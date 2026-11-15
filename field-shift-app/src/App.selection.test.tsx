/**
 * Block 5.5, the selection model (U3, U4, U5 of `PLANO-TELA-UNICA-E-PAINEIS.md`, and block 7
 * revision 10 R-06).
 *
 * The user reported three faults on the running app and the code was fixed without a falsifier
 * for any of them. This file is that falsifier, one test per fault, each written against the
 * behaviour the user described rather than against the shape of the implementation:
 *
 *  - U4: selecting a second polygon must replace the first one's class, raw values and ring. Before
 *    the fix only `selectedPolygonId` was written, and `MapCanvas` treats a populated class as a
 *    finished resolution, so the first polygon stayed on screen.
 *  - U3: the readout must not mount while nothing is selected.
 *  - U5: a press on the map that hits no polygon must clear the selection and unmount the readout.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useMapStore } from '@/lib/map-store'
import type { ClassDisplay } from '@/lib/polygon-style'
import { usePanelStore } from '@/lib/panel-store'
import { layersResponse } from '@/test/api-fixtures'
import { MapStub } from '@/test/maplibre-stub'

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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input), 'http://localhost/')
    if (parsed.pathname === '/layers') {
      return { ok: true, status: 200, json: async () => layersResponse() } as unknown as Response
    }
    if (parsed.pathname === '/polygons/mode') {
      return { ok: true, status: 200, json: async () => ({ region: 'br', mode: 'source-direct', classProperty: 'mbmode24' }) } as unknown as Response
    }
    if (parsed.pathname.endsWith('/fields')) {
      return { ok: true, status: 200, json: async () => ({ fields: brazilFields, seasons: ['2025/26'], default_season: '2025/26' }) } as unknown as Response
    }
    if (parsed.pathname.includes('/fields/')) {
      return { ok: true, status: 200, json: async () => ({ field_id: 'mt-santa-carmem-01', season: '2025/26', state: 'ranked', threshold: null, coverage: 86, scenarios: [] }) } as unknown as Response
    }
    void init
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  }))
}

/** One class display, as the map writes it when a tile resolves the polygon. */
const CLASS_A: ClassDisplay = { classId: 1, name: 'Soybean', hex: '#1f7a1f', unmapped: false }
const CLASS_B: ClassDisplay = { classId: 5, name: 'Corn', hex: '#c9a227', unmapped: false }

/** The readout mounts above the narrow breakpoint only (block 5 R-36), so the harness is wide. */
function stubViewport(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  stubViewport(false)
  MapStub.reset()
  usePanelStore.setState({ open: null })
  useMapStore.setState({
    regionId: 'us',
    selectedFieldId: null,
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRaw: null,
    polygonRing: null,
  })
  window.history.replaceState({}, '', '/?region=br')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the selection model (U3, U4, U5)', () => {
  it('replaces the class, the raw values and the ring when a second polygon is selected (U4)', () => {
    // The first polygon resolves: the map writes its class, year, raw feature and ring.
    act(() => {
      useMapStore.getState().selectField('csb:381825001868504')
      useMapStore.getState().setPolygonClass(CLASS_A, { id: 'a', properties: { cdl2024: 1 } } as never)
      useMapStore.getState().setPolygonClassYear(2024)
      useMapStore.getState().setPolygonRing([[-97.2, 46.9], [-97.1, 46.9], [-97.1, 46.95], [-97.2, 46.9]])
    })

    const first = useMapStore.getState()
    expect(first.selectedPolygonId).not.toBeNull()
    expect(first.polygonClass).toEqual(CLASS_A)
    expect(first.polygonRing).not.toBeNull()

    // U4: the second press writes the whole selection in one set. Nothing of the first survives.
    act(() => {
      useMapStore.getState().selectField('csb:381825001868505')
    })

    const second = useMapStore.getState()
    expect(second.selectedPolygonId).not.toBe(first.selectedPolygonId)
    expect(second.polygonClass).toBeNull()
    expect(second.polygonClassYear).toBeNull()
    expect(second.polygonRaw).toBeNull()
    expect(second.polygonRing).toBeNull()

    // The readout the user saw stale is fed by these fields, so a null class here is what makes the
    // second polygon read its own values once its tile resolves.
    act(() => {
      useMapStore.getState().setPolygonClass(CLASS_B, { id: 'b', properties: { cdl2024: 5 } } as never)
    })
    expect(useMapStore.getState().polygonClass).toEqual(CLASS_B)
  })

  it('does not mount the readout while nothing is selected (U3)', async () => {
    installFetch()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })

    // The app selects the region's first fixture at load, so the test clears it the way an empty
    // map press does. What matters is that the readout follows the selection and nothing else.
    act(() => useMapStore.setState({ selectedFieldId: null, selectedPolygonId: null }))
    await waitFor(() => expect(useMapStore.getState().selectedPolygonId).toBeNull())

    expect(document.querySelector('[data-polygon-region]')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Polygon' })).toBeNull()
  })

  it('clears the selection on a press that hits no polygon, and unmounts the readout (U5)', async () => {
    installFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(MapStub.instances.length).toBeGreaterThan(0))

    // A polygon in place, with its class resolved, so the readout has something to print. The
    // selection is written through the store the way the map writes it, which keeps this test
    // about the press that clears and not about how a command id resolves per region.
    void user
    act(() => {
      useMapStore.setState({
        selectedFieldId: null,
        selectedPolygonId: '381825001868504',
        polygonClass: CLASS_A,
        polygonClassYear: 2024,
        polygonRing: [[-55.28, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.28, -11.9]],
      })
    })
    await waitFor(() => expect(document.querySelector('[data-polygon-region]')).not.toBeNull())

    // A press with no polygon under it: the stub answers `queryRenderedFeatures` with nothing, so
    // the map level handler at `MapCanvas.tsx` must clear instead of leaving the old selection.
    const map = MapStub.last()
    map.renderedFeatures = []
    act(() => {
      map.emit('click', { point: { x: 5, y: 5 }, lngLat: { lng: -55.27, lat: -11.91 }, features: [] })
    })

    await waitFor(() => expect(useMapStore.getState().selectedPolygonId).toBeNull())
    expect(useMapStore.getState().selectedFieldId).toBeNull()
    await waitFor(() => expect(document.querySelector('[data-polygon-region]')).toBeNull())
  })
})
