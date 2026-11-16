/**
 * Deterministic Answer Adapter. A question is classified into one of five supported intents, and
 * the answer is assembled from catalog sentences filled only with Evidence values. Every number in
 * an answer is also in the answer's `evidence`. Nothing here calls a model or the network.
 *
 * The future agent replaces `classifyIntent` with model tool selection and keeps the tools:
 * `summaryEvidence`, `gapsOf`, `cropWaterFor` and the same AssistantResponse shape (`mode: 'agent'`).
 */
import type { NumbersPayload } from '@/lib/numbers'
import type { Locale } from '@/strings'
import { at, type AssistantKey } from '@/strings/assistant'
import { cropWaterEvidence, cropWaterFor, etcDifferences, cropWaterPeriod } from './crop-water'
import { gapStatusKey, gapsOf, metricLabelKey, sectionKey, summaryEvidence, SUMMARY_METRICS } from './evidence'
import { formatDate, formatList, formatNumber, formatResolution, formatValue } from './format'
import { cropsAskedFor, plantingWindowsFor, type PlantingWindow } from './planting'
import type { MetricVar } from './map-tools'
import type { AssistantResponse, CropWaterSet, Evidence, FieldContext, Intent, LimitationCode } from './types'

/**
 * Intent families, tried in order on the normalised question (lower case, no accents, no punctuation,
 * padded with spaces so ` et0 ` matches a whole word). The order settles overlaps:
 *  1. asking what is missing beats every topic ("what is missing for a more reliable recommendation");
 *  2. planting-window words beat a crop choice ("when can I plant corn" is about the window);
 *  3. water demand beats a crop choice ("which crop uses more water" is a comparison of evidence);
 *  4. a crop choice is matched before rain and conditions, and is answered by naming what is missing;
 *  5. rain words before the general conditions, so a rain question gets the rain answer.
 */
const KEYWORDS: [Intent, string[]][] = [
  ['missing', ['falta', 'faltam', 'faltando', 'missing', 'lacuna', ' gap', 'mais confiavel', 'mais confiaveis',
    'more reliable', 'would make', 'what else', 'precisaria', 'precisa saber', 'need to know', 'informacoes necessarias',
    'information is needed', 'information needed', 'not available']],
  // "janela" alone is not enough: the analysis window is also a "janela" ("quanto choveu nesta janela").
  ['planting', ['janela de plantio', 'janelas de plantio', 'janela de semeadura', 'janelas de semeadura', 'janela do zarc',
    'dentro da janela', 'fora da janela', 'significa essa janela', 'significa esta janela', 'significa a janela',
    'planting window', 'sowing window', 'window mean', 'inside the window', 'within the window', 'outside the window',
    'calendario', 'calendar', 'quando posso plantar', 'quando plantar', 'quando semear', 'quando devo plantar',
    'when can i plant', 'when to plant', 'when should i plant', 'when can i sow', 'when to sow', 'when do farmers plant',
    'typical planting', 'usual planting', 'zarc', 'plantio', 'semeadura', 'planting date', 'sowing date',
    'epoca de plantio']],
  ['water_demand', ['agua', 'water', 'hidric', 'evapotransp', ' et0 ', ' etc ', ' kc ', 'irrig', 'demanda', 'demand',
    'consumo', 'consume', 'uses more', 'usa mais', 'gasta mais']],
  ['recommendation', ['devo plantar', 'devo cultivar', 'devo semear', 'o que plantar', 'qual plantar', 'melhor cultura',
    'qual cultura', 'recomend', 'should i plant', 'should i grow', 'should i sow', 'what to plant', 'what should i plant',
    'which crop', 'best crop', 'recommend', 'vale a pena plantar']],
  ['rainfall', ['chuva', 'chov', 'precipita', ' rain', 'rainfall', 'estiagem', 'drought', 'veranico', 'seca ',
    'dry spell', 'molhad', ' wet']],
  ['sources', ['fonte', 'source', 'origem', 'origin', 'where does', 'come from', 'de onde', 'proveni', 'provenance',
    'nasa', 'confiar', 'trust', 'como foi calculado', 'how was', 'how is this calculated']],
  ['missing', ['ausente', 'indisponi', 'unavailable', 'limitac', 'limitation', 'incerteza', 'uncertaint']],
  ['environment', ['ambient', 'environment', 'condic', 'condition', 'clima', 'climate', 'temperat', 'calor', ' hot',
    'heat', 'geada', 'frost', 'frio', 'cold', 'indicador', 'indicator', 'solo', 'soil', 'umidade', 'moisture',
    'tempo ', 'weather', 'seca', ' dry']],
  ['explain_field', ['expli', 'explain', 'propriedade', 'field', 'talhao', 'fazenda', 'farm', 'resum', 'summar',
    'overview', 'visao geral', 'descrev', 'describe', 'what is this', 'o que e isso', 'o que e este']],
]

