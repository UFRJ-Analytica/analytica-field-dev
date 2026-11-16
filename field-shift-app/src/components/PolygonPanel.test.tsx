import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { PolygonPanel } from './PolygonPanel'
import { useMapStore } from '@/lib/map-store'
import type { PolygonScene } from '@/lib/polygon-source'
import { REGION_ADAPTERS } from '@/lib/regions'
import { UNMAPPED_CLASS_COLOUR } from '@/lib/polygon-style'

const usTiers = {
  detail: { minzoom: 9, maxzoom: 14 },
  overview: { minzoom: 6, maxzoom: 8 },
  interactiveMinzoom: 11,
}
const usScene: PolygonScene = {
  regionId: 'us',
  mode: 'self-hosted',
  classSource: 'cdl-year',
  tiers: usTiers,
  detailUrl: 'pmtiles:///data/polygons/us-38017-detail.pmtiles/{z}/{x}/{y}',
  overviewUrl: 'pmtiles:///data/polygons/us-38017-overview.pmtiles/{z}/{x}/{y}',
  failure: null,
}
const brScene: PolygonScene = {
  regionId: 'us',
  mode: 'self-hosted',
  classSource: 'cdl-year',
  tiers: { detail: { minzoom: 8, maxzoom: 12 }, overview: null, interactiveMinzoom: 10 },
  detailUrl: 'pmtiles:///data/polygons/br-mt-detail.pmtiles/{z}/{x}/{y}',
  overviewUrl: null,
  failure: null,
}

function setStore(partial: Record<string, unknown>) {
  useMapStore.setState({
    regionId: 'us',
    selectedPolygonId: null,
    polygonMode: null,
    polygonClass: null,
    polygonClassYear: null,
    polygonRaw: null,
    polygonSourceError: null,
    basemapFailed: false,
    basemapKeyMissing: false,
    basemapId: 'eox-s2cloudless-2024',
    legendRows: [],
    mapZoom: null,
    chosenDate: '2026-11-12',
    ...partial,
  } as never)
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Polygon region landmark and heading (R-42, AC-34)', () => {
  it('is a region named Polygon with a level two heading Selected polygon', () => {
    setStore({ polygonMode: usScene })
    render(<PolygonPanel />)
    const region = screen.getByRole('region', { name: 'Polygon' })
    const heading = within(region).getByRole('heading', { level: 2 })
    expect(heading.textContent).toBe('Selected polygon')
  })

  it('carries no interactive control', () => {
    setStore({ polygonMode: usScene, selectedPolygonId: '381825001868504' })
    render(<PolygonPanel />)
    const region = screen.getByRole('region', { name: 'Polygon' })
    expect(region.querySelectorAll('button, input, a, select, textarea, [tabindex]')).toHaveLength(0)
  })
})

describe('the content order of R-39', () => {

  it('prints the five readout rows in order as definition terms', () => {
    setStore({ polygonMode: usScene, selectedPolygonId: '381825001868504', polygonRaw: { classValue: 5, area: 153.18667449 }, polygonClass: { classId: 5, name: 'Soybeans', hex: '#267000', unmapped: false } })
    render(<PolygonPanel />)
    const terms = screen.getAllByRole('term').map((node) => node.textContent)
    expect(terms).toEqual(['Class', 'Area', 'Basis', 'Class year', 'Source'])
    const values = screen.getAllByRole('definition').map((node) => node.textContent)
    expect(values).toEqual(['Soybeans', '153.2 acres', 'retrieved', 'CDL 2025', REGION_ADAPTERS.us.sourceString])
  })
})

