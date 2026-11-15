import { useState } from 'react'
import { en } from '@/strings/en'
import { t, translationKeyFor } from '@/strings'
import { CropHistoryBars } from './CropHistoryBars'
import { SMAP_SCALE_MAX, SmapBar } from './SmapBar'
import type { EvidenceRow, RotationScenario } from './ScenarioCards'
import { falsifierOf, falsifierReading } from '@/lib/falsifier'
import { chosenDateOf, useMapStore } from '@/lib/map-store'
import { numbersLastReadKey } from '@/lib/numbers-api'

const SMAP_LAYER = en['evidence.layer.smap']
const CROP_HISTORY_LAYER = en['evidence.layer.crop_history']

function rowFor(rows: EvidenceRow[], layer: string): EvidenceRow | undefined {
  return rows.find((row) => row.layer === layer)
}

function scenarioHeading(scenario: RotationScenario): string {
  return t(translationKeyFor(scenario.name) ?? `scenarios.name.${scenario.id}`)
}

export function RotationFlipCard({ scenario }: { scenario: RotationScenario }) {
  const [showsCharts, setShowsCharts] = useState(false)
  const heading = scenarioHeading(scenario)
  const bodyId = `scenario-body-${scenario.id}`
  const smap = rowFor(scenario.evidence_rows, SMAP_LAYER)
  const cropHistory = rowFor(scenario.evidence_rows, CROP_HISTORY_LAYER)
  // R-39: the falsifier comes from the scenario object the card already receives, and its current
  // value, basis label and date come from the numbers payload of the same field, which the surface
  // keeps per field and window (R-48). A falsifier whose metric has no row there is not printed.
  const payload = useMapStore((state) => (
    state.selectedFieldId === null
      ? null
      : state.numbersLastRead[numbersLastReadKey(state.selectedFieldId, chosenDateOf(state))] ?? null
  ))
  const reading = falsifierReading(falsifierOf((scenario as { falsifier?: unknown }).falsifier), payload)
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
            {/* R-39 and R-40: the sixth field, immediately after Benefit. A scenario with no
                falsifier, or with a falsifier whose metric the payload does not hold, prints the
                abstention of R-40 rather than a blank or a threshold beside no value. */}
            <div data-falsifier={reading === null ? 'absent' : reading.falsifier.metric}>
              <dt>{t('scenarios.falsifier')}</dt>
              <dd>
                {reading === null
                  ? t('scenarios.no_counter_evidence')
                  : (
                    <>
                      {t(reading.falsifier.text_key)}
                      <span className="falsifier-reading">
                        {' '}
                        {t('scenarios.falsifier_reading', {
                          value: String(reading.value),
                          unit: reading.unit,
                          basis: t(`evidence.basis_${reading.basis}`),
                          as_of: reading.asOf ?? t('numbers.as_of_none'),
                        })}
                      </span>
                    </>
                  )}
              </dd>
            </div>
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
