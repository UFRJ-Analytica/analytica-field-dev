/**
 * R-44: the `Latest image` scan.
 *
 * One request per date, from the chosen date backwards, one day at a time. The scan stops at
 * the first date whose body is larger than the 5,000 byte threshold (OD-11) and requests no
 * date older than that one. It is not clamped to the layer's `declared_end`: the declared end
 * lags the imagery, so its first candidate is the chosen date itself (R-08, M-17).
 *
 * The bytes are measured by the backend, at the layer's first field tile, on the coverage
 * route the spec defines for it: one call of `GET /layers/{id}/coverage?days=1` is exactly
 * one date at that tile, and the route answers 503 with the dates scanned so far when the
 * upstream stops for a status other than 200, 400 or 404 (R-10, R-44). The route's own
 * 30-day window is a different scan and is never used here, because it would request the
 * dates after the first hit.
 */

import { API_BASE } from './api-base'
import { addDays } from './timeline'


/** OD-11: a body above this many bytes is imagery; at or below it the tile is blank. */
export const LATEST_IMAGE_THRESHOLD_BYTES = 5000

/** R-44: thirty days backwards is the whole lookback of the scan. */
export const LATEST_IMAGE_DAYS = 30

/** One date row of the coverage route (Data contracts). */
export type CoverageRow = {
  date: string
  http_status: number
  bytes: number
  coverage_ok: boolean
}

export type LatestImageScan =
  /** A date above the threshold was found; this is the date the scan lands on. */
  | { status: 'found'; date: string; dates_scanned: string[] }
  /** No date in the window holds imagery, so the chosen date does not move. */
  | { status: 'none_in_lookback'; dates_scanned: string[] }
  /** The upstream stopped for a status other than 200, 400 or 404; the date does not move. */
  | { status: 'unavailable'; dates_scanned: string[] }

export type LatestImageOptions = {
  layerId: string
  chosenDate: string
  /** R-08: the scan requests no date before the axis start, which bounds `time_start`. */
  axisStart?: string
  days?: number
  fetcher?: typeof fetch
  baseUrl?: string
}

/**
 * Runs the scan. Every date it requests is recorded in `dates_scanned` in order, so a caller
 * can assert both the stop date and the absence of any older request.
 */
export async function scanLatestImage({
  layerId,
  chosenDate,
  axisStart,
  days = LATEST_IMAGE_DAYS,
  fetcher,
  baseUrl = API_BASE,
}: LatestImageOptions): Promise<LatestImageScan> {
  const datesScanned: string[] = []
  const request = fetcher ?? fetch

  for (let back = 0; back < days; back += 1) {
    const date = addDays(chosenDate, -back)
    // R-08: the scan stops at the axis start instead of asking for a date before it.
    if (axisStart !== undefined && date < axisStart) break
    datesScanned.push(date)

    let response: Response
    try {
      response = await request(`${baseUrl}/layers/${encodeURIComponent(layerId)}/coverage?date=${date}&days=1`)
    } catch {
      return { status: 'unavailable', dates_scanned: datesScanned }
    }

    // R-44: the coverage route answers 503 when the upstream stops the scan.
    if (response.status === 503) return { status: 'unavailable', dates_scanned: datesScanned }
    if (!response.ok) return { status: 'unavailable', dates_scanned: datesScanned }

    const payload = await response.json() as { dates?: CoverageRow[] }
    const row = payload.dates?.[0]
    if (!row) return { status: 'unavailable', dates_scanned: datesScanned }

    // A 400 or a 404 counts as no observation, so the scan steps back one day (R-11).
    if (row.coverage_ok) return { status: 'found', date, dates_scanned: datesScanned }
  }

  return { status: 'none_in_lookback', dates_scanned: datesScanned }
}
