/**
 * Block 6 revision 5: the `Field numbers` panel of the map screen (R-01 to R-06, R-07 to R-13,
 * R-21 to R-25, R-30, R-41, R-42, R-44). It is a panel body inside the map screen's panel host:
 * the map stays visible and interactive while it is open, no element of the map screen reads
 * `display: none`, and opening or closing the panel calls no `map.resize()`. The landmark and the
 * level two heading belong to the host. It prints what the payload says and nothing else: every
 * printed number reads its basis from its own provenance row (R-08, R-09).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { readoutRows } from '@/lib/polygon-readout'
import { commandFieldId } from '@/lib/polygon-selection'
import { regionAdapter } from '@/lib/regions'
import {
  AGGREGATE_INPUTS,
  familyOf,
  formatMetric,
  interiorPoint,
  METRICS,
  printedWindow,
  type AggregateName,
  type ClimateSection,
  type ClimateSeries,
  type GapRow,
  type NormalName,
  type NumbersPayload,
  type NumbersRequest,
  type ProvenanceRow,
  type SmapDay,
} from '@/lib/numbers'
import {
  fetchNumbers,
  NumbersHttpError,
  NumbersNetworkError,
  numbersLastReadKey,
} from '@/lib/numbers-api'
import { falsifierCompleteness, falsifierGaps, falsifierOf, falsifierReading, type FalsifiableScenario } from '@/lib/falsifier'
import { t, translationKeyFor } from '@/strings'
import './NumbersView.css'

export const NUMBERS_VIEW_ATTR = 'data-numbers-view'

type NumbersViewProps = {
  selectedField: FieldSummary | null
  /** Block 6 F-13: the scenarios of the selected fixture field, for the counter evidence card. */
  scenarios?: readonly FalsifiableScenario[]
}

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; payload: NumbersPayload }
  | { kind: 'held'; payload: NumbersPayload }
  | { kind: 'offline' }
  | { kind: 'error'; status: number }

type Request = { fieldId: string; body: NumbersRequest }

/** The provenance rows of the payload, keyed by metric, for the basis chip of each value (R-08). */
const RowsContext = createContext<Map<string, ProvenanceRow>>(new Map())

const NO_GAPS: GapRow[] = []

/**
 * R-12, AC-11: the cause an abstained row prints. The section's own `error` when the route sends
 * one, then the older `reason` key a payload may still carry; otherwise the cause of the section's
 * gap row, which is where the route records why the input is missing; otherwise a sentence that says
 * the reason was not recorded, so the text never falls back to `No value`. `needle` picks the gap row
 * of a section that records more than one cause: the municipality section records the municipal cause
 * and the state cause. A per-row cause never borrows another row's, so when the needle finds no gap
 * the row fails closed to that sentence.
 */
function abstainReason(
  reason: string | null | undefined,
  section: string,
  gaps: GapRow[],
  needle?: string,
): string {
  const own = typeof reason === 'string' ? reason.trim() : ''
  if (own !== '') return own
  const sectionGaps = gaps.filter((gap) => gap.section === section)
  const gap = needle
    ? sectionGaps.find((entry) => entry.cause.toLowerCase().includes(needle))
    : sectionGaps[0]
  const cause = gap?.cause?.trim() ?? ''
  return cause === '' ? t('numbers.abstain.not_recorded') : cause
}

function dateOf(stamp: string | null | undefined): string {
  return stamp ? stamp.slice(0, 10) : t('numbers.no_value')
}

function basisText(basis: string): string {
  return t(`evidence.basis_${basis}`)
}

function BasisChip({ basis }: { basis: ProvenanceRow['basis'] }) {
  return (
    <span className={`numbers-basis numbers-basis-${basis}`} data-basis={basis}>
      {basisText(basis)}
    </span>
  )
}

/**
 * One printed number. The value is the payload's; the basis chip is the basis of the row with
 * the same metric id, and no other input can change it. A null value prints its abstention text.
 */
function Printed({ metric, value, abstain }: { metric: string; value: number | null; abstain: string }) {
  const rows = useContext(RowsContext)
  const row = rows.get(metric)
  const text = value === null ? null : formatMetric(metric, value)
  if (text === null) {
    return (
      <span className="numbers-cell">
        <span className="numbers-abstain" data-metric={metric}>{abstain}</span>
      </span>
    )
  }
  const unit = METRICS[familyOf(metric)]?.unit ?? ''
  // Table A's unit `1` is a dimensionless ratio: it carries no printed symbol beside the number.
  const printedUnit = unit === '1' ? '' : unit
  return (
    <span className="numbers-cell">
      <span className="numbers-value" data-metric={metric}>
        {text}
        {printedUnit && <span className="numbers-unit"> {printedUnit}</span>}
      </span>
      {row && <BasisChip basis={row.basis} />}
    </span>
  )
}

/** A printed label-like value that is not numeric (a class name of Table D), with its own row. */
function PrintedText({ metric, text }: { metric: string; text: string }) {
  const rows = useContext(RowsContext)
  const row = rows.get(metric)
  return (
    <span className="numbers-cell">
      <span className="numbers-value" data-metric={metric}>{text}</span>
      {row && <BasisChip basis={row.basis} />}
    </span>
  )
}

