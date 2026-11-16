/**
 * Optional crop water input (FAO-56 experiment). No formula runs in the browser: this module only
 * reads the recorded, validated output of `artifacts/experiment/demo_crop_water.py` and releases it
 * for one field and one window. Every other field or window gets `null`, and the assistant prints
 * the "not yet available" sentence instead.
 *
 * Release conditions (all required):
 *   1. the selected field is a fixture field whose centre is the snapshot's point;
 *   2. the block 6 payload of that field has the snapshot's exact window (start and end);
 *   3. the snapshot was produced offline from recorded responses (`reproducibility.network_used` false).
 */
import snapshot from '../../../artifacts/experiment/demo_crop_water_results.json'
import type { NumbersPayload } from '@/lib/numbers'
import type { CropWaterResult, CropWaterSet, Evidence } from './types'

type SnapshotCrop = {
  crop_id: string
  crop: string
  et0_total_mm: number | null
  etc_total_mm: number | null
  rain_total_mm: number | null
  rain_minus_etc_mm: number | null
  kc_mode: string
  kc_source: string
  kc_values: { initial: number; mid: number; end: number }
  state: string
  valid_days: number
}

type Snapshot = {
  point: { longitude: number; latitude: number }
  period: { start: string; end: string; chosen_date: string; days: number }
  crops_peak_kc: Record<string, SnapshotCrop>
  et0: { method_counts: { 'penman-monteith': number; hargreaves: number; unavailable: number } }
  source: { name: string; resolution: string }
  limitations: string[]
  reproducibility: { network_used: boolean }
}

const SNAPSHOT = snapshot as unknown as Snapshot
const POINT_TOLERANCE_DEG = 1e-6

export type FieldForCropWater = { fieldId: string; kind: 'fixture' | 'polygon' | null; center: [number, number] | null }

export function snapshotPeriod(): { start: string; end: string } {
  return { start: SNAPSHOT.period.start, end: SNAPSHOT.period.end }
}

/**
 * The chosen date whose block 6 window is the snapshot's window, which the guided demo sets. Block 6
 * R-16 ends the window on the last day at or before the chosen date with valid rain, so choosing the
 * window's own end gives exactly the recorded window whenever that day has data, whatever the NASA
 * POWER lag. The snapshot's `chosen_date` (recorded while POWER lagged) and the fixture's date (the
 * day after the end) give a later window once POWER has caught up, which the release rule refuses.
 */
export function snapshotChosenDate(): string {
  return SNAPSHOT.period.end
}

export function cropWaterFor(field: FieldForCropWater, payload: NumbersPayload | null): CropWaterSet | null {
  if (field.kind !== 'fixture' || field.center === null || payload === null) return null
  if (payload.field_id !== field.fieldId) return null
  if (SNAPSHOT.reproducibility.network_used) return null
  const [lon, lat] = field.center
  if (Math.abs(lon - SNAPSHOT.point.longitude) > POINT_TOLERANCE_DEG
    || Math.abs(lat - SNAPSHOT.point.latitude) > POINT_TOLERANCE_DEG) return null
  const window = payload.query.window
  if (!window || window.start !== SNAPSHOT.period.start || window.end !== SNAPSHOT.period.end) return null

  const methods = SNAPSHOT.et0.method_counts
  const crops: CropWaterResult[] = Object.values(SNAPSHOT.crops_peak_kc).map((crop) => ({
    cropId: crop.crop_id,
    cropName: crop.crop,
    et0TotalMm: crop.et0_total_mm,
    etcTotalMm: crop.etc_total_mm,
    rainTotalMm: crop.rain_total_mm,
    rainMinusEtcMm: crop.rain_minus_etc_mm,
    kc: crop.kc_values,
    kcMode: crop.kc_mode,
    method: { penmanMonteithDays: methods['penman-monteith'], hargreavesDays: methods.hargreaves, unavailableDays: methods.unavailable },
    coverage: { validDays: crop.valid_days, windowDays: SNAPSHOT.period.days },
    state: crop.state,
    source: SNAPSHOT.source.name,
    kcSource: crop.kc_source,
  }))
  return {
    origin: 'experimental_snapshot',
    fieldId: field.fieldId,
    point: SNAPSHOT.point,
    period: { start: SNAPSHOT.period.start, end: SNAPSHOT.period.end, chosenDate: SNAPSHOT.period.chosen_date },
    resolution: SNAPSHOT.source.resolution,
    crops,
    limitations: SNAPSHOT.limitations,
  }
}

export function cropWaterEvidence(set: CropWaterSet): Evidence[] {
  const period = { start: set.period.start, end: set.period.end }
  const common = {
    source: `${set.crops[0]?.source ?? 'NASA POWER'}; FAO-56 (artifacts/experiment)`,
    asOf: set.period.end,
    period,
    basis: 'fixture' as const,
    sourceBasis: 'modelled' as const,
    resolution: set.resolution,
    route: 'snapshot' as const,
  }
  const first = set.crops[0]
  const rows: Evidence[] = first
    ? [{ ...common, id: 'crop_water.et0_total', metric: 'et0_total', value: first.et0TotalMm, unit: 'mm',
      limitations: ['experimental_snapshot', 'coarse_cell', 'modelled_not_measured'] }]
    : []
  for (const crop of set.crops) {
    rows.push({ ...common, id: `crop_water.${crop.cropId}.etc_total`, metric: `etc_total.${crop.cropId}`,
      value: crop.etcTotalMm, unit: 'mm', limitations: ['experimental_snapshot', 'standard_kc'] })
    rows.push({ ...common, id: `crop_water.${crop.cropId}.rain_minus_etc`, metric: `rain_minus_etc.${crop.cropId}`,
      value: crop.rainMinusEtcMm, unit: 'mm', limitations: ['experimental_snapshot', 'climatic_difference_not_irrigation'] })
    rows.push({ ...common, id: `crop_water.${crop.cropId}.kc_mid`, metric: `kc_mid.${crop.cropId}`,
      value: crop.kc.mid, unit: null, decimals: 2, limitations: ['standard_kc'] })
  }
  for (const diff of etcDifferences(set)) {
    rows.push({ ...common, id: `crop_water.diff.${diff.first}_minus_${diff.second}`, metric: `etc_difference.${diff.first}.${diff.second}`,
      value: diff.mm, unit: 'mm', decimals: 1, limitations: ['experimental_snapshot', 'standard_kc'] })
  }
  return rows
}

/**
 * Pairwise ETc differences (first minus second, crop ids in alphabetical order), the same pairs the
 * backend tool registers. A subtraction of two recorded totals, rounded half up to 0.1 mm like the
 * totals themselves; no FAO-56 equation runs here.
 */
export function etcDifferences(set: CropWaterSet): { first: string; second: string; mm: number; percent: number | null }[] {
  const totals = set.crops.filter((c) => c.etcTotalMm !== null).sort((a, b) => a.cropId.localeCompare(b.cropId))
  const out: { first: string; second: string; mm: number; percent: number | null }[] = []
  totals.forEach((a, i) => {
    for (const b of totals.slice(i + 1)) {
      const mm = Math.round(((a.etcTotalMm as number) - (b.etcTotalMm as number)) * 10) / 10
      const percent = (b.etcTotalMm as number) !== 0 ? Math.round((mm / (b.etcTotalMm as number)) * 1000) / 10 : null
      out.push({ first: a.cropId, second: b.cropId, mm, percent })
    }
  })
  return out
}
