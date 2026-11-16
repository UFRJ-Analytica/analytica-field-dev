/**
 * The steps a map command ran, as the farmer reads them: what was done, what was not and why. A focus or
 * highlight step stays "framing…" until the map canvas reports it framed the geometry, so the panel
 * never claims a camera move that did not happen.
 */
import { useMapStore } from '@/lib/map-store'
import { formatDate, formatList } from '@/lib/assistant/format'
import { isRealDate, type MapToolResult } from '@/lib/assistant/map-tools'
import type { PlanTurn } from '@/lib/assistant/map-turn'
import { at, type AssistantKey } from '@/strings/assistant'
import type { Locale } from '@/strings'

const DATE_PARAMS = new Set(['date', 'start', 'end', 'last'])

function paramsFor(result: MapToolResult, locale: Locale): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(result.params)) {
    // An impossible date (31 February) is printed as typed: formatting it would roll it into March.
    if (DATE_PARAMS.has(key) && typeof value === 'string' && isRealDate(value.slice(0, 10))) out[key] = formatDate(value.slice(0, 10), locale)
    else if (key === 'metrics' && typeof value === 'string') {
      out[key] = formatList(value.split(',').map((m) => at(locale, `metricvar.${m}` as AssistantKey)), locale)
    } else out[key] = value
  }
  return out
}

function stepText(result: MapToolResult, locale: Locale, focusHandled: { seq: number; ok: boolean } | null): { key: string; text: string; status: string } {
  const params = paramsFor(result, locale)
  if (result.focusSeq !== undefined && result.status === 'success') {
    const handled = focusHandled !== null && focusHandled.seq >= result.focusSeq
    const highlight = result.code === 'highlight_requested'
    if (!handled) return { key: result.code, text: at(locale, `tool.${result.code}` as AssistantKey, params), status: 'running' }
    if (focusHandled.seq === result.focusSeq && !focusHandled.ok) {
      return { key: 'focus_no_selection', text: at(locale, 'tool.focus_no_selection'), status: 'failed' }
    }
    const done = highlight ? 'highlight_done' : 'focus_done'
    return { key: done, text: at(locale, `tool.${done}` as AssistantKey, params), status: 'success' }
  }
  return { key: result.code, text: at(locale, `tool.${result.code}` as AssistantKey, params), status: result.status }
}

export function FieldShiftAIActions({ plan, locale }: { plan: PlanTurn; locale: Locale }) {
  const focusHandled = useMapStore((state) => state.focusHandled)
  const last = plan.results[plan.results.length - 1]
  const regionOnly = plan.results.length > 0 && plan.results.every((r) => r.tool === 'select_region' || r.tool === 'set_date')
    && plan.results.some((r) => r.code === 'region_selected')
  return (
    <div className="fsai-actions" data-mode={plan.mode} data-map-version={last?.mapStateVersion ?? 0}>
      <p className="fsai-actions-head">{at(locale, 'tool.heading')}</p>
      <ol className="fsai-steps-run">
        {plan.results.map((result, index) => {
          const step = stepText(result, locale, focusHandled)
          return (
            <li key={index} data-tool={result.tool} data-status={step.status} data-code={step.key}>
              <span className="fsai-step-mark" aria-hidden="true">
                {step.status === 'success' ? '✓' : step.status === 'running' ? '…' : step.status === 'skipped' ? '–' : '!'}
              </span>
              <span className="fsai-visually-hidden">
                {at(locale, `tool.status.${step.status === 'running' ? 'success' : step.status}` as AssistantKey)}:{' '}
              </span>
              {step.text}
            </li>
          )
        })}
        {plan.unmatched.map((text, index) => (
          <li key={`u${index}`} data-tool="none" data-status="unmatched">
            <span className="fsai-step-mark" aria-hidden="true">?</span>
            {at(locale, 'tool.unmatched', { text })}
          </li>
        ))}
      </ol>
      {regionOnly && <p className="fsai-hint">{at(locale, 'tool.next_region')}</p>}
      <p className="fsai-actions-mode">{at(locale, plan.mode === 'agent' ? 'tool.mode.agent' : 'tool.mode.deterministic')}</p>
    </div>
  )
}
