import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  AttributionControl,
  Map as MapLibre,
  NavigationControl,
  addProtocol,
  setWorkerUrl,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { layerTileTemplate, VECTOR_BASEMAP_STYLE, type LayerCatalogEntry } from '@/lib/layer-catalog'
import {
  chosenDateOf,
  opacityOf,
  useMapStore,
  type CompareState,
  type CompositionPreset,
  type FieldSummary,
} from '@/lib/map-store'
import { activeBasemapAdapter, BASEMAP_ADAPTERS, type BasemapAdapter } from '@/lib/basemap-adapters'
import { probeLayerTile } from '@/lib/tile-guard'
import { regionAdapter, regionFromSearch, type RegionAdapter } from '@/lib/regions'
import {
  POLYGON_DETAIL_SOURCE_ID,
  POLYGON_FILL_LAYER_ID,
  POLYGON_LAYER_IDS,
  addPolygonLayers,
  polygonFailureFor,
  polygonMode,
  repaintPolygonLayers,
  type PolygonMap,
  type PolygonScene,
} from '@/lib/polygon-source'
import {
  POLYGON_INTERACTIVE_MIN_ZOOM,
  classDisplay,
  classPropertyFor,
  noCdlYearOf,
  paintedClassYear,
} from '@/lib/polygon-style'
import { classIdFrom, legendRowsForMap } from '@/lib/polygon-legend'
import { commandFieldId, featureStateCall } from '@/lib/polygon-selection'
import { placeTooltip, POLYGON_TOOLTIP_MAX_WIDTH, polygonTooltipText, type Box } from '@/lib/polygon-tooltip'
import { attributionCreditName, collapseAttributionControl, nameAttributionToggle, rawFeatureFrom } from '@/lib/polygon-readout'
import { runCommand } from '@/lib/commands'
import { outerRingOf } from '@/lib/numbers'
import { PolygonTooltip } from '@/components/PolygonTooltip'
import { t } from '@/strings'

// maplibre-gl derives its worker URL from import.meta.url. Vite's dev pre-bundle moves that module to
// node_modules/.vite/deps, where the worker file does not exist, so the worker 404s ("Worker failed to load")
// and no source ever loads. Pointing at the real file keeps dev and the production build working.
setWorkerUrl(maplibreWorkerUrl)

const COMPARE_SUFFIX = { a: '~compare-a', b: '~compare-b' } as const
export const COMPARE_DECISION_SUFFIX = '~compare-b'

export function rasterLayerId(layerId: string): string {
  return `${layerId}-raster`
}

function sourceIdFor(layerId: string, side?: 'a' | 'b'): string {
  return side ? `${layerId}${COMPARE_SUFFIX[side]}` : layerId
}

type MapCanvasProps = {
  fields: FieldSummary[]
  selectedField: FieldSummary | null
  onTileChange?: (tile: { z: number; x: number; y: number }) => void
  children?: ReactNode
}

function emitViewportTile(map: MapLibreMap, onTileChange?: MapCanvasProps['onTileChange']) {
  if (!onTileChange) return
  const zoom = Math.max(0, Math.min(30, Math.floor(map.getZoom())))
  const center = map.getCenter()
  const scale = 2 ** zoom
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, center.lat))
  const latitudeRadians = latitude * Math.PI / 180
  const x = Math.floor((center.lng + 180) / 360 * scale)
  const y = Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale)
  onTileChange({ z: zoom, x: Math.min(scale - 1, Math.max(0, x)), y: Math.min(scale - 1, Math.max(0, y)) })
}

/** R-16: the raster source takes its `maxzoom` from the registry entry, never a literal. */
type SourceLike = { setTiles?: (tiles: string[]) => void; setSourceProperty?: (callback: (source: unknown) => void) => void }

function readBounds(map: MapLibreMap): { west: number; south: number; east: number; north: number } {
  const bounds = map.getBounds?.()
  if (!bounds) return { west: -180, south: -85, east: 180, north: 85 }
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  }
}

function compareBounds(map: MapLibreMap, divider: number): { a: [number, number, number, number]; b: [number, number, number, number] } {
  const { west, south, east, north } = readBounds(map)
  const split = west + (east - west) * divider
  return {
    a: [west, south, split, north],
    b: [split, south, east, north],
  }
}

/**
 * R-36 and AC-28: the layer the app's imagery is inserted under.
 *
 * The polygon fill layer when the polygon surface is mounted, so imagery never covers a polygon;
 * otherwise the style's first symbol layer, so the labels stay readable in the two satellite
 * presets. A raster moved to the very top of the style (`moveLayer` with no anchor), which is how
 * the block 4 stack list used to be applied, lands above the polygon fill and above every label.
 * That is what veiled the polygons: measured on the running page at Brazil zoom 13 with the
 * Satellite preset and the default `smap-l3` layer on at 0.55, the fill implied alpha 0.159 to
 * 0.166 at 12 of 12 interior points of one class 41 polygon, and 0.398 to 0.402 at the same 12
 * points once the raster sat below the polygons (artifacts/AC-11-alpha.json).
 */
function imageryAnchor(map: MapLibreMap): string | undefined {
  // The first polygon layer present, so imagery and the water mask stay under every crop layer
  // (the overview pair and the detail pair) and never between them.
  return POLYGON_LAYER_IDS.find((id) => map.getLayer(id)) ?? firstSymbolId(map)
}

/**
 * R-36: the basemap goes under every catalog raster already mounted and under the polygons, so a
 * re-inserted basemap cannot cover the data layers of block 4 or the field polygons.
 */
function basemapInsertBefore(
  map: MapLibreMap,
  catalog: readonly LayerCatalogEntry[],
  plan: { before: string | undefined },
): string | undefined {
  const mounted = new Set((map.getStyle().layers ?? []).map((layer) => layer.id))
  for (const entry of catalog) {
    if (mounted.has(rasterLayerId(entry.id))) return rasterLayerId(entry.id)
  }
  return imageryAnchor(map) ?? plan.before
}

/**
 * R-19 and R-17: only a layer that is on owns a source and a layer, so a layer that is off
 * issues no tile request. Opacity is a paint property on `raster-opacity` and never removes
 * or re-adds a source, which is what AC-13 counts.
 */
