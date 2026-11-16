/**
 * Geospatial Agent Tools (Field Shift AI, experiment).
 *
 * A closed registry of map actions the assistant may run. Every tool:
 *  - validates its arguments against a fixed shape and resolves names against the app's own catalogs
 *    (regions in `regions.ts`, fields from `/fields`, layers from the `/layers` catalog in the store);
 *  - acts only through the existing `useMapStore` actions (`setRegionId`, `selectField`, `setChosenDate`,
 *    `setLayerOn`, `requestFocus`), so the map has one source of truth and the controls show the change;
 *  - returns a structured result. Nothing here touches the DOM, evaluates code or calls the network.
 *
 * Tools are `visual` (they change what the map shows) or `read` (they ask the panel for an analysis of
 * the selected field). A future tool that writes data or has external effects would be `persistent` and
 * the executor refuses it unless the caller passes an explicit confirmation.
 */
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { regionAdapter, type RegionId } from '@/lib/regions'

export const MAP_TOOL_NAMES = [
  'select_region',
  'select_field',
  'focus_geometry',
  'set_date',
  'set_analysis_window',
  'show_layer',
  'hide_layer',
  'query_field_metrics',
  'compare_metrics',
  'highlight_evidence',
] as const

export type MapToolName = (typeof MAP_TOOL_NAMES)[number]
export type MapToolCall = { tool: string; arguments: Record<string, unknown> }
export type MapToolStatus = 'success' | 'failed' | 'unsupported' | 'needs_clarification' | 'skipped'
export type ToolEffect = 'visual' | 'read' | 'persistent'

/** The variables an analysis may name. Each maps to block 6 indicators the panel already reads. */
export const METRIC_VARS = ['rain', 'soil_moisture', 'temperature', 'vegetation', 'water_risk', 'overview'] as const
export type MetricVar = (typeof METRIC_VARS)[number]

/** An analysis the panel renders from the current context once the tools have run. */
export type AnalysisRequest = { kind: 'query' | 'compare'; metrics: MetricVar[] }

export type MapToolResult = {
  tool: string
  status: MapToolStatus
  /** Catalog key suffix: the step is printed as `tool.<code>` with `params`. */
  code: string
  params: Record<string, string | number>
  effect: ToolEffect
  /** Increases by one for every action that changed the map state. */
  mapStateVersion: number
  /** For focus and highlight: the request the map canvas answers through `focusHandled`. */
  focusSeq?: number
  analysis?: AnalysisRequest
  /** True when the executor ran the step itself (a field the analysis needed). */
  automatic?: boolean
}

export type ExecutionEnv = {
  /** The `/fields` list, for names and for checking a field belongs to the active region. */
  fields: readonly FieldSummary[]
  /** An analysis with no field selected may select the region's first demonstration field. */
  autoSelectField?: boolean
  /** Required for a `persistent` tool. No such tool exists yet. */
  confirmed?: boolean
  /** Width in pixels of a panel over the right of the map, so a framed field stays visible beside it. */
  insetRight?: number
}

export const MAX_PLAN_STEPS = 8
export const BLOCK6_WINDOW_DAYS = 42
const MAX_LOG = 50

let mapStateVersion = 0
export function currentMapStateVersion(): number {
  return mapStateVersion
}

/** Structured log of every executed step, newest last, without free text from the user. */
export const toolLog: { at: string; tool: string; status: MapToolStatus; code: string; version: number }[] = []

function log(result: MapToolResult): MapToolResult {
  toolLog.push({ at: new Date().toISOString(), tool: result.tool, status: result.status, code: result.code, version: result.mapStateVersion })
  if (toolLog.length > MAX_LOG) toolLog.splice(0, toolLog.length - MAX_LOG)
  return result
}

