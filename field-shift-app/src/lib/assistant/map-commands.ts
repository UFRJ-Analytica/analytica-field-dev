/**
 * Deterministic command interpreter (Field Shift AI, mode B). It recognises a fixed set of map commands
 * in English and Portuguese and turns them into calls of the Geospatial Agent Tools. It is deliberately
 * narrow: a clause becomes a command only when it has an action verb and a target the catalogs know, so
 * questions such as "Was rainfall below normal?" keep going to the question answers.
 *
 * A message is split into clauses at commas, semicolons, "then/depois" and "and/e" followed by a verb,
 * so "Open Cass County, show precipitation for the last 30 days and explain the water risk" becomes three
 * clauses planned in order.
 */
import { LAYER_ALIASES, norm, REGION_ALIASES, type MapToolCall, type MetricVar } from './map-tools'

export type CommandPlan = {
  calls: MapToolCall[]
  /** Clauses that matched nothing, kept so the panel can say what it did not do. */
  unmatched: string[]
  /** The variable the last analysis or layer was about, for "and how does it compare to ...". */
  topic: MetricVar | null
}

const VERBS = [
  'open', 'show', 'display', 'go', 'go to', 'go back', 'return', 'take me', 'switch', 'focus', 'zoom', 'center', 'centre',
  'select', 'choose', 'pick', 'hide', 'remove', 'turn', 'compare', 'explain', 'analyse', 'analyze', 'highlight', 'add',
  'abra', 'abrir', 'abre', 'mostre', 'mostra', 'mostrar', 'exiba', 'exibir', 'va', 'vai', 'volte', 'voltar', 'ir', 'leve',
  'troque', 'mude', 'centralize', 'centralizar', 'centraliza', 'enquadre', 'foque', 'aproxime', 'selecione', 'selecionar',
  'escolha', 'oculte', 'ocultar', 'esconda', 'desative', 'desligue', 'remova', 'ative', 'ligue', 'compare', 'comparar',
  'explique', 'explicar', 'analise', 'analisar', 'destaque', 'destacar', 'marque', 'adicione',
]

const OPEN = ['open', 'show', 'show me', 'go to', 'go back to', 'return to', 'take me to', 'switch to', 'focus on', 'zoom to',
  'abra', 'abrir', 'abre', 'mostre', 'mostra', 'mostrar', 'va para', 'vai para', 'volte para', 'volte a', 'voltar para',
  'ir para', 'leve me para', 'troque para', 'mude para', 'exiba']
const SHOW = ['show', 'show me', 'display', 'turn on', 'add', 'see', 'mostre', 'mostra', 'mostrar', 'exiba', 'exibir', 'ative',
  'ligue', 'adicione', 'ver', 'veja']
const HIDE = ['hide', 'remove', 'turn off', 'oculte', 'ocultar', 'esconda', 'desative', 'desligue', 'remova', 'tire']
const SELECT = ['select', 'choose', 'pick', 'selecione', 'selecionar', 'escolha', 'use']
const FIELD_WORDS = ['field', 'campo', 'property', 'propriedade', 'farm', 'fazenda', 'talhao', 'plot']
const FOCUS = ['center', 'centre', 'centralize', 'centralizar', 'centraliza', 'enquadre', 'frame', 'focus', 'foque',
  'zoom in', 'aproxime', 'fit']
const HIGHLIGHT = ['highlight', 'destaque', 'destacar', 'marque', 'show on the map where', 'mostre no mapa onde',
  'where is the problem', 'onde esta o problema']
const COMPARE = ['compare', 'comparar', 'compara', 'comparacao', 'comparison', 'versus', 'vs']
const RISK = ['main risk', 'water risk', 'risco hidrico', 'principal risco', 'risco principal', 'drought risk', 'risco de seca',
  'the risk', 'o risco']
const ANALYSE = ['analyse', 'analyze', 'analise', 'analisar', 'analysis', 'analisa']
const DATA_WORDS = ['data', 'dados', 'indicators', 'indicadores', 'numbers', 'numeros']
const PLACE_WORDS = ['region', 'regiao', 'county', 'condado', 'municipio', 'area', 'place', 'lugar', 'city', 'cidade', 'state', 'estado']
const THIS_WORDS = ['this field', 'that field', 'este campo', 'neste campo', 'esse campo', 'nesse campo', 'this property',
  'esta propriedade', 'nesta propriedade', 'my field', 'my property', 'my farm', 'minha propriedade', 'meu campo',
  'minha fazenda', 'o campo', 'the field', 'a propriedade']

