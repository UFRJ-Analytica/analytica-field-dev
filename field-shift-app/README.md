# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

## Running the app

    npm install
    npm run dev        # http://localhost:5173
    npm run build      # tsc, then the bundle, then the polygon tiers into dist/
    npm run preview

The backend is the FastAPI app in `backend/`:

    backend/.venv/bin/python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000

### Where the backend lives

The frontend reads `VITE_API_BASE_URL` (see `.env.example`), baked in at build time, and falls back
to `http://localhost:8000`. The value is defined once in `src/lib/api-base.ts` and imported
everywhere else, so a deployment changes one thing and one file.

### The polygon tiers

`src/lib/regions.ts` points the United States adapter at
`data/polygons/us-38017-{detail,overview}.pmtiles` and at `data/polygons/us-38017.manifest.json`, and
the app fetches those from its own origin. They are versioned (about 70 KB and 2 KB) and
`npm run build` copies them into `dist/data/polygons/` through `scripts/copy-polygon-tiles.mjs`, so a
static deployment serves them. In development Vite serves the project root, which is why the same
URLs work without a copy step.

### CORS

The backend allows, by default, any `http://localhost:<port>` or `http://127.0.0.1:<port>` origin,
which is what the development server needs, and no other. Set `CORS_ALLOW_ORIGINS` to a comma
separated list to allow a deployment's own origins; setting it replaces the development regex, and
`CORS_ALLOW_ORIGIN_REGEX` overrides the regex directly (an empty value disables it). The backend also
serves no byte range of its own, so there is no `Content-Range` to expose; a `Range` request header
is already permitted by the wildcard `allow_headers`.

### Request limits on `POST /fields/{id}/numbers`

That route calls NASA POWER and the other sources synchronously, so it carries two protections:

- an outbound timeout, `OUTBOUND_TIMEOUT_SECONDS` (default 20, the value it always had), after which
  the source call is abandoned instead of holding the worker;
- a per client address rate limit, `NUMBERS_RATE_LIMIT_REQUESTS` in
  `NUMBERS_RATE_LIMIT_WINDOW_SECONDS` (default 60 in 60), which answers 429 with a `Retry-After`
  header. The window lives in this process, so it is PER WORKER: with `uvicorn --workers 4` a client
  can make four times the configured number of requests, one allowance per worker. Raise the limit or
  move it to a shared store if that matters; it is deliberately small enough to need no service.

To run the backend with several workers:

    backend/.venv/bin/python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000 --workers 4

Each worker loads its own fixture data and its own rate limit window. The tile fetches are cached on
disk under `.tile-cache/`, so several workers share one cache rather than fetching the same tile
twice.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
