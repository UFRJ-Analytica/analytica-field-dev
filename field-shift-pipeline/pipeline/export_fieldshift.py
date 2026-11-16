"""Export the climate evidence as dated JSON fixtures for the Field Shift backend.

    uv run python -m pipeline.export_fieldshift [--out DIR]

Writes, into field-shift-app/backend/fixtures/climate/ by default:

* enso.json                  current CPC ENSO state and strength outlook;
* municipality-<code>.json   season-to-date rainfall and the analog-year evidence rows;
* pilot-fields.json          the synthetic pilot fields, centred on the IBGE or Census centroid.

This module is the only writer of that folder. Every number comes from data/processed/ (built by
the fetch_* and build_evidence scripts); nothing is typed here. Each file carries ``recorded_at``
so the backend can serve it as a dated fixture.

Basis rules: RONI, ONI and PAM are ``reported`` (published by an agency);
NASA POWER is ``modelled`` (MERRA-2 reanalysis). A derived row takes the weakest basis of its
inputs, ordered observed, retrieved, reported, modelled.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

from api import repository as repo
from pipeline.common import ROOT, base_parser, load_config, log, setup_logging

CONTRACT_VERSION = "fieldshift-climate-1"
DEFAULT_OUT = ROOT.parent / "field-shift-app" / "backend" / "fixtures" / "climate"

POWER_SOURCE = "https://power.larc.nasa.gov/"
PAM_SOURCE = "https://apisidra.ibge.gov.br/"
NASS_SOURCE = "https://quickstats.nass.usda.gov/"
RONI_SOURCE = "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt"

# Synthetic pilot fields, the same footprint as Field 01 of field-scenarios.json.
PILOT_FIELD_WIDTH_DEG = 0.025
PILOT_FIELD_HEIGHT_DEG = 0.02
PILOT_FIELDS = (
    {"id": "rs-tupancireta-01", "name": "Field 04", "code": 4322202},
    {"id": "ba-lem-01", "name": "Field 05", "code": 2919553},
    {"id": "il-mclean-01", "name": "Field 06", "code": 17113},
    {"id": "tx-lubbock-01", "name": "Field 07", "code": 48303},
)
# Climate rows taken from the composites, in display order.
# The months differ by region (Sep-Dec and Jan-Apr in Brazil, Oct-Mar and Apr-Sep in the US), so
# every row carries `months` = [first, last] and the layer text names them.
CLIMATE_METRICS = (
    ("early_rain_mm_anom_pct", "early", "Rain {months}, strong El Nino years vs 1991 to 2020"),
    ("late_cdd_days_anom", "late", "Longest dry spell {months}, strong El Nino years vs 1991 to 2020"),
)
MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def month_span(months: list[int]) -> str:
    return f"{MONTH_ABBR[months[0] - 1]} to {MONTH_ABBR[months[-1] - 1]}"
SMALL_SAMPLE_BELOW = 3


def crop_year_label(crop_year: int) -> str:
    """Harvest-year label 2027 -> safra 2026/27."""
    return f"{crop_year - 1}/{str(crop_year)[-2:]}"


def signed(value: float, unit: str, decimals: int = 1) -> str:
    text = f"{value:+.{decimals}f}"
    return f"{text}%" if unit == "%" else f"{text} {unit}"


def pilot_boundary(lon: float, lat: float) -> dict[str, Any]:
    w, h = PILOT_FIELD_WIDTH_DEG / 2, PILOT_FIELD_HEIGHT_DEG / 2
    ring = [[lon - w, lat + h], [lon + w, lat + h], [lon + w, lat - h], [lon - w, lat - h], [lon - w, lat + h]]
    return {"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring]]}


def enso_fixture(recorded_at: str) -> dict[str, Any]:
    payload = repo.enso_payload()
    cur = payload["current"]
    disc = cur["discussion"]
    return {
        "contract_version": CONTRACT_VERSION,
        "recorded_at": recorded_at,
        "basis": "reported",
        "discussion": {k: disc[k] for k in ("issued", "alert_status", "synopsis", "next_issue", "source_url")},
        "roni": {**cur["roni"], "source": RONI_SOURCE},
        "oni": cur["oni"],
        "fetched_at": cur["fetched_at"],
        "outlook": payload["outlook"],
        "source": {
            "discussion": disc["source_url"],
            "index": RONI_SOURCE,
            "outlook": payload["provenance"]["outlook"],
        },
    }


def climate_rows(code: int, power_as_of: str, pam_as_of: str, support: str, season: dict[str, Any],
                 us: bool = False) -> list[dict[str, Any]]:
    comps = repo.frame("composites.parquet")
    strong = comps[(comps.code == code) & (comps.enso_class == "el_nino_strong")]
    crops_cfg = load_config("crops.yaml")["crops"]
    rows: list[dict[str, Any]] = []

    def row(metric, layer, number, unit, basis, as_of, source, n, years, crop_code=None, crop_name=None,
            assumption=False, months=None) -> dict[str, Any]:
        return {
            "metric": metric,
            "layer": layer,
            "value": signed(number, unit),
            "number": round(float(number), 1),
            "unit": unit,
            "basis": basis,
            "as_of": as_of,
            "source": source,
            "support": support if basis == "modelled" else ("county, USDA NASS" if us else "municipality, IBGE PAM"),
            "months": months,
            "n_years": n,
            "years": years,
            "crop_code": crop_code,
            "crop_name_en": crop_name,
            "assumption": assumption,
            "small_sample": n is not None and n < SMALL_SAMPLE_BELOW,
        }

    for metric, part, layer in CLIMATE_METRICS:
        hit = strong[(strong.kind == "climate") & (strong.metric == metric)]
        if hit.empty or pd.isna(hit.iloc[0]["mean"]):
            continue
        r = hit.iloc[0]
        months = season["sub_seasons"][part]
        rows.append(row(metric, layer.format(months=month_span(months)), r["mean"],
                        "days" if r["unit"] == "days" else r["unit"], "modelled", power_as_of, POWER_SOURCE,
                        int(r["n"]), [int(y) for y in str(r["years"]).split(",") if y],
                        months=[months[0], months[-1]]))

    for _, r in strong[strong.kind == "yield"].iterrows():
        if pd.isna(r["mean"]) or int(r["n"]) == 0:
            continue
        crop_code = int(r["crop_code"])
        name_en = crops_cfg[crop_code]["name_en"]
        rows.append(row("yield_anomaly_pct", f"{name_en} yield vs trend, strong El Nino years", r["mean"], "%",
                        "reported", pam_as_of, NASS_SOURCE if us else PAM_SOURCE, int(r["n"]),
                        [int(y) for y in str(r["years"]).split(",") if y], crop_code, name_en,
                        r["crop_source"] == "suposicao"))
    return rows


def municipality_fixture(code: int, recorded_at: str) -> dict[str, Any]:
    payload = repo.municipality_payload(code)
    mun = payload["municipality"]
    prog = payload["season_progress"]
    last = next(d for d in reversed(prog["days"]) if d["current_mm"] is not None)
    power_meta = repo.file_meta("power_daily.parquet")
    us = mun.get("country") == "US"
    unit_name = "county" if us else "municipality"
    support = f"{unit_name} centroid; {power_meta.get('grid_note', 'POWER grid-cell average')}"
    stats = repo.optional("nass.parquet") if us else repo.frame("pam.parquet")
    stats = stats[stats.code == code] if stats is not None else None
    stats_as_of = str(int(stats.year.max())) if stats is not None and not stats.empty else None
    crop_year = int(payload["current_crop_year"]["crop_year"])
    season = payload["season"]
    start_month = season["season_months"][0]

    rows = climate_rows(code, prog["last_observed"], stats_as_of, support, season, us)
    rows.append({
        "metric": "season_rain_to_date_mm",
        "layer": f"Rain since 1 {MONTH_ABBR[start_month - 1]} vs 1991 to 2020 normal",
        "months": [start_month, start_month],
        "value": f"{last['current_mm']:.0f} mm vs {last['baseline_mean_mm']:.0f} mm",
        "number": round(float(last["current_mm"]), 1),
        "unit": "mm",
        "basis": "modelled",
        "as_of": last["date"],
        "source": POWER_SOURCE,
        "support": support,
        "n_years": int(prog["n_baseline"]),
        "years": [],
        "crop_code": None,
        "crop_name_en": None,
        "assumption": False,
        "small_sample": False,
    })
    return {
        "contract_version": CONTRACT_VERSION,
        "recorded_at": recorded_at,
        "municipality": {k: mun.get(k) for k in ("code", "name", "name_official", "uf", "country", "region_id", "region_name",
                                             "enso_signal", "centroid_lon", "centroid_lat")},
        "crop_year": crop_year,
        "crop_year_label": crop_year_label(crop_year),
        "crop_year_enso": {k: payload["current_crop_year"].get(k) for k in
                           ("enso_class", "provisional", "forecast", "basis")},
        "season_progress": {
            "start": prog["start"],
            "last_observed": last["date"],
            "rain_mm": round(float(last["current_mm"]), 1),
            "normal_mm": round(float(last["baseline_mean_mm"]), 1),
            "analog_mm": None if last["analog_mean_mm"] is None else round(float(last["analog_mean_mm"]), 1),
            "n_baseline": prog["n_baseline"],
            "n_analog": prog["n_analog"],
            "analog_years": prog["analog_years"],
            "basis": "modelled",
            "source": POWER_SOURCE,
            "support": support,
            "start_month": start_month,
        },
        "rows": rows,
        "source": {"climate": POWER_SOURCE, "yield": NASS_SOURCE if us else PAM_SOURCE,
                   "rules": "field-shift-pipeline/config/analysis.yaml"},
    }


def pilot_fields_fixture(recorded_at: str) -> dict[str, Any]:
    regions = repo.municipalities_payload()["municipalities"]
    by_code = {m["code"]: m for m in regions}
    fields = []
    for spec in PILOT_FIELDS:
        mun = by_code[spec["code"]]
        lon, lat = round(float(mun["centroid_lon"]), 6), round(float(mun["centroid_lat"]), 6)
        fields.append({
            "id": spec["id"],
            "name": spec["name"],
            "location": f"{mun['name_official']} ({mun['uf']})",
            "municipality_code": spec["code"],
            "synthetic": True,
            "region": "us" if mun.get("country") == "US" else "br",
            "coverage": None,
            "center": [lon, lat],
            "boundary": pilot_boundary(lon, lat),
            "scenarios": [],
        })
    return {
        "contract_version": CONTRACT_VERSION,
        "recorded_at": recorded_at,
        "note": "Synthetic fields: a rectangle the size of Field 01 centred on the IBGE municipal centroid.",
        "fields": fields,
    }


def check_fixture_fields_inside(code: int) -> None:
    """Log whether the hand-drawn Santa Carmem fixture fields fall inside the municipality."""
    from shapely.geometry import Point, shape

    geo = repo.municipalities_payload()["geojson"]
    feature = next((f for f in geo["features"] if int(f["properties"]["code"]) == code), None)
    fixture = ROOT.parent / "field-shift-app" / "backend" / "fixtures" / "field-scenarios.json"
    if feature is None or not fixture.exists():
        return
    poly = shape(feature["geometry"])
    for field in json.loads(fixture.read_text(encoding="utf-8"))["fields"]:
        inside = poly.contains(Point(*field["center"]))
        log.info("fixture %s centre %s inside municipality %s: %s", field["id"], field["center"], code, inside)


def main() -> None:
    p = base_parser(__doc__.splitlines()[0])
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder")
    args = p.parse_args()
    setup_logging(args.verbose)
    recorded_at = pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")
    args.out.mkdir(parents=True, exist_ok=True)

    def write(name: str, data: dict[str, Any]) -> None:
        path = args.out / name
        path.write_text(json.dumps(repo.clean(data), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log.info("wrote %s (%.1f KB)", path, path.stat().st_size / 1024)

    write("enso.json", enso_fixture(recorded_at))
    for mun in repo.municipalities_payload()["municipalities"]:
        write(f"municipality-{mun['code']}.json", municipality_fixture(int(mun["code"]), recorded_at))
    write("pilot-fields.json", pilot_fields_fixture(recorded_at))
    check_fixture_fields_inside(5107248)


if __name__ == "__main__":
    main()
