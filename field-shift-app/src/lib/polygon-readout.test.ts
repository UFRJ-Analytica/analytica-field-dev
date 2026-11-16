import { afterEach, describe, expect, it, vi } from 'vitest'
import { REGION_ADAPTERS } from './regions'
import { BASEMAP_ADAPTERS, EOX_SHORT_CREDIT } from './basemap-adapters'
import {
  attributionCreditName,
  collapseAttributionControl,
  nameAttributionToggle,
  provenanceLine,
  rawFeatureFrom,
  readoutRows,
} from './polygon-readout'
import { en } from '@/strings/en'

const us = REGION_ADAPTERS.us

afterEach(() => {
  vi.restoreAllMocks()
})


describe('R-25 readout rows, United States (AC-21)', () => {
  const properties = { csbid: '381825001868504', csbacres: 153.18667449, cdl2025: 5 }

  it('prints exactly five rows in the order Class, Area, Basis, Class year, Source', () => {
    const { rows } = readoutRows({
      region: us,
      selected: true,
      raw: rawFeatureFrom(us, properties, 'cdl2025'),
      date: '2026-11-12',
      classSource: 'cdl-year',
    })
    expect(rows.map((row) => row.key)).toEqual(['class', 'area', 'basis', 'class_year', 'source'])
    expect(rows.map((row) => row.label)).toEqual(['Class', 'Area', 'Basis', 'Class year', 'Source'])
  })

  it('prints Soybeans, 153.2 acres, retrieved, CDL 2025 and the Table F string', () => {
    const { rows } = readoutRows({
      region: us,
      selected: true,
      raw: rawFeatureFrom(us, properties, 'cdl2025'),
      date: '2026-11-12',
      classSource: 'cdl-year',
    })
    expect(rows.map((row) => row.value)).toEqual([
      'Soybeans',
      '153.2 acres',
      'retrieved',
      'CDL 2025',
      us.sourceString,
    ])
  })

  it('prints Area not available when csbacres is absent, and never computes an area', () => {
    const { rows } = readoutRows({
      region: us,
      selected: true,
      raw: rawFeatureFrom(us, { csbid: '381825001868504', cdl2025: 5 }, 'cdl2025'),
      date: '2026-11-12',
      classSource: 'cdl-year',
    })
    expect(rows[1].value).toBe('Area not available')
  })

  it('paints and names the clamped year: 2019 date reads cdl2019, 2017 reads cdl2018', () => {
    const at2019 = readoutRows({
      region: us,
      selected: true,
      raw: rawFeatureFrom(us, { ...properties, cdl2019: 1 }, 'cdl2019'),
      date: '2019-06-01',
      classSource: 'cdl-year',
    })
    expect(at2019.rows[0].value).toBe('Corn')
    expect(at2019.rows[3].value).toBe('CDL 2019')
    const at2017 = readoutRows({
      region: us,
      selected: true,
      raw: rawFeatureFrom(us, { ...properties, cdl2018: 1 }, 'cdl2018'),
      date: '2017-01-01',
      classSource: 'cdl-year',
    })
    expect(at2017.rows[3].value).toBe('CDL 2018')
  })

  it('prints No CDL class for {Y} when cdl{Y} is absent or null (R-21)', () => {
    for (const cdl of [{}, { cdl2025: null }]) {
      const { rows } = readoutRows({
        region: us,
        selected: true,
        raw: rawFeatureFrom(us, { csbid: '381825001868504', csbacres: 10, ...cdl }, 'cdl2025'),
        date: '2026-11-12',
        classSource: 'cdl-year',
      })
      expect(rows[0].value).toBe('No CDL class for 2025')
    }
  })

  it('prints class not mapped for code 0 and for a code the table does not hold (R-21)', () => {
    for (const code of [0, 999]) {
      const { rows } = readoutRows({
        region: us,
        selected: true,
        raw: rawFeatureFrom(us, { csbid: '381825001868504', csbacres: 10, cdl2025: code }, 'cdl2025'),
        date: '2026-11-12',
        classSource: 'cdl-year',
      })
      expect(rows[0].value).toBe('class not mapped')
    }
  })

  it('prints empty Class and Area cells with no selection; the region rows stay', () => {
    const { rows } = readoutRows({
      region: us,
      selected: false,
      raw: null,
      date: '2026-11-12',
      classSource: 'cdl-year',
    })
    expect(rows.map((row) => row.key)).toEqual(['class', 'area', 'basis', 'class_year', 'source'])
    expect(rows[0].value).toBe('')
    expect(rows[1].value).toBe('')
    expect(rows[2].value).toBe('retrieved')
  })
})


describe('R-38 provenance line', () => {
  it('prints the CDL line with the painted year for the United States', () => {
    expect(provenanceLine(us, '2026-11-12')).toBe(
      'CDL 2025, Crop Sequence Boundaries 2025 release, retrieved',
    )
  })


})

describe('R-33 and OD-04: the compact control names both short credits', () => {
  it('composes the accessible name from the EOX short credit and the region source string', () => {
    const adapter = BASEMAP_ADAPTERS[0]
    const name = attributionCreditName(adapter, us)
    expect(name).toContain(EOX_SHORT_CREDIT)
    expect(name).toContain(us.sourceString)
  })

  it('writes the name onto the compact attribution button of the map container', () => {
    const container = document.createElement('div')
    container.innerHTML = '<button class="maplibregl-ctrl-attrib-button" aria-label="Toggle attribution"></button>'
    nameAttributionToggle(container, 'EOX credit · source')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('EOX credit · source')
  })

  it('does nothing when the compact button is not mounted', () => {
    const container = document.createElement('div')
    expect(() => nameAttributionToggle(container, 'x')).not.toThrow()
  })

  it('collapses a compact control that starts expanded, and leaves the press to MapLibre (AC-27)', () => {
    const container = document.createElement('div')
    container.innerHTML = '<details class="maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show" open></details>'
    expect(collapseAttributionControl(container)).toBe(true)
    const control = container.querySelector('details') as HTMLElement
    expect(control.classList.contains('maplibregl-compact-show')).toBe(false)
    expect(control.hasAttribute('open')).toBe(false)
    expect(control.classList.contains('maplibregl-compact')).toBe(true)
  })

  it('reports false when no compact control is mounted', () => {
    expect(collapseAttributionControl(document.createElement('div'))).toBe(false)
  })
})


describe('the catalog keys the readout reads', () => {
  it('has every label the five rows and the provenance use', () => {
    for (const key of [
      'polygon.rows.class',
      'polygon.rows.area',
      'polygon.rows.basis',
      'polygon.rows.class_year',
      'polygon.rows.source',
      'polygon.area_not_in_class_table',
      'polygon.area_not_available',
    ] as const) {
      expect(en[key]).toBeTruthy()
    }
  })
})
