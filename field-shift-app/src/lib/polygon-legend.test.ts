import { describe, expect, it } from 'vitest'
import { classIdFrom, legendRows } from './polygon-legend'
import { REGION_ADAPTERS } from './regions'
import { UNMAPPED_CLASS_COLOUR } from './polygon-style'

describe('the legend rows (R-37, AC-30)', () => {



  it('returns no row for an empty view, so the region prints its empty text', () => {
    expect(legendRows([], REGION_ADAPTERS.us)).toEqual([])
  })

  it('never prints the whole 255 row table for a handful of classes in view', () => {
    const rows = legendRows([1, 5, 23], REGION_ADAPTERS.us)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.name)).toEqual(['Corn', 'Soybeans', 'Spring Wheat'])
  })

  it('reads the class id from the tile property', () => {
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: 5 }, 'cdl2025')).toBe(5)
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: 0 }, 'cdl2025')).toBe(0)
    expect(classIdFrom(REGION_ADAPTERS.us, {}, 'cdl2025')).toBeNull()
    expect(classIdFrom(REGION_ADAPTERS.us, { cdl2025: null }, 'cdl2025')).toBeNull()
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

})
