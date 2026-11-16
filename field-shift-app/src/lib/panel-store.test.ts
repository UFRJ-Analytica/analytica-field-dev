import { beforeEach, describe, expect, it } from 'vitest'
import { PANEL_ORDER, PANEL_TOGGLE_ATTR, usePanelStore } from './panel-store'
import { useMapStore } from './map-store'

beforeEach(() => {
  usePanelStore.setState({ open: null })
})

// The strip cleanup (PR #42) left `Field Data` (`numbers`) as the only panel and removed the drawing
// draft with the `Field record` panel, so these cases cover the store as it is now.
describe('block 5.5 B3: at most one panel is open', () => {
  it('starts closed, opens and closes the panel', () => {
    expect(usePanelStore.getState().open).toBeNull()
    usePanelStore.getState().openPanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
    usePanelStore.getState().closePanel()
    expect(usePanelStore.getState().open).toBeNull()
  })

  it('toggles the same panel open and closed', () => {
    usePanelStore.getState().togglePanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
    usePanelStore.getState().togglePanel('numbers')
    expect(usePanelStore.getState().open).toBeNull()
  })

  it('keeps the strip order and one toggle attribute per panel', () => {
    expect(PANEL_ORDER).toEqual(['numbers'])
    expect(Object.keys(PANEL_TOGGLE_ATTR)).toEqual([...PANEL_ORDER])
  })
})

describe('block 5.5 U4 and U5: one write for the whole polygon selection', () => {
  it('clears the class, the raw values and the ring when another polygon is selected', () => {
    useMapStore.setState({
      regionId: 'us',
      selectedPolygonId: '39',
      polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false },
      polygonClassYear: 2025,
      polygonRaw: { classValue: 39, area: 12.5 },
      polygonRing: [[-55.28, -11.9], [-55.27, -11.9], [-55.27, -11.88], [-55.28, -11.9]],
    })
    useMapStore.getState().selectField('csb:381825001868622')
    const state = useMapStore.getState()
    expect(String(state.selectedPolygonId)).toBe('381825001868622')
    expect(state.polygonClass).toBeNull()
    expect(state.polygonClassYear).toBeNull()
    expect(state.polygonRaw).toBeNull()
    expect(state.polygonRing).toBeNull()
  })

  it('clears everything on the empty map click action', () => {
    useMapStore.setState({
      regionId: 'us',
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
    useMapStore.setState({ regionId: 'us', selectedPolygonId: '39', polygonClass: { classId: 39, name: 'Soybean', hex: '#f5b3c8', unmapped: false } })
    useMapStore.getState().selectField('mt-santa-carmem-01')
    const state = useMapStore.getState()
    expect(state.selectedFieldId).toBe('mt-santa-carmem-01')
    expect(state.selectedPolygonId).toBeNull()
    expect(state.polygonClass).toBeNull()
  })
})
