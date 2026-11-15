import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { en } from './strings/en'
import { layersResponse } from '@/test/api-fixtures'
import App, { ZOrder } from './App'

function scanVisibleUi(root: ParentNode) {
  const catalogKeys = new Set(Object.keys(en))
  const literalStrings = new Set<string>()
  const missingTranslationKeys = new Set<string>()
  const inspect = (text: string) => {
    if (/^[a-z][a-z0-9_-]*\.[a-zA-Z0-9_.-]+$/.test(text)) {
      if (!catalogKeys.has(text)) missingTranslationKeys.add(text)
      return
    }
    if (/^(?:\d+(?:\.\d+)?%?|\d+(?:\.\d+)?\s+km|\d+(?:\.\d+)?\s*[A-Za-z³⁄/%]+(?:\/[A-Za-z³⁄%]+)*|\d{4}[-/]\d{2}(?:[-/]\d{2})?|https?:\/\/\S+|GM|[·/]+|%|\{\}|\d+)$/.test(text)) return
    literalStrings.add(text)
  }

  for (const node of root.querySelectorAll('.app-shell *')) {
    if (node.closest('[data-dynamic-content]')) continue
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue
      const text = child.textContent?.trim()
      if (text) inspect(text)
    }
  }
  for (const node of root.querySelectorAll('.app-shell [aria-label], .app-shell [placeholder], .app-shell [title]')) {
    if (node.closest('[data-dynamic-content]')) continue
    for (const attribute of ['aria-label', 'placeholder', 'title']) {
      const text = node.getAttribute(attribute)?.trim()
      if (text) inspect(text)
    }
  }

  return { literalStrings: [...literalStrings], missingTranslationKeys: [...missingTranslationKeys] }
}

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
    on = vi.fn()
    remove = vi.fn()
    getSource = vi.fn(() => null)
    getLayer = vi.fn(() => null)
    getStyle = vi.fn(() => ({ layers: [] }))
    getZoom = vi.fn(() => 11)
    getCenter = vi.fn(() => ({ lng: -55.27, lat: -11.91 }))
    getCanvas = () => ({ style: {} as { cursor?: string } })
    setPaintProperty = vi.fn()
    setLayoutProperty = vi.fn()
    setFeatureState = vi.fn()
    removeFeatureState = vi.fn()
    removeControl = vi.fn()
    queryRenderedFeatures = vi.fn(() => [])
    off = vi.fn()
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

const fields = [
  {
    id: 'mt-santa-carmem-01',
    name: 'Santa Carmem North',
    location: 'Santa Carmem, Mato Grosso',
    coverage: 86,
    center: [-55.27, -11.91] as [number, number],
    boundary: { type: 'Polygon' as const, coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
  },
  {
    id: 'mt-santa-carmem-03',
    name: 'Santa Carmem South',
    location: 'Santa Carmem, Mato Grosso',
    coverage: 62,
    center: [-55.21, -11.97] as [number, number],
    boundary: { type: 'Polygon' as const, coordinates: [[[-55.225, -11.96], [-55.2, -11.96], [-55.2, -11.98], [-55.225, -11.98], [-55.225, -11.96]]] },
  },
]

const scenarios = {
  field_id: 'mt-santa-carmem-01',
  season: '2025/26',
  state: 'ranked',
  threshold: null,
  scenarios: [
    { id: 'current', name: 'Current sequence', is_current: true, crops: ['Soybean', 'Corn'], why: 'Current farm plan', evidence: 'Three supported seasons', benefit: 'Known operating fit', gap: 'No input-cost data', risk: 'Weather variability', evidence_rows: [{ layer: 'SMAP soil moisture', value: '0.28 m³/m³', basis: 'retrieved' as const, as_of: '2025-11-10', source: 'https://example.com/smap' }] },
    { id: 'rotation-a', name: 'Soybean → Corn', is_current: false, crops: ['Soybean', 'Corn'], why: 'Alternates crop families', evidence: 'SMAP soil moisture', benefit: 'Diversifies rotation', gap: 'Market access unknown', risk: 'Dry-season stress', evidence_rows: [] },
    { id: 'rotation-b', name: 'Soybean → Cotton', is_current: false, crops: ['Soybean', 'Cotton'], why: 'Adds a fiber crop', evidence: 'Three supported seasons', benefit: 'Additional outlet', gap: 'Credit terms unknown', risk: 'Higher input demand', evidence_rows: [] },
  ],
}

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (new URL(url).pathname === '/layers') {
      return { ok: true, status: 200, json: async () => layersResponse() } as Response
    }
    if (url.endsWith('/fields')) {
      return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
    }
    const fieldId = new URL(url).pathname.split('/')[2]
    const abstained = fieldId === 'mt-santa-carmem-03'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...scenarios,
        field_id: fieldId,
        state: abstained ? 'abstained' : 'ranked',
        threshold: abstained ? 'coverage_below_80_percent' : null,
        coverage: abstained ? 62 : 86,
      }),
    } as Response
  }))
}

