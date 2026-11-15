"""Record `src/test/numbers-recorded.json` from the real numbers pipeline (block 6 contract repair).

The frontend suite reads exactly one numbers payload, and that payload has to be one the backend
can produce. This script runs the shipped `build_numbers` over the recorded block 6 transport
(`backend/block6_replay.py`) with the clock frozen, and writes the response it returns.

Three inputs are pinned so the bytes are the same on any checkout:

- the request is the one the surface sends for the Brazil fixture field: its own `boundary` ring
  from `backend/fixtures/field-scenarios.json`, its `center`, `area_ha` null, and the chosen date
  `2026-11-12` (Table B of the block 6 spec);
- the clock is frozen at `2026-11-15T03:00:00Z`, so every `fetched_at` and every `cached` flag is
  the first read of the recorded responses;
- `POLYGON_MAPBIOMAS_DB` is the documented default path relative to the app root, which is absent
  in this repository, so the rotation section records `file absent`. An absolute path would put a
  machine specific path inside a committed fixture.

Usage, from `field-shift-app/`:

    python3 scripts/record_numbers_fixture.py           # rewrite the fixture
    python3 scripts/record_numbers_fixture.py --check   # fail if the committed fixture differs
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

APP_ROOT = Path(__file__).resolve().parents[1]
BACKEND = APP_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import field_numbers  # noqa: E402  (the path above is the import contract of the backend suite)
from block6_replay import ReplayTransport  # noqa: E402

CHOSEN_DATE = "2026-11-12"
FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
SIDECAR = Path("data/polygons/polygon-mapbiomas.sqlite")
FIXTURE = APP_ROOT / "src" / "test" / "numbers-recorded.json"


def _fixture_fields() -> list[dict]:
    fixture = json.loads((BACKEND / "fixtures" / "field-scenarios.json").read_text(encoding="utf-8"))
    return fixture["fields"]


def record() -> dict:
    """The route's payload for the Brazil fixture field, unmodified."""
    fields = _fixture_fields()
    field = next(entry for entry in fields if entry["id"] == "mt-santa-carmem-01")
    if SIDECAR.is_file():
        raise SystemExit(
            f"{SIDECAR} now exists: the recorded rotation section would change. Record again from a "
            "checkout without the sidecar, or pin the sidecar fixture on purpose."
        )
    body = field_numbers.NumbersRequest(
        ring=field["boundary"]["coordinates"][0],
        centroid=field["center"],
        area_ha=None,
        date=CHOSEN_DATE,
    )
    with TemporaryDirectory() as cache:
        with patch.object(field_numbers, "CACHE_DIR", Path(cache)), patch.object(
            field_numbers, "clock", lambda: FROZEN_NOW
        ), patch.object(field_numbers, "MAPBIOMAS_DB", SIDECAR), patch.object(
            field_numbers, "transport", ReplayTransport()
        ):
            return field_numbers.build_numbers(field["id"], body, fixture_fields=fields)


def main(argv: list[str]) -> int:
    payload = record()
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if "--check" in argv:
        committed = FIXTURE.read_text(encoding="utf-8") if FIXTURE.is_file() else ""
        if committed != text:
            print(f"MISMATCH: {FIXTURE} is not the payload the backend produces")
            return 1
        print(f"MATCH: {FIXTURE} is byte for byte the recorded response")
        return 0
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(text, encoding="utf-8")
    sections = payload["sections"]
    print(f"wrote {FIXTURE} ({len(text)} bytes)")
    print(f"field {payload['field_id']} region {payload['region']} state of each section:")
    for name in ("climate", "water_balance", "smap", "ndvi", "soil", "rotation", "municipality", "fragment"):
        print(f"  {name}: {sections[name]['state']}")
    print(f"provenance rows {len(payload['provenance'])}, gaps {len(payload['gaps'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
