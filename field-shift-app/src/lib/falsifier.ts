/**
 * Block 6, R-39 and R-40: the counter evidence of a rotation scenario.
 *
 * A scenario's `falsifier` is the rule that would prove it wrong: a metric of Table A, an operator,
 * a threshold in that metric's unit and the catalog sentence that states the rule. All five keys are
 * required (R-39); a falsifier missing any of them is not a falsifier and takes R-40's path, which
 * prints `No counter evidence recorded` instead of a blank and records the scenario in the gap
 * register.
 *
 * The current value of the metric, its unit, its basis label and its date come from the numbers
 * payload of the same field, never from the fixture: the payload's provenance row for that metric is
 * the one place the value and its three facts live together (Table A). A falsifier whose metric has
 * no row in the payload is not printed (R-39), so a card can never show a threshold beside a value
 * the payload does not hold.
 */
import type { GapRow, NumbersPayload, ProvenanceRow } from './numbers'

export const FALSIFIER_OPERATORS = ['<', '<=', '>', '>='] as const

export type FalsifierOperator = (typeof FALSIFIER_OPERATORS)[number]

export type Falsifier = {
  metric: string
  operator: FalsifierOperator
  threshold: number
  unit: string
  text_key: string
}

/** The shape of a scenario as the counter evidence card reads it: an id, a name and a falsifier. */
export type FalsifiableScenario = {
  id?: unknown
  name?: unknown
  falsifier?: unknown
}

/** R-39: the five keys, all required, and the operator one of the four. */
export function falsifierOf(raw: unknown): Falsifier | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const metric = typeof value.metric === 'string' ? value.metric.trim() : ''
  const operator = value.operator
  const threshold = value.threshold
  const unit = typeof value.unit === 'string' ? value.unit.trim() : ''
  const textKey = typeof value.text_key === 'string' ? value.text_key.trim() : ''
  if (metric === '' || unit === '' || textKey === '') return null
  if (typeof operator !== 'string' || !(FALSIFIER_OPERATORS as readonly string[]).includes(operator)) return null
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null
  return { metric, operator: operator as FalsifierOperator, threshold, unit, text_key: textKey }
}

/** R-39: the payload row that holds the metric's value, its basis label and its date. */
export function metricRowOf(payload: NumbersPayload | null | undefined, metric: string): ProvenanceRow | null {
  if (!payload || !Array.isArray(payload.provenance)) return null
  return payload.provenance.find((row) => row.metric === metric) ?? null
}

export type FalsifierReading = {
  falsifier: Falsifier
  row: ProvenanceRow
  value: number | string
  unit: string
  basis: ProvenanceRow['basis']
  asOf: string | null
}

/**
 * R-39: the value of the metric, with its own basis label and date. Null when there is no payload,
 * when the payload holds no row for the metric, or when the row holds no value, which is the case in
 * which the card prints the abstention rather than a threshold beside nothing.
 */
export function falsifierReading(falsifier: Falsifier | null, payload: NumbersPayload | null | undefined): FalsifierReading | null {
  if (falsifier === null) return null
  const row = metricRowOf(payload, falsifier.metric)
  if (row === null) return null
  if (row.value === null || typeof row.value === 'object') return null
  return {
    falsifier,
    row,
    value: row.value,
    unit: row.unit === '' ? falsifier.unit : row.unit,
    basis: row.basis,
    asOf: row.as_of,
  }
}

export type FalsifierCompleteness = {
  /** Every scenario the fixture response carries. */
  total: number
  /** The scenarios whose `falsifier` carries all five keys of R-39. */
  withFalsifier: number
  /** The scenario ids that carry none, or carry one that is missing a key. */
  missing: string[]
  /** AC-39: passed only when every scenario carries a falsifier. */
  status: 'passed' | 'not verified'
}

/**
 * AC-39: the completeness count of the fixture scenarios. The content is CO-B6-02, which has not
 * landed, so this reports `not verified` with the count it measured rather than a pass, and the count
 * is derived from the scenarios on screen, never written down as nine.
 */
export function falsifierCompleteness(scenarios: ReadonlyArray<{ id?: unknown; falsifier?: unknown }>): FalsifierCompleteness {
  const entries = scenarios.map((scenario, index) => ({
    id: typeof scenario.id === 'string' && scenario.id !== '' ? scenario.id : `scenario-${index + 1}`,
    ok: falsifierOf(scenario.falsifier) !== null,
  }))
  const missing = entries.filter((entry) => !entry.ok).map((entry) => entry.id)
  return {
    total: entries.length,
    withFalsifier: entries.length - missing.length,
    missing,
    status: entries.length > 0 && missing.length === 0 ? 'passed' : 'not verified',
  }
}

/**
 * R-40: one gap row per scenario without a counter evidence, carrying the scenario id and the field
 * id so a reader can tell which of the two is missing what.
 */
export function falsifierGaps(
  scenarios: ReadonlyArray<{ id?: unknown; falsifier?: unknown }>,
  fieldId: string | null,
  date: string,
): GapRow[] {
  return scenarios
    .filter((scenario) => falsifierOf(scenario.falsifier) === null)
    .map((scenario, index) => {
      const scenarioId = typeof scenario.id === 'string' && scenario.id !== '' ? scenario.id : `scenario-${index + 1}`
      return {
        section: 'counter_evidence',
        cause: `scenario ${scenarioId} of field ${fieldId ?? 'unknown'} carries no falsifier`,
        source: 'CO-B6-02',
        status: 'missing',
        date,
        remediation: 'CO-B6-02',
      } satisfies GapRow
    })
}
