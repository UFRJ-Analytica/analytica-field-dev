"""Pure functions behind the analog-year evidence. No I/O: everything takes and returns DataFrames.

Vocabulary used throughout:

crop year   Jul-Jun, labelled by the harvest year (crop year 2016 = Jul 2015 - Jun 2016).
season      the months in regions.yaml ``season_months`` (Sep-Apr) of one crop year.
ENSO class  el_nino_strong / el_nino_moderate / neutral / la_nina, from RONI at the reference
            season (config/analysis.yaml).
baseline    crop years 1991-2020; every anomaly is relative to their mean.
"""

from __future__ import annotations

from typing import Any, Iterable

import numpy as np
import pandas as pd

ENSO_CLASSES = ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"]


# --------------------------------------------------------------------------------------------
# Calendar
# --------------------------------------------------------------------------------------------


def crop_year(dates: pd.Series, start_month: int = 7) -> pd.Series:
    """Harvest-year label: months >= start_month belong to the next calendar year's crop year."""
    return dates.dt.year + (dates.dt.month >= start_month).astype(int)


# --------------------------------------------------------------------------------------------
# Rainfall indices
# --------------------------------------------------------------------------------------------


def max_dry_spell(rain: Iterable[float], wet_day_mm: float) -> int:
    """ETCCDI CDD: the longest run of consecutive days with rain below ``wet_day_mm``."""
    best = run = 0
    for r in rain:
        if r < wet_day_mm:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


def rain_indices(rain: pd.Series, cfg: dict[str, Any]) -> dict[str, float]:
    """Total, CDD, R20mm and Rx5day for one contiguous block of daily rainfall (mm/day)."""
    rain = rain.astype(float)
    return {
        "rain_mm": float(rain.sum()),
        "cdd_days": float(max_dry_spell(rain, cfg["wet_day_mm"])),
        "r20_days": float((rain >= cfg["heavy_day_mm"]).sum()),
        "rx5_mm": float(rain.rolling(cfg["rx_window_days"]).sum().max()),
    }


def seasonal_climate(
    daily: pd.DataFrame,
    season_months: list[int],
    sub_seasons: dict[str, list[int]],
    rain_cfg: dict[str, Any],
    start_month: int = 7,
) -> pd.DataFrame:
    """One row per (code, crop_year): rainfall indices for the season and each sub-season, plus
    mean root-zone wetness and mean Tmax over the season.

    A season only gets a row if every one of its days is present -- a half-observed season would
    look like a drought.
    """
    df = daily.copy()
    df["crop_year"] = crop_year(df["date"], start_month)
    df["month"] = df["date"].dt.month
    rows = []
    for (code, cy), g in df.groupby(["code", "crop_year"]):
        season = g[g.month.isin(season_months)].sort_values("date")
        expected = sum(_days_in_month(cy, m, start_month) for m in season_months)
        if len(season) != expected or season.PRECTOTCORR.isna().any():
            continue
        row: dict[str, Any] = {"code": code, "crop_year": cy}
        row.update({f"season_{k}": v for k, v in rain_indices(season.PRECTOTCORR, rain_cfg).items()})
        for name, months in sub_seasons.items():
            part = season[season.month.isin(months)]
            row.update({f"{name}_{k}": v for k, v in rain_indices(part.PRECTOTCORR, rain_cfg).items()})
        row["season_gwetroot"] = float(season.GWETROOT.mean())
        row["season_tmax_c"] = float(season.T2M_MAX.mean())
        rows.append(row)
    return pd.DataFrame(rows)


def _days_in_month(cy: int, month: int, start_month: int) -> int:
    year = cy - 1 if month >= start_month else cy
    return pd.Period(f"{year}-{month:02d}").days_in_month


def add_anomalies(df: pd.DataFrame, metrics: list[str], baseline: tuple[int, int]) -> pd.DataFrame:
    """For each metric add ``<metric>_anom`` (minus the baseline mean) and, for totals,
    ``<metric>_anom_pct``. Baseline means are per municipality."""
    out = df.copy()
    base = out[(out.crop_year >= baseline[0]) & (out.crop_year <= baseline[1])]
    means = base.groupby("code")[metrics].mean()
    for m in metrics:
        mean = out["code"].map(means[m])
        out[f"{m}_anom"] = out[m] - mean
        if m.endswith("_mm"):
            out[f"{m}_anom_pct"] = 100 * (out[m] - mean) / mean
    return out


