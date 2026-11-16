import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import ReportPage from './ReportPage'
import { STRINGS } from './i18n/strings'

/** The report page renders the Field Phase sections of one county from the real export. */

vi.mock('maplibre-gl', () => ({
  Map: class {
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    on = vi.fn()
    once = vi.fn()
    getSource = vi.fn()
    setFilter = vi.fn()
    setPaintProperty = vi.fn()
    fitBounds = vi.fn()
    flyTo = vi.fn()
    remove = vi.fn()
    isStyleLoaded = () => false
    getCanvas = () => ({ style: {} })
  },
  NavigationControl: class {},
  setWorkerUrl: vi.fn(),
}))

const EXPORT = resolve(__dirname, '../../backend/fixtures/fieldphase/data/v1')
const en = STRINGS.en

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace(/^\/fieldphase\/data\/v1\//, '')
    try {
      const body = JSON.parse(readFileSync(resolve(EXPORT, path), 'utf-8'))
      return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response
    } catch {
      return { ok: false, status: 503, statusText: 'Missing', json: async () => ({}) } as Response
    }
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('report page', () => {
  it('renders ENSO, the rotations of McLean County with their priorities and a table control', async () => {
    render(<ReportPage code={17113} />)
    expect(await screen.findByRole('heading', { level: 2, name: en.sections.enso })).toBeTruthy()
    const rotations = await screen.findByRole('region', { name: new RegExp(en.sections.rotations) })
    await waitFor(() => expect(within(rotations).getAllByText('#1').length).toBeGreaterThan(0))
    for (const priority of Object.values(en.rotations.components)) {
      expect(within(rotations).getAllByText(priority).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByRole('button', { name: /table/i }).length).toBeGreaterThan(0)
  })

  it('opens in English and offers the Portuguese switch inside the page', async () => {
    render(<ReportPage code={17113} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Field Report' })).toBeTruthy()
    const switchGroup = screen.getByRole('group', { name: en.app.language })
    const english = within(switchGroup).getByRole('button', { name: 'EN' })
    expect(english.getAttribute('aria-pressed')).toBe('true')
    expect(within(switchGroup).getByRole('button', { name: 'PT' })).toBeTruthy()
  })

  it('links back to the map at the root and focuses the link first', async () => {
    render(<ReportPage code={17113} />)
    const back = screen.getByRole('link', { name: en.app.backToMap })
    expect(back.getAttribute('href')).toBe('/')
    expect(document.activeElement).toBe(back)
  })
})
