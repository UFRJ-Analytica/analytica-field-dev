"""County yields, areas and revenue for the US pilots from USDA NASS Quick Stats.

    NASS_API_KEY=... uv run python -m pipeline.fetch_nass [--refresh]

Writes data/processed/nass.parquet in the same long layout as pam.parquet (code, year, crop_code,
variable, unit, value, flag), so build_evidence and build_scoring read both the same way:

    area_planted_ha, area_harvested_ha   county, converted from acres
    yield_native                         county, in the NASS unit (BU / ACRE or LB / ACRE)
    revenue_per_ha                       county yield x state value of production per harvested
                                         acre / state yield, in nominal US$ per hectare

The key is read from the environment only. It never reaches a cache file name, a log line or the
Parquet metadata. Rules for matching rows are in config/nass.yaml.
"""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np
import pandas as pd
import requests

from pipeline.common import (
    RAW_DIR,
    TIMEOUT,
    USER_AGENT,
    base_parser,
    load_config,
    log,
    pilot_municipalities,
    setup_logging,
    write_parquet,
)

SUPPRESSED = {"(D)": "withheld", "(Z)": "less_than_half_unit", "(NA)": "not_available", "(X)": "not_applicable",
              "(S)": "insufficient_reports", "(L)": "less_than_half_unit", "(H)": "high_cv"}


class NassError(RuntimeError):
    pass


def parse_value(raw: Any) -> tuple[float, str]:
    """Quick Stats cell -> (value, flag). Numbers carry thousands commas; codes become flags."""
    text = str(raw).strip()
    if text in SUPPRESSED:
        return np.nan, SUPPRESSED[text]
    try:
        return float(text.replace(",", "")), ""
    except ValueError:
        raise ValueError(f"unknown Quick Stats value {text!r}") from None


def is_empty_answer(text: str) -> bool:
    """Quick Stats has no "no rows" status: it answers 400 with "no data" or "invalid query"."""
    low = text.lower()
    return "no data" in low or "invalid query" in low


def _redact(url: str) -> str:
    key = os.environ.get("NASS_API_KEY")
    return url.replace(key, "***") if key else url


def query(params: dict[str, Any], cache_name: str, refresh: bool, base_url: str) -> list[dict[str, Any]]:
    """GET with caching. An empty result is a valid answer and is cached too."""
    cache = RAW_DIR / "nass" / cache_name
    if cache.exists() and not refresh:
        log.info("cache hit: %s", cache.name)
        return json.loads(cache.read_text(encoding="utf-8"))
    key = os.environ.get("NASS_API_KEY")
    if not key:
        raise NassError("NASS_API_KEY is not set and there is no cached response; see config/nass.yaml")
    resp = requests.get(base_url, params={"key": key, "format": "JSON", **params}, timeout=TIMEOUT,
                        headers={"User-Agent": USER_AGENT})
    log.info("GET %s -> %s", _redact(resp.url), resp.status_code)
    if resp.status_code == 400 and is_empty_answer(resp.text):
        # Quick Stats answers 400 when a filter value has no rows at all (cotton in Illinois, say).
        log.warning("no NASS rows for %s; recorded as no data", cache_name)
        data: list[dict[str, Any]] = []
    elif resp.status_code != 200:
        raise NassError(f"Quick Stats answered {resp.status_code}: {resp.text[:200]}")
    else:
        data = resp.json().get("data", [])
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def select(rows: list[dict[str, Any]], spec: dict[str, Any], stat: str, unit: str, utilization: str,
           class_desc: str | None = None) -> pd.DataFrame:
    """Annual rows of one statistic for one crop, as (year, value, flag)."""
    out = []
    for r in rows:
        if (r.get("commodity_desc") == spec["commodity_desc"]
                and r.get("class_desc") == (class_desc or spec["class_desc"])
                and r.get("statisticcat_desc") == stat
                and r.get("unit_desc") == unit
                and r.get("util_practice_desc") == utilization
                and r.get("prodn_practice_desc") == "ALL PRODUCTION PRACTICES"
                and r.get("domain_desc", "TOTAL") == "TOTAL"
                and r.get("reference_period_desc", "YEAR") == "YEAR"):
            value, flag = parse_value(r.get("Value", r.get("value")))
            out.append({"year": int(r["year"]), "value": value, "flag": flag})
    df = pd.DataFrame(out, columns=["year", "value", "flag"])
    return df.drop_duplicates("year").sort_values("year").reset_index(drop=True)