function Card({
  id,
  title,
  source,
  asOf,
  basis,
  resolution,
  children,
}: {
  id: string
  title: string
  source: string
  asOf: string | null
  basis: ProvenanceRow['basis']
  resolution?: string | null
  children: ReactNode
}) {
  return (
    <section className="numbers-card" data-card={id}>
      <h3>{title}</h3>
      <p className="numbers-source" data-source-line>
        {t('numbers.source_line', { source, as_of: asOf ?? t('numbers.as_of_none'), basis: basisText(basis) })}
      </p>
      {resolution && <p className="numbers-resolution">{t('numbers.resolution_line', { resolution })}</p>}
      {children}
    </section>
  )
}

/**
 * R-21: the daily chart. One point per valid day for rain, `T2M_MAX` and `T2M_MIN`, each panel
 * in the unit of Table A. A line joins two neighbouring days only when both carry a value, so a
 * dropped day is a gap in the series and never a bridge.
 *
 * The card renderers below are exported for the contract tests: each one reads exactly one section
 * of the payload, so a test can hold that section to the recorded response on its own.
 */
const CHART_W = 640
const PANEL_H = 120
const PAD_L = 40
const PAD_R = 12
const PAD_T = 14
const PAD_B = 18

export function ClimateChart({ series }: { series: ClimateSeries }) {
  const n = Math.max(series.rain_day.length, series.tmax_day.length, series.tmin_day.length)
  if (n === 0) return <p className="numbers-abstain">{t('numbers.chart.no_points')}</p>
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i * (CHART_W - PAD_L - PAD_R)) / (n - 1))
  const rainValues = series.rain_day.flatMap((p) => (p.value === null ? [] : [p.value]))
  const rainMax = Math.max(10, ...rainValues)
  const yRain = (v: number) => PANEL_H - PAD_B - (v / rainMax) * (PANEL_H - PAD_T - PAD_B)
  const tempValues = [...series.tmax_day, ...series.tmin_day].flatMap((p) => (p.value === null ? [] : [p.value]))
  const tMin = tempValues.length ? Math.floor(Math.min(...tempValues)) - 1 : 0
  const tMax = tempValues.length ? Math.ceil(Math.max(...tempValues)) + 1 : 1
  const yTemp = (v: number) =>
    PANEL_H + PANEL_H - PAD_B - ((v - tMin) / (tMax - tMin)) * (PANEL_H - PAD_T - PAD_B)

  const points = (data: { value: number | null; date: string }[], y: (v: number) => number) =>
    data.map((p, i) => (p.value === null ? null : (
      <circle cx={x(i)} cy={y(p.value)} data-date={p.date} key={p.date} r={2.6} />
    )))

  const segments = (data: { value: number | null }[], y: (v: number) => number) => {
    const paths: ReactNode[] = []
    for (let i = 1; i < data.length; i += 1) {
      const a = data[i - 1].value
      const b = data[i].value
      if (a === null || b === null) continue
      paths.push(<path d={`M ${x(i - 1)} ${y(a)} L ${x(i)} ${y(b)}`} data-segment key={`${i}`} fill="none" />)
    }
    return paths
  }

  return (
    <svg
      aria-label={t('numbers.climate.chart_label')}
      className="numbers-chart"
      role="img"
      viewBox={`0 0 ${CHART_W} ${PANEL_H * 2}`}
    >
      <text className="numbers-chart-axis" x={PAD_L} y={PAD_T - 3}>{t('numbers.climate.chart_rain')}</text>
      <text className="numbers-chart-axis" x={PAD_L} y={PANEL_H + PAD_T - 3}>{t('numbers.climate.chart_temperature')}</text>
      <line className="numbers-chart-base" x1={PAD_L} x2={CHART_W - PAD_R} y1={PANEL_H - PAD_B} y2={PANEL_H - PAD_B} />
      <line className="numbers-chart-base" x1={PAD_L} x2={CHART_W - PAD_R} y1={PANEL_H * 2 - PAD_B} y2={PANEL_H * 2 - PAD_B} />
      <g className="numbers-chart-rain" data-metric="rain_day" data-points={series.rain_day.filter((p) => p.value !== null).length}>
        {points(series.rain_day, yRain)}
      </g>
      <g className="numbers-chart-tmax" data-metric="tmax_day" data-points={series.tmax_day.filter((p) => p.value !== null).length}>
        {segments(series.tmax_day, yTemp)}
        {points(series.tmax_day, yTemp)}
      </g>
      <g className="numbers-chart-tmin" data-metric="tmin_day" data-points={series.tmin_day.filter((p) => p.value !== null).length}>
        {segments(series.tmin_day, yTemp)}
        {points(series.tmin_day, yTemp)}
      </g>
    </svg>
  )
}

