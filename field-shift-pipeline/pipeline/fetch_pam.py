"""Fetch IBGE PAM (Producao Agricola Municipal) for the pilot municipalities via the SIDRA API.

Two SIDRA tables:

* **1612** -- temporary crops: planted / harvested area, production, yield, production value, for
  every crop IBGE surveys (44 products), 1974-.
* **839**  -- maize split by harvest: 1st crop (summer) and 2nd crop (*safrinha*). Table 1612 only
  has maize as one total, which hides exactly the crop El Nino threatens in MATOPIBA.

PAM's year is the harvest year, which is how the project labels crop years too.

SIDRA writes special symbols in place of numbers. They are kept, not guessed over:

    "-"    numeric zero (not from rounding)         -> value 0,   flag "zero"
    "..."  not available                            -> value NaN, flag "not_available"
    ".."   not applicable                           -> value NaN, flag "not_applicable"
    "X"    suppressed to protect a single informant -> value NaN, flag "suppressed"

Production value (variable 215) is in the nominal currency of each year (Cruzeiros, Cruzados,
... Reais), so it is not comparable across years before 1994 without deflating; the unit column
says which currency each row is in.

Output: data/processed/pam.parquet (long format, one row per municipality x table x crop x
variable x year)
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from pipeline.common import (
    PROCESSED_DIR,
    base_parser,
    fetch_text,
    log,
    setup_logging,
    write_parquet,
)

SIDRA = "https://apisidra.ibge.gov.br/values"
# Variable codes are the ones SIDRA returned for these tables (D2C), checked 2026-11-14.
TABLES = {
    1612: {"variables": "109,216,214,112,215", "classification": "c81/allxt"},
    839: {"variables": "109,216,214,112", "classification": "c81/114253,114254"},
}
VARIABLE_KEYS = {
    "109": "area_planted_ha",
    "216": "area_harvested_ha",
    "214": "production_t",
    "112": "yield_kg_ha",
    "215": "production_value",
}
SYMBOLS = {"-": "zero", "...": "not_available", "..": "not_applicable", "X": "suppressed"}


def sidra_url(table: int, code: int) -> str:
    spec = TABLES[table]
    return f"{SIDRA}/t/{table}/n6/{code}/v/{spec['variables']}/p/all/{spec['classification']}"


def parse_value(raw: str) -> tuple[float, str]:
    """SIDRA cell -> (value, flag). Unknown non-numeric symbols raise instead of becoming NaN."""
    raw = raw.strip()
    if raw in SYMBOLS:
        flag = SYMBOLS[raw]
        return (0.0 if flag == "zero" else np.nan), flag
    try:
        return float(raw), ""
    except ValueError:
        raise ValueError(f"unknown SIDRA symbol {raw!r}") from None


def parse_sidra(payload: list[dict], table: int) -> pd.DataFrame:
    """SIDRA /values JSON (first element is the header row) -> tidy DataFrame."""
    if not payload or payload[0].get("V") != "Valor":
        raise ValueError("SIDRA response does not start with the expected header row")
    rows = []
    for r in payload[1:]:
        value, flag = parse_value(r["V"])
        rows.append(
            {
                "code": int(r["D1C"]),
                "municipality": r["D1N"],
                "table": table,
                "year": int(r["D3C"]),
                "crop_code": int(r["D4C"]),
                "crop": r["D4N"].rstrip("*"),
                "variable_code": int(r["D2C"]),
                "variable": VARIABLE_KEYS.get(r["D2C"], r["D2C"]),
                "unit": r["MN"],
                "value": value,
                "flag": flag,
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)

    regions_path = PROCESSED_DIR / "regions.parquet"
    if not regions_path.exists():
        raise SystemExit("regions.parquet missing: run `python -m pipeline.fetch_regions` first")
    codes = pd.read_parquet(regions_path).code.astype(int).tolist()

    # Measured 2026-11-14: table 1612, one municipality, all years and crops = 3.7 MB JSON.
    log.info("PAM: %d municipalities x %d tables, ~%.0f MB of JSON in total",
             len(codes), len(TABLES), len(codes) * 3.8)

    frames = []
    for code in codes:
        for table in TABLES:
            text = fetch_text(sidra_url(table, code), f"sidra_{table}_{code}.json", args.refresh)
            frames.append(parse_sidra(json.loads(text), table))

    pam = pd.concat(frames, ignore_index=True)
    write_parquet(
        pam,
        "pam.parquet",
        metadata={
            "source": "IBGE PAM via SIDRA API, tables 1612 (temporary crops) and 839 (maize by harvest)",
            "year_convention": "harvest year (matches the project crop-year label)",
            "symbols": json.dumps(SYMBOLS),
            "currency_note": "production_value is nominal, in each year's currency (see unit)",
            "generated_by": "pipeline/fetch_pam.py",
        },
    )
    y = pam[(pam.variable == "area_planted_ha") & (pam.year >= pam.year.max() - 4) & (pam.value > 0)]
    top = y.groupby(["municipality", "table", "crop"]).value.mean().round(0)
    print("Mean planted area, last 5 PAM years (ha):")
    print(top.sort_values(ascending=False).groupby(level=0).head(8).to_string())


if __name__ == "__main__":
    main()
