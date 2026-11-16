"""Experiment (not a frozen block): crop water demand per crop from NASA POWER, by FAO-56.

Block 6 prints `remaining = in - out` with `out` = POWER EVLAND, and says beside the number that it is
not a crop water demand and that no reference evapotranspiration is used (block 6 R-24, OD-02,
CO-B6-07). The comparator spec carries crop water demand as CO-B8-10. This module computes evidence
for that open decision, without implementing the comparator:

    ET0  FAO-56 Penman-Monteith, eq. 6, from POWER T2M_MAX, T2M_MIN, T2MDEW (or RH2M), WS2M,
         ALLSKY_SFC_SW_DWN and PS; Hargreaves, eq. 52, on a day whose radiation, humidity or wind is
         missing; no value on a day without both temperatures.
    ETc  Kc x ET0, single crop coefficient, FAO-56 Table 12 values (eq. 56). Mid-season Kc by default
         (the peak demand), or the eq. 66 curve when a sowing date and the four stage lengths are given.
    difference  sum(PRECTOTCORR) - sum(ETc) over block 6's 42 day window.

Every function is pure: no network, no clock, no file. Coverage follows block 6 R-19 (80 percent) for
the ET0 and ETc totals, and block 6 R-22 (every day) for the climatic difference, as for the water
balance. The difference is not an irrigation deficit and is not a soil-water balance.
The Kc values are FAO's standard-climate values (RHmin 45 percent, u2 2 m/s), not adjusted with eq. 62
and not calibrated for any Brazilian or United States field. The basis of every row is `modelled`.
"""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import aggregates as agg

SOLAR_CONSTANT = 0.0820  # MJ m-2 min-1
STEFAN_BOLTZMANN = 4.903e-9  # MJ K-4 m-2 day-1
ALBEDO = 0.23
LATENT_HEAT = 2.45  # MJ kg-1, FAO-56 eq. 20 simplification

SOURCE = ("NASA POWER daily point, community AG (T2M_MAX, T2M_MIN, T2MDEW, RH2M, WS2M, ALLSKY_SFC_SW_DWN, "
          "PS, PRECTOTCORR); FAO-56 eq. 6, 52 and 56")
RESOLUTION = "0.5 degree cell (meteorology), 1 degree cell (solar)"
FAO_TABLE_12 = "FAO-56 Table 12, standard climate (RHmin 45 percent, u2 2 m/s), not adjusted with eq. 62"

CROPS: dict[str, dict[str, Any]] = {
    "soybean": {"name": "Soybeans", "kc_ini": 0.40, "kc_mid": 1.15, "kc_end": 0.50,
                "source": FAO_TABLE_12},
    "maize": {"name": "Maize, field (grain)", "kc_ini": 0.30, "kc_mid": 1.20, "kc_end": 0.60,
              "source": f"{FAO_TABLE_12}; Kc end 0.60 is the high moisture harvest value, 0.35 if field dried"},
    "cotton": {"name": "Cotton", "kc_ini": 0.35, "kc_mid": 1.15, "kc_end": 0.50,
               "source": f"{FAO_TABLE_12}; Kc mid printed as 1.15 to 1.20 and Kc end as 0.70 to 0.50, "
                         "the lower bounds are used"},
}


