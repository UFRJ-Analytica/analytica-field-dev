/**
 * Locale formatting for Field Shift AI. Decimals and rounding are block 6's own (Table A mirror in
 * `lib/numbers.ts`); only the decimal separator, the grouping and the unit word follow the locale.
 */
import { familyOf, METRICS, roundHalfUp } from '@/lib/numbers'
import { at, type AssistantKey } from '@/strings/assistant'
import type { Locale } from '@/strings'
import { intlTag } from './locale'

/** Block 6 unit strings and the catalog key of their printed form. */
const UNIT_KEYS: Record<string, AssistantKey> = {
  mm: 'unit.mm',
  days: 'unit.days',
  C: 'unit.C',
  'C day': 'unit.C_day',
  percent: 'unit.percent',
  '1': 'unit.index',
  'unit 1': 'unit.index',
  unitless: 'unit.index',
  years: 'unit.years',
  scenes: 'unit.scenes',
  'g/kg': 'unit.g_kg',
  pH: 'unit.pH',
}

export function decimalsFor(metric: string, fallback = 1): number {
  return METRICS[familyOf(metric)]?.decimals ?? fallback
}

export function formatNumber(value: number, decimals: number, locale: Locale): string {
  return roundHalfUp(value, decimals).toLocaleString(intlTag(locale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** The printed unit of a block 6 unit string, or the string itself for a unit with no entry. */
export function formatUnit(unit: string | null, locale: Locale): string {
  if (unit === null) return ''
  const key = UNIT_KEYS[unit]
  return key ? at(locale, key) : unit
}

/**
 * A value with its unit, e.g. `171,9 mm` or `171.9 mm`. Null is never printed as zero: it returns
 * the catalog's `no value` text.
 */
export function formatValue(value: number | string | null, unit: string | null, metric: string,
  locale: Locale, decimals?: number): string {
  if (value === null || (typeof value === 'number' && !Number.isFinite(value))) return at(locale, 'ev.no_value')
  if (typeof value === 'string') return value
  const number = formatNumber(value, decimals ?? decimalsFor(metric), locale)
  const printedUnit = formatUnit(unit, locale)
  if (printedUnit === '') return number
  return printedUnit === '%' ? `${number}%` : `${number} ${printedUnit}`
}

/** An ISO date (YYYY-MM-DD, or an instant) in the locale's medium form, read in UTC so no day shifts. */
export function formatDate(iso: string | null, locale: Locale): string {
  if (iso === null || iso === '') return ''
  const instant = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(instant.getTime())) return iso
  return new Intl.DateTimeFormat(intlTag(locale), {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(instant)
}

/**
 * A source resolution string in the locale. Known block 6 / experiment phrasings are rewritten,
 * with the numbers kept exactly; anything else is returned as the source wrote it.
 */
export function formatResolution(resolution: string, locale: Locale): string {
  if (locale === 'en') return resolution
  const comma = (_: string, n: string) => n.replace('.', ',')
  return resolution
    .replace(/about (\d+(?:\.\d+)?) degree cell/g, (_, n: string) => `célula de cerca de ${comma(_, n)}°`)
    .replace(/(\d+(?:\.\d+)?) degree cell/g, (_, n: string) => `célula de ${comma(_, n)}°`)
    .replace(/(\d+(?:\.\d+)?) m static model/g, (_, n: string) => `modelo estático de ${comma(_, n)} m`)
    .replace(/(\d+(?:\.\d+)?) km posting/g, (_, n: string) => `grade de ${comma(_, n)} km`)
    .replace(/(\d+(?:\.\d+)?) km radiometer footprint/g, (_, n: string) => `pegada do radiômetro de ${comma(_, n)} km`)
    .replace('(meteorology)', '(meteorologia)')
    .replace('(solar)', '(radiação solar)')
    .replace(/Collection (\d+)/g, 'Coleção $1')
    .replace(/^not applicable$/, 'não se aplica')
    .replace(/^the municipality$/, 'o município')
    .replace(/^the state$/, 'o estado')
    .replace(/^the polygon$/, 'o polígono')
}

/** `A and B`, `A, B and C` in the locale. */
export function formatList(items: string[], locale: Locale): string {
  if (items.length <= 1) return items.join('')
  return at(locale, 'answer.list_and', { first: items.slice(0, -1).join(', '), last: items[items.length - 1] })
}
