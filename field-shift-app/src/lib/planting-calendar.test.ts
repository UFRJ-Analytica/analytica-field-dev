import type { NumbersPayload } from './numbers'
import { describe, expect, it } from 'vitest'
import snapshotJson from '../../artifacts/zarc-mt-snapshot.json'
import usWindowsJson from '../../artifacts/us-windows-cass-nd.json'
import { FIELD_CROPS, buildSeasonBand, type ZarcSnapshot } from './season-band'
import {
  SEASONS_CITATION,
  applyMarks,
  calendarRows,
  contextFrom,
  envelope,
  grainText,
  heldSeasonsOf,
  seasonKeyFor,
  seasonlessRows,
  type SeasonlessPayload,
  type ZarcWindowRow,
} from './planting-calendar'

const snapshot = snapshotJson as unknown as ZarcSnapshot
const windows = snapshotJson.rows as unknown as ZarcWindowRow[]
const usPayload = usWindowsJson as unknown as SeasonlessPayload

const fixtureSeason = '2026/27'

describe('R-28 and R-33, the season key and the rows it reads', () => {
  it('converts the derived label to the snapshot key and back', () => {
    expect(seasonKeyFor('2026/27')).toBe('2026/2027')
    expect(seasonKeyFor('2025/26')).toBe('2025/2026')
  })

  it('prints four rows for 2026/2027 and four for 2025/2026', () => {
    expect(calendarRows(windows, '2026/27')).toHaveLength(4)
    expect(calendarRows(windows, '2025/26')).toHaveLength(4)
  })

  it('prints no row for a season the source does not hold', () => {
    expect(calendarRows(windows, '2024/25')).toEqual([])
  })
})

describe('R-29 and Table F, the four envelopes of 2026/2027 (AC-26)', () => {
  const rows = calendarRows(windows, fixtureSeason)
  const byCrop = new Map(rows.map((row) => [row.crop, row]))

  it('prints the start and end of Table F, value for value', () => {
    expect(byCrop.get('Soja')?.start).toBe('2026-10-01')
    expect(byCrop.get('Soja')?.end).toBe('2027-01-10')
    expect(byCrop.get('Milho 1ª Safra')?.start).toBe('2026-10-01')
    expect(byCrop.get('Milho 1ª Safra')?.end).toBe('2026-12-31')
    expect(byCrop.get('Milho 2ª Safra')?.start).toBe('2027-01-01')
    expect(byCrop.get('Milho 2ª Safra')?.end).toBe('2027-03-10')
    expect(byCrop.get('Algodão Herbáceo')?.start).toBe('2026-12-21')
    expect(byCrop.get('Algodão Herbáceo')?.end).toBe('2027-02-20')
  })

  it('carries the portaria, the risk level, the soil codes, the cycles, the management and the row count', () => {
    const soja = byCrop.get('Soja')
    expect(soja?.source).toEqual({
      kind: 'season',
      portaria: 'Port.202_de_03-07-2026',
      portariaDate: '2026-07-03',
      risk: '20',
      soils: ['11', '12', '13', '14', '15', '16'],
      cycles: ['20', '21', '22'],
      management: 'Sequeiro',
      rows: 18,
    })
    expect(byCrop.get('Milho 2ª Safra')?.source).toMatchObject({ portaria: 'Port.326_de_30-07-2026', rows: 12 })
  })

  it('sums the four row counts to the snapshot row count of 93 over both seasons', () => {
    const one = calendarRows(windows, '2026/27').reduce((total, row) => total + ((row.source?.kind === 'season' ? row.source.rows : 0)), 0)
    const two = calendarRows(windows, '2025/26').reduce((total, row) => total + ((row.source?.kind === 'season' ? row.source.rows : 0)), 0)
    expect(one + two).toBe(snapshotJson.row_count)
  })

  it('keeps the ten day spread of O-04 visible in the soil codes it prints', () => {
    const sp = calendarRows(windows, '2025/26').find((row) => row.crop === 'Soja')
    expect(sp?.start).toBe('2025-10-01')
    if (sp?.source?.kind === 'season') expect(sp.source.soils).toEqual(['11', '12', '13', '14', '15', '16'])
  })
})