def _finite(name: str, value: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def _temperature_pair(tmax: float, tmin: float) -> tuple[float, float]:
    tmax = _finite("tmax", tmax)
    tmin = _finite("tmin", tmin)
    if tmax < tmin:
        raise ValueError("tmax must be greater than or equal to tmin")
    if tmin <= -237.3:
        raise ValueError("temperature is outside the domain of the FAO-56 vapour-pressure equation")
    return tmax, tmin


# --- FAO-56 chapter 3 equations ---------------------------------------------------------------

def atmospheric_pressure(elevation: float) -> float:
    """Eq. 7, kPa."""
    elevation = _finite("elevation", elevation)
    base = (293.0 - 0.0065 * elevation) / 293.0
    if base <= 0:
        raise ValueError("elevation is outside the domain of FAO-56 equation 7")
    return 101.3 * base ** 5.26


def psychrometric_constant(pressure: float) -> float:
    """Eq. 8, kPa C-1."""
    pressure = _finite("pressure", pressure)
    if pressure <= 0:
        raise ValueError("pressure must be positive")
    return 0.665e-3 * pressure


def saturation_vapour_pressure(t: float) -> float:
    """Eq. 11, kPa."""
    t = _finite("temperature", t)
    if t <= -237.3:
        raise ValueError("temperature is outside the domain of FAO-56 equation 11")
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def mean_saturation_vapour_pressure(tmax: float, tmin: float) -> float:
    """Eq. 12, kPa."""
    tmax, tmin = _temperature_pair(tmax, tmin)
    return (saturation_vapour_pressure(tmax) + saturation_vapour_pressure(tmin)) / 2.0


def slope_saturation_vapour_pressure(t: float) -> float:
    """Eq. 13, kPa C-1, at the mean temperature."""
    return 4098.0 * saturation_vapour_pressure(t) / (t + 237.3) ** 2


def actual_vapour_pressure_from_dew_point(tdew: float) -> float:
    """Eq. 14, kPa. FAO-56's preferred humidity route."""
    return saturation_vapour_pressure(tdew)


def actual_vapour_pressure_from_rh_mean(rh_mean: float, tmax: float, tmin: float) -> float:
    """Eq. 19, kPa. The less preferred route, used when the dew point is missing."""
    rh_mean = _finite("rh_mean", rh_mean)
    if not 0.0 <= rh_mean <= 100.0:
        raise ValueError("relative humidity must be between 0 and 100 percent")
    return rh_mean / 100.0 * mean_saturation_vapour_pressure(tmax, tmin)


def extraterrestrial_radiation(latitude: float, day_of_year: int) -> float:
    """Eq. 21 with eq. 23 to 25, MJ m-2 day-1. Latitude in decimal degrees, south negative."""
    latitude = _finite("latitude", latitude)
    if not -90.0 <= latitude <= 90.0:
        raise ValueError("latitude must be between -90 and 90 degrees")
    if not isinstance(day_of_year, int) or isinstance(day_of_year, bool) or not 1 <= day_of_year <= 366:
        raise ValueError("day_of_year must be an integer from 1 to 366")
    phi = math.radians(latitude)
    dr = 1.0 + 0.033 * math.cos(2.0 * math.pi * day_of_year / 365.0)
    delta = 0.409 * math.sin(2.0 * math.pi * day_of_year / 365.0 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(delta))))
    value = 24.0 * 60.0 / math.pi * SOLAR_CONSTANT * dr * (
        ws * math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.sin(ws))
    return max(0.0, value)


def clear_sky_radiation(ra: float, elevation: float) -> float:
    """Eq. 37, MJ m-2 day-1."""
    ra = _finite("ra", ra)
    elevation = _finite("elevation", elevation)
    factor = 0.75 + 2e-5 * elevation
    if ra < 0 or factor <= 0:
        raise ValueError("clear-sky radiation inputs are outside the physical domain")
    return factor * ra


def net_longwave_radiation(tmax: float, tmin: float, ea: float, rs: float, rso: float) -> float:
    """Eq. 39, MJ m-2 day-1. Rs/Rso is capped at 1."""
    tmax, tmin = _temperature_pair(tmax, tmin)
    ea, rs, rso = _finite("ea", ea), _finite("rs", rs), _finite("rso", rso)
    if ea < 0 or rs < 0 or rso <= 0:
        raise ValueError("ea and rs must be non-negative and rso must be positive")
    ratio = max(0.0, min(rs / rso, 1.0))
    tk4 = ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2.0
    return STEFAN_BOLTZMANN * tk4 * (0.34 - 0.14 * math.sqrt(ea)) * (1.35 * ratio - 0.35)


