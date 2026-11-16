"""Experiment (not a frozen block): crop water demand from NASA POWER, FAO-56.

The oracles are the worked examples printed in FAO Irrigation and Drainage Paper 56 (Allen, Pereira,
Raes and Smith, 1998). Each test names the example it reproduces. The recorded transport is the
POWER response in artifacts/experiment, so no test reads the network.
"""

from __future__ import annotations

import json
import math
import unittest
from datetime import date, timedelta
from pathlib import Path

import aggregates as agg
import crop_water as cw
from sources import power_et0

ARTIFACT = Path(__file__).resolve().parent.parent / "artifacts" / "experiment" / \
    "power-et0-inputs-2026-07-01-2026-11-14.json"


class Fao56Oracles(unittest.TestCase):
    """The equations, each against the number FAO-56 prints."""

    def test_example_2_pressure_and_psychrometric_constant(self):
        pressure = cw.atmospheric_pressure(1800.0)
        self.assertAlmostEqual(pressure, 81.8, places=1)
        self.assertAlmostEqual(cw.psychrometric_constant(pressure), 0.054, places=3)

    def test_example_3_saturation_vapour_pressure(self):
        self.assertAlmostEqual(cw.saturation_vapour_pressure(24.5), 3.075, places=3)
        self.assertAlmostEqual(cw.saturation_vapour_pressure(15.0), 1.705, places=3)
        self.assertAlmostEqual(cw.mean_saturation_vapour_pressure(24.5, 15.0), 2.39, places=2)

    def test_example_8_extraterrestrial_radiation_southern_hemisphere(self):
        # 20 degrees south, 3 September (day 246): Ra = 32.2 MJ m-2 day-1.
        self.assertAlmostEqual(cw.extraterrestrial_radiation(-20.0, 246), 32.2, places=1)

    def test_example_18_penman_monteith_daily(self):
        # Brussels, 50 deg 48 min N, 100 m, 6 July (day 187).
        ra = cw.extraterrestrial_radiation(50.8, 187)
        self.assertAlmostEqual(ra, 41.09, delta=0.02)
        rso = cw.clear_sky_radiation(ra, 100.0)
        self.assertAlmostEqual(rso, 30.90, delta=0.02)
        rnl = cw.net_longwave_radiation(21.5, 12.3, 1.409, 22.07, rso)
        self.assertAlmostEqual(rnl, 3.71, delta=0.02)
        self.assertAlmostEqual(cw.slope_saturation_vapour_pressure(16.9), 0.122, places=3)
        et0 = cw.et0_penman_monteith(tmax=21.5, tmin=12.3, rs=22.07, ea=1.409, u2=2.078, ra=ra,
                                     pressure=cw.atmospheric_pressure(100.0), elevation=100.0)
        self.assertAlmostEqual(et0, 3.9, delta=0.05)

    def test_example_18_actual_vapour_pressure_from_humidity_and_dew_point(self):
        # Example 5's dew point route and Example 18's own ea.
        self.assertAlmostEqual(cw.actual_vapour_pressure_from_dew_point(17.0), 1.938, places=3)
        ea = cw.actual_vapour_pressure_from_rh_mean(rh_mean=73.5, tmax=21.5, tmin=12.3)
        self.assertAlmostEqual(ea, 0.735 * (2.564 + 1.431) / 2, places=3)

    def test_hargreaves_eq_52_by_hand(self):
        # 0.0023 * (16.9 + 17.8) * sqrt(9.2) * 0.408 * 41.09, worked by hand: 4.06 mm/day.
        self.assertAlmostEqual(cw.et0_hargreaves(21.5, 12.3, 41.09), 4.06, delta=0.01)

    def test_crop_coefficient_curve_eq_66(self):
        crop = cw.CROPS["soybean"]
        stages = (15, 15, 40, 15)
        self.assertIsNone(cw.crop_coefficient(crop, 0, stages))
        self.assertEqual(cw.crop_coefficient(crop, 1, stages), crop["kc_ini"])
        self.assertEqual(cw.crop_coefficient(crop, 15, stages), crop["kc_ini"])
        middle_of_development = cw.crop_coefficient(crop, 22, stages)
        self.assertGreater(middle_of_development, crop["kc_ini"])
        self.assertLess(middle_of_development, crop["kc_mid"])
        self.assertEqual(cw.crop_coefficient(crop, 40, stages), crop["kc_mid"])
        self.assertAlmostEqual(cw.crop_coefficient(crop, 85, stages), crop["kc_end"])
        self.assertIsNone(cw.crop_coefficient(crop, 86, stages))

    def test_example_28_crop_coefficient_uses_fao_one_based_days(self):
        crop = {"kc_ini": 0.15, "kc_mid": 1.19, "kc_end": 0.35}
        stages = (25, 25, 30, 20)
        self.assertAlmostEqual(cw.crop_coefficient(crop, 20, stages), 0.15)
        self.assertAlmostEqual(cw.crop_coefficient(crop, 40, stages), 0.77, places=2)
        self.assertAlmostEqual(cw.crop_coefficient(crop, 70, stages), 1.19)
        self.assertAlmostEqual(cw.crop_coefficient(crop, 95, stages), 0.56, places=2)

    def test_the_crop_table_cites_its_source(self):
        for crop in cw.CROPS.values():
            self.assertIn("FAO-56 Table 12", crop["source"])


