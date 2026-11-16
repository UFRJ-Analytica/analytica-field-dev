"""Geospatial Agent Tools, model side (Field Shift AI, experiment).

The model may ask the map to change what it shows: region, field, date, layers, framing. The backend does
not run those actions: it validates each call against a closed schema and returns the accepted ones in
`ChatResponse.map_actions`. The browser validates them again against its own catalogs and runs them through
the app's map store, reporting every step. Nothing here reaches the network, the DOM or the file system.

Rules the model is told (prompts.py) and that the shape enforces:
- only these ten tools exist; any other name is an error result;
- arguments are closed enums or bounded strings, so a model cannot name an endpoint or code;
- at most MAX_MAP_ACTIONS per answer;
- the map runs after the answer, so the answer may say what it asked for, never what the map shows.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_MAP_ACTIONS = 8

# The `/layers` catalog ids the map holds (backend/main.py). A layer outside this list cannot be asked for.
LAYER_IDS = ["smap-l4-surface", "smap-l4-root", "imerg-daily", "imerg-30min", "ndvi-8day", "evi-8day",
             "ndvi-monthly", "lst-terra", "lst-aqua", "grace-mascon"]
METRIC_VARS = ["rain", "soil_moisture", "temperature", "vegetation", "water_risk", "overview"]
REGIONS = ["Cass County", "McLean County", "Lubbock County"]


class MapAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: Literal["select_region", "select_field", "focus_geometry", "set_date", "set_analysis_window", "show_layer",
                  "hide_layer", "query_field_metrics", "compare_metrics", "highlight_evidence"]
    arguments: dict[str, Any]


class _Region(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region: Literal["Cass County", "McLean County", "Lubbock County"]


class _Field(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9 ]+$")


class _Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: Literal["selected_field"]


class _Date(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class _Window(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: int = Field(ge=1, le=366)


class _Layer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layer: Literal[tuple(LAYER_IDS)]  # type: ignore[valid-type]


class _Metrics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metrics: list[Literal[tuple(METRIC_VARS)]] = Field(min_length=1, max_length=4)  # type: ignore[valid-type]


ARGUMENT_MODELS: dict[str, type[BaseModel]] = {
    "select_region": _Region,
    "select_field": _Field,
    "focus_geometry": _Target,
    "highlight_evidence": _Target,
    "set_date": _Date,
    "set_analysis_window": _Window,
    "show_layer": _Layer,
    "hide_layer": _Layer,
    "query_field_metrics": _Metrics,
    "compare_metrics": _Metrics,
}


def _schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


_METRICS = {"type": "array", "items": {"type": "string", "enum": METRIC_VARS}, "minItems": 1, "maxItems": 4}
_TARGET = {"type": "string", "enum": ["selected_field"]}

MAP_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {"name": "select_region", "strict": True, "input_schema": _schema({"region": {"type": "string", "enum": REGIONS}}),
     "description": "Map action: open one of the United States counties the app holds by selecting its first field. "
                    "Runs in the browser after your answer."},
    {"name": "select_field", "strict": True,
     "input_schema": _schema({"field": {"type": "string", "description": "A field name such as 'Field 02' or "
                                         "'Cass Field 01', a number 1 to 3, 'first' or 'current'."}}),
     "description": "Map action: select a demonstration field of the active region."},
    {"name": "focus_geometry", "strict": True, "input_schema": _schema({"target": _TARGET}),
     "description": "Map action: frame the selected field's own boundary. No coordinates are accepted."},
    {"name": "highlight_evidence", "strict": True, "input_schema": _schema({"target": _TARGET}),
     "description": "Map action: frame the selected field, the only geometry the evidence is tied to."},
    {"name": "set_date", "strict": True,
     "input_schema": _schema({"date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}}),
     "description": "Map action: set the chosen date (YYYY-MM-DD). The browser refuses dates outside the data."},
    {"name": "set_analysis_window", "strict": True,
     "input_schema": _schema({"days": {"type": "integer", "minimum": 1, "maximum": 366}}),
     "description": "Map action: ask for an analysis window length. The field numbers service only has 42 days; "
                    "other lengths are reported as unsupported."},
    {"name": "show_layer", "strict": True, "input_schema": _schema({"layer": {"type": "string", "enum": LAYER_IDS}}),
     "description": "Map action: turn on a NASA layer of the map catalog (smap-l4-surface soil moisture, imerg-daily "
                    "precipitation, lst-terra temperature, ndvi-8day vegetation, ...)."},
    {"name": "hide_layer", "strict": True, "input_schema": _schema({"layer": {"type": "string", "enum": LAYER_IDS}}),
     "description": "Map action: turn off a layer of the map catalog."},
    {"name": "query_field_metrics", "strict": True, "input_schema": _schema({"metrics": _METRICS}),
     "description": "Map action: show the field's indicators in the panel. Read the numbers yourself with the "
                    "data tools; this only asks the panel to display them."},
    {"name": "compare_metrics", "strict": True, "input_schema": _schema({"metrics": _METRICS}),
     "description": "Map action: show two of the field's variables side by side over the same window."},
]

MAP_TOOL_NAMES = frozenset(ARGUMENT_MODELS)


def accept(name: str, arguments: Any) -> tuple[MapAction | None, dict[str, Any]]:
    """Validates one call. Returns the action to send to the browser (or None) and the tool result for the model."""
    model = ARGUMENT_MODELS.get(name)
    if model is None or not isinstance(arguments, dict):
        return None, {"status": "rejected", "reason": "unknown_map_tool"}
    try:
        parsed = model.model_validate(arguments)
    except ValidationError:
        return None, {"status": "rejected", "reason": "invalid_arguments"}
    action = MapAction(tool=name, arguments=parsed.model_dump())  # type: ignore[arg-type]
    return action, {"status": "queued_for_browser", "tool": name,
                    "note": "The map runs this after your answer and shows the user each step's result. Say "
                            "what you asked the map to do; do not state that it happened or what the map shows."}


__all__ = ["MAP_TOOL_DEFINITIONS", "MAP_TOOL_NAMES", "MAX_MAP_ACTIONS", "MapAction", "accept"]
