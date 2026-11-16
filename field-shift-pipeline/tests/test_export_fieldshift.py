"""HUD climate exporter: pure helpers, plus a check of the written fixtures when they exist."""

from __future__ import annotations

import json

import pandas as pd
import pytest

from pipeline import export_fieldshift as ex


def test_crop_year_label_uses_harvest_year():
    assert ex.crop_year_label(2027) == "2026/27"
    assert ex.crop_year_label(2000) == "1999/00"


def test_signed_keeps_sign_and_unit():
    assert ex.signed(-16.04, "%") == "-16.0%"
    assert ex.signed(4.5, "days") == "+4.5 days"


def test_pilot_boundary_is_a_closed_rectangle_centred_on_the_point():
    ring = ex.pilot_boundary(-46.0, -12.0)["coordinates"][0]
    assert ring[0] == ring[-1]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    assert max(xs) - min(xs) == pytest.approx(ex.PILOT_FIELD_WIDTH_DEG)
    assert max(ys) - min(ys) == pytest.approx(ex.PILOT_FIELD_HEIGHT_DEG)
    assert (max(xs) + min(xs)) / 2 == pytest.approx(-46.0)


FIXTURES = ex.DEFAULT_OUT
REGIONS = ex.ROOT / "data" / "processed" / "regions.parquet"


@pytest.mark.skipif(not (FIXTURES / "pilot-fields.json").exists() or not REGIONS.exists(),
                    reason="run the pipeline and the exporter first")
class TestWrittenFixtures:
    def test_every_file_is_dated_and_versioned(self):
        for path in FIXTURES.glob("*.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            assert data["contract_version"] == ex.CONTRACT_VERSION, path.name
            assert pd.Timestamp(data["recorded_at"]).tzinfo is not None, path.name

    def test_pilot_centres_equal_the_ibge_centroids(self):
        regions = pd.read_parquet(REGIONS).set_index("code")
        fields = json.loads((FIXTURES / "pilot-fields.json").read_text(encoding="utf-8"))["fields"]
        assert [f["id"] for f in fields] == ["rs-tupancireta-01", "ba-lem-01", "il-mclean-01", "tx-lubbock-01"]
        for f in fields:
            row = regions.loc[f["municipality_code"]]
            assert f["center"] == [round(row.centroid_lon, 6), round(row.centroid_lat, 6)]
            assert f["synthetic"] is True and f["coverage"] is None and f["scenarios"] == []

    def test_rows_follow_the_basis_rules(self):
        for path in FIXTURES.glob("municipality-*.json"):
            for row in json.loads(path.read_text(encoding="utf-8"))["rows"]:
                expected = "reported" if row["metric"] == "yield_anomaly_pct" else "modelled"
                assert row["basis"] == expected, (path.name, row["metric"])
                assert row["small_sample"] == (row["n_years"] is not None and row["n_years"] < ex.SMALL_SAMPLE_BELOW)
