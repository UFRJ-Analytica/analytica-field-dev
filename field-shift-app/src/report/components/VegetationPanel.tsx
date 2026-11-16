import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LandCoverBlock, ReliefClass, TerrainBlock, VegetationBlock } from "../api/types";
import { useI18n } from "../i18n";
import { CHART, ChartFrame, Legend, Provenance, StatTile, TooltipBox } from "./common";
import { AnomalyTimeline, CompositeBars } from "./Evidence";

const C = {
  current: "var(--fp-series-current)",
  baseline: "var(--fp-series-baseline)",
  band: "var(--fp-series-band)",
  analog: "var(--fp-series-analog)",
};

export const RELIEF_ORDER: ReliefClass[] = ["plano", "suave_ondulado", "ondulado", "forte_ondulado", "montanhoso", "escarpado"];
/** Ordinal ramp, one hue (defined per theme in fieldphase.css). */
const RELIEF_COLOR = (i: number) => `var(--fp-ordinal-${i + 1})`;

/** NDVI of the stable cropland: this season vs normal, analogs, and the peak-season evidence. */
export function VegetationPanel({ vegetation }: { vegetation: VegetationBlock }) {
  const { t, fmt, date, locale } = useI18n();
  const base = vegetation.baseline_crop_years ?? "";
  const data = vegetation.progress.map((s) => ({
    ...s,
    band: s.baseline_p10 != null && s.baseline_p90 != null ? [s.baseline_p10, s.baseline_p90] : null,
  }));
  const monthLabel = (mmdd: string) => {
    const m = Number(mmdd.slice(0, 2));
    return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2001, m - 1, 1)));
  };
  const firstOfMonth = new Set<number>();
  const seen = new Set<string>();
  data.forEach((d) => {
    const m = d.label_date.slice(0, 2);
    if (!seen.has(m)) {
      seen.add(m);
      firstOfMonth.add(d.slot);
    }
  });
  const nAnalog = Math.max(0, ...data.map((d) => d.n_analog));
  // "Weak" is judged against the data itself: the strong-El-Nino mean sits inside one standard
  // deviation of the ordinary year-to-year variation of the same anomaly.
  const strong = vegetation.composite.find((c) => c.enso_class === "el_nino_strong");
  const anoms = vegetation.seasons.map((s) => s.ndvi_peak_anom_pct).filter((v): v is number => v != null);
  const mean = anoms.reduce((a, v) => a + v, 0) / Math.max(anoms.length, 1);
  const sd = Math.sqrt(anoms.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(anoms.length - 1, 1));
  const weak = strong == null || strong.mean == null || Math.abs(strong.mean) < sd;

  return (
    <div>
      <ChartFrame
        title={t.vegetation.ndviTitle}
        sub={t.vegetation.ndviSub(base, date(vegetation.last_composite))}
        legend={
          <Legend
            items={[
              { label: t.vegetation.current, color: C.current, kind: "line" },
              { label: `${t.vegetation.analog} (n=${nAnalog})`, color: C.analog, kind: "line" },
              { label: t.vegetation.baseline(base), color: C.baseline, kind: "line" },
              { label: t.vegetation.band, color: C.band, kind: "band" },
            ]}
          />
        }
        table={{
          columns: [
            { key: "d", label: t.preview.day },
            { key: "cur", label: t.vegetation.current, numeric: true },
            { key: "ana", label: t.vegetation.analog, numeric: true },
            { key: "base", label: t.vegetation.baseline(base), numeric: true },
            { key: "band", label: t.vegetation.band, numeric: true },
          ],
          rows: data.map((d) => ({
            d: d.label_date,
            cur: fmt(d.current, 2),
            ana: fmt(d.analog_mean, 2),
            base: fmt(d.baseline_mean, 2),
            band: `${fmt(d.baseline_p10, 2)}–${fmt(d.baseline_p90, 2)}`,
          })),
        }}
      >
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis
              dataKey="slot"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={[...firstOfMonth]}
              tickFormatter={(slot) => monthLabel(data.find((d) => d.slot === slot)?.label_date ?? "01-01")}
              tickLine={false}
              axisLine={{ stroke: CHART.axis }}
            />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v, 2)} />
            <Tooltip
              cursor={{ stroke: CHART.axis }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof data)[number];
                return (
                  <TooltipBox
                    title={d.current_date ? date(d.current_date) : d.label_date}
                    rows={[
                      ...(d.current != null ? [{ label: t.vegetation.current, value: fmt(d.current, 2), color: C.current }] : []),
                      { label: t.vegetation.analog, value: fmt(d.analog_mean, 2), color: C.analog },
                      { label: t.vegetation.baseline(base), value: fmt(d.baseline_mean, 2), color: C.baseline },
                    ]}
                  />
                );
              }}
            />
            <Area dataKey="band" stroke="none" fill={C.band} isAnimationActive={false} activeDot={false} />
            <Line dataKey="baseline_mean" stroke={C.baseline} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="analog_mean" stroke={C.analog} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="current" stroke={C.current} strokeWidth={2.5} isAnimationActive={false}
              dot={{ r: 4, fill: C.current, stroke: CHART.surface, strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>

      <div className="fp-grid fp-grid-2" style={{ marginTop: 16 }}>
        <CompositeBars
          title={t.vegetation.peakTitle}
          sub={t.vegetation.peakSub(base)}
          rows={vegetation.composite}
          unit="%"
          explainSubject={t.vegetation.peakTitle}
        />
        <AnomalyTimeline
          title={t.vegetation.peakTimeline}
          sub={t.vegetation.peakSub(base)}
          unit="%"
          points={vegetation.seasons.map((s) => ({
            year: s.crop_year,
            value: s.ndvi_peak_anom_pct,
            enso_class: s.enso_class,
            extra: [{ label: "NDVI", value: fmt(s.ndvi_peak, 2) }],
          }))}
        />
      </div>
      {weak && <p className="fp-lead" style={{ marginTop: 12 }}>{t.vegetation.weakSignal}</p>}
      <Provenance>
        {vegetation.provenance.source} · {vegetation.provenance.mask}
      </Provenance>
    </div>
  );
}

