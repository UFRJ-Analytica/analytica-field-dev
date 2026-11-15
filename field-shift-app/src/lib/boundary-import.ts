/**
 * Block 7, R-37, R-38 and R-39: the two import readers and the one ring validator.
 *
 * A reader returns the ring it read and nothing else; the validator returns the one catalog code of
 * Table D that rejected the ring, in the order Table D lists the rules, so a ring that breaks two
 * rules reports the first. Every visible string is a catalog key here: this module never carries a
 * sentence, because R-39 forbids a component from rewording one and AC-35 scans for literals.
 */
import {
  MAX_AREA_HA,
  MAX_OVERLAP_PERCENT,
  MAX_VERTICES,
  closeRing,
  distinctVertexCount,
  overlapPercent,
  ringAreaHa,
  ringSelfIntersects,
  ringWithinBounds,
  type Ring,
  type RingPoint,
} from './field-ring'

/** Table D, rows V-01 to V-12: the rejections a read or a validation can raise. */
export type ImportErrorCode =
  | 'import.unreadable'
  | 'import.no_polygon'
  | 'import.multi_polygon'
  | 'import.holes'
  | 'import.kml_polygons'
  | 'import.too_few_points'
  | 'import.too_many_points'
  | 'import.self_intersection'
  | 'import.no_area'
  | 'import.out_of_bounds'
  | 'import.too_large'
  | 'import.overlap'

export type ReadResult = { ok: true; ring: Ring } | { ok: false; code: ImportErrorCode }

export type ValidationResult =
  | { ok: true; ring: Ring; areaHa: number; overlapPercent: number }
  | { ok: false; code: ImportErrorCode }

function asRing(coordinates: unknown): Ring | null {
  if (!Array.isArray(coordinates)) return null
  const ring: Ring = []
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length < 2) return null
    const lon = Number(point[0])
    const lat = Number(point[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
    ring.push([lon, lat] as RingPoint)
  }
  return ring
}

type GeoJsonGeometry = { type?: unknown; coordinates?: unknown }

function polygonRingOf(geometry: GeoJsonGeometry | null | undefined): ReadResult {
  if (!geometry || geometry.type !== 'Polygon') return { ok: false, code: 'import.no_polygon' }
  const rings = geometry.coordinates
  if (!Array.isArray(rings) || rings.length === 0) return { ok: false, code: 'import.no_polygon' }
  // R-37: the first ring is the outer ring and a polygon with holes is rejected.
  if (rings.length > 1) return { ok: false, code: 'import.holes' }
  const ring = asRing(rings[0])
  if (!ring) return { ok: false, code: 'import.unreadable' }
  return { ok: true, ring: closeRing(ring) }
}

/**
 * R-37: a `Feature` whose geometry is a `Polygon`, a bare `Polygon` geometry, or a
 * `FeatureCollection` holding exactly one polygon feature. A `MultiPolygon` and a second polygon are
 * two different rejections, V-03, as Table D lists them.
 */
export function readGeoJSON(text: string): ReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'import.unreadable' }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, code: 'import.unreadable' }
  const value = parsed as Record<string, unknown>

  if (value.type === 'FeatureCollection') {
    const features = value.features
    if (!Array.isArray(features) || features.length === 0) return { ok: false, code: 'import.no_polygon' }
    const polygons = features.filter((feature) => {
      const geometry = (feature as GeoJsonGeometry & { geometry?: GeoJsonGeometry })?.geometry
      return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon'
    })
    if (polygons.length === 0) return { ok: false, code: 'import.no_polygon' }
    if (polygons.length > 1) return { ok: false, code: 'import.multi_polygon' }
    const geometry = (polygons[0] as { geometry?: GeoJsonGeometry }).geometry
    if (geometry?.type === 'MultiPolygon') return { ok: false, code: 'import.multi_polygon' }
    return polygonRingOf(geometry)
  }

  if (value.type === 'Feature') {
    const geometry = value.geometry as GeoJsonGeometry | undefined
    if (geometry?.type === 'MultiPolygon') return { ok: false, code: 'import.multi_polygon' }
    return polygonRingOf(geometry)
  }

  if (value.type === 'MultiPolygon') return { ok: false, code: 'import.multi_polygon' }
  return polygonRingOf(value as GeoJsonGeometry)
}

