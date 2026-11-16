import type { FeatureCollection } from "geojson";

/**
 * Field Phase data contract, version 1.2 (1.1 adds the optional forecast, vegetation, land_cover
 * and terrain blocks; 1.2 adds `rotations`; each is null when its inputs have not been built).
 *
 * Mirrors api/repository.py exactly. Every payload is plain JSON: numbers may be null (never NaN),
 * dates are ISO strings, categorical fields are stable codes and never translated text.
 */

export type EnsoClass = "el_nino_strong" | "el_nino_moderate" | "neutral" | "la_nina";
export type Strength = "none" | "weak" | "moderate" | "strong" | "very_strong";
export type CropSeason = "summer" | "winter" | "us";
/** "suposicao" marks an unsourced assumption and must surface as a warning in the UI. */
export type SourceTag = string;

export interface Assumption {
  scope: "crop";
  crop_code: number;
  field: string;
  value: string;
  source: SourceTag;
}

export interface Meta {
  app: string;
  contract_version: string;
  /** True only for mock payloads; the UI must then show a visible "mock" badge. */
  mock: boolean;
  generated_at: string;
  baseline_crop_years: [number, number];
  current_crop_year: number | null;
  enso_classes: EnsoClass[];
  methods: Record<string, string>;
  assumptions: Assumption[];
  datasets: Record<string, Record<string, string>>;
}

export interface OutlookRow {
  lead: number;
  season: string;
  issued: string;
  p_la_nina: number;
  p_neutral: number;
  p_el_nino: number;
  "p_p0.5_p1.0": number;
  "p_p1.0_p1.5": number;
  "p_p1.5_p2.0": number;
  "p_ge_p2.0": number;
  [bin: string]: number | string;
}

export interface EnsoHistoryRow {
  season: string;
  year: number;
  center_month: number;
  crop_year: number;
  roni: number | null;
  oni: number | null;
  roni_phase: string | null;
  roni_strength: Strength | null;
}

export interface CropYearEnso {
  crop_year: number;
  enso_class: EnsoClass;
  roni_ref: number | null;
  roni_strength: Strength | null;
  provisional: boolean;
  forecast: boolean;
  forecast_probability_pct?: number | null;
  basis: string;
}

export interface EnsoPayload {
  current: {
    discussion: {
      issued: string;
      alert_status: string;
      synopsis: string;
      next_issue: string | null;
      nino34_quoted_c: number | null;
      discussion_text: string;
      source_url: string;
    };
    roni: { season: string; value: number; phase: string; strength: Strength };
    oni: { season: string; value: number };
    weekly_nino34: { week: string; anomaly: number };
    fetched_at: string;
  };
  outlook: OutlookRow[];
  weekly: { week_center: string; nino34_anom: number; nino12_anom: number }[];
  history: EnsoHistoryRow[];
  crop_years: CropYearEnso[];
  provenance: Record<string, string>;
}

export interface Municipality {
  code: number;
  /** ASCII name from config/regions.yaml. */
  name: string;
  /** IBGE's official, accented name (from SIDRA); use this for display. */
  name_official: string;
  uf: string;
  region_id: string;
  region_name: string;
  /** Direction of the El Nino rainfall signal in this region. */
  enso_signal: "excess" | "deficit";
  hazards: string[] | string;
  centroid_lon: number;
  centroid_lat: number;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  geometry_source: string;
}

export interface MunicipalitiesPayload {
  municipalities: Municipality[];
  geojson: FeatureCollection | null;
  provenance: Record<string, string>;
}

export interface CompositeRow {
  enso_class: EnsoClass;
  n: number;
  mean: number | null;
  median: number | null;
  minus_neutral: number | null;
  /** Comma-separated crop years. */
  years: string;
}

export interface ClimateSeason {
  crop_year: number;
  enso_class: EnsoClass | null;
  [metric: string]: number | string | null;
}

export interface CropEvidence {
  crop_code: number;
  name_pt: string;
  name_en: string;
  season: CropSeason;
  source: SourceTag;
  assumption: boolean;
  /** SIDRA table for Brazilian crops; null for USDA NASS. */
  pam_table: number | null;
  /** "kg/ha" for IBGE PAM, the NASS unit ("BU / ACRE", "LB / ACRE") for the US. */
  yield_unit?: string;
  series: {
    crop_year: number;
    enso_crop_year: number;
    yield_value: number;
    trend_value: number;
    anomaly_pct: number;
    enso_class: EnsoClass | null;
  }[];
  composite: CompositeRow[];
}

export interface SeasonDay {
  day: number;
  date: string;
  current_mm: number | null;
  baseline_mean_mm: number | null;
  baseline_p10_mm: number | null;
  baseline_p90_mm: number | null;
  analog_mean_mm: number | null;
  /** Ensemble forecast continuing the curve (median and 10-90 % across members). */
  forecast_median_mm?: number | null;
  forecast_p10_mm?: number | null;
  forecast_p90_mm?: number | null;
}

export interface ForecastProductStatus {
  product: "short_range" | "extended" | "seasonal" | string;
  source: string;
  status: "ok" | "unavailable";
  reason: string;
  first_date: string | null;
  last_date: string | null;
}

export interface ForecastSummary {
  issued_utc_day: string;
  start: string;
  end: string;
  days: number;
  rain_mm: number;
  heavy_days: number;
  max_dry_spell_days: number;
  normal_rain_mm: number | null;
  normal_p10_mm: number | null;
  normal_p90_mm: number | null;
  n_normal_years: number;
  analog_rain_mm: number | null;
  n_analog_years: number;
  et0_mm?: number | null;
  water_balance_mm?: number | null;
  smi_15cm_start?: number | null;
  smi_15cm_end?: number | null;
  smi_50cm_start?: number | null;
  smi_50cm_end?: number | null;
}

