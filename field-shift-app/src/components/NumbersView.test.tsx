import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NumbersView } from './NumbersView'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { recordedNumbersPayload, RECORDED_FIELD_ID } from '@/test/numbers-recorded'
import { formatMetric, type NumbersPayload } from '@/lib/numbers'
import offlineCapture from '../../artifacts/block6/numbers-offline-payload.json'

/** The capture of the route with POWER unreachable (R-48, AC-47), as the offline surface sends it. */
const OFFLINE = offlineCapture as unknown as NumbersPayload

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

const CARD_NAMES = [
  'Climate',
  'Water balance',
  'Soil moisture, SMAP',
  'Vegetation, NDVI',
  'Soil',
  'Rotation history',
  'Municipal context',
]

/** Every element of the surface that carries a printed number's metric id (R-07). */
function printedMetrics(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-metric]')).map((node) => node.dataset.metric ?? '')
}

/**
 * The body of one exact rule of `NumbersView.css`. jsdom has no layout, so the header's width
 * contract is pinned here as the stylesheet text a browser applies; the measured widths at 360
 * are the browser evidence of the same rule.
 */
function styleRule(selector: string): string {
  // A `?raw` import of a stylesheet reads empty under this suite's CSS handling, and
  // `import.meta.url` is not a file URL here, so the source is read from the vitest root instead.
  const css = readFileSync(join(process.cwd(), 'src', 'components', 'NumbersView.css'), 'utf8')
  const at = css.indexOf(`\n${selector} {`)
  if (at < 0) return ''
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function stubNumbersFetch(payload: NumbersPayload | (() => Promise<Response>)) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/numbers') && init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      if (typeof payload === 'function') return payload()
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => null } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, bodies }
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

