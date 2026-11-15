import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldsPanel, SHORT_NO_CDL_QUERY } from './FieldsPanel'
import type { FieldSummary } from '@/lib/map-store'
import { UNMAPPED_CLASS_COLOUR } from '@/lib/polygon-style'
import { FIELDS_CHIP_ROW_ID } from './FieldsPanel'

const field: FieldSummary = {
  id: 'mt-santa-carmem-01',
  name: 'Santa Carmem North',
  location: 'Santa Carmem, Mato Grosso',
  coverage: 86,
  center: [-55.27, -11.91],
  boundary: { type: 'Polygon', coordinates: [[[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]] },
}

const baseProps = {
  fields: [field],
  selectedFieldId: null as string | null,
  isLoading: false,
  error: null,
  canRetry: false,
  onSelectField: vi.fn(),
  onRetry: vi.fn(),
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * AC-24: evaluate a media query's own `min-width` and `max-width` numbers against a width.
 *
 * jsdom does not evaluate media queries, and a stub that answers a fixed boolean hides a band with
 * a wrong edge. This parses the query the component exports, so a test at 641 or 882 fails when the
 * band's numbers are wrong instead of agreeing with them.
 */
function queryMatchesAt(query: string, width: number): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(part)
    if (min) return width >= Number(min[1])
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(part)
    if (max) return width <= Number(max[1])
    throw new Error(`the test cannot evaluate this query part: ${part}`)
  })
}