# --------------------------------------------------------------------------------------------
# ENSO label per crop year
# --------------------------------------------------------------------------------------------


def crop_year_enso(seasonal: pd.DataFrame, reference_season: str, strong: list[str]) -> pd.DataFrame:
    """ENSO class of each crop year from the RONI phase/strength at ``reference_season``.

    ``enso_seasonal.parquet`` already carries ``crop_year`` per 3-month season, so NDJ 2015
    (Nov 2015 - Jan 2016) lands in crop year 2016, as it should.
    """
    ref = seasonal[seasonal.season == reference_season].dropna(subset=["roni"])
    rows = []
    for r in ref.itertuples():
        phase = str(r.roni_phase)
        if phase.startswith("el_nino"):
            cls = "el_nino_strong" if r.roni_strength in strong else "el_nino_moderate"
        elif phase.startswith("la_nina"):
            cls = "la_nina"
        else:
            cls = "neutral"
        rows.append({
            "crop_year": int(r.crop_year), "enso_class": cls, "roni_ref": float(r.roni),
            "roni_strength": r.roni_strength, "provisional": phase.endswith("_provisional"),
            "basis": f"RONI {reference_season} {int(r.year)}",
        })
    return pd.DataFrame(rows)


def forecast_class(strength_row: pd.Series, strong_bins: list[str], moderate_bins: list[str]) -> tuple[str, int]:
    """Most likely ENSO class for a not-yet-observed season, from CPC strength probabilities.

    Returns (class, probability %). Only used for the current crop year before its reference
    season has been observed; labelled as a forecast everywhere it appears.
    """
    p = {
        "el_nino_strong": int(sum(strength_row[f"p_{b}"] for b in strong_bins)),
        "el_nino_moderate": int(sum(strength_row[f"p_{b}"] for b in moderate_bins)),
        "neutral": int(strength_row["p_neutral"]),
        "la_nina": int(strength_row["p_la_nina"]),
    }
    best = max(p, key=p.get)
    return best, p[best]


# --------------------------------------------------------------------------------------------
# Yield
# --------------------------------------------------------------------------------------------


def yield_anomalies(series: pd.DataFrame, min_years: int, col: str = "yield_kg_ha") -> pd.DataFrame:
    """Linear-trend anomalies for one municipality x crop yield series (columns year, ``col``).

    Only positive, flag-free yields enter the trend. Returns an empty frame when there are fewer
    than ``min_years`` of them. The trend column is ``col`` with "yield" replaced by "trend". The
    anomaly is a percentage, so the unit of the series does not matter.
    """
    trend_col = col.replace("yield", "trend", 1)
    s = series.dropna(subset=[col])
    s = s[s[col] > 0].sort_values("year")
    if len(s) < min_years:
        return s.iloc[0:0].assign(**{trend_col: [], "anomaly_pct": []})
    slope, intercept = np.polyfit(s.year, s[col], 1)
    trend = slope * s.year + intercept
    return s.assign(**{trend_col: trend, "anomaly_pct": 100 * (s[col] - trend) / trend})


def main_crops(area: pd.DataFrame, last_years: int, min_share: float) -> list[int]:
    """Crop codes whose mean planted area over the last ``last_years`` PAM years is at least
    ``min_share`` of the municipality's total (columns year, crop_code, value)."""
    recent = area[area.year > area.year.max() - last_years]
    mean = recent.groupby("crop_code").value.mean()
    total = mean.sum()
    if total <= 0:
        return []
    return mean[mean / total >= min_share].sort_values(ascending=False).index.astype(int).tolist()


# --------------------------------------------------------------------------------------------
# Composites
# --------------------------------------------------------------------------------------------


