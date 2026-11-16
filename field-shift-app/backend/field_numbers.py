"""Block 6 wave 1: the numbers route's logic (R-45 to R-51, Tables A, B, B2, E).

main.py owns the one route (`POST /fields/{field_id}/numbers`) and calls build_numbers(). This module
holds the request checks, the per source cache, the seven sections, one provenance row per printed
metric and one gap per missing input. The transport and the clock are module attributes so the
recorded-transport tests can replace them.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
from pydantic import BaseModel, Field

import aggregates as agg
import water_balance as wb
from sources import mapbiomas, power, sentinel2, sidra, soilgrids

AXIS_START = date(2015, 4, 1)
BACKEND_DIR = Path(__file__).resolve().parent
CACHE_DIR = Path(os.getenv("NUMBERS_CACHE_DIR", str(BACKEND_DIR / ".tile-cache" / "numbers")))  # git-ignored
MAPBIOMAS_DB = Path(os.getenv("POLYGON_MAPBIOMAS_DB", str(BACKEND_DIR.parent / "data" / "polygons" / "polygon-mapbiomas.sqlite")))
SCHEMA_VERSION = "1"
ACRES_PER_HECTARE = 2.4710538
EARTH_RADIUS_M = 6378137.0
FRAGMENT_TOLERANCE_PERCENT = 5.0
NORMAL_YEARS = range(1991, 2026)
NETWORK_CAUSE = "network unavailable (offline state)"
LIFETIME = {
    "power_daily_point": timedelta(hours=6),
    "power_normals": timedelta(days=30),
    "stac_search": timedelta(hours=12),
    "soilgrids": timedelta(days=30),
    "sidra": timedelta(hours=24),
}
POWER_URL_NAME = "https://power.larc.nasa.gov/api/temporal/daily/point"


class NumbersError(Exception):
    """A refusal with its HTTP status. The only non 200 answers of the route (R-46)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class NumbersRequest(BaseModel):
    """Table B body. Ring and centroid are checked by hand so their refusals are 400, not 422."""

    ring: list[list[float]]
    centroid: list[float] = Field(min_length=2, max_length=2)
    area_ha: float | None = None
    date: date


class SourceFailure(Exception):
    """A source that did not answer with a usable payload. Carries the section error and the gap cause."""

    def __init__(self, error: str, cause: str, status: str) -> None:
        super().__init__(error)
        self.error = error
        self.cause = cause
        self.status = status


def outbound_timeout_seconds() -> float:
    """How long an outbound source call may take before it is abandoned.

    Twenty seconds is the value this path has always used; `OUTBOUND_TIMEOUT_SECONDS` makes it a
    deployment knob, because the call is synchronous and a slow source holds the worker for the
    whole of it.
    """
    return float(os.environ.get("OUTBOUND_TIMEOUT_SECONDS", "20"))


def _default_transport(method: str, url: str, json_body: Any = None) -> httpx.Response:
    with httpx.Client(timeout=outbound_timeout_seconds(), follow_redirects=True) as client:
        if method == "POST":
            return client.post(url, json=json_body)
        return client.get(url)


transport: Callable[..., httpx.Response] = _default_transport


def clock() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- metrics: the mirror of Table A ----------------------------------------------------------

def _metric(label: str, unit: str, decimals: int | None, basis: str, resolution: str, route: str) -> dict[str, Any]:
    return {"label": f"numbers.{label}", "unit": unit, "decimals": decimals, "basis": basis,
            "resolution": resolution, "route": route}


METRICS: dict[str, dict[str, Any]] = {
    "rain_total": _metric("rain_total", "mm", 1, "modelled", "0.5 degree cell", "api"),
    "dry_spell_days": _metric("dry_spell_days", "days", 0, "modelled", "0.5 degree cell", "api"),
    "gdd10": _metric("gdd10", "C day", 0, "modelled", "0.5 degree cell", "api"),
    "frost_days": _metric("frost_days", "days", 0, "modelled", "0.5 degree cell", "api"),
    "tmin_min": _metric("tmin_min", "C", 1, "modelled", "0.5 degree cell", "api"),
    "gwetroot_mean": _metric("gwetroot_mean", "unit 1", 2, "modelled", "0.5 degree cell", "api"),
    "rain_day": _metric("rain_day", "mm", 1, "modelled", "0.5 degree cell", "api"),
    "tmax_day": _metric("tmax_day", "C", 1, "modelled", "0.5 degree cell", "api"),
    "tmin_day": _metric("tmin_day", "C", 1, "modelled", "0.5 degree cell", "api"),
    "rain_median": _metric("rain_median", "mm", 1, "modelled", "0.5 degree cell", "api"),
    "rain_min": _metric("rain_min", "mm", 1, "modelled", "0.5 degree cell", "api"),
    "rain_max": _metric("rain_max", "mm", 1, "modelled", "0.5 degree cell", "api"),
    "rain_rank": _metric("rain_rank", "years", 0, "modelled", "0.5 degree cell", "derived"),
    "rain_percentile": _metric("rain_percentile", "percent", 0, "modelled", "0.5 degree cell", "derived"),
    "hot_days": _metric("hot_days", "days", 0, "modelled", "0.5 degree cell", "api"),
    "hot_days_median": _metric("hot_days_median", "days", 0, "modelled", "0.5 degree cell", "api"),
    "wb_in": _metric("wb_in", "mm", 1, "modelled", "0.5 degree cell", "derived"),
    "wb_out": _metric("wb_out", "mm", 1, "modelled", "0.5 degree cell", "derived"),
    "wb_remaining": _metric("wb_remaining", "mm", 1, "modelled", "0.5 degree cell", "derived"),
    "smap_surface": _metric("smap_surface", "percent of the served palette", 0, "retrieved",
                            "9 km posting, 36 km radiometer footprint", "canvas"),
    "smap_rootzone": _metric("smap_rootzone", "percent of the served palette", 0, "retrieved", "9 km", "canvas"),
    "ndvi_mean": _metric("ndvi_mean", "unitless", 3, "retrieved", "10 m", "cogs"),
    "ndvi_valid_fraction": _metric("ndvi_valid_fraction", "fraction", 2, "retrieved", "10 m", "cogs"),
    "ndvi_scene_count": _metric("ndvi_scene_count", "scenes", 0, "retrieved", "not applicable", "api"),
    "ndvi_clear_count": _metric("ndvi_clear_count", "scenes", 0, "retrieved", "not applicable", "api"),
    "municipality_soy_ha": _metric("municipality_soy_ha", "ha", 0, "retrieved", "the municipality", "api"),
    "state_soy_ha": _metric("state_soy_ha", "ha", 0, "retrieved", "the state", "api"),
    "polygon_share": _metric("polygon_share", "percent", 4, "modelled", "not applicable", "derived"),
    "ring_area": _metric("ring_area", "ha", 2, "retrieved", "the polygon", "request"),
}
SOIL_RESOLUTION = "250 m static model"
SOIL_DEPTHS = (("0-5cm", "0_5"), ("5-15cm", "5_15"), ("15-30cm", "15_30"))
SOIL_PROPERTIES = (("clay", "soil.clay", 0, "g/kg"), ("sand", "soil.sand", 0, "g/kg"),
                   ("phh2o", "soil.ph", 1, "pH"), ("soc", "soil.soc", 1, "g/kg"))
