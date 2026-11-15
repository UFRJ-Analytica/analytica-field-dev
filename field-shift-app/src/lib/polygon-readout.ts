/**
 * R-25, R-33, R-38, R-43 and Table D: the readout rows, the provenance line, the attribution
 * name of the compact control and the Brazil area from the sidecar.
 *
 * Every value is read from the active region's adapter and the one class source the load
 * reports (R-18). A missing value prints its documented absence text and never a guess: the
 * area is never computed from the rendered geometry (R-25, M-04), and a United States polygon
 * never calls the Brazil route (Table D).
 */
import { t } from '@/strings'
import { classIdFrom } from './polygon-legend'
import { classDisplay, paintedClassYear } from './polygon-style'
import type { ClassSource, RegionAdapter } from './regions'

/** The two values of a clicked feature the readout reads, each `null` when absent or null. */
export type PolygonFeatureRaw = {
  /** The class property of the load (`cdl{Y}`, `mbmode24` or `class_id`), as a number. */
  classValue: number | null
  /** The region's area property when the tile carries it (United States only). */
  area: number | null
  /**
   * Block 6 wave 3, R-33 to R-36: the `cdl{Y}` properties of a United States feature, one entry
   * per CDL year of the region's range, each `null` when the property is absent or null.
   */
  cdl?: Record<number, number | null>
}

/** The Brazil sidecar area of R-25: the row, its absence, or the failure to read it. */
export type SidecarArea =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'found'; areaHa: number }
  | { status: 'absent' }
  | { status: 'error' }

export type ReadoutKey = 'class' | 'area' | 'basis' | 'class_year' | 'source'

export type ReadoutRow = { key: ReadoutKey; label: string; value: string }

