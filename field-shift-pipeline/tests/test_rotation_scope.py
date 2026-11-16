"""Only regions with configured rotations are scored."""

from __future__ import annotations

import pandas as pd
import pytest

from pipeline.common import PROCESSED_DIR, load_config, pilot_municipalities

SCORES = PROCESSED_DIR / "rotation_scores.parquet"


def test_every_configured_region_has_a_calendar():
    cfg = load_config("rotations.yaml")
    assert set(cfg["rotations"]) <= set(cfg["calendars"])


@pytest.mark.skipif(not SCORES.exists(), reason="run pipeline.build_scoring first")
def test_unconfigured_regions_are_not_scored():
    cfg = load_config("rotations.yaml")
    expected = {m["code"] for m in pilot_municipalities() if m["region_id"] in cfg["rotations"]}
    scored = set(pd.read_parquet(SCORES).code.unique())
    assert scored == expected
    assert 5107248 not in scored