export interface ForecastDay {
  date: string;
  kind: "recent" | "forecast";
  rain: number | null;
  rain_probability?: number | null;
  tmax?: number | null;
  tmin?: number | null;
  et0?: number | null;
  smi_15cm?: number | null;
  smi_50cm?: number | null;
}

export interface OutlookMonth {
  month: string;
  forecast_median_mm: number;
  forecast_p10_mm: number;
  forecast_p90_mm: number;
  n_members: number;
  normal_mm: number | null;
  normal_p10_mm: number | null;
  normal_p90_mm: number | null;
  analog_mm: number | null;
  n_analog: number;
}

export interface ForecastBlock {
  provider: string;
  issued_utc_day: string | null;
  products: ForecastProductStatus[];
  short_range: { summary: ForecastSummary; days: ForecastDay[] } | null;
  season_outlook: OutlookMonth[] | null;
  provenance: Record<string, string>;
}

export interface NdviSlot {
  slot: number;
  doy: number;
  label_date: string;
  current: number | null;
  current_date: string | null;
  baseline_mean: number | null;
  baseline_p10: number | null;
  baseline_p90: number | null;
  n_baseline: number;
  analog_mean: number | null;
  n_analog: number;
}

export interface VegetationBlock {
  baseline_crop_years: string | null;
  last_composite: string | null;
  seasons: {
    crop_year: number;
    ndvi_peak: number;
    n_composites: number;
    ndvi_peak_anom: number | null;
    ndvi_peak_anom_pct: number | null;
    enso_class: EnsoClass | null;
  }[];
  composite: CompositeRow[];
  progress: NdviSlot[];
  provenance: Record<string, string>;
}

export interface LandCoverBlock {
  years: { year: number; cropland_share: number; cropland_km2: number }[];
  provenance: Record<string, string>;
}

export type ReliefClass = "plano" | "suave_ondulado" | "ondulado" | "forte_ondulado" | "montanhoso" | "escarpado";

export type Component = "soil" | "water" | "income";
export type Weights = Record<Component, number>;

export interface CalendarEntry {
  crop: string;
  stage: "ini" | "dev" | "mid" | "end";
}

export interface RotationResult {
  id: string;
  crops: string[];
  windows: Record<string, { sow: number; harvest: number }>;
  /** Keys are calendar months "1".."12". */
  calendar: Record<string, CalendarEntry[]>;
  soil: {
    value: number | null;
    score: number | null;
    bare_months?: number[];
    heavy_days_by_bare_month?: Record<string, number>;
    reason?: string;
  };
  water: {
    value: number | null;
    score: number | null;
    demand_mm?: number;
    stress_days?: number;
    n_years?: number;
    /** Total available water (mm) in each crop's root zone. */
    taw_mm?: Record<string, number>;
    model?: string;
    by_month?: { month: number; deficit_mm: number }[];
    reason?: string;
  };
  income: {
    value: number | null;
    score: number | null;
    revenue_normal?: number;
    revenue_in_class?: number;
    min_n_years?: number;
    items: { crop: string; cover_crop?: boolean; revenue_per_ha?: number | null; yield_anomaly_pct?: number | null; n_years?: number }[];
    reason?: string;
  };
  /** Total and rank for the payload's default weights; the UI recomputes them for its own. */
  total: number | null;
  rank: number | null;
}

export interface MonthClimate {
  month: number;
  rain_mm: number | null;
  heavy_days: number | null;
  et0_mm: number | null;
  n_years: number;
  n_years_et0: number;
}

export interface RotationsBlock {
  current_class: EnsoClass | null;
  current_class_is_forecast: boolean;
  default_weights: Weights;
  formula: string;
  components: Record<Component, { metric: string; unit: string; better: "lower" | "higher" }>;
  crops: Record<string, { name_pt: string; name_en: string; abbr?: string | null; cover_crop?: boolean | null }>;
  by_class: Partial<Record<EnsoClass, RotationResult[]>>;
  climate_by_class: Partial<Record<EnsoClass | "all", MonthClimate[]>>;
  assumptions: { scope: string; region: string; source: string; crop?: string }[];
  /** Calendar display order: the region's crop year (Jul-Jun in Brazil, Oct-Sep in the US). */
  month_order?: number[];
  provenance: Record<string, string>;
}

/** The months behind every seasonal label of a region. */
export interface SeasonInfo {
  crop_year_start_month: number;
  season_months: number[];
  sub_seasons: { early: number[]; late: number[] };
  ndvi_peak_months: number[];
  source: string;
}

export interface TerrainBlock {
  by_scope: Record<"municipality" | "cropland", { median_slope_pct: number; classes: { relief_class: ReliefClass; share: number }[] }>;
  provenance: Record<string, string>;
}

export interface MunicipalityPayload {
  municipality: Municipality & { hazards: string[] };
  season?: SeasonInfo;
  current_crop_year: Partial<CropYearEnso> & { crop_year: number };
  season_progress: {
    start: string;
    last_observed: string;
    n_baseline: number;
    n_analog: number;
    analog_years: number[];
    days: SeasonDay[];
    forecast_model?: string | null;
  };
  forecast?: ForecastBlock | null;
  vegetation?: VegetationBlock | null;
  land_cover?: LandCoverBlock | null;
  terrain?: TerrainBlock | null;
  rotations?: RotationsBlock | null;
  /** Why `rotations` is null. */
  rotations_status?: "ready" | "not_built" | "not_configured";
  climate: {
    seasons: ClimateSeason[];
    composites: Record<string, { unit: string; by_class: CompositeRow[] }>;
  };
  yield: { crops: CropEvidence[] };
  provenance: Record<string, string>;
}
