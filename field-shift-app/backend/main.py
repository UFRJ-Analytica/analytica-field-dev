from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

import field_numbers

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "field-scenarios.json"
with FIXTURE_PATH.open(encoding="utf-8") as fixture_file:
    FIXTURE: dict[str, Any] = json.load(fixture_file)

BACKEND_DIR = Path(__file__).parent
TILE_CACHE_DIR = Path(os.getenv("TILE_CACHE_DIR", str(BACKEND_DIR / ".tile-cache")))
TILE_CACHE_TTL = timedelta(hours=24)
GIBS_BASE_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
AXIS_START = date(2015, 4, 1)

# Block 5, R-09: the two hosting modes per region. The polygon products are written by the
# build cards beside the app (data/polygons), never by this route, and the United States
# manifest of Table G is read here so the mode response and the app cannot disagree about a
# zoom bound. `POLYGON_DIR` is the one configured path (Expected Interface).
POLYGON_DIR = Path(os.getenv("POLYGON_DIR", str(BACKEND_DIR.parent / "data" / "polygons")))
POLYGON_SOURCE_DIRECT_URL = (
    "https://data.source.coop/wri-data-lab/trazofields/trazo3-fields/trazo3.pmtiles"
)
TABLE_G_KEYS = (
    "schema_version",
    "region",
    "clip_box",
    "detail_minzoom",
    "detail_maxzoom",
    "overview_minzoom",
    "overview_maxzoom",
    "interactive_minzoom",
)


def _layer(
    layer_id: str,
    gibs_id: str,
    matrix: str,
    max_zoom: int,
    label: str,
    basis: str,
    resolution: str,
    cadence: str,
    lookback_days: int | None,
    time_format: str,
    time_start: str,
    declared_end: str,
    kind: str,
    optical: bool,
    reserve: str | None = None,
    window_days: float | int | None = None,
) -> dict[str, Any]:
    """One registry entry, with the fields fixed by the Data contracts section."""
    return {
        "id": layer_id,
        "gibs_id": gibs_id,
        "matrix": matrix,
        "max_zoom": max_zoom,
        "label": label,
        "basis": basis,
        "resolution": resolution,
        "cadence": cadence,
        "lookback_days": lookback_days,
        "time_format": time_format,
        "time_start": time_start,
        "declared_end": declared_end,
        "kind": kind,
        "optical": optical,
        "blank_threshold_bytes": 5000 if optical else None,
        "reserve": reserve,
        "window_days": window_days,
    }


