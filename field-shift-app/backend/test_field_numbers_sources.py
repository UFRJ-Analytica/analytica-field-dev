"""Block 6 wave 1: the source readers (POWER, SoilGrids, SIDRA, Earth Search, the MapBiomas sidecar).

Recorded responses only. Rule ids point at specs/bloco-6-numeros-por-poligono.md.
"""

from __future__ import annotations

import inspect
import json
import re
import sqlite3
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import unquote

import httpx

from block6_replay import ARTIFACTS, ReplayTransport, create_sidecar, fixture_rows
from sources import mapbiomas, power, sentinel2, sidra, soilgrids

RING = [[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92]]


class PowerReaderTests(unittest.TestCase):
    """R-17 and AC-16."""

    def test_r17_request_carries_only_the_table_a_parameters_with_ag_and_json(self) -> None:
        url = power.url(-55.27, -11.91, date(2026, 7, 15), date(2026, 11, 12), power.CLIMATE_PARAMETERS)
        query = url.split("?", 1)[1]
        self.assertTrue(url.startswith("https://power.larc.nasa.gov/api/temporal/daily/point?"))
        self.assertIn("community=AG", query)
        self.assertIn("format=JSON", query)
        self.assertIn("start=20260715", query)
        self.assertIn("end=20261112", query)
        self.assertIn("longitude=-55.27", query)
        self.assertIn("latitude=-11.91", query)
        requested = set(unquote(query.split("parameters=", 1)[1].split("&", 1)[0]).split(","))
        self.assertEqual(requested, {"PRECTOTCORR", "T2M", "T2M_MAX", "T2M_MIN", "FROST_DAYS", "GWETROOT", "EVLAND"})

    def test_r17_the_fill_value_is_dropped_at_parse_and_never_enters_a_series(self) -> None:
        payload = json.loads((ARTIFACTS / "power-climate-2026-07-01-2026-11-14.json").read_text(encoding="utf-8"))
        raw = payload["properties"]["parameter"]["PRECTOTCORR"]
        self.assertIn("20261112", raw)
        self.assertEqual(raw["20261112"], -999.0)
        parsed = power.parse(payload)
        self.assertNotIn(date(2026, 11, 12), parsed["PRECTOTCORR"])
        for series in parsed.values():
            self.assertTrue(all(value != -999.0 for value in series.values()))

    def test_r17_the_route_asks_the_recorded_transport_for_the_table_a_names(self) -> None:
        transport = ReplayTransport()
        payload = transport("GET", power.url(-55.27, -11.91, date(2026, 7, 15), date(2026, 11, 12), power.CLIMATE_PARAMETERS))
        self.assertEqual(payload.status_code, 200)
        self.assertEqual(set(payload.json()["properties"]["parameter"]), set(power.CLIMATE_PARAMETERS))


