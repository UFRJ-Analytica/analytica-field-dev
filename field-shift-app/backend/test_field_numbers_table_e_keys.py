"""Table E keys of the numbers payload that had no producer (t_c9ad213a).

Three keys Table E requires and the route did not send, plus the two scene pixel keys the shipped
TypeScript type already declared:

- `ndvi.assets` (Table E, ndvi row; Table F route 2 and AC-29 name the three assets): read from the
  STAC scene assets the search already returns, never written here by hand.
- `ndvi.best_valid_fraction` (R-29 and AC-28 name the best valid fraction): null until the cloud
  optimised GeoTIFF reader of OD-01 exists, with a reason that names the missing producer.
- `municipality.state` (Table E, municipality row; R-37, R-38, AC-36, AC-37): the SIDRA `N3` state
  row, labelled as a state total that is not this field, printed while the municipal row abstains
  because the IBGE municipal join (CO-B6-06) is not built.
- `ndvi.scenes[].kept_pixels` and `ndvi.scenes[].polygon_pixels`: required by Table E's scenes array
  and by `NdviScene` in `src/lib/numbers.ts`, and absent from every scene entry.

The tests live in their own module, like `test_field_numbers_table_e.py`, because sibling cards
edit `test_field_numbers_route.py` and the recorded fixture at the same time.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import unquote

from fastapi.testclient import TestClient

import field_numbers
import main
from block6_replay import ARTIFACTS, ReplayTransport, ring_with_area_ha
from sources import sentinel2, sidra

RING = ring_with_area_ha(22.4)
BODY = {"ring": RING, "centroid": [-55.27, -11.91], "area_ha": 22.4, "date": "2026-11-12"}
FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
STAC_ARTIFACT = ARTIFACTS / "earth-search-2026-10-01-2026-11-11-ring.json"


class TableEKeysCase(unittest.TestCase):
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
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()
        self.cache_dir.cleanup()
        self.mapbiomas.cleanup()

    def payload(self, field_id: str = "mt-santa-carmem-01") -> dict:
        response = self.client.post(f"/fields/{field_id}/numbers", json=BODY)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def requested_hosts(self) -> list[str]:
        return [url for _, url, _ in self.transport.requests]


class NdviAssetsTests(TableEKeysCase):
    """Table E ndvi row, Table F route 2 and AC-29: the three asset roles the section reads."""

    def test_table_e_the_ndvi_section_carries_the_three_asset_roles(self) -> None:
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertEqual(ndvi["state"], "abstained")
        self.assertEqual(ndvi["assets"], ["B04", "B08", "SCL"])

    def test_the_assets_are_read_from_the_recorded_search_not_written_here(self) -> None:
        search = json.loads(STAC_ARTIFACT.read_text(encoding="utf-8"))
        # The label is the asset's own file stem: the search names the red, nir and scl assets and
        # each href ends in B04.tif, B08.tif and SCL.tif (O-10). The scl asset carries no `eo:bands`,
        # so the band name alone cannot label it.
        expected = sorted(
            {
                feature["assets"][key]["href"].rsplit("/", 1)[-1].rsplit(".", 1)[0]
                for feature in search["features"]
                for key in ("red", "nir", "scl")
                if feature["assets"].get(key, {}).get("href")
            }
        )
        self.assertEqual(expected, ["B04", "B08", "SCL"])
        self.assertEqual(self.payload()["sections"]["ndvi"]["assets"], expected)

    def test_table_e_the_key_is_present_when_the_search_fails(self) -> None:
        self.transport.status_overrides = {"earth-search": 503}
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertEqual(ndvi["state"], "unavailable")
        self.assertEqual(ndvi["assets"], [])

    def test_the_search_now_records_which_assets_each_scene_carries(self) -> None:
        search = json.loads(STAC_ARTIFACT.read_text(encoding="utf-8"))
        scenes = sentinel2.parse_scenes(search)
        self.assertEqual(len(scenes), 13)
        for scene in scenes:
            self.assertEqual(sorted(scene["assets"]), ["B04", "B08", "SCL"], scene["id"])
            self.assertTrue(scene["assets"]["B04"].endswith("/B04.tif"), scene["id"])
            self.assertTrue(scene["assets"]["SCL"].endswith("/SCL.tif"), scene["id"])


class NdviBestFractionTests(TableEKeysCase):
    """R-29 and AC-28: the best valid fraction, or an explicit null naming OD-01."""

    def test_table_e_the_key_is_present_and_null_with_the_named_reason(self) -> None:
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertIn("best_valid_fraction", ndvi)
        self.assertIsNone(ndvi["best_valid_fraction"])
        self.assertIn("OD-01", ndvi["best_valid_fraction_reason"])
        self.assertIn("not", ndvi["best_valid_fraction_reason"])

    def test_no_fraction_is_fabricated_for_a_scene(self) -> None:
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertTrue(ndvi["scenes"])
        for scene in ndvi["scenes"]:
            self.assertIsNone(scene["valid_fraction"], scene["id"])

    def test_the_reason_differs_when_there_was_no_search_window(self) -> None:
        self.transport.offline_hosts = ("power.larc",)
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertEqual(ndvi["state"], "unavailable")
        self.assertIsNone(ndvi["best_valid_fraction"])
        self.assertIn("window", ndvi["best_valid_fraction_reason"])


class NdviScenePixelKeysTests(TableEKeysCase):
    """Table E scenes array and `NdviScene`: kept and polygon pixel counts on every scene."""

    def test_table_e_each_scene_carries_the_two_pixel_counts(self) -> None:
        ndvi = self.payload()["sections"]["ndvi"]
        self.assertTrue(ndvi["scenes"])
        for scene in ndvi["scenes"]:
            self.assertIn("kept_pixels", scene, scene["id"])
            self.assertIn("polygon_pixels", scene, scene["id"])
            self.assertIsNone(scene["kept_pixels"])
            self.assertIsNone(scene["polygon_pixels"])


class MunicipalityStateRowTests(TableEKeysCase):
    """Table E municipality row, R-37, R-38, AC-36 and AC-37, oracles O-07 and O-08."""

    def test_ac37_the_state_row_prints_while_the_municipality_abstains(self) -> None:
        municipal = self.payload()["sections"]["municipality"]
        self.assertIsNone(municipal["municipality"])
        self.assertEqual(municipal["state"], "abstained")
        self.assertIsNotNone(municipal["state_row"])
        self.assertEqual(municipal["state_row"]["code"], "51")
        self.assertEqual(municipal["state_row"]["name"], "Mato Grosso")
        self.assertEqual(municipal["state_row"]["year"], 2025)
        self.assertEqual(municipal["state_row"]["soy_ha"], 12788611)
        self.assertEqual(municipal["state_row"]["label"], "state total, not this field")

    def test_ac37_the_municipal_row_and_the_share_still_abstain_with_a_named_reason(self) -> None:
        payload = self.payload()
        municipal = payload["sections"]["municipality"]
        self.assertIsNone(municipal["share"])
        self.assertIn("municipality code", municipal["reason"])
        causes = " ".join(g["cause"] + " " + g["remediation"] for g in payload["gaps"]
                          if g["section"] == "municipality")
        self.assertIn("CO-B6-06", causes)

    def test_ac36_the_state_row_matches_oracle_o07_and_its_own_year(self) -> None:
        payload = self.payload()
        rows = {row["metric"]: row for row in payload["provenance"]}
        self.assertEqual(rows["state_soy_ha"]["value"], 12788611)
        self.assertEqual(rows["state_soy_ha"]["as_of"], "2025-12-31")
        self.assertEqual(rows["state_soy_ha"]["basis"], "retrieved")
        self.assertEqual(rows["state_soy_ha"]["resolution"], "the state")
        self.assertIsNone(rows["municipality_soy_ha"]["value"])
        self.assertIsNone(rows["polygon_share"]["value"])

    def test_r37_the_state_row_is_read_from_the_n3_sidra_call(self) -> None:
        self.payload()
        calls = [unquote(url) for url in self.requested_hosts() if "servicodados.ibge.gov.br" in url]
        self.assertTrue(calls)
        self.assertEqual(len(calls), 1)
        self.assertIn("localidades=N3[51]", calls[0])
        self.assertNotIn("5107248", calls[0])

    def test_ac37_the_state_row_is_unavailable_when_sidra_is_down(self) -> None:
        self.transport.status_overrides = {"servicodados.ibge.gov.br": 503}
        payload = self.payload()
        municipal = payload["sections"]["municipality"]
        self.assertEqual(municipal["state"], "unavailable")
        self.assertIn("503", municipal["error"])
        self.assertIsNone(municipal["state_row"])
        self.assertTrue(any(g["section"] == "municipality" for g in payload["gaps"]))

    def test_r38_a_missing_year_moves_the_row_to_the_newest_year_with_a_value(self) -> None:
        state = json.loads((ARTIFACTS / "sidra-n3-51.json").read_text(encoding="utf-8"))
        state[0]["resultados"][0]["series"][0]["serie"]["2025"] = "..."
        self.transport.sidra_state = state
        payload = self.payload()
        municipal = payload["sections"]["municipality"]
        self.assertEqual(municipal["state_row"]["year"], 2024)
        self.assertEqual(municipal["state_row"]["soy_ha"], 12383077)
        self.assertEqual(municipal["as_of"], "2024-12-31")
        self.assertTrue(any("2025" in g["cause"] for g in payload["gaps"] if g["section"] == "municipality"))

    def test_a_field_without_a_state_code_abstains_the_row_and_makes_no_ibge_call(self) -> None:
        payload = self.payload("trazo:12345")
        municipal = payload["sections"]["municipality"]
        self.assertIsNone(municipal["state_row"])
        self.assertIn("state code", municipal["state_reason"])
        self.assertFalse([url for url in self.requested_hosts() if "servicodados.ibge.gov.br" in url])

    def test_a_united_states_field_abstains_the_state_row_naming_the_region(self) -> None:
        payload = self.payload("381825001868504")
        municipal = payload["sections"]["municipality"]
        self.assertEqual(payload["region"], "us")
        self.assertIsNone(municipal["state_row"])
        self.assertIn("United States", municipal["state_reason"])
        self.assertFalse([url for url in self.requested_hosts() if "servicodados.ibge.gov.br" in url])


class SidraStateCodeTests(unittest.TestCase):
    """The UF read block 4 R-31 documents for the Brazil fixtures, and the IBGE code table."""

    def test_the_fixture_location_text_gives_the_mato_grosso_code(self) -> None:
        self.assertEqual(sidra.state_code("Santa Carmem, Mato Grosso"), "51")

    def test_a_sigla_after_the_comma_is_read_too(self) -> None:
        self.assertEqual(sidra.state_code("Santa Carmem, MT"), "51")

    def test_a_text_without_a_known_state_is_unresolved_not_guessed(self) -> None:
        self.assertIsNone(sidra.state_code("Cass County, North Dakota"))
        self.assertIsNone(sidra.state_code("Santa Carmem"))
        self.assertIsNone(sidra.state_code(None))

    def test_the_table_is_the_ibge_unidade_da_federacao_code_table(self) -> None:
        self.assertEqual(len(sidra.STATE_CODES), 27)
        self.assertEqual(sidra.STATE_CODES["SP"], "35")
        self.assertEqual(sidra.STATE_CODES["DF"], "53")
        self.assertEqual(sidra.STATE_CODES["TO"], "17")


if __name__ == "__main__":
    unittest.main()
