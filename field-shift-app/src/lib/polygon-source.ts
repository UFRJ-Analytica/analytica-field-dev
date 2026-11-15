/**
 * R-04, R-06, R-07, R-09, R-12 and R-20: the polygon sources and layers of the map surface.
 *
 * The module holds no zoom bound of its own (Expected Interface): the United States bounds
 * come from `data/polygons/us-38017.manifest.json` through `regions.ts`, Brazil's from Table
 * B, and the hosting mode from `GET /polygons/mode?region=`, read once per load.
 *
 * The paint is built from the active region's class table and the constants of R-14; the
 * feature state drives hover and selection. Nothing here writes a class hex or a fill opacity.
 */
import type { ExpressionSpecification } from 'maplibre-gl'
import {
  classTableFor,
  lowestMountedZoom,
  parseUsManifest,
  tiersFor,
  type ClassSource,
  type RegionAdapter,
  type RegionId,
  type RegionTiers,
} from './regions'
import {
  UNMAPPED_CLASS_COLOUR,
  classColourExpression,
  fillOpacityExpression,
  lineWidthExpression,
  POLYGON_LINE_COLOUR,
  POLYGON_LINE_OPACITY,
} from './polygon-style'

/** Table B: the two source ids and the source layer both tiers share. */
export const POLYGON_DETAIL_SOURCE_ID = 'trazo'
export const POLYGON_OVERVIEW_SOURCE_ID = 'trazo-overview'

/** The four polygon layers. The detail pair is the interactive one; the overview pair never is. */
export const POLYGON_FILL_LAYER_ID = 'polygon-fill'
export const POLYGON_LINE_LAYER_ID = 'polygon-line'
export const POLYGON_OVERVIEW_FILL_LAYER_ID = 'polygon-overview-fill'
export const POLYGON_OVERVIEW_LINE_LAYER_ID = 'polygon-overview-line'

export const POLYGON_LAYER_IDS = [
  POLYGON_OVERVIEW_FILL_LAYER_ID,
  POLYGON_OVERVIEW_LINE_LAYER_ID,
  POLYGON_FILL_LAYER_ID,
  POLYGON_LINE_LAYER_ID,
] as const

/** R-11, in the string catalog keys the region prints. */
export type PolygonFailureKey = 'polygon.build_not_available' | 'polygon.source_unavailable'

export type PolygonScene = {
  regionId: RegionId
  mode: 'self-hosted' | 'source-direct' | 'unavailable'
  /** R-18: the one class source this load paints, or null when no tier is mounted. */
  classSource: ClassSource | null
  tiers: RegionTiers | null
  /** R-04: the `pmtiles` protocol template of each mounted tier. */
  detailUrl: string | null
  overviewUrl: string | null
  failure: PolygonFailureKey | null
}

export type PolygonModeDeps = {
  fetch?: typeof fetch
  apiBase?: string
}

/** R-09: the source-direct fallback of Brazil, which answers HTTP 206 to a range request (M-01). */
const DEFAULT_API_BASE = 'http://localhost:8000'

/**
 * R-04: the `pmtiles` protocol tile template. The source declares this as its `tiles` array and
 * not as a `url`: MapLibre's TileJSON path over `pmtiles://` returned no tiles for the small
 * overview archive (measured 2026-11-14: the source resolved with `minzoom` 0, `maxzoom` 22 and
 * no `tiles`, so no tile was ever requested), while the explicit template loads both tiers.
 * The zoom bounds stay the ones the manifest and Table B fix, not the archive's own.
 */
export function pmtilesSourceUrl(fileOrUrl: string): string {
  const base = fileOrUrl.startsWith('http') ? fileOrUrl : `/${fileOrUrl.replace(/^\/+/, '')}`
  return `pmtiles://${base}/{z}/{x}/{y}`
}

/** R-11: which of the two reason lines a region prints when it has no tier. */
export function polygonFailureFor(region: RegionAdapter): PolygonFailureKey {
  return region.id === 'us' ? 'polygon.build_not_available' : 'polygon.source_unavailable'
}