def et0_penman_monteith(*, tmax: float, tmin: float, rs: float, ea: float, u2: float, ra: float,
                        pressure: float, elevation: float) -> float:
    """Eq. 6, mm day-1, daily step, soil heat flux G = 0 (eq. 42)."""
    tmax, tmin = _temperature_pair(tmax, tmin)
    rs, ea, u2, ra = (_finite("rs", rs), _finite("ea", ea), _finite("u2", u2),
                      _finite("ra", ra))
    if rs < 0 or ea < 0 or u2 < 0 or ra < 0:
        raise ValueError("radiation, vapour pressure and wind speed must be non-negative")
    tmean = (tmax + tmin) / 2.0
    delta = slope_saturation_vapour_pressure(tmean)
    gamma = psychrometric_constant(pressure)
    es = mean_saturation_vapour_pressure(tmax, tmin)
    if ea > es:
        raise ValueError("actual vapour pressure cannot exceed mean saturation vapour pressure")
    rn = (1.0 - ALBEDO) * rs - net_longwave_radiation(tmax, tmin, ea, rs, clear_sky_radiation(ra, elevation))
    numerator = 0.408 * delta * rn + gamma * 900.0 / (tmean + 273.0) * u2 * (es - ea)
    return max(0.0, numerator / (delta + gamma * (1.0 + 0.34 * u2)))


def et0_hargreaves(tmax: float, tmin: float, ra: float) -> float:
    """Eq. 52, mm day-1. Ra is converted to evaporation equivalent with 0.408 (eq. 20)."""
    tmax, tmin = _temperature_pair(tmax, tmin)
    ra = _finite("ra", ra)
    if ra < 0:
        raise ValueError("extraterrestrial radiation must be non-negative")
    tmean = (tmax + tmin) / 2.0
    return max(0.0, 0.0023 * (tmean + 17.8) * math.sqrt(tmax - tmin) * 0.408 * ra)


def crop_coefficient(crop: dict[str, Any], day: int, stages: tuple[int, int, int, int]) -> float | None:
    """Eq. 66 curve: flat initial, linear development, flat mid, linear late season.

    ``day`` follows FAO-56 equation 66 and is one-based: sowing is day 1 and the final day is the sum
    of the four positive stage lengths. A caller with a zero-based date delta must add one.
    """
    if (not isinstance(day, int) or isinstance(day, bool) or len(stages) != 4 or
            any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in stages)):
        raise ValueError("day must be an integer and all four stage lengths must be positive integers")
    ini, dev, mid, late = stages
    total = ini + dev + mid + late
    if day < 1 or day > total:
        return None
    if day <= ini:
        return crop["kc_ini"]
    if day <= ini + dev:
        return crop["kc_ini"] + (day - ini) / dev * (crop["kc_mid"] - crop["kc_ini"])
    if day <= ini + dev + mid:
        return crop["kc_mid"]
    return crop["kc_mid"] + (day - ini - dev - mid) / late * (crop["kc_end"] - crop["kc_mid"])


# --- the window --------------------------------------------------------------------------------

def _value(series: dict[str, dict[date, float]], name: str, day: date) -> float | None:
    value = series.get(name, {}).get(day)
    return value if agg.is_valid(value) else None


