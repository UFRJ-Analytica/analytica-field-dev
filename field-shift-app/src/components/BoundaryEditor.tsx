/**
 * Block 7, R-36 and AC-32: the boundary editor, the only place a ring is created by hand.
 *
 * It is a MapLibre map inside the `Field record` surface (OD-02), read only over block 5's polygon
 * layer: it draws the region's basemap and the registered fields' rings, and a press on it adds one
 * vertex. `Undo` removes the last vertex, `Close ring` hands the ring to the caller for validation
 * and `Cancel` discards it. The instance is destroyed on unmount, so no second canvas survives a
 * close (layout note 5).
 */
import { useEffect, useRef } from 'react'
import { Map as MapLibre } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { activeBasemapAdapter } from '@/lib/basemap-adapters'
import { VECTOR_BASEMAP_STYLE } from '@/lib/layer-catalog'
import type { RegionAdapter } from '@/lib/regions'
import type { RegisteredField } from '@/lib/producer-store'
import type { RingPoint } from '@/lib/field-ring'
import { ringAreaHa } from '@/lib/field-ring'
import { t } from '@/strings'

export const EDITOR_INSET_ATTR = 'data-boundary-editor'

type BoundaryEditorProps = {
  region: RegionAdapter
  vertices: RingPoint[]
  registeredFields: readonly RegisteredField[]
  onAddVertex: (point: RingPoint) => void
  onUndo: () => void
  onCloseRing: () => void
  onCancel: () => void
  /** The area of the ring so far, printed beside the inset (R-36). */
  areaHa?: number
}

const VERTEX_SOURCE = 'block7-vertices'
const FIELDS_SOURCE = 'block7-fields'
const BASEMAP_SOURCE = 'block7-basemap'

export function ringOf(vertices: readonly RingPoint[]): RingPoint[] {
  return vertices.map((point) => [point[0], point[1]] as RingPoint)
}

export function runningAreaHa(vertices: readonly RingPoint[]): number {
  return vertices.length < 3 ? 0 : ringAreaHa(vertices)
}

export function BoundaryEditor({
  region,
  vertices,
  registeredFields,
  onAddVertex,
  onUndo,
  onCloseRing,
  onCancel,
  areaHa,
}: BoundaryEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibre | null>(null)
  const addVertexRef = useRef(onAddVertex)
  addVertexRef.current = onAddVertex
  const verticesRef = useRef(vertices)
  verticesRef.current = vertices
  const fieldsRef = useRef(registeredFields)
  fieldsRef.current = registeredFields

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let map: MapLibre
    try {
      map = new MapLibre({
        container,
        style: VECTOR_BASEMAP_STYLE,
        center: region.defaultView.center as [number, number],
        zoom: region.defaultView.zoom,
        attributionControl: false,
      })
    } catch {
      // A browser without WebGL leaves the inset blank rather than taking the surface down.
      return
    }
    mapRef.current = map
    const basemap = activeBasemapAdapter()

    map.on('style.load', () => {
      if (!map.getSource(BASEMAP_SOURCE)) {
        map.addSource(BASEMAP_SOURCE, {
          type: 'raster',
          tiles: [basemap.tiles],
          tileSize: basemap.tileSize,
          minzoom: basemap.minzoom,
          maxzoom: basemap.maxzoom,
        })
        const before = (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
        map.addLayer({ id: `${BASEMAP_SOURCE}-layer`, type: 'raster', source: BASEMAP_SOURCE }, before)
      }
      if (!map.getSource(FIELDS_SOURCE)) {
        map.addSource(FIELDS_SOURCE, { type: 'geojson', data: emptyCollection() })
        map.addLayer({ id: `${FIELDS_SOURCE}-line`, type: 'line', source: FIELDS_SOURCE, paint: { 'line-color': '#2e4520', 'line-width': 1.5 } })
      }
      if (!map.getSource(VERTEX_SOURCE)) {
        map.addSource(VERTEX_SOURCE, { type: 'geojson', data: emptyCollection() })
        map.addLayer({ id: `${VERTEX_SOURCE}-fill`, type: 'fill', source: VERTEX_SOURCE, paint: { 'fill-color': '#2e4520', 'fill-opacity': 0.18 } })
        map.addLayer({ id: `${VERTEX_SOURCE}-line`, type: 'line', source: VERTEX_SOURCE, paint: { 'line-color': '#2e4520', 'line-width': 2 } })
      }
      syncSources(map, verticesRef.current, fieldsRef.current)
    })

    map.on('click', (event) => {
      addVertexRef.current([event.lngLat.lng, event.lngLat.lat])
    })

    return () => {
      mapRef.current = null
      try {
        map.remove()
      } catch {
        // A map that never finished loading holds nothing to tear down.
      }
    }
    // The map is created once for the life of the card; every later change is a source update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    syncSources(map, vertices, registeredFields)
  }, [vertices, registeredFields])

  const area = areaHa ?? runningAreaHa(vertices)

  return (
    <div>
      <div className="editor-inset" ref={containerRef} role="region" aria-label={t('record.editor_heading')} {...{ [EDITOR_INSET_ATTR]: '' }} />
      <p className="editor-area">{t('record.running_area', { area: area.toFixed(1) })}</p>
      <p className="surface-empty">{t('record.draw_hint')}</p>
      <div className="editor-controls">
        <button onClick={onUndo} type="button">{t('record.undo')}</button>
        <button onClick={onCloseRing} type="button">{t('record.close_ring')}</button>
        <button onClick={onCancel} type="button">{t('record.cancel')}</button>
      </div>
    </div>
  )
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] as unknown[] }
}

function syncSources(map: MapLibre, vertices: readonly RingPoint[], registeredFields: readonly RegisteredField[]): void {
  const vertexSource = map.getSource(VERTEX_SOURCE) as { setData?: (data: unknown) => void } | undefined
  if (!vertexSource) return
  const features: unknown[] = []
  if (vertices.length >= 2) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...vertices, vertices[0]].map((point) => [point[0], point[1]])] },
    })
  }
  for (const point of vertices) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point[0], point[1]] } })
  }
  vertexSource.setData?.({ type: 'FeatureCollection', features })
  const fieldsSource = map.getSource(FIELDS_SOURCE) as { setData?: (data: unknown) => void } | undefined
  fieldsSource?.setData?.({
    type: 'FeatureCollection',
    features: registeredFields.map((field) => ({
      type: 'Feature',
      properties: { id: field.id },
      geometry: { type: 'Polygon', coordinates: [field.ring.map((point) => [point[0], point[1]])] },
    })),
  })
}