describe('R-34 and AC-31, parity with the block 4 band', () => {
  it('equals the band windows at both pinned dates, value for value', () => {
    for (const [date, season] of [['2026-11-12', '2026/27'], ['2025-11-10', '2025/26']] as const) {
      const band = buildSeasonBand(snapshot, { municipality: 'Santa Carmem', uf: 'MT', crops: FIELD_CROPS, season })
      const calendar = calendarRows(windows, season)
      const bandPairs = band.windows.map((window) => `${window.snapshotCrop}|${window.start}|${window.end}`).sort()
      const calendarPairs = calendar
        .filter((row) => row.noWindowKey === null)
        .map((row) => `${row.crop}|${row.start}|${row.end}`)
        .sort()
      expect(calendarPairs, date).toEqual(bandPairs)
    }
  })

  it('agrees with the block 4 envelope on one crop read on its own', () => {
    const sojaRows = windows.filter((row) => row.season === '2026/2027' && row.crop === 'Soja')
    const window = envelope(sojaRows)
    expect(window?.start).toBe('2026-10-01')
    expect(window?.end).toBe('2027-01-10')
    expect(window?.count).toBe(18)
  })
})

describe('R-31, the three routing tests (AC-28)', () => {
  const rowsOf2026 = calendarRows(windows, fixtureSeason)
  const held = heldSeasonsOf(windows)

  it('names the two seasons the snapshot holds', () => {
    expect(held.sort()).toEqual(['2025/2026', '2026/2027'])
  })

  it('Record 1: marks the two dated rows, gaps the undisplayed and the unheld season, and drops nothing', () => {
    const marks = [
      { crop: 'Soja', season: '2026/27', date: '2026-10-15', editedAt: '2026-11-14T20:13:00Z' },
      { crop: 'Milho 1ª Safra', season: '2026/27', date: '2026-11-15', editedAt: '2026-11-14T20:13:00Z' },
      { crop: 'Soja', season: '2024/25', date: '2024-10-20', editedAt: '2026-11-14T20:13:00Z' },
      { crop: 'Milho 1ª Safra', season: '2022/23', date: '2022-11-15', editedAt: '2026-11-14T20:13:00Z' },
    ]
    const result = applyMarks({ rows: rowsOf2026, marks, season: fixtureSeason, heldSeasons: held, seasonless: false })
    const soja = result.rows.find((row) => row.crop === 'Soja')
    const milho = result.rows.find((row) => row.crop === 'Milho 1ª Safra')
    expect(soja?.marks.map((mark) => mark.date)).toEqual(['2026-10-15'])
    expect(milho?.marks.map((mark) => mark.date)).toEqual(['2026-11-15'])
    expect(soja?.start).toBe('2026-10-01')
    expect(result.gaps.map((gap) => gap.cause)).toEqual(['calendar.mark_unplaced', 'calendar.mark_unplaced'])
    expect(result.gaps[0].params).toEqual({ season: '2024/25', crop: 'Soja' })
    expect(result.gaps[1].params).toEqual({ season: '2022/23', crop: 'Milho 1ª Safra' })
  })

  it('Record 2: a crop neither source returns gets one row, the no-window text and its mark', () => {
    const result = applyMarks({
      rows: rowsOf2026,
      marks: [{ crop: 'NOT-A-CROP', season: '2026/27', date: '2026-10-20', editedAt: '2026-11-14T20:13:00Z' }],
      season: fixtureSeason,
      heldSeasons: held,
      seasonless: false,
    })
    const extra = result.rows.find((row) => row.crop === 'NOT-A-CROP')
    expect(extra?.noWindowKey).toBe('calendar.no_window_for_crop')
    expect(extra?.start).toBeNull()
    expect(extra?.marks.map((mark) => mark.date)).toEqual(['2026-10-20'])
    expect(result.rows.find((row) => row.crop === 'Soja')?.marks).toEqual([])
    expect(result.gaps).toEqual([])
  })

  it('Record 3: a second date alone marks the second crop row', () => {
    const result = applyMarks({
      rows: rowsOf2026,
      marks: [{ crop: 'Milho 1ª Safra', season: '2026/27', date: '2026-11-15', editedAt: '2026-11-14T20:13:00Z' }],
      season: fixtureSeason,
      heldSeasons: held,
      seasonless: false,
    })
    expect(result.rows.find((row) => row.crop === 'Milho 1ª Safra')?.marks).toHaveLength(1)
    expect(result.rows.find((row) => row.crop === 'Soja')?.marks).toHaveLength(0)
  })

  it('gaps a season the source holds but the chosen date does not display', () => {
    const result = applyMarks({
      rows: rowsOf2026,
      marks: [{ crop: 'Soja', season: '2025/26', date: '2025-10-20', editedAt: '2026-11-14T20:13:00Z' }],
      season: fixtureSeason,
      heldSeasons: held,
      seasonless: false,
    })
    expect(result.gaps.map((gap) => gap.cause)).toEqual(['calendar.season_not_shown'])
    expect(result.rows.every((row) => row.marks.length === 0)).toBe(true)
  })
})

