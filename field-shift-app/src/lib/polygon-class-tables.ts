/**
 * The class table of R-16 and R-17, loaded once.
 *
 * R-44 makes the class names and hex codes data values, not catalog strings: they come from
 * the published legend of each source, so they live in the JSON files the block 5 build
 * wrote (Table A, "Class table") and never in `src/strings/en.ts`.
 *
 * The files are read at load from the build's own directory. The block 1 to 4 tree has no
 * `src/data/`, and the build card (t_aa25032c) wrote the table under `data/polygons/`, so
 * that is the path this module reads; the deviation from Table A's `src/data/` cell is
 * reported in the card handoff rather than fixed by copying the files. Nothing here edits a
 * table, a name or a hex.
 */
import usClasses from '../../data/polygons/polygon-classes-us.json'
import type { RegionId } from './regions'

/** One row of a class table: the source's own value, name and hex. */
export type ClassRow = { value: number; name: string | null; hex: string }

export type ClassTable = {
  source: {
    name: string
    url: string
    sha256: string
    fetched: string
    [key: string]: unknown
  }
  rows: readonly ClassRow[]
}

const TABLES: Record<RegionId, ClassTable> = {
  us: usClasses as ClassTable,
}

/** R-16 and R-17: the active region's table, never the other region's. */
export function classTableFor(regionId: RegionId): ClassTable {
  return TABLES[regionId]
}
