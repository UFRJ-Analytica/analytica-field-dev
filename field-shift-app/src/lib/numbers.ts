/**
 * Block 6: the payload of `POST /fields/{field_id}/numbers` (Data contracts Tables B and E), the
 * metric mirror of Table A that the surface reads, the formatting rules of Table A, and the
 * URL helpers of `?numbers=1` (R-01).
 *
 * Every type below is the shape the shipped route sends, not the shape the surface once assumed:
 * `climate.series` carries `rain_day`, `tmax_day` and `tmin_day`, each aggregate carries its own
 * `valid_days` and `of_days`, a soil depth carries the Table A token as `depth` beside the `_g_kg`
 * keys of Table E, a chart series carries its point list in its provenance `value`, a section
 * that cannot be read sends nulls rather than empty lists, and a window the route could not
 * resolve carries null in all five of its facts (`printedWindow` is the guard the surface uses
 * before it prints one). `src/test/numbers-recorded.json` is the
 * recorded response the suite renders, so a type that drifts from the route fails a test.
 */

export type Basis = 'observed' | 'retrieved' | 'modelled' | 'entered'
export type SectionState = 'ok' | 'abstained' | 'not_applicable' | 'unavailable'
export type Route = 'feature' | 'request' | 'api' | 'cogs' | 'canvas' | 'sidecar' | 'derived'

export type WindowInfo = {
  /**
   * The 42 day window of R-16. Every fact is null when the route could not resolve a window at
   * all, which is the shape R-48 sends offline: `{"start": null, "end": null, "days": null,
   * "valid_days": null, "dropped_days": null}`. `printedWindow` below turns it into the shape a
   * printed line needs, or into null.
   */
  start: string | null
  end: string | null
  days: number | null
  valid_days: number | null
  dropped_days: number | null
}

/** A window whose five facts are all present: the only shape the surface prints. */
export type PrintedWindow = {
  start: string
  end: string
  days: number
  valid_days: number
  dropped_days: number
}

/**
 * The window as the surface prints it, or null when any of its five facts is missing. A card with
 * no window prints its abstention text instead (R-12, R-48): never a null, a zero, a made up date,
 * or a window remembered from another read.
 */
export function printedWindow(window: WindowInfo | null | undefined): PrintedWindow | null {
  if (!window) return null
  const { start, end, days, valid_days, dropped_days } = window
  if (start === null || end === null) return null
  if (days === null || valid_days === null || dropped_days === null) return null
  return { start, end, days, valid_days, dropped_days }
}

export type NumbersRequest = {
  ring: [number, number][]
  centroid: [number, number]
  area_ha: number | null
  date: string
}

