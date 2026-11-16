"""Block 6 wave 1: the pure rules (window, aggregates, normals, water balance, fragment).

Every test reads the recorded POWER responses under artifacts/block6 and never the network.
Rule ids in the names point at specs/bloco-6-numeros-por-poligono.md.
"""

from __future__ import annotations

import json
import math
import unittest
from datetime import date, timedelta
from pathlib import Path

import aggregates as agg
import water_balance as wb
from field_numbers import area_of_ring_m2, ring_fragment_check
from sources import power

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts" / "block6"
CHOSEN = date(2026, 11, 12)


def recorded_climate() -> dict:
    payload = json.loads((ARTIFACTS / "power-climate-2026-07-01-2026-11-14.json").read_text(encoding="utf-8"))
    return power.parse(payload)


def recorded_normals() -> dict:
    payload = json.loads((ARTIFACTS / "power-normals-1991-2025.json").read_text(encoding="utf-8"))
    return power.parse(payload)


def window_for(chosen: date = CHOSEN) -> agg.Window:
    window = agg.resolve_window(recorded_climate()["PRECTOTCORR"], chosen)
    assert window is not None
    return window


def synthetic_window(days: int = 42, end: date = date(2026, 11, 11)) -> agg.Window:
    start = end - timedelta(days=days - 1)
    return agg.Window(start=start, end=end, days=days, valid_days=days, dropped_days=0, chosen=end)


class WindowRuleTests(unittest.TestCase):
    """R-16 and AC-15."""

    def test_r16_window_is_42_days_ending_on_the_last_valid_rain_day(self) -> None:
        window = window_for(CHOSEN)
        self.assertEqual(window.start, date(2026, 10, 1))
        self.assertEqual(window.end, date(2026, 11, 11))
        self.assertEqual(window.days, 42)
        self.assertEqual(window.valid_days, 42)

    def test_r16_dropped_days_count_the_unconsolidated_days_after_the_window_end(self) -> None:
        # Spec AC-15 and Table B print dropped_days 0 for 2026-11-12. The R-16 rule (the days after
        # the last consolidated day, up to and including the chosen date) gives 1 there, because
        # 2026-11-12 itself carries -999. The rule wins; the discrepancy is flagged in the PR.
        self.assertEqual(window_for(date(2026, 11, 12)).dropped_days, 1)
        self.assertEqual(window_for(date(2026, 11, 14)).dropped_days, 3)

    def test_ac15_chosen_2026_10_20_resolves_to_the_42_days_before_it(self) -> None:
        window = window_for(date(2026, 10, 20))
        self.assertEqual((window.start, window.end), (date(2026, 9, 9), date(2026, 10, 20)))
        self.assertEqual((window.valid_days, window.dropped_days), (42, 0))

    def test_r16_window_never_includes_a_fill_rain_day(self) -> None:
        rain = recorded_climate()["PRECTOTCORR"]
        window = window_for(date(2026, 11, 14))
        self.assertLessEqual(window.end, date(2026, 11, 11))
        for day in agg.window_days(window):
            self.assertIn(day, rain)
            self.assertNotEqual(rain[day], -999.0)

    def test_r16_no_consolidated_rain_day_in_the_lookback_gives_no_window(self) -> None:
        rain = {date(2026, 1, 1) + timedelta(days=i): -999.0 for i in range(200)}
        self.assertIsNone(agg.resolve_window(rain, date(2026, 7, 1)))


