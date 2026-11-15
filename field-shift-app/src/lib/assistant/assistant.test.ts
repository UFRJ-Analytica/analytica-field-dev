import { describe, expect, it } from 'vitest'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import { assistantEn, assistantPtBR, at, type AssistantKey } from '@/strings/assistant'
import { translationKeyFor, type Locale } from '@/strings'
import { en } from '@/strings/en'
import type { NumbersPayload } from '@/lib/numbers'
import { answerIntent, answerQuestion, classifyIntent, evidenceLabel, evidenceValue } from './answers'
import { cropWaterFor } from './crop-water'
import { gapStatusKey, summaryEvidence } from './evidence'
import { formatDate, formatResolution, formatValue } from './format'
import type { FieldContext } from './types'

const LOCALES: Locale[] = ['en', 'pt-BR']
const FIELD_01_CENTER: [number, number] = [-55.27, -11.91]

function context(overrides: Partial<FieldContext & { center: [number, number] | null }> = {},
  payload: NumbersPayload | null = recordedNumbersPayload()): FieldContext & { center: [number, number] | null } {
  return {
    fieldId: RECORDED_FIELD_ID,
    kind: 'fixture',
    name: 'Field 01',
    location: 'Santa Carmem, Mato Grosso',
    center: FIELD_01_CENTER,
    regionId: 'br',
    date: '2026-11-12',
    key: `${RECORDED_FIELD_ID}|2026-11-12|none`,
    numbers: payload ? { kind: 'ready', payload, cached: false } : { kind: 'offline' },
    polygonGeometry: null,
    ...overrides,
  }
}