describe('the Field numbers region (R-01, R-03, R-05, AC-01, AC-03, AC-04)', () => {
  it('mounts exactly one region named Field numbers with a level two heading of that text', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    const regions = screen.getAllByRole('region', { name: 'Field numbers' })
    expect(regions).toHaveLength(1)
    expect(within(regions[0]).getByRole('heading', { level: 2, name: 'Field numbers' })).toBeTruthy()
    await screen.findByText('Climate')
  })

  it('prints the raw field id in the header with no basis label, and the window with the climate basis', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const header = container.querySelector('.numbers-header') as HTMLElement
    expect(header).not.toBeNull()
    const idNode = within(header).getByText(RECORDED_FIELD_ID)
    // The id is an identifier and carries no basis chip (R-03).
    expect(idNode.querySelector('[data-basis]')).toBeNull()
    expect(idNode.closest('[data-basis]')).toBeNull()
    expect(within(header).getByText('2026-10-01 to 2026-11-11')).toBeTruthy()
    expect(within(header).getByText('2026-11-12')).toBeTruthy()
    expect(within(header).getByText('entered')).toBeTruthy()
  })

  it('prints the empty state and no section, number or gap row when no field is selected (AC-03)', () => {
    stubNumbersFetch(recordedNumbersPayload())
    useMapStore.setState({ selectedFieldId: null })
    render(<NumbersView selectedField={null} onClose={vi.fn()} />)
    expect(screen.getByText('No field selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to map' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    expect(printedMetrics()).toEqual([])
    expect(screen.queryByText('Gap register')).toBeNull()
  })

  it('moves focus to Back to map on open and closes on Enter and on Space (R-05, AC-04)', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const onClose = vi.fn()
    render(<NumbersView selectedField={field} onClose={onClose} />)
    const back = screen.getByRole('button', { name: 'Back to map' })
    expect(document.activeElement).toBe(back)
    const user = userEvent.setup()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('the seven data cards (R-13, R-12, AC-12)', () => {
  it('prints the seven card headings in the frozen order, each with a source line carrying source, as_of and basis', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const headings = Array.from(document.querySelectorAll('[data-card] > h3')).map((node) => node.textContent)
    expect(headings).toEqual(CARD_NAMES)
    const sourceLines = Array.from(document.querySelectorAll<HTMLElement>('[data-source-line]'))
    expect(sourceLines).toHaveLength(7)
    for (const line of sourceLines) {
      expect(line.textContent).toMatch(/Source: /)
      // R-13: the as_of is a date, or the words `not read` where the section holds no read date.
      expect(line.textContent).toMatch(/As of (\d{4}-\d{2}-\d{2}|not read)/)
      expect(line.textContent).toMatch(/Basis: (modelled|retrieved|entered|observed)/)
    }
  })

  it('abstains with the spec text on NDVI and rotation instead of a placeholder value (R-12, R-29, R-36)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const rotation = container.querySelector('[data-card="rotation"]') as HTMLElement
    expect(within(rotation).getByText('no MapBiomas Collection 11 row for this polygon')).toBeTruthy()
    // The scene count is the payload's own, because the abstention text names what was read.
    expect(
      screen.getByText(new RegExp(`NDVI not plotted: ${payload.sections.ndvi.scene_count} scenes below 20 percent cloud`)),
    ).toBeTruthy()
  })
})

describe('climate, water balance, SMAP and NDVI (R-16 to R-30)', () => {
  it('prints the chart with one point per valid day for rain, T2M_MAX and T2M_MIN (R-21, AC-20)', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    for (const family of ['rain_day', 'tmax_day', 'tmin_day']) {
      const group = container.querySelector(`[data-metric="${family}"]`)
      expect(group).not.toBeNull()
      expect(group?.querySelectorAll('circle')).toHaveLength(42)
    }
  })

  it('draws no line across a day without a value (R-21)', async () => {
    const payload = recordedNumbersPayload()
    const tmax = payload.sections.climate.series.tmax_day.map((point, index) => (index === 20 ? { ...point, value: null } : point))
    const tmin = payload.sections.climate.series.tmin_day.map((point, index) => (index === 20 ? { ...point, value: null } : point))
    stubNumbersFetch({
      ...payload,
      sections: { ...payload.sections, climate: { ...payload.sections.climate, series: { ...payload.sections.climate.series, tmax_day: tmax, tmin_day: tmin } } },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const tmaxGroup = container.querySelector('[data-metric="tmax_day"]')
    expect(tmaxGroup?.querySelectorAll('circle')).toHaveLength(41)
    // A run of 20 valid days before day 20 has 19 segments, and a run of 21 after it has 20: 39 in total.
    const segments = tmaxGroup?.querySelectorAll('path[data-segment]') ?? []
    expect(segments).toHaveLength(39)
    for (const segment of Array.from(segments)) {
      const d = segment.getAttribute('d') ?? ''
      expect(d.startsWith('M')).toBe(true)
    }
  })

  it('prints exactly three millimetre numbers in the water balance, with the EVLAND statement beside out (R-22, R-24, AC-21, AC-23)', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const card = container.querySelector('[data-card="water"]') as HTMLElement
    expect(card).not.toBeNull()
    const values = Array.from(card.querySelectorAll<HTMLElement>('[data-metric]')).map((node) => node.textContent?.replace(/\s*mm$/, ''))
    expect(values).toEqual(['171.9', '124.8', '47.1'])
    expect(within(card).getByText('remaining = in - out')).toBeTruthy()
    expect(within(card).getByText('out, POWER EVLAND, land surface evaporation')).toBeTruthy()
    expect(within(card).getByText('This is not a crop water demand. No reference evapotranspiration is used.')).toBeTruthy()
    expect(within(card).getByText(/estimate built from modelled fluxes/)).toBeTruthy()
  })

  it('abstains the whole balance when a window day lacks EVLAND (R-23, AC-22)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch({
      ...payload,
      sections: {
        ...payload.sections,
        water_balance: {
          ...payload.sections.water_balance,
          state: 'abstained',
          in: null,
          out: null,
          remaining: null,
          missing: { parameter: 'EVLAND', days: 1 },
        },
      },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const card = container.querySelector('[data-card="water"]') as HTMLElement
    expect(within(card).getByText(/EVLAND is missing on 1 window days/)).toBeTruthy()
    expect(card.querySelectorAll('[data-metric]')).toHaveLength(3)
    expect(Array.from(card.querySelectorAll('[data-metric]')).every((node) => node.textContent === 'not computed')).toBe(true)
  })

  it('prints the SMAP disclosure and no physical unit, and the NDVI counts (R-25, R-30, AC-24, AC-29)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const smap = container.querySelector('[data-card="smap"]') as HTMLElement
    expect(within(smap).getByText('palette, not a physical unit', { exact: false })).toBeTruthy()
    expect(within(smap).getByText(/0 to 100 percent/)).toBeTruthy()
    expect(within(smap).getByText(/8,100 ha/)).toBeTruthy()
    expect(within(smap).getByText(/about 88 of the 900 polygons/)).toBeTruthy()
    expect(smap.textContent).not.toMatch(/m3\/m3|m³\/m³|volumetric|wetness index/i)
    const ndvi = container.querySelector('[data-card="ndvi"]') as HTMLElement
    const counts = payload.sections.ndvi
    expect(within(ndvi).getByText(String(counts.scene_count))).toBeTruthy()
    expect(within(ndvi).getByText(String(counts.clear_count))).toBeTruthy()
    expect(ndvi.textContent).toMatch(/Sentinel-2 L2A, collection sentinel-2-l2a, assets B04, B08 and SCL/)
    expect(ndvi.textContent).not.toMatch(/MODIS/)
  })
})

