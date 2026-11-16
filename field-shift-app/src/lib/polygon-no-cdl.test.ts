import { describe, expect, it } from 'vitest'
import { noCdlYearOf } from './polygon-style'
import { REGION_ADAPTERS } from './regions'

const US_DATE = '2026-11-12'

describe('the No CDL year rule shared by the tooltip, the chip and the legend (R-21, R-27, R-28, R-37)', () => {
  it('returns the painted year only for a United States null class', () => {
    expect(noCdlYearOf(REGION_ADAPTERS.us, null, US_DATE)).toBe(2025)
  })

  it('returns null for a United States code 0 or any other code, which keeps class not mapped', () => {
    for (const code of [0, 1, 255, 256, 999]) {
      expect(noCdlYearOf(REGION_ADAPTERS.us, code, US_DATE)).toBeNull()
    }
  })

})
