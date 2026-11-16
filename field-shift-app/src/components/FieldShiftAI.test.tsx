import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FieldShiftAIPanel, FieldShiftAIToggle } from './FieldShiftAI'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { useAssistantUi } from '@/lib/assistant/ui-store'
import { numbersLastReadKey } from '@/lib/numbers-api'
import type { NumbersPayload } from '@/lib/numbers'
import { recordedNumbersPayload, RECORDED_DATE, RECORDED_FIELD_ID } from '@/test/numbers-recorded'

const FIELD_01: FieldSummary = {
  id: RECORDED_FIELD_ID,
  name: 'Field 01',
  location: 'Santa Carmem, Mato Grosso',
  coverage: 86,
  center: [-55.27, -11.91],
  boundary: { type: 'Polygon', coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
}
const FIELD_02: FieldSummary = {
  ...FIELD_01,
  id: 'mt-santa-carmem-02',
  name: 'Field 02',
  center: [-55.24, -11.94],
  boundary: { type: 'Polygon', coordinates: [[[-55.255, -11.93], [-55.23, -11.93], [-55.23, -11.95], [-55.255, -11.95], [-55.255, -11.93]]] },
}

function payloadFor(fieldId: string, date = RECORDED_DATE): NumbersPayload {
  const payload = recordedNumbersPayload()
  return { ...payload, field_id: fieldId, query: { ...payload.query, date } }
}

let fetchMock: ReturnType<typeof vi.fn>
let agentStatus = { experimental: true, llm_enabled: false, provider: null, mode: 'deterministic' }
let agentRequests: Record<string, unknown>[] = []
let agentReply: (body: Record<string, unknown>) => unknown = () => new Error('no agent in this test')

/** The block 6 requests only (the panel also reads the agent status once). */
const numbersCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/numbers'))

function answerWith(make: (fieldId: string, date: string) => NumbersPayload | Error) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/experimental/field-shift-ai/status')) {
      return { ok: true, status: 200, json: async () => agentStatus } as Response
    }
    if (url.endsWith('/experimental/field-shift-ai/chat')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      agentRequests.push(body)
      const reply = agentReply(body)
      if (reply instanceof Error) throw reply
      return { ok: true, status: 200, json: async () => reply } as Response
    }
    const fieldId = decodeURIComponent(url.split('/fields/')[1].split('/')[0])
    const body = JSON.parse(String(init?.body)) as { date: string }
    const result = make(fieldId, body.date)
    if (result instanceof Error) throw result
    return { ok: true, status: 200, json: async () => result } as Response
  })
}

function setup(field: FieldSummary | null = FIELD_01) {
  const view = render(
    <>
      <FieldShiftAIToggle />
      <FieldShiftAIPanel selectedField={field} />
    </>,
  )
  return view
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Field Shift AI/ }))
  return screen.findByRole('complementary')
}

