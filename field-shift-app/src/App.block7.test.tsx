import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMapStore } from '@/lib/map-store'
import { layersResponse } from '@/test/api-fixtures'
import App from './App'

vi.mock('maplibre-gl', () => {
  const resize = vi.fn()
  class MapMock {
    static last: MapMock | null = null
    resize = resize
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    flyTo = vi.fn()
    jumpTo = vi.fn()
    on = vi.fn()
    off = vi.fn()
    remove = vi.fn()
    getSource = vi.fn(() => null)
    getLayer = vi.fn(() => null)
    getStyle = vi.fn(() => ({ layers: [] }))
    getZoom = vi.fn(() => 11)
    getCenter = vi.fn(() => ({ lng: -55.27, lat: -11.91 }))
    getBearing = vi.fn(() => 0)
    getPitch = vi.fn(() => 0)
    getCanvas = () => ({ style: {} as { cursor?: string } })
    setPaintProperty = vi.fn()
    setLayoutProperty = vi.fn()
    setFeatureState = vi.fn()
    removeFeatureState = vi.fn()
    removeControl = vi.fn()
    queryRenderedFeatures = vi.fn(() => [])
    constructor() {
      MapMock.last = this
    }
  }
  return {
    Map: MapMock,
    NavigationControl: class {},
    AttributionControl: class {
      options: unknown
      constructor(options?: unknown) { this.options = options }
      onAdd() { return {} }
      onRemove() {}
    },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
    __resize: resize,
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
    return {
      ok: true,
      status: 200,
      json: async () => ({
        field_id: 'mt-santa-carmem-01', season: '2025/26', state: 'ranked', threshold: null, scenarios: [], coverage: 86,
      }),
    } as Response
  }))
}

const search = () => window.location.search

beforeEach(() => {
  window.history.replaceState({}, '', '/?region=br')
  useMapStore.setState({
    regionId: 'br', selectedFieldId: null, chosenDate: null, selectedPolygonId: null,
    calendarOpen: false, recordOpen: false, numbersOpen: false, registeredFields: [], producerData: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useMapStore.setState({ calendarOpen: false, recordOpen: false, numbersOpen: false, registeredFields: [], producerData: {} })
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('R-01, the two strip buttons and their URL parameters (AC-01)', () => {
  it('opens the calendar with its button, writes ?decision=1 and leaves every other parameter', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Planting calendar' }))
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeTruthy())
    expect(search()).toContain('decision=1')
    expect(search()).toContain('region=br')
    expect(document.querySelector('.app-shell')?.classList.contains('is-calendar-open')).toBe(true)
    expect(document.querySelector('[data-record-view]')).toBeNull()
  })

  it('opens the field record with its button and writes ?record=1', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    await waitFor(() => expect(document.querySelector('[data-record-view]')).toBeTruthy())
    expect(search()).toContain('record=1')
    expect(document.querySelector('.app-shell')?.classList.contains('is-record-open')).toBe(true)
  })

  it('reads the two parameters on load', async () => {
    window.history.replaceState({}, '', '/?region=br&decision=1')
    mockApi()
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeTruthy())
  })
})

describe('R-06, one surface at a time (AC-05)', () => {
  it('closes the calendar when the record opens, and writes one key only', async () => {
    window.history.replaceState({}, '', '/?region=br&decision=1')
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    await waitFor(() => expect(document.querySelector('[data-record-view]')).toBeTruthy())
    expect(document.querySelector('[data-decision-view]')).toBeNull()
    expect(search()).not.toContain('decision')
    expect(search()).toContain('record=1')
  })
})

describe('R-01 and AC-01, closing returns focus and restores the map (AC-02)', () => {
  it('closes the calendar on Back to map, removes only its parameter and returns focus', async () => {
    window.history.replaceState({}, '', '/?region=br&decision=1')
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Back to map' }))
    await waitFor(() => expect(document.querySelector('[data-decision-view]')).toBeNull())
    expect(search()).not.toContain('decision')
    expect(search()).toContain('region=br')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Planting calendar'))
  })

  it('takes the focus into the surface when it opens', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await user.click(screen.getByRole('button', { name: 'Field record' }))
    await waitFor(() => expect(document.querySelector('[data-record-view]')).toBeTruthy())
    expect(document.activeElement?.textContent).toBe('Back to map')
  })
})
