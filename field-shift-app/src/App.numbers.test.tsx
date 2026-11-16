import { readFileSync } from 'node:fs'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMapStore } from '@/lib/map-store'
import { usePanelStore } from '@/lib/panel-store'
import { MapStub } from '@/test/maplibre-stub'
import { ptBR } from '@/strings/pt-BR'

vi.mock('maplibre-gl', async () => {
  const { MapStub: Stub } = await import('@/test/maplibre-stub')
  return {
    Map: Stub,
    NavigationControl: class {},
    AttributionControl: class {
      options: unknown
      constructor(options?: unknown) { this.options = options }
      onAdd() { return {} }
      onRemove() {}
    },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  }
})




beforeEach(() => {
  MapStub.reset()
  usePanelStore.setState({ open: null })
  useMapStore.setState({
    regionId: 'us',
    selectedFieldId: null,
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRing: null,
    chosenDate: null,
    numbersOpen: false,
    numbersLastRead: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  usePanelStore.setState({ open: null })
  useMapStore.setState({ regionId: 'us', selectedFieldId: null, selectedPolygonId: null, polygonClass: null, numbersOpen: false })
})


describe('the module boundaries and the catalogue (R-01, R-11, AC-01, AC-10)', () => {
  it('imports none of the four right edge modules from the numbers surface', () => {
    for (const file of ['src/components/NumbersView.tsx', 'src/components/NumbersToggle.tsx', 'src/lib/numbers.ts', 'src/lib/numbers-api.ts']) {
      const source = readFileSync(`${process.cwd()}/${file}`, 'utf8')
      for (const forbidden of ['CommandToggle', 'SupportingDataToggle', 'EvidencePanel', 'AgentBar']) {
        expect(source).not.toMatch(new RegExp(`from ['"][^'"]*${forbidden}['"]`))
      }
    }
  })

  it('keeps the pt-BR catalogue empty (R-11)', () => {
    expect(Object.keys(ptBR)).toEqual([])
  })

})
