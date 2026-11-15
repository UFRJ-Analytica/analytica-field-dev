/**
 * Block 6: the `Field numbers` region (R-01 to R-06, R-07 to R-13, R-21 to R-25, R-30, R-41,
 * R-42, R-44). It is a full viewport view that the App mounts as a sibling of the map screen,
 * while the map screen is `display: none` (R-02). It prints what the payload says and nothing
 * else: every printed number reads its basis from its own provenance row (R-08, R-09).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { fetchPolygonArea, readoutRows, type SidecarArea } from '@/lib/polygon-readout'
import { commandFieldId } from '@/lib/polygon-selection'
import { regionAdapter } from '@/lib/regions'
import {
  familyOf,
  formatMetric,
  interiorPoint,
  METRICS,
  type ClimateSection,
  type CropYear,
  type GapRow,
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
import {
  CDL_PRODUCT,
  cdlHistory,
  FIRST_CROP_PRODUCT,
  FIRST_CROP_YEARS,
  historyRows,
  SECOND_CROP_PRODUCT,
  SECOND_CROP_STATES,
  SECOND_CROP_YEARS,
  usCdlNameOf,
  type HistoryRow,
  type SidecarEntry,
} from '@/lib/rotation'
import { falsifierOf } from '@/lib/falsifier'
import { t } from '@/strings'
import type { RotationScenario } from './ScenarioCards'
import './NumbersView.css'

export const NUMBERS_VIEW_ATTR = 'data-numbers-view'

type NumbersViewProps = {
  selectedField: FieldSummary | null
  onClose: () => void
  /** The rotation scenarios of the selected field, for the counter evidence gaps (R-40). */
  scenarios?: RotationScenario[]
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
  resolution?: string
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
 */
const CHART_W = 640
const PANEL_H = 120
const PAD_L = 40
const PAD_R = 12
const PAD_T = 14
const PAD_B = 18

function ClimateChart({ series }: { series: ClimateSection['series'] }) {
  const n = Math.max(series.rain.length, series.tmax.length, series.tmin.length)
  if (n === 0) return <p className="numbers-abstain">{t('numbers.chart.no_points')}</p>
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i * (CHART_W - PAD_L - PAD_R)) / (n - 1))
  const rainValues = series.rain.flatMap((p) => (p.value === null ? [] : [p.value]))
  const rainMax = Math.max(10, ...rainValues)
  const yRain = (v: number) => PANEL_H - PAD_B - (v / rainMax) * (PANEL_H - PAD_T - PAD_B)
  const tempValues = [...series.tmax, ...series.tmin].flatMap((p) => (p.value === null ? [] : [p.value]))
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
      <g className="numbers-chart-rain" data-metric="rain_day" data-points={series.rain.filter((p) => p.value !== null).length}>
        {points(series.rain, yRain)}
      </g>
      <g className="numbers-chart-tmax" data-metric="tmax_day" data-points={series.tmax.filter((p) => p.value !== null).length}>
        {segments(series.tmax, yTemp)}
        {points(series.tmax, yTemp)}
      </g>
      <g className="numbers-chart-tmin" data-metric="tmin_day" data-points={series.tmin.filter((p) => p.value !== null).length}>
        {segments(series.tmin, yTemp)}
        {points(series.tmin, yTemp)}
      </g>
    </svg>
  )
}