def daily_et0(series: dict[str, dict[date, float]], *, latitude: float, elevation: float,
              window: agg.Window) -> list[dict[str, Any]]:
    """One transparent entry per day.

    Missing or invalid temperatures abstain. Missing or invalid auxiliary Penman-Monteith inputs use
    the empirical Hargreaves fallback and record why. No invalid input is silently clamped into a
    meteorological value.
    """
    extraterrestrial_radiation(latitude, window.start.timetuple().tm_yday)
    atmospheric_pressure(elevation)
    out: list[dict[str, Any]] = []
    for day in agg.window_days(window):
        tmax, tmin = _value(series, "T2M_MAX", day), _value(series, "T2M_MIN", day)
        if tmax is None or tmin is None:
            missing = [name for name, value in (("T2M_MAX", tmax), ("T2M_MIN", tmin)) if value is None]
            out.append({"date": day.isoformat(), "et0": None, "method": None,
                        "reason": f"missing {', '.join(missing)}"})
            continue
        try:
            tmax, tmin = _temperature_pair(tmax, tmin)
            ra = extraterrestrial_radiation(latitude, day.timetuple().tm_yday)
        except ValueError as error:
            out.append({"date": day.isoformat(), "et0": None, "method": None,
                        "reason": f"invalid temperature or location: {error}"})
            continue
        rs, u2 = _value(series, "ALLSKY_SFC_SW_DWN", day), _value(series, "WS2M", day)
        tdew, rh = _value(series, "T2MDEW", day), _value(series, "RH2M", day)
        humidity_note: str | None = None
        ea: float | None = None
        if tdew is not None:
            try:
                ea = actual_vapour_pressure_from_dew_point(tdew)
                if ea > mean_saturation_vapour_pressure(tmax, tmin):
                    raise ValueError("dew-point vapour pressure exceeds saturation vapour pressure")
            except ValueError as error:
                ea = None
                humidity_note = f"invalid T2MDEW: {error}"
        if ea is None and rh is not None:
            try:
                ea = actual_vapour_pressure_from_rh_mean(rh, tmax, tmin)
                if humidity_note:
                    humidity_note += "; RH2M used instead"
            except ValueError as error:
                humidity_note = f"{humidity_note + '; ' if humidity_note else ''}invalid RH2M: {error}"
        if rs is not None and u2 is not None and ea is not None:
            pressure = _value(series, "PS", day)
            pressure_note = None
            if pressure is None:
                pressure = atmospheric_pressure(elevation)
                pressure_note = "PS missing; pressure estimated from elevation with FAO-56 equation 7"
            try:
                value = et0_penman_monteith(tmax=tmax, tmin=tmin, rs=rs, ea=ea, u2=u2, ra=ra,
                                            pressure=pressure, elevation=elevation)
                notes = [note for note in (humidity_note, pressure_note) if note]
                out.append({"date": day.isoformat(), "et0": value, "method": "penman-monteith",
                            "reason": "; ".join(notes) if notes else None})
                continue
            except ValueError as error:
                fallback_reason = f"invalid Penman-Monteith input: {error}"
        else:
            missing = [name for name, value in (("ALLSKY_SFC_SW_DWN", rs), ("WS2M", u2),
                                                 ("humidity", ea)) if value is None]
            fallback_reason = f"missing or invalid {', '.join(missing)}"
            if humidity_note:
                fallback_reason += f"; {humidity_note}"
        out.append({"date": day.isoformat(), "et0": et0_hargreaves(tmax, tmin, ra),
                    "method": "hargreaves", "reason": fallback_reason})
    return out


def _row(metric: str, value: Any, unit: str, as_of: str | None) -> dict[str, Any]:
    return {"metric": metric, "label": f"numbers.{metric.split('.')[0]}", "value": value, "unit": unit,
            "basis": "modelled", "as_of": as_of, "source": SOURCE, "resolution": RESOLUTION,
            "route": "derived", "fetched_at": None}


