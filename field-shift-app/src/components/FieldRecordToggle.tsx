import { t } from '@/strings'

/**
 * Block 7, R-01 and R-08: the `Field record` strip button, to the right of `Planting calendar` and of
 * `Supporting data`. The App owns the URL and the focus return (R-01).
 */
export const FIELD_RECORD_TOGGLE_ATTR = 'data-record-toggle'

type FieldRecordToggleProps = {
  onOpen: () => void
}

export function FieldRecordToggle({ onOpen }: FieldRecordToggleProps) {
  return (
    <button
      type="button"
      className="top-chip toggle-control record-toggle"
      {...{ [FIELD_RECORD_TOGGLE_ATTR]: '' }}
      onClick={onOpen}
    >
      {t('record.open')}
    </button>
  )
}
