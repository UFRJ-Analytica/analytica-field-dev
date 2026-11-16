import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { NumbersView } from './NumbersView'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import type { NumbersPayload } from '@/lib/numbers'
import type { FalsifiableScenario } from '@/lib/falsifier'

const field: FieldSummary = {
  id: RECORDED_FIELD_ID,
  name: 'Santa Carmem North',
  location: 'Santa Carmem, Mato Grosso',
  coverage: 86,
  center: [-55.27, -11.91],
  boundary: {
    type: 'Polygon',
    coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]],
  },
}

function stubNumbersFetch(payload: NumbersPayload) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/numbers') && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  }))
}

const WITH_FALSIFIER: FalsifiableScenario = {
  id: 'current-sequence',
  name: 'Current sequence',
  falsifier: {
    metric: 'dry_spell_days',
    operator: '>',
    threshold: 10,
    unit: 'days',
    text_key: 'scenarios.falsifier.placeholder',
  },
}

const WITHOUT_FALSIFIER: FalsifiableScenario = { id: 'soy-cotton', name: 'Soybean -> Cotton' }

beforeEach(() => {
  window.history.replaceState({}, '', '/?numbers=1')
  useMapStore.setState({
    regionId: 'us',
    selectedFieldId: field.id,
    selectedPolygonId: null,
    polygonRaw: null,
    polygonMode: null,
    polygonRing: null,
    chosenDate: '2026-11-12',
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useMapStore.setState({ selectedFieldId: null, numbersLastRead: {} })
})

describe('AC-39, the counter evidence card and its completeness count (R-40)', () => {
  it('prints No counter evidence recorded in the slot of a scenario without a falsifier, and no threshold', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView scenarios={[WITHOUT_FALSIFIER]} selectedField={field} />)
    await screen.findByText('Counter evidence')
    const card = document.querySelector('.numbers-counter') as HTMLElement
    expect(card.querySelector('[data-counter-scenario="soy-cotton"]')?.textContent).toContain('No counter evidence recorded')
    expect(card.textContent).not.toContain('exceed 10')
    expect(card.querySelector('[data-counter-status]')?.getAttribute('data-counter-status')).toBe('not verified')
  })

  it('carries one gap row per scenario without a falsifier, naming the scenario and the field', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView scenarios={[WITHOUT_FALSIFIER]} selectedField={field} />)
    await screen.findByText('Counter evidence')
    const register = document.querySelector('.numbers-gap-table') as HTMLElement
    const text = register.textContent ?? ''
    expect(text).toContain('soy-cotton')
    expect(text).toContain(RECORDED_FIELD_ID)
    expect(text).toContain('CO-B6-02')
  })

  it('reports the completeness count with its status and never as passed while a scenario lacks one', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView scenarios={[WITH_FALSIFIER, WITHOUT_FALSIFIER]} selectedField={field} />)
    await screen.findByText('Counter evidence')
    const card = document.querySelector('.numbers-counter') as HTMLElement
    expect(card.querySelector('.numbers-counter-count')?.textContent).toBe('1 of 2 scenarios carry a falsifier; not verified')
  })

  it('reports passed only when every scenario carries one, and prints its value with basis and date', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView scenarios={[WITH_FALSIFIER]} selectedField={field} />)
    await screen.findByText('Counter evidence')
    const card = document.querySelector('.numbers-counter') as HTMLElement
    expect(card.querySelector('.numbers-counter-count')?.textContent).toBe('1 of 1 scenarios carry a falsifier; passed')
    const line = card.querySelector('[data-counter-scenario="current-sequence"]')?.textContent ?? ''
    expect(line).toContain('The recommendation is refused when dry spell days exceed 10.')
    expect(line).toContain('7')
    expect(line).toContain('modelled')
    expect(line).toContain('2026-11-11')
  })

  it('prints the polygon empty text and no scenario when the selection carries no fixture scenario', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView scenarios={[]} selectedField={field} />)
    await screen.findByText('Counter evidence')
    const card = document.querySelector('.numbers-counter') as HTMLElement
    expect(card.textContent).toContain('This polygon carries no rotation scenario')
    expect(card.querySelector('[data-counter-scenario]')).toBeNull()
  })
})
