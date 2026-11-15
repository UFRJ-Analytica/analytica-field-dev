import { create } from 'zustand'
import {
  LAYER_AXIS,
  LAYER_CATALOG,
  type LayerCatalog,
  type LayerStatus,
  type LayersAxis,
} from './layer-catalog'
import {
  DEFAULT_REGION_ID,
  regionAdapter,
  type RegionId,
} from './regions'
import { rawIdFromCommandFieldId, type PolygonRawId } from './polygon-selection'
import type { PolygonFailureKey, PolygonScene } from './polygon-source'
import type { ClassDisplay } from './polygon-style'
import type { LegendRow } from './polygon-legend'
import type { PolygonFeatureRaw } from './polygon-readout'
import { activeBasemapAdapter, BASEMAP_ADAPTERS, type BasemapAdapter, type BasemapAdapterId } from './basemap-adapters'
import type { TileDecision } from './tile-guard'
import type { NumbersPayload } from './numbers'
import type { ProducerEntry, RegisteredField } from './producer-store'

export type FieldSummary = {
  id: string
  name: string
  location: string
  coverage: number
  center: [number, number]
  boundary: { type: 'Polygon'; coordinates: number[][][] }
}

export type CompositionPreset = 'map' | 'satellite' | 'satellite-with-labels'

/** One compare pair: side B's date and the divider position as a fraction of the map width. */
export type CompareState = { date: string | null; divider: number }

/** The drag handle starts in the middle of the map; it is a design target, not a measure. */
export const COMPARE_DEFAULT_DIVIDER = 0.5

/** R-17: the value `MapCanvas.tsx` line 79 applies today is the start value of a layer turned on. */
export const LAYER_DEFAULT_OPACITY = 0.55

