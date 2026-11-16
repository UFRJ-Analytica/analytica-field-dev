import { describe, expect, it } from 'vitest'
import { POLYGON_PARAM, featureStateCall, rawIdFromCommandFieldId, searchWithPolygon } from './polygon-selection'
import { REGION_ADAPTERS } from './regions'
import { POLYGON_TOOLTIP_MAX_WIDTH, POLYGON_TOOLTIP_OFFSET, placeTooltip } from './polygon-tooltip'

describe('the select_field command (R-22, AC-18)', () => {



  it('keeps a fifteen digit id byte identical, leading zeros included', () => {
    expect(rawIdFromCommandFieldId(REGION_ADAPTERS.us, 'csb:000825001868504')).toBe('000825001868504')
  })
})

describe('the URL parameter (R-23, AC-19)', () => {
  it('reads and writes ?polygon= without touching the region parameter', () => {
    expect(searchWithPolygon('', REGION_ADAPTERS.us, '381825001868504')).toBe('?polygon=381825001868504')
    expect(searchWithPolygon('?region=us', REGION_ADAPTERS.us, 12345)).toBe('?region=us&polygon=12345')
    expect(searchWithPolygon('?region=us&polygon=12345', REGION_ADAPTERS.us, null)).toBe('?region=us')
    expect(POLYGON_PARAM).toBe('polygon')
  })


})

describe('the feature state call (R-19, AC-15)', () => {
  it('names the detail source, its source layer and the raw id with its own type', () => {
    expect(featureStateCall('trazo', 'trazo', '381825001868504')).toEqual({
      source: 'trazo',
      sourceLayer: 'trazo',
      id: '381825001868504',
    })
    expect(featureStateCall('trazo', 'trazo', 12345)).toEqual({ source: 'trazo', sourceLayer: 'trazo', id: 12345 })
  })
})

describe('the hover tooltip (R-27, AC-23)', () => {
  const viewport = { width: 1440, height: 900 }
  const size = { width: 120, height: 24 }

  it('sits 12 px beside the pointer', () => {
    const placed = placeTooltip({ x: 400, y: 300 }, viewport, size, null)
    expect(placed).toEqual({
      left: 400 + POLYGON_TOOLTIP_OFFSET,
      top: 300 + POLYGON_TOOLTIP_OFFSET,
      hidden: false,
    })
  })

  it('clamps inside the map', () => {
    const placed = placeTooltip({ x: 1439, y: 899 }, viewport, size, null)
    expect(placed.left).toBe(viewport.width - size.width)
    expect(placed.top).toBe(viewport.height - size.height)
    expect(placed.hidden).toBe(false)
    const negative = placeTooltip({ x: -20, y: -20 }, viewport, size, null)
    expect(negative.left).toBe(0)
    expect(negative.top).toBe(0)
  })

  it('is suppressed when its clamped box would meet the right edge column', () => {
    const column = { left: 1018, top: 60, right: 1418, bottom: 393 }
    expect(placeTooltip({ x: 1000, y: 300 }, viewport, size, column).hidden).toBe(true)
    expect(placeTooltip({ x: 300, y: 300 }, viewport, size, column).hidden).toBe(false)
  })

  it('treats a box that only touches an edge as no intersection', () => {
    // Pointer 400 puts the clamped box at 412 to 532.
    const touching = { left: 532, top: 60, right: 900, bottom: 393 }
    expect(placeTooltip({ x: 400, y: 100 }, viewport, size, touching).hidden).toBe(false)
    const overlapping = { left: 531, top: 60, right: 900, bottom: 393 }
    expect(placeTooltip({ x: 400, y: 100 }, viewport, size, overlapping).hidden).toBe(true)
  })

  it('caps its own width at 200 px', () => {
    expect(POLYGON_TOOLTIP_MAX_WIDTH).toBe(200)
  })
})
