import { usePanelStore } from '@/lib/panel-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMapStore } from '@/lib/map-store'
import { layersResponse } from '@/test/api-fixtures'
import App from '@/App'

/**
 * A controllable MapLibre stub: the test decides when `style.load` and `load` fire,
 * so both orderings between the basemap and the `/fields` response can be mounted.
 */
const mapBus = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>()
  return {
    on(event: string, callback: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(callback)
    },
    fire(event: string) {
      for (const callback of [...(handlers.get(event) ?? [])]) callback()
    },
    reset() {
      handlers.clear()
    },
  }
})

vi.mock('maplibre-gl', () => ({
  Map: class {
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    flyTo = vi.fn()
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
    on(event: string, callback: () => void) {
      mapBus.on(event, callback)
    }
    remove = vi.fn()
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

const fieldsResponse = { fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }

const scenariosResponse = (fieldId: string) => ({
  field_id: fieldId,
  season: '2025/26',
  state: 'ranked',
  threshold: null,
  coverage: 86,
  scenarios: [
    { id: 'current', name: 'Current sequence', is_current: true, crops: ['Soybean', 'Corn'], why: 'Current farm plan', evidence: 'Three supported seasons', benefit: 'Known operating fit', gap: 'No input-cost data', risk: 'Weather variability', evidence_rows: [] },
    { id: 'rotation-a', name: 'Soybean → Corn', is_current: false, crops: ['Soybean', 'Corn'], why: 'Alternates crop families', evidence: 'SMAP soil moisture', benefit: 'Diversifies rotation', gap: 'Market access unknown', risk: 'Dry-season stress', evidence_rows: [] },
    { id: 'rotation-b', name: 'Soybean → Cotton', is_current: false, crops: ['Soybean', 'Cotton'], why: 'Adds a fiber crop', evidence: 'Three supported seasons', benefit: 'Additional outlet', gap: 'Credit terms unknown', risk: 'Higher input demand', evidence_rows: [] },
  ],
})

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (new URL(url).pathname === '/layers') {
      return jsonResponse(layersResponse())
    }
    if (url.endsWith('/fields')) return jsonResponse(fieldsResponse)
    const fieldId = new URL(url).pathname.split('/')[2]
    return jsonResponse(scenariosResponse(fieldId))
  }))
}

/** Expands the Fields panel and waits until the field list is in state. */
async function expandFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Fields' }))
  const row = await waitFor(() => {
    const found = document.getElementById('fields-chip-row')
    expect(found).toBeTruthy()
    return found as HTMLElement
  })
  await waitFor(() => expect(within(row).getAllByRole('button')).toHaveLength(2))
}

async function expectSelectedFieldUi() {
  expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01')
  // Exactly one chip is pressed: the collapsed header chip, or the row chip when the
  // panel is open. Both read the same name.
  await waitFor(() => {
    const pressed = [...document.querySelectorAll('button.field-chip[aria-pressed="true"]')]
    expect(pressed.map((chip) => chip.textContent)).toEqual(['Santa Carmem North'])
  })
  expect(screen.getByText('86% data coverage')).toBeTruthy()
  const list = screen.getByRole('list', { name: 'Rotation scenarios' })
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
  expect(screen.queryByText('Select a field to view rotation scenarios.')).toBeNull()
}

beforeEach(() => {
  // Block 5 defaults the region to the United States (R-01) and lists only the active
  // region's fixtures (R-24), so these fixture flows run with Brazil active.
  window.history.replaceState({}, '', '/?region=br')
  useMapStore.setState({ regionId: 'br' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mapBus.reset()
  useMapStore.setState({ selectedFieldId: null, composition: 'map', regionId: 'us', selectedPolygonId: null })
  window.history.replaceState({}, '', '/')
})

describe('initial field selection does not depend on event ordering', () => {
  // Block 5.5 B4: the coverage pill and the cards live in the rotation panel, which the product
  // opens by a press; these cases open the same store value to reach the pill.
  beforeEach(() => {
    usePanelStore.setState({ open: 'rotation' })
  })

  it('selects the first field when the field list lands before the map style and load never fires', async () => {
    // Load race: GET /fields resolves while the basemap style is still loading. Only
    // `style.load` follows, `load` never fires (it waits on every source in the remote
    // style), so the old `load`-handler selection never ran. Measured failure mode:
    // no chip, 0% coverage, rotation panel empty, permanently.
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await expandFields(user)

    act(() => {
      mapBus.fire('style.load')
    })

    await expectSelectedFieldUi()
  })

  it('selects the first field when the map style is ready before the field list arrives', async () => {
    // The opposite order: the map reaches style.load and load before the delayed
    // /fields response, which is what the old effect covered.
    let resolveFields: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (new URL(url).pathname === '/layers') {
        return Promise.resolve(jsonResponse(layersResponse()))
      }
      if (url.endsWith('/fields')) {
        return new Promise<Response>((resolve) => {
          resolveFields = resolve
        })
      }
      return Promise.resolve(jsonResponse(scenariosResponse(new URL(url).pathname.split('/')[2])))
    }))
    render(<App />)

    act(() => {
      mapBus.fire('style.load')
      mapBus.fire('load')
    })
    expect(useMapStore.getState().selectedFieldId).toBeNull()

    await act(async () => {
      resolveFields?.(jsonResponse(fieldsResponse))
    })

    await expectSelectedFieldUi()
  })
})