export function ClimateCard({ climate, window, gaps = NO_GAPS }: { climate: ClimateSection; window: NumbersPayload['query']['window']; gaps?: GapRow[] }) {
  const aggregates: AggregateName[] = [
    'rain_total',
    'dry_spell_days',
    'gdd10',
    'frost_days',
    'tmin_min',
    'gwetroot_mean',
  ]
  const normals: Array<{ key: NormalName; metric: string }> = [
    { key: 'rain_median', metric: 'rain_median' },
    { key: 'rain_min', metric: 'rain_min' },
    { key: 'rain_max', metric: 'rain_max' },
    { key: 'rain_rank', metric: 'rain_rank' },
    { key: 'rain_percentile', metric: 'rain_percentile' },
    { key: 'hot_days', metric: 'hot_days' },
    { key: 'hot_days_median', metric: 'hot_days_median' },
  ]
  // R-19: an aggregate abstains with the valid and missing day counts its own payload object carries,
  // and the parameter is the Table A input of that aggregate. An absent object means the section
  // carries no aggregate at all: the row then names that input and the section source, with the
  // section error or gap cause, or the sentence that says the reason was not recorded (R-12, AC-11).
  const abstainAggregate = (key: AggregateName) => {
    const aggregate = climate.aggregates[key]
    if (!aggregate) {
      return t('numbers.abstain.aggregate_absent', {
        parameter: AGGREGATE_INPUTS[key],
        reason: abstainReason(climate.error, 'climate', gaps),
        source: climate.source,
      })
    }
    return t('numbers.abstain.aggregate', {
      parameter: AGGREGATE_INPUTS[key],
      valid: aggregate.valid_days,
      days: aggregate.of_days,
      missing: aggregate.of_days - aggregate.valid_days,
    })
  }
  // R-12: the normals abstention names the POWER input, its source and its cause, and Table E makes
  // `normals` a key of every climate state. A payload from a build before that key existed carries
  // none, so the access stays optional and the card prints its abstain text instead of throwing.
  const abstainNormal = t('numbers.abstain.normals', {
    reason: abstainReason(climate.normals?.error ?? climate.error, 'climate', gaps),
    source: climate.source,
  })
  // An unavailable climate section sends `series: {}` (and a payload from an older build can omit it):
  // hand the chart the three families it reads so it prints its empty text instead of throwing.
  const chartSeries: ClimateSeries = {
    rain_day: climate.series?.rain_day ?? [],
    tmax_day: climate.series?.tmax_day ?? [],
    tmin_day: climate.series?.tmin_day ?? [],
  }
  // R-16 asks for the window the aggregates were computed over. An unavailable section resolves
  // none, and R-48 makes the card print its reason instead of a window line built from nulls.
  const windowFacts = printedWindow(window)
  return (
    <Card
      id="climate"
      title={t('numbers.card.climate')}
      source={climate.source}
      asOf={climate.as_of}
      basis={climate.basis}
      resolution={climate.resolution}
    >
      {windowFacts ? (
        <p className="numbers-window">
          {t('numbers.window_line', {
            start: windowFacts.start,
            end: windowFacts.end,
            valid: windowFacts.valid_days,
            days: windowFacts.days,
            dropped: windowFacts.dropped_days,
          })}
        </p>
      ) : (
        <p className="numbers-abstain" data-window-abstain>
          {t('numbers.abstain.window_climate', {
            reason: abstainReason(climate.error, 'climate', gaps),
            source: climate.source,
          })}
        </p>
      )}
      <p className="numbers-cell-statement">{t('numbers.climate.cell')}</p>
      <dl className="numbers-rows">
        {aggregates.map((key) => (
          <div className="numbers-row" key={key}>
            <dt>{t(`numbers.${key}`)}</dt>
            <dd>
              <Printed metric={key} value={climate.aggregates[key]?.value ?? null} abstain={abstainAggregate(key)} />
            </dd>
          </div>
        ))}
      </dl>
      <ClimateChart series={chartSeries} />
      <h4>{t('numbers.climate.normals_heading')}</h4>
      <p className="numbers-cell-statement">{t('numbers.climate.normals_statement')}</p>
      <dl className="numbers-rows">
        {normals.map(({ key, metric }) => (
          <div className="numbers-row" key={key}>
            <dt>{t(`numbers.${metric}`)}</dt>
            <dd>
              <Printed
                metric={metric}
                value={climate.normals?.[key]?.value ?? null}
                abstain={abstainNormal}
              />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function WaterCard({ water, gaps = NO_GAPS }: { water: NumbersPayload['sections']['water_balance']; gaps?: GapRow[] }) {
  const missing = water.missing
  // R-22 prints the window the balance was computed over. R-48's unavailable section and the
  // abstention with no consolidated rain day carry `window: null`, and then the card prints its
  // reason in place of the window line instead of reading five nulls into it. R-12 makes that text
  // name the window and the section source, with the section error or the water balance gap cause,
  // or the sentence that says the reason was not recorded.
  const windowFacts = printedWindow(water.window)
  const noWindow = t('numbers.abstain.window_water', {
    reason: abstainReason(water.error, 'water_balance', gaps),
    source: water.source,
  })
  // R-23: the balance abstains as a whole. The reason is printed once for the card, and each of
  // the three numbers shows `not computed`, so no partial sum and no zero stands in for it.
  const cell = (value: number | null) => (value === null && missing ? t('numbers.water.not_computed') : t('numbers.no_value'))
  return (
    <Card
      id="water"
      title={t('numbers.card.water')}
      source={water.source}
      asOf={water.as_of}
      basis={water.basis}
      resolution={water.resolution}
    >
      {missing && (
        <p className="numbers-abstain">{t('numbers.abstain.water', { parameter: missing.parameter, missing: missing.days })}</p>
      )}
      <dl className="numbers-rows">
        <div className="numbers-row">
          <dt>{t('numbers.wb_in')}</dt>
          <dd><Printed metric="wb_in" value={water.in} abstain={cell(water.in)} /></dd>
        </div>
        <div className="numbers-row">
          <dt>{t('numbers.water.out_label')}</dt>
          <dd><Printed metric="wb_out" value={water.out} abstain={cell(water.out)} /></dd>
        </div>
        <div className="numbers-row">
          <dt>{t('numbers.wb_remaining')}</dt>
          <dd><Printed metric="wb_remaining" value={water.remaining} abstain={cell(water.remaining)} /></dd>
        </div>
      </dl>
      <p className="numbers-formula">{t('numbers.water.formula')}</p>
      {windowFacts ? (
        <p className="numbers-window">{t('numbers.water.window', { start: windowFacts.start, end: windowFacts.end, days: windowFacts.days })}</p>
      ) : (
        <p className="numbers-abstain" data-window-abstain>{noWindow}</p>
      )}
      <p className="numbers-statement">{t('numbers.water.out_statement')}</p>
      <p className="numbers-statement">{t('numbers.water.statement')}</p>
    </Card>
  )
}

function SmapCard({ smap, gaps = NO_GAPS }: { smap: NumbersPayload['sections']['smap']; gaps?: GapRow[] }) {
  const reason = abstainReason(smap.error ?? smap.reason, 'smap', gaps)
  return (
    <Card id="smap" title={t('numbers.card.smap')} source={smap.source} asOf={smap.as_of} basis="retrieved" resolution={smap.resolution}>
      <p className="numbers-axis">{t('numbers.smap.axis')}</p>
      <p className="numbers-cell-statement">{t('numbers.smap.resolution')}</p>
      <p className="numbers-cell-statement">{t('numbers.smap.shared_cell')}</p>
      <p className="numbers-disclosure" data-disclosure>
        {t('numbers.smap.disclosure')}
      </p>
      <p className="numbers-disclosure" data-disclosure>{t('numbers.smap.route1')}</p>
      {smap.days.length === 0 && (
        <>
          <p className="numbers-abstain">{t('numbers.abstain.smap', { reason, source: smap.source })}</p>
          {/* R-07: the family rows print their abstention with their own metric ids (AC-06). */}
          <dl className="numbers-rows">
            <div className="numbers-row">
              <dt>{t('numbers.smap.surface')}</dt>
              <dd><Printed metric="smap_surface" value={null} abstain={t('numbers.smap.not_read')} /></dd>
            </div>
            <div className="numbers-row">
              <dt>{t('numbers.smap.rootzone')}</dt>
              <dd><Printed metric="smap_rootzone" value={null} abstain={t('numbers.smap.not_read')} /></dd>
            </div>
          </dl>
        </>
      )}
      {smap.days.length > 0 && (
        <table className="numbers-table numbers-smap-table">
          <thead>
            <tr>
              <th scope="col">{t('numbers.smap.date')}</th>
              <th scope="col">{t('numbers.smap.surface')}</th>
              <th scope="col">{t('numbers.smap.rootzone')}</th>
            </tr>
          </thead>
          <tbody>
            {smap.days.map((day: SmapDay) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td>
                  <Printed
                    metric={`smap_surface.${day.date}`}
                    value={day.surface_pct}
                    abstain={t('numbers.smap.day_gap', { status: day.status ?? t('numbers.no_value') })}
                  />
                </td>
                <td>
                  <Printed
                    metric={`smap_rootzone.${day.date}`}
                    value={day.rootzone_pct}
                    abstain={t('numbers.smap.day_gap', { status: day.status ?? t('numbers.no_value') })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function NdviCard({ ndvi, gaps = NO_GAPS }: { ndvi: NumbersPayload['sections']['ndvi']; gaps?: GapRow[] }) {
  const plotted = ndvi.scenes.filter((scene) => scene.ndvi_mean !== null && !scene.partial)
  // R-12, AC-11: a null count names the input it counts and the Earth Search source, with the
  // section error or the NDVI gap cause, or the sentence that says the reason was not recorded.
  const countReason = abstainReason(ndvi.error ?? ndvi.reason, 'ndvi', gaps)
  const abstainSceneCount = t('numbers.abstain.ndvi_scene_count', { reason: countReason, source: ndvi.source })
  const abstainClearCount = t('numbers.abstain.ndvi_clear_count', { reason: countReason, source: ndvi.source })
  // The card-level sentence below repeats the count, so a null count cannot reuse the counted
  // sentence: it names the count and the Earth Search source with the same cause as the count rows,
  // and never the placeholder `No value` (R-12, AC-11). A state that carries a count keeps the
  // sentence that states it, and both keep the two-scene rule.
  const sentence = ndvi.scene_count === null
    ? t('numbers.abstain.ndvi_uncounted', {
      reason: countReason,
      fraction: ndvi.best_valid_fraction ?? t('numbers.ndvi.best_fraction'),
      source: ndvi.source,
    })
    : t('numbers.abstain.ndvi', {
      scenes: ndvi.scene_count,
      fraction: ndvi.best_valid_fraction ?? t('numbers.ndvi.best_fraction'),
    })
  return (
    <Card id="ndvi" title={t('numbers.card.ndvi')} source={ndvi.source} asOf={ndvi.as_of} basis="retrieved">
      <p className="numbers-cell-statement">{t('numbers.ndvi.source')}</p>
      <dl className="numbers-rows">
        <div className="numbers-row">
          <dt>{t('numbers.ndvi_scene_count')}</dt>
          <dd><Printed metric="ndvi_scene_count" value={ndvi.scene_count} abstain={abstainSceneCount} /></dd>
        </div>
        <div className="numbers-row">
          <dt>{t('numbers.ndvi_clear_count')}</dt>
          <dd><Printed metric="ndvi_clear_count" value={ndvi.clear_count} abstain={abstainClearCount} /></dd>
        </div>
      </dl>
      {plotted.length === 0 && (
        <>
          <p className="numbers-abstain">{t('numbers.ndvi.none_plotted')}</p>
          {/* R-07: no point means the two family rows abstain with their own metric ids (AC-06). */}
          <dl className="numbers-rows">
            <div className="numbers-row">
              <dt>{t('numbers.ndvi_mean')}</dt>
              <dd><Printed metric="ndvi_mean" value={null} abstain={t('numbers.ndvi.not_plotted')} /></dd>
            </div>
            <div className="numbers-row">
              <dt>{t('numbers.ndvi_valid_fraction')}</dt>
              <dd><Printed metric="ndvi_valid_fraction" value={null} abstain={t('numbers.ndvi.not_plotted')} /></dd>
            </div>
          </dl>
        </>
      )}
      {ndvi.state !== 'ok' && (
        <p className="numbers-abstain" data-abstain-sentence="ndvi">{sentence}</p>
      )}
      {plotted.length > 0 && (
        <table className="numbers-table">
          <tbody>
            {plotted.map((scene) => (
              <tr key={scene.date}>
                <td>{scene.date}</td>
                <td><Printed metric={`ndvi_mean.${scene.date}`} value={scene.ndvi_mean} abstain={t('numbers.no_value')} /></td>
                <td>
                  <Printed
                    metric={`ndvi_valid_fraction.${scene.date}`}
                    value={scene.valid_fraction}
                    abstain={t('numbers.no_value')}
                  />
                  {scene.partial && <span className="numbers-partial">{t('numbers.ndvi.partial')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

export function SoilCard({ soil }: { soil: NumbersPayload['sections']['soil'] }) {
  return (
    <Card id="soil" title={t('numbers.card.soil')} source={soil.source} asOf={soil.as_of} basis="modelled" resolution="250 m static model">
      <p className="numbers-cell-statement">{t('numbers.soil.model')}</p>
      <table className="numbers-table">
        <thead>
          <tr>
            <th scope="col">{t('numbers.soil.depth_label')}</th>
            <th scope="col">{t('numbers.soil.clay')}</th>
            <th scope="col">{t('numbers.soil.sand')}</th>
            <th scope="col">{t('numbers.soil.ph')}</th>
            <th scope="col">{t('numbers.soil.soc')}</th>
          </tr>
        </thead>
        <tbody>
          {soil.depths.map((d) => {
            const depthText = d.depth.replace('_', ' to ')
            const abstain = (property: string) => t('numbers.abstain.soil', { property, depth: depthText })
            return (
              <tr key={d.depth}>
                <th scope="row">{t('numbers.soil.depth', { depth: depthText })}</th>
                <td><Printed metric={`soil.clay.${d.depth}`} value={d.clay_g_kg} abstain={abstain('clay')} /></td>
                <td><Printed metric={`soil.sand.${d.depth}`} value={d.sand_g_kg} abstain={abstain('sand')} /></td>
                <td><Printed metric={`soil.ph.${d.depth}`} value={d.ph} abstain={abstain('pH')} /></td>
                <td><Printed metric={`soil.soc.${d.depth}`} value={d.soc_g_kg} abstain={abstain('soil organic carbon')} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

export function RotationCard({ rotation }: { rotation: NumbersPayload['sections']['rotation'] }) {
  // R-36: a sidecar that cannot be read sends null lists, not empty ones. Null and empty both
  // abstain, and no year is printed for a section that holds none.
  const first = rotation.first_crop ?? []
  const second = rotation.second_crop ?? []
  const empty = first.length === 0 && second.length === 0
  return (
    <Card id="rotation" title={t('numbers.card.rotation')} source={rotation.source} asOf={rotation.as_of} basis={rotation.basis}>
      {rotation.collection_year !== null && (
        <p className="numbers-provenance-line">{t('numbers.rotation.collection', { year: rotation.collection_year })}</p>
      )}
      {empty && <p className="numbers-abstain">{t('numbers.rotation.no_row')}</p>}
      {first.length > 0 && (
        <>
          <h4>{t('numbers.rotation.first_crop')}</h4>
          <ul className="numbers-years">
            {first.map((entry) => (
              <li key={`${entry.product}-${entry.year}`}>
                <span className="numbers-year">{t('numbers.rotation.year', { year: entry.year })}</span>{' '}
                <PrintedText metric={`mb_first_crop.${entry.year}`} text={entry.class_name} />
              </li>
            ))}
          </ul>
        </>
      )}
      {second.length > 0 && (
        <>
          <h4>{t('numbers.rotation.second_crop')}</h4>
          <ul className="numbers-years">
            {second.map((entry) => (
              <li key={`${entry.product}-${entry.year}`}>
                <span className="numbers-year">{t('numbers.rotation.year', { year: entry.year })}</span>{' '}
                <PrintedText metric={`mb_second_crop.${entry.year}`} text={entry.class_name} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

function MunicipalCard({ municipal, gaps = NO_GAPS }: { municipal: NumbersPayload['sections']['municipality']; gaps?: GapRow[] }) {
  // R-12: the municipal row and the share carry the municipal cause: the section error of a failed
  // SIDRA read first, then the reason the route records for an unresolved municipal code, then the
  // municipal gap row. The state row carries the state cause, because the section records both and
  // they are not the same.
  const municipalReason = abstainReason(municipal.error ?? municipal.reason, 'municipality', gaps, 'municipal')
  // R-12: the state row names its own input and cause. The payload carries `state_reason` for exactly
  // this row, so the municipal reason must not leak into it; when `state_reason` and every state gap
  // are absent the clause falls back to the sentence that says the reason was not recorded.
  const stateReason = abstainReason(municipal.state_reason, 'municipality', gaps, 'state')
  const municipality = municipal.municipality
  const stateRow = municipal.state_row ?? null
  return (
    <Card id="municipal" title={t('numbers.card.municipal')} source={municipal.source} asOf={municipal.as_of} basis="retrieved">
      <dl className="numbers-rows">
        {municipality && (
          <div className="numbers-row">
            <dt>{t('numbers.municipal.municipality')}</dt>
            <dd>{municipality.name} ({municipality.code})</dd>
          </div>
        )}
        {/* R-07 and R-38: with no municipality the row abstains in place, carrying its own metric id. */}
        <div className="numbers-row">
          <dt>
            {municipality
              ? t('numbers.municipal.soy_planted', { year: municipality.year })
              : t('numbers.municipality_soy_ha')}
          </dt>
          <dd>
            <Printed
              metric="municipality_soy_ha"
              value={municipality ? municipality.soy_ha : null}
              abstain={t('numbers.abstain.municipal', { reason: municipalReason, source: municipal.source })}
            />
          </dd>
        </div>
        {/* R-38: the state row prints labelled beside an abstained municipal row, and abstains in place. */}
        <div className="numbers-row">
          <dt>
            {stateRow
              ? `${t('numbers.municipal.state')}, ${t('numbers.municipal.soy_planted', { year: stateRow.year })}`
              : t('numbers.state_soy_ha')}
          </dt>
          <dd>
            <Printed
              metric="state_soy_ha"
              value={stateRow ? stateRow.soy_ha : null}
              abstain={t('numbers.abstain.state', { reason: stateReason, source: municipal.source })}
            />
            {stateRow && <span className="numbers-state-label">{t('numbers.municipal.state_label')}</span>}
          </dd>
        </div>
      </dl>
      <div className="numbers-row">
        <dt>{t('numbers.municipal.share_label')}</dt>
        <dd>
          {/* R-12: the route omits `share` when it cannot compute it, so an absent key is a missing input and abstains. */}
          <Printed
            metric="polygon_share"
            value={municipal.share ?? null}
            abstain={t('numbers.abstain.share', { reason: municipalReason, source: municipal.source })}
          />
        </dd>
      </div>
    </Card>
  )
}

/**
 * R-07: a chart series is one provenance row for the family it draws. Its `value` is the point
 * list, which is not a React child, so the table prints the number of points the row covers, and
 * the chart prints each point's own date.
 */
function provenanceValue(row: ProvenanceRow): string {
  if (row.value === null) return t('numbers.no_value')
  if (typeof row.value === 'number') return formatMetric(row.metric, row.value)
  if (Array.isArray(row.value)) return t('numbers.provenance.series_value', { points: row.value.length })
  return row.value
}

export function ProvenanceTable({ rows }: { rows: ProvenanceRow[] }) {
  return (
    <section className="numbers-provenance" aria-labelledby="numbers-provenance-heading">
      <h3 id="numbers-provenance-heading">{t('numbers.provenance.heading')}</h3>
      <div className="numbers-scroll-x">
        <table className="numbers-table numbers-provenance-table">
          <thead>
            <tr>
              <th scope="col">{t('numbers.provenance.col.metric')}</th>
              <th scope="col">{t('numbers.provenance.col.label')}</th>
              <th scope="col">{t('numbers.provenance.col.value')}</th>
              <th scope="col">{t('numbers.provenance.col.unit')}</th>
              <th scope="col">{t('numbers.provenance.col.basis')}</th>
              <th scope="col">{t('numbers.provenance.col.as_of')}</th>
              <th scope="col">{t('numbers.provenance.col.source')}</th>
              <th scope="col">{t('numbers.provenance.col.resolution')}</th>
              <th scope="col">{t('numbers.provenance.col.route')}</th>
              <th scope="col">{t('numbers.provenance.col.fetched_at')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr data-provenance-metric={row.metric} key={row.metric}>
                <td>{row.metric}</td>
                <td>{t(row.label)}</td>
                <td>
                  {provenanceValue(row)}
                </td>
                <td>{row.unit}</td>
                <td><BasisChip basis={row.basis} /></td>
                <td>{row.as_of ?? t('numbers.as_of_none')}</td>
                <td>{row.source}</td>
                <td>{row.resolution}</td>
                <td>{row.route}</td>
                <td>{row.fetched_at ?? t('numbers.no_value')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Block 6, F-13 and R-39/R-40: the counter evidence card.
 *
 * One line per scenario with the falsifier that would prove it wrong and the current value of its
 * metric from the payload, its basis label and its date; or R-40's abstention when the scenario
 * carries none. The completeness count is measured from the scenarios on screen and reports
 * `not verified` while any of them lacks one, because the content is CO-B6-02.
 */
export function CounterEvidenceCard({
  scenarios,
  payload,
  fieldId,
}: {
  scenarios: readonly FalsifiableScenario[]
  payload: NumbersPayload
  fieldId: string | null
}) {
  const completeness = falsifierCompleteness(scenarios)
  return (
    <section className="numbers-card numbers-counter" aria-labelledby="numbers-counter-heading">
      <h3 id="numbers-counter-heading">{t('numbers.counter.heading')}</h3>
      {scenarios.length === 0 ? (
        <p className="numbers-empty">{t('numbers.counter.empty')}</p>
      ) : (
        <ul className="numbers-counter-list">
          {scenarios.map((scenario, index) => {
            const raw = (scenario as { falsifier?: unknown }).falsifier
            const reading = falsifierReading(falsifierOf(raw), payload)
            const id = typeof scenario.id === 'string' && scenario.id !== '' ? scenario.id : `scenario-${index + 1}`
            return (
              <li data-counter-scenario={id} key={id}>
                <span className="numbers-counter-name">{t(translationKeyFor(typeof scenario.name === 'string' ? scenario.name : '') ?? `scenarios.name.${id}`)}</span>
                <span className="numbers-counter-text">
                  {reading === null
                    ? t('scenarios.no_counter_evidence')
                    : `${t(reading.falsifier.text_key)} ${t('scenarios.falsifier_reading', {
                      value: String(reading.value),
                      unit: reading.unit,
                      basis: t(`evidence.basis_${reading.basis}`),
                      as_of: reading.asOf ?? t('numbers.as_of_none'),
                    })}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="numbers-counter-count" data-counter-status={completeness.status}>
        {t('numbers.counter.count', {
          with_falsifier: String(completeness.withFalsifier),
          total: String(completeness.total),
          status: t(completeness.status === 'passed' ? 'numbers.counter.status_passed' : 'numbers.counter.status_not_verified'),
        })}
      </p>
      {fieldId === null ? null : <p className="numbers-counter-field">{fieldId}</p>}
    </section>
  )
}

function GapRegister({ gaps }: { gaps: NumbersPayload['gaps'] }) {
  return (
    <section className="numbers-gaps" aria-labelledby="numbers-gaps-heading">
      <h3 id="numbers-gaps-heading">{t('numbers.gaps.heading')}</h3>
      {gaps.length === 0 ? (
        <p className="numbers-gaps-empty">{t('numbers.gaps.empty')}</p>
      ) : (
        <div className="numbers-scroll-x">
          <table className="numbers-table numbers-gap-table">
            <thead>
              <tr>
                <th scope="col">{t('numbers.gaps.col.section')}</th>
                <th scope="col">{t('numbers.gaps.col.cause')}</th>
                <th scope="col">{t('numbers.gaps.col.source')}</th>
                <th scope="col">{t('numbers.gaps.col.status')}</th>
                <th scope="col">{t('numbers.gaps.col.date')}</th>
                <th scope="col">{t('numbers.gaps.col.remediation')}</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((gap, index) => (
                <tr data-gap-index={index} key={`${gap.section}-${index}`}>
                  <td>{gap.section}</td>
                  <td>{gap.cause}</td>
                  <td>{gap.source}</td>
                  <td>{gap.status}</td>
                  <td>{gap.date}</td>
                  <td>{gap.remediation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function NumbersView({ selectedField, scenarios = [] }: NumbersViewProps) {
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonRaw = useMapStore((state) => state.polygonRaw)
  const polygonMode = useMapStore((state) => state.polygonMode)
  const polygonRing = useMapStore((state) => state.polygonRing)
  const chosenDate = useMapStore(chosenDateOf)
  const setNumbersLastRead = useMapStore((state) => state.setNumbersLastRead)
  const region = regionAdapter(regionId)
  const [load, setLoad] = useState<Load>({ kind: 'idle' })


  const isPolygon = selectedPolygonId !== null
  const fieldId: string | null = isPolygon
    ? commandFieldId(region, selectedPolygonId)
    : selectedField?.id ?? null

  // The request of Table B: a fixture field sends its own boundary and centre, a polygon sends
  // the outline the map rendered and an interior point of it. The area is null for both, because
  // the route takes the hectares from the polygon the client reports only when it has them.
  const request: Request | 'ring_missing' | 'waiting' | null = useMemo(() => {
    if (fieldId === null) return null
    if (isPolygon) {
      if (polygonRing === null) return 'ring_missing'
      const centre = interiorPoint(polygonRing)
      if (centre === null) return 'ring_missing'
      return {
        fieldId,
        body: {
          ring: polygonRing,
          centroid: centre,
          area_ha: null,
          date: chosenDate,
        },
      }
    }
    if (selectedField === null) return null
    return {
      fieldId: selectedField.id,
      body: {
        ring: selectedField.boundary.coordinates[0] as [number, number][],
        centroid: selectedField.center,
        area_ha: null,
        date: chosenDate,
      },
    }
  }, [fieldId, isPolygon, polygonRing, region, selectedField, chosenDate])

  const requestKey = typeof request === 'object' && request !== null
    ? JSON.stringify([request.fieldId, request.body])
    : ''

  // R-06: the request depends on the field, the ring and the date only. A resize changes none of
  // them, so it issues no new request.
  useEffect(() => {
    if (typeof request !== 'object' || request === null) return
    const controller = new AbortController()
    const key = numbersLastReadKey(request.fieldId, request.body.date)
    setLoad({ kind: 'loading' })
    fetchNumbers(request.fieldId, request.body, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return
        setNumbersLastRead(key, payload)
        setLoad({ kind: 'ok', payload })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (reason instanceof NumbersHttpError) {
          setLoad({ kind: 'error', status: reason.status })
          return
        }
        if (reason instanceof NumbersNetworkError || reason instanceof TypeError) {
          // R-48: the values held for this field and window, marked `last read`, or nothing.
          const held = useMapStore.getState().numbersLastRead[key]
          setLoad(held ? { kind: 'held', payload: held } : { kind: 'offline' })
          return
        }
        setLoad({ kind: 'offline' })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by requestKey, the serialised request
  }, [requestKey])

  const payload = load.kind === 'ok' || load.kind === 'held' ? load.payload : null
  const rows = useMemo(() => {
    const map = new Map<string, ProvenanceRow>()
    for (const row of payload?.provenance ?? []) map.set(row.metric, row)
    return map
  }, [payload])
  const areaRow = rows.get('area')
  const ringRow = rows.get('ring_area')

  // R-03: the class and the area of a polygon are block 5's own readout values; a fixture field
  // has no block 5 source, so both rows print their absence text, never a number.
  const readout = isPolygon
    ? readoutRows({
      region,
      selected: true,
      raw: polygonRaw,
      date: chosenDate,
      classSource: polygonMode?.classSource ?? null,
    }).rows
    : []
  const classText = isPolygon ? (readout.find((row) => row.key === 'class')?.value ?? '') : t('numbers.header.no_class_source')
  const areaText = isPolygon ? (readout.find((row) => row.key === 'area')?.value ?? '') : t('numbers.header.no_area_source')
  const window = printedWindow(payload?.query.window)

  let body: ReactNode
  if (fieldId === null) {
    body = <p className="numbers-empty">{t('numbers.no_field')}</p>
  } else if (request === 'ring_missing') {
    body = <p className="numbers-abstain">{t('numbers.header.polygon_ring_missing')}</p>
  } else if (load.kind === 'idle' || load.kind === 'loading') {
    body = <p className="numbers-loading">{t('numbers.loading')}</p>
  } else if (load.kind === 'error') {
    body = <p className="error-notice numbers-error" role="alert">{t('numbers.request_failed', { status: load.status })}</p>
  } else if (load.kind === 'offline') {
    body = (
      <>
        <p className="error-notice numbers-error" role="alert">{t('numbers.request_offline')}</p>
        <p className="numbers-abstain">{t('numbers.no_held_value')}</p>
      </>
    )
  } else if (payload !== null) {
    const s = payload.sections
    body = (
      <>
        {load.kind === 'held' && (
          <>
            <p className="error-notice numbers-error" role="alert">{t('numbers.request_offline')}</p>
            <p className="numbers-last-read">{t('numbers.last_read', { date: dateOf(s.climate.fetched_at) })}</p>
          </>
        )}
        <div className="numbers-cards">
          <ClimateCard climate={s.climate} window={payload.query.window} gaps={payload.gaps} />
          <WaterCard water={s.water_balance} gaps={payload.gaps} />
          <SmapCard smap={s.smap} gaps={payload.gaps} />
          <NdviCard ndvi={s.ndvi} gaps={payload.gaps} />
          <SoilCard soil={s.soil} />
          <RotationCard rotation={s.rotation} />
          <MunicipalCard municipal={s.municipality} gaps={payload.gaps} />
          <CounterEvidenceCard fieldId={payload.field_id} payload={payload} scenarios={scenarios} />
        </div>
        <ProvenanceTable rows={payload.provenance} />
        <GapRegister gaps={[...payload.gaps, ...falsifierGaps(scenarios, payload.field_id, payload.query.date)]} />
      </>
    )
  } else {
    body = null
  }

  // R-08: the row map covers the whole surface, header included, so the header's `area` and
  // `ring_area` cells read the same provenance rows as the cards.
  return (
    <RowsContext.Provider value={rows}>
      {/* Block 5.5, W4: the panel body. The landmark and the level two heading are the host's
          (block 6 revision 5 R-05), the full viewport shell and `Back to map` are gone. */}
      <div className="numbers-panel" data-numbers-view>
        <header className="numbers-header">
          <div className="numbers-title-block">
            {fieldId !== null && <span className="numbers-field-id">{fieldId}</span>}
          </div>
          {fieldId !== null && (
            <dl className="numbers-header-facts">
              <div className="numbers-header-fact">
                <dt>{t('numbers.header.class')}</dt>
                <dd>
                  <span>{classText}</span>
                  {isPolygon && <BasisChip basis={region.basis} />}
                </dd>
              </div>
              <div className="numbers-header-fact numbers-header-fact-area">
                <dt>{t('numbers.header.area')}</dt>
                <dd>
                  {/* R-07: the area row prints here, as block 5's value or as its abstention, with its id. */}
                  <span
                    className={areaRow?.value === null ? 'numbers-abstain' : undefined}
                    data-metric={areaRow ? 'area' : undefined}
                  >
                    {areaText}
                  </span>
                  {isPolygon && <BasisChip basis={region.basis} />}
                  {/* R-07: the ring's spherical hectares are the header row `ring_area`; it prints its own
                      number and basis in the same fact, so R-03's four header values keep their places. */}
                  {ringRow && (
                    <span className="numbers-header-ring">
                      <span className="numbers-header-ring-label">{t('numbers.ring_area')}</span>
                      <Printed
                        metric="ring_area"
                        value={typeof ringRow.value === 'number' ? ringRow.value : null}
                        abstain={t('numbers.no_value')}
                      />
                    </span>
                  )}
                </dd>
              </div>
              <div className="numbers-header-fact">
                <dt>{t('numbers.header.date')}</dt>
                <dd>
                  <span>{chosenDate}</span>
                  <BasisChip basis="entered" />
                </dd>
              </div>
              <div className="numbers-header-fact">
                <dt>{t('numbers.header.window')}</dt>
                <dd>
                  {window ? <span>{t('numbers.header.window_value', { start: window.start, end: window.end })}</span> : <span>{t('numbers.no_value')}</span>}
                  <BasisChip basis="modelled" />
                </dd>
              </div>
            </dl>
          )}
        </header>
        <div className="numbers-body">{body}</div>
      </div>
    </RowsContext.Provider>
  )
}
