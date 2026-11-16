from __future__ import annotations

import json
import re
import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import main
from main import app

APP_DIR = Path(__file__).resolve().parents[1]
ARTIFACTS = APP_DIR / "artifacts"
RECORDED = json.loads((ARTIFACTS / "fixtures" / "tiles-recorded-2026-11-14.json").read_text(encoding="utf-8"))
IDENTIFIERS = (ARTIFACTS / "gibs-identifiers-2026-11-14.txt").read_text(encoding="utf-8").splitlines()
CAPABILITIES = json.loads((ARTIFACTS / "gibs-capabilities-extract-2026-11-14.json").read_text(encoding="utf-8"))

TABLE_A = {
    "smap-l3": ("SMAP_L3_Passive_Enhanced_Day_Soil_Moisture", "GoogleMapsCompatible_Level6", 6, "retrieved", "9 km", False),
    "smap-l4-surface": ("SMAP_L4_Analyzed_Surface_Soil_Moisture", "GoogleMapsCompatible_Level6", 6, "modelled", "9 km", False),
    "smap-l4-root": ("SMAP_L4_Analyzed_Root_Zone_Soil_Moisture", "GoogleMapsCompatible_Level6", 6, "modelled", "9 km", False),
    "imerg-daily": ("IMERG_Precipitation_Rate", "GoogleMapsCompatible_Level6", 6, "retrieved", "about 11 km", False),
    "imerg-30min": ("IMERG_Precipitation_Rate_30min", "GoogleMapsCompatible_Level6", 6, "retrieved", "about 11 km", False),
    "ndvi-8day": ("MODIS_Terra_NDVI_8Day", "GoogleMapsCompatible_Level9", 9, "retrieved", "250 m", False),
    "evi-8day": ("MODIS_Terra_EVI_8Day", "GoogleMapsCompatible_Level9", 9, "retrieved", "250 m", False),
    "ndvi-monthly": ("MODIS_Terra_L3_NDVI_Monthly", "GoogleMapsCompatible_Level7", 7, "retrieved", "1 km", False),
    "lst-terra": ("MODIS_Terra_L3_Land_Surface_Temp_Daily_Day", "GoogleMapsCompatible_Level7", 7, "retrieved", "1 km", False),
    "lst-aqua": ("MODIS_Aqua_Land_Surface_Temp_Day", "GoogleMapsCompatible_Level7", 7, "retrieved", "1 km", False),
    "hls-l30": ("HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "GoogleMapsCompatible_Level12", 12, "retrieved", "30 m", True),
    "hls-s30": ("HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "GoogleMapsCompatible_Level12", 12, "retrieved", "30 m", True),
    "grace-mascon": ("GRACE_Tellus_Liquid_Water_Equivalent_Thickness_Mascon_CRI", "GoogleMapsCompatible_Level6", 6, "retrieved", "about 300 km, mascon", False),
}

# Listed in the registry, left out of /layers (block 12): patchy coverage on any one date.
HIDDEN = {"smap-l3", "hls-l30", "hls-s30"}

TABLE_B = {
    "smap-l3": ("tile", "P1D", "2015-03-31", "2026-11-11", 1),
    "smap-l4-surface": ("tile", "P1D", "2015-03-31", "2026-11-10", 1),
    "smap-l4-root": ("tile", "P1D", "2015-03-31", "2026-11-10", 1),
    "imerg-daily": ("tile", "P1D", "2000-06-01", "2026-11-13", 1),
    "imerg-30min": ("tile", "PT30M", "2026-01-19T20:30:00Z", "2026-11-14T12:30:00Z", 0.02),
    "ndvi-8day": ("tile", "P1D", "2025-02-12", "2026-11-13", 8),
    "evi-8day": ("tile", "P1D", "2025-02-12", "2026-11-13", 8),
    "ndvi-monthly": ("tile", "P1M", "2000-03-01", "2026-10-01", 31),
    "lst-terra": ("tile", "P1D", "2000-02-25", "2026-11-13", 1),
    "lst-aqua": ("tile", "P1D", "2002-07-03", "2026-11-14", 1),
    "hls-l30": ("tile", "P1D", "2013-03-22", "2026-11-06", 1),
    "hls-s30": ("tile", "P1D", "2015-11-28", "2026-11-06", 1),
    "grace-mascon": ("stale", "mixed P28D, P17D, P1M", "2002-04-04", "2022-07-01", None),
}

TABLE_C = {
    "smap-l3": (7, "date", "backend/reserve/smap-soil-moisture.png"),
    "smap-l4-surface": (7, "date", None),
    "smap-l4-root": (7, "date", None),
    "imerg-daily": (7, "date", None),
    "imerg-30min": (1, "datetime", None),
    "ndvi-8day": (16, "date", None),
    "evi-8day": (16, "date", None),
    "ndvi-monthly": (62, "date", None),
    "lst-terra": (7, "date", None),
    "lst-aqua": (7, "date", None),
    "hls-l30": (30, "date", None),
    "hls-s30": (30, "date", None),
    "grace-mascon": (None, "date", None),
}

LABELS = {
    "smap-l3": "SMAP soil moisture",
    "smap-l4-surface": "SMAP L4 surface soil moisture",
    "smap-l4-root": "SMAP L4 root-zone soil moisture",
    "imerg-daily": "IMERG precipitation, daily",
    "imerg-30min": "IMERG precipitation, 30 minutes",
    "ndvi-8day": "MODIS NDVI, 8 day",
    "evi-8day": "MODIS EVI, 8 day",
    "ndvi-monthly": "MODIS NDVI, monthly",
    "lst-terra": "MODIS land surface temperature, Terra",
    "lst-aqua": "MODIS land surface temperature, Aqua",
    "hls-l30": "HLS Landsat reflectance, 30 m",
    "hls-s30": "HLS Sentinel-2 reflectance, 30 m",
    "grace-mascon": "GRACE water storage, stale",
}


def tile_url(row: dict) -> str:
    return (
        f"{main.GIBS_BASE_URL}/{row['gibs_id']}/default/{row['date']}/{row['matrix']}"
        f"/{row['z']}/{row['y']}/{row['x']}{row['suffix']}"
    )


class RecordedTransport:
    """Replays the recorded tile responses and records every URL requested."""

    def __init__(self, responses: dict[str, httpx.Response] | None = None):
        self.responses = responses if responses is not None else {
            tile_url(row): httpx.Response(row["http_status"], content=b"" if row["http_status"] != 200 else b"x" * row["bytes"])
            for row in RECORDED["responses"]
        }
        self.requests: list[str] = []

    def __call__(self, url: str) -> httpx.Response:
        self.requests.append(url)
        if url not in self.responses:
            raise AssertionError(f"unrecorded tile request: {url}")
        response = self.responses[url]
        return httpx.Response(response.status_code, content=response.content)

    def tokens_for(self, gibs_id: str) -> list[str]:
        return [url.split("/")[8] for url in self.requests if f"/{gibs_id}/" in url]


class RegistryTestCase(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        main._clear_resolution_cache()
        self.cache_dir = TemporaryDirectory()
        main.TILE_CACHE_DIR = Path(self.cache_dir.name)

    def tearDown(self):
        self.cache_dir.cleanup()
        main._clear_resolution_cache()


class RegistryTests(RegistryTestCase):
    def test_ac_01_registry_holds_the_thirteen_layers_of_tables_a_to_c(self):
        self.assertEqual(len(main.LAYER_REGISTRY), 13)
        self.assertEqual(list(main.LAYER_REGISTRY), list(TABLE_A))
        required = {
            "id", "gibs_id", "matrix", "max_zoom", "label", "basis", "resolution", "cadence",
            "lookback_days", "time_format", "time_start", "declared_end", "kind", "optical",
            "blank_threshold_bytes", "reserve", "window_days", "surface", "shown",
        }
        for layer_id, entry in main.LAYER_REGISTRY.items():
            self.assertEqual(set(entry), required, layer_id)
            gibs_id, matrix, max_zoom, basis, resolution, optical = TABLE_A[layer_id]
            kind, cadence, time_start, declared_end, window_days = TABLE_B[layer_id]
            lookback_days, time_format, reserve = TABLE_C[layer_id]
            self.assertEqual(entry["id"], layer_id)
            self.assertEqual(entry["gibs_id"], gibs_id)
            self.assertEqual(entry["matrix"], matrix)
            self.assertEqual(entry["max_zoom"], max_zoom)
            self.assertEqual(entry["label"], LABELS[layer_id])
            self.assertEqual(entry["basis"], basis)
            self.assertEqual(entry["resolution"], resolution)
            self.assertEqual(entry["kind"], kind)
            self.assertEqual(entry["cadence"], cadence)
            self.assertEqual(entry["time_start"], time_start)
            self.assertEqual(entry["declared_end"], declared_end)
            self.assertEqual(entry["window_days"], window_days)
            self.assertEqual(entry["lookback_days"], lookback_days)
            self.assertEqual(entry["time_format"], time_format)
            self.assertEqual(entry["reserve"], reserve)
            self.assertEqual(entry["optical"], optical)
            self.assertEqual(entry["blank_threshold_bytes"], 5000 if optical else None)

    def test_ac_01_every_gibs_id_is_in_the_identifier_file_of_the_frozen_fetch(self):
        self.assertEqual(len(IDENTIFIERS), CAPABILITIES["layer_count_contents"])
        self.assertEqual(len(IDENTIFIERS), 1330)
        for entry in main.LAYER_REGISTRY.values():
            self.assertIn(entry["gibs_id"], IDENTIFIERS)
            self.assertNotIn("ECOSTRESS", entry["gibs_id"].upper())

    def test_ac_01_block_one_id_is_an_alias_and_the_excluded_products_are_absent(self):
        self.assertIs(main.resolve_layer("smap-soil-moisture"), main.LAYER_REGISTRY["smap-l3"])
        ids = {entry["gibs_id"].upper() for entry in main.LAYER_REGISTRY.values()}
        self.assertFalse(any("ECOSTRESS" in value for value in ids))
        self.assertFalse(any("AMSR2" in value or "LPRM" in value for value in ids))
        self.assertFalse(any("NDH" in value or "DROUGHT" in value for value in ids))
        self.assertNotIn("smap-soil-moisture", main.LAYER_REGISTRY)


class TileContractTests(RegistryTestCase):
    def test_ac_02_each_upstream_url_carries_the_registry_matrix(self):
        for entry in main.LAYER_REGISTRY.values():
            if entry["kind"] != "tile":
                continue
            token = entry["time_start"]
            url = main._upstream_url(entry, token, 0, 0, 0)
            self.assertIn(f"/{entry['matrix']}/0/0/0", url)
        ndvi_url = main._upstream_url(main.LAYER_REGISTRY["ndvi-8day"], "2026-11-12", 9, 177, 273)
        self.assertIn("/GoogleMapsCompatible_Level9/9/273/177.png", ndvi_url)
        self.assertNotIn("GoogleMapsCompatible_Level6", ndvi_url)

    def test_ac_02_recorded_matrix_results_reproduce(self):
        recorded = {tile_url(row): row for row in RECORDED["responses"]}
        level6 = next(row for row in recorded.values() if row["layer"] == "ndvi-8day" and row["matrix"].endswith("Level6"))
        level9 = next(row for row in recorded.values() if row["layer"] == "ndvi-8day" and row["date"] == "2026-11-13")
        smap9 = next(row for row in recorded.values() if row["layer"] == "smap-l3" and row["matrix"].endswith("Level9"))
        self.assertEqual((level6["http_status"], level6["bytes"]), (400, 431))
        self.assertEqual((level9["http_status"], level9["bytes"]), (200, 52372))
        self.assertEqual(smap9["http_status"], 400)

        transport = RecordedTransport()
        ndvi = main.LAYER_REGISTRY["ndvi-8day"]
        resolution = main.resolve_effective_date(ndvi, "2026-11-13", transport, z=9, x=177, y=273)
        self.assertEqual(resolution.status, "on_date")
        self.assertEqual(len(resolution.response.content), 52372)
        self.assertEqual(transport.tokens_for(ndvi["gibs_id"]), ["2026-11-13"])

    def test_ac_04_worked_example_on_2026_11_12(self):
        transport = RecordedTransport()
        cases = [
            ("imerg-daily", "2026-11-12", 6, 22, 34, "2026-11-12", 0, "on_date"),
            ("smap-l3", "2026-11-12", 6, 22, 34, "2026-11-11", 1, "earlier"),
            ("ndvi-8day", "2026-11-12", 9, 177, 273, "2026-11-12", 0, "on_date"),
        ]
        for layer_id, chosen, z, x, y, effective, age, status in cases:
            resolution = main.resolve_effective_date(
                main.LAYER_REGISTRY[layer_id], chosen, transport, z=z, x=x, y=y
            )
            self.assertEqual(resolution.status, status, layer_id)
            self.assertEqual(resolution.effective_date, effective, layer_id)
            self.assertEqual(resolution.age_days, age, layer_id)
            self.assertIsNotNone(resolution.response, layer_id)

        smap_tokens = transport.tokens_for("SMAP_L3_Passive_Enhanced_Day_Soil_Moisture")
        self.assertEqual(smap_tokens, ["2026-11-11"])
        self.assertNotIn("2026-11-12", smap_tokens)
        self.assertEqual(len(transport.responses[tile_url(next(
            row for row in RECORDED["responses"] if row["layer"] == "smap-l3" and row["date"] == "2026-11-11"
        ))].content), 9999)

    def test_ac_06_all_candidates_404_reports_none_in_lookback_with_no_body(self):
        calls: list[str] = []

        def not_found(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(404, content=b"x" * 196)

        resolution = main.resolve_effective_date(main.LAYER_REGISTRY["smap-l3"], "2026-11-12", not_found, z=6, x=22, y=34)
        self.assertEqual(resolution.status, "none_in_lookback")
        self.assertIsNone(resolution.response)
        self.assertIsNone(resolution.effective_date)
        self.assertIsNone(resolution.age_days)
        self.assertEqual(len(calls), 7)

        with patch.object(main, "upstream_fetch", not_found):
            response = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-12")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.content, b"")
        self.assertEqual(response.headers["X-Tile-Status"], "none_in_lookback")

    def test_ac_07_monthly_ndvi_uses_its_own_lookback_and_stays_in_declared_range(self):
        transport = RecordedTransport()
        entry = main.LAYER_REGISTRY["ndvi-monthly"]
        self.assertEqual(entry["lookback_days"], 62)
        resolution = main.resolve_effective_date(entry, "2026-11-14", transport, z=7, x=44, y=68)
        self.assertEqual(resolution.status, "earlier")
        self.assertEqual(resolution.effective_date, "2026-10-01")
        self.assertEqual(resolution.age_days, 44)
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(transport.tokens_for(entry["gibs_id"]), ["2026-10-01"])

    def test_ac_08_imerg_thirty_minutes_uses_datetime_tokens_on_the_thirty_minute_grid(self):
        transport = RecordedTransport()
        entry = main.LAYER_REGISTRY["imerg-30min"]
        with self.assertRaises(ValueError):
            main._token_for(entry, date(2026, 11, 14))
        resolution = main.resolve_effective_date(entry, "2026-11-14", transport, z=6, x=22, y=34)
        self.assertEqual(resolution.status, "on_date")
        self.assertEqual(resolution.effective_date, "2026-11-14T12:30:00Z")
        self.assertEqual(resolution.age_days, 0)
        tokens = transport.tokens_for(entry["gibs_id"])
        self.assertEqual(tokens, ["2026-11-14T12:30:00Z"])
        for token in tokens:
            self.assertRegex(token, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
            self.assertLessEqual(token, entry["declared_end"])
        self.assertNotIn("2026-11-14T13:30:00Z", tokens)
        self.assertNotIn("2026-11-14T14:30:00Z", tokens)

    def test_ac_09_status_handling_of_the_walk(self):
        calls: list[str] = []

        def service_unavailable(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(503, content=b"")

        resolution = main.resolve_effective_date(main.LAYER_REGISTRY["smap-l3"], "2026-11-11", service_unavailable, z=6, x=22, y=34)
        self.assertEqual(resolution.status, "unavailable")
        # Block 12: a 5xx is asked once more before the walk stops, at the same URL.
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        calls.clear()

        seq = [httpx.Response(404), httpx.Response(400), httpx.Response(200, content=b"ok")]

        def steps(url: str) -> httpx.Response:
            calls.append(url)
            return seq.pop(0)

        resolution = main.resolve_effective_date(main.LAYER_REGISTRY["smap-l3"], "2026-11-11", steps, z=6, x=22, y=34)
        self.assertEqual(resolution.status, "earlier")
        self.assertEqual(resolution.effective_date, "2026-11-09")

        calls.clear()

        def teapot(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(418, content=b"")

        resolution = main.resolve_effective_date(main.LAYER_REGISTRY["smap-l3"], "2026-11-11", teapot, z=6, x=22, y=34)
        self.assertEqual(resolution.status, "unavailable")
        self.assertEqual(len(calls), 1)

        calls.clear()
        with patch.object(main, "upstream_fetch", teapot):
            response = self.client.get("/tiles/not-a-layer/6/22/34?date=2026-11-11")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(calls, [])

    def test_ac_10_cache_key_carries_the_date_and_the_header_survives_the_cache(self):
        token = "2026-11-11"
        smap_id = main.LAYER_REGISTRY["smap-l3"]["gibs_id"]
        responses = {}
        for day in ("2026-11-11", "2026-11-10"):
            responses[f"{main.GIBS_BASE_URL}/{smap_id}/default/{day}/GoogleMapsCompatible_Level6/6/34/22.png"] = httpx.Response(200, content=day.encode())
        transport = RecordedTransport(responses)

        with patch.object(main, "upstream_fetch", transport):
            first = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-12")
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.headers["X-Tile-Date"], token)
            self.assertEqual(first.headers["X-Tile-Source"], "upstream")
            fetches_after_first = len(transport.requests)

            second = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-12")
            self.assertEqual(second.status_code, 200)
            self.assertEqual(second.headers["X-Tile-Date"], token)
            self.assertEqual(second.headers["X-Tile-Source"], "cache")
            self.assertEqual(len(transport.requests), fetches_after_first)

            third = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-10")
            self.assertEqual(third.headers["X-Tile-Date"], "2026-11-10")

        cache_files = sorted(main.TILE_CACHE_DIR.rglob("*.png"))
        self.assertEqual(len(cache_files), 2)
        self.assertEqual({path.parents[2].name for path in cache_files}, {"2026-11-10", "2026-11-11"})

    def test_ac_11_layers_is_an_object_and_coverage_rejects_non_optical_layers(self):
        def ok_transport(url: str) -> httpx.Response:
            return httpx.Response(200, content=b"x" * 6000)

        with patch.object(main, "upstream_fetch", ok_transport):
            response = self.client.get("/layers?date=2026-11-12")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIsInstance(payload, dict)
        self.assertEqual(set(payload), {"chosen_date", "axis", "layers"})
        self.assertEqual(payload["chosen_date"], "2026-11-12")
        self.assertEqual(payload["axis"], {"start": "2015-04-01", "end": "2026-11-14", "default": "2026-11-14"})
        # Block 12: SMAP L3 and the two HLS layers stay in the registry but are not listed.
        shown = [layer_id for layer_id in TABLE_A if layer_id not in HIDDEN]
        self.assertEqual(len(payload["layers"]), 10)
        self.assertEqual([row["id"] for row in payload["layers"]], shown)
        expected_keys = {
            "id", "label", "kind", "basis", "resolution", "matrix", "max_zoom", "cadence",
            "lookback_days", "time_format", "optical", "window_days", "surface", "status",
            "effective_date", "age_days", "last_observation",
        }
        for row in payload["layers"]:
            self.assertEqual(set(row), expected_keys, row["id"])
        self.assertEqual(self.client.get("/layers/grace-mascon/coverage?days=5").status_code, 400)
        self.assertEqual(self.client.get("/layers/smap-l3/coverage?days=5").status_code, 400)

    def test_ac_11_layers_leaves_the_date_fields_null_when_there_is_no_observation(self):
        def not_found(url: str) -> httpx.Response:
            return httpx.Response(404, content=b"")

        with patch.object(main, "upstream_fetch", not_found):
            payload = self.client.get("/layers?date=2026-11-12").json()
        smap = next(row for row in payload["layers"] if row["id"] == "smap-l4-surface")
        self.assertEqual(smap["status"], "none_in_lookback")
        self.assertIsNone(smap["effective_date"])
        self.assertIsNone(smap["age_days"])
        self.assertIsNone(smap["last_observation"])

    def test_ac_12_zoom_above_max_zoom_is_refused_without_an_upstream_request(self):
        calls: list[str] = []

        def transport(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(200, content=b"x" * 10)

        with patch.object(main, "upstream_fetch", transport):
            response = self.client.get("/tiles/smap-l3/7/64/64?date=2026-11-11")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Zoom above max_zoom for layer")
        self.assertEqual(calls, [])

    def test_ac_21_backend_half_layers_rows_carry_name_basis_resolution_date_and_age(self):
        def ok_transport(url: str) -> httpx.Response:
            return httpx.Response(200, content=b"x" * 6000)

        with patch.object(main, "upstream_fetch", ok_transport):
            payload = self.client.get("/layers?date=2026-11-12").json()
        by_id = {row["id"]: row for row in payload["layers"]}
        smap = by_id["smap-l4-surface"]
        self.assertEqual(smap["label"], "SMAP L4 surface soil moisture")
        self.assertEqual(smap["basis"], "modelled")
        self.assertEqual(smap["resolution"], "9 km")
        self.assertEqual(smap["effective_date"], "2026-11-10")
        self.assertEqual(smap["age_days"], 2)
        for layer_id in HIDDEN:
            self.assertNotIn(layer_id, by_id)
            self.assertFalse(main.LAYER_REGISTRY[layer_id]["shown"])
        grace = by_id["grace-mascon"]
        self.assertEqual(grace["status"], "stale")
        self.assertEqual(grace["last_observation"], "2022-07-01")
        self.assertIsNone(grace["effective_date"])
        self.assertIsNone(grace["age_days"])

    def test_ac_41_optical_walk_ignores_blank_bodies_and_stops_at_the_first_imagery_date(self):
        transport = RecordedTransport()
        entry = main.LAYER_REGISTRY["hls-l30"]
        self.assertTrue(entry["optical"])
        self.assertEqual(entry["blank_threshold_bytes"], 5000)
        resolution = main.resolve_effective_date(entry, "2026-11-14", transport, z=12, x=1419, y=2184)
        self.assertEqual(resolution.status, "earlier")
        self.assertEqual(resolution.effective_date, "2026-11-01")
        self.assertEqual(resolution.age_days, 13)
        tokens = transport.tokens_for(entry["gibs_id"])
        self.assertEqual(tokens[0], "2026-11-06")
        self.assertEqual(tokens[-1], "2026-11-01")
        self.assertNotIn("2026-11-07", tokens)
        for token in tokens:
            self.assertGreaterEqual(token, "2026-10-15")
            self.assertLessEqual(token, "2026-11-06")
        first = min(transport.requests)
        self.assertIn("/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/", first)
        self.assertTrue(all(url.endswith(".jpg") for url in transport.requests))

    def test_r_44_coverage_records_every_date_of_the_window_and_answers_503_on_a_stop(self):
        calls: list[str] = []

        def blank_then_image(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(200, content=b"x" * (9000 if "/2026-11-10/" in url else 400))

        with patch.object(main, "upstream_fetch", blank_then_image):
            payload = self.client.get("/layers/hls-l30/coverage?days=3&date=2026-11-11").json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual([row["date"] for row in payload["dates"]], ["2026-11-11", "2026-11-10", "2026-11-09"])
        self.assertEqual([row["coverage_ok"] for row in payload["dates"]], [False, True, False])
        self.assertEqual(len(calls), 3)

        calls.clear()

        def with_a_server_error(url: str) -> httpx.Response:
            calls.append(url)
            if "/2026-11-10/" in url:
                return httpx.Response(500, content=b"")
            return httpx.Response(404, content=b"")

        with patch.object(main, "upstream_fetch", with_a_server_error):
            response = self.client.get("/layers/hls-l30/coverage?days=5&date=2026-11-12")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable", "dates_scanned": ["2026-11-12", "2026-11-11", "2026-11-10"]})

    def test_r_25_offline_serves_the_newest_cached_tile_not_after_the_chosen_date(self):
        smap_id = main.LAYER_REGISTRY["smap-l3"]["gibs_id"]
        good = {f"{main.GIBS_BASE_URL}/{smap_id}/default/2026-11-11/GoogleMapsCompatible_Level6/6/34/22.png": httpx.Response(200, content=b"cached-tile")}

        def offline(url: str) -> httpx.Response:
            raise httpx.ConnectError("no route")

        with patch.object(main, "upstream_fetch", RecordedTransport(good)):
            self.assertEqual(self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-11").status_code, 200)

        main._clear_resolution_cache()
        with patch.object(main, "upstream_fetch", offline):
            served = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-12")
            before = self.client.get("/tiles/smap-l3/6/22/34?date=2026-11-10")

        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.content, b"cached-tile")
        self.assertEqual(served.headers["X-Tile-Date"], "2026-11-11")
        self.assertEqual(served.headers["X-Tile-Source"], "cache-offline")
        self.assertEqual(before.headers["X-Tile-Source"], "reserve")
        self.assertNotIn("X-Tile-Date", before.headers)


if __name__ == "__main__":
    unittest.main()


class UpstreamFailureTests(unittest.TestCase):
    def tearDown(self):
        main.upstream_fetch = main._http_fetch
        main._clear_resolution_cache()

    def test_a_failed_walk_is_not_remembered(self):
        main._clear_resolution_cache()
        answers = [httpx.ConnectError("down"), httpx.Response(200, content=b"tile")]

        def flaky(url: str) -> httpx.Response:
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        main.upstream_fetch = flaky
        entry = main.LAYER_REGISTRY["lst-terra"]
        first = main._resolve_cached(entry, date(2026, 11, 13), 7, 29, 45)
        second = main._resolve_cached(entry, date(2026, 11, 13), 7, 29, 45)
        self.assertEqual(first.status, "unavailable")
        self.assertEqual(second.status, "on_date")

    def test_a_missing_date_is_asked_once_per_layer(self):
        main._clear_resolution_cache()
        calls: list[str] = []

        def transport(url: str) -> httpx.Response:
            calls.append(url)
            return httpx.Response(404) if "/2026-11-13/" in url else httpx.Response(200, content=b"tile")

        entry = main.LAYER_REGISTRY["lst-terra"]
        main.resolve_effective_date(entry, "2026-11-13", transport, z=7, x=29, y=45)
        main.resolve_effective_date(entry, "2026-11-13", transport, z=7, x=30, y=45)
        self.assertEqual(sum("/2026-11-13/" in url for url in calls), 1)