# Table E, soil row: the keys a depth entry carries. Table A addresses the same depth by its token
# (`soil.clay.0_5`, `soil.clay.5_15`, `soil.clay.15_30`), so the entry carries that token as `depth`
# beside the SoilGrids `label`. Both are read from Table A and Table E, never invented here.
SOIL_DEPTH_KEYS = {"clay": "clay_g_kg", "sand": "sand_g_kg", "phh2o": "ph", "soc": "soc_g_kg"}
for _, _family, _decimals, _unit in SOIL_PROPERTIES:
    for _, _depth_key in SOIL_DEPTHS:
        METRICS[f"{_family}.{_depth_key}"] = _metric(_family.split(".")[1], _unit, _decimals,
                                                     "modelled", SOIL_RESOLUTION, "api")
for _year in mapbiomas.FIRST_YEARS:
    METRICS[f"mb_first_crop.{_year}"] = _metric("mb_first_crop", "class name", None, "modelled",
                                                "30 m, Collection 11", "sidecar")
for _year in mapbiomas.SECOND_YEARS:
    METRICS[f"mb_second_crop.{_year}"] = _metric("mb_second_crop", "class name", None, "modelled",
                                                 "30 m, Collection 11", "sidecar")


def _fmt(metric: str, value: Any) -> Any:
    """The printed value of a metric: rounded half up at its Table A decimals, or null."""
    if value is None:
        return None
    decimals = METRICS[metric]["decimals"]
    if decimals is None or isinstance(value, (str, list, dict)):
        return value
    return agg.round_half_up(value, decimals)


def _row(metric: str, value: Any, *, as_of: str | None, source: str, fetched_at: str | None,
         basis: str | None = None, resolution: str | None = None, route: str | None = None) -> dict[str, Any]:
    meta = METRICS[metric]
    return {
        "metric": metric,
        "label": meta["label"],
        "value": _fmt(metric, value),
        "unit": meta["unit"],
        "basis": basis or meta["basis"],
        "as_of": as_of,
        "source": source,
        "resolution": resolution or meta["resolution"],
        "route": route or meta["route"],
        "fetched_at": fetched_at,
    }


def _gap(section: str, cause: str, source: str, status: str, when: str | None, remediation: str = "") -> dict[str, Any]:
    return {"section": section, "cause": cause, "source": source, "status": status,
            "date": when, "remediation": remediation}


# --- field resolution (R-51) -------------------------------------------------------------

@dataclass(frozen=True)
class FieldRef:
    field_id: str
    region: str | None
    kind: str  # "fixture" or "polygon"
    # The fixture entry's own `location` text (block 4 R-31). A polygon id carries no location in
    # this route's request, so it is None and no state is read from it.
    location: str | None = None


def resolve_field(field_id: str, fixture_fields: list[dict[str, Any]]) -> FieldRef:
    """`csb:` is United States, `trazo:` is Brazil, a fixture id takes its entry's region, and an id that
    matches neither is a 404: no United States polygon table is readable here (CO-B6-05)."""
    for prefix, region in (("csb:", "us"), ("trazo:", "br")):
        if field_id.startswith(prefix):
            if not field_id[len(prefix):].isdigit():
                raise NumbersError(404, "Field not found")
            return FieldRef(field_id, region, "polygon")
    entry = next((item for item in fixture_fields if item.get("id") == field_id), None)
    if entry is None:
        raise NumbersError(404, "Field not found")
    return FieldRef(field_id, entry.get("region"), "fixture", entry.get("location"))


# --- geometry (R-50, the request checks of R-46) --------------------------------------

def _planar_signed_area(ring: list[tuple[float, float]]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        total += x1 * y2 - x2 * y1
    return total / 2.0


def area_of_ring_m2(ring: list[list[float]]) -> float:
    """Spherical area of a ring in square metres (Chamberlain and Duquette), orientation free."""
    points = [tuple(p) for p in ring]
    if points[0] != points[-1]:
        points.append(points[0])
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(points, points[1:]):
        total += math.radians(lon2 - lon1) * (2.0 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2)))
    return abs(total) * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0


def ring_fragment_check(ring: list[list[float]], area_ha: float | None) -> dict[str, Any]:
    """R-50: the ring area against the polygon's own area, marked a fragment beyond 5 percent."""
    ring_ha = area_of_ring_m2(ring) / 10000.0
    if area_ha is None or area_ha <= 0:
        return {"ring_area_ha": ring_ha, "area_ha": area_ha, "difference_percent": None, "is_fragment": None}
    difference = abs(ring_ha - area_ha) / area_ha * 100.0
    return {"ring_area_ha": ring_ha, "area_ha": area_ha,
            "difference_percent": difference, "is_fragment": difference > FRAGMENT_TOLERANCE_PERCENT}


def _point_in_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y):
            crossing = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < crossing:
                inside = not inside
    return inside