describe('provenance, gap register and the disclosure (R-07, R-08, R-41, R-42, R-44, AC-06, AC-41)', () => {
  it('prints each printed metric id once, only ids the payload carries, and every row of the payload (AC-06)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const printed = printedMetrics()
    expect(new Set(printed).size).toBe(printed.length)
    const carried = payload.provenance.map((row) => row.metric)
    // The surface invents no metric id: every id it prints is a row of the payload.
    expect(printed.filter((metric) => !carried.includes(metric))).toEqual([])
    // And every row of the payload has its printed number or abstention: the two directions of
    // AC-06 together are one set equality, so no row is left without a cell of its own.
    const unprinted = carried.filter((metric) => !printed.includes(metric)).sort()
    expect(unprinted).toEqual([])
    // The whole criterion in one line: the DOM ids and the payload metrics are the same multiset.
    expect(printed.slice().sort()).toEqual(carried.slice().sort())
    for (const row of payload.provenance) {
      for (const key of ['metric', 'label', 'value', 'unit', 'basis', 'as_of', 'source', 'resolution', 'route', 'fetched_at'] as const) {
        expect(Object.hasOwn(row, key)).toBe(true)
      }
    }
  })

  it('prints the header area and ring area cells with their metric ids (R-03, R-07, AC-03, AC-06)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const header = container.querySelector('.numbers-header') as HTMLElement
    // A fixture field carries no block 5 area source, so the area row abstains in the header.
    const area = header.querySelector<HTMLElement>('[data-metric="area"]')
    expect(area).not.toBeNull()
    expect(area?.textContent).toBe('No area source for this field')
    // The ring the request carries has a real spherical area, printed with its own row.
    const row = payload.provenance.find((entry) => entry.metric === 'ring_area')
    const ring = header.querySelector<HTMLElement>('[data-metric="ring_area"]')
    expect(ring).not.toBeNull()
    expect(ring?.textContent).toBe(`${formatMetric('ring_area', row?.value as number)} ha`)
    expect(ring?.closest('.numbers-cell')?.querySelector('[data-basis]')?.textContent).toBe('retrieved')
  })

  it('lets the Area fact wrap, so the area value prints in full and the ring area keeps its own line (R-03, AC-03)', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const header = container.querySelector('.numbers-header') as HTMLElement
    const area = header.querySelector<HTMLElement>('[data-metric="area"]')
    const ring = header.querySelector<HTMLElement>('[data-metric="ring_area"]')
    const fact = area?.closest('.numbers-header-fact') as HTMLElement | null
    // The Area fact is the one fact with three cells, so it is the one that opts into wrapping.
    expect(fact?.classList.contains('numbers-header-fact-area')).toBe(true)
    // R-07: both rows are cells of the same fact, so R-03's four header values keep their places.
    expect(ring?.closest('dd')).toBe(area?.closest('dd'))
    // The rule that used to ellipsize the area value no longer reaches it; the fact wraps instead.
    expect(styleRule('.numbers-header-fact-area dd')).toMatch(/flex-wrap:\s*wrap/)
    const areaValueRule = styleRule('.numbers-header-fact-area dd > span:first-child')
    expect(areaValueRule).toMatch(/white-space:\s*normal/)
    expect(areaValueRule).not.toMatch(/text-overflow:\s*ellipsis/)
  })

  it('prints the two SMAP family rows as abstentions when the series has no day (R-07, R-12, AC-06)', async () => {
    const payload = recordedNumbersPayload()
    expect(payload.sections.smap.days).toEqual([])
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const smap = container.querySelector('[data-card="smap"]') as HTMLElement
    for (const metric of ['smap_surface', 'smap_rootzone']) {
      const cell = smap.querySelector<HTMLElement>(`[data-metric="${metric}"]`)
      expect(cell, metric).not.toBeNull()
      expect(cell?.textContent).toBe('palette not read')
    }
  })

  it('prints the two NDVI family rows as abstentions when no point is plotted (R-07, R-12, AC-06)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const ndvi = container.querySelector('[data-card="ndvi"]') as HTMLElement
    for (const metric of ['ndvi_mean', 'ndvi_valid_fraction']) {
      const cell = ndvi.querySelector<HTMLElement>(`[data-metric="${metric}"]`)
      expect(cell, metric).not.toBeNull()
      expect(cell?.textContent).toBe('not plotted')
    }
  })

  // Revision 3 of the block 6 spec names the state total `state_row`, so with the recorded payload the
  // municipal row abstains while the state row prints the SIDRA total with its own label. These two
  // facts are asserted separately, because printing the total is not an abstention.
  it('prints the municipal row as an abstention and the state row as the labelled total (R-07, R-12, R-38, AC-06, AC-37)', async () => {
    const payload = recordedNumbersPayload()
    expect(payload.sections.municipality.municipality).toBeNull()
    expect(payload.sections.municipality.state_row?.soy_ha).toBe(12788611)
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const municipal = container.querySelector('[data-card="municipal"]') as HTMLElement
    const municipalCell = municipal.querySelector<HTMLElement>('[data-metric="municipality_soy_ha"]')
    expect(municipalCell).not.toBeNull()
    expect(municipalCell?.textContent).toMatch(/^Municipal value not read: /)
    const stateCell = municipal.querySelector<HTMLElement>('[data-metric="state_soy_ha"]')
    expect(stateCell).not.toBeNull()
    expect(stateCell?.textContent).toContain('12,788,611')
    expect(municipal.textContent).toContain('state total, not this field')
  })

  it('renders each provenance row in the table with its basis label (R-08, AC-07)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-provenance-metric]'))
    expect(rows).toHaveLength(payload.provenance.length)
    for (const rowNode of rows) {
      const metric = rowNode.dataset.provenanceMetric
      const row = payload.provenance.find((entry) => entry.metric === metric)
      const chip = rowNode.querySelector<HTMLElement>('[data-basis]')
      expect(chip?.dataset.basis).toBe(row?.basis)
      if (row?.basis === 'modelled') expect(chip?.textContent).toBe('modelled')
    }
  })

  it('prints one gap row per payload gap, in the payload order, each once (R-41, R-42, AC-41)', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-gap-index]'))
    expect(rows).toHaveLength(payload.gaps.length)
    rows.forEach((node, index) => {
      expect(node.dataset.gapIndex).toBe(String(index))
      expect(node.textContent).toContain(payload.gaps[index].cause)
      expect(node.textContent).toContain(payload.gaps[index].section)
    })
  })

  it('prints the empty text and no row when the payload has no gap (R-41)', async () => {
    const payload = { ...recordedNumbersPayload(), gaps: [] }
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    expect(container.querySelectorAll('[data-gap-index]')).toHaveLength(0)
    expect(screen.getByText('No gaps. Every number of this field has its source.')).toBeTruthy()
  })

  it('prints the palette disclosure beside the SMAP route 1 values (R-44, AC-43)', async () => {
    stubNumbersFetch(recordedNumbersPayload())
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const smap = container.querySelector('[data-card="smap"]') as HTMLElement
    expect(within(smap).getByText(/palette of the served image, not the physical unit/)).toBeTruthy()
  })
})

