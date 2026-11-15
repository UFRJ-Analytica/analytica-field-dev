import { describe, expect, it } from 'vitest'
import { readGeoJSON, readKML, validateRing } from './boundary-import'
import { ringAreaHa } from './field-ring'

const POLYGON: Array<[number, number]> = [[-55.285, -11.9], [-55.26, -11.9], [-55.26, -11.92], [-55.285, -11.92], [-55.285, -11.9]]
const POLYGON_OPEN: Array<[number, number]> = POLYGON.slice(0, 4)

function squareOfArea(areaHa: number, west = 0, south = 0): Array<[number, number]> {
  let size = 0.01
  for (let pass = 0; pass < 3; pass += 1) {
    const ring: Array<[number, number]> = [
      [west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south],
    ]
    size *= Math.sqrt(areaHa / ringAreaHa(ring))
  }
  return [
    [west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south],
  ]
}

describe('the GeoJSON reader (R-37, AC-33)', () => {
  it('reads a Feature of type Polygon', () => {
    const text = JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [POLYGON] } })
    const result = readGeoJSON(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ring).toEqual(POLYGON)
  })

  it('reads a bare Polygon geometry', () => {
    const result = readGeoJSON(JSON.stringify({ type: 'Polygon', coordinates: [POLYGON] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ring).toEqual(POLYGON)
  })

  it('reads a FeatureCollection holding exactly one polygon feature', () => {
    const text = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: null, geometry: { type: 'Polygon', coordinates: [POLYGON] } }],
    })
    const result = readGeoJSON(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ring).toEqual(POLYGON)
  })

  it('closes an unclosed ring, and that is not an error', () => {
    const result = readGeoJSON(JSON.stringify({ type: 'Polygon', coordinates: [POLYGON_OPEN] }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ring).toHaveLength(5)
      expect(result.ring[0]).toEqual(result.ring[4])
    }
  })

  it('rejects a MultiPolygon with V-03', () => {
    const text = JSON.stringify({ type: 'MultiPolygon', coordinates: [[[POLYGON]]] })
    expect(readGeoJSON(text)).toEqual({ ok: false, code: 'import.multi_polygon' })
  })

  it('rejects a FeatureCollection with two polygons with V-03', () => {
    const feature = { type: 'Feature', properties: null, geometry: { type: 'Polygon', coordinates: [POLYGON] } }
    const text = JSON.stringify({ type: 'FeatureCollection', features: [feature, feature] })
    expect(readGeoJSON(text)).toEqual({ ok: false, code: 'import.multi_polygon' })
  })

  it('rejects a polygon with a hole with V-04', () => {
    const hole = [[-55.28, -11.905], [-55.27, -11.905], [-55.27, -11.91], [-55.28, -11.905]]
    const text = JSON.stringify({ type: 'Polygon', coordinates: [POLYGON, hole] })
    expect(readGeoJSON(text)).toEqual({ ok: false, code: 'import.holes' })
  })

  it('rejects a file with no polygon with V-02 and unreadable text with V-01', () => {
    expect(readGeoJSON(JSON.stringify({ type: 'FeatureCollection', features: [] }))).toEqual({ ok: false, code: 'import.no_polygon' })
    expect(readGeoJSON(JSON.stringify({ type: 'Point', coordinates: [0, 0] }))).toEqual({ ok: false, code: 'import.no_polygon' })
    expect(readGeoJSON('{not json')).toEqual({ ok: false, code: 'import.unreadable' })
  })
})

