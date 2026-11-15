/**
 * R-14, R-15, R-13 and R-20: the paint values of the polygon layers, as named constants and
 * expressions, so no component and no adapter entry carries a fill opacity or a class hex.
 *
 * The class hexes are not written here either. `classColourExpression` is built at load from
 * the active region's class table (R-15), and `UNMAPPED_CLASS_COLOUR` is the single literal
 * the spec names (R-14).
 */
import type { ExpressionSpecification } from 'maplibre-gl'
import type { ClassRow, RegionAdapter } from './regions'

/** R-14: the rest fill, inside the 0.35 to 0.5 band the research proposes. */
export const POLYGON_FILL_OPACITY = 0.4
/** R-14, R-19: the hover fill. */
export const POLYGON_FILL_OPACITY_HOVER = 0.55
/** R-14, R-19: the selected fill. */
export const POLYGON_FILL_OPACITY_SELECTED = 0.6
/** R-14: the outline is the edge the fill must not replace. */
export const POLYGON_LINE_COLOUR = '#ffffff'
/** R-14 */
export const POLYGON_LINE_OPACITY = 0.75
/** R-14 */
export const POLYGON_LINE_WIDTH_ZOOM10 = 0.5
/** R-14 */
export const POLYGON_LINE_WIDTH_ZOOM14 = 1.5
/** R-14, R-19: the selected outline. */
export const POLYGON_LINE_WIDTH_SELECTED = 3
/** R-14, R-21: the colour of a class no table row names. */
export const UNMAPPED_CLASS_COLOUR = '#8a8f98'

/** The zoom stops the two line widths are named after: 10 and 14. */
export const POLYGON_LINE_WIDTH_ZOOM_STOPS = [10, 14] as const

/** R-14: the one colour a class that no table row holds draws with. */
export function unmappedClassColour(): string {
  return UNMAPPED_CLASS_COLOUR
}

/**
 * R-15: a `match` over the class property, built from the table, with the unmapped colour as
 * the fallback. `coalesce` and `to-number` keep a null or an absent property out of the label
 * list, so a polygon with no class draws unmapped instead of throwing (R-21).
 */
export function classColourExpression(property: string, table: readonly ClassRow[]): ExpressionSpecification {
  const expression: unknown[] = ['match', ['coalesce', ['to-number', ['get', property]], -1]]
  for (const row of table) {
    expression.push(row.value, row.hex)
  }
  expression.push(UNMAPPED_CLASS_COLOUR)
  return expression as unknown as ExpressionSpecification
}

/**
 * R-19: hover and selected raise the fill through the feature state. The transition is part
 * of the paint and is set to 0 under reduced motion by the map (R-45).
 */
export function fillOpacityExpression(): ExpressionSpecification {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    POLYGON_FILL_OPACITY_SELECTED,
    ['boolean', ['feature-state', 'hover'], false],
    POLYGON_FILL_OPACITY_HOVER,
    POLYGON_FILL_OPACITY,
  ] as unknown as ExpressionSpecification
}

/**
 * R-19, R-14: the selected polygon carries the wide outline; every other polygon ramps 10 to 14.
 *
 * MapLibre only accepts a `zoom` expression as the input of a top-level `interpolate`, so the
 * zoom ramp is the outer expression and the selected outline is chosen per output value. A
 * `case` wrapping the interpolate is rejected at addLayer time ("zoom expression may only be
 * used as input to a top-level step or interpolate") and the layer is silently dropped.
 */
export function lineWidthExpression(): ExpressionSpecification {
  const width = (rest: number) => [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    POLYGON_LINE_WIDTH_SELECTED,
    rest,
  ]
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    POLYGON_LINE_WIDTH_ZOOM_STOPS[0], width(POLYGON_LINE_WIDTH_ZOOM10),
    POLYGON_LINE_WIDTH_ZOOM_STOPS[1], width(POLYGON_LINE_WIDTH_ZOOM14),
  ] as unknown as ExpressionSpecification
}

/**
 * R-13: the year of the chosen date clamped to the release's year range. A date outside the
 * range paints the nearest year the release holds and never invents one, and the legend
 * prints the year actually painted, not the date's own year.
 */
export function paintedClassYear(region: RegionAdapter, date: string, classSource?: string): number | null {
  if (region.id === 'br') {
    const source = classSource ?? region.classSource
    if (source === 'mbmode24') return 2024
    if (source === 'class_id') return 2025
    throw new Error(`Brazil paints one class source per load, not ${source}`)
  }
  const range = region.classYearRange
  if (!range) return null
  const parsed = Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(parsed)) return range[1]
  const year = new Date(parsed).getUTCFullYear()
  return Math.min(range[1], Math.max(range[0], year))
}

/**
 * R-21, R-27, R-28 and R-37: the one rule that picks the `No CDL class for {Y}` string over
 * `class not mapped`. A United States null or absent class has no class for the year, so it gets
 * the year text, with the painted year. Every other unmapped value (a United States 0, a nonzero
 * code the table does not hold, and every Brazil value) is a gap in our table and returns null,
 * which keeps `class not mapped`. The tooltip, the fields chip and the legend all call this.
 */
export function noCdlYearOf(region: RegionAdapter, classValue: number | null, date: string): number | null {
  if (region.id !== 'us' || classValue !== null) return null
  return paintedClassYear(region, date)
}

/**
 * R-13 and R-18: the property the paint and the readout read. The United States uses
 * `cdl{Y}` of the clamped year, so one paint expression reads one property; Brazil uses the
 * one class property `/polygons/mode` reports for the load.
 */
export function classPropertyFor(region: RegionAdapter, date: string, classSource?: string): string {
  if (region.id === 'br') {
    const source = classSource ?? null
    if (source !== 'mbmode24' && source !== 'class_id') {
      throw new Error('Brazil needs the class source the load reports; a load paints one class source')
    }
    return source
  }
  const year = paintedClassYear(region, date)
  if (year === null) throw new Error('no class year for this region')
  return `cdl${year}`
}

export type ClassDisplay = {
  classId: number | null
  name: string | null
  hex: string
  unmapped: boolean
}

/**
 * R-21: a class id the table does not hold, a null, an absent value or a row whose name the
 * RAT leaves null draws the unmapped colour and carries no name. No other region's table is
 * consulted and no name is derived from the id.
 */
export function classDisplay(region: RegionAdapter, value: unknown): ClassDisplay {
  const classId = typeof value === 'number' && Number.isFinite(value) ? value : null
  if (classId === null) return { classId: null, name: null, hex: UNMAPPED_CLASS_COLOUR, unmapped: true }
  const row = region.classTable.rows.find((entry) => entry.value === classId)
  if (!row || row.name === null) {
    return { classId, name: null, hex: UNMAPPED_CLASS_COLOUR, unmapped: true }
  }
  return { classId, name: row.name, hex: row.hex, unmapped: false }
}

/**
 * R-20: the minimum interactive zoom is `detail minzoom + 2` read from the region contract,
 * never a constant of its own. Exported under the public name the Expected Interface fixes.
 */
export const POLYGON_INTERACTIVE_MIN_ZOOM = (detailMinzoom: number): number => detailMinzoom + 2