class AggregateTests(unittest.TestCase):
    """R-18, R-19 and AC-17, AC-18."""

    def test_r18_six_aggregates_reproduce_oracle_o01(self) -> None:
        climate = recorded_climate()
        window = window_for()
        rain_total, rain_valid = agg.rain_total(climate["PRECTOTCORR"], window)
        dry, _ = agg.dry_spell_days(climate["PRECTOTCORR"], window)
        gdd, _ = agg.gdd10(climate["T2M_MAX"], climate["T2M_MIN"], window)
        frost, _ = agg.frost_days(climate["FROST_DAYS"], window)
        tmin, _ = agg.tmin_min(climate["T2M_MIN"], window)
        root, _ = agg.gwetroot_mean(climate["GWETROOT"], window)
        self.assertEqual((rain_total, rain_valid), (171.9, 42))
        self.assertEqual(dry, 7)
        self.assertEqual(gdd, 836)
        self.assertEqual(frost, 0)
        self.assertEqual(tmin, 21.8)
        self.assertEqual(root, 0.49)

    def test_r18_formulas_on_a_hand_computed_three_day_series(self) -> None:
        window = synthetic_window(days=3, end=date(2026, 11, 3))
        rain = {date(2026, 11, 1): 0.0, date(2026, 11, 2): 0.5, date(2026, 11, 3): 4.0}
        tmax = {date(2026, 11, 1): 34.0, date(2026, 11, 2): 36.0, date(2026, 11, 3): 30.0}
        tmin = {date(2026, 11, 1): 20.0, date(2026, 11, 2): 22.0, date(2026, 11, 3): 18.0}
        self.assertEqual(agg.rain_total(rain, window)[0], 4.5)
        self.assertEqual(agg.dry_spell_days(rain, window)[0], 2)  # 0.0 and 0.5 are both below 1.0
        # day 1: (34+20)/2-10=17; day 2: (36+22)/2-10=19; day 3: (30+18)/2-10=14; sum 50
        self.assertEqual(agg.gdd10(tmax, tmin, window)[0], 50)
        self.assertEqual(agg.tmin_min(tmin, window)[0], 18.0)
        self.assertEqual(agg.hot_days(tmax, window)[0], 1)  # only 36.0 is at or above 35

    def test_r19_thirty_three_valid_days_abstains_the_growing_degree_days(self) -> None:
        window = synthetic_window()
        tmax = {window.start + timedelta(days=i): 30.0 for i in range(33)}
        tmin = {window.start + timedelta(days=i): 18.0 for i in range(42)}
        rain = {window.start + timedelta(days=i): 2.0 for i in range(42)}
        value, valid = agg.gdd10(tmax, tmin, window)
        self.assertIsNone(value)
        self.assertEqual(valid, 33)
        self.assertEqual(agg.rain_total(rain, window)[0], 84.0)  # the rain aggregate still prints

    def test_r19_thirty_four_valid_days_prints_with_its_valid_count(self) -> None:
        window = synthetic_window()
        tmax = {window.start + timedelta(days=i): 30.0 for i in range(34)}
        tmin = {window.start + timedelta(days=i): 18.0 for i in range(34)}
        value, valid = agg.gdd10(tmax, tmin, window)
        self.assertIsNotNone(value)
        self.assertEqual(valid, 34)

    def test_r18_rounding_is_half_up_at_the_table_decimals(self) -> None:
        self.assertEqual(agg.round_half_up(2.45, 1), 2.5)
        self.assertEqual(agg.round_half_up(0.125, 2), 0.13)
        self.assertEqual(agg.round_half_up(171.93, 1), 171.9)
        self.assertEqual(agg.round_half_up(836.46, 0), 836)
        self.assertEqual(agg.round_half_up(2.5, 0), 3)

    def test_r17_fill_value_never_reaches_an_aggregate(self) -> None:
        window = synthetic_window()
        # power.parse drops -999 before any arithmetic, so a fill day arrives as an absent key.
        rain = {window.start + timedelta(days=i): 1.0 for i in range(42)}
        del rain[window.start + timedelta(days=5)]
        value, valid = agg.rain_total(rain, window)
        self.assertEqual((value, valid), (41.0, 41))
        self.assertTrue(all(v != -999.0 for v in rain.values()))

    def test_r19_hot_days_counts_at_or_above_35(self) -> None:
        window = window_for()
        tmax = recorded_climate()["T2M_MAX"]
        count, valid = agg.hot_days(tmax, window)
        self.assertEqual(valid, 42)
        self.assertEqual(count, sum(1 for d in agg.window_days(window) if tmax[d] >= 35.0))