def _clean_ring(ring: list[list[float]]) -> list[tuple[float, float]]:
    points = [(float(p[0]), float(p[1])) for p in ring]
    if len(points) > 1 and points[0] == points[-1]:
        points = points[:-1]
    if len(points) < 3:
        raise NumbersError(400, "a ring needs at least three points")
    if _planar_signed_area(points) == 0:
        raise NumbersError(400, "a ring with zero signed area is refused")
    return points


# --- the per source cache (R-47, Table B2) ---------------------------------------------

@dataclass
class Sourced:
    payload: Any
    fetched_at: str
    cached: bool


def _cache_path(source: str, key: str) -> Path:
    return CACHE_DIR / source / f"{hashlib.sha256(key.encode('utf-8')).hexdigest()[:40]}.json"


def _cache_read(source: str, key: str, now: datetime) -> dict[str, Any] | None:
    path = _cache_path(source, key)
    if not path.is_file():
        return None
    entry = json.loads(path.read_text(encoding="utf-8"))
    fetched = datetime.strptime(entry["fetched_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    if now - fetched < LIFETIME[source]:
        return entry
    return None


def _cache_write(source: str, key: str, payload: Any, fetched_at: str) -> None:
    path = _cache_path(source, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"fetched_at": fetched_at, "payload": payload}), encoding="utf-8")
    temporary.replace(path)


def _http_json(method: str, url: str, body: Any = None) -> Any:
    try:
        response = transport(method, url, body)
    except httpx.TransportError as error:
        raise SourceFailure(type(error).__name__, NETWORK_CAUSE, "offline") from error
    if response.status_code != 200:
        raise SourceFailure(f"HTTP {response.status_code}", f"upstream answered HTTP {response.status_code}",
                            str(response.status_code))
    try:
        return response.json()
    except ValueError as error:
        raise SourceFailure("invalid JSON", "upstream answered without JSON", "200") from error


def _sourced(source: str, key: str, now: datetime, fetch: Callable[[], Any]) -> Sourced:
    entry = _cache_read(source, key, now)
    if entry is not None:
        return Sourced(entry["payload"], entry["fetched_at"], True)
    payload = fetch()  # a SourceFailure propagates; an unavailable source writes no cache entry
    fetched_at = _iso(clock())
    _cache_write(source, key, payload, fetched_at)
    return Sourced(payload, fetched_at, False)


# --- the request context ----------------------------------------------------------------

@dataclass
class Context:
    field: FieldRef
    chosen: date
    now: datetime
    ring_request: list[list[float]]
    ring: list[tuple[float, float]]
    centroid: tuple[float, float]
    area_ha: float | None

    @property
    def lon(self) -> float:
        return self.centroid[0]

    @property
    def lat(self) -> float:
        return self.centroid[1]


def _section_base(source: str, as_of: str | None, fetched: Sourced | None, basis: str = "modelled",
                  resolution: str | None = None) -> dict[str, Any]:
    return {"source": source, "as_of": as_of, "basis": basis, "resolution": resolution,
            "fetched_at": fetched.fetched_at if fetched else None,
            "cached": fetched.cached if fetched else False}


def _unavailable(section: dict[str, Any], failure: SourceFailure, name: str, source: str, when: str | None,
                 gaps: list, remediation: str = "") -> None:
    section.update(state="unavailable", error=failure.error)
    gaps.append(_gap(name, failure.cause, source, failure.status, when, remediation))


# --- climate (R-16 to R-21) ---------------------------------------------------------------

CLIMATE_SOURCE = POWER_URL_NAME
NORMALS_SOURCE = POWER_URL_NAME
# Table A prints this resolution on every POWER row; Table E requires it on the section too, and R-10
# wants it printed in the card header. It is passed to `_section_base` on every path, because that
# helper's default `None` is the value that used to overwrite it.
CLIMATE_RESOLUTION = "0.5 degree cell"
ALL_CLIMATE_METRICS = ["rain_total", "dry_spell_days", "gdd10", "frost_days", "tmin_min", "gwetroot_mean",
                       "rain_day", "tmax_day", "tmin_day", "rain_median", "rain_min", "rain_max", "rain_rank",
                       "rain_percentile", "hot_days", "hot_days_median"]


def _climate_source_url(ctx: Context) -> str:
    start = ctx.chosen - timedelta(days=agg.LOOKBACK_DAYS)
    return power.url(ctx.lon, ctx.lat, start, ctx.chosen, power.CLIMATE_PARAMETERS)


def _series_rows(metric: str, series: dict[date, float], window: agg.Window) -> list[dict[str, Any]]:
    return [{"date": d.isoformat(), "value": series[d]} for d in agg.window_days(window) if agg.is_valid(series.get(d))]


def _normals_unavailable(reason: str) -> dict[str, Any]:
    """Table E requires `normals` in every climate state. A section that never reached the normals keeps
    the family's facts and the reason R-12 prints, in the shape the normals failure branch already uses."""
    return {"of_years": 0, "excluded_years": [], "error": reason}


