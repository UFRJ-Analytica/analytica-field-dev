/**
 * Block 7, R-35 to R-47, R-52 to R-56 and R-58: the `Field record` region.
 *
 * Five cards, in the order of the Expected Interface: the registered fields, the boundary editor,
 * the declared history, the producer data and the gaps. Every value on it is either entered by the
 * producer, written by the store beside an entered value, computed from a ring by the formula of
 * Table C, or read from the window source for the crop list, and each one prints its own provenance
 * (R-57). Nothing here derives a crop, a season or a date (R-44) and nothing writes a fixture field
 * (R-60).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BoundaryEditor, runningAreaHa } from '@/components/BoundaryEditor'
import { usePanelStore } from '@/lib/panel-store'
import { fileLeaf, readGeoJSON, readKML, validateRing, type ImportErrorCode } from '@/lib/boundary-import'
import { distinctVertexCount, type RingPoint } from '@/lib/field-ring'
import { cropListFor, missingSourcesText } from '@/lib/crop-list'
import {
  dateInSeason,
  rowsAfterDelete,
  rowsAfterSave,
  validateHistoryRow,
  type HistoryErrorCode,
} from '@/lib/history'
import {
  deleteField as deleteFieldRecord,
  isLocalFieldId,
  loadFields,
  loadProducer,
  nameTaken,
  registeredFieldOf,
  saveField,
  saveProducer,
  type FieldSource,
  type HistoryRow,
  type ProducerEntry,
  type RegisteredField,
} from '@/lib/producer-store'
import type { ZarcWindowRow } from '@/lib/planting-calendar'
import { seasonForDate } from '@/lib/timeline'
import { t, type TranslationKey } from '@/strings'
import './Block7.css'

export const RECORD_VIEW_ATTR = 'data-record-view'

type FieldRecordViewProps = {
  regionId: 'us' | 'br'
  chosenDate: string
  selectedFieldId: string | null
  selectedFieldName: string | null
  windowRows: ZarcWindowRow[] | null
  heldSeasons: string[]
  place: { municipality: string; uf: string } | null
  rotationRows: ReadonlyArray<{ season: string; crops: readonly string[] }>
  onSelectField: (fieldId: string) => void
  onFieldDeleted: (fieldId: string) => void
  onChanged: () => void
}

/** R-61's season label of a source key, `2025/2026` to `2025/26`. */
export function seasonLabel(key: string): string {
  const [year, end] = key.split('/')
  return `${year}/${(end ?? '').slice(-2)}`
}


function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsText(file)
  })
}

