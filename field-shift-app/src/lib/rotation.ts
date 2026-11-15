/**
 * Block 6 wave 3, R-33 to R-36: the rotation history by product and code, the years and the
 * states the source holds, and the United States CDL history read from the Crop Sequence
 * Boundary properties of a polygon. Pure functions: the card prints what they return.
 *
 * A class is always the pair `product` and `code` (R-34). A pair the table does not hold is
 * `unmapped`, a NULL code is `not computed`, and neither is ever printed as a guessed name.
 */
import { classTableFor } from './polygon-class-tables'

export const FIRST_CROP_PRODUCT = 'agriculture_first_crop'
export const SECOND_CROP_PRODUCT = 'agriculture_second_crop'
/** The product of a United States CDL class. Its code is the CDL code of the year. */
export const CDL_PRODUCT = 'cdl'
export const FIRST_CROP_YEARS: readonly [number, number] = [1985, 2025]
export const SECOND_CROP_YEARS: readonly [number, number] = [2000, 2025]
export const CDL_YEARS: readonly [number, number] = [2018, 2025]

/** Table D: nine first crop classes and three second crop classes, each under its own product. */
export const TABLE_D: ReadonlyArray<{ product: string; code: number; name: string }> = [
  { product: FIRST_CROP_PRODUCT, code: 39, name: 'Soybean' },
  { product: FIRST_CROP_PRODUCT, code: 20, name: 'Sugar cane' },
  { product: FIRST_CROP_PRODUCT, code: 40, name: 'Rice' },
  { product: FIRST_CROP_PRODUCT, code: 62, name: 'Cotton (beta)' },
  { product: FIRST_CROP_PRODUCT, code: 41, name: 'Other temporary crops' },
  { product: FIRST_CROP_PRODUCT, code: 46, name: 'Coffee' },
  { product: FIRST_CROP_PRODUCT, code: 47, name: 'Citrus' },
  { product: FIRST_CROP_PRODUCT, code: 35, name: 'Palm oil' },
  { product: FIRST_CROP_PRODUCT, code: 48, name: 'Other perennial crops' },
  { product: SECOND_CROP_PRODUCT, code: 1, name: 'Second crop corn' },
  { product: SECOND_CROP_PRODUCT, code: 62, name: 'Second crop cotton' },
  { product: SECOND_CROP_PRODUCT, code: 41, name: 'Other second crop' },
]

/**
 * M-19: the ten states the second crop product maps, which is the only set of states the second
 * crop history may print. Beta product, Collection 11.
 */
export const SECOND_CROP_STATES: readonly string[] = [
  'Paraná',
  'São Paulo',
  'Minas Gerais',
  'Mato Grosso do Sul',
  'Mato Grosso',
  'Goiás',
  'Tocantins',
  'Bahia',
  'Piauí',
  'Maranhão',
]

/** What a row's class cell prints: a name from the table, unmapped, not computed, or absent. */
export type ClassCell =
  | { kind: 'named'; name: string }
  | { kind: 'unmapped' }
  | { kind: 'not_computed' }
  | { kind: 'absent' }

export type HistoryRow = { year: number; product: string; code: number | null; cell: ClassCell }

/** One sidecar row as the payload carries it: the year, the product and the code. */
export type SidecarEntry = { year: number; product: string; code: number | null }

/** The Table D name of a (product, code) pair, or null when the pair is not in the table. */
export function mapbiomasClassFor(product: string, code: number | null): string | null {
  if (code === null) return null
  const hit = TABLE_D.find((row) => row.product === product && row.code === code)
  return hit ? hit.name : null
}

export function classCellFor(product: string, code: number | null): ClassCell {
  if (code === null) return { kind: 'not_computed' }
  const name = mapbiomasClassFor(product, code)
  return name === null ? { kind: 'unmapped' } : { kind: 'named', name }
}

/**
 * R-35: one row per year the sidecar carries inside the range of the product, sorted by year.
 * A row of another product, a year outside the range and a repeated year are dropped, so the
 * history never prints a year the source does not hold.
 */
export function historyRows(
  entries: readonly SidecarEntry[],
  product: string,
  years: readonly [number, number],
): HistoryRow[] {
  const [first, last] = years
  const byYear = new Map<number, HistoryRow>()
  for (const entry of entries) {
    if (entry.product !== product || entry.year < first || entry.year > last) continue
    if (byYear.has(entry.year)) continue
    byYear.set(entry.year, {
      year: entry.year,
      product: entry.product,
      code: entry.code,
      cell: classCellFor(product, entry.code),
    })
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year)
}

/** The legend name of a United States CDL code, or null when the legend holds none. */
export function usCdlNameOf(code: number): string | null {
  const row = classTableFor('us').rows.find((candidate) => candidate.value === code)
  return row?.name ?? null
}

/**
 * The CDL history of a United States polygon: one row per CDL year 2018 to 2025, read from the
 * `cdl{Y}` properties of its Crop Sequence Boundary record. A missing or null property is `absent`
 * for that year, and a code the legend does not name is `unmapped`. MapBiomas rows never mix in.
 */
export function cdlHistory(
  values: Readonly<Record<number, number | null | undefined>>,
  nameOf: (code: number) => string | null,
): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (let year = CDL_YEARS[0]; year <= CDL_YEARS[1]; year += 1) {
    const code = values[year]
    if (typeof code !== 'number' || !Number.isFinite(code)) {
      rows.push({ year, product: CDL_PRODUCT, code: null, cell: { kind: 'absent' } })
      continue
    }
    const name = nameOf(code)
    rows.push({
      year,
      product: CDL_PRODUCT,
      code,
      cell: name === null ? { kind: 'unmapped' } : { kind: 'named', name },
    })
  }
  return rows
}
