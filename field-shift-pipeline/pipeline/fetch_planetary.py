"""Satellite products from Microsoft Planetary Computer, summarised per pilot municipality.

Three collections (config/planetary.yaml), all read as Cloud-Optimised GeoTIFFs with HTTP range
requests, so only the pixels over each municipality are downloaded:

* io-lulc-annual-v02 (10 m land cover, 2017-2023) -> cropland share per year, and a "stable
  cropland" mask: 250 m pixels that were mostly crops in every year.
* modis-13Q1-061 (MODIS Terra NDVI, 250 m, 16-day, 2000-) -> mean NDVI of that stable cropland
  for every composite since 2000. This is how green the crops actually were.
* cop-dem-glo-30 (Copernicus 30 m DEM) -> slope classes of the municipality and of its cropland,
  using Embrapa's relief classes (erosion exposure).

How access works: the STAC API is searched for items over the municipality's bounding box; each
asset URL is signed with a short-lived SAS token that ``planetary_computer`` obtains anonymously;
rasterio/GDAL then reads just the needed window. No account or key is needed.

Everything is computed on one grid per municipality: the MODIS 250 m sinusoidal grid, snapped to
MODIS's global origin so pixels from different tiles and dates line up exactly. Land cover is
averaged onto it (share of each 250 m pixel that is crops); the DEM is handled on its own 30 m
lon/lat grid and receives the cropland mask by nearest-neighbour.

Cache: every window read is stored as compressed .npz under data/raw/mpc/ (raw pixel values, not
summaries), so re-running recomputes from disk; --refresh re-reads. The first full run reads
~1,250 MODIS windows per municipality and takes several minutes; later runs only fetch new
composites.

Outputs (data/processed/):
    landcover_yearly.parquet  code, year, cropland_share, cropland_km2
    ndvi_composites.parquet   code, date, NDVI of municipality / stable cropland, validity counts
    terrain.parquet           code, scope (municipality|cropland), relief class, share, median slope
"""

from __future__ import annotations

import math
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Any

# GDAL settings for fast cloud reads; must be set before rasterio opens anything.
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")

import json  # noqa: E402

import numpy as np
import pandas as pd

from pipeline import raster_stats as rs
from pipeline.common import (
    PROCESSED_DIR,
    RAW_DIR,
    base_parser,
    load_config,
    log,
    setup_logging,
    write_parquet,
)

CACHE = RAW_DIR / "mpc"

# MODIS sinusoidal global grid (MOD13Q1 250 m): origin and pixel size, identical for every tile.
SINU_X0 = -20015109.355798
SINU_Y0 = 10007554.677899
MODIS_RES = 231.656358263750
# The sinusoidal CRS itself is taken from the first MODIS asset opened.


def _imports():
    """Import the optional 'planetary' extra lazily, with a clear message if missing."""
    try:
        import planetary_computer  # noqa: F401
        import pystac_client  # noqa: F401
        import rasterio  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("Planetary Computer extra not installed: run `uv sync --extra planetary`") from exc


# --------------------------------------------------------------------------------------------
# Grids and masks
# --------------------------------------------------------------------------------------------


def modis_grid(bounds_sinu: tuple[float, float, float, float]):
    """Snap sinusoidal bounds outward to the global MODIS 250 m grid -> (transform, (h, w))."""
    from affine import Affine

    minx, miny, maxx, maxy = bounds_sinu
    c0 = math.floor((minx - SINU_X0) / MODIS_RES)
    c1 = math.ceil((maxx - SINU_X0) / MODIS_RES)
    r0 = math.floor((SINU_Y0 - maxy) / MODIS_RES)
    r1 = math.ceil((SINU_Y0 - miny) / MODIS_RES)
    t = Affine(MODIS_RES, 0, SINU_X0 + c0 * MODIS_RES, 0, -MODIS_RES, SINU_Y0 - r0 * MODIS_RES)
    return t, (r1 - r0, c1 - c0)


def geom_mask(geom_4326: dict, crs, transform, shape) -> np.ndarray:
    """True inside the municipality polygon on the given grid."""
    from rasterio.features import geometry_mask
    from rasterio.warp import transform_geom

    g = geom_4326 if str(crs).upper() in ("EPSG:4326", "OGC:CRS84") else transform_geom("EPSG:4326", crs, geom_4326)
    return geometry_mask([g], out_shape=shape, transform=transform, invert=True)