def _climate(ctx: Context, gaps: list) -> tuple[dict, list, dict | None, agg.Window | None]:
    """Returns the section, its provenance rows, the parsed series and the window (for water and NDVI)."""
    url = _climate_source_url(ctx)
    start = ctx.chosen - timedelta(days=agg.LOOKBACK_DAYS)
    key = f"{ctx.lon},{ctx.lat},{start.isoformat()},{ctx.chosen.isoformat()}"
    section: dict[str, Any] = {"state": "abstained",
                               **_section_base(CLIMATE_SOURCE, None, None, resolution=CLIMATE_RESOLUTION)}
    section.update(window=None, aggregates={}, series={})
    rows: list[dict[str, Any]] = []
    metric_names = ALL_CLIMATE_METRICS
    try:
        sourced = _sourced("power_daily_point", key, ctx.now, lambda: _http_json("GET", url))
        series = power.parse(sourced.payload)
    except SourceFailure as failure:
        _unavailable(section, failure, "climate", CLIMATE_SOURCE, ctx.chosen.isoformat(), gaps)
        section["normals"] = _normals_unavailable(failure.error)
        rows = [_row(m, None, as_of=None, source=CLIMATE_SOURCE, fetched_at=None) for m in metric_names]
        return section, rows, None, None
    except (KeyError, ValueError, TypeError, AttributeError):
        section.update(state="unavailable", error="malformed POWER response")
        section["normals"] = _normals_unavailable("malformed POWER response")
        gaps.append(_gap("climate", "malformed POWER response", CLIMATE_SOURCE, "malformed", ctx.chosen.isoformat()))
        rows = [_row(m, None, as_of=None, source=CLIMATE_SOURCE, fetched_at=None) for m in metric_names]
        return section, rows, None, None

    section.update(_section_base(CLIMATE_SOURCE, None, sourced, resolution=CLIMATE_RESOLUTION))
    rain = series.get("PRECTOTCORR", {})
    window = agg.resolve_window(rain, ctx.chosen)
    if window is None:
        reason = "no consolidated PRECTOTCORR day in the 120 days before the chosen date"
        section["normals"] = _normals_unavailable(reason)
        gaps.append(_gap("climate", reason,
                         CLIMATE_SOURCE, "no valid rain day", ctx.chosen.isoformat()))
        rows = [_row(m, None, as_of=None, source=CLIMATE_SOURCE, fetched_at=sourced.fetched_at) for m in metric_names]
        return section, rows, series, None

    as_of = window.end.isoformat()
    section["as_of"] = as_of
    section["window"] = {"start": window.start.isoformat(), "end": as_of, "days": window.days,
                         "valid_days": window.valid_days, "dropped_days": window.dropped_days}
    tmax = series.get("T2M_MAX", {})
    tmin = series.get("T2M_MIN", {})
    computed = {
        "rain_total": agg.rain_total(rain, window),
        "dry_spell_days": agg.dry_spell_days(rain, window),
        "gdd10": agg.gdd10(tmax, tmin, window),
        "frost_days": agg.frost_days(series.get("FROST_DAYS", {}), window),
        "tmin_min": agg.tmin_min(tmin, window),
        "gwetroot_mean": agg.gwetroot_mean(series.get("GWETROOT", {}), window),
    }
    inputs = {"rain_total": "PRECTOTCORR", "dry_spell_days": "PRECTOTCORR", "gdd10": "T2M_MAX and T2M_MIN",
              "frost_days": "FROST_DAYS", "tmin_min": "T2M_MIN", "gwetroot_mean": "GWETROOT"}
    for name, (value, valid) in computed.items():
        section["aggregates"][name] = {"value": value, "valid_days": valid, "of_days": window.days}
        if value is None:
            gaps.append(_gap("climate",
                             f"{inputs[name]}: {valid} valid of {window.days} window days "
                             f"({window.days - valid} missing); below 80 percent, {name} abstains",
                             CLIMATE_SOURCE, "coverage below 80 percent", as_of))
        rows.append(_row(name, value, as_of=as_of, source=CLIMATE_SOURCE, fetched_at=sourced.fetched_at))
    for name, param in (("rain_day", rain), ("tmax_day", tmax), ("tmin_day", tmin)):
        points = _series_rows(name, param, window)
        section["series"][name] = points
        rows.append(_row(name, points, as_of=as_of, source=CLIMATE_SOURCE, fetched_at=sourced.fetched_at))

    normals_rows, normals = _normals(ctx, window, tmax, rain, gaps)
    section["normals"] = normals
    rows.extend(normals_rows)
    section["state"] = "ok" if any(item["value"] is not None for item in section["aggregates"].values()) \
        or (normals.get("rain_median") or {}).get("value") is not None else "abstained"
    return section, rows, series, window


def _normals(ctx: Context, window: agg.Window, tmax: dict[date, float], current_rain: dict[date, float],
             gaps: list) -> tuple[list, dict]:
    url = power.url(ctx.lon, ctx.lat, date(NORMAL_YEARS.start, 1, 1), date(NORMAL_YEARS.stop - 1, 12, 31),
                    power.NORMAL_PARAMETERS)
    names = ["rain_median", "rain_min", "rain_max", "rain_rank", "rain_percentile", "hot_days", "hot_days_median"]
    try:
        sourced = _sourced("power_normals", f"{ctx.lon},{ctx.lat}", ctx.now, lambda: _http_json("GET", url))
        series = power.parse(sourced.payload)
    except SourceFailure as failure:
        gaps.append(_gap("climate", f"normals: {failure.cause}", NORMALS_SOURCE, failure.status,
                         window.end.isoformat()))
        normals = {"of_years": 0, "excluded_years": [], "error": failure.error}
        return [_row(n, None, as_of=None, source=NORMALS_SOURCE, fetched_at=None) for n in names], normals
    except (KeyError, ValueError, TypeError, AttributeError):
        gaps.append(_gap("climate", "malformed POWER normals response", NORMALS_SOURCE, "malformed",
                         window.end.isoformat()))
        return [_row(n, None, as_of=None, source=NORMALS_SOURCE, fetched_at=None) for n in names], \
            {"of_years": 0, "excluded_years": [], "error": "malformed POWER normals response"}

    rain_by_year = _group_by_year(series.get("PRECTOTCORR", {}))
    tmax_by_year = _group_by_year(series.get("T2M_MAX", {}))
    totals = agg.normal_totals(rain_by_year, window, NORMAL_YEARS)
    counts = agg.hot_counts(tmax_by_year, window, NORMAL_YEARS)
    included = totals.included
    rain_now = [current_rain.get(d) for d in agg.window_days(window)]
    current_total = None
    if window.valid_days == window.days:
        current_total = sum(ctx_rain for ctx_rain in rain_now if agg.is_valid(ctx_rain))
    rank = agg.rank_for_window(window, current_total, included) if current_total is not None else None
    percentile = agg.percentile_rank(rank, len(included)) if rank is not None and included else None
    if rank is None:
        gaps.append(_gap("climate", f"rain rank needs all {window.days} valid rain days in the window; "
                         f"{window.valid_days} are valid", NORMALS_SOURCE, "coverage below 100 percent",
                         window.end.isoformat()))
    if totals.excluded:
        gaps.append(_gap("climate", f"{len(totals.excluded)} earlier year(s) excluded: a fill day in their "
                         "calendar window", NORMALS_SOURCE, "fill day", window.end.isoformat()))
    hot_now, _ = agg.hot_days(tmax, window)
    values = {
        "rain_median": round(statistics.median(included.values()), 6) if included else None,
        "rain_min": min(included.values()) if included else None,
        "rain_max": max(included.values()) if included else None,
        "rain_rank": rank,
        "rain_percentile": percentile,
        "hot_days": hot_now,
        "hot_days_median": statistics.median(counts.included.values()) if counts.included else None,
    }
    normals: dict[str, Any] = {name: {"value": _fmt(name, values[name])} for name in names}
    normals["of_years"] = len(included)
    normals["excluded_years"] = totals.excluded
    rows = [_row(n, values[n], as_of=window.end.isoformat(), source=NORMALS_SOURCE, fetched_at=sourced.fetched_at)
            for n in names]
    return rows, normals


