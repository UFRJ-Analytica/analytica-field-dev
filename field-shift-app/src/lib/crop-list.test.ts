import { describe, expect, it } from 'vitest'
import snapshotJson from '../../artifacts/zarc-mt-snapshot.json'
import { admittedHistoryCrops, classProductAdmits, cropListFor, seasonYear } from './crop-list'

type WindowRow = { crop: string; season: string; uf: string; municipality: string }
const rows = snapshotJson.rows as unknown as WindowRow[]

/** R-61 (a): the crop strings the window source returns for one place and one season, in order. */
function windowCropsFor(season: string): string[] {
  const crops: string[] = []
  for (const row of rows) {
    if (row.municipality !== 'Santa Carmem' || row.uf !== 'MT' || row.season !== season) continue
    if (!crops.includes(row.crop)) crops.push(row.crop)
  }
  return crops
}

describe('R-61, the season rule', () => {
  it('reads the year of a Y/YY label and refuses a label that is not one', () => {
    expect(seasonYear('2026/27')).toBe(2026)
    expect(seasonYear('2025/26')).toBe(2025)
    expect(seasonYear('2026')).toBeNull()
  })

  it('admits the first crop product from 1985 to 2025 only', () => {
    expect(classProductAdmits('agriculture_first_crop', '2025/26')).toBe(true)
    expect(classProductAdmits('agriculture_first_crop', '2026/27')).toBe(false)
    expect(classProductAdmits('agriculture_first_crop', '1984/85')).toBe(false)
  })
})

describe('R-61, the derived list for the fixture field (AC-54)', () => {
  it('is the window source crops of 2026/2027, every value tagged window', () => {
    const crops = windowCropsFor('2026/2027')
    expect(crops).toEqual(['Soja', 'Milho 1ª Safra', 'Milho 2ª Safra', 'Algodão Herbáceo'])
    const list = cropListFor({ windowCrops: crops, historyCrops: [], season: '2026/27', region: 'br', seasonless: false })
    expect(list.options.map((option) => option.value)).toEqual(crops)
    expect(list.options.every((option) => option.tag === 'window')).toBe(true)
    expect(list.missing).toEqual([])
  })

  it('keeps clause (b) empty for 2025/2026 under OD-11 and tags nothing history', () => {
    const crops = windowCropsFor('2025/2026')
    const list = cropListFor({ windowCrops: crops, historyCrops: ['Soybean'], season: '2025/26', region: 'br', seasonless: false })
    expect(list.options.every((option) => option.tag === 'window')).toBe(true)
    expect(list.options.map((option) => option.value)).not.toContain('Soybean')
    expect(admittedHistoryCrops({ windowCrops: [], historyCrops: ['Soybean'], season: '2025/26', region: 'br', seasonless: false })).toEqual([])
  })

  it('never reads a list from a constant: the list is what the caller passed', () => {
    const list = cropListFor({ windowCrops: ['Café'], historyCrops: [], season: '2026/27', region: 'br', seasonless: false })
    expect(list.options.map((option) => option.value)).toEqual(['Café'])
  })
})

describe('R-62, the empty case (AC-56)', () => {
  it('names both sources when the list is empty for a season source', () => {
    const list = cropListFor({ windowCrops: [], historyCrops: [], season: '2024/25', region: 'br', seasonless: false })
    expect(list.options).toEqual([])
    expect(list.missing).toEqual(['history.missing_window_season', 'history.missing_history_region'])
  })

  it('names the seasonless term and the region term for a United States field', () => {
    const list = cropListFor({ windowCrops: [], historyCrops: [], season: '2026/27', region: 'us', seasonless: true })
    expect(list.missing).toEqual(['history.missing_window_field', 'history.missing_history_region'])
  })

  it('offers no fallback set of any kind', () => {
    const list = cropListFor({ windowCrops: [], historyCrops: ['Soybean', 'Coffee'], season: '2026/27', region: 'br', seasonless: false })
    expect(list.options).toEqual([])
  })
})
