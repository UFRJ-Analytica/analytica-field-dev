import { useState } from 'react'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyDescription } from '@/components/ui/empty'
import type { FieldSummary } from '@/lib/map-store'
import type { SelectedPolygonChip } from '@/lib/polygon-chip'
import { useMediaMatch } from '@/lib/viewport'
import { t, translationKeyFor } from '@/strings'

export const FIELDS_CHIP_ROW_ID = 'fields-chip-row'

/**
 * R-28, AC-24: the one width band where the chip prints the short form, as the overflow rows of
 * `artifacts/AC-24-overflow.txt` measured it. The band is 641 to 881 px inclusive, both edges
 * included because both are measured widths:
 * - 640 and below: the narrow single column, and the long form ends on the panel's right edge
 *   (0.00 px past it at 640 and at 360), so it fits and the long form prints.
 * - 641 to 881: the long form does not fit. At 641 and 700 it is ellipsized inside its own box
 *   (102 and 117 px of the 131 px it needs); from 767 to 881 the chip box runs past the panel
 *   edge, which `contain: layout paint` cuts (29.75 px past at 767, 0.11 px at 881).
 * - 882 and above: the long form fits with the panel edge clear of it (0.16 px at 882,
 *   22.00 px inside at 1440), so the long form prints again.
 * The 641 and 881 numbers are the measurement's own; the `min-width` and `max-width` bounds are
 * inclusive so each edge width prints the form its row measured.
 */
export const SHORT_NO_CDL_QUERY = '(min-width: 641px) and (max-width: 881px)'

/** R-28: the polygon carried by the fields header chip, as the active region names it. */
export type { SelectedPolygonChip }

type FieldsPanelProps = {
  fields: FieldSummary[]
  selectedFieldId: string | null
  isLoading: boolean
  error: string | null
  canRetry: boolean
  onSelectField: (fieldId: string) => void
  onRetry: () => void
  selectedPolygon?: SelectedPolygonChip | null
  /** Block 7, AM-04: the registered fields, printed after the fixture fields, name only. */
  registeredFields?: ReadonlyArray<{ id: string; name: string }>
}

/**
 * R-28 and R-27: the chip prints the table's class name; for a United States null or absent class
 * the No CDL label of its painted year (catalog key `polygon.no_cdl_class`, or the documented short
 * form `polygon.no_cdl_class_short` in the AC-24 band where the long form does not fit); otherwise
 * `class not mapped` (catalog key `polygon.class_not_mapped`). No component abbreviates on its own.
 */
function chipLabelOf(polygon: SelectedPolygonChip, shortNoCdl: boolean): string {
  if (polygon.name) return polygon.name
  if (polygon.noCdlYear !== null && polygon.noCdlYear !== undefined) {
    return shortNoCdl
      ? t('polygon.no_cdl_class_short', { year: polygon.noCdlYear })
      : t('polygon.no_cdl_class', { year: polygon.noCdlYear })
  }
  return t('polygon.class_not_mapped')
}

export function FieldsPanel({
  fields,
  selectedFieldId,
  isLoading,
  error,
  canRetry,
  onSelectField,
  onRetry,
  selectedPolygon = null,
  registeredFields = [],
}: FieldsPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  // R-28, AC-24: the one measured width band where the long form does not fit the panel.
  const shortNoCdl = useMediaMatch(SHORT_NO_CDL_QUERY)
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null
  // R-28: the chip resolves the name through the class table, not through the catalog, and it
  // renders in both panel states. AM-04 makes it the single class surface at 360x640.
  const chipName = selectedPolygon ? chipLabelOf(selectedPolygon, shortNoCdl) : null

  return (
    <section className="overlay-interactive field-chip-stack" aria-label={t('map.your_fields')}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="fields-header">
          <CollapsibleTrigger className="fields-trigger" aria-controls={FIELDS_CHIP_ROW_ID}>
            {t('fields.trigger')}
          </CollapsibleTrigger>
          {selectedPolygon && chipName && (
            <button
              className="top-chip field-chip selected polygon-chip"
              type="button"
              aria-label={chipName}
              aria-pressed
              data-polygon-chip
              onClick={() => onSelectField(selectedPolygon.fieldId)}
            >
              <span
                aria-hidden="true"
                className="field-class-dot"
                data-class-hex={selectedPolygon.hex}
                style={{ background: selectedPolygon.hex }}
              />
              <span className="field-chip-name">{chipName}</span>
            </button>
          )}
          {!selectedPolygon && !isOpen && selectedField && (
            <button
              className="top-chip field-chip selected"
              type="button"
              aria-pressed
              onClick={() => onSelectField(selectedField.id)}
            >
              <span className="field-chip-name">{t(translationKeyFor(selectedField.name) ?? selectedField.name)}</span>
            </button>
          )}
        </div>
        <div id={FIELDS_CHIP_ROW_ID}>
          <CollapsiblePanel className="field-chip-row">
            {isLoading && <p className="field-list-status">{t('empty.loading_fields')}</p>}
            {!isLoading && fields.map((field) => (
              <button
                className={`top-chip field-chip${selectedFieldId === field.id ? ' selected' : ''}`}
                key={field.id}
                onClick={() => onSelectField(field.id)}
                type="button"
                aria-pressed={selectedFieldId === field.id}
              >
                <span className="field-chip-name">{t(translationKeyFor(field.name) ?? field.name)}</span>
              </button>
            ))}
            {registeredFields.map((field) => (
              <button
                className={`top-chip field-chip${selectedFieldId === field.id ? ' selected' : ''}`}
                key={field.id}
                onClick={() => onSelectField(field.id)}
                type="button"
                aria-pressed={selectedFieldId === field.id}
              >
                <span className="field-chip-name">{field.name}</span>
              </button>
            ))}
            {!isLoading && fields.length === 0 && (
              <div className="field-empty-copy">
                <EmptyDescription role={error ? 'alert' : undefined}>
                  {error ?? t('empty.no_fields_available')}
                </EmptyDescription>
                {canRetry && (
                  <button className="text-sm underline" type="button" onClick={onRetry}>
                    {t('common.retry')}
                  </button>
                )}
              </div>
            )}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </section>
  )
}