type ModeBody = {
  region?: string
  mode?: string
  classProperty?: string | null
  detail_minzoom?: number
  detail_maxzoom?: number
  overview_minzoom?: number
  overview_maxzoom?: number
  interactive_minzoom?: number
}

function emptyScene(region: RegionAdapter, failure: PolygonFailureKey): PolygonScene {
  return {
    regionId: region.id,
    mode: 'unavailable',
    classSource: null,
    tiers: null,
    detailUrl: null,
    overviewUrl: null,
    failure,
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/**
 * R-09 and R-05: one mode read per load, then the region's own zoom contract. The United
 * States reads the manifest and refuses a route whose numbers disagree with it, so the build
 * and the app cannot paint two different ranges. Brazil reads no manifest at all (AC-03).
 */
export async function polygonMode(region: RegionAdapter, deps: PolygonModeDeps = {}): Promise<PolygonScene> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const apiBase = deps.apiBase ?? (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE
  let body: ModeBody
  try {
    body = (await readJson(await fetchImpl(`${apiBase}/polygons/mode?region=${region.id}`))) as ModeBody
  } catch {
    return emptyScene(region, polygonFailureFor(region))
  }

  if (region.id === 'us') {
    if (body.mode !== 'self-hosted') {
      // R-09: the Feature Service is the build input only, never a render path.
      return emptyScene(region, 'polygon.build_not_available')
    }
    let manifest
    try {
      const file = region.manifestFile
      if (!file) throw new Error('the United States manifest path is a Table A value')
      manifest = parseUsManifest(await readJson(await fetchImpl(`/${file}`)))
    } catch {
      return emptyScene(region, 'polygon.build_not_available')
    }
    if (body.detail_minzoom !== undefined && body.detail_minzoom !== manifest.detail_minzoom) {
      throw new Error(
        `the mode route reports detail_minzoom ${body.detail_minzoom} but the manifest says ${manifest.detail_minzoom}`,
      )
    }
    return {
      regionId: 'us',
      mode: 'self-hosted',
      classSource: 'cdl-year',
      tiers: tiersFor('us', manifest),
      detailUrl: pmtilesSourceUrl(region.detailFile),
      overviewUrl: pmtilesSourceUrl(region.overviewFile),
      failure: null,
    }
  }

  const classSource = body.classProperty === 'class_id' ? 'class_id' : body.classProperty === 'mbmode24' ? 'mbmode24' : null
  if (classSource === null) {
    // R-18: a load that names no single class property cannot paint, and guessing one would mix two.
    throw new Error('the Brazil mode response must name mbmode24 or class_id as the one class property')
  }
  if (body.mode === 'self-hosted') {
    return {
      regionId: 'br',
      mode: 'self-hosted',
      classSource,
      tiers: tiersFor('br'),
      detailUrl: pmtilesSourceUrl(region.detailFile),
      overviewUrl: pmtilesSourceUrl(region.overviewFile),
      failure: null,
    }
  }
  if (body.mode === 'source-direct') {
    const sourceUrl = region.sourceDirectUrl
    if (!sourceUrl) return emptyScene(region, 'polygon.source_unavailable')
    return {
      regionId: 'br',
      mode: 'source-direct',
      classSource,
      tiers: tiersFor('br'),
      detailUrl: pmtilesSourceUrl(sourceUrl),
      // The source file carries no overview level (M-02), so Mode B mounts no overview tier.
      overviewUrl: null,
      failure: null,
    }
  }
  return emptyScene(region, 'polygon.source_unavailable')
}

/** The map surface this module writes to: the MapLibre methods, and nothing else. */
export type PolygonMap = {
  getSource(id: string): unknown
  addSource(id: string, spec: unknown): unknown
  getLayer(id: string): unknown
  addLayer(layer: unknown, beforeId?: string): unknown
  getStyle(): { layers?: ReadonlyArray<{ id: string; type: string }> }
  setPaintProperty?(id: string, property: string, value: unknown): unknown
}

/** R-36: the insertion point is the style's first symbol layer, so the basemap and the polygons stay below the labels. */
export function firstSymbolLayerId(map: PolygonMap): string | undefined {
  return (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
}

function fillPaint(property: string, table: ReturnType<typeof classTableFor>): Record<string, unknown> {
  return {
    'fill-color': classColourExpression(property, table.rows) as ExpressionSpecification,
    'fill-opacity': fillOpacityExpression() as ExpressionSpecification,
    // R-45: no timer and no animation moves a class colour or an opacity.
    'fill-opacity-transition': { duration: 0, delay: 0 },
    'fill-antialias': true,
  }
}

function linePaint(): Record<string, unknown> {
  return {
    'line-color': POLYGON_LINE_COLOUR,
    'line-opacity': POLYGON_LINE_OPACITY,
    'line-width': lineWidthExpression() as ExpressionSpecification,
    'line-width-transition': { duration: 0, delay: 0 },
  }
}

/**
 * R-06, AC-04: the `maxzoom` a layer needs to draw at the last zoom of its own range.
 *
 * A MapLibre layer draws at `minzoom` and stops at `maxzoom`, because a layer's `maxzoom` is
 * exclusive. A layer whose `maxzoom` equals the tier's last zoom therefore stops one zoom short of
 * it: measured on the running page, the overview drew nothing at zoom 5 in the United States and
 * nothing at zoom 7 in Brazil, while the archive at 5/7/11 holds 52 Polygon and 1 MultiPolygon
 * feature and renders 53 features once the range is widened by one. The tier's own numbers stay the
 * contract (Table G and Table B); only the layer's exclusive bound carries the plus one.
 */
export function layerMaxzoomFor(tier: { maxzoom: number }): number {
  return tier.maxzoom + 1
}

/**
 * R-04 and R-06: one vector source per mounted tier, one fill and one line per tier.
 *
 * Idempotent: a restyle re-adds the same ids and nothing is mounted twice (R-36). Below a
 * tier's `minzoom` the source and the layer issue no request and draw nothing (R-07), and
 * the overview layer ends where the detail begins, so the two never draw the same field.
 */
export function addPolygonLayers(
  map: PolygonMap,
  region: RegionAdapter,
  scene: PolygonScene,
  classProperty: string,
): void {
  const tiers = scene.tiers
  if (!tiers || !scene.detailUrl) return
  const table = classTableFor(region.id)

  if (!map.getSource(POLYGON_DETAIL_SOURCE_ID)) {
    map.addSource(POLYGON_DETAIL_SOURCE_ID, {
      type: 'vector',
      // R-04: the protocol template as the source's own tile list, not as a TileJSON `url`.
      tiles: [scene.detailUrl],
      minzoom: tiers.detail.minzoom,
      maxzoom: tiers.detail.maxzoom,
      // R-19: the feature state call needs the id promoted, with its own type.
      promoteId: region.idProperty,
    })
  }
  if (tiers.overview && scene.overviewUrl && !map.getSource(POLYGON_OVERVIEW_SOURCE_ID)) {
    map.addSource(POLYGON_OVERVIEW_SOURCE_ID, {
      type: 'vector',
      tiles: [scene.overviewUrl],
      minzoom: tiers.overview.minzoom,
      maxzoom: tiers.overview.maxzoom,
    })
  }

  const beforeId = firstSymbolLayerId(map)
  const ensure = (layer: Record<string, unknown>) => {
    if (!map.getLayer(String(layer.id))) map.addLayer(layer, beforeId)
  }
  if (tiers.overview && scene.overviewUrl) {
    ensure({
      id: POLYGON_OVERVIEW_FILL_LAYER_ID,
      type: 'fill',
      source: POLYGON_OVERVIEW_SOURCE_ID,
      'source-layer': region.sourceLayer,
      minzoom: tiers.overview.minzoom,
      // AC-04: the layer's exclusive bound, so the tier draws at its own last zoom too.
      maxzoom: layerMaxzoomFor(tiers.overview),
      paint: fillPaint(classProperty, table),
    })
    ensure({
      id: POLYGON_OVERVIEW_LINE_LAYER_ID,
      type: 'line',
      source: POLYGON_OVERVIEW_SOURCE_ID,
      'source-layer': region.sourceLayer,
      minzoom: tiers.overview.minzoom,
      maxzoom: layerMaxzoomFor(tiers.overview),
      paint: linePaint(),
      layout: { 'line-join': 'round' },
    })
  }

  ensure({
    id: POLYGON_FILL_LAYER_ID,
    type: 'fill',
    source: POLYGON_DETAIL_SOURCE_ID,
    'source-layer': region.sourceLayer,
    // No `maxzoom`: above the detail maxzoom MapLibre overzooms the highest zoom tiles (R-05).
    minzoom: tiers.detail.minzoom,
    paint: fillPaint(classProperty, table),
  })
  ensure({
    id: POLYGON_LINE_LAYER_ID,
    type: 'line',
    source: POLYGON_DETAIL_SOURCE_ID,
    'source-layer': region.sourceLayer,
    minzoom: tiers.detail.minzoom,
    paint: linePaint(),
    layout: { 'line-join': 'round' },
  })
}

/** R-15: the paint is rebuilt when the region or the painted class year changes. */
export function repaintPolygonLayers(
  map: PolygonMap,
  region: RegionAdapter,
  classProperty: string,
  layerIds: readonly string[] = [POLYGON_FILL_LAYER_ID, POLYGON_OVERVIEW_FILL_LAYER_ID],
): void {
  const table = classTableFor(region.id)
  for (const layerId of layerIds) {
    if (!map.getLayer(layerId)) continue
    map.setPaintProperty?.(layerId, 'fill-color', classColourExpression(classProperty, table.rows))
  }
}

/** R-04: the properties the app reads, and the ones it must not. */
export const FORBIDDEN_PROPERTIES = [
  'rgb',
  'csbyears',
  'inside_x',
  'inside_y',
  'orig_fid',
  'SHAPE__Length',
  'SHAPE__Area',
  'hansen_covered_area',
  'hansen_loss_area',
  'mode_year',
  'firstyear',
  'firstyearmajority',
  'mbcov_area_2024',
  'mbvalid_area_2024',
] as const

/** R-12: the region's status lines, as keys and numbers, so card 3's region only renders them. */
export type PolygonStatusLines = {
  failure: PolygonFailureKey | null
  zoomLine: { lowest: number } | null
  selectLine: { interactive: number } | null
}

/**
 * R-07, R-12, AC-05, AC-09: the tiers this scene actually mounted, as the tier contract.
 *
 * A tier is mounted only when its numbers and its URL are both present. Brazil reads the Table B
 * overview numbers in every mode, but Mode B mounts no overview file (the source carries no overview
 * level, M-02), and the zoom line printed `Polygons from zoom 5` there while the lowest mounted tier
 * was the detail at 8. The line comes from this value, never from the manifest or the Table B row.
 */
export function mountedTiers(scene: PolygonScene): RegionTiers | null {
  if (!scene.tiers || !scene.detailUrl) return null
  return {
    ...scene.tiers,
    overview: scene.overviewUrl && scene.tiers.overview ? scene.tiers.overview : null,
  }
}

/**
 * R-07 and R-12: one zoom line over the lowest mounted tier, the select line only below the
 * interactive zoom, and never a failure line for a zoom below a healthy floor.
 */
export function polygonStatusLines(scene: PolygonScene, zoom: number): PolygonStatusLines {
  const mounted = mountedTiers(scene)
  if (!mounted) {
    return { failure: scene.failure ?? polygonFailureForById(scene.regionId), zoomLine: null, selectLine: null }
  }
  return {
    failure: null,
    zoomLine: { lowest: lowestMountedZoom(mounted) },
    selectLine: zoom < mounted.interactiveMinzoom ? { interactive: mounted.interactiveMinzoom } : null,
  }
}

function polygonFailureForById(regionId: RegionId): PolygonFailureKey {
  return regionId === 'us' ? 'polygon.build_not_available' : 'polygon.source_unavailable'
}

/** The unmapped colour is exported here too, so the legend and the chip share one value. */
export { UNMAPPED_CLASS_COLOUR }
