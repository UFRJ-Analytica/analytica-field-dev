/**
 * Block 5.5, B3: which of the panels is open.
 *
 * One value holds the answer, so exactly one panel can be open at a time by construction and no
 * panel opens by itself: the store starts closed and only a press on a button writes it. The URL
 * records nothing here, and nothing outside this module decides which panel is open. The drawing
 * mode went with the `Field record` panel, so there is no draft here any more.
 */
import { create } from 'zustand'

export type PanelId = 'numbers'

/** The order of the strip: `Field Data` is the only panel left. */
export const PANEL_ORDER: readonly PanelId[] = ['numbers']

/** The data attribute each button is found by, for the focus return after a panel closes. */
export const PANEL_TOGGLE_ATTR: Record<PanelId, string> = {
  numbers: 'data-numbers-toggle',
}

type PanelState = {
  open: PanelId | null
  openPanel: (id: PanelId) => void
  closePanel: () => void
  togglePanel: (id: PanelId) => void
}

export const usePanelStore = create<PanelState>((set, get) => ({
  open: null,
  openPanel: (id) => set({ open: id }),
  closePanel: () => set({ open: null }),
  togglePanel: (id) => set({ open: get().open === id ? null : id }),
}))
