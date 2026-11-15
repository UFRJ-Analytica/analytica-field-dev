import { beforeEach, describe, expect, it } from 'vitest'
import { PANEL_ORDER, PANEL_TOGGLE_ATTR, usePanelStore } from './panel-store'
import { useMapStore } from './map-store'

beforeEach(() => {
  usePanelStore.setState({ open: null, draft: null })
})

describe('block 5.5 B3: exactly one panel is open', () => {
  it('starts closed and opens one at a time', () => {
    expect(usePanelStore.getState().open).toBeNull()
    usePanelStore.getState().openPanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
    usePanelStore.getState().openPanel('decision')
    expect(usePanelStore.getState().open).toBe('decision')
  })

  it('toggles the same panel closed and another one open', () => {
    usePanelStore.getState().togglePanel('record')
    expect(usePanelStore.getState().open).toBe('record')
    usePanelStore.getState().togglePanel('record')
    expect(usePanelStore.getState().open).toBeNull()
    usePanelStore.getState().togglePanel('rotation')
    usePanelStore.getState().togglePanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
  })

  it('keeps the order of R-08 and one toggle attribute per panel', () => {
    expect(PANEL_ORDER).toEqual(['rotation', 'numbers', 'decision', 'record'])
    expect(Object.keys(PANEL_TOGGLE_ATTR)).toEqual([...PANEL_ORDER])
  })
})

describe('block 7 R-63: the drawing draft', () => {
  it('starts null and collects one vertex per press', () => {
    expect(usePanelStore.getState().draft).toBeNull()
    usePanelStore.getState().startDrawing()
    expect(usePanelStore.getState().draft).toEqual([])
    usePanelStore.getState().addVertex([-55.28, -11.9])
    usePanelStore.getState().addVertex([-55.27, -11.9])
    expect(usePanelStore.getState().draft).toEqual([[-55.28, -11.9], [-55.27, -11.9]])
    usePanelStore.getState().undoVertex()
    expect(usePanelStore.getState().draft).toEqual([[-55.28, -11.9]])
    usePanelStore.getState().stopDrawing()
    expect(usePanelStore.getState().draft).toBeNull()
  })

  it('ignores a vertex while the mode is closed', () => {
    usePanelStore.getState().addVertex([0, 0])
    expect(usePanelStore.getState().draft).toBeNull()
  })
})

describe('block 5.5 U4 and U5: one write for the whole polygon selection', () => {
  it('clears the class, the raw values and the ring when another polygon is selected', () => {
    useMapStore.setState({
      regionId: 'br',
      selectedPolygonId: '39',
      polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false },
      polygonClassYear: 2025,
      polygonRaw: { classValue: 39, area: 12.5 },
      polygonRing: [[-55.28, -11.9], [-55.27, -11.9], [-55.27, -11.88], [-55.28, -11.9]],
    })
    useMapStore.getState().selectField('trazo:41')
    const state = useMapStore.getState()
    expect(String(state.selectedPolygonId)).toBe('41')
    expect(state.polygonClass).toBeNull()
    expect(state.polygonClassYear).toBeNull()
    expect(state.polygonRaw).toBeNull()
    expect(state.polygonRing).toBeNull()
  })

  it('clears everything on the empty map click action', () => {
    useMapStore.setState({
      regionId: 'br',
      selectedPolygonId: '39',
      polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false },
      polygonRaw: { classValue: 39, area: 12.5 },
      polygonRing: [[-55.28, -11.9], [-55.27, -11.9], [-55.27, -11.88], [-55.28, -11.9]],
    })
    useMapStore.getState().clearPolygonSelection()
    const state = useMapStore.getState()
    expect(state.selectedPolygonId).toBeNull()
    expect(state.polygonClass).toBeNull()
    expect(state.polygonRaw).toBeNull()
    expect(state.polygonRing).toBeNull()
  })

  it('switches from a polygon to a fixture field in one write', () => {
    useMapStore.setState({ regionId: 'br', selectedPolygonId: '39', polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false } })
    useMapStore.getState().selectField('mt-santa-carmem-01')
    const state = useMapStore.getState()
    expect(state.selectedFieldId).toBe('mt-santa-carmem-01')
    expect(state.selectedPolygonId).toBeNull()
    expect(state.polygonClass).toBeNull()
  })
})
