/**
 * The crop water module no longer reads a recorded experiment snapshot: the backend computes the set
 * and this module only releases it for the field and the window it was computed for.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cropWaterEvidence, cropWaterFor, cropWaterSetFrom, setCropWaterFeed, type CropWaterBody } from './crop-water'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import type { CropWaterSet } from './types'

const BODY: CropWaterBody = {
  available: true,
  period: { start: '2026-05-02', end: '2026-05-28' },
  source: 'NASA POWER; FAO-56',
  resolution: '0.5 degree cell (meteorology)',
  limitations: ['computed_crop_water', 'standard_kc'],
  crops: {
    maize: { crop_id: 'maize', crop: 'Maize', state: 'ok', kc_mid: 1.2, et0_total_mm: 100.0,
      etc_total_mm: 120.0, rain_total_mm: 40.0, rain_minus_etc_mm: -80.0, valid_days: 27,
      methods: { hargreaves: 27 }, window: { start: '2026-05-02', end: '2026-05-28', days: 27 } },
    wheat: { crop_id: 'wheat', crop: 'Spring wheat', state: 'abstained', et0_total_mm: null },
  },
  abstained: { 'spring wheat': 'no FAO-56 Kc in this repository for Spring wheat' },
}

function setFor(fieldId: string, start: string, end: string): CropWaterSet {
  return {
    origin: 'api',
    fieldId,
    point: { latitude: 46.96, longitude: -97.14 },
    period: { start, end, chosenDate: end },
    resolution: '0.5 degree cell (meteorology)',
    crops: [{ cropId: 'maize', cropName: 'Maize', et0TotalMm: 100, etcTotalMm: 120, rainTotalMm: 40,
      rainMinusEtcMm: -80, kc: { initial: 0, mid: 1.2, end: 0 }, kcMode: 'mid-season',
      method: { penmanMonteithDays: 0, hargreavesDays: 27, unavailableDays: 0 },
      coverage: { validDays: 27, windowDays: 27 }, state: 'ok', source: 'NASA POWER', kcSource: 'FAO-56 Table 12' }],
    limitations: ['computed_crop_water'],
  }
}

beforeEach(() => setCropWaterFeed(null))

describe('the crop water feed', () => {
  it('is released only for the field and the window it was computed for', () => {
    const payload = recordedNumbersPayload()
    const recorded = payload.query.window
    const window = recorded ?? { start: '2026-10-01', end: '2026-11-11' }
    const field = { fieldId: RECORDED_FIELD_ID, kind: 'fixture' as const, center: [-55.27, -11.91] as [number, number] }
    expect(cropWaterFor(field, payload)).toBeNull()  // nothing computed yet
    setCropWaterFeed(setFor(RECORDED_FIELD_ID, window.start, window.end))
    expect(cropWaterFor(field, payload)).not.toBeNull()
    // another field, another window and a polygon all abstain instead of borrowing the numbers
    expect(cropWaterFor({ ...field, fieldId: 'mt-santa-carmem-02' }, payload)).toBeNull()
    expect(cropWaterFor({ ...field, kind: 'polygon' }, payload)).toBeNull()
    setCropWaterFeed(setFor(RECORDED_FIELD_ID, '2026-09-01', '2026-09-30'))
    expect(cropWaterFor(field, payload)).toBeNull()
  })

  it('maps the route body and keeps only the crops the route released', () => {
    const set = cropWaterSetFrom(BODY, 'il-mclean-01')
    expect(set).not.toBeNull()
    expect(set?.crops.map((crop) => crop.cropId)).toEqual(['maize'])
    expect(set?.crops[0].etcTotalMm).toBe(120)
    expect(set?.origin).toBe('api')
    // an unavailable body releases nothing
    expect(cropWaterSetFrom({ ...BODY, available: false }, 'il-mclean-01')).toBeNull()
  })

  it('derives evidence from the set, marked as computed and not as a measurement', () => {
    const set = setFor('il-mclean-01', '2026-05-02', '2026-05-28')
    const evidence = cropWaterEvidence(set)
    const etc = evidence.find((row) => row.id === 'crop_water.maize.etc_total')
    expect(etc?.value).toBe(120)
    expect(etc?.limitations).toContain('computed_crop_water')
    expect(etc?.limitations).toContain('standard_kc')
    expect(etc?.route).toBe('derived')
    expect(evidence.some((row) => row.id === 'crop_water.highest_peak_demand')).toBe(false)
  })
})