/** Lower case, accents removed, punctuation as spaces, padded with one space on each side. */
export function norm(text: string): string {
  return ` ${text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

function hasWord(text: string, phrase: string): boolean {
  return norm(text).includes(` ${norm(phrase).trim()} `)
}

// ----- catalogs ---------------------------------------------------------------------------------

/**
 * The places the app holds. Since the team's publishing work the app mounts one region, the United
 * States, with the three Cass County fields and the McLean (IL) and Lubbock (TX) pilots, so a "region"
 * the farmer names is one of these counties. Opening it selects its first field, which moves the map.
 * `fieldIds` is the fallback when the `/fields` list has not loaded (its `location` is used first).
 */
export type PlaceId = 'cass' | 'mclean' | 'lubbock' | 'us'
export const PLACES: Record<PlaceId, { label: string; location: string | null; fieldIds: string[]; aliases: string[] }> = {
  cass: { label: 'Cass County', location: 'cass county', fieldIds: ['381825001868504', '381825001868512', '381825001868517'],
    aliases: ['cass county', 'condado de cass', 'cass', 'north dakota', 'dakota do norte', 'fargo'] },
  mclean: { label: 'McLean County', location: 'mclean county', fieldIds: ['il-mclean-01'],
    aliases: ['mclean county', 'condado de mclean', 'mclean', 'illinois'] },
  lubbock: { label: 'Lubbock County', location: 'lubbock county', fieldIds: ['tx-lubbock-01'],
    aliases: ['lubbock county', 'condado de lubbock', 'lubbock', 'texas'] },
  us: { label: 'United States', location: null, fieldIds: [], aliases: ['united states', 'estados unidos', 'eua', 'usa'] },
}

/** Places the app no longer holds: recognised, so the answer can say so instead of guessing. */
export const UNAVAILABLE_PLACES = ['santa carmem', 'mato grosso', 'brazil', 'brasil']

/** Every place word the interpreter may meet, available or not. */
export const REGION_ALIASES: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(PLACES).map(([id, place]) => [id, place.aliases])),
  unavailable: UNAVAILABLE_PLACES,
}

export function resolvePlace(name: string): PlaceId | 'unavailable' | null {
  if (UNAVAILABLE_PLACES.some((alias) => hasWord(name, alias))) return 'unavailable'
  const hits = (Object.keys(PLACES) as PlaceId[]).filter((id) => PLACES[id].aliases.some((alias) => hasWord(name, alias)))
  return hits.length === 1 ? hits[0] : null
}

const PLACE_OPTIONS = 'Cass County, McLean County, Lubbock County'

/** The fields of a place, in the region's fixture order, from `/fields` locations or the fallback ids. */
function placeFields(place: PlaceId, regionId: RegionId, fields: readonly FieldSummary[]): string[] {
  const ids = regionAdapter(regionId).fixtureIds
  const { location, fieldIds } = PLACES[place]
  if (location === null) return []
  const byLocation = ids.filter((id) => norm(fields.find((f) => f.id === id)?.location ?? '').includes(` ${location} `))
  return byLocation.length > 0 ? byLocation : ids.filter((id) => fieldIds.includes(id))
}

/**
 * Layer words, in the order they are tried, mapped to `/layers` catalog ids in order of preference. The
 * first id the active catalog holds wins, so a layer the backend dropped (SMAP L3, after the publishing
 * work) falls back to the one it serves now (SMAP L4 surface) instead of failing or being invented.
 */
export const LAYER_ALIASES: [string[], string[]][] = [
  [['smap-l3', 'smap-l4-surface', 'smap-l4-root'], ['soil moisture', 'umidade do solo', 'umidade', 'moisture', 'smap', 'soil water', 'agua no solo']],
  [['imerg-daily', 'imerg-30min'], ['precipitation', 'precipitacao', 'rainfall', 'rain', 'chuva', 'chuvas', 'imerg']],
  [['lst-terra', 'lst-aqua'], ['land surface temperature', 'surface temperature', 'temperature', 'temperatura', 'lst']],
  [['ndvi-8day', 'ndvi-monthly'], ['ndvi', 'vegetation', 'vegetacao', 'crop condition', 'crop conditions', 'condicao da lavoura']],
  [['evi-8day'], ['evi']],
  [['grace-mascon'], ['grace', 'groundwater', 'agua subterranea', 'water storage']],
]

export function resolveLayer(name: string): string | null {
  const catalog = useMapStore.getState().catalog
  const exact = catalog.find((entry) => entry.id === name.trim())
  if (exact) return exact.id
  for (const [ids, words] of LAYER_ALIASES) {
    if (!words.some((word) => hasWord(name, word))) continue
    return ids.find((id) => catalog.some((entry) => entry.id === id)) ?? ids[0]
  }
  return null
}

function regionFields(regionId: RegionId, fields: readonly FieldSummary[]): { id: string; name: string }[] {
  return regionAdapter(regionId).fixtureIds.map((id) => ({ id, name: fields.find((f) => f.id === id)?.name ?? id }))
}

function currentFieldName(fields: readonly FieldSummary[]): string | null {
  const state = useMapStore.getState()
  if (state.selectedFieldId) return fields.find((f) => f.id === state.selectedFieldId)?.name ?? state.selectedFieldId
  if (state.selectedPolygonId !== null) return String(state.selectedPolygonId)
  return null
}

function hasSelection(): boolean {
  const state = useMapStore.getState()
  return state.selectedFieldId !== null || state.selectedPolygonId !== null
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isRealDate(iso: string): boolean {
  const match = ISO_DATE.exec(iso)
  if (!match) return false
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

// ----- tools ------------------------------------------------------------------------------------

type Outcome = Omit<MapToolResult, 'tool' | 'effect' | 'mapStateVersion'> & { changed?: boolean }

type ToolSpec = {
  effect: ToolEffect
  /** Null when the arguments have the right shape; otherwise the reason. */
  validate: (args: Record<string, unknown>) => string | null
  run: (args: Record<string, unknown>, env: ExecutionEnv) => Outcome
}

const str = (value: unknown, max = 80): value is string => typeof value === 'string' && value.length <= max
const onlyKeys = (args: Record<string, unknown>, keys: string[]) => Object.keys(args).every((key) => keys.includes(key))

function metricList(value: unknown): MetricVar[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return null
  if (!value.every((item) => typeof item === 'string' && (METRIC_VARS as readonly string[]).includes(item))) return null
  return [...new Set(value as MetricVar[])]
}

const TOOLS: Record<MapToolName, ToolSpec> = {
  select_region: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['region']) && str(args.region) ? null : 'region'),
    run: (args, env) => {
      const name = String(args.region).trim()
      const options = PLACE_OPTIONS
      if (name === '') return { status: 'needs_clarification', code: 'region_ambiguous', params: { options } }
      const place = resolvePlace(name)
      if (place === 'unavailable') return { status: 'failed', code: 'region_not_available', params: { name, options } }
      if (place === null) return { status: 'failed', code: 'region_unknown', params: { name, options } }
      const state = useMapStore.getState()
      const label = PLACES[place].label
      let changed = false
      if (state.regionId !== 'us') {
        state.setRegionId('us')
        changed = true
      }
      // A county is opened by selecting its first field: the map flies to it and the panel reads it.
      const inPlace = placeFields(place, 'us', env.fields)
      const current = useMapStore.getState().selectedFieldId
      if (inPlace.length > 0 && (current === null || !inPlace.includes(current))) {
        useMapStore.getState().selectField(inPlace[0])
        changed = true
      }
      return changed
        ? { status: 'success', code: 'region_selected', params: { place: label }, changed: true }
        : { status: 'success', code: 'region_already', params: { place: label } }
    },
  },

  select_field: {
    effect: 'visual',
    validate: (args) => {
      if (!onlyKeys(args, ['field', 'field_id'])) return 'keys'
      if (args.field_id !== undefined && !(str(args.field_id, 64) && /^[A-Za-z0-9:_-]+$/.test(args.field_id))) return 'field_id'
      if (args.field !== undefined && !(str(args.field) || (typeof args.field === 'number' && Number.isInteger(args.field)))) return 'field'
      return args.field === undefined && args.field_id === undefined ? 'missing' : null
    },
    run: (args, env) => {
      const state = useMapStore.getState()
      const options = regionFields(state.regionId, env.fields)
      const optionText = options.map((o) => o.name).join(', ')
      let target: { id: string; name: string } | undefined
      if (typeof args.field_id === 'string') {
        target = options.find((o) => o.id === args.field_id)
        if (!target) {
          const elsewhere = env.fields.find((f) => f.id === args.field_id)
          return elsewhere
            ? { status: 'failed', code: 'field_other_region', params: { name: elsewhere.name, options: optionText } }
            : { status: 'failed', code: 'field_unknown', params: { name: String(args.field_id), options: optionText } }
        }
      } else {
        const raw = String(args.field).trim()
        const asNumber = typeof args.field === 'number' ? args.field : /^\d{1,2}$/.test(raw) ? Number(raw) : null
        if (raw === 'current') {
          const name = currentFieldName(env.fields)
          if (name !== null) return { status: 'success', code: 'field_already', params: { name } }
          return { status: 'needs_clarification', code: 'field_which', params: { options: optionText } }
        }
        if (raw === 'first') target = options[0]
        else if (asNumber !== null) target = options[asNumber - 1]
        else target = options.find((o) => norm(o.name) === norm(raw)) ?? options.find((o) => norm(o.name).includes(norm(raw).trim() === '' ? '\u0000' : norm(raw)))
        if (!target) return { status: 'failed', code: 'field_unknown', params: { name: raw, options: optionText } }
      }
      if (state.selectedFieldId === target.id) return { status: 'success', code: 'field_already', params: { name: target.name } }
      state.selectField(target.id)
      return { status: 'success', code: 'field_selected', params: { name: target.name }, changed: true }
    },
  },

  focus_geometry: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['target', 'padding']) && (args.target === undefined || args.target === 'selected_field')
      && (args.padding === undefined || (typeof args.padding === 'number' && args.padding >= 0 && args.padding <= 200)) ? null : 'target'),
    run: (args, env) => {
      if (!hasSelection()) return { status: 'failed', code: 'focus_no_selection', params: {} }
      const seq = useMapStore.getState().requestFocus(typeof args.padding === 'number' ? args.padding : 48, env.insetRight ?? 0)
      return { status: 'success', code: 'focus_requested', params: { name: currentFieldName(env.fields) ?? '' }, focusSeq: seq, changed: true }
    },
  },

  highlight_evidence: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['target']) && str(args.target) ? null : 'target'),
    run: (args, env) => {
      // The only geometry evidence is tied to is the selected field's boundary: the climate values come
      // from a reanalysis cell around it. No other shape is drawn, so no area is invented.
      if (args.target !== 'selected_field') return { status: 'unsupported', code: 'highlight_unsupported_target', params: {} }
      if (!hasSelection()) return { status: 'failed', code: 'focus_no_selection', params: {} }
      const seq = useMapStore.getState().requestFocus(48, env.insetRight ?? 0)
      return { status: 'success', code: 'highlight_requested', params: { name: currentFieldName(env.fields) ?? '' }, focusSeq: seq, changed: true }
    },
  },

  set_date: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['date']) && str(args.date, 10) ? null : 'date'),
    run: (args) => {
      const date = String(args.date)
      if (!isRealDate(date)) return { status: 'failed', code: 'date_invalid', params: { date } }
      const state = useMapStore.getState()
      const { start, end } = state.axis
      if (date < start || date > end) return { status: 'failed', code: 'date_out_of_coverage', params: { date, start, end } }
      if (chosenDateOf(state) === date) return { status: 'success', code: 'date_already', params: { date } }
      state.setChosenDate(date)
      return { status: 'success', code: 'date_set', params: { date }, changed: true }
    },
  },

  set_analysis_window: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['days']) && typeof args.days === 'number' && Number.isInteger(args.days)
      && args.days >= 1 && args.days <= 366 ? null : 'days'),
    run: (args) => {
      // Block 6 (R-16) fixes the window at 42 days ending on the chosen date; there is no other window
      // to switch to, so a different length is reported instead of being faked.
      const days = Number(args.days)
      if (days === BLOCK6_WINDOW_DAYS) return { status: 'success', code: 'window_already', params: { days } }
      return { status: 'unsupported', code: 'window_fixed', params: { days, fixed: BLOCK6_WINDOW_DAYS } }
    },
  },

  show_layer: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['layer']) && str(args.layer) && String(args.layer).trim() !== '' ? null : 'layer'),
    run: (args) => {
      const state = useMapStore.getState()
      const options = state.catalog.filter((entry) => entry.status !== 'stale' && entry.kind !== 'stale').map((e) => e.label).join(', ')
      const id = resolveLayer(String(args.layer))
      const entry = id ? state.catalog.find((e) => e.id === id) : undefined
      if (!entry) return { status: 'failed', code: 'layer_not_in_catalog', params: { name: String(args.layer), options } }
      if (entry.status === 'stale' || entry.kind === 'stale') {
        return { status: 'failed', code: 'layer_stale', params: { label: entry.label, last: entry.last_observation ?? '' } }
      }
      if (entry.status === 'unavailable' || entry.status === 'none_in_lookback') {
        return { status: 'failed', code: 'layer_unavailable', params: { label: entry.label } }
      }
      if (state.on[entry.id]) return { status: 'success', code: 'layer_already_on', params: { label: entry.label } }
      state.setLayerOn(entry.id, true)
      return {
        status: 'success', code: 'layer_on', changed: true,
        params: { label: entry.label, date: entry.effective_date ?? '', resolution: entry.resolution },
      }
    },
  },

  hide_layer: {
    effect: 'visual',
    validate: (args) => (onlyKeys(args, ['layer']) && str(args.layer) && String(args.layer).trim() !== '' ? null : 'layer'),
    run: (args) => {
      const state = useMapStore.getState()
      const id = resolveLayer(String(args.layer))
      const entry = id ? state.catalog.find((e) => e.id === id) : undefined
      if (!entry) return { status: 'failed', code: 'layer_not_in_catalog', params: { name: String(args.layer), options: '' } }
      if (!state.on[entry.id]) return { status: 'success', code: 'layer_already_off', params: { label: entry.label } }
      state.setLayerOn(entry.id, false)
      return { status: 'success', code: 'layer_off', params: { label: entry.label }, changed: true }
    },
  },

  query_field_metrics: {
    effect: 'read',
    validate: (args) => (onlyKeys(args, ['metrics']) && metricList(args.metrics) ? null : 'metrics'),
    run: (args) => {
      const metrics = metricList(args.metrics) as MetricVar[]
      if (!hasSelection()) return { status: 'failed', code: 'query_no_field', params: {} }
      if (metrics.includes('vegetation')) return { status: 'unsupported', code: 'query_vegetation', params: {} }
      return { status: 'success', code: 'query_requested', params: { metrics: metrics.join(',') }, analysis: { kind: 'query', metrics } }
    },
  },

  compare_metrics: {
    effect: 'read',
    validate: (args) => (onlyKeys(args, ['metrics']) && metricList(args.metrics) ? null : 'metrics'),
    run: (args) => {
      const metrics = (metricList(args.metrics) as MetricVar[]).filter((m) => m !== 'overview' && m !== 'water_risk')
      if (metrics.length < 2) return { status: 'needs_clarification', code: 'compare_needs_two', params: {} }
      if (!hasSelection()) return { status: 'failed', code: 'query_no_field', params: {} }
      if (metrics.includes('vegetation')) return { status: 'unsupported', code: 'compare_vegetation', params: {} }
      return { status: 'success', code: 'compare_requested', params: { metrics: metrics.join(',') }, analysis: { kind: 'compare', metrics } }
    },
  },
}

export function isMapToolName(name: string): name is MapToolName {
  return (MAP_TOOL_NAMES as readonly string[]).includes(name)
}

const BLOCKING: MapToolName[] = ['select_region', 'select_field', 'set_date']
const CONTEXT_DEPENDENT: MapToolName[] = ['select_field', 'focus_geometry', 'highlight_evidence', 'query_field_metrics', 'compare_metrics', 'set_date']

function result(tool: string, effect: ToolEffect, outcome: Outcome): MapToolResult {
  const { changed, ...rest } = outcome
  if (changed && rest.status === 'success') mapStateVersion += 1
  return log({ tool, effect, mapStateVersion, ...rest })
}

/**
 * Runs a plan in order. A failed region, field or date stops the steps that depend on it (they are
 * reported as skipped, never run on the wrong context); layer steps do not depend on the field and
 * still run. An analysis with no field selected may select the region's first field when the caller
 * allows it, and that step is reported as automatic.
 */
export function executePlan(calls: readonly MapToolCall[], env: ExecutionEnv): MapToolResult[] {
  if (calls.length > MAX_PLAN_STEPS) {
    return [result('plan', 'read', { status: 'failed', code: 'plan_too_long', params: { max: MAX_PLAN_STEPS } })]
  }
  const results: MapToolResult[] = []
  let blocked = false
  for (const call of calls) {
    const name = typeof call?.tool === 'string' ? call.tool : ''
    if (!isMapToolName(name)) {
      results.push(result(name.slice(0, 40) || 'unknown', 'read', { status: 'failed', code: 'tool_not_allowed', params: { tool: name.slice(0, 40) } }))
      continue
    }
    const spec = TOOLS[name]
    if (blocked && CONTEXT_DEPENDENT.includes(name)) {
      results.push(result(name, spec.effect, { status: 'skipped', code: 'skipped_after_failure', params: {} }))
      continue
    }
    if (spec.effect === 'persistent' && !env.confirmed) {
      results.push(result(name, spec.effect, { status: 'needs_clarification', code: 'needs_confirmation', params: {} }))
      continue
    }
    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {}
    if (spec.validate(args) !== null) {
      results.push(result(name, spec.effect, { status: 'failed', code: 'invalid_arguments', params: {} }))
      if (BLOCKING.includes(name)) blocked = true
      continue
    }
    if ((name === 'query_field_metrics' || name === 'compare_metrics') && !hasSelection() && env.autoSelectField) {
      const auto = result('select_field', 'visual', TOOLS.select_field.run({ field: 'first' }, env))
      results.push({ ...auto, code: auto.status === 'success' ? 'field_auto_selected' : auto.code, automatic: true })
    }
    let outcome: Outcome
    try {
      outcome = spec.run(args, env)
    } catch {
      outcome = { status: 'failed', code: 'tool_error', params: {} }
    }
    const done = result(name, spec.effect, outcome)
    results.push(done)
    if (BLOCKING.includes(name) && done.status !== 'success') blocked = true
  }
  return results
}

/** The field the plan left selected, so the panel can tell its own change from a later manual one. */
export function selectionAfterPlan(): string | null {
  const state = useMapStore.getState()
  return state.selectedFieldId ?? (state.selectedPolygonId !== null ? String(state.selectedPolygonId) : null)
}
