/**
 * Block 5.5, B3 and R-06 of block 7 revision 10: which of the four panels is open.
 *
 * One value holds the answer, so exactly one panel can be open at a time by construction and no
 * panel opens by itself: the store starts closed and only a press on a button writes it. The URL
 * records nothing here (block 7 R-09), and nothing outside this module decides which panel is open.
 */
import { create } from 'zustand'

export type PanelId = 'rotation' | 'numbers' | 'decision' | 'record'

/** The order of R-08 of block 7 revision 10, which is the order of the strip. */
export const PANEL_ORDER: readonly PanelId[] = ['rotation', 'numbers', 'decision', 'record']

/** The data attribute each button is found by, for the focus return after a panel closes. */
export const PANEL_TOGGLE_ATTR: Record<PanelId, string> = {
  rotation: 'data-rotation-toggle',
  numbers: 'data-numbers-toggle',
  decision: 'data-decision-toggle',
  record: 'data-record-toggle',
}

export type DraftPoint = [number, number]

type PanelState = {
  open: PanelId | null
  openPanel: (id: PanelId) => void
  closePanel: () => void
  togglePanel: (id: PanelId) => void
  /**
   * Block 7 revision 10 R-63: the boundary drawing mode. `draft` is null while the mode is closed,
   * and an array of vertices, possibly empty, while the map is taking the drawing pointer events.
   * The map appends a vertex per click and the panel renders the instructions and the controls.
   */
  draft: DraftPoint[] | null
  startDrawing: () => void
  addVertex: (point: DraftPoint) => void
  undoVertex: () => void
  stopDrawing: () => void
}

export const usePanelStore = create<PanelState>((set, get) => ({
  open: null,
  openPanel: (id) => set({ open: id }),
  closePanel: () => set({ open: null }),
  togglePanel: (id) => set({ open: get().open === id ? null : id }),
  draft: null,
  startDrawing: () => set({ draft: [] }),
  addVertex: (point) => set((state) => ({ draft: state.draft === null ? null : [...state.draft, point] })),
  undoVertex: () => set((state) => ({ draft: state.draft === null ? null : state.draft.slice(0, -1) })),
  stopDrawing: () => set({ draft: null }),
}))
