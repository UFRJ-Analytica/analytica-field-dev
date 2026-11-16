"""Fetch weather forecasts from the Meteomatics API at each pilot municipality's centroid.

Three products (config/meteomatics.yaml): a 15-day short-range forecast with agronomic parameters,
a 45-day extended-range rain forecast, and a 6-month seasonal rain forecast. Each product is one
request per municipality, so a full run costs 3 x n_municipalities queries.

Authentication -- never in the repository, tried in this order:
  1. METEOMATICS_USERNAME / METEOMATICS_PASSWORD environment variables (HTTP basic auth);
  2. a ``machine api.meteomatics.com`` entry in ~/.netrc (requests reads it automatically);
  3. a credential injected by a network proxy (the Claude Code cloud environment does this).

Responses are cached per product, municipality and UTC day: re-running the same day costs no
queries; ``--refresh`` forces new ones. The account name Meteomatics echoes in every response is
dropped at parse time so it never reaches data/processed or the published JSON.

Ensemble products (extended, seasonal) are requested with every member (``ens_select``) and kept
member by member; summaries are made later, from per-member totals.

Outputs (data/processed/):
    meteomatics_daily.parquet     deterministic products: code, product, source, date, parameters
    meteomatics_ensemble.parquet  ensemble products: code, product, source, date, member, rain
    meteomatics_status.parquet    one row per (code, product): ok / unavailable + reason
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pandas as pd
import requests

from pipeline.common import (
    PROCESSED_DIR,
    RAW_DIR,
    TIMEOUT,
    USER_AGENT,
    base_parser,
    load_config,
    log,
    setup_logging,
    write_parquet,
)


class MeteomaticsError(RuntimeError):
    """The API refused or failed a request; carries the HTTP status and Meteomatics' message."""

    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message


def build_url(base: str, start: date, period: str, parameters: list[str], lat: float, lon: float,
              source: str, ens_select: str | None = None) -> str:
    """``<base>/<start>T00:00:00Z<period>:P1D/<params>/<lat>,<lon>/json?source=<source>[&ens_select=..]``."""
    url = (f"{base}/{start.isoformat()}T00:00:00Z{period}:P1D/{','.join(parameters)}/"
           f"{lat:.4f},{lon:.4f}/json?source={source}")
    return f"{url}&ens_select={ens_select}" if ens_select else url


def parse_response(payload: dict[str, Any], names: dict[str, str]) -> pd.DataFrame:
    """Meteomatics JSON -> one row per date, one column per parameter (renamed via ``names``).

    Meteomatics marks missing values with reserved numbers <= -666 (docs: "Reserved Values");
    they become NaN. The ``user`` field of the payload is deliberately ignored.

    Interval parameters (``*_24h``) are right-aligned: the value stamped D 00:00Z covers the 24 h
    *before* it, i.e. calendar day D-1 (docs, precipitation parameters: "interval parameters are
    right-aligned"). They are shifted back one day so a row's date is the day the rain fell, as in
    NASA POWER. Instantaneous parameters (soil moisture index) keep their timestamp.
    """
    if payload.get("status") != "OK":
        raise MeteomaticsError(200, str(payload.get("message", "status not OK")))
    cols: dict[str, pd.Series] = {}
    for block in payload["data"]:
        param = block["parameter"]
        coords = block["coordinates"]
        if len(coords) != 1:
            raise ValueError("expected exactly one location per response")
        cols[names.get(param, param)] = _series(coords[0]["dates"], param)
    df = pd.DataFrame(cols)
    df.index.name = "date"
    return df.reset_index()


def _series(dates: list[dict], param: str) -> pd.Series:
    s = pd.Series(
        [d["value"] for d in dates],
        index=pd.to_datetime([d["date"] for d in dates]).tz_convert(None).normalize(),
        dtype="float64",
    )
    if "_24h" in param.split(":")[0]:  # right-aligned interval -> the day it covers
        s.index = s.index - pd.Timedelta(days=1)
    return s.mask(s <= -666)


def parse_ensemble(payload: dict[str, Any], name: str) -> pd.DataFrame:
    """Ensemble response -> long frame (date, member, <name>).

    Meteomatics names member blocks ``<param>-m<N>``; the block without a suffix is member 0 (the
    control run).
    """
    if payload.get("status") != "OK":
        raise MeteomaticsError(200, str(payload.get("message", "status not OK")))
    frames = []
    for block in payload["data"]:
        param, _, suffix = block["parameter"].partition("-m")
        member = int(suffix) if suffix else 0
        s = _series(block["coordinates"][0]["dates"], param)
        frames.append(pd.DataFrame({"date": s.index, "member": member, name: s.values}))
    return pd.concat(frames, ignore_index=True).sort_values(["member", "date"]).reset_index(drop=True)


def _auth() -> tuple[str, str] | None:
    user, pw = os.environ.get("METEOMATICS_USERNAME"), os.environ.get("METEOMATICS_PASSWORD")
    return (user, pw) if user and pw else None