type MapState = {
  selectedFieldId: string | null
  composition: CompositionPreset
  openPanelName: 'scenarios' | 'evidence' | null
  activeFilter: 'all' | 'ranked' | 'abstained' | null
  selectField: (fieldId: string) => void
  setComposition: (composition: CompositionPreset) => void
  openPanel: (panel: 'scenarios' | 'evidence') => void
  applyFilter: (filter: 'all' | 'ranked' | 'abstained') => void

  // Block 5, the map surface. `regionId` defaults to the United States at every width (R-01);
  // the polygon selection is one id with the region's own type (R-19, R-23); the scene is the
  // one mode read of the load (R-09); `polygonClass` is what the chip and the tooltip print.
  regionId: RegionId
  selectedPolygonId: PolygonRawId | null
  polygonMode: PolygonScene | null
  polygonClass: ClassDisplay | null
  polygonClassYear: number | null
  basemapId: BasemapAdapterId
  /** R-11: a source that failed at runtime, as opposed to a tier that never mounted. */
  polygonSourceError: PolygonFailureKey | null
  /** R-35: the basemap tile failure line the region prints; the map itself keeps drawing. */
  basemapFailed: boolean
  /** R-32: `?basemap=google` was asked for without `VITE_GOOGLE_MAPS_API_KEY`. */
  basemapKeyMissing: boolean
  /** R-25: the selected feature's own class and area values, read from the rendered tile. */
  polygonRaw: PolygonFeatureRaw | null
  /** R-37: the legend rows of the classes in view, read from the map at idle. */
  legendRows: LegendRow[]
  /** R-12: the current map zoom, which the zoom and select lines read. */
  mapZoom: number | null
  setRegionId: (regionId: RegionId) => void
  restorePolygon: (rawId: PolygonRawId) => void
  clearPolygonSelection: () => void
  setPolygonScene: (scene: PolygonScene | null) => void
  setPolygonClass: (display: ClassDisplay | null, raw?: PolygonFeatureRaw | null) => void
  setPolygonClassYear: (year: number | null) => void
  setBasemapId: (basemapId: BasemapAdapterId) => void
  setPolygonSourceError: (failure: PolygonFailureKey | null) => void
  setBasemapFailed: (failed: boolean) => void
  setBasemapKeyMissing: (missing: boolean) => void
  setLegendRows: (rows: LegendRow[]) => void
  setMapZoom: (zoom: number | null) => void

  // Block 4, wave 2. `chosenDate` is null until a date control sets it, and the axis
  // default stands in for it, so this wave never invents a date of its own.
  chosenDate: string | null
  axis: LayersAxis
  catalog: LayerCatalog
  layerCatalogFailed: boolean
  on: Record<string, boolean>
  opacity: Record<string, number>
  order: string[]
  pinnedDates: Record<string, string | null>
  compare: Record<string, CompareState | null>
  tileDecisions: Record<string, TileDecision>
  setChosenDate: (date: string) => void
  setLayersResponse: (payload: { chosen_date: string; axis: LayersAxis; catalog: LayerCatalog }) => void
  setLayerCatalogFailed: (failed: boolean) => void
  setLayerOn: (layerId: string, on: boolean) => void
  setOpacity: (layerId: string, opacity: number) => void
  moveLayer: (layerId: string, direction: 'up' | 'down') => void
  setPinnedDate: (layerId: string, date: string | null) => void
  setCompare: (layerId: string, compare: CompareState | null) => void
  setCompareDate: (layerId: string, date: string | null) => void
  setCompareDivider: (layerId: string, divider: number) => void
  setTileDecision: (layerId: string, decision: TileDecision) => void
  /** R-44: the row reports the scan's outcome until the next `/layers` response replaces it. */
  setLayerStatus: (layerId: string, status: LayerStatus) => void

  // Block 6. `numbersOpen` mirrors `?numbers=1` (R-01). `polygonRing` is the outline of the
  // selected polygon as the map rendered it, the ring the numbers request carries (Table B).
  // `numbersLastRead` holds the last payload per field and window in memory only (R-48); it is
  // never written to local storage, like every other selection of the app.
  numbersOpen: boolean
  polygonRing: [number, number][] | null
  numbersLastRead: Record<string, NumbersPayload>
  setNumbersOpen: (open: boolean) => void
  setPolygonRing: (ring: [number, number][] | null) => void
  setNumbersLastRead: (key: string, payload: NumbersPayload) => void

  // Block 7. The two open flags are URL state like `numbersOpen`: the App writes `?decision=1` and
  // `?record=1` from them. `registeredFields` is the producer's own record as the store read it,
  // and `producerData` is every declared season keyed by field id.
  calendarOpen: boolean
  recordOpen: boolean
  registeredFields: RegisteredField[]
  producerData: Record<string, ProducerEntry>
  setCalendarOpen: (open: boolean) => void
  setRecordOpen: (open: boolean) => void
  setProducerRecords: (fields: RegisteredField[], producer: Record<string, ProducerEntry>) => void
}

const DEFAULT_ORDER = LAYER_CATALOG.map((entry) => entry.id)
// Only the block 1 layer starts visible, so R-19 holds at first paint: a layer that is
// off issues no tile request, and the transport sees `smap-l3` alone (AC-15).
const DEFAULT_ON = { 'smap-l3': true }

