/**
 * Block 6 contract repair: one test per shipped defect (D1 to D5), each driven by the recorded
 * response of the real numbers route (`src/test/numbers-recorded.json`), plus the smoke test that
 * renders the whole surface from that response.
 *
 * Each defect test renders the one section reader it names, so a failure points at that section
 * and not at the first card that happens to be rendered. The smoke test at the end is the one that
 * would have caught all five at once: it mounts the surface exactly as the app does.
 *
 * The last block is the payload follow-up (t_4b5447cf): the climate card's resolution line had never
 * printed, because the section sent `null` while its own rows and Table E carried the value.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClimateCard, ClimateChart, NumbersView, ProvenanceTable, RotationCard, SoilCard } from './NumbersView'
import { formatMetric, type ClimateSection, type NumbersPayload } from '@/lib/numbers'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import offlineCapture from '../../artifacts/block6/numbers-offline-payload.json'

/**
 * The response of the same route with `power.larc` unreachable (R-48, AC-47).
 *
 * It is a capture, not hand written: `artifacts/block6/numbers-offline-payload.json` is the JSON
 * body of `POST /fields/mt-santa-carmem-01/numbers` for the request below, produced by the shipped
 * `build_numbers` over the recorded block 6 transport with `offline_hosts=("power.larc",)`, a
 * temporary cache and `MAPBIOMAS_DB`, and the clock frozen at `2026-11-15T03:00Z`. Every section
 * but soil and fragment is unavailable or abstained, `query.window` and `water_balance.window`
 * are null, and the surface has to render that wire shape instead of the `ok` one.
 */
const OFFLINE = offlineCapture as unknown as NumbersPayload

function offlineNumbersPayload(): NumbersPayload {
  return structuredClone(OFFLINE)
}

const field: FieldSummary = {
  id: 'mt-santa-carmem-01',
  name: 'Santa Carmem North',
  location: 'Santa Carmem, Mato Grosso',
  coverage: 86,
  center: [-55.27, -11.91],
  boundary: {
    type: 'Polygon',
    coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]],
  },
}

function stubNumbersFetch(payload: NumbersPayload) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/numbers') && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?numbers=1')
  useMapStore.setState({
    regionId: 'br',
    selectedFieldId: field.id,
    selectedPolygonId: null,
    polygonRaw: null,
    polygonMode: null,
    polygonRing: null,
    chosenDate: '2026-11-12',
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useMapStore.setState({ selectedFieldId: null, numbersLastRead: {} })
})

describe('D1: the climate aggregates are the payload objects, and no invented key is read', () => {
  it('prints the six aggregate values and abstains from the valid day counts the payload carries (R-19)', () => {
    const payload = recordedNumbersPayload()
    const climate = payload.sections.climate
    const { container } = render(<ClimateCard climate={climate} window={payload.query.window} />)

    for (const [metric, aggregate] of Object.entries(climate.aggregates)) {
      const node = container.querySelector<HTMLElement>(`[data-metric="${metric}"]`)
      expect(node, metric).not.toBeNull()
      expect(node?.textContent).toContain(formatMetric(metric, aggregate.value))
    }

    // A short parameter abstains with its own counts, taken from the aggregate the payload sends.
    const short: typeof climate = structuredClone(climate)
    short.aggregates.gdd10 = { value: null, valid_days: 33, of_days: 42 }
    const abstained = render(<ClimateCard climate={short} window={payload.query.window} />)
    expect(
      within(abstained.container).getByText(/T2M_MAX and T2M_MIN is valid on 33 of 42 days \(9 missing\)/),
    ).toBeTruthy()
  })
})