# The registry is the single source of a layer id, a GIBS identifier and a tile
# matrix (R-01). The order is the stack order of the /layers response.
LAYER_REGISTRY: dict[str, dict[str, Any]] = {
    entry["id"]: entry
    for entry in (
        _layer("smap-l3", "SMAP_L3_Passive_Enhanced_Day_Soil_Moisture", "GoogleMapsCompatible_Level6", 6,
               "SMAP soil moisture", "retrieved", "9 km", "P1D", 7, "date", "2015-03-31", "2026-11-11", "tile", False,
               reserve="backend/reserve/smap-soil-moisture.png", window_days=1),
        _layer("smap-l4-surface", "SMAP_L4_Analyzed_Surface_Soil_Moisture", "GoogleMapsCompatible_Level6", 6,
               "SMAP L4 surface soil moisture", "modelled", "9 km", "P1D", 7, "date", "2015-03-31", "2026-11-10", "tile", False,
               window_days=1),
        _layer("smap-l4-root", "SMAP_L4_Analyzed_Root_Zone_Soil_Moisture", "GoogleMapsCompatible_Level6", 6,
               "SMAP L4 root-zone soil moisture", "modelled", "9 km", "P1D", 7, "date", "2015-03-31", "2026-11-10", "tile", False,
               window_days=1),
        _layer("imerg-daily", "IMERG_Precipitation_Rate", "GoogleMapsCompatible_Level6", 6,
               "IMERG precipitation, daily", "retrieved", "about 11 km", "P1D", 7, "date", "2000-06-01", "2026-11-13", "tile", False,
               window_days=1),
        _layer("imerg-30min", "IMERG_Precipitation_Rate_30min", "GoogleMapsCompatible_Level6", 6,
               "IMERG precipitation, 30 minutes", "retrieved", "about 11 km", "PT30M", 1, "datetime",
               "2026-01-19T20:30:00Z", "2026-11-14T12:30:00Z", "tile", False, window_days=0.02),
        _layer("ndvi-8day", "MODIS_Terra_NDVI_8Day", "GoogleMapsCompatible_Level9", 9,
               "MODIS NDVI, 8 day", "retrieved", "250 m", "P1D", 16, "date", "2025-02-12", "2026-11-13", "tile", False,
               window_days=8),
        _layer("evi-8day", "MODIS_Terra_EVI_8Day", "GoogleMapsCompatible_Level9", 9,
               "MODIS EVI, 8 day", "retrieved", "250 m", "P1D", 16, "date", "2025-02-12", "2026-11-13", "tile", False,
               window_days=8),
        _layer("ndvi-monthly", "MODIS_Terra_L3_NDVI_Monthly", "GoogleMapsCompatible_Level7", 7,
               "MODIS NDVI, monthly", "retrieved", "250 m", "P1M", 62, "date", "2000-03-01", "2026-10-01", "tile", False,
               window_days=31),
        _layer("lst-terra", "MODIS_Terra_L3_Land_Surface_Temp_Daily_Day", "GoogleMapsCompatible_Level7", 7,
               "MODIS land surface temperature, Terra", "retrieved", "1 km", "P1D", 7, "date", "2000-02-25", "2026-11-13", "tile", False,
               window_days=1),
        _layer("lst-aqua", "MODIS_Aqua_Land_Surface_Temp_Day", "GoogleMapsCompatible_Level7", 7,
               "MODIS land surface temperature, Aqua", "retrieved", "1 km", "P1D", 7, "date", "2002-07-03", "2026-11-14", "tile", False,
               window_days=1),
        _layer("hls-l30", "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "GoogleMapsCompatible_Level12", 12,
               "HLS Landsat reflectance, 30 m", "retrieved", "30 m", "P1D", 30, "date", "2013-03-22", "2026-11-06", "tile", True,
               window_days=1),
        _layer("hls-s30", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "GoogleMapsCompatible_Level12", 12,
               "HLS Sentinel-2 reflectance, 30 m", "retrieved", "30 m", "P1D", 30, "date", "2015-11-28", "2026-11-06", "tile", True,
               window_days=1),
        _layer("grace-mascon", "GRACE_Tellus_Liquid_Water_Equivalent_Thickness_Mascon_CRI", "GoogleMapsCompatible_Level6", 6,
               "GRACE water storage, stale", "retrieved", "about 300 km, mascon", "mixed P28D, P17D, P1M", None, "date",
               "2002-04-04", "2022-07-01", "stale", False),
    )
}

# The block 1 id stays an alias of smap-l3 (R-01, AM-03).
LAYER_ALIASES: dict[str, str] = {"smap-soil-moisture": "smap-l3"}

_upstream_requests = 0
_tile_lock = threading.RLock()

app = FastAPI(title="Field Shift API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Tile-Source", "X-Tile-Fallback", "X-Tile-Date", "X-Tile-Status"],
)
# Field Shift AI (experiment): routes under /experimental/field-shift-ai only; no existing route changes.
from field_shift_agent.routes import router as field_shift_ai_router  # noqa: E402

app.include_router(field_shift_ai_router)

