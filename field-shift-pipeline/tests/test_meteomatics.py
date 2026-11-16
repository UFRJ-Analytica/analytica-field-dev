"""Tests for the Meteomatics client (no network)."""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from pipeline.fetch_meteomatics import MeteomaticsError, build_url, parse_response, product_window


def payload(param: str, values: list[float], start_day: int = 10) -> dict:
    return {
        "version": "3.0",
        "user": "someone_private",
        "status": "OK",
        "data": [{
            "parameter": param,
            "coordinates": [{
                "lat": -12.1982, "lon": -46.0202,
                "dates": [{"date": f"2026-11-{start_day + i:02d}T00:00:00Z", "value": v}
                          for i, v in enumerate(values)],
            }],
        }],
    }


def test_url_shape():
    url = build_url("https://api.meteomatics.com", date(2026, 11, 9), "P20D",
                    ["precip_24h:mm", "t_2m:C"], -12.19823, -46.02021, "mix")
    assert url == ("https://api.meteomatics.com/2026-11-09T00:00:00ZP20D:P1D/precip_24h:mm,t_2m:C/"
                   "-12.1982,-46.0202/json?source=mix")


def test_24h_values_are_moved_to_the_day_they_cover():
    df = parse_response(payload("precip_24h:mm", [1.0, 2.0]), {"precip_24h:mm": "rain"})
    # Value stamped 11-10 00Z is the rain of 11-09.
    assert df.date.dt.strftime("%Y-%m-%d").tolist() == ["2026-11-09", "2026-11-10"]
    assert df.rain.tolist() == [1.0, 2.0]


def test_instantaneous_values_keep_their_date():
    df = parse_response(payload("soil_moisture_index_-15cm:idx", [0.5]), {"soil_moisture_index_-15cm:idx": "smi"})
    assert df.date.dt.strftime("%Y-%m-%d").tolist() == ["2026-11-10"]


def test_reserved_values_become_nan_and_user_is_not_kept():
    df = parse_response(payload("precip_24h:mm", [1.0, -999.0, -666.0]), {"precip_24h:mm": "rain"})
    assert df.rain.isna().tolist() == [False, True, True]
    assert "someone_private" not in df.to_json()


def test_error_status_raises():
    with pytest.raises(MeteomaticsError):
        parse_response({"status": "ERROR", "message": "not available"}, {})


def test_product_window():
    assert product_window({"days": 15}, date(2026, 11, 14), 5) == (date(2026, 11, 9), "P20D")
    assert product_window({"months": 6}, date(2026, 11, 14), 5) == (date(2026, 11, 14), "P6M")
