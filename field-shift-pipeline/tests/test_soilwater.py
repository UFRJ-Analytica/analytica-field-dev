"""Tests for the FAO-56 daily soil water balance (pipeline/soilwater.py)."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import soilwater as sw

PROFILE = [  # theta_FC - theta_WP = 0.10 everywhere -> TAW = 100 mm per metre
    {"top_cm": 0, "bottom_cm": 30, "fc": 0.30, "wp": 0.20},
    {"top_cm": 30, "bottom_cm": 200, "fc": 0.35, "wp": 0.25},
]


def test_taw_integrates_layers_eq82():
    assert sw.taw_mm(PROFILE, 1.0) == pytest.approx(100.0)
    assert sw.taw_mm(PROFILE, 0.15) == pytest.approx(15.0)


def test_tew_eq73():
    # (0.30 - 0.5 * 0.20) * 0.125 m * 1000 = 25 mm
    assert sw.tew_mm(PROFILE, 0.125) == pytest.approx(25.0)


def test_profile_too_shallow_raises():
    with pytest.raises(ValueError):
        sw.taw_mm(PROFILE, 2.5)


@pytest.mark.parametrize("etc,expected", [(5.0, 0.5), (7.0, 0.42), (2.0, 0.62), (30.0, 0.1)])
def test_p_adjustment_table22_note(etc, expected):
    assert sw.p_adjusted(0.5, etc) == pytest.approx(expected)


def run(rain, et0, kc=1.0, taw=100.0, p=0.5, cropped=True, tew=25.0):
    n = len(rain)
    return sw.simulate(np.asarray(rain, float), np.asarray(et0, float), np.full(n, kc), np.full(n, taw),
                       np.full(n, p), np.full(n, cropped), tew)


class TestSimulate:
    def test_no_stress_until_raw_then_ks_falls(self):
        out = run([0.0] * 30, [5.0] * 30)  # ETc 5 mm/day, p 0.5 -> RAW 50 mm
        assert (out["ks"][:10] == 1).all()          # depletion 0..45 mm < RAW
        assert out["ks"][11] < 1                     # past RAW: stressed
        assert out["eta"][20] < out["etc"][20]
        assert out["dr"].max() <= 100               # Eq. 86

    def test_ks_eq84_value(self):
        # ETc 5 mm/day, TAW 100, p 0.5 -> RAW 50. Day 11 starts at Dr = 55:
        # Ks = (TAW - Dr) / ((1 - p) TAW) = (100 - 55) / 50 = 0.9 (Eq. 84), so ETa = 4.5 mm.
        out = run([0.0] * 16, [5.0] * 16)
        assert out["dr"][10] == pytest.approx(55.0)
        assert out["ks"][11] == pytest.approx(0.9)
        assert out["eta"][11] == pytest.approx(4.5)
        for i in range(12, 16):  # every stressed day obeys Eq. 84 on the previous depletion
            assert out["ks"][i] == pytest.approx((100 - out["dr"][i - 1]) / 50)

    def test_heavy_rain_refills_and_percolates(self):
        out = run([0, 0, 0, 0, 200.0, 0], [5.0] * 6)
        assert out["dr"][4] == 0.0  # back to field capacity (Eq. 88), excess drains

    def test_small_rain_is_ignored(self):
        out = run([0.9, 0.9], [5.0, 5.0])  # < 0.2 ET0 = 1 mm
        assert out["dr"][1] == pytest.approx(10.0)

    def test_bare_soil_stops_evaporating_at_tew(self):
        out = run([0.0] * 10, [5.0] * 10, kc=0.4, cropped=False, tew=6.0)
        # 2 mm/day while Dr < 6: days 1-3 evaporate (Dr 2, 4, 6), then nothing.
        assert out["dr"][-1] == pytest.approx(6.0)
        assert out["eta"][5] == 0.0

    def test_missing_input_refuses_to_skip(self):
        with pytest.raises(ValueError, match="cannot skip"):
            run([0.0, np.nan], [5.0, 5.0])


CROPS = {
    "soja": {"kc": {"ini": 0.4, "mid": 1.15, "end": 0.5}, "root": {"p": 0.5}},
    "trigo": {"kc": {"ini": 0.3, "mid": 1.15, "end": 0.325}, "root": {"p": 0.55}},
}


def test_schedule_hand_over_and_fallow():
    from pipeline.scoring import occupancy

    occ = occupancy(["soja", "trigo"], {"soja": {"sow": 11, "harvest": 4}, "trigo": {"sow": 6, "harvest": 11}})
    cal = {m: [{"crop": e["crop"], "stage": e["stage"]} for e in occ[m]] for m in occ}
    months = np.array([11, 11, 5])
    days = np.array([10, 20, 10])
    s = sw.daily_schedule(months, days, cal, CROPS, {"soja": 130.0, "trigo": 150.0})
    assert s["crop"][0] == "trigo" and s["kc"][0] == pytest.approx(0.325)  # Nov 1-15: wheat ends
    assert s["crop"][1] == "soja" and s["kc"][1] == pytest.approx(0.4)     # Nov 16-30: soy starts
    assert not s["cropped"][2] and s["kc"][2] == pytest.approx(0.4)       # May fallow: Kc ini of soy
    assert s["taw"][2] == 130.0