beforeEach(() => {
  usePanelStore.setState({ open: 'rotation' })
  // Block 5 makes the United States the default region (R-01) and lists only the active
  // region's fixtures (R-24, AM-10). These block 1 to 4 cases exercise the Brazil fixtures,
  // so they run with Brazil active, which `?region=` is the only way to choose.
  window.history.replaceState({}, '', '/?region=br')
  useMapStore.setState({ regionId: 'br', selectedFieldId: null, chosenDate: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  translationTestState.useKeys = false
  window.localStorage.removeItem('fs.locale')
  useMapStore.setState({ selectedFieldId: null, chosenDate: null, regionId: 'us', selectedPolygonId: null })
  window.history.replaceState({}, '', '/')
})

describe('field map and rotation scenario selection', () => {
  async function expandFields(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Fields' }))
    return await waitFor(() => {
      const row = document.getElementById('fields-chip-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
  }

  it('scans rendered interface text for untranslated literals when t returns keys', async () => {
    translationTestState.useKeys = true
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'fields.trigger' }))
    const row = await waitFor(() => {
      const found = document.getElementById('fields-chip-row')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    await user.click(within(row).getByRole('button', { name: 'map.field.mt-santa-carmem-03' }))
    await waitFor(() => expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(3))
    await user.click(screen.getByRole('button', { name: 'agent.command' }))
    await user.click(screen.getByRole('button', { name: 'evidence.supporting_data' }))
    const { literalStrings, missingTranslationKeys } = scanVisibleUi(document)
    expect(missingTranslationKeys).toEqual([])
    expect(literalStrings).toEqual([])
  })

  it('renders the Field map region at the root route', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Field map' })).toBeTruthy()
  })

  it('renders top chips without panel surface classes', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByText('FIELD INTELLIGENCE')).toBeTruthy()
    const chips = document.querySelectorAll('.top-chip')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect([...chip.classList].some((className) => /surface/i.test(className))).toBe(false)
    }
  })

  it('renders the fullscreen map behind pointer-transparent overlay anchors', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(document.querySelector('.map-panel .map-canvas')).toBeTruthy()

    const overlays = document.querySelectorAll('.app-shell > .overlay')
    expect(overlays.length).toBeGreaterThan(0)
    for (const overlay of overlays) {
      expect(overlay.classList.contains('overlay')).toBe(true)
      const interactiveChild = overlay.querySelector('.overlay-interactive')
      expect(interactiveChild?.classList.contains('overlay-interactive')).toBe(true)
    }
    // A fresh load now always selects the first field, so the list settles on its three
    // rotation cards instead of the old one-child "select a field" empty state.
    await waitFor(() => expect(document.querySelectorAll('.scenario-list .scenario-card[role="option"]')).toHaveLength(3))
  })

  it('keeps the block 3 anchors and the fixed layer sequence', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: /Santa Carmem South/ }))
    await screen.findByRole('status')

    const anchors = [
      '.anchor-top-left',
      '.anchor-left.field-list-anchor',
      '.anchor-top-right',
      '.anchor-notice',
      '.anchor-bottom-left',
      '.layer-rail-anchor',
    ]
    for (const anchor of anchors) expect(document.querySelector(anchor)).toBeTruthy()
    expect(anchors).toHaveLength(6)
    // AM-11: the constraints panel is withdrawn, so its anchor must not exist.
    expect(document.querySelector('.anchor-constraints')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Command' }))
    await user.click(screen.getByRole('button', { name: 'Supporting data' }))
    expect(document.querySelector('.anchor-right-column')).toBeTruthy()

    const layers = [
      ['.layer-agent', ZOrder.agentBar],
      ['.layer-controls', ZOrder.controlStrip],
      ['.layer-cards', ZOrder.scenarioCards],
      ['.layer-notice', ZOrder.abstentionNotice],
      ['.layer-evidence', ZOrder.evidence],
      ['.layer-rail-anchor', ZOrder.layerRail],
      ['.layer-chips', ZOrder.chips],
    ] as const
    const zIndices = layers.map(([selector, zIndex]) => {
      const element = document.querySelector<HTMLElement>(selector)
      expect(element).toBeTruthy()
      expect(element?.style.zIndex).toBe(String(zIndex))
      return zIndex
    })
    expect(zIndices).toEqual([...zIndices].sort((a, b) => b - a))

    const panels = document.querySelectorAll('.panel-surface')
    expect(panels.length).toBeGreaterThanOrEqual(5)
    for (const chip of document.querySelectorAll('.top-chip')) {
      expect(chip.classList.contains('panel-surface')).toBe(false)
    }
  })

  it('does not repeat the empty reason as both evidence title and subtitle', async () => {
    // Evidence is empty when the field's scenarios carry no evidence rows. The panel
    // must then show the empty title and the reason as its subtitle, not twice.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (new URL(url).pathname === '/layers') {
        return { ok: true, status: 200, json: async () => layersResponse() } as Response
      }
      if (url.endsWith('/fields')) {
        return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
      }
      const fieldId = new URL(url).pathname.split('/')[2]
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...scenarios,
          field_id: fieldId,
          scenarios: scenarios.scenarios.map((scenario) => ({ ...scenario, evidence_rows: [] })),
        }),
      } as Response
    }))
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Supporting data' }))
    const evidence = await screen.findByRole('region', { name: 'Evidence' })
    await waitFor(() => expect(evidence.querySelector('[data-slot="empty-title"]')).toBeTruthy())
    expect(evidence.querySelector('[data-slot="empty-title"]')?.textContent)
      .not.toBe(evidence.querySelector('[data-slot="empty-description"]')?.textContent)
  })

  it('shows the server abstention threshold for field 03, keeps all cards, and hides ranking markers', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: /Santa Carmem South/ }))

    expect((await screen.findByRole('status')).textContent).toContain('Ranking withheld: coverage below 80%.')
    const list = screen.getByRole('list', { name: 'Rotation scenarios' })
    expect(within(list).getAllByRole('option')).toHaveLength(3)
    expect(within(list).queryByText(/#\s*\d+/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Supporting data' }))
    expect(within(screen.getByRole('region', { name: 'Evidence' })).getByRole('row', { name: /SMAP soil moisture/ }).textContent).toContain('retrieved')
  })

  it('does not show an abstention notice for ranked field 01', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: /Santa Carmem North/ }))

    await screen.findByRole('list', { name: 'Rotation scenarios' })
    expect(screen.queryByRole('status')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Supporting data' }))
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
  })

  it('requests scenarios without a season and keeps the fixture values when the date changes (R-30)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    const scenarioRequest = 'http://localhost:8000/fields/mt-santa-carmem-01/scenarios'
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toContain(scenarioRequest)

    const before = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/scenarios')).length
    fireEvent.change(screen.getByLabelText('Go to date'), { target: { value: '2026-11-12' } })
    const note = await screen.findByText('Fixture data for 2025/26, not for 2026/27')
    expect(note).toBeTruthy()
    expect(screen.getByText('0.28 m³/m³')).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/scenarios'))).toHaveLength(before)
  })

  it('keeps the unconditional pairs mounted and retries only the field list after an HTTP error', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === '/layers') {
        return { ok: true, status: 200, json: async () => layersResponse() } as Response
      }
      if (new URL(String(input)).pathname === '/fields') {
        if (fetchMock.mock.calls.filter(([request]) => new URL(String(request)).pathname === '/fields').length === 1) {
          return { ok: false, status: 500, json: async () => ({}) } as Response
        }
        return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findAllByText('Backend request failed (HTTP 500). Retry when it is available.')).not.toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Layers' })).toBeTruthy()
    // Block 5.5 B5: with nothing selected the rotation button is disabled and its panel does not
    // mount, so the cards are absent while the control is still on the strip.
    expect(screen.getAllByRole('button', { name: /Rotation outlook/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Season' })).toBeNull()
    expect(document.querySelector('select')).toBeNull()
    expect(screen.getByRole('button', { name: 'Command' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Supporting data' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()

    const satellitePreset = screen.getByRole('button', { name: 'Satellite', pressed: false })
    await user.click(satellitePreset)
    expect(screen.getByRole('button', { name: 'Satellite', pressed: true })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Fields' }))
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Santa Carmem North/ })).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/layers')).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/fields')).toHaveLength(2)
  })

  it('renders a translated backend-unreachable reason when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<App />)

    expect(await screen.findAllByText('Backend is unreachable. Check your connection and retry.')).not.toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rotation outlook/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Supporting data' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
  })

  it('runs a registered agent command and reports an unregistered name', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Command' }))
    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
    const commandInput = screen.getByRole('textbox', { name: 'Command name' })
    const argumentsInput = screen.getByRole('textbox', { name: 'JSON arguments' })
    await user.type(commandInput, 'set_composition')
    await fireEvent.change(argumentsInput, { target: { value: '{"preset":"satellite"}' } })
    await user.click(screen.getByRole('button', { name: 'Run command' }))
    expect(useMapStore.getState().composition).toBe('satellite')

    await user.clear(commandInput)
    await user.type(commandInput, 'unknown_command')
    await user.click(screen.getByRole('button', { name: 'Run command' }))
    expect(screen.getByRole('alert').textContent).toMatch(/select_field.*set_composition.*open_panel.*apply_filter/)
  })
})

