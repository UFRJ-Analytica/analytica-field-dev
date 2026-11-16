"""The US calendar and the USDA NASS reader."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pipeline import evidence as ev
from pipeline import fetch_nass as nass
from pipeline.common import load_config, pilot_municipalities, region_calendars


def test_us_counties_are_us_and_use_the_water_year():
    cals = region_calendars()
    for m in pilot_municipalities():
        cal = cals[m["region_id"]]
        if m["country"] == "US":
            assert cal["crop_year_start_month"] == 10
            assert cal["season_months"][0] == 10 and len(cal["season_months"]) == 12
        else:
            assert cal["crop_year_start_month"] == 7


def test_both_calendars_put_the_ndj_label_season_inside_the_crop_year():
    """Crop year Y (Jul-Jun in Brazil, Oct-Sep in the US) contains December of Y-1, so one ENSO
    table, keyed by the NDJ season, labels both."""
    dec = pd.Series(pd.to_datetime(["2025-12-15"]))
    assert ev.crop_year(dec, 7).iloc[0] == 2026
    assert ev.crop_year(dec, 10).iloc[0] == 2026


@pytest.mark.parametrize("raw, value, flag", [("1,234.5", 1234.5, ""), (" 185 ", 185.0, ""), ("(D)", np.nan, "withheld"),
                                              ("(Z)", np.nan, "less_than_half_unit")])
def test_parse_value(raw, value, flag):
    v, f = nass.parse_value(raw)
    assert f == flag
    assert (np.isnan(v) and np.isnan(value)) or v == value


def test_parse_value_rejects_unknown_codes():
    with pytest.raises(ValueError):
        nass.parse_value("(Q)")


def _row(year, stat, unit, value, util="GRAIN", cls="ALL CLASSES", commodity="CORN", practice="ALL PRODUCTION PRACTICES"):
    return {"year": str(year), "commodity_desc": commodity, "class_desc": cls, "statisticcat_desc": stat,
            "unit_desc": unit, "util_practice_desc": util, "prodn_practice_desc": practice,
            "domain_desc": "TOTAL", "reference_period_desc": "YEAR", "Value": value}


def test_select_matches_columns_and_skips_irrigated_rows():
    spec = load_config("nass.yaml")["crops"][840001]
    rows = [_row(2020, "YIELD", "BU / ACRE", "200.0"),
            _row(2020, "YIELD", "BU / ACRE", "250.0", practice="IRRIGATED"),
            _row(2021, "YIELD", "BU / ACRE", "(D)")]
    out = nass.select(rows, spec, "YIELD", "BU / ACRE", "GRAIN")
    assert out.year.tolist() == [2020, 2021]
    assert out.value.iloc[0] == 200.0 and out.flag.iloc[1] == "withheld"


def test_state_value_per_yield_unit_needs_no_bushel_weight():
    """US$ per (bu x acre) = value / acres / yield; county revenue = county yield x that."""
    spec = load_config("nass.yaml")["crops"][840001]
    state = [_row(2020, "PRODUCTION", "$", "1,000,000"), _row(2020, "AREA HARVESTED", "ACRES", "1,000"),
             _row(2020, "YIELD", "BU / ACRE", "200")]
    per_unit, cls = nass.state_value_per_yield_unit(state, spec)
    assert cls == "ALL CLASSES"
    assert per_unit.value.iloc[0] == pytest.approx(1_000_000 / 1_000 / 200)


def test_winter_wheat_falls_back_to_all_wheat_value():
    spec = load_config("nass.yaml")["crops"][840003]
    state = [_row(2020, "PRODUCTION", "$", "500", util="ALL UTILIZATION PRACTICES", commodity="WHEAT"),
             _row(2020, "AREA HARVESTED", "ACRES", "10", util="ALL UTILIZATION PRACTICES", commodity="WHEAT"),
             _row(2020, "YIELD", "BU / ACRE", "50", util="ALL UTILIZATION PRACTICES", commodity="WHEAT")]
    per_unit, cls = nass.state_value_per_yield_unit(state, spec)
    assert cls == "ALL CLASSES" and per_unit.value.iloc[0] == pytest.approx(1.0)


def test_the_key_is_redacted_from_logged_urls(monkeypatch):
    monkeypatch.setenv("NASS_API_KEY", "SECRET123")
    assert "SECRET123" not in nass._redact("https://x/api_GET/?key=SECRET123&commodity_desc=CORN")


def test_yield_anomalies_work_in_any_unit():
    s = pd.DataFrame({"year": range(2000, 2012), "yield_value": [150.0 + i for i in range(12)]})
    out = ev.yield_anomalies(s, 10, col="yield_value")
    assert "trend_value" in out and out.anomaly_pct.abs().max() < 1e-9


def test_an_absent_crop_is_no_data_not_an_error():
    assert nass.is_empty_answer('{"error":["bad request - invalid query"]}')
    assert nass.is_empty_answer('{"error":["no data for selected filters"]}')
    assert not nass.is_empty_answer('{"error":["unauthorized"]}')