describe('D2: the chart reads the three series the backend names', () => {
  it('draws one point per valid day for rain_day, tmax_day and tmin_day, with no line across a gap (R-21)', () => {
    const payload = recordedNumbersPayload()
    const series = payload.sections.climate.series
    const { container } = render(<ClimateChart series={series} />)

    for (const family of ['rain_day', 'tmax_day', 'tmin_day'] as const) {
      const group = container.querySelector<SVGGElement>(`[data-metric="${family}"]`)
      expect(group, family).not.toBeNull()
      const valid = series[family].filter((point) => point.value !== null).length
      expect(group?.querySelectorAll('circle'), family).toHaveLength(valid)
    }

    // 42 valid days give 41 consecutive pairs per temperature series, and every pair is a segment.
    expect(container.querySelectorAll('[data-metric="tmax_day"] path[data-segment]')).toHaveLength(41)
    expect(container.querySelectorAll('[data-metric="tmin_day"] path[data-segment]')).toHaveLength(41)
  })
})

describe('D3: the soil card reads the depth token and the g/kg keys of the payload', () => {
  it('prints the four properties of the three depths Table A names (R-31, AC-30)', () => {
    const payload = recordedNumbersPayload()
    const soil = payload.sections.soil
    const { container } = render(<SoilCard soil={soil} />)

    const rows = Array.from(container.querySelectorAll<HTMLElement>('tbody tr'))
    expect(rows).toHaveLength(soil.depths.length)

    soil.depths.forEach((depth, index) => {
      const cells = [
        { metric: `soil.clay.${depth.depth}`, value: depth.clay_g_kg },
        { metric: `soil.sand.${depth.depth}`, value: depth.sand_g_kg },
        { metric: `soil.ph.${depth.depth}`, value: depth.ph },
        { metric: `soil.soc.${depth.depth}`, value: depth.soc_g_kg },
      ]
      for (const cell of cells) {
        const node = rows[index].querySelector<HTMLElement>(`[data-metric="${cell.metric}"]`)
        expect(node, cell.metric).not.toBeNull()
        expect(node?.textContent).toContain(formatMetric(cell.metric, cell.value))
      }
    })
  })
})

describe('D4: the provenance table never puts a point list into a React child', () => {
  it('renders one row per provenance row and summarises a chart series as its point count (R-07)', () => {
    const payload = recordedNumbersPayload()
    const { container } = render(<ProvenanceTable rows={payload.provenance} />)

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-provenance-metric]'))
    expect(rows).toHaveLength(payload.provenance.length)

    for (const family of ['rain_day', 'tmax_day', 'tmin_day'] as const) {
      const row = container.querySelector<HTMLElement>(`[data-provenance-metric="${family}"]`)
      expect(row, family).not.toBeNull()
      const points = payload.sections.climate.series[family].length
      expect(row?.textContent).toContain(`${points} points`)
    }
  })
})

describe('D5: a rotation section whose crop lists are null abstains instead of indexing them', () => {
  it('prints the R-36 abstention text for the unavailable sidecar (R-36)', () => {
    const rotation = recordedNumbersPayload().sections.rotation
    expect(rotation.first_crop).toBeNull()
    expect(rotation.second_crop).toBeNull()

    render(<RotationCard rotation={rotation} />)
    expect(screen.getByText('no MapBiomas Collection 11 row for this polygon')).toBeTruthy()
  })
})

describe('Table E: the municipality state row (t_c9ad213a)', () => {
  it('prints the SIDRA state total labelled while the municipal row abstains (R-38, AC-37)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} />)
    await screen.findByText('Climate')

    const card = container.querySelector<HTMLElement>('[data-card="municipal"]')
    expect(card, 'municipal card').not.toBeNull()
    expect(card?.textContent).toContain('12,788,611')
    expect(card?.textContent).toContain('state total, not this field')
    expect(card?.textContent).toMatch(/IBGE municipal join is not built/)
    expect(card?.querySelector('[data-metric="state_soy_ha"]')).not.toBeNull()
  })
})

