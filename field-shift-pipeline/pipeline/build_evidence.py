"""Build the analog-year evidence from POWER, PAM and the ENSO record.

Inputs (data/processed/): regions, power_daily, pam, enso_seasonal, enso_strength_forecast.
Run the fetch_* scripts first. All the arithmetic lives in pipeline/evidence.py (pure).

Outputs (data/processed/):
    crop_year_enso.parquet     ENSO class of every crop year (+ the current one, as a forecast)
    climate_seasonal.parquet   rainfall indices per municipality x crop year, with anomalies
    yield_anomalies.parquet    detrended PAM yield anomalies per municipality x crop x year
    composites.parquet         mean anomaly by ENSO class, with n and the years behind it
    season_progress.parquet    cumulative rain this season vs climatology vs strong-El-Nino years
                               (+ forecast_mm continuing it, when Meteomatics data is present)

Optional, built only when their inputs exist:
    forecast_summary.parquet   15-day Meteomatics forecast vs POWER normal for the same dates
    forecast_days.parquet      the forecast day by day (rain, ET0, soil moisture index, ...)
    season_outlook.parquet     seasonal forecast by month vs normal and strong-El-Nino months
    ndvi_seasonal.parquet      peak-season cropland NDVI per crop year, 2001-2020 anomalies
    ndvi_progress.parquet      this season's NDVI per 16-day slot vs normal and analogs
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pipeline import evidence as ev
from pipeline.common import (
    PROCESSED_DIR,
    base_parser,
    load_config,
    log,
    region_calendars,
    setup_logging,
    write_parquet,
)

STRONG_BINS = ["p1.5_p2.0", "ge_p2.0"]
MODERATE_BINS = ["p0.5_p1.0", "p1.0_p1.5"]

CLIMATE_METRICS = [
    f"{part}_{m}"
    for part in ("season", "early", "late")
    for m in ("rain_mm", "cdd_days", "r20_days", "rx5_mm")
] + ["season_gwetroot", "season_tmax_c"]

# Metrics carried into composites: percent anomalies for totals, absolute for counts and means.
COMPOSITE_METRICS = {
    "season_rain_mm_anom_pct": "%",
    "early_rain_mm_anom_pct": "%",
    "late_rain_mm_anom_pct": "%",
    "early_r20_days_anom": "days",
    "late_cdd_days_anom": "days",
    "early_rx5_mm_anom_pct": "%",
    "season_gwetroot_anom": "0-1",
    "season_tmax_c_anom": "C",
}


def pq_meta(path: Path) -> dict[str, str]:
    raw = pq.read_schema(path).metadata or {}
    return {k.decode(): v.decode() for k, v in raw.items() if not k.startswith(b"pandas")}


def _read(name: str) -> pd.DataFrame:
    path = PROCESSED_DIR / name
    if not path.exists():
        raise SystemExit(f"{name} missing: run the fetch_* scripts first (see README)")
    return pd.read_parquet(path)


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)

    cfg = load_config("analysis.yaml")
    baseline = tuple(cfg["baseline_crop_years"])

    regions = _read("regions.parquet")
    daily = _read("power_daily.parquet")
    pam = _read("pam.parquet")
    nass_path = PROCESSED_DIR / "nass.parquet"
    nass = pd.read_parquet(nass_path) if nass_path.exists() else None
    country_of = {int(r.code): getattr(r, "country", "BR") or "BR" for r in regions.itertuples()}
    if nass is None and "US" in country_of.values():
        log.warning("nass.parquet missing (run pipeline.fetch_nass with NASS_API_KEY): no US yields")

    # Each region has its own season calendar (config/regions.yaml); Brazil's is the default.
    calendars = region_calendars()
    cal_of = {int(r.code): calendars[r.region_id] for r in regions.itertuples()}
    enso = _read("enso_seasonal.parquet")
    outlook = _read("enso_strength_forecast.parquet")

    # ---- ENSO class per crop year ------------------------------------------------------------
    ce = cfg["crop_year_enso"]
    cy_enso = ev.crop_year_enso(enso, ce["reference_season"], ce["strong_classes"])
    cy_enso["forecast"] = False
    last_day = daily.date.tail(1)
    labels = {int(ev.crop_year(last_day, c["crop_year_start_month"]).iloc[0]) for c in cal_of.values()}
    if len(labels) > 1:
        raise SystemExit(f"regions disagree on the current crop year {sorted(labels)}: check their calendars")
    current_cy = labels.pop()
    if current_cy not in set(cy_enso.crop_year) or cy_enso.set_index("crop_year").loc[current_cy, "provisional"]:
        row = outlook[outlook.season == ce["reference_season"]]
        if row.empty:
            log.warning("no CPC outlook for %s; current crop year left unclassified", ce["reference_season"])
        else:
            cls, prob = ev.forecast_class(row.iloc[0], STRONG_BINS, MODERATE_BINS)
            cy_enso = cy_enso[cy_enso.crop_year != current_cy]
            cy_enso = pd.concat([cy_enso, pd.DataFrame([{
                "crop_year": current_cy, "enso_class": cls, "roni_ref": None,
                "roni_strength": None, "provisional": True, "forecast": True,
                "forecast_probability_pct": prob,
                "basis": f"CPC strength outlook issued {row.iloc[0].issued}, {ce['reference_season']}",
            }])], ignore_index=True)
    log.info("current crop year %d: %s", current_cy,
             cy_enso.set_index("crop_year").loc[current_cy].to_dict())

    # ---- Climate ----------------------------------------------------------------------------
    climate = pd.concat([
        ev.seasonal_climate(daily[daily.code == code], c["season_months"], c["sub_seasons"], cfg["rain_indices"],
                            c["crop_year_start_month"])
        for code, c in cal_of.items()
    ], ignore_index=True)
    climate = ev.add_anomalies(climate, CLIMATE_METRICS, baseline)
    climate = climate.merge(cy_enso[["crop_year", "enso_class", "forecast"]], on="crop_year", how="left")

    # ---- Yield ------------------------------------------------------------------------------
    # Only crops in config/crops.yaml, each matched to the ENSO event it actually grew through:
    # winter crops harvested in PAM year Y grew during the ENSO of crop year Y + 1.
    ya = cfg["yield_anomaly"]
    crops_cfg = load_config("crops.yaml")
    offsets = crops_cfg["season_offset"]
    known = {int(k): v for k, v in crops_cfg["crops"].items()}
    enso_by_cy = cy_enso.set_index("crop_year").enso_class
    yields = []
    for code in regions.code:
        if country_of[int(code)] == "US":
            if nass is None:
                continue
            mun = nass[nass.code == code]
            area = mun[mun.variable == "area_planted_ha"].dropna(subset=["value"])
            yield_var = "yield_native"
        else:
            mun = pam[pam.code == code]
            area = mun[(mun.table == 1612) & (mun.variable == "area_planted_ha")]
            yield_var = "yield_kg_ha"
        # Largest planted area first; that order is what the UI shows.
        main = ev.main_crops(area[["year", "crop_code", "value"]], 5, ya["min_area_share"]) if not area.empty else []
        if 2711 in main:  # maize total -> use the per-harvest series from table 839 instead
            at = main.index(2711)
            main[at:at] = sorted(mun[mun.table == 839].crop_code.unique().tolist())
        for crop_code in [c for c in main if c in known]:
            spec = known[crop_code]
            s = mun[(mun.crop_code == crop_code) & (mun.variable == yield_var) & (mun.flag == "")]
            unit = "kg/ha" if yield_var == "yield_kg_ha" else (s.unit.iloc[0] if not s.empty else "")
            s = s[["year", "value", "crop", "table"]].rename(columns={"value": "yield_value"})
            an = ev.yield_anomalies(s, ya["min_years"], col="yield_value").assign(yield_unit=unit)
            if an.empty:
                continue
            offset = offsets[spec["season"]]
            yields.append(an.assign(
                code=code, crop_code=crop_code, crop_pt=spec["name_pt"], crop_en=spec["name_en"],
                season=spec["season"], crop_source=spec["source"],
                enso_crop_year=an.year + offset,
            ))
    yields = pd.concat(yields, ignore_index=True).rename(columns={"year": "crop_year"})
    log.info("yield series: %s", yields.groupby("code").crop_code.nunique().to_dict())
    yields["enso_class"] = yields.enso_crop_year.map(enso_by_cy)
    # A winter crop of the latest PAM year would map onto the forecast year: keep it out.
    forecast_years = set(cy_enso[cy_enso.forecast].crop_year)
    yields.loc[yields.enso_crop_year.isin(forecast_years), "enso_class"] = None

    # ---- Composites (observed crop years only; the forecast year is never part of the evidence)
    obs = climate[~climate.forecast.fillna(False).astype(bool)]
    comps = []
    for metric, unit in COMPOSITE_METRICS.items():
        c = ev.composite(obs, metric, ["code"])
        comps.append(c.assign(kind="climate", metric=metric, unit=unit, crop_code=None, crop=None))
    for (code, crop_code), g in yields.groupby(["code", "crop_code"]):
        c = ev.composite(g, "anomaly_pct", ["code"])
        comps.append(c.assign(kind="yield", metric="yield_anomaly_pct", unit="%",
                              crop_code=crop_code, crop=g.crop_pt.iloc[0],
                              crop_source=g.crop_source.iloc[0], season=g.season.iloc[0]))
    composites = pd.concat(comps, ignore_index=True)

    # ---- Season to date ---------------------------------------------------------------------
    strong_years = cy_enso[(cy_enso.enso_class == "el_nino_strong") & ~cy_enso.forecast].crop_year.tolist()
    progress = pd.concat([
        ev.season_progress(daily, code, c["season_months"][0],
                           sum(pd.Period(f"2001-{m:02d}").days_in_month for m in c["season_months"]),
                           current_cy, baseline, strong_years, c["crop_year_start_month"])
        for code, c in cal_of.items()
    ], ignore_index=True)

    meta = {
        "generated_by": "pipeline/build_evidence.py",
        "rules": "config/analysis.yaml",
        "baseline_crop_years": f"{baseline[0]}-{baseline[1]}",
        "current_crop_year": str(current_cy),
    }

    # ---- Optional: Meteomatics forecasts -----------------------------------------------------
    fc_path = PROCESSED_DIR / "meteomatics_daily.parquet"
    if fc_path.exists():
        fc_all = pd.read_parquet(fc_path)
        ens_path = PROCESSED_DIR / "meteomatics_ensemble.parquet"
        ens_all = pd.read_parquet(ens_path) if ens_path.exists() else pd.DataFrame(
            columns=["code", "product", "date", "member", "rain"])
        fc_day = pd.Timestamp(pq_meta(fc_path).get("fetched_utc_day", str(daily.date.max().date())))
        fcfg = cfg["forecast"]
        summaries, days_out, outlook_rows, extended_progress = [], [], [], []
        for code in regions.code:
            code = int(code)
            short = fc_all[(fc_all.code == code) & (fc_all["product"] == "short_range")].dropna(axis=1, how="all")
            ext = ens_all[(ens_all.code == code) & (ens_all["product"] == "extended")]
            seas = ens_all[(ens_all.code == code) & (ens_all["product"] == "seasonal")]
            p = progress[progress.code == code]
            last_obs = p.dropna(subset=["current_mm"]).date.max()
            if not short.empty:
                s = ev.forecast_summary(short, daily, code, fc_day, baseline, strong_years,
                                        fcfg["heavy_day_mm"], fcfg["wet_day_mm"])
                summaries.append({"code": code, "issued_utc_day": fc_day, **s})
                d = short.drop(columns=["product", "source"]).copy()
                d["kind"] = np.where(d.date < fc_day, "recent", "forecast")
                days_out.append(d[d.date > last_obs])  # days POWER has not published yet, then forecast
            if not ext.empty:
                bridge = short[["date", "rain"]] if not short.empty else pd.DataFrame(columns=["date", "rain"])
                p = ev.ensemble_progress(p, bridge, ext[["date", "member", "rain"]])
            if not seas.empty:
                c = cal_of[code]
                outlook_rows.append(ev.monthly_outlook(seas[["date", "member", "rain"]], daily, code,
                                                       c["season_months"], baseline, strong_years,
                                                       c["crop_year_start_month"]))
            extended_progress.append(p)
        progress = pd.concat(extended_progress, ignore_index=True)
        fmeta = {**meta, "source": "Meteomatics Weather API; normals from NASA POWER 1991-2020",
                 "issued_utc_day": str(fc_day.date())}
        if summaries:
            write_parquet(pd.DataFrame(summaries), "forecast_summary.parquet", fmeta)
            write_parquet(pd.concat(days_out, ignore_index=True), "forecast_days.parquet", fmeta)
        if outlook_rows:
            write_parquet(pd.concat(outlook_rows, ignore_index=True), "season_outlook.parquet",
                          {**fmeta, "model": "ecmwf-mmsf via Meteomatics, all 51 members"})
        log.info("forecasts: %d summaries, %d outlook rows", len(summaries), sum(len(o) for o in outlook_rows))
    else:
        log.info("no meteomatics_daily.parquet: forecast products skipped")

    # ---- Optional: MODIS NDVI (Planetary Computer) --------------------------------------------
    nd_path = PROCESSED_DIR / "ndvi_composites.parquet"
    if nd_path.exists():
        nd = pd.read_parquet(nd_path)
        ncfg = cfg["ndvi"]
        nbase = tuple(ncfg["baseline_crop_years"])
        ndvi_cy = pd.concat([
            ev.ndvi_by_crop_year(nd[nd.code == code], c["ndvi_peak_months"], ncfg["min_valid_fraction"],
                                 ncfg["min_composites"], c["crop_year_start_month"])
            for code, c in cal_of.items() if (nd.code == code).any()
        ], ignore_index=True)
        ndvi_cy = ev.add_anomalies(ndvi_cy, ["ndvi_peak"], nbase)
        means = ndvi_cy[(ndvi_cy.crop_year >= nbase[0]) & (ndvi_cy.crop_year <= nbase[1])].groupby("code").ndvi_peak.mean()
        ndvi_cy["ndvi_peak_anom_pct"] = 100 * ndvi_cy.ndvi_peak_anom / ndvi_cy.code.map(means)
        ndvi_cy = ndvi_cy.merge(cy_enso[["crop_year", "enso_class", "forecast"]], on="crop_year", how="left")
        obs_nd = ndvi_cy[~ndvi_cy.forecast.fillna(False).astype(bool)]
        vc = ev.composite(obs_nd, "ndvi_peak_anom_pct", ["code"])
        composites = pd.concat([composites, vc.assign(kind="vegetation", metric="ndvi_peak_anom_pct", unit="%",
                                                     crop_code=None, crop=None)], ignore_index=True)
        nprog = pd.concat([
            ev.ndvi_progress(nd, code, c["season_months"], current_cy, nbase, strong_years,
                             ncfg["min_valid_fraction"], c["crop_year_start_month"])
            for code, c in cal_of.items() if (nd.code == code).any()
        ], ignore_index=True)
        vmeta = {**meta, "baseline_crop_years": f"{nbase[0]}-{nbase[1]}",
                 "source": "MODIS MOD13Q1 v061 NDVI via Microsoft Planetary Computer, stable cropland"}
        write_parquet(ndvi_cy, "ndvi_seasonal.parquet", vmeta)
        write_parquet(nprog, "ndvi_progress.parquet", vmeta)
        log.info("NDVI: %d crop-year values, %d progress slots", len(ndvi_cy), len(nprog))
    else:
        log.info("no ndvi_composites.parquet: vegetation products skipped")

    write_parquet(cy_enso, "crop_year_enso.parquet", meta)
    write_parquet(climate, "climate_seasonal.parquet", {**meta, "source": "NASA POWER PRECTOTCORR, GWETROOT, T2M_MAX"})
    write_parquet(yields, "yield_anomalies.parquet",
                  {**meta, "source": "IBGE PAM tables 1612, 839 (Brazil); USDA NASS Quick Stats (US)"})
    write_parquet(composites, "composites.parquet", meta)
    write_parquet(progress, "season_progress.parquet", {**meta, "source": "NASA POWER PRECTOTCORR"})

    view = composites[(composites.kind == "climate") & composites.metric.isin(
        ["early_rain_mm_anom_pct", "late_rain_mm_anom_pct", "late_cdd_days_anom"])]
    print(view.pivot_table(index=["code", "metric"], columns="enso_class", values="mean").round(1).to_string())
    print()
    soy = composites[(composites.kind == "yield") & (composites.crop_code == 2713)]
    print("Soy yield anomaly (%) by ENSO class:")
    print(soy.pivot_table(index="code", columns="enso_class", values=["mean", "n"]).round(1).to_string())


if __name__ == "__main__":
    main()
