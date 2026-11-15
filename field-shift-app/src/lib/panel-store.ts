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

export const usePanelStore = create<PanelState>((set, get) => {
  /**
   * The drawing mode lives exactly as long as the `Field record` panel is open. `startDrawing` sets
   * `draft: []` and only `stopDrawing` used to clear it, and `stopDrawing` runs on save, cancel and
   * import but never when the panel closes, so pressing the draw control once and closing the panel
   * left `draft` non null. Every later press on the map then added a vertex instead of selecting the
   * polygon under it: no selection, no highlight, nothing happened, for the rest of the tab's life.
   * Ending it here, in the three actions that change `open`, keeps one place and needs no effect.
   */
  const nextOpenState = (state: PanelState, next: PanelId | null) => ({
    open: next,
    // The vertices survive while the record panel stays open and die the moment it does not.
    draft: next === 'record' ? state.draft : null,
  })
  return {
    open: null,
    openPanel: (id) => set((state) => nextOpenState(state, id)),
    closePanel: () => set((state) => nextOpenState(state, null)),
    togglePanel: (id) => set((state) => nextOpenState(state, get().open === id ? null : id)),
    draft: null,
    startDrawing: () => set({ draft: [] }),
    addVertex: (point) => set((state) => ({ draft: state.draft === null ? null : [...state.draft, point] })),
    undoVertex: () => set((state) => ({ draft: state.draft === null ? null : state.draft.slice(0, -1) })),
    stopDrawing: () => set({ draft: null }),
  }
})
