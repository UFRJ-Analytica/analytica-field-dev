"""Daily root-zone soil water balance (a "bucket" model), FAO-56 Chapters 7, 8 and 11. Pure numpy.

Allen et al. (1998), FAO Irrigation and Drainage Paper 56, read from
https://www.fao.org/4/x0490e/x0490e0e.htm (ch. 8), x0490e0c.htm (ch. 7), x0490e0h.htm (ch. 11)
on 2026-11-14. Equation numbers are FAO-56's.

The root zone is one bucket. Each day:

    Dr_i = Dr_{i-1} - P_i + ET_i            (Eq. 85; no irrigation, runoff or capillary rise)
    0 <= Dr_i <= TAW                         (Eq. 86); water above field capacity percolates (Eq. 88)

Cropped day:  ETc = Kc ET0; Ks = 1 while Dr <= RAW = p TAW, else (TAW - Dr) / ((1 - p) TAW)
              (Eqs. 83-84, p adjusted for ETc per the Table 22 note); actual ET = Ks ETc (Eq. 80).
Fallow day:   Kc = Kc ini of the crop just harvested (ch. 11: "K c for bare soil can be calculated as
              K c = K c ini"); bare soil only dries its evaporation layer, so evaporation stops once
              the depletion exceeds TEW = 1000 (theta_FC - 0.5 theta_WP) Ze (Eq. 73).
Rain:         daily rain below 0.2 ET0 is ignored ("normally entirely evaporated", ch. 8).

Simplifications (documented in docs/scoring.md): one bucket for the whole profile, roots at their
maximum depth from sowing, no surface runoff, evaporation cut-off instead of FAO's stage-2 decay.
"""

from __future__ import annotations

from typing import Any

import numpy as np


def layer_integral(profile: list[dict[str, float]], depth_m: float, fn) -> float:
    """Integrate fn(layer) [m3/m3] over 0..depth_m, in mm. Layers: top_cm, bottom_cm, fc, wp."""
    total = 0.0
    for layer in profile:
        top, bottom = layer["top_cm"] / 100, layer["bottom_cm"] / 100
        thickness = max(0.0, min(bottom, depth_m) - top)
        total += 1000 * fn(layer) * thickness
    if depth_m > max(l["bottom_cm"] for l in profile) / 100 + 1e-9:
        raise ValueError(f"profile ends above {depth_m} m")
    return total


def taw_mm(profile: list[dict[str, float]], zr_m: float) -> float:
    """Total available water in the root zone, Eq. 82 integrated over the soil layers."""
    return layer_integral(profile, zr_m, lambda l: l["fc"] - l["wp"])


def tew_mm(profile: list[dict[str, float]], ze_m: float) -> float:
    """Total evaporable water of the surface layer, Eq. 73."""
    return layer_integral(profile, ze_m, lambda l: l["fc"] - 0.5 * l["wp"])


def p_adjusted(p_table: float, etc_mm: float) -> float:
    """Table 22 note 2: p = p_table + 0.04 (5 - ETc), limited to 0.1-0.8."""
    return float(np.clip(p_table + 0.04 * (5.0 - etc_mm), 0.1, 0.8))


def simulate(
    rain: np.ndarray,
    et0: np.ndarray,
    kc: np.ndarray,
    taw: np.ndarray,
    p_table: np.ndarray,
    cropped: np.ndarray,
    tew: float,
    min_rain_fraction: float = 0.2,
) -> dict[str, np.ndarray]:
    """Run the daily balance. All inputs are arrays of the same length (one value per day).

    ``kc``/``taw``/``p_table`` hold the values of the crop in the field that day (for fallow days:
    the fallow Kc and the bucket depth of the last crop). ``cropped`` is True on crop days.
    Starts at field capacity (Dr = 0, FAO-56: "following heavy rain ... Dr ~ 0").
    """
    n = len(rain)
    dr = np.zeros(n)
    etc = np.zeros(n)
    eta = np.zeros(n)
    ks = np.ones(n)
    prev = 0.0
    for i in range(n):
        if np.isnan(rain[i]) or np.isnan(et0[i]):
            raise ValueError(f"missing rain/ET0 on day {i}: the balance cannot skip days")
        p_eff = rain[i] if rain[i] >= min_rain_fraction * et0[i] else 0.0
        demand = kc[i] * et0[i]
        cap = taw[i]
        d = min(prev, cap)  # a shallower bucket cannot be more depleted than it holds
        if cropped[i]:
            p = p_adjusted(p_table[i], demand)
            raw = p * cap
            k = 1.0 if d <= raw else max(0.0, (cap - d) / ((1 - p) * cap))
            actual = k * demand
            ks[i] = k
        else:
            actual = demand if d < tew else 0.0
        d = d - p_eff + actual
        d = min(max(d, 0.0), cap)  # Eqs. 86, 88: excess percolates
        dr[i], etc[i], eta[i] = d, demand, actual
        prev = d
    return {"dr": dr, "etc": etc, "eta": eta, "ks": ks}