def read_onto_grid(href: str, crs, transform, shape) -> np.ma.MaskedArray:
    """Read a raster onto a target grid with nearest-neighbour (exact when grids are aligned)."""
    import planetary_computer
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT

    with rasterio.open(planetary_computer.sign(href)) as src:
        # Pixels of the target grid that this tile does not cover must come back *masked*. A source
        # without a declared nodata (Copernicus DEM) would otherwise fill them with 0, and a 0 m
        # "elevation" outside the tile would win the tile merge and flatten the slope map.
        with WarpedVRT(src, crs=crs, transform=transform, width=shape[1], height=shape[0],
                       resampling=Resampling.nearest, nodata=_fill_value(src)) as vrt:
            return vrt.read(1, masked=True)


def _fill_value(src) -> float | int:
    """The source's own nodata, or a value it cannot contain (NaN for floats, dtype min for ints)."""
    if src.nodata is not None:
        return src.nodata
    dtype = np.dtype(src.dtypes[0])
    return np.nan if dtype.kind == "f" else np.iinfo(dtype).min


def merge_tiles(arrays: list[np.ma.MaskedArray]) -> np.ma.MaskedArray:
    """Combine reads from several tiles: first valid value wins (tiles do not overlap)."""
    out = arrays[0].copy()
    for a in arrays[1:]:
        fill = np.ma.getmaskarray(out) & ~np.ma.getmaskarray(a)
        out[fill] = a[fill]
    return out


# --------------------------------------------------------------------------------------------
# Land cover
# --------------------------------------------------------------------------------------------


def cropland_fraction(cat, cfg: dict, bbox, year: int, crs, transform, shape, code: int, refresh: bool) -> np.ndarray:
    """Share of each 250 m pixel classed as Crops in ``year`` (NaN where no data)."""
    import planetary_computer
    import rasterio
    from affine import Affine
    from rasterio.enums import Resampling
    from rasterio.warp import reproject, transform_bounds
    from rasterio.windows import Window, from_bounds

    path = CACHE / "landcover" / f"{code}_{year}.npz"
    if path.exists() and not refresh:
        arr = np.load(path)["fraction"]
        if arr.shape == shape:
            return arr
    items = list(cat.search(collections=[cfg["collection"]], bbox=bbox,
                            datetime=f"{year}-01-01/{year}-12-31").items())
    if not items:
        raise RuntimeError(f"no {cfg['collection']} items for {year} over {bbox}")
    acc = np.full(shape, np.nan, dtype="float32")
    dec = int(cfg["read_decimation"])
    for it in items:
        with rasterio.open(planetary_computer.sign(it.assets["data"].href)) as src:
            b = transform_bounds("EPSG:4326", src.crs, *bbox, densify_pts=21)
            try:
                win = from_bounds(*b, src.transform).intersection(Window(0, 0, src.width, src.height))
            except Exception:  # no overlap with this tile
                continue
            win = win.round_offsets().round_lengths()
            out_h, out_w = max(1, math.ceil(win.height / dec)), max(1, math.ceil(win.width / dec))
            classes = src.read(1, window=win, out_shape=(out_h, out_w), resampling=Resampling.nearest)
            # Pixel size grows by the decimation factor; origin stays at the window corner.
            win_t = src.window_transform(win) * Affine.scale(win.width / out_w, win.height / out_h)
            ind = rs.crop_indicator(classes, cfg["crops_value"], cfg["nodata_value"])
            dst = np.full(shape, np.nan, dtype="float32")
            reproject(ind, dst, src_transform=win_t, src_crs=src.crs, dst_transform=transform, dst_crs=crs,
                      resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
            acc = np.where(np.isnan(acc), dst, acc)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, fraction=acc)
    return acc


# --------------------------------------------------------------------------------------------
# NDVI
# --------------------------------------------------------------------------------------------


def ndvi_items(cat, cfg: dict, bbox, end: date) -> dict[str, list]:
    """Terra MOD13Q1 items over bbox, grouped by composite start date (one per tile)."""
    items = cat.search(collections=[cfg["collection"]], bbox=bbox,
                       datetime=f"{cfg['start']}/{end.isoformat()}").items()
    by_date: dict[str, list] = {}
    for it in items:
        if not it.id.startswith(cfg["platform_prefix"]):
            continue
        d = (it.properties.get("start_datetime") or it.properties["datetime"])[:10]
        by_date.setdefault(d, []).append(it)
    return dict(sorted(by_date.items()))


