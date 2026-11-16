"""Turn the processed Parquet files into the JSON payloads of the public contract (v1).

Used by both the FastAPI server (api/main.py) and the static exporter (api/export.py), so a
static deployment and a live server return byte-for-byte the same shapes.

Contract rules, mirrored in web/src/api/types.ts:
* snake_case keys, plain JSON types only (NaN -> null, dates -> ISO strings);
* categorical values are stable codes (``el_nino_strong``), never translated text -- the UI owns
  the wording;
* every block carries ``provenance`` (source + method) and every crop carries ``source`` so a
  ``suposicao`` can be surfaced as a warning;
* nothing here is mock data; ``meta.mock`` is false and would be true for any mock payload.
"""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow.parquet as pq

from pipeline.common import PROCESSED_DIR, load_config

# 1.1 adds optional blocks (forecast, vegetation, land_cover, terrain); 1.2 adds `rotations`.
# Each version only adds fields, so older clients keep working.
CONTRACT_VERSION = "1.2"
ENSO_CLASSES = ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"]


class DataMissing(RuntimeError):
    """A processed file the API needs has not been built yet."""


def data_dir() -> Path:
    return Path(os.environ.get("FIELD_PHASE_DATA_DIR", PROCESSED_DIR))


@lru_cache(maxsize=None)
def _frame(name: str, directory: str) -> pd.DataFrame:
    path = Path(directory) / name
    if not path.exists():
        raise DataMissing(f"{name} not found in {directory}; run the pipeline (see README)")
    return pd.read_parquet(path)


@lru_cache(maxsize=None)
def _meta(name: str, directory: str) -> dict[str, str]:
    raw = pq.read_schema(Path(directory) / name).metadata or {}
    return {k.decode(): v.decode() for k, v in raw.items() if not k.startswith(b"pandas")}


def frame(name: str) -> pd.DataFrame:
    return _frame(name, str(data_dir()))


def file_meta(name: str) -> dict[str, str]:
    return _meta(name, str(data_dir()))


def optional(name: str) -> pd.DataFrame | None:
    """A processed file that only exists when its optional integration ran (Meteomatics,
    Planetary Computer); None otherwise, so the payload simply leaves that block out."""
    return frame(name) if (data_dir() / name).exists() else None


def clear_cache() -> None:
    _frame.cache_clear()
    _meta.cache_clear()


