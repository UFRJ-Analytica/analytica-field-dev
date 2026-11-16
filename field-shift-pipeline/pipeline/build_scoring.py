"""Score the candidate rotations of every municipality, for every ENSO class.

Inputs (data/processed/): regions, power_daily, pam, crop_year_enso, composites, soil_profile --
so run the fetch_* scripts (incl. fetch_soil) and build_evidence first. Rules: config/rotations.yaml,
config/analysis.yaml. All arithmetic is in pipeline/scoring.py, pipeline/soilwater.py and
pipeline/agromet.py (all pure).

Steps:
1. Daily reference ET0 (FAO-56 Penman-Monteith) from POWER at each centroid.
2. Monthly rain, heavy-rain days (>= 20 mm) and ET0 per ENSO class (complete months only).
3. For every rotation: a continuous daily FAO-56 soil water balance from 1984 (SoilGrids water
   retention, FAO-56 rooting depths), summarised per crop year, then averaged per ENSO class.
4. Recent revenue per hectare per crop from PAM (production value / harvested area, last N years).
5. Yield anomaly per crop and ENSO class from the composites built by build_evidence.
6. scoring.score_rotations for each municipality x ENSO class.

Outputs (data/processed/):
    monthly_climate_by_class.parquet   code, enso_class, month, rain_mm, heavy_days, et0_mm, n_years
    rotation_scores.parquet            code, enso_class, rotation_id, result (JSON with every number)
    soil_water_years.parquet           code, rotation_id, crop_year, enso_class, deficit_mm, stress_days
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from pipeline import agromet, scoring, soilwater
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

ENSO_CLASSES = ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"]


def daily_et0(daily: pd.DataFrame, regions: pd.DataFrame) -> pd.Series:
    lat = daily.code.map(regions.set_index("code").centroid_lat)
    ea = agromet.actual_vapour_pressure_rh_mean(daily.T2M_MAX, daily.T2M_MIN, daily.RH2M)
    out = np.full(len(daily), np.nan)
    for code, idx in daily.groupby("code").groups.items():
        d = daily.loc[idx]
        out[np.asarray([daily.index.get_loc(i) for i in idx])] = agromet.et0_penman_monteith(
            d.T2M_MAX, d.T2M_MIN, d.ALLSKY_SFC_SW_DWN, d.WS2M, ea.loc[idx],
            float(lat.loc[idx].iloc[0]), d.date.dt.dayofyear, float(d.elevation_m.iloc[0]),
        )
    return pd.Series(out, index=daily.index)


def water_stats_for(
    daily_code: pd.DataFrame,
    rotations: list[dict],
    crops: dict,
    calendar: dict,
    profile: list[dict],
    sw: dict,
    cy_enso: pd.DataFrame,
    start_month: int = 7,
) -> tuple[dict[str, dict[str, dict]], pd.DataFrame]:
    """Run the daily soil water balance for every rotation; summarise per ENSO class.

    Returns ({enso_class: {rotation_id: stats}}, per-year table). Only complete crop years after the
    spin-up enter the means.
    """
    start = pd.Timestamp(sw["start"])
    d = daily_code[daily_code.date >= start].sort_values("date")
    # Keep whole crop years only: cut at the last day before the most recent crop-year start.
    last = d.date.max()
    year_start = pd.Timestamp(last.year - (0 if last.month >= start_month else 1), start_month, 1)
    d = d[d.date < year_start]
    # A gap (a missing POWER solar day, say) inside the latest crop year drops that whole year rather
    # than being filled in; a gap further back is an error.
    gaps = d[d.ET0.isna() | d.PRECTOTCORR.isna()]
    if not gaps.empty:
        first = gaps.date.min()
        cut = pd.Timestamp(first.year - (0 if first.month >= start_month else 1), start_month, 1)
        if cut >= year_start - pd.DateOffset(years=1):
            log.info("soil water: dropping crop year from %s (POWER gap on %s)", cut.date(), first.date())
            d = d[d.date < cut]
    if d.ET0.isna().any() or d.PRECTOTCORR.isna().any():
        raise SystemExit(f"gaps in rain/ET0 between {d.date.min().date()} and {d.date.max().date()}")
    tew = soilwater.tew_mm(profile, sw["ze_m"])
    taw = {cid: soilwater.taw_mm(profile, spec["root"]["zr_m"]) for cid, spec in crops.items()}
    first_full = int(ev.crop_year(pd.Series([start]), start_month).iloc[0]) + 1  # first crop year fully simulated
    obs = cy_enso[~cy_enso.forecast.fillna(False).astype(bool)][["crop_year", "enso_class"]]
    years, months, days = d.date.dt.year.to_numpy(), d.date.dt.month.to_numpy(), d.date.dt.day.to_numpy()

    out: dict[str, dict[str, dict]] = {}
    per_year = []
    for rot in rotations:
        occ = scoring.occupancy(rot["crops"], scoring.rotation_windows(rot, calendar))
        cal = {m: [{"crop": e["crop"], "stage": e["stage"]} for e in occ[m]] for m in occ}
        sched = soilwater.daily_schedule(months, days, cal, crops, taw)
        sim = soilwater.simulate(d.PRECTOTCORR.to_numpy(), d.ET0.to_numpy(), sched["kc"], sched["taw"],
                                 sched["p"], sched["cropped"], tew, sw["min_rain_fraction_et0"])
        monthly = soilwater.crop_year_summary(years, months, sim, sched["cropped"], start_month)
        monthly = monthly[monthly.crop_year >= first_full].merge(obs, on="crop_year", how="inner")
        yearly = monthly.groupby(["crop_year", "enso_class"]).agg(
            deficit_mm=("deficit_mm", "sum"), demand_mm=("demand_mm", "sum"),
            stress_days=("stress_days", "sum")).reset_index()
        per_year.append(yearly.assign(rotation_id=rot["id"]))
        main_taw = {c: round(taw[c], 1) for c in rot["crops"]}
        for cls, g in yearly.groupby("enso_class"):
            m = monthly[monthly.enso_class == cls].groupby("month").deficit_mm.mean()
            out.setdefault(cls, {})[rot["id"]] = {
                "deficit_mm": float(g.deficit_mm.mean()),
                "demand_mm": float(g.demand_mm.mean()),
                "stress_days": float(g.stress_days.mean()),
                "n_years": int(len(g)),
                "taw_mm": main_taw,
                "by_month": [{"month": int(k), "deficit_mm": float(v)} for k, v in m.items() if v > 0.05],
            }
    return out, pd.concat(per_year, ignore_index=True)


def revenue_per_ha_nass(nass: pd.DataFrame | None, code: int, years: int) -> dict[int, float]:
    """Mean nominal US$/ha over the last ``years`` NASS years (see pipeline/fetch_nass.py)."""
    if nass is None:
        return {}
    r = nass[(nass.code == code) & (nass.variable == "revenue_per_ha")].dropna(subset=["value"])
    if r.empty:
        return {}
    r = r[r.year > r.year.max() - years]
    return {int(k): float(v) for k, v in r.groupby("crop_code").value.mean().items()}


def revenue_per_ha(pam: pd.DataFrame, code: int, years: int) -> dict[int, float]:
    """Mean of production value (thousand R$) / harvested area over the last ``years`` PAM years."""
    p = pam[(pam.code == code) & (pam.table == 1612) & (pam.flag == "")]
    last = int(p.year.max())
    p = p[p.year > last - years]
    w = p.pivot_table(index=["crop_code", "year"], columns="variable", values="value").reset_index()
    w = w[(w.get("area_harvested_ha", 0) > 0) & w.get("production_value").notna()]
    w["rs_ha"] = w.production_value * 1000 / w.area_harvested_ha
    return {int(k): float(v) for k, v in w.groupby("crop_code").rs_ha.mean().items()}


def anomalies(composites: pd.DataFrame, code: int, enso_class: str) -> dict[int, tuple[float | None, int]]:
    y = composites[(composites.kind == "yield") & (composites.code == code) & (composites.enso_class == enso_class)]
    return {int(r.crop_code): (None if pd.isna(r["mean"]) else float(r["mean"]), int(r.n)) for _, r in y.iterrows()}


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)
    cfg = load_config("rotations.yaml")
    heavy_mm = load_config("analysis.yaml")["rain_indices"]["heavy_day_mm"]

    regions = pd.read_parquet(PROCESSED_DIR / "regions.parquet")
    daily = pd.read_parquet(PROCESSED_DIR / "power_daily.parquet")
    pam = pd.read_parquet(PROCESSED_DIR / "pam.parquet")
    nass_path = PROCESSED_DIR / "nass.parquet"
    nass = pd.read_parquet(nass_path) if nass_path.exists() else None
    calendars = region_calendars()
    cy = pd.read_parquet(PROCESSED_DIR / "crop_year_enso.parquet")
    comps = pd.read_parquet(PROCESSED_DIR / "composites.parquet")
    soil_path = PROCESSED_DIR / "soil_profile.parquet"
    soil = pd.read_parquet(soil_path) if soil_path.exists() else None
    if soil is None:
        log.warning("soil_profile.parquet missing (run pipeline.fetch_soil): water component will be empty")

    daily["ET0"] = daily_et0(daily, regions)
    log.info("ET0: %.0f%% of days computable (solar radiation gaps elsewhere)", 100 * daily.ET0.notna().mean())
    # Monthly climate by ENSO class, with each region's own crop-year boundary.
    clim = pd.concat([
        ev.monthly_climate_by_class(daily[daily.code == r.code], cy, heavy_mm,
                                    calendars[r.region_id]["crop_year_start_month"])
        for r in regions.itertuples()
    ], ignore_index=True)

    rows, sw_years = [], []
    for r in regions.itertuples():
        code, region = int(r.code), r.region_id
        if region not in cfg["rotations"] or region not in cfg["calendars"]:
            # No candidate rotations or crop calendar for this region (Santa Carmem): nothing is
            # scored, rather than borrowing another region's list.
            log.info("%s: no rotations configured for region %s; not scored", r.name, region)
            continue
        if getattr(r, "country", "BR") == "US":
            rev = revenue_per_ha_nass(nass, code, load_config("nass.yaml")["revenue_years"])
        else:
            rev = revenue_per_ha(pam, code, cfg["meta"]["revenue_years"])
        start_month = calendars[region]["crop_year_start_month"]
        calendar = {k: v for k, v in cfg["calendars"][region].items() if k != "source"}
        water: dict[str, dict] = {}
        if soil is not None and (soil.code == code).any():
            profile = soil[soil.code == code].to_dict("records")
            water, yearly = water_stats_for(daily[daily.code == code], cfg["rotations"][region], cfg["crops"],
                                            calendar, profile, cfg["soil_water"], cy, start_month)
            sw_years.append(yearly.assign(code=code))
        for cls in ENSO_CLASSES:
            c = clim[(clim.code == code) & (clim.enso_class == cls)].set_index("month")
            climate = {"heavy_days": c.heavy_days.to_dict()}
            results = scoring.score_rotations(cfg["rotations"][region], cfg["crops"], calendar, climate,
                                              rev, anomalies(comps, code, cls), water.get(cls, {}))
            n_years = int(c.n_years.min()) if len(c) else 0
            for res in results:
                rows.append({"code": code, "enso_class": cls, "rotation_id": res["id"], "n_climate_years": n_years,
                             "result": json.dumps(res, default=_json_default)})
        log.info("%s: %d rotations x %d ENSO classes", r.name, len(cfg["rotations"][region]), len(ENSO_CLASSES))

    meta = {"generated_by": "pipeline/build_scoring.py", "rules": "config/rotations.yaml",
            "kc_source": cfg["kc_source"], "root_source": cfg["root_source"],
            "soil_source": "ISRIC SoilGrids 2.0 wv0033/wv1500 at the IBGE centroid (modelled, 250 m)",
            "water_model": cfg["soil_water"]["source"].strip(),
            "normalisation": cfg["meta"]["normalisation"],
            "climate_source": "NASA POWER daily; ET0 FAO-56 Penman-Monteith (pipeline/agromet.py)",
            "revenue_source": f"IBGE PAM table 1612, last {cfg['meta']['revenue_years']} years, nominal R$"}
    write_parquet(clim, "monthly_climate_by_class.parquet", meta)
    scores = pd.DataFrame(rows)
    write_parquet(scores, "rotation_scores.parquet", meta)
    if sw_years:
        write_parquet(pd.concat(sw_years, ignore_index=True), "soil_water_years.parquet", meta)

    # Console summary: the ranking under equal weights, by class.
    w = cfg["meta"]["default_weights"]
    for code in regions.code:
        for cls in ("el_nino_strong", "la_nina"):
            res = [json.loads(x) for x in scores[(scores.code == code) & (scores.enso_class == cls)].result]
            ranked = scoring.rank(res, w)
            print(f"{code} {cls}: " + " > ".join(
                f"{x['id']}({x['total']:.0f})" if x["total"] is not None else f"{x['id']}(n/a)" for x in ranked))


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    raise TypeError(type(o))


if __name__ == "__main__":
    main()