def _group_by_year(series: dict[date, float]) -> dict[int, dict[date, float]]:
    grouped: dict[int, dict[date, float]] = {}
    for day, value in series.items():
        grouped.setdefault(day.year, {})[day] = value
    return grouped


# --- water balance (R-22 to R-24) -----------------------------------------------------------

WATER_OUT_LABEL = ("EVLAND, land surface evaporation from POWER. It is not crop transpiration and not a "
                   "crop water demand; no reference evapotranspiration is used.")
WATER_STATEMENT = "An estimate built from modelled fluxes, not a measurement."


def _water(ctx: Context, series: dict | None, window: agg.Window | None, climate: dict, gaps: list) -> tuple[dict, list]:
    section: dict[str, Any] = {"state": "abstained", **_section_base(CLIMATE_SOURCE, None, None),
                               "in": None, "out": None, "remaining": None, "unit": "mm",
                               "out_label": WATER_OUT_LABEL, "formula": wb.FORMULA, "statement": WATER_STATEMENT,
                               "window": climate.get("window")}
    names = ["wb_in", "wb_out", "wb_remaining"]
    if series is None:
        section.update(state="unavailable", error=climate.get("error", "climate source unavailable"))
        climate_gap = next((g for g in gaps if g["section"] == "climate"), None)
        if climate_gap is not None:
            gaps.append(_gap("water_balance", climate_gap["cause"], CLIMATE_SOURCE, climate_gap["status"],
                             climate_gap["date"]))
        rows = [_row(n, None, as_of=None, source=CLIMATE_SOURCE, fetched_at=None) for n in names]
        return section, rows
    section.update(_section_base(CLIMATE_SOURCE, window.end.isoformat() if window else None, None))
    section["fetched_at"] = climate.get("fetched_at")
    section["cached"] = climate.get("cached", False)
    if window is None:
        gaps.append(_gap("water_balance", "no window: no consolidated rain day before the chosen date",
                         CLIMATE_SOURCE, "no valid rain day", ctx.chosen.isoformat()))
        rows = [_row(n, None, as_of=None, source=CLIMATE_SOURCE, fetched_at=climate.get("fetched_at")) for n in names]
        return section, rows
    result = wb.water_balance(series.get("PRECTOTCORR", {}), series.get("EVLAND", {}), window)
    as_of = window.end.isoformat()
    if result["ok"]:
        section.update(state="ok", **{"in": result["in"], "out": result["out"], "remaining": result["remaining"]})
    else:
        missing = {k: v for k, v in result["missing"].items() if v}
        text = ", ".join(f"{name} missing on {count} day(s)" for name, count in missing.items())
        gaps.append(_gap("water_balance", f"{text} in the window; the balance abstains as a whole",
                         CLIMATE_SOURCE, "coverage below 100 percent", as_of))
    rows = [_row("wb_in", result["in"], as_of=as_of, source=CLIMATE_SOURCE, fetched_at=climate.get("fetched_at")),
            _row("wb_out", result["out"], as_of=as_of, source=CLIMATE_SOURCE, fetched_at=climate.get("fetched_at")),
            _row("wb_remaining", result["remaining"], as_of=as_of, source=CLIMATE_SOURCE,
                 fetched_at=climate.get("fetched_at"))]
    return section, rows


# --- SMAP (R-25, R-26) -------------------------------------------------------------------

SMAP_SOURCE = "NASA GIBS SMAP layers through the block 4 tile proxy"


def _smap(ctx: Context, gaps: list) -> tuple[dict, list]:
    cause = ("the SMAP palette ramp is not in this repository, so the palette position of the served tile "
             "cannot be read in wave 1; no day carries a value")
    gaps.append(_gap("smap", cause, SMAP_SOURCE, "palette reader not built", ctx.chosen.isoformat(),
                     "block 6 wave 2"))
    section = {
        "state": "abstained", **_section_base(SMAP_SOURCE, None, None, basis="retrieved",
                                              resolution="9 km posting, 36 km radiometer footprint"),
        "axis": "0 to 100 percent of the served palette",
        "disclosure": "palette, not a physical unit",
        "shared_cell": "One 9 km cell is about 8,100 ha, and about 88 of the 900 polygons measured at the field "
                       "point share one value.",
        "days": [],
    }
    rows = [_row("smap_surface", None, as_of=None, source=SMAP_SOURCE, fetched_at=None),
            _row("smap_rootzone", None, as_of=None, source=SMAP_SOURCE, fetched_at=None)]
    return section, rows


# --- NDVI (R-27 to R-30) -----------------------------------------------------------------

NDVI_SOURCE = "Element84 Earth Search, collection sentinel-2-l2a, assets B04, B08 and SCL"
# R-29 names the best valid fraction, which is the highest `valid_fraction` over the scenes. A
# `valid_fraction` needs the B04, B08 and SCL zonal statistic, which needs the COG reader of OD-01.
# Until that reader exists the honest value is null, and the reason beside it names the producer.
NO_READER_REASON = ("not computed: the B04, B08 and SCL zonal statistic needs the cloud optimised "
                    "GeoTIFF reader of OD-01, which is not approved, so no scene carries a "
                    "valid_fraction and there is no best valid fraction")
