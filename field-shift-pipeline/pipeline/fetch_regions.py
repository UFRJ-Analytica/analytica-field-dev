"""Resolve pilot municipalities against IBGE and compute their centroids.

Reads the declarative list in config/regions.yaml and gets each municipality's boundary from IBGE,
then computes an area-weighted polygon centroid. The centroid is the point handed to NASA POWER, so
it is derived here rather than hand-typed anywhere.

Two official IBGE routes to the same boundary, tried in order:

1. the *malhas* API (``servicodados.ibge.gov.br``), one small GeoJSON per municipality;
2. the per-state municipal shapefile on ``geoftp.ibge.gov.br`` (2025 mesh, ~10 MB per state).

The API resets connections from outside Brazil, so (2) is what a cloud runner ends up using. Which
route produced each row is recorded in the ``geometry_source`` column.

US counties (``country: US`` in regions.yaml) come from the Census Bureau cartographic boundary file
for 2023 (``cb_2023_us_county_500k.zip``, about 12 MB), matched on the 5-digit FIPS code.

Outputs:
    data/processed/regions.parquet   one row per municipality, centroid + bbox
    data/processed/regions.geojson   simplified outlines (~100 m tolerance) for the web map
"""

from __future__ import annotations

import json
from typing import Any

import pandas as pd
import requests

from pipeline.common import (
    PROCESSED_DIR,
    base_parser,
    fetch_file,
    fetch_json,
    load_config,
    log,
    pilot_municipalities,
    setup_logging,
    write_parquet,
)

MALHA_URL = (
    "https://servicodados.ibge.gov.br/api/v3/malhas/municipios/{code}"
    "?formato=application/vnd.geo%2Bjson&qualidade=intermediaria"
)
MESH_YEAR = 2025
UF_MESH_URL = (
    "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/"
    "municipio_{year}/UFs/{uf}/{uf}_Municipios_{year}.zip"
)
CENSUS_COUNTY_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip"
CENSUS_LABEL = "US Census Bureau cartographic boundary file 2023 (1:500k)"

# Simplification tolerance for the map outline only, in degrees (~100 m). Centroids and bounds are
# always computed from the full-resolution geometry.
MAP_TOLERANCE_DEG = 0.001


def _ring_area_and_centroid(ring: list[list[float]]) -> tuple[float, float, float]:
    """Signed area and centroid of one closed linear ring, by the shoelace formula.

    Returns (signed_area, cx, cy). A negative signed area means the ring is wound the other way,
    which is how holes cancel out of the weighted sum.
    """
    area2 = 0.0
    cx = 0.0
    cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        cross = x0 * y1 - x1 * y0
        area2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross

    if area2 == 0.0:
        # Degenerate ring: fall back to the mean of its vertices so a bad geometry cannot
        # silently produce a (0, 0) centroid in the Atlantic.
        n = len(ring)
        return 0.0, sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n

    return area2 / 2.0, cx / (3.0 * area2), cy / (3.0 * area2)


def _polygons(geometry: dict[str, Any]) -> list[list[list[list[float]]]]:
    """Normalise Polygon / MultiPolygon into a list of polygons (each a list of rings)."""
    kind = geometry["type"]
    if kind == "Polygon":
        return [geometry["coordinates"]]
    if kind == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"unsupported geometry type for a municipality: {kind}")


def centroid(geometry: dict[str, Any]) -> tuple[float, float]:
    """Area-weighted centroid of a (Multi)Polygon, in degrees lon/lat.

    Computed in plain degrees, not an equal-area projection. At municipality scale the error is far
    below the resolution of anything we sample with it (NASA POWER is ~0.5 degrees), so projecting
    would add a dependency for no gain.
    """
    total = 0.0
    sx = 0.0
    sy = 0.0
    for polygon in _polygons(geometry):
        for ring in polygon:
            area, cx, cy = _ring_area_and_centroid(ring)
            total += area
            sx += cx * area
            sy += cy * area

    if total == 0.0:
        raise ValueError("geometry has zero total area; refusing to guess a centroid")

    return sx / total, sy / total


