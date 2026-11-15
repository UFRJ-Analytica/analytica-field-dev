"""Evidence Guard: the check every model answer passes before it reaches the frontend.

The model never writes a number. It writes `{{value:<id>}}` or `{{period:<id>}}` where a value or a
period goes, and lists the ids it cites. The guard:

1. parses the answer into segments (text, value, period) - structure first, not a regex over numbers;
2. accepts only ids that a tool registered in this run, for this field (`Evidence.fieldId`);
3. rejects any digit left in free text (a number the tools did not supply), outside a short list of
   instrument and method names such as `FAO-56` or `Sentinel-2`;
4. rejects recommendation, ranking, yield, irrigation-saving and forecast claims in either language;
5. checks the status: an answer that cites no evidence cannot be `answered`;
6. merges the limitation codes of every cited evidence item into the response.

The frontend then prints each value from the Evidence item (value, unit, decimals, locale), so the
number on screen is the tool's number, not the model's.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .schemas import LIMITATION_CODES, Evidence, Segment

MAX_PARAGRAPHS = 8
MAX_PARAGRAPH_CHARS = 700
MAX_CITED = 40
PLACEHOLDER = re.compile(r"\{\{\s*(value|period)\s*:\s*([A-Za-z0-9_.\-]+)\s*\}\}")
LOOSE_BRACES = re.compile(r"\{\{|\}\}")
# Names that carry digits but are not quantities.
NAMED_TOKENS = re.compile(
    r"FAO-?56|ET0|ETc|Sentinel-?2|SMAP\s?L3|T2M(?:_MAX|_MIN)?|B04|B08|MapBiomas\s+Collection\s+11|"
    r"Coleção\s+11|Collection\s+11|CDL|ZARC|PRECTOTCORR|GWETROOT|EVLAND|EVPTRNS",
    re.IGNORECASE,
)
# Affirmative claims the tools never support. A negated form ("I do not recommend") is also rejected:
# the safe failure is the deterministic fallback, not a borderline answer.
FORBIDDEN = [re.compile(p, re.IGNORECASE) for p in (
    r"\brecomend(o|amos|a-se|aria)\b", r"\b(i|we)\s+(would\s+)?recommend\b", r"\byou\s+should\s+(plant|grow|sow)\b",
    r"\bvoc[eê]\s+deve(ria)?\s+plantar\b", r"\bplante\b", r"\bthe\s+best\s+crop\s+is\b", r"\ba\s+melhor\s+cultura\s+[eé]\b",
    r"\bwill\s+(rain|be\s+(dry|wet|hot))\b", r"\b(vai|ir[aá])\s+chover\b", r"\bforecast(s|ed)?\s+(shows?|predicts?)\b",
    r"\bprevis[aã]o\s+(indica|mostra)\b", r"\byield(s)?\s+(of|will)\b", r"\bprodutividade\s+(de|ser[aá])\b",
    r"\b(save|saves|saving)\s+\w*\s*water\b", r"\beconomi[az]\w*\s+(de\s+)?[aá]gua\b",
)]


class GuardRejected(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class GuardResult:
    status: str
    answer: list[list[Segment]]
    evidence: list[Evidence]
    limitations: list[str] = field(default_factory=list)


def _segments(paragraph: str, known: dict[str, Evidence], field_id: str, cited: list[str]) -> list[Segment]:
    segments: list[Segment] = []
    cursor = 0
    for match in PLACEHOLDER.finditer(paragraph):
        _check_text(paragraph[cursor:match.start()])
        if match.start() > cursor:
            segments.append(Segment(t="text", text=paragraph[cursor:match.start()]))
        kind, evidence_id = match.group(1), match.group(2)
        item = known.get(evidence_id)
        if item is None:
            raise GuardRejected("unknown_evidence")
        if item.fieldId != field_id:
            raise GuardRejected("evidence_of_another_field")
        if kind == "period" and item.period is None and item.asOf is None:
            raise GuardRejected("evidence_has_no_period")
        segments.append(Segment(t=kind, evidence=evidence_id))
        if evidence_id not in cited:
            cited.append(evidence_id)
        cursor = match.end()
    _check_text(paragraph[cursor:])
    if cursor < len(paragraph):
        segments.append(Segment(t="text", text=paragraph[cursor:]))
    return segments


def _check_text(text: str) -> None:
    if LOOSE_BRACES.search(text):
        raise GuardRejected("malformed_placeholder")
    stripped = NAMED_TOKENS.sub(" ", text)
    if re.search(r"\d", stripped) or "%" in stripped:
        raise GuardRejected("unverified_number")
    for pattern in FORBIDDEN:
        if pattern.search(text):
            raise GuardRejected("unsupported_claim")


def validate(candidate: Any, known: dict[str, Evidence], field_id: str) -> GuardResult:
    """`candidate` is the model's `submit_answer` input. Raises GuardRejected with a code."""
    if not isinstance(candidate, dict):
        raise GuardRejected("not_an_object")
    status = candidate.get("status")
    paragraphs = candidate.get("paragraphs")
    listed = candidate.get("evidence_ids", [])
    codes = candidate.get("limitation_codes", [])
    if status not in ("answered", "partial", "unavailable"):
        raise GuardRejected("bad_status")
    if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= MAX_PARAGRAPHS:
        raise GuardRejected("bad_paragraphs")
    if not isinstance(listed, list) or not isinstance(codes, list) or len(listed) > MAX_CITED:
        raise GuardRejected("bad_lists")

    cited: list[str] = []
    answer: list[list[Segment]] = []
    for paragraph in paragraphs:
        if not isinstance(paragraph, str) or not paragraph.strip() or len(paragraph) > MAX_PARAGRAPH_CHARS:
            raise GuardRejected("bad_paragraph")
        answer.append(_segments(paragraph, known, field_id, cited))
    for evidence_id in listed:
        item = known.get(evidence_id) if isinstance(evidence_id, str) else None
        if item is None:
            raise GuardRejected("unknown_evidence")
        if item.fieldId != field_id:
            raise GuardRejected("evidence_of_another_field")
        if evidence_id not in cited:
            cited.append(evidence_id)
    unknown_codes = [c for c in codes if c not in LIMITATION_CODES]
    if unknown_codes:
        raise GuardRejected("unknown_limitation")

    evidence = [known[i] for i in cited]
    if status == "answered" and not evidence:
        status = "partial"
    limitations: list[str] = []
    for code in [*codes, *(c for item in evidence for c in item.limitations)]:
        if code not in limitations:
            limitations.append(code)
    return GuardResult(status=status, answer=answer, evidence=evidence, limitations=limitations)
