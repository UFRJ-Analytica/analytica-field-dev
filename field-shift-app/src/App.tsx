import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { API_BASE } from '@/lib/api-base'
import { MapCanvas } from '@/components/MapCanvas'
import { LayerRail } from '@/components/LayerRail'
import type { RotationScenario } from '@/components/ScenarioCards'
import { EvidencePanel, type EvidenceRow } from '@/components/EvidencePanel'
import { TimelineDock } from '@/components/TimelineDock'
import { AbstentionNotice } from '@/components/AbstentionNotice'
import { FieldsPanel } from '@/components/FieldsPanel'
import { PolygonPanel } from '@/components/PolygonPanel'
import { PanelHost, type PanelSpec } from '@/components/PanelHost'
import { PANEL_TOGGLE_ATTR, usePanelStore, type PanelId } from '@/lib/panel-store'
import { SUPPORTING_DATA_PANEL_ID, SupportingDataToggle, useSupportingDataToggle } from '@/components/SupportingDataToggle'
import { NumbersToggle } from '@/components/NumbersToggle'
import { EnsoChip } from '@/components/EnsoChip'
import { ReportButton } from '@/components/ReportButton'
import { ClimateSignal } from '@/components/ClimateSignal'
import { ensoSchema, fieldClimateSchema, loadParsed, type EnsoState, type FieldClimate, type Loadable } from '@/lib/climate'
import { NumbersView } from '@/components/NumbersView'
import { chosenDateOf, useMapStore, type FieldSummary } from '@/lib/map-store'
import { loadFields, loadProducer } from '@/lib/producer-store'
import { useLayers } from '@/lib/use-layers'
import {
  regionAdapter,
  regionFromSearch,
  searchWithRegion,
} from '@/lib/regions'
import { BASEMAP_ADAPTERS } from '@/lib/basemap-adapters'
import { selectedPolygonChipOf } from '@/lib/polygon-chip'
import { polygonIdFromSearch, searchWithPolygon } from '@/lib/polygon-selection'
import {
  COMPACT_QUERY,
  NARROW_QUERY,
  isNarrowViewport,
  useMediaMatch,
} from '@/lib/viewport'
import { t, translationKeyFor } from '@/strings'


type FieldResponse = { fields: FieldSummary[]; seasons: string[]; default_season: string }
type ScenarioResponse = {
  field_id: string
  season: string
  state: 'ranked' | 'abstained'
  threshold: string | null
  coverage: number
  scenarios: RotationScenario[]
}

class BackendHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

function backendFailureReason(reason: unknown): string {
  return reason instanceof BackendHttpError
    ? t('empty.backend_http_error', { status: reason.status })
    : t('empty.backend_unreachable')
}

export const ZOrder = Object.freeze({
  chips: 10,
  layerRail: 20,
  polygonPanel: 25,
  evidence: 30,
  abstentionNotice: 40,
  timelineDock: 45,
  scenarioCards: 50,
  controlStrip: 60,
  agentBar: 70,
  /** Block 6, AM-05: the numbers surface sits above every map screen key. */
  numbersView: 80,
  /** Block 7, AM-03: the two surfaces sit above the numbers surface. */
  decisionView: 81,
  fieldRecordView: 82,
})

