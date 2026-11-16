import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fieldClimateSchema } from '@/lib/climate'
import { climateFixture } from '@/test/climate-fixtures'
import { ClimateSignal } from './ClimateSignal'

afterEach(cleanup)

describe('ClimateSignal', () => {
  it('prints the municipality, the three values, modelled, the date and n from the McLean County fixture', () => {
    const raw = climateFixture<Record<string, unknown>>('municipality-17113.json')
    const climate = fieldClimateSchema.parse({ state: 'available', ...raw })
    const progress = climate.season_progress
    render(<ClimateSignal climate={{ status: 'ready', data: climate }} />)

    const region = screen.getByRole('region')
    const text = region.textContent ?? ''
    expect(text).toContain(climate.municipality.name_official)
    expect(text).toContain(`${Math.round(progress.rain_mm)} mm`)
    expect(text).toContain(`${Math.round(progress.normal_mm)} mm`)
    expect(text).toContain(`${Math.round(progress.analog_mm ?? 0)} mm`)
    expect(text).toContain('modelled')
    expect(text).toContain(progress.last_observed)
    expect(text).toContain(`${progress.n_analog} analog years`)
    expect(text).toContain(climate.crop_year_label)

    const fills = [...region.querySelectorAll<HTMLElement>('.climate-bar-fill')].map((fill) => Number(fill.dataset.fillPercent))
    expect(fills).toHaveLength(3)
    expect(Math.max(...fills)).toBe(100)
  })

  it('prints one literal and no digit when the climate request fails', () => {
    render(<ClimateSignal climate={{ status: 'unavailable' }} />)
    expect(screen.getByText('Climate signal unavailable')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\d/)
    expect(document.querySelector('.climate-bar')).toBeNull()
  })
})
