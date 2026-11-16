from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from main import app

APP_DIR = Path(__file__).resolve().parents[1]
MANIFEST = APP_DIR / "data" / "polygons" / "us-38017.manifest.json"


class PolygonModeTests(unittest.TestCase):
    """R-09, AC-07: one hosting mode per region, read once, and no tile read here."""

    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_us_mode_is_self_hosted_and_carries_the_manifest_zoom_values(self) -> None:
        response = self.client.get("/polygons/mode", params={"region": "us"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(body["region"], "us")
        self.assertEqual(body["mode"], "self-hosted")
        self.assertIsNone(body["classProperty"])
        self.assertEqual(body["class_year_range"], [2018, 2025])
        self.assertEqual(body["class_property_pattern"], "cdl{year}")
        for key in (
            "detail_minzoom",
            "detail_maxzoom",
            "overview_minzoom",
            "overview_maxzoom",
            "interactive_minzoom",
        ):
            self.assertEqual(body[key], manifest[key], key)
        self.assertEqual(body["detail_file"], "/data/polygons/us-38017-detail.pmtiles")
        self.assertEqual(body["overview_file"], "/data/polygons/us-38017-overview.pmtiles")
        # R-09: the Feature Service is a build input, never a render path.
        self.assertNotIn("scinet", json.dumps(body))

    def test_us_mode_fails_rather_than_default_when_the_manifest_is_absent(self) -> None:
        with TemporaryDirectory() as empty:
            with patch.object(main, "POLYGON_DIR", Path(empty)):
                response = self.client.get("/polygons/mode", params={"region": "us"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("us-38017.manifest.json", response.json()["detail"])

    def test_us_mode_refuses_a_manifest_that_breaks_its_own_rule(self) -> None:
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
            manifest["interactive_minzoom"] = 9
            (directory / "us-38017.manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with patch.object(main, "POLYGON_DIR", directory):
                response = self.client.get("/polygons/mode", params={"region": "us"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("interactive_minzoom", response.json()["detail"])

    def test_an_unknown_region_is_rejected(self) -> None:
        response = self.client.get("/polygons/mode", params={"region": "fr"})
        self.assertEqual(response.status_code, 422)

    def test_the_guard_names_the_fixture_field_and_the_two_polygon_forms(self) -> None:
        entry = next(item for item in main.COMMANDS if item["name"] == "select_field")
        self.assertEqual(
            entry["guard"],
            "field_id must identify a fixture field, a trazo: polygon id or a csb: field id",
        )

    def test_the_validator_accepts_a_polygon_id(self) -> None:
        client = TestClient(app)
        for field_id in ("csb:381825001868504", "trazo:12345"):
            response = client.post("/commands/select_field", json={"field_id": field_id})
            self.assertEqual(response.status_code, 200, field_id)
            self.assertEqual(response.json()["arguments"]["field_id"], field_id)


if __name__ == "__main__":
    unittest.main()
