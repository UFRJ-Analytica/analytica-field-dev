import { describe, expect, it } from 'vitest'
import { polygonTooltipText } from './polygon-tooltip'
import { REGION_ADAPTERS } from './regions'

// 2026-11-12 paints the United States year 2025 (classYearRange 2018 to 2025), as the readout tests do.
const US_DATE = '2026-11-12'

describe('the tooltip string per state (R-27, AC-23, AC-17)', () => {
  it('prints No CDL class for {Y} for a United States null cdl{Y}, with the year substituted', () => {
    expect(polygonTooltipText(REGION_ADAPTERS.us, null, US_DATE)).toBe('No CDL class for 2025')
  })

  it('does not print class not mapped for a United States null cdl{Y}', () => {
    expect(polygonTooltipText(REGION_ADAPTERS.us, null, US_DATE)).not.toContain('class not mapped')
  })

  it('prints class not mapped for a United States code 0 and for a nonzero code the table does not hold', () => {
    for (const code of [0, 256, 999]) {
      expect(polygonTooltipText(REGION_ADAPTERS.us, code, US_DATE)).toBe('class not mapped')
    }
  })

  it('does not print No CDL class for an unmapped code', () => {
    for (const code of [0, 256, 999]) {
      expect(polygonTooltipText(REGION_ADAPTERS.us, code, US_DATE)).not.toContain('No CDL class for')
    }
  })

  it('prints the class name for a mapped United States code', () => {
    expect(polygonTooltipText(REGION_ADAPTERS.us, 1, US_DATE)).toBe('Corn')
  })


})
