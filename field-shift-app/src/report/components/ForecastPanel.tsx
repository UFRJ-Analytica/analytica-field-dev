import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  ErrorBar,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ForecastBlock, ForecastDay, OutlookMonth } from "../api/types";
import { useI18n } from "../i18n";
import { CHART, ChartFrame, ENSO_COLOR, Legend, Provenance, StatTile, TooltipBox } from "./common";

const C = {
  forecast: "var(--fp-series-current)",
  recent: "var(--fp-series-baseline)",
  normal: "var(--fp-ink-2)",
  analog: ENSO_COLOR.el_nino_strong,
};

/** Meteomatics forecast for one municipality: headline tiles, daily rain, seasonal outlook. */
export function ForecastPanel({ forecast }: { forecast: ForecastBlock }) {
  const { t, date } = useI18n();
  const missing = forecast.products.filter((p) => p.status !== "ok");
  return (
    <div>
      {forecast.short_range && <ShortRange days={forecast.short_range.days} summary={forecast.short_range.summary} />}
      {forecast.season_outlook && forecast.season_outlook.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SeasonOutlookChart months={forecast.season_outlook} />
        </div>
      )}
      {missing.map((p) => (
        <p key={p.product} className="fp-note">
          {t.forecast.unavailable(t.forecast.products[p.product] ?? p.product, p.reason)}
        </p>
      ))}
      <Provenance>
        {forecast.provenance.forecast} · {forecast.provenance.normals}
        {forecast.issued_utc_day ? ` · ${t.forecast.issued(date(forecast.issued_utc_day))}` : ""}
      </Provenance>
    </div>
  );
}

