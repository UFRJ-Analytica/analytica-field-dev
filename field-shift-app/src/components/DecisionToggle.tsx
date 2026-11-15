import { PanelToggle } from './PanelToggle'

/** Block 5.5 W3: the `Planting calendar` button of the block 3 control strip, third of the four. */
export const DECISION_TOGGLE_ATTR = 'data-decision-toggle'

type DecisionToggleProps = {
  hasSelection?: boolean
}

export function DecisionToggle({ hasSelection = true }: DecisionToggleProps) {
  return (
    <PanelToggle
      attr={[DECISION_TOGGLE_ATTR, '']}
      className="decision-toggle"
      hasSelection={hasSelection}
      id="decision"
      labelKey="calendar.open"
      needsSelection={false}
    />
  )
}
