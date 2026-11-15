/**
 * Block 6 wave 3, R-39 and R-40: the falsifier of a rotation scenario, read from the scenario
 * object, and the current value of its metric from the numbers payload of the same field.
 * A falsifier with a key missing is no falsifier, and nothing here invents a threshold.
 */
import { formatMetric, type NumbersPayload } from './numbers'

export const FALSIFIER_OPERATORS = ['<', '<=', '>', '>='] as const
export type FalsifierOperator = (typeof FALSIFIER_OPERATORS)[number]

/** R-39: the five keys are all required. `text_key` names the catalog label of the metric. */
export type Falsifier = {
  metric: string
  operator: FalsifierOperator
  threshold: number
  unit: string
  text_key: string
}

export function readFalsifier(value: unknown): Falsifier | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.metric !== 'string' || candidate.metric === '') return null
  if (typeof candidate.operator !== 'string' || !(FALSIFIER_OPERATORS as readonly string[]).includes(candidate.operator)) {
    return null
  }
  if (typeof candidate.threshold !== 'number' || !Number.isFinite(candidate.threshold)) return null
  if (typeof candidate.unit !== 'string') return null
  if (typeof candidate.text_key !== 'string' || candidate.text_key === '') return null
  return {
    metric: candidate.metric,
    operator: candidate.operator as FalsifierOperator,
    threshold: candidate.threshold,
    unit: candidate.unit,
    text_key: candidate.text_key,
  }
}

/** The falsifier a scenario object carries, or null when it carries none or an incomplete one. */
export function falsifierOf(scenario: object): Falsifier | null {
  return readFalsifier((scenario as { falsifier?: unknown }).falsifier)
}

export type FalsifierValue =
  | { status: 'not_read' }
  | { status: 'no_row'; metric: string }
  | { status: 'value'; value: string; unit: string; basis: 'observed' | 'retrieved' | 'modelled' | 'entered'; asOf: string | null }

/**
 * The metric's current value from the payload of the same field: `not_read` when no payload is
 * held, `no_row` when the payload has no printable row for the metric (the falsifier is then not
 * printed), and the formatted value with its own unit, basis and date otherwise.
 */
export function falsifierValue(falsifier: Falsifier, payload: NumbersPayload | null): FalsifierValue {
  if (payload === null) return { status: 'not_read' }
  const row = payload.provenance.find((candidate) => candidate.metric === falsifier.metric)
  if (row === undefined || typeof row.value !== 'number') return { status: 'no_row', metric: falsifier.metric }
  return {
    status: 'value',
    value: formatMetric(row.metric, row.value),
    unit: row.unit,
    basis: row.basis,
    asOf: row.as_of,
  }
}