def bounds(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) -- the bbox used later to clip gridded products."""
    xs: list[float] = []
    ys: list[float] = []
    for polygon in _polygons(geometry):
        for ring in polygon:
            xs.extend(p[0] for p in ring)
            ys.extend(p[1] for p in ring)
    return min(xs), min(ys), max(xs), max(ys)


def geometry_from_api(code: int, refresh: bool) -> dict[str, Any]:
    geojson = fetch_json(MALHA_URL.format(code=code), f"ibge_malha_{code}.geojson", refresh)
    return geojson["features"][0]["geometry"]


def geometry_from_uf_mesh(code: int, uf: str, refresh: bool) -> dict[str, Any]:
    import shapefile  # pyshp

    path = fetch_file(
        UF_MESH_URL.format(year=MESH_YEAR, uf=uf), f"ibge_{uf}_Municipios_{MESH_YEAR}.zip", refresh
    )
    with shapefile.Reader(str(path)) as reader:
        for rec, shp in zip(reader.iterRecords(fields=["CD_MUN"]), reader.iterShapes()):
            if int(rec["CD_MUN"]) == code:
                return shp.__geo_interface__
    raise LookupError(f"municipality {code} not found in the {uf} {MESH_YEAR} mesh")


def geometry_from_census(code: int, refresh: bool) -> tuple[dict[str, Any], str]:
    """County outline and its official name ("McLean County") from the Census file."""
    import shapefile  # pyshp

    path = fetch_file(CENSUS_COUNTY_URL, "census_cb_2023_us_county_500k.zip", refresh)
    with shapefile.Reader(str(path)) as reader:
        for rec, shp in zip(reader.iterRecords(fields=["GEOID", "NAMELSAD"]), reader.iterShapes()):
            if int(rec["GEOID"]) == code:
                return shp.__geo_interface__, rec["NAMELSAD"]
    raise LookupError(f"county {code:05d} not found in the Census 2023 file")


def resolve_geometry(code: int, uf: str, refresh: bool) -> tuple[dict[str, Any], str]:
    """Return (geometry, source label), preferring the API and falling back to the UF mesh."""
    try:
        return geometry_from_api(code, refresh), "IBGE malhas API v3 (qualidade=intermediaria)"
    except requests.RequestException as exc:
        log.warning("IBGE malhas API unavailable for %d (%s); using the %s UF mesh",
                    code, type(exc).__name__, MESH_YEAR)
        return geometry_from_uf_mesh(code, uf, refresh), f"IBGE malha municipal {MESH_YEAR}, {uf} shapefile"


def simplified_feature(geometry: dict[str, Any], properties: dict[str, Any]) -> dict[str, Any]:
    from shapely.geometry import mapping, shape

    simple = shape(geometry).simplify(MAP_TOLERANCE_DEG, preserve_topology=True)
    return {"type": "Feature", "properties": properties, "geometry": mapping(simple)}


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)

    meta = load_config("regions.yaml")["meta"]
    rows: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []

    for mun in pilot_municipalities():
        code = int(mun["code"])
        official = None
        if mun["country"] == "US":
            geometry, official = geometry_from_census(code, args.refresh)
            geometry_source = CENSUS_LABEL
        else:
            geometry, geometry_source = resolve_geometry(code, mun["uf"], args.refresh)
        lon, lat = centroid(geometry)
        min_lon, min_lat, max_lon, max_lat = bounds(geometry)

        log.info("%s (%d): centroid %.4f, %.4f [%s]", mun["name"], code, lon, lat, geometry_source)
        row = {
            "code": code,
            "name": mun["name"],
            "uf": mun["uf"],
            "mesoregion": mun["mesoregion"],
            "region_id": mun["region_id"],
            "region_name": mun["region_name"],
            "country": mun["country"],
            "name_official": official,
            "enso_signal": mun["enso_signal"],
            "hazards": ",".join(mun["hazards"]),
            "centroid_lon": round(lon, 4),
            "centroid_lat": round(lat, 4),
            "min_lon": min_lon,
            "min_lat": min_lat,
            "max_lon": max_lon,
            "max_lat": max_lat,
            "geometry_source": geometry_source,
        }
        rows.append(row)
        features.append(simplified_feature(geometry, {k: row[k] for k in (
            "code", "name", "uf", "region_id", "country", "enso_signal", "centroid_lon", "centroid_lat")}))

    df = pd.DataFrame(rows)
    write_parquet(
        df,
        "regions.parquet",
        metadata={
            "source": "; ".join(sorted(set(df.geometry_source))),
            "centroid_method": "area-weighted polygon centroid, degrees lon/lat, full-resolution geometry",
            "climatology_baseline": f"{meta['climatology_baseline'][0]}-{meta['climatology_baseline'][1]}",
            "generated_by": "pipeline/fetch_regions.py",
        },
    )
    out = PROCESSED_DIR / "regions.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    log.info("wrote %s (%.1f KB, simplified at %.4f deg)", out.name, out.stat().st_size / 1024,
             MAP_TOLERANCE_DEG)
    print(df[["code", "name", "uf", "centroid_lon", "centroid_lat", "enso_signal", "geometry_source"]]
          .to_string(index=False))


if __name__ == "__main__":
    main()
