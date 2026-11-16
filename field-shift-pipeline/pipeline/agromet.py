"""Reference evapotranspiration (ET0) by the FAO-56 Penman-Monteith method. Pure numpy.

Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998). Crop evapotranspiration -- Guidelines for
computing crop water requirements. FAO Irrigation and Drainage Paper 56. Chapters 2-4,
https://www.fao.org/4/x0490e/x0490e00.htm (read 2026-11-14). Equation numbers below are FAO-56's.

Inputs map directly onto NASA POWER daily variables: T2M_MAX, T2M_MIN, RH2M, WS2M (already at
2 m) and ALLSKY_SFC_SW_DWN (measured-equivalent solar radiation Rs, MJ m-2 day-1). The soil heat
flux G is taken as 0 for daily steps (Eq. 42). Verified against FAO-56 Example 18 (tests).
"""

from __future__ import annotations

import numpy as np

GSC = 0.0820            # solar constant, MJ m-2 min-1 (Eq. 21)
SIGMA = 4.903e-9        # Stefan-Boltzmann, MJ K-4 m-2 day-1 (Eq. 39)
ALBEDO = 0.23           # grass reference crop (Eq. 38)


def sat_vapour_pressure(t: np.ndarray) -> np.ndarray:
    """e°(T), kPa (Eq. 11)."""
    return 0.6108 * np.exp(17.27 * t / (t + 237.3))


def actual_vapour_pressure_rh_mean(tmax, tmin, rh_mean) -> np.ndarray:
    """ea from mean relative humidity, kPa (Eq. 19) -- the form POWER's RH2M supports."""
    return rh_mean / 100.0 * (sat_vapour_pressure(tmax) + sat_vapour_pressure(tmin)) / 2.0


def extraterrestrial_radiation(lat_deg: float, doy) -> np.ndarray:
    """Ra, MJ m-2 day-1 (Eqs. 21-25). Latitude negative in the southern hemisphere."""
    phi = np.radians(lat_deg)
    j = np.asarray(doy, dtype="float64")
    dr = 1 + 0.033 * np.cos(2 * np.pi / 365 * j)                       # Eq. 23
    delta = 0.409 * np.sin(2 * np.pi / 365 * j - 1.39)                 # Eq. 24
    ws = np.arccos(np.clip(-np.tan(phi) * np.tan(delta), -1.0, 1.0))  # Eq. 25
    return 24 * 60 / np.pi * GSC * dr * (
        ws * np.sin(phi) * np.sin(delta) + np.cos(phi) * np.cos(delta) * np.sin(ws)
    )


def et0_penman_monteith(
    tmax, tmin, rs, u2, ea, lat_deg: float, doy, elevation_m: float
) -> np.ndarray:
    """Daily grass-reference ET0, mm day-1 (Eq. 6). Arrays broadcast; NaN in -> NaN out."""
    tmax, tmin, rs, u2, ea = (np.asarray(x, dtype="float64") for x in (tmax, tmin, rs, u2, ea))
    tmean = (tmax + tmin) / 2
    p = 101.3 * ((293 - 0.0065 * elevation_m) / 293) ** 5.26                  # Eq. 7
    gamma = 0.665e-3 * p                                                     # Eq. 8
    delta = 4098 * sat_vapour_pressure(tmean) / (tmean + 237.3) ** 2         # Eq. 13
    es = (sat_vapour_pressure(tmax) + sat_vapour_pressure(tmin)) / 2         # Eq. 12
    ra = extraterrestrial_radiation(lat_deg, doy)
    rso = (0.75 + 2e-5 * elevation_m) * ra                                   # Eq. 37
    rns = (1 - ALBEDO) * rs                                                  # Eq. 38
    ratio = np.clip(rs / rso, None, 1.0)                                     # Rs/Rso <= 1
    rnl = SIGMA * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2 \
        * (0.34 - 0.14 * np.sqrt(ea)) * (1.35 * ratio - 0.35)                # Eq. 39
    rn = rns - rnl                                                           # Eq. 40
    g = 0.0                                                                  # Eq. 42
    num = 0.408 * delta * (rn - g) + gamma * 900 / (tmean + 273) * u2 * (es - ea)
    return num / (delta + gamma * (1 + 0.34 * u2))                           # Eq. 6
