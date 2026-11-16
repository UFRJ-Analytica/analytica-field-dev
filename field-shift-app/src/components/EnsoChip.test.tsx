import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ensoSchema } from '@/lib/climate'
import { climateFixture } from '@/test/climate-fixtures'
import { EnsoChip } from './EnsoChip'

afterEach(cleanup)

const enso = ensoSchema.parse(climateFixture('enso.json'))

describe('EnsoChip', () => {
  it('prints phase, strength, index, season, value, basis and issue date from the fixture', () => {
    render(<EnsoChip enso={{ status: 'ready', data: enso }} />)
    const chip = screen.getByRole('group')
    const text = chip.textContent ?? ''
    const value = `${enso.roni.value >= 0 ? '+' : ''}${enso.roni.value.toFixed(2)} °C`
    expect(text).toContain('RONI')
    expect(text).toContain(enso.roni.season)
    expect(text).toContain(value)
    expect(text).toContain('reported')
    expect(text).toContain(enso.discussion.issued)
    if (enso.roni.phase === 'el_nino') expect(text).toContain('El Niño')
    if (enso.roni.strength === 'very_strong') expect(text).toContain('very strong')
    const name = chip.getAttribute('aria-label') ?? ''
    for (const fact of ['RONI', enso.roni.season, value, 'reported', enso.discussion.issued]) expect(name).toContain(fact)
  })

  it('prints only the unavailable literal when the endpoint fails', () => {
    render(<EnsoChip enso={{ status: 'unavailable' }} />)
    expect(screen.getByText('ENSO unavailable')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\d/)
  })
})