NO_WINDOW_REASON = "not computed: no search window, so no scene was searched and no valid_fraction exists"
NO_CLIMATE_REASON = ("not computed: the search window is unknown because the climate source is "
                     "unavailable, so no scene was searched and no valid_fraction exists")


def _ndvi(ctx: Context, window: agg.Window | None, gaps: list, climate: dict[str, Any]) -> tuple[dict, list]:
    section: dict[str, Any] = {"state": "abstained", **_section_base(NDVI_SOURCE, None, None, basis="retrieved",
                                                                    resolution="10 m"),
                               "scene_count": None, "clear_count": None, "scenes": [],
                               # Table E requires `assets`. The search fills it from the item's own
                               # red, nir and scl assets; it stays an empty list when no search ran,
                               # so the key is never missing and no asset is written by hand.
                               "assets": [],
                               "best_valid_fraction": None,
                               "best_valid_fraction_reason": NO_READER_REASON}
    names = ["ndvi_scene_count", "ndvi_clear_count", "ndvi_mean", "ndvi_valid_fraction"]
    if window is None:
        if climate.get("state") == "unavailable":
            section.update(state="unavailable", error="search window unknown: climate source unavailable",
                           best_valid_fraction_reason=NO_CLIMATE_REASON)
            gaps.append(_gap("ndvi", "search window unknown: the climate source is unavailable, so the 42 day "
                             "window that bounds the search cannot be set", NDVI_SOURCE, "window unknown",
                             ctx.chosen.isoformat()))
        else:
            section["best_valid_fraction_reason"] = NO_WINDOW_REASON
            gaps.append(_gap("ndvi", "no window to search: no consolidated rain day before the chosen date",
                             NDVI_SOURCE, "no window", ctx.chosen.isoformat()))
        rows = [_row(n, None, as_of=None, source=NDVI_SOURCE, fetched_at=None) for n in names]
        return section, rows
    body = sentinel2.search_body(ctx.ring_request, window.start, window.end)
    key = f"{hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()}"
    try:
        sourced = _sourced("stac_search", key, ctx.now,
                           lambda: _http_json("POST", sentinel2.STAC_URL, body))
        scenes = sentinel2.parse_scenes(sourced.payload)
    except SourceFailure as failure:
        _unavailable(section, failure, "ndvi", NDVI_SOURCE, ctx.chosen.isoformat(), gaps)
        rows = [_row(n, None, as_of=None, source=NDVI_SOURCE, fetched_at=None) for n in names]
        return section, rows
    except (KeyError, ValueError, TypeError, AttributeError):
        section.update(state="unavailable", error="malformed STAC response")
        gaps.append(_gap("ndvi", "malformed STAC response", NDVI_SOURCE, "malformed", ctx.chosen.isoformat()))
        rows = [_row(n, None, as_of=None, source=NDVI_SOURCE, fetched_at=None) for n in names]
        return section, rows
    section.update(_section_base(NDVI_SOURCE, window.end.isoformat(), sourced, basis="retrieved", resolution="10 m"))
    section["scene_count"] = len(scenes)
    section["clear_count"] = sentinel2.clear_count(scenes)
    # Table E, ndvi row: the three assets the section reads, taken from the items the search returned.
    section["assets"] = sentinel2.asset_roles(scenes)
    # Table E's scene entry carries the two pixel counts beside the mean and the fraction. Both need
    # the same zonal statistic, so both are null while OD-01 is open, never a made up count.
    section["scenes"] = [{"id": s["id"], "date": s["date"], "cloud_cover": s["cloud_cover"],
                          "ndvi_mean": None, "valid_fraction": None, "kept_pixels": None,
                          "polygon_pixels": None, "partial": None} for s in scenes]
    gaps.append(_gap("ndvi", f"the B04, B08 and SCL zonal statistic needs a cloud optimised GeoTIFF reader that "
                     f"is not approved, so no valid_fraction is computed; {section['clear_count']} of "
                     f"{section['scene_count']} scenes are below 20 percent cloud",
                     NDVI_SOURCE, "reader not approved", window.end.isoformat(), "OD-01"))
    as_of = window.end.isoformat()
    rows = [_row("ndvi_scene_count", section["scene_count"], as_of=as_of, source=NDVI_SOURCE,
                 fetched_at=sourced.fetched_at),
            _row("ndvi_clear_count", section["clear_count"], as_of=as_of, source=NDVI_SOURCE,
                 fetched_at=sourced.fetched_at),
            _row("ndvi_mean", None, as_of=as_of, source=NDVI_SOURCE, fetched_at=sourced.fetched_at),
            _row("ndvi_valid_fraction", None, as_of=as_of, source=NDVI_SOURCE, fetched_at=sourced.fetched_at)]
    return section, rows


# --- soil (R-31, R-32) -------------------------------------------------------------------

def _soil(ctx: Context, gaps: list) -> tuple[dict, list]:
    url = soilgrids.url(ctx.lon, ctx.lat)
    section: dict[str, Any] = {"state": "abstained", **_section_base(soilgrids.URL, None, None, resolution=SOIL_RESOLUTION)}
    section.update(model_note="SoilGrids is a static 250 m model sampled at the centroid, not a map of the field.",
                   depths=[], d_factor={name: None for name in soilgrids.PROPERTIES})
    rows: list[dict[str, Any]] = []
    try:
        sourced = _sourced("soilgrids", f"{ctx.lon},{ctx.lat}", ctx.now, lambda: _http_json("GET", url))
        values = soilgrids.parse(sourced.payload)
    except SourceFailure as failure:
        _unavailable(section, failure, "soil", soilgrids.URL, None, gaps)
        for _, family, _, _ in SOIL_PROPERTIES:
            for _, depth_key in SOIL_DEPTHS:
                rows.append(_row(f"{family}.{depth_key}", None, as_of=None, source=soilgrids.URL, fetched_at=None))
        return section, rows
    except (KeyError, ValueError, TypeError, AttributeError):
        section.update(state="unavailable", error="malformed SoilGrids response")
        gaps.append(_gap("soil", "malformed SoilGrids response", soilgrids.URL, "malformed", None))
        return section, rows
    as_of = sourced.fetched_at[:10]
    section.update(_section_base(soilgrids.URL, as_of, sourced, resolution=SOIL_RESOLUTION))
    depth_rows = []
    any_value = False
    for depth, depth_key in SOIL_DEPTHS:
        entry: dict[str, Any] = {"label": depth, "depth": depth_key}
        for prop, family, decimals, unit in SOIL_PROPERTIES:
            cell = values[(prop, depth)]
            metric = f"{family}.{depth_key}"
            value = cell["value"]
            if value is None:
                gaps.append(_gap("soil", cell["reason"], soilgrids.URL, "absent", as_of))
            else:
                any_value = True
            rows.append(_row(metric, value, as_of=as_of, source=soilgrids.URL, fetched_at=sourced.fetched_at))
            entry[SOIL_DEPTH_KEYS[prop]] = _fmt(metric, value)
        depth_rows.append(entry)
    section["depths"] = depth_rows
    # Table E, soil row: the factor each property was divided by, read from the same response (R-31).
    section["d_factor"] = soilgrids.d_factors(values)
    section["state"] = "ok" if any_value else "abstained"
    return section, rows