class SoilGridsReaderTests(unittest.TestCase):
    """R-31, R-32 and AC-30, AC-31, O-06."""

    def setUp(self) -> None:
        self.payload = json.loads((ARTIFACTS / "soilgrids-55.27--11.91.json").read_text(encoding="utf-8"))

    def test_ac30_values_reproduce_oracle_o06(self) -> None:
        values = soilgrids.parse(self.payload)
        self.assertEqual([values[("clay", d)]["value"] for d in soilgrids.DEPTHS], [225, 223, 265])
        self.assertEqual([values[("sand", d)]["value"] for d in soilgrids.DEPTHS], [635, 639, 601])
        self.assertEqual([values[("phh2o", d)]["value"] for d in soilgrids.DEPTHS], [5.0, 5.1, 5.1])
        self.assertEqual([values[("soc", d)]["value"] for d in soilgrids.DEPTHS], [22.2, 16.2, 9.1])

    def test_ac30_clay_is_converted_by_its_declared_target_unit_not_by_the_factor_alone(self) -> None:
        # The spec's R-31 text divides every mean by d_factor and prints g/kg. For clay and sand the
        # response declares mapped g/kg with target %, so dividing by d_factor gives 22.5, not 225.
        # The unit fields of the response decide the conversion; the spec error is flagged in the PR.
        self.assertEqual(soilgrids.parse(self.payload)[("clay", "0-5cm")]["value"], 225)

    def test_r32_a_missing_d_factor_abstains_its_rows_with_the_named_text(self) -> None:
        broken = json.loads(json.dumps(self.payload))
        for layer in broken["properties"]["layers"]:
            if layer["name"] == "soc":
                del layer["unit_measure"]["d_factor"]
        values = soilgrids.parse(broken)
        for depth in soilgrids.DEPTHS:
            self.assertIsNone(values[("soc", depth)]["value"])
            self.assertIn("d_factor", values[("soc", depth)]["reason"])
        self.assertEqual(values[("clay", "0-5cm")]["value"], 225)  # the other properties keep their values

    def test_r32_a_missing_property_and_a_missing_depth_each_abstain_their_own_rows(self) -> None:
        broken = json.loads(json.dumps(self.payload))
        broken["properties"]["layers"] = [l for l in broken["properties"]["layers"] if l["name"] != "sand"]
        for layer in broken["properties"]["layers"]:
            if layer["name"] == "clay":
                layer["depths"] = [d for d in layer["depths"] if d["label"] != "15-30cm"]
        values = soilgrids.parse(broken)
        self.assertIsNone(values[("sand", "0-5cm")]["value"])
        self.assertIn("sand", values[("sand", "0-5cm")]["reason"])
        self.assertIsNone(values[("clay", "15-30cm")]["value"])
        self.assertIn("15-30cm", values[("clay", "15-30cm")]["reason"])

    def test_r32_no_value_is_copied_between_depths_or_properties(self) -> None:
        broken = json.loads(json.dumps(self.payload))
        for layer in broken["properties"]["layers"]:
            if layer["name"] == "clay":
                layer["depths"] = [d for d in layer["depths"] if d["label"] != "5-15cm"]
        values = soilgrids.parse(broken)
        self.assertIsNone(values[("clay", "5-15cm")]["value"])
        self.assertNotEqual(values[("clay", "5-15cm")]["value"], values[("clay", "0-5cm")]["value"])

    def test_r32_the_module_carries_no_literal_ten_for_a_missing_factor(self) -> None:
        source = inspect.getsource(soilgrids)
        self.assertNotIn("d_factor\", 10", source)
        self.assertIsNone(re.search(r"\bor 10\b", source))


class SidraReaderTests(unittest.TestCase):
    """R-37, R-38 and AC-36, AC-37, O-07, O-08."""

    def test_ac36_state_series_reproduces_oracle_o07(self) -> None:
        payload = json.loads((ARTIFACTS / "sidra-n3-51.json").read_text(encoding="utf-8"))
        values = sidra.parse(payload, "51", range(2021, 2026))
        self.assertEqual(
            [values[y] for y in range(2021, 2026)],
            [10366601, 10925226, 11981285, 12383077, 12788611],
        )

    def test_ac36_municipality_series_reproduces_oracle_o08(self) -> None:
        payload = json.loads((ARTIFACTS / "sidra-n6-5107248.json").read_text(encoding="utf-8"))
        values = sidra.parse(payload, "5107248", range(2021, 2026))
        self.assertEqual([values[y] for y in range(2021, 2026)], [121000, 126000, 130000, 130000, 130000])

    def test_ac37_a_missing_year_abstains_that_year_only(self) -> None:
        payload = json.loads((ARTIFACTS / "sidra-n6-5107248.json").read_text(encoding="utf-8"))
        payload[0]["resultados"][0]["series"][0]["serie"]["2025"] = "..."
        values = sidra.parse(payload, "5107248", range(2021, 2026))
        self.assertIsNone(values[2025])
        self.assertEqual(values[2024], 130000)

    def test_r38_an_unresolved_code_is_an_error_not_a_guess(self) -> None:
        payload = json.loads((ARTIFACTS / "sidra-n6-5107248.json").read_text(encoding="utf-8"))
        with self.assertRaises(LookupError):
            sidra.parse(payload, "9999999", range(2021, 2026))

    def test_r37_the_url_is_api_v3_table_1612_variable_109_category_2713(self) -> None:
        url = sidra.url("N3", "51")
        self.assertIn("/api/v3/agregados/1612/", url)
        self.assertIn("variaveis/109", url)
        self.assertIn("classificacao=81%5B2713%5D", url)
        self.assertIn("N3%5B51%5D", url)


