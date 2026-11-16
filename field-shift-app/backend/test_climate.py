"""Pilot fields, coverage abstention and the climate fixtures."""

from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

import main
from main import app

FIXTURE_CLIMATE_DIR = Path(main.__file__).parent / "fixtures" / "climate"


def _read(name: str) -> dict:
    return json.loads((FIXTURE_CLIMATE_DIR / name).read_text(encoding="utf-8"))


class ClimateEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.original_dir = main.CLIMATE_DIR
        main.CLIMATE_DIR = FIXTURE_CLIMATE_DIR

    def tearDown(self):
        main.CLIMATE_DIR = self.original_dir

    def test_fields_lists_fixture_fields_then_pilot_fields(self):
        response = self.client.get("/fields")
        self.assertEqual(response.status_code, 200)
        fields = response.json()["fields"]
        # The fixture fields this app keeps, then the two United States pilots. The Brazilian
        # pilot fields 04 and 05 are not in this app's export.
        self.assertEqual(
            [field["id"] for field in fields],
            ["mt-santa-carmem-01", "mt-santa-carmem-02", "mt-santa-carmem-03",
             "381825001868504", "381825001868512", "381825001868517",
             "il-mclean-01", "tx-lubbock-01"],
        )
        for field in fields[3:6]:  # Cass County, North Dakota: no climate pilot yet
            self.assertIsNone(field["municipality_code"])
            self.assertFalse(field["synthetic"])
        for field in fields[-2:]:
            self.assertTrue(field["synthetic"])
            self.assertIsNone(field["coverage"])
            self.assertNotIn("scenarios", field)

    def test_field_without_coverage_abstains_with_empty_list(self):
        body = self.client.get("/fields/il-mclean-01/scenarios").json()
        self.assertEqual(body["state"], "abstained")
        self.assertEqual(body["threshold"], "coverage_not_measured")
        self.assertEqual(body["scenarios"], [])
        self.assertIsNone(body["coverage"])

    def test_existing_fields_keep_their_abstention_rule(self):
        self.assertEqual(self.client.get("/fields/mt-santa-carmem-01/scenarios").json()["state"], "ranked")
        self.assertEqual(self.client.get("/fields/mt-santa-carmem-03/scenarios").json()["threshold"], "coverage_below_80_percent")

    def test_enso_endpoint_serves_the_fixture_unchanged(self):
        body = self.client.get("/climate/enso").json()
        fixture = _read("enso.json")
        self.assertEqual(body, fixture)
        for key in ("recorded_at", "discussion", "roni", "oni", "outlook"):
            self.assertIn(key, body)
        for key in ("issued", "alert_status", "source_url"):
            self.assertIn(key, body["discussion"])
        for key in ("season", "value", "phase", "strength"):
            self.assertIn(key, body["roni"])

    def test_field_climate_matches_its_municipality_file(self):
        body = self.client.get("/fields/il-mclean-01/climate").json()
        fixture = _read("municipality-17113.json")
        self.assertEqual(body["state"], "available")
        self.assertEqual(body["season_progress"], fixture["season_progress"])
        self.assertEqual(body["rows"], fixture["rows"])
        for key in ("rain_mm", "normal_mm", "analog_mm", "last_observed", "n_analog", "analog_years"):
            self.assertIn(key, body["season_progress"])

    def test_a_fixture_field_without_a_municipality_answers_not_available(self):
        # The fixture fields have no municipality code in this app, so their climate is reported
        # as not available rather than served from a municipality the app does not mount.
        body = self.client.get("/fields/mt-santa-carmem-01/climate").json()
        self.assertEqual(body["state"], "not_available")
        self.assertIsNone(body["municipality"])
        self.assertEqual(body["rows"], [])

    def test_unknown_field_climate_is_404(self):
        self.assertEqual(self.client.get("/fields/nope/climate").status_code, 404)

    def test_missing_enso_file_is_503_and_fields_still_answer(self):
        with TemporaryDirectory() as directory:
            for path in FIXTURE_CLIMATE_DIR.glob("*.json"):
                if path.name != "enso.json":
                    shutil.copy(path, directory)
            main.CLIMATE_DIR = Path(directory)
            response = self.client.get("/climate/enso")
            self.assertEqual(response.status_code, 503)
            self.assertIn("enso.json", response.json()["detail"])
            self.assertEqual(self.client.get("/fields").status_code, 200)

    def test_rows_carry_seven_fields_and_basis_rules(self):
        for path in FIXTURE_CLIMATE_DIR.glob("municipality-*.json"):
            for row in json.loads(path.read_text(encoding="utf-8"))["rows"]:
                for key in ("layer", "value", "basis", "as_of", "source", "support", "n_years"):
                    self.assertIn(key, row, f"{path.name} {row.get('metric')}")
                expected = "reported" if row["metric"] == "yield_anomaly_pct" else "modelled"
                self.assertEqual(row["basis"], expected)
                if row["n_years"] is not None and row["n_years"] < 3:
                    self.assertTrue(row["small_sample"])
        self.assertEqual(_read("enso.json")["basis"], "reported")


if __name__ == "__main__":
    unittest.main()
