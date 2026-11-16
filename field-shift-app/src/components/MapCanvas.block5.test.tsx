import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MapCanvas, BASEMAP_LAYER_ID } from './MapCanvas'
import { useMapStore } from '@/lib/map-store'
import { buildLayerCatalog } from '@/lib/layer-catalog'
import { RECORDED_LAYERS_RESPONSE } from '@/lib/recorded-layers-response'
import { MapStub } from '@/test/maplibre-stub'
import {
  POLYGON_DETAIL_SOURCE_ID,
  POLYGON_FILL_LAYER_ID,
  POLYGON_LINE_LAYER_ID,
  POLYGON_OVERVIEW_FILL_LAYER_ID,
  POLYGON_OVERVIEW_SOURCE_ID,
} from '@/lib/polygon-source'

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

const manifest = {
  schema_version: '1',
  region: 'us',
  clip_box: '-97.20,46.90,-97.14,46.96',
  detail_minzoom: 6,
  detail_maxzoom: 14,
  overview_minzoom: 3,
  overview_maxzoom: 5,
  interactive_minzoom: 8,
}

const modeBodies: Record<string, unknown> = {
  us: {
    region: 'us',
    mode: 'self-hosted',
    classProperty: null,
    detail_minzoom: 6,
    detail_maxzoom: 14,
    overview_minzoom: 3,
    overview_maxzoom: 5,
    interactive_minzoom: 8,
  },
  br: { region: 'br', mode: 'self-hosted', classProperty: 'mbmode24' },
}

function installFetch() {
  const calls: string[] = []
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const parsed = new URL(url, 'http://localhost/')
    if (parsed.pathname === '/polygons/mode') {
      const region = parsed.searchParams.get('region') ?? 'us'
      return { ok: true, status: 200, json: async () => modeBodies[region] } as unknown as Response
    }
    if (parsed.pathname.endsWith('us-38017.manifest.json')) {
      return { ok: true, status: 200, json: async () => manifest } as unknown as Response
    }
    // The tile guard's own probe, answered so the one catalog layer this suite turns on draws.
    if (/^\/tiles\/[^/]+\//.test(parsed.pathname)) {
      const headers = new Headers()
      headers.set('X-Tile-Date', '2026-11-12')
      headers.set('X-Tile-Source', 'recorded')
      headers.set('X-Tile-Status', 'ok')
      return { status: 200, headers, arrayBuffer: async () => new ArrayBuffer(6400) } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

function resetStore(regionId: 'us' = 'us') {
  useMapStore.setState({
    regionId,
    selectedFieldId: null,
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonSourceError: null,
    basemapFailed: false,
    chosenDate: '2026-11-12',
    composition: 'satellite',
    compare: {},
    on: {},
    opacity: {},
    pinnedDates: {},
    tileDecisions: {},
  })
}

function stubColumnRect(rect: { left: number; top: number; right: number; bottom: number }) {
  const node = document.createElement('div')
  node.className = 'right-column-stack'
  node.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  }) as DOMRect
  document.body.appendChild(node)
  return node
}

let columns: HTMLElement[] = []

beforeEach(() => {
  MapStub.reset()
  resetStore()
  columns = []
  // jsdom has no layout, so the map container would measure 0 by 0 and the tooltip clamp
  // would be untestable. The canvas measures the contract's 1440x900 view; the column nodes
  // below carry their own rectangle.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('map-canvas')) {
      return {
        left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, x: 0, y: 0,
        toJSON: () => ({}),
      } as DOMRect
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const node of columns) node.remove()
  columns = []
  MapStub.reset()
  useMapStore.setState({ regionId: 'us', selectedPolygonId: null, selectedFieldId: null, polygonMode: null })
})

/** Mounts the canvas and waits until the polygon surface of the mode read is on the map. */
async function mountMap() {
  const calls = installFetch()
  render(<MapCanvas fields={[]} selectedField={null} />)
  const map = MapStub.last()
  await waitFor(() => expect(map.getSource(POLYGON_DETAIL_SOURCE_ID)).toBeTruthy())
  return { map, calls }
}

