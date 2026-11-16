import { beforeEach, describe, expect, it } from 'vitest'
import { usePanelStore } from './panel-store'
import { useMapStore } from './map-store'

beforeEach(() => {
  usePanelStore.setState({ open: null })
})

describe('block 5.5 B3: exactly one panel is open', () => {
  it('starts closed and opens the one panel', () => {
    expect(usePanelStore.getState().open).toBeNull()
    usePanelStore.getState().openPanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
  })

  it('toggles the same panel closed again', () => {
    usePanelStore.getState().togglePanel('numbers')
    expect(usePanelStore.getState().open).toBe('numbers')
    usePanelStore.getState().togglePanel('numbers')
    expect(usePanelStore.getState().open).toBeNull()
  })

})


describe('block 5.5 U4 and U5: one write for the whole polygon selection', () => {

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
