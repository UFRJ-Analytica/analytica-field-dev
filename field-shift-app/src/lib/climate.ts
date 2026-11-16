import { z } from 'zod'

/**
 * The climate fixtures the backend serves from `backend/fixtures/climate/`, written by
 * `field-shift-pipeline/pipeline/export_fieldshift.py`. Every payload is parsed here; a payload
 * that does not match is treated as unavailable rather than half rendered.
 */

const basis = z.enum(['observed', 'retrieved', 'reported', 'modelled', 'entered'])

export const ensoSchema = z.object({
  recorded_at: z.string(),
  basis,
  discussion: z.object({
    issued: z.string(),
    alert_status: z.string(),
    source_url: z.string(),
  }),
  roni: z.object({
    season: z.string(),
    value: z.number(),
    phase: z.string(),
    strength: z.string().nullable(),
    source: z.string(),
  }),
})

export const climateRowSchema = z.object({
  metric: z.string(),
  layer: z.string(),
  value: z.string(),
  number: z.number(),
  unit: z.string(),
  basis,
  as_of: z.string(),
  source: z.string(),
  support: z.string(),
  n_years: z.number().nullable(),
  crop_name_en: z.string().nullable(),
  assumption: z.boolean(),
  small_sample: z.boolean(),
  /** First and last month the row covers; the regions have different seasons. */
  months: z.tuple([z.number(), z.number()]).nullable().optional(),
})

export const fieldClimateSchema = z.object({
  state: z.literal('available'),
  municipality: z.object({ code: z.number(), name_official: z.string(), uf: z.string() }),
  crop_year_label: z.string(),
  season_progress: z.object({
    last_observed: z.string(),
    rain_mm: z.number(),
    normal_mm: z.number(),
    analog_mm: z.number().nullable(),
    n_analog: z.number(),
    analog_years: z.array(z.number()),
    basis,
    source: z.string(),
    start_month: z.number().optional(),
  }),
  rows: z.array(climateRowSchema),
})

export type EnsoState = z.infer<typeof ensoSchema>
export type ClimateRow = z.infer<typeof climateRowSchema>
export type FieldClimate = z.infer<typeof fieldClimateSchema>

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'unavailable' }

/** Fetch and parse; any network, HTTP or shape failure is `unavailable`, never an error. */
export async function loadParsed<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<Loadable<T>> {
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return { status: 'unavailable' }
    const parsed = schema.safeParse(await response.json())
    return parsed.success ? { status: 'ready', data: parsed.data } : { status: 'unavailable' }
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    return { status: 'unavailable' }
  }
}

export function signedCelsius(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} °C`
}