/** Cropland share over the land-cover record, as a headline tile. */
export function LandCoverTile({ landCover }: { landCover: LandCoverBlock }) {
  const { t, fmt } = useI18n();
  const ys = landCover.years;
  if (!ys.length) return null;
  const first = ys[0];
  const last = ys[ys.length - 1];
  return (
    <StatTile
      label={`${t.vegetation.landTitle} ${t.vegetation.share(last.year)}`}
      value={`${fmt(100 * last.cropland_share)}%`}
      sub={`${fmt(last.cropland_km2)} km² · ${first.year}: ${fmt(100 * first.cropland_share)}% · ${t.vegetation.landSub}`}
    />
  );
}

/** Relief classes as tall segmented bars (one whole per scope), with the erosion headline. */
export function TerrainBars({ terrain }: { terrain: TerrainBlock }) {
  const { t, fmt } = useI18n();
  const [hover, setHover] = useState<string | null>(null);
  const scopes = (["municipality", "cropland"] as const).filter((s) => terrain.by_scope[s]);
  const crop = terrain.by_scope.cropland;
  const steep = crop
    ? crop.classes.filter((c) => RELIEF_ORDER.indexOf(c.relief_class) >= 2).reduce((a, c) => a + c.share, 0)
    : null;
  return (
    <ChartFrame
      title={t.vegetation.terrainTitle}
      sub={t.vegetation.terrainSub}
      legend={<Legend items={RELIEF_ORDER.map((r, i) => ({ label: t.vegetation.relief[r], color: RELIEF_COLOR(i) }))} />}
      table={{
        columns: [
          { key: "cls", label: "" },
          ...scopes.map((s) => ({ key: s, label: t.vegetation.scope[s], numeric: true })),
        ],
        rows: RELIEF_ORDER.map((r) => ({
          cls: t.vegetation.relief[r],
          ...Object.fromEntries(
            scopes.map((s) => [s, `${fmt(100 * (terrain.by_scope[s].classes.find((c) => c.relief_class === r)?.share ?? 0), 1)}%`]),
          ),
        })),
      }}
      foot={
        <>
          {steep != null && <p className="fp-explain" style={{ margin: 0 }}>{t.vegetation.erosionLine(`${fmt(100 * steep)}%`)}</p>}
          <Provenance>{terrain.provenance.source}</Provenance>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12 }}>
        {scopes.map((s) => {
          const g = terrain.by_scope[s];
          return (
            <div key={s}>
              <div className="fp-tile-label" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{t.vegetation.scope[s]}</span>
                <span>{t.vegetation.medianSlope(fmt(g.median_slope_pct, 1))}</span>
              </div>
              <div className="fp-segbar" role="img"
                aria-label={`${t.vegetation.scope[s]}: ${RELIEF_ORDER.map((r) => `${t.vegetation.relief[r]} ${fmt(100 * (g.classes.find((c) => c.relief_class === r)?.share ?? 0))}%`).join(", ")}`}>
                {RELIEF_ORDER.map((r, i) => {
                  const share = g.classes.find((c) => c.relief_class === r)?.share ?? 0;
                  if (share <= 0.0005) return null;
                  const key = `${s}-${r}`;
                  return (
                    <span
                      key={r}
                      className="fp-segbar-part"
                      style={{ width: `${100 * share}%`, background: RELIEF_COLOR(i), color: i >= 2 ? "#fff" : "#0b0b0b" }}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover(null)}
                      title={`${t.vegetation.relief[r]}: ${fmt(100 * share, 1)}%`}
                      data-active={hover === key || undefined}
                    >
                      {share >= 0.1 ? `${fmt(100 * share)}%` : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}
