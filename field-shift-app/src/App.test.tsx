import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { layersResponse } from '@/test/api-fixtures'
import App  from './App'


const translationTestState = vi.hoisted(() => ({ useKeys: false }))

vi.mock('@/strings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/strings')>()
  return {
    ...actual,
    t: (key: string, vars?: Record<string, string | number>) =>
      translationTestState.useKeys ? key : actual.t(key, vars),
  }
})

vi.mock('maplibre-gl', () => ({
  Map: class {
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    flyTo = vi.fn()
    on = vi.fn()
    remove = vi.fn()
    getSource = vi.fn(() => null)
    getLayer = vi.fn(() => null)
    getStyle = vi.fn(() => ({ layers: [] }))
    getZoom = vi.fn(() => 11)
    getCenter = vi.fn(() => ({ lng: -55.27, lat: -11.91 }))
    getCanvas = () => ({ style: {} as { cursor?: string } })
    setPaintProperty = vi.fn()
    setLayoutProperty = vi.fn()
    setFeatureState = vi.fn()
    removeFeatureState = vi.fn()
    removeControl = vi.fn()
    queryRenderedFeatures = vi.fn(() => [])
    off = vi.fn()
  },
  NavigationControl: class {},
  AttributionControl: class {
    options: unknown
    constructor(options?: unknown) { this.options = options }
    onAdd() { return {} }
    onRemove() {}
  },
  addProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
}))

const fields = [
  {
    id: 'mt-santa-carmem-01',
    name: 'Santa Carmem North',
    location: 'Santa Carmem, Mato Grosso',
    coverage: 86,
    center: [-55.27, -11.91] as [number, number],
    boundary: { type: 'Polygon' as const, coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
  },
  {
    id: 'mt-santa-carmem-03',
    name: 'Santa Carmem South',
    location: 'Santa Carmem, Mato Grosso',
    coverage: 62,
    center: [-55.21, -11.97] as [number, number],
    boundary: { type: 'Polygon' as const, coordinates: [[[-55.225, -11.96], [-55.2, -11.96], [-55.2, -11.98], [-55.225, -11.98], [-55.225, -11.96]]] },
  },
]

const scenarios = {
  field_id: 'mt-santa-carmem-01',
  season: '2025/26',
  state: 'ranked',
  threshold: null,
  scenarios: [
    { id: 'current', name: 'Current sequence', is_current: true, crops: ['Soybean', 'Corn'], why: 'Current farm plan', evidence: 'Three supported seasons', benefit: 'Known operating fit', gap: 'No input-cost data', risk: 'Weather variability', evidence_rows: [{ layer: 'SMAP soil moisture', value: '0.28 m³/m³', basis: 'retrieved' as const, as_of: '2025-11-10', source: 'https://example.com/smap' }] },
    { id: 'rotation-a', name: 'Soybean → Corn', is_current: false, crops: ['Soybean', 'Corn'], why: 'Alternates crop families', evidence: 'SMAP soil moisture', benefit: 'Diversifies rotation', gap: 'Market access unknown', risk: 'Dry-season stress', evidence_rows: [] },
    { id: 'rotation-b', name: 'Soybean → Cotton', is_current: false, crops: ['Soybean', 'Cotton'], why: 'Adds a fiber crop', evidence: 'Three supported seasons', benefit: 'Additional outlet', gap: 'Credit terms unknown', risk: 'Higher input demand', evidence_rows: [] },
  ],
}

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (new URL(url).pathname === '/layers') {
      return { ok: true, status: 200, json: async () => layersResponse() } as Response
    }
    if (url.endsWith('/fields')) {
      return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
    }
    const fieldId = new URL(url).pathname.split('/')[2]
    const abstained = fieldId === 'mt-santa-carmem-03'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...scenarios,
        field_id: fieldId,
        state: abstained ? 'abstained' : 'ranked',
        threshold: abstained ? 'coverage_below_80_percent' : null,
        coverage: abstained ? 62 : 86,
      }),
    } as Response
  }))
}

