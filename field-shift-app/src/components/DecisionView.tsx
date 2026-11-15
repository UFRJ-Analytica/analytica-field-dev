/**
 * Block 7, R-01 to R-06 and R-28 to R-34: the `Planting calendar` region.
 *
 * A full viewport surface, a sibling of the map screen, opened by its strip button or by
 * `?decision=1` (the plumbing keeps the word `Decision`; the visible name is R-01's). It prints one
 * row per crop and season with every limit's own source line, the block 6 climate numbers beside the
 * window as context, and the declared sowing dates the producer entered, each routed by R-31's
 * three tests. It computes no envelope of its own: the rows come from `calendarRows`, which reads the
 * window rows the app already holds for block 4's band, so the two surfaces agree by construction.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  applyMarks,
  calendarRows,
  contextFrom,
  seasonlessRows,
  type CalendarContext,
  type CalendarRow,
  type SeasonlessPayload,
  type ZarcWindowRow,
} from '@/lib/planting-calendar'
import { sowingMarksFor } from '@/lib/history'
import type { HistoryRow } from '@/lib/producer-store'
import type { RingPoint } from '@/lib/field-ring'
import { seasonForDate } from '@/lib/timeline'
import { fetchNumbers, NumbersHttpError, NumbersNetworkError } from '@/lib/numbers-api'
import type { NumbersPayload } from '@/lib/numbers'
import { t, type TranslationKey } from '@/strings'
import './Block7.css'

export const DECISION_VIEW_ATTR = 'data-decision-view'

export type CalendarTarget = {
  fieldId: string
  ring: RingPoint[]
  centroid: [number, number]
  areaHa: number | null
}

type DecisionViewProps = {
  fieldName: string | null
  chosenDate: string
  /** The field's place, or null when it has none (a registered field carries no municipality). */
  place: { municipality: string; uf: string } | null
  /** The window rows of the region's source, or null when no source holds the region. */
  windowRows: ZarcWindowRow[] | null
  /** The seasonless source of the United States, when that is the region's source. */
  seasonless: SeasonlessPayload | null
  heldSeasons: string[]
  history: HistoryRow[]
  /** What the block 6 numbers route is asked for, or null when there is nothing to ask about. */
  numbersTarget: CalendarTarget | null
  seasonlessGrainState?: boolean
}

function contextText(context: CalendarContext | null): string | null {
  if (!context) return null
  if (context.kind === 'state') {
    return `${context.state}${context.reason ? `: ${context.reason}` : ''}`
  }
  return context.numbers
    .map((number) => `${t(number.key)}: ${t('calendar.context_value', { value: number.value ?? 'null', basis: number.basis, source: number.source, as_of: number.asOf ?? '' })}`)
    .join(' | ')
}

function RowCells({ row }: { row: CalendarRow }) {
  const mark = row.marks[0]
  return (
    <>
      <td>
        {row.crop}
        {mark ? (
          <span className="calendar-mark">
            {t('calendar.mark', { date: mark.date, edited: mark.editedAt.slice(0, 10) })}
          </span>
        ) : null}
      </td>
      <td>{row.seasonless ? t('calendar.seasonless_season') : row.season}</td>
      <td>{row.start ?? (row.startMd ?? (row.noWindowKey ? t(row.noWindowKey, { crop: row.crop, season: row.season }) : ''))}</td>
      <td>{row.end ?? row.endMd ?? ''}</td>
      <td>
        {row.source === null ? null : row.source.kind === 'season' ? (
          t('calendar.source_line', {
            portaria: row.source.portaria,
            date: row.source.portariaDate,
            risk: row.source.risk,
            soils: row.source.soils.join(', '),
            cycles: row.source.cycles.join(', '),
            management: row.source.management,
            rows: row.source.rows,
          })
        ) : (
          <>
            {t('calendar.citation_line', { citation: row.source.citation, grain: row.source.grain })}
            <span className="calendar-context">{t(row.source.caveatKey)}</span>
          </>
        )}
      </td>
      <td>{row.source?.kind === 'season' ? row.source.risk : t('calendar.risk_not_held')}</td>
      <td>{row.source?.kind === 'season' ? row.source.soils.join(', ') : t('calendar.risk_not_held')}</td>
      <td>{row.source?.kind === 'season' ? row.source.cycles.join(', ') : t('calendar.risk_not_held')}</td>
      <td>{row.source?.kind === 'season' ? row.source.rows : row.noWindowKey ? 0 : 1}</td>
    </>
  )
}

