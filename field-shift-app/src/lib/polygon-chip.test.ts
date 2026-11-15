import { describe, expect, it } from 'vitest'
import { selectedPolygonChipOf } from './polygon-chip'
import { REGION_ADAPTERS } from './regions'
import { UNMAPPED_CLASS_COLOUR, classDisplay } from './polygon-style'

const US_DATE = '2026-11-12'
const US_ID = '381825001868504'
const US_FIELD_ID = 'csb:381825001868504'

describe('the chip a polygon selection produces (R-21, R-27, R-28)', () => {
  it('returns no chip when no polygon is selected', () => {
    const display = classDisplay(REGION_ADAPTERS.us, null)
    expect(selectedPolygonChipOf(null, display, { classValue: null, area: 12.5 }, REGION_ADAPTERS.us, US_DATE)).toBeNull()
  })

  it('gives a United States null class the painted year, the No CDL case', () => {
    const display = classDisplay(REGION_ADAPTERS.us, null)
    const chip = selectedPolygonChipOf(US_ID, display, { classValue: null, area: 12.5 }, REGION_ADAPTERS.us, US_DATE)
    expect(chip).toEqual({
      fieldId: US_FIELD_ID,
      name: null,
      hex: UNMAPPED_CLASS_COLOUR,
      noCdlYear: 2025,
    })
  })

  it('gives a United States class 0 no year, which keeps class not mapped', () => {
    const display = classDisplay(REGION_ADAPTERS.us, 0)
    const chip = selectedPolygonChipOf(US_ID, display, { classValue: 0, area: 12.5 }, REGION_ADAPTERS.us, US_DATE)
    expect(chip?.noCdlYear).toBeNull()
  })

  it('gives a nonzero code the table does not hold no year, which keeps class not mapped', () => {
    const display = classDisplay(REGION_ADAPTERS.us, 999)
    const chip = selectedPolygonChipOf('999', display, { classValue: 999, area: 12.5 }, REGION_ADAPTERS.us, US_DATE)
    expect(chip?.noCdlYear).toBeNull()
  })

  it('gives Brazil no year, because Brazil has no No CDL text', () => {
    const display = classDisplay(REGION_ADAPTERS.br, null)
    const chip = selectedPolygonChipOf(999, display, { classValue: null, area: 1 }, REGION_ADAPTERS.br, US_DATE)
    expect(chip?.noCdlYear).toBeNull()
  })

  it('keeps the unmapped colour when the class display is absent', () => {
    const chip = selectedPolygonChipOf(US_ID, null, null, REGION_ADAPTERS.us, US_DATE)
    expect(chip).toEqual({
      fieldId: US_FIELD_ID,
      name: null,
      hex: UNMAPPED_CLASS_COLOUR,
      noCdlYear: null,
    })
  })
})
