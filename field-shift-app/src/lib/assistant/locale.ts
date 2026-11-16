/**
 * Field Shift AI: the active locale as React state. It reads and writes the app's own `fs.locale`
 * through `@/strings` (getLocale / setLocale), so there is no second source of truth for language.
 */
import { useSyncExternalStore } from 'react'
import { getLocale, LOCALE_CHANGE_EVENT, LOCALE_STORAGE_KEY, setLocale, type Locale } from '@/strings'

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LOCALE_STORAGE_KEY) onChange()
  }
  window.addEventListener(LOCALE_CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(LOCALE_CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'en' as Locale)
  return [locale, setLocale]
}

/** The BCP 47 tag Intl needs for a locale of the app. */
export function intlTag(locale: Locale): string {
  return locale === 'pt-BR' ? 'pt-BR' : 'en-US'
}
