import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PanelHost, type PanelSpec } from './PanelHost'
import { PANEL_ORDER, usePanelStore, type PanelId } from '@/lib/panel-store'

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



  it('does not mount a panel whose content is null', () => {
    const withEmpty = specs().map((spec) => (spec.id === 'numbers' ? { ...spec, content: null } : spec))
    // The store may name a panel the caller has nothing for: the host mounts nothing rather than an
    // empty box (B5, and R-01 of block 7 revision 10).
    usePanelStore.setState({ open: 'numbers' })
    const { container } = render(<PanelHost panels={withEmpty} />)
    expect(container.querySelector('[data-panel-host]')).toBeNull()
  })

})