describe('the request and the states (R-45, R-06, R-48, AC-05, AC-47)', () => {
  it('sends the Table B body for a fixture field: its ring, centroid, a null area and the chosen date', async () => {
    const { bodies } = stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({
      ring: field.boundary.coordinates[0],
      centroid: [-55.27, -11.91],
      area_ha: null,
      date: '2026-11-12',
    })
  })

  it('keeps the open state, the field, the payload and the window through a real resize, with no new request (R-06, AC-05)', async () => {
    const { fetchMock } = stubNumbersFetch(recordedNumbersPayload())
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const before = document.querySelector('[data-numbers-view]')?.textContent
    const region = screen.getByRole('region', { name: 'Field numbers' })
    // jsdom has no layout, so the offset is a plain property here; the browser run measures the real one.
    Object.defineProperty(region, 'scrollTop', { configurable: true, writable: true, value: 120 })
    for (const width of [780, 360, 1440]) {
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
        window.dispatchEvent(new Event('resize'))
      })
      expect(screen.getByRole('region', { name: 'Field numbers' })).toBe(region)
      expect(document.querySelector('[data-numbers-view]')?.textContent).toBe(before)
      expect(screen.getByRole('heading', { level: 2, name: 'Field numbers' })).toBeTruthy()
      expect(region.scrollTop).toBe(120)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers a network failure with the last read values marked, and never a fixture value (R-48, AC-47)', async () => {
    const payload = recordedNumbersPayload()
    useMapStore.setState({ numbersLastRead: { [`${field.id}|2026-11-12`]: payload } })
    stubNumbersFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    expect(await screen.findByText('last read 2026-11-15')).toBeTruthy()
    expect(screen.getByText('Numbers service unreachable. Check your connection and retry.')).toBeTruthy()
    expect(screen.getAllByText('171.9').length).toBeGreaterThan(0)
  })

  it('prints the offline text and no value when nothing is held (R-48)', async () => {
    stubNumbersFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    expect(await screen.findByText('No value held for this field and window.')).toBeTruthy()
    expect(printedMetrics()).toEqual([])
  })

  it('prints the HTTP status on a non 200 answer (R-46)', async () => {
    stubNumbersFetch(() => Promise.resolve({ ok: false, status: 422, json: async () => null } as unknown as Response))
    render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    expect(await screen.findByText('Numbers request failed (HTTP 422). Retry when the service is available.')).toBeTruthy()
  })
})

