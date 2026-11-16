import { API_BASE } from './api-base'
import { RECORDED_LAYERS_RESPONSE } from './recorded-layers-response'
import { en } from '@/strings/en'
import type { TranslationKey } from '@/strings'


export type LayerStatus = 'on_date' | 'earlier' | 'none_in_lookback' | 'stale' | 'unavailable'
export type LayerKind = 'tile' | 'stale'
export type LayerTimeFormat = 'date' | 'datetime'

/** One row of the `layers` array of `GET /layers` (Data contracts, RFC only on the name). */
export type LayersResponseLayer = {
  id: string
  label: string
  kind: LayerKind
  basis: string
  resolution: string
  matrix: string
  max_zoom: number
  cadence: string
  lookback_days: number | null
  time_format: LayerTimeFormat
  optical: boolean
  window_days: number | null
  /** "land" for products with no values over water; the map hides the sea above them. */
  surface?: 'land' | 'any'
  status: LayerStatus
  effective_date: string | null
  age_days: number | null
  last_observation: string | null
}

export type LayersAxis = { start: string; end: string; default: string }

/** The object `GET /layers` returns (R-14). Not a JSON array. */
export type LayersResponse = {
  chosen_date: string
  axis: LayersAxis
  layers: LayersResponseLayer[]
}

/**
 * One catalog entry. `labelKey` is the string catalog key that holds the display name, so
 * the rail never writes a label literal (R-42); `label` is the response text kept as the
 * fallback for an id the catalog does not know yet.
 */
export type LayerCatalogEntry = Omit<LayersResponseLayer, 'label'> & {
  label: string
  labelKey: TranslationKey | null
}

export type LayerCatalog = readonly LayerCatalogEntry[]

function labelKeyFor(id: string): TranslationKey | null {
  const key = `layers.name.${id}`
  return Object.hasOwn(en, key) ? key as TranslationKey : null
}

/**
 * Builds the catalog from the `/layers` response (Expected Interface). The response order
 * is the stack order the spec fixes, so the catalog keeps it and never sorts: the first
 * item is the layer drawn on top (R-18) and the first one on is the primary layer (R-33).
 */
export function buildLayerCatalog(payload: LayersResponse): LayerCatalog {
  return payload.layers.map(({ label, ...entry }) => ({
    ...entry,
    label,
    labelKey: labelKeyFor(entry.id),
  }))
}

/**
 * The catalog while `/layers` has not answered, generated from the recorded response of
 * `artifacts/fixtures/layers-response-2026-11-12.json`. Every row is marked `unavailable`
 * with no date and no age, which is exactly what R-24 requires a row to print when the
 * `/layers` request fails: the row stays, the status shows, and no date is invented.
 */
export const LAYER_CATALOG: LayerCatalog = buildLayerCatalog(RECORDED_LAYERS_RESPONSE)
  .map((entry) => ({
    ...entry,
    status: 'unavailable' as const,
    effective_date: null,
    age_days: null,
    last_observation: entry.kind === 'stale' ? entry.last_observation : null,
  }))

export const LAYER_AXIS: LayersAxis = RECORDED_LAYERS_RESPONSE.axis

/**
 * R-24: when `/layers` fails, or a layer reports `unavailable`, the row stays with its
 * status text and without a date or an age. The catalog keeps every id, label, basis and
 * resolution, and drops only what the failed response could not confirm.
 */
export function markCatalogUnavailable(catalog: LayerCatalog): LayerCatalog {
  return catalog.map((entry) => ({
    ...entry,
    status: 'unavailable',
    effective_date: null,
    age_days: null,
  }))
}

/** Tile URL of one layer at one date. The proxy resolves the effective date from it (R-13). */
export function layerTileTemplate(layerId: string, date: string | null): string {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  return `${API_BASE}/tiles/${layerId}/{z}/{x}/{y}${query}`
}

export const VECTOR_BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
