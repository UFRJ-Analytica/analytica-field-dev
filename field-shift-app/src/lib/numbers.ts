/**
 * Block 6: the payload of `POST /fields/{field_id}/numbers` (Data contracts Tables B and E), the
 * metric mirror of Table A that the surface reads, the formatting rules of Table A, and the
 * URL helpers of `?numbers=1` (R-01).
 *
 * The backend route is not on `main` at this card (wave 1 of block 6). The surface is built
 * against the payload shape below and against a recorded payload (`src/test/numbers-recorded.ts`).
 */

export type Basis = 'observed' | 'retrieved' | 'modelled' | 'entered'
export type SectionState = 'ok' | 'abstained' | 'not_applicable' | 'unavailable'
export type Route = 'feature' | 'request' | 'api' | 'cogs' | 'canvas' | 'sidecar' | 'derived'

export type WindowInfo = {
  start: string
  end: string
  days: number
  valid_days: number
  dropped_days: number
}

export type NumbersRequest = {
  ring: [number, number][]
  centroid: [number, number]
  area_ha: number | null
  date: string
}

/** One row per printed number (R-07). `metric` is the only key. */
export type ProvenanceRow = {
  metric: string
  label: string
  value: number | string | null
  unit: string
  basis: Basis
  as_of: string | null
  source: string
  resolution: string
  route: Route
  fetched_at: string | null
}

/** One row per gap (R-41). The register prints these in the payload's order (R-42). */
export type GapRow = {
  section: string
  cause: string
  source: string
  status: string
  date: string
  remediation: string
}

export type DailyPoint = { date: string; value: number | null }

export type ClimateSection = {
  state: SectionState
  basis: 'modelled'
  resolution: string
  source: string
  as_of: string | null
  fetched_at: string | null
  cached: boolean
  error?: string | null
  series: { rain: DailyPoint[]; tmax: DailyPoint[]; tmin: DailyPoint[] }
  aggregates: {
    rain_total: number | null
    dry_spell_days: number | null
    gdd10: number | null
    frost_days: number | null
    tmin_min: number | null
    gwetroot_mean: number | null
  }
  normals: {
    rain_median: number | null
    rain_min: number | null
    rain_max: number | null
    rank: number | null
    of_years: number | null
    percentile: number | null
    hot_days: number | null
    hot_days_median: number | null
  }
  /** Valid day counts behind each aggregate (R-19), and the reason an aggregate abstained. */
  aggregate_valid: Partial<Record<keyof ClimateSection['aggregates'], { parameter: string; valid: number; days: number }>>
  normals_reason?: string | null
}

export type WaterBalanceSection = {
  state: 'ok' | 'abstained'
  in: number | null
  out: number | null
  remaining: number | null
  formula: string
  window: WindowInfo
  statement: string
  missing?: { parameter: string; days: number } | null
  basis: 'modelled'
  source: string
  as_of: string | null
  resolution: string
  fetched_at: string | null
}

export type SmapDay = {
  date: string
  surface_pct: number | null
  rootzone_pct: number | null
  status?: number | null
}

export type SmapSection = {
  state: SectionState
  days: SmapDay[]
  resolution: string
  shared_cell: string
  disclosure: string
  source: string
  as_of: string | null
  reason?: string | null
}

export type NdviScene = {
  date: string
  cloud_cover: number
  ndvi_mean: number | null
  valid_fraction: number | null
  kept_pixels: number | null
  polygon_pixels: number | null
  partial: boolean
}

export type NdviSection = {
  state: SectionState
  scenes: NdviScene[]
  scene_count: number | null
  clear_count: number | null
  best_valid_fraction: number | null
  assets: string[]
  source: string
  as_of: string | null
  reason?: string | null
}

export type SoilDepth = {
  depth: '0_5' | '5_15' | '15_30'
  clay_g_kg: number | null
  sand_g_kg: number | null
  ph: number | null
  soc_g_kg: number | null
}

export type SoilSection = {
  state: SectionState
  depths: SoilDepth[]
  missing: string[]
  model_note: string
  source: string
  as_of: string | null
}

/**
 * One sidecar row of the rotation section. `code` and `class_name` are null when the sidecar row
 * carries no class (Brazil, CO-B6-01), and the card prints that as not computed, never a name.
 */
export type CropYear = {
  year: number
  product: string
  code: number | null
  class_name: string | null
  collection?: number | null
}