/**
 * R-37: a KML 2.2 document, `<Polygon>` with `<outerBoundaryIs><LinearRing><coordinates>`, `lon,lat`
 * pairs separated by whitespace, an altitude ignored when present. A document with no polygon or
 * with more than one, and a polygon with an inner boundary, are rejected.
 */
export function readKML(text: string): ReadResult {
  if (typeof DOMParser === 'undefined') return { ok: false, code: 'import.unreadable' }
  let document: Document
  try {
    document = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    return { ok: false, code: 'import.unreadable' }
  }
  if (document.getElementsByTagName('parsererror').length > 0) return { ok: false, code: 'import.unreadable' }

  const polygons = document.getElementsByTagName('Polygon')
  if (polygons.length !== 1) return { ok: false, code: 'import.kml_polygons' }
  const polygon = polygons[0]
  if (polygon.getElementsByTagName('innerBoundaryIs').length > 0) return { ok: false, code: 'import.holes' }

  const outer = polygon.getElementsByTagName('outerBoundaryIs')
  if (outer.length === 0) return { ok: false, code: 'import.kml_polygons' }
  const coordinates = outer[0].getElementsByTagName('coordinates')
  if (coordinates.length === 0) return { ok: false, code: 'import.kml_polygons' }
  const raw = (coordinates[0].textContent ?? '').trim()
  if (raw === '') return { ok: false, code: 'import.kml_polygons' }

  const ring: Ring = []
  for (const tuple of raw.split(/\s+/).filter(Boolean)) {
    const parts = tuple.split(',')
    if (parts.length < 2) return { ok: false, code: 'import.unreadable' }
    const lon = Number(parts[0])
    const lat = Number(parts[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ok: false, code: 'import.unreadable' }
    ring.push([lon, lat])
  }
  if (ring.length === 0) return { ok: false, code: 'import.kml_polygons' }
  return { ok: true, ring: closeRing(ring) }
}

/**
 * R-38 and Table D: every rule of the table in the order it lists them, returning the first one the
 * ring breaks. `existing` is every registered field's ring and, through the caller, every crop
 * polygon of the active region: the overlap test reads the rings it is given and never the camera.
 */
export function validateRing(ring: readonly RingPoint[], existing: readonly Ring[] = []): ValidationResult {
  const closed = closeRing(ring)
  const distinct = distinctVertexCount(closed)
  if (distinct < 3) return { ok: false, code: 'import.too_few_points' }
  if (distinct > MAX_VERTICES) return { ok: false, code: 'import.too_many_points' }
  if (!ringWithinBounds(closed)) return { ok: false, code: 'import.out_of_bounds' }
  if (ringSelfIntersects(closed)) return { ok: false, code: 'import.self_intersection' }
  const areaHa = ringAreaHa(closed)
  if (!(areaHa > 0)) return { ok: false, code: 'import.no_area' }
  if (areaHa > MAX_AREA_HA) return { ok: false, code: 'import.too_large' }
  let worst = 0
  for (const other of existing) worst = Math.max(worst, overlapPercent(closed, other))
  if (worst > MAX_OVERLAP_PERCENT) return { ok: false, code: 'import.overlap' }
  return { ok: true, ring: closed, areaHa, overlapPercent: worst }
}

/** The file leaf of an imported name, for the `source_file` key of Table C. */
export function fileLeaf(name: string): string {
  const parts = name.split(/[\\/]/)
  return parts[parts.length - 1] ?? name
}
