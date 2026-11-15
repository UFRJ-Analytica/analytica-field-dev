import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MapCanvas } from '@/components/MapCanvas'
import { LayerRail } from '@/components/LayerRail'
import { ScenarioCards, type RotationScenario } from '@/components/ScenarioCards'
import { EvidencePanel, type EvidenceRow } from '@/components/EvidencePanel'
import { TimelineDock } from '@/components/TimelineDock'
import { AbstentionNotice } from '@/components/AbstentionNotice'
import { FieldsPanel } from '@/components/FieldsPanel'
import { AgentBar, CommandToggle, useCommandToggle } from '@/components/CommandToggle'
import { PolygonPanel } from '@/components/PolygonPanel'
import { SUPPORTING_DATA_PANEL_ID, SupportingDataToggle, useSupportingDataToggle } from '@/components/SupportingDataToggle'
import { NumbersToggle, NUMBERS_TOGGLE_ATTR } from '@/components/NumbersToggle'
import { NumbersView } from '@/components/NumbersView'
import { useMapStore, type FieldSummary } from '@/lib/map-store'
import { numbersOpenFromSearch, searchWithNumbers } from '@/lib/numbers'
import { useLayers } from '@/lib/use-layers'
import { seasonForDate } from '@/lib/timeline'
import {
  regionAdapter,
  regionFromSearch,
  searchWithRegion,
} from '@/lib/regions'
import { BASEMAP_ADAPTERS } from '@/lib/basemap-adapters'
import { unmappedClassColour } from '@/lib/polygon-style'
import { polygonIdFromSearch, searchWithPolygon, commandFieldId } from '@/lib/polygon-selection'
import {
  COMPACT_QUERY,
  NARROW_QUERY,
  isCompactViewport,
  isNarrowViewport,
  useMediaMatch,
} from '@/lib/viewport'
import { t, translationKeyFor } from '@/strings'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

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
})