function ClimateCard({ climate, window }: { climate: ClimateSection; window: NumbersPayload['query']['window'] }) {
  const aggregates: Array<keyof ClimateSection['aggregates']> = [
    'rain_total',
    'dry_spell_days',
    'gdd10',
    'frost_days',
    'tmin_min',
    'gwetroot_mean',
  ]
  const normals: Array<{ key: keyof ClimateSection['normals']; metric: string }> = [
    { key: 'rain_median', metric: 'rain_median' },
    { key: 'rain_min', metric: 'rain_min' },
    { key: 'rain_max', metric: 'rain_max' },
    { key: 'rank', metric: 'rain_rank' },
    { key: 'percentile', metric: 'rain_percentile' },
    { key: 'hot_days', metric: 'hot_days' },
    { key: 'hot_days_median', metric: 'hot_days_median' },
  ]
  const abstainAggregate = (key: keyof ClimateSection['aggregates']) => {
    const info = climate.aggregate_valid[key]
    if (!info) return t('numbers.abstain.climate', { error: climate.error ?? t('numbers.no_value') })
    return t('numbers.abstain.aggregate', {
      parameter: info.parameter,
      valid: info.valid,
      days: info.days,
      missing: info.days - info.valid,
    })
  }
  return (
    <Card
      id="climate"
      title={t('numbers.card.climate')}
      source={climate.source}
      asOf={climate.as_of}
      basis={climate.basis}
      resolution={climate.resolution}
    >
      <p className="numbers-window">
        {t('numbers.window_line', {
          start: window.start,
          end: window.end,
          valid: window.valid_days,
          days: window.days,
          dropped: window.dropped_days,
        })}
      </p>
      <p className="numbers-cell-statement">{t('numbers.climate.cell')}</p>
      <dl className="numbers-rows">
        {aggregates.map((key) => (
          <div className="numbers-row" key={key}>
            <dt>{t(`numbers.${key}`)}</dt>
            <dd>
              <Printed metric={key} value={climate.aggregates[key]} abstain={abstainAggregate(key)} />
            </dd>
          </div>
        ))}
      </dl>
      <ClimateChart series={climate.series} />
      <h4>{t('numbers.climate.normals_heading')}</h4>
      <p className="numbers-cell-statement">{t('numbers.climate.normals_statement')}</p>
      <dl className="numbers-rows">
        {normals.map(({ key, metric }) => (
          <div className="numbers-row" key={key}>
            <dt>{t(`numbers.${metric}`)}</dt>
            <dd>
              <Printed
                metric={metric}
                value={climate.normals[key]}
                abstain={t('numbers.abstain.normals', { reason: climate.normals_reason ?? t('numbers.no_value') })}
              />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function WaterCard({ water }: { water: NumbersPayload['sections']['water_balance'] }) {
  const missing = water.missing
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
      <p className="numbers-window">{t('numbers.water.window', { start: water.window.start, end: water.window.end, days: water.window.days })}</p>
      <p className="numbers-statement">{t('numbers.water.out_statement')}</p>
      <p className="numbers-statement">{t('numbers.water.statement')}</p>
    </Card>
  )
}

function SmapCard({ smap }: { smap: NumbersPayload['sections']['smap'] }) {
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
        <p className="numbers-abstain">{t('numbers.abstain.smap', { reason: smap.reason ?? t('numbers.no_value') })}</p>
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

function NdviCard({ ndvi }: { ndvi: NumbersPayload['sections']['ndvi'] }) {
  const plotted = ndvi.scenes.filter((scene) => scene.ndvi_mean !== null && !scene.partial)
  return (
    <Card id="ndvi" title={t('numbers.card.ndvi')} source={ndvi.source} asOf={ndvi.as_of} basis="retrieved">
      <p className="numbers-cell-statement">{t('numbers.ndvi.source')}</p>
      <dl className="numbers-rows">
        <div className="numbers-row">
          <dt>{t('numbers.ndvi_scene_count')}</dt>
          <dd><Printed metric="ndvi_scene_count" value={ndvi.scene_count} abstain={t('numbers.no_value')} /></dd>
        </div>
        <div className="numbers-row">
          <dt>{t('numbers.ndvi_clear_count')}</dt>
          <dd><Printed metric="ndvi_clear_count" value={ndvi.clear_count} abstain={t('numbers.no_value')} /></dd>
        </div>
      </dl>
      {plotted.length === 0 && <p className="numbers-abstain">{t('numbers.ndvi.none_plotted')}</p>}
      {ndvi.state !== 'ok' && (
        <p className="numbers-abstain">
          {t('numbers.abstain.ndvi', {
            scenes: ndvi.scene_count ?? t('numbers.no_value'),
            fraction: ndvi.best_valid_fraction ?? t('numbers.ndvi.best_fraction'),
          })}
        </p>
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

function SoilCard({ soil }: { soil: NumbersPayload['sections']['soil'] }) {
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

/** One printed class cell of a history row: a Table D name, `unmapped`, `not computed`, or `absent`. */
function ClassCell({ row }: { row: HistoryRow }) {
  const cell = row.cell
  if (cell.kind === 'named') {
    if (row.product === CDL_PRODUCT) return <span className="numbers-value">{cell.name}</span>
    const metric = row.product === SECOND_CROP_PRODUCT ? 'mb_second_crop' : 'mb_first_crop'
    return <PrintedText metric={`${metric}.${row.year}`} text={cell.name} />
  }
  if (cell.kind === 'unmapped') {
    return (
      <span className="numbers-abstain" data-class="unmapped">
        {t('numbers.rotation.unmapped', { code: row.code ?? t('numbers.no_value'), product: row.product })}
      </span>
    )
  }
  if (cell.kind === 'absent') {
    return <span className="numbers-abstain" data-class="absent">{t('polygon.no_cdl_class', { year: row.year })}</span>
  }
  return <span className="numbers-abstain" data-class="not_computed">{t('numbers.rotation.not_computed')}</span>
}

/** A year-by-year list. Each item carries its product beside its code (R-34) and its class cell. */
function HistoryList({ rows, history }: { rows: HistoryRow[]; history: 'first' | 'second' | 'cdl' }) {
  return (
    <ul className="numbers-years" data-history={history}>
      {rows.map((row) => (
        <li key={`${row.product}-${row.year}`} data-year={row.year} data-product={row.product} data-code={row.code ?? ''}>
          <span className="numbers-year">{t('numbers.rotation.year', { year: row.year })}</span>{' '}
          <span className="numbers-product">{row.product}</span>{' '}
          {row.code !== null && <span className="numbers-code">{t('numbers.rotation.code', { code: row.code })}</span>}{' '}
          <ClassCell row={row} />
        </li>
      ))}
    </ul>
  )
}

/** R-33: the years whose class is not computed, named once per product, so the gap names the missing class. */
function unresolvedSummary(rows: HistoryRow[], product: string): string | null {
  const count = rows.filter((row) => row.cell.kind === 'not_computed').length
  return count === 0 ? null : t('numbers.rotation.class_missing', { count, product })
}

function entriesOf(crops: CropYear[] | null): SidecarEntry[] {
  return (crops ?? []).map((entry) => ({ year: entry.year, product: entry.product, code: entry.code }))
}

/**
 * R-33 to R-36: the MapBiomas first and second crop history of the sidecar, one row per year it
 * carries, and the CDL history of a United States polygon from its own properties. A row with no
 * class abstains with its named cause; no row abstains with the R-36 gap. Nothing is filled in.
 */
function RotationCard({
  rotation,
  cdl,
}: {
  rotation: NumbersPayload['sections']['rotation']
  cdl: HistoryRow[] | null
}) {
  const first = historyRows(entriesOf(rotation.first_crop), FIRST_CROP_PRODUCT, FIRST_CROP_YEARS)
  const second = historyRows(entriesOf(rotation.second_crop), SECOND_CROP_PRODUCT, SECOND_CROP_YEARS)
  const unavailable = rotation.state === 'unavailable'
  const noMapBiomasRow = first.length === 0 && second.length === 0
  const firstSummary = unresolvedSummary(first, FIRST_CROP_PRODUCT)
  const secondSummary = unresolvedSummary(second, SECOND_CROP_PRODUCT)
  return (
    <Card id="rotation" title={t('numbers.card.rotation')} source={rotation.source} asOf={rotation.as_of} basis={rotation.basis}>
      <p className="numbers-provenance-line">
        {t('numbers.rotation.collection', { year: rotation.collection_year ?? t('numbers.no_value') })}
      </p>
      {unavailable && (
        <p className="numbers-abstain">{t('numbers.rotation.unavailable', { error: rotation.error ?? t('numbers.no_value') })}</p>
      )}
      {!unavailable && noMapBiomasRow && <p className="numbers-abstain">{t('numbers.rotation.no_row')}</p>}
      {first.length > 0 && (
        <>
          <h4>{t('numbers.rotation.first_crop')}</h4>
          <HistoryList rows={first} history="first" />
          {firstSummary && <p className="numbers-abstain">{firstSummary}</p>}
        </>
      )}
      {first.length === 0 && second.length > 0 && <p className="numbers-abstain">{t('numbers.rotation.first_no_row')}</p>}
      <h4>{t('numbers.rotation.second_crop')}</h4>
      <p className="numbers-cell-statement">{t('numbers.rotation.second_states', { states: SECOND_CROP_STATES.join(', ') })}</p>
      {rotation.second_crop_state_outside ? (
        <p className="numbers-abstain">{t('numbers.rotation.state_outside', { state: rotation.second_crop_state_outside })}</p>
      ) : second.length === 0 ? (
        <p className="numbers-abstain">{t('numbers.rotation.second_no_row')}</p>
      ) : (
        <>
          <HistoryList rows={second} history="second" />
          {secondSummary && <p className="numbers-abstain">{secondSummary}</p>}
        </>
      )}
      {cdl !== null && cdl.length > 0 && (
        <div className="numbers-cdl" data-cdl-block>
          <h4>
            {t('numbers.rotation.cdl_heading')} <BasisChip basis="retrieved" />
          </h4>
          <p className="numbers-cell-statement">{t('numbers.rotation.cdl_source')}</p>
          <HistoryList rows={cdl} history="cdl" />
        </div>
      )}
    </Card>
  )
}


function MunicipalCard({ municipal }: { municipal: NumbersPayload['sections']['municipality'] }) {
  return (
    <Card id="municipal" title={t('numbers.card.municipal')} source={municipal.source} asOf={municipal.as_of} basis="retrieved">
      {municipal.municipality ? (
        <dl className="numbers-rows">
          <div className="numbers-row">
            <dt>{t('numbers.municipal.municipality')}</dt>
            <dd>{municipal.municipality.name} ({municipal.municipality.code})</dd>
          </div>
          <div className="numbers-row">
            <dt>{t('numbers.municipal.soy_planted', { year: municipal.municipality.year })}</dt>
            <dd>
              <Printed
                metric="municipality_soy_ha"
                value={municipal.municipality.soy_ha}
                abstain={t('numbers.abstain.municipal', { reason: t('numbers.no_value') })}
              />
            </dd>
          </div>
        </dl>
      ) : (
        <p className="numbers-abstain">{t('numbers.abstain.municipal', { reason: municipal.reason ?? t('numbers.no_value') })}</p>
      )}
      {municipal.state_row && (
        <dl className="numbers-rows">
          <div className="numbers-row">
            <dt>
              {t('numbers.municipal.state')}, {t('numbers.municipal.soy_planted', { year: municipal.state_row.year })}
            </dt>
            <dd>
              <Printed metric="state_soy_ha" value={municipal.state_row.soy_ha} abstain={t('numbers.no_value')} />
              <span className="numbers-state-label">{t('numbers.municipal.state_label')}</span>
            </dd>
          </div>
        </dl>
      )}
      <div className="numbers-row">
        <dt>{t('numbers.municipal.share_label')}</dt>
        <dd>
          <Printed
            metric="polygon_share"
            value={municipal.share}
            abstain={t('numbers.abstain.share', { reason: municipal.reason ?? t('numbers.no_value') })}
          />
        </dd>
      </div>
    </Card>
  )
}

function ProvenanceTable({ rows }: { rows: ProvenanceRow[] }) {
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
                  {typeof row.value === 'number'
                    ? formatMetric(row.metric, row.value)
                    : (row.value ?? t('numbers.no_value'))}
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

export function NumbersView({ selectedField, onClose, scenarios = [] }: NumbersViewProps) {
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonRaw = useMapStore((state) => state.polygonRaw)
  const polygonMode = useMapStore((state) => state.polygonMode)
  const polygonRing = useMapStore((state) => state.polygonRing)
  const chosenDate = useMapStore(chosenDateOf)
  const setNumbersLastRead = useMapStore((state) => state.setNumbersLastRead)
  const region = regionAdapter(regionId)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const [sidecar, setSidecar] = useState<SidecarArea>({ status: 'idle' })
  const [load, setLoad] = useState<Load>({ kind: 'idle' })

  // R-05: focus moves to `Back to map` on open, and the control is a native button.
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  // Block 5's Brazil area is read from the sidecar for the selected polygon (R-25 of block 5).
  useEffect(() => {
    if (!region.areaFromSidecar || selectedPolygonId === null) {
      setSidecar({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setSidecar({ status: 'loading' })
    fetchPolygonArea(region, selectedPolygonId, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setSidecar(next)
    })
    return () => controller.abort()
  }, [region, selectedPolygonId])

  const isPolygon = selectedPolygonId !== null
  const fieldId: string | null = isPolygon
    ? commandFieldId(region, selectedPolygonId)
    : selectedField?.id ?? null

  // The request of Table B: a fixture field sends its own boundary and centre, a polygon sends
  // the outline the map rendered and an interior point of it. The area is null for a fixture and
  // for a United States polygon (its feature carries acres only), and the sidecar's hectares for
  // Brazil, which waits for the sidecar to answer.
  const request: Request | 'ring_missing' | 'waiting' | null = useMemo(() => {
    if (fieldId === null) return null
    if (isPolygon) {
      if (polygonRing === null) return 'ring_missing'
      const centre = interiorPoint(polygonRing)
      if (centre === null) return 'ring_missing'
      if (region.areaFromSidecar && (sidecar.status === 'idle' || sidecar.status === 'loading')) return 'waiting'
      return {
        fieldId,
        body: {
          ring: polygonRing,
          centroid: centre,
          area_ha: region.areaFromSidecar && sidecar.status === 'found' ? sidecar.areaHa : null,
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
  }, [fieldId, isPolygon, polygonRing, region, sidecar, selectedField, chosenDate])

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

  // R-03: the class and the area of a polygon are block 5's own readout values; a fixture field
  // has no block 5 source, so both rows print their absence text, never a number.
  const readout = isPolygon
    ? readoutRows({
      region,
      selected: true,
      raw: polygonRaw,
      date: chosenDate,
      classSource: polygonMode?.classSource ?? null,
      sidecar,
    }).rows
    : []
  const classText = isPolygon ? (readout.find((row) => row.key === 'class')?.value ?? '') : t('numbers.header.no_class_source')
  const areaText = isPolygon ? (readout.find((row) => row.key === 'area')?.value ?? '') : t('numbers.header.no_area_source')
  const window = payload?.query.window ?? null

  // R-33 to R-36: a United States polygon's CDL history is read from its own `cdl{Y}` properties.
  const cdl = isPolygon && regionId === 'us' && polygonRaw?.cdl !== undefined
    ? cdlHistory(polygonRaw.cdl, usCdlNameOf)
    : null

  // R-40: a scenario with no falsifier is a gap of the register, with its scenario id and field id.
  const counterGaps: GapRow[] = !isPolygon && selectedField !== null
    ? scenarios
      .filter((scenario) => falsifierOf(scenario) === null)
      .map((scenario) => ({
        section: 'counter evidence',
        cause: t('numbers.gaps.counter', { scenario: scenario.id, field: selectedField.id }),
        source: 'fixture rotation scenarios of the field (backend/fixtures/field-scenarios.json)',
        status: 'not recorded',
        date: chosenDate,
        remediation: 'CO-B6-02: record a falsifier for this scenario',
      }))
    : []

  let body: ReactNode
  if (fieldId === null) {
    body = <p className="numbers-empty">{t('numbers.no_field')}</p>
  } else if (request === 'ring_missing') {
    body = <p className="numbers-abstain">{t('numbers.header.polygon_ring_missing')}</p>
  } else if (request === 'waiting' || load.kind === 'idle' || load.kind === 'loading') {
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
        <RowsContext.Provider value={rows}>
          <div className="numbers-cards">
            <ClimateCard climate={s.climate} window={payload.query.window} />
            <WaterCard water={s.water_balance} />
            <SmapCard smap={s.smap} />
            <NdviCard ndvi={s.ndvi} />
            <SoilCard soil={s.soil} />
            <RotationCard rotation={s.rotation} cdl={cdl} />
            <MunicipalCard municipal={s.municipality} />
          </div>
          <ProvenanceTable rows={payload.provenance} />
          <GapRegister gaps={[...payload.gaps, ...counterGaps]} />
        </RowsContext.Provider>
      </>
    )
  } else {
    body = null
  }

  return (
    <section aria-labelledby="numbers-title" className="numbers-view" data-numbers-view role="region">
      <header className="numbers-header">
        <button className="numbers-back" onClick={onClose} ref={backRef} type="button">
          {t('numbers.back')}
        </button>
        <div className="numbers-title-block">
          <h2 id="numbers-title">{t('numbers.region')}</h2>
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
            <div className="numbers-header-fact">
              <dt>{t('numbers.header.area')}</dt>
              <dd>
                <span>{areaText}</span>
                {isPolygon && <BasisChip basis={region.basis} />}
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
    </section>
  )
}
