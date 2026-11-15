import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecisionView } from './DecisionView'
import { calendarRows, type SeasonlessPayload, type ZarcWindowRow } from '@/lib/planting-calendar'
import type { HistoryRow } from '@/lib/producer-store'
import { recordedNumbersPayload } from '@/test/numbers-recorded'
import type { NumbersPayload } from '@/lib/numbers'
import snapshot from '../../artifacts/zarc-mt-snapshot.json'
import usWindows from '../../artifacts/us-windows-cass-nd.json'

/**
 * The block 6 route is stubbed at its module boundary: the surface's job is what it prints for a
 * payload, and `contextFrom` itself is covered against the recorded payload in the lib test.
 */
const numbersStub = vi.hoisted(() => ({ payload: null as unknown }))
vi.mock('@/lib/numbers-api', () => ({
  NumbersHttpError: class NumbersHttpError extends Error {},
  NumbersNetworkError: class NumbersNetworkError extends Error {},
  fetchNumbers: async () => numbersStub.payload,
}))

/** The recorded Brazil window source, the same object block 4's band holds. */
const ROWS = snapshot.rows as unknown as ZarcWindowRow[]
const PLACE = { municipality: 'Santa Carmem', uf: 'MT' }
/** R-31's season of the chosen date: 1 July to 30 June, so 2026-11-12 sits in 2026/27. */
const SEASON = '2026/27'
const FIELD = { fieldId: 'mt-santa-carmem-01', ring: [[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]] as Array<[number, number]>, centroid: [-55.27, -11.91] as [number, number], areaHa: null }

function renderCalendar(overrides: Partial<Parameters<typeof DecisionView>[0]> = {}) {
  const props: Parameters<typeof DecisionView>[0] = {
    onClose: () => {},
    fieldName: 'Santa Carmem North',
    chosenDate: '2026-11-12',
    place: PLACE,
    windowRows: ROWS,
    seasonless: null,
    heldSeasons: ['2025/2026', '2026/2027'],
    history: [],
    numbersTarget: null,
    gaps: [],
    ...overrides,
  }
  return render(<DecisionView {...props} />)
}