function App() {
  const selectedFieldId = useMapStore((state) => state.selectedFieldId)
  const selectField = useMapStore((state) => state.selectField)
  const regionId = useMapStore((state) => state.regionId)
  const selectedPolygonId = useMapStore((state) => state.selectedPolygonId)
  const polygonClass = useMapStore((state) => state.polygonClass)
  const numbersOpen = useMapStore((state) => state.numbersOpen)
  const command = useCommandToggle()
  const supportingData = useSupportingDataToggle()
  const [fields, setFields] = useState<FieldSummary[]>([])
  const [mapTile, setMapTile] = useState<{ z: number; x: number; y: number } | null>(null)
  const [scenarios, setScenarios] = useState<RotationScenario[]>([])
  const [scenarioState, setScenarioState] = useState<ScenarioResponse['state'] | null>(null)
  const [threshold, setThreshold] = useState<string | null>(null)
  // R-30: the fixture's own season, so the panel can say when the derived season differs.
  const [fixtureSeason, setFixtureSeason] = useState('2025/26')
  const [error, setError] = useState<string | null>(null)
  const [canRetryFields, setCanRetryFields] = useState(false)
  const [fieldsRequest, setFieldsRequest] = useState(0)
  const [isLoadingFields, setIsLoadingFields] = useState(true)
  const [isLoadingScenarios, setIsLoadingScenarios] = useState(false)
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const [noticeHeight, setNoticeHeight] = useState(0)
  // R-40: which right edge panel was opened last. The transition into 360 keeps it
  // and closes the other; leaving 360 never reopens anything (R-35).
  const lastRightPanelRef = useRef<'command' | 'supporting' | null>(null)

  // R-40, R-51, R-52: the two block 4 toggle states. Each takes the default of the width
  // the app loads at, once, and is never re-derived: a resize keeps the value the user's
  // last press set, and only a reload returns the default.
  const [timelineExpanded, setTimelineExpanded] = useState(() => !isNarrowViewport())
  const [rotationCollapsed, setRotationCollapsed] = useState(() => isCompactViewport())
  // Structure only, never state (R-40): the timeline toggle is mounted at 360 and 780, and
  // at 360 it is the region's first control rather than the region's sibling (R-46).
  const compactViewport = useMediaMatch(COMPACT_QUERY)
  const narrowViewport = useMediaMatch(NARROW_QUERY)
  // R-35 and R-36: the dock's top edge follows the rotation panel's measured top edge, so
  // the 8 px gap and the y 450 floor are kept without hard-coding either panel height.
  const rotationPanelRef = useRef<HTMLDivElement | null>(null)
  const [rotationTop, setRotationTop] = useState<number | null>(null)

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
    // Block 6, R-01: `?numbers=1` opens the numbers surface, and nothing else in the URL changes.
    store.setNumbersOpen(numbersOpenFromSearch(search))
  }, [])

  // Block 6, R-01 and R-02: opening and closing the numbers surface writes or removes the one
  // `numbers` parameter with `history.replaceState`. Every other parameter is kept as it was.
  const openNumbers = useCallback(() => {
    useMapStore.getState().setNumbersOpen(true)
    window.history.replaceState(null, '', `${window.location.pathname}${searchWithNumbers(window.location.search, true)}${window.location.hash}`)
  }, [])

  const closeNumbers = useCallback(() => {
    useMapStore.getState().setNumbersOpen(false)
    window.history.replaceState(null, '', `${window.location.pathname}${searchWithNumbers(window.location.search, false)}${window.location.hash}`)
  }, [])

  // R-05 and AC-01: closing returns focus to the `Field numbers` button that opened the surface.
  const wasNumbersOpenRef = useRef(false)
  useEffect(() => {
    if (wasNumbersOpenRef.current && !numbersOpen) {
      document.querySelector<HTMLButtonElement>(`[${NUMBERS_TOGGLE_ATTR}]`)?.focus()
    }
    wasNumbersOpenRef.current = numbersOpen
  }, [numbersOpen])

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

  // R-35, R-36: the rotation panel's top edge is the only anchor the dock needs. It is
  // measured, not assumed, because a collapsed panel's height is its header and a
  // resized viewport moves it.
  useLayoutEffect(() => {
    const node = rotationPanelRef.current
    if (!node) return
    const next = node.getBoundingClientRect().top
    setRotationTop((current) => (current === null || Math.abs(current - next) > 0.1 ? next : current))
  })

  useEffect(() => {
    const node = rotationPanelRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      setRotationTop((current) => {
        const next = node.getBoundingClientRect().top
        return current === null || Math.abs(current - next) > 0.1 ? next : current
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [rotationCollapsed])

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
  // an unresolved or unmapped class draws the unmapped colour.
  const selectedPolygonChip = useMemo(
    () => (selectedPolygonId === null
      ? null
      : {
        fieldId: commandFieldId(regionAdapter(regionId), selectedPolygonId),
        name: polygonClass?.name ?? null,
        hex: polygonClass?.hex ?? unmappedClassColour(),
      }),
    [selectedPolygonId, polygonClass, regionId],
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

  // R-29 and R-31: the dock and the band read one chosen date and one derived season.
  const chosenDate = useMapStore((state) => state.chosenDate ?? state.axis.default)
  const derivedSeason = seasonForDate(chosenDate)
  // The band draws the crops of the field's scenarios (Soybean, Corn and Cotton here).
  const fieldCrops = useMemo(() => {
    const seen = new Set<string>()
    for (const scenario of scenarios) {
      for (const crop of scenario.crops) seen.add(crop)
    }
    return [...seen]
  }, [scenarios])
  // R-30: the fixture scenario stays the fixture scenario, and the panel says which
  // season its values belong to when the chosen date derives another one.
  const showFixtureNote = selectedField !== null && derivedSeason !== fixtureSeason

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

  const handleToggleRotation = useCallback(() => {
    setRotationCollapsed((current) => !current)
  }, [])

  const handleToggleCommand = useCallback(() => {
    const willOpen = !command.isOpen
    if (isNarrowViewport() && willOpen) supportingData.close()
    if (willOpen) lastRightPanelRef.current = 'command'
    command.toggle()
  }, [command, supportingData])

  const handleToggleSupportingData = useCallback(() => {
    const willOpen = !supportingData.isOpen
    if (isNarrowViewport() && willOpen) command.close()
    if (willOpen) lastRightPanelRef.current = 'supporting'
    supportingData.toggle()
  }, [command, supportingData])

  // R-40: the one resize transition that changes a toggle state. When the viewport
  // becomes 360 while both panels are open, the panel opened last stays and the older
  // one closes. Both closes are programmatic, so neither pulls focus (the command
  // form's close skips its focus restore), and focus stays where it was.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches || !command.isOpen || !supportingData.isOpen) return
      if (lastRightPanelRef.current === 'supporting') command.close()
      else supportingData.close()
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [command.isOpen, supportingData.isOpen, command.close, supportingData.close])

  const shellStyle = {
    '--fs-notice-block': `${hasNotice ? noticeHeight + 8 : 0}px`,
    ...(rotationTop === null ? {} : { '--fs-rotation-top': `${rotationTop}px` }),
  } as CSSProperties

  return (
    <main className={numbersOpen ? 'app-shell is-numbers-open' : 'app-shell'} style={shellStyle}>
      <MapCanvas fields={regionFields} selectedField={selectedField} onTileChange={setMapTile} />
      <div className="overlay anchor-bottom-right layer-rail-anchor" style={{ zIndex: ZOrder.layerRail }}>
        <div className="overlay-interactive panel-surface layer-panel"><LayerRail /></div>
      </div>

      {/* Block 5, R-40 and OD-03: the Polygon region sits at its own numbers at 1440 and 780.
          At 360 it is not mounted at all, and the fields chip carries the class there. */}
      {!narrowViewport && (
        <div className="polygon-panel-anchor" style={{ zIndex: ZOrder.polygonPanel }}>
          <PolygonPanel />
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
          <CommandToggle isOpen={command.isOpen} buttonRef={command.buttonRef} onToggle={handleToggleCommand} />
          <SupportingDataToggle isOpen={supportingData.isOpen} onToggle={handleToggleSupportingData} />
          <NumbersToggle onOpen={openNumbers} />
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

      <div className="overlay anchor-bottom-left layer-cards" style={{ zIndex: ZOrder.scenarioCards }}>
        <div
          ref={rotationPanelRef}
          className="overlay-interactive panel-surface scenario-anchor"
          data-collapsed={rotationCollapsed ? 'true' : 'false'}
          data-rotation-panel
          style={{ zIndex: ZOrder.scenarioCards }}
        >
          <div className="rotation-heading-row">
            <div className="rotation-heading-copy">
              <div>
                <p className="eyebrow">{t('map.plan_with_evidence')}</p>
                <h2>{t('map.rotation_outlook')}</h2>
              </div>
              {/* R-48: native button, name states the action, 44 by 44 px, focus stays. */}
              <button
                aria-expanded={!rotationCollapsed}
                aria-label={t(rotationCollapsed ? 'rotation.expand' : 'rotation.collapse')}
                className="rotation-collapse-toggle"
                onClick={handleToggleRotation}
                type="button"
              >
                <svg aria-hidden="true" focusable="false" height="14" viewBox="0 0 14 14" width="14">
                  <path
                    d={rotationCollapsed ? 'M2 5l5 5 5-5' : 'M2 9l5-5 5 5'}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              </button>
            </div>
            {/* AM-07 and R-26: a polygon has no coverage measurement, so the pill is unmounted
                while a polygon is the selected field rather than printing a 0 percent. */}
            {selectedPolygonId === null && (
              <span className="field-coverage-pill"><span className="coverage-dot" />{t('map.data_coverage', { coverage: selectedField?.coverage ?? 0 })}</span>
            )}
            {showFixtureNote && (
              <p className="fixture-season-note">
                {t('timeline.fixture_data', { season: fixtureSeason, derived: derivedSeason })}
              </p>
            )}
          </div>
          <ScenarioCards
            collapsed={rotationCollapsed}
            emptyReason={isLoadingFields || isLoadingScenarios
              ? null
              : error ?? (selectedPolygonId !== null
                // R-26, AC-22: a polygon has no rotation scenarios of its own. It gets the
                // scenarios empty text, not the fixture's select-a-field copy.
                ? t('empty.no_rotation_scenarios')
                : !selectedFieldId
                  ? t('empty.select_field')
                  : scenarios.length === 0 ? t('empty.no_rotation_scenarios') : null)}
            isLoading={isLoadingFields || isLoadingScenarios}
            // R-49, AC-41: the season chip belongs to block 3's map screen, not to the polygon surface.
            seasonChip={selectedPolygonId === null}
            scenarios={scenarios}
            state={scenarioState === 'abstained' ? null : scenarioState}
            threshold={scenarioState === 'abstained' ? null : threshold}
          />
        </div>
      </div>

      {(command.isOpen || supportingData.isOpen) && (
        <div className="overlay anchor-right-column">
          <div className="right-column-stack">
            {command.isOpen && (
              <div className="overlay-interactive panel-surface agent-anchor layer-agent" style={{ zIndex: ZOrder.agentBar }}>
                <AgentBar
                  draft={command.draft}
                  commandNameInputRef={command.commandNameInputRef}
                  onDraftChange={command.updateDraft}
                />
              </div>
            )}
            {supportingData.isOpen && (
              <div
                id={SUPPORTING_DATA_PANEL_ID}
                className="overlay-interactive panel-surface evidence-anchor layer-evidence"
                style={{ zIndex: ZOrder.evidence }}
              >
                <EvidencePanel
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

      {/* Block 6, R-01 and R-02: the numbers surface is a sibling of the map screen. While it is
          open, `.is-numbers-open` hides every other child of the shell (NumbersView.css). */}
      {numbersOpen && (
        <NumbersView selectedField={selectedField} onClose={closeNumbers} scenarios={scenarios} />
      )}
    </main>
  )
}

export default App