const METRIC_WORDS: [MetricVar, string[]][] = [
  ['soil_moisture', ['soil moisture', 'umidade do solo', 'umidade', 'moisture', 'smap', 'soil water']],
  ['rain', ['rainfall', 'rain', 'precipitation', 'precipitacao', 'chuva', 'chuvas', 'imerg']],
  ['temperature', ['temperature', 'temperatura', 'heat', 'calor']],
  ['vegetation', ['vegetation', 'vegetacao', 'ndvi', 'evi', 'crop condition', 'crop conditions']],
]

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, janeiro: 1, february: 2, feb: 2, fevereiro: 2, fev: 2, march: 3, mar: 3, marco: 3,
  april: 4, apr: 4, abril: 4, abr: 4, may: 5, maio: 5, mai: 5, june: 6, jun: 6, junho: 6, july: 7, jul: 7, julho: 7,
  august: 8, aug: 8, agosto: 8, ago: 8, september: 9, sep: 9, sept: 9, setembro: 9, set: 9, october: 10, oct: 10,
  outubro: 10, out: 10, november: 11, nov: 11, novembro: 11, december: 12, dec: 12, dezembro: 12, dez: 12,
}

const has = (text: string, phrases: string[]) => phrases.some((phrase) => text.includes(` ${phrase} `))

function metricsIn(text: string): MetricVar[] {
  const found: { metric: MetricVar; at: number }[] = []
  for (const [metric, words] of METRIC_WORDS) {
    const positions = words.map((w) => text.indexOf(` ${w} `)).filter((i) => i >= 0)
    if (positions.length > 0) found.push({ metric, at: Math.min(...positions) })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.metric)
}

function layerWordIn(text: string): boolean {
  return LAYER_ALIASES.some(([, words]) => has(text, words))
}

function regionIn(text: string): string | null {
  for (const aliases of Object.values(REGION_ALIASES)) {
    const hit = aliases.find((alias) => text.includes(` ${alias} `))
    if (hit) return hit
  }
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A date in the clause, as `YYYY-MM-DD` (not checked for validity here), or null. */
export function dateIn(raw: string, defaultYear: number): string | null {
  const text = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text)
  if (m) return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-z]+)(?:\.)?(?:,?\s+(?:de\s+)?(\d{4}))?\b/.exec(text)
  if (m && MONTHS[m[2]] !== undefined) return `${m[3] ?? defaultYear}-${pad(MONTHS[m[2]])}-${pad(Number(m[1]))}`
  m = /\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/.exec(text)
  if (m && MONTHS[m[1]] !== undefined) return `${m[3] ?? defaultYear}-${pad(MONTHS[m[1]])}-${pad(Number(m[2]))}`
  return null
}

function windowDaysIn(text: string): number | null {
  const m = /\b(?:last|past|ultimos|ultimas|previous)\s+(\d{1,3})\s+(?:days|dias)\b/.exec(text)
  return m ? Number(m[1]) : null
}

/** The clauses of a message, split before a verb so "rainfall and soil moisture" stays one clause. */
export function clausesOf(message: string): string[] {
  const verbs = VERBS.map((v) => v.replace(/ /g, '\\s+')).join('|')
  // A comma before a year ("November 15, 2026") or a dot inside a number does not end a clause.
  const splitter = new RegExp(`\\s*(?:(?:,(?!\\s*\\d{4}\\b)|[;!?]|\\.(?!\\d))+|\\bthen\\b|\\bdepois\\b|\\b(?:and|e)\\s+(?:then\\s+|depois\\s+)?(?=(?:${verbs})\\b))\\s*`, 'i')
  return message.split(splitter).map((c) => c?.trim() ?? '').filter((c) => c.length > 0)
}

function placeAfterOpen(text: string): string | null {
  const verb = OPEN.find((v) => text.startsWith(` ${v} `) || text.includes(` ${v} `))
  if (!verb) return null
  const rest = text.slice(text.indexOf(` ${verb} `) + verb.length + 2).replace(/ (on|in) the map | no mapa | na tela /g, ' ')
  const name = rest.replace(/^ *(the|o|a|os|as) /, ' ').trim()
  return name.length > 0 && name.length <= 40 ? name : null
}

/**
 * Plans one message. `topic` is the variable of the previous command, used when a comparison names
 * one variable and refers to the other ("And how does that compare to soil moisture?").
 */
