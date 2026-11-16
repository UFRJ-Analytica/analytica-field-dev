"""Tests for the geometry helpers behind municipality centroids.

The centroid is what gets handed to NASA POWER, so a silent error here would quietly shift every
climate series in the project to the wrong place.
"""

from __future__ import annotations

import math

import pytest

from pipeline.common import load_config, pilot_municipalities
from pipeline.fetch_regions import bounds, centroid

# A closed unit square, counter-clockwise, offset into the southern hemisphere so a sign error
# shows up rather than cancelling out.
SQUARE = {
    "type": "Polygon",
    "coordinates": [[[-54.0, -29.0], [-53.0, -29.0], [-53.0, -28.0], [-54.0, -28.0], [-54.0, -29.0]]],
}


def test_centroid_of_square_is_its_middle():
    lon, lat = centroid(SQUARE)
    assert math.isclose(lon, -53.5, abs_tol=1e-9)
    assert math.isclose(lat, -28.5, abs_tol=1e-9)


def test_centroid_ignores_ring_winding():
    """Reversing the winding flips the signed area but must not move the centroid."""
    reversed_square = {
        "type": "Polygon",
        "coordinates": [list(reversed(SQUARE["coordinates"][0]))],
    }
    assert centroid(reversed_square) == pytest.approx(centroid(SQUARE))


def test_hole_pulls_centroid_away_from_it():
    """An interior ring must subtract area, not add it."""
    # Square with a hole in its western half -> centroid moves east.
    holed = {
        "type": "Polygon",
        "coordinates": [
            SQUARE["coordinates"][0],
            # Hole wound clockwise (opposite of the shell) so its signed area is negative.
            [[-53.9, -28.9], [-53.9, -28.1], [-53.6, -28.1], [-53.6, -28.9], [-53.9, -28.9]],
        ],
    }
    lon, _ = centroid(holed)
    assert lon > -53.5


def test_multipolygon_is_area_weighted():
    """Two unequal squares: the centroid must sit nearer the larger one, not midway between."""
    multi = {
        "type": "MultiPolygon",
        "coordinates": [
            # Large: 2x2 centred at lon -54
            [[[-55.0, -29.0], [-53.0, -29.0], [-53.0, -27.0], [-55.0, -27.0], [-55.0, -29.0]]],
            # Small: 1x1 centred at lon -50.5
            [[[-51.0, -29.0], [-50.0, -29.0], [-50.0, -28.0], [-51.0, -28.0], [-51.0, -29.0]]],
        ],
    }
    lon, _ = centroid(multi)
    midway = (-54.0 + -50.5) / 2
    assert lon < midway  # pulled west, toward the 4x-larger polygon
    assert math.isclose(lon, (-54.0 * 4 + -50.5 * 1) / 5, abs_tol=1e-9)


def test_zero_area_geometry_refuses_to_guess():
    degenerate = {
        "type": "Polygon",
        "coordinates": [[[-54.0, -29.0], [-54.0, -29.0], [-54.0, -29.0], [-54.0, -29.0]]],
    }
    with pytest.raises(ValueError, match="zero total area"):
        centroid(degenerate)


def test_unsupported_geometry_type_is_rejected():
    with pytest.raises(ValueError, match="unsupported geometry"):
        centroid({"type": "LineString", "coordinates": [[-54.0, -29.0], [-53.0, -28.0]]})


def test_bounds_of_square():
    assert bounds(SQUARE) == (-54.0, -29.0, -53.0, -28.0)


def test_centroid_lies_inside_bounds_for_square():
    lon, lat = centroid(SQUARE)
    min_lon, min_lat, max_lon, max_lat = bounds(SQUARE)
    assert min_lon < lon < max_lon
    assert min_lat < lat < max_lat


class TestRegionsConfig:
    """config/regions.yaml is hand-authored, so guard its shape and the project's invariants."""

    def test_both_pilot_municipalities_are_present(self):
        muns = pilot_municipalities()
        assert {m["code"] for m in muns} == {4322202, 2919553, 5107248, 17113, 48303}

    def test_each_municipality_carries_its_region_signal(self):
        by_code = {m["code"]: m for m in pilot_municipalities()}
        assert by_code[4322202]["enso_signal"] == "excess"
        assert by_code[2919553]["enso_signal"] == "deficit"
        assert by_code[5107248]["enso_signal"] == "unclassified"
        assert by_code[48303]["enso_signal"] == "excess"
        assert by_code[17113]["enso_signal"] == "unclassified"

    def test_the_two_pilots_have_opposite_signals(self):
        """The whole premise of the tool is the Brazilian ENSO dipole."""
        signals = {m["enso_signal"] for m in pilot_municipalities()}
        assert {"excess", "deficit"} <= signals
        assert signals <= {"excess", "deficit", "unclassified"}

    def test_climatology_baseline_is_a_documented_30_year_period(self):
        meta = load_config("regions.yaml")["meta"]
        start, end = meta["climatology_baseline"]
        assert end - start + 1 == 30

    def test_season_months_cover_the_summer_crop(self):
        meta = load_config("regions.yaml")["meta"]
        # Sep through Apr, wrapping the new year.
        assert meta["season_months"] == [9, 10, 11, 12, 1, 2, 3, 4]

    def test_crop_year_starts_in_july(self):
        """Jul-Jun crop year, labelled by harvest year, is what aligns the series with IBGE PAM."""
        assert load_config("regions.yaml")["meta"]["crop_year_start_month"] == 7