beforeEach(() => {
  usePanelStore.setState({ open: null })
  // Block 5 makes the United States the default region (R-01) and lists only the active
  // region's fixtures (R-24, AM-10). The Brazilian region was removed, so these block 1 to 4
  // cases run against the one region the app mounts.
  window.history.replaceState({}, '', '/')
  useMapStore.setState({ regionId: 'us', selectedFieldId: null, chosenDate: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  translationTestState.useKeys = false
  window.localStorage.removeItem('fs.locale')
  useMapStore.setState({ selectedFieldId: null, chosenDate: null, regionId: 'us', selectedPolygonId: null })
  window.history.replaceState({}, '', '/')
})

describe('field map and rotation scenario selection', () => {


  it('renders the Field map region at the root route', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Field map' })).toBeTruthy()
  })

  it('renders top chips without panel surface classes', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByText('FIELD INTELLIGENCE')).toBeTruthy()
    const chips = document.querySelectorAll('.top-chip')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect([...chip.classList].some((className) => /surface/i.test(className))).toBe(false)
    }
  })









})

describe('block 3 wave 1: toggles and the single coverage readout', () => {



  it('wraps the field list in the vendored collapsible (AC-04)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole('button', { name: 'Fields' })
    const row = document.getElementById('fields-chip-row')
    expect(row).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe('fields-chip-row')
    expect(document.querySelector('[data-slot="collapsible-panel"]')).toBeNull()

    await user.click(trigger)
    const panel = await waitFor(() => {
      const found = document.querySelector('[data-slot="collapsible-panel"]')
      expect(found).toBeTruthy()
      return found as Element
    })
    expect(row?.contains(panel)).toBe(true)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))

    await user.click(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.querySelector('[data-slot="collapsible-panel"]')).toBeNull()
  })


  it('renders no chip while the field list is loading with nothing selected (AC-05)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<App />)

    expect(screen.getByRole('button', { name: 'Fields' })).toBeTruthy()
    expect(document.querySelectorAll('.field-chip')).toHaveLength(0)
    expect(document.querySelector('.field-list-anchor')?.textContent).not.toContain('%')
  })






})




describe('block 4 wave 3: the timeline replaces the season control', () => {
  const dateInput = () => screen.getByLabelText('Go to date') as HTMLInputElement

  it('has no element named Season and no season select anywhere (AC-22, timeline half)', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeTruthy()
    expect(document.querySelector('[aria-label="Season"]')).toBeNull()
    expect(document.querySelector('select')).toBeNull()
    expect(screen.queryByText('Season')).toBeNull()
  })

  it('opens at the axis end by default (AC-23)', async () => {
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2026-11-14'))
    expect(dateInput().min).toBe('2015-04-01')
    expect(dateInput().max).toBe('2026-11-14')
  })

  it('opens at ?date=2026-11-12 and asks /layers for that date (AC-23)', async () => {
    window.history.replaceState({}, '', '/?date=2026-11-12')
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2026-11-12'))
    const layerRequests = vi.mocked(fetch).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/layers')
    expect(layerRequests.some((url) => url.searchParams.get('date') === '2026-11-12')).toBe(true)
  })

  it('clamps a query before the axis and shows the polite limit message (AC-23)', async () => {
    window.history.replaceState({}, '', '/?date=2015-03-01')
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2015-04-01'))
    expect(screen.getByText('Date limited to 2015-04-01')).toBeTruthy()
  })

  it('renders none_in_lookback and the first axis day without inventing a date (AC-28)', async () => {
    const payloads: Record<string, ReturnType<typeof layersResponse>> = {}
    const noneInLookback = layersResponse('2025-01-15')
    payloads['2025-01-15'] = {
      ...noneInLookback,
      layers: noneInLookback.layers.map((layer) => (layer.id === 'ndvi-8day'
        ? { ...layer, status: 'none_in_lookback' as const, effective_date: null, age_days: null }
        : layer)),
    }
    const firstAxisDay = layersResponse('2015-04-01')
    payloads['2015-04-01'] = {
      ...firstAxisDay,
      layers: firstAxisDay.layers.map((layer) => (layer.id === 'smap-l3'
        ? { ...layer, status: 'on_date' as const, effective_date: '2015-04-01', age_days: 0 }
        : layer)),
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/layers') {
        const date = url.searchParams.get('date') ?? ''
        return { ok: true, status: 200, json: async () => payloads[date] } as Response
      }
      if (url.pathname === '/fields') {
        return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    }))

    window.history.replaceState({}, '', '/?date=2025-01-15')
    const first = render(<App />)
    await waitFor(() => expect((screen.getByLabelText('Go to date') as HTMLInputElement).value).toBe('2025-01-15'))
    const ndvi = document.querySelector('.layer-entry[data-layer-id="ndvi-8day"]') as HTMLElement
    await waitFor(() => expect(ndvi.textContent).toContain('no observation in lookback'))
    expect(ndvi.querySelector('time')).toBeNull()
    first.unmount()

    window.history.replaceState({}, '', '/?date=2015-04-01')
    // A page load starts with the default state: the store is fresh, no chosen date.
    useMapStore.setState({ chosenDate: null })
    render(<App />)
    await waitFor(() => expect((screen.getByLabelText('Go to date') as HTMLInputElement).value).toBe('2015-04-01'))
    const smap = document.querySelector('.layer-entry[data-layer-id="smap-l3"]') as HTMLElement
    await waitFor(() => expect(smap.textContent).toContain('2015-04-01'))
  })
})