COMMANDS: tuple[dict[str, Any], ...] = (
    {
        "name": "select_field",
        "label": "Select a field",
        "input_schema": {"type": "object", "properties": {"field_id": {"type": "string", "minLength": 1}}, "required": ["field_id"], "additionalProperties": False},
        "effect": "select_field",
        "idempotent": False,
        "guard": "field_id must identify a fixture field, a trazo: polygon id or a csb: field id",
    },
    {
        "name": "set_composition",
        "label": "Set map composition",
        "input_schema": {"type": "object", "properties": {"preset": {"type": "string", "enum": ["map", "satellite", "satellite-with-labels"]}}, "required": ["preset"], "additionalProperties": False},
        "effect": "set_composition",
        "idempotent": True,
        "guard": "preset must be a supported map composition",
    },
    {
        "name": "open_panel",
        "label": "Open a panel",
        "input_schema": {"type": "object", "properties": {"panel": {"type": "string", "enum": ["scenarios", "evidence"]}}, "required": ["panel"], "additionalProperties": False},
        "effect": "open_panel",
        "idempotent": True,
        "guard": "panel must be one of the available workspace panels",
    },
    {
        "name": "apply_filter",
        "label": "Apply a scenario filter",
        "input_schema": {"type": "object", "properties": {"filter": {"type": "string", "enum": ["all", "ranked", "abstained"]}}, "required": ["filter"], "additionalProperties": False},
        "effect": "apply_filter",
        "idempotent": False,
        "guard": "filter must be all, ranked, or abstained",
    },
)
COMMANDS_BY_NAME = {command["name"]: command for command in COMMANDS}
COMMAND_NAMES = [command["name"] for command in COMMANDS]
command_state: dict[str, Any] = {
    "selected_field_id": None,
    "composition": "map",
    "open_panel": None,
    "filter": None,
}


def _validate_command_arguments(name: str, arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=422, detail="Command arguments must be a JSON object")
    schema = COMMANDS_BY_NAME[name]["input_schema"]
    properties = schema["properties"]
    if set(arguments) != set(properties):
        raise HTTPException(status_code=422, detail=f"Arguments must contain exactly: {', '.join(properties)}")
    for key, value in arguments.items():
        rule = properties[key]
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail=f"{key} must be a string")
        if len(value) < rule.get("minLength", 0) or ("enum" in rule and value not in rule["enum"]):
            raise HTTPException(status_code=422, detail=f"Invalid value for {key}")
    return arguments


@app.get("/commands")
def list_commands() -> dict[str, Any]:
    return {"commands": list(COMMANDS)}


@app.post("/commands/{name}")
def execute_command(name: str, arguments: Any = Body(...)) -> dict[str, Any]:
    if name not in COMMANDS_BY_NAME:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=422,
            content={"detail": "Unknown command", "valid_names": COMMAND_NAMES},
        )
    validated_arguments = _validate_command_arguments(name, arguments)
    state_key, state_value = {
        "select_field": ("selected_field_id", validated_arguments.get("field_id")),
        "set_composition": ("composition", validated_arguments.get("preset")),
        "open_panel": ("open_panel", validated_arguments.get("panel")),
        "apply_filter": ("filter", validated_arguments.get("filter")),
    }[name]
    command_state[state_key] = state_value
    return {"name": name, "effect": COMMANDS_BY_NAME[name]["effect"], "arguments": validated_arguments, "state": dict(command_state)}


def resolve_layer(layer_id: str) -> dict[str, Any] | None:
    """Resolve a requested id, including the block 1 alias, to its registry entry."""
    return LAYER_REGISTRY.get(LAYER_ALIASES.get(layer_id, layer_id))


def _axis_end() -> date:
    return max(date.fromisoformat(entry["declared_end"][:10]) for entry in LAYER_REGISTRY.values())


AXIS_END = _axis_end()
AXIS = {"start": AXIS_START.isoformat(), "end": AXIS_END.isoformat(), "default": AXIS_END.isoformat()}


def _parse_chosen(value: str | None) -> date:
    if not value:
        return AXIS_END
    try:
        chosen = date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date, expected YYYY-MM-DD") from exc
    return min(max(chosen, AXIS_START), AXIS_END)


