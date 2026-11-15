/**
 * Block 7, R-38, R-40 and Table C: the ring arithmetic of the field record.
 *
 * One module holds the spherical area of Table C, the ring's centroid, the self intersection test,
 * the two region extents and the overlap ratio, because R-38 and R-40 name one formula and one
 * overlap each and a second implementation of either would be a defect. Angles are converted once,
 * here, and every caller reads the same numbers.
 *
 * R-38 forbids the overlap verdict to depend on the camera: nothing in this module reads the map,
 * the view, the zoom, the pan or the width.
 */

/** Table C: the WGS 84 equatorial radius, in metres. */
export const WGS84_RADIUS_M = 6378137

/** Table C: square metres to hectares. */
const M2_PER_HA = 10000

/** Table C: the two region extents, the Trazo3 extract box of block 5 R-10 and the CSB pilot box. */
export const REGION_EXTENTS = {
  br: { west: -61.633, south: -18.0416, east: -50.2248, north: -7.3487 },
  us: { west: -97.2, south: 46.9, east: -97.14, north: 46.96 },
} as const

export type RingPoint = [number, number]
export type Ring = RingPoint[]

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/** Two points are the same vertex when they agree to a millimetre of a degree (about 0.1 m). */
function samePoint(a: RingPoint, b: RingPoint): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
}

/**
 * R-37 and R-38: the ring with its repeated closing point removed, which is the ring the formula
 * counts. A ring that is not closed stays as it is; closing a ring is not an error (R-37).
 */
export function openRing(ring: readonly RingPoint[]): Ring {
  const points = ring.map((point) => [point[0], point[1]] as RingPoint)
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop()
  return points
}

/** R-37: a ring that is not closed is closed by repeating its first point. */
export function closeRing(ring: readonly RingPoint[]): Ring {
  const open = openRing(ring)
  if (open.length === 0) return open
  return [...open, [open[0][0], open[0][1]]]
}

/** Table C: the number of distinct vertices, the closing repeated point removed. */
export function distinctVertexCount(ring: readonly RingPoint[]): number {
  return openRing(ring).length
}

/**
 * Table C, the one area formula of this block: S is the sum over i of
 * `(lon[i+2] - lon[i]) * sin(lat[i+1])` with indices modulo n over the distinct vertices, and
 * `area_m2 = |S| * R * R / 2`. The example ring of Table C reproduces 606.2633 ha.
 */
export function ringAreaHa(ring: readonly RingPoint[]): number {
  const points = openRing(ring)
  const n = points.length
  if (n < 3) return 0
  let sum = 0
  for (let i = 0; i < n; i += 1) {
    const lonNext = toRadians(points[(i + 2) % n][0])
    const lonPrev = toRadians(points[i][0])
    sum += (lonNext - lonPrev) * Math.sin(toRadians(points[(i + 1) % n][1]))
  }
  return (Math.abs(sum) * WGS84_RADIUS_M * WGS84_RADIUS_M) / 2 / M2_PER_HA
}

/** R-38: at most 2,000 ha and a non zero area are two of its rules; both read this value. */
export const MAX_AREA_HA = 2000

/** R-38: at most 5,000 vertices. */
export const MAX_VERTICES = 5000

/** R-38: at most 1 percent of the smaller ring. */
export const MAX_OVERLAP_PERCENT = 1

/** R-40: the area centroid of the ring, or the mean of its vertices when it encloses no area. */
export function ringCentroid(ring: readonly RingPoint[]): RingPoint {
  const points = openRing(ring)
  if (points.length === 0) return [0, 0]
  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    const cross = x0 * y1 - x1 * y0
    twiceArea += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(twiceArea) < 1e-18) {
    const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length
    const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length
    return [meanX, meanY]
  }
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)]
}

/** R-40: `br` or `us` when the centroid falls inside that extent, null otherwise. No third extent. */
export function regionForRing(ring: readonly RingPoint[]): 'br' | 'us' | null {
  const [lon, lat] = ringCentroid(ring)
  for (const region of ['br', 'us'] as const) {
    const box = REGION_EXTENTS[region]
    if (lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north) return region
  }
  return null
}

function orientation(a: RingPoint, b: RingPoint, c: RingPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: RingPoint, b: RingPoint, p: RingPoint): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12
    && Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12
  )
}

/** Two segments cross when the orientations differ on both sides, or when an end lies on the other. */
function segmentsCross(a: RingPoint, b: RingPoint, c: RingPoint, d: RingPoint): boolean {
  const d1 = orientation(a, b, c)
  const d2 = orientation(a, b, d)
  const d3 = orientation(c, d, a)
  const d4 = orientation(c, d, b)
  const straddle = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  if (straddle) return true
  if (Math.abs(d1) < 1e-15 && onSegment(a, b, c)) return true
  if (Math.abs(d2) < 1e-15 && onSegment(a, b, d)) return true
  if (Math.abs(d3) < 1e-15 && onSegment(c, d, a)) return true
  if (Math.abs(d4) < 1e-15 && onSegment(c, d, b)) return true
  return false
}

/**
 * R-38, V-08: whether any two non adjacent segments of the ring cross. Adjacent segments share a
 * vertex by construction, and the closing segment is adjacent to the first and the last one.
 */
export function ringSelfIntersects(ring: readonly RingPoint[]): boolean {
  const points = openRing(ring)
  const n = points.length
  if (n < 4) return false
  for (let i = 0; i < n; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % n]
    for (let j = i + 1; j < n; j += 1) {
      // Adjacent pairs share a vertex: (i, i+1) and (i+1, i+2), and the pair (0, n-1).
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue
      const c = points[j]
      const d = points[(j + 1) % n]
      if (segmentsCross(a, b, c, d)) return true
    }
  }
  return false
}

