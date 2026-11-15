/**
 * Block 7, R-52 to R-56 and Table C: the two local storage keys of the producer's own record.
 *
 * One module owns both keys, their schema version, their shape check and their write order, because
 * R-53 pins the order (producer key first on a field deletion) and R-54 pins that an unreadable key is
 * neither read nor migrated nor rewritten. Every write replaces a whole key in one `setItem` call and
 * happens only when a caller asks for it: nothing here writes on load.
 *
 * A caller supplies the storage object, so a test drives the real code with a fake store and the app
 * passes `localStorage` (R-52's two keys are the only keys this block writes).
 */
import { regionForRing, ringAreaHa, type Ring, type RingPoint } from './field-ring'

/** R-52: the two keys. `fs.locale` in `src/strings/index.ts` is the third key the app already writes. */
export const FIELDS_KEY = 'fs.fields.v1'
export const PRODUCER_KEY = 'fs.producer.v1'

/** R-52 and Table C: the integer this block writes, and the value R-54 refuses to read. */
export const SCHEMA_VERSION = 1

export type FieldSource = 'drawn' | 'geojson' | 'kml'

/** Table C: one registered field, nine keys and no other. */
export type RegisteredField = {
  id: string
  name: string
  ring: Ring
  area_ha: number
  region: 'br' | 'us' | null
  source: FieldSource
  source_file: string | null
  created_at: string
  updated_at: string
}

/** R-43: one declared season, seven keys and no other. */
export type HistoryRow = {
  season: string
  first_crop: string
  second_crop: string | null
  first_sowing_date: string | null
  second_sowing_date: string | null
  basis: 'entered'
  edited_at: string
}

export type ProducerEntry = { history: HistoryRow[] }

export type FieldsRecord = { schema_version: number; fields: RegisteredField[] }
export type ProducerRecord = { schema_version: number; fields: Record<string, ProducerEntry> }

export type StoreCode = 'persist.version' | 'persist.quota'

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreCode }

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type StoreOptions = {
  storage?: StorageLike
  /** Injected so a test pins the timestamps; the app passes nothing and reads the clock. */
  now?: () => string
}

const FIELDS_KEYS = [
  'id',
  'name',
  'ring',
  'area_ha',
  'region',
  'source',
  'source_file',
  'created_at',
  'updated_at',
] as const

const HISTORY_KEYS = [
  'season',
  'first_crop',
  'second_crop',
  'first_sowing_date',
  'second_sowing_date',
  'basis',
  'edited_at',
] as const

function storageOf(options: StoreOptions): StorageLike | null {
  if (options.storage) return options.storage
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

function nowOf(options: StoreOptions): string {
  if (options.now) return options.now()
  return new Date().toISOString()
}

/** R-40: the id form, `local:` plus a lower case UUID version 4. */
export function isLocalFieldId(value: string): boolean {
  return /^local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/** R-40: a fresh id for a saved field. */
export function newFieldId(): string {
  const globalCrypto = typeof crypto === 'undefined' ? undefined : crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return `local:${globalCrypto.randomUUID()}`
  }
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(Math.random() * 16)]
  return `local:${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${'89ab'[Math.floor(Math.random() * 4)]}${out.slice(17, 20)}-${out.slice(20, 32)}`
}

function isRingPoint(value: unknown): value is RingPoint {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
}

/** R-53: a record that does not match Table C is unreadable (V-20), never repaired. */
function isRegisteredField(value: unknown): value is RegisteredField {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const field = value as Record<string, unknown>
  const keys = Object.keys(field)
  if (keys.length !== FIELDS_KEYS.length) return false
  if (!FIELDS_KEYS.every((key) => Object.hasOwn(field, key))) return false
  if (typeof field.id !== 'string' || !isLocalFieldId(field.id)) return false
  if (typeof field.name !== 'string' || field.name.length < 1 || field.name.length > 60) return false
  if (!Array.isArray(field.ring) || field.ring.length < 3 || !field.ring.every(isRingPoint)) return false
  if (typeof field.area_ha !== 'number' || !Number.isFinite(field.area_ha)) return false
  if (!(field.region === 'br' || field.region === 'us' || field.region === null)) return false
  if (!(field.source === 'drawn' || field.source === 'geojson' || field.source === 'kml')) return false
  if (!(field.source_file === null || typeof field.source_file === 'string')) return false
  if (typeof field.created_at !== 'string' || typeof field.updated_at !== 'string') return false
  return true
}