/** The payload writes `first_crop` and `second_crop` as null when the sidecar holds no such product. */
export type RotationSection = {
  state: SectionState
  first_crop: CropYear[] | null
  second_crop: CropYear[] | null
  collection: string
  collection_year: number | null
  sidecar: string
  basis: 'modelled'
  source: string
  as_of: string | null
  reason?: string | null
  error?: string | null
  second_crop_state_outside?: string | null
}

export type MunicipalityRow = { code: string; name: string; year: number; soy_ha: number | null }

export type MunicipalitySection = {
  state: SectionState
  municipality: MunicipalityRow | null
  state_row: (MunicipalityRow & { label: string }) | null
  share: number | null
  source: string
  as_of: string | null
  reason?: string | null
}

export type NumbersPayload = {
  schema_version: string
  field_id: string
  region: 'us' | 'br'
  query: NumbersRequest & { window: WindowInfo }
  sections: {
    climate: ClimateSection
    water_balance: WaterBalanceSection
    smap: SmapSection
    ndvi: NdviSection
    soil: SoilSection
    rotation: RotationSection
    municipality: MunicipalitySection
  }
  provenance: ProvenanceRow[]
  gaps: GapRow[]
}

/**
 * Table A mirror for the metrics the surface prints: unit, decimals, basis, resolution and
 * route per family. The basis label of a row comes from the row's own `basis` (R-08, R-09);
 * this table only supplies the printed decimals and unit of a family, never a label.
 */
export const METRICS: Record<string, { unit: string; decimals: number; route: Route }> = {
  area: { unit: 'ha', decimals: 1, route: 'feature' },
  ring_area: { unit: 'ha', decimals: 2, route: 'request' },
  rain_total: { unit: 'mm', decimals: 1, route: 'api' },
  dry_spell_days: { unit: 'days', decimals: 0, route: 'api' },
  gdd10: { unit: 'C day', decimals: 0, route: 'api' },
  frost_days: { unit: 'days', decimals: 0, route: 'api' },
  tmin_min: { unit: 'C', decimals: 1, route: 'api' },
  gwetroot_mean: { unit: '1', decimals: 2, route: 'api' },
  rain_day: { unit: 'mm', decimals: 1, route: 'api' },
  tmax_day: { unit: 'C', decimals: 1, route: 'api' },
  tmin_day: { unit: 'C', decimals: 1, route: 'api' },
  rain_median: { unit: 'mm', decimals: 1, route: 'api' },
  rain_min: { unit: 'mm', decimals: 1, route: 'api' },
  rain_max: { unit: 'mm', decimals: 1, route: 'api' },
  rain_rank: { unit: 'years', decimals: 0, route: 'derived' },
  rain_percentile: { unit: 'percent', decimals: 0, route: 'derived' },
  hot_days: { unit: 'days', decimals: 0, route: 'api' },
  hot_days_median: { unit: 'days', decimals: 0, route: 'api' },
  wb_in: { unit: 'mm', decimals: 1, route: 'derived' },
  wb_out: { unit: 'mm', decimals: 1, route: 'derived' },
  wb_remaining: { unit: 'mm', decimals: 1, route: 'derived' },
  smap_surface: { unit: 'percent of the served palette', decimals: 0, route: 'canvas' },
  smap_rootzone: { unit: 'percent of the served palette', decimals: 0, route: 'canvas' },
  'ndvi_mean': { unit: 'unitless', decimals: 3, route: 'cogs' },
  'ndvi_valid_fraction': { unit: 'fraction', decimals: 2, route: 'cogs' },
  ndvi_scene_count: { unit: 'scenes', decimals: 0, route: 'api' },
  ndvi_clear_count: { unit: 'scenes', decimals: 0, route: 'api' },
  'soil.clay': { unit: 'g/kg', decimals: 0, route: 'api' },
  'soil.sand': { unit: 'g/kg', decimals: 0, route: 'api' },
  'soil.ph': { unit: 'pH', decimals: 1, route: 'api' },
  'soil.soc': { unit: 'g/kg', decimals: 1, route: 'api' },
  mb_first_crop: { unit: 'class name', decimals: 0, route: 'sidecar' },
  mb_second_crop: { unit: 'class name', decimals: 0, route: 'sidecar' },
  municipality_soy_ha: { unit: 'ha', decimals: 0, route: 'api' },
  state_soy_ha: { unit: 'ha', decimals: 0, route: 'api' },
  polygon_share: { unit: 'percent', decimals: 4, route: 'derived' },
}

