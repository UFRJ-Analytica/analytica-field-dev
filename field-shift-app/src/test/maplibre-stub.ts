/**
 * A MapLibre stub for the block 4 criteria, which read the map back the way the browser
 * does: `getPaintProperty` for AC-13, `getStyle().layers` for AC-14, the source and layer
 * counts for both, `getCenter` and `getZoom` for the compare camera rule (AC-18), and the
 * source `setTiles` calls for the effective date rule (AC-16).
 */
export type StubSource = {
  id: string
  tiles: string[]
  bounds?: [number, number, number, number]
  setTiles: (tiles: string[]) => void
  /** MapLibre calls this with no argument; the callback mutates the source. */
  setSourceProperty: (callback: () => void) => void
}

export type StubLayer = {
  id: string
  type: 'raster' | 'fill' | 'line' | 'symbol'
  source?: string
  paint?: Record<string, unknown>
}

export class MapStub {
  static instances: MapStub[] = []
  /**
   * Block 5 AC-28: a test seeds the style's own layers, in the order of the style, before the map
   * mounts. Null keeps the one-symbol default below.
   */
  static styleLayers: StubLayer[] | null = null

  sources = new Map<string, StubSource>()
  layers: StubLayer[] = [{ id: 'place-label', type: 'symbol' }]
  addSourceCalls = 0
  removeSourceCalls = 0
  addLayerCalls = 0
  removeLayerCalls = 0
  moveLayerCalls: string[] = []
  listeners: Record<string, Array<(...args: never[]) => void>> = {}
  center = { lng: -55.27, lat: -11.91 }
  zoom = 11
  flyToCalls = 0
  /** Field Shift AI focus_geometry: the bounds each `fitBounds` call framed. */
  fitBoundsCalls: Array<[[number, number], [number, number]]> = []
  lastFlyTo: Record<string, unknown> | null = null
  options: Record<string, unknown>
  /** Block 5: the calls the polygon surface makes, recorded so a criterion can read them. */
  featureStateCalls: Array<{ state: Record<string, unknown>; value?: Record<string, unknown> }> = []
  removedFeatureStateCalls: Array<Record<string, unknown>> = []
  layoutCalls: Array<{ id: string; property: string; value: unknown }> = []
  controls: unknown[] = []
  renderedFeatures: Array<{ id?: string | number; properties?: Record<string, unknown> | null }> = []
  cursor = ''
  queryOptions: Array<Record<string, unknown>> = []

  constructor(options: Record<string, unknown>) {
    this.options = options
    if (MapStub.styleLayers) this.layers = MapStub.styleLayers.map((layer) => ({ ...layer }))
    MapStub.instances.push(this)
  }

  addControl(control?: unknown) {
    this.controls.push(control)
  }

  removeControl(control?: unknown) {
    this.controls = this.controls.filter((entry) => entry !== control)
  }

  remove() {}

  /** R-19: MapLibre's own cursor is written through the canvas element. */
  getCanvas() {
    const stub = this
    return {
      style: {
        get cursor() { return stub.cursor },
        set cursor(value: string) { stub.cursor = value },
      },
    }
  }

  setFeatureState(state: Record<string, unknown>, value?: Record<string, unknown>) {
    this.featureStateCalls.push({ state, value })
  }

  removeFeatureState(state: Record<string, unknown>) {
    this.removedFeatureStateCalls.push(state)
  }

  queryRenderedFeatures(options: Record<string, unknown> = {}) {
    this.queryOptions.push(options)
    return this.renderedFeatures
  }

  addSource(id: string, spec: { tiles?: string[]; bounds?: [number, number, number, number]; [key: string]: unknown }) {
    this.addSourceCalls += 1
    const source: StubSource & Record<string, unknown> = {
      ...spec,
      id,
      tiles: [...(spec.tiles ?? [])],
      bounds: spec.bounds,
      setTiles: (tiles: string[]) => { source.tiles = [...tiles] },
      // MapLibre calls this callback with no argument and then reloads the source, so the
      // callback mutates the source itself. The stub is faithful to that, not generous:
      // a callback written against an argument would throw here as it does in the browser.
      setSourceProperty: (callback: () => void) => { callback() },
    }
    this.sources.set(id, source)
  }

  removeSource(id: string) {
    this.removeSourceCalls += 1
    this.sources.delete(id)
  }

