"""Experiment: the NASA POWER daily point inputs of FAO-56 reference evapotranspiration.

Community AG, so ALLSKY_SFC_SW_DWN arrives in MJ/m^2/day, the unit FAO-56 uses. The parse step reuses
block 6's reader (sources.power.parse), which drops the -999 fill value before any arithmetic.
"""

from __future__ import annotations

import math
from datetime import date

from sources import power

PARAMETERS = ("T2M_MAX", "T2M_MIN", "RH2M", "T2MDEW", "WS2M", "ALLSKY_SFC_SW_DWN", "PS", "PRECTOTCORR",
              "EVPTRNS")
UNITS = {"T2M_MAX": "C", "T2M_MIN": "C", "RH2M": "%", "T2MDEW": "C", "WS2M": "m/s",
         "ALLSKY_SFC_SW_DWN": "MJ/m^2/day", "PS": "kPa", "PRECTOTCORR": "mm/day", "EVPTRNS": "MJ/m^2/day"}


def url(lon: float, lat: float, start: date, end: date) -> str:
    # POWER defaults to LST today, but the convention is explicit so a service default cannot silently
    # move a daily boundary in a reproducibility experiment.
    return power.url(lon, lat, start, end, PARAMETERS) + "&time-standard=LST"


def parse(payload: dict) -> dict[str, dict[date, float]]:
    return power.parse(payload)


def point(payload: dict) -> tuple[float, float, float]:
    """(longitude, latitude, elevation in m) as POWER reports the cell it answered for."""
    coordinates = payload.get("geometry", {}).get("coordinates", [])
    if len(coordinates) < 3:
        raise ValueError("POWER payload has no longitude, latitude and elevation")
    lon, lat, elevation = map(float, coordinates[:3])
    if not all(math.isfinite(value) for value in (lon, lat, elevation)):
        raise ValueError("POWER point coordinates and elevation must be finite")
    if not -180.0 <= lon <= 180.0 or not -90.0 <= lat <= 90.0:
        raise ValueError("POWER point coordinates are outside longitude/latitude bounds")
    return lon, lat, elevation


def check_units(payload: dict) -> list[str]:
    """The parameters whose unit in the payload differs from the unit the equations assume."""
    declared = payload.get("parameters", {})
    return [name for name, unit in UNITS.items() if name in declared and declared[name].get("units") != unit]


def validate_payload(payload: dict) -> list[str]:
    """Return reproducibility issues without guessing units or filling absent metadata."""
    issues: list[str] = []
    declared = payload.get("parameters", {})
    data = payload.get("properties", {}).get("parameter", {})
    for name, expected_unit in UNITS.items():
        if name not in data:
            issues.append(f"missing data parameter {name}")
        if name not in declared:
            issues.append(f"missing unit metadata for {name}")
        elif declared[name].get("units") != expected_unit:
            issues.append(f"unit mismatch for {name}: expected {expected_unit}, got {declared[name].get('units')}")
    time_standard = payload.get("header", {}).get("time_standard")
    if time_standard != "LST":
        issues.append(f"time standard is {time_standard!r}, expected 'LST'")
    fill_value = payload.get("header", {}).get("fill_value")
    if fill_value != power.FILL:
        issues.append(f"fill value is {fill_value!r}, expected {power.FILL}")
    try:
        point(payload)
    except (KeyError, TypeError, ValueError) as error:
        issues.append(f"invalid point metadata: {error}")
    return issues