describe('the fields header chip for a polygon (R-28, AC-24, AM-04)', () => {
  it('renders the class name, its colour dot and no percentage', () => {
    render(<FieldsPanel {...baseProps} selectedPolygon={{ fieldId: 'trazo:12345', name: 'Soybean', hex: '#f5b3c8' }} />)
    const chip = screen.getByRole('button', { name: 'Soybean' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.textContent).toBe('Soybean')
    expect(chip.textContent).not.toContain('%')
    const dot = chip.querySelector('[data-class-hex]')
    expect(dot?.getAttribute('data-class-hex')).toBe('#f5b3c8')
    expect((dot as HTMLElement).style.background).toContain('rgb(245, 179, 200)')
  })

  it('keeps the chip mounted in both panel states', async () => {
    const user = userEvent.setup()
    render(<FieldsPanel {...baseProps} selectedPolygon={{ fieldId: 'csb:381825001868504', name: 'Soybeans', hex: '#267000' }} />)
    expect(screen.getByRole('button', { name: 'Soybeans' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Fields' }))
    const row = document.getElementById(FIELDS_CHIP_ROW_ID) as HTMLElement
    expect(within(row).getAllByRole('button')).toHaveLength(1)
    // The chip is beside the trigger and survives the open state (R-28).
    expect(screen.getByRole('button', { name: 'Soybeans' })).toBeTruthy()
  })

  it('prints class not mapped with the unmapped colour when the class is not in the table', () => {
    render(<FieldsPanel {...baseProps} selectedPolygon={{ fieldId: 'trazo:999', name: null, hex: UNMAPPED_CLASS_COLOUR }} />)
    const chip = screen.getByRole('button', { name: 'class not mapped' })
    expect(chip.textContent).toBe('class not mapped')
    expect(chip.querySelector('[data-class-hex]')?.getAttribute('data-class-hex')).toBe(UNMAPPED_CLASS_COLOUR)
  })

  it('shows the fixture chip instead while no polygon is selected, and never both', () => {
    const { rerender } = render(<FieldsPanel {...baseProps} selectedFieldId="mt-santa-carmem-01" />)
    expect(screen.getByRole('button', { name: 'Santa Carmem North' })).toBeTruthy()
    rerender(
      <FieldsPanel
        {...baseProps}
        selectedFieldId={null}
        selectedPolygon={{ fieldId: 'trazo:12345', name: 'Soybean', hex: '#f5b3c8' }}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Santa Carmem North' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Soybean' })).toBeTruthy()
  })

  it('re-selects the polygon through the same onSelectField the command uses', async () => {
    const user = userEvent.setup()
    const onSelectField = vi.fn()
    render(
      <FieldsPanel
        {...baseProps}
        onSelectField={onSelectField}
        selectedPolygon={{ fieldId: 'trazo:12345', name: 'Soybean', hex: '#f5b3c8' }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Soybean' }))
    expect(onSelectField).toHaveBeenCalledWith('trazo:12345')
  })
})

describe('the fields chip per state (R-28, AC-24, R-44)', () => {
  it('prints No CDL class for {Y} for a United States null class, with the year substituted', () => {
    render(
      <FieldsPanel
        {...baseProps}
        selectedPolygon={{ fieldId: 'us:381825001868504', name: null, hex: UNMAPPED_CLASS_COLOUR, noCdlYear: 2026 }}
      />,
    )
    const chip = screen.getByRole('button', { name: 'No CDL class for 2026' })
    expect(chip.textContent).toBe('No CDL class for 2026')
    expect(chip.querySelector('[data-class-hex]')?.getAttribute('data-class-hex')).toBe(UNMAPPED_CLASS_COLOUR)
    expect(chip.textContent).not.toContain('%')
  })

  it('does not print class not mapped for a United States null class', () => {
    render(
      <FieldsPanel
        {...baseProps}
        selectedPolygon={{ fieldId: 'us:381825001868504', name: null, hex: UNMAPPED_CLASS_COLOUR, noCdlYear: 2026 }}
      />,
    )
    expect(screen.queryByText('class not mapped')).toBeNull()
  })

  it('prints class not mapped for an unmapped code, and never No CDL class for', () => {
    render(
      <FieldsPanel
        {...baseProps}
        selectedPolygon={{ fieldId: 'us:999', name: null, hex: UNMAPPED_CLASS_COLOUR, noCdlYear: null }}
      />,
    )
    const chip = screen.getByRole('button', { name: 'class not mapped' })
    expect(chip.textContent).toBe('class not mapped')
    expect(screen.queryByText(/No CDL class for/)).toBeNull()
  })

  it('prints the class name for a mapped class, with no unmapped label', () => {
    render(
      <FieldsPanel
        {...baseProps}
        selectedPolygon={{ fieldId: 'us:1', name: 'Corn', hex: '#ffd300', noCdlYear: null }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Corn' }).textContent).toBe('Corn')
    expect(screen.queryByText('class not mapped')).toBeNull()
  })
})

describe('the fields chip at the AC-24 widths (R-28, AC-24, R-44)', () => {
  // jsdom has no layout, so these tests pin the string each width prints and which panel content
  // box the chip mounts in. The stub answers the real `SHORT_NO_CDL_QUERY` for a width instead of
  // returning a fixed boolean: a stub keyed to one preset width is how a band with both edges
  // wrong stayed green. The pixel containment is measured in the real browser and recorded in
  // artifacts/AC-24-overflow.txt: at 780 the short chip box is 104.80 px wide, right edge 180.80
  // against the 202.80 px panel (22.00 px inside); at 360 the long form ends at 296.00, the panel
  // edge; at 1440 it ends at 298.00 inside the 320.00 px panel.
  function stubChipWidth(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: queryMatchesAt(query, width),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  const usNull = {
    fieldId: 'csb:381825001868504',
    name: null,
    hex: UNMAPPED_CLASS_COLOUR,
    noCdlYear: 2026,
  }

  it('prints the long form at 360, where the chip box ends at the 296.00 panel edge', () => {
    stubChipWidth(360)
    render(<FieldsPanel {...baseProps} selectedPolygon={usNull} />)
    expect(screen.getByRole('button', { name: 'No CDL class for 2026' }).textContent).toBe('No CDL class for 2026')
    expect(screen.queryByText('No CDL 2026')).toBeNull()
  })

  it('prints the short form at 780, and the long form is not in the document', () => {
    stubChipWidth(780)
    render(<FieldsPanel {...baseProps} selectedPolygon={usNull} />)
    const chip = screen.getByRole('button', { name: 'No CDL 2026' })
    expect(chip.textContent).toBe('No CDL 2026')
    // The chip mounts in the fields header, the panel content box AC-24 measures the box against.
    expect(chip.closest('.fields-header')).not.toBeNull()
    expect(screen.queryByText(/No CDL class for/)).toBeNull()
  })

  it('returns to the long form at 1440, where the chip box ends 22.00 px inside the panel', () => {
    stubChipWidth(1440)
    render(<FieldsPanel {...baseProps} selectedPolygon={usNull} />)
    expect(screen.getByRole('button', { name: 'No CDL class for 2026' }).textContent).toBe('No CDL class for 2026')
    expect(screen.queryByText('No CDL 2026')).toBeNull()
  })

  it('keeps class not mapped for an unmapped code in the short-form band', () => {
    stubChipWidth(780)
    render(<FieldsPanel {...baseProps} selectedPolygon={{ ...usNull, noCdlYear: null }} />)
    expect(screen.getByRole('button', { name: 'class not mapped' }).textContent).toBe('class not mapped')
    expect(screen.queryByText(/No CDL/)).toBeNull()
  })
})

describe('the short-form band edges (R-28, AC-24)', () => {
  // The reviewer's band-edge measurement, `AC-24-band-edges-review-t_71e817ec.txt`: the long form
  // is ellipsized or cut from 641 through 881 inclusive, and it fits at 640 and below and from 882
  // up. These two rows are the edges the wrong band missed.
  const usNull = {
    fieldId: 'csb:381825001868504',
    name: null,
    hex: UNMAPPED_CLASS_COLOUR,
    noCdlYear: 2026,
  }

  function stubChipWidth(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: queryMatchesAt(query, width),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
  }

  it('declares the measured band, both edges inclusive', () => {
    expect(SHORT_NO_CDL_QUERY).toBe('(min-width: 641px) and (max-width: 881px)')
    for (const width of [641, 700, 767, 801, 881]) {
      expect(queryMatchesAt(SHORT_NO_CDL_QUERY, width)).toBe(true)
    }
    for (const width of [360, 640, 882, 1023, 1024, 1440]) {
      expect(queryMatchesAt(SHORT_NO_CDL_QUERY, width)).toBe(false)
    }
  })

  it('prints No CDL {Y} at 641, the first width whose row shows overflow', () => {
    stubChipWidth(641)
    render(<FieldsPanel {...baseProps} selectedPolygon={usNull} />)
    expect(screen.getByRole('button', { name: 'No CDL 2026' }).textContent).toBe('No CDL 2026')
    expect(screen.queryByText(/No CDL class for/)).toBeNull()
  })

  it('prints No CDL class for {Y} at 882, the first width where the long form fits', () => {
    stubChipWidth(882)
    render(<FieldsPanel {...baseProps} selectedPolygon={usNull} />)
    expect(screen.getByRole('button', { name: 'No CDL class for 2026' }).textContent).toBe('No CDL class for 2026')
    expect(screen.queryByText('No CDL 2026')).toBeNull()
  })
})