export function DecisionView({
  fieldName,
  chosenDate,
  place,
  windowRows,
  seasonless,
  heldSeasons,
  history,
  numbersTarget,
}: DecisionViewProps) {
  const [payload, setPayload] = useState<NumbersPayload | null>(null)
  const season = seasonForDate(chosenDate)

  // R-30: the three climate numbers come from the block 6 payload. One request, keyed on the field,
  // its ring and the chosen date, so a resize issues nothing (R-05).
  const targetKey = numbersTarget === null ? '' : JSON.stringify([numbersTarget.fieldId, chosenDate, numbersTarget.ring.length, numbersTarget.areaHa])
  useEffect(() => {
    if (numbersTarget === null) {
      setPayload(null)
      return
    }
    const controller = new AbortController()
    fetchNumbers(numbersTarget.fieldId, {
      ring: numbersTarget.ring,
      centroid: numbersTarget.centroid,
      area_ha: numbersTarget.areaHa,
      date: chosenDate,
    }, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setPayload(next)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (reason instanceof NumbersHttpError || reason instanceof NumbersNetworkError) setPayload(null)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const base: { rows: CalendarRow[]; empty: TranslationKey | null; params?: Record<string, string> } = useMemo(() => {
    if (seasonless) {
      return { rows: seasonlessRows(seasonless), empty: seasonless.rows.length === 0 ? ('calendar.empty_season' as TranslationKey) : null }
    }
    if (!windowRows || !place) {
      return { rows: [], empty: ('calendar.abstain_municipality' as TranslationKey) }
    }
    const placeRows = windowRows.filter((row) => row.municipality === place.municipality && row.uf === place.uf)
    const rows = calendarRows(placeRows, season)
    return {
      rows,
      empty: rows.length === 0 ? ('calendar.empty_season' as TranslationKey) : null,
      params: { season },
    }
  }, [seasonless, windowRows, place, season])

  const marked = useMemo(
    () => applyMarks({
      rows: base.rows,
      marks: sowingMarksFor(history),
      season,
      heldSeasons: seasonless ? [] : heldSeasons,
      seasonless: seasonless !== null,
    }),
    [base.rows, history, season, seasonless, heldSeasons],
  )

  const context = payload === null ? null : contextFrom(payload)
  const emptyText = fieldName === null
    ? t('record.no_field_selected')
    : base.empty === null
      ? null
      : t(base.empty, base.params ?? {})

  // Block 5.5, W5: the panel body. The landmark and the heading are the host's; `Back to map` and
  // the calendar's own `Gaps` card are deleted by block 7 revision 10 (U9, R-58).
  return (
    <div className="decision-panel" data-decision-view>
      <div className="surface-content">
        <div className="surface-card">
          <h3 id="calendar-card-title">{t('calendar.title')}</h3>
          {emptyText !== null ? (
            <p className="surface-empty">{emptyText}</p>
          ) : (
            <div className="surface-card-scroll">
              <table className="surface-table calendar-table" aria-label={t('calendar.table_label')}>
                <thead>
                  <tr>
                    <th scope="col">{t('calendar.col.crop')}</th>
                    <th scope="col">{t('calendar.col.season')}</th>
                    <th scope="col">{t('calendar.col.earliest')}</th>
                    <th scope="col">{t('calendar.col.latest')}</th>
                    <th scope="col">{t('calendar.col.citation')}</th>
                    <th scope="col">{t('calendar.col.risk')}</th>
                    <th scope="col">{t('calendar.col.soils')}</th>
                    <th scope="col">{t('calendar.col.cycles')}</th>
                    <th scope="col">{t('calendar.col.rows')}</th>
                  </tr>
                </thead>
                <tbody>
                  {marked.rows.map((row, index) => (
                    <tr className={index % 2 === 1 ? 'calendar-row-alt' : undefined} data-calendar-crop={row.crop} key={`${row.crop}-${row.season}-${index}`}>
                      <RowCells row={row} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {context !== null && emptyText === null ? (
            <p className="calendar-context">{t('calendar.context_label')}: {contextText(context)}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