describe('sources, layers and the basemap (R-04, R-30, R-36, AC-02, AC-28)', () => {
  it('mounts one source per tier, the four layers and the one basemap layer in stack order', async () => {
    const { map } = await mountMap()
    expect(map.getSource(POLYGON_DETAIL_SOURCE_ID)).toMatchObject({
      type: 'vector',
      minzoom: 6,
      maxzoom: 14,
      promoteId: 'csbid',
      tiles: ['pmtiles:///data/polygons/us-38017-detail.pmtiles/{z}/{x}/{y}'],
    })
    expect(map.getSource(POLYGON_OVERVIEW_SOURCE_ID)).toMatchObject({ minzoom: 3, maxzoom: 5 })
    expect(map.getSource('basemap')).toMatchObject({
      type: 'raster',
      tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
      tileSize: 256,
      minzoom: 5,
      maxzoom: 14,
    })

    const ids = map.layers.map((layer) => layer.id)
    // The stub style carries one symbol layer, so the whole basemap and polygon stack is
    // inserted before it: the basemap first, then the polygon pair above the imagery and
    // below the labels (R-36, AC-28).
    expect(ids).toEqual([
      BASEMAP_LAYER_ID,
      POLYGON_OVERVIEW_FILL_LAYER_ID,
      'polygon-overview-line',
      POLYGON_FILL_LAYER_ID,
      POLYGON_LINE_LAYER_ID,
      'place-label',
    ])
  })

  /**
   * AC-11, R-36: the fill's composite is one 0.4 fill over the imagery, which is only true when no
   * raster sits above the polygons. The block 4 stack list used to move the on raster to the very top
   * of the style, above the polygon fill and above the labels: measured on the running page, the fill
   * implied alpha 0.159 to 0.166 at 12 interior points of one class 41 polygon with `smap-l3` on at
   * 0.55, and 0.398 to 0.402 once the raster sat below the polygons (artifacts/AC-11-alpha.json).
   */
  it('keeps an on raster under the field polygons and above the basemap (AC-11, R-36)', async () => {
    const catalog = buildLayerCatalog(RECORDED_LAYERS_RESPONSE)
    useMapStore.setState({ catalog, on: { 'smap-l3': true }, order: catalog.map((entry) => entry.id) })
    installFetch()
    render(<MapCanvas fields={[]} selectedField={null} />)
    const map = MapStub.last()
    await waitFor(() => expect(map.getLayer(POLYGON_FILL_LAYER_ID)).toBeTruthy())
    await waitFor(() => expect(map.getLayer('smap-l3-raster')).toBeTruthy())
    const ids = map.layers.map((layer) => layer.id)
    const basemap = ids.indexOf(BASEMAP_LAYER_ID)
    const raster = ids.indexOf('smap-l3-raster')
    const fill = ids.indexOf(POLYGON_FILL_LAYER_ID)
    const firstSymbol = map.layers.findIndex((layer) => layer.type === 'symbol')
    expect(basemap).toBeGreaterThanOrEqual(0)
    // imagery over the basemap, the field polygons over the imagery, the labels over everything.
    expect(raster).toBeGreaterThan(basemap)
    expect(fill).toBeGreaterThan(raster)
    expect(firstSymbol).toBeGreaterThan(fill)
  })

  it('mounts the basemap layer exactly once after a composition change (R-36)', async () => {
    const { map } = await mountMap()
    act(() => {
      useMapStore.getState().setComposition('map')
    })
    await waitFor(() => {
      expect(map.layoutCalls.some((call) => call.id === BASEMAP_LAYER_ID && call.value === 'none')).toBe(true)
    })
    const basemapLayers = map.layers.filter((layer) => String(layer.id).includes('basemap'))
    expect(basemapLayers).toHaveLength(1)
  })

  it('places the basemap above the style own fill and line layers and below its symbols, polygons between (AC-28)', async () => {
    // The Liberty order: a road-arrow symbol sits below a bridge line and above the labels. The
    // criterion needs the basemap above every own fill and line and below every own symbol, so
    // the arrow is raised above the imagery with the labels (the style's own order is kept).
    MapStub.styleLayers = [
      { id: 'water', type: 'fill', source: 'openmaptiles' },
      { id: 'road_motorway', type: 'line', source: 'openmaptiles' },
      { id: 'road_one_way_arrow', type: 'symbol', source: 'openmaptiles' },
      { id: 'bridge_link', type: 'line', source: 'openmaptiles' },
      { id: 'place-label', type: 'symbol', source: 'openmaptiles' },
    ]
    const { map } = await mountMap()
    const ids = map.layers.map((layer) => layer.id)
    const at = (id: string) => ids.indexOf(id)
    const basemap = at(BASEMAP_LAYER_ID)
    expect(basemap).toBeGreaterThanOrEqual(0)
    for (const own of ['water', 'road_motorway', 'bridge_link']) {
      expect(at(own), `${own} must sit below the basemap`).toBeLessThan(basemap)
    }
    for (const symbol of ['road_one_way_arrow', 'place-label']) {
      expect(at(symbol), `${symbol} must sit above the basemap`).toBeGreaterThan(basemap)
    }
    for (const polygon of [POLYGON_OVERVIEW_FILL_LAYER_ID, 'polygon-overview-line', POLYGON_FILL_LAYER_ID, POLYGON_LINE_LAYER_ID]) {
      expect(at(polygon), `${polygon} must sit above the basemap`).toBeGreaterThan(basemap)
      expect(at(polygon), `${polygon} must sit below the labels`).toBeLessThan(at('place-label'))
    }
  })

  it('sets the basemap failure from the map error event of the basemap source (R-35, AC-29)', async () => {
    const { map } = await mountMap()
    act(() => {
      map.emit('error', { sourceId: 'basemap', error: new Error('Failed to fetch'), tile: { tileID: 'z12' } })
    })
    expect(useMapStore.getState().basemapFailed).toBe(true)
  })

  it('does not set the basemap failure for an error of another source (R-35)', async () => {
    const { map } = await mountMap()
    act(() => {
      map.emit('error', { sourceId: 'openmaptiles', error: new Error('style tile failed'), tile: {} })
    })
    expect(useMapStore.getState().basemapFailed).toBe(false)
  })

  it('paints the United States with cdl{Y} of the painted year and no other table', async () => {
    const { map } = await mountMap()
    const fill = map.getLayer(POLYGON_FILL_LAYER_ID) as { paint: Record<string, unknown> }
    const colour = JSON.stringify(fill.paint['fill-color'])
    expect(colour).toContain('cdl2025')
    expect(colour).toContain('#267000')
    // A Brazil hex never appears in a United States paint (R-03).
    expect(colour).not.toContain('#f5b3c8')
    expect(useMapStore.getState().polygonClassYear).toBe(2025)
  })

  it('names the offline build when the manifest is absent and adds no polygon source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input), 'http://localhost/')
      if (parsed.pathname === '/polygons/mode') {
        return { ok: true, status: 200, json: async () => modeBodies.us } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response
    }))
    render(<MapCanvas fields={[]} selectedField={null} />)
    const map = MapStub.last()
    await waitFor(() => expect(useMapStore.getState().polygonSourceError).toBe('polygon.build_not_available'))
    expect(map.getSource(POLYGON_DETAIL_SOURCE_ID)).toBeUndefined()
    expect(useMapStore.getState().polygonMode?.tiers).toBeNull()
  })
})

