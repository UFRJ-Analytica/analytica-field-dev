import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RotationFlipCard } from './RotationFlipCard'
import type { RotationScenario } from './ScenarioCards'

const FACT_LABELS = ['Why', 'Evidence', 'Benefit', 'Falsifier', 'Gap', 'Risk']
const VISUAL_LABELS = ['SMAP soil moisture', 'Crop history']

const smapRow = {
  layer: 'SMAP soil moisture',
  value: '0.28 m³/m³',
  basis: 'retrieved' as const,
  as_of: '2025-11-10',
  source: 'https://gibs.earthdata.nasa.gov/',
}

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
    evidence_rows: [smapRow, {
      layer: 'Crop history',
      value: 'Soybean → Corn',
      basis: 'entered',
      as_of: '2025-06-30',
      source: 'https://field-shift.local/fixtures/crop-history',
    }],
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
    evidence_rows: [smapRow],
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
    evidence_rows: [{
      layer: 'Rotation suitability',
      value: '0.68',
      basis: 'modelled',
      as_of: '2025-11-10',
      source: 'https://field-shift.local/fixtures/model-v1',
    }],
  },
]

function renderCards(renderedScenarios: RotationScenario[] = scenarios) {
  const { container } = render(
    <ul>
      {renderedScenarios.map((scenario) => (
        <RotationFlipCard key={scenario.id} scenario={scenario} />
      ))}
    </ul>,
  )
  const cards = [...container.querySelectorAll('.scenario-card')] as HTMLElement[]
  return { container, cards }
}

afterEach(() => {
  cleanup()
})

