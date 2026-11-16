import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { chosenDateOf, useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { UNMAPPED_CLASS_COLOUR, paintedClassYear } from '@/lib/polygon-style'
import { REGION_ADAPTERS } from '@/lib/regions'
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

const modeBody = { region: 'br', mode: 'source-direct', classProperty: 'mbmode24' }

function installFetch(options: { axisDefault?: string } = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const parsed = new URL(url, 'http://localhost/')
    if (parsed.pathname === '/layers') {
      const response = layersResponse()
      const body = options.axisDefault
        ? { ...response, axis: { ...response.axis, default: options.axisDefault } }
        : response
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }
    if (parsed.pathname === '/polygons/mode') {
      return { ok: true, status: 200, json: async () => modeBody } as unknown as Response
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
        json: async () => ({
          field_id: 'mt-santa-carmem-01',
          season: '2025/26',
          state: 'ranked',
          threshold: null,
          coverage: 86,
          scenarios: [],
        }),
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  }))
  return calls
}

beforeEach(() => {
  // The rotation panel was removed in the strip cleanup (PR #42); no panel is open by default.
  usePanelStore.setState({ open: null })
  MapStub.reset()
  useMapStore.setState({
    regionId: 'us',
    selectedFieldId: null,
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    chosenDate: null,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  useMapStore.setState({ regionId: 'us', selectedFieldId: null, selectedPolygonId: null, polygonClass: null })
})


describe('the polygon selection in the app (R-23, R-24, R-28, AC-19, AC-20, AC-24)', () => {


  it('reads the chip year through chosenDateOf, not the live axis default (R-21, R-28)', async () => {
    // The live axis default is 2022-06-01 while the static LAYER_AXIS default is 2026-11-14.
    // The tooltip, the legend and the readout read chosenDateOf, so the chip must too.
    window.history.replaceState({}, '', '/')
    installFetch({ axisDefault: '2022-06-01' })
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().axis.default).toBe('2022-06-01'))

    act(() => {
      useMapStore.getState().selectField('csb:381825001868504')
      useMapStore.getState().setPolygonClass(
        { classId: null, name: null, hex: UNMAPPED_CLASS_COLOUR, unmapped: true },
        { classValue: null, area: 12.5 },
      )
    })

    const expectedYear = paintedClassYear(REGION_ADAPTERS.us, chosenDateOf(useMapStore.getState()))
    const chip = await screen.findByRole('button', { name: `No CDL class for ${expectedYear}` })
    expect(chip.textContent).toBe(`No CDL class for ${expectedYear}`)
    expect(screen.queryByRole('button', { name: 'No CDL class for 2022' })).toBeNull()
  })

})

describe('the rotation panel while a polygon is selected (R-26, R-49, AC-22, AC-41)', () => {

  it('AC-41: prints no 2025/26 season chip while the polygon is the selected field', async () => {
    window.history.replaceState({}, '', '/')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('us'))
    act(() => {
      useMapStore.getState().selectField('csb:381825001868504')
    })
    await waitFor(() => expect(window.location.search).toContain('polygon=381825001868504'))
    expect(document.body.textContent ?? '').not.toContain('2025/26 season')
  })

})