describe('the smoke test the four defects needed', () => {
  it('mounts the seven cards, the provenance table and the gap register from the recorded payload', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} />)
    await screen.findByText('Climate')

    expect(within(container.querySelector('.numbers-header') as HTMLElement).getByText(RECORDED_FIELD_ID)).toBeTruthy()

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-card]'))
    expect(cards.map((card) => card.dataset.card)).toEqual([
      'climate',
      'water',
      'smap',
      'ndvi',
      'soil',
      'rotation',
      'municipal',
    ])
    for (const card of cards) {
      expect(within(card).getByRole('heading', { level: 3 })).toBeTruthy()
    }

    expect(container.querySelectorAll('[data-provenance-metric]')).toHaveLength(payload.provenance.length)
    expect(container.querySelectorAll('[data-gap-index]')).toHaveLength(payload.gaps.length)
  })
})

describe('the climate resolution line the null payload never triggered (R-10, Table E)', () => {
  it('prints the resolution the section carries, from the recorded payload', () => {
    const payload = recordedNumbersPayload()
    expect(payload.sections.climate.resolution).toBe('0.5 degree cell')

    const { container } = render(<ClimateCard climate={payload.sections.climate} window={payload.query.window} />)
    expect(container.querySelector('.numbers-resolution')?.textContent).toBe('Resolution: 0.5 degree cell.')
  })
})

describe('the normals reader the unavailable payload broke (Table E, R-12)', () => {
  // Table E requires `normals` in every climate state. The unavailable section this route sends when
  // POWER is offline carries it with the reason; a payload from a build before that fix carries no key
  // at all, and the card must not dereference it.
  it('prints the abstain text with its reason and renders an older payload without the key', () => {
    const payload = recordedNumbersPayload()
    const unavailable: ClimateSection = {
      ...payload.sections.climate,
      state: 'unavailable',
      as_of: null,
      fetched_at: null,
      cached: false,
      error: 'ConnectError',
      window: null,
      // The wire shape of the unavailable section: no series families, no aggregates (the route sends `{}`).
      series: {} as ClimateSection['series'],
      aggregates: {},
      normals: { of_years: 0, excluded_years: [], error: 'ConnectError' },
    }

    expect(() => render(<ClimateCard climate={unavailable} window={payload.query.window} />)).not.toThrow()
    expect(screen.getAllByText(/Normals not computed: ConnectError\. Source: /).length).toBeGreaterThan(0)
    // The same section carries no series families, so the chart prints its empty text rather than throwing.
    expect(screen.getByText('No valid day in the window.')).toBeTruthy()

    // An older build's payload: the type says the key is there, the wire did not carry it.
    cleanup()
    const older = structuredClone(unavailable) as Partial<ClimateSection>
    delete older.normals
    expect(() => render(<ClimateCard climate={older as ClimateSection} window={payload.query.window} />)).not.toThrow()
    expect(screen.getAllByText(/Normals not computed: ConnectError\. Source: /).length).toBeGreaterThan(0)
  })
})