/** One row per printed number (R-07). `metric` is the only key. A chart series carries its points. */
export type ProvenanceRow = {
  metric: string
  label: string
  value: number | string | DailyPoint[] | null
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

/**
 * The daily families of Table A. The backend names them `rain_day`, `tmax_day` and `tmin_day`,
 * and one provenance row covers the whole family (R-07).
 */
export type ClimateSeries = { rain_day: DailyPoint[]; tmax_day: DailyPoint[]; tmin_day: DailyPoint[] }

/** One aggregate of R-18 as the route sends it: the value and the valid day count behind it (R-19). */
export type AggregateValue = { value: number | null; valid_days: number; of_days: number }

export type AggregateName =
  | 'rain_total'
  | 'dry_spell_days'
  | 'gdd10'
  | 'frost_days'
  | 'tmin_min'
  | 'gwetroot_mean'

/** One normal of R-20 as the route sends it. `of_years` and `excluded_years` are facts of the family. */
export type NormalValue = { value: number | null }

export type NormalName =
  | 'rain_median'
  | 'rain_min'
  | 'rain_max'
  | 'rain_rank'
  | 'rain_percentile'
  | 'hot_days'
  | 'hot_days_median'

export type ClimateSection = {
  state: SectionState
  basis: 'modelled'
  resolution: string | null
  source: string
  as_of: string | null
  fetched_at: string | null
  cached: boolean
  error?: string | null
  window: WindowInfo | null
  series: ClimateSeries
  aggregates: Partial<Record<AggregateName, AggregateValue>>
  normals: Partial<Record<NormalName, NormalValue>> & {
    of_years?: number | null
    excluded_years?: number[]
    error?: string | null
  }
}

export type WaterBalanceSection = {
  /** R-48 sends `unavailable` when POWER cannot be read at all; R-23 abstains the balance as a whole. */
  state: 'ok' | 'abstained' | 'unavailable'
  in: number | null
  out: number | null
  remaining: number | null
  formula: string
  /** Null when there is no window: the section is unavailable, or no consolidated rain day was found. */
  window: WindowInfo | null
  statement: string
  unit?: string
  out_label?: string
  missing?: { parameter: string; days: number } | null
  /** The reason an unavailable section carries (`ConnectError`, the HTTP status, ...). */
  error?: string | null
  basis: 'modelled'
  source: string
  as_of: string | null
  resolution: string | null
  fetched_at: string | null
  cached?: boolean
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
  /**
   * The failure the route records when the section cannot be read (`ConnectError`, the HTTP status,
   * a malformed response, ...). It is the field the route writes and the one the abstention row
   * prints; `reason` is the older key a payload may still carry.
   */
  error?: string | null
  reason?: string | null
}

export type NdviScene = {
  date: string
  cloud_cover: number
  ndvi_mean: number | null
  valid_fraction: number | null
  kept_pixels: number | null
  polygon_pixels: number | null
  /** Null until the COG reader of OD-01 can mark a point partial; the route sends null today. */
  partial: boolean | null
}

export type NdviSection = {
  state: SectionState
  scenes: NdviScene[]
  scene_count: number | null
  clear_count: number | null
  /**
   * Table E's ndvi `assets`: the B04, B08 and SCL addresses the STAC search returned, labelled by
   * their own file stem (`B04.tif` is `B04`). Empty when no search ran, never absent.
   */
  assets: string[]
  /**
   * R-29 names the best valid fraction. It is null while the COG reader of OD-01 is open, and
   * `best_valid_fraction_reason` names that missing producer beside it; a number means the reader
   * computed it. Nothing is ever filled in here.
   */
  best_valid_fraction: number | null
  best_valid_fraction_reason: string | null
  source: string
  as_of: string | null
  /**
   * The failure the route records when it could not read the section: the search window is unknown,
   * the STAC response is malformed, or the search itself failed. It is the field the route writes
   * and the one the abstention row prints; `reason` is the older key a payload may still carry.
   */
  error?: string | null
  reason?: string | null
}

/** The Table A depth token of a SoilGrids row. The payload also carries the display `label`. */
export type DepthToken = '0_5' | '5_15' | '15_30'

export type SoilDepth = {
  label: string
  depth: DepthToken
  clay_g_kg: number | null
  sand_g_kg: number | null
  ph: number | null
  soc_g_kg: number | null
}

export type SoilSection = {
  state: SectionState
  depths: SoilDepth[]
  missing?: string[]
  model_note: string
  source: string
  as_of: string | null
}

export type CropYear = { year: number; code: number; product: string; class_name: string }

export type RotationSection = {
  state: SectionState
  /** Null while the sidecar cannot be read: the route sends null, never an empty list, for that state. */
  first_crop: CropYear[] | null
  second_crop: CropYear[] | null
  collection: string
  collection_year: number | null
  sidecar: string
  basis: 'modelled'
  source: string
  as_of: string | null
  error?: string | null
  reason?: string | null
  second_crop_state_outside?: string | null
}

export type MunicipalityRow = { code: string; name: string; year: number; soy_ha: number | null }

export type MunicipalitySection = {
  state: SectionState
  municipality: MunicipalityRow | null
  /**
   * Table E's municipality `state` object. It is carried as `state_row` because the section's own
   * `state` key is the state token of R-45: one JSON object cannot hold both. Null when the field
   * carries no IBGE state code, and `state_reason` names why.
   */
  state_row: (MunicipalityRow & { label: string }) | null
  state_reason: string | null
  share: number | null
  source: string
  as_of: string | null
  /** The route records the unresolved municipal code here; the reader prints `error` first, then this key. */
  reason?: string | null
  /** Present only when the SIDRA read itself failed; the section abstains with this text. */
  error?: string | null
}

export type FragmentSection = {
  state: SectionState
  ring_area_ha: number
  area_ha: number | null
  difference_percent: number | null
  is_fragment: boolean | null
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
    fragment: FragmentSection
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

/**
 * Table A, Source column: the POWER parameter behind each aggregate of R-18. The abstention text of
 * R-19 names the missing input, and the payload carries the input as a fact of Table A rather than
 * as a field of each aggregate, so the mirror lives here and nowhere else.
 */
export const AGGREGATE_INPUTS: Record<AggregateName, string> = {
  rain_total: 'PRECTOTCORR',
  dry_spell_days: 'PRECTOTCORR',
  gdd10: 'T2M_MAX and T2M_MIN',
  frost_days: 'FROST_DAYS',
  tmin_min: 'T2M_MIN',
  gwetroot_mean: 'GWETROOT',
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