function ensureRaster(
  map: MapLibreMap,
  entry: LayerCatalogEntry,
  tiles: string,
  side?: 'a' | 'b',
  bounds?: [number, number, number, number],
): boolean {
  const sourceId = sourceIdFor(entry.id, side)
  const layerId = rasterLayerId(entry.id) + (side ? COMPARE_SUFFIX[side] : '')
  const source = map.getSource(sourceId) as SourceLike | undefined
  const created = !source
  if (!source) {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [tiles],
      tileSize: 256,
      maxzoom: entry.max_zoom,
      ...(bounds ? { bounds } : {}),
      attribution: t('map.attribution'),
    })
  }
  if (!map.getLayer(layerId)) {
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      // A coarse product (SMAP is 9 km) is drawn as hard squares: smoothing it would suggest
      // detail the measurement does not have.
      paint: { 'raster-opacity': 0, ...(resolutionMetres(entry.resolution) >= 1000 ? { 'raster-resampling': 'nearest' as const } : {}) },
    }, imageryAnchor(map))
  }
  return created
}

/** Metres in a layer's resolution label (`9 km`, `250 m`, `about 11 km`); 0 when it cannot be read. */
export function resolutionMetres(label: string): number {
  const match = label.match(/([\d.]+)\s*(km|m)\b/i)
  if (!match) return 0
  const value = Number(match[1])
  return match[2].toLowerCase() === 'km' ? value * 1000 : value
}

function ensureFieldBoundaries(map: MapLibreMap, fields: FieldSummary[]) {
  for (const field of fields) {
    const id = `boundary-${field.id}`
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data: field.boundary })
    }
    if (!map.getLayer(id)) {
      map.addLayer({
        id,
        type: 'line',
        source: id,
        paint: { 'line-color': '#d5e86c', 'line-width': 2 },
      })
    }
  }
}

/**
 * Block 1 R-09 keeps the three composition presets, and block 1 R-10 keeps them from
 * remounting the map. Block 4 R-17 moves the raster itself to its own on/off state and its
 * own opacity, so the preset now only recomposes the labels of the basemap: the raster
 * opacity a user sets is the opacity the map shows, which is what AC-13 reads back.
 */
function applyComposition(map: MapLibreMap, composition: CompositionPreset) {
  const showLabels = composition !== 'satellite'
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === 'symbol') {
      map.setLayoutProperty(layer.id, 'visibility', showLabels ? 'visible' : 'none')
    }
  }
}

export const WATER_MASK_LAYER_ID = 'land-only-water-mask'
const SATELLITE_WATER = '#17324a'

/**
 * Land-only products (soil moisture, vegetation, land surface temperature) have kilometre
 * pixels, and a pixel on the coast spills its colour over the sea when zoomed in. The basemap's
 * own water polygons are drawn above those layers as a mask; layers that do have values over
 * water (rain, reflectance) are raised above the mask again, in their stack order.
 */
export function placeWaterMask(
  map: MapLibreMap,
  catalog: readonly LayerCatalogEntry[],
  stack: string[],
  composition: CompositionPreset,
) {
  const landOn = stack.some((id) => catalog.find((entry) => entry.id === id)?.surface === 'land')
  const water = (map.getStyle().layers ?? []).find(
    (layer) => layer.type === 'fill' && (layer as { 'source-layer'?: string })['source-layer'] === 'water',
  ) as { id: string; source?: string; filter?: unknown } | undefined
  if (!landOn || !water?.source) {
    if (map.getLayer(WATER_MASK_LAYER_ID)) map.removeLayer(WATER_MASK_LAYER_ID)
    return
  }
  const colour = composition === 'map'
    ? (map.getPaintProperty(water.id, 'fill-color') as string | undefined) ?? '#a0c8f0'
    : SATELLITE_WATER
  if (!map.getLayer(WATER_MASK_LAYER_ID)) {
    map.addLayer({
      id: WATER_MASK_LAYER_ID,
      type: 'fill',
      source: water.source,
      'source-layer': 'water',
      ...(water.filter ? { filter: water.filter as never } : {}),
      paint: { 'fill-color': colour, 'fill-opacity': 1 },
    })
  } else {
    map.setPaintProperty(WATER_MASK_LAYER_ID, 'fill-color', colour)
  }
  const ceiling = imageryAnchor(map)
  map.moveLayer(WATER_MASK_LAYER_ID, ceiling)
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const id = stack[index]
    if (catalog.find((entry) => entry.id === id)?.surface === 'land') continue
    for (const key of [rasterLayerId(id), `${rasterLayerId(id)}${COMPARE_SUFFIX.a}`, `${rasterLayerId(id)}${COMPARE_SUFFIX.b}`]) {
      if (map.getLayer(key)) map.moveLayer(key, ceiling)
    }
  }
}

/** R-18: the stack list puts its first item on top, so the list is applied bottom up. */
function applyOrder(map: MapLibreMap, order: string[]) {
  // R-36: the rasters keep their order among themselves and stay under the polygons and the labels.
  const before = imageryAnchor(map)
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const layerId = rasterLayerId(order[index])
    if (map.getLayer(layerId)) map.moveLayer(layerId, before)
  }
}

/** Table E: the one basemap raster source and layer this block mounts (R-30, R-36). */
export const BASEMAP_SOURCE_ID = 'basemap'
export const BASEMAP_LAYER_ID = 'basemap-raster'

/** R-04: the `pmtiles` protocol is registered once per page, not once per source. */
let pmtilesProtocolRegistered = false
export function ensurePmtilesProtocol(): void {
  if (pmtilesProtocolRegistered) return
  addProtocol('pmtiles', new Protocol().tile)
  pmtilesProtocolRegistered = true
}

/** R-33: the exact adapter string and the region's source string, in the control's own text. */
export function attributionText(adapter: BasemapAdapter, region: RegionAdapter): string {
  return `${adapter.attributionText} · ${region.sourceString} · ${t('map.attribution')}`
}

