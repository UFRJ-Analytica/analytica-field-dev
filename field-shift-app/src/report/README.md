# Field Phase — web interface

React 18 + Vite + TypeScript, Recharts for charts, MapLibre GL for the map. Strings are Brazilian
Portuguese by default with an English switch (for the pitch).

```
web/src/
  fieldphase/          ← the portable UI kit: copy this folder to reuse it
    api/types.ts         the JSON data contract (v1), mirrors api/repository.py
    api/client.ts        loader for static JSON or the live API
    i18n/                every UI string, pt-BR + en, and number/date formatting
    theme/fieldphase.css all styles, scoped under .fp-root, light + dark
    components/          charts and panels; they take data as props and never fetch
    index.ts             public exports
  app/                 the Field Phase page: composes the kit, owns state and loading
  main.tsx
```

## Run it

Data first (from the repository root), then the web app:

```bash
uv run python -m pipeline.fetch_regions
uv run python -m pipeline.fetch_enso
uv run python -m pipeline.fetch_power
uv run python -m pipeline.fetch_pam
uv run python -m pipeline.build_evidence
uv run python -m api.export
```

```bash
cd web && npm install && npm run dev
```

`api.export` writes the API's responses as JSON files into `web/public/data/v1/`, and the app
reads them from there (the default, `VITE_DATA_MODE=static`). No Python server is needed to view
the page, and `npm run build` produces a `dist/` folder you can host anywhere (GitHub Pages,
Netlify, a USB stick), because every path is relative.

To use the live API instead, start it and switch the mode:

```bash
uv run uvicorn api.main:app --reload
```

```bash
cd web && VITE_DATA_MODE=api npm run dev
```

Configuration lives in `.env` (copy `.env.example`): data mode, data base URL, and the basemap
tile server.

## Reusing the kit in another project

The kit was built so other Space Apps teams can use it. Two ways:

### A. Same data, different page

Point the kit at Field Phase's data (static JSON or the API) and compose your own layout:

```tsx
import "./fieldphase/theme/fieldphase.css";
import { I18nProvider, createClient, useLoad, EnsoStatus, EnsoOutlookChart } from "./fieldphase";

const client = createClient({ mode: "static", baseUrl: "https://your-host/field-phase" });

export function MyPage() {
  const enso = useLoad(client.enso, "enso");
  return (
    <div className="fp-root">
      <I18nProvider locale="en">
        {enso.status === "ready" && (
          <>
            <EnsoStatus enso={enso.data} />
            <EnsoOutlookChart outlook={enso.data.outlook} />
          </>
        )}
      </I18nProvider>
    </div>
  );
}
```

Dependencies to add: `react@18`, `react-dom@18`, `recharts@2.15`, `maplibre-gl@4.7` (only if you
use the map).

### B. Your own data, same components

Every component takes plain props typed in `api/types.ts`. Produce JSON in that shape and the
components render it. The most generic pieces:

| Component | Feed it | Good for |
|---|---|---|
| `CompositeBars` | `{enso_class, n, mean, years}` × 4 | any "average under each ENSO phase" comparison |
| `AnomalyTimeline` | `{year, value, enso_class}[]` | any yearly anomaly series coloured by ENSO |
| `SeasonProgressChart` | daily cumulative current / mean / p10–p90 / analog | any "this season vs normal" view |
| `EnsoStatus`, `EnsoOutlookChart`, `RoniHistoryChart` | `/enso` payload | the current ENSO state, as-is |
| `MunicipalityMap` | a GeoJSON FeatureCollection + list | point-and-pick maps |
| `ForecastPanel`, `SeasonOutlookChart` | `forecast` block (Meteomatics) | 15-day tiles and daily rain; monthly median + 10–90 % vs normal |
| `RotationPanel` (+ `rankRotations`, `weightedTotal`) | `rotations` block | the advisor: weights, ENSO switch, ranked cards, calendar, arithmetic |
| `VegetationPanel`, `TerrainBars`, `LandCoverTile` | `vegetation` / `terrain` / `land_cover` blocks (Planetary Computer) | NDVI vs normal band; relief-class segmented bars; cropland share |
| `ChartFrame`, `StatTile`, `Legend`, `TooltipBox` | anything | consistent cards around your own charts |
| `AssumptionNotice`, `MockBanner` | — | honest labelling of assumptions and mock data |

To translate or reword, edit `i18n/strings.ts`: add a locale object with the same keys, and
TypeScript will list every string you missed.

To re-theme, override the `--fp-*` variables on `.fp-root`. If you change the four
`--fp-enso-*` colours, re-validate them for colour-blind separation; the current set was checked
in both light and dark mode.

## Design rules the kit enforces

- **No mock data without a label.** If `meta.mock` is true, a red "mock" banner is pinned to the
  top of the page.
- **Assumptions are visible.** Any crop whose config entry has `source: suposicao` shows a warning
  next to its numbers.
- **Every comparison shows its n and its years.** A strong El Niño average built from two years
  carries an explicit small-sample caution.
- **Every chart has a table view** ("Ver tabela"), so no number depends on telling colours apart.
- **The UI never invents wording for data.** Explanations are templates in `strings.ts` filled
  with values from the payload.
