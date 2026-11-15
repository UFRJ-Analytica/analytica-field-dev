"""SoilGrids v2.0 properties query at the centroid (R-31, R-32).

The response declares each property's mapped unit, target unit and d_factor. The conversion follows
those declarations: value = mean / d_factor, and when the target unit is percent the value is
multiplied by ten to reach g/kg (1 percent is 10 g/kg). Clay and sand therefore print 225 g/kg for a
mean of 225 with d_factor 10, not 22.5 as the literal text of R-31 would give.
"""

from __future__ import annotations

from typing import Any

URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
PROPERTIES = ("clay", "sand", "phh2o", "soc")
DEPTHS = ("0-5cm", "5-15cm", "15-30cm")
PERCENT_TARGET = "%"
GRAMS_PER_KILOGRAM_PER_PERCENT = 10.0


def url(lon: float, lat: float) -> str:
    properties = "&".join(f"property={name}" for name in PROPERTIES)
    depths = "&".join(f"depth={depth}" for depth in DEPTHS)
    return f"{URL}?lon={lon}&lat={lat}&{properties}&{depths}&value=mean"


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _abstain(reason: str) -> dict:
    return {"value": None, "reason": reason, "d_factor": None}


def parse(payload: dict) -> dict[tuple[str, str], dict]:
    layers = {layer.get("name"): layer for layer in payload["properties"]["layers"]}
    values: dict[tuple[str, str], dict] = {}
    for name in PROPERTIES:
        layer = layers.get(name)
        unit = (layer or {}).get("unit_measure") or {}
        depth_rows = {row.get("label"): row for row in (layer or {}).get("depths", [])}
        for depth in DEPTHS:
            values[(name, depth)] = _one(name, depth, layer, unit, depth_rows)
    return values


def _one(name: str, depth: str, layer: dict | None, unit: dict, depth_rows: dict) -> dict:
    if layer is None:
        return _abstain(f"{name} is absent from the SoilGrids response")
    row = depth_rows.get(depth)
    if row is None:
        return _abstain(f"{depth} is absent for {name} in the SoilGrids response")
    d_factor = unit.get("d_factor")
    if not _is_number(d_factor) or d_factor == 0:
        return _abstain(f"d_factor is absent for {name} in the SoilGrids response")
    mean = (row.get("values") or {}).get("mean")
    if not _is_number(mean):
        return _abstain(f"mean is absent for {name} at {depth} in the SoilGrids response")
    value = mean / d_factor
    if unit.get("target_units") == PERCENT_TARGET:
        value = value * GRAMS_PER_KILOGRAM_PER_PERCENT
    return {"value": float(value), "reason": None, "d_factor": d_factor}


def d_factors(values: dict[tuple[str, str], dict]) -> dict[str, float | None]:
    """The `d_factor` each property declared, so the section shows what was applied (Table E, R-31).

    The factor sits on the layer, so the three depths of a property carry the same one. A property
    whose depths disagree, or whose factor is missing at any depth, reports `None` instead of picking
    one of them: the section never prints a factor that was not the one used for every value.
    """
    factors: dict[str, float | None] = {}
    for name in PROPERTIES:
        declared = {values[(name, depth)]["d_factor"] for depth in DEPTHS}
        factors[name] = declared.pop() if len(declared) == 1 else None
    return factors
