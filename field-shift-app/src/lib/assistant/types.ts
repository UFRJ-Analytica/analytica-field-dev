/**
 * Field Shift AI contracts. They are adapters over the block 6 payload (`NumbersPayload`), not a
 * second schema: an Evidence keeps the block 6 provenance row's own value, unit, source, as_of,
 * basis and resolution, and only adds what the assistant needs to cite it.
 */
import type { Locale } from '@/strings'
import type { Basis, GapRow, NumbersPayload, Route } from '@/lib/numbers'

/**
 * `retrieved`, `modelled`, `observed` and `entered` come from the row's own basis. `derived` is a
 * block 6 row whose route is `derived` (computed from other rows). `fixture` is a value recorded for
 * a demonstration: the scenario fixture or the experimental crop water snapshot.
 */
export type EvidenceBasis = Basis | 'derived' | 'fixture'

export type Evidence = {
  /** Stable id: the block 6 metric id, or `crop_water.<crop>.<metric>` for the experiment. */
  id: string
  metric: string
  value: number | string | null
  /** The source unit as printed by block 6 (`mm`, `C`, `days`, ...); formatted per locale at render. */
  unit: string | null
  /** Printed decimals when the metric is not in block 6's Table A mirror (agent-derived metrics). */
  decimals?: number | null
  source: string
  asOf: string | null
  period: { start: string; end: string } | null
  basis: EvidenceBasis
  /** The basis the source row itself carries, kept when `basis` is `derived` or `fixture`. */
  sourceBasis: Basis | null
  resolution: string | null
  route: Route | 'snapshot'
  /** Limitation codes, translated at render (see strings/assistant.ts `limit.*`). */
  limitations: LimitationCode[]
}

export type LimitationCode =
  | 'coarse_cell'
  | 'modelled_not_measured'
  | 'evland_not_crop_demand'
  | 'palette_not_physical'
  | 'point_sample'
  | 'experimental_snapshot'
  | 'standard_kc'
  | 'climatic_difference_not_irrigation'
  | 'historical_not_forecast'
  | 'needs_sowing_date'
  | 'needs_farm_records'
  | 'comparator_not_built'
  | 'planting_window_not_decision'
  | 'zarc_municipal_envelope'
  | 'seasonless_state_average'

export type Intent =
  | 'explain_field'
  | 'environment'
  | 'rainfall'
  | 'planting'
  | 'water_demand'
  | 'sources'
  | 'missing'
  | 'recommendation'
  | 'unsupported'

export type AssistantResponse = {
  id: string
  /** The field the answer was computed for. A response is never shown for another field. */
  fieldId: string | null
  /** The context key (field, date, ring) the answer belongs to. */
  contextKey: string
  locale: Locale
  intent: Intent
  /** Paragraphs, already in `locale`. */
  answer: string[]
  evidence: Evidence[]
  limitations: LimitationCode[]
  status: 'answered' | 'partial' | 'unavailable'
  /** `deterministic` in this milestone. `agent` is reserved for the LLM tool-calling backend. */
  mode: 'deterministic' | 'agent'
  /** The recorded crop water set the answer compared, rendered as a compact table. */
  cropWater?: CropWaterSet | null
}

export type NumbersStatus =
  | { kind: 'no_field' }
  | { kind: 'ring_missing' }
  | { kind: 'loading' }
  | { kind: 'ready'; payload: NumbersPayload; cached: boolean }
  | { kind: 'held'; payload: NumbersPayload }
  | { kind: 'error'; status: number }
  | { kind: 'offline' }

export type FieldContext = {
  fieldId: string | null
  /** `fixture` for the three demonstration fields, `polygon` for a block 5 polygon. */
  kind: 'fixture' | 'polygon' | null
  name: string | null
  location: string | null
  regionId: string
  date: string
  /** The key that invalidates answers: field, date and ring. */
  key: string
  /** A polygon's ring and interior point, the only geometry the agent request carries. */
  polygonGeometry: { ring: [number, number][]; centroid: [number, number] } | null
  numbers: NumbersStatus
}

/** Optional future contract of crop water results (FAO-56 experiment). Never computed in the browser. */
export type CropWaterResult = {
  cropId: string
  cropName: string
  et0TotalMm: number | null
  etcTotalMm: number | null
  rainTotalMm: number | null
  /** Rain minus ETc over the window. A climatic difference, not an irrigation requirement. */
  rainMinusEtcMm: number | null
  kc: { initial: number; mid: number; end: number }
  kcMode: string
  method: { penmanMonteithDays: number; hargreavesDays: number; unavailableDays: number }
  coverage: { validDays: number; windowDays: number }
  state: string
  source: string
  kcSource: string
}

export type CropWaterSet = {
  /** Where the numbers come from: `experimental_snapshot` now, `api` once a route is approved. */
  origin: 'experimental_snapshot' | 'api'
  fieldId: string
  point: { longitude: number; latitude: number }
  period: { start: string; end: string; chosenDate: string }
  resolution: string
  crops: CropWaterResult[]
  limitations: string[]
}

export type { GapRow }
