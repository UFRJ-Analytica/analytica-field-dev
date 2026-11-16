/**
 * Field Shift AI focus_geometry on the real map canvas (MapLibre stubbed): the canvas frames the selected
 * field's own boundary, keeps it clear of the assistant panel, never past zoom 13, and reports back.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapCanvas } from './MapCanvas'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { buildLayerCatalog } from '@/lib/layer-catalog'
import { RECORDED_LAYERS_RESPONSE } from '@/lib/recorded-layers-response'
import { MapStub } from '@/test/maplibre-stub'

vi.mock('maplibre-gl', async () => {
  const { MapStub: Stub } = await import('@/test/maplibre-stub')
  return {
    Map: Stub,
    NavigationControl: class {},
    AttributionControl: class { onAdd() { return {} } onRemove() {} },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  }
})

const FIELD: FieldSummary = {
  id: 'mt-santa-carmem-01', name: 'Field 01', location: 'Santa Carmem, Mato Grosso', coverage: 86, center: [-55.27, -11.91],
  boundary: { type: 'Polygon', coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
}

beforeEach(() => {
  MapStub.reset()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false, status: 404, headers: new Headers(), json: async () => null, arrayBuffer: async () => new ArrayBuffer(0),
  }) as unknown as Response))
  const catalog = buildLayerCatalog(RECORDED_LAYERS_RESPONSE)
  useMapStore.setState({
    regionId: 'us', selectedFieldId: FIELD.id, selectedPolygonId: null, polygonRing: null, catalog, on: {},
    order: catalog.map((e) => e.id), chosenDate: '2026-11-11', axis: RECORDED_LAYERS_RESPONSE.axis,
    focusRequest: null, focusHandled: null,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Field Shift AI focus_geometry on the map canvas', () => {
  it('frames the selected field boundary with the panel inset, at most zoom 13, and reports it', async () => {
    render(<MapCanvas fields={[FIELD]} selectedField={FIELD} />)
    const map = MapStub.last()
    let seq = 0
    act(() => { seq = useMapStore.getState().requestFocus(48, 400) })
    await waitFor(() => expect(map.fitBoundsCalls).toHaveLength(1))
    expect(map.fitBoundsCalls[0]).toEqual([[-55.285, -11.92], [-55.26, -11.9]])
    expect(useMapStore.getState().focusHandled).toEqual({ seq, ok: true, reason: 'framed' })
  })

  it('answers no_selection and moves nothing when no field or polygon is selected', async () => {
    useMapStore.setState({ selectedFieldId: null })
    render(<MapCanvas fields={[]} selectedField={null} />)
    const map = MapStub.last()
    let seq = 0
    act(() => { seq = useMapStore.getState().requestFocus(48) })
    await waitFor(() => expect(useMapStore.getState().focusHandled).toEqual({ seq, ok: false, reason: 'no_selection' }))
    expect(map.fitBoundsCalls).toHaveLength(0)
  })
})
