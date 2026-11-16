/**
 * Evidence Adapter: block 6 payload -> Evidence[]. It reads `payload.provenance`, the one row per
 * printed number that the backend and the frontend agree on field for field, and `payload.gaps`.
 * It never reads `sections.climate` keys, whose shape differs between the route on main and the
 * frontend types (series and normals keys; see FIELD_SHIFT_AI_MVP.md, "Known contract risk").
 */
import type { NumbersPayload, ProvenanceRow } from '@/lib/numbers'
import { assistantEn, type AssistantKey } from '@/strings/assistant'
import type { Evidence, GapRow, LimitationCode } from './types'

/** The few indicators the assistant summarises, in reading order. The full set stays on NumbersView. */
export const SUMMARY_METRICS = [
  'rain_total',
  'rain_median',
  'rain_percentile',
  'dry_spell_days',
  'hot_days',
  'hot_days_median',
  'tmin_min',
  'frost_days',
  'gwetroot_mean',
  'wb_remaining',
  'ndvi_clear_count',
  'soil.clay.0_5',
  'soil.ph.0_5',
] as const

export type SummaryMetric = (typeof SUMMARY_METRICS)[number]

/** The overview shows four of them. */
export const OVERVIEW_METRICS: SummaryMetric[] = ['rain_total', 'dry_spell_days', 'hot_days', 'gwetroot_mean']

/**
 * The catalog key of a metric's label: `soil.clay.0_5` -> `metric.soil.clay`, `rain_week.3` ->
 * `metric.rain_week`, `rain_total` -> `metric.rain_total`. Null when the catalog has no label.
 */
export function metricLabelKey(metric: string): AssistantKey | null {
  const parts = metric.split('.')
  const family = metric.startsWith('soil.') ? parts.slice(0, 2).join('.') : parts[0]
  const key = `metric.${family}`
  return key in assistantEn ? key as AssistantKey : null
}

function limitationsFor(row: ProvenanceRow): LimitationCode[] {
  const codes: LimitationCode[] = []
  if ((row.resolution ?? '').includes('0.5 degree')) codes.push('coarse_cell')
  if (row.basis === 'modelled') codes.push('modelled_not_measured')
  if (row.metric.startsWith('wb_')) codes.push('evland_not_crop_demand')
  if (row.metric.startsWith('smap_')) codes.push('palette_not_physical')
  if (row.metric.startsWith('soil.')) codes.push('point_sample')
  return codes
}

const WINDOWED = new Set(['rain_total', 'dry_spell_days', 'hot_days', 'tmin_min', 'frost_days', 'gwetroot_mean',
  'wb_remaining', 'rain_percentile', 'rain_median', 'hot_days_median', 'ndvi_clear_count'])

export function evidenceFromRow(row: ProvenanceRow, payload: NumbersPayload): Evidence {
  const window = payload.query.window
  const period = WINDOWED.has(row.metric) && window?.start && window?.end
    ? { start: window.start, end: window.end }
    : null
  const value = Array.isArray(row.value) ? null : row.value
  return {
    id: row.metric,
    metric: row.metric,
    value: typeof value === 'number' || typeof value === 'string' ? value : null,
    unit: row.unit ?? null,
    source: row.source,
    asOf: row.as_of,
    period,
    basis: row.route === 'derived' ? 'derived' : row.basis,
    sourceBasis: row.basis,
    resolution: row.resolution ?? null,
    route: row.route,
    limitations: limitationsFor(row),
  }
}

/**
 * The summary evidence of a payload, guarded by field: a payload of another field yields nothing,
 * so an answer can never cite numbers of a field the user is not looking at.
 */
export function summaryEvidence(payload: NumbersPayload, fieldId: string,
  metrics: readonly string[] = SUMMARY_METRICS): Evidence[] {
  if (payload.field_id !== fieldId) return []
  const rows = new Map(payload.provenance.map((row) => [row.metric, row]))
  return metrics.flatMap((metric) => {
    const row = rows.get(metric)
    return row ? [evidenceFromRow(row, payload)] : []
  })
}

export function gapsOf(payload: NumbersPayload, fieldId: string): GapRow[] {
  return payload.field_id === fieldId ? payload.gaps : []
}

const SECTION_KEYS: Record<string, AssistantKey> = {
  climate: 'section.climate',
  water_balance: 'section.water_balance',
  smap: 'section.smap',
  ndvi: 'section.ndvi',
  soil: 'section.soil',
  rotation: 'section.rotation',
  municipality: 'section.municipality',
  fragment: 'section.fragment',
  header: 'section.header',
}

export function sectionKey(section: string): AssistantKey {
  return SECTION_KEYS[section] ?? 'section.other'
}

/** The catalog key of a gap status code, with its variables. Free-text causes are never reworded. */
export function gapStatusKey(status: string): { key: AssistantKey; vars?: Record<string, string> } {
  const s = status.toLowerCase()
  if (/^\d{3}$/.test(s)) return { key: 'gap.http', vars: { status: s } }
  if (s.includes('below 80')) return { key: 'gap.coverage_80' }
  if (s.includes('below 100')) return { key: 'gap.coverage_100' }
  if (s.includes('no valid rain day') || s.includes('no window') || s.includes('window unknown')) return { key: 'gap.no_valid_rain_day' }
  if (s.includes('malformed')) return { key: 'gap.malformed' }
  if (s.includes('fill day')) return { key: 'gap.fill_day' }
  if (s.includes('not built')) return { key: 'gap.reader_not_built' }
  if (s.includes('not approved')) return { key: 'gap.reader_not_approved' }
  if (s.includes('region absent')) return { key: 'gap.region_absent' }
  if (s.includes('unresolved')) return { key: 'gap.unresolved' }
  if (s === 'offline') return { key: 'gap.offline' }
  if (s.includes('no row')) return { key: 'gap.no_row' }
  if (s.includes('read failed')) return { key: 'gap.read_failed' }
  if (s.includes('not recorded')) return { key: 'gap.not_recorded' }
  if (s.includes('absent')) return { key: 'gap.absent' }
  return { key: 'gap.other' }
}
