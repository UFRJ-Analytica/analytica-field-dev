import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import type { ClimateRow } from '@/lib/climate'
import { en } from '@/strings/en'
import { monthName, t, translationKeyFor } from '@/strings'

export type EvidenceBasis = 'observed' | 'retrieved' | 'reported' | 'modelled' | 'entered'

export type EvidenceRow = {
  layer: string
  value: string | null
  basis: EvidenceBasis
  as_of: string
  source: string
}

type EvidencePanelProps = {
  rows: EvidenceRow[]
  isLoading?: boolean
  emptyReason?: string | null
  /** Municipal climate rows, rendered as a second table under the scenario rows. */
  climate?: { municipality: string; rows: ClimateRow[] } | null
}

function climateLayer(row: ClimateRow): string {
  if (row.metric === 'yield_anomaly_pct') {
    const crop = row.crop_name_en ?? ''
    return t('climate.metric.yield_anomaly_pct', { crop: t(translationKeyFor(crop) ?? crop) })
  }
  const key = `climate.metric.${row.metric}`
  if (!Object.hasOwn(en, key) || !row.months) return row.layer
  const [first, last] = row.months
  return t(key, {
    months: t('climate.month_span', { from: monthName(first), to: monthName(last) }),
    month: monthName(first),
  })
}

function ClimateTable({ municipality, rows }: { municipality: string; rows: ClimateRow[] }) {
  const title = t('climate.table.title', { municipality })
  return (
    <div className="climate-evidence" role="group" aria-label={title}>
      <h3 className="climate-evidence-title">{title}</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('evidence.layer')}</th>
            <th scope="col">{t('evidence.value')}</th>
            <th scope="col">{t('evidence.basis')}</th>
            <th scope="col">{t('evidence.as_of')}</th>
            <th scope="col">{t('evidence.source')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.metric}-${row.crop_name_en ?? ''}`} data-metric={row.metric}>
              <th scope="row">{climateLayer(row)}</th>
              <td>
                <span className="climate-value" data-dynamic-content>{row.value}</span>
                {row.n_years !== null ? <span className="climate-note">{t('climate.row.n_years', { count: row.n_years })}</span> : null}
                {row.small_sample ? <span className="climate-flag climate-flag-small">{t('climate.row.small_sample')}</span> : null}
                {row.assumption ? <span className="climate-flag climate-flag-assumption">{t('climate.row.assumed_season')}</span> : null}
                <span className="climate-note climate-support" data-dynamic-content>{row.support}</span>
              </td>
              <td><span className={`basis-label basis-${row.basis}`}>{t(`evidence.basis_${row.basis}`)}</span></td>
              <td data-dynamic-content><time dateTime={row.as_of}>{row.as_of}</time></td>
              <td data-dynamic-content><a href={row.source} target="_blank" rel="noreferrer">{row.source}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="climate-evidence-note">{t('climate.table.note')}</p>
    </div>
  )
}

export function EvidencePanel({ rows, isLoading = false, emptyReason, climate = null }: EvidencePanelProps) {
  return (
    <section className="scenario-panel evidence-panel" role="region" aria-label={t('evidence.title')}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t('evidence.supporting_data')}</p>
          <h2>{t('evidence.title')}</h2>
        </div>
      </div>
      {isLoading ? (
        <div className="evidence-loading" aria-label={t('evidence.loading')} aria-busy="true">
          <Skeleton className="mb-3 h-8 w-full" />
          {rows.length > 0 ? rows.map((row) => (
            <Skeleton className="mb-2 h-10 w-full" key={`${row.layer}-${row.as_of}`} />
          )) : Array.from({ length: 3 }, (_, index) => (
            <Skeleton className="mb-2 h-10 w-full" key={`evidence-skeleton-${index}`} />
          ))}
        </div>
      ) : emptyReason ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyTitle>{t('evidence.no_evidence_available')}</EmptyTitle>
            <EmptyDescription>{emptyReason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
      <table>
        <thead>
          <tr>
            <th scope="col">{t('evidence.layer')}</th>
            <th scope="col">{t('evidence.value')}</th>
            <th scope="col">{t('evidence.basis')}</th>
            <th scope="col">{t('evidence.as_of')}</th>
            <th scope="col">{t('evidence.source')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.layer}-${row.as_of}`}>
              <th scope="row">{t(translationKeyFor(row.layer) ?? row.layer)}</th>
              <td>{row.value === null ? t('evidence.no_observation') : t(translationKeyFor(row.value) ?? row.value)}</td>
              <td><span className={`basis-label basis-${row.basis}`}>{t(`evidence.basis_${row.basis}`)}</span></td>
              <td data-dynamic-content><time dateTime={row.as_of}>{row.as_of}</time></td>
              <td data-dynamic-content><a href={row.source} target="_blank" rel="noreferrer">{row.source}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      {!isLoading && climate && climate.rows.length > 0 ? (
        <ClimateTable municipality={climate.municipality} rows={climate.rows} />
      ) : null}
    </section>
  )
}
