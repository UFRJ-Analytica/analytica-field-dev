"""Tests for the pure raster maths behind the Planetary Computer products."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import raster_stats as rs
from pipeline.fetch_planetary import MODIS_RES, SINU_X0, SINU_Y0, merge_tiles, modis_grid

RELIEF = {"plano": [0, 3], "suave_ondulado": [3, 8], "ondulado": [8, 20], "forte_ondulado": [20, None]}


def test_crop_indicator():
    classes = np.array([[5, 2], [0, 11]])
    out = rs.crop_indicator(classes, crops_value=5, nodata_value=0)
    assert out[0, 0] == 1 and out[0, 1] == 0 and out[1, 1] == 0
    assert np.isnan(out[1, 0])


def test_stable_cropland_needs_every_year():
    a = np.array([[0.9, 0.9, np.nan]])
    b = np.array([[0.9, 0.4, 0.9]])
    assert rs.stable_cropland([a, b], 0.5).tolist() == [[True, False, False]]


def test_ndvi_summary_drops_clouds_and_nodata():
    ndvi = np.array([[5000, 6000], [7000, -3000]], dtype="int16")
    rel = np.array([[0, 3], [1, 0]], dtype="int8")  # 3 = cloudy
    inside = np.ones((2, 2), bool)
    crop = np.array([[True, True], [False, True]])
    s = rs.ndvi_summary(ndvi, rel, inside, crop, 0.0001, [0, 1])
    assert s["ndvi_municipality"] == pytest.approx((0.5 + 0.7) / 2)
    assert s["ndvi_cropland"] == pytest.approx(0.5)  # 0.6 cloudy, -3000 nodata
    assert s["n_cropland_px"] == 3 and s["n_valid_cropland_px"] == 1
    assert s["valid_cropland_fraction"] == pytest.approx(1 / 3)


def test_ndvi_summary_all_cloudy_gives_nan_not_zero():
    s = rs.ndvi_summary(np.full((2, 2), 5000, "int16"), np.full((2, 2), 3, "int8"),
                        np.ones((2, 2), bool), np.ones((2, 2), bool), 0.0001, [0, 1])
    assert np.isnan(s["ndvi_cropland"]) and s["valid_cropland_fraction"] == 0


def test_slope_of_a_plane():
    # Rises 10 m per pixel eastwards; pixel 0.001 deg at the equator ~ 111.32 m -> ~8.98 %.
    dem = np.tile(np.arange(5) * 10.0, (5, 1))
    s = rs.slope_percent(dem, 0.001, 0.001, np.zeros(5))
    assert s[2, 2] == pytest.approx(100 * 10 / 111.32, rel=1e-3)


def test_slope_accounts_for_latitude():
    """At 60 degrees a degree of longitude is half as long, so the same rise is twice as steep."""
    dem = np.tile(np.arange(5) * 10.0, (5, 1))
    eq = rs.slope_percent(dem, 0.001, 0.001, np.zeros(5))[2, 2]
    s60 = rs.slope_percent(dem, 0.001, 0.001, np.full(5, 60.0))[2, 2]
    assert s60 == pytest.approx(2 * eq, rel=1e-6)


def test_relief_shares():
    slope = np.array([1.0, 2.0, 5.0, 10.0, 30.0, np.nan])
    mask = np.ones(6, bool)
    out = rs.relief_shares(slope, mask, RELIEF)
    assert out == {"plano": 0.4, "suave_ondulado": 0.2, "ondulado": 0.2, "forte_ondulado": 0.2}
    assert sum(out.values()) == pytest.approx(1.0)


def test_modis_grid_snaps_to_global_origin():
    t, shape = modis_grid((SINU_X0 + 10.5 * MODIS_RES, SINU_Y0 - 20.2 * MODIS_RES,
                           SINU_X0 + 12.1 * MODIS_RES, SINU_Y0 - 18.7 * MODIS_RES))
    assert t.c == pytest.approx(SINU_X0 + 10 * MODIS_RES)
    assert t.f == pytest.approx(SINU_Y0 - 18 * MODIS_RES)
    assert shape == (3, 3)


def test_tile_merge_does_not_let_fill_values_win():
    """Regression: an unmasked 0 outside tile A must not overwrite tile B's real elevations."""
    a = np.ma.array([[100.0, 0.0]], mask=[[False, True]])
    b = np.ma.array([[0.0, 250.0]], mask=[[True, False]])
    out = merge_tiles([a, b])
    assert out.tolist() == [[100.0, 250.0]]