def _flat(days: list[date], **values: float) -> dict[str, dict[date, float]]:
    return {name: {d: value for d in days} for name, value in values.items()}


class DailyMethodAndWindow(unittest.TestCase):
    """The per-day method, block 6 R-19 coverage and the climatic difference."""

    def setUp(self):
        self.end = date(2026, 11, 11)
        self.days = [self.end - timedelta(days=i) for i in range(60)]
        self.series = _flat(self.days, T2M_MAX=32.0, T2M_MIN=22.0, T2MDEW=20.0, RH2M=70.0, WS2M=1.5,
                            ALLSKY_SFC_SW_DWN=20.0, PS=96.9, PRECTOTCORR=3.0)
        self.window = agg.resolve_window(self.series["PRECTOTCORR"], self.end)

    def test_penman_monteith_when_every_input_is_valid(self):
        daily = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)
        self.assertEqual({d["method"] for d in daily}, {"penman-monteith"})
        self.assertEqual(len(daily), 42)

    def test_hargreaves_only_on_the_day_radiation_is_missing(self):
        del self.series["ALLSKY_SFC_SW_DWN"][self.end - timedelta(days=3)]
        daily = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)
        methods = [d["method"] for d in daily]
        self.assertEqual(methods.count("hargreaves"), 1)
        self.assertEqual(methods.count("penman-monteith"), 41)

    def test_a_day_without_temperature_has_no_value(self):
        del self.series["T2M_MAX"][self.end]
        daily = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)
        last = daily[-1]
        self.assertIsNone(last["et0"])
        self.assertIsNone(last["method"])

    def test_crop_water_difference_is_rain_minus_crop_demand(self):
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="soybean")
        self.assertEqual(result["state"], "ok")
        self.assertAlmostEqual(result["rain_total"], 126.0)
        self.assertAlmostEqual(result["climatic_difference"],
                               agg.round_half_up(result["rain_total"] - result["etc_total"], 1))
        self.assertAlmostEqual(result["etc_total"], agg.round_half_up(result["et0_total"] * 1.15, 1), delta=0.1)
        self.assertEqual(result["kc_mode"], "mid-season")

    def test_abstains_below_80_percent_coverage(self):
        for offset in range(9):  # 33 of 42 valid days is 78.6 percent
            del self.series["T2M_MAX"][self.end - timedelta(days=offset)]
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="maize")
        self.assertEqual(result["state"], "abstained")
        self.assertIsNone(result["etc_total"])
        self.assertIsNone(result["climatic_difference"])
        self.assertIn("below 80 percent", result["reason"])

    def test_rain_gap_abstains_the_difference_but_not_the_demand(self):
        del self.series["PRECTOTCORR"][self.end - timedelta(days=5)]
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="cotton")
        self.assertIsNotNone(result["etc_total"])
        self.assertIsNone(result["climatic_difference"])

    def test_sowing_date_uses_the_kc_curve_and_requires_stage_lengths(self):
        with self.assertRaises(ValueError):
            cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                          crop_id="soybean", sowing=self.window.start)
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="soybean", sowing=self.window.start, stages=(15, 15, 40, 15))
        self.assertEqual(result["kc_mode"], "curve from sowing")
        mid = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                            crop_id="soybean")
        self.assertLess(result["etc_total"], mid["etc_total"])

    def test_invalid_temperature_order_abstains_that_day(self):
        self.series["T2M_MAX"][self.end] = 10.0
        self.series["T2M_MIN"][self.end] = 20.0
        row = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)[-1]
        self.assertIsNone(row["et0"])
        self.assertIsNone(row["method"])
        self.assertIn("tmax", row["reason"])

    def test_invalid_dew_point_uses_valid_rh_and_records_the_substitution(self):
        self.series["T2MDEW"][self.end] = 40.0
        row = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)[-1]
        self.assertEqual(row["method"], "penman-monteith")
        self.assertIn("RH2M used instead", row["reason"])

    def test_negative_radiation_uses_explicit_hargreaves_fallback(self):
        self.series["ALLSKY_SFC_SW_DWN"][self.end] = -1.0
        row = cw.daily_et0(self.series, latitude=-11.91, elevation=354.0, window=self.window)[-1]
        self.assertEqual(row["method"], "hargreaves")
        self.assertIn("invalid Penman-Monteith input", row["reason"])

    def test_sowing_after_the_window_abstains_instead_of_inventing_a_stage(self):
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="soybean", sowing=self.window.end + timedelta(days=1),
                               stages=(15, 15, 40, 15))
        self.assertEqual(result["state"], "abstained")
        self.assertEqual(result["valid_days"], 0)

    def test_provenance_rows_follow_the_block_6_row_shape(self):
        result = cw.crop_water(self.series, latitude=-11.91, elevation=354.0, window=self.window,
                               crop_id="soybean")
        keys = {"metric", "label", "value", "unit", "basis", "as_of", "source", "resolution", "route",
                "fetched_at"}
        self.assertTrue(result["provenance"])
        for row in result["provenance"]:
            self.assertEqual(set(row), keys)
            self.assertEqual(row["basis"], "modelled")


