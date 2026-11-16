"""Field context: which field the question is about, and the block 6 request body for it.

The field id is checked with block 6's own resolver (`field_numbers.resolve_field`): `csb:` and
`trazo:` polygons, or an entry of the fixture file. A fixture field's ring and centre come from the
server's fixture file, so a client cannot ask about one field with another field's geometry.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

import field_numbers

from .schemas import ChatRequest

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "field-scenarios.json"


class AgentInputError(Exception):
    """A request the agent cannot answer for. `code` is safe to return; nothing internal leaks."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@lru_cache(maxsize=1)
def fixture_fields() -> tuple[dict[str, Any], ...]:
    with FIXTURE_PATH.open(encoding="utf-8") as handle:
        return tuple(json.load(handle)["fields"])


@dataclass(frozen=True)
class FieldContext:
    field_id: str
    kind: str  # "fixture" or "polygon"
    region: str | None
    name: str | None
    location: str | None
    center: tuple[float, float] | None
    chosen_date: date
    numbers_request: field_numbers.NumbersRequest


def resolve_context(request: ChatRequest) -> FieldContext:
    fields = list(fixture_fields())
    try:
        ref = field_numbers.resolve_field(request.field_id, fields)
    except field_numbers.NumbersError as error:
        raise AgentInputError("unknown_field" if error.status == 404 else "invalid_field") from error

    if ref.kind == "fixture":
        entry = next(item for item in fields if item.get("id") == request.field_id)
        ring = entry["boundary"]["coordinates"][0]
        center = (float(entry["center"][0]), float(entry["center"][1]))
        body = field_numbers.NumbersRequest(ring=ring, centroid=list(center), area_ha=None, date=request.date)
        return FieldContext(request.field_id, "fixture", ref.region, entry.get("name"), entry.get("location"),
                            center, request.date, body)

    if request.ring is None or request.centroid is None:
        raise AgentInputError("ring_missing")
    body = field_numbers.NumbersRequest(ring=request.ring, centroid=request.centroid, area_ha=request.area_ha,
                                        date=request.date)
    center = (float(request.centroid[0]), float(request.centroid[1]))
    return FieldContext(request.field_id, "polygon", ref.region, None, None, center, request.date, body)
