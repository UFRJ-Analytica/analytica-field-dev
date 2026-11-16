import { useState } from "react";
import type { CropEvidence } from "../api/types";
import { useI18n } from "../i18n";
import { AssumptionNotice, Provenance } from "./common";
import { AnomalyTimeline, CompositeBars } from "./Evidence";

/** Crop tabs; each crop shows its composite by ENSO class and its year-by-year anomalies. */
export function YieldEvidence({ crops, provenance }: { crops: CropEvidence[]; provenance?: string }) {
  const { t, locale, fmt } = useI18n();
  const [active, setActive] = useState(0);
  if (!crops.length) return null;
  const crop = crops[Math.min(active, crops.length - 1)];
  const name = (c: CropEvidence) => (locale === "en" ? c.name_en : c.name_pt);
  const seasonLabel = crop.season === "winter" ? t.yield.winter : crop.season === "us" ? t.yield.usSeason : t.yield.summer;

  return (
    <div>
      <div className="fp-seg" role="tablist" aria-label={t.yield.tabsLabel} style={{ flexWrap: "wrap", marginBottom: 12 }}>
        {crops.map((c, i) => (
          <button key={c.crop_code} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}>
            {name(c)}
          </button>
        ))}
      </div>
      <div className="fp-grid fp-grid-2" role="tabpanel">
        <CompositeBars
          title={`${name(crop)}: ${t.yield.compositeTitle}`}
          sub={`${seasonLabel} · ${t.units["%"]}`}
          rows={crop.composite}
          unit="%"
          explainSubject={name(crop)}
          kind="yield"
        />
        <AnomalyTimeline
          title={t.yield.seriesTitle(name(crop))}
          sub={crop.pam_table ? t.yield.sourcePam(crop.pam_table) : t.yield.sourceNass}
          unit="%"
          points={crop.series.map((s) => ({
            year: s.crop_year,
            value: s.anomaly_pct,
            enso_class: s.enso_class,
            extra: [
              { label: crop.yield_unit ?? t.yield.kgha, value: fmt(s.yield_value, crop.yield_unit && crop.yield_unit !== "kg/ha" ? 1 : 0) },
              { label: t.yield.trend, value: fmt(s.trend_value, crop.yield_unit && crop.yield_unit !== "kg/ha" ? 1 : 0) },
            ],
          }))}
        />
      </div>
      {crop.season === "winter" && <p className="fp-note">{t.yield.winterNote}</p>}
      {crop.assumption && <AssumptionNotice>{t.assumption.text(t.assumption.cropSeason(name(crop), seasonLabel))}</AssumptionNotice>}
      {provenance && <Provenance>{provenance}</Provenance>}
    </div>
  );
}
