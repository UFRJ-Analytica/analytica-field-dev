import { PanelToggle } from './PanelToggle'

/** Block 5.5 W3: the `Field record` button of the block 3 control strip, fourth of the four. */
export const FIELD_RECORD_TOGGLE_ATTR = 'data-record-toggle'

type FieldRecordToggleProps = {
  hasSelection?: boolean
}

export function FieldRecordToggle({ hasSelection = true }: FieldRecordToggleProps) {
  return (
    <PanelToggle
      attr={[FIELD_RECORD_TOGGLE_ATTR, '']}
      className="record-toggle"
      hasSelection={hasSelection}
      id="record"
      labelKey="record.open"
      needsSelection={false}
    />
  )
}