def _token_for(entry: dict[str, Any], value: date | datetime) -> str:
    """Format one candidate token. A datetime layer refuses a date-only token (R-09)."""
    if entry["time_format"] == "datetime":
        if not isinstance(value, datetime):
            raise ValueError("datetime layers need a full UTC token, not a date-only token")
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, datetime):
        value = value.date()
    return value.isoformat()


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _floor_thirty_minutes(value: datetime) -> datetime:
    return value.replace(minute=(value.minute // 30) * 30, second=0, microsecond=0)


def _candidate_tokens(entry: dict[str, Any], chosen: date) -> list[str]:
    """The walk of R-05, newest candidate first, bounded by time_start and lookback_days."""
    lookback = entry["lookback_days"]
    if entry["time_format"] == "datetime":
        end_of_day = datetime.combine(chosen, time(23, 59, 59), tzinfo=timezone.utc)
        declared_end = _parse_utc(entry["declared_end"])
        start = _floor_thirty_minutes(min(end_of_day, declared_end))
        lower = max(_parse_utc(entry["time_start"]), end_of_day - timedelta(days=lookback or 0))
        candidates: list[str] = []
        cursor = start
        while cursor >= lower:
            candidates.append(_token_for(entry, cursor))
            cursor -= timedelta(minutes=30)
        return candidates

    declared_end = date.fromisoformat(entry["declared_end"][:10])
    start = min(chosen, declared_end)
    lower = max(date.fromisoformat(entry["time_start"][:10]), chosen - timedelta(days=lookback or 0))
    candidates = []
    if entry["cadence"].startswith("P1M"):
        cursor = start.replace(day=1)
        while cursor >= lower:
            candidates.append(_token_for(entry, cursor))
            cursor = (cursor.replace(day=1) - timedelta(days=1)).replace(day=1)
        return candidates
    cursor = start
    while cursor >= lower:
        candidates.append(_token_for(entry, cursor))
        cursor -= timedelta(days=1)
    return candidates


@dataclass
class TileResolution:
    """The outcome of the effective-date walk for one layer, chosen date and tile."""

    status: str
    effective_date: str | None = None
    age_days: int | None = None
    last_observation: str | None = None
    response: httpx.Response | None = None
    attempts: list[str] = field(default_factory=list)


def _http_fetch(url: str) -> httpx.Response:
    global _upstream_requests
    with _tile_lock:
        _upstream_requests += 1
    with httpx.Client(timeout=10.0, follow_redirects=True) as client:
        return client.get(url)


# Tests replace this hook with a recorded transport (the spec's mock transports).
upstream_fetch: Callable[[str], httpx.Response] = _http_fetch


def _tile_suffix(entry: dict[str, Any]) -> str:
    # HLS products are served as JPEG on GIBS; the rest are PNG.
    return ".jpg" if entry["optical"] else ".png"


def _tile_media_type(entry: dict[str, Any]) -> str:
    return "image/jpeg" if entry["optical"] else "image/png"


def _upstream_url(entry: dict[str, Any], token: str, z: int, x: int, y: int) -> str:
    base_url = os.getenv("TILE_UPSTREAM_URL", GIBS_BASE_URL).rstrip("/")
    return (
        f"{base_url}/{entry['gibs_id']}/default/{token}"
        f"/{entry['matrix']}/{z}/{y}/{x}{_tile_suffix(entry)}"
    )


def _same_day(entry: dict[str, Any], effective: str, chosen: date) -> bool:
    return effective[:10] == chosen.isoformat()


def _age_days(effective: str, chosen: date) -> int:
    return (chosen - date.fromisoformat(effective[:10])).days


def resolve_effective_date(
    layer: str | dict[str, Any],
    chosen: date | datetime | str,
    fetch: Callable[[str], httpx.Response] | None = None,
    z: int = 0,
    x: int = 0,
    y: int = 0,
) -> TileResolution:
    """The effective-date rule of R-05 as a pure function over a fetch callable."""
    entry = resolve_layer(layer) if isinstance(layer, str) else layer
    if entry is None:
        raise KeyError(f"Unknown layer {layer}")
    fetch = fetch or upstream_fetch
    if entry["kind"] == "stale":
        return TileResolution(status="stale", last_observation=entry["declared_end"][:10])
    if isinstance(chosen, str):
        chosen = date.fromisoformat(chosen[:10])
    chosen_day = chosen.date() if isinstance(chosen, datetime) else chosen
    attempts: list[str] = []
    for token in _candidate_tokens(entry, chosen_day):
        attempts.append(token)
        try:
            response = fetch(_upstream_url(entry, token, z, x, y))
        except httpx.HTTPError:
            return TileResolution(status="unavailable", attempts=attempts)
        status = response.status_code
        if status == 200:
            threshold = entry["blank_threshold_bytes"]
            if threshold is not None and len(response.content) <= threshold:
                continue
            effective_status = "on_date" if _same_day(entry, token, chosen_day) else "earlier"
            return TileResolution(
                status=effective_status,
                effective_date=token,
                age_days=_age_days(token, chosen_day),
                response=response,
                attempts=attempts,
            )
        if status in (400, 404):
            continue
        return TileResolution(status="unavailable", attempts=attempts)
    return TileResolution(status="none_in_lookback", attempts=attempts)


_resolution_cache: dict[tuple[str, str, int, int, int], tuple[datetime, TileResolution]] = {}


def _clear_resolution_cache() -> None:
    _resolution_cache.clear()


def _resolve_cached(entry: dict[str, Any], chosen: date, z: int, x: int, y: int) -> TileResolution:
    key = (entry["id"], chosen.isoformat(), z, x, y)
    now = datetime.now(timezone.utc)
    cached = _resolution_cache.get(key)
    if cached is not None and now - cached[0] < TILE_CACHE_TTL:
        return cached[1]
    resolution = resolve_effective_date(entry, chosen, z=z, x=x, y=y)
    _resolution_cache[key] = (now, resolution)
    return resolution


def _tile_cache_path(entry: dict[str, Any], tile_date: str, z: int, x: int, y: int) -> Path:
    return TILE_CACHE_DIR / entry["id"] / tile_date[:10] / str(z) / str(x) / f"{y}{_tile_suffix(entry)}"


def _read_fresh_cache(path: Path) -> bytes | None:
    try:
        if datetime.now(timezone.utc).timestamp() - path.stat().st_mtime < TILE_CACHE_TTL.total_seconds():
            return path.read_bytes()
    except FileNotFoundError:
        pass
    return None


def _write_cache(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_bytes(content)
    temporary_path.replace(path)


def _cached_tiles_on_or_before(entry: dict[str, Any], chosen: date, z: int, x: int, y: int) -> list[tuple[date, Path]]:
    """Every cached tile of this layer and address dated on or before the chosen date (R-25)."""
    base = TILE_CACHE_DIR / entry["id"]
    if not base.is_dir():
        return []
    found: list[tuple[date, Path]] = []
    for date_dir in base.iterdir():
        try:
            tile_date = date.fromisoformat(date_dir.name)
        except ValueError:
            continue
        if tile_date > chosen:
            continue
        path = date_dir / str(z) / str(x) / f"{y}{_tile_suffix(entry)}"
        if path.is_file():
            found.append((tile_date, path))
    found.sort(key=lambda item: item[0], reverse=True)
    return found


def _reserve_tile(entry: dict[str, Any], upstream_status: int | str) -> Response | None:
    if not entry["reserve"]:
        return None
    reserve_path = BACKEND_DIR.parent / entry["reserve"]
    if not reserve_path.is_file():
        return None
    return Response(
        content=reserve_path.read_bytes(),
        media_type="image/png",
        headers={
            "X-Tile-Source": "reserve",
            "X-Tile-Fallback": f"Local reserve tile served after upstream failure ({upstream_status})",
        },
    )


def _offline_tile(entry: dict[str, Any], chosen: date, z: int, x: int, y: int, upstream_status: int | str) -> Response:
    for tile_date, path in _cached_tiles_on_or_before(entry, chosen, z, x, y):
        try:
            content = path.read_bytes()
        except OSError:
            continue
        return Response(
            content=content,
            media_type=_tile_media_type(entry),
            headers={"X-Tile-Source": "cache-offline", "X-Tile-Date": tile_date.isoformat()},
        )
    reserve = _reserve_tile(entry, upstream_status)
    if reserve is not None:
        return reserve
    return Response(status_code=404, content=b"", headers={"X-Tile-Status": "no_offline_copy"})


def _tile_for_coordinate(longitude: float, latitude: float, zoom: int) -> tuple[int, int]:
    scale = 2**zoom
    x = int((longitude + 180.0) / 360.0 * scale)
    latitude_radians = math.radians(latitude)
    y = int((1 - math.asinh(math.tan(latitude_radians)) / math.pi) / 2 * scale)
    return min(max(x, 0), scale - 1), min(max(y, 0), scale - 1)


def _first_field_tile(zoom: int) -> tuple[int, int]:
    center = FIXTURE["fields"][0]["center"]
    return _tile_for_coordinate(center[0], center[1], zoom)


def _layer_row(entry: dict[str, Any], chosen: date, z: int, x: int, y: int) -> dict[str, Any]:
    effective_date: str | None = None
    age_days: int | None = None
    last_observation: str | None = None
    if entry["kind"] == "stale":
        status = "stale"
        last_observation = entry["declared_end"][:10]
    else:
        layer_zoom = min(z, entry["max_zoom"])
        scale = 2 ** (z - layer_zoom)
        resolution = _resolve_cached(entry, chosen, layer_zoom, x // scale, y // scale)
        status = resolution.status
        effective_date = resolution.effective_date
        age_days = resolution.age_days
    return {
        "id": entry["id"],
        "label": entry["label"],
        "kind": entry["kind"],
        "basis": entry["basis"],
        "resolution": entry["resolution"],
        "matrix": entry["matrix"],
        "max_zoom": entry["max_zoom"],
        # The JSON sample of the spec fixes the client facing cadence of the
        # stale layer as "mixed"; the registry keeps Table B's full string.
        "cadence": "mixed" if entry["kind"] == "stale" else entry["cadence"],
        "lookback_days": entry["lookback_days"],
        "time_format": entry["time_format"],
        "optical": entry["optical"],
        "window_days": entry["window_days"],
        "status": status,
        "effective_date": effective_date,
        "age_days": age_days,
        "last_observation": last_observation,
    }


@app.get("/layers")
def list_layers(
    chosen: str | None = Query(default=None, alias="date"),
    z: int = 11,
    x: int | None = None,
    y: int | None = None,
) -> dict[str, Any]:
    if z < 0 or z > 30:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")
    if x is None or y is None:
        default_x, default_y = _first_field_tile(z)
        x = default_x if x is None else x
        y = default_y if y is None else y
    if min(x, y) < 0 or x >= 2**z or y >= 2**z:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    chosen_day = _parse_chosen(chosen)
    return {
        "chosen_date": chosen_day.isoformat(),
        "axis": dict(AXIS),
        "layers": [_layer_row(entry, chosen_day, z, x, y) for entry in LAYER_REGISTRY.values()],
    }


@app.get("/layers/{layer_id}/coverage", response_model=None)
def layer_coverage(
    layer_id: str,
    days: int = 30,
    chosen: str | None = Query(default=None, alias="date"),
) -> Response | dict[str, Any]:
    entry = resolve_layer(layer_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown layer")
    if not entry["optical"]:
        raise HTTPException(status_code=400, detail="Coverage is only defined for optical layers")
    if days < 1 or days > 90:
        raise HTTPException(status_code=400, detail="days must be between 1 and 90")

    chosen_day = _parse_chosen(chosen)
    zoom = entry["max_zoom"]
    x, y = _first_field_tile(zoom)
    dates_scanned: list[str] = []
    rows: list[dict[str, Any]] = []
    for back in range(days):
        tile_date = chosen_day - timedelta(days=back)
        token = _token_for(entry, tile_date)
        dates_scanned.append(token)
        try:
            response = upstream_fetch(_upstream_url(entry, token, zoom, x, y))
        except httpx.HTTPError:
            return _coverage_unavailable(dates_scanned)
        if response.status_code not in (200, 400, 404):
            return _coverage_unavailable(dates_scanned)
        body_bytes = len(response.content)
        rows.append({
            "date": token,
            "http_status": response.status_code,
            "bytes": body_bytes,
            "coverage_ok": response.status_code == 200 and body_bytes > entry["blank_threshold_bytes"],
        })
    return {
        "status": "ok",
        "layer": entry["id"],
        "start": dates_scanned[-1],
        "end": dates_scanned[0],
        "days": days,
        "dates": rows,
    }


def _coverage_unavailable(dates_scanned: list[str]) -> Response:
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=503, content={"status": "unavailable", "dates_scanned": dates_scanned})


@app.get("/tiles/stats/upstream")
def tile_upstream_stats() -> dict[str, int]:
    with _tile_lock:
        return {"upstream_requests": _upstream_requests}


@app.get("/tiles/{layer}/{z}/{x}/{y}")
def get_tile(
    layer: str,
    z: int,
    x: int,
    y: int,
    chosen: str | None = Query(default=None, alias="date"),
) -> Response:
    entry = resolve_layer(layer)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown tile layer")
    if min(z, x, y) < 0 or z > 30 or x >= 2**z or y >= 2**z:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")
    if z > entry["max_zoom"]:
        raise HTTPException(status_code=400, detail="Zoom above max_zoom for layer")

    chosen_day = _parse_chosen(chosen)
    if entry["kind"] == "stale":
        return Response(status_code=404, content=b"", headers={"X-Tile-Status": "stale"})

    resolution = _resolve_cached(entry, chosen_day, z, x, y)
    if resolution.status == "none_in_lookback":
        return Response(status_code=404, content=b"", headers={"X-Tile-Status": "none_in_lookback"})
    if resolution.status == "unavailable":
        return _offline_tile(entry, chosen_day, z, x, y, "upstream unavailable")

    cache_path = _tile_cache_path(entry, resolution.effective_date or "", z, x, y)
    content = _read_fresh_cache(cache_path)
    source = "cache"
    if content is None and resolution.response is not None:
        content = resolution.response.content
        _write_cache(cache_path, content)
        source = "upstream"
    if content is None:
        try:
            refreshed = upstream_fetch(_upstream_url(entry, resolution.effective_date or "", z, x, y))
        except httpx.HTTPError:
            return _offline_tile(entry, chosen_day, z, x, y, "connection error")
        if refreshed.status_code != 200:
            return _offline_tile(entry, chosen_day, z, x, y, refreshed.status_code)
        content = refreshed.content
        _write_cache(cache_path, content)
        source = "upstream"
    return Response(
        content=content,
        media_type=_tile_media_type(entry),
        headers={"X-Tile-Source": source, "X-Tile-Date": resolution.effective_date or ""},
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _read_us_manifest() -> dict[str, Any]:
    """Table G, read strictly. A missing key or a broken rule is a failed load, never a default."""
    manifest_path = POLYGON_DIR / "us-38017.manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=503, detail="us-38017.manifest.json is absent")
    with manifest_path.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    if set(manifest) != set(TABLE_G_KEYS):
        raise HTTPException(status_code=503, detail="the manifest does not carry the Table G keys")
    if manifest["schema_version"] != "1" or manifest["region"] != "us":
        raise HTTPException(status_code=503, detail="the manifest header is not the Table G header")
    if manifest["clip_box"] != "-97.20,46.90,-97.14,46.96":
        raise HTTPException(status_code=503, detail="the manifest clip_box is not the pilot box")
    detail = manifest["detail_minzoom"]
    if not isinstance(detail, int) or detail > 9:
        raise HTTPException(status_code=503, detail="detail_minzoom must be an integer of at most 9")
    if manifest["detail_maxzoom"] != 14:
        raise HTTPException(status_code=503, detail="detail_maxzoom must be 14")
    if manifest["overview_minzoom"] != detail - 3 or manifest["overview_maxzoom"] != detail - 1:
        raise HTTPException(status_code=503, detail="the overview range is not derived from detail_minzoom")
    if manifest["interactive_minzoom"] != detail + 2:
        raise HTTPException(status_code=503, detail="interactive_minzoom must be detail_minzoom + 2")
    return manifest


@app.get("/polygons/mode")
def polygon_mode(region: Literal["us", "br"] = Query(description="us or br")) -> dict[str, Any]:
    """R-09: the one hosting mode read of a load, per region. No tile is read here.

    The United States is self-hosted only and its zoom values are the manifest's (Table G),
    so this response and the app cannot disagree. Brazil keeps the two modes of R-09: the
    self-hosted extract when both files exist, the source-direct URL otherwise. Every load
    reports `mbmode24` as the one class property (R-18), because the extract preserves it.
    """
    if region == "us":
        manifest = _read_us_manifest()
        return {
            "region": "us",
            "mode": "self-hosted",
            "classProperty": None,
            "class_property_pattern": "cdl{year}",
            "class_year_range": [2018, 2025],
            "detail_minzoom": manifest["detail_minzoom"],
            "detail_maxzoom": manifest["detail_maxzoom"],
            "overview_minzoom": manifest["overview_minzoom"],
            "overview_maxzoom": manifest["overview_maxzoom"],
            "interactive_minzoom": manifest["interactive_minzoom"],
            "detail_file": "/data/polygons/us-38017-detail.pmtiles",
            "overview_file": "/data/polygons/us-38017-overview.pmtiles",
        }

    detail = POLYGON_DIR / "br-mt-detail.pmtiles"
    overview = POLYGON_DIR / "br-mt-overview.pmtiles"
    self_hosted = detail.exists() and overview.exists()
    return {
        "region": "br",
        "mode": "self-hosted" if self_hosted else "source-direct",
        "classProperty": "mbmode24",
        "detail_file": "/data/polygons/br-mt-detail.pmtiles" if self_hosted else POLYGON_SOURCE_DIRECT_URL,
        "overview_file": "/data/polygons/br-mt-overview.pmtiles" if self_hosted else None,
    }


@app.get("/fields")
def list_fields() -> dict[str, Any]:
    return {
        "seasons": FIXTURE["seasons"],
        "default_season": FIXTURE["default_season"],
        "fields": [
            {key: value for key, value in field.items() if key != "scenarios"}
            for field in FIXTURE["fields"]
        ],
    }


@app.get("/fields/{field_id}/scenarios")
def get_scenarios(field_id: str) -> dict[str, Any]:
    field = next((entry for entry in FIXTURE["fields"] if entry["id"] == field_id), None)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")

    threshold = "coverage_below_80_percent" if field["coverage"] < 80 else None
    return {
        "field_id": field["id"],
        "season": FIXTURE["default_season"],
        "state": "abstained" if threshold else "ranked",
        "threshold": threshold,
        "coverage": field["coverage"],
        "scenarios": field["scenarios"],
    }


@app.post("/fields/{field_id}/numbers")
def post_field_numbers(field_id: str, body: field_numbers.NumbersRequest = Body(...)) -> dict[str, Any]:
    """Block 6 R-45: the one numbers route. Refusals are 400 and 404; a body that misses the schema is 422."""
    try:
        return field_numbers.build_numbers(field_id, body, fixture_fields=FIXTURE["fields"])
    except field_numbers.NumbersError as error:
        raise HTTPException(status_code=error.status, detail=error.detail) from error

