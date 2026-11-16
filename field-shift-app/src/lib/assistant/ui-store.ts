/**
 * Field Shift AI UI state: whether the panel is open. It holds no map or field data (that stays in
 * `useMapStore`); it only lets the toggle in the control strip and the panel share one flag.
 */
import { create } from 'zustand'

type AssistantUiState = {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useAssistantUi = create<AssistantUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

export const ASSISTANT_PANEL_ID = 'field-shift-ai-panel'
export const ASSISTANT_TOGGLE_ATTR = 'data-field-shift-ai-toggle'