beforeEach(() => {
  localStorage.removeItem('fs.locale')
  fetchMock = vi.fn()
  agentStatus = { experimental: true, llm_enabled: false, provider: null, mode: 'deterministic' }
  agentRequests = []
  agentReply = () => new Error('no agent in this test')
  vi.stubGlobal('fetch', fetchMock)
  answerWith((fieldId, date) => payloadFor(fieldId, date))
  useAssistantUi.setState({ open: false })
  useMapStore.setState({
    regionId: 'br',
    selectedFieldId: FIELD_01.id,
    selectedPolygonId: null,
    polygonRing: null,
    chosenDate: RECORDED_DATE,
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem('fs.locale')
})

describe('Field Shift AI panel', () => {
  it('opens from the control strip and closes with the close button and with Escape', async () => {
    setup()
    const toggle = screen.getByRole('button', { name: /Open Field Shift AI/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const panel = await openPanel()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(panel).getByRole('heading', { name: 'Field Shift AI' })).toBeTruthy()
    expect(within(panel).getByText('Evidence-based preview')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Close Field Shift AI' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    await openPanel()
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('sends no request while closed, and one block 6 request for the selected field when open', async () => {
    setup()
    expect(fetchMock).not.toHaveBeenCalled()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    expect(numbersCalls()).toHaveLength(1)
    const [url, init] = numbersCalls()[0]
    expect(url).toMatch(/\/fields\/mt-santa-carmem-01\/numbers$/)
    expect(JSON.parse(init.body)).toMatchObject({ centroid: [-55.27, -11.91], date: RECORDED_DATE, area_ha: null })
    expect(within(panel).getByTestId('fsai-field').textContent).toBe('Field 01')
    expect(within(panel).getByText('171.9 mm')).toBeTruthy()
    // The payload is shared with NumbersView through the store cache.
    expect(useMapStore.getState().numbersLastRead[numbersLastReadKey(RECORDED_FIELD_ID, RECORDED_DATE)]).toBeTruthy()
  })

  it('reuses a payload already read in the session instead of requesting it again', async () => {
    useMapStore.setState({ numbersLastRead: { [numbersLastReadKey(RECORDED_FIELD_ID, RECORDED_DATE)]: payloadFor(RECORDED_FIELD_ID) } })
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators already read in this session.')
    expect(numbersCalls()).toHaveLength(0)
  })

  it('does not reuse a cached payload that belongs to another field', async () => {
    useMapStore.setState({ numbersLastRead: { [numbersLastReadKey(RECORDED_FIELD_ID, RECORDED_DATE)]: payloadFor('mt-santa-carmem-03') } })
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    expect(numbersCalls()).toHaveLength(1)
  })

  it('answers a suggested question with evidence and limitations', async () => {
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    fireEvent.click(within(panel).getByRole('button', { name: 'What do the environmental indicators show?' }))
    const answer = panel.querySelector('.fsai-answer') as HTMLElement
    expect(answer.dataset.field).toBe(RECORDED_FIELD_ID)
    expect(answer.textContent).toContain('Rain over the window: 171.9 mm.')
    expect(within(answer).getByText(/^Evidence \(\d+\)$/)).toBeTruthy()
    expect(within(answer).getByText('Limitations')).toBeTruthy()
    expect(answer.querySelector('[data-metric="rain_total"]')?.textContent).toContain('power.larc.nasa.gov')
  })

  it('answers a typed question in Portuguese with Portuguese number formatting', async () => {
    localStorage.setItem('fs.locale', 'pt-BR')
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicadores carregados do serviço de números.')
    fireEvent.change(within(panel).getByLabelText('Pergunte sobre esta propriedade'), { target: { value: 'Quais são as condições ambientais desta propriedade?' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Enviar' }))
    const answer = panel.querySelector('.fsai-answer') as HTMLElement
    expect(answer.textContent).toContain('Chuva na janela: 171,9 mm.')
    expect(answer.textContent).toContain('Respondida')
    expect(answer.textContent).not.toMatch(/Rain over the window/)
  })

  it('switches language during the session: the same answer and the stored locale', async () => {
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare the water demand of maize and soybean.' }))
    expect(panel.querySelector('.fsai-answer')?.textContent).toContain('197.6 mm')
    fireEvent.click(within(panel).getByRole('button', { name: 'PT-BR' }))
    expect(localStorage.getItem('fs.locale')).toBe('pt-BR')
    const panelPt = screen.getByRole('complementary')
    expect(panelPt.getAttribute('lang')).toBe('pt-BR')
    expect(within(panelPt).getByText('Assistente agrícola')).toBeTruthy()
    expect(panelPt.querySelector('.fsai-question')?.textContent).toContain('Compare a demanda hídrica do milho e da soja.')
    expect(panelPt.querySelector('.fsai-answer')?.textContent).toContain('197,6 mm')
    // ET0, then per crop ETc, rain minus ETc and Kc, then the three pairwise ETc differences.
    expect(panelPt.querySelectorAll('.fsai-answer [data-metric]').length).toBe(13)
    fireEvent.click(within(panelPt).getByRole('button', { name: 'EN' }))
    expect(screen.getByRole('complementary').querySelector('.fsai-answer')?.textContent).toContain('197.6 mm')
  })

  it('clears answers when the field changes, so two fields never share an answer', async () => {
    const view = setup(FIELD_01)
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare the water demand of maize and soybean.' }))
    expect(panel.querySelector('.fsai-answer')?.getAttribute('data-status')).toBe('answered')
    view.rerender(<><FieldShiftAIToggle /><FieldShiftAIPanel selectedField={FIELD_02} /></>)
    expect(screen.getByRole('complementary').querySelector('.fsai-answer')).toBeNull()
    expect(screen.getByText(/The field or the date changed/)).toBeTruthy()
    await screen.findByText('Indicators loaded from the numbers service.')
    expect(screen.getByTestId('fsai-field').textContent).toBe('Field 02')
    fireEvent.click(screen.getByRole('button', { name: 'Compare the water demand of maize and soybean.' }))
    const answer = screen.getByRole('complementary').querySelector('.fsai-answer') as HTMLElement
    expect(answer.dataset.field).toBe('mt-santa-carmem-02')
    expect(answer.dataset.status).toBe('unavailable')
    expect(answer.textContent).toContain('Crop-specific water demand comparison is not yet available for this field.')
  })

  it('clears answers and requests again when the date changes', async () => {
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain this field.' }))
    act(() => useMapStore.setState({ chosenDate: '2026-11-01' }))
    expect(screen.getByRole('complementary').querySelector('.fsai-answer')).toBeNull()
    await waitFor(() => expect(numbersCalls()).toHaveLength(2))
    expect(JSON.parse(numbersCalls()[1][1].body).date).toBe('2026-11-01')
  })

  it('treats a polygon without its outline as unavailable, never as another field', async () => {
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    act(() => useMapStore.setState({ selectedPolygonId: 12345 as never, selectedFieldId: null, polygonRing: null }))
    const status = await screen.findByTestId('fsai-status')
    expect(status.dataset.status).toBe('ring_missing')
    fireEvent.click(screen.getByRole('button', { name: 'What do the environmental indicators show?' }))
    const answer = screen.getByRole('complementary').querySelector('.fsai-answer') as HTMLElement
    expect(answer.dataset.status).toBe('unavailable')
    expect(answer.dataset.field).not.toBe(RECORDED_FIELD_ID)
    expect(answer.querySelectorAll('[data-metric]').length).toBe(0)
  })

  it('works with no field selected', async () => {
    setup(null)
    useMapStore.setState({ selectedFieldId: null })
    const panel = await openPanel()
    expect(within(panel).getByTestId('fsai-status').textContent).toBe('Select a field on the map to start.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain this field.' }))
    expect(panel.querySelector('.fsai-answer')?.textContent).toContain('No field is selected.')
    expect(numbersCalls()).toHaveLength(0)
    expect(agentRequests).toHaveLength(0)
  })

  it('reports the service as unreachable and answers without numbers', async () => {
    answerWith(() => new TypeError('Failed to fetch'))
    setup()
    const panel = await openPanel()
    await within(panel).findByText('The numbers service is unreachable. No value is shown.')
    fireEvent.click(within(panel).getByRole('button', { name: 'What do the environmental indicators show?' }))
    const answer = panel.querySelector('.fsai-answer') as HTMLElement
    expect(answer.dataset.status).toBe('unavailable')
    expect(answer.querySelectorAll('[data-metric]').length).toBe(0)
    expect(answer.textContent).not.toMatch(/\d+(\.\d+)? mm/)
  })
})

function agentAnswer(fieldId: string, locale: 'en' | 'pt-BR', overrides: Record<string, unknown> = {}) {
  const rain = {
    id: 'rain_total', metric: 'rain_total', value: 171.9, unit: 'mm', decimals: 1,
    source: 'https://power.larc.nasa.gov/api/temporal/daily/point', asOf: '2026-11-11',
    period: { start: '2026-10-01', end: '2026-11-11' }, basis: 'modelled', sourceBasis: 'modelled',
    resolution: '0.5 degree cell', route: 'api', limitations: ['coarse_cell', 'historical_not_forecast'], fieldId,
  }
  const text = locale === 'pt-BR' ? 'Na janela de ' : 'Over '
  const middle = locale === 'pt-BR' ? ', choveu ' : ', it rained '
  return {
    status: 'answered', locale, field_id: fieldId, mode: 'agent',
    answer: [[{ t: 'text', text }, { t: 'period', evidence: 'rain_total' }, { t: 'text', text: middle },
      { t: 'value', evidence: 'rain_total' }, { t: 'text', text: '.' }]],
    evidence: [rain], limitations: ['coarse_cell', 'historical_not_forecast'], tools_used: ['get_environmental_indicators'],
    errors: [], fallback_reason: null, ...overrides,
  }
}

describe('Field Shift AI agent (milestone 2)', () => {
  async function openReady() {
    setup()
    const panel = await openPanel()
    await within(panel).findByText(/Indicators loaded|Indicadores carregados/)
    return panel
  }

  function typeQuestion(panel: HTMLElement, text: string) {
    const input = panel.querySelector('.fsai-form input') as HTMLInputElement
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(panel.querySelector('.fsai-form') as HTMLFormElement)
  }

  const enableAgent = () => { agentStatus = { ...agentStatus, llm_enabled: true, mode: 'agent' } }

  it('without a configured model, answers deterministically and posts no question', async () => {
    const panel = await openReady()
    expect(within(panel).getByText('Evidence-based preview')).toBeTruthy()
    typeQuestion(panel, 'What are the main environmental indicators for this field?')
    expect(panel.querySelector('.fsai-answer')?.textContent).toContain('Rain over the window: 171.9 mm.')
    expect(agentRequests).toHaveLength(0)
  })

  it('with a model, sends only the needed fields and renders the verified answer from evidence', async () => {
    enableAgent()
    let release: () => void = () => {}
    agentReply = (body) => new Promise((resolve) => { release = () => resolve(agentAnswer(String(body.field_id), 'pt-BR')) })
    localStorage.setItem('fs.locale', 'pt-BR')
    const panel = await openReady()
    await within(panel).findByText('Agente com ferramentas (experimental)')
    typeQuestion(panel, 'Como foi a distribuição das chuvas?')
    await within(panel).findByText('Consultando as evidências…')
    expect(agentRequests).toEqual([{ field_id: RECORDED_FIELD_ID, locale: 'pt-BR', question: 'Como foi a distribuição das chuvas?', date: RECORDED_DATE }])
    await act(async () => { release() })
    const answer = await waitFor(() => {
      const found = panel.querySelector('[data-mode="agent"]') as HTMLElement
      expect(found).toBeTruthy()
      return found
    })
    expect(answer.textContent).toContain('choveu 171,9 mm')
    expect(answer.textContent).toContain('1 de out')
    expect(answer.querySelector('[data-evidence="rain_total"]')).toBeTruthy()
    expect(within(answer).getByText('Evidências (1)')).toBeTruthy()
    expect(answer.textContent).toContain('não é uma previsão')
  })

  it('milestone 3: an agent water answer prints the difference and a table built only from its verified evidence', async () => {
    enableAgent()
    const common = { unit: 'mm', decimals: 1, source: 'NASA POWER; FAO-56', asOf: '2026-11-11',
      period: { start: '2026-10-01', end: '2026-11-11' }, basis: 'fixture', sourceBasis: 'modelled',
      resolution: '0.5 degree cell', route: 'snapshot', limitations: ['experimental_snapshot'] }
    agentReply = (body) => {
      const fieldId = String(body.field_id)
      return agentAnswer(fieldId, 'en', {
        answer: [[{ t: 'text', text: 'Maize needs ' }, { t: 'value', evidence: 'crop_water.diff.maize_minus_soybean' },
          { t: 'text', text: ' more water than soybean.' }]],
        evidence: [
          { ...common, fieldId, id: 'crop_water.et0_total', metric: 'et0_total', value: 197.6 },
          { ...common, fieldId, id: 'crop_water.maize.etc_total', metric: 'etc_total.maize', value: 237.2 },
          { ...common, fieldId, id: 'crop_water.soybean.etc_total', metric: 'etc_total.soybean', value: 227.3 },
          { ...common, fieldId, id: 'crop_water.maize.kc_mid', metric: 'kc_mid.maize', value: 1.2, unit: null, decimals: 2 },
          { ...common, fieldId, id: 'crop_water.diff.maize_minus_soybean', metric: 'etc_difference.maize.soybean', value: 9.9 },
        ],
      })
    }
    const panel = await openReady()
    await within(panel).findByText('Agent with tools (experimental)')
    typeQuestion(panel, 'Compare the water demand of maize and soybean')
    const answer = await waitFor(() => {
      const found = panel.querySelector('[data-mode="agent"]') as HTMLElement
      expect(found).toBeTruthy()
      return found
    })
    expect(answer.textContent).toContain('Maize needs 9.9 mm more water than soybean.')
    const rows = [...answer.querySelectorAll('[data-testid="fsai-water-table"] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent))
    // Soybean's Kc and both balances were not cited, so they are not shown: a dash or "no value", never a guess.
    expect(rows).toEqual([['Maize', '1.20', '237.2 mm', 'no value'], ['Soybean', '—', '227.3 mm', 'no value']])
    expect(within(answer).getByText('ETc difference, Maize minus soybean')).toBeTruthy()
  })

  it('falls back to the deterministic answer, and says why, when the backend falls back', async () => {
    enableAgent()
    agentReply = (body) => ({ ...agentAnswer(String(body.field_id), 'en'), status: 'fallback', mode: 'fallback',
      answer: [], evidence: [], fallback_reason: 'guard_unverified_number' })
    const panel = await openReady()
    typeQuestion(panel, 'What are the main environmental indicators for this field?')
    const note = await within(panel).findByText(/did not pass the evidence check/)
    expect(note.getAttribute('data-reason')).toBe('guard_unverified_number')
    expect(panel.querySelector('.fsai-answer')?.textContent).toContain('Rain over the window: 171.9 mm.')
  })

  it('falls back when the agent service is unreachable', async () => {
    enableAgent()
    agentReply = () => new TypeError('Failed to fetch')
    const panel = await openReady()
    typeQuestion(panel, 'Where does this data come from?')
    await within(panel).findByText(/the agent service is unreachable/)
    expect(panel.querySelector('.fsai-answer')?.getAttribute('data-intent')).toBe('sources')
  })

  it('never shows an agent answer that belongs to another field', async () => {
    enableAgent()
    agentReply = () => agentAnswer('mt-santa-carmem-02', 'en')
    const panel = await openReady()
    typeQuestion(panel, 'How was rainfall distributed?')
    await within(panel).findByText(/the answer belonged to another field/)
    expect(panel.querySelector('[data-mode="agent"]')).toBeNull()
  })

  it('marks an agent answer written in the other language and asks again on request', async () => {
    enableAgent()
    agentReply = (body) => agentAnswer(String(body.field_id), body.locale as 'en' | 'pt-BR')
    const panel = await openReady()
    typeQuestion(panel, 'How was rainfall distributed?')
    await waitFor(() => expect(panel.querySelector('[data-mode="agent"]')).toBeTruthy())
    fireEvent.click(within(panel).getByRole('button', { name: 'PT-BR' }))
    const switched = screen.getByRole('complementary')
    expect(switched.querySelector('[data-mode="agent"]')?.textContent).toContain('it rained 171.9 mm')
    expect(within(switched).getByText(/Esta resposta foi escrita em inglês/)).toBeTruthy()
    fireEvent.click(within(switched).getByRole('button', { name: 'Perguntar de novo em português' }))
    await waitFor(() => expect(agentRequests).toHaveLength(2))
    expect(agentRequests[1].locale).toBe('pt-BR')
    await waitFor(() => expect(switched.textContent).toContain('choveu 171,9 mm'))
  })

  it('cancels a question, and drops a late answer when the field changes', async () => {
    enableAgent()
    const pending: (() => void)[] = []
    agentReply = (body) => new Promise((resolve) => { pending.push(() => resolve(agentAnswer(String(body.field_id), 'en'))) })
    const view = setup(FIELD_01)
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    await within(panel).findByText('Agent with tools (experimental)')
    typeQuestion(panel, 'How was rainfall distributed?')
    fireEvent.click(await within(panel).findByRole('button', { name: 'Cancel' }))
    expect(within(panel).getByText('Question cancelled.')).toBeTruthy()
    typeQuestion(panel, 'How was rainfall distributed?')
    await within(panel).findByText('Consulting the evidence…')
    view.rerender(<><FieldShiftAIToggle /><FieldShiftAIPanel selectedField={FIELD_02} /></>)
    await act(async () => { pending.forEach((resolve) => resolve()) })
    const after = screen.getByRole('complementary')
    expect(after.querySelector('[data-mode="agent"]')).toBeNull()
    expect(after.querySelector('.fsai-answer')).toBeNull()
  })

  it('demo 3 without a model: a crop choice is declined with what is missing', async () => {
    localStorage.setItem('fs.locale', 'pt-BR')
    const panel = await openReady()
    typeQuestion(panel, 'Com esses dados, qual cultura devo plantar?')
    const answer = panel.querySelector('.fsai-answer') as HTMLElement
    expect(answer.dataset.intent).toBe('recommendation')
    expect(answer.dataset.status).toBe('partial')
    expect(answer.textContent).toContain('Esses dados não bastam para escolher uma cultura.')
    expect(answer.textContent).toContain('Nenhuma cultura é recomendada')
    expect(answer.textContent).toContain('O comparador de rotações ainda não foi construído')
  })
})

describe('milestone 3: guided demo and farmer view', () => {
  it('opens Santa Carmem from a United States start: region, field and the recorded window date', async () => {
    useMapStore.setState({ regionId: 'us', selectedFieldId: null, chosenDate: '2026-11-14' })
    setup(null)
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('button', { name: 'Open Santa Carmem, Brazil' }))
    const state = useMapStore.getState()
    expect(state.regionId).toBe('br')
    expect(state.selectedFieldId).toBe('mt-santa-carmem-01')
    expect(state.chosenDate).toBe('2026-11-11')
  })

  it('switches back to the United States without carrying the Brazilian date or field', async () => {
    setup()
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('button', { name: 'Open Cass County, United States' }))
    const state = useMapStore.getState()
    expect(state.regionId).toBe('us')
    expect(state.selectedFieldId).toBe('381825001868504')
  })

  it('runs the demo steps in order and renders the crop water comparison as a table', async () => {
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    const steps = within(panel.querySelector('.fsai-steps') as HTMLElement).getAllByRole('button').map((b) => b.textContent)
    expect(steps).toEqual(['Open Santa Carmem, Brazil', 'Open Cass County, United States', 'What do the environmental indicators show?',
      'Was rainfall below normal?', 'Compare the water demand of maize and soybean.', 'What are the planting windows?',
      'Where does this data come from?'])
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare the water demand of maize and soybean.' }))
    const table = within(panel).getByTestId('fsai-water-table')
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((cell) => cell.textContent))
    expect(rows).toContainEqual(['Maize', '1.20', '237.2 mm', '-65.2 mm'])
    expect(table.querySelector('tr[data-highest="true"]')?.getAttribute('data-crop')).toBe('maize')
    expect(table.textContent).toContain('recorded experiment, not a live value')
  })

  it('does not show a crop water table for a field outside the recorded experiment', async () => {
    useMapStore.setState({ selectedFieldId: FIELD_02.id })
    setup(FIELD_02)
    const panel = await openPanel()
    await within(panel).findByText('Indicators loaded from the numbers service.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare the water demand of maize and soybean.' }))
    expect(within(panel).queryByTestId('fsai-water-table')).toBeNull()
  })

  it('answers the rain and planting steps in Portuguese with conclusions first', async () => {
    localStorage.setItem('fs.locale', 'pt-BR')
    setup()
    const panel = await openPanel()
    await within(panel).findByText('Indicadores carregados do serviço de números.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Choveu menos que o normal?' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Quais são as janelas de plantio?' }))
    const answers = panel.querySelectorAll('.fsai-answer')
    expect(answers[0].getAttribute('data-intent')).toBe('rainfall')
    expect(answers[0].querySelector('p:nth-of-type(2)')?.textContent).toMatch(/^Choveu abaixo do usual/)
    expect(answers[1].getAttribute('data-intent')).toBe('planting')
    expect(answers[1].textContent).toContain('ZARC')
    expect(panel.textContent).not.toMatch(/assistant\.|answer\.|gloss\./)
  })

  it('hides the developer command console by default and shows it on request', async () => {
    localStorage.removeItem('fs.fsai.devTools')
    setup()
    expect(document.documentElement.dataset.fsaiDevTools).toBe('off')
    const panel = await openPanel()
    expect(document.documentElement.dataset.fsaiOpen).toBe('true')
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Show developer tools (COMMAND)' }))
    expect(document.documentElement.dataset.fsaiDevTools).toBe('on')
    fireEvent.click(within(panel).getByRole('button', { name: 'Close Field Shift AI' }))
    expect(document.documentElement.dataset.fsaiOpen).toBeUndefined()
    localStorage.removeItem('fs.fsai.devTools')
  })

  it('explains the acronyms it uses', async () => {
    setup()
    const panel = await openPanel()
    const glossary = within(panel).getByText('What do these terms mean?').closest('details') as HTMLElement
    expect(glossary.textContent).toMatch(/ET0: reference evapotranspiration/)
    expect(glossary.textContent).toMatch(/ZARC: Agricultural Climate Risk Zoning/)
  })
})