describe('the KML reader (R-37, AC-33)', () => {
  const kml = (coordinates: string, extra = ''): string => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Polygon>
<outerBoundaryIs><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></outerBoundaryIs>${extra}
</Polygon></Placemark></Document></kml>`

  it('reads a KML 2.2 polygon into the same ring as the GeoJSON form', () => {
    const text = kml('-55.285,-11.9,0 -55.26,-11.9,0 -55.26,-11.92,0 -55.285,-11.92,0 -55.285,-11.9,0')
    const result = readKML(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ring).toEqual(POLYGON)
  })

  it('rejects a document with two polygons with V-05', () => {
    const text = `<?xml version="1.0"?><kml><Document><Placemark><Polygon>
<outerBoundaryIs><LinearRing><coordinates>-55.285,-11.9 -55.26,-11.9 -55.26,-11.92</coordinates></LinearRing></outerBoundaryIs>
</Polygon></Placemark><Placemark><Polygon>
<outerBoundaryIs><LinearRing><coordinates>-55.285,-11.9 -55.26,-11.9 -55.26,-11.92</coordinates></LinearRing></outerBoundaryIs>
</Polygon></Placemark></Document></kml>`
    expect(readKML(text)).toEqual({ ok: false, code: 'import.kml_polygons' })
  })

  it('rejects a polygon with an inner boundary with V-04', () => {
    const inner = '<innerBoundaryIs><LinearRing><coordinates>-55.28,-11.905 -55.27,-11.905 -55.27,-11.91</coordinates></LinearRing></innerBoundaryIs>'
    const text = kml('-55.285,-11.9 -55.26,-11.9 -55.26,-11.92 -55.285,-11.9', inner)
    expect(readKML(text)).toEqual({ ok: false, code: 'import.holes' })
  })

  it('rejects a document with no polygon with V-05', () => {
    expect(readKML('<?xml version="1.0"?><kml><Document /></kml>')).toEqual({ ok: false, code: 'import.kml_polygons' })
  })
})

describe('the validator of Table D (R-38, AC-34)', () => {
  it('accepts the example ring and returns its area', () => {
    const result = validateRing(POLYGON)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.areaHa).toBeCloseTo(606.2633, 3)
  })

  it('rejects a two point ring with V-06', () => {
    expect(validateRing([[0, 0], [1, 1]])).toEqual({ ok: false, code: 'import.too_few_points' })
  })

  it('rejects three collinear points with V-09 and no other rule', () => {
    expect(validateRing([[0, 0], [0.001, 0], [0.002, 0]])).toEqual({ ok: false, code: 'import.no_area' })
  })

  it('rejects a bow tie with V-08', () => {
    const square = squareOfArea(100, 0, 0)
    const bowTie: Array<[number, number]> = [square[0], square[2], square[1], square[3], square[0]]
    expect(validateRing(bowTie)).toEqual({ ok: false, code: 'import.self_intersection' })
  })

  it('rejects a point at longitude 181 with V-10', () => {
    const ring: Array<[number, number]> = [[181, 0], [181.01, 0], [181.01, 0.01], [181, 0]]
    expect(validateRing(ring)).toEqual({ ok: false, code: 'import.out_of_bounds' })
  })

  it('rejects 5,001 distinct vertices with V-07 and accepts 5,000', () => {
    const circle = (count: number): Array<[number, number]> => {
      const ring: Array<[number, number]> = []
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * 2 * Math.PI
        ring.push([-55.27 + 0.01 * Math.cos(angle), -11.91 + 0.01 * Math.sin(angle)])
      }
      return ring
    }
    expect(validateRing(circle(5001))).toEqual({ ok: false, code: 'import.too_many_points' })
    expect(validateRing(circle(5000)).ok).toBe(true)
  })

  it('rejects 2,001 ha with V-11 and accepts 1,999 ha', () => {
    expect(validateRing(squareOfArea(2001, 0, 0))).toEqual({ ok: false, code: 'import.too_large' })
    expect(validateRing(squareOfArea(1999, 0, 0)).ok).toBe(true)
  })

  it('rejects an overlap of 1.6 percent with V-12 and accepts 0.6 percent', () => {
    const existing = squareOfArea(1000, 0, 0)
    const size = Math.abs(existing[1][0] - existing[0][0])
    const heavy = [existing, squareOfArea(1000, size * 0.9836, 0)]
    const light = [existing, squareOfArea(1000, size * 0.9938, 0)]
    expect(validateRing(heavy[1], [heavy[0]])).toEqual({ ok: false, code: 'import.overlap' })
    expect(validateRing(light[1], [light[0]]).ok).toBe(true)
  })
})