describe('the offline surface the route sends when POWER is unreachable (R-48, AC-47)', () => {
  it('mounts the whole surface from the captured offline payload and prints every card or its empty state', async () => {
    const payload = offlineNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} />)
    await screen.findByText('Climate')

    // The section states the capture carries, so a reader knows which wire shape this test renders.
    expect(
      Object.fromEntries(Object.entries(payload.sections).map(([name, section]) => [name, section.state])),
    ).toEqual({
      climate: 'unavailable',
      water_balance: 'unavailable',
      smap: 'abstained',
      ndvi: 'unavailable',
      soil: 'ok',
      rotation: 'unavailable',
      municipality: 'abstained',
      fragment: 'ok',
    })
    expect(payload.query.window).toEqual({
      start: null,
      end: null,
      days: null,
      valid_days: null,
      dropped_days: null,
    })
    expect(payload.sections.water_balance.window).toBeNull()

    // The seven cards the surface renders, each with its heading (the eight sections share one card per family).
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-card]'))
    expect(cards.map((card) => card.dataset.card)).toEqual([
      'climate',
      'water',
      'smap',
      'ndvi',
      'soil',
      'rotation',
      'municipal',
    ])
    for (const card of cards) {
      expect(within(card).getByRole('heading', { level: 3 })).toBeTruthy()
    }

    const card = (id: string) => container.querySelector<HTMLElement>(`[data-card="${id}"]`) as HTMLElement

    // The climate card abstains with the section reason, and its chart prints the empty text.
    // With no window the window line itself abstains: the text names the window and the source.
    expect(
      within(card('climate')).getByText(`Climate window not read: ConnectError. Source: ${payload.sections.climate.source}.`),
    ).toBeTruthy()
    expect(within(card('climate')).getAllByText(/Normals not computed: ConnectError\. Source: /).length).toBe(7)
    expect(within(card('climate')).getByText('No valid day in the window.')).toBeTruthy()

    // The water card has no window to print, so it prints the window abstention with the same
    // reason and no window line.
    expect(card('water').querySelector('.numbers-window')).toBeNull()
    expect(
      within(card('water')).getByText(`Water balance window not read: ConnectError. Source: ${payload.sections.water_balance.source}.`),
    ).toBeTruthy()

    // The remaining cards print their empty states from the reason the section carries. The merged
    // abstention copy names the gap cause and the source, so these hold the text to that shape.
    const smapText = card('smap').textContent ?? ''
    expect(smapText).toContain('SMAP palette not read')
    expect(smapText).toContain('palette ramp')
    expect(smapText).toContain(payload.sections.smap.source)
    expect(smapText).not.toContain('No value')
    const ndviText = card('ndvi').textContent ?? ''
    expect(ndviText).toContain('NDVI not plotted')
    // The card-level sentence names the count it could not read and the Earth Search source, carries
    // the cause the route itself sends in `error` (it outranks the gap register, which is the older
    // key), and keeps the two-scene rule instead of printing the placeholder value.
    expect(ndviText).toContain('the scene count was not read')
    expect(ndviText).toContain(payload.sections.ndvi.source)
    expect(ndviText).toContain(payload.sections.ndvi.error ?? 'no ndvi error')
    expect(ndviText).toContain('At least two scenes at or above 0.5 are needed.')
    expect(ndviText).not.toContain('No value')
    expect(within(card('rotation')).getByText('no MapBiomas Collection 11 row for this polygon')).toBeTruthy()
    const municipalText = card('municipal').textContent ?? ''
    expect(municipalText).toContain('Municipal value not read')
    expect(municipalText).toContain('municipality code is unresolved')
    expect(municipalText).toContain(payload.sections.municipality.source)
    expect(municipalText).not.toContain('No value')
    // The capture's municipality section omits `share` altogether (the route only sends one beside a
    // municipality row), so the share cell paints no number and no `null`. Giving that cell its own
    // abstention text is t_e60dd62e's card, which owns the abstention copy; this test only holds the
    // offline surface to rendering it without a crash and without a printed null.

    // The soil section is the one that reads ok offline, and it prints its own numbers.
    expect(
      within(card('soil')).getByText(formatMetric('soil.clay.0_5', payload.sections.soil.depths[0].clay_g_kg)),
    ).toBeTruthy()

    // The provenance table and the gap register still print the payload's own rows, one gap per section.
    expect(container.querySelectorAll('[data-provenance-metric]')).toHaveLength(payload.provenance.length)
    expect(container.querySelectorAll('[data-gap-index]')).toHaveLength(payload.gaps.length)
    expect(payload.gaps).toHaveLength(7)
  })

  it('prints no literal `null` token anywhere on the offline surface (AC-11 falsifier)', async () => {
    stubNumbersFetch(offlineNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} />)
    await screen.findByText('Climate')

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bnull\b/)
    // The header window fact has no window to print either, and it prints the empty text, not a date.
    expect(container.querySelector('.numbers-header')?.textContent).toContain('No value')
  })
})