def clean(value: Any) -> Any:
    """Make a value JSON-safe: NaN/NaT -> None, numpy scalars -> Python, timestamps -> ISO."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value.date().isoformat()
    if value is None or value is pd.NaT:
        return None
    if hasattr(value, "item"):  # numpy scalar
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def records(df: pd.DataFrame, columns: list[str] | None = None) -> list[dict[str, Any]]:
    if columns:
        df = df[[c for c in columns if c in df.columns]]
    return [clean(r) for r in df.to_dict(orient="records")]


def round_floats(df: pd.DataFrame, decimals: int = 2) -> pd.DataFrame:
    out = df.copy()
    for c in out.select_dtypes("float").columns:
        out[c] = out[c].round(decimals)
    return out


# --------------------------------------------------------------------------------------------
# Payloads
# --------------------------------------------------------------------------------------------


def meta_payload() -> dict[str, Any]:
    crops = load_config("crops.yaml")["crops"]
    assumptions = [
        {"scope": "crop", "crop_code": int(code), "field": "season", "value": spec["season"],
         "source": spec["source"]}
        for code, spec in crops.items() if spec["source"] == "suposicao"
    ]
    analysis = load_config("analysis.yaml")
    current = file_meta("season_progress.parquet")
    return clean({
        "app": "Field Phase",
        "contract_version": CONTRACT_VERSION,
        "mock": False,
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
        "baseline_crop_years": analysis["baseline_crop_years"],
        "current_crop_year": int(current.get("current_crop_year", 0)) or None,
        "enso_classes": ENSO_CLASSES,
        "methods": {
            "rain_indices": analysis["rain_indices"]["source"].strip(),
            "crop_year_enso": analysis["crop_year_enso"]["source"].strip(),
            "yield_anomaly": analysis["yield_anomaly"]["source"].strip(),
            "ndvi": analysis["ndvi"]["source"].strip(),
            "forecast": analysis["forecast"]["source"].strip(),
        },
        "assumptions": assumptions,
        "datasets": {
            name: file_meta(name) for name in (
                "enso_seasonal.parquet", "enso_current.parquet", "power_daily.parquet",
                "pam.parquet", "regions.parquet", "meteomatics_daily.parquet",
                "ndvi_composites.parquet", "landcover_yearly.parquet", "terrain.parquet",
            ) if (data_dir() / name).exists()
        },
    })


def enso_payload() -> dict[str, Any]:
    cur = frame("enso_current.parquet").iloc[0].to_dict()
    outlook = frame("enso_strength_forecast.parquet")
    seasonal = frame("enso_seasonal.parquet")
    cy = frame("crop_year_enso.parquet")
    weekly = frame("enso_weekly.parquet").tail(26)
    return clean({
        "current": {
            "discussion": {k: cur[k] for k in (
                "issued", "alert_status", "synopsis", "next_issue", "nino34_quoted_c",
                "discussion_text", "source_url")},
            "roni": {"season": cur["roni_latest_season"], "value": cur["roni_latest"],
                     "phase": cur["roni_latest_phase"], "strength": cur["roni_latest_strength"]},
            "oni": {"season": cur["oni_latest_season"], "value": cur["oni_latest"]},
            "weekly_nino34": {"week": cur["weekly_latest_week"], "anomaly": cur["weekly_nino34_anom"]},
            "fetched_at": cur["fetched_at"],
        },
        "outlook": records(outlook),
        "weekly": records(weekly[["week_center", "nino34_anom", "nino12_anom"]]),
        "history": records(round_floats(seasonal), [
            "season", "year", "center_month", "crop_year", "roni", "oni",
            "roni_phase", "roni_strength"]),
        "crop_years": records(cy),
        "provenance": {
            "index": "NOAA CPC RONI (official since Feb 2026); ONI shown for comparison",
            "discussion": cur["source_url"],
            "outlook": file_meta("enso_strength_forecast.parquet").get("source"),
            "rules": "config/enso.yaml",
        },
    })


def _with_official_names(regions: pd.DataFrame) -> pd.DataFrame:
    """Add ``name_official``: IBGE's accented name as SIDRA returns it ("Tupanciretã"), or the
    Census name for a US county ("McLean County"), falling back to the config name."""
    out = regions.copy()
    census = out["name_official"] if "name_official" in out else pd.Series(None, index=out.index)
    try:
        pam = frame("pam.parquet")
        names = pam.drop_duplicates("code").set_index("code").municipality.str.replace(r"\s*\(\w{2}\)$", "", regex=True)
        out["name_official"] = census.fillna(out.code.map(names)).fillna(out.name)
    except DataMissing:
        out["name_official"] = census.fillna(out.name)
    if "country" not in out:
        out["country"] = "BR"
    out["country"] = out["country"].fillna("BR")
    return out


def _season_info(region_id: str) -> dict[str, Any]:
    """The months behind every seasonal label of this region (they differ between BR and US)."""
    from pipeline.common import region_calendars

    c = region_calendars()[region_id]
    return {"crop_year_start_month": c["crop_year_start_month"], "season_months": c["season_months"],
            "sub_seasons": c["sub_seasons"], "ndvi_peak_months": c["ndvi_peak_months"], "source": c["source"]}


def municipalities_payload() -> dict[str, Any]:
    regions = _with_official_names(frame("regions.parquet"))
    geo_path = data_dir() / "regions.geojson"
    geojson = json.loads(geo_path.read_text(encoding="utf-8")) if geo_path.exists() else None
    return clean({
        "municipalities": records(regions, [
            "code", "name", "name_official", "uf", "country", "region_id", "region_name", "enso_signal", "hazards",
            "centroid_lon", "centroid_lat", "min_lon", "min_lat", "max_lon", "max_lat",
            "geometry_source"]),
        "geojson": geojson,
        "provenance": {"source": file_meta("regions.parquet").get("source"),
                       "map_note": "outlines simplified to ~100 m for display; centroids use full resolution"},
    })


def municipality_payload(code: int) -> dict[str, Any]:
    regions = _with_official_names(frame("regions.parquet"))
    row = regions[regions.code == code]
    if row.empty:
        raise KeyError(code)
    mun = records(row)[0]
    mun["hazards"] = mun["hazards"].split(",") if mun.get("hazards") else []

    climate = round_floats(frame("climate_seasonal.parquet"))
    climate = climate[climate.code == code]
    comps = round_floats(frame("composites.parquet"))
    comps = comps[comps.code == code]
    yields = round_floats(frame("yield_anomalies.parquet"))
    yields = yields[yields.code == code]
    progress = round_floats(frame("season_progress.parquet"), 1)
    progress = progress[progress.code == code]
    cy = frame("crop_year_enso.parquet")

    crops_out = []
    for crop_code, g in yields.groupby("crop_code", sort=False):
        first = g.iloc[0]
        c = comps[(comps.kind == "yield") & (comps.crop_code == crop_code)]
        crops_out.append({
            "crop_code": int(crop_code),
            "name_pt": first.crop_pt,
            "name_en": first.crop_en,
            "season": first.season,
            "source": first.crop_source,
            "assumption": first.crop_source == "suposicao",
            "pam_table": int(first.table) if int(first.table) else None,
            "yield_unit": first.get("yield_unit", "kg/ha"),
            "series": records(g, ["crop_year", "enso_crop_year", "yield_value", "trend_value",
                                  "anomaly_pct", "enso_class"]),
            "composite": records(c, ["enso_class", "n", "mean", "median", "minus_neutral", "years"]),
        })
    current_cy = int(file_meta("season_progress.parquet")["current_crop_year"])
    current = cy[cy.crop_year == current_cy]

    climate_cols = ["crop_year", "enso_class", "season_rain_mm", "season_rain_mm_anom_pct",
                    "early_rain_mm", "early_rain_mm_anom_pct", "late_rain_mm", "late_rain_mm_anom_pct",
                    "early_r20_days", "early_r20_days_anom", "late_cdd_days", "late_cdd_days_anom",
                    "early_rx5_mm", "early_rx5_mm_anom_pct", "season_gwetroot", "season_gwetroot_anom",
                    "season_tmax_c", "season_tmax_c_anom"]
    climate_comps = comps[comps.kind == "climate"]
    is_us = mun.get("country") == "US"
    return clean({
        "municipality": mun,
        "season": _season_info(mun["region_id"]),
        "current_crop_year": {
            "crop_year": current_cy,
            **(records(current)[0] if not current.empty else {}),
        },
        "season_progress": {
            "start": progress.date.min(),
            "last_observed": progress.dropna(subset=["current_mm"]).date.max(),
            "n_baseline": int(progress.n_baseline.iloc[0]),
            "n_analog": int(progress.n_analog.iloc[0]),
            "analog_years": [int(y) for y in str(progress.analog_years.iloc[0]).split(",") if y],
            "days": records(progress, ["day", "date", "current_mm", "baseline_mean_mm",
                                       "baseline_p10_mm", "baseline_p90_mm", "analog_mean_mm",
                                       "forecast_median_mm", "forecast_p10_mm", "forecast_p90_mm"]),
            "forecast_model": "ecmwf-vareps via Meteomatics, 51 members" if "forecast_median_mm" in progress else None,
        },
        "forecast": _forecast_block(code),
        "vegetation": _vegetation_block(code, comps),
        "land_cover": _land_cover_block(code),
        "terrain": _terrain_block(code),
        "rotations": rotations_block(code, current),
        # Says why `rotations` is null, so the page never tells a
        # municipality with no configured candidates to "run the scoring".
        "rotations_status": _rotations_status(code),
        "climate": {
            "seasons": records(climate, climate_cols),
            "composites": {
                metric: {
                    "unit": g.unit.iloc[0],
                    "by_class": records(g, ["enso_class", "n", "mean", "median", "minus_neutral", "years"]),
                }
                for metric, g in climate_comps.groupby("metric", sort=False)
            },
        },
        "yield": {"crops": crops_out},
        "provenance": {
            "climate": ("NASA POWER daily (grid-cell average at the "
                        f"{'Census county' if is_us else 'IBGE municipal'} centroid); ETCCDI indices"),
            "yield": ("USDA NASS Quick Stats, county survey; linear-trend anomalies" if is_us
                      else "IBGE PAM via SIDRA (tables 1612, 839); linear-trend anomalies"),
            "baseline_crop_years": file_meta("climate_seasonal.parquet").get("baseline_crop_years"),
            "rules": "config/analysis.yaml, config/crops.yaml",
        },
    })


def rotations_block(code: int, current: pd.DataFrame | None = None) -> dict[str, Any] | None:
    """Every candidate rotation scored for every ENSO class, with all the numbers behind it.

    Totals for the default weights are included for convenience; a client changing the weights
    recomputes them with the same formula (scoring.weighted_total), documented in `formula`.
    """
    from pipeline import scoring

    scores = optional("rotation_scores.parquet")
    if scores is None:
        return None
    s = scores[scores.code == code]
    if s.empty:
        return None
    cfg = load_config("rotations.yaml")
    region = frame("regions.parquet").set_index("code").loc[code, "region_id"]
    weights = cfg["meta"]["default_weights"]
    by_class = {}
    for cls, g in s.groupby("enso_class", sort=False):
        results = [json.loads(x) for x in g.result]
        by_class[cls] = scoring.rank(results, weights)
    clim = optional("monthly_climate_by_class.parquet")
    climate = {}
    if clim is not None:
        c = round_floats(clim[clim.code == code], 1)
        climate = {cls: records(g.drop(columns=["code", "enso_class"])) for cls, g in c.groupby("enso_class")}
    if current is None:
        cy = frame("crop_year_enso.parquet")
        current = cy[cy.crop_year == int(file_meta("season_progress.parquet")["current_crop_year"])]
    cur = records(current)[0] if current is not None and not current.empty else {}
    crop_ids = sorted({c for rot in cfg["rotations"][region] for c in rot["crops"]})
    cal_source = cfg["calendars"][region]["source"]
    return clean({
        "current_class": cur.get("enso_class"),
        "current_class_is_forecast": bool(cur.get("forecast", False)),
        "default_weights": weights,
        "formula": "total = sum(weight_i * score_i) / sum(weight_i), over components with weight > 0; "
                   "score_i = min-max 0-100 across candidates (100 = best)",
        "components": {
            "soil": {"metric": "heavy_rain_days_on_bare_soil", "unit": "days/yr", "better": "lower"},
            "water": {"metric": "transpiration_deficit_daily_soil_water_balance", "unit": "mm/yr", "better": "lower"},
            "income": {"metric": "revenue_change_in_class", "unit": "%", "better": "higher"},
        },
        "crops": {cid: {k: cfg["crops"][cid].get(k) for k in ("name_pt", "name_en", "abbr", "cover_crop")} for cid in crop_ids},
        "by_class": by_class,
        "climate_by_class": climate,
        "assumptions": ([{"scope": "calendar", "region": region, "source": cal_source}] if cal_source == "suposicao" else [])
        + [{"scope": "calendar", "region": region, "crop": cid, "source": "suposicao"}
           for cid in crop_ids if (cfg["calendars"][region].get(cid) or {}).get("source") == "suposicao"],
        "month_order": _month_order(region),
        "provenance": {
            "kc": cfg["kc_source"],
            "calendar": f"config/rotations.yaml calendars.{region} (source: {cal_source})",
            "climate": file_meta("rotation_scores.parquet").get("climate_source"),
            "soil": file_meta("rotation_scores.parquet").get("soil_source"),
            "roots": file_meta("rotation_scores.parquet").get("root_source"),
            "water_model": file_meta("rotation_scores.parquet").get("water_model"),
            "revenue": ("USDA NASS: county yield x state value of production per harvested acre / state "
                        "yield, last 5 years, nominal US$" if region.startswith("us_")
                        else file_meta("rotation_scores.parquet").get("revenue_source")),
            "yield_anomalies": (("USDA NASS" if region.startswith("us_") else "IBGE PAM")
                                + " yield anomalies by ENSO class (composites)"),
            "limitations": "one-bucket soil water balance with modelled soil properties (SoilGrids) and "
                           "maximum rooting depth from sowing; gross revenue, not margin; "
                           "scores are relative among these candidates",
        },
    })


def ranked_rotations(code: int, enso_class: str, weights: dict[str, float]) -> list[dict[str, Any]]:
    """Ranking for arbitrary weights (the API endpoint). Same pure function the build uses."""
    from pipeline import scoring

    scores = optional("rotation_scores.parquet")
    if scores is None:
        raise DataMissing("rotation_scores.parquet not found; run pipeline.build_scoring")
    s = scores[(scores.code == code) & (scores.enso_class == enso_class)]
    if s.empty:
        raise KeyError((code, enso_class))
    return clean(scoring.rank([json.loads(x) for x in s.result], weights))


def _month_order(region: str) -> list[int]:
    """Calendar display order: the region's crop year, e.g. Jul-Jun in Brazil, Oct-Sep in the US."""
    from pipeline.common import region_calendars

    start = region_calendars()[region]["crop_year_start_month"]
    return [(start - 1 + i) % 12 + 1 for i in range(12)]


