import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { climateFixture } from '@/test/climate-fixtures'
import { en } from './strings/en'
import App from './App'

/** Climate features measured on the whole screen: failure isolation, pilot fields, the string scan. */

const translationTestState = vi.hoisted(() => ({ useKeys: false }))

vi.mock('@/strings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/strings')>()
  return {
    ...actual,
    t: (key: string, vars?: Record<string, string | number>) =>
      translationTestState.useKeys ? key : actual.t(key, vars),
  }
})

vi.mock('maplibre-gl', () => ({
  Map: class {
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    flyTo = vi.fn()
    fitBounds = vi.fn()
    on = vi.fn()
    once = vi.fn()
    off = vi.fn()
    remove = vi.fn()
    getSource = vi.fn(() => null)
    getLayer = vi.fn(() => null)
    getStyle = vi.fn(() => ({ layers: [] }))
    getZoom = vi.fn(() => 11)
    getCenter = vi.fn(() => ({ lng: -97.17, lat: 46.93 }))
    getCanvas = () => ({ style: {} as { cursor?: string } })
    isStyleLoaded = () => false
    setFilter = vi.fn()
    setPaintProperty = vi.fn()
    setLayoutProperty = vi.fn()
    setFeatureState = vi.fn()
    removeFeatureState = vi.fn()
    removeControl = vi.fn()
    queryRenderedFeatures = vi.fn(() => [])
  },
  NavigationControl: class {},
  AttributionControl: class {
    options: unknown
    constructor(options?: unknown) { this.options = options }
    onAdd() { return {} }
    onRemove() {}
  },
  addProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
}))

type PilotFields = { fields: Array<Record<string, unknown>> }
const pilot = climateFixture<PilotFields>('pilot-fields.json').fields.map(({ scenarios: _scenarios, ...field }) => field)
const cass = {
  id: '381825001868504',
  name: 'Cass Field 01',
  location: 'Cass County, North Dakota',
  coast: undefined,
  coverage: 86,
  center: [-97.17, 46.93],
  boundary: { type: 'Polygon', coordinates: [[[-97.18, 46.92], [-97.16, 46.92], [-97.16, 46.94], [-97.18, 46.94], [-97.18, 46.92]]] },
}
const fields = [cass, ...pilot]
const climateByCode: Record<number, string> = {
  17113: 'municipality-17113.json',
  48303: 'municipality-48303.json',
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const FIELDPHASE_EXPORT = resolve(__dirname, '../backend/fixtures/fieldphase/data/v1')

function mockApi({ ensoFails = false, climateFails = false } = {}) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path.startsWith('/fieldphase/data/v1/')) {
      return ok(JSON.parse(readFileSync(resolve(FIELDPHASE_EXPORT, path.slice('/fieldphase/data/v1/'.length)), 'utf-8')))
    }
    if (path === '/layers') return ok({ chosen_date: '2026-11-12', axis: { start: '2015-04-01', end: '2026-11-14', default: '2026-11-14' }, layers: [] })
    if (path === '/fields') return ok({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' })
    if (path === '/climate/enso') {
      if (ensoFails) return { ok: false, status: 503, json: async () => ({}) } as Response
      return ok(climateFixture('enso.json'))
    }
    const [, , fieldId, resource] = path.split('/')
    const field = fields.find((entry) => entry.id === fieldId) as Record<string, unknown> | undefined
    if (resource === 'climate') {
      if (climateFails) throw new TypeError('Failed to fetch')
      const code = field?.municipality_code as number | undefined
      // A fixture field has no county, so the route answers not available, exactly as the backend does.
      if (code === undefined) return ok({ field_id: fieldId, state: 'not_available', municipality: null, season_progress: null, rows: [] })
      return ok({ field_id: fieldId, state: 'available', ...climateFixture<Record<string, unknown>>(climateByCode[code]) })
    }
    const coverage = field?.coverage as number | null
    return ok({
      field_id: fieldId,
      season: '2025/26',
      state: coverage === null ? 'abstained' : 'ranked',
      threshold: coverage === null ? 'coverage_not_measured' : null,
      coverage,
      scenarios: [],
    })
  }))
}