class Sentinel2ReaderTests(unittest.TestCase):
    """R-27, R-28, R-29, R-30 and AC-26, AC-29, O-09."""

    def test_ac26_search_body_carries_collection_ring_and_window(self) -> None:
        body = sentinel2.search_body(RING, date(2026, 10, 1), date(2026, 11, 11))
        self.assertEqual(body["collections"], ["sentinel-2-l2a"])
        self.assertEqual(body["intersects"]["type"], "Polygon")
        self.assertEqual(body["intersects"]["coordinates"][0][0], RING[0])
        self.assertEqual(body["datetime"], "2026-10-01T00:00:00Z/2026-11-11T23:59:59Z")

    def test_ac29_scene_count_and_clear_count_come_from_the_recorded_search(self) -> None:
        payload = json.loads((ARTIFACTS / "earth-search-2026-10-01-2026-11-11-ring.json").read_text(encoding="utf-8"))
        scenes = sentinel2.parse_scenes(payload)
        self.assertEqual(len(scenes), 13)
        self.assertEqual(sum(1 for s in scenes if s["cloud_cover"] < 20.0), sentinel2.clear_count(scenes))
        # Table E's ndvi `assets`: the parse keeps the addresses of the three assets beside the counts.
        self.assertTrue(all(set(s) == {"id", "date", "cloud_cover", "assets"} for s in scenes))
        self.assertTrue(all(sorted(s["assets"]) == ["B04", "B08", "SCL"] for s in scenes))

    def test_r28_clear_threshold_is_below_twenty_percent(self) -> None:
        scenes = [{"id": "a", "date": "2026-10-01", "cloud_cover": 19.99},
                  {"id": "b", "date": "2026-10-02", "cloud_cover": 20.0}]
        self.assertEqual(sentinel2.clear_count(scenes), 1)