/** R-44: a row with a basis other than `entered`, or a key outside R-43, is unreadable. */
export function isHistoryRow(value: unknown): value is HistoryRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.length !== HISTORY_KEYS.length) return false
  if (!HISTORY_KEYS.every((key) => Object.hasOwn(row, key))) return false
  if (row.basis !== 'entered') return false
  if (typeof row.season !== 'string' || !/^\d{4}\/\d{2}$/.test(row.season)) return false
  if (typeof row.first_crop !== 'string' || row.first_crop === '') return false
  if (!(row.second_crop === null || typeof row.second_crop === 'string')) return false
  if (!(row.first_sowing_date === null || typeof row.first_sowing_date === 'string')) return false
  if (!(row.second_sowing_date === null || typeof row.second_sowing_date === 'string')) return false
  if (typeof row.edited_at !== 'string') return false
  return true
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * R-53 and R-54: read the fields key. A missing key is empty, a key of another version or of the
 * wrong shape is `persist.version` and the raw string stays where it is.
 */
export function loadFields(options: StoreOptions = {}): StoreResult<RegisteredField[]> {
  const storage = storageOf(options)
  if (!storage) return { ok: true, value: [] }
  const raw = storage.getItem(FIELDS_KEY)
  if (raw === null) return { ok: true, value: [] }
  const parsed = parseJson(raw)
  if (parsed === null || typeof parsed !== 'object') return { ok: false, code: 'persist.version' }
  const record = parsed as Record<string, unknown>
  if (record.schema_version !== SCHEMA_VERSION) return { ok: false, code: 'persist.version' }
  const fields = record.fields
  if (!Array.isArray(fields) || !fields.every(isRegisteredField)) return { ok: false, code: 'persist.version' }
  return { ok: true, value: fields as RegisteredField[] }
}