export function normalise(text: string): string {
  return ` ${text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

export function classifyIntent(question: string): Intent {
  const text = normalise(question)
  for (const [intent, words] of KEYWORDS) {
    if (words.some((word) => text.includes(word))) return intent
  }
  return 'unsupported'
}

/** "Was there enough rain?": rain alone cannot answer it, so the rain answer adds the caveat. */
function asksSufficiency(question: string | undefined): boolean {
  if (!question) return false
  const text = normalise(question)
  return ['suficiente', 'enough', 'sufficient', 'bastou', 'basta', 'adequad'].some((word) => text.includes(word))
}

export type AnswerInput = {
  context: FieldContext & { center: [number, number] | null }
  locale: Locale
  id: string
  /** The question as asked, for the crop it names or a sufficiency caveat. Optional: intents need no text. */
  question?: string
  /** For `compare`: the variables a map command named, in its order. */
  metrics?: MetricVar[]
}

function payloadOf(context: FieldContext): NumbersPayload | null {
  return context.numbers.kind === 'ready' || context.numbers.kind === 'held' ? context.numbers.payload : null
}

export function evidenceLabel(evidence: Evidence, locale: Locale): string {
  const [family, crop] = evidence.metric.split('.')
  if (family === 'et0_total') return at(locale, 'metric.et0_total')
  if (family === 'rain_week') return at(locale, 'metric.rain_week', { n: crop ?? '' })
  if (family === 'planting_window') return at(locale, 'metric.planting_window', { crop: String(evidence.value ?? '') })
  if (family === 'kc_mid') return at(locale, 'metric.kc_mid', { crop: crop ? at(locale, `crop.${crop}` as AssistantKey) : '' })
  if (family === 'etc_difference') {
    const [, first, second] = evidence.metric.split('.')
    return at(locale, 'metric.etc_difference', {
      first: at(locale, `crop.${first}` as AssistantKey), second: at(locale, `crop.${second}` as AssistantKey).toLocaleLowerCase(locale),
    })
  }
  if (family === 'etc_total' || family === 'rain_minus_etc') {
    const cropName = crop ? at(locale, `crop.${crop}` as AssistantKey) : ''
    return at(locale, family === 'etc_total' ? 'metric.etc_total' : 'metric.rain_minus_etc', { crop: cropName })
  }
  const key = metricLabelKey(evidence.metric)
  return key ? at(locale, key) : evidence.metric
}

/** Crop ids as translated names: `cotton,soybean` -> `cotton and soybean` (lower case, sentence-internal). */
export function cropNames(ids: string, locale: Locale): string {
  return formatList(ids.split(',').filter(Boolean)
    .map((id) => at(locale, `crop.${id}` as AssistantKey).toLocaleLowerCase(locale)), locale)
}

/** A printed evidence value. Crop ids are translated; numbers use the item's decimals or Table A. */
export function evidenceValue(evidence: Evidence, locale: Locale): string {
  if (evidence.metric === 'highest_peak_demand' && typeof evidence.value === 'string') return cropNames(evidence.value, locale)
  if (evidence.metric === 'rain_vs_median' && typeof evidence.value === 'string') {
    return at(locale, `rain_cmp.${evidence.value}` as AssistantKey)
  }
  return formatValue(evidence.value, evidence.unit, evidence.metric, locale, evidence.decimals ?? undefined)
}

function regionName(regionId: string, locale: Locale): string {
  // The application mounts one region (`us`) since the strip cleanup; the argument stays for the
  // call sites, and any other value still labels the one region the app has.
  return at(locale, regionId === 'us' ? 'region.us' : 'region.us')
}

function unavailableReason(context: FieldContext, locale: Locale): string {
  switch (context.numbers.kind) {
    case 'ring_missing': return at(locale, 'status.ring_missing')
    case 'loading': return at(locale, 'status.loading')
    case 'error': return at(locale, 'status.error', { status: context.numbers.status })
    case 'offline': return at(locale, 'status.offline')
    default: return ''
  }
}

function collectLimitations(evidence: Evidence[]): LimitationCode[] {
  const seen = new Set<LimitationCode>()
  for (const item of evidence) for (const code of item.limitations) seen.add(code)
  return [...seen]
}

function respond(input: AnswerInput, intent: Intent, answer: string[], evidence: Evidence[],
  status: AssistantResponse['status'], extraLimitations: LimitationCode[] = []): AssistantResponse {
  const limitations = collectLimitations(evidence)
  for (const code of extraLimitations) if (!limitations.includes(code)) limitations.push(code)
  return {
    id: input.id,
    fieldId: input.context.fieldId,
    contextKey: input.context.key,
    locale: input.locale,
    intent,
    answer,
    evidence,
    limitations,
    status,
    mode: 'deterministic',
  }
}

function valueOf(evidence: Evidence[], metric: string): Evidence | null {
  const item = evidence.find((e) => e.metric === metric)
  return item && item.value !== null ? item : null
}

function printed(item: Evidence, locale: Locale): string {
  return formatValue(item.value, item.unit, item.metric, locale)
}

export function answerQuestion(question: string, input: AnswerInput): AssistantResponse {
  return answerIntent(classifyIntent(question), { ...input, question: input.question ?? question })
}

export function answerIntent(intent: Intent, input: AnswerInput): AssistantResponse {
  const { context, locale } = input
  if (intent === 'unsupported') return respond(input, intent, [at(locale, 'answer.unsupported')], [], 'unavailable')
  if (context.fieldId === null) return respond(input, intent, [at(locale, 'answer.no_field')], [], 'unavailable')

  const payload = payloadOf(context)
  if (intent === 'recommendation') return recommendationAnswer(input, payload)
  // Planting windows come from the calendar sources, not from block 6, so they answer without numbers.
  if (intent === 'planting') return plantingAnswer(input)
  if (payload === null) {
    // Without block 6 numbers not even the crop water window can be checked, so every intent
    // states why the numbers are missing (loading, offline, HTTP error, no ring).
    return respond(input, intent, [at(locale, 'answer.no_numbers', { reason: unavailableReason(context, locale) })], [], 'unavailable')
  }
  if (intent === 'water_demand') return waterAnswer(input, payload)
  const evidence = summaryEvidence(payload, context.fieldId)
  switch (intent) {
    case 'explain_field': return explainAnswer(input, payload, evidence)
    case 'environment': return environmentAnswer(input, evidence)
    case 'rainfall': return rainfallAnswer(input, payload, [...evidence, ...summaryEvidence(payload, context.fieldId, ['rain_rank'])])
    case 'sources': return sourcesAnswer(input, evidence)
    case 'missing': return missingAnswer(input, payload)
    case 'compare': return compareAnswer(input, payload, [...evidence, ...summaryEvidence(payload, context.fieldId, ['rain_rank'])])
    case 'water_risk': return waterRiskAnswer(input, payload, evidence)
  }
}

function windowLine(payload: NumbersPayload, locale: Locale, key: AssistantKey = 'answer.compare.window'): string | null {
  const window = payload.query.window
  return window?.start && window?.end
    ? at(locale, key, { start: formatDate(window.start, locale), end: formatDate(window.end, locale), days: window.days ?? '' })
    : null
}

/**
 * Two or three variables over the same block 6 window. Each is described against its own baseline when
 * block 6 holds one (rain: 1991-2025 median and percentile; hot days: median). Root-zone wetness has no
 * baseline in block 6, so it is printed without "above" or "below". No causal link is drawn.
 */
function compareAnswer(input: AnswerInput, payload: NumbersPayload, evidence: Evidence[]): AssistantResponse {
  const { locale } = input
  const vars = (input.metrics ?? ['rain', 'soil_moisture']).filter((m) => m === 'rain' || m === 'soil_moisture' || m === 'temperature')
  const used: Evidence[] = []
  const take = (metric: string) => {
    const item = valueOf(evidence, metric)
    if (item) used.push(item)
    return item
  }
  const lines: string[] = []
  const window = windowLine(payload, locale)
  if (window) lines.push(window)
  const missing: string[] = []
  for (const variable of vars) {
    if (variable === 'rain') {
      const rain = take('rain_total')
      const median = take('rain_median')
      const percentile = take('rain_percentile')
      if (!rain) missing.push(at(locale, 'metricvar.rain'))
      else if (median && percentile) {
        const p = Number(percentile.value)
        lines.push(at(locale, p <= 20 ? 'answer.compare.rain_low' : p >= 80 ? 'answer.compare.rain_high' : 'answer.compare.rain_mid', {
          value: printed(rain, locale), median: printed(median, locale), percentile: formatNumber(p, 0, locale),
        }))
      } else lines.push(at(locale, 'answer.compare.rain_plain', { value: printed(rain, locale) }))
    }
    if (variable === 'soil_moisture') {
      const soil = take('gwetroot_mean')
      if (soil) lines.push(at(locale, 'answer.compare.soil', { value: printed(soil, locale) }))
      else missing.push(at(locale, 'metricvar.soil_moisture'))
    }
    if (variable === 'temperature') {
      const hot = take('hot_days')
      const hotMedian = take('hot_days_median')
      if (hot && hotMedian) lines.push(at(locale, 'answer.compare.hot', { value: printed(hot, locale), median: printed(hotMedian, locale) }))
      else if (hot) lines.push(at(locale, 'answer.env.hot', { value: printed(hot, locale) }))
      else missing.push(at(locale, 'metricvar.temperature'))
    }
  }
  if (used.length === 0) return respond(input, 'compare', [at(locale, 'answer.env.none')], [], 'unavailable')
  if (missing.length > 0) lines.push(at(locale, 'answer.env.missing', { metrics: formatList(missing, locale) }))
  lines.push(at(locale, 'answer.compare.not_causal'))
  if (vars.includes('soil_moisture')) lines.push(at(locale, 'answer.compare.layer_note'))
  return respond(input, 'compare', lines, used, missing.length > 0 ? 'partial' : 'answered', ['historical_not_forecast'])
}

/**
 * The water signals of the window, conclusion first. "Clearest signal" is only said of an indicator with a
 * historical baseline in block 6 (rain percentile), using the same fifths the rain answer uses; the rest
 * are listed as context. Not a forecast, an irrigation requirement or a yield risk.
 */
function waterRiskAnswer(input: AnswerInput, payload: NumbersPayload, evidence: Evidence[]): AssistantResponse {
  const { locale } = input
  const used: Evidence[] = []
  const take = (metric: string) => {
    const item = valueOf(evidence, metric)
    if (item) used.push(item)
    return item
  }
  const lines: string[] = []
  const rain = take('rain_total')
  const median = take('rain_median')
  const percentile = take('rain_percentile')
  if (rain && median && percentile) {
    const p = Number(percentile.value)
    const vars = { value: printed(rain, locale), median: printed(median, locale), percentile: formatNumber(p, 0, locale) }
    lines.push(at(locale, p <= 20 ? 'answer.risk.lead_dry' : p >= 80 ? 'answer.risk.lead_wet' : 'answer.risk.lead_none', vars))
  } else if (rain) {
    lines.push(at(locale, 'answer.risk.lead_no_baseline', { value: printed(rain, locale) }))
  }
  const dry = take('dry_spell_days')
  if (dry) lines.push(at(locale, 'answer.env.dry', { value: printed(dry, locale) }))
  const hot = take('hot_days')
  const hotMedian = take('hot_days_median')
  if (hot && hotMedian) lines.push(at(locale, 'answer.compare.hot', { value: printed(hot, locale), median: printed(hotMedian, locale) }))
  const soil = take('gwetroot_mean')
  if (soil) lines.push(at(locale, 'answer.compare.soil', { value: printed(soil, locale) }))
  if (used.length === 0) return respond(input, 'water_risk', [at(locale, 'answer.env.none')], [], 'unavailable')
  const window = windowLine(payload, locale, 'answer.risk.window')
  if (window) lines.push(window)
  lines.push(at(locale, 'answer.risk.scope'))
  return respond(input, 'water_risk', lines, used, median && percentile ? 'answered' : 'partial', ['historical_not_forecast'])
}

function explainAnswer(input: AnswerInput, payload: NumbersPayload, evidence: Evidence[]): AssistantResponse {
  const { context, locale } = input
  const region = regionName(context.regionId, locale)
  const lines: string[] = []
  lines.push(context.kind === 'fixture' && context.name
    ? at(locale, 'answer.explain.fixture', { name: context.name, location: context.location ?? '', region })
    : at(locale, 'answer.explain.polygon', { id: context.fieldId ?? '', region }))
  const window = payload.query.window
  if (window?.start && window?.end) {
    lines.push(at(locale, 'answer.explain.window', {
      start: formatDate(window.start, locale), end: formatDate(window.end, locale),
      days: window.days ?? '', date: formatDate(context.date, locale),
    }))
  }
  const available = evidence.filter((e) => e.value !== null).length
  lines.push(at(locale, 'answer.explain.counts', { available, total: SUMMARY_METRICS.length, gaps: gapsOf(payload, context.fieldId ?? '').length }))
  lines.push(at(locale, 'answer.explain.no_ranking'))
  if (context.kind === 'fixture') lines.push(at(locale, 'answer.explain.fixture_scenarios'))
  lines.push(at(locale, 'answer.explain.next'))
  const shown = evidence.filter((e) => ['rain_total', 'dry_spell_days', 'hot_days'].includes(e.metric))
  return respond(input, 'explain_field', lines, shown, available === 0 ? 'partial' : 'answered')
}

function environmentAnswer(input: AnswerInput, evidence: Evidence[]): AssistantResponse {
  const { locale } = input
  const lines: string[] = []
  const used: Evidence[] = []
  const take = (metric: string) => {
    const item = valueOf(evidence, metric)
    if (item) used.push(item)
    return item
  }
  const rain = take('rain_total')
  const median = take('rain_median')
  const percentile = take('rain_percentile')
  if (rain) {
    let sentence = at(locale, 'answer.env.rain', { value: printed(rain, locale) })
    if (median && percentile) {
      sentence += ` ${at(locale, 'answer.env.rain_normal', { median: printed(median, locale), percentile: formatNumber(Number(percentile.value), 0, locale) })}`
    } else if (median) {
      sentence += ` ${at(locale, 'answer.env.rain_median_only', { median: printed(median, locale) })}`
    }
    lines.push(sentence)
  }
  const dry = take('dry_spell_days')
  if (dry) lines.push(at(locale, 'answer.env.dry', { value: printed(dry, locale) }))
  const hot = take('hot_days')
  const hotMedian = take('hot_days_median')
  if (hot) {
    let sentence = at(locale, 'answer.env.hot', { value: printed(hot, locale) })
    if (hotMedian) sentence += ` ${at(locale, 'answer.env.hot_median', { median: printed(hotMedian, locale) })}`
    lines.push(sentence)
  }
  const tmin = take('tmin_min')
  const frost = take('frost_days')
  if (tmin && frost) lines.push(at(locale, 'answer.env.tmin', { value: printed(tmin, locale), frost: formatNumber(Number(frost.value), 0, locale) }))
  const soil = take('gwetroot_mean')
  if (soil) lines.push(at(locale, 'answer.env.soil', { value: printed(soil, locale) }))
  const wb = take('wb_remaining')
  if (wb) lines.push(at(locale, 'answer.env.wb', { value: printed(wb, locale) }))

  const climateMetrics = ['rain_total', 'dry_spell_days', 'hot_days', 'tmin_min', 'gwetroot_mean', 'wb_remaining']
  const missing = climateMetrics.filter((m) => !valueOf(evidence, m)).map((m) => {
    const key = metricLabelKey(m)
    return key ? at(locale, key) : m
  })
  if (lines.length === 0) {
    return respond(input, 'environment', [at(locale, 'answer.env.none')], [], 'unavailable')
  }
  if (missing.length > 0) lines.push(at(locale, 'answer.env.missing', { metrics: formatList(missing, locale) }))
  lines.push(at(locale, 'answer.env.closing'))
  return respond(input, 'environment', lines, used, missing.length > 0 ? 'partial' : 'answered')
}

const CROP_IDS: [RegExp, string][] = [[/\b(milho|corn|maize)\b/, 'maize'], [/\b(soja|soy|soybeans?)\b/, 'soybean'], [/\b(algodao|cotton)\b/, 'cotton']]

/** The crop ids a question names, in the order it names them. */
function cropIdsIn(question: string | undefined): string[] {
  if (!question) return []
  const text = normalise(question)
  return CROP_IDS.map(([pattern, id]) => ({ id, at: text.search(pattern) })).filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at).map((c) => c.id)
}

function waterAnswer(input: AnswerInput, payload: NumbersPayload): AssistantResponse {
  const { context, locale } = input
  const set = cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload)
  if (set === null) {
    const period = cropWaterPeriod()
    if (period === null) {
      // The route has not answered for this field yet, so no window and no crop water is claimed.
      return respond(input, 'water_demand', [
        at(locale, 'answer.water.unavailable'),
        at(locale, 'answer.water.demo_hint'),
      ], [], 'unavailable')
    }
    return respond(input, 'water_demand', [
      at(locale, 'answer.water.unavailable'),
      at(locale, 'answer.water.why', { start: formatDate(period.start, locale), end: formatDate(period.end, locale) }),
      at(locale, 'answer.water.demo_hint'),
    ], [], 'unavailable')
  }
  const evidence = cropWaterEvidence(set)
  const mm = (value: number | null) => formatValue(value, 'mm', 'rain_total', locale)
  const name = (cropId: string) => at(locale, `crop.${cropId}` as AssistantKey)
  const lower = (cropId: string) => name(cropId).toLocaleLowerCase(locale)
  const capitalise = (text: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
  // "o milho", "a soja" in Portuguese; the bare noun in English.
  const withArticle = (cropId: string) => at(locale, `crop_art.${cropId}` as AssistantKey)
  const crops = set.crops.filter((c) => c.etcTotalMm !== null)
  const lines: string[] = []

  // 1. The conclusion first: the pair the question names, else maize against soybean, the headline pair.
  const asked = cropIdsIn(input.question).filter((id) => crops.some((c) => c.cropId === id))
  const pair = asked.length >= 2 ? [asked[0], asked[1]] : ['maize', 'soybean'].filter((id) => crops.some((c) => c.cropId === id))
  if (pair.length === 2) {
    const diff = etcDifferences(set).find((d) => (d.first === pair[0] && d.second === pair[1]) || (d.first === pair[1] && d.second === pair[0]))
    if (diff) {
      const higherId = diff.mm >= 0 ? diff.first : diff.second
      const lowerId = higherId === diff.first ? diff.second : diff.first
      const hi = crops.find((c) => c.cropId === higherId)!
      const lo = crops.find((c) => c.cropId === lowerId)!
      const pct = Math.round((Math.abs(diff.mm) / (lo.etcTotalMm as number)) * 1000) / 10
      lines.push(diff.mm === 0
        ? at(locale, 'answer.water.diff_equal', { a: capitalise(withArticle(pair[0])), b: withArticle(pair[1]), etc: mm(hi.etcTotalMm), kc: formatNumber(hi.kc.mid, 2, locale) })
        : at(locale, 'answer.water.diff', {
          a: capitalise(withArticle(higherId)), b: withArticle(lowerId), diff: mm(Math.abs(diff.mm)), pct: `${formatNumber(pct, 1, locale)}%`,
          kcA: formatNumber(hi.kc.mid, 2, locale), kcB: formatNumber(lo.kc.mid, 2, locale),
        }))
    }
  }
  // 2. The window, ET0 and rain, then each crop.
  const first = set.crops[0]
  lines.push(at(locale, 'answer.water.intro', {
    name: context.name ?? context.fieldId ?? '',
    start: formatDate(set.period.start, locale), end: formatDate(set.period.end, locale),
    et0: mm(first?.et0TotalMm ?? null), rain: mm(first?.rainTotalMm ?? null),
  }))
  for (const crop of set.crops) {
    lines.push(at(locale, 'answer.water.crop', {
      crop: name(crop.cropId), etc: mm(crop.etcTotalMm), kc: formatNumber(crop.kc.mid, 2, locale), diff: mm(crop.rainMinusEtcMm),
    }))
  }
  if (crops.length > 0) {
    const top = Math.max(...crops.map((c) => c.etcTotalMm as number))
    const leaders = crops.filter((c) => c.etcTotalMm === top).map((c) => lower(c.cropId))
    lines.push(leaders.length === 1
      ? at(locale, 'answer.water.highest', { crop: leaders[0] })
      : at(locale, 'answer.water.tie', { crops: formatList(leaders, locale) }))
    const byValue = new Map<number, string[]>()
    for (const c of crops) if (c.etcTotalMm !== top) byValue.set(c.etcTotalMm as number, [...(byValue.get(c.etcTotalMm as number) ?? []), lower(c.cropId)])
    for (const names of byValue.values()) {
      if (names.length > 1) lines.push(capitalise(at(locale, 'answer.water.tie_lower', { crops: formatList(names, locale) })))
    }
  }
  // 3. Why they differ, then what the comparison is not.
  lines.push(at(locale, 'answer.water.kc'))
  lines.push(at(locale, 'answer.water.caveat'))
  const complete = set.crops.every((c) => c.state === 'ok' && c.etcTotalMm !== null && c.rainMinusEtcMm !== null)
  return { ...respond(input, 'water_demand', lines, evidence, complete ? 'answered' : 'partial', ['needs_sowing_date']), cropWater: set }
}

/**
 * Rain against the 1991-2025 median of the same calendar dates. The conclusion comes first and is a
 * comparison of two block 6 values made here, in code; the percentile is explained as a rank among
 * past years, never as a probability or a forecast.
 */
function rainfallAnswer(input: AnswerInput, payload: NumbersPayload, evidence: Evidence[]): AssistantResponse {
  const { context, locale } = input
  const used: Evidence[] = []
  const take = (metric: string) => {
    const item = valueOf(evidence, metric)
    if (item) used.push(item)
    return item
  }
  const rain = take('rain_total')
  if (!rain) return respond(input, 'rainfall', [at(locale, 'answer.rain.none')], [], 'unavailable')
  const median = take('rain_median')
  const percentile = take('rain_percentile')
  const rank = take('rain_rank')
  const lines: string[] = []
  const window = payload.query.window
  const period = window?.start && window?.end
    ? at(locale, 'answer.rain.period', { start: formatDate(window.start, locale), end: formatDate(window.end, locale) })
    : ''
  if (median) {
    const diff = Math.round((Number(rain.value) - Number(median.value)) * 10) / 10
    const pct = Number(median.value) !== 0 ? Math.round(Math.abs(diff / Number(median.value)) * 100) : null
    const vars = {
      rain: printed(rain, locale), median: printed(median, locale), period,
      diff: formatValue(Math.abs(diff), 'mm', 'rain_total', locale), pct: pct === null ? '' : `${formatNumber(pct, 0, locale)}%`,
    }
    lines.push(at(locale, diff < 0 ? 'answer.rain.below' : diff > 0 ? 'answer.rain.above' : 'answer.rain.equal', vars))
    if (percentile) {
      const p = Number(percentile.value)
      lines.push(rank
        ? at(locale, 'answer.rain.rank', { percentile: formatNumber(p, 0, locale), rank: formatNumber(Number(rank.value), 0, locale) })
        : at(locale, 'answer.rain.percentile', { percentile: formatNumber(p, 0, locale) }))
      if (p <= 20) lines.push(at(locale, 'answer.rain.driest'))
      else if (p >= 80) lines.push(at(locale, 'answer.rain.wettest'))
      lines.push(at(locale, 'answer.rain.percentile_meaning'))
    }
  } else {
    lines.push(at(locale, 'answer.rain.no_normal', { rain: printed(rain, locale), period }))
  }
  const dry = take('dry_spell_days')
  if (dry) lines.push(at(locale, 'answer.env.dry', { value: printed(dry, locale) }))
  if (asksSufficiency(input.question)) {
    lines.push(at(locale, 'answer.rain.enough'))
    const set = cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload)
    if (set) {
      const balance = set.crops.filter((c) => c.rainMinusEtcMm !== null).map((c) => at(locale, 'answer.rain.balance_item', {
        crop: at(locale, `crop.${c.cropId}` as AssistantKey).toLocaleLowerCase(locale),
        value: formatValue(c.rainMinusEtcMm, 'mm', 'rain_total', locale),
      }))
      lines.push(at(locale, 'answer.rain.enough_water', { items: formatList(balance, locale) }))
      used.push(...cropWaterEvidence(set).filter((e) => e.metric.startsWith('rain_minus_etc.')))
    }
  }
  lines.push(at(locale, 'answer.rain.closing'))
  return respond(input, 'rainfall', lines, used, median ? 'answered' : 'partial')
}

/** Planting windows: ZARC in Brazil, NASS usual dates in the United States, never a picked date. */
function plantingAnswer(input: AnswerInput): AssistantResponse {
  const { context, locale } = input
  if (context.fieldId === null) return respond(input, 'planting', [at(locale, 'answer.no_field')], [], 'unavailable')
  const result = plantingWindowsFor(context)
  if (result.kind === 'no_source') return respond(input, 'planting', [at(locale, 'answer.plant.no_source')], [], 'unavailable')
  if (result.kind === 'season_not_held') {
    return respond(input, 'planting', [at(locale, 'answer.plant.season_not_held', {
      season: result.season, seasons: formatList(result.held, locale),
    })], [], 'unavailable')
  }
  const asked = cropsAskedFor(normalise(input.question ?? ''))
  const shown: PlantingWindow[] = asked ? result.windows.filter((w) => asked.crops.includes(w.crop)) : result.windows
  const lines: string[] = []
  const date = formatDate(context.date, locale)
  lines.push(result.kind === 'br'
    ? at(locale, 'answer.plant.br_intro', { place: `${result.municipality} (${result.uf})`, season: result.season })
    : at(locale, 'answer.plant.us_intro'))
  if (asked && shown.length === 0) lines.push(at(locale, 'answer.plant.crop_missing', { crop: formatList(asked.words, locale) }))
  for (const w of shown) {
    if (w.start === null || w.end === null || w.position === null) {
      lines.push(at(locale, 'answer.plant.row_none', { crop: w.crop }))
      continue
    }
    lines.push(at(locale, 'answer.plant.row', {
      crop: w.crop, start: formatDate(w.start, locale), end: formatDate(w.end, locale), date,
      position: at(locale, `plant.pos.${w.position}` as AssistantKey),
    }))
  }
  lines.push(at(locale, result.kind === 'br' ? 'answer.plant.br_meaning' : 'answer.plant.us_meaning'))
  lines.push(at(locale, 'answer.plant.closing'))
  lines.push(at(locale, 'answer.plant.calendar_hint'))
  const evidence = shown.map((w) => w.evidence).filter((e): e is Evidence => e !== null)
  return respond(input, 'planting', lines, evidence, evidence.length > 0 ? 'answered' : 'partial')
}

function recommendationAnswer(input: AnswerInput, payload: NumbersPayload | null): AssistantResponse {
  const { context, locale } = input
  const lines = [at(locale, 'answer.reco.intro'), at(locale, 'answer.reco.have')]
  const set: CropWaterSet | null = payload ? cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload) : null
  let evidence: Evidence[] = []
  if (set) {
    const totals = set.crops.filter((c) => c.etcTotalMm !== null)
    const top = Math.max(...totals.map((c) => c.etcTotalMm as number))
    const leaders = totals.filter((c) => c.etcTotalMm === top).map((c) => c.cropId).join(',')
    lines.push(at(locale, 'answer.reco.water', { crop: cropNames(leaders, locale) }))
    evidence = cropWaterEvidence(set).filter((e) => e.metric.startsWith('etc_total.'))
  }
  lines.push(at(locale, 'answer.reco.window'), at(locale, 'answer.reco.missing'), at(locale, 'answer.reco.closing'))
  // The peak-coefficient caveat belongs only to an answer that shows a crop water estimate.
  const limits: LimitationCode[] = ['comparator_not_built', 'planting_window_not_decision', 'needs_farm_records', 'historical_not_forecast']
  if (set) limits.splice(2, 0, 'needs_sowing_date')
  return respond(input, 'recommendation', lines, evidence, 'partial', limits)
}

function sourcesAnswer(input: AnswerInput, evidence: Evidence[]): AssistantResponse {
  const { locale } = input
  const withValue = evidence.filter((e) => e.value !== null)
  if (withValue.length === 0) return respond(input, 'sources', [at(locale, 'answer.sources.none')], [], 'unavailable')
  const bySource = new Map<string, Evidence[]>()
  for (const item of withValue) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item])
  const lines = [at(locale, 'answer.sources.intro', { count: withValue.length })]
  for (const [source, items] of bySource) {
    const bases = [...new Set(items.map((i) => at(locale, `basis.${i.basis}` as AssistantKey)))]
    const resolutions = [...new Set(items.map((i) => (i.resolution ? formatResolution(i.resolution, locale) : '')))].filter(Boolean)
    lines.push(at(locale, 'answer.sources.item', {
      source,
      metrics: formatList(items.map((i) => evidenceLabel(i, locale)), locale),
      basis: formatList(bases, locale),
      resolution: resolutions.join('; '),
    }))
  }
  lines.push(at(locale, 'answer.sources.provenance'))
  return respond(input, 'sources', lines, withValue, 'answered')
}

function missingAnswer(input: AnswerInput, payload: NumbersPayload): AssistantResponse {
  const { context, locale } = input
  const gaps = gapsOf(payload, context.fieldId ?? '')
  const lines: string[] = []
  if (gaps.length === 0) {
    lines.push(at(locale, 'answer.missing.none'))
  } else {
    lines.push(at(locale, 'answer.missing.intro', { count: gaps.length }))
    for (const gap of gaps) {
      const { key, vars } = gapStatusKey(gap.status)
      lines.push(at(locale, 'answer.missing.gap', { section: at(locale, sectionKey(gap.section)), status: at(locale, key, vars) }))
    }
  }
  const set = cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload)
  if (set === null) lines.push(at(locale, 'answer.water.unavailable'))
  lines.push(at(locale, 'answer.missing.not_built'))
  return respond(input, 'missing', lines, [], 'answered')
}