class DomainAndExtremeCases(unittest.TestCase):
    def test_polar_latitudes_are_finite_and_non_negative(self):
        for latitude, day_of_year in ((89.999999, 172), (-89.999999, 355)):
            value = cw.extraterrestrial_radiation(latitude, day_of_year)
            self.assertTrue(math.isfinite(value))
            self.assertGreaterEqual(value, 0.0)

    def test_out_of_range_latitude_and_day_are_rejected(self):
        with self.assertRaises(ValueError):
            cw.extraterrestrial_radiation(90.1, 100)
        with self.assertRaises(ValueError):
            cw.extraterrestrial_radiation(0.0, 0)

    def test_zero_clear_sky_radiation_is_not_silently_treated_as_clear_sky(self):
        with self.assertRaises(ValueError):
            cw.net_longwave_radiation(10.0, 0.0, 0.5, 0.0, 0.0)

    def test_relative_humidity_outside_zero_to_one_hundred_is_rejected(self):
        for rh in (-0.1, 100.1):
            with self.assertRaises(ValueError):
                cw.actual_vapour_pressure_from_rh_mean(rh, 30.0, 20.0)

    def test_zero_wind_is_valid_but_negative_wind_is_rejected(self):
        kwargs = dict(tmax=30.0, tmin=20.0, rs=20.0, ea=2.0, ra=30.0, pressure=95.0,
                      elevation=300.0)
        self.assertGreaterEqual(cw.et0_penman_monteith(u2=0.0, **kwargs), 0.0)
        with self.assertRaises(ValueError):
            cw.et0_penman_monteith(u2=-0.1, **kwargs)

    def test_negative_temperatures_do_not_produce_negative_et0(self):
        self.assertEqual(cw.et0_hargreaves(-20.0, -30.0, 5.0), 0.0)

    def test_tmax_below_tmin_is_rejected(self):
        with self.assertRaises(ValueError):
            cw.et0_hargreaves(10.0, 20.0, 30.0)

    def test_invalid_stage_lengths_are_rejected(self):
        for stages in ((15, 0, 40, 15), (15, -1, 40, 15), (15.0, 15, 40, 15)):
            with self.assertRaises(ValueError):
                cw.crop_coefficient(cw.CROPS["soybean"], 20, stages)


