import { en } from './en'
import { ptBR } from './pt-BR'

export type TranslationKey = keyof typeof en
export type TranslationVariables = Record<string, string | number>
export type Locale = 'en' | 'pt-BR'

export const LOCALE_STORAGE_KEY = 'fs.locale'
/** Dispatched on `window` after setLocale writes the key, so mounted views can re-render. */
export const LOCALE_CHANGE_EVENT = 'fs:locale-change'

export function getLocale(): Locale {
  if (typeof localStorage === 'undefined') return 'en'
  return localStorage.getItem(LOCALE_STORAGE_KEY) === 'pt-BR' ? 'pt-BR' : 'en'
}

/** The short month name in the app's language, from a 1 based month number. */
export function monthName(month: number): string {
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2001, month - 1, 1)))
    .replace('.', '')
}

/** The one writer of the stored locale. `fs.locale` stays the single source of truth. */
export function setLocale(locale: Locale): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT))
}

export function translationKeyFor(value: string): TranslationKey | null {
  // `assistant.*` keys (Field Shift AI) never answer a reverse lookup, so a fixture string such as
  // `SMAP soil moisture` keeps resolving to the app key it resolved to before they existed.
  const entry = Object.entries(en).find(([key, english]) => english === value && !key.startsWith('assistant.'))
  return entry ? entry[0] as TranslationKey : null
}

export function t(key: TranslationKey | string, vars?: TranslationVariables): string {
  const english = en[key as TranslationKey]
  const template = getLocale() === 'pt-BR' && ptBR[key as keyof typeof ptBR]
    ? ptBR[key as keyof typeof ptBR] as string
    : english ?? key

  if (!vars) return template
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  )
}
