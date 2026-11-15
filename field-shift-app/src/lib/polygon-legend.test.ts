import { describe, expect, it } from 'vitest'
import { classIdFrom, legendRows } from './polygon-legend'
import { REGION_ADAPTERS } from './regions'
import { UNMAPPED_CLASS_COLOUR } from './polygon-style'

describe('the legend rows (R-37, AC-30)', () => {
  it('lists only the classes in view, ordered by ascending class id', () => {
    const rows = legendRows([41, 39, 15, 39, 41, 3], REGION_ADAPTERS.br)
    expect(rows.map((row) => row.classId)).toEqual([3, 15, 39, 41])
    expect(rows.map((row) => row.classId)).not.toContain(4)
  })

  it('carries the table name and hex on every swatch', () => {
    const rows = legendRows([39, 15], REGION_ADAPTERS.br)
    expect(rows[0]).toMatchObject({ classId: 15, name: 'Pasture', hex: '#edde8e', unmapped: false })
    expect(rows[1]).toMatchObject({ classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false })
  })

  it('appends the unmapped row once, last, while an unmapped polygon is in view', () => {
    const rows = legendRows([0, 39, null, 999], REGION_ADAPTERS.br)
    expect(rows).toHaveLength(2)
    expect(rows[rows.length - 1]).toMatchObject({
      classId: null,
      name: null,
      nameKey: 'polygon.class_not_mapped',
      hex: UNMAPPED_CLASS_COLOUR,
      unmapped: true,
    })
    expect(rows.filter((row) => row.unmapped)).toHaveLength(1)
  })

  it('returns no row for an empty view, so the region prints its empty text', () => {
    expect(legendRows([], REGION_ADAPTERS.us)).toEqual([])
  })

  it('never prints the whole 255 row table for a handful of classes in view', () => {
    const rows = legendRows([1, 5, 23], REGION_ADAPTERS.us)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.name)).toEqual(['Corn', 'Soybeans', 'Spring Wheat'])
  })

  it('reads the class id from the tile property, in either region', () => {
    expect(classIdFrom(REGION_ADAPTERS.br, { mbmode24: 39 }, 'mbmode24')).toBe(39)
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: 5 }, 'cdl2025')).toBe(5)
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: 0 }, 'cdl2025')).toBe(0)
    expect(classIdFrom(REGION_ADAPTERS.us, {}, 'cdl2025')).toBeNull()
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: null }, 'cdl2025')).toBeNull()
    expect(classIdFrom(REGION_ADAPTERS.br, { mbmode24: '39' }, 'mbmode24')).toBe(39)
  })

  it('prints No CDL class for {Y} as its own row, before class not mapped, for a United States null class', () => {
    const rows = legendRows([5, null, 0], REGION_ADAPTERS.us, 2025)
    expect(rows.map((row) => row.nameKey ?? row.name)).toEqual(['Soybeans', 'polygon.no_cdl_class', 'polygon.class_not_mapped'])
    expect(rows[1]).toMatchObject({
      classId: null,
      nameKey: 'polygon.no_cdl_class',
      params: { year: 2025 },
      hex: UNMAPPED_CLASS_COLOUR,
      unmapped: true,
    })
    expect(rows[2]).toMatchObject({ nameKey: 'polygon.class_not_mapped', unmapped: true })
  })

  it('never lists a United States null class under class not mapped', () => {
    const rows = legendRows([null, 300], REGION_ADAPTERS.us, 2025)
    expect(rows.filter((row) => row.nameKey === 'polygon.class_not_mapped')).toHaveLength(1)
    expect(rows.filter((row) => row.nameKey === 'polygon.no_cdl_class')).toHaveLength(1)
  })

  it('prints only the class not mapped row for a United States code 0 or a code the table does not hold', () => {
    const rows = legendRows([0, 300], REGION_ADAPTERS.us, 2025)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ nameKey: 'polygon.class_not_mapped', unmapped: true })
    expect(rows.some((row) => row.nameKey === 'polygon.no_cdl_class')).toBe(false)
  })

  it('keeps the Brazil split: null, 0 and 999 share one class not mapped row and never a No CDL row', () => {
    const rows = legendRows([null, 0, 999, 39], REGION_ADAPTERS.br, null)
    expect(rows.map((row) => row.nameKey ?? row.name)).toEqual(['Soybean', 'polygon.class_not_mapped'])
    expect(rows.some((row) => row.nameKey === 'polygon.no_cdl_class')).toBe(false)
  })
})
