import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { chosenDateOf, useMapStore } from '@/lib/map-store'
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

describe('the region parameter (R-01, R-03, AC-01)', () => {
  it('defaults to the United States and lists no Brazil fixture chip', async () => {
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('us'))
    // AM-10: the Brazil fixture never appears on a United States map, and no CSB fixture exists.
    expect(screen.queryByRole('button', { name: 'Santa Carmem North' })).toBeNull()
    expect(window.location.search).not.toContain('region=')
  })

  it('activates Brazil from ?region=br and keeps the parameter in the URL', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('br'))
    expect(window.location.search).toContain('region=br')
    // The Brazil fixture list is the active region's, so its chip mounts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fields' })).toBeTruthy())
  })
})

describe('the polygon selection in the app (R-23, R-24, R-28, AC-19, AC-20, AC-24)', () => {
  it('writes ?polygon= with the raw id, shows the chip and clears the fixture chip', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('br'))

    act(() => {
      useMapStore.setState({
        polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false },
      })
      // R-22: the map runs the command; the command runs this store action.
      useMapStore.getState().selectField('trazo:39')
    })

    await waitFor(() => expect(window.location.search).toContain('polygon=39'))
    expect(window.location.search).toContain('region=br')
    expect(useMapStore.getState().selectedFieldId).toBeNull()

    const chip = screen.getByRole('button', { name: 'Soybean' })
    expect(chip.textContent).toBe('Soybean')
    expect(chip.getAttribute('aria-pressed')).toBe('true')

    // R-26 and AM-07: no coverage percentage for a polygon.
    expect(screen.queryByText(/data coverage/)).toBeNull()
  })

  it('clears ?polygon= when a fixture field is selected instead', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('br'))
    act(() => {
      useMapStore.getState().selectField('trazo:39')
    })
    await waitFor(() => expect(window.location.search).toContain('polygon=39'))

    act(() => {
      useMapStore.getState().selectField('mt-santa-carmem-01')
    })
    await waitFor(() => expect(window.location.search).not.toContain('polygon='))
    expect(useMapStore.getState().selectedPolygonId).toBeNull()
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01')
  })

  it('reads the chip year through chosenDateOf, not the live axis default (R-21, R-28)', async () => {
    // The live axis default is 2022-06-01 while the static LAYER_AXIS default is 2026-11-14.
    // The tooltip, the legend and the readout read chosenDateOf, so the chip must too.
    window.history.replaceState({}, '', '/')
    installFetch({ axisDefault: '2022-06-01' })
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().axis.default).toBe('2022-06-01'))

    act(() => {
      useMapStore.getState().setPolygonClass(
        { classId: null, name: null, hex: UNMAPPED_CLASS_COLOUR, unmapped: true },
        { classValue: null, area: 12.5 },
      )
      useMapStore.getState().selectField('csb:381825001868504')
    })

    const expectedYear = paintedClassYear(REGION_ADAPTERS.us, chosenDateOf(useMapStore.getState()))
    const chip = await screen.findByRole('button', { name: `No CDL class for ${expectedYear}` })
    expect(chip.textContent).toBe(`No CDL class for ${expectedYear}`)
    expect(screen.queryByRole('button', { name: 'No CDL class for 2022' })).toBeNull()
  })

  it('clears a ?polygon= that does not resolve in the active region', async () => {
    // A csb id under Brazil does not resolve: the app clears it instead of guessing.
    window.history.replaceState({}, '', '/?region=br&polygon=381825001868504')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().selectedPolygonId).toBeNull())
    await waitFor(() => expect(window.location.search).not.toContain('polygon='))
  })
})

describe('the rotation panel while a polygon is selected (R-26, R-49, AC-22, AC-41)', () => {
  it('AC-22: prints the polygon empty text, not the fixture copy, and requests no field scenarios', async () => {
    window.history.replaceState({}, '', '/')
    const calls = installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('us'))
    act(() => {
      useMapStore.getState().selectField('csb:381825001868504')
    })
    await waitFor(() => expect(window.location.search).toContain('polygon=381825001868504'))

    const panel = document.querySelector('[data-rotation-panel]') as HTMLElement
    expect(panel.textContent).toContain('No rotation scenarios are available for this field.')
    expect(panel.textContent).not.toContain('Select a field to view rotation scenarios.')
    expect(calls.some((url) => url.includes('/fields/'))).toBe(false)
  })

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

  it('keeps the fixture season chip for a fixture field (regression, block 3 R-07)', async () => {
    window.history.replaceState({}, '', '/?region=br')
    installFetch()
    render(<App />)
    await waitFor(() => expect(useMapStore.getState().regionId).toBe('br'))
    act(() => {
      useMapStore.getState().selectField('mt-santa-carmem-01')
    })
    await waitFor(() => expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01'))
    expect(document.body.textContent ?? '').toContain('2025/26 season')
  })
})
