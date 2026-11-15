/**
 * Block 5.5, W3 and block 7 revision 10 R-08: one strip button per panel.
 *
 * The four buttons are one exclusive group: `aria-expanded` is true only for the panel the button
 * holds open, a press on one closes the other three because the store holds a single value, and a
 * panel that needs a polygon is disabled with the reason in its accessible name while nothing is
 * selected (B5). Every button is a native `button` with a 44 by 44 px minimum hit area.
 */
import { usePanelStore, type PanelId } from '@/lib/panel-store'
import { t, type TranslationKey } from '@/strings'

export type PanelToggleProps = {
  id: PanelId
  labelKey: TranslationKey
  /** True for `Rotation outlook` and `Field numbers`, which read the selected polygon. */
  needsSelection: boolean
  hasSelection: boolean
  /** The data attribute this button is found by, e.g. `data-numbers-toggle`. */
  attr: readonly [string, string]
  className: string
  /** Block 4 R-48 freezes the rotation control's name as the action it performs. */
  actionLabels?: { open: TranslationKey; closed: TranslationKey }
}

export function PanelToggle({ id, labelKey, needsSelection, hasSelection, attr, className, actionLabels }: PanelToggleProps) {
  const open = usePanelStore((state) => state.open)
  const togglePanel = usePanelStore((state) => state.togglePanel)
  const label = t(labelKey)
  const disabled = needsSelection && !hasSelection
  const expanded = open === id
  const accessibleName = disabled
    ? t('panel.needs_selection', { panel: label })
    : actionLabels === undefined
      ? label
      : t(expanded ? actionLabels.open : actionLabels.closed)
  return (
    <button
      type="button"
      className={`top-chip toggle-control panel-toggle ${className}${expanded ? ' is-open' : ''}`}
      {...{ [attr[0]]: attr[1] }}
      aria-expanded={expanded}
      aria-disabled={disabled ? true : undefined}
      disabled={disabled}
      aria-label={accessibleName}
      onClick={() => togglePanel(id)}
    >
      {label}
    </button>
  )
}