def _rotations_status(code: int) -> str:
    cfg = load_config("rotations.yaml")
    region = frame("regions.parquet").set_index("code").loc[code, "region_id"]
    if region not in cfg["rotations"] or region not in cfg["calendars"]:
        return "not_configured"
    return "ready" if rotations_block(code, None) is not None else "not_built"


def _forecast_block(code: int) -> dict[str, Any] | None:
    status = optional("meteomatics_status.parquet")
    if status is None:
        return None
    st = status[status.code == code]
    if st.empty:  # this place was never fetched: the page says so instead of drawing empty panels
        return None
    summ = optional("forecast_summary.parquet")
    days = optional("forecast_days.parquet")
    outlook = optional("season_outlook.parquet")
    s = summ[summ.code == code] if summ is not None else None
    return {
        "provider": "Meteomatics",
        "issued_utc_day": file_meta("meteomatics_status.parquet").get("fetched_utc_day"),
        "products": records(st, ["product", "source", "status", "reason", "first_date", "last_date"]),
        "short_range": None if s is None or s.empty else {
            "summary": records(round_floats(s.drop(columns=["code"])))[0],
            "days": records(round_floats(days[days.code == code].drop(columns=["code"]))) if days is not None else [],
        },
        "season_outlook": None if outlook is None else records(round_floats(outlook[outlook.code == code].drop(columns=["code"]), 0)),
        "provenance": {
            "forecast": "Meteomatics Weather API: mix (15 days), ecmwf-vareps and ecmwf-mmsf ensembles (51 members)",
            "normals": "NASA POWER 1991-2020 for the same calendar dates -- a different source from the forecast",
            "rules": "config/meteomatics.yaml, config/analysis.yaml (forecast)",
        },
    }


