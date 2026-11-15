import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { layersResponse } from '@/test/api-fixtures'
import App from './App'

vi.mock('maplibre-gl', async () => {
  const { MapStub } = await import('@/test/maplibre-stub')
  return {
    Map: MapStub,
    NavigationControl: class {},
    AttributionControl: class { onAdd() { return {} } onRemove() {} },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  }
})

const fields = [{
  id: 'mt-santa-carmem-01',
  name: 'Santa Carmem North',
  location: 'Santa Carmem, Mato Grosso',
  coverage: 86,
  center: [-55.27, -11.91] as [number, number],
  boundary: { type: 'Polygon' as const, coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
}]

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (new URL(url).pathname === '/layers') {
      return { ok: true, status: 200, json: async () => layersResponse() } as Response
    }
    if (url.endsWith('/fields')) {
      return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2025/26'], default_season: '2025/26' }) } as Response
    }
    if (url.endsWith('/numbers')) {
      return { ok: true, status: 200, json: async () => ({ schema_version: '1', field_id: 'mt-santa-carmem-01', provenance: [], gaps: [], sections: {}, query: { date: '2026-11-12' } }) } as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ field_id: 'mt-santa-carmem-01', season: '2025/26', state: 'ranked', threshold: null, scenarios: [], coverage: 86 }),
    } as Response
  }))
}

const search = () => window.location.search

async function selectField(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Fields' }))
  await user.click(await screen.findByRole('button', { name: 'Santa Carmem North' }))
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?region=br')
  usePanelStore.setState({ open: null })
  useMapStore.setState({
    regionId: 'br', selectedFieldId: null, chosenDate: null, selectedPolygonId: null,
    calendarOpen: false, recordOpen: false, numbersOpen: false, registeredFields: [], producerData: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  usePanelStore.setState({ open: null })
  useMapStore.setState({ calendarOpen: false, recordOpen: false, numbersOpen: false, registeredFields: [], producerData: {} })
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('R-06 and R-08, the four buttons and one panel at a time (AC-01, AC-05)', () => {
  it('opens the calendar panel from its button and writes no URL key', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Planting calendar' }))
    const panel = await screen.findByRole('region', { name: 'Planting calendar' })
    expect(panel.querySelector('[data-decision-view]')).toBeTruthy()
    expect(search()).toBe('?region=br')
    expect(document.querySelector('[data-record-view]')).toBeNull()
  })

  it('opens the field record panel from its button', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    const panel = await screen.findByRole('region', { name: 'Field record' })
    expect(panel.querySelector('[data-record-view]')).toBeTruthy()
    expect(search()).toBe('?region=br')
  })

  it('closes the calendar when another of the four opens', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Planting calendar' }))
    await screen.findByRole('region', { name: 'Planting calendar' })
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    await waitFor(() => expect(document.querySelector('[data-record-view]')).toBeTruthy())
    expect(document.querySelector('[data-decision-view]')).toBeNull()
    expect(document.querySelectorAll('[data-panel-host]')).toHaveLength(1)
  })

  it('keeps aria-expanded true for one button only', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    const calendar = screen.getByRole('button', { name: 'Planting calendar' })
    const record = screen.getByRole('button', { name: 'Field record' })
    await user.click(calendar)
    expect(calendar.getAttribute('aria-expanded')).toBe('true')
    expect(record.getAttribute('aria-expanded')).toBe('false')
    await user.click(record)
    expect(calendar.getAttribute('aria-expanded')).toBe('false')
    expect(record.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('the panel close control and the map screen (AC-01, AC-02)', () => {
  it('closes the calendar from its own close control and returns the focus to its button', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Planting calendar' }))
    const panel = await screen.findByRole('region', { name: 'Planting calendar' })
    await user.click(within(panel).getByRole('button', { name: 'Close Planting calendar' }))
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeNull())
    expect(search()).toBe('?region=br')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Planting calendar'))
  })

  it('leaves the map screen mounted while a panel is open (B1, R-02)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    await screen.findByRole('region', { name: 'Field record' })
    expect(screen.getByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Layers' })).toBeTruthy()
    expect(document.querySelector('.app-shell')?.className).toBe('app-shell')
  })

  it('opens no panel at first paint and needs a selection for the polygon panels (B4, B5)', async () => {
    mockApi()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    // The app selects the region's first fixture at load, so the test clears it first.
    act(() => useMapStore.setState({ selectedFieldId: null, selectedPolygonId: null }))
    expect(document.querySelector('[data-panel-host]')).toBeNull()
    expect(document.querySelector('[data-decision-view]')).toBeNull()
    expect(document.querySelector('[data-record-view]')).toBeNull()
    expect((screen.getByRole('button', { name: 'Field numbers, select a polygon first' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('selects a field and then opens the rotation panel over the same map', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await selectField(user)
    await user.click(screen.getByRole('button', { name: 'Expand Rotation outlook' }))
    await waitFor(() => expect(document.querySelector('[data-panel-host]')?.getAttribute('data-panel')).toBe('rotation'))
  })
})
