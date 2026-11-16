import { API_BASE } from './api-base'
import type { LayerStatus } from './layer-catalog'


/** What the map may do with a tile, and what the rail has to say about it. */
export type TileDecision = {
  /** True only when the body is a dated observation for this layer and this date. */
  draw: boolean
  status: LayerStatus
  /** The date the map is showing, or null when the body carries no date. */
  date: string | null
  /** R-25 labels: the reserve has no date, and a layer with neither source has nothing. */
  offline: 'none' | 'offline_sample_date_unknown' | 'no_offline_copy'
  /** Where the body came from, so the map can label a cached tile with its date (R-25). */
  source: 'upstream' | 'cache-offline' | 'reserve' | 'none'
}

export type TileResponse = {
  chosenDate: string
  /** `X-Tile-Date`, present on every 200 of the proxy (R-12). */
  headerDate: string | null
  /** `X-Tile-Source`: `cache-offline` on the R-25 cached branch, `reserve` on the reserve. */
  headerSource: string | null
  /** `X-Tile-Status`: `no_offline_copy` when the R-25 branch has neither source. */
  headerStatus: string | null
  httpStatus: number
  byteLength: number
}

function laterThan(date: string, boundary: string): boolean {
  return date.slice(0, 10) > boundary.slice(0, 10)
}

/**
 * R-23 and the app side of R-25, as a pure decision over one tile response.
 *
 * The two R-23 rules come first, because they are the app's own refusal: a 200 whose
 * `X-Tile-Date` is later than the chosen date is rejected, and a 200 with a zero byte body
 * is not drawn and reports `unavailable`. Only a response that survives both may be drawn.
 * The R-25 labels are read from the headers the proxy sets, so the app never invents a date
 * for a cache entry or a reserve.
 */
export function decideTile(response: TileResponse): TileDecision {
  const { chosenDate, headerDate, headerSource, headerStatus, httpStatus, byteLength } = response
  const source = headerSource === 'cache-offline' || headerSource === 'reserve'
    ? headerSource
    : headerStatus === 'no_offline_copy' ? 'none' : 'upstream'

  if (headerStatus === 'no_offline_copy' || httpStatus === 404) {
    return { draw: false, status: 'unavailable', date: null, offline: 'no_offline_copy', source: 'none' }
  }
  if (httpStatus !== 200) {
    return { draw: false, status: 'unavailable', date: null, offline: 'none', source: 'none' }
  }
  if (headerDate !== null && laterThan(headerDate, chosenDate)) {
    return { draw: false, status: 'none_in_lookback', date: null, offline: 'none', source }
  }
  if (byteLength === 0) {
    return { draw: false, status: 'unavailable', date: null, offline: 'none', source }
  }
  if (source === 'reserve') {
    // R-25: the reserve is undated, so it may be drawn but never as a current observation.
    return { draw: true, status: 'unavailable', date: null, offline: 'offline_sample_date_unknown', source }
  }
  if (headerDate === null) {
    return { draw: false, status: 'unavailable', date: null, offline: 'none', source }
  }
  return {
    draw: true,
    status: headerDate.slice(0, 10) === chosenDate.slice(0, 10) ? 'on_date' : 'earlier',
    date: headerDate,
    offline: 'none',
    source,
  }
}

/**
 * Requests one tile at the first field tile and reads the headers the guard needs. The map
 * itself cannot inspect a tile body, so the app asks once per layer and date before it lets
 * the raster source draw, which is what makes R-23 and the R-25 labels observable.
 */
export async function probeLayerTile(
  layerId: string,
  date: string | null,
  tile: { z: number; x: number; y: number },
  signal?: AbortSignal,
): Promise<TileDecision> {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  const url = `${API_BASE}/tiles/${layerId}/${tile.z}/${tile.x}/${tile.y}${query}`
  try {
    const response = await fetch(url, { signal })
    const body = await response.arrayBuffer()
    return decideTile({
      chosenDate: date ?? '',
      headerDate: response.headers.get('X-Tile-Date'),
      headerSource: response.headers.get('X-Tile-Source'),
      headerStatus: response.headers.get('X-Tile-Status'),
      httpStatus: response.status,
      byteLength: body.byteLength,
    })
  } catch (reason: unknown) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    return { draw: false, status: 'unavailable', date: null, offline: 'none', source: 'none' }
  }
}
