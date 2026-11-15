/**
 * Field Shift AI, milestone 2: the agent calls of the panel.
 *
 * - The status route is read once, when the panel first opens. With no model configured the panel
 *   never posts a question: the deterministic adapter answers at once and nothing waits on a network.
 * - Each question has its own AbortController. A change of field, date or ring aborts every request in
 *   flight, so an old answer can never arrive into a new context; the panel clears its turns too.
 * - An answer is kept only if it belongs to the field it was asked about (`belongsTo`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentHttpError, belongsTo, fetchAgentStatus, postAgentChat, type AgentChatRequest, type AgentChatResponse } from './agent-api'

export type AgentState =
  | { kind: 'loading' }
  | { kind: 'done'; response: AgentChatResponse }
  | { kind: 'fallback'; reason: string }
  | { kind: 'cancelled' }

export type AgentAvailability = 'unknown' | 'enabled' | 'disabled'

export function useAgentAvailability(open: boolean): AgentAvailability {
  const [availability, setAvailability] = useState<AgentAvailability>('unknown')
  useEffect(() => {
    if (!open || availability !== 'unknown') return
    const controller = new AbortController()
    fetchAgentStatus({ signal: controller.signal })
      .then((status) => { if (!controller.signal.aborted) setAvailability(status.llm_enabled ? 'enabled' : 'disabled') })
      .catch(() => { if (!controller.signal.aborted) setAvailability('disabled') })
    return () => controller.abort()
  }, [open, availability])
  return availability
}

export function useAgentTurns(contextKey: string) {
  const [states, setStates] = useState<Record<string, AgentState>>({})
  const controllers = useRef(new Map<string, AbortController>())

  const abortAll = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
  }, [])

  useEffect(() => {
    abortAll()
    setStates({})
  }, [contextKey, abortAll])
  useEffect(() => abortAll, [abortAll])

  const start = useCallback((turnId: string, body: AgentChatRequest) => {
    const controller = new AbortController()
    controllers.current.set(turnId, controller)
    setStates((current) => ({ ...current, [turnId]: { kind: 'loading' } }))
    postAgentChat(body, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        const next: AgentState = response.mode === 'agent' && belongsTo(response, body.field_id)
          ? { kind: 'done', response }
          : { kind: 'fallback', reason: response.mode === 'agent' ? 'field_mismatch' : response.fallback_reason ?? 'other' }
        setStates((current) => ({ ...current, [turnId]: next }))
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        const code = reason instanceof AgentHttpError ? `http_${reason.status}` : 'network'
        setStates((current) => ({ ...current, [turnId]: { kind: 'fallback', reason: code } }))
      })
      .finally(() => { controllers.current.delete(turnId) })
  }, [])

  const cancel = useCallback((turnId: string) => {
    controllers.current.get(turnId)?.abort()
    controllers.current.delete(turnId)
    setStates((current) => ({ ...current, [turnId]: { kind: 'cancelled' } }))
  }, [])

  const reset = useCallback(() => {
    abortAll()
    setStates({})
  }, [abortAll])

  return { states, start, cancel, reset }
}

/** The catalog key that explains a fallback reason code in words. */
export function fallbackReasonKey(code: string):
  | 'agent.reason.not_configured' | 'agent.reason.guard' | 'agent.reason.provider' | 'agent.reason.network'
  | 'agent.reason.limit' | 'agent.reason.field' | 'agent.reason.other' {
  if (code.startsWith('llm_')) return 'agent.reason.not_configured'
  if (code.startsWith('guard_')) return 'agent.reason.guard'
  if (code.startsWith('provider_')) return 'agent.reason.provider'
  if (code === 'network' || code.startsWith('http_')) return 'agent.reason.network'
  if (code === 'deadline' || code === 'tool_limit' || code === 'turn_limit') return 'agent.reason.limit'
  if (code === 'field_mismatch') return 'agent.reason.field'
  return 'agent.reason.other'
}
