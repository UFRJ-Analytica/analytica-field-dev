import { describe, expect, it, vi } from 'vitest'
import { POLYGON_DETAIL_SOURCE_ID, POLYGON_FILL_LAYER_ID, POLYGON_LINE_LAYER_ID, POLYGON_OVERVIEW_FILL_LAYER_ID, POLYGON_OVERVIEW_LINE_LAYER_ID, POLYGON_OVERVIEW_SOURCE_ID, addPolygonLayers, mountedTiers, polygonMode, polygonStatusLines, pmtilesSourceUrl } from './polygon-source'
import { REGION_ADAPTERS } from './regions'

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

type Call = { url: string }

/** One stub transport: the mode route and the manifest file, and nothing else. */
function transport(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url })
    const key = Object.keys(routes).find((entry) => url.includes(entry))
    const answer = key ? routes[key] : { status: 404, body: null }
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    } as unknown as Response
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const modeUs = {
  region: 'us',
  mode: 'self-hosted',
  classProperty: null,
  detail_minzoom: 6,
  detail_maxzoom: 14,
  overview_minzoom: 3,
  overview_maxzoom: 5,
  interactive_minzoom: 8,
}

/** R-09: Brazil Mode A, both files present, so the Table B overview tier is mounted. */

/** R-09: Brazil Mode B, the source-direct file, which carries no overview level (M-02). */

describe('hosting mode (R-09, AC-07)', () => {
  it('reads the mode once from the route and takes the United States bounds from the manifest', async () => {
    const { impl, calls } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    expect(calls.map((call) => call.url)).toEqual([
      '/polygons/mode?region=us',
      '/data/polygons/us-38017.manifest.json',
    ])
    expect(scene.mode).toBe('self-hosted')
    expect(scene.classSource).toBe('cdl-year')
    expect(scene.tiers).toEqual({
      detail: { minzoom: 6, maxzoom: 14 },
      overview: { minzoom: 3, maxzoom: 5 },
      interactiveMinzoom: 8,
    })
    expect(scene.detailUrl).toBe('pmtiles:///data/polygons/us-38017-detail.pmtiles/{z}/{x}/{y}')
    expect(scene.overviewUrl).toBe('pmtiles:///data/polygons/us-38017-overview.pmtiles/{z}/{x}/{y}')
    expect(scene.failure).toBeNull()
  })

  it('reports the build missing when the manifest is absent, with no fallback bound', async () => {
    const { impl } = transport({ '/polygons/mode?region=us': { body: modeUs } })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    expect(scene.tiers).toBeNull()
    expect(scene.detailUrl).toBeNull()
    expect(scene.failure).toBe('polygon.build_not_available')
  })

  it('refuses a route whose zoom values disagree with the manifest', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: { ...modeUs, detail_minzoom: 9 } },
      'us-38017.manifest.json': { body: manifest },
    })
    await expect(polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })).rejects.toThrow(/detail_minzoom/)
  })





  it('builds a pmtiles template for a relative file and an absolute source', () => {
    expect(pmtilesSourceUrl('data/polygons/x.pmtiles')).toBe('pmtiles:///data/polygons/x.pmtiles/{z}/{x}/{y}')
    expect(pmtilesSourceUrl('https://host/x.pmtiles')).toBe('pmtiles://https://host/x.pmtiles/{z}/{x}/{y}')
  })
})

/** The smallest map the source module needs, with the same insert-before semantics. */
type FakeLayer = { id: string; type: string; [key: string]: unknown }

function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>()
  const layers: FakeLayer[] = [
    { id: 'land', type: 'fill', source: 'openmaptiles' },
    { id: 'place-label', type: 'symbol' },
  ]
  const map = {
    sources,
    layers,
    addSource: vi.fn((id: string, spec: Record<string, unknown>) => { sources.set(id, spec) }),
    getSource: vi.fn((id: string) => sources.get(id)),
    addLayer: vi.fn((layer: FakeLayer, beforeId?: string) => {
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : -1
      if (index >= 0) layers.splice(index, 0, layer)
      else layers.push(layer)
    }),
    getLayer: vi.fn((id: string) => layers.find((layer) => layer.id === id)),
    getStyle: vi.fn(() => ({ layers })),
    setPaintProperty: vi.fn(),
    setLayoutProperty: vi.fn(),
  }
  return map
}