def _vegetation_block(code: int, comps: pd.DataFrame) -> dict[str, Any] | None:
    seasonal = optional("ndvi_seasonal.parquet")
    if seasonal is None:
        return None
    prog = optional("ndvi_progress.parquet")
    nd = optional("ndvi_composites.parquet")
    s = round_floats(seasonal[seasonal.code == code], 3)
    vc = comps[(comps.kind == "vegetation") & (comps.code == code)]
    last = nd[nd.code == code].date.max() if nd is not None else None
    return {
        "baseline_crop_years": file_meta("ndvi_seasonal.parquet").get("baseline_crop_years"),
        "last_composite": last,
        "seasons": records(s, ["crop_year", "ndvi_peak", "n_composites", "ndvi_peak_anom",
                               "ndvi_peak_anom_pct", "enso_class"]),
        "composite": records(vc, ["enso_class", "n", "mean", "median", "minus_neutral", "years"]),
        "progress": records(round_floats(prog[prog.code == code], 3), [
            "slot", "doy", "label_date", "current", "current_date", "baseline_mean", "baseline_p10",
            "baseline_p90", "n_baseline", "analog_mean", "n_analog"]) if prog is not None else [],
        "provenance": {
            "source": "MODIS MOD13Q1 v061 NDVI (Terra, 250 m, 16-day) via Microsoft Planetary Computer",
            "mask": file_meta("ndvi_composites.parquet").get("cropland_mask"),
            "rules": "config/planetary.yaml, config/analysis.yaml (ndvi)",
        },
    }


def _land_cover_block(code: int) -> dict[str, Any] | None:
    lc = optional("landcover_yearly.parquet")
    if lc is None:
        return None
    return {
        "years": records(round_floats(lc[lc.code == code].drop(columns=["code"]), 3)),
        "provenance": {"source": "Impact Observatory/Esri 10 m annual land cover (io-lulc-annual-v02) via Microsoft Planetary Computer",
                       "license": file_meta("landcover_yearly.parquet").get("license")},
    }


def _terrain_block(code: int) -> dict[str, Any] | None:
    tr = optional("terrain.parquet")
    if tr is None:
        return None
    t = round_floats(tr[tr.code == code], 3)
    meta = file_meta("terrain.parquet")
    return {
        "by_scope": {
            scope: {
                "median_slope_pct": float(g.median_slope_pct.iloc[0]),
                "classes": records(g, ["relief_class", "share"]),
            }
            for scope, g in t.groupby("scope", sort=False)
        },
        "provenance": {"source": meta.get("attribution"), "classes": meta.get("relief_source")},
    }
