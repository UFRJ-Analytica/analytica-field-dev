import { PanelToggle } from './PanelToggle'

/**
 * Block 5.5, U6 and W3: `Rotation outlook` becomes the first of the four buttons. It becomes a
 * button and its cards become a panel; the content of `ScenarioCards` is unchanged.
 */
export const ROTATION_TOGGLE_ATTR = 'data-rotation-toggle'

type RotationToggleProps = {
  hasSelection: boolean
}

export function RotationToggle({ hasSelection }: RotationToggleProps) {
  return (
    <PanelToggle
      actionLabels={{ open: 'rotation.collapse', closed: 'rotation.expand' }}
      attr={[ROTATION_TOGGLE_ATTR, '']}
      className="rotation-toggle"
      hasSelection={hasSelection}
      id="rotation"
      labelKey="map.rotation_outlook"
      needsSelection
    />
  )
}
