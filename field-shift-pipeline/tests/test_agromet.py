"""FAO-56 Penman-Monteith checked against the publication's own worked example."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline.agromet import actual_vapour_pressure_rh_mean, et0_penman_monteith, extraterrestrial_radiation


def test_fao56_example_18_brussels():
    """FAO-56 Example 18: Uccle, 6 July (J=187), 50.80 N, 100 m -> Ra 41.09, ET0 3.88 mm/day."""
    assert extraterrestrial_radiation(50.80, 187) == pytest.approx(41.09, abs=0.05)
    et0 = et0_penman_monteith(tmax=21.5, tmin=12.3, rs=22.07, u2=2.078, ea=1.409,
                              lat_deg=50.80, doy=187, elevation_m=100)
    assert et0 == pytest.approx(3.88, abs=0.03)


def test_southern_hemisphere_summer_has_more_radiation_than_winter():
    assert extraterrestrial_radiation(-29.0, 355) > extraterrestrial_radiation(-29.0, 172) * 1.5


def test_ea_from_mean_rh():
    # Eq. 19 with RHmean 73.5 % at the Example 18 temperatures (e° 2.564 and 1.431 kPa).
    assert actual_vapour_pressure_rh_mean(21.5, 12.3, 73.5) == pytest.approx(0.735 * (2.564 + 1.431) / 2, abs=0.005)


def test_nan_propagates():
    out = et0_penman_monteith(np.array([30.0, np.nan]), 20.0, 20.0, 2.0, 2.0, -12.2, 300, 700)
    assert np.isfinite(out[0]) and np.isnan(out[1])
