"""Soil water retention from ISRIC SoilGrids 2.0 at each pilot municipality's centroid.

Properties (https://rest.isric.org/soilgrids/v2.0/docs):
    wv0033  volumetric water content at 33 kPa  -> field capacity (theta_FC)
    wv1500  volumetric water content at 1500 kPa -> wilting point (theta_WP)
    clay, sand                                   -> texture, for context only
for the six standard depths 0-5, 5-15, 15-30, 30-60, 60-100, 100-200 cm.

Values are converted with the ``d_factor`` SoilGrids returns for each property (never a hard-coded
divisor). A 250 m SoilGrids cell is a model prediction, not a field measurement; the UI says so.
ISRIC asks for fair use (a few calls per minute): one call per municipality, cached.

Output: data/processed/soil_profile.parquet (code, top_cm, bottom_cm, fc, wp, clay_pct, sand_pct)
"""

from __future__ import annotations

import json

import pandas as pd

from pipeline.common import (
    PROCESSED_DIR,
    base_parser,
    fetch_text,
    log,
    setup_logging,
    write_parquet,
)

URL = ("https://rest.isric.org/soilgrids/v2.0/properties/query?lon={lon:.4f}&lat={lat:.4f}"
       "&property=wv0033&property=wv1500&property=clay&property=sand"
       "&depth=0-5cm&depth=5-15cm&depth=15-30cm&depth=30-60cm&depth=60-100cm&depth=100-200cm&value=mean")

# target units -> multiplier to the unit we store
TARGET = {"wv0033": ("10-2 cm³/cm³", 0.01), "wv1500": ("10-2 cm³/cm³", 0.01), "clay": ("%", 1.0), "sand": ("%", 1.0)}
COLUMN = {"wv0033": "fc", "wv1500": "wp", "clay": "clay_pct", "sand": "sand_pct"}


def parse_soilgrids(payload: dict) -> pd.DataFrame:
    """SoilGrids point query -> one row per depth layer, theta in m3/m3, texture in %."""
    rows: dict[str, dict] = {}
    for layer in payload["properties"]["layers"]:
        name = layer["name"]
        if name not in TARGET:
            continue
        unit = layer["unit_measure"]
        expected, mult = TARGET[name]
        if unit["target_units"] != expected:
            raise ValueError(f"SoilGrids changed units of {name}: {unit['target_units']!r}")
        d_factor = float(unit["d_factor"])
        for d in layer["depths"]:
            r = d["range"]
            row = rows.setdefault(d["label"], {"top_cm": r["top_depth"], "bottom_cm": r["bottom_depth"]})
            v = d["values"]["mean"]
            row[COLUMN[name]] = None if v is None else v / d_factor * mult
    df = pd.DataFrame(rows.values()).sort_values("top_cm").reset_index(drop=True)
    if df[["fc", "wp"]].isna().any().any():
        raise ValueError("SoilGrids returned no water retention for some depths (water body or urban cell?)")
    if (df.fc <= df.wp).any():
        raise ValueError("field capacity must exceed wilting point in every layer")
    return df


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)
    regions = pd.read_parquet(PROCESSED_DIR / "regions.parquet")
    frames = []
    for r in regions.itertuples():
        text = fetch_text(URL.format(lon=r.centroid_lon, lat=r.centroid_lat), f"soilgrids_{int(r.code)}.json", args.refresh)
        df = parse_soilgrids(json.loads(text))
        df.insert(0, "code", int(r.code))
        frames.append(df)
        log.info("%s: TAW of 0-100 cm = %.0f mm", r.name,
                 sum(1000 * (x.fc - x.wp) * (min(x.bottom_cm, 100) - x.top_cm) / 100 for x in df.itertuples() if x.top_cm < 100))
    out = pd.concat(frames, ignore_index=True)
    write_parquet(out, "soil_profile.parquet", {
        "source": "ISRIC SoilGrids 2.0 REST (wv0033, wv1500, clay, sand), point query at the IBGE centroid",
        "fc": "wv0033 (33 kPa)", "wp": "wv1500 (1500 kPa)", "generated_by": "pipeline/fetch_soil.py"})
    print(out.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