# --- rotation (R-33 to R-36) -------------------------------------------------------------

def _rotation(ctx: Context, gaps: list) -> tuple[dict, list]:
    section = mapbiomas.rotation_section(MAPBIOMAS_DB, ctx.field.field_id)
    for gap in section["gaps"]:
        gaps.append(gap)
    rows: list[dict[str, Any]] = []
    source = section["source"]
    as_of = section.get("as_of")
    for key, product_key in (("first_crop", "mb_first_crop"), ("second_crop", "mb_second_crop")):
        for entry in section.get(key) or []:
            rows.append(_row(f"{product_key}.{entry['year']}", entry["class_name"], as_of=f"{entry['year']}-12-31",
                             source=source, fetched_at=None, route="sidecar"))
    section.pop("gaps", None)
    return section, rows


# --- municipal context (R-37, R-38) ------------------------------------------------------

MUNICIPAL_SOURCE = "IBGE SIDRA table 1612, API v3, variable 109, category 2713"
# Table E and AC-36: the state row prints labelled as a state total that is not this field.
STATE_ROW_LABEL = "state total, not this field"
SIDRA_YEARS = f"{sidra.YEARS.start} to {sidra.YEARS.stop - 1}"


def resolve_municipality(ctx: Context) -> tuple[str | None, str | None]:
    """The IBGE municipal join is CO-B6-06 and is not built, and no municipality code is inferred
    from a name, a centroid or the region adapter (R-38). The state code is a different fact: it is
    read from the field's own `location` text through the IBGE state table, the read block 4 R-31
    documents for this fixture data (`Santa Carmem, Mato Grosso` gives UF `MT`, code `51`).
    """
    if ctx.field.region != "br":
        return None, None
    return None, sidra.state_code(ctx.field.location)


def _newest_sidra_year(values: dict[int, int | None]) -> tuple[int, int] | None:
    """The newest reference year with a planted area, so a missing year never blanks the row (R-38)."""
    for year in sorted(values, reverse=True):
        value = values[year]
        if value is not None:
            return year, value
    return None


def _municipal(ctx: Context, gaps: list) -> tuple[dict, list]:
    code, state_code = resolve_municipality(ctx)
    section: dict[str, Any] = {"state": "abstained", **_section_base(MUNICIPAL_SOURCE, None, None, basis="retrieved",
                                                                    resolution="the municipality")}
    # Table E requires `municipality`, `state` and `share`. The section's own `state` key is the state
    # token of R-45, so Table E's state object is carried as `state_row`: one key cannot hold both,
    # and the worked response of the spec repeats `state` twice in the same object because of it.
    section.update(municipality=None, state_row=None, share=None, reason=None, state_reason=None)
    names = ["municipality_soy_ha", "state_soy_ha", "polygon_share"]
    if code is None:
        if ctx.field.region == "us":
            reason = ("municipality code is unresolved for this field: SIDRA table 1612 is an IBGE "
                      "product and carries no United States municipality")
        else:
            reason = ("municipality code is unresolved for this field: the IBGE municipal join is not built, "
                      "so the municipal row and the share abstain")
        section["reason"] = reason
        gaps.append(_gap("municipality", reason, MUNICIPAL_SOURCE, "unresolved", None, "CO-B6-06"))
    if state_code is None:
        if ctx.field.region == "us":
            cause = ("the state row does not print: SIDRA table 1612 is an IBGE product and carries no "
                     "United States state")
        else:
            cause = ("the state row does not print: this field carries no IBGE state code, and no state "
                     "is inferred from a centroid or the region adapter")
        section["state_reason"] = cause
        gaps.append(_gap("municipality", cause, MUNICIPAL_SOURCE, "unresolved", None, "CO-B6-06"))
        rows = [_row(n, None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None) for n in names]
        return section, rows
    try:
        sourced = _sourced("sidra", f"N3,{state_code}", ctx.now,
                           lambda: _http_json("GET", sidra.url("N3", state_code)))
        values = sidra.parse(sourced.payload, state_code, sidra.YEARS)
        name = sidra.locality_name(sourced.payload, state_code)
    except SourceFailure as failure:
        _unavailable(section, failure, "municipality", MUNICIPAL_SOURCE, None, gaps)
        section["state_reason"] = f"the state row does not print: {failure.cause}"
        rows = [_row(n, None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None) for n in names]
        return section, rows
    except (KeyError, ValueError, TypeError, AttributeError, LookupError) as error:
        section.update(state="abstained", error="malformed SIDRA response")
        section["state_reason"] = f"the state row does not print: malformed SIDRA response ({type(error).__name__})"
        gaps.append(_gap("municipality", "malformed SIDRA response", MUNICIPAL_SOURCE, "malformed", None))
        rows = [_row(n, None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None) for n in names]
        return section, rows
    newest = _newest_sidra_year(values)
    if newest is None:
        cause = (f"the state row does not print: SIDRA table 1612 carries no soy planted area for "
                 f"state {state_code} in {SIDRA_YEARS}")
        section["state_reason"] = cause
        gaps.append(_gap("municipality", cause, MUNICIPAL_SOURCE, "absent", None))
        rows = [_row(n, None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None) for n in names]
        return section, rows
    year, soy_ha = newest
    absent = sorted(y for y, value in values.items() if value is None)
    if absent:
        gaps.append(_gap("municipality",
                         f"the state row prints {year}: SIDRA carries no value for "
                         f"{', '.join(str(y) for y in absent)}",
                         MUNICIPAL_SOURCE, "absent", f"{year}-12-31"))
    # Table B2: the `as_of` of an annual statistic is the last day of its reference year.
    as_of = f"{year}-12-31"
    section.update(_section_base(MUNICIPAL_SOURCE, as_of, sourced, basis="retrieved", resolution="the municipality"))
    section["state_row"] = {"code": state_code, "name": name, "year": year,
                            "soy_ha": _fmt("state_soy_ha", soy_ha), "label": STATE_ROW_LABEL}
    rows = [_row("municipality_soy_ha", None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None),
            _row("state_soy_ha", soy_ha, as_of=as_of, source=MUNICIPAL_SOURCE, fetched_at=sourced.fetched_at),
            _row("polygon_share", None, as_of=None, source=MUNICIPAL_SOURCE, fetched_at=None)]
    return section, rows


