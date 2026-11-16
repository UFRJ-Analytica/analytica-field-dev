"""Table E keys of the numbers payload that the block 6 surface prints (t_4b5447cf).

Two facts Table E requires and the route did not send:

- the climate section's `resolution` (Table E, climate row; R-10 wants it printed in the card header).
  `_climate` set it and then overwrote it with `_section_base`'s default `None`;
- the `d_factor` of each SoilGrids property (Table E, soil row; R-31 divides by the factor returned in
  the same response, AC-30 counts the four factors). `sources/soilgrids.py` parsed and applied it but
  the section never exposed it.

The tests live in their own module because a sibling card edits `test_field_numbers_route.py` at the
same time. They run against the recorded transport and a temporary cache, like that module does.
"""

from __future__ import annotations

import os
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import field_numbers
import main
from block6_replay import ARTIFACTS, ReplayTransport, ring_with_area_ha
from sources import soilgrids

RING = ring_with_area_ha(22.4)
BODY = {"ring": RING, "centroid": [-55.27, -11.91], "area_ha": 22.4, "date": "2026-11-12"}
FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
SOIL_ARTIFACT = ARTIFACTS / "soilgrids-55.27--11.91.json"

# Table E, climate row: the section carries these keys in every state.
TABLE_E_CLIMATE_KEYS = {"series", "aggregates", "normals", "window", "source", "basis", "resolution", "as_of",
                        "fetched_at", "cached"}
NORMALS_KEYS = {"of_years", "excluded_years"}


class TableECase(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)
        self.cache_dir = TemporaryDirectory()
        self.mapbiomas = TemporaryDirectory()
        self.transport = ReplayTransport()
        self.patches = [
            patch.object(field_numbers, "CACHE_DIR", Path(self.cache_dir.name)),
            patch.object(field_numbers, "clock", lambda: FROZEN_NOW),
            patch.object(field_numbers, "MAPBIOMAS_DB", Path(self.mapbiomas.name) / "polygon-mapbiomas.sqlite"),
            patch.object(field_numbers, "transport", self.transport),
            # The limiter is per client address and every case here posts from the same one, so the
            # suite turns it off rather than tripping it; the limiter has its own tests.
            patch.dict(os.environ, {"NUMBERS_RATE_LIMIT_REQUESTS": "0"}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()
        self.cache_dir.cleanup()
        self.mapbiomas.cleanup()

    def payload(self) -> dict:
        response = self.client.post("/fields/mt-santa-carmem-01/numbers", json=BODY)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


class ClimateResolutionTests(TableECase):
    """Table E climate row and R-10: the section carries the resolution of its own cells."""

    def test_table_e_the_climate_section_carries_the_resolution_of_its_cell(self) -> None:
        climate = self.payload()["sections"]["climate"]
        self.assertEqual(climate["state"], "ok")
        self.assertEqual(climate["resolution"], "0.5 degree cell")

    def test_r10_the_section_resolution_is_the_one_every_climate_row_prints(self) -> None:
        payload = self.payload()
        climate = payload["sections"]["climate"]
        rows = [row for row in payload["provenance"] if row["metric"] in field_numbers.ALL_CLIMATE_METRICS]
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(row["resolution"], "0.5 degree cell", row["metric"])
        self.assertEqual(climate["resolution"], rows[0]["resolution"])

    def test_table_e_the_resolution_survives_a_power_failure(self) -> None:
        self.transport.offline_hosts = ("power.larc",)
        climate = self.payload()["sections"]["climate"]
        self.assertEqual(climate["state"], "unavailable")
        self.assertEqual(climate["resolution"], "0.5 degree cell")


class SoilDFactorTests(TableECase):
    """Table E soil row, R-31 and AC-30, O-06: one `d_factor` per property, the one that was applied."""

    def test_table_e_the_soil_section_carries_the_four_d_factors(self) -> None:
        soil = self.payload()["sections"]["soil"]
        self.assertEqual(soil["state"], "ok")
        self.assertEqual(soil["d_factor"], {"clay": 10, "sand": 10, "phh2o": 10, "soc": 10})

    def test_r31_each_d_factor_is_the_one_the_response_declared(self) -> None:
        soil = self.payload()["sections"]["soil"]
        observed = soilgrids.parse(json.loads(SOIL_ARTIFACT.read_text(encoding="utf-8")))
        for name in soilgrids.PROPERTIES:
            declared = {observed[(name, depth)]["d_factor"] for depth in soilgrids.DEPTHS}
            self.assertEqual(len(declared), 1, name)
            self.assertEqual(soil["d_factor"][name], declared.pop(), name)

    def test_table_e_the_d_factor_key_is_present_with_no_factor_when_the_source_is_down(self) -> None:
        self.transport.status_overrides = {"rest.isric.org": 503}
        soil = self.payload()["sections"]["soil"]
        self.assertEqual(soil["state"], "unavailable")
        self.assertEqual(soil["d_factor"], {"clay": None, "sand": None, "phh2o": None, "soc": None})


class ClimateNormalsTests(TableECase):
    """Table E climate row and R-12: `normals` is present in every state, with a printable reason."""

    def assert_table_e_climate(self, climate: dict, state: str) -> dict:
        self.assertEqual(climate["state"], state)
        missing = TABLE_E_CLIMATE_KEYS - set(climate)
        self.assertEqual(missing, set(), f"Table E climate keys missing in state {state}")
        normals = climate["normals"]
        self.assertTrue(NORMALS_KEYS <= set(normals), f"normals facts missing in state {state}: {normals}")
        return normals

    def test_table_e_the_ok_state_carries_the_normals_family(self) -> None:
        normals = self.assert_table_e_climate(self.payload()["sections"]["climate"], "ok")
        self.assertGreater(normals["of_years"], 0)
        self.assertNotIn("error", normals)

    def test_table_e_power_unavailable_carries_normals_with_the_section_reason(self) -> None:
        self.transport.offline_hosts = ("power.larc",)
        climate = self.payload()["sections"]["climate"]
        normals = self.assert_table_e_climate(climate, "unavailable")
        self.assertEqual(normals["of_years"], 0)
        self.assertEqual(normals["excluded_years"], [])
        self.assertEqual(normals["error"], climate["error"])

    def test_table_e_a_malformed_power_body_carries_normals_with_its_reason(self) -> None:
        # A body without `properties.parameter`: `power.parse` raises KeyError, the malformed branch.
        with patch.object(self.transport, "_power",
                          return_value={"header": {"fill_value": -999.0}, "properties": {}}):
            climate = self.payload()["sections"]["climate"]
        normals = self.assert_table_e_climate(climate, "unavailable")
        self.assertEqual(normals["of_years"], 0)
        self.assertEqual(normals["error"], "malformed POWER response")

    def test_r12_no_valid_rain_day_still_carries_normals_with_its_reason(self) -> None:
        # Drop every PRECTOTCORR day: `resolve_window` finds no valid day in the 120 day lookback.
        self.transport.power["PRECTOTCORR"] = {}
        climate = self.payload()["sections"]["climate"]
        normals = self.assert_table_e_climate(climate, "abstained")
        self.assertEqual(normals["of_years"], 0)
        self.assertEqual(normals["excluded_years"], [])
        self.assertIn("no consolidated PRECTOTCORR day", normals["error"])


if __name__ == "__main__":
    unittest.main()
