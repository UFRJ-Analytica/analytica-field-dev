/**
 * Field Shift AI, milestone 2: the client of the experimental agent routes
 * (`/experimental/field-shift-ai/status` and `/chat`, backend/field_shift_agent/routes.py).
 *
 * The request carries only what the agent needs: the field id, the locale, the question, the date and,
 * for a polygon, its ring and interior point. No other map state is sent.
 */
import { NUMBERS_API_BASE } from '@/lib/numbers-api'
import type { Locale } from '@/strings'
import type { Evidence, LimitationCode } from './types'

export type AgentSegment = { t: 'text' | 'value' | 'period'; text?: string | null; evidence?: string | null }

export type AgentEvidence = Evidence & { fieldId: string }

export type AgentChatResponse = {
  status: 'answered' | 'partial' | 'unavailable' | 'fallback'
  locale: Locale
  field_id: string
  mode: 'agent' | 'fallback'
  answer: AgentSegment[][]
  evidence: AgentEvidence[]
  limitations: LimitationCode[]
  tools_used: string[]
  errors: string[]
  fallback_reason: string | null
}

export type AgentChatRequest = {
  field_id: string
  locale: Locale
  question: string
  date: string
  ring?: [number, number][]
  centroid?: [number, number]
  area_ha?: number | null
}

export type AgentStatus = { experimental: boolean; llm_enabled: boolean; provider: string | null; mode: string }

export class AgentHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

const BASE = () => `${NUMBERS_API_BASE}/experimental/field-shift-ai`

export async function fetchAgentStatus(options: { signal?: AbortSignal } = {}): Promise<AgentStatus> {
  const response = await fetch(`${BASE()}/status`, { signal: options.signal })
  if (!response.ok) throw new AgentHttpError(response.status)
  return (await response.json()) as AgentStatus
}

export async function postAgentChat(body: AgentChatRequest, options: { signal?: AbortSignal } = {}): Promise<AgentChatResponse> {
  const response = await fetch(`${BASE()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!response.ok) throw new AgentHttpError(response.status)
  return (await response.json()) as AgentChatResponse
}

/**
 * The client-side half of the field check: an answer is shown only for the field it was asked about,
 * and only if every evidence item it carries belongs to that field.
 */
export function belongsTo(response: AgentChatResponse, fieldId: string): boolean {
  return response.field_id === fieldId && response.evidence.every((item) => item.fieldId === fieldId)
}
