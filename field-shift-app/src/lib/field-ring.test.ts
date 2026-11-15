import { describe, expect, it } from 'vitest'
import {
  MAX_AREA_HA,
  MAX_OVERLAP_PERCENT,
  closeRing,
  distinctVertexCount,
  overlapPercent,
  regionForRing,
  ringAreaHa,
  ringCentroid,
  ringSelfIntersects,
  ringWithinBounds,
} from './field-ring'

/** Table C's worked example: the four distinct vertices of the record. */
const EXAMPLE_RING: Array<[number, number]> = [
  [-55.285, -11.9],
  [-55.26, -11.9],
  [-55.26, -11.92],
  [-55.285, -11.92],
  [-55.285, -11.9],
]

/** A square ring of a requested area in hectares, at the equator, refined twice. */
function squareOfArea(areaHa: number, west = 0, south = 0): Array<[number, number]> {
  let size = 0.01
  for (let pass = 0; pass < 3; pass += 1) {
    const ring: Array<[number, number]> = [
      [west, south],
      [west + size, south],
      [west + size, south + size],
      [west, south + size],
      [west, south],
    ]
    const measured = ringAreaHa(ring)
    size *= Math.sqrt(areaHa / measured)
  }
  return [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ]
}

describe('Table C, the one area formula (R-38, R-40, AC-36)', () => {
  it('stores 606.2633 ha for the example ring of Table C', () => {
    expect(ringAreaHa(EXAMPLE_RING)).toBeCloseTo(606.2633, 3)
  })

  it('counts the four distinct vertices, not the repeated closing point', () => {
    expect(distinctVertexCount(EXAMPLE_RING)).toBe(4)
    expect(distinctVertexCount(closeRing(EXAMPLE_RING))).toBe(4)
  })

  it('closes an unclosed ring without changing its area (R-37)', () => {
    const open = EXAMPLE_RING.slice(0, 4) as Array<[number, number]>
    expect(closeRing(open)).toHaveLength(5)
    expect(ringAreaHa(open)).toBeCloseTo(ringAreaHa(EXAMPLE_RING), 9)
  })

  it('returns the area centroid, inside the example ring', () => {
    const [lon, lat] = ringCentroid(EXAMPLE_RING)
    expect(lon).toBeCloseTo(-55.2725, 4)
    expect(lat).toBeCloseTo(-11.91, 4)
  })
})

describe('the two region extents (R-40, AC-36)', () => {
  it('reads br for the example ring and us for the CSB pilot box', () => {
    expect(regionForRing(EXAMPLE_RING)).toBe('br')
    expect(regionForRing([[ -97.17, 46.93 ], [ -97.16, 46.93 ], [ -97.16, 46.94 ], [ -97.17, 46.94 ]])).toBe('us')
  })

  it('returns null outside both extents rather than guessing a region', () => {
    expect(regionForRing([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]])).toBeNull()
  })
})

describe('the ring tests of R-38', () => {
  it('accepts a square and rejects a bow tie', () => {
    const square: Array<[number, number]> = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]
    const bowTie: Array<[number, number]> = [[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.01]]
    expect(ringSelfIntersects(square)).toBe(false)
    expect(ringSelfIntersects(bowTie)).toBe(true)
  })

  it('rejects a point outside the longitude and latitude bounds', () => {
    expect(ringWithinBounds([[181, 0], [182, 0], [182, 1]])).toBe(false)
    expect(ringWithinBounds([[0, 95], [1, 95], [1, 96]])).toBe(false)
    expect(ringWithinBounds(EXAMPLE_RING)).toBe(true)
  })

  it('measures a ring of 5,000 distinct vertices without dropping a point', () => {
    const ring: Array<[number, number]> = []
    for (let i = 0; i < 5000; i += 1) {
      const angle = (i / 5000) * 2 * Math.PI
      ring.push([-55.27 + 0.01 * Math.cos(angle), -11.91 + 0.01 * Math.sin(angle)])
    }
    expect(distinctVertexCount(ring)).toBe(5000)
    expect(ringSelfIntersects(ring)).toBe(false)
    expect(ringAreaHa(ring)).toBeGreaterThan(0)
  })
})

describe('the overlap ratio of R-38 and AC-34', () => {
  it('reads 1.6 percent for a ring that overlaps its neighbour by 1.6 percent', () => {
    const existing = squareOfArea(1000, 0, 0)
    const size = existing[1][0] - existing[0][0]
    const candidate = squareOfArea(1000, size * 0.9836, 0)
    expect(overlapPercent(candidate, existing)).toBeCloseTo(1.6, 1)
  })

  it('reads 0.6 percent for a ring that overlaps its neighbour by 0.6 percent', () => {
    const existing = squareOfArea(1000, 0, 0)
    const size = existing[1][0] - existing[0][0]
    const candidate = squareOfArea(1000, size * 0.9938, 0)
    expect(overlapPercent(candidate, existing)).toBeCloseTo(0.6, 1)
  })

  it('reads 0 for two rings that touch only at an edge', () => {
    const existing = squareOfArea(500, 0, 0)
    const size = Math.abs(existing[1][0] - existing[0][0])
    const neighbour = squareOfArea(500, size, 0)
    expect(overlapPercent(neighbour, existing)).toBeLessThan(MAX_OVERLAP_PERCENT)
  })
})

describe('the two design constants of Table D (M-13, OD-07)', () => {
  it('keeps the 2,000 ha cap and the 1 percent overlap', () => {
    expect(MAX_AREA_HA).toBe(2000)
    expect(MAX_OVERLAP_PERCENT).toBe(1)
  })
})
