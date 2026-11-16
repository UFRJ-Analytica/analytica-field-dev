/**
 * R-25, R-33, R-38, R-43 and Table D: the readout rows, the provenance line, the attribution
 * name of the compact control.
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
}

export type ReadoutKey = 'class' | 'area' | 'basis' | 'class_year' | 'source'

export type ReadoutRow = { key: ReadoutKey; label: string; value: string }

export type ReadoutInput = {
  region: RegionAdapter
  selected: boolean
  raw: PolygonFeatureRaw | null
  date: string
  classSource: ClassSource | null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads the two values from a rendered feature: the class of the load's one class property and the
 * area column the tile carries (R-25).
 */
export function rawFeatureFrom(
  region: RegionAdapter,
  properties: Record<string, unknown> | null | undefined,
  classProperty: string,
): PolygonFeatureRaw {
  return {
    classValue: classIdFrom(region, properties, classProperty),
    area: numberOrNull(properties?.[region.areaProperty]),
  }
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

function areaText(region: RegionAdapter, raw: PolygonFeatureRaw): string {
  if (raw.area === null) return t('polygon.area_not_available')
  return t('polygon.area_value', { area: raw.area.toFixed(1), unit: region.areaUnit })
}

/**
 * R-18 and R-38: exactly one provenance line at every mounted width, naming the one class source
 * the load paints. The failure line goes in addition to it, never in its place.
 */
function classYearText(region: RegionAdapter, date: string): string {
  return t('polygon.class_year.cdl', { year: paintedClassYear(region, date) ?? '' })
}


/**
 * R-25: exactly five rows, in the order Class, Area, Basis, Class year, Source. The class and
 * the area are the selected polygon's own values and read empty with no selection; the basis,
 * the year and the source describe the region and are always printed.
 */
export function readoutRows(input: ReadoutInput): { rows: ReadoutRow[] } {
  const { region, selected, raw, date } = input
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
        value: measured === null ? '' : areaText(region, measured),
      },
      { key: 'basis', label: t('polygon.rows.basis'), value: t(basisKey) },
      {
        key: 'class_year',
        label: t('polygon.rows.class_year'),
        value: classYearText(region, date),
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
export function provenanceLine(region: RegionAdapter, date: string): string {
  return t('polygon.provenance.cdl', { year: paintedClassYear(region, date) ?? '' })
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


export type PolygonAreaDeps = {
  fetch?: typeof fetch
  apiBase?: string
  signal?: AbortSignal
}


