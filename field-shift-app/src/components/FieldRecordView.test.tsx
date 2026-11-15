import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FieldRecordView } from './FieldRecordView'
import { regionAdapter } from '@/lib/regions'
import type { ZarcWindowRow } from '@/lib/planting-calendar'
import { registeredFieldOf, saveField, saveProducer } from '@/lib/producer-store'
import snapshot from '../../artifacts/zarc-mt-snapshot.json'

vi.mock('maplibre-gl', async () => {
  const { MapStub } = await import('@/test/maplibre-stub')
  return { Map: MapStub, NavigationControl: class {}, AttributionControl: class {}, default: { Map: MapStub } }
})

const ROWS = snapshot.rows as unknown as ZarcWindowRow[]
const PLACE = { municipality: 'Santa Carmem', uf: 'MT' }
const REGION = regionAdapter('br')

/** A square in the fixture field's neighbourhood, from the block 7 example ring of Table C. */
const SQUARE: Array<[number, number]> = [
  [-55.285, -11.9],
  [-55.27, -11.9],
  [-55.27, -11.885],
  [-55.285, -11.885],
  [-55.285, -11.9],
]

const CARD_ORDER = [
  'Registered fields',
  'Boundary editor',
  'Declared history',
  'Producer data',
  'Gaps',
]

/**
 * The fields of the store are seeded through the store itself, never by hand: a hand-shaped entry
 * that misses one key is read as `persist.version`, and a fixture that does not pass the gate cannot
 * prove anything about a surface that reads through it.
 */
function seedField(name = 'North Forty'): string {
  const field = registeredFieldOf({ name, ring: SQUARE, source: 'drawn', sourceFile: null })
  const saved = saveField(field)
  if (!('value' in saved)) throw new Error(`seed failed: ${saved.code}`)
  return field.id
}

function storedFields(): Array<Record<string, unknown>> {
  const raw = window.localStorage.getItem('fs.fields.v1')
  return raw === null ? [] : (JSON.parse(raw) as { fields: Array<Record<string, unknown>> }).fields
}

function renderRecord(overrides: Partial<Parameters<typeof FieldRecordView>[0]> = {}) {
  const onSelectField = vi.fn()
  const onFieldDeleted = vi.fn()
  const onChanged = vi.fn()
  const props: Parameters<typeof FieldRecordView>[0] = {
    onClose: () => {},
    regionId: 'br',
    region: REGION,
    chosenDate: '2026-11-12',
    selectedFieldId: null,
    selectedFieldName: null,
    windowRows: ROWS,
    heldSeasons: ['2025/2026', '2026/2027'],
    place: PLACE,
    rotationRows: [],
    onSelectField,
    onFieldDeleted,
    onChanged,
    ...overrides,
  }
  render(<FieldRecordView {...props} />)
  return { onSelectField, onFieldDeleted, onChanged }
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?record=1&region=br')
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('R-35 and R-36, the surface and its five cards (AC-39)', () => {
  it('prints the five cards in the order of the Expected Interface', () => {
    renderRecord()
    const headings = [...document.querySelectorAll('.record-view h3')].map((node) => node.textContent)
    for (const name of CARD_ORDER) expect(headings).toContain(name)
    const indexes = CARD_ORDER.map((name) => headings.indexOf(name))
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  })

  it('carries the surface header with the field, the date and `Back to map`', () => {
    renderRecord({ selectedFieldName: 'North Forty' })
    expect(document.querySelector('.surface-back')?.textContent).toBe('Back to map')
    expect(document.querySelector('.record-view')?.textContent).toContain('North Forty')
  })
})

describe('R-36 and R-40, registering a field (AC-40)', () => {
  const addField = async (user: ReturnType<typeof userEvent.setup>) => {
    const file = new File([JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [SQUARE] } }],
    })], 'north.geojson', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Import boundary'), file)
    await waitFor(() => expect((screen.getByLabelText('Field name') as HTMLInputElement).value).toBe('north'))
  }

  it('registers an imported ring with its area, its provenance and its vertices', async () => {
    const user = userEvent.setup()
    const { onChanged } = renderRecord()
    await addField(user)
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    const fields = storedFields()
    expect(fields).toHaveLength(1)
    expect(fields[0].name).toBe('north')
    expect(fields[0].source).toBe('geojson')
    expect(fields[0].source_file).toBe('north.geojson')
    expect(Number(fields[0].area_ha)).toBeGreaterThan(0)
    expect((fields[0].ring as unknown[]).length).toBe(5)
    expect(fields[0].region).toBe('br')
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open north' })).toBeTruthy()
  })

  it('refuses to save without a name and prints the reason', async () => {
    const user = userEvent.setup()
    renderRecord()
    await addField(user)
    await user.clear(screen.getByLabelText('Field name'))
    await user.click(screen.getByRole('button', { name: 'Save field' }))
    expect(storedFields()).toHaveLength(0)
    expect(document.querySelector('.error-line')?.textContent).toBeTruthy()
  })

  it('refuses a boundary that is not a polygon and writes nothing', async () => {
    const user = userEvent.setup()
    renderRecord()
    const file = new File([JSON.stringify({ type: 'FeatureCollection', features: [] })], 'empty.geojson', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Import boundary'), file)
    expect(storedFields()).toHaveLength(0)
    expect(document.querySelector('.error-line')?.textContent).toBeTruthy()
  })
})

