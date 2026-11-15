import { describe, expect, it } from 'vitest'
import { falsifierOf, falsifierValue, readFalsifier, type Falsifier } from './falsifier'
import { recordedNumbersPayload } from '@/test/numbers-recorded'

const valid: Falsifier = { metric: 'rain_total', operator: '<', threshold: 150, unit: 'mm', text_key: 'numbers.rain_total' }

describe('the falsifier object (R-39): all five keys required', () => {
  it('reads a complete object', () => {
    expect(readFalsifier(valid)).toEqual(valid)
  })

  it('reads nothing when the object is absent', () => {
    expect(readFalsifier(undefined)).toBeNull()
    expect(readFalsifier(null)).toBeNull()
    expect(falsifierOf({ id: 'soy-cotton' })).toBeNull()
  })

  it('reads nothing when any one of the five keys is missing', () => {
    for (const key of ['metric', 'operator', 'threshold', 'unit', 'text_key'] as const) {
      const partial: Record<string, unknown> = { ...valid }
      delete partial[key]
      expect(readFalsifier(partial)).toBeNull()
    }
  })

  it('reads nothing for an operator outside the four comparisons, or a non numeric threshold', () => {
    expect(readFalsifier({ ...valid, operator: '==' })).toBeNull()
    expect(readFalsifier({ ...valid, threshold: '150' })).toBeNull()
    expect(readFalsifier({ ...valid, threshold: Number.NaN })).toBeNull()
  })
})

describe('the current value of the falsifier metric from the numbers payload (R-39)', () => {
  it('reports not read when no payload is held for the field and date', () => {
    expect(falsifierValue(valid, null)).toEqual({ status: 'not_read' })
  })

  it('reads the value, its unit, its basis and its date from the payload row of the same metric', () => {
    expect(falsifierValue(valid, recordedNumbersPayload())).toEqual({
      status: 'value',
      value: '171.9',
      unit: 'mm',
      basis: 'modelled',
      asOf: '2026-11-11',
    })
  })

  it('reports no row when the payload holds no row for the metric, so the falsifier is not printed', () => {
    expect(falsifierValue({ ...valid, metric: 'ndvi_mean' }, recordedNumbersPayload())).toEqual({
      status: 'no_row',
      metric: 'ndvi_mean',
    })
  })
})
