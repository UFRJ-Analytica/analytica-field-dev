"""Pure array functions for the Planetary Computer products. No I/O, no rasterio: numpy only.

Kept separate from fetch_planetary.py (which does the reading) so every number it produces can be
unit-tested on small synthetic arrays.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# Mean Earth radius-based metres per degree; good to <0.5 % for slope at these latitudes.
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON_EQUATOR = 111_320.0


def crop_indicator(classes: np.ndarray, crops_value: int, nodata_value: int) -> np.ndarray:
    """Land-cover classes -> float: 1 crops, 0 any other valid class, NaN for no-data."""
    out = (classes == crops_value).astype("float32")
    out[classes == nodata_value] = np.nan
    return out


def stable_cropland(fractions: list[np.ndarray], threshold: float) -> np.ndarray:
    """True where the cropland fraction is >= threshold in every year (NaN counts as not crop)."""
    if not fractions:
        raise ValueError("no land-cover years given")
    stack = np.stack(fractions)
    return np.all(np.nan_to_num(stack, nan=0.0) >= threshold, axis=0)


def ndvi_summary(
    ndvi_raw: np.ndarray,
    reliability: np.ndarray,
    in_municipality: np.ndarray,
    cropland: np.ndarray,
    scale: float,
    usable: list[int],
    nodata: int = -3000,
) -> dict[str, Any]:
    """Mean NDVI over usable pixels, for the whole municipality and for its stable cropland.

    ``valid_crop_fraction`` is the share of cropland pixels that were usable (cloud-free); the
    build step drops composites where it is too low rather than trusting a few clear pixels.
    """
    usable_px = np.isin(reliability, usable) & (ndvi_raw != nodata)
    ndvi = ndvi_raw.astype("float64") * scale
    muni = in_municipality
    crop = in_municipality & cropland
    v_all = usable_px & muni
    v_crop = usable_px & crop
    n_crop = int(crop.sum())
    return {
        "n_municipality_px": int(muni.sum()),
        "n_valid_px": int(v_all.sum()),
        "ndvi_municipality": float(ndvi[v_all].mean()) if v_all.any() else np.nan,
        "n_cropland_px": n_crop,
        "n_valid_cropland_px": int(v_crop.sum()),
        "ndvi_cropland": float(ndvi[v_crop].mean()) if v_crop.any() else np.nan,
        "valid_cropland_fraction": float(v_crop.sum() / n_crop) if n_crop else 0.0,
    }


def slope_percent(dem: np.ndarray, res_lon_deg: float, res_lat_deg: float, row_lats: np.ndarray) -> np.ndarray:
    """Slope in percent (rise / run x 100) of a DEM on a regular lon/lat grid.

    The east-west pixel size shrinks with latitude, so it is computed per row from ``row_lats``.
    NaN in the DEM propagates to its neighbours' slope.
    """
    dz_dy, dz_dx = np.gradient(dem.astype("float64"))
    dy = abs(res_lat_deg) * M_PER_DEG_LAT
    dx = abs(res_lon_deg) * M_PER_DEG_LON_EQUATOR * np.cos(np.radians(row_lats))[:, None]
    return 100.0 * np.hypot(dz_dx / dx, dz_dy / dy)


def relief_shares(slope_pct: np.ndarray, mask: np.ndarray, classes: dict[str, list]) -> dict[str, float]:
    """Share (0-1) of masked, non-NaN pixels in each slope class. Bounds are [lo, hi)."""
    vals = slope_pct[mask & ~np.isnan(slope_pct)]
    if vals.size == 0:
        return {name: np.nan for name in classes}
    out = {}
    for name, (lo, hi) in classes.items():
        sel = vals >= lo if hi is None else (vals >= lo) & (vals < hi)
        out[name] = float(sel.sum() / vals.size)
    return out


def masked_median(values: np.ndarray, mask: np.ndarray) -> float:
    v = values[mask & ~np.isnan(values)]
    return float(np.median(v)) if v.size else np.nan
