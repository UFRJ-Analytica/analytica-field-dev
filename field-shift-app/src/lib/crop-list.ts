/**
 * Block 7, R-61 and R-62: the crop list the history form offers, derived when it opens.
 *
 * The list is the union of two sources, each value tagged with the source that returned it. The tag
 * lives in the form only (R-61): nothing here writes it to a stored row.
 *
 * Source (a), `window`, is the crop strings the block 4 windows response returns for the field's
 * place and for the row's season. Source (b), `history`, is the agricultural crops of the field's own
 * history, admitted by two rules. Both rules are written here as functions rather than as constants,
 * because a decision that lands later (OD-10, OD-11) changes the admission and not the shape:
 *
 * - The season rule: `Y/YY` takes the year `Y`, and clause (b) is empty when `Y` falls outside the
 *   range of the product that carries the class, 1985 to 2025 for `agriculture_first_crop` and 2000
 *   to 2025 for `agriculture_second_crop`.
 * - The region rule: under OD-11's default no Brazilian class name is admitted, so the list of a
 *   Brazilian field is the window source's crops only; under OD-10's default no United States class
 *   is admitted either. Both defaults leave clause (b) empty today, which is the state R-62 prints.
 */
import type { TranslationKey } from '@/strings'

export type CropTag = 'window' | 'history'

export type CropOption = { value: string; tag: CropTag }

/** R-61's two products and their season ranges, as M-22 and block 6 R-35 record them. */
export const CLASS_PRODUCT_RANGES = {
  agriculture_first_crop: { from: 1985, to: 2025 },
  agriculture_second_crop: { from: 2000, to: 2025 },
} as const

export type CropListInput = {
  /** Source (a): the crop strings the window response returns, in the response's own spelling. */
  windowCrops: readonly string[]
  /** Source (b): the crops the field's own history carries, already the class names of block 6. */
  historyCrops: readonly string[]
  /** The season of the row being entered, in the `Y/YY` form. */
  season: string
  /** The field's region, or null for a boundary outside both extents. */
  region: 'br' | 'us' | null
  /** True for a source that declares `season_dimension` `none` (the United States source). */
  seasonless: boolean
}

export type CropList = {
  options: CropOption[]
  /** The catalog keys of the sources that returned no value, in the order R-62 names them. */
  missing: TranslationKey[]
}

/** R-61's season rule: the year `Y` of a `Y/YY` season, or null when the label is not one. */
export function seasonYear(season: string): number | null {
  const match = /^(\d{4})\/(\d{2})$/.exec(season)
  return match ? Number(match[1]) : null
}

/** R-61's season rule: whether the year falls inside the named product's range. */
export function classProductAdmits(
  product: keyof typeof CLASS_PRODUCT_RANGES,
  season: string,
): boolean {
  const year = seasonYear(season)
  if (year === null) return false
  const range = CLASS_PRODUCT_RANGES[product]
  return year >= range.from && year <= range.to
}

/**
 * R-61's region rule. OD-11 is not approved for Brazil and OD-10's default admits no United States
 * class, so no class name of block 6 enters the list today. The function exists so the approval has
 * one place to land and so the criterion can assert that the empty clause is a rule and not a bug.
 */
export function regionAdmitsHistory(region: 'br' | 'us' | null): boolean {
  if (region === 'br') return false
  if (region === 'us') return false
  return false
}

/** R-61 clause (b): the history crops admitted for this field, its season and its region. */
export function admittedHistoryCrops(input: CropListInput): string[] {
  if (!regionAdmitsHistory(input.region)) return []
  if (!classProductAdmits('agriculture_first_crop', input.season)) return []
  return [...input.historyCrops]
}

/**
 * R-61 and R-62: the list, deduplicated by string, each value keeping the tag of the first source
 * that returned it, and the sources that returned nothing when the list is empty.
 */
export function cropListFor(input: CropListInput): CropList {
  const options: CropOption[] = []
  const seen = new Set<string>()
  for (const crop of input.windowCrops) {
    if (crop === '' || seen.has(crop)) continue
    seen.add(crop)
    options.push({ value: crop, tag: 'window' })
  }
  for (const crop of admittedHistoryCrops(input)) {
    if (crop === '' || seen.has(crop)) continue
    seen.add(crop)
    options.push({ value: crop, tag: 'history' })
  }
  if (options.length > 0) return { options, missing: [] }

  const missing: TranslationKey[] = [
    input.seasonless ? 'history.missing_window_field' : 'history.missing_window_season',
  ]
  missing.push(regionAdmitsHistory(input.region) ? 'history.missing_history_own' : 'history.missing_history_region')
  return { options: [], missing }
}

/** R-62: the `{missing}` value of the empty text, in the order the keys carry. */
export function missingSourcesText(keys: readonly TranslationKey[], translate: (key: TranslationKey) => string, join: string): string {
  return keys.map((key) => translate(key)).join(join)
}
