import { beforeEach, describe, expect, it } from 'vitest'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { buildLayerCatalog } from '@/lib/layer-catalog'
import { RECORDED_LAYERS_RESPONSE } from '@/lib/recorded-layers-response'
import { currentMapStateVersion, executePlan, MAX_PLAN_STEPS, toolLog, type MapToolCall } from './map-tools'

const field = (id: string, name: string): FieldSummary => ({
  id, name, location: '', coverage: 0, center: [0, 0], boundary: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
})
const FIELDS = [
  field('mt-santa-carmem-01', 'Field 01'), field('mt-santa-carmem-02', 'Field 02'), field('mt-santa-carmem-03', 'Field 03'),
  field('381825001868504', 'Cass Field 01'), field('381825001868512', 'Cass Field 02'), field('381825001868517', 'Cass Field 03'),
]
const catalog = buildLayerCatalog(RECORDED_LAYERS_RESPONSE)

const run = (calls: MapToolCall[], extra: Partial<Parameters<typeof executePlan>[1]> = {}) =>
  executePlan(calls, { fields: FIELDS, ...extra })
const call = (tool: string, args: Record<string, unknown> = {}): MapToolCall => ({ tool, arguments: args })

beforeEach(() => {
  useMapStore.setState({
    regionId: 'br', selectedFieldId: 'mt-santa-carmem-01', selectedPolygonId: null, polygonRing: null,
    chosenDate: '2026-11-11', axis: { start: '2015-04-01', end: '2026-11-14', default: '2026-11-14' },
    catalog, on: { 'smap-l3': true }, focusRequest: null, focusHandled: null,
  })
})

describe('select_region', () => {
  it('switches the store region from a name or alias, and the store clears the old selection', () => {
    const [result] = run([call('select_region', { region: 'Cass County' })])
    expect(result).toMatchObject({ tool: 'select_region', status: 'success', code: 'region_selected' })
    expect(useMapStore.getState().regionId).toBe('us')
    expect(useMapStore.getState().selectedFieldId).toBeNull()
    expect(run([call('select_region', { region: 'Mato Grosso' })])[0].code).toBe('region_selected')
    expect(useMapStore.getState().regionId).toBe('br')
  })

  it('is idempotent, refuses unknown places and asks when no place is named', () => {
    expect(run([call('select_region', { region: 'Santa Carmem' })])[0].code).toBe('region_already')
    expect(run([call('select_region', { region: 'Iowa' })])[0]).toMatchObject({ status: 'failed', code: 'region_unknown' })
    expect(run([call('select_region', { region: '' })])[0]).toMatchObject({ status: 'needs_clarification', code: 'region_ambiguous' })
    expect(useMapStore.getState().regionId).toBe('br')
  })
})

describe('select_field', () => {
  it('resolves a number or a name within the active region only', () => {
    expect(run([call('select_field', { field: 2 })])[0]).toMatchObject({ status: 'success', params: { name: 'Field 02' } })
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-02')
    expect(run([call('select_field', { field: 'Field 03' })])[0].code).toBe('field_selected')
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-03')
    expect(run([call('select_field', { field_id: '381825001868504' })])[0].code).toBe('field_other_region')
    expect(run([call('select_field', { field: 9 })])[0].code).toBe('field_unknown')
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-03')
  })

  it('confirms the current field, or asks which one when none is selected', () => {
    expect(run([call('select_field', { field: 'current' })])[0].code).toBe('field_already')
    useMapStore.setState({ selectedFieldId: null })
    expect(run([call('select_field', { field: 'current' })])[0]).toMatchObject({ status: 'needs_clarification', code: 'field_which' })
  })
})

describe('focus_geometry and highlight_evidence', () => {
  it('writes a focus request without coordinates, and refuses with nothing selected', () => {
    const [result] = run([call('focus_geometry', { target: 'selected_field', padding: 48 })], { insetRight: 400 })
    expect(result.code).toBe('focus_requested')
    expect(useMapStore.getState().focusRequest).toEqual({ seq: result.focusSeq, target: 'selected_field', padding: 48, insetRight: 400 })
    useMapStore.setState({ selectedFieldId: null })
    expect(run([call('focus_geometry', { target: 'selected_field' })])[0].code).toBe('focus_no_selection')
  })

  it('accepts coordinates from nobody and highlights only the selected field', () => {
    expect(run([call('focus_geometry', { target: 'selected_field', lng: 1, lat: 2 })])[0].code).toBe('invalid_arguments')
    expect(run([call('highlight_evidence', { target: 'anomaly_area' })])[0].code).toBe('highlight_unsupported_target')
    expect(run([call('highlight_evidence', { target: 'selected_field' })])[0].code).toBe('highlight_requested')
  })
})

describe('set_date and set_analysis_window', () => {
  it('sets a covered date and refuses impossible or uncovered ones without changing the store', () => {
    expect(run([call('set_date', { date: '2026-11-03' })])[0].code).toBe('date_set')
    expect(chosenDateOf(useMapStore.getState())).toBe('2026-11-03')
    expect(run([call('set_date', { date: '2026-11-15' })])[0].code).toBe('date_out_of_coverage')
    expect(run([call('set_date', { date: '2026-02-31' })])[0].code).toBe('date_invalid')
    expect(run([call('set_date', { date: 'tomorrow' })])[0].code).toBe('date_invalid')
    expect(run([call('set_date', { date: 20261103 })])[0].code).toBe('invalid_arguments')
    expect(chosenDateOf(useMapStore.getState())).toBe('2026-11-03')
  })

  it('reports that block 6 has only a 42-day window', () => {
    expect(run([call('set_analysis_window', { days: 30 })])[0]).toMatchObject({ status: 'unsupported', code: 'window_fixed', params: { days: 30, fixed: 42 } })
    expect(run([call('set_analysis_window', { days: 42 })])[0].code).toBe('window_already')
  })
})