def crop_water(series: dict[str, dict[date, float]], *, latitude: float, elevation: float,
               window: agg.Window, crop_id: str, sowing: date | None = None,
               stages: tuple[int, int, int, int] | None = None) -> dict[str, Any]:
    """The crop water section for one crop over one window. Never defaults a missing value."""
    if sowing is not None and stages is None:
        raise ValueError("a sowing date needs the four stage lengths (FAO-56 Table 11); none is assumed")
    if crop_id not in CROPS:
        raise ValueError(f"unsupported crop_id: {crop_id}")
    crop = CROPS[crop_id]
    daily = daily_et0(series, latitude=latitude, elevation=elevation, window=window)
    kc_mode = "curve from sowing" if sowing is not None else "mid-season"
    et0_sum = etc_sum = 0.0
    valid = 0
    for entry in daily:
        day = date.fromisoformat(entry["date"])
        kc = crop["kc_mid"] if sowing is None else crop_coefficient(crop, (day - sowing).days + 1, stages)
        entry["kc"] = kc
        entry["etc"] = entry["et0"] * kc if entry["et0"] is not None and kc is not None else None
        if entry["etc"] is not None:
            valid += 1
            et0_sum += entry["et0"]
            etc_sum += entry["etc"]
    methods = {m: sum(1 for d in daily if d["method"] == m) for m in ("penman-monteith", "hargreaves")}
    rain = [_value(series, "PRECTOTCORR", date.fromisoformat(d["date"])) for d in daily]
    rain = [value if value is None or value >= 0 else None for value in rain]
    rain_ok = all(r is not None for r in rain)
    as_of = window.end.isoformat()
    result: dict[str, Any] = {
        "crop_id": crop_id, "crop": crop["name"], "kc_mode": kc_mode, "kc_source": crop["source"],
        "window": {"start": window.start.isoformat(), "end": as_of, "days": window.days},
        "valid_days": valid, "methods": methods, "daily": daily,
        "rain_total": agg.round_half_up(sum(rain), 1) if rain_ok else None,
        "state": "ok", "reason": None, "et0_total": None, "etc_total": None,
        "climatic_difference": None,
        "formula": "climatic_difference = sum(PRECTOTCORR) - sum(Kc x ET0)",
        "statement": "A modelled demand from a 0.5 degree reanalysis cell and FAO standard Kc values; "
                     "not a measurement, not calibrated for this field. The climatic difference is "
                     "not an irrigation deficit and not a soil-water balance.",
    }
    if not agg.covered(valid, window.days):
        result.update(state="abstained",
                      reason=f"ET0 on {valid} of {window.days} window days; below 80 percent, the demand abstains")
    else:
        result["et0_total"] = agg.round_half_up(et0_sum, 1)
        result["etc_total"] = agg.round_half_up(etc_sum, 1)
        if rain_ok and valid == window.days:
            result["climatic_difference"] = agg.round_half_up(sum(rain) - etc_sum, 1)
        else:
            result["reason"] = ("the climatic difference needs every window day of rain and ET0, "
                                "as block 6 R-22")
    result["provenance"] = [
        _row("et0_total", result["et0_total"], "mm", as_of),
        _row(f"etc_total.{crop_id}", result["etc_total"], "mm", as_of),
        _row(f"rain_minus_etc.{crop_id}", result["climatic_difference"], "mm", as_of),
    ]
    return result


def evptrns_mm(series: dict[str, dict[date, float]], window: agg.Window) -> float | None:
    """POWER EVPTRNS over the window divided by the latent heat (block 6 OD-02), for comparison only."""
    values = [_value(series, "EVPTRNS", d) for d in agg.window_days(window)]
    if any(v is None or v < 0 for v in values):
        return None
    return agg.round_half_up(sum(values) / LATENT_HEAT, 1)


if __name__ == "__main__":  # the experiment's printout over the recorded response
    import json
    from pathlib import Path

    from sources import power_et0

    artifact = Path(__file__).resolve().parent.parent / "artifacts" / "experiment" / \
        "power-et0-inputs-2026-07-01-2026-11-14.json"
    payload = json.loads(artifact.read_text())
    series = power_et0.parse(payload)
    lon, lat, elevation = power_et0.point(payload)
    window = agg.resolve_window(series["PRECTOTCORR"], date(2026, 11, 14))
    print(f"cell {lon}, {lat}, {elevation} m; unit mismatches: {power_et0.check_units(payload) or 'none'}")
    print(f"window {window.start} to {window.end} ({window.days} days)")
    print(f"POWER EVPTRNS / 2.45 over the window: {evptrns_mm(series, window)} mm")
    for crop_id in CROPS:
        r = crop_water(series, latitude=lat, elevation=elevation, window=window, crop_id=crop_id)
        print(f"{crop_id:8s} state={r['state']} ET0={r['et0_total']} ETc={r['etc_total']} rain={r['rain_total']} "
              f"rain-ETc={r['climatic_difference']} methods={r['methods']}")

# --- the United States path -------------------------------------------------------------------
# The recorded POWER series carries only what block 6 fetches (T2M_MAX, T2M_MIN, PRECTOTCORR), so
# every day here is Hargreaves (eq. 52), which needs no humidity, wind, radiation or elevation. The
# crop's own usual planting window comes from the NASS state bulletin the repository already records
# (`artifacts/us-windows-cass-nd.json`); a crop with no window there, or no FAO-56 Kc here, abstains
# and says which input is missing. No window and no Kc is ever invented.

