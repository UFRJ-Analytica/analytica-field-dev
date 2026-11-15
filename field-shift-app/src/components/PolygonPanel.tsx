import { useEffect, useState } from 'react'
import { basemapAdapterFor, chosenDateOf, useMapStore } from '@/lib/map-store'
import { polygonStatusLines } from '@/lib/polygon-source'
import {
  fetchPolygonArea,
  provenanceLine,
  readoutRows,
  type SidecarArea,
} from '@/lib/polygon-readout'
import { regionAdapter } from '@/lib/regions'
import { t, type TranslationKey } from '@/strings'

/** The landmark class of the region. The App mounts it only at widths above 640 (R-40). */
export const POLYGON_PANEL_CLASS = 'polygon-panel'

type StatusLine = { key: 'failure' | 'key' | 'basemap' | 'zoom' | 'select'; text: string }

/**
 * R-39: the `Polygon` region, one landmark with the content order of the spec: the heading,
 * the five readout rows (R-25), the legend rows (R-37), the provenance line (R-38), the source
 * line, the licence credit line (R-33), then the five status lines in their declared order.
 * It carries no control (R-42) and every absent line is absent, leaving no gap.
 */
export function PolygonPanel() {
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonMode = useMapStore((state) => state.polygonMode)
  const polygonRaw = useMapStore((state) => state.polygonRaw)
  const legendRows = useMapStore((state) => state.legendRows)
  const mapZoom = useMapStore((state) => state.mapZoom)
  const polygonSourceError = useMapStore((state) => state.polygonSourceError)
  const basemapFailed = useMapStore((state) => state.basemapFailed)
  const basemapKeyMissing = useMapStore((state) => state.basemapKeyMissing)
  const basemapId = useMapStore((state) => state.basemapId)
  const chosenDate = useMapStore(chosenDateOf)

  const region = regionAdapter(regionId)
  const [sidecar, setSidecar] = useState<SidecarArea>({ status: 'idle' })

  // R-25: the Brazil area is read from the sidecar for the selected polygon only. The United
  // States never calls it (Table D), and a superseded request is aborted before it can answer.
  useEffect(() => {
    if (!region.areaFromSidecar || selectedPolygonId === null) {
      setSidecar({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setSidecar({ status: 'loading' })
    fetchPolygonArea(region, selectedPolygonId, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setSidecar(next)
    })
    return () => controller.abort()
  }, [region, selectedPolygonId])

  const scene = polygonMode
  const classSource = scene?.classSource ?? null
  const { rows } = readoutRows({
    region,
    selected: selectedPolygonId !== null,
    raw: polygonRaw,
    date: chosenDate,
    classSource,
    sidecar,
  })
  const provenance = provenanceLine(region, chosenDate, classSource)
  const adapter = basemapAdapterFor(basemapId)
  const hasTiers = Boolean(scene?.tiers)

  // R-12: the zoom and select lines come from the one rule of the source module. An unknown
  // zoom prints no select line, because the select line is claimed only below a known zoom.
  const lines = scene ? polygonStatusLines(scene, mapZoom ?? Number.POSITIVE_INFINITY) : null
  const failure = lines?.failure ?? polygonSourceError
  const statusLines: StatusLine[] = []
  if (failure) statusLines.push({ key: 'failure', text: t(failure as TranslationKey) })
  if (basemapKeyMissing) statusLines.push({ key: 'key', text: t('polygon.google_key_missing') })
  if (basemapFailed) statusLines.push({ key: 'basemap', text: t('polygon.basemap_unavailable') })
  // R-12 and AC-05, AC-09: a failure line means no tier paints. The zoom and select lines name a
  // mounted tier, so they are absent beside the failure line, not printed next to it.
  const tierMounted = failure === null
  if (tierMounted && lines?.zoomLine) {
    statusLines.push({ key: 'zoom', text: t('polygon.polygons_from_zoom', { lowest: lines.zoomLine.lowest }) })
  }
  if (tierMounted && lines?.selectLine) {
    statusLines.push({
      key: 'select',
      text: t('polygon.select_from_zoom', { interactive: lines.selectLine.interactive }),
    })
  }

  return (
    <section aria-label={t('polygon.region_label')} className={POLYGON_PANEL_CLASS} data-polygon-region>
      <h2 className="polygon-heading">{t('polygon.selected_polygon')}</h2>
      <dl aria-label={t('polygon.readout_label')} className="polygon-readout">
        {rows.map((row) => (
          <div className="polygon-readout-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd data-dynamic-content>{row.value}</dd>
          </div>
        ))}
      </dl>
      {legendRows.length > 0 && (
        <ul aria-label={t('polygon.legend_label')} className="polygon-legend">
          {legendRows.map((row) => (
            <li className="polygon-legend-row" key={row.nameKey ?? row.classId}>
              <span aria-hidden="true" className="polygon-legend-swatch" style={{ background: row.hex }} />
              {/* R-44: class names are data values of the class tables, not catalog text. */}
              <span data-dynamic-content>{row.nameKey ? t(row.nameKey, row.params) : row.name}</span>
            </li>
          ))}
        </ul>
      )}
      {legendRows.length === 0 && hasTiers && (
        <p className="polygon-legend-empty">{t('polygon.legend_empty')}</p>
      )}
      {provenance && <p className="polygon-provenance">{provenance}</p>}
      {/* Table F strings are data of the licence, carried verbatim and never retyped (R-48). */}
      <p className="polygon-source" data-dynamic-content>{region.sourceString}</p>
      <p className="polygon-credit" data-dynamic-content>{adapter.shortCredit}</p>
      {statusLines.map((line) => (
        <p className={`polygon-status polygon-status-${line.key}`} data-status={line.key} key={line.key}>
          {line.text}
        </p>
      ))}
    </section>
  )
}
