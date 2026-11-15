"""Request and response contracts of `POST /experimental/field-shift-ai/chat`.

`Evidence` mirrors the frontend contract (src/lib/assistant/types.ts): the block 6 provenance row's own
value, unit, source, as_of, basis and resolution, plus the id an answer cites it by.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_QUESTION_CHARS = 500
MAX_RING_POINTS = 2000

Locale = Literal["en", "pt-BR"]
EvidenceBasis = Literal["observed", "retrieved", "modelled", "entered", "derived", "fixture"]

LIMITATION_CODES = (
    "coarse_cell",
    "modelled_not_measured",
    "evland_not_crop_demand",
    "palette_not_physical",
    "point_sample",
    "experimental_snapshot",
    "standard_kc",
    "climatic_difference_not_irrigation",
    "historical_not_forecast",
    "needs_sowing_date",
    "needs_farm_records",
    "comparator_not_built",
    "planting_calendar_not_integrated",
)


class ChatRequest(BaseModel):
    """Only the fields the agent needs. The ring and centroid are read for polygons only; a fixture
    field's geometry always comes from the server's own fixture file, never from the client."""

    model_config = ConfigDict(extra="forbid")

    field_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9:_\-]+$")
    locale: Locale
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    date: date
    ring: list[list[float]] | None = Field(default=None, max_length=MAX_RING_POINTS)
    centroid: list[float] | None = Field(default=None, min_length=2, max_length=2)
    area_ha: float | None = None


class Period(BaseModel):
    start: str
    end: str


class Evidence(BaseModel):
    id: str
    metric: str
    value: float | int | str | None
    unit: str | None
    decimals: int | None = None
    source: str
    asOf: str | None = None
    period: Period | None = None
    basis: EvidenceBasis
    sourceBasis: str | None = None
    resolution: str | None = None
    route: str
    limitations: list[str] = Field(default_factory=list)
    fieldId: str


class Segment(BaseModel):
    """One piece of an answer paragraph. `value` and `period` segments carry an evidence id; the
    frontend formats the value, unit and dates from the Evidence item, never from model text."""

    t: Literal["text", "value", "period"]
    text: str | None = None
    evidence: str | None = None


class ChatResponse(BaseModel):
    status: Literal["answered", "partial", "unavailable", "fallback"]
    locale: Locale
    field_id: str
    mode: Literal["agent", "fallback"]
    answer: list[list[Segment]] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    tools_used: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    fallback_reason: str | None = None
