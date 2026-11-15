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
import { cropWaterEvidence, cropWaterFor, snapshotPeriod } from './crop-water'
import { gapStatusKey, gapsOf, metricLabelKey, sectionKey, summaryEvidence, SUMMARY_METRICS } from './evidence'
import { formatDate, formatList, formatNumber, formatResolution, formatValue } from './format'
import type { AssistantResponse, Evidence, FieldContext, Intent, LimitationCode } from './types'

const KEYWORDS: [Intent, string[]][] = [
  // A request for a decision is matched first: it is answered by naming what is missing, never by a pick.
  ['recommendation', ['devo plantar', 'devo cultivar', 'o que plantar', 'qual plantar', 'melhor cultura', 'recomend',
    'should i plant', 'should i grow', 'what to plant', 'which crop should', 'best crop', 'recommend']],
  ['water_demand', ['agua', 'water', 'hidric', 'evapotransp', 'et0', 'etc ', 'irrig', 'demanda', 'demand']],
  ['sources', ['fonte', 'source', 'origem', 'origin', 'where does', 'come from', 'de onde', 'proveni', 'provenance']],
  ['missing', ['falta', 'faltam', 'faltando', 'missing', 'lacuna', 'gap', 'ausente', 'indisponi', 'unavailable']],
  ['environment', ['ambient', 'environment', 'condic', 'condition', 'clima', 'climate', 'chuva', 'rain', 'temperat',
    'indicador', 'indicator', 'seca', 'dry', 'calor', 'hot', 'solo', 'soil', 'umidade', 'moisture']],
  ['explain_field', ['expli', 'explain', 'propriedade', 'field', 'talhao', 'fazenda', 'farm', 'resum', 'summar',
    'overview', 'visao geral', 'descrev', 'describe']],
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

export type AnswerInput = {
  context: FieldContext & { center: [number, number] | null }
  locale: Locale
  id: string
}

function payloadOf(context: FieldContext): NumbersPayload | null {
  return context.numbers.kind === 'ready' || context.numbers.kind === 'held' ? context.numbers.payload : null
}

export function evidenceLabel(evidence: Evidence, locale: Locale): string {
  const [family, crop] = evidence.metric.split('.')
  if (family === 'et0_total') return at(locale, 'metric.et0_total')
  if (family === 'rain_week') return at(locale, 'metric.rain_week', { n: crop ?? '' })
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
  return formatValue(evidence.value, evidence.unit, evidence.metric, locale, evidence.decimals ?? undefined)
}

function regionName(regionId: string, locale: Locale): string {
  return at(locale, regionId === 'br' ? 'region.br' : 'region.us')
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
  return answerIntent(classifyIntent(question), input)
}

export function answerIntent(intent: Intent, input: AnswerInput): AssistantResponse {
  const { context, locale } = input
  if (intent === 'unsupported') return respond(input, intent, [at(locale, 'answer.unsupported')], [], 'unavailable')
  if (context.fieldId === null) return respond(input, intent, [at(locale, 'answer.no_field')], [], 'unavailable')

  const payload = payloadOf(context)
  if (intent === 'recommendation') return recommendationAnswer(input, payload)
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
    case 'sources': return sourcesAnswer(input, evidence)
    case 'missing': return missingAnswer(input, payload)
  }
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

function waterAnswer(input: AnswerInput, payload: NumbersPayload): AssistantResponse {
  const { context, locale } = input
  const set = cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload)
  if (set === null) {
    const period = snapshotPeriod()
    return respond(input, 'water_demand', [
      at(locale, 'answer.water.unavailable'),
      at(locale, 'answer.water.why', { start: formatDate(period.start, locale), end: formatDate(period.end, locale) }),
    ], [], 'unavailable')
  }
  const evidence = cropWaterEvidence(set)
  const mm = (value: number | null) => formatValue(value, 'mm', 'rain_total', locale)
  const crops = set.crops.filter((c) => c.etcTotalMm !== null)
  const first = set.crops[0]
  const lines = [at(locale, 'answer.water.intro', {
    name: context.name ?? context.fieldId ?? '',
    start: formatDate(set.period.start, locale), end: formatDate(set.period.end, locale),
    et0: mm(first?.et0TotalMm ?? null), rain: mm(first?.rainTotalMm ?? null),
  })]
  for (const crop of set.crops) {
    lines.push(at(locale, 'answer.water.crop', {
      crop: at(locale, `crop.${crop.cropId}` as AssistantKey),
      etc: mm(crop.etcTotalMm), kc: formatNumber(crop.kc.mid, 2, locale), diff: mm(crop.rainMinusEtcMm),
    }))
  }
  if (crops.length > 0) {
    // Crop names are common nouns: lower case inside a sentence, capitalised only at its start.
    const inSentence = (cropId: string) => at(locale, `crop.${cropId}` as AssistantKey).toLocaleLowerCase(locale)
    const capitalise = (text: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
    const top = Math.max(...crops.map((c) => c.etcTotalMm as number))
    const leaders = crops.filter((c) => c.etcTotalMm === top).map((c) => inSentence(c.cropId))
    lines.push(leaders.length === 1
      ? at(locale, 'answer.water.highest', { crop: leaders[0] })
      : at(locale, 'answer.water.tie', { crops: formatList(leaders, locale) }))
    const byValue = new Map<number, string[]>()
    for (const c of crops) if (c.etcTotalMm !== top) byValue.set(c.etcTotalMm as number, [...(byValue.get(c.etcTotalMm as number) ?? []), inSentence(c.cropId)])
    for (const names of byValue.values()) {
      if (names.length > 1) lines.push(capitalise(at(locale, 'answer.water.tie_lower', { crops: formatList(names, locale) })))
    }
  }
  lines.push(at(locale, 'answer.water.caveat'))
  const complete = set.crops.every((c) => c.state === 'ok' && c.etcTotalMm !== null && c.rainMinusEtcMm !== null)
  return respond(input, 'water_demand', lines, evidence, complete ? 'answered' : 'partial')
}

function recommendationAnswer(input: AnswerInput, payload: NumbersPayload | null): AssistantResponse {
  const { context, locale } = input
  const lines = [at(locale, 'answer.reco.intro'), at(locale, 'answer.reco.have')]
  const set = payload ? cropWaterFor({ fieldId: context.fieldId ?? '', kind: context.kind, center: context.center }, payload) : null
  let evidence: Evidence[] = []
  if (set) {
    const totals = set.crops.filter((c) => c.etcTotalMm !== null)
    const top = Math.max(...totals.map((c) => c.etcTotalMm as number))
    const leaders = totals.filter((c) => c.etcTotalMm === top).map((c) => c.cropId).join(',')
    lines.push(at(locale, 'answer.reco.water', { crop: cropNames(leaders, locale) }))
    evidence = cropWaterEvidence(set).filter((e) => e.metric.startsWith('etc_total.'))
  }
  lines.push(at(locale, 'answer.reco.missing'), at(locale, 'answer.reco.closing'))
  return respond(input, 'recommendation', lines, evidence, 'partial',
    ['comparator_not_built', 'planting_calendar_not_integrated', 'needs_sowing_date', 'needs_farm_records', 'historical_not_forecast'])
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