export const useMapStore = create<MapState>((set, get) => ({
  selectedFieldId: null,
  composition: 'map',
  openPanelName: null,
  activeFilter: null,
  /**
   * R-22 and R-24: `select_field` is the only way a selection is written, and its `field_id`
   * says which kind it is. A prefixed id (`csb:` or `trazo:`) is a polygon of the active
   * region, stored with its own type; anything else is a fixture field. Selecting one clears
   * the other, so at most one of the two is ever selected.
   */
  selectField: (fieldId) => {
    const region = regionAdapter(get().regionId)
    const rawId = rawIdFromCommandFieldId(region, fieldId)
    if (rawId !== null) {
      // Block 5.5, U4: a selection writes the whole polygon state in one set, class and raw values
      // included. Selecting B after A used to leave A's class, raw values and ring on screen,
      // because only `selectedPolygonId` was written and the sync effect treats a populated class
      // as a finished resolution.
      set({
        selectedPolygonId: rawId,
        selectedFieldId: null,
        polygonClass: null,
        polygonClassYear: null,
        polygonRaw: null,
        polygonRing: null,
      })
      return
    }
    set({
      selectedFieldId: fieldId,
      selectedPolygonId: null,
      polygonClass: null,
      polygonClassYear: null,
      polygonRaw: null,
      polygonRing: null,
    })
  },
  setComposition: (composition) => set({ composition }),
  openPanel: (openPanelName) => set({ openPanelName }),
  applyFilter: (activeFilter) => set({ activeFilter }),

  regionId: DEFAULT_REGION_ID,
  selectedPolygonId: null,
  polygonMode: null,
  polygonClass: null,
  polygonClassYear: null,
  basemapId: 'eox-s2cloudless-2024',
  polygonSourceError: null,
  basemapFailed: false,
  basemapKeyMissing: false,
  polygonRaw: null,
  legendRows: [],
  mapZoom: null,

  /** R-03: a region change clears both selections, the class and the legend of the previous region. */
  setRegionId: (regionId) => set({
    regionId,
    selectedPolygonId: null,
    selectedFieldId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRaw: null,
    polygonRing: null,
    legendRows: [],
    polygonSourceError: null,
    basemapFailed: false,
  }),

  /** R-23: the selection a `?polygon=` resolves at load, written without a command. */
  restorePolygon: (rawId) => set({
    selectedPolygonId: rawId,
    selectedFieldId: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRaw: null,
    polygonRing: null,
  }),

  clearPolygonSelection: () => set({
    selectedPolygonId: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRaw: null,
    polygonRing: null,
  }),

  setPolygonScene: (polygonMode) => set({ polygonMode }),
  // The raw values travel with the class: a class of null clears both, so no stale area or
  // class value outlives the selection it was read from.
  setPolygonClass: (polygonClass, raw) => set({
    polygonClass,
    polygonRaw: polygonClass === null ? null : (raw ?? null),
  }),
  setPolygonClassYear: (polygonClassYear) => set({ polygonClassYear }),
  setBasemapId: (basemapId) => set({ basemapId }),
  setPolygonSourceError: (polygonSourceError) => set({ polygonSourceError }),
  setBasemapFailed: (basemapFailed) => set({ basemapFailed }),
  setBasemapKeyMissing: (basemapKeyMissing) => set({ basemapKeyMissing }),
  setLegendRows: (legendRows) => set({ legendRows }),
  setMapZoom: (mapZoom) => set({ mapZoom }),

  chosenDate: null,
  axis: LAYER_AXIS,
  catalog: LAYER_CATALOG,
  layerCatalogFailed: false,
  on: { ...DEFAULT_ON },
  opacity: {},
  order: [...DEFAULT_ORDER],
  pinnedDates: {},
  compare: {},
  tileDecisions: {},

  setChosenDate: (chosenDate) => set({ chosenDate }),

  // A new response replaces the rows but not the user's own state: order, opacity, pins and
  // compare survive it (R-40 keeps them across a resize, and a date change is the same
  // kind of change). A layer the catalog no longer holds is dropped from the order, and a
  // new layer is appended, so the stack list always covers the catalog.
  // `chosenDate` is left alone on purpose: null means "the axis default" (R-28), and
  // writing the response's own date back into the store would refetch the same date.
  setLayersResponse: ({ axis, catalog }) => set((state) => {
    const ids = catalog.map((entry) => entry.id)
    const kept = state.order.filter((id) => ids.includes(id))
    const added = ids.filter((id) => !kept.includes(id))
    return {
      catalog,
      axis,
      layerCatalogFailed: false,
      order: [...kept, ...added],
    }
  }),

  setLayerCatalogFailed: (layerCatalogFailed) => set({ layerCatalogFailed }),

  setLayerOn: (layerId, on) => set((state) => ({
    on: { ...state.on, [layerId]: on },
    // A layer turned on starts at 0.55 unless the user already moved its opacity (R-17).
    opacity: on && !Object.hasOwn(state.opacity, layerId)
      ? { ...state.opacity, [layerId]: LAYER_DEFAULT_OPACITY }
      : state.opacity,
  })),

  setOpacity: (layerId, opacity) => set((state) => ({
    opacity: { ...state.opacity, [layerId]: Math.min(1, Math.max(0, opacity)) },
  })),

  // R-18: the first item is drawn on top. A move swaps the row with its neighbour and
  // nothing else, so the stack keeps every other relative position.
  moveLayer: (layerId, direction) => set((state) => {
    const index = state.order.indexOf(layerId)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= state.order.length) return state
    const order = [...state.order]
    ;[order[index], order[target]] = [order[target], order[index]]
    return { order }
  }),

  setPinnedDate: (layerId, date) => set((state) => ({
    pinnedDates: { ...state.pinnedDates, [layerId]: date },
  })),

  setCompare: (layerId, compare) => set((state) => ({
    compare: { ...state.compare, [layerId]: compare },
  })),

  setCompareDate: (layerId, date) => set((state) => {
    const current = state.compare[layerId] ?? { date: null, divider: COMPARE_DEFAULT_DIVIDER }
    return { compare: { ...state.compare, [layerId]: { ...current, date } } }
  }),

  setCompareDivider: (layerId, divider) => set((state) => {
    const current = state.compare[layerId] ?? { date: null, divider: COMPARE_DEFAULT_DIVIDER }
    const clamped = Math.min(1, Math.max(0, divider))
    return { compare: { ...state.compare, [layerId]: { ...current, divider: clamped } } }
  }),

  setTileDecision: (layerId, decision) => set((state) => ({
    tileDecisions: { ...state.tileDecisions, [layerId]: decision },
  })),

  // R-44: `none_in_lookback` and `unavailable` carry no date and no age (Data contracts), so
  // the row prints the status alone. The next `/layers` response replaces the whole catalog.
  setLayerStatus: (layerId, status) => set((state) => ({
    catalog: state.catalog.map((entry) => (entry.id === layerId
      ? {
          ...entry,
          status,
          effective_date: status === 'none_in_lookback' || status === 'unavailable' ? null : entry.effective_date,
          age_days: status === 'none_in_lookback' || status === 'unavailable' ? null : entry.age_days,
        }
      : entry)),
  })),

  // Block 6, R-01 and R-02: the open flag is URL state; the App writes `?numbers=1` from it.
  numbersOpen: false,
  polygonRing: null,
  numbersLastRead: {},
  setNumbersOpen: (numbersOpen) => set({ numbersOpen }),
  setPolygonRing: (polygonRing) => set({ polygonRing }),
  setNumbersLastRead: (key, payload) => set((state) => ({
    numbersLastRead: { ...state.numbersLastRead, [key]: payload },
  })),

  // Block 7, R-01 and R-52: the open flags are URL state and the producer's record is read once
  // per session from the two local storage keys and kept here so the chips and the map can read it.
  calendarOpen: false,
  recordOpen: false,
  registeredFields: [],
  producerData: {},
  setCalendarOpen: (calendarOpen) => set({ calendarOpen }),
  setRecordOpen: (recordOpen) => set({ recordOpen }),
  setProducerRecords: (registeredFields, producerData) => set({ registeredFields, producerData }),
}))

/** The chosen date, or the axis default while no control has set one. */
export function chosenDateOf(state: Pick<MapState, 'chosenDate'>): string {
  return state.chosenDate ?? LAYER_AXIS.default
}

/** R-29: the adapter a basemap id names, or the active adapter when the id is unknown. */
export function basemapAdapterFor(basemapId: BasemapAdapterId): BasemapAdapter {
  return BASEMAP_ADAPTERS.find((adapter) => adapter.id === basemapId) ?? activeBasemapAdapter()
}

export function opacityOf(state: Pick<MapState, 'opacity'>, layerId: string): number {
  return state.opacity[layerId] ?? LAYER_DEFAULT_OPACITY
}
