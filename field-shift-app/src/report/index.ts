/**
 * Field Phase UI kit -- the portable part of the web app.
 *
 * Copy this folder into another React project (React 18, Recharts 2, MapLibre GL 4), import
 * "./fieldphase/theme/fieldphase.css" once, wrap your page in
 * <div className="fp-root"><I18nProvider locale="pt-BR">...</I18nProvider></div>,
 * and pass data that follows ./api/types.ts. Components never fetch on their own.
 * See web/README.md for the full guide.
 */

export * from "./api/types";
export { createClient, clientFromEnv, useLoad, type FieldPhaseClient, type DataMode, type Loadable } from "./api/client";
export { I18nProvider, useI18n, type Locale } from "./i18n";
export { STRINGS, type Strings } from "./i18n/strings";
export {
  AssumptionNotice,
  ChartFrame,
  ENSO_COLOR,
  ENSO_ORDER,
  EnsoLegend,
  Legend,
  MockBanner,
  Provenance,
  StatTile,
  TooltipBox,
} from "./components/common";
export { EnsoOutlookChart, EnsoStatus, RoniHistoryChart } from "./components/EnsoPanel";
export { SeasonProgressChart, progressSummary } from "./components/SeasonProgress";
export { AnomalyTimeline, CompositeBars, SMALL_SAMPLE, type TimelinePoint } from "./components/Evidence";
export { YieldEvidence } from "./components/YieldEvidence";
export { MunicipalityMap, MunicipalityPicker, type BasemapOptions } from "./components/MunicipalityMap";
export { ForecastPanel, SeasonOutlookChart } from "./components/ForecastPanel";
export { LandCoverTile, TerrainBars, VegetationPanel, RELIEF_ORDER } from "./components/VegetationPanel";
export { RotationPanel, cropColor } from "./components/RotationPanel";
export { COMPONENTS, rankRotations, weightedTotal, type Ranked } from "./scoring";