describe('a selected polygon (R-03, R-49, Table B, AC-50)', () => {
  const usRing: [number, number][] = [[-97.2, 46.9], [-97.19, 46.9], [-97.19, 46.91], [-97.2, 46.91], [-97.2, 46.9]]

  it('prints the raw id, the block 5 class and area with the retrieved label, and sends the outline with an interior point', async () => {
    const { bodies } = stubNumbersFetch(recordedNumbersPayload())
    useMapStore.setState({
      regionId: 'us',
      selectedFieldId: null,
      selectedPolygonId: '381825001868504',
      polygonRaw: { classValue: 5, area: 153.18667449 },
      polygonRing: usRing,
      chosenDate: '2026-11-12',
    })
    const { container } = render(<NumbersView selectedField={null} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const header = container.querySelector('.numbers-header') as HTMLElement
    expect(within(header).getByText('csb:381825001868504')).toBeTruthy()
    expect(within(header).getByText('Soybeans')).toBeTruthy()
    expect(within(header).getByText('153.2 acres')).toBeTruthy()
    // The class and the area come from block 5's own readout; the outline area is the `ring_area`
    // row the header prints beside them (R-07). All three are `retrieved`.
    const retrieved = within(header).getAllByText('retrieved')
    expect(retrieved).toHaveLength(3)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].ring).toEqual(usRing)
    expect(bodies[0].area_ha).toBeNull()
    expect(bodies[0].date).toBe('2026-11-12')
    const [cx, cy] = bodies[0].centroid as [number, number]
    expect(cx).toBeCloseTo(-97.195, 6)
    expect(cy).toBeCloseTo(46.905, 6)
  })

  it('abstains with the outline text and sends no request when the map has not rendered the outline', async () => {
    const { fetchMock } = stubNumbersFetch(recordedNumbersPayload())
    useMapStore.setState({ regionId: 'us', selectedFieldId: null, selectedPolygonId: '381825001868504', polygonRing: null })
    render(<NumbersView selectedField={null} onClose={vi.fn()} />)
    expect(screen.getByText('Polygon outline not read yet. Select the polygon on the map.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * R-12, AC-11: an abstained row names the missing input, its source and its cause. The payload's
 * section `error` is the cause when the route sends one, then the older `reason` key; otherwise the
 * cause is the section's own gap row, which is where the route records why the input is missing.
 */
describe('abstention texts name the missing input, its source and its cause (R-12, AC-11)', () => {
  function cellText(container: HTMLElement, metric: string): string {
    return container.querySelector<HTMLElement>(`[data-metric="${metric}"]`)?.textContent ?? ''
  }

  /** The window line's abstention: the paragraph a card prints when the payload carries no window. */
  function windowAbstainText(container: HTMLElement, card: 'climate' | 'water'): string {
    return container.querySelector<HTMLElement>(`[data-card="${card}"] [data-window-abstain]`)?.textContent ?? ''
  }

  function gapCause(payload: NumbersPayload, section: string, needle: string): string {
    const gap = payload.gaps.find((entry) => entry.section === section && entry.cause.includes(needle))
    expect(gap, `${section} gap whose cause contains ${needle}`).toBeDefined()
    return gap?.cause ?? ''
  }

  /** The card-level NDVI sentence: the paragraph that states the count and the two-scene rule. */
  function ndviCardSentence(container: HTMLElement): string {
    return container.querySelector<HTMLElement>('[data-card="ndvi"] [data-abstain-sentence="ndvi"]')?.textContent ?? ''
  }

  it('prints the SMAP abstention with the palette source and the SMAP gap cause', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const smap = container.querySelector('[data-card="smap"]') as HTMLElement
    const text = smap.querySelector('p.numbers-abstain')?.textContent ?? ''
    expect(text).toContain('SMAP palette not read')
    expect(text).toContain(payload.sections.smap.source)
    expect(text).toContain(gapCause(payload, 'smap', 'palette ramp'))
    expect(text).not.toContain('No value')
  })

  it('prints the municipal abstention with the SIDRA source and the municipal gap cause', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'municipality_soy_ha')
    expect(text).toContain('Municipal value not read')
    expect(text).toContain(payload.sections.municipality.source)
    expect(text).toContain(gapCause(payload, 'municipality', 'municipality code'))
    expect(text).not.toContain('No value')
  })

  it('prints the share abstention with the SIDRA source and the municipal gap cause', async () => {
    const payload = recordedNumbersPayload()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'polygon_share')
    expect(text).toContain('Share not computed')
    expect(text).toContain(payload.sections.municipality.source)
    expect(text).toContain(gapCause(payload, 'municipality', 'municipality code'))
    expect(text).not.toContain('No value')
  })

  it('prints the state abstention with the SIDRA source and the state gap cause, not the municipal one', async () => {
    const payload = recordedNumbersPayload()
    // The recorded payload now carries the state total, so this test builds the case the clause is
    // about: no state total and a state gap in the register, which the fixture no longer produces.
    const municipalGap = payload.gaps.find((gap) => gap.section === 'municipality')!
    const stateGap = { ...municipalGap, cause: 'state code is unresolved for this field: the IBGE state lookup returned no row' }
    const payloadWithStateGap = {
      ...payload,
      gaps: [...payload.gaps, stateGap],
      sections: {
        ...payload.sections,
        municipality: { ...payload.sections.municipality, state_row: null, state_reason: null },
      },
    }
    stubNumbersFetch(payloadWithStateGap)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'state_soy_ha')
    expect(text).toContain('State value not read')
    expect(text).toContain(payload.sections.municipality.source)
    expect(text).toContain(gapCause(payloadWithStateGap, 'municipality', 'state code'))
    expect(text).not.toContain(gapCause(payloadWithStateGap, 'municipality', 'municipality code'))
    expect(text).not.toContain('No value')
  })

  it('prints the section reason ahead of the gap cause when the payload sends one', async () => {
    const payload = recordedNumbersPayload()
    const reason = 'the SIDRA municipal request answered with no row for this code'
    stubNumbersFetch({
      ...payload,
      sections: {
        ...payload.sections,
        municipality: {
          ...payload.sections.municipality,
          reason,
          // The state row reads its own reason field, so an explicit section reason reaches it too.
          state_reason: reason,
          state_row: null,
        },
      },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const rows = [
      ['municipality_soy_ha', 'Municipal value not read'],
      ['state_soy_ha', 'State value not read'],
      ['polygon_share', 'Share not computed'],
    ] as const
    for (const [metric, label] of rows) {
      const text = cellText(container, metric)
      expect(text, metric).toContain(label)
      expect(text, metric).toContain(reason)
      expect(text, metric).toContain(payload.sections.municipality.source)
      expect(text, metric).not.toContain('municipality code is unresolved')
    }
  })

  /**
   * Option 1 of the section cause: `error` is the field the route writes when it could not read a
   * section, and it is the cause the row prints. Each payload below deletes every gap row of the
   * section, so the section field is the only cause the payload records and the not-recorded
   * sentence would be false. NDVI and the municipality are the captured and recorded shapes; SMAP
   * reads no network source in wave 1, so its payload is the shape `_unavailable` writes once that
   * read lands.
   */
  it('prints the SMAP section error, not the not-recorded sentence, when the payload carries no SMAP gap row', async () => {
    const payload = recordedNumbersPayload()
    const failure = 'the SMAP palette proxy answered 503'
    payload.sections.smap = { ...payload.sections.smap, error: failure }
    payload.gaps = payload.gaps.filter((gap) => gap.section !== 'smap')
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const smap = container.querySelector('[data-card="smap"]') as HTMLElement
    const text = smap.querySelector('p.numbers-abstain')?.textContent ?? ''
    expect(text).toContain(failure)
    expect(text).toContain(payload.sections.smap.source)
    expect(text).not.toContain('the reason was not recorded')
    expect(text).not.toContain('No value')
  })

  it('prints the NDVI section error, not the not-recorded sentence, when the payload carries no NDVI gap row', async () => {
    // The offline capture is the real shape the route sends: the NDVI section carries `error` and
    // never `reason`. Deleting its gap row leaves the section error as the only cause.
    const failure = 'search window unknown: climate source unavailable'
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.ndvi.error).toBe(failure)
    payload.gaps = payload.gaps.filter((gap) => gap.section !== 'ndvi')
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    for (const metric of ['ndvi_scene_count', 'ndvi_clear_count'] as const) {
      const text = cellText(container, metric)
      expect(text, metric).toContain(failure)
      expect(text, metric).toContain(payload.sections.ndvi.source)
      expect(text, metric).not.toContain('the reason was not recorded')
      expect(text, metric).not.toContain('No value')
    }
  })

  it('prints the municipality section error, not the not-recorded sentence, when the payload carries no municipal gap row', async () => {
    const payload = recordedNumbersPayload()
    const failure = 'malformed SIDRA response'
    payload.sections.municipality = {
      ...payload.sections.municipality,
      reason: null,
      error: failure,
    }
    payload.gaps = payload.gaps.filter((gap) => gap.section !== 'municipality')
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    for (const metric of ['municipality_soy_ha', 'polygon_share'] as const) {
      const text = cellText(container, metric)
      expect(text, metric).toContain(failure)
      expect(text, metric).toContain(payload.sections.municipality.source)
      expect(text, metric).not.toContain('the reason was not recorded')
      expect(text, metric).not.toContain('No value')
    }
  })

  it('names the normals input and source and says the reason was not recorded when neither carries one', async () => {
    const payload = recordedNumbersPayload()
    const normals = { ...payload.sections.climate.normals }
    for (const key of ['rain_median', 'rain_min', 'rain_max', 'rain_rank', 'rain_percentile', 'hot_days', 'hot_days_median'] as const) {
      normals[key] = { value: null }
    }
    delete normals.error
    stubNumbersFetch({
      ...payload,
      sections: { ...payload.sections, climate: { ...payload.sections.climate, error: null, normals } },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'rain_median')
    expect(text).toContain('Normals not computed')
    expect(text).toContain(payload.sections.climate.source)
    expect(text).toContain('the reason was not recorded')
    expect(text).not.toContain('No value')
  })

  it('names the missing aggregate input and the POWER source when the section carries no aggregate object (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.climate.aggregates).toEqual({})
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const rows = [
      ['rain_total', 'PRECTOTCORR'],
      ['gdd10', 'T2M_MAX and T2M_MIN'],
      ['gwetroot_mean', 'GWETROOT'],
    ] as const
    for (const [metric, input] of rows) {
      const text = cellText(container, metric)
      expect(text, metric).toContain('Not computed')
      expect(text, metric).toContain(input)
      expect(text, metric).toContain(payload.sections.climate.source)
      expect(text, metric).toContain('ConnectError')
      expect(text, metric).not.toContain('No value')
    }
  })

  it('says the reason was not recorded for an absent aggregate, and still names its input and source (R-12, AC-11)', async () => {
    const payload = recordedNumbersPayload()
    const climate = { ...payload.sections.climate, aggregates: {}, error: null }
    stubNumbersFetch({
      ...payload,
      gaps: payload.gaps.filter((gap) => gap.section !== 'climate'),
      sections: { ...payload.sections, climate },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'gdd10')
    expect(text).toContain('T2M_MAX and T2M_MIN')
    expect(text).toContain('the reason was not recorded')
    expect(text).toContain(climate.source)
    expect(text).not.toContain('No value')
  })

  // R-16 and R-22 ask for the window line. With no window the missing input IS the window, so the
  // text names the window and the section source, with the section error or the section gap cause,
  // or the sentence that says the reason was not recorded (R-12, AC-11).
  it('names the climate window and the POWER source when the capture carries no window (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.climate.window).toBeNull()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = windowAbstainText(container, 'climate')
    expect(text).toContain('Climate window not read')
    expect(text).toContain(payload.sections.climate.source)
    expect(text).toContain('ConnectError')
    expect(text).not.toContain('No value')
  })

  it('names the water balance window and the POWER source when the capture carries no window (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.water_balance.window).toBeNull()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = windowAbstainText(container, 'water')
    expect(text).toContain('Water balance window not read')
    expect(text).toContain(payload.sections.water_balance.source)
    expect(text).toContain('ConnectError')
    expect(text).not.toContain('No value')
  })

  it('says the reason was not recorded for the climate window, and still names the window and the source (R-12, AC-11)', async () => {
    const payload = recordedNumbersPayload()
    const climate = { ...payload.sections.climate, window: null, error: null }
    stubNumbersFetch({
      ...payload,
      query: { ...payload.query, window: { start: null, end: null, days: null, valid_days: null, dropped_days: null } },
      gaps: payload.gaps.filter((gap) => gap.section !== 'climate'),
      sections: { ...payload.sections, climate },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = windowAbstainText(container, 'climate')
    expect(text).toContain('Climate window not read')
    expect(text).toContain('the reason was not recorded')
    expect(text).toContain(climate.source)
    expect(text).not.toContain('No value')
  })

  it('says the reason was not recorded for the water balance window, and still names the window and the source (R-12, AC-11)', async () => {
    const payload = recordedNumbersPayload()
    expect(payload.gaps.some((gap) => gap.section === 'water_balance')).toBe(false)
    const water = { ...payload.sections.water_balance, window: null, error: null, missing: null }
    stubNumbersFetch({
      ...payload,
      sections: { ...payload.sections, water_balance: water },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = windowAbstainText(container, 'water')
    expect(text).toContain('Water balance window not read')
    expect(text).toContain('the reason was not recorded')
    expect(text).toContain(water.source)
    expect(text).not.toContain('No value')
  })

  it('names the NDVI scene count, the Earth Search source and the section error when the capture sends a null count (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.ndvi.scene_count).toBeNull()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'ndvi_scene_count')
    expect(text).toContain('NDVI scene count not read')
    expect(text).toContain(payload.sections.ndvi.source)
    // The capture carries `error` and no `reason`, so the route's own error is the cause the row prints.
    expect(payload.sections.ndvi.error).toBe('search window unknown: climate source unavailable')
    expect(text).toContain('search window unknown: climate source unavailable')
    expect(text).not.toContain('No value')
  })

  it('names the NDVI clear scene count, the Earth Search source and the section error when the capture sends a null count (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.ndvi.clear_count).toBeNull()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'ndvi_clear_count')
    expect(text).toContain('NDVI clear scene count not read')
    expect(text).toContain(payload.sections.ndvi.source)
    expect(payload.sections.ndvi.error).toBe('search window unknown: climate source unavailable')
    expect(text).toContain('search window unknown: climate source unavailable')
    expect(text).not.toContain('No value')
  })

  it('says the reason was not recorded for the NDVI scene count, and still names its input and source (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    delete (payload.sections.ndvi as { error?: string | null }).error
    payload.gaps = payload.gaps.filter((gap) => gap.section !== 'ndvi')
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    for (const metric of ['ndvi_scene_count', 'ndvi_clear_count']) {
      const text = cellText(container, metric)
      expect(text, metric).toContain('NDVI')
      expect(text, metric).toContain('the reason was not recorded')
      expect(text, metric).toContain(payload.sections.ndvi.source)
      expect(text, metric).not.toContain('No value')
    }
  })

  it('names the scene count and the Earth Search source in the card-level NDVI sentence when the count was not read (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    expect(payload.sections.ndvi.scene_count).toBeNull()
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = ndviCardSentence(container)
    expect(text).toContain('scene count')
    expect(text).toContain(payload.sections.ndvi.source)
    // The route writes the cause in `error`, and that key outranks the gap register, so the sentence
    // carries the section error here; the gap cause is the fallback when no error is sent.
    expect(text).toContain(payload.sections.ndvi.error ?? 'no ndvi error')
    // The rule the sentence states stays, because it is what the reader needs to act on.
    expect(text).toContain('At least two scenes at or above 0.5 are needed.')
    expect(text).not.toContain('No value')
  })

  it('says the reason was not recorded in the card-level NDVI sentence when neither the payload nor the register carries one (R-12, AC-11)', async () => {
    const payload = structuredClone(OFFLINE)
    delete (payload.sections.ndvi as { error?: string | null }).error
    payload.gaps = payload.gaps.filter((gap) => gap.section !== 'ndvi')
    stubNumbersFetch(payload)
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = ndviCardSentence(container)
    expect(text).toContain('scene count')
    expect(text).toContain('the reason was not recorded in the payload or the gap register')
    expect(text).toContain(payload.sections.ndvi.source)
    expect(text).toContain('At least two scenes at or above 0.5 are needed.')
    expect(text).not.toContain('No value')
  })

  it('fails the state cause closed to the not-recorded sentence when the register carries no state gap (R-12, AC-11)', async () => {
    const payload = recordedNumbersPayload()
    const gaps = payload.gaps.filter((gap) => !gap.cause.startsWith('state code'))
    expect(gaps.some((gap) => gap.section === 'municipality' && gap.cause.includes('municipality code'))).toBe(true)
    expect(gaps.some((gap) => gap.section === 'municipality' && gap.cause.includes('state code'))).toBe(false)
    stubNumbersFetch({
      ...payload,
      gaps,
      sections: { ...payload.sections, municipality: { ...payload.sections.municipality, state_row: null } },
    })
    const { container } = render(<NumbersView selectedField={field} onClose={vi.fn()} />)
    await screen.findByText('Climate')
    const text = cellText(container, 'state_soy_ha')
    expect(text).toContain('State value not read')
    expect(text).toContain('the reason was not recorded')
    expect(text).toContain(payload.sections.municipality.source)
    // The municipal cause belongs to the municipal row, not to the state row.
    expect(text).not.toContain('municipality code is unresolved')
    expect(cellText(container, 'municipality_soy_ha')).toContain('municipality code is unresolved')
  })
})
