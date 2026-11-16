"""Fetch daily agroclimate from NASA POWER at each pilot municipality's centroid.

One point per municipality: the IBGE-derived centroid from regions.parquet (run fetch_regions
first). POWER's grid is ~0.5 x 0.625 degrees, so the value is a grid-cell average, not a station
reading; the UI says so.

The period runs from 1981-01-01 (start of POWER's daily agroclimate record) to today. Requests are
split into decade chunks, each cached under data/raw/ by its exact date range, so a re-run only
fetches the chunk that contains today. POWER publishes with a lag of a few days; those trailing
days come back as the fill value and are dropped.

Output: data/processed/power_daily.parquet (code, date, one column per parameter)
"""

from __future__ import annotations

import json
from datetime import date

import pandas as pd

from pipeline.common import (
    PROCESSED_DIR,
    base_parser,
    fetch_text,
    log,
    setup_logging,
    write_parquet,
)

POWER_URL = (
    "https://power.larc.nasa.gov/api/temporal/daily/point"
    "?parameters={params}&community=AG&longitude={lon}&latitude={lat}"
    "&start={start}&end={end}&format=JSON"
)

# Name -> (unit, what it is for). Units are checked against the response header at parse time.
PARAMETERS: dict[str, tuple[str, str]] = {
    "PRECTOTCORR": ("mm/day", "rainfall: seasonal totals, dry spells, heavy-rain days"),
    "T2M": ("C", "mean air temperature"),
    "T2M_MAX": ("C", "heat stress"),
    "T2M_MIN": ("C", "frost risk in the south"),
    "RH2M": ("%", "humidity, disease pressure"),
    "WS2M": ("m/s", "evapotranspiration inputs"),
    "ALLSKY_SFC_SW_DWN": ("MJ/m^2/day", "solar radiation"),
    "GWETROOT": ("1", "root-zone soil wetness, 0-1 (model)"),
    "GWETTOP": ("1", "surface soil wetness, 0-1 (model)"),
    "EVPTRNS": ("MJ/m^2/day", "evapotranspiration energy flux (model)"),
}

START = date(1981, 1, 1)
CHUNK_YEARS = 10


def chunks(start: date, end: date, years: int = CHUNK_YEARS) -> list[tuple[date, date]]:
    """Split [start, end] into calendar blocks of `years` years, aligned to decades."""
    out = []
    y = start.year
    while y <= end.year:
        block_end_year = (y // years + 1) * years - 1
        a = max(start, date(y, 1, 1))
        b = min(end, date(block_end_year, 12, 31))
        out.append((a, b))
        y = block_end_year + 1
    return out


def parse_power(payload: dict) -> tuple[pd.DataFrame, dict[str, str]]:
    """Turn one POWER point response into a daily DataFrame, fill values -> NaN.

    Returns (frame, info) where info carries the upstream sources and fill value for provenance.
    """
    header = payload["header"]
    fill = header.get("fill_value", -999.0)
    params = payload["properties"]["parameter"]
    units = {k: v["units"] for k, v in payload["parameters"].items()}
    for name, (unit, _) in PARAMETERS.items():
        if name in units and units[name] != unit:
            raise ValueError(f"POWER changed the unit of {name}: {units[name]!r} != {unit!r}")

    df = pd.DataFrame(params)
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    df = df.mask(df == fill)
    df.index.name = "date"
    coords = payload.get("geometry", {}).get("coordinates", [])
    info = {"sources": ",".join(header.get("sources", [])), "fill_value": str(fill),
            "api_version": header.get("api", {}).get("version", ""),
            # POWER returns the grid cell's elevation as the third coordinate; FAO-56 ET0 needs it.
            "elevation_m": float(coords[2]) if len(coords) > 2 else float("nan")}
    return df.reset_index(), info


def drop_unpublished_tail(df: pd.DataFrame) -> pd.DataFrame:
    """Drop trailing days where every parameter is missing (POWER's publication lag)."""
    have = df.drop(columns=["date"]).notna().any(axis=1)
    if not have.any():
        return df.iloc[0:0]
    last = have[have].index[-1]
    return df.loc[:last]


def fetch_point(code: int, lon: float, lat: float, end: date, refresh: bool) -> tuple[pd.DataFrame, set[str]]:
    frames, sources, elevation = [], set(), float("nan")
    for a, b in chunks(START, end):
        url = POWER_URL.format(params=",".join(PARAMETERS), lon=lon, lat=lat,
                               start=a.strftime("%Y%m%d"), end=b.strftime("%Y%m%d"))
        text = fetch_text(url, f"power_{code}_{a:%Y%m%d}_{b:%Y%m%d}.json", refresh)
        df, info = parse_power(json.loads(text))
        frames.append(df)
        sources.update(info["sources"].split(","))
        elevation = info["elevation_m"]
    out = drop_unpublished_tail(pd.concat(frames, ignore_index=True))
    out.insert(0, "code", code)
    out["elevation_m"] = elevation
    return out, sources


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)

    regions_path = PROCESSED_DIR / "regions.parquet"
    if not regions_path.exists():
        raise SystemExit("regions.parquet missing: run `python -m pipeline.fetch_regions` first")
    regions = pd.read_parquet(regions_path)

    end = date.today()
    n_days = (end - START).days + 1
    # A 14-day x 10-parameter slice is ~3.6 KB of JSON (measured 2026-11-14).
    log.info("POWER: %d municipalities x %d days x %d parameters, ~%.1f MB of JSON in total",
             len(regions), n_days, len(PARAMETERS), len(regions) * n_days * 3.6 / 14 / 1024)

    frames, sources = [], set()
    for r in regions.itertuples():
        df, src = fetch_point(int(r.code), r.centroid_lon, r.centroid_lat, end, args.refresh)
        log.info("%s: %s to %s (%d days)", r.name, df.date.min().date(), df.date.max().date(), len(df))
        frames.append(df)
        sources |= src

    daily = pd.concat(frames, ignore_index=True)
    write_parquet(
        daily,
        "power_daily.parquet",
        metadata={
            "source": "NASA POWER daily point API, community=AG",
            "upstream_models": ",".join(sorted(s for s in sources if s)),
            "point": "IBGE-derived municipal centroid (regions.parquet)",
            "grid_note": "POWER values are grid-cell averages (~0.5 x 0.625 deg), not station data",
            "units": json.dumps({k: v[0] for k, v in PARAMETERS.items()}),
            "generated_by": "pipeline/fetch_power.py",
        },
    )
    print(daily.groupby("code").date.agg(["min", "max", "count"]).to_string())


if __name__ == "__main__":
    main()
