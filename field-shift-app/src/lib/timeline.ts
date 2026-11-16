import type { LayersAxis } from './layer-catalog'

/** The date axis of R-28: every date of the block is a UTC calendar date. */
export type Axis = Pick<LayersAxis, 'start' | 'end' | 'default'>

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

export function utcMs(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
}

export function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** R-38: the step buttons and the range move by whole UTC days, never by local time. */
export function addDays(date: string, days: number): string {
  return fromUtcMs(utcMs(date) + days * DAY_MS)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS)
}

/**
 * R-28: a date outside the axis clamps to the nearest bound and reports which bound it
 * used, so the live region can say `Date limited to {date}`. A value that is not a date
 * leaves the choice alone: it is not a date the user can have meant.
 */
export function clampToAxis(date: string, axis: Axis): { date: string; clamped: string | null } {
  if (!isIsoDate(date)) return { date: axis.default, clamped: null }
  if (date < axis.start) return { date: axis.start, clamped: axis.start }
  if (date > axis.end) return { date: axis.end, clamped: axis.end }
  return { date, clamped: null }
}

/** R-28: `?date=YYYY-MM-DD` sets the chosen date at load when it lies on the axis. */
export function readDateParam(search: string, axis: Axis): { date: string; clamped: string | null } {
  const value = new URLSearchParams(search).get('date')
  if (!value) return { date: axis.default, clamped: null }
  return clampToAxis(value, axis)
}

/**
 * R-29: a crop season starts on 1 July, so the label is `Y/YY` where Y is the year of the
 * most recent 1 July on or before the date.
 */
export function seasonForDate(date: string): string {
  const [year, month] = date.slice(0, 10).split('-').map(Number)
  const startYear = month >= 7 ? year : year - 1
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`
}

/**
 * R-31: the snapshot writes its season as `Y/YYYY`. This is the only conversion between
 * the derived `Y/YY` label and the snapshot key.
 */
export function snapshotSeasonKey(season: string): string {
  const [yearText, shortYearText] = season.split('/')
  const year = Number(yearText)
  const century = Math.floor(year / 100) * 100
  let end = century + Number(shortYearText)
  while (end <= year) end += 100
  return `${year}/${end}`
}

/** The state names a field `location` text can carry, mapped to the snapshot's UF. */
const STATE_UF: Record<string, string> = {
  Acre: 'AC',
  Alagoas: 'AL',
  Amapá: 'AP',
  Amazonas: 'AM',
  Bahia: 'BA',
  Ceará: 'CE',
  'Distrito Federal': 'DF',
  'Espírito Santo': 'ES',
  Goiás: 'GO',
  Maranhão: 'MA',
  'Mato Grosso': 'MT',
  'Mato Grosso do Sul': 'MS',
  'Minas Gerais': 'MG',
  Pará: 'PA',
  Paraíba: 'PB',
  Paraná: 'PR',
  Pernambuco: 'PE',
  Piauí: 'PI',
  'Rio de Janeiro': 'RJ',
  'Rio Grande do Norte': 'RN',
  'Rio Grande do Sul': 'RS',
  Rondônia: 'RO',
  Roraima: 'RR',
  'Santa Catarina': 'SC',
  'São Paulo': 'SP',
  Sergipe: 'SE',
  Tocantins: 'TO',
}

/**
 * R-31: the municipality and UF are read from the field's `location` text, which the
 * fixture writes as `Santa Carmem, Mato Grosso`.
 */
export function parseFieldLocation(location: string | null | undefined): { municipality: string; uf: string } | null {
  if (!location) return null
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const uf = STATE_UF[parts[parts.length - 1]]
  if (!uf) return null
  return { municipality: parts[0], uf }
}

/** R-33: the primary layer is the first layer that is on in stack order, else smap-l3. */
export const DEFAULT_PRIMARY_LAYER = 'smap-l4-surface'

export function primaryLayerId(order: readonly string[], on: Record<string, boolean>): string {
  return order.find((id) => on[id]) ?? DEFAULT_PRIMARY_LAYER
}
