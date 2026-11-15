import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PanelHost, type PanelSpec } from './PanelHost'
import { PANEL_ORDER, usePanelStore, type PanelId } from '@/lib/panel-store'

const TITLES: Record<PanelId, string> = {
  rotation: 'Rotation outlook',
  numbers: 'Field numbers',
  decision: 'Planting calendar',
  record: 'Field record',
}

function specs(): PanelSpec[] {
  return PANEL_ORDER.map((id) => ({
    id,
    labelKey: (id === 'rotation' ? 'map.rotation_outlook' : id === 'numbers' ? 'numbers.open' : id === 'decision' ? 'calendar.open' : 'record.open') as PanelSpec['labelKey'],
    needsSelection: id === 'rotation' || id === 'numbers',
    content: <p data-body={id}>{`body of ${TITLES[id]}`}</p>,
  }))
}

beforeEach(() => {
  usePanelStore.setState({ open: null, draft: null })
})

describe('block 5.5 W2: one host, one panel, built as data', () => {
  it('renders nothing while no panel is open', () => {
    const { container } = render(<PanelHost panels={specs()} />)
    expect(container.querySelector('[data-panel-host]')).toBeNull()
  })

  it('renders exactly the open panel, with its name and its level two heading', () => {
    usePanelStore.setState({ open: 'decision' })
    const { container } = render(<PanelHost panels={specs()} />)
    const host = container.querySelector('[data-panel-host]') as HTMLElement
    expect(host.getAttribute('data-panel')).toBe('decision')
    expect(host.getAttribute('role')).toBe('region')
    expect(host.getAttribute('aria-label')).toBe(TITLES.decision)
    expect(screen.getByRole('heading', { level: 2, name: TITLES.decision })).toBeTruthy()
    expect(container.querySelectorAll('[data-body]')).toHaveLength(1)
    expect(container.querySelector('[data-body]')?.getAttribute('data-body')).toBe('decision')
  })

  it('closes from its own control', async () => {
    usePanelStore.setState({ open: 'record' })
    const user = userEvent.setup()
    render(<PanelHost panels={specs()} />)
    await user.click(screen.getByRole('button', { name: 'Close Field record' }))
    expect(usePanelStore.getState().open).toBeNull()
  })

  it('does not mount a panel whose content is null', () => {
    const withEmpty = specs().map((spec) => (spec.id === 'numbers' ? { ...spec, content: null } : spec))
    // The store may name a panel the caller has nothing for: the host mounts nothing rather than an
    // empty box (B5, and R-01 of block 7 revision 10).
    usePanelStore.setState({ open: 'numbers' })
    const { container } = render(<PanelHost panels={withEmpty} />)
    expect(container.querySelector('[data-panel-host]')).toBeNull()
  })

  it('accepts a fifth panel without a branch: the host renders whatever the data names', () => {
    const fifth = {
      id: 'rotation' as PanelId,
      labelKey: 'map.rotation_outlook' as PanelSpec['labelKey'],
      needsSelection: false,
      content: <p data-body="fifth">a later panel</p>,
    }
    usePanelStore.setState({ open: 'rotation' })
    const { container } = render(<PanelHost panels={[...specs().filter((spec) => spec.id !== 'rotation'), fifth]} />)
    expect(container.querySelector('[data-body]')?.getAttribute('data-body')).toBe('fifth')
  })

  it('forwards a close press to the store and lets the caller keep the focus', async () => {
    const closePanel = vi.fn()
    usePanelStore.setState({ open: 'numbers' })
    const user = userEvent.setup()
    render(<PanelHost panels={specs()} />)
    await user.click(screen.getByRole('button', { name: 'Close Field numbers' }))
    expect(usePanelStore.getState().open).toBeNull()
    expect(closePanel).not.toHaveBeenCalled()
  })
})