describe('block 4 wave 4: the dock states, the two toggles and the motion rules', () => {
  type Width = '1440' | '780' | '360'

  /** The two queries the block 4 layout reads, keyed by the width they stand for. */
  function widthMatches(query: string, width: Width): boolean {
    if (query === '(max-width: 640px)') return width === '360'
    if (query === '(max-width: 1020px)') return width !== '1440'
    return false
  }

  function stubWidth(width: Width) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: widthMatches(query, width),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  /** A matchMedia stub a test can resize, dispatching `change` the way a real resize does. */

  const timelineToggle = () => screen.getByRole('button', { name: 'Timeline controls' })
  const timelineRegion = () => screen.queryByRole('region', { name: 'Timeline' })
  const chosenDate = () => useMapStore.getState().chosenDate

  it('R-46, AC-39: at 360x640 the dock is the collapsed toggle and Enter expands it as the region first control', async () => {
    stubWidth('360')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull()
    const toggle = timelineToggle()
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('2026-11-14')
    expect(toggle.tabIndex).toBe(0)

    toggle.focus()
    await user.keyboard('{Enter}')
    const region = await screen.findByRole('region', { name: 'Timeline' })
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('true')
    expect(region.querySelector('.timeline-date-row')?.firstElementChild).toBe(timelineToggle())
    expect(document.activeElement).toBe(timelineToggle())
    // The four R-37 controls stay four at this width.
    expect(within(region).getByLabelText('Go to date')).toBeTruthy()
    expect(within(region).getByLabelText('Previous day')).toBeTruthy()
    expect(within(region).getByLabelText('Timeline date')).toBeTruthy()
    expect(within(region).getByLabelText('Next day')).toBeTruthy()

    await user.keyboard(' ')
    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(timelineToggle())
  })

  it('R-46, AC-39: at 780x900 the dock is expanded at first paint and its toggle is a sibling of the region', async () => {
    stubWidth('780')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const region = await screen.findByRole('region', { name: 'Timeline' })
    const toggle = timelineToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region.contains(toggle)).toBe(false)
    expect(toggle.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(toggle)
    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('false')
    expect(timelineToggle().textContent).toContain('2026-11-14')

    await user.click(timelineToggle())
    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeTruthy()
  })




  it('R-37, AC-36: Enter and Space step the date from Previous day and Next day and keep focus', async () => {
    stubWidth('1440')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })

    const previous = screen.getByRole('button', { name: 'Previous day' })
    previous.focus()
    await user.keyboard('{Enter}')
    expect(chosenDate()).toBe('2026-11-13')
    expect(document.activeElement).toBe(previous)
    await user.keyboard(' ')
    expect(chosenDate()).toBe('2026-11-12')
    expect(document.activeElement).toBe(previous)

    const next = screen.getByRole('button', { name: 'Next day' })
    next.focus()
    await user.keyboard('{Enter}')
    expect(chosenDate()).toBe('2026-11-13')
    expect(document.activeElement).toBe(next)
  })


})
