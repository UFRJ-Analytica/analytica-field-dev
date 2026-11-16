import { createContext, useContext, useMemo, type ReactNode } from "react";
import { STRINGS, type Locale, type Strings } from "./strings";

export type { Locale, Strings };

interface I18n {
  locale: Locale;
  t: Strings;
  /** Locale-aware number: fmt(1234.5, 1) -> "1.234,5" (pt-BR) / "1,234.5" (en). */
  fmt: (n: number | null | undefined, digits?: number) => string;
  /** Signed number with unit suffix: signed(40, "%") -> "+40%". */
  signed: (n: number | null | undefined, unit?: string, digits?: number) => string;
  /** ISO date -> "11 nov. 2026" / "11 Nov 2026". */
  date: (iso: string | null | undefined) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18n>(() => {
    const num = (digits: number) =>
      new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const dateFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const fmt = (n: number | null | undefined, digits = 0) => (n == null ? "—" : num(digits).format(n));
    return {
      locale,
      t: STRINGS[locale],
      fmt,
      signed: (n, unit = "", digits = 0) => {
        if (n == null) return "—";
        // Sign from the *rounded* value, so -0.4 shows as "0%", never "−0%".
        const r = Number(n.toFixed(digits));
        const s = fmt(Math.abs(r), digits);
        // U+2212 minus, so negative values align with positive ones in tables.
        return `${r > 0 ? "+" : r < 0 ? "−" : ""}${s}${unit}`;
      },
      date: (iso) => (iso ? dateFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—"),
    };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
