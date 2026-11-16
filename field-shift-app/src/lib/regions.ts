/**
 * R-01 and R-02: one region adapter interface and one entry.
 *
 * Every source specific value of Data contracts Table A is a field here. A requirement
 * never writes one of them as a literal, and another region would be one more entry plus
 * one more column in the table, not a rewritten requirement set.
 *
 * The zoom bounds are not constants of this module: R-05 and AC-03 make every one of them a
 * build measurement read from `data/polygons/us-38017.manifest.json`, so a load that mounts a
 * source without that manifest fails instead of inventing a floor.
 */
import { classTableFor, type ClassTable } from './polygon-class-tables'

export type RegionId = 'us'

export const REGION_IDS = ['us'] as const

/** Table A: the load default is the United States at every width (R-01). */
export const DEFAULT_REGION_ID: RegionId = 'us'

export type RegionTiers = {
  detail: { minzoom: number; maxzoom: number }
  overview: { minzoom: number; maxzoom: number } | null
  interactiveMinzoom: number
}

/** Table A, the class source cell: the one region paints `cdl{Y}`. */
export type ClassSource = 'cdl-year'

export type RegionAdapter = {
  id: RegionId
  /** Table A: the visible label, the same in both languages. */
  label: string
  defaultView: { center: [number, number]; zoom: number }
  /** Table A: the geometry source and its tier addresses, relative to the app origin. */
  detailFile: string
  overviewFile: string
  /** Table G: the zoom contract file, read at load. */
  manifestFile: string
  sourceLayer: 'trazo'
  /** Table A: the id property, its type and the `select_field` prefix. */
  idProperty: 'csbid' | 'Id'
  idType: 'string' | 'number'
  commandPrefix: 'csb' | 'trazo'
  /** Table A, feature properties read. Nothing outside this list is read (R-04). */
  properties: readonly string[]
  classTable: ClassTable
  classSource: ClassSource
  /** R-13: the release's year range, or null where the class year is not a year of the date. */
  classYearRange: readonly [number, number] | null
  /** Table A: the area property, its unit and the two absence texts of R-25. */
  areaProperty: string
  areaUnit: 'acres' | 'ha'
  basis: 'retrieved' | 'modelled'
  /** Table F: the exact source string, which the region and the attribution both print. */
  sourceString: string
  licence: string
  fixtureIds: readonly string[]
  tileBudget: { detail: number; overview: number; hard: number }
}

export const REGION_ADAPTERS: Record<RegionId, RegionAdapter> = {
  us: {
    id: 'us',
    label: 'United States',
    defaultView: { center: [-97.17, 46.93], zoom: 11 },
    detailFile: 'data/polygons/us-38017-detail.pmtiles',
    overviewFile: 'data/polygons/us-38017-overview.pmtiles',
    manifestFile: 'data/polygons/us-38017.manifest.json',
    sourceLayer: 'trazo',
    idProperty: 'csbid',
    idType: 'string',
    commandPrefix: 'csb',
    properties: [
      'csbid',
      'csbacres',
      'cdl2018',
      'cdl2019',
      'cdl2020',
      'cdl2021',
      'cdl2022',
      'cdl2023',
      'cdl2024',
      'cdl2025',
    ],
    classTable: classTableFor('us'),
    classSource: 'cdl-year',
    classYearRange: [2018, 2025],
    areaProperty: 'csbacres',
    areaUnit: 'acres',
    basis: 'retrieved',
    sourceString:
      'Crop Sequence Boundaries (USDA NASS and ERS), public domain; CDL (USDA NASS), public domain',
    licence: 'CSB and CDL public domain; the Table F string is a courtesy credit',
    fixtureIds: ['381825001868504', '381825001868512', '381825001868517'],
    tileBudget: { detail: 250_000, overview: 300_000, hard: 1_000_000 },
  },
}

/** R-01: the active region is one store value and the default is the United States. */
export function regionAdapter(regionId: RegionId): RegionAdapter {
  return REGION_ADAPTERS[regionId] ?? REGION_ADAPTERS[DEFAULT_REGION_ID]
}

/**
 * R-01: the region is chosen by `?region=` alone, and an unknown or absent value leaves the
 * United States active. A value no adapter carries is treated the same way, which is what keeps
 * a stale bookmark from failing the load.
 */
export function regionFromSearch(search: string): RegionId {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('region')
  return value === DEFAULT_REGION_ID ? DEFAULT_REGION_ID : DEFAULT_REGION_ID
}

