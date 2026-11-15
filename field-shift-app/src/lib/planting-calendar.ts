/**
 * Block 7, R-28 to R-34 and R-31: the planting calendar's rules.
 *
 * The calendar prints one row per crop and season. For the Brazil source it reads the rows of
 * `window_risk_20` and draws, for each crop, the earliest start and the latest end over the rows of
 * that crop and season (R-28), with the portaria, the risk level, the soil codes, the cycles, the
 * management and the row count of the rows it enveloped (R-29). For the seasonless United States
 * source it prints one row per crop, month and day with no year, the source's own citation and grain,
 * and `Not held by this source` where the Brazil source carries a code (R-29, AC-57).
 *
 * R-28 keeps the source boundary: this module reads no file and issues no request. Its input is the
 * window rows the block 4 source answered with, handed to `calendarRows` by the caller, which is the
 * same object block 4 already loaded for the band. The one conversion between the derived `Y/YY`
 * label and the snapshot's `Y/YYYY` key is `seasonKeyFor`, which delegates to block 4's own
 * `snapshotSeasonKey` rather than holding a second copy of the rule.
 */
import type { NumbersPayload } from './numbers'
import { snapshotSeasonKey } from './timeline'
import type { TranslationKey } from '@/strings'

/** R-28: one row of the Brazil snapshot, as the block 4 source returns it. */
export type ZarcWindowRow = {
  crop: string
  season: string
  uf: string
  municipality: string
  management?: string
  soil_code?: string | number | null
  cultivar_cycle_code?: string | number | null
  portaria?: string | null
  portaria_date?: string | null
  window_risk_20: { start_date: string; end_date: string } | null
}

/** R-29, season source: everything the source line of one limit names. */
export type SeasonSourceLine = {
  kind: 'season'
  portaria: string
  portariaDate: string
  risk: string
  soils: string[]
  cycles: string[]
  management: string
  rows: number
}

/** R-29, seasonless source: the citation and the grain, and the cells the source does not hold. */
export type SeasonlessSourceLine = {
  kind: 'seasonless'
  citation: string
  grain: string
  caveatKey: TranslationKey
}

export type CalendarSourceLine = SeasonSourceLine | SeasonlessSourceLine

/** One row of the calendar table (Table B). */
export type CalendarRow = {
  crop: string
  /** The derived `Y/YY` label, or the seasonless label key, rendered by the view. */
  season: string
  seasonless: boolean
  start: string | null
  end: string | null
  startMd: string | null
  endMd: string | null
  source: CalendarSourceLine | null
  /** Set when the row exists only because the history named a crop the source holds no row for. */
  noWindowKey: TranslationKey | null
  marks: CalendarMark[]
}

/** A declared sowing date that landed on a row (R-31). */
export type CalendarMark = { crop: string; season: string; date: string; editedAt: string }

/** R-58: one row of the Gaps card. Six fields, as AC-51 reads them. */
export type CalendarGap = {
  surface: string
  cause: TranslationKey
  source: string
  status: string
  date: string
  remediation: string
  params?: Record<string, string>
}

/** R-28: the one documented conversion between the band's label and the snapshot's key. */
export function seasonKeyFor(label: string): string {
  return snapshotSeasonKey(label)
}

function textOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text === '' ? null : text
}

function sortedUnique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort()
}

/**
 * R-28 and R-29: the envelope of one crop and one season, and the facts the source line prints. The
 * envelope is the earliest start and the latest end over the rows of that crop and season; the risk
 * level, the soil codes and the cycles are the ones the enveloped rows carry, so a spread of codes
 * prints as a list rather than being reduced to one.
 */
export function envelope(rows: readonly ZarcWindowRow[]): {
  start: string
  end: string
  portarias: Array<{ portaria: string; date: string }>
  soils: string[]
  cycles: string[]
  management: string
  count: number
} | null {
  let start: string | null = null
  let end: string | null = null
  const portarias: Array<{ portaria: string; date: string }> = []
  const soils: Array<string | null> = []
  const cycles: Array<string | null> = []
  const managements: string[] = []
  let count = 0

  for (const row of rows) {
    const window = row.window_risk_20
    if (!window?.start_date || !window?.end_date) continue
    count += 1
    if (start === null || window.start_date < start) start = window.start_date
    if (end === null || window.end_date > end) end = window.end_date
    const portaria = textOf(row.portaria)
    if (portaria !== null) {
      const date = textOf(row.portaria_date) ?? ''
      if (!portarias.some((entry) => entry.portaria === portaria && entry.date === date)) {
        portarias.push({ portaria, date })
      }
    }
    soils.push(textOf(row.soil_code))
    cycles.push(textOf(row.cultivar_cycle_code))
    const management = textOf(row.management)
    if (management !== null && !managements.includes(management)) managements.push(management)
  }

  if (start === null || end === null) return null
  return {
    start,
    end,
    portarias,
    soils: sortedUnique(soils),
    cycles: sortedUnique(cycles),
    management: managements.join(', '),
    count,
  }
}

