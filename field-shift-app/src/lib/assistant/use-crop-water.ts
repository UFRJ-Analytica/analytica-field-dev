/**
 * Fetches the crop water set of the selected field from the backend.
 *
 * No FAO-56 equation runs in the browser: `GET /fields/<id>/crop-water?date=...` computes ET0 from the
 * recorded block 6 series, multiplies it by the FAO-56 Table 12 Kc over the crop's own NASS planting
 * window and answers with the numbers or with the abstention. A field that is not a fixture, an
 * answer that is not released and a failed request all clear the feed, so the assistant abstains
 * instead of printing an older field's numbers.
 */
import { useEffect } from 'react'
import { API_BASE } from '@/lib/api-base'
import { cropWaterSetFrom, setCropWaterFeed, type CropWaterBody } from './crop-water'

export function useCropWater(fieldId: string | null, kind: string | null, date: string,
                             enabled = true): void {
  useEffect(() => {
    if (!enabled || fieldId === null || kind !== 'fixture') {
      setCropWaterFeed(null)
      return
    }
    let cancelled = false
    const url = `${API_BASE}/fields/${encodeURIComponent(fieldId)}/crop-water?date=${encodeURIComponent(date)}`
    fetch(url)
      .then((response) => (response.ok ? (response.json() as Promise<CropWaterBody>) : null))
      .then((body) => {
        if (!cancelled) setCropWaterFeed(body === null ? null : cropWaterSetFrom(body, fieldId))
      })
      .catch(() => {
        if (!cancelled) setCropWaterFeed(null)
      })
    return () => {
      cancelled = true
    }
  }, [fieldId, kind, date, enabled])
}
