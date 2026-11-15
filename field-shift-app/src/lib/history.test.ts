import { describe, expect, it } from 'vitest'
import { rowsAfterDelete, rowsAfterSave, seasonRange, sowingMarksFor, validateHistoryRow } from './history'
import type { HistoryRow } from './producer-store'

const row = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  season: '2026/27',
  first_crop: 'Soja',
  second_crop: null,
  first_sowing_date: '2026-10-15',
  second_sowing_date: null,
  basis: 'entered',
  edited_at: '2026-11-14T20:13:00Z',
  ...overrides,
})

describe('R-47, the season window', () => {
  it('runs from 1 July of the first year to 30 June of the second', () => {
    expect(seasonRange('2026/27')).toEqual({ start: '2026-07-01', end: '2027-06-30' })
    expect(seasonRange('nope')).toBeNull()
  })
})

describe('R-47 and Table D, the four rejections (AC-42)', () => {
  it('rejects a sowing date outside its season with V-16', () => {
    expect(validateHistoryRow(row({ first_sowing_date: '2026-06-15' }), [])).toEqual({ ok: false, code: 'history.date_outside_season' })
  })

  it('rejects a second crop equal to the first with V-17', () => {
    expect(validateHistoryRow(row({ second_crop: 'Soja' }), [])).toEqual({ ok: false, code: 'history.same_crop' })
  })

  it('rejects a duplicate season with V-18', () => {
    expect(validateHistoryRow(row(), [row()])).toEqual({ ok: false, code: 'history.duplicate_season' })
  })

  it('rejects a second sowing date with no second crop with V-22', () => {
    expect(validateHistoryRow(row({ second_sowing_date: '2026-11-15' }), [])).toEqual({ ok: false, code: 'history.second_date_without_crop' })
  })

  it('accepts a row with both crops, both dates and nothing else', () => {
    const candidate = row({ second_crop: 'Milho 1ª Safra', second_sowing_date: '2026-11-15' })
    expect(validateHistoryRow(candidate, [])).toEqual({ ok: true, row: candidate })
  })
})

describe('R-31, the marks a history produces', () => {
  it('makes one mark per dated crop and none for a null date', () => {
    const marks = sowingMarksFor([
      row(),
      row({ season: '2025/26', first_sowing_date: null, second_crop: 'Milho 1ª Safra', second_sowing_date: '2026-01-05' }),
    ])
    expect(marks).toEqual([
      { crop: 'Soja', season: '2026/27', date: '2026-10-15', editedAt: '2026-11-14T20:13:00Z' },
      { crop: 'Milho 1ª Safra', season: '2025/26', date: '2026-01-05', editedAt: '2026-11-14T20:13:00Z' },
    ])
  })
})

describe('R-47, editing and deleting one row', () => {
  it('replaces only the edited season and removes only the deleted one', () => {
    const first = row({ season: '2026/27' })
    const second = row({ season: '2025/26', first_crop: 'Milho 1ª Safra' })
    const edited = row({ season: '2026/27', first_crop: 'Algodão Herbáceo' })
    const saved = rowsAfterSave([first, second], edited, '2026/27')
    expect(saved[0].first_crop).toBe('Algodão Herbáceo')
    expect(saved[1]).toBe(second)
    expect(rowsAfterDelete(saved, '2026/27')).toEqual([second])
  })
})
