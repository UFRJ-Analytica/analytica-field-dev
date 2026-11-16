import { Skeleton } from '@/components/ui/skeleton'
import { signedCelsius, type EnsoState, type Loadable } from '@/lib/climate'
import { t } from '@/strings'

/** Read-only ENSO state from the CPC fixture, next to the brand chip. */
export function EnsoChip({ enso }: { enso: Loadable<EnsoState> }) {
  if (enso.status === 'loading') {
    return (
      <span className="top-chip enso-chip" aria-label={t('climate.enso.loading')} aria-busy="true">
        <Skeleton className="h-3 w-28" />
      </span>
    )
  }
  if (enso.status === 'unavailable') {
    return <span className="top-chip enso-chip enso-unavailable">{t('climate.enso.unavailable')}</span>
  }

  const { roni, discussion, basis } = enso.data
  const phase = t(`climate.enso.phase.${roni.phase}`)
  const strength = t(`climate.enso.strength.${roni.strength ?? 'none'}`)
  const value = signedCelsius(roni.value)
  const basisLabel = t(`evidence.basis_${basis}`)
  const label = t('climate.enso.chip_label', {
    phase,
    strength,
    season: roni.season,
    value,
    basis: basisLabel,
    issued: discussion.issued,
  })

  return (
    <span className="top-chip enso-chip" role="group" aria-label={label} data-phase={roni.phase}>
      <span className="enso-dot" aria-hidden="true" />
      <span className="enso-phase">{phase}</span>
      <span className="enso-strength">{strength}</span>
      <span className="enso-index">{t('climate.enso.index')}</span>
      <span className="enso-value" data-dynamic-content>{roni.season} {value}</span>
      <span className={`basis-label basis-${basis}`}>{basisLabel}</span>
      <time className="enso-issued" data-dynamic-content dateTime={discussion.issued}>
        {t('climate.enso.issued', { issued: discussion.issued })}
      </time>
    </span>
  )
}
