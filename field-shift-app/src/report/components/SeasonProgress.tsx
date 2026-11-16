import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CropYearEnso, MunicipalityPayload } from "../api/types";
import { useI18n } from "../i18n";
import { CHART, ChartFrame, Legend, Provenance, TooltipBox } from "./common";

type Progress = MunicipalityPayload["season_progress"];

const COLORS = {
  current: "var(--fp-series-current)",
  baseline: "var(--fp-series-baseline)",
  band: "var(--fp-series-band)",
  analog: "var(--fp-series-analog)",
  forecastBand: "var(--fp-series-forecast-band)",
};

/** Headline numbers at the last observed day. Pure; exported for reuse and testing. */
export function progressSummary(p: Progress) {
  const last = [...p.days].reverse().find((d) => d.current_mm != null);
  if (!last || last.baseline_mean_mm == null) return null;
  return {
    date: last.date,
    current: last.current_mm as number,
    normal: last.baseline_mean_mm,
    pctOfNormal: (100 * (last.current_mm as number)) / last.baseline_mean_mm,
    analog: last.analog_mean_mm,
    p10: last.baseline_p10_mm,
    p90: last.baseline_p90_mm,
  };
}

export function SeasonProgressChart({
  progress,
  currentYear,
}: {
  progress: Progress;
  currentYear?: Partial<CropYearEnso>;
}) {
  const { t, fmt, date, locale } = useI18n();
  const summary = progressSummary(progress);
  const data = progress.days.map((d) => ({
    ...d,
    band: d.baseline_p10_mm != null && d.baseline_p90_mm != null ? [d.baseline_p10_mm, d.baseline_p90_mm] : null,
    forecastBand:
      d.forecast_p10_mm != null && d.forecast_p90_mm != null ? [d.forecast_p10_mm, d.forecast_p90_mm] : null,
  }));
  const lastForecast = [...data].reverse().find((d) => d.forecast_median_mm != null);
  const hasForecast = lastForecast != null && lastForecast.date !== progress.last_observed;
  const monthTicks = data.filter((d) => d.date.slice(8, 10) === "01").map((d) => d.day);
  const monthName = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const dayLabel = (day: number) => {
    const d = data[day];
    return d ? monthName.format(new Date(`${d.date}T00:00:00Z`)) : "";
  };
  const years = progress.analog_years.join(", ");

  return (
    <div>
      {summary && (
        <div style={{ marginBottom: 12 }}>
          <p className="fp-headline">
            {t.preview.headline(fmt(summary.current), `${fmt(summary.pctOfNormal)}%`, fmt(summary.normal))}
          </p>
          {summary.analog != null && (
            <p className="fp-lead" style={{ margin: 0 }}>
              {t.preview.analogLine(fmt(summary.analog), progress.n_analog, years)}
            </p>
          )}
          {hasForecast && lastForecast && (
            <p className="fp-lead" style={{ margin: "4px 0 0" }}>
              {t.forecast.curveLine(
                date(lastForecast.date),
                fmt(lastForecast.forecast_median_mm),
                fmt(lastForecast.forecast_p10_mm),
                fmt(lastForecast.forecast_p90_mm),
                fmt(lastForecast.baseline_mean_mm),
              )}
            </p>
          )}
          {currentYear?.forecast && currentYear.enso_class && (
            <p className="fp-note">
              {t.preview.forecastClass(
                t.classes[currentYear.enso_class],
                `${fmt(currentYear.forecast_probability_pct ?? null)}%`,
                currentYear.basis ?? "",
              )}
            </p>
          )}
        </div>
      )}
      <ChartFrame
        title={t.preview.title}
        sub={t.preview.sub(date(progress.start), date(progress.last_observed))}
        legend={
          <Legend
            items={[
              { label: t.preview.current, color: COLORS.current, kind: "line" },
              { label: `${t.preview.analog} (n=${progress.n_analog})`, color: COLORS.analog, kind: "line" },
              { label: `${t.preview.baseline} (n=${progress.n_baseline})`, color: COLORS.baseline, kind: "line" },
              { label: t.preview.band, color: COLORS.band, kind: "band" },
              ...(hasForecast
                ? [
                    { label: t.forecast.curve, color: COLORS.current, kind: "dash" as const },
                    { label: t.forecast.curveBand, color: COLORS.forecastBand, kind: "band" as const },
                  ]
                : []),
            ]}
          />
        }
        table={{
          columns: [
            { key: "date", label: t.preview.day },
            { key: "current", label: t.preview.current, numeric: true },
            { key: "analog", label: t.preview.analog, numeric: true },
            { key: "baseline", label: t.preview.baseline, numeric: true },
            { key: "band", label: t.preview.band, numeric: true },
            ...(hasForecast ? [{ key: "fc", label: t.forecast.curve, numeric: true }] : []),
          ],
          rows: data
            .filter((d) => d.day % 7 === 0 || d.date === progress.last_observed || d.date === lastForecast?.date)
            .map((d) => ({
              date: date(d.date),
              current: fmt(d.current_mm),
              analog: fmt(d.analog_mean_mm),
              baseline: fmt(d.baseline_mean_mm),
              band: `${fmt(d.baseline_p10_mm)}–${fmt(d.baseline_p90_mm)}`,
              fc:
                d.forecast_median_mm != null && d.current_mm == null
                  ? `${fmt(d.forecast_median_mm)} (${fmt(d.forecast_p10_mm)}–${fmt(d.forecast_p90_mm)})`
                  : "",
            })),
        }}
        foot={<Provenance>{t.preview.gridNote}</Provenance>}
      >
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis
              dataKey="day"
              type="number"
              domain={[0, data.length - 1]}
              ticks={monthTicks}
              tickFormatter={dayLabel}
              tickLine={false}
              axisLine={{ stroke: CHART.axis }}
            />
            <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={52} unit="" />
            <Tooltip
              cursor={{ stroke: CHART.axis }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof data)[number];
                return (
                  <TooltipBox
                    title={date(d.date)}
                    rows={[
                      ...(d.current_mm != null ? [{ label: t.preview.current, value: `${fmt(d.current_mm)} mm`, color: COLORS.current }] : []),
                      ...(d.current_mm == null && d.forecast_median_mm != null
                        ? [{
                            label: t.forecast.curve,
                            value: `${fmt(d.forecast_median_mm)} mm (${fmt(d.forecast_p10_mm)}–${fmt(d.forecast_p90_mm)})`,
                            color: COLORS.current,
                          }]
                        : []),
                      { label: t.preview.analog, value: `${fmt(d.analog_mean_mm)} mm`, color: COLORS.analog },
                      { label: t.preview.baseline, value: `${fmt(d.baseline_mean_mm)} mm`, color: COLORS.baseline },
                      { label: t.preview.band, value: `${fmt(d.baseline_p10_mm)}–${fmt(d.baseline_p90_mm)} mm` },
                    ]}
                  />
                );
              }}
            />
            <Area dataKey="band" stroke="none" fill={COLORS.band} isAnimationActive={false} activeDot={false} />
            {hasForecast && (
              <Area dataKey="forecastBand" stroke="none" fill={COLORS.forecastBand} isAnimationActive={false} activeDot={false} />
            )}
            <Line dataKey="baseline_mean_mm" stroke={COLORS.baseline} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="analog_mean_mm" stroke={COLORS.analog} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              dataKey="current_mm"
              stroke={COLORS.current}
              strokeWidth={2.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: CHART.surface, strokeWidth: 2 }}
            />
            {hasForecast && (
              <Line
                dataKey="forecast_median_mm"
                stroke={COLORS.current}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