def read_ndvi(items: list, cfg: dict, crs, transform, shape, path: Path, refresh: bool) -> tuple[np.ndarray, np.ndarray]:
    if path.exists() and not refresh:
        z = np.load(path)
        if z["ndvi"].shape == shape:
            return z["ndvi"], z["reliability"]
    ndvi = merge_tiles([read_onto_grid(it.assets[cfg["ndvi_asset"]].href, crs, transform, shape) for it in items])
    rel = merge_tiles([read_onto_grid(it.assets[cfg["reliability_asset"]].href, crs, transform, shape) for it in items])
    # Build the cached arrays from the masks explicitly: the reliability COG is stored as uint8
    # (its STAC entry says int8), so a masked fill of -1 cannot be applied on the raw dtype.
    ndvi_a = np.where(np.ma.getmaskarray(ndvi), -3000, np.ma.getdata(ndvi).astype("int32")).astype("int16")
    rel_a = np.where(np.ma.getmaskarray(rel), -1, np.ma.getdata(rel).astype("int16")).astype("int8")
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, ndvi=ndvi_a, reliability=rel_a)
    return ndvi_a, rel_a


# --------------------------------------------------------------------------------------------
# Terrain
# --------------------------------------------------------------------------------------------


def terrain_stats(cat, cfg: dict, bbox, geom, crop_mask_modis: np.ndarray, modis_crs, modis_t, code: int,
                  refresh: bool) -> list[dict[str, Any]]:
    import planetary_computer
    import rasterio
    from affine import Affine
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    items = list(cat.search(collections=[cfg["collection"]], bbox=bbox).items())
    if not items:
        raise RuntimeError(f"no DEM tiles over {bbox}")
    with rasterio.open(planetary_computer.sign(items[0].assets["data"].href)) as src:
        rx, ry = src.res
    minx, miny, maxx, maxy = bbox
    shape = (math.ceil((maxy - miny) / ry), math.ceil((maxx - minx) / rx))
    t = Affine(rx, 0, minx, 0, -ry, maxy)

    path = CACHE / "dem" / f"{code}.npz"
    if path.exists() and not refresh and np.load(path)["dem"].shape == shape:
        dem = np.load(path)["dem"]
    else:
        dem_ma = merge_tiles([read_onto_grid(it.assets["data"].href, "EPSG:4326", t, shape) for it in items])
        dem = dem_ma.filled(np.nan).astype("float32")
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, dem=dem)

    row_lats = maxy - (np.arange(shape[0]) + 0.5) * ry
    slope = rs.slope_percent(dem, rx, ry, row_lats)
    in_muni = geom_mask(geom, "EPSG:4326", t, shape)
    crop = np.zeros(shape, dtype="uint8")
    reproject(crop_mask_modis.astype("uint8"), crop, src_transform=modis_t, src_crs=modis_crs,
              dst_transform=t, dst_crs="EPSG:4326", resampling=Resampling.nearest)
    classes = cfg["relief_classes_pct"]
    rows = []
    for scope, mask in (("municipality", in_muni), ("cropland", in_muni & crop.astype(bool))):
        shares = rs.relief_shares(slope, mask, classes)
        med = rs.masked_median(slope, mask)
        for name, share in shares.items():
            rows.append({"code": code, "scope": scope, "relief_class": name, "share": share,
                         "median_slope_pct": med, "n_px": int(mask.sum())})
    return rows


# --------------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------------