function ShortRange({ days, summary }: { days: ForecastDay[]; summary: NonNullable<ForecastBlock["short_range"]>["summary"] }) {
  const { t, fmt, signed, date, locale } = useI18n();
  const dayFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const label = (iso: string) => dayFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
  const pct = summary.normal_rain_mm ? (100 * summary.rain_mm) / summary.normal_rain_mm : null;
  const smiEnd = summary.smi_15cm_end;
  return (
    <>
      <div className="fp-grid fp-grid-tiles">
        <StatTile
          label={t.forecast.next15(summary.days)}
          value={`${fmt(summary.rain_mm)} mm`}
          swatch={C.forecast}
          sub={`${pct != null ? `${fmt(pct)}% · ` : ""}${t.forecast.vsNormal(
            fmt(summary.normal_rain_mm),
            fmt(summary.normal_p10_mm),
            fmt(summary.normal_p90_mm),
          )}`}
        />
        <StatTile label={t.forecast.heavy} value={summary.heavy_days} sub={t.forecast.heavySub(summary.max_dry_spell_days)} />
        {summary.water_balance_mm != null && (
          <StatTile
            label={t.forecast.balance}
            value={signed(summary.water_balance_mm, " mm")}
            sub={t.forecast.balanceSub(fmt(summary.et0_mm))}
          />
        )}
        {smiEnd != null && (
          <StatTile
            label={t.forecast.soil}
            value={fmt(smiEnd, 2)}
            sub={`${t.forecast.soilSub(fmt(summary.smi_15cm_start, 2), fmt(smiEnd, 2))}${smiEnd > 1 ? ` · ${t.forecast.soilSaturated}` : ""}`}
          />
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartFrame
          title={t.forecast.daily}
          sub={`${t.forecast.dailySub} ${date(summary.start)} – ${date(summary.end)}`}
          legend={
            <Legend
              items={[
                { label: t.forecast.recent, color: C.recent },
                { label: t.forecast.forecastKind, color: C.forecast },
              ]}
            />
          }
          table={{
            columns: [
              { key: "date", label: t.preview.day },
              { key: "kind", label: "" },
              { key: "rain", label: "mm", numeric: true },
              { key: "prob", label: "%", numeric: true },
              { key: "tmax", label: "Tmax", numeric: true },
              { key: "et0", label: "ET0", numeric: true },
              { key: "smi", label: "SMI 15 cm", numeric: true },
            ],
            rows: days
              .filter((d) => d.rain != null)
              .map((d) => ({
                date: label(d.date),
                kind: d.kind === "recent" ? t.forecast.recent : t.forecast.forecastKind,
                rain: fmt(d.rain, 1),
                prob: fmt(d.rain_probability ?? null),
                tmax: fmt(d.tmax ?? null, 1),
                et0: fmt(d.et0 ?? null, 1),
                smi: fmt(d.smi_15cm ?? null, 2),
              })),
          }}
        >
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={days.filter((d) => d.rain != null)} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="date" tickFormatter={label} tickLine={false} axisLine={{ stroke: CHART.axis }} minTickGap={16} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} />
              <Tooltip
                cursor={{ fill: "var(--fp-surface-2)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as ForecastDay;
                  return (
                    <TooltipBox
                      title={`${label(d.date)} · ${d.kind === "recent" ? t.forecast.recent : t.forecast.forecastKind}`}
                      rows={[
                        { label: "mm", value: fmt(d.rain, 1), color: d.kind === "recent" ? C.recent : C.forecast },
                        ...(d.rain_probability != null ? [{ label: "%", value: fmt(d.rain_probability) }] : []),
                        ...(d.tmax != null ? [{ label: "Tmax / Tmin", value: `${fmt(d.tmax, 0)} / ${fmt(d.tmin ?? null, 0)} °C` }] : []),
                        ...(d.et0 != null ? [{ label: "ET0", value: `${fmt(d.et0, 1)} mm` }] : []),
                        ...(d.smi_15cm != null ? [{ label: "SMI 15 cm", value: fmt(d.smi_15cm, 2) }] : []),
                      ]}
                    />
                  );
                }}
              />
              <Bar dataKey="rain" maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {days
                  .filter((d) => d.rain != null)
                  .map((d) => (
                    <Cell key={d.date} fill={d.kind === "recent" ? C.recent : C.forecast} />
                  ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>
    </>
  );
}

/** Monthly totals: forecast median with its 10-90 % whisker, against normal and analog means. */
export function SeasonOutlookChart({ months }: { months: OutlookMonth[] }) {
  const { t, fmt, locale } = useI18n();
  // Compact "dez 26" / "Dec 26": fits five months side by side on a phone.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const label = (ym: string) =>
    `${monthFmt.format(new Date(`${ym}-01T00:00:00Z`)).replace(".", "")} ${ym.slice(2, 4)}`;
  const data = months.map((m) => ({
    ...m,
    label: label(m.month),
    err: [m.forecast_median_mm - m.forecast_p10_mm, m.forecast_p90_mm - m.forecast_median_mm],
  }));
  return (
    <ChartFrame
      title={t.forecast.outlook}
      sub={t.forecast.outlookSub}
      legend={
        <Legend
          items={[
            { label: t.forecast.median, color: C.forecast },
            { label: t.forecast.normal, color: C.normal },
            { label: t.forecast.analogMonth, color: C.analog },
          ]}
        />
      }
      table={{
        columns: [
          { key: "label", label: "" },
          { key: "fc", label: t.forecast.median, numeric: true },
          { key: "normal", label: t.forecast.normal, numeric: true },
          { key: "analog", label: t.forecast.analogMonth, numeric: true },
        ],
        rows: data.map((m) => ({
          label: m.label,
          fc: `${fmt(m.forecast_median_mm)} (${fmt(m.forecast_p10_mm)}–${fmt(m.forecast_p90_mm)})`,
          normal: `${fmt(m.normal_mm)} (${fmt(m.normal_p10_mm)}–${fmt(m.normal_p90_mm)})`,
          analog: `${fmt(m.analog_mm)} (n=${m.n_analog})`,
        })),
      }}
      foot={<p className="fp-note" style={{ margin: 0 }}>{t.forecast.outlookNote}</p>}
    >
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART.axis }} />
          <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} />
          <Tooltip
            cursor={{ fill: "var(--fp-surface-2)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const m = payload[0].payload as (typeof data)[number];
              return (
                <TooltipBox
                  title={m.label}
                  rows={[
                    { label: t.forecast.median, value: `${fmt(m.forecast_median_mm)} mm (${fmt(m.forecast_p10_mm)}–${fmt(m.forecast_p90_mm)})`, color: C.forecast },
                    { label: t.forecast.normal, value: `${fmt(m.normal_mm)} mm`, color: C.normal },
                    { label: `${t.forecast.analogMonth} (n=${m.n_analog})`, value: `${fmt(m.analog_mm)} mm`, color: C.analog },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="forecast_median_mm" fill={C.forecast} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <ErrorBar dataKey="err" width={8} strokeWidth={1.5} stroke="var(--fp-ink-2)" />
          </Bar>
          <Line dataKey="normal_mm" stroke="none" isAnimationActive={false}
            dot={{ r: 5, fill: C.normal, stroke: CHART.surface, strokeWidth: 2 }} activeDot={false} />
          <Line dataKey="analog_mm" stroke="none" isAnimationActive={false}
            dot={{ r: 5, fill: C.analog, stroke: CHART.surface, strokeWidth: 2 }} activeDot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
