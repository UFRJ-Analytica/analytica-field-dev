import { describe, expect, it } from 'vitest'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import { assistantEn, assistantPtBR, at, type AssistantKey } from '@/strings/assistant'
import { translationKeyFor, type Locale } from '@/strings'
import { en } from '@/strings/en'
import type { NumbersPayload } from '@/lib/numbers'
import { answerIntent, answerQuestion, classifyIntent, evidenceLabel, evidenceValue } from './answers'
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
    ['Como foi a distribuição das chuvas?', 'rainfall'],
    ['O milho apresenta maior demanda hídrica que a soja?', 'water_demand'],
    ['Por que essa análise não é suficiente para determinar a melhor cultura?', 'recommendation'],
    ['Quais informações faltam para avaliar minha próxima safra?', 'missing'],
    ['De onde vêm os dados apresentados?', 'sources'],
    ['What are the main environmental indicators for this field?', 'environment'],
    ['How was rainfall distributed?', 'rainfall'],
    ['Does corn have a higher estimated water demand than soybean?', 'water_demand'],
    ['Why is this analysis insufficient to determine the best crop?', 'recommendation'],
    ['What information is missing to evaluate my next growing season?', 'missing'],
    ['Where does this data come from?', 'sources'],
    ['Com esses dados, qual cultura devo plantar?', 'recommendation'],
    ['With this data, which crop should I plant?', 'recommendation'],
  ])('%s -> %s', (question, intent) => {
    expect(classifyIntent(question)).toBe(intent)
  })


  it('labels and prints the agent-derived metrics', () => {
    const week = { ...summaryEvidence(recordedNumbersPayload(), RECORDED_FIELD_ID)[0], id: 'rain_week.3', metric: 'rain_week.3', value: 12.04, decimals: 1 }
    expect(evidenceLabel(week, 'pt-BR')).toBe('Chuva, semana 3')
    expect(evidenceValue(week, 'pt-BR')).toBe('12,0 mm')
    const top = { ...week, id: 'crop_water.highest_peak_demand', metric: 'highest_peak_demand', value: 'cotton,soybean', unit: null }
    expect(evidenceValue(top, 'pt-BR')).toBe('algodão e soja')
    expect(evidenceValue(top, 'en')).toBe('cotton and soybean')
  })

  it('labels a planting window by its source crop name and prints a yearless period without a year', () => {
    const base = summaryEvidence(recordedNumbersPayload(), RECORDED_FIELD_ID)[0]
    const soja = { ...base, id: 'planting.soja.window', metric: 'planting_window', value: 'Soja', unit: null }
    expect(evidenceLabel(soja, 'pt-BR')).toBe('Janela de semeadura, Soja')
    expect(evidenceLabel(soja, 'en')).toBe('Sowing window, Soja')
    expect(formatDate('04-26', 'en')).toBe('Apr 26')
    expect(formatDate('2026-10-01', 'pt-BR')).toContain('2026')
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


describe('milestone 3: paraphrases reach the same intent', () => {
  it.each([
    // Rain, PT-BR and EN (the audit's failing phrasings included).
    ['Choveu pouco?', 'rainfall'],
    ['A chuva foi abaixo do normal?', 'rainfall'],
    ['Como está a precipitação?', 'rainfall'],
    ['A chuva recente foi suficiente?', 'rainfall'],
    ['O que a chuva recente indica?', 'rainfall'],
    ['Was rainfall low?', 'rainfall'],
    ['Has rainfall been below normal?', 'rainfall'],
    ['Has rainfall been unusually low?', 'rainfall'],
    ['How much rain did this field receive?', 'rainfall'],
    ['Was there enough rainfall?', 'rainfall'],
    ['Quanto choveu nesta janela?', 'rainfall'],
    // Planting windows.
    ['Quando posso plantar milho?', 'planting'],
    ['O que significa essa janela de plantio?', 'planting'],
    ['A data selecionada está dentro da janela?', 'planting'],
    ['When is the typical corn planting window?', 'planting'],
    ['What does this planting window mean?', 'planting'],
    ['What do the planting windows mean?', 'planting'],
    ['Is the selected date inside the window?', 'planting'],
    // Water demand, missing information and a crop choice.
    ['Qual é a diferença entre a demanda hídrica do milho e da soja?', 'water_demand'],
    ['Can you compare corn and soybean water demand?', 'water_demand'],
    ['Qual cultura usa mais água?', 'water_demand'],
    ['Quais informações estão faltando para uma recomendação mais confiável?', 'missing'],
    ['What information would make this assessment more reliable?', 'missing'],
    ['Qual cultura devo plantar agora?', 'recommendation'],
    ['Which crop should I plant next?', 'recommendation'],
    ['Como estão as condições ambientais da minha propriedade?', 'environment'],
    ['What do the environmental indicators show about my field?', 'environment'],
    // Out of scope stays out of scope.
    ['Qual será o preço da soja ano que vem?', 'unsupported'],
  ])('%s -> %s', (question, intent) => {
    expect(classifyIntent(question)).toBe(intent)
  })
})

describe('milestone 3: rain answers lead with the comparison', () => {
  // Recorded block 6 payload of Field 01: rain 171.9 mm, median 224.9 mm, rank 7, percentile 20.
  it('says the rain was below the median, by how much, and what the percentile is not', () => {
    const response = answerQuestion('Choveu menos que o normal?', { context: context(), locale: 'pt-BR', id: 'r' })
    expect(response.intent).toBe('rainfall')
    expect(response.status).toBe('answered')
    expect(response.answer[0]).toMatch(/^Choveu abaixo do usual/)
    expect(response.answer[0]).toContain('171,9 mm')
    expect(response.answer[0]).toContain('224,9 mm')
    expect(response.answer[0]).toContain('53,0 mm a menos')
    expect(response.answer[0]).toContain('24% abaixo')
    expect(response.answer.join(' ')).toContain('percentil 20: em 7 dos anos')
    expect(response.answer.join(' ')).toContain('quinto mais seco')
    expect(response.answer.join(' ')).toMatch(/não é uma probabilidade/)
    expect(response.evidence.map((e) => e.metric)).toEqual(expect.arrayContaining(['rain_total', 'rain_median', 'rain_percentile', 'rain_rank']))
  })

  it('answers in English with the same evidence', () => {
    const pt = answerQuestion('A chuva foi abaixo do normal?', { context: context(), locale: 'pt-BR', id: 'r' })
    const en = answerQuestion('Was rainfall low?', { context: context(), locale: 'en', id: 'r' })
    expect(en.answer[0]).toMatch(/^Rain was below the usual for these dates: 171\.9 mm/)
    expect(en.evidence.map((e) => e.id)).toEqual(pt.evidence.map((e) => e.id))
  })


  it('does not call the rain low or high without the historical median', () => {
    const payload = recordedNumbersPayload()
    payload.provenance = payload.provenance.filter((row) => row.metric !== 'rain_median')
    const response = answerQuestion('Was rainfall low?', { context: context({}, payload), locale: 'en', id: 'r' })
    expect(response.status).toBe('partial')
    expect(response.answer[0]).toMatch(/cannot be called above or below normal/)
  })
})

describe('milestone 3: crop water comparison', () => {



  it('never gives the comparison to another field or window, and points to the demo instead', () => {
    const other = answerQuestion('Compare the water demand', { context: context({ fieldId: 'mt-santa-carmem-02', center: [-55.24, -11.94] }), locale: 'en', id: 'w' })
    expect(other.status).toBe('unavailable')
    expect(other.cropWater).toBeUndefined()
    expect(other.answer.join(' ')).toMatch(/guided demo/)
  })

  it('does not attach the peak-coefficient limit to a crop choice without crop water evidence', () => {
    const response = answerIntent('recommendation', { context: context({ fieldId: 'mt-santa-carmem-02', center: [-55.24, -11.94] }), locale: 'en', id: 'a' })
    expect(response.limitations).not.toContain('needs_sowing_date')
    expect(response.evidence).toEqual([])
  })
})

describe('milestone 3: planting windows', () => {
  it('explains the ZARC windows of the season of the chosen date, with the date position', () => {
    const response = answerQuestion('Quais são as janelas de plantio?', { context: context(), locale: 'pt-BR', id: 'p' })
    expect(response.intent).toBe('planting')
    expect(response.status).toBe('answered')
    expect(response.answer[0]).toContain('Santa Carmem (MT), safra 2026/2027')
    const text = response.answer.join(' ')
    expect(text).toContain('Soja: de 1 de out. de 2026 a 10 de jan. de 2027. A data escolhida (12 de nov. de 2026) está dentro desta janela.')
    expect(text).toContain('Milho 2ª Safra: de 1 de jan. de 2027 a 10 de mar. de 2027. A data escolhida (12 de nov. de 2026) está antes desta janela.')
    expect(text).toMatch(/nível de risco de 20%/)
    expect(text).toMatch(/não garante uma boa safra e não é uma data de semeadura recomendada/)
    expect(response.evidence.map((e) => e.id)).toEqual(['planting.soja.window', 'planting.milho_1a_safra.window',
      'planting.milho_2a_safra.window', 'planting.algodao_herbaceo.window'])
    expect(response.limitations).toEqual(expect.arrayContaining(['zarc_municipal_envelope', 'planting_window_not_decision']))
  })

  it('narrows to the crop the question names', () => {
    const response = answerQuestion('When can I plant corn?', { context: context(), locale: 'en', id: 'p' })
    expect(response.evidence.map((e) => e.value)).toEqual(['Milho 1ª Safra', 'Milho 2ª Safra'])
  })

  it('uses the NASS usual dates, without a year, for a United States field', () => {
    const response = answerQuestion('When is the typical corn planting window?', {
      context: context({ fieldId: '381825001868504', name: 'Cass Field 01', location: 'Cass County, North Dakota', regionId: 'us', date: '2026-05-10', center: [-97.17, 46.93] }),
      locale: 'en', id: 'p',
    })
    expect(response.answer[0]).toMatch(/NASS/)
    expect(response.answer[1]).toBe('Corn: Apr 26 to Jun 4. The chosen date (May 10, 2026) is inside this window.')
    expect(response.answer.join(' ')).toMatch(/not a climatic risk rating/)
    expect(response.limitations).toContain('seasonless_state_average')
  })

  it('names the seasons the snapshot holds instead of inventing a window', () => {
    const response = answerQuestion('Quando posso plantar soja?', { context: context({ date: '2028-01-05' }), locale: 'pt-BR', id: 'p' })
    expect(response.status).toBe('unavailable')
    expect(response.answer[0]).toContain('2025/2026 e 2026/2027')
    expect(response.evidence).toEqual([])
  })

  it('has no window for a drawn polygon', () => {
    const response = answerQuestion('What are the planting windows?', { context: context({ fieldId: 'trazo:1', kind: 'polygon', name: null, location: null }), locale: 'en', id: 'p' })
    expect(response.status).toBe('unavailable')
    expect(response.evidence).toEqual([])
  })
})