export function firstSymbolId(map: MapLibreMap): string | undefined {
  return (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
}

/**
 * R-36, AC-28: where the basemap goes and which of the style's own symbols it must not cover.
 *
 * The imagery sits above every fill and line of the style's own layers (its land, water, road
 * and boundary geometry) and below its symbols, so the labels stay readable. The style's own order
 * can put a symbol under one of those fills and lines: in OpenFreeMap Liberty the road-arrow
 * symbols sit under the bridge, building and boundary lines. The basemap goes directly before the
 * first symbol that follows the last such fill or line, and each own symbol that sits under that
 * point is raised to just above the imagery in its own order. Nothing else of the style moves.
 *
 * `ownIds` is the style's layer ids at `style.load`, before the app adds a layer, so the app's
 * boundary, class and raster layers are never read as the style's own.
 */
export function basemapStackPlan(
  layers: ReadonlyArray<{ id: string; type: string }>,
  ownIds: ReadonlySet<string>,
): { before: string | undefined; raise: string[] } {
  let lastOwnGeometry = -1
  layers.forEach((layer, index) => {
    if (ownIds.has(layer.id) && (layer.type === 'fill' || layer.type === 'line')) lastOwnGeometry = index
  })
  const anchor = layers.findIndex((layer, index) => index > lastOwnGeometry && layer.type === 'symbol')
  const raise = layers
    .filter((layer, index) => index < lastOwnGeometry && ownIds.has(layer.id) && layer.type === 'symbol')
    .map((layer) => layer.id)
  return { before: anchor >= 0 ? layers[anchor].id : undefined, raise }
}

/**
 * R-36: the basemap sits above the style's own fill and line layers and below its symbols, and
 * the polygon layers are raised above it, so imagery never hides a polygon.
 */
function ensureBasemap(
  map: MapLibreMap,
  adapter: BasemapAdapter,
  composition: CompositionPreset,
  ownIds: ReadonlySet<string>,
  catalog: readonly LayerCatalogEntry[],
): void {
  if (!map.getSource(BASEMAP_SOURCE_ID)) {
    map.addSource(BASEMAP_SOURCE_ID, {
      type: 'raster',
      tiles: [adapter.tiles],
      tileSize: adapter.tileSize,
      minzoom: adapter.minzoom,
      maxzoom: adapter.maxzoom,
    })
  }
  if (!map.getLayer(BASEMAP_LAYER_ID)) {
    const plan = basemapStackPlan(map.getStyle().layers ?? [], ownIds)
    const before = basemapInsertBefore(map, catalog, plan)
    map.addLayer({
      id: BASEMAP_LAYER_ID,
      type: 'raster',
      source: BASEMAP_SOURCE_ID,
      paint: { 'raster-opacity': 1 },
    }, before)
    for (const layerId of plan.raise) map.moveLayer(layerId, before)
  }
  // R-34: `Map` hides the basemap; the two satellite presets show it, and the labels are the
  // style's own symbol layers, which `applyComposition` owns.
  map.setLayoutProperty(BASEMAP_LAYER_ID, 'visibility', composition === 'map' ? 'none' : 'visible')
}

function removeBasemap(map: MapLibreMap): void {
  if (map.getLayer(BASEMAP_LAYER_ID)) map.removeLayer(BASEMAP_LAYER_ID)
  if (map.getSource(BASEMAP_SOURCE_ID)) map.removeSource(BASEMAP_SOURCE_ID)
}

/** R-03: a region change leaves no source or layer of the previous region behind. */
function removePolygonSurface(map: MapLibreMap): void {
  for (const layerId of POLYGON_LAYER_IDS) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  for (const sourceId of [POLYGON_DETAIL_SOURCE_ID, 'trazo-overview']) {
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }
}

/** R-36: after any raster insert, the polygon pair is moved back above the imagery. */
function raisePolygonLayers(map: MapLibreMap): void {
  const before = firstSymbolId(map)
  for (const layerId of POLYGON_LAYER_IDS) {
    if (map.getLayer(layerId)) map.moveLayer(layerId, before)
  }
}

/** Layout note 6: the block 3 right edge column, read from the mounted element only. */
const RIGHT_EDGE_COLUMN_SELECTOR = '.right-column-stack'

function rightEdgeColumnBox(): Box | null {
  if (typeof document === 'undefined') return null
  const node = document.querySelector(RIGHT_EDGE_COLUMN_SELECTOR)
  if (!node) return null
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

export function MapCanvas({ fields, selectedField, onTileChange, children }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const fieldsRef = useRef(fields)
  // `style.load` is a promise, not a render value: effects keyed on map readiness need
  // it as state, because the previous `mapLoadedRef` snapshot was read once and never
  // re-read, so an effect that ran before the style loaded never ran again.
  const [mapReady, setMapReady] = useState(false)
  const didSetInitialFieldRef = useRef(false)
  const composition = useMapStore((state) => state.composition)
  const catalog = useMapStore((state) => state.catalog)
  const layerOn = useMapStore((state) => state.on)
  const opacity = useMapStore((state) => state.opacity)
  const order = useMapStore((state) => state.order)
  const pinnedDates = useMapStore((state) => state.pinnedDates)
  const compare = useMapStore((state) => state.compare)
  const decisions = useMapStore((state) => state.tileDecisions)
  const chosenDate = useMapStore(chosenDateOf)
  const regionId = useMapStore((state) => state.regionId)
  const focusRequest = useMapStore((state) => state.focusRequest)
  const polygonRing = useMapStore((state) => state.polygonRing)
  const basemapId = useMapStore((state) => state.basemapId)
  const polygonScene = useMapStore((state) => state.polygonMode)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const appliedTilesRef = useRef<Record<string, string>>({})
  const region = regionAdapter(regionId)
  const basemapAdapter = BASEMAP_ADAPTERS.find((adapter) => adapter.id === basemapId) ?? activeBasemapAdapter()
  const sceneRef = useRef<PolygonScene | null>(null)
  // AC-28: the style's own layer ids, read at `style.load` before the app adds any layer.
  const styleOwnLayerIdsRef = useRef<ReadonlySet<string>>(new Set())
  const attributionRef = useRef<AttributionControl | null>(null)
  const attributionKeyRef = useRef('')
  const hoveredRef = useRef<string | number | null>(null)
  const selectedRef = useRef<string | number | null>(null)
  // R-01: the region the page loads with is the `?region=` value, so the map is constructed at
  // that region's default view and the camera effect only moves it when the region changes.
  // Reading the URL here rather than the store keeps the first paint independent of the order
  // in which the child and parent effects run.
  const initialRegionIdRef = useRef(
    regionFromSearch(typeof window === 'undefined' ? '' : window.location.search),
  )
  const cameraRegionRef = useRef(initialRegionIdRef.current)
  const paintedPropertyRef = useRef<string | null>(null)
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null)

  fieldsRef.current = fields
  sceneRef.current = polygonScene

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    ensurePmtilesProtocol()
    const initialRegion = regionAdapter(initialRegionIdRef.current)
    const map = new MapLibre({
      container: containerRef.current,
      style: VECTOR_BASEMAP_STYLE,
      // R-01 and R-03: the camera starts at the active region's default view of Table A.
      center: initialRegion.defaultView.center,
      zoom: initialRegion.defaultView.zoom,
      // R-33: one attribution control. MapLibre would add its own default one otherwise, a second
      // toggle beside ours. The custom control still collects the style's sources' credits.
      attributionControl: false,
    })
    mapRef.current = map
    ;(window as unknown as { __fsMap?: unknown }).__fsMap = map
    map.addControl(new NavigationControl(), 'top-right')
    // R-33: one compact attribution control carrying both exact strings, at every width.
    const control = new AttributionControl({
      compact: true,
      customAttribution: attributionText(activeBasemapAdapter(), initialRegion),
    })
    attributionRef.current = control
    map.addControl(control, 'bottom-right')
    // OD-04: the compact button's accessible name carries both short credits (AC-27).
    nameAttributionToggle(containerRef.current, attributionCreditName(activeBasemapAdapter(), initialRegion))
    collapseAttributionControl(containerRef.current)
    attributionKeyRef.current = `${useMapStore.getState().basemapId}|${initialRegion.id}`
    // Sources and layers are dropped by every setStyle(), so they are (re)added here, idempotently.
    map.on('style.load', () => {
      if (mapRef.current !== map) return
      // A new style drops every source, so the applied tile cache no longer describes the map.
      appliedTilesRef.current = {}
      setMapReady(true)
      // AC-28: snapshot the style's own layers before the app adds its boundary, basemap or polygon layers.
      styleOwnLayerIdsRef.current = new Set((map.getStyle().layers ?? []).map((layer) => layer.id))
      ensureFieldBoundaries(map, fieldsRef.current)
      const styleRegion = regionAdapter(useMapStore.getState().regionId)
      ensureBasemap(map, activeBasemapAdapter(), useMapStore.getState().composition, styleOwnLayerIdsRef.current, useMapStore.getState().catalog)
      applyComposition(map, useMapStore.getState().composition)
      const scene = sceneRef.current
      if (scene?.tiers) {
        addPolygonLayers(map as unknown as PolygonMap, styleRegion, scene, classPropertyFor(
          styleRegion,
          chosenDateOf(useMapStore.getState()),
          scene.classSource ?? undefined,
        ))
        raisePolygonLayers(map)
      }
    })
    map.on('load', () => {
      emitViewportTile(map, onTileChange)
      map.on('moveend', () => emitViewportTile(map, onTileChange))
    })

    return () => {
      map.remove()
      mapRef.current = null
      attributionRef.current = null
      setMapReady(false)
    }
  }, [])

  // Selection is app state, not a map concern. One rule runs whenever the list changes:
  // if nothing in the list is selected, select the first field. Both sides of the race
  // are covered because the rule is keyed on `fields` alone, not on a map readiness
  // snapshot: `fields` and the basemap style arrive in either order.
  useEffect(() => {
    const current = useMapStore.getState().selectedFieldId
    if (current && fields.some((field) => field.id === current)) return
    // R-24: a polygon is the selected field, so the fixture default never overwrites it.
    if (useMapStore.getState().selectedPolygonId !== null) return
    const first = fields[0]
    if (!first) return
    useMapStore.getState().selectField(first.id)
    didSetInitialFieldRef.current = true
  }, [fields])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    ensureFieldBoundaries(mapRef.current, fields)
  }, [fields, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current || !selectedField || !didSetInitialFieldRef.current) return
    const bounds: [[number, number], [number, number]] = selectedField.boundary.coordinates[0].reduce(
      (box, [lng, lat]) => [
        [Math.min(box[0][0], lng), Math.min(box[0][1], lat)],
        [Math.max(box[1][0], lng), Math.max(box[1][1], lat)],
      ],
      [[selectedField.center[0], selectedField.center[1]], [selectedField.center[0], selectedField.center[1]]],
    )
    if (typeof mapRef.current.fitBounds === 'function') {
      const padding = 48
      mapRef.current.fitBounds(bounds, { padding, maxZoom: 14, duration: 500 })
    }
  }, [selectedField, mapReady])

  // Field Shift AI (experiment), focus_geometry: frames the selected field's own boundary, or the
  // selected polygon's ring, never a coordinate from the request. While a selection is still resolving
  // (the field list or the polygon ring not loaded yet) the request waits; with nothing selected it
  // answers `no_selection`. Declared after the selection flyTo so the framing is the last camera move.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || focusRequest === null) return
    const store = useMapStore.getState()
    if (store.focusHandled?.seq === focusRequest.seq) return
    const ring = selectedField ? selectedField.boundary.coordinates[0] : selectedPolygonId !== null ? polygonRing : null
    if (!ring || ring.length === 0) {
      const resolving = (store.selectedFieldId !== null && !selectedField) || (selectedPolygonId !== null && polygonRing === null)
      if (!resolving) store.markFocusHandled(focusRequest.seq, false, 'no_selection')
      return
    }
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (const [lng, lat] of ring) {
      west = Math.min(west, lng); east = Math.max(east, lng); south = Math.min(south, lat); north = Math.max(north, lat)
    }
    const p = focusRequest.padding
    // Zoom 13 is the deepest level the basemaps draw everywhere; a field is never framed past it.
    map.fitBounds([[west, south], [east, north]], {
      padding: { top: p, bottom: p, left: p, right: p + focusRequest.insetRight }, maxZoom: 13, duration: 500,
    })
    store.markFocusHandled(focusRequest.seq, true, 'framed')
  }, [focusRequest, selectedField, selectedPolygonId, polygonRing, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    applyComposition(mapRef.current, composition)
  }, [composition, mapReady])

  // R-03: the camera of a region is the default view of Table A, and a switch never reloads.
  // The first placement is the constructor's, so the effect only moves the camera when the
  // region differs from the one the map was last placed at; a preset change or a layer edit
  // therefore never moves it (block 1 R-10, block 2 R-10).
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (cameraRegionRef.current === regionId) return
    cameraRegionRef.current = regionId
    map.flyTo({ center: region.defaultView.center, zoom: region.defaultView.zoom, duration: 500 })
  }, [regionId, mapReady, region])

  // R-09 and R-03: one mode read per region load, and the previous region's surface goes first
  // so no tile, class or colour of it survives the switch.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    let cancelled = false
    removePolygonSurface(map)
    removeBasemap(map)
    hoveredRef.current = null
    selectedRef.current = null
    setTooltip(null)
    map.getCanvas().style.cursor = ''
    const active = regionAdapter(regionId)
    polygonMode(active)
      .then((scene) => {
        if (cancelled || mapRef.current !== map) return
        const store = useMapStore.getState()
        store.setPolygonScene(scene)
        store.setPolygonSourceError(scene.failure)
        if (!scene.tiers) return
        const property = classPropertyFor(
          active,
          chosenDateOf(useMapStore.getState()),
          scene.classSource ?? undefined,
        )
        addPolygonLayers(map as unknown as PolygonMap, active, scene, property)
        raisePolygonLayers(map)
      })
      .catch(() => {
        if (cancelled) return
        useMapStore.getState().setPolygonSourceError(polygonFailureFor(active))
        useMapStore.getState().setPolygonScene(null)
      })
    return () => {
      cancelled = true
    }
  }, [mapReady, regionId])

  // R-13, R-15 and R-18: the paint is rebuilt when the region or the painted class year
  // changes, and only the year actually painted is stored for the readout. A change of the
  // painted property drops the resolved class, so the chip re-reads it from the new tile.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !polygonScene?.tiers) return
    const property = classPropertyFor(region, chosenDate, polygonScene.classSource ?? undefined)
    repaintPolygonLayers(map, region, property)
    if (paintedPropertyRef.current !== null && paintedPropertyRef.current !== property) {
      useMapStore.getState().setPolygonClass(null)
    }
    paintedPropertyRef.current = property
    useMapStore.getState().setPolygonClassYear(
      paintedClassYear(region, chosenDate, polygonScene.classSource ?? undefined),
    )
  }, [mapReady, polygonScene, region, chosenDate])

  // R-30, R-34, R-36: the basemap adapter's layer, its preset visibility, and the polygon
  // layers kept above the imagery.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    ensureBasemap(map, basemapAdapter, composition, styleOwnLayerIdsRef.current, catalog)
    raisePolygonLayers(map)
  }, [mapReady, basemapAdapter, composition, regionId])

  // R-03 and R-48: the control carries the active adapter's string and the active region's
  // source string, and it is rebuilt when either changes so no old string stays printed.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !attributionRef.current) return
    const key = `${basemapId}|${regionId}`
    if (attributionKeyRef.current === key) return
    attributionKeyRef.current = key
    map.removeControl(attributionRef.current)
    const control = new AttributionControl({ compact: true, customAttribution: attributionText(basemapAdapter, region) })
    attributionRef.current = control
    map.addControl(control, 'bottom-right')
    nameAttributionToggle(containerRef.current, attributionCreditName(basemapAdapter, region))
    collapseAttributionControl(containerRef.current)
  }, [mapReady, basemapId, regionId, basemapAdapter, region])

  // R-12 and R-37: the zoom the zoom and select lines read, and the legend rows of the classes
  // in view. Both are read only, so the map's own behaviour is unchanged. The legend is read at
  // idle, after the tiles of the view have rendered, and again whenever the scene or the class
  // property changes. Nothing is read before the fill layer exists.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const publishZoom = () => useMapStore.getState().setMapZoom(map.getZoom())
    const publishLegend = () => {
      const store = useMapStore.getState()
      const scene = store.polygonMode
      if (!scene?.tiers || !map.getLayer(POLYGON_FILL_LAYER_ID)) {
        store.setLegendRows([])
        return
      }
      const active = regionAdapter(store.regionId)
      const property = classPropertyFor(active, chosenDateOf(store), scene.classSource ?? undefined)
      store.setLegendRows(legendRowsForMap(map, active, property, noCdlYearOf(active, null, chosenDateOf(store))))
    }
    publishZoom()
    publishLegend()
    map.on('zoom', publishZoom)
    map.on('idle', publishLegend)
    return () => {
      map.off('zoom', publishZoom)
      map.off('idle', publishLegend)
    }
  }, [mapReady, polygonScene, regionId, chosenDate])

  // R-11 and R-35: a tile or source that fails keeps everything else on screen and sets the
  // reason line the region prints; no cached or substitute tile is served.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const handleError = (event: unknown) => {
      const sourceId = (event as { sourceId?: string } | null)?.sourceId
      if (sourceId === BASEMAP_SOURCE_ID) {
        useMapStore.getState().setBasemapFailed(true)
        return
      }
      if (sourceId === POLYGON_DETAIL_SOURCE_ID || sourceId === 'trazo-overview') {
        useMapStore.getState().setPolygonSourceError(polygonFailureFor(regionAdapter(useMapStore.getState().regionId)))
      }
    }
    map.on('error', handleError)
    return () => {
      map.off('error', handleError)
    }
  }, [mapReady])

  // R-19: hover and selection are feature state calls on the detail source, never a filter.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const active = regionAdapter(useMapStore.getState().regionId)
    const call = (id: string | number, value: Record<string, boolean>) => {
      map.setFeatureState(featureStateCall(POLYGON_DETAIL_SOURCE_ID, active.sourceLayer, id), value)
    }
    const previous = selectedRef.current
    if (previous !== null && previous !== selectedPolygonId) call(previous, { selected: false })
    if (selectedPolygonId !== null) call(selectedPolygonId, { selected: true })
    selectedRef.current = selectedPolygonId
    if (selectedPolygonId === null) {
      useMapStore.getState().setPolygonClass(null)
      return
    }
    /**
     * R-28: the chip and the class year read the selected polygon's own tile properties. A
     * restored selection resolves here once the tiles of its view are rendered, which is why
     * this also runs on the map's `idle` until it finds the feature.
     */
    const syncSelectedClass = () => {
      const store = useMapStore.getState()
      if (store.selectedPolygonId === null) return
      if (store.polygonClass !== null && store.polygonRing !== null) return
      const scene = store.polygonMode
      if (!scene?.tiers) return
      const region = regionAdapter(store.regionId)
      const property = classPropertyFor(region, chosenDateOf(store), scene.classSource ?? undefined)
      const features = map.queryRenderedFeatures({ layers: [POLYGON_FILL_LAYER_ID] })
      const match = features.find(
        (feature) => String(feature.id ?? feature.properties?.[region.idProperty]) === String(store.selectedPolygonId),
      )
      if (!match) return
      if (store.polygonClass === null) {
        store.setPolygonClass(
          classDisplay(region, classIdFrom(region, match.properties, property)),
          rawFeatureFrom(region, match.properties, property),
        )
        store.setPolygonClassYear(paintedClassYear(region, chosenDateOf(store), scene.classSource ?? undefined))
      }
      // Block 6, Table B: the outline the map rendered is the ring the numbers request carries.
      if (store.polygonRing === null) store.setPolygonRing(outerRingOf(match.geometry))
    }
    syncSelectedClass()
    map.on('idle', syncSelectedClass)
    return () => {
      map.off('idle', syncSelectedClass)
    }
  }, [mapReady, selectedPolygonId, polygonScene, regionId])

  // Block 6 revision 5 R-02 and block 5.5: the map is never hidden by a panel, so opening or
  // closing one needs no camera restore and no `map.resize()` call. The guard that used to
  // read the camera before a surface opened and restored it on close was removed here.

  // R-19, R-20, R-22, R-27: hover, the tooltip, the cursor and the press.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    // The one press the layer scoped handler has already spoken for. A fresh press carries a fresh
    // `originalEvent`, so a stale value can never swallow a later empty click.
    const handledPressRef: { current: Event | null } = { current: null }
    type PolygonFeature = { id?: string | number; properties?: Record<string, unknown> | null }
    type PolygonEvent = MapMouseEvent & { features?: PolygonFeature[] }

    const interactiveZoom = () => {
      const scene = useMapStore.getState().polygonMode
      // R-20: the named rule, read from the region contract's detail floor.
      return scene?.tiers ? POLYGON_INTERACTIVE_MIN_ZOOM(scene.tiers.detail.minzoom) : null
    }
    const currentFeature = (event: PolygonEvent) => {
      const store = useMapStore.getState()
      const active = regionAdapter(store.regionId)
      const scene = store.polygonMode
      if (!scene?.tiers) return null
      const minZoom = interactiveZoom()
      if (minZoom === null || map.getZoom() < minZoom) return null
      const feature = event.features?.[0]
      if (!feature) return null
      const raw = feature.id ?? feature.properties?.[active.idProperty]
      if (typeof raw !== 'string' && typeof raw !== 'number') return null
      return { active, scene, raw, feature }
    }
    const clearHover = () => {
      if (hoveredRef.current !== null) {
        const active = regionAdapter(useMapStore.getState().regionId)
        map.setFeatureState(featureStateCall(POLYGON_DETAIL_SOURCE_ID, active.sourceLayer, hoveredRef.current), { hover: false })
        hoveredRef.current = null
      }
      setTooltip(null)
      map.getCanvas().style.cursor = ''
    }
    const handleMove = (event: PolygonEvent) => {
      const found = currentFeature(event)
      if (!found) {
        clearHover()
        return
      }
      const { active, scene, raw, feature } = found
      if (hoveredRef.current !== raw) {
        if (hoveredRef.current !== null) {
          map.setFeatureState(featureStateCall(POLYGON_DETAIL_SOURCE_ID, active.sourceLayer, hoveredRef.current), { hover: false })
        }
        hoveredRef.current = raw
        map.setFeatureState(featureStateCall(POLYGON_DETAIL_SOURCE_ID, active.sourceLayer, raw), { hover: true })
      }
      map.getCanvas().style.cursor = 'pointer'
      const property = classPropertyFor(active, chosenDateOf(useMapStore.getState()), scene.classSource ?? undefined)
      const classValue = classIdFrom(active, feature.properties, property)
      const container = containerRef.current?.getBoundingClientRect()
      if (!container) return
      const placement = placeTooltip(
        { x: event.point.x, y: event.point.y },
        { width: container.width, height: container.height },
        { width: POLYGON_TOOLTIP_MAX_WIDTH, height: 24 },
        rightEdgeColumnBox(),
      )
      setTooltip(placement.hidden ? null : {
        text: polygonTooltipText(active, classValue, chosenDateOf(useMapStore.getState())),
        left: placement.left,
        top: placement.top,
      })
    }
    const handleLeave = () => clearHover()
    const handleClick = (event: PolygonEvent) => {
      // Block 5.5 W6: this listener only runs when a fill layer feature is under the press, so it
      // tells the map level handler that this press is spoken for, whatever `currentFeature` decides.
      handledPressRef.current = event.originalEvent ?? null
      const found = currentFeature(event)
      if (!found) return
      // R-22: the map handler runs the command and never calls the store action itself.
      runCommand('select_field', { field_id: commandFieldId(found.active, found.raw) })
    }

    /**
     * Block 5.5, U4, U5 and W6. The two handlers share one fact instead of each running its own hit
     * test: the layer scoped `handleClick` runs only when a feature of the fill layer is under the
     * press, so "the layer handler ran" IS the hit test. It records the press it handled and the map
     * level handler returns at once for that same press.
     *
     * Neither handler may read `event.features`: MapLibre sets that field only for a layer scoped
     * listener and deletes it the moment that listener returns, so the map level handler never sees
     * it. A `queryRenderedFeatures(event.point, ...)` in this handler was tried and still cleared a
     * press that did select, which is why the shared press is used rather than a second query.
     */
    const handleMapClick = (event: PolygonEvent) => {
      const original = event.originalEvent ?? null
      if (original !== null && original === handledPressRef.current) {
        handledPressRef.current = null
        return
      }
      const store = useMapStore.getState()
      if (store.selectedPolygonId === null) return
      store.clearPolygonSelection()
    }

    map.on('mousemove', POLYGON_FILL_LAYER_ID, handleMove)
    map.on('mouseleave', POLYGON_FILL_LAYER_ID, handleLeave)
    map.on('click', POLYGON_FILL_LAYER_ID, handleClick)
    map.on('click', handleMapClick)
    return () => {
      map.off('mousemove', POLYGON_FILL_LAYER_ID, handleMove)
      map.off('mouseleave', POLYGON_FILL_LAYER_ID, handleLeave)
      map.off('click', POLYGON_FILL_LAYER_ID, handleClick)
      map.off('click', handleMapClick)
      clearHover()
    }
  }, [mapReady, regionId])

  // R-23 and R-25: one probe per layer and *effective* date. `effective_date` comes from
  // the `/layers` response, so a chosen date that resolves every layer to the same date
  // issues no request at all (R-20, AC-16), and a pinned layer is never probed again.
  const probedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!mapReady) return
    const controller = new AbortController()
    const state = useMapStore.getState()
    const zoom = mapRef.current ? Math.floor(mapRef.current.getZoom()) : 11
    const center = mapRef.current ? mapRef.current.getCenter() : { lng: -55.27, lat: -11.91 }
    // The proxy refuses z above the layer's max_zoom (R-15), so the probe asks at the
    // layer's own zoom, which is the tile the overzoomed raster source would request.
    const tileAt = (layerZoom: number) => {
      const scale = 2 ** layerZoom
      return {
        z: layerZoom,
        x: Math.min(scale - 1, Math.floor((center.lng + 180) / 360 * scale)),
        y: Math.min(scale - 1, Math.floor((1 - Math.asinh(Math.tan(center.lat * Math.PI / 180)) / Math.PI) / 2 * scale)),
      }
    }
    const targets: Array<{ id: string; date: string | null; key: string; maxZoom: number; resolved: string | null }> = []
    const chosen = chosenDateOf(state)
    for (const entry of state.catalog) {
      if (!state.on[entry.id]) continue
      const pinned = state.pinnedDates[entry.id] ?? null
      // The probe asks for the date the app is reading at: the pin when the layer has one,
      // the chosen date otherwise. That date is also the boundary R-23 compares against, so
      // a failed `/layers` (no effective date at all) still accepts a dated cached tile.
      // The *resolved* date only keys the cache, so a chosen date that resolves every layer
      // to the same date issues no new request (R-20, AC-16).
      targets.push({
        id: entry.id,
        date: pinned ?? chosen,
        key: entry.id,
        maxZoom: entry.max_zoom,
        resolved: pinned ?? entry.effective_date ?? chosen,
      })
      const pair = state.compare[entry.id]
      if (pair) {
        targets.push({
          id: entry.id,
          date: pair.date,
          key: `${entry.id}${COMPARE_DECISION_SUFFIX}`,
          maxZoom: entry.max_zoom,
          resolved: pair.date,
        })
      }
    }
    for (const target of targets) {
      const probeKey = `${target.key}::${target.resolved ?? 'none'}`
      if (probedRef.current.has(probeKey)) continue
      probedRef.current.add(probeKey)
      probeLayerTile(target.id, target.date, tileAt(Math.min(zoom, target.maxZoom)), controller.signal)
        .then((decision) => useMapStore.getState().setTileDecision(target.key, decision))
        .catch((reason: unknown) => {
          // An aborted probe (a newer catalog or date arrived) proves nothing, so the key
          // is released and the next run asks again. Leaving it claimed would lose the
          // decision for good and the layer would never draw.
          if (reason instanceof DOMException && reason.name === 'AbortError') {
            probedRef.current.delete(probeKey)
          }
        })
    }
    return () => controller.abort()
  }, [mapReady, chosenDate, catalog, layerOn, pinnedDates, compare])

  // The single writer of the map style for the raster layers. It only touches the style
  // when the plan changes, so an opacity edit does not re-add a source (AC-13) and an order
  // edit does not remove one (AC-14).
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const visibleIds = new Set<string>()

    for (const entry of catalog) {
      const isOn = layerOn[entry.id] ?? false
      const decision = decisions[entry.id]
      // R-19: a layer that is off owns no source. R-23: only a tile the guard has cleared
      // may draw, so a refused or not yet settled probe leaves no source behind.
      if (!isOn || decision?.draw !== true) {
        for (const key of [rasterLayerId(entry.id), `${rasterLayerId(entry.id)}${COMPARE_SUFFIX.a}`, `${rasterLayerId(entry.id)}${COMPARE_SUFFIX.b}`]) {
          if (map.getLayer(key)) map.removeLayer(key)
        }
        for (const sourceId of [entry.id, sourceIdFor(entry.id, 'a'), sourceIdFor(entry.id, 'b')]) {
          if (map.getSource(sourceId)) map.removeSource(sourceId)
        }
        delete appliedTilesRef.current[entry.id]
        continue
      }

      visibleIds.add(entry.id)
      const effectiveDate = pinnedDates[entry.id] ?? decision?.date ?? entry.effective_date
      const tiles = layerTileTemplate(entry.id, effectiveDate)
      // R-20: a date that resolves to the same effective date keeps the same URL, so a
      // source is rewritten only when its URL really changed. A fresh source already has
      // the right tiles and is not asked for them twice.
      const applyTiles = (key: string, sourceId: string, url: string, created: boolean) => {
        if (created) {
          appliedTilesRef.current[key] = url
          return
        }
        if (appliedTilesRef.current[key] === url) return
        const source = map.getSource(sourceId) as SourceLike | undefined
        source?.setTiles?.([url])
        appliedTilesRef.current[key] = url
      }
      const baseCreated = ensureRaster(map, entry, tiles)
      const pair = compare[entry.id]
      const baseOpacity = pair ? 0 : opacityOf(useMapStore.getState(), entry.id)
      map.setPaintProperty(rasterLayerId(entry.id), 'raster-opacity', baseOpacity)
      applyTiles(entry.id, entry.id, tiles, baseCreated)

      if (pair) {
        const bounds = compareBounds(map, pair.divider)
        // R-22: side A is the chosen date (its effective date), side B the Compare date.
        const tilesA = layerTileTemplate(entry.id, effectiveDate)
        const tilesB = layerTileTemplate(entry.id, pair.date)
        const createdA = ensureRaster(map, entry, tilesA, 'a', bounds.a)
        const createdB = ensureRaster(map, entry, tilesB, 'b', bounds.b)
        applyTiles(`${entry.id}~a`, sourceIdFor(entry.id, 'a'), tilesA, createdA)
        applyTiles(`${entry.id}~b`, sourceIdFor(entry.id, 'b'), tilesB, createdB)
        map.setPaintProperty(`${rasterLayerId(entry.id)}${COMPARE_SUFFIX.a}`, 'raster-opacity', opacityOf(useMapStore.getState(), entry.id))
        map.setPaintProperty(`${rasterLayerId(entry.id)}${COMPARE_SUFFIX.b}`, 'raster-opacity', opacityOf(useMapStore.getState(), entry.id))
        for (const side of ['a', 'b'] as const) {
          const source = map.getSource(sourceIdFor(entry.id, side)) as (SourceLike & { bounds?: [number, number, number, number] }) | undefined
          const sideBounds = side === 'a' ? bounds.a : bounds.b
          // MapLibre calls the callback with no argument: it is meant to mutate the source
          // itself, which is then reloaded.
          source?.setSourceProperty?.(() => {
            if (source) source.bounds = sideBounds
          })
        }
      } else {
        delete appliedTilesRef.current[`${entry.id}~a`]
        delete appliedTilesRef.current[`${entry.id}~b`]
        for (const side of ['a', 'b'] as const) {
          const layerId = `${rasterLayerId(entry.id)}${COMPARE_SUFFIX[side]}`
          if (map.getLayer(layerId)) map.removeLayer(layerId)
          if (map.getSource(sourceIdFor(entry.id, side))) map.removeSource(sourceIdFor(entry.id, side))
        }
      }
    }

    // R-18: only the layers still on the map take part in the stack order.
    applyOrder(map, order.filter((id) => visibleIds.has(id)))
    // The land only products get the basemap's water drawn over them, under the crop polygons.
    placeWaterMask(map, catalog, order.filter((id) => visibleIds.has(id)), composition)
    // R-36: whatever raster was just inserted, the polygon pair stays above the imagery.
    raisePolygonLayers(map)
  }, [mapReady, catalog, layerOn, opacity, order, pinnedDates, compare, decisions])

  return (
    <section className="map-panel" role="region" aria-label={t('map.field_map')}>
      <div ref={containerRef} className="map-canvas" aria-label={t('map.satellite_map_label')} />
      <div className="map-overlay" aria-hidden="true">
        <span className="map-live-dot" />
        <span>{t('map.satellite_layer')}</span>
      </div>
      {children}
      {tooltip && <PolygonTooltip left={tooltip.left} text={tooltip.text} top={tooltip.top} />}
      <ActiveLayersNote />
      <CompareOverlay chosenDate={chosenDate} />
      <OfflineOverlay />
    </section>
  )
}