# --- header and fragment (R-03, R-50) ----------------------------------------------------

def _area_rows(ctx: Context, gaps: list) -> list[dict[str, Any]]:
    """The area row (Table A `area`): ha and modelled in Brazil, acres and retrieved in the United States."""
    chosen = ctx.chosen.isoformat()
    source = "request body area_ha (block 5 polygon source)"
    if ctx.field.region == "us":
        basis, unit = "retrieved", "acres"
        value = None if ctx.area_ha is None else ctx.area_ha * ACRES_PER_HECTARE
    elif ctx.field.region == "br":
        basis, unit = "modelled", "ha"
        value = ctx.area_ha
    else:
        basis, unit = "entered", "ha"
        value = None
    if ctx.area_ha is None:
        gaps.append(_gap("header", "the request carries no area_ha", source, "absent", chosen, "block 5 R-24"))
    elif ctx.field.region is None:
        gaps.append(_gap("header", "the fixture entry carries no region, so the area unit and basis cannot resolve",
                         source, "region absent", chosen, "block 5 R-24"))
    area = _row("ring_area", value, as_of=chosen, source=source, fetched_at=None, basis=basis,
                resolution="the polygon", route="feature")
    area.update(metric="area", label="numbers.area", unit=unit,
                value=None if value is None else agg.round_half_up(value, 1))
    ring_ha = area_of_ring_m2(ctx.ring_request) / 10000.0
    ring = _row("ring_area", ring_ha, as_of=chosen, source="request ring, spherical area", fetched_at=None,
                basis="retrieved", route="request", resolution="the polygon")
    return [area, ring]



def _fragment(ctx: Context, gaps: list) -> dict[str, Any]:
    check = ring_fragment_check(ctx.ring_request, ctx.area_ha)
    section: dict[str, Any] = {"state": "ok", **check}
    if check["is_fragment"] is None:
        section["state"] = "abstained"
        gaps.append(_gap("fragment", "the request carries no area_ha, so the R-50 clip check is not computed",
                         "request ring", "absent", ctx.chosen.isoformat(), "block 5 R-24"))
    elif check["is_fragment"]:
        gaps.append(_gap("fragment", f"clip: the ring area {check['ring_area_ha']:.2f} ha differs from the polygon "
                         f"area {check['area_ha']:.2f} ha by {check['difference_percent']:.1f} percent; zonal "
                         "values from this ring are marked fragment", "request ring", "clip",
                         ctx.chosen.isoformat(), "CO-B6-05"))
    return section


# --- the route's payload ------------------------------------------------------------------

def build_numbers(field_id: str, request: NumbersRequest, *, fixture_fields: list[dict[str, Any]]) -> dict[str, Any]:
    now = clock()
    today = now.astimezone(timezone.utc).date()
    chosen = request.date
    if chosen < AXIS_START or chosen > today:
        raise NumbersError(400, f"date must be from {AXIS_START.isoformat()} to {today.isoformat()}")
    ring = _clean_ring(request.ring)
    centroid = (float(request.centroid[0]), float(request.centroid[1]))
    if not _point_in_ring(centroid, ring):
        raise NumbersError(400, "the centroid lies outside the ring")
    ref = resolve_field(field_id, fixture_fields)
    ctx = Context(field=ref, chosen=chosen, now=now, ring_request=request.ring, ring=ring,
                  centroid=centroid, area_ha=request.area_ha)

    gaps: list[dict[str, Any]] = []
    climate, climate_rows, series, window = _climate(ctx, gaps)
    water, water_rows = _water(ctx, series, window, climate, gaps)
    smap, smap_rows = _smap(ctx, gaps)
    ndvi, ndvi_rows = _ndvi(ctx, window, gaps, climate)
    soil, soil_rows = _soil(ctx, gaps)
    rotation, rotation_rows = _rotation(ctx, gaps)
    municipal, municipal_rows = _municipal(ctx, gaps)
    fragment = _fragment(ctx, gaps)
    header_rows = _area_rows(ctx, gaps)

    provenance = header_rows + climate_rows + water_rows + smap_rows + ndvi_rows + soil_rows + rotation_rows \
        + municipal_rows
    payload = {
        "schema_version": SCHEMA_VERSION,
        "field_id": field_id,
        "region": ref.region,
        "query": {
            "ring": request.ring,
            "centroid": list(request.centroid),
            "area_ha": request.area_ha,
            "date": chosen.isoformat(),
            "window": climate.get("window") or {"start": None, "end": None, "days": None, "valid_days": None,
                                                "dropped_days": None},
        },
        "sections": {
            "climate": climate,
            "water_balance": water,
            "smap": smap,
            "ndvi": ndvi,
            "soil": soil,
            "rotation": rotation,
            "municipality": municipal,
            "fragment": fragment,
        },
        "provenance": provenance,
        "gaps": gaps,
    }
    return payload