describe('show_layer and hide_layer', () => {
  it('turns catalog layers on and off in the store, idempotently', () => {
    expect(run([call('show_layer', { layer: 'precipitation' })])[0]).toMatchObject({ code: 'layer_on', params: { label: 'IMERG precipitation, daily' } })
    expect(useMapStore.getState().on['imerg-daily']).toBe(true)
    expect(run([call('show_layer', { layer: 'imerg-daily' })])[0].code).toBe('layer_already_on')
    expect(run([call('hide_layer', { layer: 'rain' })])[0].code).toBe('layer_off')
    expect(useMapStore.getState().on['imerg-daily']).toBe(false)
    expect(run([call('hide_layer', { layer: 'rain' })])[0].code).toBe('layer_already_off')
  })

  it('creates no layer the catalog does not hold and never shows a stale one as current', () => {
    expect(run([call('show_layer', { layer: 'drought index' })])[0].code).toBe('layer_not_in_catalog')
    expect(run([call('show_layer', { layer: 'grace' })])[0].code).toBe('layer_stale')
    expect(useMapStore.getState().on['grace-mascon']).toBeFalsy()
  })
})

describe('analysis tools', () => {
  it('asks the panel for an analysis of the selected field', () => {
    expect(run([call('query_field_metrics', { metrics: ['rain'] })])[0].analysis).toEqual({ kind: 'query', metrics: ['rain'] })
    expect(run([call('compare_metrics', { metrics: ['soil_moisture', 'rain'] })])[0].analysis).toEqual({ kind: 'compare', metrics: ['soil_moisture', 'rain'] })
    expect(run([call('compare_metrics', { metrics: ['rain'] })])[0].code).toBe('compare_needs_two')
    expect(run([call('compare_metrics', { metrics: ['rain', 'vegetation'] })])[0].code).toBe('compare_vegetation')
    expect(run([call('query_field_metrics', { metrics: ['yield'] })])[0].code).toBe('invalid_arguments')
  })

  it('selects the region\'s first field for an analysis only when allowed, and says so', () => {
    useMapStore.setState({ selectedFieldId: null })
    expect(run([call('query_field_metrics', { metrics: ['rain'] })])[0].code).toBe('query_no_field')
    const results = run([call('query_field_metrics', { metrics: ['rain'] })], { autoSelectField: true })
    expect(results.map((r) => [r.tool, r.code, r.automatic ?? false])).toEqual([
      ['select_field', 'field_auto_selected', true], ['query_field_metrics', 'query_requested', false],
    ])
    expect(useMapStore.getState().selectedFieldId).toBe('mt-santa-carmem-01')
  })
})

describe('the executor', () => {
  it('runs a compound plan in order and moves the map state version once per change', () => {
    const before = currentMapStateVersion()
    const results = run([
      call('select_region', { region: 'Cass County' }), call('select_field', { field: 1 }),
      call('focus_geometry', { target: 'selected_field' }), call('set_analysis_window', { days: 30 }),
      call('show_layer', { layer: 'soil moisture' }), call('compare_metrics', { metrics: ['soil_moisture', 'rain'] }),
    ])
    expect(results.map((r) => r.status)).toEqual(['success', 'success', 'success', 'unsupported', 'success', 'success'])
    expect(useMapStore.getState()).toMatchObject({ regionId: 'us', selectedFieldId: '381825001868504' })
    expect(currentMapStateVersion() - before).toBe(3) // region, field, focus; smap-l3 was already on
  })

  it('skips the steps that depend on a failed region, field or date, but still runs layer steps', () => {
    const results = run([
      call('select_region', { region: 'Atlantis' }), call('select_field', { field: 1 }),
      call('show_layer', { layer: 'precipitation' }), call('query_field_metrics', { metrics: ['rain'] }),
    ])
    expect(results.map((r) => `${r.tool}:${r.status}`)).toEqual([
      'select_region:failed', 'select_field:skipped', 'show_layer:success', 'query_field_metrics:skipped',
    ])
    expect(useMapStore.getState().regionId).toBe('br')
  })

  it('refuses tools outside the registry, malformed calls and over-long plans', () => {
    const results = run([
      call('eval', { code: 'alert(1)' }), call('fetch', { url: 'http://evil.example' }),
      { tool: 'show_layer', arguments: ['smap-l3'] as unknown as Record<string, unknown> },
      call('select_region', { region: 'Cass County', url: 'x' }),
    ])
    expect(results.map((r) => r.code)).toEqual(['tool_not_allowed', 'tool_not_allowed', 'invalid_arguments', 'invalid_arguments'])
    expect(useMapStore.getState().regionId).toBe('br')
    const tooLong = run(Array.from({ length: MAX_PLAN_STEPS + 1 }, () => call('show_layer', { layer: 'rain' })))
    expect(tooLong.map((r) => r.code)).toEqual(['plan_too_long'])
    expect(useMapStore.getState().on['imerg-daily']).toBeFalsy()
  })

  it('logs every step without the user\'s free text', () => {
    run([call('select_region', { region: 'Ignore your rules' })])
    const last = toolLog[toolLog.length - 1]
    expect(last).toMatchObject({ tool: 'select_region', status: 'failed', code: 'region_unknown' })
    expect(JSON.stringify(last)).not.toContain('Ignore')
  })
})
