import { Skeleton } from '@/components/ui/skeleton'
import type { FieldClimate, Loadable } from '@/lib/climate'
import { monthName, t } from '@/strings'

type Bar = { key: string; label: string; value: number | null }

/**
 * One line under the rotation heading for the selected field's municipality. The
 * three values share one scale whose maximum is the largest of them; every value also prints as
 * text, so the bar never carries a number alone. The line prints its own crop year.
 */
export function ClimateSignal({ climate }: { climate: Loadable<FieldClimate> | null }) {
  if (climate === null) return null
  if (climate.status === 'loading') {
    return (
      <div className="climate-signal" aria-busy="true">
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }
  if (climate.status === 'unavailable') {
    return (
      <div className="climate-signal climate-signal-unavailable">
        <span className="visual-caption">{t('climate.signal.unavailable')}</span>
      </div>
    )
  }

  const { municipality, season_progress: progress, crop_year_label: season } = climate.data
  const bars: Bar[] = [
    { key: 'rain', label: t('climate.signal.rain_so_far', { month: monthName(progress.start_month ?? 9) }), value: progress.rain_mm },
    { key: 'normal', label: t('climate.signal.normal'), value: progress.normal_mm },
    { key: 'analog', label: t('climate.signal.analog'), value: progress.analog_mm },
  ]
  const scaleMax = Math.max(...bars.map((bar) => bar.value ?? 0))
  const basisLabel = t(`evidence.basis_${progress.basis}`)
  const municipalityName = `${municipality.name_official} (${municipality.uf})`

  return (
    <section className="climate-signal" aria-label={t('climate.signal.label', { municipality: municipalityName })}>
      <div className="climate-signal-heading">
        <span className="visual-caption">{t('climate.signal.caption')}</span>
        <span className="climate-signal-place" data-dynamic-content>{municipalityName}</span>
        <span className="climate-signal-season">{t('climate.signal.season', { season })}</span>
        <span className={`basis-label basis-${progress.basis}`}>{basisLabel}</span>
        <time data-dynamic-content dateTime={progress.last_observed}>{progress.last_observed}</time>
        <span>{t('climate.signal.analog_years', { count: progress.n_analog })}</span>
      </div>
      <ul className="climate-bars">
        {bars.map((bar) => {
          const percent = bar.value !== null && scaleMax > 0 ? Number(((bar.value / scaleMax) * 100).toFixed(2)) : 0
          return (
            <li
              key={bar.key}
              className={`climate-bar climate-bar-${bar.key}`}
              aria-label={bar.value === null
                ? t('climate.signal.bar_label_empty', { label: bar.label, state: t('climate.signal.not_available') })
                : t('climate.signal.bar_label', { label: bar.label, value: Math.round(bar.value) })}
            >
              <span className="climate-bar-label">{bar.label}</span>
              {bar.value === null
                ? <span className="climate-bar-value">{t('climate.signal.not_available')}</span>
                : <span className="climate-bar-value" data-dynamic-content>{Math.round(bar.value)} mm</span>}
              <span className="climate-bar-track">
                <span className="climate-bar-fill" data-fill-percent={percent} style={{ width: `${percent}%` }} />
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