/**
 * R-28, R-29 and R-33: the rows of one season, one per crop, in the order the source returns its
 * crops. A row whose rows carry no window keeps its crop with no limits, which is the state R-29
 * prints as the empty text; a crop that the source returns no row for at all is not in this list, and
 * R-31's third test adds it only when the history names it.
 */
export function calendarRows(windows: readonly ZarcWindowRow[], season: string): CalendarRow[] {
  const key = seasonKeyFor(season)
  const rows = windows.filter((row) => row.season === key)
  const crops: string[] = []
  for (const row of rows) if (!crops.includes(row.crop)) crops.push(row.crop)

  return crops.map((crop) => {
    const cropRows = rows.filter((row) => row.crop === crop)
    const window = envelope(cropRows)
    if (window === null) {
      return {
        crop,
        season,
        seasonless: false,
        start: null,
        end: null,
        startMd: null,
        endMd: null,
        source: null,
        noWindowKey: 'calendar.empty_crop' as TranslationKey,
        marks: [],
      }
    }
    const first = window.portarias[0]
    return {
      crop,
      season,
      seasonless: false,
      start: window.start,
      end: window.end,
      startMd: window.start.slice(5),
      endMd: window.end.slice(5),
      source: {
        kind: 'season',
        portaria: window.portarias.map((entry) => entry.portaria).join(', '),
        portariaDate: first?.date ?? '',
        risk: '20',
        soils: window.soils,
        cycles: window.cycles,
        management: window.management,
        rows: window.count,
      },
      noWindowKey: null,
      marks: [],
    }
  })
}

/** R-28 and R-29, seasonless source: one row of `artifacts/us-windows-cass-nd.json`. */
export type SeasonlessWindowRow = {
  crop: string
  window_start_md: string | null
  window_end_md: string | null
  cdl_name?: string | null
}

export type SeasonlessPayload = {
  grain?: string
  region?: { state?: string | null; county?: string | null; county_fips?: string | null }
  rows: SeasonlessWindowRow[]
  citation?: string | null
}

/** R-29: the exact citation of the seasonless source, printed in the `citation` cell. */
export const SEASONS_CITATION =
  'NASS, North Dakota Agricultural Statistics 2025, Usual Planting and Harvesting Dates by Crop - North Dakota: 20-Year Average, printed page 20, column (begin) for the start and column (end) for the end'

/** R-29: the grain of a seasonless source, `state` with its state name. */
export function grainText(payload: SeasonlessPayload): string {
  const grain = payload.grain ?? 'state'
  const state = payload.region?.state ?? ''
  if (grain === 'county') {
    return `county ${payload.region?.county ?? ''} (FIPS ${payload.region?.county_fips ?? ''})`
  }
  return `${state}, ${grain} grain`
}

/**
 * R-29, seasonless case: one row per crop of the source, in the source's order, the season cell
 * `every season, 20 year average`, the limits as month and day with no year, the citation and grain
 * in the source line and `Not held by this source` where the Brazil source carries a code. A crop
 * whose window is null keeps its row and prints the empty text of R-29, which AC-57 asserts for
 * Canola.
 */
export function seasonlessRows(payload: SeasonlessPayload): CalendarRow[] {
  const citation = payload.citation ?? SEASONS_CITATION
  const grain = grainText(payload)
  return payload.rows.map((row) => {
    const hasWindow = Boolean(row.window_start_md && row.window_end_md)
    return {
      crop: row.crop,
      season: 'calendar.seasonless_season',
      seasonless: true,
      start: null,
      end: null,
      startMd: hasWindow ? (row.window_start_md as string) : null,
      endMd: hasWindow ? (row.window_end_md as string) : null,
      source: hasWindow ? { kind: 'seasonless' as const, citation, grain, caveatKey: 'calendar.end_caveat' as TranslationKey } : null,
      noWindowKey: hasWindow ? null : ('calendar.empty_crop' as TranslationKey),
      marks: [],
    }
  })
}

/**
 * R-31: route every declared sowing date to the row it can mark, in the three ordered tests.
 *
 * 1. The source does not hold the season: no mark, one gap row, `calendar.mark_unplaced`.
 * 2. The source holds the season but the calendar does not display it: no mark, one gap row,
 *    `calendar.season_not_shown`.
 * 3. The season is displayed and the crop has no row: one row for the crop with the declared date
 *    and the no-window text, and no mark on any other row.
 *
 * A row that exists with a null window (Canola on the seasonless source) is not a crop without a
 * row: the mark lands on it.
 */
