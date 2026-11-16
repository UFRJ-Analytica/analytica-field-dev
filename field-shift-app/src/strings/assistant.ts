/**
 * Field Shift AI strings: `at(locale, key)`. The data is in `assistant-catalog.ts`.
 *  - English renders through the app's `t()` (keys `assistant.*`, spread into `en.ts`).
 *  - Portuguese reads `assistantPtBR`, because `pt-BR.ts` stays empty under block 3 R-37.
 *  - Unit words are data values (block 6 R-11) and are read from the catalog in both languages.
 * The language itself is the app's one `fs.locale`.
 */
import { getLocale, t, type Locale } from '@/strings'
import { assistantEn, assistantPtBR, type AssistantKey } from './assistant-catalog'

export { assistantEn, assistantPtBR, type AssistantKey }

const CATALOGS: Record<Locale, Record<AssistantKey, string>> = { en: assistantEn, 'pt-BR': assistantPtBR }

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  )
}

/**
 * An assistant string in `locale`. The active locale goes through the app's `t()`, the one
 * translation path; another locale (asked for by tests that compare both) reads the catalog.
 */
export function at(locale: Locale, key: AssistantKey, vars?: Record<string, string | number>): string {
  if (locale === 'en' && getLocale() === 'en' && !key.startsWith('unit.')) return t(`assistant.${key}`, vars)
  return fill(CATALOGS[locale][key], vars)
}