def main() -> None:
    p = base_parser(__doc__ or "")
    p.add_argument("--workers", type=int, default=8, help="parallel MODIS reads")
    p.add_argument("--skip-ndvi", action="store_true", help="land cover and terrain only")
    args = p.parse_args()
    setup_logging(args.verbose)
    _imports()
    import planetary_computer
    import pystac_client
    import rasterio
    from rasterio.warp import transform_bounds

    cfg = load_config("planetary.yaml")
    regions = pd.read_parquet(PROCESSED_DIR / "regions.parquet")
    geo = json.loads((PROCESSED_DIR / "regions.geojson").read_text(encoding="utf-8"))
    geoms = {int(f["properties"]["code"]): f["geometry"] for f in geo["features"]}
    cat = pystac_client.Client.open(cfg["stac_url"])
    today = date.today()

    lc_rows, ndvi_rows, terrain_rows = [], [], []
    for r in regions.itertuples():
        code = int(r.code)
        bbox = (float(r.min_lon), float(r.min_lat), float(r.max_lon), float(r.max_lat))
        geom = geoms[code]

        groups = ndvi_items(cat, cfg["ndvi"], bbox, today)
        first = next(iter(groups.values()))[0]
        with rasterio.open(planetary_computer.sign(first.assets[cfg["ndvi"]["ndvi_asset"]].href)) as src:
            sinu = src.crs
        transform, shape = modis_grid(transform_bounds("EPSG:4326", sinu, *bbox, densify_pts=21))
        in_muni = geom_mask(geom, sinu, transform, shape)
        px_km2 = MODIS_RES**2 / 1e6
        log.info("%s: grid %dx%d (250 m), %d pixels inside, %d MODIS composites",
                 r.name, shape[1], shape[0], int(in_muni.sum()), len(groups))

        # Land cover ------------------------------------------------------------------------
        lc_cfg = cfg["landcover"]
        fractions = []
        for year in lc_cfg["years"]:
            frac = cropland_fraction(cat, lc_cfg, bbox, year, sinu, transform, shape, code, args.refresh)
            fractions.append(frac)
            inside = frac[in_muni]
            share = float(np.nanmean(inside)) if np.isfinite(inside).any() else np.nan
            lc_rows.append({"code": code, "year": year, "cropland_share": share,
                            "cropland_km2": float(np.nansum(inside) * px_km2)})
            log.info("  land cover %d: cropland %.1f%% of municipality", year, 100 * share)
        stable = rs.stable_cropland(fractions, cfg["cropland_fraction_threshold"])
        log.info("  stable cropland: %d pixels (%.0f km2)", int((stable & in_muni).sum()),
                 (stable & in_muni).sum() * px_km2)

        # Terrain ---------------------------------------------------------------------------
        terrain_rows += terrain_stats(cat, cfg["terrain"], bbox, geom, stable, sinu, transform, code, args.refresh)

        # NDVI ------------------------------------------------------------------------------
        if args.skip_ndvi:
            continue
        cached = sum((CACHE / "ndvi" / str(code) / f"{d}.npz").exists() for d in groups)
        todo = len(groups) - (0 if args.refresh else cached)
        # Two int16/int8 windows per composite; COG blocks make the transfer ~2x the window.
        est_mb = todo * shape[0] * shape[1] * 3 * 2 / 1e6
        log.info("  NDVI: %d composites, %d cached, %d to read (~%.0f MB)", len(groups), cached, todo, est_mb)

        def work(d: str, items: list) -> dict[str, Any]:
            nd, rel = read_ndvi(items, cfg["ndvi"], sinu, transform, shape,
                                CACHE / "ndvi" / str(code) / f"{d}.npz", args.refresh)
            s = rs.ndvi_summary(nd, rel, in_muni, stable, cfg["ndvi"]["scale"], cfg["ndvi"]["usable_reliability"])
            return {"code": code, "date": pd.Timestamp(d), "tiles": len(items), **s}

        done = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = [pool.submit(work, d, its) for d, its in groups.items()]
            for f in as_completed(futs):
                ndvi_rows.append(f.result())
                done += 1
                if done % 100 == 0:
                    log.info("  NDVI %d/%d", done, len(futs))

    meta = {"source": f"Microsoft Planetary Computer STAC ({cfg['stac_url']})",
            "config": "config/planetary.yaml", "generated_by": "pipeline/fetch_planetary.py"}
    write_parquet(pd.DataFrame(lc_rows), "landcover_yearly.parquet",
                  {**meta, "collection": cfg["landcover"]["collection"], "license": cfg["landcover"]["license"]})
    write_parquet(pd.DataFrame(terrain_rows), "terrain.parquet",
                  {**meta, "collection": cfg["terrain"]["collection"], "attribution": cfg["terrain"]["attribution"].strip(),
                   "relief_source": cfg["terrain"]["relief_source"].strip()})
    if ndvi_rows:
        nd = pd.DataFrame(ndvi_rows).sort_values(["code", "date"]).reset_index(drop=True)
        write_parquet(nd, "ndvi_composites.parquet",
                      {**meta, "collection": cfg["ndvi"]["collection"],
                       "cropland_mask": f"stable cropland, io-lulc {lc_cfg['years'][0]}-{lc_cfg['years'][-1]}, "
                                        f"fraction >= {cfg['cropland_fraction_threshold']} every year"})
        print(nd.groupby("code").agg(n=("date", "size"), first=("date", "min"), last=("date", "max"),
                                     ndvi_crop=("ndvi_cropland", "mean")).to_string())


if __name__ == "__main__":
    main()