/** The Table A family of a metric id: `soil.clay.0_5` is `soil.clay`, `ndvi_mean.2026-10-07` is `ndvi_mean`. */
export function familyOf(metric: string): string {
  if (metric.startsWith('soil.')) return metric.split('.').slice(0, 2).join('.')
  return metric.split('.')[0]
}

/** Table A: round half up to the family's decimals. Null and non-finite values print nothing. */
export function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals
  const sign = value < 0 ? -1 : 1
  return (sign * Math.round(Math.abs(value) * factor + 1e-9)) / factor
}

/** A printed number: the family's decimals, round half up, grouped as en-US, and no unit (the unit is printed beside it). */
export function formatMetric(metric: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return ''
  const decimals = METRICS[familyOf(metric)]?.decimals ?? 0
  return roundHalfUp(value, decimals).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** R-08: `observed`, `retrieved` and `entered` present as measured; `modelled` never does. */
export function isMeasuredBasis(basis: Basis): boolean {
  return basis !== 'modelled'
}

const OPEN_PARAM = 'numbers'

/** R-01: `?numbers=1` is the only record of the open state. */
export function numbersOpenFromSearch(search: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search
  return query.split('&').some((part) => part === `${OPEN_PARAM}=1`)
}

/**
 * R-01: opening appends `numbers=1` and closing removes that parameter alone. Every other
 * parameter is kept as the raw segment it was, so `date`, `region`, `polygon` and `basemap`
 * survive byte for byte.
 */
export function searchWithNumbers(search: string, open: boolean): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  const segments = query === '' ? [] : query.split('&')
  const kept = segments.filter((part) => part !== `${OPEN_PARAM}=1` && part !== OPEN_PARAM && !part.startsWith(`${OPEN_PARAM}=`))
  if (open) kept.push(`${OPEN_PARAM}=1`)
  return kept.length === 0 ? '' : `?${kept.join('&')}`
}

/**
 * The outer ring of a rendered polygon feature's geometry, as `[lon, lat]` pairs. A MultiPolygon
 * contributes its first part. Null for any other geometry, so no ring is ever invented.
 */
export function outerRingOf(geometry: unknown): [number, number][] | null {
  if (geometry === null || typeof geometry !== 'object') return null
  const g = geometry as { type?: string; coordinates?: unknown }
  let ring: unknown = null
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) ring = g.coordinates[0]
  else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) ring = (g.coordinates[0] as unknown[] | undefined)?.[0]
  if (!Array.isArray(ring) || ring.length < 3) return null
  const points: [number, number][] = []
  for (const pair of ring) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') return null
    points.push([pair[0], pair[1]])
  }
  return points
}

/**
 * An interior point of a ring, for the request's `centroid` (the body rule of Table B: the
 * centroid must lie inside the ring). The area centroid is used when it is inside; otherwise the
 * midpoint of the widest run inside the ring on a horizontal scanline through the middle of the
 * bounding box. Returns null for a ring with no interior.
 */
export function interiorPoint(ring: [number, number][]): [number, number] | null {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring
  if (pts.length < 3) return null
  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i += 1) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    twiceArea += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (twiceArea !== 0) {
    const centre: [number, number] = [cx / (3 * twiceArea), cy / (3 * twiceArea)]
    if (containsPoint(pts, centre)) return centre
  }
  const ys = pts.map((p) => p[1])
  const yMid = (Math.min(...ys) + Math.max(...ys)) / 2
  const xs: number[] = []
  for (let i = 0; i < pts.length; i += 1) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    if ((y0 <= yMid && y1 > yMid) || (y1 <= yMid && y0 > yMid)) {
      xs.push(x0 + ((yMid - y0) * (x1 - x0)) / (y1 - y0))
    }
  }
  xs.sort((a, b) => a - b)
  let best: [number, number] | null = null
  let bestWidth = -1
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const width = xs[i + 1] - xs[i]
    if (width > bestWidth) {
      bestWidth = width
      best = [(xs[i] + xs[i + 1]) / 2, yMid]
    }
  }
  return best
}

function containsPoint(pts: [number, number][], [px, py]: [number, number]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