describe('R-42, deleting a registered field (AC-42)', () => {
  it('removes the field, tells the App and clears the selection', async () => {
    const user = userEvent.setup()
    const id = seedField()
    const { onFieldDeleted } = renderRecord({ selectedFieldId: id, selectedFieldName: 'North Forty' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Delete North Forty' }))
    expect(storedFields()).toHaveLength(0)
    expect(onFieldDeleted).toHaveBeenCalledWith(id)
  })
})

describe('R-43, R-44 and R-47, the declared history (AC-43)', () => {

  it('saves a declared season with the entered basis and the edited date', async () => {
    const user = userEvent.setup()
    const id = seedField()
    renderRecord({ selectedFieldId: id, selectedFieldName: 'North Forty' })
    await user.selectOptions(screen.getByLabelText('First crop'), 'Soja')
    await user.type(screen.getByLabelText('First sowing date'), '2026-10-20')
    await user.click(screen.getByRole('button', { name: 'Save season' }))
    const raw = JSON.parse(window.localStorage.getItem('fs.producer.v1') ?? '{}') as { fields: Record<string, { history: Array<Record<string, unknown>> }> }
    const rows = raw.fields[id].history
    expect(rows).toHaveLength(1)
    expect(rows[0].season).toBe('2026/27')
    expect(rows[0].first_crop).toBe('Soja')
    expect(rows[0].first_sowing_date).toBe('2026-10-20')
    expect(rows[0].basis).toBe('entered')
    expect(String(rows[0].edited_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('refuses a sowing date outside the season and prints the rejection', async () => {
    const user = userEvent.setup()
    const id = seedField()
    renderRecord({ selectedFieldId: id, selectedFieldName: 'North Forty' })
    await user.selectOptions(screen.getByLabelText('First crop'), 'Soja')
    await user.type(screen.getByLabelText('First sowing date'), '2020-01-05')
    await user.click(screen.getByRole('button', { name: 'Save season' }))
    const raw = JSON.parse(window.localStorage.getItem('fs.producer.v1') ?? '{}') as { fields?: Record<string, unknown> }
    expect(raw.fields?.[id]).toBeUndefined()
    expect(document.querySelector('.error-line')?.textContent).toBeTruthy()
  })

  it('writes nothing but the two keys of this block and the existing locale key', async () => {
    const user = userEvent.setup()
    const id = seedField()
    renderRecord({ selectedFieldId: id, selectedFieldName: 'North Forty' })
    await user.selectOptions(screen.getByLabelText('First crop'), 'Soja')
    await user.click(screen.getByRole('button', { name: 'Save season' }))
    expect(window.localStorage.length).toBe(2)
    expect(Object.keys({ ...window.localStorage }).every((key) => key === 'fs.fields.v1' || key === 'fs.producer.v1')).toBe(true)
  })
})

describe('R-61 and R-62, the crop list (AC-45)', () => {
  it('offers the union of the crops the window source holds for the field and season', () => {
    const id = seedField('Far Field')
    renderRecord({ selectedFieldId: id, selectedFieldName: 'Far Field' })
    const options = [...screen.getByLabelText('First crop').querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toContain('Soja')
    expect(options).toContain('Milho 1ª Safra')
  })

  it('says which source is missing and refuses to save when no crop can be offered', () => {
    const id = seedField('Far Field')
    renderRecord({ selectedFieldId: id, selectedFieldName: 'Far Field', place: { municipality: 'Nowhere', uf: 'MT' } })
    const options = [...screen.getByLabelText('First crop').querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toEqual(['None'])
    expect((screen.getByRole('button', { name: 'Save season' }) as HTMLButtonElement).disabled).toBe(true)
    const missing = document.querySelectorAll('.surface-empty')
    expect([...missing].some((node) => (node.textContent ?? '').includes('Missing'))).toBe(true)
  })
})

describe('R-56, export and reset (AC-46)', () => {
  it('exports both keys in one bundle and resets them after a confirmation', async () => {
    const user = userEvent.setup()
    const id = seedField()
    saveProducer(id, [], {})
    const created: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:x'
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    renderRecord()
    await user.click(screen.getByRole('button', { name: 'Export producer data' }))
    expect(created).toHaveLength(1)
    const text = await created[0].text()
    const bundle = JSON.parse(text) as { schema_version: number; fields: unknown[]; producer: Record<string, unknown>; exported_at: string }
    expect(bundle.schema_version).toBe(1)
    expect(bundle.fields).toHaveLength(1)
    expect(typeof bundle.exported_at).toBe('string')
    vi.stubGlobal('URL', URL)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Reset producer data' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(storedFields()).toHaveLength(0)
  })
})

describe('R-54, an unreadable store (AC-50)', () => {
  it('reports the version gap and keeps the surface standing', () => {
    window.localStorage.setItem('fs.fields.v1', JSON.stringify({ schema_version: 99, fields: [] }))
    renderRecord()
    const gaps = document.querySelector('.gaps-table')?.textContent ?? ''
    expect(gaps).toContain('fs.fields.v1')
    expect(document.querySelector('.record-view')).toBeTruthy()
  })
})