describe('the status lines of R-07, R-11, R-12, R-32 and R-35', () => {
  it('prints the failure line and neither zoom line when the United States has no build (AC-08, AC-05)', () => {
    setStore({
      polygonMode: { ...usScene, tiers: null, classSource: null, detailUrl: null, overviewUrl: null, failure: 'polygon.build_not_available' },
    })
    render(<PolygonPanel />)
    expect(screen.getByText('Polygon build not available')).toBeTruthy()
    expect(screen.queryByText(/Polygons from zoom/)).toBeNull()
    expect(screen.queryByText(/Select from zoom/)).toBeNull()
  })

  it('prints the source unavailable line for Brazil with neither mode answering', () => {
    setStore({
      regionId: 'us',
      polygonMode: { ...brScene, tiers: null, classSource: null, detailUrl: null, failure: 'polygon.source_unavailable' },
    })
    render(<PolygonPanel />)
    expect(screen.getByText('Polygon source unavailable')).toBeTruthy()
  })

  it('prints exactly one zoom line over the lowest mounted tier, and the select line only below the interactive zoom (AC-09)', () => {
    setStore({ polygonMode: usScene, mapZoom: 10 })
    const { unmount } = render(<PolygonPanel />)
    expect(screen.getAllByText(/^Polygons from zoom /)).toHaveLength(1)
    expect(screen.getByText('Polygons from zoom 6')).toBeTruthy()
    expect(screen.getByText('Select from zoom 11')).toBeTruthy()
    unmount()
    setStore({ polygonMode: usScene, mapZoom: 11 })
    render(<PolygonPanel />)
    expect(screen.queryByText(/Select from zoom/)).toBeNull()
    expect(screen.getByText('Polygons from zoom 6')).toBeTruthy()
  })

  it('never prints a failure line while a tier is mounted and the source answers (R-07)', () => {
    setStore({ polygonMode: brScene, mapZoom: 4, regionId: 'br' })
    render(<PolygonPanel />)
    expect(screen.queryByText('Polygon source unavailable')).toBeNull()
    expect(screen.getByText('Polygons from zoom 8')).toBeTruthy()
    expect(screen.getByText('Select from zoom 10')).toBeTruthy()
  })

  /**
   * AC-05, AC-09: Brazil Mode A mounts both tiers, so the line names the overview's 5.
   */
  it('names the overview floor in Brazil Mode A, where the overview file is mounted', () => {
    const modeA: PolygonScene = {
      ...brScene,
      tiers: { detail: { minzoom: 8, maxzoom: 12 }, overview: { minzoom: 5, maxzoom: 7 }, interactiveMinzoom: 10 },
      overviewUrl: 'pmtiles:///data/polygons/br-mt-overview.pmtiles/{z}/{x}/{y}',
    }
    setStore({ polygonMode: modeA, mapZoom: 6, regionId: 'br' })
    render(<PolygonPanel />)
    expect(screen.getByText('Polygons from zoom 5')).toBeTruthy()
    expect(screen.getByText('Select from zoom 10')).toBeTruthy()
  })

  /**
   * AC-05, AC-09: the gate measured Brazil Mode B at zoom 6, 7, 9 and 10 and the line read
   * `Polygons from zoom 5` while the lowest mounted tier was the detail at 8. The real Mode B scene
   * keeps the Table B overview numbers and mounts no overview URL; the old `brScene` fixture had
   * `overview: null`, so it never carried that state.
   */
  it('names the detail floor in Brazil Mode B, where the overview numbers are mounted by nothing', () => {
    const modeB: PolygonScene = {
      ...brScene,
      tiers: { detail: { minzoom: 8, maxzoom: 12 }, overview: { minzoom: 5, maxzoom: 7 }, interactiveMinzoom: 10 },
      overviewUrl: null,
    }
    for (const zoom of [6, 7, 9, 10]) {
      setStore({ polygonMode: modeB, mapZoom: zoom, regionId: 'br' })
      const { unmount } = render(<PolygonPanel />)
      expect(screen.getByText('Polygons from zoom 8')).toBeTruthy()
      expect(screen.queryByText('Polygons from zoom 5')).toBeNull()
      expect(screen.queryByText('Polygon source unavailable')).toBeNull()
      unmount()
    }
  })

  it('prints the Google key line when ?basemap=google was asked without a key (R-32)', () => {
    setStore({ polygonMode: brScene, basemapKeyMissing: true, regionId: 'br' })
    render(<PolygonPanel />)
    expect(screen.getByText('Google basemap needs an API key')).toBeTruthy()
  })

  it('prints the basemap line when a basemap tile failed (R-35)', () => {
    setStore({ polygonMode: brScene, basemapFailed: true, regionId: 'br' })
    render(<PolygonPanel />)
    expect(screen.getByText('Basemap unavailable')).toBeTruthy()
  })

  it('orders the status lines key, basemap, zoom, select (R-39), and the failure line stands alone (R-12)', () => {
    setStore({
      polygonMode: { ...brScene, failure: null },
      basemapKeyMissing: true,
      basemapFailed: true,
      mapZoom: 9,
      regionId: 'us',
      polygonSourceError: null,
    })
    render(<PolygonPanel />)
    // R-12: a failure line means no tier paints, so the zoom and select lines are absent with it.
    // The four lines below are the ones that can print together.
    const lines = [
      'Google basemap needs an API key',
      'Basemap unavailable',
      'Polygons from zoom 8',
      'Select from zoom 10',
    ]
    const text = screen.getByRole('region', { name: 'Polygon' }).textContent ?? ''
    let cursor = -1
    for (const line of lines) {
      const index = text.indexOf(line)
      expect(index, line).toBeGreaterThan(cursor)
      cursor = index
    }
  })

  it('orders the failure line alone, with no zoom or select line beside it (R-12)', () => {
    setStore({
      polygonMode: { ...brScene, failure: null },
      basemapKeyMissing: false,
      basemapFailed: false,
      mapZoom: 9,
      regionId: 'us',
      polygonSourceError: 'polygon.source_unavailable',
    })
    render(<PolygonPanel />)
    const text = screen.getByRole('region', { name: 'Polygon' }).textContent ?? ''
    expect(text).toContain('Polygon source unavailable')
    expect(text).not.toContain('Polygons from zoom')
    expect(text).not.toContain('Select from zoom')
  })
})

