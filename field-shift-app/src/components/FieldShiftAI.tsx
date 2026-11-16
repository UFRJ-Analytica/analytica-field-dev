/**
 * Field Shift AI: a bilingual, evidence-based assistant panel over the map.
 * Milestone 2 adds the agent: with a model configured on the backend, questions go to
 * `/experimental/field-shift-ai/chat` and the verified answer is shown; otherwise, and on any agent
 * failure, the milestone 1 deterministic adapter answers and the panel says why.
 *
 * - FieldShiftAIToggle is its own launcher (bottom right), outside the frozen control strip.
 * - FieldShiftAIPanel is a retractable side panel. It reads the selected field from the app store
 *   (Context Adapter), the block 6 numbers (Evidence Adapter) and answers a fixed set of questions
 *   (Deterministic Answer Adapter). It is a direct child of the app shell. Since block 5.5 the
 *   team's four panels live in `PanelHost` over the scenario slot, and this panel sits beside it.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { regionAdapter } from '@/lib/regions'
import { answerIntent, classifyIntent, evidenceLabel, evidenceValue } from '@/lib/assistant/answers'
import type { AgentChatRequest, AgentChatResponse } from '@/lib/assistant/agent-api'
import { useFieldContext } from '@/lib/assistant/context'
import { OVERVIEW_METRICS, summaryEvidence } from '@/lib/assistant/evidence'
import { formatDate, formatNumber, formatResolution, formatValue } from '@/lib/assistant/format'
import { useLocale } from '@/lib/assistant/locale'
import { planCommand } from '@/lib/assistant/map-commands'
import { executePlan, selectionAfterPlan, type MapToolCall, type MetricVar } from '@/lib/assistant/map-tools'
import { analysesOf, splitUnmatched, topicOf, type PlanTurn } from '@/lib/assistant/map-turn'
import type { AssistantResponse, CropWaterSet, Evidence, Intent, LimitationCode } from '@/lib/assistant/types'
import { fallbackReasonKey, useAgentAvailability, useAgentTurns, type AgentState } from '@/lib/assistant/use-agent'
import { ASSISTANT_PANEL_ID, ASSISTANT_TOGGLE_ATTR, useAssistantUi } from '@/lib/assistant/ui-store'
import { useCropWater } from '@/lib/assistant/use-crop-water'
import { at, type AssistantKey } from '@/strings/assistant'
import type { Locale } from '@/strings'
import { FieldShiftAIActions } from './FieldShiftAIActions'
import './FieldShiftAI.css'

export function FieldShiftAIToggle({ onOpen }: { onOpen?: () => void }) {
  const open = useAssistantUi((state) => state.open)
  const setOpen = useAssistantUi((state) => state.setOpen)
  const [locale] = useLocale()
  return (
    <button
      type="button"
      className={`top-chip toggle-control panel-toggle fsai-strip-toggle${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-controls={ASSISTANT_PANEL_ID}
      aria-label={at(locale, 'ai.launcher_label')}
      {...{ [ASSISTANT_TOGGLE_ATTR]: '' }}
      onClick={() => { if (!open) onOpen?.(); setOpen(!open) }}
    >
      {at(locale, 'ai.name')}
    </button>
  )
}

/** A suggested question keeps its catalog key, so it follows a language switch; typed text does not change. */
type Turn = {
  id: string
  question: string
  quickKey: AssistantKey | null
  intent: Intent
  /** A map command: the steps it ran (Geospatial Agent Tools). */
  plan?: PlanTurn
  /** The field the turn's answers belong to; another field means they are no longer shown. */
  boundFieldId?: string | null
}

/** Example commands of the map, in the order of the main demonstration. */
const MAP_EXAMPLES: AssistantKey[] = ['mapcmd.ex1', 'mapcmd.ex2', 'mapcmd.ex3', 'mapcmd.ex4']

/** How long a context change the assistant itself caused is told apart from a manual one. */
const OWN_CHANGE_MS = 5000

/** Steps 2 to 6 of the guided demo, in the order a first-time user reads a field. */
const DEMO_STEPS: { intent: Intent; key: AssistantKey }[] = [
  { intent: 'environment', key: 'quick.environment' },
  { intent: 'rainfall', key: 'quick.rain' },
  { intent: 'water_demand', key: 'quick.water' },
  { intent: 'planting', key: 'quick.planting' },
  { intent: 'sources', key: 'quick.sources' },
]

