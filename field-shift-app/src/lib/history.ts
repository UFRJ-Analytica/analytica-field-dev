/**
 * Block 7, R-43 to R-47 and R-31: the declared management history.
 *
 * A row has seven keys and one producer per value (Table A), so this module only validates and
 * indexes what the producer typed: it derives no crop, season or date from block 6, from the fixture
 * or from a previous row (R-44), and it writes no sentence (R-39).
 */
import type { HistoryRow } from './producer-store'

export type HistoryErrorCode =
  | 'history.date_outside_season'
  | 'history.same_crop'
  | 'history.duplicate_season'
  | 'history.second_date_without_crop'

export type HistoryValidation =
  | { ok: true; row: HistoryRow }
  | { ok: false; code: HistoryErrorCode }

/** R-47: a season `Y/YY` runs from 1 July of `Y` to 30 June of `Y` plus one. */
export function seasonRange(season: string): { start: string; end: string } | null {
  const match = /^(\d{4})\/(\d{2})$/.exec(season)
  if (!match) return null
  const start = Number(match[1])
  return { start: `${start}-07-01`, end: `${start + 1}-06-30` }
}

/** R-47 and V-16: a sowing date falls inside its own season. */
export function dateInSeason(date: string, season: string): boolean {
  const range = seasonRange(season)
  if (!range) return false
  const day = date.slice(0, 10)
  return day >= range.start && day <= range.end
}

/**
 * R-47 and Table D: the four rejections of a history row, each with its own code. `existing` is
 * every other row of the same field, which is where V-18 reads the duplicate season.
 */
export function validateHistoryRow(input: HistoryRow, existing: readonly HistoryRow[]): HistoryValidation {
  if (input.second_sowing_date !== null && (input.second_crop === null || input.second_crop === '')) {
    return { ok: false, code: 'history.second_date_without_crop' }
  }
  if (input.second_crop !== null && input.second_crop === input.first_crop) {
    return { ok: false, code: 'history.same_crop' }
  }
  if (input.first_sowing_date !== null && !dateInSeason(input.first_sowing_date, input.season)) {
    return { ok: false, code: 'history.date_outside_season' }
  }
  if (input.second_sowing_date !== null && !dateInSeason(input.second_sowing_date, input.season)) {
    return { ok: false, code: 'history.date_outside_season' }
  }
  if (existing.some((row) => row.season === input.season)) {
    return { ok: false, code: 'history.duplicate_season' }
  }
  return { ok: true, row: input }
}

/** A declared sowing date, ready to be matched against the calendar (R-31). */
export type SowingMark = {
  crop: string
  season: string
  date: string
  editedAt: string
}

/**
 * R-31: the declared dates of a field's history, one mark per crop and season. A row with no date
 * produces no mark, and a row whose first and second crop share a season produce two.
 */
export function sowingMarksFor(rows: readonly HistoryRow[]): SowingMark[] {
  const marks: SowingMark[] = []
  for (const row of rows) {
    if (row.first_sowing_date !== null) {
      marks.push({ crop: row.first_crop, season: row.season, date: row.first_sowing_date, editedAt: row.edited_at })
    }
    if (row.second_sowing_date !== null && row.second_crop !== null) {
      marks.push({ crop: row.second_crop, season: row.season, date: row.second_sowing_date, editedAt: row.edited_at })
    }
  }
  return marks
}

/** The row a form is editing: a history row it will replace, identified by its season. */
export function rowsAfterSave(
  rows: readonly HistoryRow[],
  next: HistoryRow,
  editingSeason: string | null,
): HistoryRow[] {
  if (editingSeason === null) return [...rows, next]
  return rows.map((row) => (row.season === editingSeason ? next : row))
}

/** R-47: deleting one row removes that row and nothing else. */
export function rowsAfterDelete(rows: readonly HistoryRow[], season: string): HistoryRow[] {
  return rows.filter((row) => row.season !== season)
}
