/**
 * Block 7, R-01, R-06 and R-09: the two URL parameters of the two surfaces.
 *
 * `decision` opens `Planting calendar` and `record` opens `Field record`. At most one of them is in
 * the URL at any moment: opening one removes the other, and opening either also removes `numbers`,
 * because R-06 lets one screen be open at a time. Closing removes only the surface's own parameter,
 * and every other parameter (`date`, `region`, `polygon`, `basemap`) is left byte for byte. These
 * functions are the only place this block writes a URL key (R-09).
 */

export type Surface = 'decision' | 'record'

const OTHER: Record<Surface, Surface> = { decision: 'record', record: 'decision' }

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

function searchOf(params: URLSearchParams): string {
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/** R-01: whether `?decision=1` asks for the calendar. Any other value does not. */
export function surfaceOpenFromSearch(search: string, surface: Surface): boolean {
  return paramsOf(search).get(surface) === '1'
}

/** R-01 and R-06: open one surface, remove the other and `numbers`, keep everything else. */
export function searchWithSurface(search: string, surface: Surface): string {
  const params = paramsOf(search)
  params.set(surface, '1')
  params.delete(OTHER[surface])
  params.delete('numbers')
  return searchOf(params)
}

/** R-01 and R-06: close one surface and remove only its own parameter. */
export function searchWithoutSurface(search: string, surface: Surface): string {
  const params = paramsOf(search)
  params.delete(surface)
  return searchOf(params)
}