def composite(df: pd.DataFrame, value_col: str, keys: list[str]) -> pd.DataFrame:
    """Mean of ``value_col`` by ENSO class within ``keys``, with n and the years used.

    Every class appears for every key, with n = 0 and mean NaN when there were no such years, so
    the UI can show "no strong El Nino on record here" instead of silently dropping the bar.
    """
    rows = []
    for key, g in df.dropna(subset=[value_col]).groupby(keys):
        key = key if isinstance(key, tuple) else (key,)
        neutral = g[g.enso_class == "neutral"][value_col]
        for cls in ENSO_CLASSES:
            sub = g[g.enso_class == cls]
            vals = sub[value_col]
            rows.append({
                **dict(zip(keys, key)),
                "enso_class": cls,
                "n": int(len(vals)),
                "mean": float(vals.mean()) if len(vals) else np.nan,
                "median": float(vals.median()) if len(vals) else np.nan,
                "minus_neutral": float(vals.mean() - neutral.mean()) if len(vals) and len(neutral) else np.nan,
                "years": ",".join(str(int(y)) for y in sorted(sub.crop_year)),
            })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------------
# Season to date (the "impact preview")
# --------------------------------------------------------------------------------------------


def season_progress(
    daily: pd.DataFrame,
    code: int,
    season_start_month: int,
    season_days: int,
    current_crop_year: int,
    baseline: tuple[int, int],
    analog_years: list[int],
    start_month: int = 7,
) -> pd.DataFrame:
    """Cumulative rainfall from the first day of the season, day by day.

    Columns: day (0 = first day of the season), current (this crop year, to date), baseline mean
    and 10th/90th percentile across baseline crop years, and the mean over ``analog_years``.
    Days are counted from the season start, so leap years shift a calendar date by one day at
    most from February on.
    """
    d = daily[daily.code == code].copy()
    d["crop_year"] = crop_year(d["date"], start_month)

    def cumulative(cy: int) -> pd.Series:
        start_year = cy - 1 if season_start_month >= start_month else cy
        start = pd.Timestamp(start_year, season_start_month, 1)
        part = d[(d.date >= start) & (d.date < start + pd.Timedelta(days=season_days))]
        s = part.set_index((part.date - start).dt.days).PRECTOTCORR.cumsum()
        return s

    base_years = [y for y in range(baseline[0], baseline[1] + 1)]
    base = pd.DataFrame({y: cumulative(y) for y in base_years}).reindex(range(season_days))
    complete = base.columns[base.notna().all()]
    base = base[complete]
    analog = pd.DataFrame({y: cumulative(y) for y in analog_years}).reindex(range(season_days))
    analog = analog[analog.columns[analog.notna().all()]]
    cur = cumulative(current_crop_year).reindex(range(season_days))

    first = pd.Timestamp(current_crop_year - 1 if season_start_month >= start_month else current_crop_year,
                         season_start_month, 1)
    return pd.DataFrame({
        "code": code,
        "day": range(season_days),
        "date": [first + pd.Timedelta(days=i) for i in range(season_days)],
        "current_mm": cur.to_numpy(),
        "baseline_mean_mm": base.mean(axis=1).to_numpy(),
        "baseline_p10_mm": base.quantile(0.1, axis=1).to_numpy(),
        "baseline_p90_mm": base.quantile(0.9, axis=1).to_numpy(),
        "analog_mean_mm": analog.mean(axis=1).to_numpy() if analog.shape[1] else np.nan,
        "n_baseline": base.shape[1],
        "n_analog": analog.shape[1],
        "analog_years": ",".join(str(y) for y in analog.columns),
    })


# --------------------------------------------------------------------------------------------
# Forecasts (Meteomatics) against the POWER climatology
# --------------------------------------------------------------------------------------------


def window_climatology(
    daily: pd.DataFrame,
    code: int,
    start: pd.Timestamp,
    end: pd.Timestamp,
    years: list[int],
    column: str = "PRECTOTCORR",
) -> pd.Series:
    """Total of ``column`` over the same calendar window [start, end] in each of ``years``.

    The window may cross the new year; year Y means the window that *starts* in Y. Windows with
    any missing day are dropped. Returns a Series indexed by year.
    """
    d = daily[daily.code == code].set_index("date")[column]
    out = {}
    span = (end - start).days
    for y in years:
        try:
            s = pd.Timestamp(y, start.month, start.day)
        except ValueError:  # 29 Feb in a non-leap year
            s = pd.Timestamp(y, start.month, 28)
        part = d.loc[s: s + pd.Timedelta(days=span)]
        if len(part) == span + 1 and part.notna().all():
            out[y] = float(part.sum())
    return pd.Series(out, dtype="float64")