beforeEach(() => {
  usePanelStore.setState({ open: null })
  window.history.replaceState({}, '', '/')
  useMapStore.setState({ regionId: 'us', selectedFieldId: null })
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  translationTestState.useKeys = false
  useMapStore.setState({ selectedFieldId: null })
})

async function openFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Fields' }))
  return waitFor(() => {
    const row = document.getElementById('fields-chip-row')
    expect(row).toBeTruthy()
    return row as HTMLElement
  })
}

describe('climate, pilot fields and the report control on the whole screen', () => {
  it('a failing ENSO endpoint shows the literal and leaves the field list working', async () => {
    mockApi({ ensoFails: true })
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByText('ENSO unavailable')).toBeTruthy()
    const row = await openFields(user)
    expect(within(row).getByRole('button', { name: /Cass Field 01/ })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failing climate request prints one literal and nothing else changes', async () => {
    mockApi({ climateFails: true })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Data Info' }))
    useMapStore.setState({ selectedFieldId: '381825001868504' })
    expect(await screen.findByText('Climate signal unavailable')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lists the two pilots and links the report control to the county page of the pilot selected', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)
    const row = await openFields(user)
    expect(await within(row).findByRole('button', { name: /Field 06/ })).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Field 07/ })).toBeTruthy()

    // A fixture without a county keeps the control disabled, with the reason in its name.
    await waitFor(() => expect(document.querySelector('[data-report-toggle]')).toBeTruthy())
    const disabled = document.querySelector('[data-report-toggle]') as HTMLElement
    expect(disabled.getAttribute('aria-label')).toMatch(/select a pilot field with report data/)

    await user.click(within(row).getByRole('button', { name: /Field 06/ }))
    await waitFor(() => {
      const control = document.querySelector('[data-report-toggle]') as HTMLAnchorElement
      expect(control.getAttribute('href')).toBe('/report/17113')
      expect(control.getAttribute('target')).toBe('_blank')
    })
  })

  it('every new visible string and accessible name comes from the catalog', async () => {
    mockApi()
    translationTestState.useKeys = true
    useMapStore.setState({ selectedFieldId: 'il-mclean-01' })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(document.querySelector('.enso-chip[role="group"]')).toBeTruthy())
    await user.click(await screen.findByRole('button', { name: 'evidence.supporting_data' }))
    await waitFor(() => expect(document.querySelector('.climate-signal')).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.climate-evidence')).toBeTruthy())

    const catalogKeys = new Set(Object.keys(en))
    const unknown: string[] = []
    const literals: string[] = []
    const inspect = (text: string) => {
      if (/^[a-z][a-z0-9_-]*\.[a-zA-Z0-9_.-]+$/.test(text)) {
        if (!catalogKeys.has(text)) unknown.push(text)
        return
      }
      if (/^(?:\d+(?:\.\d+)?%?|\d+(?:\.\d+)?\s*[A-Za-z³⁄/%]+|\d{4}[-/]\d{2}(?:[-/]\d{2})?|https?:\/\/\S+|GM|[·/]+|\d+)$/.test(text)) return
      literals.push(text)
    }
    for (const node of document.querySelectorAll('.climate-signal *, .climate-evidence *, .enso-chip *')) {
      if (node.closest('[data-dynamic-content]')) continue
      for (const child of node.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE) continue
        const text = child.textContent?.trim()
        if (text) inspect(text)
      }
    }
    for (const node of document.querySelectorAll('.climate-signal [aria-label], .climate-signal[aria-label], .climate-evidence[aria-label], .enso-chip[aria-label]')) {
      const text = node.getAttribute('aria-label')?.trim()
      if (text) inspect(text)
    }
    expect(unknown).toEqual([])
    expect(literals).toEqual([])
  })
})
