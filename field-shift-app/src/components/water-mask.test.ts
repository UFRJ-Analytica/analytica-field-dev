import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'

vi.mock('maplibre-gl', () => ({ Map: class {}, NavigationControl: class {}, AttributionControl: class {}, addProtocol: vi.fn(), setWorkerUrl: vi.fn() }))

const { placeWaterMask, WATER_MASK_LAYER_ID } = await import('./MapCanvas')
const { POLYGON_LAYER_IDS } = await import('@/lib/polygon-source')

type Layer = { id: string; type: string; source?: string; 'source-layer'?: string }

function fakeMap(layers: Layer[]) {
  const stack = [...layers]
  const map = {
    getStyle: () => ({ layers: stack }),
    getLayer: (id: string) => stack.find((layer) => layer.id === id),
    getPaintProperty: () => '#a0c8f0',
    setPaintProperty: vi.fn(),
    addLayer: (layer: Layer) => { stack.push(layer) },
    removeLayer: (id: string) => { stack.splice(stack.findIndex((layer) => layer.id === id), 1) },
    moveLayer: (id: string, before?: string) => {
      const [layer] = stack.splice(stack.findIndex((entry) => entry.id === id), 1)
      const at = before ? stack.findIndex((entry) => entry.id === before) : -1
      if (at < 0) stack.push(layer)
      else stack.splice(at, 0, layer)
    },
  }
  return { map: map as unknown as MapLibreMap, order: () => stack.map((layer) => layer.id) }
}

const water: Layer = { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' }
const catalog = [
  { id: 'lst-terra', surface: 'land' },
  { id: 'imerg-daily', surface: 'any' },
] as never

describe('the water mask over land-only layers', () => {
  it('sits above a land-only layer and below a layer that has values over water', () => {
    const { map, order } = fakeMap([water, { id: 'lst-terra-raster', type: 'raster' }, { id: 'imerg-daily-raster', type: 'raster' }])
    placeWaterMask(map, catalog, ['imerg-daily', 'lst-terra'], 'map')
    const ids = order()
    expect(ids.indexOf(WATER_MASK_LAYER_ID)).toBeGreaterThan(ids.indexOf('lst-terra-raster'))
    expect(ids.indexOf('imerg-daily-raster')).toBeGreaterThan(ids.indexOf(WATER_MASK_LAYER_ID))
  })

  it('is removed when no land-only layer is on', () => {
    const { map, order } = fakeMap([water, { id: 'lst-terra-raster', type: 'raster' }])
    placeWaterMask(map, catalog, ['lst-terra'], 'map')
    expect(order()).toContain(WATER_MASK_LAYER_ID)
    placeWaterMask(map, catalog, ['imerg-daily'], 'map')
    expect(order()).not.toContain(WATER_MASK_LAYER_ID)
  })

  it('keeps the mask and the rasters under the crop polygons and the labels', () => {
    const polygon = POLYGON_LAYER_IDS[0]
    const { map, order } = fakeMap([
      water,
      { id: 'lst-terra-raster', type: 'raster' },
      { id: 'imerg-daily-raster', type: 'raster' },
      { id: polygon, type: 'fill' },
      { id: 'place-label', type: 'symbol' },
    ])
    placeWaterMask(map, catalog, ['imerg-daily', 'lst-terra'], 'map')
    const ids = order()
    for (const id of [WATER_MASK_LAYER_ID, 'lst-terra-raster', 'imerg-daily-raster']) {
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf(polygon))
    }
    expect(ids.indexOf(polygon)).toBeLessThan(ids.indexOf('place-label'))
  })
})
