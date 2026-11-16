/**
 * Small building blocks shared by every chart: colours, frame + table view, legend, tooltip,
 * stat tile, and the two mandatory notices (assumption warning, mock banner).
 */

import { useState, type ReactNode } from "react";
import type { EnsoClass } from "../api/types";
import { useI18n } from "../i18n";

export const ENSO_ORDER: EnsoClass[] = ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"];

/** CSS variable per ENSO class; resolved per light/dark theme in fieldphase.css. */
export const ENSO_COLOR: Record<EnsoClass, string> = {
  el_nino_strong: "var(--fp-enso-el-nino-strong)",
  el_nino_moderate: "var(--fp-enso-el-nino-moderate)",
  neutral: "var(--fp-enso-neutral)",
  la_nina: "var(--fp-enso-la-nina)",
};

export const CHART = {
  grid: "var(--fp-grid)",
  axis: "var(--fp-axis)",
  muted: "var(--fp-muted)",
  surface: "var(--fp-surface)",
  font: 12,
};

export interface TableSpec {
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, ReactNode>[];
}

/** Card with title, subtitle, optional legend, the chart, and a toggleable data table. */
export function ChartFrame({
  title,
  sub,
  legend,
  table,
  foot,
  children,
}: {
  title: string;
  sub?: ReactNode;
  legend?: ReactNode;
  table?: TableSpec;
  foot?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <figure className="fp-card" style={{ margin: 0 }}>
      <h3>{title}</h3>
      {sub && <p className="fp-sub">{sub}</p>}
      {legend}
      <div className="fp-chart">{children}</div>
      <div className="fp-chart-foot">
        <div>{foot}</div>
        {table && (
          <button className="fp-link" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t.chart.hideTable : t.chart.showTable}
          </button>
        )}
      </div>
      {table && open && (
        <div className="fp-table-wrap">
          <table className="fp-table">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} className={c.numeric ? "fp-num" : undefined} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {table.columns.map((c) => (
                    <td key={c.key} className={c.numeric ? "fp-num" : undefined}>
                      {r[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

export type LegendItem = { label: string; color: string; kind?: "dot" | "line" | "dash" | "band" };

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="fp-legend">
      {items.map((it) => (
        <li key={it.label}>
          {it.kind === "line" ? (
            <span className="fp-key-line" style={{ background: it.color }} />
          ) : it.kind === "dash" ? (
            <span
              className="fp-key-line"
              style={{ background: `repeating-linear-gradient(90deg, ${it.color} 0 5px, transparent 5px 8px)` }}
            />
          ) : it.kind === "band" ? (
            <span className="fp-key-band" style={{ background: it.color }} />
          ) : (
            <span className="fp-dot" style={{ background: it.color }} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export function EnsoLegend({ classes = ENSO_ORDER }: { classes?: EnsoClass[] }) {
  const { t } = useI18n();
  return <Legend items={classes.map((c) => ({ label: t.classes[c], color: ENSO_COLOR[c] }))} />;
}

/** Tooltip body used by every Recharts chart in the kit. */
export function TooltipBox({
  title,
  rows,
}: {
  title: ReactNode;
  rows: { label: ReactNode; value: ReactNode; color?: string }[];
}) {
  return (
    <div className="fp-tooltip">
      <div className="fp-tooltip-title">{title}</div>
      {rows.map((r, i) => (
        <div className="fp-tooltip-row" key={i}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {r.color && <span className="fp-dot" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function StatTile({ label, value, sub, swatch }: { label: string; value: ReactNode; sub?: ReactNode; swatch?: string }) {
  return (
    <div className="fp-card">
      <div className="fp-tile-label">{label}</div>
      <div className="fp-tile-value" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {swatch && <span className="fp-dot" style={{ background: swatch, width: 12, height: 12 }} />}
        {value}
      </div>
      {sub && <div className="fp-tile-sub">{sub}</div>}
    </div>
  );
}

function WarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Project rule 3: anything sourced as "suposicao" is shown with this warning, always. */
export function AssumptionNotice({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="fp-notice" role="note">
      <WarnIcon />
      <div>
        <strong>{t.assumption.badge}.</strong> {children}
      </div>
    </div>
  );
}

/** Project rule 2: mock data is labelled visibly. Rendered whenever meta.mock is true. */
export function MockBanner() {
  const { t } = useI18n();
  return (
    <div className="fp-mock" role="alert">
      {t.app.mock}
    </div>
  );
}

export function Provenance({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <p className="fp-note">
      {t.provenance}: {children}
    </p>
  );
}

/** Format the comma-separated year list from a composite row, e.g. "1983, 1992, 1998". */
export function yearsList(years: string): string {
  return years
    .split(",")
    .filter(Boolean)
    .join(", ");
}