export function planCommand(message: string, options: { defaultYear: number; topic: MetricVar | null }): CommandPlan {
  const calls: MapToolCall[] = []
  const unmatched: string[] = []
  let topic = options.topic
  const push = (tool: string, args: Record<string, unknown>) => calls.push({ tool, arguments: args })

  for (const clause of clausesOf(message)) {
    const text = norm(clause)
    const before = calls.length
    const metrics = metricsIn(text)
    const date = dateIn(clause, options.defaultYear)
    const windowDays = windowDaysIn(text)

    if (has(text, HIDE) && (layerWordIn(text) || has(text, ['layer', 'camada']))) {
      const word = LAYER_ALIASES.flatMap(([, w]) => w).find((w) => text.includes(` ${w} `))
      push('hide_layer', { layer: word ?? clause })
    } else if (has(text, COMPARE) && metrics.length > 0) {
      // One variable named: the other is what the conversation was about ("compare it with rainfall").
      const vars = [...metrics]
      if (vars.length === 1 && topic && topic !== vars[0]) vars.unshift(topic)
      if (windowDays !== null) push('set_analysis_window', { days: windowDays })
      push('compare_metrics', { metrics: vars })
      topic = vars[vars.length - 1] ?? topic
    } else if (has(text, RISK)) {
      if (windowDays !== null) push('set_analysis_window', { days: windowDays })
      push('query_field_metrics', { metrics: ['water_risk'] })
    } else if (has(text, HIGHLIGHT)) {
      push('highlight_evidence', { target: 'selected_field' })
    } else if (has(text, FOCUS) && (has(text, FIELD_WORDS) || has(text, THIS_WORDS) || has(text, ['map', 'mapa']))) {
      push('focus_geometry', { target: 'selected_field', padding: 48 })
    } else if (has(text, SELECT) && has(text, FIELD_WORDS)) {
      const number = /\b(?:field|campo|talhao|plot|property|propriedade)\s+0?(\d{1,2})\b/.exec(text)
      const named = /\b(cass field|field)\s+0?(\d{1,2})\b/.exec(text)
      if (number || named) push('select_field', { field: Number((number ?? named)![named && !number ? 2 : 1]) })
      else if (has(text, ['first', 'primeiro', 'primeira'])) push('select_field', { field: 'first' })
      else push('select_field', { field: 'current' })
    } else if (date !== null && (has(text, OPEN) || has(text, DATA_WORDS) || has(text, ['date', 'data', 'dia', 'day']))) {
      push('set_date', { date })
      if (has(text, DATA_WORDS) || has(text, SHOW)) push('query_field_metrics', { metrics: ['overview'] })
    } else if (regionIn(text) && (has(text, OPEN) || text.trim().split(' ').length <= 3)) {
      push('select_region', { region: regionIn(text) })
    } else if (has(text, SHOW) && layerWordIn(text)) {
      const word = LAYER_ALIASES.flatMap(([, w]) => w).find((w) => text.includes(` ${w} `)) as string
      push('show_layer', { layer: word })
      const metric = metrics.find((m) => m === 'rain' || m === 'soil_moisture' || m === 'temperature')
      if (windowDays !== null) push('set_analysis_window', { days: windowDays })
      if (metric) {
        push('query_field_metrics', { metrics: [metric] })
        topic = metric
      }
    } else if (windowDays !== null && (has(text, ANALYSE) || has(text, SHOW) || has(text, DATA_WORDS))) {
      push('set_analysis_window', { days: windowDays })
      push('query_field_metrics', { metrics: ['overview'] })
    } else if (has(text, SHOW) && has(text, ['layer', 'camada'])) {
      push('show_layer', { layer: placeAfterOpen(text)?.replace(/ (layer|camada) | (layer|camada)$/g, ' ').trim() || clause })
    } else if (has(text, OPEN) && (has(text, PLACE_WORDS) || has(text, ['map', 'mapa']))) {
      // A place the catalog does not know, or no place at all: the tool answers with the regions it has.
      const name = placeAfterOpen(text)
      const bare = name === null || PLACE_WORDS.some((w) => ` ${name} `.includes(` ${w} `)) && name.split(' ').length <= 2
      push('select_region', { region: bare ? '' : name })
    }
    if (calls.length === before) unmatched.push(clause)
  }
  return { calls, unmatched, topic }
}