/** R-38: every longitude within -180 to 180 and every latitude within -90 to 90. */
export function ringWithinBounds(ring: readonly RingPoint[]): boolean {
  return ring.every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)
}

function insideRing(ring: readonly RingPoint[], point: RingPoint): boolean {
  const points = openRing(ring)
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** A ring is convex when every turn has the same sign; a collinear ring is not convex. */
function isConvexRing(ring: readonly RingPoint[]): boolean {
  const points = openRing(ring)
  if (points.length < 3) return false
  let sign = 0
  for (let i = 0; i < points.length; i += 1) {
    const turn = orientation(points[i], points[(i + 1) % points.length], points[(i + 2) % points.length])
    if (Math.abs(turn) < 1e-15) continue
    const next = turn > 0 ? 1 : -1
    if (sign === 0) sign = next
    else if (sign !== next) return false
  }
  return sign !== 0
}

/** Sutherland-Hodgman: the part of `subject` inside the convex `clip` polygon. */
function clipToConvex(subject: readonly RingPoint[], clip: readonly RingPoint[]): Ring {
  let output = openRing(subject)
  const clipRing = openRing(clip)
  for (let i = 0; i < clipRing.length && output.length > 0; i += 1) {
    const a = clipRing[i]
    const b = clipRing[(i + 1) % clipRing.length]
    const input = output
    output = []
    const side = (point: RingPoint): number => orientation(a, b, point)
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j]
      const previous = input[(j + input.length - 1) % input.length]
      const currentIn = side(current) >= -1e-15
      const previousIn = side(previous) >= -1e-15
      if (currentIn) {
        if (!previousIn) output.push(intersectionPoint(previous, current, a, b))
        output.push(current)
      } else if (previousIn) {
        output.push(intersectionPoint(previous, current, a, b))
      }
    }
  }
  return output
}

function intersectionPoint(p1: RingPoint, p2: RingPoint, p3: RingPoint, p4: RingPoint): RingPoint {
  const d1x = p2[0] - p1[0]
  const d1y = p2[1] - p1[1]
  const d2x = p4[0] - p3[0]
  const d2y = p4[1] - p3[1]
  const denominator = d1x * d2y - d1y * d2x
  if (Math.abs(denominator) < 1e-18) return [p2[0], p2[1]]
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denominator
  return [p1[0] + t * d1x, p1[1] + t * d1y]
}

/**
 * R-38: the intersection area in hectares. The fast path clips a subject against a convex clip
 * polygon exactly (Sutherland-Hodgman). When the clip polygon is not convex the area is measured on
 * a 400 by 400 sample grid over the overlap of the two bounding boxes, which is the documented
 * approximation of this module: the verdict it feeds is a 1 percent threshold, and the grid
 * resolves 0.06 percent of a ring of the median 22.4 ha polygon.
 */
export function intersectionAreaHa(a: readonly RingPoint[], b: readonly RingPoint[]): number {
  const areaA = ringAreaHa(a)
  const areaB = ringAreaHa(b)
  if (areaA === 0 || areaB === 0) return 0
  if (isConvexRing(b)) {
    const clipped = clipToConvex(a, b)
    if (clipped.length < 3) return 0
    return Math.min(ringAreaHa(clipped), Math.min(areaA, areaB))
  }
  const box = boundingBox([...a, ...b])
  const overlapBox = intersectBoxes(boundingBox(a), boundingBox(b))
  if (!overlapBox) return 0
  const steps = 400
  const dx = (overlapBox.east - overlapBox.west) / steps
  const dy = (overlapBox.north - overlapBox.south) / steps
  let hits = 0
  for (let ix = 0; ix < steps; ix += 1) {
    for (let iy = 0; iy < steps; iy += 1) {
      const point: RingPoint = [overlapBox.west + (ix + 0.5) * dx, overlapBox.south + (iy + 0.5) * dy]
      if (insideRing(a, point) && insideRing(b, point)) hits += 1
    }
  }
  // The sampled cells cover the overlap box; the share of hits times the ring's own area is the
  // intersection, bounded by the smaller ring.
  const cellArea = (overlapBox.east - overlapBox.west) * (overlapBox.north - overlapBox.south) / (steps * steps)
  const squareHa = cellArea * (Math.PI / 180) * WGS84_RADIUS_M / 180 * WGS84_RADIUS_M / M2_PER_HA
  void box
  return Math.min(hits * squareHa, Math.min(areaA, areaB))
}

type Box = { west: number; south: number; east: number; north: number }

function boundingBox(ring: readonly RingPoint[]): Box {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return { west, south, east, north }
}

function intersectBoxes(a: Box, b: Box): Box | null {
  const west = Math.max(a.west, b.west)
  const east = Math.min(a.east, b.east)
  const south = Math.max(a.south, b.south)
  const north = Math.min(a.north, b.north)
  if (west >= east || south >= north) return null
  return { west, south, east, north }
}

/**
 * R-38: the overlap of two rings as a percentage of the smaller of the two, rounded to one decimal.
 * The caller compares it with MAX_OVERLAP_PERCENT.
 */
export function overlapPercent(candidate: readonly RingPoint[], existing: readonly RingPoint[]): number {
  const smaller = Math.min(ringAreaHa(candidate), ringAreaHa(existing))
  if (smaller <= 0) return 0
  const intersection = intersectionAreaHa(candidate, existing)
  return Math.round((intersection / smaller) * 100 * 10) / 10
}

/** R-38 and AC-34: the largest overlap of a candidate ring against every existing ring, one decimal. */
export function worstOverlapPercent(candidate: readonly RingPoint[], existing: readonly Ring[]): number {
  let worst = 0
  for (const ring of existing) worst = Math.max(worst, overlapPercent(candidate, ring))
  return worst
}
