/**
 * Context Adapter. It derives the assistant's context from the app's own store (`useMapStore`) and
 * the block 6 client (`fetchNumbers`, `numbersLastReadKey`), and keeps no copy of map state.
 *
 * Reuse rules:
 *  - a payload already in `numbersLastRead` for this field and date is used as is (no new request);
 *  - otherwise one request is sent with the Table B body NumbersView sends, and only when the panel
 *    is open, so a closed panel costs nothing;
 *  - the result is written back to `numbersLastRead` only when the body equals NumbersView's
 *    (fixture fields, and polygons of regions whose area does not come from the sidecar), so the
 *    shared cache never holds a payload NumbersView would not have produced.
 */
import { useEffect, useMemo, useState } from 'react'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { fetchNumbers, numbersLastReadKey, NumbersHttpError, NumbersNetworkError } from '@/lib/numbers-api'
import { interiorPoint, type NumbersPayload, type NumbersRequest } from '@/lib/numbers'
import { commandFieldId } from '@/lib/polygon-selection'
import { regionAdapter } from '@/lib/regions'
import type { FieldContext, NumbersStatus } from './types'

type Built = {
  fieldId: string | null
  kind: 'fixture' | 'polygon' | null
  name: string | null
  location: string | null
  center: [number, number] | null
  body: NumbersRequest | 'ring_missing' | null
  sharesCache: boolean
}

function ringKey(ring: [number, number][] | null): string {
  if (ring === null) return 'none'
  const first = ring[0] ?? [0, 0]
  return `${ring.length}:${first[0].toFixed(6)},${first[1].toFixed(6)}`
}

export function useFieldContext(selectedField: FieldSummary | null, enabled: boolean): FieldContext & { center: [number, number] | null } {
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonRing = useMapStore((state) => state.polygonRing)
  const date = useMapStore(chosenDateOf)
  const setNumbersLastRead = useMapStore((state) => state.setNumbersLastRead)

  const built: Built = useMemo(() => {
    const region = regionAdapter(regionId)
    if (selectedPolygonId !== null) {
      const fieldId = commandFieldId(region, selectedPolygonId)
      const centre = polygonRing ? interiorPoint(polygonRing) : null
      return {
        fieldId,
        kind: 'polygon',
        name: null,
        location: null,
        center: centre,
        body: polygonRing && centre ? { ring: polygonRing, centroid: centre, area_ha: null, date } : 'ring_missing',
        sharesCache: !region.areaFromSidecar,
      }
    }
    if (selectedField === null) {
      return { fieldId: null, kind: null, name: null, location: null, center: null, body: null, sharesCache: false }
    }
    return {
      fieldId: selectedField.id,
      kind: 'fixture',
      name: selectedField.name,
      location: selectedField.location,
      center: selectedField.center,
      body: {
        ring: selectedField.boundary.coordinates[0] as [number, number][],
        centroid: selectedField.center,
        area_ha: null,
        date,
      },
      sharesCache: true,
    }
  }, [regionId, selectedPolygonId, polygonRing, selectedField, date])

  const key = `${built.fieldId ?? 'none'}|${date}|${ringKey(polygonRing)}`
  const cacheKey = built.fieldId ? numbersLastReadKey(built.fieldId, date) : null
  const cached = useMapStore((state) => (cacheKey ? state.numbersLastRead[cacheKey] : undefined))
  const [fetched, setFetched] = useState<{ key: string; status: NumbersStatus } | null>(null)

  const usable = (payload: NumbersPayload | undefined): payload is NumbersPayload =>
    payload !== undefined && payload.field_id === built.fieldId && payload.query.date === date

  useEffect(() => {
    if (!enabled || built.fieldId === null || typeof built.body !== 'object' || built.body === null) return
    if (usable(useMapStore.getState().numbersLastRead[cacheKey ?? ''])) return
    const controller = new AbortController()
    const fieldId = built.fieldId
    setFetched({ key, status: { kind: 'loading' } })
    fetchNumbers(fieldId, built.body, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return
        if (built.sharesCache && cacheKey) setNumbersLastRead(cacheKey, payload)
        setFetched({ key, status: { kind: 'ready', payload, cached: false } })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (reason instanceof NumbersHttpError) {
          setFetched({ key, status: { kind: 'error', status: reason.status } })
          return
        }
        const held = cacheKey ? useMapStore.getState().numbersLastRead[cacheKey] : undefined
        const isNetwork = reason instanceof NumbersNetworkError || reason instanceof TypeError
        setFetched({ key, status: isNetwork && usable(held) ? { kind: 'held', payload: held } : { kind: 'offline' } })
      })
    return () => controller.abort()
    // The request is keyed by `key` (field, date, ring) and `enabled`; the body is derived from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  let numbers: NumbersStatus
  if (built.fieldId === null) numbers = { kind: 'no_field' }
  else if (built.body === 'ring_missing') numbers = { kind: 'ring_missing' }
  else if (fetched?.key === key && fetched.status.kind !== 'ready') numbers = fetched.status
  else if (fetched?.key === key && fetched.status.kind === 'ready') numbers = fetched.status
  else if (usable(cached)) numbers = { kind: 'ready', payload: cached, cached: true }
  else numbers = { kind: 'loading' }

  return {
    fieldId: built.fieldId,
    kind: built.kind,
    name: built.name,
    location: built.location,
    center: built.center,
    regionId,
    date,
    key,
    numbers,
    polygonGeometry: built.kind === 'polygon' && typeof built.body === 'object' && built.body !== null
      ? { ring: built.body.ring, centroid: built.body.centroid }
      : null,
  }
}
