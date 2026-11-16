import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EnsoPayload, OutlookRow } from "../api/types";
import { useI18n } from "../i18n";
import { CHART, ChartFrame, ENSO_COLOR, EnsoLegend, Provenance, StatTile, TooltipBox } from "./common";

/** Current state: alert, official index, weekly reading, NOAA's own words. */
export function EnsoStatus({ enso }: { enso: EnsoPayload }) {
  const { t, signed, date } = useI18n();
  const c = enso.current;
  const strong = c.roni.strength === "strong" || c.roni.strength === "very_strong";
  return (
    <div>
      <div className="fp-grid fp-grid-tiles">
        <StatTile
          label={t.enso.alert}
          value={c.discussion.alert_status}
          sub={`${t.enso.issued(date(c.discussion.issued))}${c.discussion.next_issue ? ` · ${t.enso.next(date(c.discussion.next_issue))}` : ""}`}
        />
        <StatTile
          label={t.enso.roni}
          value={signed(c.roni.value, " °C", 2)}
          swatch={c.roni.phase === "el_nino" ? ENSO_COLOR[strong ? "el_nino_strong" : "el_nino_moderate"] : undefined}
          sub={`${t.enso.roniSub(c.roni.season)} · ${t.strength[c.roni.strength]}`}
        />
        <StatTile
          label={t.enso.weekly}
          value={signed(c.weekly_nino34.anomaly, " °C", 1)}
          sub={t.enso.weeklySub(date(c.weekly_nino34.week))}
        />
      </div>
      <blockquote className="fp-quote" lang="en">
        <small>{t.enso.synopsisLabel}</small>
        {c.discussion.synopsis}
      </blockquote>
      <p className="fp-note">{t.enso.oni(signed(c.oni.value, " °C", 2), c.oni.season)}</p>
      <Provenance>
        <a href={c.discussion.source_url} target="_blank" rel="noreferrer">
          NOAA CPC ENSO Diagnostic Discussion
        </a>
        {" · "}
        {enso.provenance.index}
      </Provenance>
    </div>
  );
}

type OutlookDatum = { season: string; la_nina: number; neutral: number; el_nino_moderate: number; el_nino_strong: number };

function outlookData(rows: OutlookRow[]): OutlookDatum[] {
  return rows.map((r) => ({
    season: r.season,
    la_nina: r.p_la_nina,
    neutral: r.p_neutral,
    el_nino_moderate: r["p_p0.5_p1.0"] + r["p_p1.0_p1.5"],
    el_nino_strong: r["p_p1.5_p2.0"] + r["p_ge_p2.0"],
  }));
}

/** CPC strength probabilities for the next seasons, folded into the four ENSO classes. */
export function EnsoOutlookChart({ outlook }: { outlook: OutlookRow[] }) {
  const { t } = useI18n();
  const data = outlookData(outlook);
  const stack = ["la_nina", "neutral", "el_nino_moderate", "el_nino_strong"] as const;
  return (
    <ChartFrame
      title={t.enso.outlookTitle}
      sub={t.enso.outlookSub(outlook[0]?.issued ?? "")}
      legend={<EnsoLegend />}
      table={{
        columns: [
          { key: "season", label: t.chart.season },
          ...[...stack].reverse().map((k) => ({ key: k, label: t.classes[k], numeric: true })),
        ],
        rows: data.map((d) => ({ ...d, ...Object.fromEntries(stack.map((k) => [k, `${d[k]}%`])) })),
      }}
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="season" tickLine={false} axisLine={{ stroke: CHART.axis }} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "var(--fp-surface-2)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={label}
                  rows={[...stack].reverse().map((k) => ({
                    label: t.classes[k],
                    value: `${(payload[0].payload as OutlookDatum)[k]}%`,
                    color: ENSO_COLOR[k],
                  }))}
                />
              ) : null
            }
          />
          {stack.map((k) => (
            <Bar key={k} dataKey={k} stackId="p" fill={ENSO_COLOR[k]} stroke={CHART.surface} strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** RONI history: one series, so no legend; the reference lines carry the thresholds. */
export function RoniHistoryChart({ enso }: { enso: EnsoPayload }) {
  const { t, signed } = useI18n();
  const data = enso.history
    .filter((h) => h.roni != null)
    .map((h) => ({ x: h.year + (h.center_month - 1) / 12, roni: h.roni, label: `${h.season} ${h.year}` }));
  const recent = data.slice(-60);
  return (
    <ChartFrame
      title={t.enso.historyTitle}
      sub={t.enso.historySub}
      table={{
        columns: [
          { key: "label", label: t.chart.season },
          { key: "roni", label: "RONI", numeric: true },
        ],
        rows: recent.reverse().map((d) => ({ label: d.label, roni: signed(d.roni, " °C", 2) })),
      }}
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            ticks={[1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020]}
            tickFormatter={(v) => String(Math.round(v))}
            tickLine={false}
            axisLine={{ stroke: CHART.axis }}
          />
          <YAxis domain={[-3, 3]} ticks={[-2, -1, 0, 1, 2]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
          <ReferenceLine y={0.5} stroke={ENSO_COLOR.el_nino_moderate} strokeWidth={1} />
          <ReferenceLine y={-0.5} stroke={ENSO_COLOR.la_nina} strokeWidth={1} />
          <ReferenceLine
            y={2.5}
            stroke={ENSO_COLOR.el_nino_strong}
            strokeWidth={1}
            label={{ value: t.enso.historic, position: "insideTopLeft", fontSize: 12 }}
          />
          <Tooltip
            cursor={{ stroke: CHART.axis }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={(payload[0].payload as { label: string }).label}
                  rows={[{ label: "RONI", value: signed(payload[0].value as number, " °C", 2) }]}
                />
              ) : null
            }
          />
          <Line dataKey="roni" stroke="var(--fp-ink-2)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
