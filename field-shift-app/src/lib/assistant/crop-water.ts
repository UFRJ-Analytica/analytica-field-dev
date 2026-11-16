/**
 * Crop water input (FAO-56). No formula runs in the browser: the numbers come from the backend route
 * `GET /fields/<id>/crop-water`, which computes ET0 (FAO-56 eq. 52) from the recorded block 6 series,
 * multiplies it by the FAO-56 Table 12 Kc of each crop over that crop's usual planting window (the
 * NASS bulletin) and registers the difference from the rain. This module keeps the last set the route
 * returned and releases it for the field and the window it was computed for; every other field or
 * window gets `null` and the assistant prints the "not yet available" sentence.
 *
 * Release conditions (all required):
 *   1. the selected field is a fixture field;
 *   2. the set was computed for that same field id;
 *   3. the block 6 payload of that field has the set's exact window (start and end).
 */
import type { NumbersPayload } from '@/lib/numbers'
import type { CropWaterResult, CropWaterSet, Evidence } from './types'

export type FieldForCropWater = { fieldId: string; kind: 'fixture' | 'polygon' | null; center: [number, number] | null }

let feed: CropWaterSet | null = null

/** Written by `useCropWater` after the route answers; `null` clears it (another field, another date). */
export function setCropWaterFeed(set: CropWaterSet | null): void {
  feed = set
}

export function cropWaterFeed(): CropWaterSet | null {
  return feed
}

/** The window of the set in hand, for the demo date; `null` when the route has not answered yet. */
export function cropWaterPeriod(): { start: string; end: string } | null {
  return feed === null ? null : { start: feed.period.start, end: feed.period.end }
}

export function cropWaterFor(field: FieldForCropWater, payload: NumbersPayload | null): CropWaterSet | null {
  if (field.kind !== 'fixture' || field.center === null || payload === null || feed === null) return null
  if (payload.field_id !== field.fieldId || feed.fieldId !== field.fieldId) return null
  const window = payload.query.window
  if (!window || window.start !== feed.period.start || window.end !== feed.period.end) return null
  return feed
}

/** The route's body, as `CropWaterSet`. Nothing is invented: a field the route did not release has none. */
export function cropWaterSetFrom(body: CropWaterBody, fieldId: string): CropWaterSet | null {
  if (!body.available || !body.crops) return null
  const crops: CropWaterResult[] = Object.values(body.crops)
    .filter((crop) => crop.state === 'ok')
    .map((crop) => ({
      cropId: crop.crop_id,
      cropName: crop.crop,
      et0TotalMm: crop.et0_total_mm ?? null,
      etcTotalMm: crop.etc_total_mm ?? null,
      rainTotalMm: crop.rain_total_mm ?? null,
      rainMinusEtcMm: crop.rain_minus_etc_mm ?? null,
      kc: { initial: 0, mid: crop.kc_mid ?? 0, end: 0 },
      kcMode: crop.kc_mode ?? 'mid-season',
      method: { penmanMonteithDays: crop.methods?.['penman-monteith'] ?? 0,
        hargreavesDays: crop.methods?.hargreaves ?? 0, unavailableDays: 0 },
      coverage: { validDays: crop.valid_days ?? 0, windowDays: crop.window?.days ?? 0 },
      state: crop.state,
      source: body.source ?? 'NASA POWER',
      kcSource: crop.kc_source ?? '',
    }))
  if (crops.length === 0) return null
  return {
    origin: 'api',
    fieldId,
    point: { latitude: body.point?.latitude ?? 0, longitude: body.point?.longitude ?? 0 },
    period: { start: body.period.start, end: body.period.end, chosenDate: body.period.end },
    resolution: body.resolution ?? '',
    crops,
    limitations: body.limitations ?? [],
  }
}

export type CropWaterBody = {
  available: boolean
  reason?: string | null
  point?: { latitude: number; longitude: number } | null
  period: { start: string; end: string }
  source?: string | null
  resolution?: string | null
  limitations?: string[]
  crops?: Record<string, {
    crop_id: string
    crop: string
    state: string
    reason?: string | null
    kc_mid?: number | null
    kc_mode?: string | null
    kc_source?: string | null
    et0_total_mm?: number | null
    etc_total_mm?: number | null
    rain_total_mm?: number | null
    rain_minus_etc_mm?: number | null
    valid_days?: number | null
    methods?: Record<string, number>
    window?: { start: string; end: string; days: number } | null
  }>
  abstained?: Record<string, string>
}

export function cropWaterEvidence(set: CropWaterSet): Evidence[] {
  const period = { start: set.period.start, end: set.period.end }
  const common = {
    source: `${set.crops[0]?.source ?? 'NASA POWER'}; FAO-56 eq. 52 and 56`,
    asOf: set.period.end,
    period,
    basis: 'fixture' as const,
    sourceBasis: 'modelled' as const,
    resolution: set.resolution,
    route: 'derived' as const,
  }
  const first = set.crops[0]
  const rows: Evidence[] = first
    ? [{ ...common, id: 'crop_water.et0_total', metric: 'et0_total', value: first.et0TotalMm, unit: 'mm',
      limitations: ['computed_crop_water', 'coarse_cell', 'modelled_not_measured'] }]
    : []
  for (const crop of set.crops) {
    rows.push({ ...common, id: `crop_water.${crop.cropId}.etc_total`, metric: `etc_total.${crop.cropId}`,
      value: crop.etcTotalMm, unit: 'mm', limitations: ['computed_crop_water', 'standard_kc'] })
    rows.push({ ...common, id: `crop_water.${crop.cropId}.rain_minus_etc`, metric: `rain_minus_etc.${crop.cropId}`,
      value: crop.rainMinusEtcMm, unit: 'mm', limitations: ['computed_crop_water', 'climatic_difference_not_irrigation'] })
    rows.push({ ...common, id: `crop_water.${crop.cropId}.kc_mid`, metric: `kc_mid.${crop.cropId}`,
      value: crop.kc.mid, unit: null, decimals: 2, limitations: ['standard_kc'] })
  }
  for (const diff of etcDifferences(set)) {
    rows.push({ ...common, id: `crop_water.diff.${diff.first}_minus_${diff.second}`, metric: `etc_difference.${diff.first}.${diff.second}`,
      value: diff.mm, unit: 'mm', decimals: 1, limitations: ['computed_crop_water', 'standard_kc'] })
  }
  return rows
}

/**
 * Pairwise ETc differences (first minus second, crop ids in alphabetical order), the same pairs the
 * backend tool registers. A subtraction of two computed totals, rounded half up to 0.1 mm like the
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
