import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PanelHost, type PanelSpec } from './PanelHost'
import { PANEL_ORDER, usePanelStore, type PanelId } from '@/lib/panel-store'

// The strip cleanup (PR #42) left `Field Data` (`numbers`) as the only panel. The host is still built
// as data, so the extensibility case below passes a panel id the store does not list yet.
const TITLES: Record<PanelId, string> = {
  numbers: 'Field Data',
}

function specs(): PanelSpec[] {
  return PANEL_ORDER.map((id) => ({
    id,
    labelKey: 'numbers.open' as PanelSpec['labelKey'],
    needsSelection: true,
    content: <p data-body={id}>{`body of ${TITLES[id]}`}</p>,
  }))
}

beforeEach(() => {
  usePanelStore.setState({ open: null })
})

describe('block 5.5 W2: one host, one panel, built as data', () => {
  it('renders nothing while no panel is open', () => {
    const { container } = render(<PanelHost panels={specs()} />)
    expect(container.querySelector('[data-panel-host]')).toBeNull()
  })

  it('renders exactly the open panel, with its name and its level two heading', () => {
    usePanelStore.setState({ open: 'numbers' })
    const { container } = render(<PanelHost panels={specs()} />)
    const host = container.querySelector('[data-panel-host]') as HTMLElement
    expect(host.getAttribute('data-panel')).toBe('numbers')
    expect(host.getAttribute('role')).toBe('region')
    expect(host.getAttribute('aria-label')).toBe(TITLES.numbers)
    expect(screen.getByRole('heading', { level: 2, name: TITLES.numbers })).toBeTruthy()
    expect(container.querySelectorAll('[data-body]')).toHaveLength(1)
    expect(container.querySelector('[data-body]')?.getAttribute('data-body')).toBe('numbers')
  })

  it('does not mount a panel whose content is null', () => {
    const withEmpty = specs().map((spec) => ({ ...spec, content: null }))
    // The store may name a panel the caller has nothing for: the host mounts nothing rather than an
    // empty box (B5, and R-01 of block 7 revision 10).
    usePanelStore.setState({ open: 'numbers' })
    const { container } = render(<PanelHost panels={withEmpty} />)
    expect(container.querySelector('[data-panel-host]')).toBeNull()
  })

  it('accepts another panel without a branch: the host renders whatever the data names', () => {
    const later = 'later' as PanelId
    const extra = {
      id: later,
      labelKey: 'numbers.open' as PanelSpec['labelKey'],
      needsSelection: false,
      content: <p data-body="later">a later panel</p>,
    }
    usePanelStore.setState({ open: later })
    const { container } = render(<PanelHost panels={[...specs(), extra]} />)
    expect(container.querySelector('[data-body]')?.getAttribute('data-body')).toBe('later')
  })

  it('closes from its own control and leaves the focus to the caller', async () => {
    const closePanel = vi.fn()
    usePanelStore.setState({ open: 'numbers' })
    const user = userEvent.setup()
    render(<PanelHost panels={specs()} />)
    await user.click(screen.getByRole('button', { name: `Close ${TITLES.numbers}` }))
    expect(usePanelStore.getState().open).toBeNull()
    expect(closePanel).not.toHaveBeenCalled()
  })
})