US_WINDOWS_PATH = Path(__file__).resolve().parents[1] / "artifacts" / "us-windows-cass-nd.json"
# The bulletin's crop names to the FAO-56 crop ids this module carries Kc for.
WINDOW_CROP_IDS = {"corn": "maize", "soybeans": "soybean", "cotton": "cotton"}
SERIES_KEYS = {"tmax_day": "T2M_MAX", "tmin_day": "T2M_MIN", "rain_day": "PRECTOTCORR"}


def load_us_windows(path: Path | None = None) -> dict[str, Any] | None:
    """The NASS windows file, or None when it is not in the tree."""
    try:
        return json.loads(Path(path or US_WINDOWS_PATH).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _series_from_payload(section: dict[str, Any]) -> dict[str, dict[date, float]]:
    """Block 6's recorded daily series, keyed the way this module reads POWER."""
    out: dict[str, dict[date, float]] = {}
    series = section.get("series") or {}
    for payload_key, power_key in SERIES_KEYS.items():
        days: dict[date, float] = {}
        for entry in series.get(payload_key) or []:
            try:
                days[date.fromisoformat(entry["date"])] = float(entry["value"])
            except (KeyError, TypeError, ValueError):
                continue
        out[power_key] = days
    return out


def _planting_window(month_day: dict[str, Any], year: int) -> agg.Window | None:
    """The bulletin's `MM-DD` pair as a window in the recorded season's year."""
    try:
        start = date(year, int(month_day["start"][:2]), int(month_day["start"][3:]))
        end = date(year, int(month_day["end"][:2]), int(month_day["end"][3:]))
    except (KeyError, TypeError, ValueError):
        return None
    if end < start:
        return None
    days = (end - start).days + 1
    return agg.Window(start=start, end=end, days=days, valid_days=days, dropped_days=0, chosen=end)


def field_crop_water(section: dict[str, Any], *, latitude: float, window: agg.Window,
                     location: str | None, windows_path: Path | None = None) -> dict[str, Any]:
    """Crop water demand for one field, or an abstention naming the input that is missing.

    The window the demand is summed over is the crop's own usual planting window from the NASS state
    bulletin, in the year of the recorded block 6 window, and it must lie inside the recorded POWER
    window; anything else abstains instead of borrowing another window.
    """
    series = _series_from_payload(section)
    if not any(series.values()):
        return {"available": False, "reason": "the recorded climate section carries no daily series",
                "limitations": ["no_recorded_series"], "crops": {}, "abstained": {}}
    file = load_us_windows(windows_path)
    if file is None:
        return {"available": False, "reason": "the NASS planting window file is not in the tree",
                "limitations": ["no_window_source"], "crops": {}, "abstained": {}}
    region = file.get("region") or {}
    state = region.get("state") or ""
    rows = {str(row.get("crop", "")).lower(): row for row in file.get("rows") or []}
    common = {"source": SOURCE, "basis": "modelled", "resolution": RESOLUTION,
              "window": {"start": window.start.isoformat(), "end": window.end.isoformat()}}
    abstained: dict[str, str] = {}
    crops: dict[str, dict[str, Any]] = {}
    if not state or state.lower() not in (location or "").lower():
        reason = (f"no cited planting window for this location: the tree records the NASS window for "
                  f"{state or 'no state'} only")
        return {"available": False, "reason": reason, "limitations": ["no_window_for_location"],
                "crops": {}, "abstained": {crop_id: reason for crop_id in CROPS}, **common}
    methods: dict[str, int] = {}
    for crop_name, row in rows.items():
        crop_id = WINDOW_CROP_IDS.get(crop_name)
        month_day = row.get("most_active_md")
        if crop_id is None:
            abstained[crop_name] = (f"no FAO-56 Kc in this repository for {row.get('crop') or crop_name}; "
                                    f"no Kc is invented")
            continue
        if not month_day:
            abstained[crop_id] = (f"the NASS {state} bulletin records no usual planting window for "
                                  f"{row.get('crop') or crop_name}")
            continue
        planting = _planting_window(month_day, window.start.year)
        if planting is None:
            abstained[crop_id] = "the recorded planting window is not a valid date pair"
            continue
        if planting.start < window.start or planting.end > window.end:
            abstained[crop_id] = (f"the recorded NASA POWER window {window.start.isoformat()} to "
                                  f"{window.end.isoformat()} does not cover the crop's planting window "
                                  f"{planting.start.isoformat()} to {planting.end.isoformat()}")
            continue
        crop = CROPS[crop_id]
        et0_sum = etc_sum = rain_sum = 0.0
        valid = rain_days = 0
        for day in agg.window_days(planting):
            tmax, tmin = _value(series, "T2M_MAX", day), _value(series, "T2M_MIN", day)
            rain = _value(series, "PRECTOTCORR", day)
            rain_days += 1 if rain is not None and rain >= 0 else 0
            if tmax is None or tmin is None:
                continue
            try:
                tmax, tmin = _temperature_pair(tmax, tmin)
                ra = extraterrestrial_radiation(latitude, day.timetuple().tm_yday)
            except ValueError:
                continue
            et0 = et0_hargreaves(tmax, tmin, ra)
            et0_sum += et0
            etc_sum += et0 * crop["kc_mid"]
            valid += 1
            methods["hargreaves"] = methods.get("hargreaves", 0) + 1
        entry: dict[str, Any] = {
            "crop_id": crop_id, "crop": crop["name"], "kc_mode": "mid-season", "kc_mid": crop["kc_mid"],
            "kc_source": crop["source"], "planting_window_text": row.get("most_active_text"),
            "window": {"start": planting.start.isoformat(), "end": planting.end.isoformat(),
                       "days": planting.days},
            "valid_days": valid, "methods": dict(methods), "state": "ok", "reason": None,
            "et0_total_mm": None, "etc_total_mm": None, "rain_total_mm": None,
            "rain_minus_etc_mm": None,
            "statement": ("A modelled demand from a 0.5 degree reanalysis cell with the FAO standard "
                          "mid-season Kc over the crop's usual planting window; not a measurement, not "
                          "calibrated for this field, and not an irrigation deficit."),
        }
        if not agg.covered(valid, planting.days):
            entry.update(state="abstained",
                         reason=(f"ET0 on {valid} of {planting.days} window days; below 80 percent, "
                                 f"the demand abstains"))
            abstained[crop_id] = entry["reason"]
            crops[crop_id] = entry
            continue
        entry["et0_total_mm"] = agg.round_half_up(et0_sum, 1)
        entry["etc_total_mm"] = agg.round_half_up(etc_sum, 1)
        rain_values = [_value(series, "PRECTOTCORR", d) for d in agg.window_days(planting)]
        if all(v is not None and v >= 0 for v in rain_values):
            entry["rain_total_mm"] = agg.round_half_up(sum(rain_values), 1)
            if valid == planting.days:
                entry["rain_minus_etc_mm"] = agg.round_half_up(entry["rain_total_mm"] - etc_sum, 1)
            else:
                entry["reason"] = ("the climatic difference needs every window day of rain and ET0, "
                                   "as block 6 R-22")
        else:
            entry["reason"] = "the recorded rain series is incomplete over the planting window"
        crops[crop_id] = entry
    if not crops:
        return {"available": False, "reason": "no crop in the recorded planting window file has both a "
                                             "window and a FAO-56 Kc",
                "limitations": ["no_supported_crop"], "crops": {}, "abstained": abstained, **common}
    return {"available": True, "reason": None, "crops": crops, "abstained": abstained,
            "limitations": ["coarse_cell", "modelled_not_measured", "standard_kc",
                            "moved_window_from_bulletin", "hargreaves_only"],
            "method": {"name": "hargreaves",
                       "reason": ("the recorded climate section carries tmax, tmin and rain only, so "
                                  "FAO-56 eq. 52 is used for every day, not eq. 6")},
            "planting_source": {"state": state, "county": region.get("county"),
                                "retrieved": file.get("retrieved"), "grain": file.get("grain")},
            **common}
