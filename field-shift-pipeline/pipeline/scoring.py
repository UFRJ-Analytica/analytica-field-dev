"""Rotation scoring. Pure: no I/O, no pandas required -- dicts and lists in, dicts out.

Three components, each a physical quantity first and a 0-100 score second:

soil    Heavy-rain days (>= 20 mm, ETCCDI R20mm) that fall in months when the rotation leaves the
        field bare, in years of the chosen ENSO class. Fewer is better.
water   Water stress: the transpiration the crops wanted but could not get, mm/yr -- sum over cropped
        days of (Kc ET0 - Ks Kc ET0) from a daily FAO-56 soil water balance (pipeline/soilwater.py)
        that stores rain in the root zone between days, averaged over years of the ENSO class.
        Smaller is better.
income  Change in the rotation's gross revenue in years of the chosen ENSO class, from each cash
        crop's recent revenue per hectare (IBGE PAM) and its yield anomaly in that class. Higher
        (less negative) is better: this is income *stability*, not income level.

Scores are min-max normalised across the candidates of one municipality and ENSO class (100 =
best candidate, 0 = worst), then combined: total = sum(w_i x score_i) / sum(w_i). Every
intermediate number is returned so the UI can open the arithmetic.

A component that cannot be computed (a cash crop with no yield history for that class) is None,
never a guess. A rotation whose weighted components are not all available gets no total.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

COMPONENTS = ("soil", "water", "income")
MONTHS = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6]  # crop year, Jul-Jun


class RotationError(ValueError):
    """A rotation's calendar is impossible (two crops in the field at once)."""


def crop_months(sow: int, harvest: int) -> list[int]:
    """Calendar months from sowing to harvest inclusive, wrapping over the new year."""
    if not (1 <= sow <= 12 and 1 <= harvest <= 12):
        raise RotationError(f"months must be 1-12, got sow={sow} harvest={harvest}")
    out, m = [sow], sow
    while m != harvest:
        m = m % 12 + 1
        out.append(m)
    return out


def stages(n_months: int) -> list[str]:
    """FAO-56 stage per month of a crop's cycle: ini, dev, mid..., end."""
    if n_months == 1:
        return ["mid"]
    if n_months == 2:
        return ["ini", "end"]
    return ["ini", "dev"] + ["mid"] * (n_months - 3) + ["end"]


def kc_value(stage: str, kc: dict[str, float]) -> float:
    """Monthly Kc: development is the midpoint of the FAO-56 linear rise from ini to mid."""
    if stage == "dev":
        return (kc["ini"] + kc["mid"]) / 2
    return kc[stage]


def occupancy(crop_ids: list[str], windows: dict[str, dict[str, int]]) -> dict[int, list[dict[str, Any]]]:
    """Month -> list of {crop, stage, share} in the field that month.

    Two crops may share a month only at the hand-over (harvest of one, sowing of the next); each
    then gets share 0.5. Anything else is an impossible calendar and raises RotationError.
    """
    occ: dict[int, list[dict[str, Any]]] = {m: [] for m in range(1, 13)}
    for crop in crop_ids:
        w = windows[crop]
        months = crop_months(w["sow"], w["harvest"])
        for m, st in zip(months, stages(len(months))):
            occ[m].append({"crop": crop, "stage": st})
    for m, entries in occ.items():
        if len(entries) > 2 or (len(entries) == 2 and {e["stage"] for e in entries} != {"end", "ini"}):
            names = ", ".join(f"{e['crop']} ({e['stage']})" for e in entries)
            raise RotationError(f"month {m} holds incompatible crops: {names}")
        for e in entries:
            e["share"] = 1.0 / len(entries)
    return occ


def soil_component(occ: dict[int, list], heavy_days: dict[int, float]) -> dict[str, Any]:
    """Heavy-rain days landing on bare soil (lower is better)."""
    bare = [m for m in MONTHS if not occ[m]]
    missing = [m for m in bare if heavy_days.get(m) is None or _nan(heavy_days[m])]
    if missing:
        return {"value": None, "bare_months": bare, "reason": f"no heavy-rain climatology for months {missing}"}
    by_month = {m: heavy_days[m] for m in bare}
    return {"value": sum(by_month.values()), "bare_months": bare, "heavy_days_by_bare_month": by_month,
            "unit": "days/yr", "better": "lower"}


def water_component(stats: dict[str, Any] | None) -> dict[str, Any]:
    """Water stress from the daily soil water balance (lower is better).

    ``stats``: mean over the ENSO class's years of the transpiration deficit (mm), stress days and
    crop demand, with the month-by-month deficit and the number of years. None -> no value.
    """
    if not stats or stats.get("deficit_mm") is None or _nan(stats.get("deficit_mm")):
        return {"value": None, "reason": (stats or {}).get("reason", "no soil water simulation for this class")}
    return {
        "value": stats["deficit_mm"],
        "demand_mm": stats["demand_mm"],
        "stress_days": stats["stress_days"],
        "n_years": stats["n_years"],
        "taw_mm": stats.get("taw_mm"),
        "by_month": stats.get("by_month", []),
        "unit": "mm/yr",
        "better": "lower",
        "model": "FAO-56 daily soil water balance",
    }