const MORE_QUESTIONS: { intent: Intent; key: AssistantKey }[] = [
  { intent: 'explain_field', key: 'quick.explain' },
  { intent: 'missing', key: 'quick.missing' },
  { intent: 'recommendation', key: 'quick.recommendation' },
]

const GLOSSARY: AssistantKey[] = ['gloss.et0', 'gloss.etc', 'gloss.kc', 'gloss.zarc', 'gloss.nass', 'gloss.power',
  'gloss.percentile', 'gloss.gwetroot', 'gloss.evland']

/**
 * Experimental display state written on <html>, read only by FieldShiftAI.css: `data-fsai-open` lets the
 * assistant take the right-hand column while it is open. No team component is edited; removing the
 * attribute restores the app exactly.
 */

/**
 * The guided demo opens a United States field: Cass Field 01, then the two pilots when the region
 * carries them. The application mounts one region, so no region switch is involved.
 */
const DEMO_CANDIDATES: { demo: string; fieldId: string; key: AssistantKey }[] = [
  { demo: 'us', fieldId: regionAdapter('us').fixtureIds[0] ?? '', key: 'demo.open_us' },
  { demo: 'il-mclean-01', fieldId: 'il-mclean-01', key: 'demo.open_mclean' },
  { demo: 'tx-lubbock-01', fieldId: 'tx-lubbock-01', key: 'demo.open_lubbock' },
]
const DEMO_FIELDS = DEMO_CANDIDATES.filter(
  (entry) => entry.fieldId !== '' && regionAdapter('us').fixtureIds.includes(entry.fieldId))

function openDemoField(fieldId: string): void {
  const store = useMapStore.getState()
  if (store.regionId !== 'us') store.setRegionId('us')
  if (store.selectedFieldId !== fieldId) store.selectField(fieldId)
}

function statusText(kind: string, locale: Locale, status?: number): string {
  switch (kind) {
    case 'no_field': return at(locale, 'status.no_field')
    case 'ring_missing': return at(locale, 'status.ring_missing')
    case 'loading': return at(locale, 'status.loading')
    case 'held': return at(locale, 'status.held')
    case 'error': return at(locale, 'status.error', { status: status ?? '' })
    case 'offline': return at(locale, 'status.offline')
    case 'cached': return at(locale, 'status.cached')
    default: return at(locale, 'status.ready')
  }
}

