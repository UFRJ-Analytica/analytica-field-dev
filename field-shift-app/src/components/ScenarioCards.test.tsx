import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScenarioCards, type RotationScenario } from './ScenarioCards'

vi.mock('maplibre-gl', () => ({
  Map: class {
    addControl = vi.fn()
    addSource = vi.fn()
    addLayer = vi.fn()
    flyTo = vi.fn()
    on = vi.fn()
    remove = vi.fn()
  },
  NavigationControl: class {},
}))

const scenarios: RotationScenario[] = [
  {
    id: 'current-sequence',
    name: 'Current sequence',
    is_current: true,
    crops: ['Soybean', 'Corn'],
    why: 'The current farm plan is the reference for comparison.',
    evidence: 'Three seasons of field history are available.',
    benefit: 'Known operating fit for this field.',
    gap: 'Input-cost records are not available.',
    risk: 'Weather variability can shift planting windows.',
    evidence_rows: [
      { layer: 'SMAP soil moisture', value: '0.28 m³/m³', basis: 'retrieved', as_of: '2025-11-10', source: 'https://gibs.earthdata.nasa.gov/' },
      { layer: 'Crop history', value: 'Soybean → Corn', basis: 'entered', as_of: '2025-06-30', source: 'https://field-shift.local/fixtures/crop-history' },
    ],
  },
  {
    id: 'soy-corn-cover',
    name: 'Soybean → Corn cover',
    is_current: false,
    crops: ['Soybean', 'Corn'],
    why: 'Alternating crop families maintains the current rotation pattern.',
    evidence: 'SMAP soil moisture retrieval is available for the reference date.',
    benefit: 'Familiar sequence with a cover-crop window.',
    gap: 'Cover-crop establishment is not recorded.',
    risk: 'A short dry spell may reduce emergence.',
    evidence_rows: [
      { layer: 'SMAP soil moisture', value: '0.28 m³/m³', basis: 'retrieved', as_of: '2025-11-10', source: 'https://gibs.earthdata.nasa.gov/' },
      { layer: 'Rotation suitability', value: '0.74', basis: 'modelled', as_of: '2025-11-10', source: 'https://field-shift.local/fixtures/model-v1' },
    ],
  },
  {
    id: 'soy-cotton',
    name: 'Soybean → Cotton',
    is_current: false,
    crops: ['Soybean', 'Cotton'],
    why: 'Introduces a fiber crop after soybean.',
    evidence: 'Three seasons of crop history support a rotation comparison.',
    benefit: 'Adds a potential market outlet.',
    gap: 'Buyer access and credit terms are unknown.',
    risk: 'Cotton requires higher working capital.',
    evidence_rows: [
      { layer: 'Rotation suitability', value: '0.68', basis: 'modelled', as_of: '2025-11-10', source: 'https://field-shift.local/fixtures/model-v1' },
      { layer: 'Market outlet', value: 'Not entered', basis: 'entered', as_of: '2025-11-10', source: 'https://field-shift.local/fixtures/producer-inputs' },
    ],
  },
]

// Block 6 AM-03: six labelled facts on the back face, the falsifier after Benefit.
const expectedFields = ['Why', 'Evidence', 'Benefit', 'Falsifier', 'Gap', 'Risk']