describe('R-29, the seasonless source (AC-57)', () => {
  const rows = seasonlessRows(usPayload)

  it('prints four rows in the source order, with the seasonless season cell', () => {
    expect(rows.map((row) => row.crop)).toEqual(['Corn', 'Soybeans', 'Spring wheat', 'Canola'])
    expect(rows.every((row) => row.season === 'calendar.seasonless_season')).toBe(true)
  })

  it('prints the limits as month and day with no year, and Canola empty', () => {
    expect(rows[0].startMd).toBe('04-26')
    expect(rows[0].endMd).toBe('06-04')
    expect(rows[1].startMd).toBe('05-07')
    expect(rows[1].endMd).toBe('06-11')
    expect(rows[2].startMd).toBe('04-16')
    expect(rows[2].endMd).toBe('06-03')
    expect(rows[3].noWindowKey).toBe('calendar.empty_crop')
    expect(rows[3].startMd).toBeNull()
  })

  it('prints the citation and the state grain in the source line', () => {
    expect(rows[0].source).toEqual({
      kind: 'seasonless',
      citation: SEASONS_CITATION,
      grain: 'North Dakota, state grain',
      caveatKey: 'calendar.end_caveat',
    })
    expect(grainText(usPayload)).toBe('North Dakota, state grain')
  })

  it('marks the Canola row, which exists with a null window (revision 9 clause 3)', () => {
    const result = applyMarks({
      rows,
      marks: [{ crop: 'Canola', season: '2026/27', date: '2027-05-10', editedAt: '2026-11-14T20:13:00Z' }],
      season: fixtureSeason,
      heldSeasons: [],
      seasonless: true,
    })
    const canola = result.rows.filter((row) => row.crop === 'Canola')
    expect(canola).toHaveLength(1)
    expect(canola[0].marks.map((mark) => mark.date)).toEqual(['2027-05-10'])
    expect(canola[0].noWindowKey).toBe('calendar.empty_crop')
    expect(result.gaps).toEqual([])
  })
})

describe('R-30, the block 6 context (AC-27)', () => {
  const payload = {
    sections: {
      climate: {
        state: 'ok',
        basis: 'modelled',
        source: 'NASA POWER',
        as_of: '2026-11-12',
        aggregates: { dry_spell_days: { value: 7 }, frost_days: { value: 0 } },
        normals: { percentile: { value: 20 } },
      },
    },
  }

  it('prints the three numbers with the basis, the source and as_of of the section', () => {
    const context = contextFrom(payload as unknown as NumbersPayload)
    expect(context.kind).toBe('numbers')
    if (context.kind !== 'numbers') return
    expect(context.numbers.map((number) => number.value)).toEqual([7, 0, 20])
    expect(context.numbers.every((number) => number.basis === 'modelled')).toBe(true)
    expect(context.numbers.every((number) => number.asOf === '2026-11-12')).toBe(true)
  })

  it('leaves the window untouched when the climate numbers change', () => {
    const before = calendarRows(windows, fixtureSeason)
    const changed = {
      sections: {
        climate: {
          state: 'ok', basis: 'modelled', source: 'NASA POWER', as_of: '2026-11-12',
          aggregates: { dry_spell_days: { value: 14 }, frost_days: { value: 0 } },
          normals: { percentile: { value: 5 } },
        },
      },
    }
    const after = calendarRows(windows, fixtureSeason)
    expect(contextFrom(changed as unknown as NumbersPayload).kind).toBe('numbers')
    expect(after.map((row) => `${row.start}|${row.end}`)).toEqual(before.map((row) => `${row.start}|${row.end}`))
  })

  it('prints the state and the reason when the section abstains', () => {
    const abstained = {
      sections: { climate: { state: 'abstained', reason: 'no POWER cell for this point' } },
    }
    expect(contextFrom(abstained as unknown as NumbersPayload)).toEqual({ kind: 'state', state: 'abstained', reason: 'no POWER cell for this point' })
  })
})