class NormalsTests(unittest.TestCase):
    """R-20 and AC-19, O-03, O-04, O-05."""

    def setUp(self) -> None:
        self.window = window_for()
        normals = recorded_normals()
        self.rain_by_year = {}
        self.tmax_by_year = {}
        for year in range(1991, 2026):
            self.rain_by_year[year] = {d: v for d, v in normals["PRECTOTCORR"].items() if d.year == year}
            self.tmax_by_year[year] = {d: v for d, v in normals["T2M_MAX"].items() if d.year == year}

    def test_r20_normals_reproduce_oracles_o03_o04_o05(self) -> None:
        totals = agg.normal_totals(self.rain_by_year, self.window, years=range(1991, 2026))
        self.assertEqual(len(totals.included), 35)
        self.assertEqual(agg.round_half_up(agg.median(totals.included.values()), 1), 224.9)
        self.assertEqual(agg.round_half_up(min(totals.included.values()), 1), 88.9)
        self.assertEqual(agg.round_half_up(max(totals.included.values()), 1), 389.7)
        current_total, _ = agg.rain_total(recorded_climate()["PRECTOTCORR"], self.window)
        rank = agg.rank_of(current_total, totals.included)
        self.assertEqual(rank, 7)
        self.assertEqual(agg.percentile_rank(rank, len(totals.included)), 20)
        earlier_below = sorted(y for y, t in totals.included.items() if t < current_total)
        self.assertEqual(earlier_below, [1996, 1997, 2014, 2015, 2016, 2020, 2025])
        counts = agg.hot_counts(self.tmax_by_year, self.window, years=range(1991, 2026))
        self.assertEqual(agg.round_half_up(agg.median(counts.included.values()), 0), 17)

    def test_r20_percentile_is_round_of_100_rank_over_years(self) -> None:
        self.assertEqual(agg.percentile_rank(7, 35), 20)
        self.assertEqual(agg.percentile_rank(0, 35), 0)
        self.assertEqual(agg.percentile_rank(35, 35), 100)

    def test_r20_year_with_a_fill_day_in_its_window_is_excluded_and_counted(self) -> None:
        broken = {year: dict(series) for year, series in self.rain_by_year.items()}
        victim = date(1999, 10, 15)
        del broken[1999][victim]
        totals = agg.normal_totals(broken, self.window, years=range(1991, 2026))
        self.assertEqual(totals.excluded, [1999])
        self.assertEqual(len(totals.included), 34)

    def test_r20_a_window_ending_on_29_february_clamps_in_a_non_leap_year(self) -> None:
        # A window built from 1992, which is a leap year, replayed over 1991, which is not. Before
        # the clamp this raised ValueError("day 29 must be in range 1..28 for month 2 in year 1991")
        # inside _calendar_window, so the route answered 500 and the request hung the process.
        window = agg.Window(start=date(1992, 1, 19), end=date(1992, 2, 29), days=42, valid_days=42,
                            dropped_days=0, chosen=date(1992, 2, 29))
        days = agg._calendar_window(window, 1991)
        self.assertEqual(days[0], date(1991, 1, 19))
        self.assertEqual(days[-1], date(1991, 2, 28))
        self.assertEqual(len(days), 41)
        totals = agg.normal_totals({}, window, years=[1991])
        self.assertEqual(totals.excluded, [1991])

    def test_r20_a_window_starting_on_29_february_clamps_in_a_non_leap_year(self) -> None:
        # The other endpoint: the start clamps to 28 February and the end is untouched, so the span
        # keeps its 42 days.
        window = agg.Window(start=date(1992, 2, 29), end=date(1992, 4, 10), days=42, valid_days=42,
                            dropped_days=0, chosen=date(1992, 4, 10))
        days = agg._calendar_window(window, 1991)
        self.assertEqual(days[0], date(1991, 2, 28))
        self.assertEqual(days[-1], date(1991, 4, 10))
        self.assertEqual(len(days), 42)
        totals = agg.normal_totals({}, window, years=[1991])
        self.assertEqual(totals.excluded, [1991])

    def test_r20_a_window_crossing_the_new_year_ends_in_the_next_year(self) -> None:
        # The one pair that clamps backwards: a December start and a January end both land in the
        # replay year, so the end moves to the following year rather than the span collapsing.
        window = agg.Window(start=date(2026, 12, 1), end=date(2027, 1, 11), days=42, valid_days=42,
                            dropped_days=0, chosen=date(2027, 1, 11))
        days = agg._calendar_window(window, 1991)
        self.assertEqual(days[0], date(1991, 12, 1))
        self.assertEqual(days[-1], date(1992, 1, 11))
        self.assertEqual(len(days), 42)

    def test_r20_rank_abstains_when_the_current_window_is_incomplete(self) -> None:
        incomplete = agg.Window(start=date(2026, 10, 1), end=date(2026, 11, 11), days=42, valid_days=41,
                                dropped_days=0, chosen=date(2026, 11, 11))
        self.assertIsNone(agg.rank_for_window(incomplete, 10.0, {1991: 1.0}))


