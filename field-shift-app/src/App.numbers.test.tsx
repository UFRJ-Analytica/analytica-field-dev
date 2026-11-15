import { readFileSync } from 'node:fs'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { layersResponse } from '@/test/api-fixtures'
import { MapStub } from '@/test/maplibre-stub'
import { recordedNumbersPayload } from '@/test/numbers-recorded'
import { ptBR } from '@/strings/pt-BR'

vi.mock('maplibre-gl', async () => {
  const { MapStub: Stub } = await import('@/test/maplibre-stub')
  return {
    Map: Stub,
    NavigationControl: class {},
    AttributionControl: class {
      options: unknown
      constructor(options?: unknown) { this.options = options }
      onAdd() { return {} }
      onRemove() {}
    },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  }
})

const brazilFields = [
  {
    id: 'mt-santa-carmem-01',
    name: 'Santa Carmem North',
    location: 'Santa Carmem, Mato Grosso',
    coverage: 86,
    center: [-55.27, -11.91],
    boundary: { type: 'Polygon', coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
  },
]

function installFetch() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const parsed = new URL(url, 'http://localhost/')
    if (parsed.pathname === '/layers') {
      return { ok: true, status: 200, json: async () => layersResponse() } as unknown as Response
    }
    if (parsed.pathname === '/polygons/mode') {
      return { ok: true, status: 200, json: async () => ({ region: 'br', mode: 'source-direct', classProperty: 'mbmode24' }) } as unknown as Response
    }
    if (parsed.pathname.endsWith('/numbers')) {
      return { ok: true, status: 200, json: async () => recordedNumbersPayload() } as unknown as Response
    }
    if (parsed.pathname.endsWith('/fields')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: brazilFields, seasons: ['2025/26'], default_season: '2025/26' }),
      } as unknown as Response
    }
    if (parsed.pathname.includes('/fields/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ field_id: 'mt-santa-carmem-01', season: '2025/26', state: 'ranked', threshold: null, coverage: 86, scenarios: [] }),
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  }))
  return calls
}

async function selectField(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Fields' }))
  await user.click(await screen.findByRole('button', { name: 'Santa Carmem North' }))
}

beforeEach(() => {
  MapStub.reset()
  usePanelStore.setState({ open: null })
  useMapStore.setState({
    regionId: 'us',
    selectedFieldId: null,
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRing: null,
    chosenDate: null,
    numbersOpen: false,
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  usePanelStore.setState({ open: null })
  useMapStore.setState({ regionId: 'us', selectedFieldId: null, selectedPolygonId: null, polygonClass: null, numbersOpen: false })
})

describe('the Field numbers panel (block 6 revision 5 R-01, R-05, AC-01, AC-02)', () => {
  it('mounts one landmark named Field numbers only after its button is pressed', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    // B4: no panel is open at first paint.
    expect(screen.queryByRole('region', { name: 'Field numbers' })).toBeNull()
    await selectField(user)
    await user.click(screen.getByRole('button', { name: 'Field numbers' }))
    const panels = screen.getAllByRole('region', { name: 'Field numbers' })
    expect(panels).toHaveLength(1)
    expect(within(panels[0]).getByRole('heading', { level: 2, name: 'Field numbers' })).toBeTruthy()
  })

  it('writes no URL parameter and leaves every map screen box mounted', async () => {
    const search = '?region=br&date=2026-11-12&basemap=eox-s2cloudless-2024'
    window.history.replaceState({}, '', `/${search}`)
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await selectField(user)
    await user.click(screen.getByRole('button', { name: 'Field numbers' }))
    expect(window.location.search).toBe(search)
    expect(screen.getByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Layers' })).toBeTruthy()
    expect(document.querySelector('.app-shell')?.className).toBe('app-shell')
  })

  it('closes from its own button and returns the focus to it', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await selectField(user)
    const button = screen.getByRole('button', { name: 'Field numbers' })
    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await user.click(button)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Field numbers' })).toBeNull())
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('is disabled with its reason in the accessible name while nothing is selected (B5)', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    // The app selects the region's first fixture at load, so the test clears the selection the way
    // an empty map click does before reading the disabled state.
    act(() => useMapStore.setState({ selectedFieldId: null, selectedPolygonId: null }))
    const button = screen.getByRole('button', { name: 'Field numbers, select a polygon first' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('prints the cards, the chart, the provenance table and the gap register inside the panel', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await selectField(user)
    await user.click(screen.getByRole('button', { name: 'Field numbers' }))
    const panel = await screen.findByRole('region', { name: 'Field numbers' })
    for (const card of ['Climate', 'Water balance', 'Soil moisture, SMAP', 'Vegetation, NDVI', 'Soil', 'Rotation history', 'Municipal context', 'Counter evidence']) {
      expect(within(panel).getByText(card)).toBeTruthy()
    }
    expect(within(panel).getByText('Gap register')).toBeTruthy()
  })

  it('calls map.resize zero times in any of the four panel states, and keeps the camera (AC-02)', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(MapStub.instances.length).toBeGreaterThan(0))
    await selectField(user)
    const map = MapStub.last()
    map.center = { lng: -55.27, lat: -11.91 }
    map.zoom = 11.5
    const resizes = map.resizeCalls
    const camera = () => ({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() })
    const before = camera()

    // Block 6 revision 5 R-02 and AC-02: the map is never hidden, so no panel state may resize it.
    // The four buttons are pressed once each, which opens and then closes every panel in turn.
    const buttons = [
      'Expand Rotation outlook',
      'Field numbers',
      'Planting calendar',
      'Field record',
    ]
    for (const name of buttons) {
      const button = screen.getByRole('button', { name })
      await user.click(button)
      await waitFor(() => expect(document.querySelector('[data-panel-host]')).toBeTruthy())
      expect(map.resizeCalls).toBe(resizes)
      expect(camera()).toEqual(before)
      await user.click(button)
      await waitFor(() => expect(document.querySelector('[data-panel-host]')).toBeNull())
      expect(map.resizeCalls).toBe(resizes)
      expect(camera()).toEqual(before)
    }
    expect(map.resizeCalls).toBe(resizes)
  })
})

describe('the module boundaries and the catalogue (R-01, R-11, AC-01, AC-10)', () => {
  it('imports none of the four right edge modules from the numbers surface', () => {
    for (const file of ['src/components/NumbersView.tsx', 'src/components/NumbersToggle.tsx', 'src/lib/numbers.ts', 'src/lib/numbers-api.ts']) {
      const source = readFileSync(`${process.cwd()}/${file}`, 'utf8')
      for (const forbidden of ['CommandToggle', 'SupportingDataToggle', 'EvidencePanel', 'AgentBar']) {
        expect(source).not.toMatch(new RegExp(`from ['"][^'"]*${forbidden}['"]`))
      }
    }
  })

  it('keeps the pt-BR catalogue empty (R-11)', () => {
    expect(Object.keys(ptBR)).toEqual([])
  })

  it('does not add a raster source or a numbers layer to the map style (R-14, AC-13)', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await selectField(user)
    await user.click(screen.getByRole('button', { name: 'Field numbers' }))
    const map = MapStub.last()
    const ids = [...map.sources.keys(), ...map.layers.map((layer) => layer.id)]
    expect(ids.filter((id) => id.startsWith('numbers'))).toEqual([])
  })
})