export function FieldShiftAIPanel({ selectedField, fields = [] }: { selectedField: FieldSummary | null; fields?: readonly FieldSummary[] }) {
  const open = useAssistantUi((state) => state.open)
  const setOpen = useAssistantUi((state) => state.setOpen)
  const [locale, setLocale] = useLocale()
  const context = useFieldContext(selectedField, open)
  const availability = useAgentAvailability(open)
  const agent = useAgentTurns(context.key)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [contextChanged, setContextChanged] = useState(false)
  const lastKey = useRef(context.key)
  // A change the assistant made itself (a map command) keeps the conversation; a manual change clears it.
  const ownChange = useRef<{ regionId: string; fieldId: string | null; date: string; until: number } | null>(null)
  const topic = useRef<MetricVar | null>(null)
  const executedAgentPlans = useRef(new Set<string>())
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const logRef = useRef<HTMLOListElement | null>(null)
  const headingId = useId()
  const inputId = useId()

  useEffect(() => {
    if (open) document.documentElement.dataset.fsaiOpen = 'true'
    else delete document.documentElement.dataset.fsaiOpen
    return () => { delete document.documentElement.dataset.fsaiOpen }
  }, [open])

  // Answers belong to one field, date and ring. A change clears them, so no answer can show data
  // of a field the user is no longer looking at.
  const turnSeq = useRef(0)
  const turnCount = useRef(0)
  turnCount.current = turns.length
  useEffect(() => {
    if (lastKey.current === context.key) return
    lastKey.current = context.key
    const own = ownChange.current
    // After a region switch the app selects the region's first field by itself: within the window, a
    // field of the region the command opened is still the command's own change, and its turns adopt it.
    const sameRegion = own !== null && context.regionId === own.regionId
    if (own && Date.now() < own.until && sameRegion
      && (context.fieldId === own.fieldId || context.fieldId === null || own.fieldId === null)) {
      if (own.fieldId === null && context.fieldId !== null) {
        const adopted = context.fieldId
        setTurns((current) => current.map((turn) => (turn.plan && turn.boundFieldId === null ? { ...turn, boundFieldId: adopted } : turn)))
        own.fieldId = adopted
      }
      // Settled only once a field is in place: right after a region switch there is briefly none.
      if (context.fieldId !== null && context.fieldId === own.fieldId && context.date === own.date) ownChange.current = null
      return
    }
    ownChange.current = null
    topic.current = null
    setContextChanged(turnCount.current > 0)
    setTurns([])
  }, [context.key, context.fieldId, context.date, context.regionId])

  /** Runs map tool calls and records what they left selected, so the panel keeps its own change. */
  const runPlan = (calls: readonly MapToolCall[], autoSelectField: boolean) => {
    // The panel covers the right of the map on wide screens; on narrow ones it is a sheet, so no inset.
    const panel = document.getElementById(ASSISTANT_PANEL_ID)
    const width = panel?.getBoundingClientRect().width ?? 0
    const insetRight = width > 0 && width < globalThis.innerWidth * 0.6 ? Math.round(width + 24) : 0
    const results = executePlan(calls, { fields, autoSelectField, insetRight })
    const store = useMapStore.getState()
    ownChange.current = { regionId: store.regionId, fieldId: selectionAfterPlan(), date: chosenDateOf(store), until: Date.now() + OWN_CHANGE_MS }
    return results
  }

  // Model mode: map actions arrive with the verified answer and run once, through the same closed
  // registry and validation as the command interpreter. The model's arguments are never trusted as is.
  useEffect(() => {
    for (const [turnId, state] of Object.entries(agent.states)) {
      if (state.kind !== 'done' || executedAgentPlans.current.has(turnId)) continue
      const actions = state.response.map_actions ?? []
      executedAgentPlans.current.add(turnId)
      if (actions.length === 0) continue
      const results = runPlan(actions, false)
      setTurns((current) => current.map((turn) => (turn.id === turnId
        ? { ...turn, plan: { mode: 'agent', results, unmatched: [], questions: [] }, boundFieldId: selectionAfterPlan() }
        : turn)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.states])

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' })
  }, [turns])

  const close = () => {
    setOpen(false)
    document.querySelector<HTMLButtonElement>(`[${ASSISTANT_TOGGLE_ATTR}]`)?.focus()
  }

  const ask = (question: string, quickKey: AssistantKey | null = null, intent: Intent = classifyIntent(question),
    askLocale: Locale = locale) => {
    const text = question.trim()
    if (text === '') return
    setContextChanged(false)
    const id = `${context.key}#${turnSeq.current++}`
    const useModel = availability === 'enabled' && context.fieldId !== null
    // Without a model, a map command runs through the command interpreter; anything else is a question.
    if (!useModel && quickKey === null) {
      const command = planCommand(text, { defaultYear: Number(context.date.slice(0, 4)), topic: topic.current })
      if (command.calls.length > 0) {
        const results = runPlan(command.calls, true)
        const plan: PlanTurn = { mode: 'deterministic', results, ...splitUnmatched(command.unmatched) }
        topic.current = topicOf(plan, command.topic)
        setTurns((current) => [...current, { id, question: text, quickKey, intent: 'unsupported', plan, boundFieldId: selectionAfterPlan() }])
        return
      }
    }
    setTurns((current) => [...current, { id, question: text, quickKey, intent, boundFieldId: context.fieldId }])
    // With a model configured the question goes to the agent; otherwise the deterministic adapter answers.
    if (useModel) {
      const body: AgentChatRequest = { field_id: context.fieldId, locale: askLocale, question: text, date: context.date }
      if (context.polygonGeometry) Object.assign(body, context.polygonGeometry)
      agent.start(id, body)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    ask(draft)
    setDraft('')
  }

  // Responses are computed at render from the turn's intent and the current context, so a locale
  // switch re-renders the same answer, with the same evidence, in the other language.
  const responses: AssistantResponse[] = useMemo(
    () => turns.map((turn) => answerIntent(turn.intent, {
      context, locale, id: turn.id, question: turn.quickKey ? at(locale, turn.quickKey) : turn.question,
    })),
    [turns, context, locale],
  )
  // A command's answers, computed like any answer from the context the map is in after its steps.
  const planResponses: AssistantResponse[][] = useMemo(
    () => turns.map((turn) => (turn.plan && turn.plan.mode === 'deterministic'
      ? analysesOf(turn.plan).map((analysis, index) => answerIntent(analysis.intent, {
        context, locale, id: `${turn.id}.${index}`, question: analysis.question ?? turn.question, metrics: analysis.metrics,
      }))
      : [])),
    [turns, context, locale],
  )

  // The FAO-56 comparison is computed by the backend; this keeps the set of the selected field.
  useCropWater(context.fieldId, context.kind, context.date, open)

  const payload = context.numbers.kind === 'ready' || context.numbers.kind === 'held' ? context.numbers.payload : null
  const overview = payload && context.fieldId
    ? summaryEvidence(payload, context.fieldId).filter((e) => OVERVIEW_METRICS.includes(e.metric as never))
    : []
  const window = payload?.query.window
  const statusKind = context.numbers.kind === 'ready' && context.numbers.cached ? 'cached' : context.numbers.kind
  const fieldName = context.kind === 'fixture'
    ? context.name
    : context.fieldId ? at(locale, 'ctx.polygon_name', { id: context.fieldId }) : null

  if (!open) return null

  return (
    <aside
      id={ASSISTANT_PANEL_ID}
      className="fsai-panel overlay-interactive panel-surface"
      aria-labelledby={headingId}
      lang={locale}
      onKeyDown={(event) => { if (event.key === 'Escape') close() }}
    >
      <header className="fsai-header">
        <div className="fsai-title">
          <h2 id={headingId}>{at(locale, 'ai.name')}</h2>
          <p className="fsai-subtitle">{at(locale, 'ai.subtitle')}</p>
        </div>
        <button ref={closeRef} type="button" className="fsai-close" aria-label={at(locale, 'ai.close_label')} onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="fsai-meta">
        <span className="fsai-badge" data-availability={availability}>
          {at(locale, availability === 'enabled' ? 'agent.badge_on' : 'ai.preview_badge')}
        </span>
        <div className="fsai-lang" role="group" aria-label={at(locale, 'ai.language')}>
          <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
          <button type="button" lang="pt-BR" aria-pressed={locale === 'pt-BR'} onClick={() => setLocale('pt-BR')}>PT-BR</button>
        </div>
      </div>
      <p className="fsai-note">
        {availability === 'enabled' ? at(locale, 'agent.answered_by_model') : at(locale, 'ai.preview_note')}
        {' '}{at(locale, 'ai.language_note')}
      </p>

      <div className="fsai-scroll">
        <section className="fsai-section fsai-demo" aria-label={at(locale, 'demo.heading')}>
          <h3>{at(locale, 'demo.heading')}</h3>
          <p className="fsai-hint">{at(locale, 'demo.intro')}</p>
          <ol className="fsai-steps">
            <li>
              <div className="fsai-step-field">
                {DEMO_FIELDS.map((entry) => (
                  <button key={entry.demo} type="button" data-demo={entry.demo}
                    className={entry.demo === 'us' ? 'fsai-primary' : undefined}
                    onClick={() => openDemoField(entry.fieldId)}>{at(locale, entry.key)}</button>
                ))}
              </div>
              <p className="fsai-hint">{at(locale, 'demo.region_note')}</p>
              {fieldName && <p className="fsai-hint fsai-active" data-testid="fsai-demo-active">{at(locale, 'demo.active', { name: fieldName })}</p>}
            </li>
            {DEMO_STEPS.map(({ intent, key }) => (
              <li key={key}>
                <button type="button" className="fsai-step" disabled={context.fieldId === null}
                  onClick={() => ask(at(locale, key), key, intent)}>{at(locale, key)}</button>
              </li>
            ))}
          </ol>
        </section>

        <section className="fsai-section fsai-mapcmd" aria-label={at(locale, 'mapcmd.heading')}>
          <h3>{at(locale, 'mapcmd.heading')}</h3>
          <p className="fsai-hint">{at(locale, 'mapcmd.hint')}</p>
          <div className="fsai-quick">
            {MAP_EXAMPLES.map((key) => (
              <button key={key} type="button" data-map-example={key} onClick={() => ask(at(locale, key))}>{at(locale, key)}</button>
            ))}
          </div>
        </section>

        <section className="fsai-section" aria-label={at(locale, 'ctx.heading')}>
          <h3>{at(locale, 'ctx.heading')}</h3>
          <dl className="fsai-context">
            <dt>{at(locale, 'ctx.field')}</dt>
            <dd data-testid="fsai-field">{fieldName ?? at(locale, 'ctx.none')}</dd>
            <dt>{at(locale, 'ctx.region')}</dt>
            <dd>{at(locale, 'region.us')}</dd>
            <dt>{at(locale, 'ctx.date')}</dt>
            <dd data-testid="fsai-date">{formatDate(context.date, locale)}</dd>
            {window?.start && window?.end && (
              <>
                <dt>{at(locale, 'ctx.window')}</dt>
                <dd>{at(locale, 'ctx.window_value', { start: formatDate(window.start, locale), end: formatDate(window.end, locale), days: window.days ?? '' })}</dd>
              </>
            )}
            <dt>{at(locale, 'ctx.data')}</dt>
            <dd data-testid="fsai-status" data-status={statusKind} role="status">
              {statusText(statusKind, locale, context.numbers.kind === 'error' ? context.numbers.status : undefined)}
            </dd>
          </dl>
        </section>

        {overview.length > 0 && (
          <section className="fsai-section" aria-label={at(locale, 'overview.heading')}>
            <h3>{at(locale, 'overview.heading')}</h3>
            <ul className="fsai-overview">
              {overview.map((item) => (
                <li key={item.id} data-metric={item.metric}>
                  <span className="fsai-overview-label">{evidenceLabel(item, locale)}</span>
                  <span className="fsai-overview-value">{evidenceValue(item, locale)}</span>
                </li>
              ))}
            </ul>
            <p className="fsai-hint">{at(locale, 'overview.more')}</p>
          </section>
        )}

        <section className="fsai-section" aria-label={at(locale, 'quick.more')}>
          <h3>{at(locale, 'quick.more')}</h3>
          <div className="fsai-quick">
            {MORE_QUESTIONS.map(({ intent, key }) => (
              <button key={key} type="button" onClick={() => ask(at(locale, key), key, intent)}>{at(locale, key)}</button>
            ))}
          </div>
        </section>

        <section className="fsai-section" aria-label={at(locale, 'chat.label')}>
          {contextChanged && <p className="fsai-notice" role="status">{at(locale, 'chat.context_changed')}</p>}
          {turns.length === 0 && !contextChanged && <p className="fsai-hint">{at(locale, 'chat.empty')}</p>}
          <ol className="fsai-log" ref={logRef} aria-live="polite">
            {turns.map((turn, index) => (
              <li key={turn.id} className="fsai-turn">
                <p className="fsai-question"><span className="fsai-who">{at(locale, 'chat.you')}</span>{turn.quickKey ? at(locale, turn.quickKey) : turn.question}</p>
                {turn.plan && <FieldShiftAIActions plan={turn.plan} locale={locale} />}
                {turn.boundFieldId !== undefined && turn.boundFieldId !== context.fieldId
                  ? <p className="fsai-notice" data-testid="fsai-superseded">{at(locale, 'stage.superseded')}</p>
                  : turn.plan && turn.plan.mode === 'deterministic'
                    ? <PlanAnswers responses={planResponses[index]} numbers={context.numbers.kind} locale={locale} />
                    // The model's data tools read the field and date of the moment it was asked (the turn id
                    // starts with that context key); once its own map actions changed them, the answer
                    // describes the old context and is not shown.
                    : turn.plan?.mode === 'agent' && turn.id.slice(0, turn.id.lastIndexOf('#')) !== context.key
                      ? <p className="fsai-notice" data-testid="fsai-superseded">{at(locale, 'stage.superseded')}</p>
                      : (
                      <TurnAnswer
                        state={agent.states[turn.id]}
                        deterministic={responses[index]}
                        locale={locale}
                        onCancel={() => agent.cancel(turn.id)}
                        onRegenerate={() => ask(turn.quickKey ? at(locale, turn.quickKey) : turn.question, turn.quickKey, turn.intent, locale)}
                      />
                    )}
              </li>
            ))}
          </ol>
          {turns.length > 0 && (
            <button type="button" className="fsai-clear" onClick={() => { agent.reset(); setTurns([]); setContextChanged(false) }}>
              {at(locale, 'chat.clear')}
            </button>
          )}
        </section>

        <section className="fsai-section">
          <details className="fsai-glossary">
            <summary>{at(locale, 'gloss.heading')}</summary>
            <ul>{GLOSSARY.map((key) => <li key={key}>{at(locale, key)}</li>)}</ul>
          </details>
        </section>
      </div>

      <form className="fsai-form" onSubmit={submit}>
        <label className="fsai-visually-hidden" htmlFor={inputId}>{at(locale, 'chat.input_label')}</label>
        <input
          id={inputId}
          type="text"
          value={draft}
          placeholder={at(locale, 'chat.placeholder')}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={draft.trim() === ''}>{at(locale, 'chat.send')}</button>
      </form>
    </aside>
  )
}

/** A command's answers, with the real stage of the evidence: still loading, or complete. */
function PlanAnswers({ responses, numbers, locale }: { responses: AssistantResponse[]; numbers: string; locale: Locale }) {
  if (responses.length === 0) return null
  const loading = numbers === 'loading'
  const stage = loading ? 'evidence' : numbers === 'error' || numbers === 'offline' ? 'failed' : 'done'
  return (
    <div className="fsai-plan-answers">
      <p className="fsai-stage" role="status" data-stage={stage}>{at(locale, `stage.${stage}` as AssistantKey)}</p>
      {!loading && responses.map((response) => <ResponseView key={response.id} response={response} locale={locale} />)}
    </div>
  )
}

type TurnAnswerProps = {
  state: AgentState | undefined
  deterministic: AssistantResponse
  locale: Locale
  onCancel: () => void
  onRegenerate: () => void
}

/**
 * One turn's answer. Without the agent (no model, an error, a guard rejection) it is the deterministic
 * answer, with a note saying why the model was not used. With the agent it is the verified answer.
 */
function TurnAnswer({ state, deterministic, locale, onCancel, onRegenerate }: TurnAnswerProps) {
  if (state === undefined) return <ResponseView response={deterministic} locale={locale} />
  if (state.kind === 'loading') {
    return (
      <div className="fsai-answer" data-status="loading">
        <p className="fsai-answer-head"><span className="fsai-who">{at(locale, 'ai.name')}</span></p>
        <p role="status" className="fsai-loading">{at(locale, 'agent.loading')}</p>
        <button type="button" className="fsai-clear" onClick={onCancel}>{at(locale, 'agent.cancel')}</button>
      </div>
    )
  }
  if (state.kind === 'cancelled') {
    return <div className="fsai-answer" data-status="cancelled"><p>{at(locale, 'agent.cancelled')}</p></div>
  }
  if (state.kind === 'fallback') {
    return (
      <>
        <p className="fsai-fallback-note" data-reason={state.reason}>
          {at(locale, 'agent.fallback_note', { reason: at(locale, fallbackReasonKey(state.reason)) })}
        </p>
        <ResponseView response={deterministic} locale={locale} />
      </>
    )
  }
  return <AgentResponseView response={state.response} locale={locale} onRegenerate={onRegenerate} />
}

/**
 * A verified agent answer. Text segments are the model's words in the language it was asked in; value
 * and period segments are printed here from the Evidence items the backend checked, so every number on
 * screen is a tool's number. Evidence cards and limitations follow the active language.
 */
function AgentResponseView({ response, locale, onRegenerate }: { response: AgentChatResponse; locale: Locale; onRegenerate: () => void }) {
  const byId = new Map(response.evidence.map((item) => [item.id, item]))
  const textLocale = response.locale
  const segment = (part: AgentChatResponse['answer'][number][number], key: number) => {
    const item = part.evidence ? byId.get(part.evidence) : undefined
    if (part.t === 'text') return <span key={key}>{part.text}</span>
    if (!item) return null
    if (part.t === 'value') return <strong key={key} className="fsai-value" data-evidence={item.id}>{evidenceValue(item, textLocale)}</strong>
    const period = item.period
      ? at(textLocale, 'ev.period_value', { start: formatDate(item.period.start, textLocale), end: formatDate(item.period.end, textLocale) })
      : formatDate(item.asOf ?? null, textLocale)
    return <span key={key} data-evidence={item.id}>{period}</span>
  }
  const status = response.status === 'fallback' ? 'unavailable' : response.status
  return (
    <div className="fsai-answer" data-status={status} data-intent="agent" data-field={response.field_id} data-mode="agent">
      <p className="fsai-answer-head">
        <span className="fsai-who">{at(locale, 'ai.name')}</span>
        <span className={`fsai-pill is-${status}`}>{at(locale, `answer.status.${status}` as AssistantKey)}</span>
      </p>
      {textLocale !== locale && (
        <p className="fsai-notice" role="status">
          {at(locale, 'agent.other_language', { language: at(locale, `lang.${textLocale}` as AssistantKey) })}{' '}
          <button type="button" className="fsai-clear" onClick={onRegenerate}>
            {at(locale, 'agent.regenerate', { language: at(locale, `lang.${locale}` as AssistantKey) })}
          </button>
        </p>
      )}
      <div lang={textLocale}>
        {response.answer.map((paragraph, index) => <p key={index}>{paragraph.map(segment)}</p>)}
      </div>
      {waterRowsFromEvidence(response.evidence).length > 0 && (
        <WaterTable rows={waterRowsFromEvidence(response.evidence)} set={null} locale={locale}
          period={response.evidence.find((e) => e.id === 'crop_water.et0_total')?.period ?? null}
          et0={response.evidence.find((e) => e.id === 'crop_water.et0_total')?.value ?? null} />
      )}
      {response.evidence.length > 0 && (
        <details className="fsai-evidence">
          <summary>{at(locale, 'answer.evidence', { count: response.evidence.length })}</summary>
          <ul>
            {response.evidence.map((item) => <EvidenceItem key={item.id} item={item} locale={locale} />)}
          </ul>
        </details>
      )}
      {response.limitations.length > 0 && (
        <div className="fsai-limits">
          <p className="fsai-limits-head">{at(locale, 'answer.limitations')}</p>
          <ul>
            {response.limitations.map((code: LimitationCode) => <li key={code}>{at(locale, `limit.${code}` as AssistantKey)}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

function ResponseView({ response, locale }: { response: AssistantResponse; locale: Locale }) {
  return (
    <div className="fsai-answer" data-status={response.status} data-intent={response.intent} data-field={response.fieldId ?? ''}>
      <p className="fsai-answer-head">
        <span className="fsai-who">{at(locale, 'ai.name')}</span>
        <span className={`fsai-pill is-${response.status}`}>{at(locale, `answer.status.${response.status}` as AssistantKey)}</span>
      </p>
      {/* The conclusion, then the comparison it summarises, then the explanation. */}
      {response.answer.slice(0, 1).map((line, index) => <p key={index}>{line}</p>)}
      {response.cropWater && <WaterTable rows={waterRowsFromSet(response.cropWater)} set={response.cropWater} locale={locale} />}
      {response.answer.slice(1).map((line, index) => <p key={index + 1}>{line}</p>)}
      {response.evidence.length > 0 && (
        <details className="fsai-evidence">
          <summary>{at(locale, 'answer.evidence', { count: response.evidence.length })}</summary>
          <ul>
            {response.evidence.map((item) => <EvidenceItem key={item.id} item={item} locale={locale} />)}
          </ul>
        </details>
      )}
      {response.limitations.length > 0 && (
        <div className="fsai-limits">
          <p className="fsai-limits-head">{at(locale, 'answer.limitations')}</p>
          <ul>
            {response.limitations.map((code) => <li key={code}>{at(locale, `limit.${code}` as AssistantKey)}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

type WaterRow = { cropId: string; kc: number | null; etc: number | null; balance: number | null }

function waterRowsFromSet(set: CropWaterSet): WaterRow[] {
  return set.crops.map((c) => ({ cropId: c.cropId, kc: c.kc.mid, etc: c.etcTotalMm, balance: c.rainMinusEtcMm }))
}

/** The same table for an agent answer, read only from the evidence the backend verified. */
function waterRowsFromEvidence(evidence: Evidence[]): WaterRow[] {
  const num = (id: string) => {
    const value = evidence.find((e) => e.id === id)?.value
    return typeof value === 'number' ? value : null
  }
  const ids = [...new Set(evidence.map((e) => /^crop_water\.([a-z]+)\.etc_total$/.exec(e.id)?.[1]).filter((id): id is string => Boolean(id)))]
  return ids.map((cropId) => ({
    cropId,
    kc: num(`crop_water.${cropId}.kc_mid`),
    etc: num(`crop_water.${cropId}.etc_total`),
    balance: num(`crop_water.${cropId}.rain_minus_etc`),
  }))
}

/**
 * A compact comparison of the recorded FAO-56 values: one row per crop, no chart and no ranking
 * beyond the order of the source. Every cell is a recorded value; nothing is computed here.
 */
function WaterTable({ rows, set, locale, period, et0 }: {
  rows: WaterRow[]; set: CropWaterSet | null; locale: Locale
  period?: { start: string; end: string } | null; et0?: number | string | null
}) {
  const window = set ? set.period : period ?? null
  const et0Value = set ? set.crops[0]?.et0TotalMm ?? null : typeof et0 === 'number' ? et0 : null
  const rain = set ? set.crops[0]?.rainTotalMm ?? null : null
  const mm = (value: number | null) => formatValue(value, 'mm', 'rain_total', locale)
  const top = Math.max(...rows.map((r) => r.etc ?? -Infinity))
  return (
    <table className="fsai-water" data-testid="fsai-water-table">
      {window && (
        <caption>{at(locale, 'water.table_caption', { start: formatDate(window.start, locale), end: formatDate(window.end, locale) })}</caption>
      )}
      <thead>
        <tr>
          <th scope="col">{at(locale, 'water.col_crop')}</th>
          <th scope="col">{at(locale, 'water.col_kc')}</th>
          <th scope="col">{at(locale, 'water.col_etc')}</th>
          <th scope="col">{at(locale, 'water.col_balance')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.cropId} data-crop={row.cropId} data-highest={row.etc === top ? 'true' : undefined}>
            <th scope="row">{at(locale, `crop.${row.cropId}` as AssistantKey)}</th>
            <td>{row.kc === null ? '—' : formatNumber(row.kc, 2, locale)}</td>
            <td>{mm(row.etc)}</td>
            <td>{mm(row.balance)}</td>
          </tr>
        ))}
      </tbody>
      {et0Value !== null && (
        <tfoot>
          <tr>
            <td colSpan={4}>{at(locale, 'water.table_foot', { et0: mm(et0Value), rain: rain === null ? '—' : mm(rain) })}</td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

function EvidenceItem({ item, locale }: { item: Evidence; locale: Locale }) {
  return (
    <li className="fsai-ev" data-metric={item.metric} data-basis={item.basis}>
      <p className="fsai-ev-title">
        <span>{evidenceLabel(item, locale)}</span>
        <strong>{evidenceValue(item, locale)}</strong>
      </p>
      <dl>
        <dt>{at(locale, 'ev.basis')}</dt>
        <dd>{at(locale, `basis.${item.basis}` as AssistantKey)}</dd>
        {item.period && (
          <>
            <dt>{at(locale, 'ev.period')}</dt>
            <dd>{at(locale, 'ev.period_value', { start: formatDate(item.period.start, locale), end: formatDate(item.period.end, locale) })}</dd>
          </>
        )}
        {!item.period && item.asOf && (
          <>
            <dt>{at(locale, 'ev.as_of')}</dt>
            <dd>{formatDate(item.asOf, locale)}</dd>
          </>
        )}
        {item.resolution && (
          <>
            <dt>{at(locale, 'ev.resolution')}</dt>
            <dd>{formatResolution(item.resolution, locale)}</dd>
          </>
        )}
        <dt>{at(locale, 'ev.source')}</dt>
        <dd className="fsai-ev-source" lang="en">{item.source}</dd>
      </dl>
    </li>
  )
}
