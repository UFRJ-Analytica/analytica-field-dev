import { useMemo, useState } from "react";
import type { Component, EnsoClass, MonthClimate, RotationResult, RotationsBlock, Weights } from "../api/types";
import { useI18n } from "../i18n";
import { COMPONENTS, rankRotations, type Ranked } from "../scoring";
import { AssumptionNotice, ENSO_COLOR, ENSO_ORDER, Provenance } from "./common";

const MONTHS = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
const LEVELS = [0, 1, 2, 3];

/** Crop identity colour (fixed per crop, never by rank); see --fp-crop-* in fieldphase.css. */
export const cropColor = (id: string) => `var(--fp-crop-${id.replace(/_/g, "-")}, var(--fp-muted))`;

/**
 * The rotation advisor: priority weights, ENSO class, and the ranked candidates with their
 * calendars, plain-language reasons and the full arithmetic behind each score.
 */
export function RotationPanel({ rotations, regionLabel }: { rotations: RotationsBlock; regionLabel?: string }) {
  const { t, locale } = useI18n();
  const cropName = (id: string) => (locale === "en" ? rotations.crops[id]?.name_en : rotations.crops[id]?.name_pt) ?? id;
  const available = ENSO_ORDER.filter((c) => rotations.by_class[c]?.length);
  const [cls, setCls] = useState<EnsoClass>(
    rotations.current_class && available.includes(rotations.current_class) ? rotations.current_class : available[0],
  );
  const [weights, setWeights] = useState<Weights>(() => ({
    soil: Math.min(3, rotations.default_weights.soil * 2),
    water: Math.min(3, rotations.default_weights.water * 2),
    income: Math.min(3, rotations.default_weights.income * 2),
  }));
  const ranked = useMemo(() => rankRotations(rotations.by_class[cls] ?? [], weights), [rotations, cls, weights]);
  const climate = rotations.climate_by_class[cls] ?? [];

  return (
    <div>
      <p className="fp-lead">{t.rotations.lead}</p>
      <div className="fp-card fp-rot-controls">
        <div>
          <div className="fp-tile-label">{t.rotations.priorities}</div>
          {COMPONENTS.map((c) => (
            <div key={c} className="fp-rot-weight">
              <span>{t.rotations.components[c]}</span>
              <div className="fp-seg" role="group" aria-label={t.rotations.components[c]}>
                {LEVELS.map((l) => (
                  <button key={l} type="button" aria-pressed={weights[c] === l} onClick={() => setWeights({ ...weights, [c]: l })}>
                    {t.rotations.levels[l]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="fp-tile-label">{t.rotations.enso}</div>
          <div className="fp-seg" role="group" aria-label={t.rotations.enso} style={{ flexWrap: "wrap" }}>
            {available.map((c) => (
              <button key={c} type="button" aria-pressed={cls === c} onClick={() => setCls(c)}>
                <span className="fp-dot" style={{ background: ENSO_COLOR[c], marginRight: 6 }} />
                {t.classes[c]}
                {c === rotations.current_class && rotations.current_class_is_forecast ? ` · ${t.rotations.forecastTag}` : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rotations.assumptions.map((a) => (
        <AssumptionNotice key={a.scope + a.region + (a.crop ?? "")}>
          {t.assumption.text(
            a.crop
              ? t.rotations.cropCalendarAssumption(cropName(a.crop), regionLabel ?? a.region)
              : t.rotations.calendarAssumption(regionLabel ?? a.region),
          )}
        </AssumptionNotice>
      ))}

      <ol className="fp-rot-list">
        {ranked.map((r) => (
          <RotationCard key={r.id} r={r} rotations={rotations} weights={weights} cls={cls} climate={climate} />
        ))}
      </ol>

      <ul className="fp-explain">
        <li>{t.rotations.notes.relative}</li>
        <li>{t.rotations.notes.water}</li>
        <li>{t.rotations.notes.income}</li>
        <li>{t.rotations.notes.kc}</li>
      </ul>
      <Provenance>
        {rotations.provenance.kc} · {rotations.provenance.climate} · {rotations.provenance.revenue}
      </Provenance>
    </div>
  );
}

function RotationCard({
  r,
  rotations,
  weights,
  cls,
  climate,
}: {
  r: Ranked;
  rotations: RotationsBlock;
  weights: Weights;
  cls: EnsoClass;
  climate: MonthClimate[];
}) {
  const { t, fmt, signed, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const cropName = (id: string) => (locale === "en" ? rotations.crops[id]?.name_en : rotations.crops[id]?.name_pt) ?? id;
  const monthName = (m: number) => t.rotations.monthNames[m - 1];
  const title = r.crops.map(cropName).join(" → ") + (r.crops.length === 1 ? ` → ${t.rotations.fallow}` : "");

  const raw: Record<Component, string> = {
    soil: r.soil.value == null ? "—" : r.soil.value === 0 ? t.rotations.soilCovered : t.rotations.soilValue(fmt(r.soil.value, 1)),
    water: r.water.value == null ? "—" : t.rotations.waterValue(fmt(r.water.value), fmt(r.water.stress_days ?? null)),
    income: r.income.value == null ? "—" : t.rotations.incomeValue(signed(r.income.value, "%", 1)),
  };

  const why = whyLines(r, t, fmt, signed, cropName, monthName, t.classes[cls]);
  const smallN = r.income.min_n_years != null && r.income.min_n_years < 3;

  return (
    <li className="fp-card fp-rot-card" data-unranked={r.myRank == null || undefined}>
      <div className="fp-rot-head">
        <span className="fp-rot-rank" aria-label={r.myRank != null ? `#${r.myRank}` : t.rotations.unranked}>
          {r.myRank != null ? `#${r.myRank}` : "—"}
        </span>
        <h3>{title}</h3>
        <span className="fp-rot-total">
          {r.myTotal != null ? fmt(r.myTotal) : "—"}
          <small>{t.rotations.total}</small>
        </span>
      </div>

      {r.myRank == null && (
        <p className="fp-caution" style={{ margin: "4px 0 8px", fontSize: 13 }}>
          {t.rotations.unranked}: {r.missing.map((c) => reasonText(r, c, t, cropName)).join("; ")}
        </p>
      )}

      <div className="fp-rot-bars">
        {COMPONENTS.map((c) => (
          <div key={c} className="fp-rot-bar" data-off={weights[c] === 0 || undefined}>
            <span className="fp-rot-bar-label">{t.rotations.components[c]}</span>
            <span className="fp-rot-bar-track" aria-hidden="true">
              {r[c].score != null && <span className="fp-rot-bar-fill" style={{ width: `${Math.max(r[c].score as number, 1.5)}%` }} />}
            </span>
            <span className="fp-rot-bar-score">{r[c].score != null ? fmt(r[c].score) : "—"}</span>
            <span className="fp-rot-bar-raw">{raw[c]}</span>
          </div>
        ))}
      </div>

      <CalendarStrip
        r={r}
        climate={climate}
        months={rotations.month_order ?? MONTHS}
        cropName={cropName}
        abbr={(id) => rotations.crops[id]?.abbr ?? cropName(id).slice(0, 2)}
      />

      <ul className="fp-explain">
        {why.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {smallN && <li className="fp-caution">{t.rotations.smallSample(r.income.min_n_years as number)}</li>}
      </ul>

      <button className="fp-link" type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ marginTop: 8 }}>
        {open ? t.rotations.hideCalc : t.rotations.showCalc}
      </button>
      {open && <Arithmetic r={r} weights={weights} raw={raw} />}
    </li>
  );
}

function CalendarStrip({
  r,
  climate,
  months,
  cropName,
  abbr,
}: {
  r: RotationResult;
  climate: MonthClimate[];
  months: number[];
  cropName: (id: string) => string;
  abbr: (id: string) => string;
}) {
  const { t, fmt } = useI18n();
  const heavy = new Map(climate.map((c) => [c.month, c.heavy_days]));
  const title = t.rotations.calendar(t.rotations.monthNames[months[0] - 1], t.rotations.monthNames[months[11] - 1]);
  return (
    <div className="fp-rot-cal" aria-label={title}>
      <div className="fp-tile-label">{title}</div>
      <div className="fp-rot-cal-grid">
        {months.map((m) => {
          const entries = r.calendar[String(m)] ?? [];
          const h = heavy.get(m);
          const label = entries.length
            ? entries.map((e) => `${cropName(e.crop)} (${e.stage})`).join(" + ")
            : `${t.rotations.bare}${h != null ? ` · ${t.rotations.heavyTitle(fmt(h, 1))}` : ""}`;
          return (
            <div key={m} className="fp-rot-cal-cell" title={`${t.rotations.monthNames[m - 1]}: ${label}`}>
              <div className="fp-rot-cal-fill" data-bare={!entries.length || undefined}>
                {entries.map((e) => (
                  <span key={e.crop} style={{ background: cropColor(e.crop), color: `var(--fp-crop-ink-${e.crop.replace(/_/g, "-")}, #fff)` }}>
                    {abbr(e.crop)}
                  </span>
                ))}
              </div>
              <div className="fp-rot-cal-month">{t.rotations.monthNames[m - 1].charAt(0).toUpperCase()}</div>
              {!entries.length && h != null && h >= 0.5 && <div className="fp-rot-cal-heavy">{fmt(h, 1)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Arithmetic({ r, weights, raw }: { r: Ranked; weights: Weights; raw: Record<Component, string> }) {
  const { t, fmt } = useI18n();
  const sumW = COMPONENTS.reduce((a, c) => a + (weights[c] > 0 ? weights[c] : 0), 0);
  const parts = COMPONENTS.filter((c) => weights[c] > 0).map(
    (c) => `${weights[c]}×${r[c].score != null ? fmt(r[c].score) : "?"}`,
  );
  return (
    <div className="fp-table-wrap">
      <table className="fp-table">
        <thead>
          <tr>
            <th scope="col">{t.rotations.calcComponent}</th>
            <th scope="col">{t.rotations.calcRaw}</th>
            <th scope="col" className="fp-num">{t.rotations.calcScore}</th>
            <th scope="col" className="fp-num">{t.rotations.calcWeight}</th>
            <th scope="col" className="fp-num">{t.rotations.calcContribution}</th>
          </tr>
        </thead>
        <tbody>
          {COMPONENTS.map((c) => (
            <tr key={c}>
              <td>{t.rotations.components[c]}</td>
              <td>{raw[c]}</td>
              <td className="fp-num">{r[c].score != null ? fmt(r[c].score) : "—"}</td>
              <td className="fp-num">{weights[c]}</td>
              <td className="fp-num">
                {r[c].score != null && sumW > 0 && weights[c] > 0 ? fmt((weights[c] * (r[c].score as number)) / sumW, 1) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fp-note">
        {t.rotations.calcFormula(`(${parts.join(" + ")}) / ${sumW}`, r.myTotal != null ? fmt(r.myTotal, 1) : "—")}
      </p>
    </div>
  );
}

type Fmt = (n: number | null | undefined, digits?: number) => string;
type Signed = (n: number | null | undefined, unit?: string, digits?: number) => string;

function whyLines(
  r: RotationResult,
  t: ReturnType<typeof useI18n>["t"],
  fmt: Fmt,
  signed: Signed,
  cropName: (id: string) => string,
  monthName: (m: number) => string,
  clsLabel: string,
): string[] {
  const out: string[] = [];
  if (r.soil.value != null) {
    const bare = r.soil.bare_months ?? [];
    out.push(
      bare.length
        ? t.rotations.soilWhy(bare.map(monthName).join(", "), fmt(r.soil.value, 1), clsLabel)
        : t.rotations.soilWhyCovered,
    );
  }
  if (r.water.value != null) {
    const worst = [...(r.water.by_month ?? [])].sort((a, b) => b.deficit_mm - a.deficit_mm)[0];
    const n = r.water.n_years ?? 0;
    out.push(
      r.water.value >= 1 && worst
        ? t.rotations.waterWhy(fmt(r.water.value), fmt(r.water.stress_days ?? null), monthName(worst.month),
            fmt(r.water.demand_mm ?? null), n)
        : t.rotations.waterWhyNone(fmt(r.water.demand_mm ?? null), n),
    );
    if (r.water.taw_mm) {
      out.push(t.rotations.soilStore(Object.entries(r.water.taw_mm).map(([c, v]) => `${cropName(c)} ${fmt(v)} mm`).join(", ")));
    }
  }
  const parts = r.income.items
    .map((i) =>
      i.cover_crop
        ? `${cropName(i.crop)}: ${t.rotations.coverCrop}`
        : i.yield_anomaly_pct != null
          ? t.rotations.incomePart(cropName(i.crop), signed(i.yield_anomaly_pct, "%", 1), i.n_years ?? 0)
          : `${cropName(i.crop)}: —`,
    )
    .join("; ");
  if (parts) out.push(t.rotations.incomeWhy(parts, clsLabel));
  return out;
}

function reasonText(r: RotationResult, c: Component, t: ReturnType<typeof useI18n>["t"], cropName: (id: string) => string): string {
  if (c === "income") {
    const missing = r.income.items.find((i) => !i.cover_crop && (i.yield_anomaly_pct == null || i.revenue_per_ha == null));
    if (missing) return t.rotations.reasonIncome(cropName(missing.crop));
  }
  return `${t.rotations.components[c]}: ${t.rotations.reasonOther}`;
}