def daily_schedule(
    dates_month: np.ndarray,
    dates_day: np.ndarray,
    calendar: dict[int, list[dict[str, Any]]],
    crops: dict[str, dict[str, Any]],
    taw_by_crop: dict[str, float],
) -> dict[str, np.ndarray]:
    """Turn a monthly rotation calendar into daily kc / taw / p / cropped / crop arrays.

    ``calendar``: month -> [{crop, stage}] (scoring.occupancy without shares). In a hand-over month
    the first crop is in the field on days 1-15 and the next one from day 16. Fallow days carry the
    Kc ini and bucket of the last crop harvested.
    """
    from pipeline.scoring import kc_value

    n = len(dates_month)
    kc = np.zeros(n)
    taw = np.zeros(n)
    p = np.zeros(n)
    cropped = np.zeros(n, dtype=bool)
    crop = np.empty(n, dtype=object)

    plan: dict[int, tuple] = {}
    for m in range(1, 13):
        entries = calendar[m]
        if len(entries) == 2:  # hand-over: the crop ending, then the crop starting
            first = next(e for e in entries if e["stage"] == "end")
            second = next(e for e in entries if e["stage"] == "ini")
            plan[m] = ("crop", first, second)
        elif entries:
            plan[m] = ("crop", entries[0], entries[0])
        else:
            plan[m] = ("fallow", _last_crop_before(m, calendar))
    for i in range(n):
        m, day = int(dates_month[i]), int(dates_day[i])
        kind = plan[m]
        if kind[0] == "crop":
            e = kind[1] if day <= 15 else kind[2]
            spec = crops[e["crop"]]
            kc[i] = kc_value(e["stage"], spec["kc"])
            taw[i] = taw_by_crop[e["crop"]]
            p[i] = spec["root"]["p"]
            cropped[i] = True
            crop[i] = e["crop"]
        else:
            prev = kind[1]
            if prev is None:
                raise ValueError("rotation has no crop at all")
            kc[i] = crops[prev]["kc"]["ini"]
            taw[i] = taw_by_crop[prev]
            p[i] = crops[prev]["root"]["p"]
            crop[i] = None
    return {"kc": kc, "taw": taw, "p": p, "cropped": cropped, "crop": crop}


CROP_YEAR_ORDER = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6]


def _last_crop_before(month: int, calendar: dict[int, list[dict[str, Any]]]) -> str | None:
    """The crop most recently harvested before ``month``, searching backwards round the year."""
    idx = CROP_YEAR_ORDER.index(month)
    for k in range(1, 13):
        entries = calendar[CROP_YEAR_ORDER[(idx - k) % 12]]
        if entries:
            ends = [e for e in entries if e["stage"] == "end"]
            return (ends[-1] if ends else entries[-1])["crop"]
    return None


def crop_year_summary(
    years: np.ndarray, months: np.ndarray, sim: dict[str, np.ndarray], cropped: np.ndarray, start_month: int = 7
):
    """Per (crop year, month): transpiration deficit, crop demand and stress days on cropped days.

    Crop year = harvest-year label (Jul-Jun). Returns a pandas DataFrame.
    """
    import pandas as pd

    cy = years + (months >= start_month).astype(int)
    df = pd.DataFrame({
        "crop_year": cy,
        "month": months,
        "cropped": cropped,
        "deficit_mm": np.where(cropped, sim["etc"] - sim["eta"], 0.0),
        "demand_mm": np.where(cropped, sim["etc"], 0.0),
        "stress_day": cropped & (sim["ks"] < 1.0),
        "days": 1,
    })
    return df.groupby(["crop_year", "month"]).agg(
        deficit_mm=("deficit_mm", "sum"), demand_mm=("demand_mm", "sum"),
        stress_days=("stress_day", "sum"), days=("days", "sum"),
    ).reset_index()