class RecordedSantaCarmem(unittest.TestCase):
    """The recorded POWER response at the Santa Carmem fixture centroid (block 6 O-02)."""

    @classmethod
    def setUpClass(cls):
        payload = json.loads(ARTIFACT.read_text())
        cls.series = power_et0.parse(payload)
        cls.lon, cls.lat, cls.elevation = power_et0.point(payload)
        cls.window = agg.resolve_window(cls.series["PRECTOTCORR"], date(2026, 11, 14))

    def test_the_window_matches_block_6(self):
        self.assertEqual(self.window.end, date(2026, 11, 11))
        self.assertEqual(self.window.days, 42)
        self.assertAlmostEqual(self.elevation, 354.49)

    def test_the_demand_separates_crops_where_the_rain_percentile_cannot(self):
        results = {c: cw.crop_water(self.series, latitude=self.lat, elevation=self.elevation,
                                    window=self.window, crop_id=c) for c in ("soybean", "maize", "cotton")}
        for result in results.values():
            self.assertEqual(result["state"], "ok")
        totals = {c: r["etc_total"] for c, r in results.items()}
        self.assertGreater(totals["maize"], totals["soybean"])
        # Finding: at peak demand soybean and cotton share Kc mid 1.15 (cotton's lower bound), so the
        # mid-season mode cannot separate them; only the eq. 66 curve with stage lengths can.
        self.assertEqual(totals["soybean"], totals["cotton"])

    def test_the_kc_curve_separates_soybean_and_cotton(self):
        sowing = self.window.start
        soy = cw.crop_water(self.series, latitude=self.lat, elevation=self.elevation, window=self.window,
                            crop_id="soybean", sowing=sowing, stages=(15, 15, 40, 15))
        cotton = cw.crop_water(self.series, latitude=self.lat, elevation=self.elevation, window=self.window,
                               crop_id="cotton", sowing=sowing, stages=(15, 15, 40, 15))
        self.assertNotEqual(soy["etc_total"], cotton["etc_total"])

    def test_daily_reference_et_is_plausible_for_the_cerrado_dry_to_wet_transition(self):
        daily = cw.daily_et0(self.series, latitude=self.lat, elevation=self.elevation, window=self.window)
        values = [d["et0"] for d in daily if d["et0"] is not None]
        mean = sum(values) / len(values)
        self.assertGreater(mean, 3.0)
        self.assertLess(mean, 7.5)
        fallback = [d["date"] for d in daily if d["method"] == "hargreaves"]
        self.assertEqual(fallback, ["2026-11-05", "2026-11-11"])  # ALLSKY_SFC_SW_DWN is a fill value


class PowerEt0Source(unittest.TestCase):
    def test_url_asks_for_the_agroclimatology_community_and_every_input(self):
        url = power_et0.url(-55.27, -11.91, date(2026, 7, 1), date(2026, 11, 14))
        self.assertIn("community=AG", url)
        self.assertIn("time-standard=LST", url)
        for name in power_et0.PARAMETERS:
            self.assertIn(name, url)

    def test_parse_drops_the_fill_value(self):
        payload = json.loads(ARTIFACT.read_text())
        series = power_et0.parse(payload)
        self.assertNotIn(date(2026, 11, 5), series["ALLSKY_SFC_SW_DWN"])
        self.assertIn(date(2026, 11, 4), series["ALLSKY_SFC_SW_DWN"])

    def test_recorded_payload_has_the_expected_units_time_and_point(self):
        payload = json.loads(ARTIFACT.read_text())
        self.assertEqual(power_et0.validate_payload(payload), [])
        self.assertEqual(power_et0.check_units(payload), [])
        self.assertEqual(power_et0.point(payload), (-55.27, -11.91, 354.49))


if __name__ == "__main__":
    unittest.main()