export function applyMarks(input: {
  rows: readonly CalendarRow[]
  marks: readonly CalendarMark[]
  season: string
  /** Every season key the source holds, in its own `Y/YYYY` form, for test 1. */
  heldSeasons: readonly string[]
  seasonless: boolean
}): { rows: CalendarRow[]; gaps: CalendarGap[] } {
  const rows = input.rows.map((row) => ({ ...row, marks: [...row.marks] }))
  const gaps: CalendarGap[] = []
  const seasonKey = input.seasonless ? null : seasonKeyFor(input.season)
  const surface = 'Planting calendar'

  for (const mark of input.marks) {
    const markKey = input.seasonless ? null : seasonKeyFor(mark.season)
    if (!input.seasonless && !input.heldSeasons.includes(markKey as string)) {
      gaps.push({
        surface,
        cause: 'calendar.mark_unplaced',
        source: 'fs.producer.v1',
        status: `season ${mark.season}, crop ${mark.crop}, date ${mark.date}`,
        date: mark.editedAt.slice(0, 10),
        remediation: 'CO-B7-08',
        params: { season: mark.season, crop: mark.crop },
      })
      continue
    }
    if (!input.seasonless && markKey !== seasonKey) {
      gaps.push({
        surface,
        cause: 'calendar.season_not_shown',
        source: 'fs.producer.v1',
        status: `season ${mark.season}, crop ${mark.crop}, date ${mark.date}`,
        date: mark.editedAt.slice(0, 10),
        remediation: 'CO-B7-08',
        params: { season: mark.season, crop: mark.crop },
      })
      continue
    }
    const row = rows.find((entry) => entry.crop === mark.crop)
    if (row) {
      row.marks.push(mark)
      continue
    }
    // Test 3: the crop has no row at all, so the calendar prints one for it with the declared date.
    rows.push({
      crop: mark.crop,
      season: input.seasonless ? 'calendar.seasonless_season' : mark.season,
      seasonless: input.seasonless,
      start: null,
      end: null,
      startMd: null,
      endMd: null,
      source: null,
      noWindowKey: input.seasonless
        ? ('calendar.no_window_for_crop_seasonless' as TranslationKey)
        : ('calendar.no_window_for_crop' as TranslationKey),
      marks: [mark],
    })
  }
  return { rows, gaps }
}

/** R-30: one of the three block 6 numbers the calendar prints as context. */
export type ContextNumber = {
  key: TranslationKey
  value: number | string | null
  basis: string
  source: string
  asOf: string | null
}

export type CalendarContext =
  | { kind: 'numbers'; numbers: ContextNumber[] }
  | { kind: 'state'; state: string; reason: string }

/**
 * R-30: the three climate numbers of the block 6 payload, each with the basis, source and `as_of`
 * the climate section carries. While the section abstains or is unavailable, or the payload names
 * no climate section, the calendar prints that state and the payload's own reason in place of the
 * numbers and still prints the window.
 *
 * The rain percentile is the block 6 key `rain_percentile` in the tree; R-30 words it `percentile`,
 * and both spellings are read so a payload of either shape prints the number rather than a blank.
 */
export function contextFrom(payload: NumbersPayload | null | undefined): CalendarContext {
  const climate = payload?.sections?.climate
  if (!climate) return { kind: 'state', state: 'unavailable', reason: '' }
  if (climate.state !== 'ok') {
    // Block 6's tree carries `error` on an abstaining section; R-30 words the same field `reason`,
    // so both spellings are read and the one present is printed.
    const loose = climate as { reason?: string | null }
    return {
      kind: 'state',
      state: climate.state ?? 'unavailable',
      reason: (typeof climate.error === 'string' && climate.error.trim() !== '')
        ? climate.error
        : (typeof loose.reason === 'string' ? loose.reason : ''),
    }
  }
  const basis = climate.basis ?? 'modelled'
  const source = climate.source ?? ''
  const asOf = climate.as_of ?? null
  const normals = climate.normals as Record<string, { value?: number | null } | undefined> | undefined
  const percentile = climate.normals?.rain_percentile?.value ?? normals?.percentile?.value ?? null
  const numbers: ContextNumber[] = [
    { key: 'calendar.dry_spell', value: climate.aggregates?.dry_spell_days?.value ?? null, basis, source, asOf },
    { key: 'calendar.frost_days', value: climate.aggregates?.frost_days?.value ?? null, basis, source, asOf },
    { key: 'calendar.rain_percentile', value: percentile, basis, source, asOf },
  ]
  return { kind: 'numbers', numbers }
}

/** R-31: the season keys a set of window rows holds, in the source's own `Y/YYYY` form. */
export function heldSeasonsOf(windows: readonly ZarcWindowRow[]): string[] {
  return [...new Set(windows.map((row) => row.season))]
}
