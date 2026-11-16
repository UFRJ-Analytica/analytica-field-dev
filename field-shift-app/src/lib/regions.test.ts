import { describe, expect, it } from 'vitest'
import { classTableFor, parseUsManifest } from './regions'

const manifest = {
  schema_version: '1',
  region: 'us',
  clip_box: '-97.20,46.90,-97.14,46.96',
  detail_minzoom: 6,
  detail_maxzoom: 14,
  overview_minzoom: 3,
  overview_maxzoom: 5,
  interactive_minzoom: 8,
}


describe('class tables (R-16, R-17)', () => {

  it('carries the 255 United States rows from values 1 to 255 with code 0 excluded', () => {
    const table = classTableFor('us')
    expect(table.rows).toHaveLength(255)
    expect(table.rows[0].value).toBe(1)
    expect(table.rows[254].value).toBe(255)
    expect(table.rows.some((row) => row.value === 0)).toBe(false)
    const byValue = new Map(table.rows.map((row) => [row.value, row]))
    expect(byValue.get(1)).toMatchObject({ name: 'Corn', hex: '#ffd300' })
    expect(byValue.get(5)).toMatchObject({ name: 'Soybeans', hex: '#267000' })
    expect(byValue.get(6)).toMatchObject({ name: 'Sunflower', hex: '#ffff00' })
    expect(byValue.get(176)).toMatchObject({ name: 'Grassland/Pasture', hex: '#e8ffbf' })
    expect(byValue.get(123)?.name).toBe('Developed/Med Intensity')
    expect(table.source.sha256).toBe('8b5cec2ff965a2d1f7f1205111b3a0fbe3cce5ed82cb0ef6a446ae304fe0b699')
  })
})

describe('the manifest contract (AC-03, R-05, Table G)', () => {
  it('accepts the recorded manifest and derives the three zoom values', () => {
    const parsed = parseUsManifest(manifest)
    expect(parsed.detail_minzoom).toBe(6)
    expect(parsed.detail_maxzoom).toBe(14)
    expect(parsed.overview_minzoom).toBe(3)
    expect(parsed.overview_maxzoom).toBe(5)
    expect(parsed.interactive_minzoom).toBe(8)
  })

  it('fails on a missing key, a key outside Table G, or a broken rule', () => {
    const { clip_box: _clip, ...missing } = manifest
    expect(() => parseUsManifest(missing)).toThrow(/clip_box/)
    expect(() => parseUsManifest({ ...manifest, extra: 1 })).toThrow(/extra/)
    expect(() => parseUsManifest({ ...manifest, schema_version: 1 })).toThrow(/schema_version/)
    expect(() => parseUsManifest({ ...manifest, region: 'br' })).toThrow(/region/)
    expect(() => parseUsManifest({ ...manifest, clip_box: '-97.2,46.9,-97.1,46.96' })).toThrow(/clip_box/)
    expect(() => parseUsManifest({ ...manifest, detail_maxzoom: 13 })).toThrow(/detail_maxzoom/)
    expect(() => parseUsManifest({ ...manifest, overview_minzoom: 2 })).toThrow(/overview_minzoom/)
    expect(() => parseUsManifest({ ...manifest, overview_maxzoom: 6 })).toThrow(/overview_maxzoom/)
    expect(() => parseUsManifest({ ...manifest, interactive_minzoom: 9 })).toThrow(/interactive_minzoom/)
    expect(() => parseUsManifest({ ...manifest, detail_minzoom: 10, overview_minzoom: 7, overview_maxzoom: 9, interactive_minzoom: 12 }))
      .toThrow(/detail_minzoom/)
    expect(() => parseUsManifest(null)).toThrow()
  })


})