class WaterBalanceTests(unittest.TestCase):
    """R-22, R-23, R-24 and AC-21, AC-22."""

    def setUp(self) -> None:
        self.window = window_for()
        climate = recorded_climate()
        self.rain = climate["PRECTOTCORR"]
        self.evland = climate["EVLAND"]

    def test_r22_three_numbers_in_mm_from_the_recorded_window(self) -> None:
        result = wb.water_balance(self.rain, self.evland, self.window)
        self.assertTrue(result["ok"])
        self.assertEqual(result["in"], 171.9)
        expected_out = agg.round_half_up(sum(self.evland[d] for d in agg.window_days(self.window)), 1)
        self.assertEqual(result["out"], expected_out)
        self.assertEqual(result["remaining"], agg.round_half_up(
            sum(self.rain[d] for d in agg.window_days(self.window))
            - sum(self.evland[d] for d in agg.window_days(self.window)), 1))
        self.assertEqual(set(result), {"ok", "in", "out", "remaining", "missing"})

    def test_r23_one_missing_evland_day_abstains_the_whole_balance(self) -> None:
        evland = dict(self.evland)
        del evland[self.window.start + timedelta(days=10)]
        result = wb.water_balance(self.rain, evland, self.window)
        self.assertFalse(result["ok"])
        self.assertIsNone(result["in"])
        self.assertIsNone(result["out"])
        self.assertIsNone(result["remaining"])
        self.assertEqual(result["missing"], {"PRECTOTCORR": 0, "EVLAND": 1})

    def test_r23_the_balance_has_no_input_from_smap(self) -> None:
        import inspect

        self.assertEqual(list(inspect.signature(wb.water_balance).parameters), ["rain", "evland", "window"])


class FragmentTests(unittest.TestCase):
    """R-50 and AC-49: a ring whose area differs from the polygon's by more than 5 percent is a fragment."""

    def test_ac49_ten_point_seven_percent_difference_is_a_fragment(self) -> None:
        ring = ring_with_area_ha(20.0)
        check = ring_fragment_check(ring, 22.4)
        self.assertTrue(check["is_fragment"])
        self.assertAlmostEqual(check["ring_area_ha"], 20.0, places=1)
        self.assertAlmostEqual(check["difference_percent"], 10.7, places=1)

    def test_ac49_one_point_eight_percent_difference_is_not_a_fragment(self) -> None:
        ring = ring_with_area_ha(22.0)
        check = ring_fragment_check(ring, 22.4)
        self.assertFalse(check["is_fragment"])
        self.assertAlmostEqual(check["difference_percent"], 1.8, places=1)

    def test_r50_without_a_polygon_area_the_check_is_null(self) -> None:
        check = ring_fragment_check(ring_with_area_ha(22.0), None)
        self.assertIsNone(check["is_fragment"])
        self.assertIsNone(check["difference_percent"])

    def test_area_of_ring_is_spherical_and_orientation_free(self) -> None:
        ring = ring_with_area_ha(22.4)
        self.assertAlmostEqual(area_of_ring_m2(ring) / 10000.0, 22.4, places=2)
        self.assertAlmostEqual(area_of_ring_m2(list(reversed(ring))) / 10000.0, 22.4, places=2)


def ring_with_area_ha(target_ha: float) -> list[list[float]]:
    """A square ring centred near the fixture point whose spherical area is target_ha."""
    lat0 = -11.91
    radius = 6378137.0
    lo, hi = 1e-5, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2
        ring = _square(lat0, mid)
        if area_of_ring_m2(ring) / 10000.0 < target_ha:
            lo = mid
        else:
            hi = mid
    return _square(lat0, (lo + hi) / 2)


def _square(lat0: float, half: float) -> list[list[float]]:
    lat_half = half
    return [
        [-55.27 - half, lat0 - lat_half],
        [-55.27 + half, lat0 - lat_half],
        [-55.27 + half, lat0 + lat_half],
        [-55.27 - half, lat0 + lat_half],
    ]


if __name__ == "__main__":
    unittest.main()
