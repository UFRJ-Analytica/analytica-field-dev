import { useState } from 'react'
import { en } from '@/strings/en'
import { t, translationKeyFor } from '@/strings'
import { useMapStore, chosenDateOf } from '@/lib/map-store'
import { falsifierOf, falsifierValue, type Falsifier } from '@/lib/falsifier'
import { numbersLastReadKey } from '@/lib/numbers-api'
import type { NumbersPayload } from '@/lib/numbers'
import { CropHistoryBars } from './CropHistoryBars'
import { SMAP_SCALE_MAX, SmapBar } from './SmapBar'
import type { EvidenceRow, RotationScenario } from './ScenarioCards'

const SMAP_LAYER = en['evidence.layer.smap']
const CROP_HISTORY_LAYER = en['evidence.layer.crop_history']

function rowFor(rows: EvidenceRow[], layer: string): EvidenceRow | undefined {
  return rows.find((row) => row.layer === layer)
}

function scenarioHeading(scenario: RotationScenario): string {
  return t(translationKeyFor(scenario.name) ?? `scenarios.name.${scenario.id}`)
}

/**
 * R-39 and R-40: the Falsifier slot. A scenario with no falsifier prints the R-40 text. A
 * falsifier prints its threshold sentence with the current value of its metric from the payload
 * of the same field, or the text that the value is not read, or no sentence when the payload has
 * no row for the metric.
 */
function FalsifierSlot({ falsifier, payload }: { falsifier: Falsifier | null; payload: NumbersPayload | null }) {
  if (falsifier === null) return <dd>{t('scenarios.no_counter_evidence')}</dd>
  const value = falsifierValue(falsifier, payload)
  if (value.status === 'no_row') {
    return <dd>{t('scenarios.falsifier.no_row', { metric: value.metric })}</dd>
  }
  const labelled = Object.prototype.hasOwnProperty.call(en, falsifier.text_key)
  const metric = labelled ? t(falsifier.text_key) : falsifier.metric
  return (
    <dd>
      <span>
        {t('scenarios.falsifier.text', {
          metric,
          operator: falsifier.operator,
          threshold: String(falsifier.threshold),
          unit: falsifier.unit,
        })}
      </span>{' '}
      {value.status === 'value' ? (
        <span>
          {t('scenarios.falsifier.value', {
            value: value.value,
            unit: value.unit,
            basis: t(`evidence.basis_${value.basis}`),
            as_of: value.asOf ?? t('numbers.as_of_none'),
          })}
        </span>
      ) : (
        <span>{t('scenarios.falsifier.not_read')}</span>
      )}
    </dd>
  )
}

export function RotationFlipCard({ scenario }: { scenario: RotationScenario }) {
  const [showsCharts, setShowsCharts] = useState(false)
  const heading = scenarioHeading(scenario)
  const bodyId = `scenario-body-${scenario.id}`
  const smap = rowFor(scenario.evidence_rows, SMAP_LAYER)
  const cropHistory = rowFor(scenario.evidence_rows, CROP_HISTORY_LAYER)
  const falsifier = falsifierOf(scenario)
  // R-39: the current value is the payload of the same field and date, as the numbers surface holds it.
  const payload = useMapStore((state) => (state.selectedFieldId === null
    ? null
    : state.numbersLastRead[numbersLastReadKey(state.selectedFieldId, chosenDateOf(state))] ?? null))
  const kicker = scenario.is_current
    ? t('scenarios.current_sequence')
    : t('scenarios.option', { crops: scenario.crops.map((crop) => t(`common.crop.${crop.toLowerCase()}`)).join(' / ') })
  // R-18: the accessible name states the face currently on screen, not the destination.
  // The front face shows the charts, the back face shows the details.
  const flipName = showsCharts
    ? t('visual.flip_details', { scenario: heading })
    : t('visual.flip_charts', { scenario: heading })

  return (
    <li
      className={`scenario-card rotation-card${scenario.is_current ? ' is-current' : ''}`}
      role="option"
      aria-selected={scenario.is_current}
      aria-current={scenario.is_current ? 'true' : undefined}
    >
      <div className="scenario-card-heading">
        <div>
          <span className="scenario-kicker">{kicker}</span>
          <h3>{heading}</h3>
        </div>
        <div className="card-heading-actions">
          {scenario.is_current ? <span className="current-badge">{t('scenarios.current_badge')}</span> : null}
        </div>
      </div>
      <div className="flip-face" id={bodyId} data-face={showsCharts ? 'back' : 'front'}>
        {/* The card body is the flip control: one transparent button, no visible label. */}
        <button
          type="button"
          className="flip-overlay"
          aria-expanded={showsCharts}
          aria-controls={bodyId}
          aria-label={flipName}
          onClick={() => setShowsCharts((open) => !open)}
        />
        {showsCharts ? (
          <dl className="scenario-facts">
            <div><dt>{t('scenarios.why')}</dt><dd>{t(translationKeyFor(scenario.why) ?? `scenarios.fixture.${scenario.id}.why`)}</dd></div>
            <div><dt>{t('scenarios.evidence')}</dt><dd>{t(translationKeyFor(scenario.evidence) ?? `scenarios.fixture.${scenario.id}.evidence`)}</dd></div>
            <div><dt>{t('scenarios.benefit')}</dt><dd>{t(translationKeyFor(scenario.benefit) ?? `scenarios.fixture.${scenario.id}.benefit`)}</dd></div>
            <div><dt>{t('scenarios.falsifier')}</dt><FalsifierSlot falsifier={falsifier} payload={payload} /></div>
            <div><dt>{t('scenarios.gap')}</dt><dd>{t(translationKeyFor(scenario.gap) ?? `scenarios.fixture.${scenario.id}.gap`)}</dd></div>
            <div><dt>{t('scenarios.risk')}</dt><dd>{t(translationKeyFor(scenario.risk) ?? `scenarios.fixture.${scenario.id}.risk`)}</dd></div>
          </dl>
        ) : (
          <div className="flip-visuals">
            <SmapBar
              value={smap ? smap.value : undefined}
              basis={smap?.basis}
              asOf={smap?.as_of}
              scaleMax={SMAP_SCALE_MAX}
            />
            <CropHistoryBars crops={scenario.crops} basis={cropHistory?.basis} asOf={cropHistory?.as_of} />
          </div>
        )}
      </div>
    </li>
  )
}