class MapBiomasReaderTests(unittest.TestCase):
    """R-33, R-34, R-35, R-36 and AC-32, AC-33, AC-34, AC-35."""

    def test_ac33_a_code_alone_never_resolves_a_name(self) -> None:
        self.assertEqual(mapbiomas.class_for("agriculture_second_crop", 1), "Second crop corn")
        self.assertIsNone(mapbiomas.class_for("agriculture_first_crop", 1))
        self.assertEqual(mapbiomas.class_for("agriculture_first_crop", 41), "Other temporary crops")
        self.assertEqual(mapbiomas.class_for("agriculture_second_crop", 41), "Other second crop")
        self.assertNotEqual(mapbiomas.class_for("agriculture_first_crop", 62), mapbiomas.class_for("agriculture_second_crop", 62))

    def test_r34_table_d_carries_nine_first_crop_and_three_second_crop_classes(self) -> None:
        first = [k for k in mapbiomas.TABLE_D if k[0] == "agriculture_first_crop"]
        second = [k for k in mapbiomas.TABLE_D if k[0] == "agriculture_second_crop"]
        self.assertEqual(len(first), 9)
        self.assertEqual(len(second), 3)
        self.assertEqual(mapbiomas.class_for("agriculture_first_crop", 39), "Soybean")

    def test_r33_the_sidecar_key_is_polygon_product_year(self) -> None:
        with TemporaryDirectory() as temporary:
            db = Path(temporary) / "sidecar.sqlite"
            create_sidecar(db)
            connection = sqlite3.connect(db)
            try:
                columns = [row[1] for row in connection.execute("PRAGMA table_info(polygon_mapbiomas)")]
                pk = [row[1] for row in sorted(connection.execute("PRAGMA table_info(polygon_mapbiomas)"), key=lambda r: r[5]) if row[5]]
            finally:
                connection.close()
        self.assertEqual(
            columns,
            ["polygon_id", "region", "product", "code", "class_name", "year", "collection", "area_ha", "fraction", "basis", "source"],
        )
        self.assertEqual(pk, ["polygon_id", "product", "year"])

    def test_r33_the_module_makes_no_network_call(self) -> None:
        self.assertNotIn("httpx", inspect.getsource(mapbiomas))

    def test_r36_a_polygon_without_a_row_abstains_with_the_named_gap(self) -> None:
        with TemporaryDirectory() as temporary:
            db = Path(temporary) / "sidecar.sqlite"
            create_sidecar(db)
            section = mapbiomas.rotation_section(db, "trazo:777")
        self.assertEqual(section["state"], "abstained")
        self.assertEqual(section["gaps"][0]["cause"], "no MapBiomas Collection 11 row for this polygon")
        self.assertIsNone(section["first_crop"])
        self.assertIsNone(section["second_crop"])

    def test_r35_rows_cover_1985_to_2025_first_and_2000_to_2025_second(self) -> None:
        with TemporaryDirectory() as temporary:
            db = Path(temporary) / "sidecar.sqlite"
            create_sidecar(db, rows=fixture_rows("trazo:12345"))
            section = mapbiomas.rotation_section(db, "trazo:12345")
        first = section["first_crop"]
        second = section["second_crop"]
        self.assertEqual([r["year"] for r in first], list(range(1985, 2026)))
        self.assertEqual([r["year"] for r in second], list(range(2000, 2026)))
        self.assertEqual(section["collection"], "MapBiomas Collection 11")

    def test_r35_a_class_with_null_code_is_a_gap_naming_the_missing_class_never_a_zero(self) -> None:
        with TemporaryDirectory() as temporary:
            db = Path(temporary) / "sidecar.sqlite"
            create_sidecar(db, rows=fixture_rows("trazo:999", classes=False))
            section = mapbiomas.rotation_section(db, "trazo:999")
        self.assertEqual(section["state"], "abstained")
        self.assertIsNone(section["first_crop"][0]["class_name"])
        self.assertTrue(any("class" in gap["cause"] for gap in section["gaps"]))
        self.assertFalse(any(row["class_name"] == 0 for row in section["first_crop"]))

    def test_r36_an_absent_sidecar_file_is_unavailable_with_the_path(self) -> None:
        section = mapbiomas.rotation_section(Path("/nonexistent/polygon-mapbiomas.sqlite"), "trazo:1")
        self.assertEqual(section["state"], "unavailable")
        self.assertIn("/nonexistent/polygon-mapbiomas.sqlite", section["error"])
        self.assertEqual(len(section["gaps"]), 1)

    def test_artifact_fixture_covers_the_ok_null_class_and_no_row_paths(self) -> None:
        """The pinned three polygon fixture of the spec: ok, class missing, and no row at all."""
        db = ARTIFACTS / "polygon-mapbiomas-fixture.sqlite"
        self.assertEqual(mapbiomas.rotation_section(db, "trazo:12345")["state"], "ok")
        missing = mapbiomas.rotation_section(db, "trazo:67890")
        self.assertEqual(missing["state"], "abstained")
        self.assertTrue(any("class" in gap["cause"] for gap in missing["gaps"]))
        none = mapbiomas.rotation_section(db, "trazo:777")
        self.assertEqual(none["gaps"][0]["cause"], "no MapBiomas Collection 11 row for this polygon")


if __name__ == "__main__":
    unittest.main()