/**
 * Names the layers drawn on the map with their pixel size, and warns when a pixel is larger
 * than a field at the current zoom, so a coarse product is not read as field detail.
 */
function ActiveLayersNote() {
  const catalog = useMapStore((state) => state.catalog)
  const on = useMapStore((state) => state.on)
  const zoom = useMapStore((state) => state.mapZoom)
  const active = catalog.filter((entry) => on[entry.id])
  if (active.length === 0) return null
  return (
    <div className="map-layers-note" role="status">
      {active.map((entry) => {
        const coarse = resolutionMetres(entry.resolution) >= 1000 && (zoom ?? 0) >= 9
        return (
          <p key={entry.id}>
            <span className="map-live-dot" aria-hidden="true" />
            <span>{t('map.layer_pixel', { name: t(entry.labelKey ?? entry.label), resolution: entry.resolution })}</span>
            {coarse ? <span className="map-layers-coarse">{t('map.layer_coarse')}</span> : null}
          </p>
        )
      })}
    </div>
  )
}

/** R-22: the divider and the two side labels, and no numeric delta anywhere (F-34 is block 6). */
function CompareOverlay({ chosenDate }: { chosenDate: string }) {
  const compare = useMapStore((state) => state.compare)
  const catalog = useMapStore((state) => state.catalog)
  const decisions = useMapStore((state) => state.tileDecisions)
  const setCompareDivider = useMapStore((state) => state.setCompareDivider)
  const active = catalog.find((entry) => compare[entry.id] != null)
  if (!active) return null
  const pair = compare[active.id] as CompareState
  const sideA = decisions[active.id]?.date ?? chosenDate
  const sideB = decisions[`${active.id}${COMPARE_DECISION_SUFFIX}`]?.date ?? pair.date ?? ''

  // Dragging anywhere on the handle moves the split; the range input under it keeps the keyboard contract.
  const dragFrom = (event: ReactPointerEvent<HTMLDivElement>) => {
    const overlay = event.currentTarget.parentElement
    if (!overlay) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const move = (clientX: number) => {
      const box = overlay.getBoundingClientRect()
      if (box.width <= 0) return
      setCompareDivider(active.id, Math.min(1, Math.max(0, (clientX - box.left) / box.width)))
    }
    move(event.clientX)
    const target = event.currentTarget
    const onMove = (next: PointerEvent) => move(next.clientX)
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  return (
    <div className="compare-overlay">
      <div aria-hidden="true" className="compare-line" onPointerDown={dragFrom} style={{ left: `${pair.divider * 100}%` }}>
        <span className="compare-handle">⇆</span>
      </div>
      <span className="compare-side compare-side-a" data-dynamic-content>
        {t('layers.compare_side', { date: sideA, age: ageText(sideA, chosenDate) })}
      </span>
      <span className="compare-side compare-side-b" data-dynamic-content>
        {/* Both ages are read against the chosen date: one clock for the whole map. */}
        {t('layers.compare_side', { date: sideB, age: ageText(sideB, chosenDate) })}
      </span>
      <input
        aria-label={t('layers.compare_divider')}
        aria-valuenow={Math.round(pair.divider * 100)}
        aria-valuetext={t('layers.compare_divider_value', { value: Math.round(pair.divider * 100) })}
        className="compare-divider"
        max={100}
        min={0}
        onChange={(event) => setCompareDivider(active.id, Number(event.target.value) / 100)}
        onKeyDown={(event) => {
          // AC-38: one step per arrow press, focus stays on the divider, the camera is
          // untouched because nothing here reaches the map.
          const step = (direction: number) => {
            event.preventDefault()
            const current = Math.round(pair.divider * 100)
            setCompareDivider(active.id, Math.min(100, Math.max(0, current + direction)) / 100)
          }
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') step(1)
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') step(-1)
          else if (event.key === 'Home') step(-100)
          else if (event.key === 'End') step(100)
        }}
        step={1}
        style={{ left: `${pair.divider * 100}%` }}
        type="range"
        value={Math.round(pair.divider * 100)}
      />
    </div>
  )
}

/** R-25: the label a cached or reserve tile has to carry, and the layer that has neither. */
function OfflineOverlay() {
  const decisions = useMapStore((state) => state.tileDecisions)
  const catalog = useMapStore((state) => state.catalog)
  const on = useMapStore((state) => state.on)
  const rows = catalog
    .filter((entry) => {
      const decision = decisions[entry.id]
      return Boolean(on[entry.id]) && decision !== undefined
        && (decision.source === 'cache-offline' || decision.source === 'reserve' || decision.offline === 'no_offline_copy')
    })
    .map((entry) => ({
      id: entry.id,
      name: t(entry.labelKey ?? entry.label),
      key: decisions[entry.id]?.source === 'reserve'
        ? 'layers.offline_sample' as const
        : decisions[entry.id]?.offline === 'no_offline_copy'
          ? 'layers.no_offline_copy' as const
          : null,
      date: decisions[entry.id]?.date ?? null,
    }))
  if (rows.length === 0) return null
  return (
    <div className="offline-overlay">
      {rows.map((row) => (
        <p className="offline-row" key={row.id} data-dynamic-content>
          <span>{row.name}</span>
          {row.key ? <span>{t(row.key)}</span> : null}
          {row.date ? <time dateTime={row.date}>{row.date}</time> : null}
        </p>
      ))}
    </div>
  )
}

/** Whole days between an effective date and the date the side is read at. */
export function ageText(effectiveDate: string | null, readAt: string | null): string {
  if (!effectiveDate || !readAt) return ''
  const from = Date.parse(`${effectiveDate.slice(0, 10)}T00:00:00Z`)
  const to = Date.parse(`${readAt.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return ''
  const days = Math.max(0, Math.round((to - from) / 86_400_000))
  if (days === 0) return t('layers.age_zero')
  if (days === 1) return t('layers.age_one')
  return t('layers.age_days', { days })
}
