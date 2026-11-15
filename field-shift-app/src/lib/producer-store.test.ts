import { describe, expect, it } from 'vitest'
import {
  FIELDS_KEY,
  PRODUCER_KEY,
  deleteField,
  exportFileName,
  exportProducer,
  isLocalFieldId,
  loadFields,
  loadProducer,
  nameTaken,
  newFieldId,
  registeredFieldOf,
  resetProducer,
  saveField,
  saveProducer,
  type HistoryRow,
  type StorageLike,
} from './producer-store'

/** A storage that records every write, and can refuse one key the way a full quota does. */
class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>()
  readonly writes: Array<{ key: string; value: string }> = []
  refuse: string | null = null

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    if (this.refuse === key) throw new Error('QuotaExceededError')
    this.data.set(key, value)
    this.writes.push({ key, value })
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }
}

const RING: Array<[number, number]> = [
  [-55.285, -11.9],
  [-55.26, -11.9],
  [-55.26, -11.92],
  [-55.285, -11.92],
  [-55.285, -11.9],
]

const ROW: HistoryRow = {
  season: '2025/26',
  first_crop: 'Soja',
  second_crop: 'Milho 1ª Safra',
  first_sowing_date: '2025-10-20',
  second_sowing_date: null,
  basis: 'entered',
  edited_at: '2026-11-14T20:13:00Z',
}

function fieldOf(name = 'North block', id?: string) {
  return registeredFieldOf({
    name,
    ring: RING,
    source: 'drawn',
    id,
    createdAt: '2026-11-14T20:10:00Z',
    updatedAt: '2026-11-14T20:10:00Z',
  })
}