const placeholders = (text: string) => [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort()

describe('the assistant catalog', () => {
  it('has the same keys in English and Portuguese', () => {
    expect(Object.keys(assistantPtBR).sort()).toEqual(Object.keys(assistantEn).sort())
  })

  it('translates every key and keeps the same placeholders', () => {
    for (const key of Object.keys(assistantEn) as AssistantKey[]) {
      const en = assistantEn[key]
      const pt = assistantPtBR[key]
      if (en !== '') expect(pt, key).not.toBe('')
      expect(placeholders(pt), key).toEqual(placeholders(en))
    }
  })

  it('translates the user-facing sentences rather than copying the English', () => {
    const same = (Object.keys(assistantEn) as AssistantKey[])
      .filter((key) => assistantEn[key] === assistantPtBR[key] && assistantEn[key].length > 3)
    // Language-neutral only: the product name, a unit symbol and two templates made of placeholders.
    expect(same.sort()).toEqual(['ai.name', 'answer.missing.gap', 'answer.sources.item', 'unit.g_kg'])
  })

  it('does not take over the reverse lookup of strings the app already had', () => {
    expect(translationKeyFor('SMAP soil moisture')).not.toMatch(/^assistant\./)
    expect(translationKeyFor('Soybean')).toBe('common.crop.soybean')
    expect(translationKeyFor('Source')).not.toMatch(/^assistant\./)
  })

  it('registers English strings in the app catalog, without unit symbols (block 6 R-11)', () => {
    expect(en['assistant.ai.subtitle' as keyof typeof en]).toBe('Agricultural assistant')
    expect(Object.keys(en).filter((key) => key.startsWith('assistant.unit.'))).toEqual([])
  })

  it('uses the exact unavailable sentences of the brief', () => {
    expect(at('pt-BR', 'answer.water.unavailable')).toBe('A comparação de demanda hídrica por cultura ainda não está disponível para esta propriedade.')
    expect(at('en', 'answer.water.unavailable')).toBe('Crop-specific water demand comparison is not yet available for this field.')
  })
})

describe('locale formatting', () => {
  it('formats numbers with the locale separator and block 6 decimals', () => {
    expect(formatValue(171.93, 'mm', 'rain_total', 'pt-BR')).toBe('171,9 mm')
    expect(formatValue(171.93, 'mm', 'rain_total', 'en')).toBe('171.9 mm')
    expect(formatValue(12788611, 'ha', 'state_soy_ha', 'pt-BR')).toBe('12.788.611 ha')
    expect(formatValue(12788611, 'ha', 'state_soy_ha', 'en')).toBe('12,788,611 ha')
    expect(formatValue(7, 'days', 'dry_spell_days', 'pt-BR')).toBe('7 dias')
    expect(formatValue(21.77, 'C', 'tmin_min', 'en')).toBe('21.8 °C')
  })

  it('never prints a missing value as zero', () => {
    expect(formatValue(null, 'mm', 'rain_total', 'en')).toBe('no value')
    expect(formatValue(null, 'mm', 'rain_total', 'pt-BR')).toBe('sem valor')
    expect(formatValue(Number.NaN, 'mm', 'rain_total', 'en')).toBe('no value')
  })

  it('formats dates per locale in UTC', () => {
    expect(formatDate('2026-10-01', 'en')).toBe('Oct 1, 2026')
    expect(formatDate('2026-10-01', 'pt-BR')).toMatch(/^1 de out\.? de 2026$/)
  })

  it('rewrites known resolutions in Portuguese and keeps the numbers', () => {
    expect(formatResolution('0.5 degree cell (meteorology), 1 degree cell (solar)', 'pt-BR'))
      .toBe('célula de 0,5° (meteorologia), célula de 1° (radiação solar)')
    expect(formatResolution('about 0.5 degree cell', 'pt-BR')).toBe('célula de cerca de 0,5°')
    expect(formatResolution('250 m static model', 'pt-BR')).toBe('modelo estático de 250 m')
    expect(formatResolution('about 0.5 degree cell', 'en')).toBe('about 0.5 degree cell')
  })
})

describe('question classification', () => {
  it.each([
    ['Quais são as condições ambientais desta propriedade?', 'environment'],
    ['Qual cultura apresenta maior demanda de água?', 'water_demand'],
    ['De onde vêm esses dados?', 'sources'],
    ['Quais informações ainda faltam?', 'missing'],
    ['Explique esta propriedade.', 'explain_field'],
    ['What are the environmental conditions of this field?', 'environment'],
    ['Which crop has a higher estimated water demand?', 'water_demand'],
    ['Where does this data come from?', 'sources'],
    ['What information is still missing?', 'missing'],
    ['Explain this field.', 'explain_field'],
    ['What will the soybean price be next year?', 'unsupported'],
  ])('%s -> %s', (question, intent) => {
    expect(classifyIntent(question)).toBe(intent)
  })
})

describe('milestone 2 questions in the deterministic fallback', () => {
  it.each([
    ['Quais são os principais indicadores ambientais desta propriedade?', 'environment'],
    ['Como foi a distribuição das chuvas?', 'environment'],
    ['O milho apresenta maior demanda hídrica que a soja?', 'water_demand'],
    ['Por que essa análise não é suficiente para determinar a melhor cultura?', 'recommendation'],
    ['Quais informações faltam para avaliar minha próxima safra?', 'missing'],
    ['De onde vêm os dados apresentados?', 'sources'],
    ['What are the main environmental indicators for this field?', 'environment'],
    ['How was rainfall distributed?', 'environment'],
    ['Does corn have a higher estimated water demand than soybean?', 'water_demand'],
    ['Why is this analysis insufficient to determine the best crop?', 'recommendation'],
    ['What information is missing to evaluate my next growing season?', 'missing'],
    ['Where does this data come from?', 'sources'],
    ['Com esses dados, qual cultura devo plantar?', 'recommendation'],
    ['With this data, which crop should I plant?', 'recommendation'],
  ])('%s -> %s', (question, intent) => {
    expect(classifyIntent(question)).toBe(intent)
  })

  it.each(LOCALES)('declines a crop choice with the same evidence and limits (%s)', (locale) => {
    const response = answerIntent('recommendation', { context: context(), locale, id: 'a' })
    expect(response.status).toBe('partial')
    expect(response.limitations).toEqual(expect.arrayContaining(['comparator_not_built', 'planting_calendar_not_integrated']))
    expect(response.evidence.map((e) => e.metric).sort()).toEqual(['etc_total.cotton', 'etc_total.maize', 'etc_total.soybean'])
  })

  it('labels and prints the agent-derived metrics', () => {
    const week = { ...summaryEvidence(recordedNumbersPayload(), RECORDED_FIELD_ID)[0], id: 'rain_week.3', metric: 'rain_week.3', value: 12.04, decimals: 1 }
    expect(evidenceLabel(week, 'pt-BR')).toBe('Chuva, semana 3')
    expect(evidenceValue(week, 'pt-BR')).toBe('12,0 mm')
    const top = { ...week, id: 'crop_water.highest_peak_demand', metric: 'highest_peak_demand', value: 'cotton,soybean', unit: null }
    expect(evidenceValue(top, 'pt-BR')).toBe('algodão e soja')
    expect(evidenceValue(top, 'en')).toBe('cotton and soybean')
  })
})

describe('evidence', () => {
  it('keeps the unit, source, period and basis of the block 6 rows', () => {
    const payload = recordedNumbersPayload()
    const rain = summaryEvidence(payload, RECORDED_FIELD_ID).find((e) => e.metric === 'rain_total')!
    expect(rain.value).toBe(payload.provenance.find((row) => row.metric === 'rain_total')!.value)
    expect(rain.unit).toBe('mm')
    expect(rain.source).toContain('power.larc.nasa.gov')
    expect(rain.period).toEqual({ start: '2026-10-01', end: '2026-11-11' })
    expect(rain.basis).toBe('modelled')
    expect(rain.limitations).toContain('coarse_cell')
    const percentile = summaryEvidence(recordedNumbersPayload(), RECORDED_FIELD_ID).find((e) => e.metric === 'rain_percentile')!
    expect(percentile.basis).toBe('derived')
    expect(percentile.sourceBasis).toBe('modelled')
  })

  it('keeps a null value null', () => {
    const payload = recordedNumbersPayload()
    payload.provenance = payload.provenance.map((row) => (row.metric === 'hot_days' ? { ...row, value: null } : row))
    const hot = summaryEvidence(payload, RECORDED_FIELD_ID).find((e) => e.metric === 'hot_days')!
    expect(hot.value).toBeNull()
  })

  it('returns nothing for a payload of another field', () => {
    expect(summaryEvidence(recordedNumbersPayload(), 'mt-santa-carmem-02')).toEqual([])
  })

  it('maps gap status codes to catalog keys and never to raw text', () => {
    expect(gapStatusKey('coverage below 80 percent').key).toBe('gap.coverage_80')
    expect(gapStatusKey('503')).toEqual({ key: 'gap.http', vars: { status: '503' } })
    expect(gapStatusKey('something new').key).toBe('gap.other')
  })
})

describe('answers in both languages', () => {
  const intents = ['explain_field', 'environment', 'water_demand', 'sources', 'missing'] as const

  it.each(intents)('%s carries the same evidence in English and Portuguese', (intent) => {
    const en = answerIntent(intent, { context: context(), locale: 'en', id: 'a' })
    const pt = answerIntent(intent, { context: context(), locale: 'pt-BR', id: 'a' })
    expect(pt.evidence).toEqual(en.evidence)
    expect(pt.status).toBe(en.status)
    expect(pt.limitations).toEqual(en.limitations)
    expect(pt.answer.join(' ')).not.toEqual(en.answer.join(' '))
    expect(en.mode).toBe('deterministic')
  })

  it.each(LOCALES)('never shows an internal key or an unfilled placeholder (%s)', (locale) => {
    for (const intent of [...intents, 'unsupported'] as const) {
      const text = answerIntent(intent, { context: context(), locale, id: 'a' }).answer.join(' ')
      expect(text).not.toMatch(/\b(answer|ai|ctx|status|metric|limit|gap|section|crop|unit)\.[a-z_]+/)
      expect(text).not.toMatch(/\{[a-z_]+\}/)
    }
  })

  it('prints the environment numbers with the locale separator', () => {
    const pt = answerQuestion('Quais são as condições ambientais desta propriedade?', { context: context(), locale: 'pt-BR', id: 'a' })
    expect(pt.answer.join(' ')).toContain('171,9 mm')
    expect(pt.answer.join(' ')).toContain('224,9 mm')
    const en = answerQuestion('What are the environmental conditions of this field?', { context: context(), locale: 'en', id: 'a' })
    expect(en.answer.join(' ')).toContain('171.9 mm')
  })

  it('cites in every answer only numbers that are in its evidence', () => {
    const response = answerIntent('environment', { context: context(), locale: 'en', id: 'a' })
    const numbers = response.answer.join(' ').match(/\d+(?:\.\d+)?/g) ?? []
    const allowed = new Set(['1', '35', '1991', '2025', '0', ...response.evidence.flatMap((e) => {
      const v = formatValue(e.value, e.unit, e.metric, 'en')
      return v.match(/\d+(?:\.\d+)?/g) ?? []
    })])
    for (const n of numbers) expect(allowed.has(n), n).toBe(true)
  })

  it('does not recommend a crop or a rotation', () => {
    for (const locale of LOCALES) {
      for (const intent of intents) {
        const text = answerIntent(intent, { context: context(), locale, id: 'a' }).answer.join(' ').toLowerCase()
        expect(text).not.toMatch(/\b(you should|we recommend|recomendamos|você deve|plante|plant)\b/)
      }
    }
  })

  it('answers without a field by asking for one', () => {
    const response = answerIntent('environment', { context: context({ fieldId: null, kind: null, numbers: { kind: 'no_field' } }), locale: 'pt-BR', id: 'a' })
    expect(response.status).toBe('unavailable')
    expect(response.evidence).toEqual([])
    expect(response.answer[0]).toBe(at('pt-BR', 'answer.no_field'))
  })

  it('declares unavailable data instead of inventing it', () => {
    const response = answerIntent('environment', { context: context({}, null), locale: 'en', id: 'a' })
    expect(response.status).toBe('unavailable')
    expect(response.evidence).toEqual([])
    expect(response.answer[0]).toContain('unreachable')
  })

  it('answers an unsupported question with the supported list and no evidence', () => {
    const response = answerQuestion('Qual será o preço da soja?', { context: context(), locale: 'pt-BR', id: 'a' })
    expect(response.intent).toBe('unsupported')
    expect(response.status).toBe('unavailable')
    expect(response.evidence).toEqual([])
  })
})

describe('crop water demand (recorded FAO-56 experiment)', () => {
  it('is released for field 01 and the snapshot window only, marked as a recorded demonstration', () => {
    const set = cropWaterFor({ fieldId: RECORDED_FIELD_ID, kind: 'fixture', center: FIELD_01_CENTER }, recordedNumbersPayload())
    expect(set?.origin).toBe('experimental_snapshot')
    const response = answerIntent('water_demand', { context: context(), locale: 'en', id: 'a' })
    expect(response.status).toBe('answered')
    expect(response.evidence.every((e) => e.basis === 'fixture')).toBe(true)
    expect(response.limitations).toEqual(expect.arrayContaining(['experimental_snapshot', 'standard_kc', 'climatic_difference_not_irrigation']))
    const text = response.answer.join(' ')
    expect(text).toContain('Recorded experimental result')
    expect(text).toContain('maize has the highest estimated water demand')
    expect(text).toContain('Cotton and soybean have the same estimated demand at peak')
    const pt = answerIntent('water_demand', { context: context(), locale: 'pt-BR', id: 'a' }).answer.join(' ')
    expect(pt).toContain('a cultura com maior demanda hídrica estimada nesta janela é milho')
    expect(pt).toContain('Algodão e soja têm a mesma demanda estimada no pico')
    expect(text).toContain('not an irrigation requirement')
  })

  it('keeps ET0 and ETc apart', () => {
    const response = answerIntent('water_demand', { context: context(), locale: 'pt-BR', id: 'a' })
    const et0 = response.evidence.filter((e) => e.metric === 'et0_total')
    const etc = response.evidence.filter((e) => e.metric.startsWith('etc_total.'))
    expect(et0).toHaveLength(1)
    expect(etc.map((e) => e.metric).sort()).toEqual(['etc_total.cotton', 'etc_total.maize', 'etc_total.soybean'])
    expect(response.answer.join(' ')).toContain('197,6 mm')
  })

  it('is not attributed to another field, even one in the same climate cell', () => {
    const payload = { ...recordedNumbersPayload(), field_id: 'mt-santa-carmem-02' }
    const response = answerIntent('water_demand', {
      context: context({ fieldId: 'mt-santa-carmem-02', center: [-55.24, -11.94] }, payload), locale: 'pt-BR', id: 'a',
    })
    expect(response.status).toBe('unavailable')
    expect(response.evidence).toEqual([])
    expect(response.answer[0]).toBe('A comparação de demanda hídrica por cultura ainda não está disponível para esta propriedade.')
  })

  it('is not released for another window of the right field', () => {
    const payload = recordedNumbersPayload()
    payload.query = { ...payload.query, window: { ...payload.query.window, start: '2026-10-02', end: '2026-11-12' } }
    expect(cropWaterFor({ fieldId: RECORDED_FIELD_ID, kind: 'fixture', center: FIELD_01_CENTER }, payload)).toBeNull()
  })

  it('is not released for a polygon or without block 6 numbers', () => {
    expect(cropWaterFor({ fieldId: RECORDED_FIELD_ID, kind: 'polygon', center: FIELD_01_CENTER }, recordedNumbersPayload())).toBeNull()
    expect(cropWaterFor({ fieldId: RECORDED_FIELD_ID, kind: 'fixture', center: FIELD_01_CENTER }, null)).toBeNull()
  })
})