def forecast_summary(
    fc: pd.DataFrame,
    daily: pd.DataFrame,
    code: int,
    first_forecast_day: pd.Timestamp,
    baseline: tuple[int, int],
    analog_years: list[int],
    heavy_day_mm: float,
    wet_day_mm: float,
) -> dict[str, Any]:
    """Headline numbers for the short-range forecast from ``first_forecast_day`` onwards.

    Rain total, heavy-rain days, longest dry spell, reference ET and the climatic water balance
    (rain minus ET0) -- each next to the POWER 1991-2020 normal for the same calendar dates and the
    strong-El-Nino analog mean. ``analog_years`` are crop years; the calendar window is taken in
    the year it falls in for that crop year.
    """
    f = fc[(fc.date >= first_forecast_day)].dropna(subset=["rain"]).sort_values("date")
    if f.empty:
        return {}
    start, end = f.date.min(), f.date.max()
    base_years = list(range(baseline[0] - 1, baseline[1] + 1))
    clim = window_climatology(daily, code, start, end, base_years)
    # Keep only windows whose crop year is in the baseline.
    in_base = [y for y in clim.index if baseline[0] <= _crop_year_of(pd.Timestamp(y, start.month, 1)) <= baseline[1]]
    clim_b = clim.loc[in_base]
    analog_start_years = [cy - 1 if start.month >= 7 else cy for cy in analog_years]
    clim_a = window_climatology(daily, code, start, end, analog_start_years)
    out = {
        "start": start, "end": end, "days": int(len(f)),
        "rain_mm": float(f.rain.sum()),
        "heavy_days": int((f.rain >= heavy_day_mm).sum()),
        "max_dry_spell_days": int(max_dry_spell(f.rain, wet_day_mm)),
        "normal_rain_mm": float(clim_b.mean()) if len(clim_b) else np.nan,
        "normal_p10_mm": float(clim_b.quantile(0.1)) if len(clim_b) else np.nan,
        "normal_p90_mm": float(clim_b.quantile(0.9)) if len(clim_b) else np.nan,
        "n_normal_years": int(len(clim_b)),
        "analog_rain_mm": float(clim_a.mean()) if len(clim_a) else np.nan,
        "n_analog_years": int(len(clim_a)),
    }
    if "et0" in f and f.et0.notna().any():
        out["et0_mm"] = float(f.et0.sum())
        out["water_balance_mm"] = out["rain_mm"] - out["et0_mm"]
    for col in ("smi_15cm", "smi_50cm"):
        if col in fc and fc[col].notna().any():
            s = fc.dropna(subset=[col]).sort_values("date")
            first = s[s.date >= first_forecast_day]
            if not first.empty:
                out[f"{col}_start"] = float(first[col].iloc[0])
                out[f"{col}_end"] = float(first[col].iloc[-1])
    return out


def _crop_year_of(ts: pd.Timestamp, start_month: int = 7) -> int:
    return ts.year + (1 if ts.month >= start_month else 0)


def ensemble_progress(progress: pd.DataFrame, bridge: pd.DataFrame, members: pd.DataFrame) -> pd.DataFrame:
    """Continue one municipality's season-to-date curve with an ensemble forecast.

    ``progress``  one municipality's season_progress rows (date, current_mm, ...).
    ``bridge``    deterministic daily rain (date, rain) for the days between the last observed
                  POWER day and the ensemble's first day (POWER's publication lag).
    ``members``   ensemble daily rain (date, member, rain).

    Every member gets its own cumulative curve, starting from the observed total plus the bridge;
    the median and 10th/90th percentiles are taken *across members* for each day. Adds
    forecast_median_mm, forecast_p10_mm, forecast_p90_mm (equal on observed/bridge days).
    """
    out = progress.copy()
    for col in ("forecast_median_mm", "forecast_p10_mm", "forecast_p90_mm"):
        out[col] = np.nan
    obs = out.dropna(subset=["current_mm"])
    if obs.empty or members.empty:
        return out
    last = obs.iloc[-1]
    ens_start = members.date.min()
    br = bridge[(bridge.date > last.date) & (bridge.date < ens_start)].sort_values("date")
    fixed = {last.date: last.current_mm}
    running = last.current_mm
    for d, r in zip(br.date, br.rain.fillna(0.0)):
        running += r
        fixed[d] = running
    m = members.pivot_table(index="date", columns="member", values="rain").sort_index()
    cum = running + m.cumsum()
    q = cum.quantile([0.1, 0.5, 0.9], axis=1).T
    for i, d in out.date.items():
        if d in fixed:
            out.loc[i, ["forecast_median_mm", "forecast_p10_mm", "forecast_p90_mm"]] = fixed[d]
        elif d in q.index:
            out.at[i, "forecast_p10_mm"] = q.at[d, 0.1]
            out.at[i, "forecast_median_mm"] = q.at[d, 0.5]
            out.at[i, "forecast_p90_mm"] = q.at[d, 0.9]
    return out