/** R-54: the same gate for the producer key. */
export function loadProducer(options: StoreOptions = {}): StoreResult<Record<string, ProducerEntry>> {
  const storage = storageOf(options)
  if (!storage) return { ok: true, value: {} }
  const raw = storage.getItem(PRODUCER_KEY)
  if (raw === null) return { ok: true, value: {} }
  const parsed = parseJson(raw)
  if (parsed === null || typeof parsed !== 'object') return { ok: false, code: 'persist.version' }
  const record = parsed as Record<string, unknown>
  if (record.schema_version !== SCHEMA_VERSION) return { ok: false, code: 'persist.version' }
  const fields = record.fields
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return { ok: false, code: 'persist.version' }
  const entries: Record<string, ProducerEntry> = {}
  for (const [fieldId, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') return { ok: false, code: 'persist.version' }
    const history = (entry as Record<string, unknown>).history
    if (!Array.isArray(history) || !history.every(isHistoryRow)) return { ok: false, code: 'persist.version' }
    entries[fieldId] = { history: history as HistoryRow[] }
  }
  return { ok: true, value: entries }
}

/** R-53 and R-55: one `setItem` for the whole key, and a quota error leaves the old value intact. */
function write<T>(storage: StorageLike, key: string, record: unknown, value: T): StoreResult<T> {
  try {
    storage.setItem(key, JSON.stringify(record))
  } catch {
    return { ok: false, code: 'persist.quota' }
  }
  return { ok: true, value }
}

/** Table C: the record a candidate becomes, with the area and the region computed from its ring. */
export function registeredFieldOf(input: {
  name: string
  ring: readonly RingPoint[]
  source: FieldSource
  sourceFile?: string | null
  id?: string
  createdAt?: string
  updatedAt?: string
}): RegisteredField {
  const ring = input.ring.map((point) => [point[0], point[1]] as RingPoint)
  const stamp = input.updatedAt ?? new Date().toISOString()
  return {
    id: input.id ?? newFieldId(),
    name: input.name,
    ring,
    area_ha: ringAreaHa(ring),
    region: regionForRing(ring),
    source: input.source,
    source_file: input.sourceFile ?? null,
    created_at: input.createdAt ?? stamp,
    updated_at: stamp,
  }
}

/** R-53: saving a field is one explicit action and writes the whole fields key. */
export function saveField(field: RegisteredField, options: StoreOptions = {}): StoreResult<RegisteredField[]> {
  const storage = storageOf(options)
  if (!storage) return { ok: false, code: 'persist.quota' }
  const current = loadFields(options)
  if (!current.ok) return current
  const others = current.value.filter((entry) => entry.id !== field.id)
  const next = [...others, { ...field, updated_at: nowOf(options) }]
  return write(storage, FIELDS_KEY, { schema_version: SCHEMA_VERSION, fields: next }, next)
}

/** R-53 and R-42: the producer key is written first, so a failed second write leaves no orphan rows. */
export function deleteField(fieldId: string, options: StoreOptions = {}): StoreResult<{ fields: RegisteredField[]; producer: Record<string, ProducerEntry> }> {
  const storage = storageOf(options)
  if (!storage) return { ok: false, code: 'persist.quota' }
  const fieldsResult = loadFields(options)
  if (!('value' in fieldsResult)) return { ok: false, code: fieldsResult.code }
  const producerResult = loadProducer(options)
  if (!('value' in producerResult)) return { ok: false, code: producerResult.code }
  const fields = fieldsResult.value
  const producer = producerResult.value

  const remainingEntries = { ...producer }
  delete remainingEntries[fieldId]
  const producerWrite = write(storage, PRODUCER_KEY, { schema_version: SCHEMA_VERSION, fields: remainingEntries }, remainingEntries)
  if (!('value' in producerWrite)) return { ok: false, code: producerWrite.code }

  const remainingFields = fields.filter((field) => field.id !== fieldId)
  const fieldsWrite = write(storage, FIELDS_KEY, { schema_version: SCHEMA_VERSION, fields: remainingFields }, remainingFields)
  if (!('value' in fieldsWrite)) {
    // R-53: the producer write already landed, so restore it rather than leave rows with no field.
    try {
      storage.setItem(PRODUCER_KEY, JSON.stringify({ schema_version: SCHEMA_VERSION, fields: producer }))
    } catch {
      // Nothing else can be done: the fields key still holds the field and the entry is gone.
    }
    return { ok: false, code: fieldsWrite.code }
  }
  return { ok: true, value: { fields: remainingFields, producer: remainingEntries } }
}

/** R-53: saving one history row writes the whole producer key for that field. */
export function saveProducer(
  fieldId: string,
  history: readonly HistoryRow[],
  options: StoreOptions = {},
): StoreResult<Record<string, ProducerEntry>> {
  const storage = storageOf(options)
  if (!storage) return { ok: false, code: 'persist.quota' }
  const current = loadProducer(options)
  if (!current.ok) return current
  const next = { ...current.value, [fieldId]: { history: [...history] } }
  return write(storage, PRODUCER_KEY, { schema_version: SCHEMA_VERSION, fields: next }, next)
}

/** R-56: the export's file name, dated by the day it was written. */
export function exportFileName(date: string): string {
  return `field-shift-producer-${date.slice(0, 10)}.json`
}

export type ExportBundle = {
  schema_version: number
  exported_at: string
  fields: RegisteredField[]
  producer: Record<string, ProducerEntry>
}

/** R-56: both keys as one document. The values are read through the same gate as the screen. */
export function exportProducer(options: StoreOptions = {}): StoreResult<ExportBundle> {
  const fields = loadFields(options)
  if (!('value' in fields)) return { ok: false, code: fields.code }
  const producer = loadProducer(options)
  if (!('value' in producer)) return { ok: false, code: producer.code }
  return {
    ok: true,
    value: {
      schema_version: SCHEMA_VERSION,
      exported_at: nowOf(options),
      fields: fields.value,
      producer: producer.value,
    },
  }
}

/** R-56: reset empties both keys, after the caller's one confirmation. */
export function resetProducer(options: StoreOptions = {}): StoreResult<true> {
  const storage = storageOf(options)
  if (!storage) return { ok: false, code: 'persist.quota' }
  try {
    storage.setItem(PRODUCER_KEY, JSON.stringify({ schema_version: SCHEMA_VERSION, fields: {} }))
    storage.setItem(FIELDS_KEY, JSON.stringify({ schema_version: SCHEMA_VERSION, fields: [] }))
  } catch {
    return { ok: false, code: 'persist.quota' }
  }
  return { ok: true, value: true }
}

/** Table A, V-14: the name rule, 1 to 60 characters and unique among the registered fields. */
export function nameTaken(name: string, fields: readonly RegisteredField[], exceptId?: string): boolean {
  const needle = name.trim().toLowerCase()
  return fields.some((field) => field.id !== exceptId && field.name.trim().toLowerCase() === needle)
}
