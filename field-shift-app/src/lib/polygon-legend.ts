/**
 * R-37: the legend lists the classes present in the current view, deduplicated by class id,
 * ordered by ascending class id, with the unmapped rows last. The whole 255 row United States
 * table is never printed, because a row exists only while a polygon of that class is drawn.
 *
 * The names and hexes come from the active region's class table (R-44). The two unmapped labels
 * are catalog strings, so a row carries a `nameKey` for them: `No CDL class for {Y}` for a United
 * States null or absent class (first), and `class not mapped` for every other unmapped value
 * (last). Both paint UNMAPPED_CLASS_COLOUR (AC-17), so the rows are told apart by their label.
 */
import type { TranslationKey } from '@/strings'
import { POLYGON_FILL_LAYER_ID, POLYGON_OVERVIEW_FILL_LAYER_ID } from './polygon-source'
import type { RegionAdapter } from './regions'
import { classDisplay } from './polygon-style'

export type LegendRow = {
  classId: number | null
  name: string | null
  nameKey: TranslationKey | null
  /** The variables of `nameKey`, for example the painted year of `polygon.no_cdl_class`. */
  params?: { year: number | string }
  hex: string
  unmapped: boolean
}

export const UNMAPPED_LEGEND_KEY = 'polygon.class_not_mapped' satisfies TranslationKey
export const NO_CDL_LEGEND_KEY = 'polygon.no_cdl_class' satisfies TranslationKey

/**
 * Reads the class id from a rendered feature's properties. The tile value is a number; a
 * string form is the same number and is read as one. An absent or null property is null,
 * which is the unmapped case of R-21, never a guess.
 */
export function classIdFrom(
  _region: RegionAdapter,
  properties: Record<string, unknown> | null | undefined,
  property: string,
): number | null {
  const value = properties?.[property]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return null
}

/**
 * R-37: dedupe by class id, ascending, then the No CDL row (a United States null or absent class,
 * with the painted year `noCdlYear`), then the class not mapped row. `classIds` holds what
 * `classIdFrom` reads, so a null is an absent or null property and every other unmapped value is
 * a number the table does not hold, which includes a United States 0 and every Brazil value.
 */
export function legendRows(
  classIds: readonly unknown[],
  region: RegionAdapter,
  noCdlYear: number | null = null,
): LegendRow[] {
  const seen = new Set<number>()
  let noCdlInView = false
  let unmappedInView = false
  for (const raw of classIds) {
    if (region.id === 'us' && raw === null) {
      noCdlInView = true
      continue
    }
    const display = classDisplay(region, raw)
    if (display.unmapped) {
      unmappedInView = true
      continue
    }
    seen.add(display.classId as number)
  }
  const rows: LegendRow[] = [...seen]
    .sort((a, b) => a - b)
    .map((classId) => {
      const display = classDisplay(region, classId)
      return {
        classId,
        name: display.name,
        nameKey: null,
        hex: display.hex,
        unmapped: false,
      }
    })
  if (noCdlInView) {
    rows.push({
      classId: null,
      name: null,
      nameKey: NO_CDL_LEGEND_KEY,
      params: { year: noCdlYear ?? '' },
      hex: classDisplay(region, null).hex,
      unmapped: true,
    })
  }
  if (unmappedInView) {
    rows.push({
      classId: null,
      name: null,
      nameKey: UNMAPPED_LEGEND_KEY,
      hex: classDisplay(region, null).hex,
      unmapped: true,
    })
  }
  return rows
}

/** The two fill layers a rendered feature can come from; the overview pair is never interactive. */
export const LEGEND_LAYERS = [POLYGON_FILL_LAYER_ID, POLYGON_OVERVIEW_FILL_LAYER_ID] as const

type LegendMap = {
  queryRenderedFeatures: (options?: Record<string, unknown>) => Array<{ properties?: Record<string, unknown> | null }>
}

/** R-37: the rows for what is on screen right now, over the mounted polygon fill layers. */
export function legendRowsForMap(
  map: LegendMap,
  region: RegionAdapter,
  property: string,
  noCdlYear: number | null = null,
): LegendRow[] {
  const features = map.queryRenderedFeatures({ layers: [...LEGEND_LAYERS] })
  return legendRows(
    features.map((feature) => classIdFrom(region, feature.properties, property)),
    region,
    noCdlYear,
  )
}
