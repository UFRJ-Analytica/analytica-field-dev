import { describe, expect, it } from 'vitest'
import {
  addDays,
  clampToAxis,
  daysBetween,
  parseFieldLocation,
  primaryLayerId,
  readDateParam,
  seasonForDate,
  snapshotSeasonKey,
} from './timeline'

const AXIS = { start: '2015-04-01', end: '2026-11-14', default: '2026-11-14' }

describe('AC-24 / R-29: seasonForDate derives Y/YY from the most recent 1 July', () => {
  it('returns the four pinned examples of the spec', () => {
    expect(seasonForDate('2015-04-01')).toBe('2014/15')
    expect(seasonForDate('2025-06-30')).toBe('2024/25')
    expect(seasonForDate('2025-07-01')).toBe('2025/26')
    expect(seasonForDate('2026-11-12')).toBe('2026/27')
  })

  it('changes the label between 2025-06-30 and 2025-07-01 (AC-26)', () => {
    expect(seasonForDate('2025-06-30')).not.toBe(seasonForDate('2025-07-01'))
  })

  it('normalises the derived label to the snapshot key Y/YYYY (R-31)', () => {
    expect(snapshotSeasonKey('2026/27')).toBe('2026/2027')
    expect(snapshotSeasonKey('2025/26')).toBe('2025/2026')
    expect(snapshotSeasonKey('2014/15')).toBe('2014/2015')
  })
})

describe('AC-23 / R-28: the axis, the default and the ?date= pin', () => {
  it('uses the axis default when the query holds no date', () => {
    expect(readDateParam('', AXIS)).toEqual({ date: '2026-11-14', clamped: null })
    expect(readDateParam('?foo=bar', AXIS)).toEqual({ date: '2026-11-14', clamped: null })
  })

  it('sets the chosen date from an on-axis ?date=', () => {
    expect(readDateParam('?date=2026-11-12', AXIS)).toEqual({ date: '2026-11-12', clamped: null })
  })

  it('clamps a date before the axis start and names the bound', () => {
    expect(readDateParam('?date=2015-03-01', AXIS)).toEqual({ date: '2015-04-01', clamped: '2015-04-01' })
  })

  it('clamps a date after the axis end and names the bound', () => {
    expect(readDateParam('?date=2027-01-01', AXIS)).toEqual({ date: '2026-11-14', clamped: '2026-11-14' })
  })

  it('clamps through clampToAxis and ignores a malformed value', () => {
    expect(clampToAxis('2015-03-01', AXIS)).toEqual({ date: '2015-04-01', clamped: '2015-04-01' })
    expect(clampToAxis('2026-11-12', AXIS)).toEqual({ date: '2026-11-12', clamped: null })
    expect(clampToAxis('not-a-date', AXIS)).toEqual({ date: '2026-11-14', clamped: null })
    expect(readDateParam('?date=not-a-date', AXIS)).toEqual({ date: '2026-11-14', clamped: null })
  })
})

describe('day arithmetic is UTC and exact', () => {
  it('steps one day across a month boundary', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-01', -1)).toBe('2026-11-30')
    expect(addDays('2015-04-01', 0)).toBe('2015-04-01')
  })

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-11-12', '2026-11-14')).toBe(2)
    expect(daysBetween('2026-11-14', '2026-11-12')).toBe(-2)
    expect(daysBetween('2026-11-14', '2026-11-14')).toBe(0)
  })
})

describe('the field location text maps to the snapshot municipality and UF', () => {
  it('reads Santa Carmem, Mato Grosso as Santa Carmem and MT', () => {
    expect(parseFieldLocation('Santa Carmem, Mato Grosso')).toEqual({ municipality: 'Santa Carmem', uf: 'MT' })
  })

  it('returns null when the text cannot be read', () => {
    expect(parseFieldLocation(null)).toBeNull()
    expect(parseFieldLocation('')).toBeNull()
    expect(parseFieldLocation('Nowhere')).toBeNull()
  })
})

describe('R-33: the primary layer is the first one on in stack order, else smap-l3', () => {
  it('takes the first on layer of the stack', () => {
    expect(primaryLayerId(['ndvi-8day', 'smap-l3'], { 'ndvi-8day': true, 'smap-l3': true })).toBe('ndvi-8day')
  })

  it('falls back to smap-l3 when no layer is on', () => {
    expect(primaryLayerId(['ndvi-8day', 'smap-l3'], {})).toBe('smap-l4-surface')
  })
})
