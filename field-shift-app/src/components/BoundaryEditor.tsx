/**
 * Block 7 revision 10, R-36 and R-63: the boundary drawing controls of the `Field record` panel.
 *
 * The drawing itself happens on the map: the map takes the pointer events and appends one vertex per
 * press, and this component holds what a person reads and presses while that happens, the
 * instructions, the running area in hectares, `Undo`, `Close ring` and `Cancel`. R-63 keeps the file
 * control of R-37 as the keyboard path to a ring, and the Table D validation of R-38 runs on the
 * client exactly as it does for a drawn ring.
 */
import type { RingPoint } from '@/lib/field-ring'
import { ringAreaHa } from '@/lib/field-ring'
import { t } from '@/strings'

export const EDITOR_INSET_ATTR = 'data-boundary-editor'

type BoundaryEditorProps = {
  /** The draft ring the map is building, or null while the mode is closed. */
  draft: RingPoint[] | null
  onStart: () => void
  onUndo: () => void
  onCloseRing: () => void
  onCancel: () => void
  /** The area of the accepted ring, printed while the mode is closed and a ring is held. */
  areaHa?: number
}

export function runningAreaHa(vertices: readonly RingPoint[]): number {
  return vertices.length < 3 ? 0 : ringAreaHa(vertices)
}

export function BoundaryEditor({ draft, onStart, onUndo, onCloseRing, onCancel, areaHa }: BoundaryEditorProps) {
  const isDrawing = draft !== null
  const area = areaHa ?? runningAreaHa(draft ?? [])
  return (
    <div className="editor-controls-panel" {...{ [EDITOR_INSET_ATTR]: '' }}>
      {!isDrawing ? (
        <button onClick={onStart} type="button">{t('panel.draw')}</button>
      ) : (
        <p className="surface-empty">{t('panel.record_instructions')}</p>
      )}
      <p className="editor-area">{t('record.running_area', { area: area.toFixed(1) })}</p>
      <div className="editor-controls">
        <button disabled={!isDrawing || (draft?.length ?? 0) === 0} onClick={onUndo} type="button">{t('record.undo')}</button>
        <button disabled={!isDrawing || (draft?.length ?? 0) < 3} onClick={onCloseRing} type="button">{t('record.close_ring')}</button>
        <button onClick={onCancel} type="button">{t('record.cancel')}</button>
      </div>
    </div>
  )
}
