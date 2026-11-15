import { t } from '@/strings'

/**
 * Block 7, R-01 and R-08: the two strip buttons. They sit to the right of `Supporting data` and open
 * their surface; the App owns the URL and the focus return (R-01).
 */
export const DECISION_TOGGLE_ATTR = 'data-decision-toggle'

type DecisionToggleProps = {
  onOpen: () => void
}

export function DecisionToggle({ onOpen }: DecisionToggleProps) {
  return (
    <button
      type="button"
      className="top-chip toggle-control decision-toggle"
      {...{ [DECISION_TOGGLE_ATTR]: '' }}
      onClick={onOpen}
    >
      {t('calendar.open')}
    </button>
  )
}
