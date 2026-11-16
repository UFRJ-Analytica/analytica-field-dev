import { t } from '@/strings'

/**
 * The `Field Report` control of the strip, next to `Field Data` and `Data Info`.
 *
 * A field with report data opens the report page in a new tab at `/report/<municipality code>`, so
 * the map page is left exactly as it is. A field without one is disabled with its reason in the
 * accessible name, the same pattern as `Field Data, select a polygon first`.
 */
export function ReportButton({ code }: { code: number | null }) {
  const label = t('report.open')
  if (code === null) {
    return (
      <button
        type="button"
        className="top-chip panel-toggle"
        data-report-toggle
        aria-label={t('report.needs_pilot', { panel: label })}
        disabled
      >
        {label}
      </button>
    )
  }
  return (
    <a
      className="top-chip panel-toggle"
      data-report-toggle
      href={`/report/${code}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('report.open_for', { code })}
    >
      {label}
    </a>
  )
}
