"""Block 6 wave 1: the numbers route, its sections, provenance, cache, gaps and failure paths.

Every test runs against the recorded transport (block6_replay.py) and a temporary cache directory.
The live smoke test is skipped unless BLOCK6_LIVE=1 is set. Rule ids point at the spec.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch

from fastapi.testclient import TestClient

import field_numbers
import main
from block6_replay import ARTIFACTS, ReplayTransport, create_sidecar, fixture_rows, ring_with_area_ha

# A 22.4 ha ring centred on the fixture point, so R-50 compares like with like. The spec's Table B
# worked ring (0.025 by 0.02 degrees) covers about 600 ha and would be marked a fragment.
RING = ring_with_area_ha(22.4)
CENTROID = [-55.27, -11.91]
BODY = {"ring": RING, "centroid": CENTROID, "area_ha": 22.4, "date": "2026-11-12"}
FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
ALLOWED_STATES = {"ok", "abstained", "not_applicable", "unavailable"}
PROVENANCE_KEYS = {"metric", "label", "value", "unit", "basis", "as_of", "source", "resolution", "route", "fetched_at"}
SECTIONS = {"climate", "water_balance", "smap", "ndvi", "soil", "rotation", "municipality", "fragment"}


class RouteCase(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)
        self.cache_dir = TemporaryDirectory()
        self.clock = {"now": FROZEN_NOW}
        self.mapbiomas = TemporaryDirectory()
        self.db = Path(self.mapbiomas.name) / "polygon-mapbiomas.sqlite"
        self.transport = ReplayTransport()
        self.patches = [
            patch.object(field_numbers, "CACHE_DIR", Path(self.cache_dir.name)),
            patch.object(field_numbers, "clock", lambda: self.clock["now"]),
            patch.object(field_numbers, "MAPBIOMAS_DB", self.db),
            patch.object(field_numbers, "transport", self.transport),
            # The limiter is per client address and this module posts from the same one in every
            # case, so it is off here; NumbersRateLimitTests turns it back on for itself.
            patch.dict(os.environ, {"NUMBERS_RATE_LIMIT_REQUESTS": "0"}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()
        self.cache_dir.cleanup()
        self.mapbiomas.cleanup()

    def post(self, field_id: str = "mt-santa-carmem-01", body: dict | None = None):
        return self.client.post(f"/fields/{field_id}/numbers", json=BODY if body is None else body)

    def ok_payload(self, field_id: str = "mt-santa-carmem-01") -> dict:
        response = self.post(field_id)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


class RouteInventoryTests(RouteCase):
    """R-45: exactly one new route, and the count measured on the branch."""

    def test_r45_exactly_one_new_route_is_registered_for_this_block(self) -> None:
        numbers_routes = [r for r in main.app.routes if getattr(r, "path", "") == "/fields/{field_id}/numbers"]
        self.assertEqual(len(numbers_routes), 1)
        self.assertEqual(numbers_routes[0].methods, {"POST"})

    def test_r45_the_app_answers_eleven_api_routes_after_this_block(self) -> None:
        api = sorted(
            (sorted(r.methods - {"HEAD"})[0], r.path)
            for r in main.app.routes
            if getattr(r, "methods", None) and r.path not in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc")
        )
        self.assertEqual(len(api), 11, api)
        self.assertIn(("POST", "/fields/{field_id}/numbers"), api)


class RouteValidationTests(RouteCase):
    """R-45 and R-46: 200, 400, 404 and 422, and no other non 200 answer."""

    def test_r45_a_valid_request_answers_200_with_every_section_and_allowed_states(self) -> None:
        payload = self.ok_payload()
        self.assertEqual(set(payload["sections"]), SECTIONS)
        for name, section in payload["sections"].items():
            self.assertIn(section["state"], ALLOWED_STATES, name)
        self.assertIn("provenance", payload)
        self.assertIn("gaps", payload)
        self.assertIn("query", payload)

    def test_r45_the_date_range_accepts_the_axis_start_and_today(self) -> None:
        self.assertEqual(self.post(body={**BODY, "date": "2015-04-01"}).status_code, 200)
        self.assertEqual(self.post(body={**BODY, "date": "2026-11-15"}).status_code, 200)

    def test_r46_a_date_outside_the_range_is_400(self) -> None:
        self.assertEqual(self.post(body={**BODY, "date": "2015-03-31"}).status_code, 400)
        self.assertEqual(self.post(body={**BODY, "date": "2026-11-16"}).status_code, 400)

    def test_r46_a_ring_with_fewer_than_three_points_is_400(self) -> None:
        self.assertEqual(self.post(body={**BODY, "ring": [[-55.0, -11.0], [-55.1, -11.0]]}).status_code, 400)

    def test_r46_a_zero_area_ring_is_400(self) -> None:
        flat = [[-55.0, -11.0], [-55.1, -11.0], [-55.2, -11.0]]
        self.assertEqual(self.post(body={**BODY, "ring": flat, "centroid": [-55.1, -11.0]}).status_code, 400)

    def test_r46_a_centroid_outside_the_ring_is_400(self) -> None:
        self.assertEqual(self.post(body={**BODY, "centroid": [-54.0, -11.0]}).status_code, 400)

    def test_r46_an_unknown_id_is_404(self) -> None:
        self.assertEqual(self.post(field_id="no-such-field").status_code, 404)

    def test_r46_a_malformed_body_is_422(self) -> None:
        self.assertEqual(self.post(body={"ring": RING, "centroid": [1.0, 2.0, 3.0], "date": "2026-11-12"}).status_code, 422)
        self.assertEqual(self.post(body={"ring": RING, "centroid": CENTROID, "date": "not-a-date"}).status_code, 422)
        self.assertEqual(self.post(body={"ring": RING, "date": "2026-11-12"}).status_code, 422)

    def test_r51_the_three_id_forms_resolve_the_region_they_name(self) -> None:
        self.assertEqual(self.ok_payload("mt-santa-carmem-01")["region"], "br")
        self.assertEqual(self.ok_payload("csb:381825001868504")["region"], "us")
        self.assertEqual(self.ok_payload("trazo:12345")["region"], "br")
        self.assertEqual(self.ok_payload("381825001868504")["region"], "us")


class RouteSectionTests(RouteCase):
    """Sections, states and gaps: R-03, R-12, R-19, R-23, R-25, R-29, R-36, R-37, R-38."""

    def test_r16_the_query_reports_the_window_and_its_day_counts(self) -> None:
        window = self.ok_payload()["query"]["window"]
        self.assertEqual(window, {"start": "2026-10-01", "end": "2026-11-11", "days": 42, "valid_days": 42, "dropped_days": 1})

    def test_r18_climate_aggregates_match_oracle_o01_through_the_route(self) -> None:
        climate = self.ok_payload()["sections"]["climate"]
        aggregates = climate["aggregates"]
        self.assertEqual(aggregates["rain_total"]["value"], 171.9)
        self.assertEqual(aggregates["dry_spell_days"]["value"], 7)
        self.assertEqual(aggregates["gdd10"]["value"], 836)
        self.assertEqual(aggregates["frost_days"]["value"], 0)
        self.assertEqual(aggregates["tmin_min"]["value"], 21.8)
        self.assertEqual(aggregates["gwetroot_mean"]["value"], 0.49)

    def test_r20_normals_match_oracle_o03_through_the_route(self) -> None:
        normals = self.ok_payload()["sections"]["climate"]["normals"]
        self.assertEqual(normals["rain_median"]["value"], 224.9)
        self.assertEqual(normals["rain_rank"]["value"], 7)
        self.assertEqual(normals["rain_percentile"]["value"], 20)
        self.assertEqual(normals["hot_days"]["value"], 28)
        self.assertEqual(normals["hot_days_median"]["value"], 17)
        self.assertEqual(normals["of_years"], 35)

    def test_r22_r23_r24_water_balance_prints_three_numbers_and_the_evland_label(self) -> None:
        water = self.ok_payload()["sections"]["water_balance"]
        self.assertEqual(water["state"], "ok")
        self.assertEqual(water["in"], 171.9)
        self.assertIsNotNone(water["out"])
        self.assertIn("EVLAND", water["out_label"])
        self.assertIn("land surface evaporation", water["out_label"])
        self.assertEqual(water["formula"], "remaining = in - out")

    def test_r25_r26_smap_abstains_with_one_gap_and_no_upstream_request(self) -> None:
        payload = self.ok_payload()
        smap = payload["sections"]["smap"]
        self.assertEqual(smap["state"], "abstained")
        self.assertTrue(all(row["value"] is None for row in payload["provenance"] if row["metric"].startswith("smap_")))
        self.assertTrue(any(g["section"] == "smap" for g in payload["gaps"]))
        self.assertFalse(any("gibs" in host for host in self.transport.hosts()))

    def test_r29_r30_ndvi_prints_the_scene_counts_and_abstains_with_a_named_reason(self) -> None:
        payload = self.ok_payload()
        ndvi = payload["sections"]["ndvi"]
        self.assertEqual(ndvi["state"], "abstained")
        rows = {row["metric"]: row for row in payload["provenance"]}
        self.assertEqual(rows["ndvi_scene_count"]["value"], 13)
        self.assertEqual(rows["ndvi_clear_count"]["value"], ndvi["clear_count"])
        cause = [g for g in payload["gaps"] if g["section"] == "ndvi"][0]
        self.assertIn("OD-01", cause["remediation"])
        self.assertIn("is not approved", cause["cause"])
        self.assertNotIn("MODIS", json.dumps(payload))

    def test_r12_soil_values_match_oracle_o06_and_the_rows_carry_modelled_basis(self) -> None:
        payload = self.ok_payload()
        soil = payload["sections"]["soil"]
        self.assertEqual(soil["state"], "ok")
        rows = {row["metric"]: row for row in payload["provenance"]}
        self.assertEqual(rows["soil.clay.0_5"]["value"], 225)
        self.assertEqual(rows["soil.soc.15_30"]["value"], 9.1)
        self.assertEqual(rows["soil.clay.0_5"]["basis"], "modelled")
        self.assertEqual(rows["soil.clay.0_5"]["resolution"], "250 m static model")

    def test_r37_r38_the_municipal_row_abstains_and_the_state_row_prints(self) -> None:
        payload = self.ok_payload()
        municipal = payload["sections"]["municipality"]
        self.assertEqual(municipal["state"], "abstained")
        self.assertIsNone(municipal["municipality"], "no municipality code is inferred from a name")
        self.assertEqual(municipal["state_row"]["code"], "51")
        rows = {row["metric"]: row for row in payload["provenance"]}
        self.assertIsNone(rows["municipality_soy_ha"]["value"])
        self.assertEqual(rows["state_soy_ha"]["value"], 12788611)
        causes = " ".join(g["cause"] + " " + g["remediation"] for g in payload["gaps"] if g["section"] == "municipality")
        self.assertIn("CO-B6-06", causes)

    def test_r36_rotation_is_unavailable_when_the_sidecar_is_absent_and_never_empty(self) -> None:
        payload = self.ok_payload()
        rotation = payload["sections"]["rotation"]
        self.assertEqual(rotation["state"], "unavailable")
        self.assertIn(str(self.db), rotation["error"])
        self.assertFalse(any(row["metric"].startswith("mb_") for row in payload["provenance"]))
        self.assertTrue(any(g["section"] == "rotation" for g in payload["gaps"]))

    def test_r36_rotation_abstains_for_a_polygon_without_a_sidecar_row(self) -> None:
        create_sidecar(self.db, rows=fixture_rows("trazo:12345"))
        payload = self.ok_payload("trazo:777")
        rotation = payload["sections"]["rotation"]
        self.assertEqual(rotation["state"], "abstained")
        self.assertEqual([g["cause"] for g in payload["gaps"] if g["section"] == "rotation"],
                         ["no MapBiomas Collection 11 row for this polygon"])

    def test_r35_rotation_rows_have_one_row_per_year_and_the_collection_provenance(self) -> None:
        create_sidecar(self.db, rows=fixture_rows("trazo:12345"))
        payload = self.ok_payload("trazo:12345")
        rotation = payload["sections"]["rotation"]
        self.assertEqual(rotation["state"], "ok")
        first = [r for r in payload["provenance"] if r["metric"].startswith("mb_first_crop.")]
        second = [r for r in payload["provenance"] if r["metric"].startswith("mb_second_crop.")]
        self.assertEqual(len(first), 41)
        self.assertEqual(len(second), 26)
        self.assertEqual(rotation["collection"], "MapBiomas Collection 11")
        self.assertNotIn("mbMode 2024", json.dumps(payload))

    def test_r50_fragment_section_is_ok_and_reports_the_clip_check(self) -> None:
        fragment = self.ok_payload()["sections"]["fragment"]
        self.assertEqual(fragment["state"], "ok")
        self.assertIs(fragment["is_fragment"], False)
        self.assertAlmostEqual(fragment["ring_area_ha"], 22.4, places=0)

    def test_r50_without_an_area_the_fragment_check_is_null_with_a_gap(self) -> None:
        response = self.post(body={**BODY, "area_ha": None})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIsNone(payload["sections"]["fragment"]["is_fragment"])
        self.assertTrue(any(g["section"] == "fragment" for g in payload["gaps"]))

    def test_r12_a_missing_input_is_null_and_never_zero(self) -> None:
        payload = self.ok_payload()
        for row in payload["provenance"]:
            if row["value"] is None:
                self.assertNotEqual(row["value"], 0)
        self.assertNotIn("\"value\": 0,", json.dumps(payload["sections"]["municipality"]))


class RouteProvenanceTests(RouteCase):
    """R-07, R-08, R-09, R-10, R-13 and AC-06, AC-07, AC-09, AC-12."""

    def test_ac06_each_printed_metric_has_exactly_one_row_with_the_ten_keys(self) -> None:
        payload = self.ok_payload()
        metrics = [row["metric"] for row in payload["provenance"]]
        self.assertEqual(len(metrics), len(set(metrics)))
        for row in payload["provenance"]:
            self.assertEqual(set(row), PROVENANCE_KEYS, row["metric"])

    def test_ac07_basis_is_one_of_the_four_and_comes_from_the_row(self) -> None:
        for row in self.ok_payload()["provenance"]:
            self.assertIn(row["basis"], {"observed", "retrieved", "modelled", "entered"})
        rows = {row["metric"]: row for row in self.ok_payload()["provenance"]}
        self.assertEqual(rows["rain_total"]["basis"], "modelled")
        self.assertEqual(rows["ndvi_scene_count"]["basis"], "retrieved")

    def test_r09_no_metric_id_or_source_string_sets_a_basis(self) -> None:
        for row in self.ok_payload()["provenance"]:
            if "smap" in row["metric"]:
                self.assertIn(row["basis"], {"retrieved"})
            if "POWER" in row["source"] or "power.larc" in row["source"]:
                self.assertEqual(row["basis"], "modelled")

    def test_r10_coarse_sources_print_their_resolution_on_every_row(self) -> None:
        rows = {row["metric"]: row for row in self.ok_payload()["provenance"]}
        self.assertEqual(rows["rain_total"]["resolution"], "0.5 degree cell")
        self.assertEqual(rows["gdd10"]["resolution"], "0.5 degree cell")
        self.assertEqual(rows["soil.ph.0_5"]["resolution"], "250 m static model")

    def test_r08_every_row_carries_as_of_source_route_and_fetched_at(self) -> None:
        for row in self.ok_payload()["provenance"]:
            self.assertTrue(row["fetched_at"] or row["fetched_at"] is None)
            self.assertIn("route", row)
            self.assertIn("source", row)

    def test_ac12_each_data_section_prints_a_source_line_with_as_of_and_basis(self) -> None:
        sections = self.ok_payload()["sections"]
        for name in ("climate", "water_balance", "soil", "ndvi", "municipality"):
            section = sections[name]
            self.assertIn("source", section, name)
            self.assertIn("as_of", section, name)
            self.assertIn("basis", section, name)


class RouteSourceHostTests(RouteCase):
    """R-14, R-15, R-33 and AC-13, AC-14, AC-32: no Google derived value, no MapBiomas host."""

    def test_r15_no_request_reaches_a_google_or_mapbiomas_host(self) -> None:
        self.ok_payload()
        hosts = self.transport.hosts()
        self.assertFalse(any("google" in host or "mapbiomas" in host for host in hosts), hosts)
        # The state row of R-37 reads IBGE SIDRA, so its host is part of the documented set now.
        self.assertEqual(
            hosts,
            {"power.larc.nasa.gov", "rest.isric.org", "earth-search.aws.element84.com",
             "servicodados.ibge.gov.br"},
        )


class RoutePartialFailureTests(RouteCase):
    """R-46 and AC-45: one failed source never fails the whole response."""

    def test_ac45_power_down_keeps_soil_and_ndvi_and_answers_200(self) -> None:
        self.transport.offline_hosts = ("power.larc",)
        response = self.post()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["sections"]["climate"]["state"], "unavailable")
        self.assertIn("error", payload["sections"]["climate"])
        self.assertEqual(payload["sections"]["soil"]["state"], "ok")
        self.assertEqual(payload["sections"]["ndvi"]["state"], "unavailable")
        self.assertIn("window unknown", payload["sections"]["ndvi"]["error"])
        self.assertTrue(any(g["section"] == "climate" for g in payload["gaps"]))

    def test_ac45_each_failing_source_in_turn_answers_200(self) -> None:
        for host, section in (("earth-search", "ndvi"), ("rest.isric.org", "soil")):
            with self.subTest(host=host):
                # A fresh cache per source: a payload cached by an earlier subtest is a valid cache hit (R-47).
                shutil.rmtree(self.cache_dir.name, ignore_errors=True)
                self.transport.status_overrides = {host: 503}
                response = self.post()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["sections"][section]["state"], "unavailable")
                self.assertIn("503", response.json()["sections"][section]["error"])
        self.transport.status_overrides = {}

    def test_r48_offline_network_answers_200_with_every_network_section_unavailable(self) -> None:
        self.transport.offline = True
        response = self.post()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        # R-48: every section whose source is the network answers `unavailable`, SIDRA included.
        for name in ("climate", "water_balance", "ndvi", "soil", "municipality"):
            self.assertEqual(payload["sections"][name]["state"], "unavailable", name)
        for name in ("climate", "water_balance", "soil", "municipality"):
            self.assertTrue(any(g["section"] == name for g in payload["gaps"]), name)
        network_gaps = [g for g in payload["gaps"] if "network" in g["cause"] or "offline" in g["cause"]]
        self.assertGreaterEqual(len(network_gaps), 3)


class RouteMalformedNormalsTests(RouteCase):
    """AC-16 and R-20: a malformed normals response is readable from the normals payload itself.

    t_c2709ec2: the malformed branch used to record the cause only in the gap register, while the
    SourceFailure branch set `normals.error`. Both branches of the same source now agree.
    """

    def test_ac16_malformed_normals_sets_the_error_and_keeps_its_gap_row(self) -> None:
        # Only the normals request (1991 to 2025) is answered without the parameter table: the daily
        # climate request must keep succeeding, or the section returns before `_normals` runs.
        recorded = self.transport._power

        def power(url: str) -> dict:
            if "start=19910101" in url:
                return {"header": {"fill_value": -999.0}, "properties": {}}
            return recorded(url)

        with patch.object(self.transport, "_power", side_effect=power):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        normals = payload["sections"]["climate"]["normals"]
        self.assertEqual(normals["error"], "malformed POWER normals response")
        self.assertEqual(normals["of_years"], 0)
        self.assertEqual(normals["excluded_years"], [])
        # The same three keys the SourceFailure branch returns: a failure never carries metric keys.
        self.assertEqual(set(normals), {"of_years", "excluded_years", "error"})
        rows = {row["metric"]: row for row in payload["provenance"]}
        self.assertIsNone(rows["rain_median"]["value"])
        gaps = [g for g in payload["gaps"]
                if g["section"] == "climate" and g["cause"] == "malformed POWER normals response"]
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["status"], "malformed")
        self.assertEqual(payload["sections"]["climate"]["window"]["days"], 42)  # the daily read still landed


class RouteNormalsFailureAbstainTests(RouteCase):
    """R-19 and R-20: a failed normals payload is never a 500, even when every aggregate abstains.

    The unguarded read predates block 6 wave 1: `_climate` read `normals["rain_median"]` only when all
    six aggregates were None, and the two `_normals` failure branches carry the three keys `of_years`,
    `excluded_years` and `error` and no metric key, so that read raised `KeyError` inside the route.
    A mostly fill POWER daily response (one valid `PRECTOTCORR` day, so the 42 day window still
    resolves) together with a malformed normals response is the shape that reaches it.
    """

    def test_a_malformed_normals_payload_with_every_aggregate_abstaining_answers_200(self) -> None:
        recorded = self.transport._power

        def power(url: str) -> dict:
            if "start=19910101" in url:  # the normals request (1991 to 2025)
                return {"header": {"fill_value": -999.0}, "properties": {}}
            # The daily climate request: fill on every day of every parameter, then one valid rain day.
            payload = recorded(url)
            params = payload["properties"]["parameter"]
            rain_days = sorted(params.get("PRECTOTCORR", {}))
            for series in params.values():
                for key in list(series):
                    series[key] = -999.0
            params["PRECTOTCORR"][rain_days[-1]] = 3.0
            return payload

        with patch.object(self.transport, "_power", side_effect=power):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        climate = response.json()["sections"]["climate"]
        self.assertEqual(climate["state"], "abstained")
        # The run must reach the failed normals read, not return early on a missing window.
        self.assertIsNotNone(climate["window"])
        self.assertEqual(climate["window"]["valid_days"], 1)
        self.assertEqual(len(climate["aggregates"]), 6)
        for name, item in climate["aggregates"].items():
            self.assertIsNone(item["value"], name)
        self.assertEqual(climate["normals"]["error"], "malformed POWER normals response")
        self.assertEqual(climate["normals"]["of_years"], 0)


class RouteCacheTests(RouteCase):
    """R-47 and AC-46: per source lifetimes, cached and fetched_at exposed, no cache for an unavailable section."""

    def test_ac46_a_second_request_inside_the_lifetime_returns_the_same_fetched_at(self) -> None:
        first = self.ok_payload()
        self.clock["now"] = FROZEN_NOW + timedelta(hours=1)
        second = self.ok_payload()
        self.assertFalse(first["sections"]["climate"]["cached"])
        self.assertTrue(second["sections"]["climate"]["cached"])
        self.assertEqual(first["sections"]["climate"]["fetched_at"], second["sections"]["climate"]["fetched_at"])
        self.assertEqual(second["sections"]["climate"]["aggregates"], first["sections"]["climate"]["aggregates"])

    def test_ac46_after_the_climate_lifetime_only_climate_refreshes(self) -> None:
        first = self.ok_payload()
        self.clock["now"] = FROZEN_NOW + timedelta(hours=7)
        second = self.ok_payload()
        self.assertNotEqual(first["sections"]["climate"]["fetched_at"], second["sections"]["climate"]["fetched_at"])
        self.assertEqual(first["sections"]["soil"]["fetched_at"], second["sections"]["soil"]["fetched_at"])
        self.assertTrue(second["sections"]["soil"]["cached"])

    def test_ac46_an_unavailable_section_writes_no_cache_file(self) -> None:
        self.transport.status_overrides = {"rest.isric.org": 503}
        self.post()
        files = [p.parent.name for p in Path(self.cache_dir.name).rglob("*.json")]
        self.assertNotIn("soil", files)
        self.assertFalse(any("soilgrids" in name for name in files))
        self.transport.status_overrides = {}

    def test_r47_fetched_at_is_the_instant_of_the_upstream_read(self) -> None:
        self.clock["now"] = FROZEN_NOW + timedelta(minutes=5)
        payload = self.ok_payload()
        self.assertEqual(payload["sections"]["climate"]["fetched_at"], "2026-11-15T03:05:00Z")


APP_ROOT = Path(__file__).resolve().parents[1]
RECORDER = APP_ROOT / "scripts" / "record_numbers_fixture.py"


def _load_recorder() -> ModuleType:
    """Load the recorder by path: it is a command, not a backend module."""
    spec = importlib.util.spec_from_file_location("record_numbers_fixture", RECORDER)
    if spec is None or spec.loader is None:  # pragma: no cover - a missing script is the failure itself
        raise FileNotFoundError(RECORDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordedFixtureTests(unittest.TestCase):
    """Block 6 contract repair: the committed frontend fixture is a tested claim about the backend.

    `scripts/record_numbers_fixture.py --check` catches a payload the committed fixture no longer
    matches, but nothing in the repository ran it, and the route test read only provenance rows.
    A regression in the soil depth entry (`label`, the Table A token as `depth`, and the Table E
    keys) therefore kept every suite green while the app blanked (defect D1 of the repair). This
    test runs the same recorder over the same frozen clock and compares the bytes the frontend
    renders, so the fixture cannot drift from the producer silently.
    """

    def test_the_committed_frontend_fixture_is_the_payload_the_backend_produces(self) -> None:
        recorder = _load_recorder()
        produced = (json.dumps(recorder.record(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        committed = recorder.FIXTURE.read_bytes()
        if produced != committed:
            self.fail(f"MISMATCH: {recorder.FIXTURE} is not the payload the backend produces")


class RouteLiveSmokeTests(unittest.TestCase):
    """One live smoke test, skipped unless BLOCK6_LIVE=1. Its values are recorded with their date and are
    never compared as oracles. The payload is written to artifacts/block6/live-smoke-<date>.json."""

    @unittest.skipUnless(os.environ.get("BLOCK6_LIVE") == "1", "live smoke test: set BLOCK6_LIVE=1")
    def test_live_route_answers_200_with_every_section(self) -> None:
        client = TestClient(main.app)
        with TemporaryDirectory() as cache:
            with patch.object(field_numbers, "CACHE_DIR", Path(cache)):
                response = client.post("/fields/mt-santa-carmem-01/numbers", json=BODY)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload["sections"]), SECTIONS)
        recorded = ARTIFACTS / f"live-smoke-{datetime.now(timezone.utc):%Y-%m-%d}.json"
        recorded.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")



class NumbersRateLimitTests(RouteCase):
    """Item 4 of the publishing fixes: the one slow route is throttled per client address."""

    def setUp(self) -> None:
        super().setUp()
        self.previous = {
            name: os.environ.get(name)
            for name in ("NUMBERS_RATE_LIMIT_REQUESTS", "NUMBERS_RATE_LIMIT_WINDOW_SECONDS")
        }
        os.environ["NUMBERS_RATE_LIMIT_REQUESTS"] = "2"
        os.environ["NUMBERS_RATE_LIMIT_WINDOW_SECONDS"] = "60"
        main._rate_hits.clear()
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        for name, value in self.previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        main._rate_hits.clear()

    def test_the_request_after_the_window_is_429_with_retry_after(self) -> None:
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post().status_code, 200)
        blocked = self.post()
        self.assertEqual(blocked.status_code, 429, blocked.text)
        self.assertEqual(blocked.headers.get("Retry-After"), "60")
        self.assertIn("at most 2 in 60 s", blocked.json()["detail"])

    def test_a_window_of_zero_seconds_lets_the_next_request_through(self) -> None:
        os.environ["NUMBERS_RATE_LIMIT_WINDOW_SECONDS"] = "0.001"
        self.assertIn(self.post().status_code, (200, 429))
        for _ in range(3):
            self.assertEqual(self.post().status_code, 200)

    def test_the_default_allowance_is_sixty_requests_a_minute_per_worker(self) -> None:
        os.environ.pop("NUMBERS_RATE_LIMIT_REQUESTS", None)
        os.environ.pop("NUMBERS_RATE_LIMIT_WINDOW_SECONDS", None)
        self.assertEqual(main._numbers_rate_limit(), (60, 60.0))


if __name__ == "__main__":
    unittest.main()
