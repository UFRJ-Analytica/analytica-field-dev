import { useEffect } from 'react'
import { API_BASE } from './api-base'
import { buildLayerCatalog, markCatalogUnavailable, type LayersResponse } from './layer-catalog'
import { useMapStore } from './map-store'


type TilePosition = { z: number; x: number; y: number }

/**
 * One `/layers` request per chosen date and viewport tile, written into the store.
 *
 * The rail and the map both read the catalog from the store, so the screen issues one
 * request instead of one per consumer, and a failure is a single fact that R-24 renders in
 * every row. The rows never disappear: on failure the previous catalog is kept and every
 * row is marked `unavailable` with no date and no age, which is what AC-20 measures.
 */
export function useLayers(tile: TilePosition | null): void {
  const chosenDate = useMapStore((state) => state.chosenDate)
  // The axis is read from the store inside the effect, not through a dependency: the
  // response carries a fresh axis object every time, and keying on its identity made the
  // effect refetch its own result in a loop.
  const zoom = tile?.z
  const x = tile?.x
  const y = tile?.y

  useEffect(() => {
    const controller = new AbortController()
    const axis = useMapStore.getState().axis
    const date = useMapStore.getState().chosenDate ?? axis.default
    const query = new URLSearchParams({ date })
    if (zoom !== undefined && x !== undefined && y !== undefined) {
      query.set('z', String(zoom))
      query.set('x', String(x))
      query.set('y', String(y))
    }
    fetch(`${API_BASE}/layers?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as LayersResponse
        if (Array.isArray(payload) || !Array.isArray(payload.layers)) throw new Error('Invalid layer response')
        return payload
      })
      .then((payload) => {
        useMapStore.getState().setLayersResponse({
          chosen_date: payload.chosen_date,
          axis: payload.axis,
          catalog: buildLayerCatalog(payload),
        })
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        const state = useMapStore.getState()
        state.setLayersResponse({
          chosen_date: state.chosenDate ?? state.axis.default,
          axis: state.axis,
          catalog: markCatalogUnavailable(state.catalog),
        })
        state.setLayerCatalogFailed(true)
      })
    return () => controller.abort()
  }, [chosenDate, zoom, x, y])
}
