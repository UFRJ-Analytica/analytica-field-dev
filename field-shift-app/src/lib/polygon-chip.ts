/**
 * R-21 and R-28: the chip a selected polygon produces, as one pure step so the year rule is
 * tested at its source rather than only through the rendered component.
 *
 * The selected id decides whether a chip exists; the class display supplies the table name and
 * hex; and `noCdlYearOf` supplies the painted year only for a United States null or absent class.
 * Every other unmapped value (a United States 0, a nonzero code the table does not hold and every
 * Brazil value) carries no year and prints `class not mapped`.
 */
import { commandFieldId, type PolygonRawId } from './polygon-selection'
import type { PolygonFeatureRaw } from './polygon-readout'
import type { ClassDisplay } from './polygon-style'
import { noCdlYearOf, unmappedClassColour } from './polygon-style'
import type { RegionAdapter } from './regions'

export type SelectedPolygonChip = {
  /** The `select_field` id of the polygon, `trazo:12345` or `csb:381825001868504`. */
  fieldId: string
  /** The class name of the table, or `null` when the class is not in the table. */
  name: string | null
  hex: string
  /**
   * R-21 and R-28: the painted year of a United States null or absent class, which prints
   * `No CDL class for {Y}`. `null` for every other unmapped value, which prints `class not mapped`.
   */
  noCdlYear?: number | null
}

export function selectedPolygonChipOf(
  selectedPolygonId: PolygonRawId | null,
  polygonClass: ClassDisplay | null,
  polygonRaw: PolygonFeatureRaw | null,
  region: RegionAdapter,
  date: string,
): SelectedPolygonChip | null {
  if (selectedPolygonId === null) return null
  return {
    fieldId: commandFieldId(region, selectedPolygonId),
    name: polygonClass?.name ?? null,
    hex: polygonClass?.hex ?? unmappedClassColour(),
    noCdlYear: polygonRaw === null ? null : noCdlYearOf(region, polygonRaw.classValue, date),
  }
}