function App() {
  const selectedFieldId = useMapStore((state) => state.selectedFieldId)
  const selectField = useMapStore((state) => state.selectField)
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonClass = useMapStore((state) => state.polygonClass)
  // R-21, R-28: the raw class value tells a United States null class from an unmapped code.
  const polygonRaw = useMapStore((state) => state.polygonRaw)
  const polygonDate = useMapStore(chosenDateOf)
  const panelOpen = usePanelStore((state) => state.open)
  const supportingData = useSupportingDataToggle()
  const [fields, setFields] = useState<FieldSummary[]>([])
  const [mapTile, setMapTile] = useState<{ z: number; x: number; y: number } | null>(null)
  const [scenarios, setScenarios] = useState<RotationScenario[]>([])
  const [scenarioState, setScenarioState] = useState<ScenarioResponse['state'] | null>(null)
  const [threshold, setThreshold] = useState<string | null>(null)
  // R-30: the fixture's own season, so the panel can say when the derived season differs.
  const [error, setError] = useState<string | null>(null)
  const [canRetryFields, setCanRetryFields] = useState(false)
  const [fieldsRequest, setFieldsRequest] = useState(0)
  const [isLoadingFields, setIsLoadingFields] = useState(true)
  const [isLoadingScenarios, setIsLoadingScenarios] = useState(false)
  // The CPC ENSO state is one read per page; the municipal climate line follows the field.
  const [enso, setEnso] = useState<Loadable<EnsoState>>({ status: 'loading' })
  const [climate, setClimate] = useState<Loadable<FieldClimate> | null>(null)
  // The municipality codes the report export carries; a field without one has no report.
  const [reportCodes, setReportCodes] = useState<Set<number> | null>(null)
  // The fixture's own season, written by the `/fields` response; the note that printed it lived in the
  // rotation panel, so only the setter is kept.
  const [, setFixtureSeason] = useState('2025/26')
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const [noticeHeight, setNoticeHeight] = useState(0)

  // R-40, R-51, R-52: the two block 4 toggle states. Each takes the default of the width
  // the app loads at, once, and is never re-derived: a resize keeps the value the user's
  // last press set, and only a reload returns the default.
  const [timelineExpanded, setTimelineExpanded] = useState(() => !isNarrowViewport())
  // Structure only, never state (R-40): the timeline toggle is mounted at 360 and 780, and
  // at 360 it is the region's first control rather than the region's sibling (R-46).
  const compactViewport = useMediaMatch(COMPACT_QUERY)
  const narrowViewport = useMediaMatch(NARROW_QUERY)
  // R-35 and R-36: the dock's top edge follows the rotation panel's measured top edge, so
  // the 8 px gap and the y 450 floor are kept without hard-coding either panel height.

  // Block 4: one `/layers` request per chosen date and viewport tile feeds both the rail
  // and the map (R-14, R-24). The rail no longer fetches on its own.
  useLayers(mapTile)

  // R-01, R-23 and R-32: the load reads `?region=`, `?basemap=` and `?polygon=` once. The
  // region is never chosen by a visible control, the basemap stays EOX without a Google key,
  // and a `?polygon=` that does not resolve in the active region clears the selection.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const search = window.location.search
    const store = useMapStore.getState()
    const loadedRegion = regionFromSearch(search)
    if (loadedRegion !== store.regionId) store.setRegionId(loadedRegion)
    const requestedBasemap = new URLSearchParams(search).get('basemap')
    if (requestedBasemap === 'google' || requestedBasemap === 'google-satellite') {
      const google = BASEMAP_ADAPTERS.find((adapter) => adapter.id === 'google-satellite')
      // R-32: without a key the EOX adapter stays, and the region says why.
      if (google?.selectable()) store.setBasemapId('google-satellite')
      else store.setBasemapKeyMissing(true)
    }
    const restored = polygonIdFromSearch(search, regionAdapter(loadedRegion))
    if (restored !== null) store.restorePolygon(restored)
    else if (store.selectedPolygonId !== null) store.clearPolygonSelection()
    // Block 5.5, D1: the three deep links are removed. The four buttons are the only way to open
    // a panel, and nothing in the URL records which one is open (block 7 revision 10 R-06, R-09).
  }, [])

  // Block 5.5, W3: closing a panel returns the focus to the button that opened it, the same rule
  // block 6 R-05 had for the full screen surface, now that the panel is inside the map screen.
  const wasPanelOpenRef = useRef<PanelId | null>(null)
  useEffect(() => {
    const previous = wasPanelOpenRef.current
    if (previous !== null && panelOpen !== previous) {
      const attr = PANEL_TOGGLE_ATTR[previous]
      document.querySelector<HTMLButtonElement>(`[${attr}]`)?.focus()
    }
    wasPanelOpenRef.current = panelOpen
  }, [panelOpen])

  const registeredFields = useMapStore((state) => state.registeredFields)

  // R-52, R-53 and R-54: the two keys are read once when the app loads and again after an explicit
  // action on the `Field record` surface. Nothing is written here.
  const refreshProducer = useCallback(() => {
    const storedFields = loadFields()
    const storedProducer = loadProducer()
    useMapStore.getState().setProducerRecords(
      'value' in storedFields ? storedFields.value : [],
      'value' in storedProducer ? storedProducer.value : {},
    )
  }, [])

  useEffect(() => {
    refreshProducer()
  }, [refreshProducer])

  // R-03 and R-23: the URL is the only record of the region and the polygon selection, so it
  // is rewritten with `history.replaceState` and never with a navigation or local storage.
  // The effect reads the store rather than the render snapshot, so the first write after the
  // mount read above cannot momentarily drop `?region=` or `?polygon=`.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const store = useMapStore.getState()
    const next = searchWithPolygon(
      searchWithRegion(window.location.search, store.regionId),
      regionAdapter(store.regionId),
      store.selectedPolygonId,
    )
    if (next !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${next}${window.location.hash}`)
    }
  }, [regionId, selectedPolygonId])

  // R-24 and AM-10: only the fixture fields of the active region are listed or drawn, so a
  // Brazil chip never appears on a United States map. Before the CSB fixture exists the
  // United States list is empty, which is the honest state.
  const regionFields = useMemo(
    () => fields.filter((field) => regionAdapter(regionId).fixtureIds.includes(field.id)),
    [fields, regionId],
  )

  const hasNotice = Boolean(error || (scenarioState === 'abstained' && threshold && scenarios.length > 0))

  // Block 4 R-35 and R-36 used to anchor the dock's top edge to the rotation panel's measured
  // top edge. That panel is gone, so the dock keeps the position it had there with a fixed value:
  // `--fs-rotation-top` defaults to 882px in the stylesheet, which is the measurement both widths
  // produced while the panel existed, and the dock's own floor and offsets are unchanged.

  // The status notice and the right edge column are separate fixed overlays, so the
  // 8 px gap of R-23 is kept by measuring the notice, not by nesting it. The measure
  // runs after every render, because a viewport change can rewrap the notice without
  // dispatching a resize event.
  useLayoutEffect(() => {
    const node = noticeRef.current
    const next = node ? node.getBoundingClientRect().height : 0
    setNoticeHeight((current) => (Math.abs(current - next) > 0.5 ? next : current))
  })

  useEffect(() => {
    const node = noticeRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setNoticeHeight((current) => {
        const next = node.getBoundingClientRect().height
        return Math.abs(current - next) > 0.5 ? next : current
      })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNotice])

  const selectedField = useMemo(
    () => regionFields.find((field) => field.id === selectedFieldId) ?? null,
    [regionFields, selectedFieldId],
  )
  // R-28: the chip's class comes from the table through the store, never from the catalog, and
  // an unresolved or unmapped class draws the unmapped colour. The year rule is a pure function
  // so a United States null class is tested at its source.
  const selectedPolygonChip = useMemo(
    () => selectedPolygonChipOf(
      selectedPolygonId,
      polygonClass,
      polygonRaw,
      regionAdapter(regionId),
      polygonDate,
    ),
    [selectedPolygonId, polygonClass, polygonRaw, polygonDate, regionId],
  )
  // R-14, R-15: every evidence row is presented from its own fields. The layer name is
  // the fixture string through its catalog key; the basis label comes from the row's
  // own `basis` in EvidencePanel. No state outside the row can relabel it.
  const evidenceRows = useMemo<EvidenceRow[]>(() => {
    const selectedScenario = scenarios.find((scenario) => scenario.is_current) ?? scenarios[0]
    return (selectedScenario?.evidence_rows ?? []).map((row) => ({
      ...row,
      layer: t(translationKeyFor(row.layer) ?? row.layer),
    }))
  }, [scenarios])

  // The band draws the crops of the field's scenarios (Soybean, Corn and Cotton here).
  const fieldCrops = useMemo(() => {
    const seen = new Set<string>()
    for (const scenario of scenarios) {
      for (const crop of scenario.crops) seen.add(crop)
    }
    return [...seen]
  }, [scenarios])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API_BASE}/fields`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new BackendHttpError(response.status)
        return response.json() as Promise<FieldResponse>
      })
      .then((data) => {
        setFields(data.fields)
        setFixtureSeason(data.default_season)
        setError(null)
        setCanRetryFields(false)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setFields([])
        setScenarios([])
        setScenarioState(null)
        setThreshold(null)
        setError(backendFailureReason(reason))
        setCanRetryFields(true)
      })
      .finally(() => setIsLoadingFields(false))
    return () => controller.abort()
  }, [fieldsRequest])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API_BASE}/fieldphase/data/v1/municipalities.json`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { municipalities?: { code: number }[] } | null) => {
        if (!controller.signal.aborted) setReportCodes(new Set((body?.municipalities ?? []).map((entry) => entry.code)))
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadParsed(`${API_BASE}/climate/enso`, ensoSchema, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setEnso(next) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selectedFieldId) {
      setClimate(null)
      return
    }
    const controller = new AbortController()
    setClimate({ status: 'loading' })
    loadParsed(`${API_BASE}/fields/${selectedFieldId}/climate`, fieldClimateSchema, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setClimate(next) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [selectedFieldId])

  useEffect(() => {
    if (!selectedFieldId) return
    const controller = new AbortController()
    setIsLoadingScenarios(true)
    setError(null)
    // R-30: the scenario request carries no season. The fixture evidence rows have no
    // season field, so a date change must not refetch or relabel their values.
    fetch(`${API_BASE}/fields/${selectedFieldId}/scenarios`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new BackendHttpError(response.status)
        return response.json() as Promise<ScenarioResponse>
      })
      .then((data) => {
        setScenarios(data.scenarios)
        setScenarioState(data.state)
        setThreshold(data.threshold)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setScenarios([])
        setScenarioState(null)
        setError(backendFailureReason(reason))
      })
      .finally(() => setIsLoadingScenarios(false))
    return () => controller.abort()
  }, [selectedFieldId])

  const handleRetryFields = useCallback(() => {
    setIsLoadingFields(true)
    setFieldsRequest((request) => request + 1)
  }, [])

  const handleSelectField = useCallback((fieldId: string) => {
    if (fieldId === useMapStore.getState().selectedFieldId) return
    setScenarios([])
    setScenarioState(null)
    setThreshold(null)
    selectField(fieldId)
  }, [selectField])

  // R-40: at 360 opening one panel closes the other. Above 640 both may stay open (R-23).
  // The width is read at press time so a resize cannot leave the rule stale.
  const handleToggleTimeline = useCallback(() => {
    setTimelineExpanded((current) => !current)
  }, [])

  const handleToggleSupportingData = useCallback(() => {
    supportingData.toggle()
  }, [supportingData])

  // Block 5.5, B5: `Rotation outlook` and `Field numbers` are disabled while nothing is selected,
  // with the reason in their accessible name. A fixture field is a selection too (block 6 R-03).
  const hasSelection = selectedPolygonId !== null || selectedFieldId !== null

  /**
   * Block 5.5, W2 and the plan's R3: the panels are data. A later panel is one more entry here, and
   * `PanelHost` renders whichever one is open without a branch of its own.
   */
  const panelSpecs: PanelSpec[] = [
    {
      id: 'numbers',
      labelKey: 'numbers.open',
      needsSelection: true,
      content: hasSelection ? <NumbersView scenarios={scenarios} selectedField={selectedField} /> : null,
    },
  ]

  // Block 5.5, B1: the map screen is never hidden. The shell carries no state class for a panel,
  // because a panel is a box inside the map screen and not a screen over it.
  const shellClass = 'app-shell'

  const reportCode = (() => {
    const code = selectedField?.municipality_code ?? null
    return reportCodes !== null && code !== null && reportCodes.has(code) ? code : null
  })()

  const shellStyle = {
    '--fs-notice-block': `${hasNotice ? noticeHeight + 8 : 0}px`,
  } as CSSProperties

  return (
    <main className={shellClass} style={shellStyle}>
      <MapCanvas fields={regionFields} selectedField={selectedField} onTileChange={setMapTile} />
      <div className="overlay anchor-bottom-right layer-rail-anchor" style={{ zIndex: ZOrder.layerRail }}>
        <div className="overlay-interactive panel-surface layer-panel"><LayerRail /></div>
      </div>

      {/* Block 5, R-40 and OD-03: the Polygon region sits at its own numbers at 1440 and 780.
          At 360 it is not mounted at all, and the fields chip carries the class there. */}
      {!narrowViewport && (
        <div className="polygon-panel-anchor" style={{ zIndex: ZOrder.polygonPanel }}>
          {/* Block 5.5, U3 and W6: the readout exists only while a polygon is selected. */}
          {selectedPolygonId !== null && <PolygonPanel />}
        </div>
      )}

      <div className="overlay anchor-top-left layer-chips" style={{ zIndex: ZOrder.chips }}>
        <div className="overlay-interactive top-chip brand-chip">
          <a className="brand" href="/" aria-label={t('map.field_map_home')}>
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span>{t('map.brand')}{t('map.brand_accent')}</span>
          </a>
        </div>
      </div>

      <div className="overlay anchor-top-right layer-controls" style={{ zIndex: ZOrder.controlStrip }}>
        <div className="overlay-interactive topbar-meta">
          <span className="top-chip workspace-label">{t('map.field_intelligence')}</span>
          <span className="top-chip profile-avatar" aria-label={t('map.grower_profile')}>GM</span>
          <EnsoChip enso={enso} />
          <SupportingDataToggle isOpen={supportingData.isOpen} onToggle={handleToggleSupportingData} />
          {/* Block 5.5, W3 and block 7 revision 10 R-08: the four buttons in the fixed order
              `Rotation outlook`, `Field numbers`, `Planting calendar`, `Field record`, to the
              right of `Supporting data`, which block 4 R-41 freezes as the anchor. */}
          <NumbersToggle hasSelection={hasSelection} />
          <ReportButton code={reportCode} />
        </div>
      </div>

      {/* One notice node. At 360 it is the first box of the left stack (R-39); above 640 it
          sits at right 22, top 60 and the right edge column starts 8 px below it (R-23). */}
      <div className="left-stack">
        {hasNotice && (
          <div className="overlay anchor-notice layer-notice" style={{ zIndex: ZOrder.abstentionNotice }}>
            <div ref={noticeRef} className="overlay-interactive panel-surface notice-anchor">
              {error && <p className="error-notice" role="alert">{error}</p>}
              {scenarioState === 'abstained' && threshold && scenarios.length > 0 && (
                <AbstentionNotice threshold={threshold} />
              )}
            </div>
          </div>
        )}

        <div className="overlay anchor-left field-list-anchor layer-chips" style={{ zIndex: ZOrder.chips }}>
          <FieldsPanel
            fields={regionFields}
            selectedFieldId={selectedFieldId}
            isLoading={isLoadingFields}
            error={error}
            canRetry={canRetryFields}
            onSelectField={handleSelectField}
            onRetry={handleRetryFields}
            selectedPolygon={selectedPolygonChip}
            registeredFields={registeredFields}
          />
        </div>
      </div>

      {/* Block 4 wave 4: the dock is its own anchor at z 45, between the abstention notice
          (40) and the rotation panel (50). It is fixed, so at 780 its 8 px gap and the
          y 450 floor are both kept while block 3's panel boxes do not move. */}
      <div className="overlay anchor-timeline-dock" style={{ zIndex: ZOrder.timelineDock }}>
        <TimelineDock
          crops={fieldCrops}
          location={selectedField?.location ?? null}
          expanded={timelineExpanded}
          onToggle={handleToggleTimeline}
          showToggle={compactViewport}
          toggleInside={narrowViewport && timelineExpanded}
        />
      </div>

      {/* Block 5.5, W2: one box in the bottom left overlay, the rectangle `ScenarioCards`
          occupied, holding exactly one panel. The heading row, the coverage pill and the fixture
          note now belong to the `Rotation outlook` panel's own content. */}
      <div className="overlay anchor-bottom-left layer-cards" style={{ zIndex: ZOrder.scenarioCards }}>
        <div
          className="overlay-interactive panel-surface scenario-anchor"
          data-rotation-panel
          style={{ zIndex: ZOrder.scenarioCards }}
        >
          <PanelHost panels={panelSpecs} />
        </div>
      </div>

      {supportingData.isOpen && (
        <div className="overlay anchor-right-column">
          <div className="right-column-stack">
            {supportingData.isOpen && (
              <div
                id={SUPPORTING_DATA_PANEL_ID}
                className="overlay-interactive panel-surface evidence-anchor layer-evidence"
                style={{ zIndex: ZOrder.evidence }}
              >
                <ClimateSignal climate={climate} />
                <EvidencePanel
                  climate={climate && climate.status === 'ready'
                    ? {
                      municipality: `${climate.data.municipality.name_official} (${climate.data.municipality.uf})`,
                      rows: climate.data.rows,
                    }
                    : null}
                  rows={evidenceRows}
                  isLoading={isLoadingFields || isLoadingScenarios}
                  emptyReason={isLoadingFields || isLoadingScenarios
                    ? null
                    : error ?? (evidenceRows.length === 0 ? t('evidence.empty_hint') : null)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Block 5.5, B1: nothing is mounted over the map any more. The four panels live in the
          host above, and the map screen is the screen. */}
    </main>
  )
}

export default App

