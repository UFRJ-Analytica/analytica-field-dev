import { describe, expect, it } from 'vitest'
import {
  cdlHistory,
  CDL_YEARS,
  classCellFor,
  FIRST_CROP_PRODUCT,
  FIRST_CROP_YEARS,
  historyRows,
  mapbiomasClassFor,
  SECOND_CROP_PRODUCT,
  SECOND_CROP_STATES,
  SECOND_CROP_YEARS,
  TABLE_D,
  usCdlNameOf,
} from './rotation'
import { csbCdlYears } from '@/test/rotation-recorded'

describe('the class is the pair product and code (R-34, Table D)', () => {
  it('resolves code 1 only under second crop, and never under first crop', () => {
    expect(mapbiomasClassFor(SECOND_CROP_PRODUCT, 1)).toBe('Second crop corn')
    expect(mapbiomasClassFor(FIRST_CROP_PRODUCT, 1)).toBeNull()
  })

  it('keeps codes 41 and 62 apart by product', () => {
    expect(mapbiomasClassFor(FIRST_CROP_PRODUCT, 41)).toBe('Other temporary crops')
    expect(mapbiomasClassFor(SECOND_CROP_PRODUCT, 41)).toBe('Other second crop')
    expect(mapbiomasClassFor(FIRST_CROP_PRODUCT, 62)).toBe('Cotton (beta)')
    expect(mapbiomasClassFor(SECOND_CROP_PRODUCT, 62)).toBe('Second crop cotton')
  })

  it('holds nine first crop classes and three second crop classes, each under its product', () => {
    expect(TABLE_D.filter((row) => row.product === FIRST_CROP_PRODUCT)).toHaveLength(9)
    expect(TABLE_D.filter((row) => row.product === SECOND_CROP_PRODUCT)).toHaveLength(3)
  })

  it('prints unmapped for a pair the table does not hold, and never guesses a name', () => {
    expect(classCellFor(FIRST_CROP_PRODUCT, 99)).toEqual({ kind: 'unmapped' })
    expect(classCellFor(SECOND_CROP_PRODUCT, 39)).toEqual({ kind: 'unmapped' })
  })

  it('prints not computed for a NULL code, never unknown and never a name', () => {
    expect(mapbiomasClassFor(FIRST_CROP_PRODUCT, null)).toBeNull()
    expect(classCellFor(FIRST_CROP_PRODUCT, null)).toEqual({ kind: 'not_computed' })
  })

  it('names a held pair from the table', () => {
    expect(classCellFor(FIRST_CROP_PRODUCT, 39)).toEqual({ kind: 'named', name: 'Soybean' })
  })
})

describe('the history rows (R-35)', () => {
  it('prints one row per year the sidecar carries from 1985 to 2025, and nothing before or after', () => {
    const entries = [
      { year: 1984, product: FIRST_CROP_PRODUCT, code: 39 },
      { year: 1985, product: FIRST_CROP_PRODUCT, code: 39 },
      { year: 2025, product: FIRST_CROP_PRODUCT, code: 39 },
      { year: 2026, product: FIRST_CROP_PRODUCT, code: 39 },
    ]
    const rows = historyRows(entries, FIRST_CROP_PRODUCT, FIRST_CROP_YEARS)
    expect(rows.map((row) => row.year)).toEqual([1985, 2025])
  })

  it('prints no row for a year the sidecar does not carry', () => {
    const entries = [
      { year: 2003, product: SECOND_CROP_PRODUCT, code: 1 },
      { year: 2001, product: SECOND_CROP_PRODUCT, code: 1 },
    ]
    expect(historyRows(entries, SECOND_CROP_PRODUCT, SECOND_CROP_YEARS).map((row) => row.year)).toEqual([2001, 2003])
  })

  it('keeps the second crop between 2000 and 2025 and drops a 1999 or a 2026 row', () => {
    const entries = [
      { year: 1999, product: SECOND_CROP_PRODUCT, code: 1 },
      { year: 2000, product: SECOND_CROP_PRODUCT, code: 1 },
      { year: 2026, product: SECOND_CROP_PRODUCT, code: 1 },
    ]
    expect(historyRows(entries, SECOND_CROP_PRODUCT, SECOND_CROP_YEARS).map((row) => row.year)).toEqual([2000])
  })

  it('drops a row whose product is not the product of the history it is read for', () => {
    const entries = [{ year: 2010, product: SECOND_CROP_PRODUCT, code: 1 }]
    expect(historyRows(entries, FIRST_CROP_PRODUCT, FIRST_CROP_YEARS)).toEqual([])
  })

  it('keeps a NULL code row with its not computed cell and its product (Brazil NULL class)', () => {
    const entries = [{ year: 2025, product: FIRST_CROP_PRODUCT, code: null }]
    expect(historyRows(entries, FIRST_CROP_PRODUCT, FIRST_CROP_YEARS)).toEqual([
      { year: 2025, product: FIRST_CROP_PRODUCT, code: null, cell: { kind: 'not_computed' } },
    ])
  })
})

describe('the second crop states the source holds (M-19)', () => {
  it('lists the ten states the product maps and no other state', () => {
    expect(SECOND_CROP_STATES).toHaveLength(10)
    expect(SECOND_CROP_STATES).toContain('Mato Grosso')
    expect(SECOND_CROP_STATES).toContain('Maranhão')
    expect(SECOND_CROP_STATES).not.toContain('Amazonas')
  })
})

describe('the United States CDL history of the Crop Sequence Boundary record', () => {
  it('reads the eight CDL years 2018 to 2025 of the recorded record, each with its legend name', () => {
    const rows = cdlHistory(csbCdlYears(), usCdlNameOf)
    expect(CDL_YEARS).toEqual([2018, 2025])
    expect(rows.map((row) => row.year)).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025])
    expect(rows.every((row) => row.product === 'cdl')).toBe(true)
    expect(rows[0]).toEqual({ year: 2018, product: 'cdl', code: 23, cell: { kind: 'named', name: 'Spring Wheat' } })
    expect(rows[1]).toEqual({ year: 2019, product: 'cdl', code: 41, cell: { kind: 'named', name: 'Sugarbeets' } })
    expect(rows[3]).toEqual({ year: 2021, product: 'cdl', code: 5, cell: { kind: 'named', name: 'Soybeans' } })
    expect(rows[4]).toEqual({ year: 2022, product: 'cdl', code: 1, cell: { kind: 'named', name: 'Corn' } })
    expect(rows[7]).toEqual({ year: 2025, product: 'cdl', code: 5, cell: { kind: 'named', name: 'Soybeans' } })
  })

  it('prints absent for a year whose property is missing or null, and never invents a class', () => {
    const rows = cdlHistory({ 2018: 5, 2019: null }, usCdlNameOf)
    expect(rows[0].cell).toEqual({ kind: 'named', name: 'Soybeans' })
    expect(rows[1]).toEqual({ year: 2019, product: 'cdl', code: null, cell: { kind: 'absent' } })
    expect(rows[2]).toEqual({ year: 2020, product: 'cdl', code: null, cell: { kind: 'absent' } })
  })

  it('prints unmapped for a CDL code the legend holds no name for', () => {
    expect(cdlHistory({ 2018: 999 }, usCdlNameOf)[0].cell).toEqual({ kind: 'unmapped' })
    expect(usCdlNameOf(999)).toBeNull()
  })
})