function rowsOfTable(): HTMLElement[][] {
  const table = document.querySelector('.calendar-table') as HTMLElement
  return [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')] as HTMLElement[])
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?decision=1&region=br&date=2026-11-12')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('R-28 and R-29, one row per crop and season with its source (AC-26)', () => {
  it('prints a row per crop of the municipality and season, derived from the recorded rows', () => {
    renderCalendar()
    const expected = calendarRows(ROWS.filter((row) => row.municipality === PLACE.municipality && row.uf === PLACE.uf), SEASON)
    const rows = rowsOfTable()
    expect(rows).toHaveLength(expected.length)
    expect(rows.map((cells) => cells[0].textContent)).toEqual(expected.map((row) => row.crop))
    expect(expected.length).toBeGreaterThan(0)
  })

  it('names the portaria, its date, the risk, the soils, the cycles and the row count it enveloped', () => {
    renderCalendar()
    const first = rowsOfTable()[0]
    const citation = first[4].textContent ?? ''
    const expected = calendarRows(ROWS.filter((row) => row.municipality === PLACE.municipality && row.uf === PLACE.uf), SEASON)[0]
    expect(expected.source?.kind).toBe('season')
    if (expected.source?.kind !== 'season') return
    expect(citation).toContain(expected.source.portaria)
    expect(citation).toContain(expected.source.portariaDate)
    expect(citation).toContain(expected.source.management)
    expect(citation).toContain(String(expected.source.rows))
    expect(first[5].textContent).toBe(expected.source.risk)
    expect(first[6].textContent).toBe(expected.source.soils.join(', '))
    expect(first[7].textContent).toBe(expected.source.cycles.join(', '))
  })

  it('prints the season of every row and the earliest start and latest end of the envelope', () => {
    renderCalendar()
    for (const cells of rowsOfTable()) {
      expect(cells[1].textContent).toBe(SEASON)
      expect(cells[2].textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(cells[3].textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('R-30, the climate numbers beside the window (AC-27)', () => {
  it('prints the three numbers with basis, source and as_of, and the window beside them', async () => {
    // The recorded block 6 payload, with only the climate section replaced, so the response still
    // passes the route's own validation and the window is proven to survive beside real numbers.
    const payload = {
      ...(recordedNumbersPayload as unknown as NumbersPayload),
      sections: {
        ...(recordedNumbersPayload as unknown as NumbersPayload).sections,
        climate: {
          state: 'ok',
          basis: 'modelled',
          source: 'NASA POWER',
          as_of: '2026-11-12',
          aggregates: { dry_spell_days: { value: 7 }, frost_days: { value: 0 } },
          normals: { rain_percentile: { value: 20 } },
        },
      },
    } as unknown as NumbersPayload
    numbersStub.payload = payload
    renderCalendar({ numbersTarget: FIELD })
    const context = await screen.findByText(/NASA POWER/)
    const text = context.textContent ?? ''
    expect(text).toContain('7')
    expect(text).toContain('0')
    expect(text).toContain('20')
    expect(text).toContain('modelled')
    expect(text).toContain('2026-11-12')
    expect(rowsOfTable().length).toBeGreaterThan(0)
  })

  it('prints the abstention and its reason while the climate section abstains, and still prints the window', async () => {
    const payload = {
      ...(recordedNumbersPayload as unknown as NumbersPayload),
      sections: { climate: { state: 'abstained', error: 'no POWER cell for this point' } },
    } as unknown as NumbersPayload
    numbersStub.payload = payload
    renderCalendar({ numbersTarget: FIELD })
    expect(await screen.findByText(/no POWER cell for this point/)).toBeTruthy()
    expect(rowsOfTable().length).toBeGreaterThan(0)
  })
})

describe('R-31, the declared sowing dates (AC-28)', () => {
  it('marks the row of the declared crop and season with the entered date', () => {
    const history: HistoryRow[] = [{
      season: SEASON,
      first_crop: 'Soja',
      second_crop: null,
      first_sowing_date: '2025-10-20',
      second_sowing_date: null,
      basis: 'entered',
      edited_at: '2026-11-12T10:00:00.000Z',
    }]
    renderCalendar({ history })
    const soja = rowsOfTable().find((cells) => (cells[0].textContent ?? '').startsWith('Soja'))
    expect(soja).toBeTruthy()
    expect(soja?.[0].textContent).toContain('2025-10-20')
  })

  it('prints a row with no mark when the crop was declared in another season', () => {
    const history: HistoryRow[] = [{
      season: '2025/26',
      first_crop: 'Soja',
      second_crop: null,
      first_sowing_date: '2025-10-20',
      second_sowing_date: null,
      basis: 'entered',
      edited_at: '2026-11-12T10:00:00.000Z',
    }]
    renderCalendar({ history })
    for (const cells of rowsOfTable()) {
      expect(cells[0].textContent).not.toContain('2025-10-20')
    }
  })
})

describe('R-32, the empty season (AC-25)', () => {
  it('prints an empty table with the season it asked for and no invented row', () => {
    renderCalendar({ windowRows: [] })
    expect(document.querySelector('.calendar-table')).toBeNull()
    const empty = document.querySelector('.surface-empty')
    expect(empty?.textContent).toContain(SEASON)
  })
})

describe('R-41 and R-58, a registered field (AC-29)', () => {
  it('abstains with the missing location and prints one gap naming it', () => {
    renderCalendar({
      fieldName: 'North Forty',
      place: null,
      gaps: [{
        surface: 'Planting calendar',
        cause: 'calendar.abstain_municipality',
        source: 'fs.fields.v1',
        status: 'the field carries no municipality',
        date: '2026-11-12',
        remediation: 'CO-B7-06',
      }],
    })
    expect(document.querySelector('.calendar-table')).toBeNull()
    expect(screen.getByText(/no municipality/i)).toBeTruthy()
    const gapsTable = document.querySelector('.gaps-table') as HTMLElement
    expect(gapsTable).toBeTruthy()
    expect(within(gapsTable).getByText('CO-B7-06')).toBeTruthy()
  })
})

describe('AC-57, the seasonless source', () => {
  it('prints one row per crop, month and day with the citation and the not held text', () => {
    renderCalendar({ seasonless: usWindows as unknown as SeasonlessPayload, windowRows: null, place: null })
    const cells = rowsOfTable()[0]
    expect(cells.length).toBeGreaterThan(0)
    const body = document.querySelector('.calendar-table')?.textContent ?? ''
    expect(body).toContain('Not held by this source')
  })
})