describe('block 3 wave 1: toggles and the single coverage readout', () => {
  async function expandFields(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Fields' }))
    return await waitFor(() => {
      const row = document.getElementById('fields-chip-row')
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
  }

  it('mounts the agent command form only while Command is open (R-01, AC-02)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const command = await screen.findByRole('button', { name: 'Command' })
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(command.getAttribute('aria-controls')).toBeNull()

    await user.click(command)
    const form = screen.getByRole('form', { name: 'Agent command' })
    expect(command.getAttribute('aria-expanded')).toBe('true')
    expect(command.getAttribute('aria-controls')).toBe(form.id)

    await user.click(command)
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(command.getAttribute('aria-controls')).toBeNull()
  })

  it('moves focus into the command form, returns it on close and keeps the draft (AC-03)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const command = await screen.findByRole('button', { name: 'Command' })
    await user.click(command)
    const nameInput = screen.getByRole('textbox', { name: 'Command name' })
    expect(document.activeElement).toBe(nameInput)
    await user.type(nameInput, 'set_composition')
    const jsonInput = screen.getByRole('textbox', { name: 'JSON arguments' })
    await fireEvent.change(jsonInput, { target: { value: '{"preset":"satellite"}' } })

    await user.click(command)
    expect(document.activeElement).toBe(command)
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()

    await user.click(command)
    expect((screen.getByRole('textbox', { name: 'Command name' }) as HTMLInputElement).value).toBe('set_composition')
    expect((screen.getByRole('textbox', { name: 'JSON arguments' }) as HTMLInputElement).value).toBe('{"preset":"satellite"}')
  })

  it('wraps the field list in the vendored collapsible (AC-04)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole('button', { name: 'Fields' })
    const row = document.getElementById('fields-chip-row')
    expect(row).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe('fields-chip-row')
    expect(document.querySelector('[data-slot="collapsible-panel"]')).toBeNull()

    await user.click(trigger)
    const panel = await waitFor(() => {
      const found = document.querySelector('[data-slot="collapsible-panel"]')
      expect(found).toBeTruthy()
      return found as Element
    })
    expect(row?.contains(panel)).toBe(true)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))

    await user.click(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.querySelector('[data-slot="collapsible-panel"]')).toBeNull()
  })

  it('shows one collapsed chip for the selected field and no percentage (AC-05)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole('button', { name: 'Fields' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // AC-05: the collapsed header shows exactly one chip for the selected field and no
    // percentage. A fresh load always selects the first field now, so that chip exists
    // before any click instead of depending on when the map happened to load.
    await waitFor(() => expect(document.querySelectorAll('.field-chip')).toHaveLength(1))
    expect(document.querySelector('.field-chip')?.textContent).toBe('Santa Carmem North')

    const row = await expandFields(user)
    const rowChips = within(row).getAllByRole('button')
    expect(rowChips).toHaveLength(2)
    for (const chip of rowChips) expect(chip.textContent).not.toContain('%')

    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    await user.click(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))

    const header = document.querySelector('.fields-header')
    const northChips = header?.querySelectorAll('button.field-chip') ?? []
    expect(northChips).toHaveLength(1)
    expect(northChips[0].textContent).toBe('Santa Carmem North')

    await user.click(trigger)
    await user.click(within(await waitFor(() => {
      const expanded = document.getElementById('fields-chip-row')
      expect(expanded).toBeTruthy()
      return expanded as HTMLElement
    })).getByRole('button', { name: 'Santa Carmem South' }))
    await screen.findByRole('status')
    await user.click(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))

    const southChips = document.querySelector('.fields-header')?.querySelectorAll('button.field-chip') ?? []
    expect(southChips).toHaveLength(1)
    expect(southChips[0].textContent).toBe('Santa Carmem South')
    expect(southChips[0].textContent).not.toContain('%')
    expect(document.querySelector('.field-list-anchor')?.textContent).not.toContain('%')
  })

  it('renders no chip while the field list is loading with nothing selected (AC-05)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<App />)

    expect(screen.getByRole('button', { name: 'Fields' })).toBeTruthy()
    expect(document.querySelectorAll('.field-chip')).toHaveLength(0)
    expect(document.querySelector('.field-list-anchor')?.textContent).not.toContain('%')
  })

  it('keeps the selected field and issues no new scenario request when the panel collapses or expands (AC-06)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole('button', { name: 'Fields' })
    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    const scenarioRequestCount = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).includes('/scenarios')).length
    const before = scenarioRequestCount()
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01')

    await user.click(trigger)
    await user.click(trigger)

    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01')
    expect(scenarioRequestCount()).toBe(before)

    await user.click(trigger)
    const collapsedChip = await waitFor(() => {
      const chip = document.querySelector('.fields-header button.field-chip')
      expect(chip).toBeTruthy()
      return chip as HTMLElement
    })
    await user.click(collapsedChip)
    const list = screen.getByRole('list', { name: 'Rotation scenarios' })
    expect(within(list).getAllByRole('option')).toHaveLength(3)
    expect(scenarioRequestCount()).toBe(before)
  })

  it('keeps the four unconditional pairs at first paint and mounts Evidence only while Supporting data is open (AC-14, AC-21)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Field map' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Layers' })).toBeTruthy()
    // Block 5.5 B5: with nothing selected the rotation button is disabled and its panel does not
    // mount, so the cards are absent while the control is still on the strip.
    expect(screen.getAllByRole('button', { name: /Rotation outlook/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Season' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })

    const supportingData = screen.getByRole('button', { name: 'Supporting data' })
    expect(supportingData.getAttribute('aria-expanded')).toBe('false')
    await user.click(supportingData)

    const evidence = await screen.findByRole('region', { name: 'Evidence' })
    expect(supportingData.getAttribute('aria-expanded')).toBe('true')
    expect(supportingData.getAttribute('aria-controls')).toBe(evidence.parentElement?.id)
    const headers = within(evidence).getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual(['Layer', 'Value', 'Basis', 'As of', 'Source'])

    await user.click(supportingData)
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
    expect(supportingData.getAttribute('aria-expanded')).toBe('false')
  })

  it('prints coverage only in the rotation pill and drops every other readout (R-25, R-26)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const row = await expandFields(user)
    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    expect(screen.getByText('86% data coverage')).toBeTruthy()

    await user.click(within(row).getByRole('button', { name: 'Santa Carmem South' }))
    await screen.findByRole('status')

    expect(document.querySelector('.coverage-chip')).toBeNull()
    expect(screen.queryByText('COVERAGE')).toBeNull()
    expect(screen.getByText('62% data coverage')).toBeTruthy()
    expect(document.querySelectorAll('.field-coverage-pill')).toHaveLength(1)
    expect(document.querySelector('.field-list-anchor')?.textContent).not.toContain('%')
    expect(screen.getByRole('status').textContent).toBe('Ranking withheld: coverage below 80%.')
  })

  it('stacks the command form above the evidence panel in one right edge column (R-23)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Command' }))
    await user.click(await screen.findByRole('button', { name: 'Supporting data' }))

    const column = document.querySelector('.anchor-right-column')
    expect(column).toBeTruthy()
    const stack = column?.querySelector('.right-column-stack')
    const children = [...(stack?.children ?? [])]
    expect(children).toHaveLength(2)
    expect(children[0].classList.contains('layer-agent')).toBe(true)
    expect(children[1].classList.contains('layer-evidence')).toBe(true)
    expect(children[0].querySelector('form')?.getAttribute('aria-label')).toBe('Agent command')
    expect(children[1].querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Evidence')
  })

  it('keeps every toggle operable and the field error reachable when the backend fails (AC-28, R-09)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    const fields = await screen.findByRole('button', { name: 'Fields' })
    const supportingData = screen.getByRole('button', { name: 'Supporting data' })
    const command = screen.getByRole('button', { name: 'Command' })
    expect(fields).toBeTruthy()
    expect(supportingData).toBeTruthy()
    expect(command).toBeTruthy()
    expect(document.querySelectorAll('.field-chip')).toHaveLength(0)

    await user.click(fields)
    const fieldPanel = document.querySelector('.field-list-anchor') as HTMLElement
    expect(await within(fieldPanel).findByRole('alert')).toBeTruthy()
    expect(within(fieldPanel).getByText('Backend request failed (HTTP 500). Retry when it is available.')).toBeTruthy()
    expect(within(fieldPanel).getByRole('button', { name: 'Retry' })).toBeTruthy()

    await user.click(supportingData)
    const evidence = await screen.findByRole('region', { name: 'Evidence' })
    expect(within(evidence).getByText('No evidence available')).toBeTruthy()

    await user.click(command)
    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
  })

  it('has no second form and no withdrawn constraint control at first paint or after activations (AC-16, R-15)', async () => {
    // Field 01 selected before the first paint, which is the fixture default the map
    // resolves on load; nothing is clicked to reach the measured state.
    useMapStore.setState({ selectedFieldId: 'mt-santa-carmem-01' })
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const list = await screen.findByRole('list', { name: 'Rotation scenarios' })
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))

    // AM-11 withdrew the four-control form: no form at first paint, and none of its labels.
    expect(document.querySelectorAll('form')).toHaveLength(0)
    for (const name of ['Water', 'Rent', 'Credit', 'Market outlet']) {
      expect(screen.queryByRole('combobox', { name })).toBeNull()
      expect(screen.queryByText(name)).toBeNull()
    }

    await user.click(screen.getByRole('button', { name: 'Supporting data' }))
    const evidence = await screen.findByRole('region', { name: 'Evidence' })
    const smapRow = () => within(evidence).getByRole('row', { name: /SMAP soil moisture/ })
    expect(smapRow().textContent).toContain('SMAP soil moisture')
    expect(smapRow().textContent).toContain('retrieved')

    // Activating every disclosure the app renders leaves the row labels unchanged.
    await user.click(screen.getByRole('button', { name: 'Fields' }))
    const currentCard = screen.getByRole('heading', { name: 'Current sequence' }).closest('.scenario-card') as HTMLElement
    await user.click(within(currentCard).getByRole('button', { name: 'Charts for Current sequence' }))
    expect(smapRow().textContent).toContain('SMAP soil moisture')
    expect(smapRow().textContent).toContain('retrieved')
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
})