def fetch_product(url: str, cache_name: str, refresh: bool) -> dict[str, Any]:
    """GET with caching. Raises MeteomaticsError on any non-200 (no partial data is cached)."""
    cache = RAW_DIR / "meteomatics" / cache_name
    if cache.exists() and not refresh:
        log.info("cache hit: %s", cache.name)
        return json.loads(cache.read_text(encoding="utf-8"))
    log.info("GET %s", url)
    resp = requests.get(url, timeout=TIMEOUT, auth=_auth(), headers={"User-Agent": USER_AGENT})
    if resp.status_code != 200:
        try:
            msg = resp.json().get("message", resp.text[:200])
        except ValueError:
            msg = resp.text[:200]
        raise MeteomaticsError(resp.status_code, msg)
    payload = resp.json()
    payload.pop("user", None)  # account name; never cached, never published
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def product_window(spec: dict[str, Any], today: date, lookback: int) -> tuple[date, str]:
    """(start date, ISO-8601 period) for a product.

    Only deterministic products look back: ensemble runs exist from their own start onwards
    ("not available ... due to a gap" before it), and the days in between are covered by the
    deterministic short-range product.
    """
    if "months" in spec:
        return today, f"P{int(spec['months'])}M"
    back = 0 if spec.get("ens_select") else lookback
    return today - timedelta(days=back), f"P{int(spec['days']) + back}D"


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)
    cfg = load_config("meteomatics.yaml")

    regions_path = PROCESSED_DIR / "regions.parquet"
    if not regions_path.exists():
        raise SystemExit("regions.parquet missing: run `python -m pipeline.fetch_regions` first")
    regions = pd.read_parquet(regions_path)

    today = datetime.now(timezone.utc).date()
    products = cfg["products"]
    log.info("Meteomatics: %d municipalities x %d products = %d queries (cached per UTC day)",
             len(regions), len(products), len(regions) * len(products))
    if _auth() is None:
        log.info("no METEOMATICS_USERNAME/PASSWORD set; relying on ~/.netrc or a proxy credential")

    frames, ens_frames, status = [], [], []
    for r in regions.itertuples():
        for name, spec in products.items():
            start, period = product_window(spec, today, cfg["lookback_days"])
            names = dict(spec["parameters"])
            ens = spec.get("ens_select")
            url = build_url(cfg["base_url"], start, period, list(names), r.centroid_lat, r.centroid_lon,
                            spec["source"], ens)
            row = {"code": int(r.code), "product": name, "source": spec["source"],
                   "requested_from": start.isoformat(), "period": period,
                   "parameters": ",".join(names.values()), "fetched_utc_day": today.isoformat()}
            try:
                tag = "_members" if ens else ""
                payload = fetch_product(url, f"{name}{tag}_{int(r.code)}_{today:%Y%m%d}.json", args.refresh)
                if ens:
                    if len(names) != 1:
                        raise ValueError(f"ensemble product {name} must request exactly one parameter")
                    df = parse_ensemble(payload, next(iter(names.values())))
                else:
                    df = parse_response(payload, names)
            except MeteomaticsError as exc:
                if exc.status == 401:
                    raise SystemExit(
                        "Meteomatics refused the login (401). Set METEOMATICS_USERNAME and "
                        "METEOMATICS_PASSWORD, or add api.meteomatics.com to ~/.netrc."
                    ) from exc
                log.warning("%s for %s unavailable: %s", name, r.name, exc)
                status.append({**row, "status": "unavailable", "reason": str(exc)})
                continue
            df.insert(0, "code", int(r.code))
            df.insert(1, "product", name)
            df.insert(2, "source", spec["source"])
            (ens_frames if ens else frames).append(df)
            status.append({**row, "status": "ok", "reason": "",
                           "first_date": df.date.min().date().isoformat(),
                           "last_date": df.date.max().date().isoformat()})
            log.info("%s %s: %d days%s (%s .. %s)", r.name, name, df.date.nunique(),
                     f" x {df.member.nunique()} members" if ens else "", df.date.min().date(), df.date.max().date())

    meta = {"source": "Meteomatics Weather API (api.meteomatics.com)",
            "config": "config/meteomatics.yaml", "fetched_utc_day": today.isoformat(),
            "generated_by": "pipeline/fetch_meteomatics.py"}
    if frames:
        write_parquet(pd.concat(frames, ignore_index=True), "meteomatics_daily.parquet", meta)
    if ens_frames:
        write_parquet(pd.concat(ens_frames, ignore_index=True), "meteomatics_ensemble.parquet", meta)
    write_parquet(pd.DataFrame(status), "meteomatics_status.parquet", meta)
    print(pd.DataFrame(status)[["code", "product", "source", "status", "reason"]].to_string(index=False))


if __name__ == "__main__":
    main()
