/**
 * R-27 and Layout note 6: where the hover tooltip sits and when it is suppressed.
 *
 * The tooltip is placed 12 px beside the pointer, clamped inside the map, and it is not
 * mounted at all while its clamped box would have a positive area intersection with the
 * block 3 right edge column. The column box is the measured rectangle of the mounted
 * element; nothing here reads or writes the column's state (R-46).
 */

import { t } from '@/strings'
import { classDisplay, noCdlYearOf } from './polygon-style'
import type { RegionAdapter } from './regions'

/**
 * R-27 and AC-23: the tooltip prints one string and nothing else. A United States null or absent
 * `cdl{Y}` prints `No CDL class for {Y}` (catalog key `polygon.no_cdl_class`), the same string the
 * readout prints. Every other unmapped polygon prints `class not mapped` (`polygon.class_not_mapped`),
 * and a mapped one prints its table name. Brazil keeps its own split (R-21).
 */
export function polygonTooltipText(region: RegionAdapter, classValue: number | null, date: string): string {
  const year = noCdlYearOf(region, classValue, date)
  if (year !== null) return t('polygon.no_cdl_class', { year })
  return classDisplay(region, classValue).name ?? t('polygon.class_not_mapped')
}

export const POLYGON_TOOLTIP_OFFSET = 12
export const POLYGON_TOOLTIP_MAX_WIDTH = 200

export type Box = { left: number; top: number; right: number; bottom: number }

export type TooltipPlacement = { left: number; top: number; hidden: boolean }

function intersects(a: Box, b: Box): boolean {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return width > 0 && height > 0
}

/** Positive area overlap only: a shared edge is not an intersection. */
export function placeTooltip(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  column: Box | null,
): TooltipPlacement {
  const width = Math.min(size.width, POLYGON_TOOLTIP_MAX_WIDTH)
  const left = Math.min(Math.max(0, pointer.x + POLYGON_TOOLTIP_OFFSET), Math.max(0, viewport.width - width))
  const top = Math.min(Math.max(0, pointer.y + POLYGON_TOOLTIP_OFFSET), Math.max(0, viewport.height - size.height))
  const box: Box = { left, top, right: left + width, bottom: top + size.height }
  return { left, top, hidden: column ? intersects(box, column) : false }
}