describe('the legend rows of R-37 and R-21', () => {
  it('lists the classes in view and the class not mapped row', () => {
    setStore({
      polygonMode: brScene,
      regionId: 'us',
      legendRows: [
        { classId: 15, name: 'Pasture', nameKey: null, hex: '#edde8e', unmapped: false },
        { classId: null, name: null, nameKey: 'polygon.class_not_mapped', hex: UNMAPPED_CLASS_COLOUR, unmapped: true },
      ],
    })
    render(<PolygonPanel />)
    const list = screen.getByRole('list', { name: 'Classes in view' })
    const items = within(list).getAllByRole('listitem').map((node) => node.textContent)
    expect(items).toEqual(['Pasture', 'class not mapped'])
  })

  it('prints the No CDL row with its year, and the class not mapped row, as two rows', () => {
    setStore({
      polygonMode: usScene,
      regionId: 'us',
      legendRows: [
        { classId: 5, name: 'Soybeans', nameKey: null, hex: '#267000', unmapped: false },
        { classId: null, name: null, nameKey: 'polygon.no_cdl_class', params: { year: 2025 }, hex: UNMAPPED_CLASS_COLOUR, unmapped: true },
        { classId: null, name: null, nameKey: 'polygon.class_not_mapped', hex: UNMAPPED_CLASS_COLOUR, unmapped: true },
      ],
    })
    render(<PolygonPanel />)
    const list = screen.getByRole('list', { name: 'Classes in view' })
    const items = within(list).getAllByRole('listitem').map((node) => node.textContent)
    expect(items).toEqual(['Soybeans', 'No CDL class for 2025', 'class not mapped'])
  })

  it('prints the empty text, and no rows, when the view holds no polygon', () => {
    setStore({ polygonMode: usScene, legendRows: [] })
    render(<PolygonPanel />)
    expect(screen.getByText('No crop polygon in view')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Classes in view' })).toBeNull()
  })
})

describe('the provenance, source and credit lines (R-33, R-38, AC-31)', () => {
  it('prints exactly one provenance, one source and one credit line in the United States', () => {
    setStore({ polygonMode: usScene, polygonClassYear: 2025, mapZoom: 11 })
    render(<PolygonPanel />)
    const text = screen.getByRole('region', { name: 'Polygon' }).textContent ?? ''
    expect(text.split('CDL 2025, Crop Sequence Boundaries 2025 release, retrieved').length - 1).toBe(1)
    expect(text.split(REGION_ADAPTERS.us.sourceString).length - 1).toBe(2)
    expect(text.split('EOxCloudless by EOX IT Services GmbH, CC BY-NC-SA 4.0').length - 1).toBe(1)
  })

  it('prints one provenance line even with no class source, the failure line in addition (R-38)', () => {
    setStore({ polygonMode: { ...usScene, tiers: null, classSource: null, failure: 'polygon.build_not_available' } })
    render(<PolygonPanel />)
    expect(screen.getByText('CDL 2025, Crop Sequence Boundaries 2025 release, retrieved')).toBeTruthy()
    expect(screen.getByText('Polygon build not available')).toBeTruthy()
  })
})

// The measured state of the gate (AC-05, AC-09): the manifest answers, so the scene carries
// tiers, but the tile files fail, so the map reports the source error and the region has no
// tier that paints. R-12 says both zoom lines are then absent and the failure line prints.
const usTiersFromManifest = {
  detail: { minzoom: 6, maxzoom: 14 },
  overview: { minzoom: 3, maxzoom: 5 },
  interactiveMinzoom: 8,
}

describe('no tier available after a source error prints no zoom line (R-07, R-12, AC-05, AC-09)', () => {
  it('AC-05: at zoom 3 the failure line prints and the zoom string is absent beside it', () => {
    setStore({
      polygonMode: { ...usScene, tiers: usTiersFromManifest },
      mapZoom: 3,
      polygonSourceError: 'polygon.build_not_available',
    })
    render(<PolygonPanel />)
    const region = screen.getByRole('region', { name: 'Polygon' })
    expect(screen.getByText('Polygon build not available')).toBeTruthy()
    expect(region.textContent ?? '').not.toContain('Polygons from zoom')
    expect(region.textContent ?? '').not.toContain('Select from zoom')
  })

  it('AC-09: at zoom 11 (the default view) the zoom string is absent when the US tier is absent', () => {
    setStore({
      polygonMode: { ...usScene, tiers: usTiersFromManifest },
      mapZoom: 11,
      polygonSourceError: 'polygon.build_not_available',
    })
    render(<PolygonPanel />)
    const region = screen.getByRole('region', { name: 'Polygon' })
    expect(screen.getByText('Polygon build not available')).toBeTruthy()
    expect(region.textContent ?? '').not.toContain('Polygons from zoom')
    expect(region.textContent ?? '').not.toContain('Select from zoom')
  })

  it('still prints the zoom line when the source answers (no regression on R-12)', () => {
    setStore({ polygonMode: { ...usScene, tiers: usTiersFromManifest }, mapZoom: 3, polygonSourceError: null })
    render(<PolygonPanel />)
    expect(screen.getByText('Polygons from zoom 3')).toBeTruthy()
    expect(screen.queryByText('Polygon build not available')).toBeNull()
  })
})