def monthly_outlook(
    members: pd.DataFrame,
    daily: pd.DataFrame,
    code: int,
    months: list[int],
    baseline: tuple[int, int],
    analog_years: list[int],
    start_month: int = 7,
) -> pd.DataFrame:
    """Seasonal-forecast rain for every *complete* month it covers, summarised across members
    (median, 10th-90th percentile of the members' monthly totals), next to the POWER 1991-2020
    monthly normal (mean, p10, p90) and the strong-El-Nino analog mean.
    """
    m = members.dropna(subset=["rain"]).copy()
    d = daily[daily.code == code].copy()
    d["crop_year"] = crop_year(d.date, start_month)
    d["ym"] = d.date.dt.to_period("M")
    monthly_obs = d.groupby(["crop_year", "ym"]).PRECTOTCORR.agg(["sum", "count"]).reset_index()
    rows = []
    for period in pd.period_range(m.date.min(), m.date.max(), freq="M"):
        if period.month not in months:
            continue
        part = m[(m.date >= period.start_time) & (m.date <= period.end_time.normalize())]
        per_member = part.groupby("member").agg(total=("rain", "sum"), days=("rain", "size"))
        per_member = per_member[per_member.days == period.days_in_month].total
        if per_member.empty:
            continue  # partial month at either end
        same = monthly_obs[(monthly_obs.ym.dt.month == period.month) & (monthly_obs["count"] == period.days_in_month)]
        base = same[(same.crop_year >= baseline[0]) & (same.crop_year <= baseline[1])]["sum"]
        ana = same[same.crop_year.isin(analog_years)]["sum"]
        rows.append({
            "code": code, "month": period.strftime("%Y-%m"),
            "forecast_median_mm": float(per_member.median()),
            "forecast_p10_mm": float(per_member.quantile(0.1)),
            "forecast_p90_mm": float(per_member.quantile(0.9)),
            "n_members": int(len(per_member)),
            "normal_mm": float(base.mean()) if len(base) else np.nan,
            "normal_p10_mm": float(base.quantile(0.1)) if len(base) else np.nan,
            "normal_p90_mm": float(base.quantile(0.9)) if len(base) else np.nan,
            "analog_mm": float(ana.mean()) if len(ana) else np.nan,
            "n_analog": int(len(ana)),
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------------
# Vegetation (MODIS NDVI)
# --------------------------------------------------------------------------------------------


def ndvi_by_crop_year(
    comp: pd.DataFrame, peak_months: list[int], min_valid_fraction: float, min_composites: int,
    start_month: int = 7,
) -> pd.DataFrame:
    """Peak-season mean cropland NDVI per (code, crop_year), from usable composites only."""
    c = comp[comp.valid_cropland_fraction >= min_valid_fraction].copy()
    c = c[c.date.dt.month.isin(peak_months)]
    c["crop_year"] = crop_year(c.date, start_month)
    g = c.groupby(["code", "crop_year"]).ndvi_cropland.agg(["mean", "count"]).reset_index()
    g = g[g["count"] >= min_composites]
    return g.rename(columns={"mean": "ndvi_peak", "count": "n_composites"})


def ndvi_progress(
    comp: pd.DataFrame,
    code: int,
    season_months: list[int],
    current_cy: int,
    baseline: tuple[int, int],
    analog_years: list[int],
    min_valid_fraction: float,
    start_month: int = 7,
) -> pd.DataFrame:
    """Cropland NDVI per 16-day composite slot of the season: this crop year vs the baseline
    (mean, p10, p90) and the strong-El-Nino analogs.

    MODIS composites start on fixed days of year (1, 17, 33, ...), so a slot is identified by its
    day of year; leap years shift the calendar date by one day, never the slot.
    """
    c = comp[(comp.code == code) & (comp.valid_cropland_fraction >= min_valid_fraction)].copy()
    c = c[c.date.dt.month.isin(season_months)]
    c["crop_year"] = crop_year(c.date, start_month)
    c["doy"] = c.date.dt.dayofyear
    # Season order: slots from the season start month onwards come first.
    c["order"] = np.where(c.date.dt.month >= start_month, c.doy, c.doy + 366)
    slots = sorted(c.order.unique())
    rows = []
    for o in slots:
        s = c[c.order == o]
        base = s[(s.crop_year >= baseline[0]) & (s.crop_year <= baseline[1])].ndvi_cropland
        ana = s[s.crop_year.isin(analog_years)].ndvi_cropland
        cur = s[s.crop_year == current_cy].ndvi_cropland
        ref_doy = int(s.doy.iloc[0])
        rows.append({
            "code": code, "slot": int(o), "doy": ref_doy,
            "label_date": (pd.Timestamp(2001 if o <= 366 else 2002, 1, 1) + pd.Timedelta(days=ref_doy - 1)).strftime("%m-%d"),
            "current": float(cur.iloc[0]) if len(cur) else np.nan,
            "current_date": s[s.crop_year == current_cy].date.iloc[0] if len(cur) else pd.NaT,
            "baseline_mean": float(base.mean()) if len(base) else np.nan,
            "baseline_p10": float(base.quantile(0.1)) if len(base) else np.nan,
            "baseline_p90": float(base.quantile(0.9)) if len(base) else np.nan,
            "n_baseline": int(len(base)),
            "analog_mean": float(ana.mean()) if len(ana) else np.nan,
            "n_analog": int(len(ana)),
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------------
# Monthly climate by ENSO class (input to rotation scoring)
# --------------------------------------------------------------------------------------------


def monthly_climate_by_class(
    daily: pd.DataFrame, cy_enso: pd.DataFrame, heavy_day_mm: float, start_month: int = 7
) -> pd.DataFrame:
    """Mean monthly rain, heavy-rain days and ET0 per (code, ENSO class, calendar month).

    ``daily`` needs code, date, PRECTOTCORR and ET0. A month enters the rain/heavy-day means only if
    every day has rain, and the ET0 mean only if every day has ET0 (POWER's solar radiation has gaps
    in the early 1980s). Months take the ENSO class of their crop year (Jul-Jun); forecast crop years
    are excluded. Class "all" is every observed year, for reference.
    """
    d = daily.copy()
    d["crop_year"] = crop_year(d.date, start_month)
    d["month"] = d.date.dt.month
    d["heavy"] = (d.PRECTOTCORR >= heavy_day_mm).astype(float).where(d.PRECTOTCORR.notna())
    g = d.groupby(["code", "crop_year", "month"]).agg(
        days=("date", "size"), rain_days=("PRECTOTCORR", "count"), et0_days=("ET0", "count"),
        rain_mm=("PRECTOTCORR", "sum"), heavy_days=("heavy", "sum"), et0_mm=("ET0", "sum"),
        first=("date", "min"),
    ).reset_index()
    full = g.first.dt.days_in_month
    g.loc[(g.days != full) | (g.rain_days != full), ["rain_mm", "heavy_days"]] = np.nan
    g.loc[(g.days != full) | (g.et0_days != full), "et0_mm"] = np.nan
    obs = cy_enso[~cy_enso.forecast.fillna(False).astype(bool)][["crop_year", "enso_class"]]
    g = g.merge(obs, on="crop_year", how="inner")
    both = pd.concat([g, g.assign(enso_class="all")], ignore_index=True)
    out = both.groupby(["code", "enso_class", "month"]).agg(
        rain_mm=("rain_mm", "mean"), heavy_days=("heavy_days", "mean"), et0_mm=("et0_mm", "mean"),
        n_years=("rain_mm", "count"), n_years_et0=("et0_mm", "count"),
    ).reset_index()
    return out
