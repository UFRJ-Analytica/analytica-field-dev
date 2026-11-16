import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CompositeRow, EnsoClass } from "../api/types";
import { useI18n } from "../i18n";
import { CHART, ChartFrame, ENSO_COLOR, ENSO_ORDER, EnsoLegend, TooltipBox, yearsList } from "./common";

/** Fewer analog years than this get the small-sample caution under the chart. */
export const SMALL_SAMPLE = 3;

function unitSuffix(unit: string): string {
  return unit === "%" ? "%" : unit === "days" ? " d" : unit === "C" ? " °C" : "";
}

function digitsFor(unit: string): number {
  return unit === "0-1" ? 2 : unit === "C" ? 1 : 0;
}

/**
 * Mean anomaly for each ENSO class, as a diverging bar list around a zero line.
 *
 * Plain HTML rather than an SVG chart: four rows of label | bar | value reflow cleanly at any
 * width (the label moves above its bar on phones), so labels never collide or clip. Every row
 * carries its value and n; a class with no years says so instead of disappearing. Hover or focus
 * a row for the years behind it.
 */
export function CompositeBars({
  title,
  sub,
  rows,
  unit,
  explainSubject,
  kind = "climate",
}: {
  title: string;
  sub?: string;
  rows: CompositeRow[];
  unit: string;
  /** Name used in the plain-language sentence (metric or crop). */
  explainSubject: string;
  kind?: "climate" | "yield";
}) {
  const { t, signed } = useI18n();
  const [hover, setHover] = useState<EnsoClass | null>(null);
  const suffix = unitSuffix(unit);
  const digits = digitsFor(unit);
  const data = ENSO_ORDER.map((c) => {
    const r = rows.find((x) => x.enso_class === c);
    return { cls: c, label: t.classes[c], mean: r?.mean ?? null, n: r?.n ?? 0, years: r?.years ?? "" };
  });
  const extent = Math.max(1e-9, ...data.map((d) => Math.abs(d.mean ?? 0)));

  const strong = data.find((d) => d.cls === "el_nino_strong");
  const sentence =
    strong && strong.n > 0 && strong.mean != null
      ? (kind === "yield" ? t.explain.yield : t.explain.climate)(
          explainSubject,
          t.classes.el_nino_strong,
          strong.n,
          signed(strong.mean, suffix, digits),
          yearsList(strong.years),
        )
      : t.explain.noYears(t.classes.el_nino_strong);
  const focused = data.find((d) => d.cls === hover);

  return (
    <ChartFrame
      title={title}
      sub={sub}
      table={{
        columns: [
          { key: "label", label: t.chart.class },
          { key: "mean", label: t.chart.value, numeric: true },
          { key: "n", label: t.chart.n, numeric: true },
          { key: "years", label: t.chart.years },
        ],
        rows: data.map((d) => ({ label: d.label, mean: signed(d.mean, suffix, digits), n: d.n, years: yearsList(d.years) })),
      }}
      foot={
        <ul className="fp-explain">
          <li>{sentence}</li>
          {strong && strong.n > 0 && strong.n < SMALL_SAMPLE && <li className="fp-caution">{t.explain.smallSample(strong.n)}</li>}
        </ul>
      }
    >
      <div className="fp-dbars" onMouseLeave={() => setHover(null)}>
        {data.map((d) => {
          const share = d.mean == null ? 0 : (Math.abs(d.mean) / extent) * 50;
          const neg = (d.mean ?? 0) < 0;
          return (
            <div
              key={d.cls}
              className="fp-dbar"
              tabIndex={0}
              aria-label={`${d.label}: ${signed(d.mean, suffix, digits)}, n=${d.n}${d.years ? `, ${yearsList(d.years)}` : ""}`}
              onMouseEnter={() => setHover(d.cls)}
              onFocus={() => setHover(d.cls)}
              onBlur={() => setHover(null)}
              data-active={hover === d.cls || undefined}
            >
              <span className="fp-dbar-label">{d.label}</span>
              <span className="fp-dbar-track">
                <span className="fp-dbar-zero" />
                {d.mean != null && share > 0 && (
                  <span
                    className="fp-dbar-fill"
                    data-neg={neg || undefined}
                    style={{
                      background: ENSO_COLOR[d.cls],
                      width: `${Math.max(share, 0.8)}%`,
                      [neg ? "right" : "left"]: "50%",
                    }}
                  />
                )}
              </span>
              <span className="fp-dbar-value">
                {d.n === 0 ? "—" : signed(d.mean, suffix, digits)}
                <small> n={d.n}</small>
              </span>
            </div>
          );
        })}
        <div className="fp-dbar-axis" aria-hidden="true">
          <span />
          <span className="fp-dbar-ticks">
            <span>{signed(-extent, suffix, digits)}</span>
            <span>0</span>
            <span>{signed(extent, suffix, digits)}</span>
          </span>
          <span />
        </div>
      </div>
      <p className="fp-note" aria-live="polite" style={{ minHeight: "1.4em" }}>
        {focused ? `${focused.label} · ${t.chart.years}: ${yearsList(focused.years) || "—"}` : "\u00a0"}
      </p>
    </ChartFrame>
  );
}

export interface TimelinePoint {
  year: number;
  value: number | null;
  enso_class: EnsoClass | null;
  /** Optional extra tooltip rows, e.g. raw yield and trend. */
  extra?: { label: string; value: string }[];
}

/** One column per crop year, coloured by that year's ENSO class, from a zero baseline. */
export function AnomalyTimeline({
  title,
  sub,
  points,
  unit,
  yearLabel,
}: {
  title: string;
  sub?: string;
  points: TimelinePoint[];
  unit: string;
  yearLabel?: string;
}) {
  const { t, signed } = useI18n();
  const suffix = unitSuffix(unit);
  const digits = digitsFor(unit);
  const data = points.filter((p) => p.value != null);
  const present = ENSO_ORDER.filter((c) => data.some((d) => d.enso_class === c));
  return (
    <ChartFrame
      title={title}
      sub={sub}
      legend={<EnsoLegend classes={present} />}
      table={{
        columns: [
          { key: "year", label: yearLabel ?? t.chart.year },
          { key: "cls", label: t.chart.class },
          { key: "value", label: t.chart.value, numeric: true },
        ],
        rows: [...data].reverse().map((d) => ({
          year: d.year,
          cls: d.enso_class ? t.classes[d.enso_class] : "—",
          value: signed(d.value, suffix, digits),
        })),
      }}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="year" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => signed(v, suffix, digits)} width={56} />
          <ReferenceLine y={0} stroke={CHART.axis} />
          <Tooltip
            cursor={{ fill: "var(--fp-surface-2)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as TimelinePoint;
              return (
                <TooltipBox
                  title={`${yearLabel ?? t.chart.year} ${d.year}`}
                  rows={[
                    {
                      label: d.enso_class ? t.classes[d.enso_class] : "—",
                      value: signed(d.value, suffix, digits),
                      color: d.enso_class ? ENSO_COLOR[d.enso_class] : undefined,
                    },
                    ...(d.extra ?? []),
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="value" maxBarSize={14} isAnimationActive={false} radius={[3, 3, 3, 3]}>
            {data.map((d) => (
              <Cell key={d.year} fill={d.enso_class ? ENSO_COLOR[d.enso_class] : CHART.axis} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
