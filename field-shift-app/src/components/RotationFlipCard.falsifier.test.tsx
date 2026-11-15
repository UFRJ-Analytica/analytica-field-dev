import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RotationFlipCard } from './RotationFlipCard'
import type { RotationScenario } from './ScenarioCards'
import { en } from '@/strings/en'
import { numbersLastReadKey } from '@/lib/numbers-api'
import { useMapStore } from '@/lib/map-store'
import { recordedNumbersPayload, RECORDED_DATE, RECORDED_FIELD_ID } from '@/test/numbers-recorded'

const base: RotationScenario = {
  id: 'soy-cotton',
  name: 'Soybean → Cotton',
  is_current: false,
  crops: ['Soybean', 'Cotton'],
  why: 'Introduces a fiber crop after soybean.',
  evidence: 'Three seasons of crop history support a rotation comparison.',
  benefit: 'Adds a potential market outlet.',
  gap: 'Buyer access and credit terms are unknown.',
  risk: 'Cotton requires higher working capital.',
  evidence_rows: [],
}

const falsifier = { metric: 'rain_total', operator: '<', threshold: 150, unit: 'mm', text_key: 'numbers.rain_total' }

function openBack(scenario: RotationScenario) {
  const { container } = render(<ul>{<RotationFlipCard scenario={scenario} />}</ul>)
  const card = container.querySelector('.scenario-card') as HTMLElement
  return { card, flip: () => userEvent.setup().click(within(card).getByRole('button')) }
}

function factTerms(card: HTMLElement): string[] {
  return within(card).getAllByRole('term').map((term) => term.textContent ?? '')
}

function falsifierSlot(card: HTMLElement): HTMLElement {
  const term = within(card).getAllByRole('term').find((node) => node.textContent === 'Falsifier')
  if (term === undefined) throw new Error('the Falsifier term is not printed')
  return term.nextElementSibling as HTMLElement
}

beforeEach(() => {
  useMapStore.setState({ selectedFieldId: RECORDED_FIELD_ID, chosenDate: RECORDED_DATE, numbersLastRead: {} })
})

afterEach(() => {
  cleanup()
  useMapStore.setState({ selectedFieldId: null, chosenDate: null, numbersLastRead: {} })
})

describe('the counter evidence slot of a rotation card (R-39, R-40)', () => {
  it('prints Falsifier as the fourth fact, immediately after Benefit (R-39, AM-03)', async () => {
    const { card, flip } = openBack({ ...base, falsifier } as RotationScenario)
    await flip()
    expect(factTerms(card)).toEqual(['Why', 'Evidence', 'Benefit', 'Falsifier', 'Gap', 'Risk'])
  })

  it('prints the threshold sentence, the current value of its metric with the row basis and date (R-39)', async () => {
    useMapStore.setState({ numbersLastRead: { [numbersLastReadKey(RECORDED_FIELD_ID, RECORDED_DATE)]: recordedNumbersPayload() } })
    const { card, flip } = openBack({ ...base, falsifier } as RotationScenario)
    await flip()
    const slot = falsifierSlot(card).textContent ?? ''
    expect(slot).toContain(en['numbers.rain_total'])
    expect(slot).toContain('< 150 mm')
    expect(slot).toContain('171.9 mm')
    expect(slot).toContain(en['evidence.basis_modelled'])
    expect(slot).toContain('2026-11-11')
  })

  it('says the current value is not read yet when no payload is held for the field and date', async () => {
    const { card, flip } = openBack({ ...base, falsifier } as RotationScenario)
    await flip()
    expect(falsifierSlot(card).textContent).toContain(en['scenarios.falsifier.not_read'])
  })

  it('prints no threshold when the payload holds no row for the metric (R-39)', async () => {
    useMapStore.setState({ numbersLastRead: { [numbersLastReadKey(RECORDED_FIELD_ID, RECORDED_DATE)]: recordedNumbersPayload() } })
    const { card, flip } = openBack({ ...base, falsifier: { ...falsifier, metric: 'ndvi_mean' } } as RotationScenario)
    await flip()
    const slot = falsifierSlot(card).textContent ?? ''
    expect(slot).toContain('ndvi_mean')
    expect(slot).not.toContain('< 150')
  })

  it('prints No counter evidence recorded for a scenario with no falsifier, and no threshold (R-40)', async () => {
    const { card, flip } = openBack(base)
    await flip()
    expect(falsifierSlot(card).textContent).toBe('No counter evidence recorded')
    expect(card.textContent).not.toMatch(/< \d/)
  })

  it('treats a falsifier missing one of its five keys as no falsifier (R-39, R-40)', async () => {
    const { text_key: _textKey, ...partial } = falsifier
    const { card, flip } = openBack({ ...base, falsifier: partial } as unknown as RotationScenario)
    await flip()
    expect(falsifierSlot(card).textContent).toBe('No counter evidence recorded')
  })
})