describe('hover, selection and the tooltip (R-19, R-20, R-22, R-27, AC-15, AC-16, AC-18, AC-23)', () => {
  const feature = { id: '381825001868504', properties: { cdl2025: 5, csbacres: 153.18667449 } }

  it('sets the hover feature state with the raw string id and raises the cursor', async () => {
    const { map } = await mountMap()
    map.zoom = 12
    act(() => {
      map.emit('mousemove', { point: { x: 400, y: 300 }, features: [feature] })
    })
    await waitFor(() => {
      expect(map.featureStateCalls.at(-1)).toEqual({
        state: { source: 'trazo', sourceLayer: 'trazo', id: '381825001868504' },
        value: { hover: true },
      })
    })
    expect(map.cursor).toBe('pointer')
    const tooltip = document.querySelector('[data-polygon-tooltip]')
    expect(tooltip?.textContent).toBe('Soybeans')
    expect(tooltip?.getAttribute('aria-hidden')).toBe('true')
  })


  it('selects nothing and mounts no tooltip below the interactive zoom (AC-16)', async () => {
    const { map } = await mountMap()
    map.zoom = 7
    act(() => {
      map.emit('mousemove', { point: { x: 400, y: 300 }, features: [feature] })
      map.emit('click', { point: { x: 400, y: 300 }, features: [feature] })
    })
    expect(map.featureStateCalls).toHaveLength(0)
    expect(map.cursor).toBe('')
    expect(document.querySelector('[data-polygon-tooltip]')).toBeNull()
    expect(useMapStore.getState().selectedPolygonId).toBeNull()
  })

  it('suppresses the tooltip when its clamped box would meet the right edge column', async () => {
    columns.push(stubColumnRect({ left: 1018, top: 60, right: 1418, bottom: 393 }))
    const { map } = await mountMap()
    map.zoom = 12
    act(() => {
      map.emit('mousemove', { point: { x: 1000, y: 300 }, features: [feature] })
    })
    expect(document.querySelector('[data-polygon-tooltip]')).toBeNull()
    // The hover state itself is still set: only the tooltip is suppressed.
    expect(map.featureStateCalls.at(-1)?.value).toEqual({ hover: true })
  })

  it('clears the hover state when the pointer leaves the polygon', async () => {
    const { map } = await mountMap()
    map.zoom = 12
    act(() => {
      map.emit('mousemove', { point: { x: 400, y: 300 }, features: [feature] })
    })
    act(() => {
      map.emit('mouseleave', {})
    })
    await waitFor(() => {
      expect(map.featureStateCalls.at(-1)?.value).toEqual({ hover: false })
    })
    expect(document.querySelector('[data-polygon-tooltip]')).toBeNull()
    expect(map.cursor).toBe('')
  })
})


describe('the 360x640 rule (OD-03, R-40)', () => {
  it('mounts no polygon region at any width and no fourth surface', async () => {
    await mountMap()
    expect(screen.queryByRole('region', { name: 'Polygon' })).toBeNull()
    // The only block 5 element in the DOM is the transient tooltip, absent until a hover.
    expect(document.querySelectorAll('[data-polygon-tooltip]')).toHaveLength(0)
  })
})