  getSource(id: string) {
    return this.sources.get(id)
  }

  addLayer(layer: StubLayer, beforeId?: string) {
    this.addLayerCalls += 1
    const index = beforeId ? this.layers.findIndex((entry) => entry.id === beforeId) : -1
    if (index >= 0) this.layers.splice(index, 0, layer)
    else this.layers.push(layer)
  }

  removeLayer(id: string) {
    this.removeLayerCalls += 1
    this.layers = this.layers.filter((layer) => layer.id !== id)
  }

  getLayer(id: string) {
    return this.layers.find((layer) => layer.id === id)
  }

  /** Without a `beforeId`, MapLibre moves the layer to the top of the stack. */
  moveLayer(id: string, beforeId?: string) {
    this.moveLayerCalls.push(id)
    const layer = this.layers.find((entry) => entry.id === id)
    if (!layer) return
    this.layers = this.layers.filter((entry) => entry.id !== id)
    const index = beforeId ? this.layers.findIndex((entry) => entry.id === beforeId) : -1
    if (index >= 0) this.layers.splice(index, 0, layer)
    else this.layers.push(layer)
  }

  getStyle() {
    return { layers: this.layers.map((layer) => ({ ...layer })) }
  }

  setPaintProperty(id: string, property: string, value: unknown) {
    const layer = this.layers.find((entry) => entry.id === id)
    if (layer) layer.paint = { ...layer.paint, [property]: value }
  }

  getPaintProperty(id: string, property: string) {
    return this.layers.find((entry) => entry.id === id)?.paint?.[property]
  }

  setLayoutProperty(id: string, property: string, value: unknown) {
    this.layoutCalls.push({ id, property, value })
  }

  getZoom() {
    return this.zoom
  }

  /** Block 6, R-02: the camera values and the resize the numbers surface makes on close. */
  resizeCalls = 0
  bearing = 0
  pitch = 0
  jumpToCalls: Array<Record<string, unknown>> = []

  resize() {
    this.resizeCalls += 1
  }

  getBearing() {
    return this.bearing
  }

  getPitch() {
    return this.pitch
  }

  jumpTo(options: Record<string, unknown>) {
    this.jumpToCalls.push(options)
    if (Array.isArray(options.center)) this.center = { lng: options.center[0] as number, lat: options.center[1] as number }
    if (typeof options.zoom === 'number') this.zoom = options.zoom
    if (typeof options.bearing === 'number') this.bearing = options.bearing
    if (typeof options.pitch === 'number') this.pitch = options.pitch
  }

  getCenter() {
    return { ...this.center }
  }

  getBounds() {
    return {
      getWest: () => -56,
      getSouth: () => -12.5,
      getEast: () => -54.5,
      getNorth: () => -11.3,
    }
  }

  fitBounds(bounds: [[number, number], [number, number]]) {
    this.fitBoundsCalls.push(bounds)
    return this
  }

  flyTo(options?: Record<string, unknown>) {
    this.flyToCalls += 1
    this.lastFlyTo = options ?? null
  }

  /** The two forms MapLibre accepts: `on(event, cb)` and `on(event, layerId, cb)`. */
  on(event: string, layerOrCallback?: unknown, maybeCallback?: (...args: never[]) => void) {
    const callback = (typeof layerOrCallback === 'function' ? layerOrCallback : maybeCallback) as
      | ((...args: never[]) => void)
      | undefined
    if (callback) (this.listeners[event] ??= []).push(callback)
    if (event === 'style.load') callback?.()
  }

  off(event: string, layerOrCallback?: unknown, maybeCallback?: (...args: never[]) => void) {
    const callback = typeof layerOrCallback === 'function' ? layerOrCallback : maybeCallback
    if (!callback) {
      delete this.listeners[event]
      return
    }
    this.listeners[event] = (this.listeners[event] ?? []).filter((entry) => entry !== callback)
  }

  emit(event: string, payload?: unknown) {
    for (const callback of [...(this.listeners[event] ?? [])]) {
      (callback as unknown as (value?: unknown) => void)(payload)
    }
  }

  static reset() {
    MapStub.instances = []
    MapStub.styleLayers = null
  }

  static last(): MapStub {
    return MapStub.instances[MapStub.instances.length - 1]
  }
}
