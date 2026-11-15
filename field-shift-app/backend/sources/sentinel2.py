"""Element84 Earth Search, collection sentinel-2-l2a (R-27 to R-30). Search only.

The zonal NDVI statistic needs a cloud optimised GeoTIFF reader that is not approved (OD-01), so
this module returns scene counts, the addresses of the three assets and never a valid_fraction. No
key, no login, no Google host.

The three assets are the item's `red`, `nir` and `scl` assets, which the search already returns.
They are labelled by their own file stem (`B04.tif` is `B04`), because the `scl` asset carries no
`eo:bands` and the band name alone would leave it unnamed. The addresses are what the reader of
OD-01 will range-request (Table E, ndvi `assets`; Table F route 2; O-10).
"""

from __future__ import annotations

from datetime import date
from typing import Any

STAC_URL = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
CLEAR_CLOUD_PERCENT = 20.0
ASSET_KEYS = ("red", "nir", "scl")


def search_body(ring: list[list[float]], start: date, end: date) -> dict[str, Any]:
    closed = list(ring) if ring[0] == ring[-1] else list(ring) + [ring[0]]
    return {
        "collections": [COLLECTION],
        "intersects": {"type": "Polygon", "coordinates": [closed]},
        "datetime": f"{start:%Y-%m-%d}T00:00:00Z/{end:%Y-%m-%d}T23:59:59Z",
        "limit": 100,
    }


def asset_label(href: Any) -> str | None:
    """The file stem of an asset address: `.../B04.tif` is `B04`, `.../SCL.tif` is `SCL`."""
    if not isinstance(href, str) or not href:
        return None
    return href.rsplit("/", 1)[-1].split(".", 1)[0]


def scene_assets(feature: dict) -> dict[str, str]:
    """The red, nir and scl addresses of one item, keyed by their own file stem. Missing is missing."""
    assets = feature.get("assets") or {}
    found: dict[str, str] = {}
    for key in ASSET_KEYS:
        asset = assets.get(key)
        if not isinstance(asset, dict):
            continue
        label = asset_label(asset.get("href"))
        if label is not None:
            found[label] = asset["href"]
    return found


def parse_scenes(payload: dict) -> list[dict[str, Any]]:
    scenes = []
    for feature in payload.get("features", []):
        properties = feature.get("properties", {})
        cloud = properties.get("eo:cloud_cover")
        scenes.append({
            "id": feature["id"],
            "date": str(properties["datetime"])[:10],
            "cloud_cover": float(cloud) if isinstance(cloud, (int, float)) else None,
            "assets": scene_assets(feature),
        })
    return scenes


def clear_count(scenes: list[dict[str, Any]]) -> int:
    return sum(1 for scene in scenes if scene["cloud_cover"] is not None and scene["cloud_cover"] < CLEAR_CLOUD_PERCENT)


def asset_roles(scenes: list[dict[str, Any]]) -> list[str]:
    """The distinct asset labels the returned scenes carry, sorted: `['B04', 'B08', 'SCL']`."""
    return sorted({label for scene in scenes for label in scene.get("assets", {})})