describe('block 3 wave 3: layout, notice and right edge column rules', () => {
  function stubViewport(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  /** A matchMedia stub whose media query change can be dispatched, as a real resize does. */
  function stubViewportWithChange(initial: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const mediaQuery = {
      matches: initial,
      media: '(max-width: 640px)',
      onchange: null,
      addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') listeners.add(listener)
      },
      removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') listeners.delete(listener)
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: () => false,
    }
    vi.stubGlobal('matchMedia', () => mediaQuery)
    return {
      setMatches(next: boolean) {
        mediaQuery.matches = next
        for (const listener of listeners) listener({ matches: next, media: mediaQuery.media } as MediaQueryListEvent)
      },
      listeners: () => listeners.size,
    }
  }

  async function selectSouth(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Fields' }))
    const row = await waitFor(() => {
      const found = document.getElementById('fields-chip-row')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    await user.click(within(row).getByRole('button', { name: /Santa Carmem South/ }))
    await screen.findByRole('status')
  }

  it('keeps one notice node, first in the left stack, with no duplicate mount (R-23, R-39)', async () => {
    stubViewport(true)
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await selectSouth(user)
    expect(document.querySelectorAll('.anchor-notice')).toHaveLength(1)
    expect(document.querySelectorAll('.abstention-notice')).toHaveLength(1)

    const stack = document.querySelector('.left-stack') as HTMLElement
    expect(stack).toBeTruthy()
    const order = [...stack.children].map((child) => child.className)
    // R-39 after AM-14: the 360 left flow column holds the notice and the fields panel only.
    expect(order).toHaveLength(2)
    expect(order[0]).toContain('anchor-notice')
    expect(order[1]).toContain('field-list-anchor')
    expect(document.querySelector('.anchor-constraints')).toBeNull()
  })

  it('holds at most one right edge panel open at 360 (R-40, AC-30)', async () => {
    stubViewport(true)
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const command = await screen.findByRole('button', { name: 'Command' })
    const supporting = screen.getByRole('button', { name: 'Supporting data' })

    await user.click(command)
    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()

    await user.click(supporting)
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(supporting.getAttribute('aria-expanded')).toBe('true')

    await user.click(command)
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
    expect(document.querySelectorAll('.anchor-right-column .layer-agent, .anchor-right-column .layer-evidence')).toHaveLength(1)
  })

  it('keeps both right edge panels open above 640 (R-23)', async () => {
    stubViewport(false)
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Command' }))
    await user.click(screen.getByRole('button', { name: 'Supporting data' }))

    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
    expect(document.querySelectorAll('.anchor-right-column .layer-agent, .anchor-right-column .layer-evidence')).toHaveLength(2)
  })

  it('closes the older right edge panel when the viewport enters 360 and keeps focus (R-40, AC-26, AC-30)', async () => {
    const viewport = stubViewportWithChange(false)
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const command = await screen.findByRole('button', { name: 'Command' })
    const supporting = screen.getByRole('button', { name: 'Supporting data' })
    await user.click(command)
    await user.click(supporting)
    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
    expect(document.activeElement).toBe(supporting)

    act(() => viewport.setMatches(true))

    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(supporting.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(supporting)
    expect(document.querySelectorAll('.anchor-right-column .layer-agent, .anchor-right-column .layer-evidence')).toHaveLength(1)

    // Leaving 360 does not reopen the panel that the transition closed (R-40).
    act(() => viewport.setMatches(false))
    expect(screen.queryByRole('form', { name: 'Agent command' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()
    expect(supporting.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the panel opened last when the command form is the newer one (R-40)', async () => {
    const viewport = stubViewportWithChange(false)
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const command = await screen.findByRole('button', { name: 'Command' })
    const supporting = screen.getByRole('button', { name: 'Supporting data' })
    await user.click(supporting)
    await user.click(command)
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeTruthy()

    act(() => viewport.setMatches(true))

    expect(screen.getByRole('form', { name: 'Agent command' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Evidence' })).toBeNull()
    expect(supporting.getAttribute('aria-expanded')).toBe('false')
    expect(command.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Command name' }))
  })
})

describe('block 3 wave 2: rotation flip card visuals', () => {
  async function selectNorth(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Fields' }))
    const row = await waitFor(() => {
      const found = document.getElementById('fields-chip-row')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    await user.click(within(row).getByRole('button', { name: 'Santa Carmem North' }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    const card = screen.getByRole('heading', { name: 'Current sequence' }).closest('.scenario-card')
    expect(card).toBeTruthy()
    return card as HTMLElement
  }

  it('draws the measured SMAP value and its number at first paint with no interaction (AC-08, AC-09, AC-13)', async () => {
    // Field 01 is the field the map selects on load; nothing is activated after paint.
    useMapStore.setState({ selectedFieldId: 'mt-santa-carmem-01' })
    mockApi()
    render(<App />)

    const list = await screen.findByRole('list', { name: 'Rotation scenarios' })
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
    const card = screen.getByRole('heading', { name: 'Current sequence' }).closest('.scenario-card') as HTMLElement
    const smap = within(card).getByRole('group', { name: /^SMAP soil moisture/ })

    // Nothing was clicked: Field 01 is auto selected and the row's own basis is retrieved.
    expect(smap.textContent).toContain('SMAP soil moisture')
    expect(smap.textContent).toContain('0.28 m³/m³')
    expect(smap.textContent).toContain('retrieved')
    expect(smap.textContent).toContain('2025-11-10')
    expect(smap.textContent).not.toContain('(assumes)')
    expect(smap.textContent).not.toContain('modelled')
    expect(smap.getAttribute('aria-label')).toBe('SMAP soil moisture, 0.28 m³/m³, retrieved')
    expect((card.querySelector('.smap-fill') as HTMLElement).style.width).toBe('56%')
  })

  it('flips one card to its facts and back without touching the others (AC-07)', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const card = await selectNorth(user)
    const triggers = [...document.querySelectorAll('.scenario-card .flip-overlay')] as HTMLElement[]
    expect(triggers.every((trigger) => trigger.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(screen.queryByText('Why')).toBeNull()

    await user.click(within(card).getByRole('button', { name: 'Charts for Current sequence' }))

    expect(within(card).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    // Block 6 AM-03: the sixth labelled fact, the falsifier, sits after Benefit.
    expect(within(card).getAllByRole('term').map((term) => term.textContent))
      .toEqual(['Why', 'Evidence', 'Benefit', 'Falsifier', 'Gap', 'Risk'])
    expect(within(card).queryByRole('group')).toBeNull()
    expect(document.querySelectorAll('.scenario-card .flip-overlay[aria-expanded="true"]')).toHaveLength(1)

    await user.click(within(card).getByRole('button', { name: 'Details for Current sequence' }))
    expect(within(card).queryByRole('term')).toBeNull()
    expect(within(card).getByRole('group', { name: /^SMAP soil moisture/ })).toBeTruthy()
  })
})

describe('block 3 gate: keyboard contract of the four controls (AC-32)', () => {
  function focusLabel(element: Element | null): string {
    if (!element) return 'none'
    const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''
    return `${element.tagName.toLowerCase()}${label ? `:${label}` : ''}`
  }

  it('lists the four controls, their tag, tabIndex and state after Enter, Space and a letter key', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    type Row = {
      control: string
      tagName: string
      tabIndex: number
      disabled: boolean
      negativeTabIndex: boolean
      afterEnter: string | null
      afterSpace: string | null
      afterSecondEnter: string | null
      afterLetter: string | null
      focusAfterEnter: string
      focusAfterSpace: string
      focusAfterSecondEnter: string
      focusAfterLetter: string
      regionAfterEnter: boolean
      regionAfterSpace: boolean
      regionAfterSecondEnter: boolean
      regionAfterLetter: boolean
    }

    // Enter toggles, Space toggles back, a second Enter toggles again, and `a` does
    // nothing. The state is the control's own aria-expanded, the region is what it
    // controls. Command is re-focused before each later press per R-04, because the
    // opening press moves focus into the Command name box.
    async function exercise(
      control: HTMLElement,
      region: () => Element | null,
      refocusBeforePress: boolean,
    ): Promise<Row> {
      control.focus()
      await user.keyboard('{Enter}')
      const afterEnter = control.getAttribute('aria-expanded')
      const focusAfterEnter = focusLabel(document.activeElement)
      const regionAfterEnter = Boolean(region())

      if (refocusBeforePress) control.focus()
      await user.keyboard(' ')
      const afterSpace = control.getAttribute('aria-expanded')
      const focusAfterSpace = focusLabel(document.activeElement)
      const regionAfterSpace = Boolean(region())

      if (refocusBeforePress) control.focus()
      await user.keyboard('{Enter}')
      const afterSecondEnter = control.getAttribute('aria-expanded')
      const focusAfterSecondEnter = focusLabel(document.activeElement)
      const regionAfterSecondEnter = Boolean(region())

      if (refocusBeforePress) control.focus()
      await user.keyboard('a')
      const afterLetter = control.getAttribute('aria-expanded')
      const focusAfterLetter = focusLabel(document.activeElement)
      const regionAfterLetter = Boolean(region())

      return {
        control: control.textContent?.trim() || (control.getAttribute('aria-label') ?? ''),
        tagName: control.tagName,
        tabIndex: control.tabIndex,
        disabled: (control as HTMLButtonElement).disabled,
        negativeTabIndex: control.getAttribute('tabindex') === '-1',
        afterEnter,
        afterSpace,
        afterSecondEnter,
        afterLetter,
        focusAfterEnter,
        focusAfterSpace,
        focusAfterSecondEnter,
        focusAfterLetter,
        regionAfterEnter,
        regionAfterSpace,
        regionAfterSecondEnter,
        regionAfterLetter,
      }
    }

    const fields = await screen.findByRole('button', { name: 'Fields' })
    const command = screen.getByRole('button', { name: 'Command' })
    const supporting = screen.getByRole('button', { name: 'Supporting data' })

    const fieldsRow = await exercise(fields, () => document.querySelector('#fields-chip-row [data-slot="collapsible-panel"][data-open]'), false)
    const row = await waitFor(() => {
      const found = document.getElementById('fields-chip-row')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    await user.click(within(row).getByRole('button', { name: /Santa Carmem North/ }))
    await screen.findByRole('list', { name: 'Rotation scenarios' })
    const flip = await waitFor(() => {
      const found = document.querySelector('.scenario-card .flip-overlay')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    const flipFace = () => document.querySelector('.scenario-card .flip-face[data-face="back"]')

    const commandRow = await exercise(command, () => screen.queryByRole('form', { name: 'Agent command' }), true)
    const supportingRow = await exercise(supporting, () => screen.queryByRole('region', { name: 'Evidence' }), false)
    const flipRow = await exercise(flip, flipFace, false)

    const matrix = [fieldsRow, commandRow, supportingRow, flipRow]
    console.log('AC-32 keyboard matrix', JSON.stringify(matrix, null, 2))

    for (const entry of matrix) {
      expect(entry.tagName).toBe('BUTTON')
      expect(entry.tabIndex).toBe(0)
      expect(entry.disabled).toBe(false)
      expect(entry.negativeTabIndex).toBe(false)
      expect(entry.afterEnter).toBe('true')
      expect(entry.regionAfterEnter).toBe(true)
      expect(entry.afterSpace).toBe('false')
      expect(entry.regionAfterSpace).toBe(false)
      expect(entry.afterSecondEnter).toBe('true')
      expect(entry.regionAfterSecondEnter).toBe(true)
      expect(entry.afterLetter).toBe('true')
      expect(entry.regionAfterLetter).toBe(true)
    }

    // Focus policy: R-04 governs Command, every other control keeps focus on itself.
    expect(fieldsRow.focusAfterEnter).toBe('button:Fields')
    expect(fieldsRow.focusAfterSpace).toBe('button:Fields')
    expect(fieldsRow.focusAfterSecondEnter).toBe('button:Fields')
    expect(fieldsRow.focusAfterLetter).toBe('button:Fields')
    expect(commandRow.focusAfterEnter).toBe('input:Command name')
    expect(commandRow.focusAfterSpace).toBe('button:Command')
    expect(commandRow.focusAfterSecondEnter).toBe('input:Command name')
    expect(commandRow.focusAfterLetter).toBe('button:Command')
    expect(supportingRow.focusAfterEnter).toBe('button:Supporting data')
    expect(supportingRow.focusAfterSpace).toBe('button:Supporting data')
    expect(supportingRow.focusAfterSecondEnter).toBe('button:Supporting data')
    expect(supportingRow.focusAfterLetter).toBe('button:Supporting data')
    expect(flipRow.focusAfterEnter).toBe('button:Details for Current sequence')
    expect(flipRow.focusAfterSpace).toBe('button:Charts for Current sequence')
    expect(flipRow.focusAfterSecondEnter).toBe('button:Details for Current sequence')
    expect(flipRow.focusAfterLetter).toBe('button:Details for Current sequence')
  })
})

describe('block 4 wave 3: the timeline replaces the season control', () => {
  const dateInput = () => screen.getByLabelText('Go to date') as HTMLInputElement

  it('has no element named Season and no season select anywhere (AC-22, timeline half)', async () => {
    mockApi()
    render(<App />)

    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeTruthy()
    expect(document.querySelector('[aria-label="Season"]')).toBeNull()
    expect(document.querySelector('select')).toBeNull()
    expect(screen.queryByText('Season')).toBeNull()
  })

  it('opens at the axis end by default (AC-23)', async () => {
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2026-11-14'))
    expect(dateInput().min).toBe('2015-04-01')
    expect(dateInput().max).toBe('2026-11-14')
  })

  it('opens at ?date=2026-11-12 and asks /layers for that date (AC-23)', async () => {
    window.history.replaceState({}, '', '/?date=2026-11-12')
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2026-11-12'))
    const layerRequests = vi.mocked(fetch).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/layers')
    expect(layerRequests.some((url) => url.searchParams.get('date') === '2026-11-12')).toBe(true)
  })

  it('clamps a query before the axis and shows the polite limit message (AC-23)', async () => {
    window.history.replaceState({}, '', '/?date=2015-03-01')
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    await waitFor(() => expect(dateInput().value).toBe('2015-04-01'))
    expect(screen.getByRole('status').textContent).toBe('Date limited to 2015-04-01')
  })

  it('renders none_in_lookback and the first axis day without inventing a date (AC-28)', async () => {
    const payloads: Record<string, ReturnType<typeof layersResponse>> = {}
    const noneInLookback = layersResponse('2025-01-15')
    payloads['2025-01-15'] = {
      ...noneInLookback,
      layers: noneInLookback.layers.map((layer) => (layer.id === 'ndvi-8day'
        ? { ...layer, status: 'none_in_lookback' as const, effective_date: null, age_days: null }
        : layer)),
    }
    const firstAxisDay = layersResponse('2015-04-01')
    payloads['2015-04-01'] = {
      ...firstAxisDay,
      layers: firstAxisDay.layers.map((layer) => (layer.id === 'smap-l3'
        ? { ...layer, status: 'on_date' as const, effective_date: '2015-04-01', age_days: 0 }
        : layer)),
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/layers') {
        const date = url.searchParams.get('date') ?? ''
        return { ok: true, status: 200, json: async () => payloads[date] } as Response
      }
      if (url.pathname === '/fields') {
        return { ok: true, status: 200, json: async () => ({ fields, seasons: ['2023/24', '2024/25', '2025/26'], default_season: '2025/26' }) } as Response
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    }))

    window.history.replaceState({}, '', '/?date=2025-01-15')
    const first = render(<App />)
    await waitFor(() => expect((screen.getByLabelText('Go to date') as HTMLInputElement).value).toBe('2025-01-15'))
    const ndvi = document.querySelector('.layer-entry[data-layer-id="ndvi-8day"]') as HTMLElement
    await waitFor(() => expect(ndvi.textContent).toContain('no observation in lookback'))
    expect(ndvi.querySelector('time')).toBeNull()
    first.unmount()

    window.history.replaceState({}, '', '/?date=2015-04-01')
    // A page load starts with the default state: the store is fresh, no chosen date.
    useMapStore.setState({ chosenDate: null })
    render(<App />)
    await waitFor(() => expect((screen.getByLabelText('Go to date') as HTMLInputElement).value).toBe('2015-04-01'))
    const smap = document.querySelector('.layer-entry[data-layer-id="smap-l3"]') as HTMLElement
    await waitFor(() => expect(smap.textContent).toContain('2015-04-01'))
  })
})

describe('block 4 wave 4: the dock states, the two toggles and the motion rules', () => {
  type Width = '1440' | '780' | '360'

  /** The two queries the block 4 layout reads, keyed by the width they stand for. */
  function widthMatches(query: string, width: Width): boolean {
    if (query === '(max-width: 640px)') return width === '360'
    if (query === '(max-width: 1020px)') return width !== '1440'
    return false
  }

  function stubWidth(width: Width) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: widthMatches(query, width),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  /** A matchMedia stub a test can resize, dispatching `change` the way a real resize does. */
  function stubResizableWidth(initial: Width) {
    const current: { width: Width } = { width: initial }
    const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>()
    const set = (width: Width) => {
      current.width = width
      for (const [query, handlers] of listeners) {
        const event = { matches: widthMatches(query, width), media: query } as MediaQueryListEvent
        for (const handler of handlers) handler(event)
      }
    }
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return widthMatches(query, current.width) },
      media: query,
      onchange: null,
      addEventListener: (type: string, handler: (event: MediaQueryListEvent) => void) => {
        if (type !== 'change') return
        if (!listeners.has(query)) listeners.set(query, new Set())
        listeners.get(query)?.add(handler)
      },
      removeEventListener: (type: string, handler: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') listeners.get(query)?.delete(handler)
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    return { set }
  }

  const timelineToggle = () => screen.getByRole('button', { name: 'Timeline controls' })
  const timelineRegion = () => screen.queryByRole('region', { name: 'Timeline' })
  const rotationCollapsedState = () => document.querySelector('[data-rotation-panel]')?.getAttribute('data-collapsed')
  const chosenDate = () => useMapStore.getState().chosenDate

  it('R-46, AC-39: at 360x640 the dock is the collapsed toggle and Enter expands it as the region first control', async () => {
    stubWidth('360')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull()
    const toggle = timelineToggle()
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('2026-11-14')
    expect(toggle.tabIndex).toBe(0)

    toggle.focus()
    await user.keyboard('{Enter}')
    const region = await screen.findByRole('region', { name: 'Timeline' })
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('true')
    expect(region.querySelector('.timeline-date-row')?.firstElementChild).toBe(timelineToggle())
    expect(document.activeElement).toBe(timelineToggle())
    // The four R-37 controls stay four at this width.
    expect(within(region).getByLabelText('Go to date')).toBeTruthy()
    expect(within(region).getByLabelText('Previous day')).toBeTruthy()
    expect(within(region).getByLabelText('Timeline date')).toBeTruthy()
    expect(within(region).getByLabelText('Next day')).toBeTruthy()

    await user.keyboard(' ')
    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(timelineToggle())
  })

  it('R-46, AC-39: at 780x900 the dock is expanded at first paint and its toggle is a sibling of the region', async () => {
    stubWidth('780')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const region = await screen.findByRole('region', { name: 'Timeline' })
    const toggle = timelineToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region.contains(toggle)).toBe(false)
    expect(toggle.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(toggle)
    await waitFor(() => expect(timelineRegion()).toBeNull())
    expect(timelineToggle().getAttribute('aria-expanded')).toBe('false')
    expect(timelineToggle().textContent).toContain('2026-11-14')

    await user.click(timelineToggle())
    expect(await screen.findByRole('region', { name: 'Timeline' })).toBeTruthy()
  })

  it('R-40, R-51, R-52, AC-33: a resize keeps the chosen date and the states the user set', async () => {
    const viewport = stubResizableWidth('1440')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    act(() => useMapStore.setState({ chosenDate: '2026-11-12' }))
    await user.click(screen.getByRole('button', { name: 'Collapse Rotation outlook' }))
    expect(rotationCollapsedState()).toBe('true')

    act(() => viewport.set('780'))
    await waitFor(() => expect(rotationCollapsedState()).toBe('true'))
    expect(timelineRegion()).toBeTruthy()
    expect(chosenDate()).toBe('2026-11-12')

    // Two presses at 780: the expanded state is a press value, not the width default.
    await user.click(timelineToggle())
    expect(timelineRegion()).toBeNull()
    await user.click(timelineToggle())
    expect(timelineRegion()).toBeTruthy()

    act(() => viewport.set('360'))
    await waitFor(() => expect(timelineToggle().getAttribute('aria-expanded')).toBe('true'))
    const region = await screen.findByRole('region', { name: 'Timeline' })
    expect(region.querySelector('.timeline-date-row')?.firstElementChild).toBe(timelineToggle())
    expect(chosenDate()).toBe('2026-11-12')
    // 360x640's own default is collapsed, and the resize does not reapply it.
    expect(rotationCollapsedState()).toBe('true')
  })

  it('R-48, AC-42: the rotation toggle is a native button whose name states the action and whose keys toggle it', async () => {
    stubWidth('1440')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    const toggle = await screen.findByRole('button', { name: 'Collapse Rotation outlook' })
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.tabIndex).toBe(0)
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    toggle.focus()
    await user.keyboard('{Enter}')
    const collapsed = screen.getByRole('button', { name: 'Expand Rotation outlook' })
    expect(collapsed.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(collapsed)

    await user.keyboard(' ')
    const expanded = screen.getByRole('button', { name: 'Collapse Rotation outlook' })
    expect(expanded.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(expanded)
  })

  it('R-49, AC-43: collapsing unmounts the three cards and the Rotation scenarios list', async () => {
    stubWidth('1440')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(3))
    expect(screen.getByRole('list', { name: 'Rotation scenarios' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Collapse Rotation outlook' }))
    await waitFor(() => expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(0))
    expect(screen.queryByRole('list', { name: 'Rotation scenarios' })).toBeNull()
    expect(document.querySelectorAll('.rotation-card').length).toBe(0)
    // Block 5.5 B4: closing the panel unmounts it whole, heading included, and leaves the map screen
    // with no empty surface over it.
    expect(screen.queryByRole('heading', { name: 'Rotation outlook' })).toBeNull()
    expect(document.querySelector('[data-panel-host]')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Expand Rotation outlook' }))
    await waitFor(() => expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(3))
    expect(screen.getByRole('list', { name: 'Rotation scenarios' })).toBeTruthy()
    for (const face of document.querySelectorAll('.scenario-card .flip-face')) {
      expect(face.getAttribute('data-face')).toBe('front')
    }
  })

  it('R-37, AC-36: Enter and Space step the date from Previous day and Next day and keep focus', async () => {
    stubWidth('1440')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })

    const previous = screen.getByRole('button', { name: 'Previous day' })
    previous.focus()
    await user.keyboard('{Enter}')
    expect(chosenDate()).toBe('2026-11-13')
    expect(document.activeElement).toBe(previous)
    await user.keyboard(' ')
    expect(chosenDate()).toBe('2026-11-12')
    expect(document.activeElement).toBe(previous)

    const next = screen.getByRole('button', { name: 'Next day' })
    next.focus()
    await user.keyboard('{Enter}')
    expect(chosenDate()).toBe('2026-11-13')
    expect(document.activeElement).toBe(next)
  })

  it('R-53, AC-45: a block 4 press leaves the card faces and values alone, and wave 4 imports no other panel state', async () => {
    stubWidth('780')
    mockApi()
    const user = userEvent.setup()
    render(<App />)

    // Block 5.5 B4: no panel is open at first paint at any width, so the cards mount after a press.
    await user.click(await screen.findByRole('button', { name: 'Collapse Rotation outlook' }))
    await user.click(screen.getByRole('button', { name: 'Expand Rotation outlook' }))
    await waitFor(() => expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(3))
    const flip = document.querySelector('.scenario-card .flip-overlay') as HTMLElement
    await user.click(flip)
    const face = () => document.querySelector('.scenario-card .flip-face')?.getAttribute('data-face')
    expect(face()).toBe('back')
    const value = document.querySelector('.smap-value')?.textContent ?? null

    await user.click(timelineToggle())
    expect(face()).toBe('back')
    await user.click(timelineToggle())
    expect(face()).toBe('back')
    expect(document.querySelectorAll('.scenario-card[role="option"]')).toHaveLength(3)
    expect(document.querySelector('.smap-value')?.textContent ?? null).toBe(value)

    const wave4Sources = ['src/components/TimelineDock.tsx', 'src/components/ScenarioCards.tsx', 'src/lib/viewport.ts']
      .map((path) => readFileSync(resolve(process.cwd(), path), 'utf8'))
      .join('\n')
    expect(wave4Sources).not.toMatch(/useCommandToggle|useSupportingDataToggle|SUPPORTING_DATA_PANEL_ID/)
  })

  it('R-41, AC-22: the top right strip is the label, the avatar, Command, Supporting data and, from block 6, Field numbers', async () => {
    stubWidth('1440')
    mockApi()
    render(<App />)

    await screen.findByRole('region', { name: 'Timeline' })
    const strip = document.querySelector('.anchor-top-right .topbar-meta') as HTMLElement
    const children = [...strip.children]
    // Block 6, R-01: the `Field numbers` button is the control block 6 added after Supporting data,
    // and block 7 R-08 adds `Planting calendar` and `Field record` to its right, in that order.
    expect(children).toHaveLength(8)
    expect(children[0].textContent).toBe('FIELD INTELLIGENCE')
    expect(children[1].getAttribute('aria-label')).toBe('Grower profile')
    expect(children[2].textContent).toBe('Command')
    expect(children[3].textContent).toBe('Supporting data')
    expect(children[4].textContent).toBe('Rotation outlook')
    expect(children[5].textContent).toBe('Field numbers')
    expect(children[6].textContent).toBe('Planting calendar')
    expect(children[7].textContent).toBe('Field record')
    expect(document.querySelector('[aria-label="Season"]')).toBeNull()
    expect(document.querySelector('select')).toBeNull()
  })
})