describe('Table C, the registered field record (R-40, AC-36)', () => {
  it('carries the nine keys, the area of the formula and the region of the extent test', () => {
    const field = fieldOf()
    expect(Object.keys(field).sort()).toEqual([
      'area_ha', 'created_at', 'id', 'name', 'region', 'ring', 'source', 'source_file', 'updated_at',
    ])
    expect(field.area_ha).toBeCloseTo(606.2633, 3)
    expect(field.region).toBe('br')
    expect(field.source).toBe('drawn')
    expect(field.source_file).toBeNull()
    expect(isLocalFieldId(field.id)).toBe(true)
  })

  it('accepts a ring outside both extents with a null region', () => {
    const field = registeredFieldOf({ name: 'Elsewhere', ring: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]], source: 'geojson', sourceFile: 'x.geojson' })
    expect(field.region).toBeNull()
    expect(field.source_file).toBe('x.geojson')
  })

  it('mints a lower case UUID version 4 after the local prefix', () => {
    expect(newFieldId()).toMatch(/^local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('the two keys, the version gate and the write order (R-52 to R-55, AC-46, AC-47)', () => {
  it('writes only fs.fields.v1 with schema_version 1 when a field is saved', () => {
    const storage = new FakeStorage()
    const result = saveField(fieldOf(), { storage })
    expect(result.ok).toBe(true)
    expect(storage.writes).toHaveLength(1)
    expect(storage.writes[0].key).toBe(FIELDS_KEY)
    expect(JSON.parse(storage.writes[0].value).schema_version).toBe(1)
  })

  it('reads an empty store as empty and never writes on load', () => {
    const storage = new FakeStorage()
    expect(loadFields({ storage })).toEqual({ ok: true, value: [] })
    expect(loadProducer({ storage })).toEqual({ ok: true, value: {} })
    expect(storage.writes).toHaveLength(0)
  })

  it('refuses a key of another version with persist.version and leaves the raw string in place', () => {
    const storage = new FakeStorage()
    const raw = JSON.stringify({ schema_version: 2, fields: [] })
    storage.data.set(FIELDS_KEY, raw)
    expect(loadFields({ storage })).toEqual({ ok: false, code: 'persist.version' })
    expect(storage.getItem(FIELDS_KEY)).toBe(raw)
    expect(storage.writes).toHaveLength(0)
  })

  it('refuses a record of the wrong shape with persist.version', () => {
    const storage = new FakeStorage()
    storage.data.set(FIELDS_KEY, JSON.stringify({ schema_version: 1, fields: [{ id: 'local:nope' }] }))
    expect(loadFields({ storage })).toEqual({ ok: false, code: 'persist.version' })
    storage.data.set(PRODUCER_KEY, JSON.stringify({ schema_version: 1, fields: { a: { history: [{ season: '2025/26' }] } } }))
    expect(loadProducer({ storage })).toEqual({ ok: false, code: 'persist.version' })
  })

  it('refuses a history row whose basis is not entered (R-44, AC-39)', () => {
    const storage = new FakeStorage()
    const row = { ...ROW, basis: 'modelled' }
    storage.data.set(PRODUCER_KEY, JSON.stringify({ schema_version: 1, fields: { 'local:x': { history: [row] } } }))
    expect(loadProducer({ storage })).toEqual({ ok: false, code: 'persist.version' })
  })

  it('refuses a history row with a key outside R-43', () => {
    const storage = new FakeStorage()
    const row = { ...ROW, tillage: 'no_till' }
    storage.data.set(PRODUCER_KEY, JSON.stringify({ schema_version: 1, fields: { 'local:x': { history: [row] } } }))
    expect(loadProducer({ storage })).toEqual({ ok: false, code: 'persist.version' })
  })

  it('writes the producer key before the fields key when a field is deleted (R-53)', () => {
    const storage = new FakeStorage()
    const field = fieldOf('North block', 'local:8f14e45f-ceea-467f-a4c6-1e6b0c2b0c11')
    saveField(field, { storage })
    saveProducer(field.id, [ROW], { storage })
    storage.writes.length = 0
    const result = deleteField(field.id, { storage })
    expect(result.ok).toBe(true)
    expect(storage.writes.map((write) => write.key)).toEqual([PRODUCER_KEY, FIELDS_KEY])
    expect(loadFields({ storage })).toEqual({ ok: true, value: [] })
    expect(loadProducer({ storage })).toEqual({ ok: true, value: {} })
  })

  it('leaves the previous value intact when the write is refused (R-55, AC-48)', () => {
    const storage = new FakeStorage()
    const field = fieldOf('North block', 'local:8f14e45f-ceea-467f-a4c6-1e6b0c2b0c11')
    saveField(field, { storage })
    const before = storage.getItem(FIELDS_KEY)
    storage.refuse = FIELDS_KEY
    const result = saveField(fieldOf('Other block'), { storage })
    expect(result).toEqual({ ok: false, code: 'persist.quota' })
    expect(storage.getItem(FIELDS_KEY)).toBe(before)
  })

  it('exports both keys with every field key and the export date (R-56, AC-49)', () => {
    const storage = new FakeStorage()
    const field = fieldOf('North block', 'local:8f14e45f-ceea-467f-a4c6-1e6b0c2b0c11')
    saveField(field, { storage })
    saveProducer(field.id, [ROW], { storage })
    const bundle = exportProducer({ storage, now: () => '2026-11-15T02:00:00Z' })
    expect(bundle.ok).toBe(true)
    if (!bundle.ok) return
    expect(bundle.value.schema_version).toBe(1)
    expect(bundle.value.fields[0].created_at).toBe('2026-11-14T20:10:00Z')
    expect(bundle.value.producer[field.id].history).toHaveLength(1)
    expect(exportFileName('2026-11-15T02:00:00Z')).toBe('field-shift-producer-2026-11-15.json')
  })

  it('empties both keys on reset', () => {
    const storage = new FakeStorage()
    saveField(fieldOf(), { storage })
    resetProducer({ storage })
    expect(loadFields({ storage })).toEqual({ ok: true, value: [] })
    expect(loadProducer({ storage })).toEqual({ ok: true, value: {} })
  })
})

describe('the name rule of Table A (V-14)', () => {
  it('treats a name as taken, case aside, and never as taken by itself', () => {
    const field = fieldOf('North block')
    expect(nameTaken('north BLOCK', [field])).toBe(true)
    expect(nameTaken('North block', [field], field.id)).toBe(false)
    expect(nameTaken('South block', [field])).toBe(false)
  })
})
