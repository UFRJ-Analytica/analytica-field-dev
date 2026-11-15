/**
 * Block 5.5, W2: the panel host.
 *
 * One box in the bottom left overlay, the rectangle `ScenarioCards` occupies today, holding exactly
 * one panel at a time. A panel is data: its id, its label key, whether it needs a polygon and its
 * content node. A fifth panel is one entry in the array the caller passes, never a new branch here
 * (block 7 revision 10 R-02, and the plan's R3).
 *
 * The host renders nothing while no panel is open, so no empty surface sits over the map and the
 * box's rectangle is only measured while a panel is on screen.
 */
import type { ReactNode } from 'react'
import { usePanelStore, type PanelId } from '@/lib/panel-store'
import { t, type TranslationKey } from '@/strings'

export const PANEL_HOST_ATTR = 'data-panel-host'

export type PanelSpec = {
  id: PanelId
  /** The visible name of the panel, which is also the text of its button. */
  labelKey: TranslationKey
  /** True for a panel that cannot open while no polygon is selected. */
  needsSelection: boolean
  /** The panel's own content, or null when it has nothing to show and must not mount. */
  content: ReactNode
}

export function PanelHost({ panels }: { panels: readonly PanelSpec[] }) {
  const open = usePanelStore((state) => state.open)
  const closePanel = usePanelStore((state) => state.closePanel)
  const active = open === null ? null : panels.find((panel) => panel.id === open && panel.content !== null) ?? null
  if (active === null) return null
  return (
    <section
      aria-label={t(active.labelKey)}
      className="panel-host"
      data-panel={active.id}
      {...{ [PANEL_HOST_ATTR]: active.id }}
      role="region"
    >
      <header className="panel-host-head">
        <h2 id="panel-host-title">{t(active.labelKey)}</h2>
        <button
          aria-label={t('panel.close', { panel: t(active.labelKey) })}
          className="panel-host-close"
          onClick={closePanel}
          type="button"
        >
          {t('panel.close_label')}
        </button>
      </header>
      <div className="panel-host-body">{active.content}</div>
    </section>
  )
}