def income_component(
    crop_ids: list[str],
    crops: dict[str, dict[str, Any]],
    revenue_per_ha: dict[int, float],
    anomaly: dict[int, tuple[float | None, int]],
) -> dict[str, Any]:
    """Gross-revenue change (%) in years of the ENSO class (higher is better).

    ``revenue_per_ha``: recent R$/ha by PAM code. ``anomaly``: (mean yield anomaly %, n years) by
    PAM code for the ENSO class. Cover crops contribute no revenue.
    """
    items, normal, in_class, min_n = [], 0.0, 0.0, None
    for cid in crop_ids:
        spec = crops[cid]
        if spec.get("cover_crop"):
            items.append({"crop": cid, "cover_crop": True})
            continue
        rev = revenue_per_ha.get(spec["revenue_pam_code"])
        mean, n = anomaly.get(spec["anomaly_pam_code"], (None, 0))
        item = {"crop": cid, "revenue_per_ha": rev, "yield_anomaly_pct": mean, "n_years": n}
        items.append(item)
        if rev is None or _nan(rev):
            return {"value": None, "items": items, "reason": f"no PAM revenue for {cid} in this municipality"}
        if mean is None or _nan(mean) or n == 0:
            return {"value": None, "items": items, "reason": f"no {cid} yield history for this ENSO class"}
        normal += rev
        in_class += rev * (1 + mean / 100)
        min_n = n if min_n is None else min(min_n, n)
    if normal <= 0:
        return {"value": None, "items": items, "reason": "rotation has no cash crop"}
    return {"value": 100 * (in_class / normal - 1), "revenue_normal": normal, "revenue_in_class": in_class,
            "min_n_years": min_n, "items": items, "unit": "%", "better": "higher"}


def normalise(values: Iterable[float | None], higher_is_better: bool) -> list[float | None]:
    """Min-max to 0-100 (100 = best). None stays None; all-equal values all score 100."""
    vals = list(values)
    ok = [v for v in vals if v is not None and not _nan(v)]
    if not ok:
        return [None] * len(vals)
    lo, hi = min(ok), max(ok)
    out = []
    for v in vals:
        if v is None or _nan(v):
            out.append(None)
        elif hi == lo:
            out.append(100.0)
        else:
            s = (v - lo) / (hi - lo)
            out.append(100.0 * (s if higher_is_better else 1 - s))
    return out


def weighted_total(scores: dict[str, float | None], weights: dict[str, float]) -> float | None:
    """sum(w x score) / sum(w) over components with weight > 0; None if any of those is missing."""
    used = {c: w for c, w in weights.items() if w and w > 0}
    if not used:
        return None
    if any(scores.get(c) is None for c in used):
        return None
    return sum(w * scores[c] for c, w in used.items()) / sum(used.values())


def rotation_windows(rot: dict[str, Any], calendar: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    """Sow/harvest window of each crop in a rotation, applying the rotation's overrides."""
    return {c: {**calendar[c], **rot.get("override", {}).get(c, {})} for c in rot["crops"]}


def score_rotations(
    rotations: list[dict[str, Any]],
    crops: dict[str, dict[str, Any]],
    calendar: dict[str, dict[str, int]],
    climate: dict[str, dict[int, float]],
    revenue_per_ha: dict[int, float],
    anomaly: dict[int, tuple[float | None, int]],
    water_stats: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Score every candidate of one municipality for one ENSO class.

    ``climate`` holds monthly heavy-rain-day means for that class: {"heavy_days": {m: ..}}.
    ``water_stats`` maps rotation id -> soil water balance summary for that class.
    Returns one dict per rotation with raw components and 0-100 scores.
    """
    water_stats = water_stats or {}
    results = []
    for rot in rotations:
        windows = rotation_windows(rot, calendar)
        occ = occupancy(rot["crops"], windows)
        results.append({
            "id": rot["id"],
            "crops": rot["crops"],
            "windows": windows,
            "calendar": {m: [{"crop": e["crop"], "stage": e["stage"]} for e in occ[m]] for m in MONTHS},
            "soil": soil_component(occ, climate["heavy_days"]),
            "water": water_component(water_stats.get(rot["id"])),
            "income": income_component(rot["crops"], crops, revenue_per_ha, anomaly),
        })
    for comp in COMPONENTS:
        higher = comp == "income"
        scores = normalise([r[comp]["value"] for r in results], higher_is_better=higher)
        for r, s in zip(results, scores):
            r[comp]["score"] = s
    return results


def rank(results: list[dict[str, Any]], weights: dict[str, float]) -> list[dict[str, Any]]:
    """Attach totals and ranks. Rotations without a total come last, unranked."""
    out = []
    for r in results:
        total = weighted_total({c: r[c]["score"] for c in COMPONENTS}, weights)
        out.append({**r, "total": total})
    scored = sorted((r for r in out if r["total"] is not None), key=lambda r: -r["total"])
    for i, r in enumerate(scored, start=1):
        r["rank"] = i
    unscored = [{**r, "rank": None} for r in out if r["total"] is None]
    return scored + unscored


def _nan(x: Any) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))
