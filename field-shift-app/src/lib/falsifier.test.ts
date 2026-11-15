import { describe, expect, it } from 'vitest'
import {
  falsifierCompleteness,
  falsifierGaps,
  falsifierOf,
  falsifierReading,
  metricRowOf,
} from './falsifier'
import type { NumbersPayload } from './numbers'
import recorded from '@/test/numbers-recorded.json'

const PAYLOAD = recorded as unknown as NumbersPayload

const VALID = {
  metric: 'dry_spell_days',
  operator: '>',
  threshold: 10,
  unit: 'days',
  text_key: 'scenarios.falsifier.placeholder',
}

describe('R-39, the five keys of a falsifier', () => {
  it('accepts the five keys when the operator is one of the four', () => {
    for (const operator of ['<', '<=', '>', '>=']) {
      expect(falsifierOf({ ...VALID, operator })).toEqual({ ...VALID, operator })
    }
  })

  it('refuses a falsifier that misses any one of the five keys', () => {
    for (const key of ['metric', 'operator', 'threshold', 'unit', 'text_key']) {
      const broken: Record<string, unknown> = { ...VALID }
      delete broken[key]
      expect(falsifierOf(broken)).toBeNull()
    }
    expect(falsifierOf(undefined)).toBeNull()
    expect(falsifierOf(null)).toBeNull()
    expect(falsifierOf([])).toBeNull()
    expect(falsifierOf('dry_spell_days > 10')).toBeNull()
  })

  it('refuses an operator outside the four and a threshold that is not a finite number', () => {
    expect(falsifierOf({ ...VALID, operator: '==' })).toBeNull()
    expect(falsifierOf({ ...VALID, operator: '>' })).not.toBeNull()
    expect(falsifierOf({ ...VALID, threshold: Number.NaN })).toBeNull()
    expect(falsifierOf({ ...VALID, threshold: '10' })).toBeNull()
  })

  it('refuses blank strings where a key must carry text', () => {
    expect(falsifierOf({ ...VALID, metric: '   ' })).toBeNull()
    expect(falsifierOf({ ...VALID, unit: '' })).toBeNull()
    expect(falsifierOf({ ...VALID, text_key: '' })).toBeNull()
  })
})

describe('R-39, the metric value with its basis and its date', () => {
  it('reads the value, the unit, the basis label and the date from the payload row', () => {
    const reading = falsifierReading(falsifierOf(VALID), PAYLOAD)
    expect(reading).not.toBeNull()
    expect(reading?.value).toBe(7)
    expect(reading?.unit).toBe('days')
    expect(reading?.basis).toBe('modelled')
    expect(reading?.asOf).toBe('2026-11-11')
  })

  it('prints nothing when the metric has no row in the payload', () => {
    expect(metricRowOf(PAYLOAD, 'metric_not_in_payload')).toBeNull()
    expect(falsifierReading(falsifierOf({ ...VALID, metric: 'metric_not_in_payload' }), PAYLOAD)).toBeNull()
  })

  it('prints nothing when there is no payload at all', () => {
    expect(falsifierReading(falsifierOf(VALID), null)).toBeNull()
    expect(falsifierReading(null, PAYLOAD)).toBeNull()
  })

  it('prints nothing when the row holds no scalar value', () => {
    const payload = {
      ...PAYLOAD,
      provenance: PAYLOAD.provenance.map((row) => (row.metric === 'dry_spell_days' ? { ...row, value: null } : row)),
    }
    expect(falsifierReading(falsifierOf(VALID), payload)).toBeNull()
  })
})

describe('AC-39, the completeness count of the fixture scenarios', () => {
  it('counts the scenarios that carry one and reports not verified while any lacks one', () => {
    const completeness = falsifierCompleteness([
      { id: 'current-sequence', falsifier: VALID },
      { id: 'soy-cotton' },
    ])
    expect(completeness).toEqual({ total: 2, withFalsifier: 1, missing: ['soy-cotton'], status: 'not verified' })
  })

  it('reports passed only when every scenario carries one, and not verified for no scenario', () => {
    expect(falsifierCompleteness([{ id: 'a', falsifier: VALID }]).status).toBe('passed')
    expect(falsifierCompleteness([]).status).toBe('not verified')
  })

  it('counts a falsifier missing a key as missing, not as present', () => {
    const completeness = falsifierCompleteness([{ id: 'a', falsifier: { ...VALID, unit: '' } }])
    expect(completeness.withFalsifier).toBe(0)
    expect(completeness.missing).toEqual(['a'])
  })
})

describe('R-40, the gap rows', () => {
  it('carries one row per scenario without a falsifier, with the scenario id and the field id', () => {
    const gaps = falsifierGaps([{ id: 'current-sequence', falsifier: VALID }, { id: 'soy-cotton' }], 'mt-santa-carmem-01', '2026-11-12')
    expect(gaps).toHaveLength(1)
    expect(gaps[0].section).toBe('counter_evidence')
    expect(gaps[0].cause).toContain('soy-cotton')
    expect(gaps[0].cause).toContain('mt-santa-carmem-01')
    expect(gaps[0].source).toBe('CO-B6-02')
    expect(gaps[0].date).toBe('2026-11-12')
  })

  it('writes no row when every scenario carries one', () => {
    expect(falsifierGaps([{ id: 'a', falsifier: VALID }], 'mt-santa-carmem-01', '2026-11-12')).toEqual([])
  })
})
