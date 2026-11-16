/**
 * Planting windows for the assistant. No rule of its own: the rows come from the same two sources the
 * block 7 Planting calendar reads (`artifacts/zarc-mt-snapshot.json`, `artifacts/us-windows-cass-nd.json`),
 * enveloped by block 7's `calendarRows` and `seasonlessRows`, with block 4's season and place readers.
 * The backend tool `get_planting_constraints` mirrors the same rule for the agent.
 */
import snapshotJson from '../../../artifacts/zarc-mt-snapshot.json'
import usWindowsJson from '../../../artifacts/us-windows-cass-nd.json'
import { calendarRows, seasonKeyFor, seasonlessRows, type SeasonlessPayload, type ZarcWindowRow } from '@/lib/planting-calendar'
import { parseFieldLocation, seasonForDate } from '@/lib/timeline'
import type { Evidence, FieldContext, LimitationCode } from './types'

export type WindowPosition = 'before' | 'inside' | 'after'

export type PlantingWindow = {
  crop: string
  start: string | null
  end: string | null
  position: WindowPosition | null
  evidence: Evidence | null
}

export type PlantingWindows =
  | { kind: 'br'; municipality: string; uf: string; season: string; windows: PlantingWindow[]; portarias: string }
  | { kind: 'us'; state: string; windows: PlantingWindow[] }
  | { kind: 'season_not_held'; season: string; held: string[] }
  | { kind: 'no_source' }

const ZARC_ROWS = (snapshotJson as unknown as { rows: (ZarcWindowRow & { download_date?: string })[] }).rows
const US_WINDOWS = usWindowsJson as unknown as SeasonlessPayload & { retrieved?: string }
const US_STATE = 'North Dakota'

export function cropSlug(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '_')
}

export function positionOf(day: string, start: string, end: string): WindowPosition {
  if (day < start) return 'before'
  return day <= end ? 'inside' : 'after'
}

/** The frontend Evidence has no field id: the response's `fieldId` and context key bind it to the field. */
function windowEvidence(crop: string, start: string, end: string, source: string, asOf: string | null,
  resolution: string, limitations: LimitationCode[]): Evidence {
  return {
    id: `planting.${cropSlug(crop)}.window`, metric: 'planting_window', value: crop, unit: null,
    source, asOf, period: { start, end }, basis: 'retrieved', sourceBasis: 'retrieved', resolution,
    route: 'snapshot', limitations,
  }
}

/** The windows of the field's region for the season of the chosen date, or why there are none. */
export function plantingWindowsFor(context: Pick<FieldContext, 'fieldId' | 'kind' | 'location' | 'regionId' | 'date'>): PlantingWindows {
  if (context.fieldId === null || context.kind !== 'fixture') return { kind: 'no_source' }
  if (context.regionId === 'us') {
    if (!(context.location ?? '').endsWith(US_STATE)) return { kind: 'no_source' }
    const day = context.date.slice(5)
    const windows = seasonlessRows(US_WINDOWS).map((row) => {
      if (!row.startMd || !row.endMd) return { crop: row.crop, start: null, end: null, position: null, evidence: null }
      return {
        crop: row.crop, start: row.startMd, end: row.endMd, position: positionOf(day, row.startMd, row.endMd),
        evidence: windowEvidence(row.crop, row.startMd, row.endMd,
          'NASS, North Dakota Agricultural Statistics 2025, usual planting dates, 20-year average',
          US_WINDOWS.retrieved ?? null, `${US_STATE}, state grain`, ['seasonless_state_average', 'planting_window_not_decision']),
      }
    })
    return { kind: 'us', state: US_STATE, windows }
  }
  const place = parseFieldLocation(context.location)
  if (!place) return { kind: 'no_source' }
  const local = ZARC_ROWS.filter((row) => row.municipality === place.municipality && row.uf === place.uf)
  const season = seasonForDate(context.date)
  const key = seasonKeyFor(season)
  const held = [...new Set(local.map((row) => row.season))].sort()
  if (!held.includes(key)) return { kind: 'season_not_held', season: key, held }
  const rows = calendarRows(local, season)
  const portarias = [...new Set(rows.flatMap((row) => (row.source?.kind === 'season' ? row.source.portaria.split(', ') : [])))]
  const asOf = local.find((row) => row.season === key)?.download_date ?? null
  const windows = rows.map((row) => {
    if (!row.start || !row.end) return { crop: row.crop, start: null, end: null, position: null, evidence: null }
    const portaria = row.source?.kind === 'season' ? row.source.portaria : ''
    return {
      crop: row.crop, start: row.start, end: row.end, position: positionOf(context.date, row.start, row.end),
      evidence: windowEvidence(row.crop, row.start, row.end, `MAPA ZARC, ${portaria}`, asOf,
        `municipality ${place.municipality} (${place.uf})`, ['zarc_municipal_envelope', 'planting_window_not_decision']),
    }
  })
  return { kind: 'br', municipality: place.municipality, uf: place.uf, season: key, windows, portarias: portarias.join(', ') }
}

/** Crop words of a question, as source crop names. `null` when the question names no crop. */
const CROP_WORDS: [RegExp, string[]][] = [
  [/\b(milho|corn|maize)\b/, ['Milho 1ª Safra', 'Milho 2ª Safra', 'Corn']],
  [/\b(soja|soy|soybeans?)\b/, ['Soja', 'Soybeans']],
  [/\b(algodao|cotton)\b/, ['Algodão Herbáceo']],
  [/\b(trigo|wheat)\b/, ['Spring wheat']],
  [/\bcanola\b/, ['Canola']],
]

export function cropsAskedFor(normalisedQuestion: string): { words: string[]; crops: string[] } | null {
  const words: string[] = []
  const crops: string[] = []
  for (const [pattern, names] of CROP_WORDS) {
    const match = normalisedQuestion.match(pattern)
    if (match) {
      words.push(match[1])
      crops.push(...names)
    }
  }
  return crops.length > 0 ? { words, crops } : null
}