describe('RotationFlipCard', () => {
  it('shows the front face only at first paint (R-11, R-12, AC-07)', () => {
    const { cards } = renderCards()

    expect(cards).toHaveLength(3)
    for (const card of cards) {
      const trigger = within(card).getByRole('button')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      for (const label of FACT_LABELS) expect(within(card).queryByText(label)).toBeNull()
      for (const label of VISUAL_LABELS) expect(within(card).getByText(label)).toBeTruthy()
      expect(within(card).queryByRole('definition')).toBeNull()
    }
  })

  it('moves one card to the back face with the five facts and no visuals (R-11, R-13, AC-07)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()
    const currentCard = cards[0]

    await user.click(within(currentCard).getByRole('button', { name: 'Charts for Current sequence' }))

    const trigger = within(currentCard).getByRole('button')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-label')).toBe('Details for Current sequence')
    expect(within(currentCard).getAllByRole('term').map((term) => term.textContent)).toEqual(FACT_LABELS)
    expect(within(currentCard).getAllByRole('definition').map((definition) => definition.textContent)).toEqual([
      scenarios[0].why,
      scenarios[0].evidence,
      scenarios[0].benefit,
      'No counter evidence recorded',
      scenarios[0].gap,
      scenarios[0].risk,
    ])
    for (const label of VISUAL_LABELS) expect(within(currentCard).queryByText(label)).toBeNull()
    expect(currentCard.textContent).toContain('Current sequence')
    expect(currentCard.textContent).toContain('CURRENT')
  })

  it('leaves the other cards on their own front face (R-11, AC-07)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()

    await user.click(within(cards[1]).getByRole('button', { name: 'Charts for Soybean → Corn cover' }))

    for (const card of [cards[0], cards[2]]) {
      expect(within(card).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      expect(within(card).getByText('SMAP soil moisture')).toBeTruthy()
      for (const label of FACT_LABELS) expect(within(card).queryByText(label)).toBeNull()
    }
  })

  it('derives every accessible name from the card heading and shows no label text (R-18, AC-11)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()

    for (const [index, card] of cards.entries()) {
      const heading = within(card).getByRole('heading', { level: 3 }).textContent
      const trigger = within(card).getByRole('button')
      expect(heading).toBe(scenarios[index].name)
      expect(trigger.getAttribute('aria-label')).toBe(`Charts for ${heading}`)
      expect(trigger.textContent).toBe('')
      expect(trigger.hasAttribute('aria-pressed')).toBe(false)
    }

    expect(screen.getByRole('button', { name: 'Charts for Soybean → Corn cover' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Charts for Soybean → Corn' })).toBeNull()

    await user.click(within(cards[2]).getByRole('button'))
    const backTrigger = within(cards[2]).getByRole('button')
    expect(backTrigger.getAttribute('aria-label')).toBe('Details for Soybean → Cotton')
    expect(backTrigger.textContent).toBe('')
    expect(backTrigger.hasAttribute('aria-pressed')).toBe(false)
  })

  it('points aria-controls at the card body and swaps its content (R-18, R-20)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()
    const trigger = within(cards[0]).getByRole('button')
    const bodyId = trigger.getAttribute('aria-controls')

    expect(bodyId).toBeTruthy()
    const body = cards[0].querySelector(`#${bodyId}`) as HTMLElement
    expect(body).not.toBeNull()
    expect(body.textContent).toContain('SMAP soil moisture')

    await user.click(trigger)

    const nextBody = cards[0].querySelector(`#${bodyId}`) as HTMLElement
    expect(nextBody).not.toBeNull()
    expect(nextBody.textContent).not.toContain('SMAP soil moisture')
    expect(nextBody.querySelectorAll('dl').length).toBe(1)
    expect(cards[0].querySelectorAll('.flip-face')).toHaveLength(1)
  })

  it('keeps focus on the trigger across both flips (R-19, AC-11)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()
    const trigger = within(cards[0]).getByRole('button')

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(within(cards[0]).getByRole('button'))
    expect(within(cards[0]).getByRole('button').getAttribute('aria-expanded')).toBe('true')

    await user.keyboard('{Enter}')
    expect(within(cards[0]).getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(within(cards[0]).getByRole('button'))
  })

  it('flips the card with Enter from the overlay button (R-19)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()
    const trigger = within(cards[0]).getByRole('button')

    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await user.keyboard('{Enter}')

    const body = cards[0].querySelector('.flip-face') as HTMLElement
    expect(body.getAttribute('data-face')).toBe('back')
    expect(within(cards[0]).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(within(cards[0]).getByRole('button'))
  })

  it('flips the card with Space from the overlay button (R-19)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()
    const trigger = within(cards[0]).getByRole('button')

    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await user.keyboard(' ')

    const body = cards[0].querySelector('.flip-face') as HTMLElement
    expect(body.getAttribute('data-face')).toBe('back')
    expect(within(cards[0]).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(within(cards[0]).getByRole('button'))
  })

  it('renders no visual at all on the back and no fact on the front (R-12, R-13)', async () => {
    const user = userEvent.setup()
    const { cards } = renderCards()

    for (const label of VISUAL_LABELS) expect(within(cards[2]).getByText(label)).toBeTruthy()
    await user.click(within(cards[2]).getByRole('button'))
    expect(within(cards[2]).queryByRole('group')).toBeNull()
    expect(cards[2].querySelectorAll('.crop-bar')).toHaveLength(0)
    expect(cards[2].querySelectorAll('.smap-track')).toHaveLength(0)
  })

  it('marks a modelled SMAP row at 0 px and keeps the crop date on the same face (R-17, AC-13)', () => {
    const modelledScenario: RotationScenario = {
      ...scenarios[0],
      evidence_rows: [
        { ...smapRow, basis: 'modelled' as const },
        scenarios[0].evidence_rows[1],
      ],
    }
    const { cards } = renderCards([modelledScenario])

    const smap = within(cards[0]).getByRole('group', { name: /^SMAP soil moisture/ })
    expect(smap.textContent).toContain('SMAP soil moisture (modelled)')
    expect(smap.textContent).not.toMatch(/\d/)
    expect(smap.textContent).not.toContain('assumes')
    expect((cards[0].querySelector('.smap-fill') as HTMLElement).style.width).toBe('0px')
    // R-15's crop group still prints its own date on the same face.
    expect(within(cards[0]).getByRole('group', { name: /^Crop history/ }).textContent).toContain('2025-06-30')
  })

  it('renders the not reported state when the scenario has no SMAP row (R-16)', () => {
    const { cards } = renderCards()

    expect(within(cards[2]).getByText('Not reported for this option')).toBeTruthy()
    expect(cards[2].textContent).not.toContain('0.28')
  })
})