def county_rows(county: list[dict[str, Any]], spec: dict[str, Any], acre_m2: float) -> dict[str, pd.DataFrame]:
    util = spec["utilization"]
    ha = acre_m2 / 10_000
    planted = select(county, spec, "AREA PLANTED", "ACRES", util["area_planted"])
    harvested = select(county, spec, "AREA HARVESTED", "ACRES", util["area_harvested"])
    return {
        "area_planted_ha": planted.assign(value=planted.value * ha),
        "area_harvested_ha": harvested.assign(value=harvested.value * ha),
        "yield_native": select(county, spec, "YIELD", spec["yield_unit"], util["yield"]),
    }


def state_value_per_yield_unit(state: list[dict[str, Any]], spec: dict[str, Any]) -> tuple[pd.DataFrame, str]:
    """US$ per (yield unit x acre) at state level = value of production / harvested acres / yield.

    Tries the crop's own class first, then `value_fallback_class`. Returns (year, value) and the
    class that was used.
    """
    util = spec["utilization"]
    classes = [spec["class_desc"]] + ([spec["value_fallback_class"]] if spec.get("value_fallback_class") else [])
    for cls in classes:
        value = select(state, spec, "PRODUCTION", "$", util["production_value"], cls)
        area = select(state, spec, "AREA HARVESTED", "ACRES", util["area_harvested"], cls)
        yld = select(state, spec, "YIELD", spec["yield_unit"], util["yield"], cls)
        w = value.merge(area, on="year", suffixes=("_usd", "_acres")).merge(yld.rename(columns={"value": "yield"}), on="year")
        w = w[(w.value_acres > 0) & (w["yield"] > 0)].dropna(subset=["value_usd"])
        if not w.empty:
            return pd.DataFrame({"year": w.year, "value": w.value_usd / w.value_acres / w["yield"]}), cls
    return pd.DataFrame(columns=["year", "value"]), ""


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)
    cfg = load_config("nass.yaml")
    us = [m for m in pilot_municipalities() if m["country"] == "US"]
    log.info("NASS: %d counties x %d crops, county and state queries (a few hundred KB each)",
             len(us), len(cfg["crops"]))

    frames = []
    status = []
    ha = cfg["acre_m2"] / 10_000
    for mun in us:
        code = int(mun["code"])
        state_alpha, county_ansi = mun["uf"], f"{code % 1000:03d}"
        label = f"{mun['mesoregion']}"
        for crop_code, spec in cfg["crops"].items():
            base = {"source_desc": "SURVEY", "sector_desc": "CROPS", "commodity_desc": spec["commodity_desc"],
                    "state_alpha": state_alpha, "year__GE": cfg["first_year"]}
            county = query({**base, "agg_level_desc": "COUNTY", "county_ansi": county_ansi},
                           f"county_{code}_{spec['commodity_desc']}.json", args.refresh, cfg["base_url"])
            state = query({**base, "agg_level_desc": "STATE", "freq_desc": "ANNUAL", "reference_period_desc": "YEAR"},
                          f"state_{state_alpha}_{spec['commodity_desc']}.json", args.refresh, cfg["base_url"])
            series = county_rows(county, spec, cfg["acre_m2"])
            per_unit, used_class = state_value_per_yield_unit(state, spec)
            y = series["yield_native"].dropna(subset=["value"])
            rev = y.merge(per_unit, on="year", suffixes=("_yield", "_usd"))
            series["revenue_per_ha"] = pd.DataFrame({
                "year": rev.year, "value": rev.value_yield * rev.value_usd / ha, "flag": ""})
            units = {"area_planted_ha": "ha", "area_harvested_ha": "ha", "yield_native": spec["yield_unit"],
                     "revenue_per_ha": "US$/ha (nominal)"}
            for variable, df in series.items():
                frames.append(df.assign(code=code, municipality=label, table=0, crop_code=int(crop_code),
                                        crop=spec["name_en"], variable_code=0, variable=variable,
                                        unit=units[variable]))
            status.append({"code": code, "crop_code": int(crop_code), "years_yield": int(y.year.nunique()),
                           "years_revenue": int(rev.year.nunique()), "value_class": used_class})

    cols = ["code", "municipality", "table", "year", "crop_code", "crop", "variable_code", "variable", "unit",
            "value", "flag"]
    nass = pd.concat(frames, ignore_index=True)[cols] if frames else pd.DataFrame(columns=cols)
    nass["flag"] = nass.flag.fillna("")
    write_parquet(nass, "nass.parquet", metadata={
        "source": "USDA NASS Quick Stats API (SURVEY, county and state)",
        "year_convention": "NASS year = harvest year; with the Oct-Sep crop year of the US regions it is the crop-year label",
        "revenue_method": "county yield x state value of production / state harvested acres / state yield",
        "table_note": "table = 0 marks NASS rows; PAM rows carry their SIDRA table number",
        "generated_by": "pipeline/fetch_nass.py",
    })
    print(pd.DataFrame(status).to_string(index=False))


if __name__ == "__main__":
    main()