/** R-03: `?region=br` is written when Brazil is active and removed for the default. */
export function searchWithRegion(search: string, regionId: RegionId): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (regionId === DEFAULT_REGION_ID) params.delete('region')
  else params.set('region', regionId)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/** Table G: the nine keys a United States manifest carries, and no other. */
export const US_MANIFEST_KEYS = [
  'schema_version',
  'region',
  'clip_box',
  'detail_minzoom',
  'detail_maxzoom',
  'overview_minzoom',
  'overview_maxzoom',
  'interactive_minzoom',
] as const

export type UsManifest = {
  schema_version: '1'
  region: 'us'
  clip_box: string
  detail_minzoom: number
  detail_maxzoom: number
  overview_minzoom: number
  overview_maxzoom: number
  interactive_minzoom: number
}

/** Table G: the pilot box, in west, south, east, north order. */
export const US_PILOT_CLIP_BOX = '-97.20,46.90,-97.14,46.96'

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Table G, read strictly. R-05 forbids a defaulted key, and AC-03 fails a load that mounts
 * a source without a manifest, so every rule is a throw rather than a fallback: a missing
 * key, a key outside the table, a wrong type, a clip box that is not the pilot box, a
 * detail floor above 9, or a derived zoom that does not match its own rule.
 */
export function parseUsManifest(raw: unknown): UsManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('us-38017.manifest.json must be a JSON object')
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!(US_MANIFEST_KEYS as readonly string[]).includes(key)) {
      throw new Error(`us-38017.manifest.json carries a key outside Table G: ${key}`)
    }
  }
  for (const key of US_MANIFEST_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`us-38017.manifest.json is missing the Table G key ${key}`)
    }
  }
  if (value.schema_version !== '1') throw new Error('schema_version must be the string "1"')
  if (value.region !== 'us') throw new Error('region must be "us"')
  if (value.clip_box !== US_PILOT_CLIP_BOX) throw new Error('clip_box must be the pilot box of R-05')
  for (const key of ['detail_minzoom', 'detail_maxzoom', 'overview_minzoom', 'overview_maxzoom', 'interactive_minzoom'] as const) {
    if (!isInteger(value[key])) throw new Error(`${key} must be an integer`)
  }
  const manifest = value as unknown as UsManifest
  if (manifest.detail_maxzoom !== 14) throw new Error('detail_maxzoom must be 14')
  if (manifest.detail_minzoom < 6 || manifest.detail_minzoom > 14) {
    throw new Error('detail_minzoom must be a zoom in 6 to 14')
  }
  // R-05: the build fails above 9, because selection has to work at the default zoom 11.
  if (manifest.detail_minzoom > 9) throw new Error('detail_minzoom must be at most 9')
  if (manifest.overview_minzoom !== manifest.detail_minzoom - 3) {
    throw new Error('overview_minzoom must equal detail_minzoom - 3')
  }
  if (manifest.overview_maxzoom !== manifest.detail_minzoom - 1) {
    throw new Error('overview_maxzoom must equal detail_minzoom - 1')
  }
  if (manifest.interactive_minzoom !== manifest.detail_minzoom + 2) {
    throw new Error('interactive_minzoom must equal detail_minzoom + 2')
  }
  return manifest
}

/**
 * R-05, R-06, R-20: the tier bounds in force for a load. They come from the region's manifest
 * and are never invented, so the contract file and the app cannot disagree (AC-03).
 */
export function tiersFor(manifest?: UsManifest | null): RegionTiers {
  if (!manifest) {
    throw new Error(
      'the United States detail tier needs data/polygons/us-38017.manifest.json; no zoom bound is invented',
    )
  }
  return {
    detail: { minzoom: manifest.detail_minzoom, maxzoom: manifest.detail_maxzoom },
    overview: { minzoom: manifest.overview_minzoom, maxzoom: manifest.overview_maxzoom },
    interactiveMinzoom: manifest.interactive_minzoom,
  }
}

/** R-07, R-12: the lowest mounted tier is the number the zoom line prints. */
export function lowestMountedZoom(tiers: RegionTiers): number {
  return tiers.overview ? Math.min(tiers.detail.minzoom, tiers.overview.minzoom) : tiers.detail.minzoom
}

export { classTableFor }
export type { ClassTable, ClassRow } from './polygon-class-tables'
