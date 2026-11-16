/**
 * Block 6: the one client call of the numbers surface, `POST /fields/{field_id}/numbers` (R-45,
 * Table B). It sends the body of Table B and returns the payload unchanged; the surface prints
 * what the payload says and nothing else (R-06 and R-42 forbid a fetch on resize, and a reword).
 */
import { API_BASE } from './api-base'
import type { NumbersPayload, NumbersRequest } from './numbers'

export const NUMBERS_API_BASE = API_BASE

/** A non 200 answer. The route answers 400, 404 and 422 with a status the surface names (R-46). */
export class NumbersHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/** A request that never got an answer (R-48): the network is down or the socket failed. */
export class NumbersNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'network error')
  }
}

/** The in-memory key of the last read of a field and a chosen date (R-48). */
export function numbersLastReadKey(fieldId: string, date: string): string {
  return `${fieldId}|${date}`
}

export async function fetchNumbers(
  fieldId: string,
  request: NumbersRequest,
  options: { signal?: AbortSignal; apiBase?: string } = {},
): Promise<NumbersPayload> {
  const base = options.apiBase ?? NUMBERS_API_BASE
  let response: Response
  try {
    response = await fetch(`${base}/fields/${encodeURIComponent(fieldId)}/numbers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ring: request.ring,
        centroid: request.centroid,
        area_ha: request.area_ha,
        date: request.date,
      }),
      signal: options.signal,
    })
  } catch (reason: unknown) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    throw new NumbersNetworkError(reason)
  }
  if (!response.ok) throw new NumbersHttpError(response.status)
  return (await response.json()) as NumbersPayload
}
