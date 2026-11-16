/**
 * Glue between the Geospatial Agent Tools and the panel: which answers a command asks for once its
 * steps have run. An analysis becomes one of the deterministic intents, rendered from the context the
 * map is in after the steps, so every number still comes from block 6 evidence.
 */
import { classifyIntent } from './answers'
import type { MapToolResult, MetricVar } from './map-tools'
import type { Intent } from './types'

export type PlannedAnalysis = { intent: Intent; metrics?: MetricVar[]; question?: string }

export type PlanTurn = {
  mode: 'deterministic' | 'agent'
  results: MapToolResult[]
  /** Clauses that were neither a command nor a question the answers know. */
  unmatched: string[]
  /** Clauses that were not commands but are questions the deterministic answers know. */
  questions: string[]
}

/** Splits the clauses a plan did not act on into known questions and text it did not understand. */
export function splitUnmatched(clauses: string[]): { questions: string[]; unmatched: string[] } {
  const questions = clauses.filter((c) => classifyIntent(c) !== 'unsupported')
  return { questions, unmatched: clauses.filter((c) => !questions.includes(c)) }
}

function intentForQuery(metrics: MetricVar[]): Intent {
  if (metrics.includes('water_risk')) return 'water_risk'
  if (metrics.length === 1 && metrics[0] === 'rain') return 'rainfall'
  return 'environment'
}

/** The answers of a plan: one per successful analysis step, plus questions the plan did not act on. */
export function analysesOf(plan: PlanTurn): PlannedAnalysis[] {
  const out: PlannedAnalysis[] = []
  for (const result of plan.results) {
    if (result.status !== 'success' || !result.analysis) continue
    const { kind, metrics } = result.analysis
    out.push(kind === 'compare' ? { intent: 'compare', metrics } : { intent: intentForQuery(metrics), metrics })
  }
  for (const clause of plan.questions) out.push({ intent: classifyIntent(clause), question: clause })
  return out
}

/** The variable a plan was last about, for a follow-up such as "and how does that compare to ...". */
export function topicOf(plan: PlanTurn, previous: MetricVar | null): MetricVar | null {
  let topic = previous
  for (const result of plan.results) {
    const metrics = result.analysis?.metrics.filter((m) => m === 'rain' || m === 'soil_moisture' || m === 'temperature')
    if (result.status === 'success' && metrics && metrics.length > 0) topic = metrics[metrics.length - 1]
  }
  return topic
}