function cardFor(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name }).closest('.scenario-card')
  if (!card) throw new Error(`No card for ${name}`)
  return card as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ScenarioCards', () => {
  it('renders the scenario skeletons while loading and keeps the list contract', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} isLoading />)

    const panel = screen.getByRole('list', { name: 'Rotation scenarios' })
    expect(panel.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(within(panel).queryByRole('option')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Current sequence' })).toBeNull()
  })

  it('renders the empty state with its reason instead of scenarios', () => {
    render(<ScenarioCards scenarios={[]} state={null} threshold={null} emptyReason="No field is selected." />)

    expect(screen.getByText('No field is selected.')).toBeTruthy()
    expect(document.querySelector('[data-slot="empty"]')).not.toBeNull()
    expect(screen.getByRole('list', { name: 'Rotation scenarios' })).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('renders scenarios normally when no loading or empty flags are provided', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(document.querySelector('[data-slot="empty"]')).toBeNull()
  })

  it('puts the current sequence first even when the fixture order differs', () => {
    render(<ScenarioCards scenarios={[scenarios[1], scenarios[2], scenarios[0]]} state="ranked" threshold={null} />)

    const list = screen.getByRole('list', { name: 'Rotation scenarios' })
    const options = within(list).getAllByRole('option')

    expect(options).toHaveLength(3)
    expect(options.every((option) => option.tagName.toLowerCase() === 'li')).toBe(true)
    expect(options[0].getAttribute('aria-current')).toBe('true')
    expect(within(options[0]).getByRole('heading', { name: 'Current sequence' })).toBeTruthy()
    expect(options[1].getAttribute('aria-current')).not.toBe('true')
    expect(options[2].getAttribute('aria-current')).not.toBe('true')
  })

  it('keeps the three scenario cards in one row at a wide viewport (R-11, AC-11)', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    const list = screen.getByRole('list', { name: 'Rotation scenarios' })
    const options = within(list).getAllByRole('option')

    // jsdom has no layout, so this asserts the row contract in the DOM: one list, three
    // direct card children in order, no wrapper per card. The pixel check for one row at
    // 1440, 780 and 360 is the browser measurement in the task report.
    expect(list.classList.contains('scenario-list')).toBe(true)
    expect(options).toHaveLength(3)
    expect([...list.children]).toEqual(options)
    expect(options.map((option) => option.tagName.toLowerCase())).toEqual(['li', 'li', 'li'])
    for (const option of options) {
      expect(option.classList.contains('rotation-card')).toBe(true)
      expect(option.querySelectorAll(':scope > .flip-face').length).toBe(1)
      expect(within(option).getAllByRole('button')).toHaveLength(1)
    }
    expect(options.map((option) => within(option).getByRole('heading', { level: 3 }).textContent))
      .toEqual(['Current sequence', 'Soybean → Corn cover', 'Soybean → Cotton'])
  })

  it('shows the two visuals on every front and none of the five facts (R-12, AC-07)', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    const list = screen.getByRole('list', { name: 'Rotation scenarios' })
    for (const option of within(list).getAllByRole('option')) {
      expect(within(option).getByRole('group', { name: /^SMAP soil moisture/ })).toBeTruthy()
      expect(within(option).getByRole('group', { name: /^Crop history/ })).toBeTruthy()
      for (const label of expectedFields) expect(within(option).queryByText(label)).toBeNull()
      expect(option.querySelector('dl')).toBeNull()
    }
  })

  it('renders the six labelled facts in block 2 order on the back face (R-13, AC-07, AM-03)', async () => {
    const user = userEvent.setup()
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    for (const scenario of scenarios) {
      const card = cardFor(scenario.name)
      await user.click(within(card).getByRole('button', { name: `Charts for ${scenario.name}` }))

      const facts = card.querySelector('dl')
      expect(facts).not.toBeNull()
      expect(within(facts as HTMLElement).getAllByRole('term').map((label) => label.textContent)).toEqual(expectedFields)
      // R-40: with no payload read, the falsifier slot prints the abstention of the block.
      expect(within(facts as HTMLElement).getAllByRole('definition').map((value) => value.textContent)).toEqual([
        scenario.why,
        scenario.evidence,
        scenario.benefit,
        'No counter evidence recorded',
        scenario.gap,
        scenario.risk,
      ])
      expect(within(card).queryByRole('group')).toBeNull()
      expect(within(card).getByRole('heading')).toBeTruthy()
    }
  })

  it('keeps the crop group basis and date per scenario and invents none (R-15, AC-10)', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    const current = within(cardFor('Current sequence')).getByRole('group', { name: /^Crop history/ })
    expect(current.textContent).toContain('Soybean')
    expect(current.textContent).toContain('Corn')
    expect(current.textContent).toContain('entered')
    expect(current.textContent).toContain('2025-06-30')
    expect(current.getAttribute('aria-label')).toBe('Crop history, Soybean then Corn, entered')

    const cover = cardFor('Soybean → Corn cover')
    const coverCrop = within(cover).getByRole('group', { name: /^Crop history/ })
    expect(coverCrop.textContent).not.toContain('entered')
    expect(coverCrop.textContent).not.toMatch(/\d/)
    expect(within(cover).getByRole('group', { name: /^SMAP soil moisture/ }).textContent).toContain('0.28 m³/m³')

    const cotton = cardFor('Soybean → Cotton')
    const cottonCrop = within(cotton).getByRole('group', { name: /^Crop history/ })
    expect(cottonCrop.textContent).toContain('Cotton')
    expect(cottonCrop.textContent).not.toContain('entered')
    expect(cottonCrop.textContent).not.toMatch(/\d/)
  })

  it('shows the measured SMAP strings and no derived rotation value on the front (R-14, R-38, AC-08)', () => {
    render(<ScenarioCards scenarios={scenarios} state="ranked" threshold={null} />)

    const current = cardFor('Current sequence')
    const smap = within(current).getByRole('group', { name: /^SMAP soil moisture/ })
    expect(smap.textContent).toContain('SMAP soil moisture')
    expect(smap.textContent).toContain('0.28 m³/m³')
    expect(smap.textContent).toContain('retrieved')
    expect(smap.textContent).toContain('2025-11-10')

    const fronts = document.querySelector('.scenario-list')?.textContent ?? ''
    for (const derived of ['0.46', '0.58', '0.68', '0.72', '0.74', '0.79']) {
      expect(fronts).not.toContain(derived)
    }
  })

  it('decides the SMAP label from each row basis: retrieved measures, modelled marks (R-14, R-17, AC-13)', () => {
    const withModelled = scenarios.map((scenario) => scenario.id !== 'soy-corn-cover'
      ? scenario
      : {
          ...scenario,
          evidence_rows: scenario.evidence_rows.map((row) => row.layer === 'SMAP soil moisture'
            ? { ...row, basis: 'modelled' as const }
            : row),
        })
    render(<ScenarioCards scenarios={withModelled} state="ranked" threshold={null} />)

    const current = cardFor('Current sequence')
    const measured = within(current).getByRole('group', { name: /^SMAP soil moisture/ })
    expect(measured.textContent).toContain('0.28 m³/m³')
    expect(measured.textContent).toContain('retrieved')
    expect(measured.textContent).not.toContain('modelled')
    expect(measured.textContent).not.toContain('assumes')
    expect((current.querySelector('.smap-fill') as HTMLElement).style.width).toBe('56%')

    const cover = cardFor('Soybean → Corn cover')
    const marked = within(cover).getByRole('group', { name: /^SMAP soil moisture/ })
    expect(marked.textContent).toContain('SMAP soil moisture (modelled)')
    expect(marked.textContent).not.toMatch(/\d/)
    expect((cover.querySelector('.smap-fill') as HTMLElement).style.width).toBe('0px')
    expect(within(cover).getByRole('group', { name: /^Crop history/ })).toBeTruthy()
  })
})

describe('the season chip of the rotation panel (R-49, AC-41)', () => {
  it('shows the season chip by default and omits it when the polygon surface is open', () => {
    const { unmount } = render(<ScenarioCards scenarios={[]} state={null} threshold={null} emptyReason="x" />)
    expect(screen.getByText('2025/26 season')).toBeTruthy()
    unmount()
    render(<ScenarioCards scenarios={[]} state={null} threshold={null} emptyReason="x" seasonChip={false} />)
    expect(screen.queryByText('2025/26 season')).toBeNull()
  })
})
