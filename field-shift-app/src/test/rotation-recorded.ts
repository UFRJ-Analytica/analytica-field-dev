/**
 * Recorded inputs of block 6 wave 3: the rotation history and the counter evidence.
 *
 * - The United States record is the answer of the USDA Crop Sequence Boundaries 2025
 *   FeatureServer for csbid 381825001868504, queried on 2026-11-15 with
 *   `where=csbid='381825001868504'`. It is saved verbatim in
 *   `artifacts/block6-wave3/csb-381825001868504-cdl-2018-2025.json`, and its csbacres
 *   matches the feature the block 5 readout test uses.
 * - The Brazil case is a contract fixture, not a live answer. It has the shape wave 1's
 *   `rotation_section` returns for a sidecar row whose class is NULL. The block 5 sidecar on
 *   this machine (`polygon_class`) carries `class_id`, `collection` and `year` NULL on every
 *   row and has no `polygon_mapbiomas` table, so no real Brazil row is reproduced here.
 */
import csbRecord from '../../artifacts/block6-wave3/csb-381825001868504-cdl-2018-2025.json'
import { recordedNumbersPayload } from './numbers-recorded'
import type { GapRow, NumbersPayload, RotationSection } from '@/lib/numbers'

export const CSB_FIELD_ID = '381825001868504'
export const CSB_FETCHED = '2026-11-15'
export const CSB_RING: [number, number][] = [
  [-97.15, 46.95],
  [-97.14, 46.95],
  [-97.14, 46.96],
  [-97.15, 46.96],
  [-97.15, 46.95],
]

type CsbRecord = { features: { attributes: Record<string, number | string | null> }[] }
const attributes = (csbRecord as CsbRecord).features[0].attributes

/** The eight CDL classes of the record, keyed by year, exactly as the service returned them. */
export function csbCdlYears(): Record<number, number | null> {
  const years: Record<number, number | null> = {}
  for (let year = 2018; year <= 2025; year += 1) {
    const value = attributes[`cdl${year}`]
    years[year] = typeof value === 'number' ? value : null
  }
  return years
}

export const CSB_ACRES = attributes.csbacres as number

/**
 * A Brazil polygon whose sidecar row carries no class: one first crop row for 2025 with `code`
 * and `class_name` NULL, and the gap the wave 1 route writes for it (R-33, R-34).
 */
export function brNullClassPayload(): NumbersPayload {
  const base = recordedNumbersPayload()
  const rotation: RotationSection = {
    state: 'abstained',
    first_crop: [{ year: 2025, product: 'agriculture_first_crop', code: null, class_name: null, collection: 11 }],
    second_crop: null,
    collection: 'MapBiomas Collection 11',
    collection_year: 2025,
    sidecar: 'polygon_mapbiomas',
    basis: 'modelled',
    source: 'polygon_mapbiomas sidecar (POLYGON_MAPBIOMAS_DB)',
    as_of: '2025-12-31',
    reason: 'class missing for 1 year(s) of agriculture_first_crop',
  }
  const classGap: GapRow = {
    section: 'rotation',
    cause: 'class missing for 1 year(s) of agriculture_first_crop: class_id is NULL in the sidecar, no Collection 11 class is computed',
    source: 'polygon_mapbiomas sidecar (CO-B6-01)',
    status: 'class not computed',
    date: '2025-12-31',
    remediation: 'CO-B6-01: the Collection 11 class of this polygon is not computed',
  }
  return {
    ...base,
    sections: { ...base.sections, rotation },
    gaps: [...base.gaps.filter((gap) => gap.section !== 'rotation'), classGap],
  }
}

/** A United States polygon: the MapBiomas sidecar holds no row for it (R-36), CDL is read from its properties. */
export function usPolygonPayload(): NumbersPayload {
  const base = recordedNumbersPayload()
  const rotation: RotationSection = {
    state: 'abstained',
    first_crop: null,
    second_crop: null,
    collection: 'MapBiomas Collection 11',
    collection_year: 2025,
    sidecar: 'polygon_mapbiomas',
    basis: 'modelled',
    source: 'polygon_mapbiomas sidecar (POLYGON_MAPBIOMAS_DB)',
    as_of: null,
    reason: 'no MapBiomas Collection 11 row for this polygon',
  }
  return { ...base, region: 'us', field_id: `csb:${CSB_FIELD_ID}`, sections: { ...base.sections, rotation } }
}
