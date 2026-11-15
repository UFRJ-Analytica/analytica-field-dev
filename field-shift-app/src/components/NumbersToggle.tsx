import { PanelToggle } from './PanelToggle'

/** Block 5.5 W3: the `Field numbers` button of the block 3 control strip, second of the four. */
export const NUMBERS_TOGGLE_ATTR = 'data-numbers-toggle'

type NumbersToggleProps = {
  hasSelection: boolean
}

export function NumbersToggle({ hasSelection }: NumbersToggleProps) {
  return (
    <PanelToggle
      attr={[NUMBERS_TOGGLE_ATTR, '']}
      className="numbers-toggle"
      hasSelection={hasSelection}
      id="numbers"
      labelKey="numbers.open"
      needsSelection
    />
  )
}
