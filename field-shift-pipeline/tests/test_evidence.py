"""Tests for the pure evidence functions (pipeline/evidence.py)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pipeline import evidence as ev

RAIN_CFG = {"wet_day_mm": 1.0, "heavy_day_mm": 20.0, "rx_window_days": 5}


def test_crop_year_is_labelled_by_harvest_year():
    d = pd.Series(pd.to_datetime(["2015-06-30", "2015-07-01", "2016-01-15"]))
    assert ev.crop_year(d).tolist() == [2015, 2016, 2016]


@pytest.mark.parametrize("rain,expected", [
    ([5, 0, 0, 0, 5], 3),
    ([0.9, 0.5, 1.0, 0], 2),  # 1.0 mm is a wet day (ETCCDI)
    ([5, 5, 5], 0),
    ([], 0),
])
def test_max_dry_spell(rain, expected):
    assert ev.max_dry_spell(rain, 1.0) == expected


def test_rain_indices():
    r = pd.Series([0, 25, 0, 0, 30, 1, 1, 0])
    out = ev.rain_indices(r, RAIN_CFG)
    assert out["rain_mm"] == 57
    assert out["r20_days"] == 2
    assert out["cdd_days"] == 2
    assert out["rx5_mm"] == 56  # 25 + 0 + 0 + 30 + 1


def _daily(start: str, end: str, rain: float = 2.0) -> pd.DataFrame:
    dates = pd.date_range(start, end)
    return pd.DataFrame({"code": 1, "date": dates, "PRECTOTCORR": rain,
                         "GWETROOT": 0.5, "T2M_MAX": 30.0})


class TestSeasonalClimate:
    MONTHS = [9, 10, 11, 12, 1, 2, 3, 4]
    SUBS = {"early": [9, 10, 11, 12], "late": [1, 2, 3, 4]}

    def test_full_season_gets_a_row_with_right_totals(self):
        out = ev.seasonal_climate(_daily("2015-07-01", "2016-06-30"), self.MONTHS, self.SUBS, RAIN_CFG)
        row = out.set_index("crop_year").loc[2016]
        assert row.season_rain_mm == pytest.approx(2.0 * 243)  # Sep 2015-Apr 2016, leap year
        assert row.early_rain_mm == pytest.approx(2.0 * 122)

    def test_partial_season_is_dropped_not_reported_as_drought(self):
        out = ev.seasonal_climate(_daily("2026-07-01", "2026-11-11"), self.MONTHS, self.SUBS, RAIN_CFG)
        assert out.empty

    def test_season_with_missing_day_is_dropped(self):
        d = _daily("2015-07-01", "2016-06-30")
        d.loc[d.date == "2015-10-10", "PRECTOTCORR"] = np.nan
        assert ev.seasonal_climate(d, self.MONTHS, self.SUBS, RAIN_CFG).empty


def test_anomalies_use_only_the_baseline_years():
    df = pd.DataFrame({"code": 1, "crop_year": [1990, 1991, 1992, 2021], "x_mm": [0.0, 100.0, 200.0, 300.0]})
    out = ev.add_anomalies(df, ["x_mm"], (1991, 1992))
    assert out.x_mm_anom.tolist() == [-150.0, -50.0, 50.0, 150.0]
    assert out.x_mm_anom_pct.iloc[-1] == pytest.approx(100.0)


class TestCropYearEnso:
    def seasonal(self, phase, strength, roni=2.0):
        return pd.DataFrame([{"season": "NDJ", "year": 2015, "crop_year": 2016, "roni": roni,
                              "roni_phase": phase, "roni_strength": strength}])

    def test_strong(self):
        out = ev.crop_year_enso(self.seasonal("el_nino", "very_strong"), "NDJ", ["strong", "very_strong"])
        assert out.iloc[0].crop_year == 2016
        assert out.iloc[0].enso_class == "el_nino_strong"

    def test_moderate_and_provisional(self):
        out = ev.crop_year_enso(self.seasonal("el_nino_provisional", "moderate", 1.2), "NDJ", ["strong"])
        assert out.iloc[0].enso_class == "el_nino_moderate"
        assert bool(out.iloc[0].provisional)

    def test_forecast_class_picks_most_likely(self):
        row = pd.Series({"p_p1.5_p2.0": 4, "p_ge_p2.0": 96, "p_p0.5_p1.0": 0, "p_p1.0_p1.5": 0,
                         "p_neutral": 0, "p_la_nina": 0})
        assert ev.forecast_class(row, ["p1.5_p2.0", "ge_p2.0"], ["p0.5_p1.0", "p1.0_p1.5"]) == ("el_nino_strong", 100)


class TestYield:
    def test_linear_trend_is_removed(self):
        years = np.arange(2000, 2012)
        y = 2000 + 50 * (years - 2000)  # pure trend
        s = pd.DataFrame({"year": years, "yield_kg_ha": y.astype(float)})
        s.loc[s.year == 2005, "yield_kg_ha"] *= 0.8  # one bad year
        out = ev.yield_anomalies(s, 10).set_index("year")
        assert out.loc[2005, "anomaly_pct"] < -15
        assert abs(out.drop(index=2005).anomaly_pct).max() < 5

    def test_short_series_gives_nothing(self):
        s = pd.DataFrame({"year": range(2000, 2005), "yield_kg_ha": 1000.0})
        assert ev.yield_anomalies(s, 10).empty

    def test_zero_yield_is_not_a_crop_failure_datapoint(self):
        """A '-' (zero) yield means the crop was not grown, not that it failed."""
        s = pd.DataFrame({"year": range(2000, 2012), "yield_kg_ha": [1000.0] * 11 + [0.0]})
        out = ev.yield_anomalies(s, 10)
        assert 2011 not in out.year.tolist()

    def test_main_crops_by_area_share(self):
        area = pd.DataFrame({"year": [2025] * 3, "crop_code": [1, 2, 3], "value": [990.0, 9.0, 1.0]})
        assert ev.main_crops(area, 5, 0.005) == [1, 2]


def test_composite_reports_every_class_even_when_empty():
    df = pd.DataFrame({"code": 1, "crop_year": [2000, 2001, 2002],
                       "enso_class": ["neutral", "neutral", "el_nino_strong"], "v": [0.0, 2.0, -10.0]})
    out = ev.composite(df, "v", ["code"]).set_index("enso_class")
    assert set(out.index) == set(ev.ENSO_CLASSES)
    assert out.loc["la_nina", "n"] == 0 and np.isnan(out.loc["la_nina", "mean"])
    assert out.loc["el_nino_strong", "minus_neutral"] == -11.0
    assert out.loc["neutral", "years"] == "2000,2001"


def test_season_progress_cumulates_from_season_start():
    d = _daily("1990-07-01", "1992-06-30", rain=1.0)
    d = pd.concat([d, _daily("2026-07-01", "2026-09-10", rain=3.0)])
    out = ev.season_progress(d, 1, 9, 242, 2027, (1991, 1992), [1992])
    assert out.loc[0, "current_mm"] == 3.0
    assert out.loc[9, "current_mm"] == 30.0
    assert np.isnan(out.loc[20, "current_mm"])  # not happened yet
    assert out.loc[9, "baseline_mean_mm"] == 10.0
    assert out.n_baseline.iloc[0] == 2
    assert out.n_analog.iloc[0] == 1


class TestForecasts:
    def daily(self):
        dates = pd.date_range("1990-07-01", "2026-11-11")
        return pd.DataFrame({"code": 1, "date": dates, "PRECTOTCORR": 2.0})

    def test_window_climatology_sums_the_same_calendar_window(self):
        clim = ev.window_climatology(self.daily(), 1, pd.Timestamp("2026-11-14"), pd.Timestamp("2026-11-28"), [1991, 1992])
        assert clim.to_dict() == {1991: 30.0, 1992: 30.0}  # 15 days x 2 mm

    def test_forecast_summary_against_normal(self):
        fc = pd.DataFrame({"date": pd.date_range("2026-11-12", periods=10),
                           "rain": [5, 0, 0, 25, 0, 0, 0, 0, 1, 1], "et0": 4.0})
        s = ev.forecast_summary(fc, self.daily(), 1, pd.Timestamp("2026-11-14"), (1991, 2020), [2016], 20.0, 1.0)
        assert s["days"] == 8 and s["rain_mm"] == 27.0  # from the 14th only
        assert s["heavy_days"] == 1 and s["max_dry_spell_days"] == 4
        assert s["normal_rain_mm"] == 16.0  # 8 days x 2 mm
        assert s["water_balance_mm"] == 27.0 - 32.0

    def test_ensemble_progress_quantiles_across_members(self):
        prog = pd.DataFrame({"date": pd.date_range("2026-11-09", periods=6),
                             "current_mm": [10.0, 20.0, 30.0, np.nan, np.nan, np.nan]})
        bridge = pd.DataFrame({"date": [pd.Timestamp("2026-11-12")], "rain": [5.0]})
        members = pd.DataFrame({"date": list(pd.date_range("2026-11-13", periods=2)) * 3,
                                "member": [0, 0, 1, 1, 2, 2], "rain": [0.0, 0.0, 10.0, 10.0, 20.0, 20.0]})
        out = ev.ensemble_progress(prog, bridge, members).set_index("date")
        assert out.loc["2026-11-11", "forecast_median_mm"] == 30.0  # joins the observed curve
        assert out.loc["2026-11-12", "forecast_median_mm"] == 35.0  # bridge day
        assert out.loc["2026-11-14", "forecast_median_mm"] == 55.0  # 35 + median member (10+10)
        assert out.loc["2026-11-14", "forecast_p90_mm"] > out.loc["2026-11-14", "forecast_p10_mm"]

    def test_monthly_outlook_sums_per_member_and_skips_partial_months(self):
        dates = pd.date_range("2026-11-20", "2027-01-31")
        members = pd.concat([pd.DataFrame({"date": dates, "member": m, "rain": float(m)}) for m in range(3)])
        out = ev.monthly_outlook(members, self.daily(), 1, [12, 1], (1991, 2020), [2016])
        assert out.month.tolist() == ["2026-12", "2027-01"]  # November is partial
        dec = out.iloc[0]
        assert dec.forecast_median_mm == 31.0  # member 1: 1 mm x 31 days
        assert dec.n_members == 3
        assert dec.normal_mm == 62.0  # 2 mm x 31 days


class TestNdvi:
    def comps(self):
        dates = pd.to_datetime(["2015-12-19", "2016-01-01", "2016-01-17", "2016-02-02", "2016-02-18",
                                "2016-10-15"])
        return pd.DataFrame({"code": 1, "date": dates, "ndvi_cropland": [0.8, 0.8, 0.6, 0.8, 0.8, 0.3],
                             "valid_cropland_fraction": [1, 1, 0.2, 1, 1, 1]})

    def test_peak_ndvi_skips_cloudy_composites(self):
        out = ev.ndvi_by_crop_year(self.comps(), [12, 1, 2, 3], 0.5, 4)
        row = out.set_index("crop_year").loc[2016]
        assert row.n_composites == 4 and row.ndvi_peak == pytest.approx(0.8)

    def test_too_few_composites_gives_no_value(self):
        assert ev.ndvi_by_crop_year(self.comps(), [12, 1, 2, 3], 0.5, 5).empty

    def test_progress_orders_slots_from_season_start(self):
        out = ev.ndvi_progress(self.comps(), 1, [9, 10, 11, 12, 1, 2, 3, 4], 2016, (2016, 2016), [], 0.5)
        # October (season start side) comes before December, which comes before January/February.
        assert [d[:2] for d in out.label_date] == ["10", "12", "01", "02", "02"]  # 17 Jan was cloudy
        assert out.slot.is_monotonic_increasing


def test_monthly_climate_by_class():
    dates = pd.date_range("2014-07-01", "2016-06-30")
    daily = pd.DataFrame({"code": 1, "date": dates, "PRECTOTCORR": 1.0, "ET0": 4.0})
    daily.loc[daily.date == "2015-12-25", "PRECTOTCORR"] = 30.0
    daily.loc[daily.date == "2015-01-10", "ET0"] = np.nan  # incomplete ET0 month
    cy = pd.DataFrame({"crop_year": [2015, 2016], "enso_class": ["neutral", "el_nino_strong"], "forecast": [False, False]})
    out = ev.monthly_climate_by_class(daily, cy, 20.0).set_index(["enso_class", "month"])
    dec = out.loc[("el_nino_strong", 12)]
    assert dec.rain_mm == 30 + 30 and dec.heavy_days == 1 and dec.et0_mm == 124
    assert np.isnan(out.loc[("neutral", 1)].et0_mm) and out.loc[("neutral", 1)].rain_mm == 31
    assert out.loc[("all", 12)].n_years == 2