describe('sources and layers (R-04, R-06, AC-02)', () => {
  it('adds one vector source per tier with Table B bounds and the id property promoted', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    const map = fakeMap()
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    const detail = map.sources.get(POLYGON_DETAIL_SOURCE_ID)
    expect(detail).toMatchObject({
      type: 'vector',
      minzoom: 6,
      maxzoom: 14,
      promoteId: 'csbid',
      tiles: ['pmtiles:///data/polygons/us-38017-detail.pmtiles/{z}/{x}/{y}'],
    })
    const overview = map.sources.get(POLYGON_OVERVIEW_SOURCE_ID)
    expect(overview).toMatchObject({ type: 'vector', minzoom: 3, maxzoom: 5 })
    expect(overview).not.toHaveProperty('promoteId')
    expect(map.sources.size).toBe(2)
  })

  it('draws no polygon below the lowest mounted tier and hides the overview where the detail draws', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    const map = fakeMap()
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    const fill = map.layers.find((layer) => layer.id === POLYGON_FILL_LAYER_ID)
    const overviewFill = map.layers.find((layer) => layer.id === POLYGON_OVERVIEW_FILL_LAYER_ID)
    expect(fill).toMatchObject({ type: 'fill', source: 'trazo', minzoom: 6 })
    expect(fill).not.toHaveProperty('maxzoom')
    expect(overviewFill).toMatchObject({ type: 'fill', source: 'trazo-overview', minzoom: 3, maxzoom: 6 })
  })

  /**
   * AC-04: the overview has to draw at its own last zoom. A MapLibre layer draws while
   * `minzoom <= z < maxzoom`, and the layer's `maxzoom` is exclusive, so `maxzoom` equal to the
   * tier's last zoom stopped the overview one zoom short: measured on the running page, zero
   * overview features at zoom 5 in the United States, and 0 at zoom 7 in Brazil.
   */

  it('keeps the overview source on the tier range, so MapLibre overzooms nothing above it (AC-04)', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    const map = fakeMap()
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    expect(map.sources.get(POLYGON_OVERVIEW_SOURCE_ID)).toMatchObject({ minzoom: 3, maxzoom: 5 })
  })

  it('puts the polygon layers above the style and below its symbols', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    const map = fakeMap()
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    const ids = map.layers.map((layer) => layer.id)
    expect(ids).toEqual([
      'land',
      POLYGON_OVERVIEW_FILL_LAYER_ID,
      POLYGON_OVERVIEW_LINE_LAYER_ID,
      POLYGON_FILL_LAYER_ID,
      POLYGON_LINE_LAYER_ID,
      'place-label',
    ])
  })


  it('is idempotent, so a restyle re-adds nothing twice', async () => {
    const { impl } = transport({
      '/polygons/mode?region=us': { body: modeUs },
      'us-38017.manifest.json': { body: manifest },
    })
    const scene = await polygonMode(REGION_ADAPTERS.us, { fetch: impl, apiBase: '' })
    const map = fakeMap()
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    const layerCount = map.layers.length
    addPolygonLayers(map, REGION_ADAPTERS.us, scene, 'cdl2025')
    expect(map.layers.length).toBe(layerCount)
    expect(map.addSource).toHaveBeenCalledTimes(2)
  })

})

describe('status lines (R-07, R-12, AC-09)', () => {
  const tiers = { detail: { minzoom: 6, maxzoom: 14 }, overview: { minzoom: 3, maxzoom: 5 }, interactiveMinzoom: 8 }

  it('prints the lowest mounted tier and the interactive line below it', () => {
    const scene = { regionId: 'us' as const, mode: 'self-hosted' as const, classSource: 'cdl-year' as const,
      tiers, detailUrl: 'x', overviewUrl: 'y', failure: null }
    expect(polygonStatusLines(scene, 2)).toEqual({
      failure: null,
      zoomLine: { lowest: 3 },
      selectLine: { interactive: 8 },
    })
    expect(polygonStatusLines(scene, 7).selectLine).toEqual({ interactive: 8 })
    expect(polygonStatusLines(scene, 8).selectLine).toBeNull()
    expect(polygonStatusLines(scene, 11)).toEqual({ failure: null, zoomLine: { lowest: 3 }, selectLine: null })
  })

  it('prints no zoom or select line when no tier is mounted, only the failure line', () => {
    const empty = { regionId: 'us' as const, mode: 'unavailable' as const, classSource: null,
      tiers: null, detailUrl: null, overviewUrl: null, failure: 'polygon.build_not_available' as const }
    expect(polygonStatusLines(empty, 11)).toEqual({
      failure: 'polygon.build_not_available',
      zoomLine: null,
      selectLine: null,
    })
  })

  it('never prints a failure line for a zoom below a healthy floor', () => {
    const scene = { regionId: 'us' as const, mode: 'self-hosted' as const, classSource: 'cdl-year' as const,
      tiers: { detail: { minzoom: 8, maxzoom: 12 }, overview: { minzoom: 5, maxzoom: 7 }, interactiveMinzoom: 10 },
      detailUrl: 'x', overviewUrl: 'y', failure: null }
    const lines = polygonStatusLines(scene, 4)
    expect(lines.failure).toBeNull()
    expect(lines.zoomLine).toEqual({ lowest: 5 })
    expect(lines.selectLine).toEqual({ interactive: 10 })
  })

  /** AC-05, AC-09: Brazil Mode A mounts both tiers, so the line names the overview's 5. */

  /**
   * AC-05, AC-09: Brazil Mode B mounts no overview tier, and the zoom line named 5 anyway while the
   * lowest mounted tier was the detail at 8. The line reads the mounted tiers, never the Table B row.
   */

  /** AC-05, AC-09: the no-tier state prints the failure line and neither R-12 line. */
  it('prints no tier line at all when the region mounts no tier', () => {
    const noTier = { regionId: 'us' as const, mode: 'unavailable' as const, classSource: null,
      tiers: { detail: { minzoom: 8, maxzoom: 12 }, overview: null, interactiveMinzoom: 10 },
      detailUrl: null, overviewUrl: null, failure: 'polygon.build_not_available' as const }
    expect(mountedTiers(noTier)).toBeNull()
    expect(polygonStatusLines(noTier, 9)).toEqual({
      failure: 'polygon.build_not_available',
      zoomLine: null,
      selectLine: null,
    })
  })
})
