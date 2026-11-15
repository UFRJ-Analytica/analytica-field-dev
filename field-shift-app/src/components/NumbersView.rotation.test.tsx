import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NumbersView } from './NumbersView'
import type { RotationScenario } from './ScenarioCards'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import type { NumbersPayload } from '@/lib/numbers'
import { recordedNumbersPayload, RECORDED_DATE, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import { brNullClassPayload, CSB_FIELD_ID, CSB_RING, csbCdlYears, usPolygonPayload } from '@/test/rotation-recorded'

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

const cropScenario: RotationScenario = {
  id: 'soy-cotton',
  name: 'Soybean → Cotton',
  is_current: false,
  crops: ['Soybean', 'Cotton'],
  why: 'Introduces a fiber crop after soybean.',
  evidence: 'Three seasons of crop history support a rotation comparison.',
  benefit: 'Adds a potential market outlet.',
  gap: 'Buyer access and credit terms are unknown.',
  risk: 'Cotton requires higher working capital.',
  evidence_rows: [],
}

function stubNumbersFetch(payload: NumbersPayload) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/numbers') && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function rotationCard(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-card="rotation"]') as HTMLElement
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?numbers=1')
  useMapStore.setState({
    regionId: 'br',
    selectedFieldId: field.id,
    selectedPolygonId: null,
    polygonRaw: null,
    polygonMode: null,
    polygonRing: null,
    chosenDate: RECORDED_DATE,
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useMapStore.setState({ selectedFieldId: null, selectedPolygonId: null, polygonRaw: null, polygonRing: null, numbersLastRead: {} })
})

describe('the rotation history of a Brazil polygon whose sidecar class is NULL (R-33, R-34, R-36)', () => {
  it('prints the collection line, the year with a class not computed cell, and the gap naming the missing class', async () => {
    stubNumbersFetch(brNullClassPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Rotation history')
    const card = rotationCard(container)
    await waitFor(() => expect(within(card).getByText('MapBiomas Collection 11, collection year 2025')).toBeTruthy())
    const row = card.querySelector('[data-history="first"] li') as HTMLElement
    expect(row.getAttribute('data-code')).toBe('')
    expect(within(row).getByText('Year 2025')).toBeTruthy()
    expect(within(row).getByText('agriculture_first_crop')).toBeTruthy()
    expect(within(row).getByText('class not computed')).toBeTruthy()
    expect(within(card).getByText(
      'class missing for 1 year(s) of agriculture_first_crop: class_id is NULL in the sidecar, no Collection 11 class is computed.',
    )).toBeTruthy()
  })

  it('names the missing class in the gap register too, and prints no unknown class and no class name', async () => {
    stubNumbersFetch(brNullClassPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Gap register')
    const card = rotationCard(container)
    expect(card.textContent).not.toMatch(/unknown/i)
    expect(card.textContent).not.toMatch(/mbMode/)
    expect(card.textContent).not.toMatch(/Soybean/)
    expect(screen.getByText(/class missing for 1 year\(s\) of agriculture_first_crop/, { selector: 'td' })).toBeTruthy()
  })
})

describe('the rotation history of a field with no sidecar row (R-36)', () => {
  it('abstains with the named gap and prints no year row', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Rotation history')
    const card = rotationCard(container)
    expect(within(card).getByText('no MapBiomas Collection 11 row for this polygon')).toBeTruthy()
    expect(card.querySelectorAll('[data-history] li')).toHaveLength(0)
    expect(card.textContent).not.toMatch(/Year \d{4}/)
  })
})

describe('the CDL history of a United States polygon (Crop Sequence Boundary properties)', () => {
  it('prints eight CDL years, 2018 to 2025, each with its code and its legend name', async () => {
    stubNumbersFetch(usPolygonPayload())
    useMapStore.setState({
      regionId: 'us',
      selectedFieldId: null,
      selectedPolygonId: CSB_FIELD_ID,
      polygonRing: CSB_RING,
      polygonRaw: { classValue: 5, area: 153.18667449, cdl: csbCdlYears() },
    })
    const { container } = render(<NumbersView selectedField={null} onClose={vi.fn()} />)
    await screen.findByText('Rotation history')
    await waitFor(() => expect(rotationCard(container).querySelectorAll('[data-history="cdl"] li')).toHaveLength(8))
    const card = rotationCard(container)
    const items = Array.from(card.querySelectorAll('[data-history="cdl"] li')) as HTMLElement[]
    expect(items.map((item) => item.dataset.year)).toEqual(['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'])
    expect(items[1].dataset.code).toBe('41')
    expect(within(items[1]).getByText('Sugarbeets')).toBeTruthy()
    expect(within(items[4]).getByText('Corn')).toBeTruthy()
    expect(items.every((item) => within(item).queryByText('cdl') !== null)).toBe(true)
    // The MapBiomas section still abstains for this polygon (R-36): CDL is a separate source.
    expect(within(card).getByText('no MapBiomas Collection 11 row for this polygon')).toBeTruthy()
  })
})

describe('the counter evidence of a scenario in the gap register (R-40)', () => {
  it('carries a gap with the scenario id and the field id when the scenario has no falsifier', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView selectedField={field} onClose={vi.fn()} scenarios={[cropScenario]} />)
    await screen.findByText('Gap register')
    expect(screen.getByText(`No counter evidence recorded for scenario soy-cotton of field ${RECORDED_FIELD_ID}.`, { selector: 'td' })).toBeTruthy()
  })

  it('adds no counter evidence gap for a scenario that carries a falsifier', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const withFalsifier: RotationScenario = {
      ...cropScenario,
      falsifier: { metric: 'rain_total', operator: '<', threshold: 150, unit: 'mm', text_key: 'numbers.rain_total' },
    } as RotationScenario
    render(<NumbersView selectedField={field} onClose={vi.fn()} scenarios={[withFalsifier]} />)
    await screen.findByText('Gap register')
    expect(screen.queryByText(/No counter evidence recorded for scenario/)).toBeNull()
  })
})