export type ReadoutInput = {
  region: RegionAdapter
  selected: boolean
  raw: PolygonFeatureRaw | null
  date: string
  classSource: ClassSource | null
  sidecar: SidecarArea
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads the two values from a rendered feature. Brazil's area is never read from the tile,
 * because the detail tiles carry no area column (R-25, M-01), so `area` stays null there.
 */
export function rawFeatureFrom(
  region: RegionAdapter,
  properties: Record<string, unknown> | null | undefined,
  classProperty: string,
): PolygonFeatureRaw {
  const raw: PolygonFeatureRaw = {
    classValue: classIdFrom(region, properties, classProperty),
    area: region.areaFromSidecar ? null : numberOrNull(properties?.[region.areaProperty]),
  }
  if (region.classSource === 'cdl-year' && region.classYearRange !== null) {
    const cdl: Record<number, number | null> = {}
    for (let year = region.classYearRange[0]; year <= region.classYearRange[1]; year += 1) {
      cdl[year] = numberOrNull(properties?.[`cdl${year}`])
    }
    raw.cdl = cdl
  }
  return raw
}

function classText(region: RegionAdapter, raw: PolygonFeatureRaw, date: string): string {
  // R-21: an absent or null `cdl{Y}` prints the year-missing text in the United States. A code
  // 0 or a code the table does not hold prints `class not mapped`. Brazil has no year text.
  // AC-17 named `class not mapped` for a null `cdl{Y}`, which R-21 does not say. Spec revision 6
  // (card t_2fcdef6a) amended AC-17 to R-21's `No CDL class for {Y}`, and this readout follows R-21.
  // The legend, the tooltip and the fields chip still print `class not mapped` for the same case:
  // that is open decision O1 of the spec, for the user to decide. It is not changed here.
  if (region.id === 'us' && raw.classValue === null) {
    return t('polygon.no_cdl_class', { year: paintedClassYear(region, date) ?? '' })
  }
  return classDisplay(region, raw.classValue).name ?? t('polygon.class_not_mapped')
}

function areaText(region: RegionAdapter, raw: PolygonFeatureRaw, sidecar: SidecarArea): string {
  if (region.areaFromSidecar) {
    if (sidecar.status === 'found') {
      return t('polygon.area_value', { area: sidecar.areaHa.toFixed(1), unit: region.areaUnit })
    }
    if (sidecar.status === 'absent') return t('polygon.area_not_in_class_table')
    if (sidecar.status === 'error') return t('polygon.area_not_available')
    return ''
  }
  if (raw.area === null) return t('polygon.area_not_available')
  return t('polygon.area_value', { area: raw.area.toFixed(1), unit: region.areaUnit })
}

/**
 * R-18: every load this block ships reports `mbmode24`. When no load has reported a class
 * source yet, the provenance and the class year still name that one source, because R-38
 * requires exactly one provenance line at every mounted width, and the failure line goes in
 * addition to it, never in its place.
 */
const SHIPPED_BRAZIL_CLASS_SOURCE: ClassSource = 'mbmode24'

function classYearText(region: RegionAdapter, date: string, classSource: ClassSource | null): string {
  if (region.id === 'us') {
    return t('polygon.class_year.cdl', { year: paintedClassYear(region, date) ?? '' })
  }
  const source = classSource ?? SHIPPED_BRAZIL_CLASS_SOURCE
  if (source === 'mbmode24') return t('polygon.class_year.mbmode')
  return t('polygon.class_year.collection11')
}


/**
 * R-25: exactly five rows, in the order Class, Area, Basis, Class year, Source. The class and
 * the area are the selected polygon's own values and read empty with no selection; the basis,
 * the year and the source describe the region and are always printed.
 */
export function readoutRows(input: ReadoutInput): { rows: ReadoutRow[] } {
  const { region, selected, raw, date, classSource, sidecar } = input
  const measured = selected ? raw : null
  const basisKey = region.basis === 'retrieved' ? 'polygon.basis.retrieved' : 'polygon.basis.modelled'
  return {
    rows: [
      {
        key: 'class',
        label: t('polygon.rows.class'),
        value: measured === null ? '' : classText(region, measured, date),
      },
      {
        key: 'area',
        label: t('polygon.rows.area'),
        value: measured === null ? '' : areaText(region, measured, sidecar),
      },
      { key: 'basis', label: t('polygon.rows.basis'), value: t(basisKey) },
      {
        key: 'class_year',
        label: t('polygon.rows.class_year'),
        value: classYearText(region, date, classSource),
      },
      { key: 'source', label: t('polygon.rows.source'), value: region.sourceString },
    ],
  }
}

/**
 * R-38: the one provenance line of the load. The United States prints the painted year. Brazil
 * prints the line of the one class property the load reports (R-18), and nothing when no class
 * source is loaded, because a line that names a source the map does not paint would be false.
 */
export function provenanceLine(
  region: RegionAdapter,
  date: string,
  classSource: ClassSource | null,
): string {
  if (region.id === 'us') {
    return t('polygon.provenance.cdl', { year: paintedClassYear(region, date) ?? '' })
  }
  const source = classSource ?? SHIPPED_BRAZIL_CLASS_SOURCE
  if (source === 'mbmode24') return t('polygon.provenance.mbmode')
  return t('polygon.provenance.collection11')
}

/**
 * OD-04 and AC-27: the compact control's accessible name carries both short credits, the
 * basemap's visible credit and the region's source string (Table F).
 */
export function attributionCreditName(adapter: { shortCredit: string }, region: RegionAdapter): string {
  return `${adapter.shortCredit} · ${region.sourceString}`
}

/**
 * Names the compact attribution button that MapLibre mounts in the map container. MapLibre
 * labels it with its own library string, so the app overwrites that label with the composed
 * name once the control exists. Returns false when the button is not mounted.
 */
export function nameAttributionToggle(container: ParentNode | null | undefined, name: string): boolean {
  const button = container?.querySelector('.maplibregl-ctrl-attrib-button')
  if (!button) return false
  button.setAttribute('aria-label', name)
  return true
}

/**
 * AC-27 and R-33: a compact MapLibre control starts expanded (`maplibregl-compact-show`, and
 * the `<details>` element open), so its text is what the bottom right corner shows at first.
 * The spec's collapsed footprint is the 24 by 24 button alone, so the control is collapsed once
 * it is added. The button's own press still opens it, because MapLibre's toggle reads the class
 * this removes. Returns false when no compact control is mounted.
 */
export function collapseAttributionControl(container: ParentNode | null | undefined): boolean {
  const control = container?.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')
  if (!control) return false
  control.classList.remove('maplibregl-compact-show')
  control.removeAttribute('open')
  return true
}

const DEFAULT_API_BASE = 'http://localhost:8000'

export type PolygonAreaDeps = {
  fetch?: typeof fetch
  apiBase?: string
  signal?: AbortSignal
}

/**
 * R-25 and Table D: the Brazil area from the sidecar row, read by `GET /polygons/br/{id}`.
 * A 404 is an absent row. Any other failure is an error, which prints a different text, so
 * a missing route is never read as a row that does not exist. A United States polygon never
 * reaches the route.
 */
export async function fetchPolygonArea(
  region: RegionAdapter,
  rawId: string | number,
  deps: PolygonAreaDeps = {},
): Promise<SidecarArea> {
  if (!region.areaFromSidecar) return { status: 'idle' }
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const apiBase = deps.apiBase ?? (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE
  const url = `${apiBase}/polygons/br/${rawId}`
  try {
    const response = deps.signal ? await fetchImpl(url, { signal: deps.signal }) : await fetchImpl(url)
    if (response.status === 404) return { status: 'absent' }
    if (!response.ok) return { status: 'error' }
    const body = (await response.json()) as { area_ha?: unknown }
    const areaHa = numberOrNull(body.area_ha)
    return areaHa === null ? { status: 'absent' } : { status: 'found', areaHa }
  } catch {
    return { status: 'error' }
  }
}