export function FieldRecordView({
  regionId,
  chosenDate,
  selectedFieldId,
  selectedFieldName,
  windowRows,
  heldSeasons,
  place,
  rotationRows,
  onSelectField,
  onFieldDeleted,
  onChanged,
}: FieldRecordViewProps) {
  const [fields, setFields] = useState<RegisteredField[]>([])
  const [producer, setProducer] = useState<Record<string, ProducerEntry>>({})
  const [name, setName] = useState('')
  // Block 7 revision 10 R-63: the draft the map fills, one vertex per press.
  const draft = usePanelStore((state) => state.draft)
  const startDrawing = usePanelStore((state) => state.startDrawing)
  const undoVertex = usePanelStore((state) => state.undoVertex)
  const stopDrawing = usePanelStore((state) => state.stopDrawing)
  const [imported, setImported] = useState<{ ring: RingPoint[]; source: FieldSource; file: string | null } | null>(null)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const [errorParams, setErrorParams] = useState<Record<string, string> | undefined>(undefined)
  const [editingSeason, setEditingSeason] = useState<string | null>(null)
  const [form, setForm] = useState<{ season: string; first: string; second: string; firstDate: string; secondDate: string }>({
    season: '', first: '', second: '', firstDate: '', secondDate: '',
  })


  const refresh = useCallback(() => {
    const storedFields = loadFields()
    if (!('value' in storedFields)) {
      // R-54: an unreadable key is reported on the card's own error line, and the panel prints no
      // gap row (block 7 revision 10 R-58).
      setErrorKey('persist.version')
      setFields([])
    } else {
      setFields(storedFields.value)
    }
    const storedProducer = loadProducer()
    if (!('value' in storedProducer)) {
      setErrorKey('persist.version')
      setProducer({})
    } else {
      setProducer(storedProducer.value)
    }
    onChanged()
  }, [onChanged])

  useEffect(() => {
    refresh()
    // The record is read once, when the surface opens; nothing is written on mount (R-53).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const historyRows: HistoryRow[] = useMemo(() => {
    if (selectedFieldId === null) return []
    return producer[selectedFieldId]?.history ?? []
  }, [producer, selectedFieldId])

  // R-31: the season of the chosen date is offered first and selected by default, then every season
  // the window source holds, so the producer does not have to switch the season to declare today.
  const seasons = useMemo(() => {
    const current = seasonForDate(chosenDate)
    const labels = heldSeasons.map(seasonLabel)
    return [current, ...labels.filter((label) => label !== current)]
  }, [heldSeasons, chosenDate])

  useEffect(() => {
    if (form.season === '' && seasons.length > 0) {
      setForm((current) => ({ ...current, season: seasons[0] }))
    }
  }, [form.season, seasons])

  const cropList = useMemo(() => {
    const season = form.season === '' ? (seasons[0] ?? '') : form.season
    const windowCrops = windowRows === null || place === null
      ? []
      : windowRows
        .filter((row) => row.municipality === place.municipality && row.uf === place.uf && seasonLabel(row.season) === season)
        .map((row) => row.crop)
    return cropListFor({
      windowCrops,
      historyCrops: [],
      season,
      region: regionId,
      seasonless: regionId === 'us',
    })
  }, [windowRows, place, form.season, seasons, regionId])

  const emptyCropText = cropList.missing.length === 0
    ? null
    : t('history.crops_empty', { missing: missingSourcesText(cropList.missing, (key) => t(key), t('history.missing_join')) })

  const ring: RingPoint[] = imported?.ring ?? draft ?? []
  const candidateArea = runningAreaHa(ring)

  const closeRing = () => {
    const existing = fields.map((field) => field.ring)
    const result = validateRing(ring, existing)
    if ('code' in result) {
      setErrorKey(result.code as unknown as TranslationKey)
      setErrorParams(undefined)
      return
    }
    setErrorKey(null)
    setImported({ ring: result.ring, source: imported?.source ?? 'drawn', file: imported?.file ?? null })
    stopDrawing()
  }

  const onImport = async (file: File | null) => {
    if (!file) return
    const text = await readFileAsText(file)
    const isKml = /\.kml$/i.test(file.name)
    const result = isKml ? readKML(text) : readGeoJSON(text)
    if ('code' in result) {
      setErrorKey(result.code as unknown as TranslationKey)
      return
    }
    stopDrawing()
    setImported({ ring: result.ring, source: isKml ? 'kml' : 'geojson', file: fileLeaf(file.name) })
    setErrorKey(null)
    if (name.trim() === '') setName(fileLeaf(file.name).replace(/\.[^.]+$/, ''))
  }

  const save = () => {
    if (name.trim() === '') {
      setErrorKey('import.name_required' as TranslationKey)
      return
    }
    if (nameTaken(name, fields)) {
      setErrorKey('import.name_taken' as TranslationKey)
      setErrorParams({ name })
      return
    }
    const validation = validateRing(ring, fields.map((field) => field.ring))
    if ('code' in validation) {
      setErrorKey(validation.code as unknown as TranslationKey)
      return
    }
    const field = registeredFieldOf({
      name: name.trim(),
      ring: validation.ring,
      source: imported?.source ?? 'drawn',
      sourceFile: imported?.file ?? null,
    })
    const saved = saveField(field, {})
    if (!('value' in saved)) {
      setErrorKey('persist.quota')
      return
    }
    setFields(saved.value)
    stopDrawing()
    setImported(null)
    setName('')
    setErrorKey(null)
    onChanged()
  }

  const remove = (field: RegisteredField) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(t('record.delete_confirm', { name: field.name }))) return
    }
    const result = deleteFieldRecord(field.id, {})
    if (!('value' in result)) {
      setErrorKey('persist.quota')
      return
    }
    setFields(result.value.fields)
    setProducer(result.value.producer)
    onFieldDeleted(field.id)
    onChanged()
  }

  const startEdit = (row: HistoryRow) => {
    setEditingSeason(row.season)
    setForm({
      season: row.season,
      first: row.first_crop,
      second: row.second_crop ?? '',
      firstDate: row.first_sowing_date ?? '',
      secondDate: row.second_sowing_date ?? '',
    })
  }

  const saveHistory = () => {
    if (selectedFieldId === null) return
    if (form.first === '') {
      setErrorKey('import.name_required' as TranslationKey)
      return
    }
    const row: HistoryRow = {
      season: form.season,
      first_crop: form.first,
      second_crop: form.second === '' ? null : form.second,
      first_sowing_date: form.firstDate === '' ? null : form.firstDate,
      second_sowing_date: form.secondDate === '' ? null : form.secondDate,
      basis: 'entered',
      edited_at: new Date().toISOString(),
    }
    const others = historyRows.filter((entry) => entry.season !== editingSeason)
    const validation = validateHistoryRow(row, others)
    if ('code' in validation) {
      setErrorKey(validation.code as unknown as TranslationKey)
      return
    }
    const next = rowsAfterSave(historyRows, validation.row, editingSeason)
    const saved = saveProducer(selectedFieldId, next, {})
    if (!('value' in saved)) {
      setErrorKey('persist.quota')
      return
    }
    setProducer(saved.value)
    setEditingSeason(null)
    setErrorKey(null)
    setForm({ season: form.season, first: '', second: '', firstDate: '', secondDate: '' })
    onChanged()
  }

  const deleteHistory = (season: string) => {
    if (selectedFieldId === null) return
    const next = rowsAfterDelete(historyRows, season)
    const saved = saveProducer(selectedFieldId, next, {})
    if (!('value' in saved)) {
      setErrorKey('persist.quota')
      return
    }
    setProducer(saved.value)
    onChanged()
  }

  // R-46: the declared history and the modelled rotation print as two lists under two headings, and
  // a season both name with a different crop prints that they disagree. Neither is relabelled.
  const disagreements = useMemo(() => {
    const seasons: string[] = []
    for (const row of historyRows) {
      const rotation = rotationRows.find((entry) => entry.season === row.season)
      if (!rotation) continue
      const crops = rotation.crops.map((crop) => crop.toLowerCase())
      if (!crops.includes(row.first_crop.toLowerCase())) seasons.push(row.season)
    }
    return seasons
  }, [historyRows, rotationRows])

  return (
    // Block 5.5, W5: the panel body. The heading belongs to the host, `Back to map` is gone, and
    // `Producer data` and the `Gaps` card are deleted by block 7 revision 10 (U9, R-56, R-58).
    <div className="record-panel" data-record-view>
      <div className="surface-content">
        <p className="record-facts">
          <span>{selectedFieldName ?? t('record.no_field_selected')}</span>
          <span>{chosenDate}</span>
        </p>
        <div className="record-grid">
          <div className="surface-card span-6">
            <h3 id="record-fields-title">{t('record.registered_heading')}</h3>
            {fields.length === 0 ? (
              <p className="surface-empty">{t('record.registered_empty')}</p>
            ) : (
              <ul className="field-list">
                {fields.map((field) => (
                  <li className="field-row" key={field.id}>
                    <button className="field-button" onClick={() => onSelectField(field.id)} type="button">
                      {t('record.select', { name: field.name })}
                    </button>
                    <span>{t('record.area_method', { area: field.area_ha.toFixed(1), vertices: distinctVertexCount(field.ring) })}</span>
                    <span className="surface-empty">
                      {field.source_file === null ? t('record.drawn') : t('record.imported_from', { file: field.source_file })}
                    </span>
                    {field.region === null ? <span className="calendar-note">{t('field.no_region_source')}</span> : null}
                    <button className="field-delete" onClick={() => remove(field)} type="button">
                      {t('record.delete', { name: field.name })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="surface-card span-6">
            <h3 id="record-editor-title">{t('record.editor_heading')}</h3>
            <label className="history-form">
              <span>{t('record.name_label')}</span>
              <input aria-label={t('record.name_label')} maxLength={60} onChange={(event) => setName(event.target.value)} type="text" value={name} />
            </label>
            <label className="history-form">
              <span>{t('record.import_label')}</span>
              <input
                accept=".geojson,.json,.kml"
                aria-label={t('record.import_label')}
                onChange={(event) => { void onImport(event.target.files?.[0] ?? null) }}
                type="file"
              />
            </label>
            <BoundaryEditor
              draft={draft}
              onCancel={() => { stopDrawing(); setImported(null); setErrorKey(null) }}
              onCloseRing={closeRing}
              onStart={() => { setImported(null); setErrorKey(null); startDrawing() }}
              onUndo={undoVertex}
            />
            <div className="editor-controls">
              <button disabled={ring.length < 3} onClick={save} type="button">{t('record.save')}</button>
            </div>
            <p className="surface-empty">{t('record.running_area', { area: candidateArea.toFixed(1) })}</p>
            {errorKey !== null ? <p className="error-line" role="alert">{t(errorKey, errorParams)}</p> : null}
          </div>

          <div className="surface-card span-8">
            <h3 id="record-history-title">{t('record.history_heading')}</h3>
            {historyRows.length === 0 ? <p className="surface-empty">{t('record.history_empty')}</p> : (
              <table className="surface-table">
                <thead>
                  <tr>
                    <th scope="col">{t('history.season')}</th>
                    <th scope="col">{t('history.first_crop')}</th>
                    <th scope="col">{t('history.second_crop')}</th>
                    <th scope="col">{t('history.first_sowing')}</th>
                    <th scope="col">{t('history.second_sowing')}</th>
                    <th scope="col">{t('history.basis_entered')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((row) => (
                    <tr key={row.season}>
                      <td>{row.season}</td>
                      <td>{row.first_crop}</td>
                      <td>{row.second_crop ?? t('history.none')}</td>
                      <td>{row.first_sowing_date ?? ''}</td>
                      <td>{row.second_sowing_date ?? ''}</td>
                      <td>
                        {t('history.basis_entered')}
                        <span className="calendar-context">{t('history.edited_at', { date: row.edited_at.slice(0, 10) })}</span>
                      </td>
                      <td>
                        <button className="field-button" onClick={() => startEdit(row)} type="button">
                          {t('history.edit_season', { season: row.season })}
                        </button>
                        <button className="field-delete" onClick={() => deleteHistory(row.season)} type="button">
                          {t('history.delete_season', { season: row.season })}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="history-form">
              <label>
                <span>{t('history.season')}</span>
                <select aria-label={t('history.season')} onChange={(event) => setForm((current) => ({ ...current, season: event.target.value }))} value={form.season}>
                  {seasons.map((season) => <option key={season} value={season}>{season}</option>)}
                </select>
              </label>
              <label>
                <span>{t('history.first_crop')}</span>
                <select aria-label={t('history.first_crop')} onChange={(event) => setForm((current) => ({ ...current, first: event.target.value }))} value={form.first}>
                  <option value="">{t('history.none')}</option>
                  {cropList.options.map((option) => <option key={`${option.tag}-${option.value}`} value={option.value}>{option.value}</option>)}
                </select>
              </label>
              <label>
                <span>{t('history.second_crop')}</span>
                <select aria-label={t('history.second_crop')} onChange={(event) => setForm((current) => ({ ...current, second: event.target.value }))} value={form.second}>
                  <option value="">{t('history.none')}</option>
                  {cropList.options.map((option) => <option key={`second-${option.value}`} value={option.value}>{option.value}</option>)}
                </select>
              </label>
              <label>
                <span>{t('history.first_sowing')}</span>
                <input aria-label={t('history.first_sowing')} onChange={(event) => setForm((current) => ({ ...current, firstDate: event.target.value }))} type="date" value={form.firstDate} />
              </label>
              <label>
                <span>{t('history.second_sowing')}</span>
                <input aria-label={t('history.second_sowing')} onChange={(event) => setForm((current) => ({ ...current, secondDate: event.target.value }))} type="date" value={form.secondDate} />
              </label>
              <div className="history-actions">
                <button disabled={cropList.options.length === 0 || selectedFieldId === null} onClick={saveHistory} type="button">
                  {t('history.save')}
                </button>
              </div>
            </div>
            {emptyCropText !== null ? <p className="surface-empty">{emptyCropText}</p> : null}
            {disagreements.length > 0 ? (
              <p className="calendar-note">{t('record.two_lists_note', { seasons: disagreements.join(', ') })}</p>
            ) : null}
            {rotationRows.length > 0 ? (
              <section aria-labelledby="record-rotation-title">
                <h3 id="record-rotation-title">{t('record.rotation_heading')}</h3>
                <ul className="field-list">
                  {rotationRows.map((row) => (
                    <li key={row.season}>{row.season}: {row.crops.join(', ')}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** R-41: whether a stored field can be opened in the active region, and the text when it cannot. */
export function fieldOpenText(field: RegisteredField, regionId: 'us' | 'br'): TranslationKey | null {
  if (field.region === null) return 'field.no_region_source'
  if (field.region !== regionId) return 'field.region_mismatch'
  return null
}

/** R-41 and AM-13: the `select_field` guard accepts a registered field's `local:` id. */
export function isRegisteredFieldId(fieldId: string): boolean {
  return isLocalFieldId(fieldId)
}

export type { ImportErrorCode, HistoryErrorCode }
export { dateInSeason }
