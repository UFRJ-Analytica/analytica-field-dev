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

### The Field Report page

`/report/<municipality code>` is its own page, opened from the `Field Report` control in the strip
(next to `Field Data` and `Data Info`) in a new tab, so the map page is untouched. It is enabled only
for a pilot field whose county has report data, and disabled with its reason in the accessible name
otherwise. The page opens in English and carries its own Portuguese switch. Vite serves the path as
the app's own single page, so no hosting configuration is needed.

The report reads the static export under `backend/fixtures/fieldphase/data/v1/`, served read-only by
`GET /fieldphase/data/v1/{path}`. Its sources are `GET /climate/enso` (the CPC state the strip's chip
prints) and `GET /fields/{id}/climate` (the municipal rows of `Data Info`).

### Environment variables

| Variable | Where | What |
|---|---|---|
| `VITE_API_BASE_URL` | frontend, build time | the backend base URL, `http://localhost:8000` unset |
| `VITE_BASEMAP_TILES`, `VITE_BASEMAP_ATTRIBUTION` | frontend, build time | the basemap the report's own county map draws |
| `CLIMATE_FIXTURE_DIR` | backend | where `enso.json`, `pilot-fields.json` and `municipality-<code>.json` live |
| `FIELDPHASE_FIXTURE_DIR` | backend | the Field Phase export root served under `/fieldphase` |
| `CORS_ALLOW_ORIGINS`, `CORS_ALLOW_ORIGIN_REGEX` | backend | which origins may call the API |
| `OUTBOUND_TIMEOUT_SECONDS`, `NUMBERS_RATE_LIMIT_REQUESTS`, `NUMBERS_RATE_LIMIT_WINDOW_SECONDS` | backend | the numbers route |
| `FIELD_SHIFT_AI_PROVIDER`, `FIELD_SHIFT_AI_OPENAI_API_KEY`, `FIELD_SHIFT_AI_OPENAI_MODEL`, `FIELD_SHIFT_AI_OPENAI_BUDGET_USD` | backend | the Field Shift AI assistant; no key means the deterministic adapter |
| `FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS`, `FIELD_SHIFT_AI_RATE_LIMIT_WINDOW_SECONDS` | backend | the chat route's own allowance (default 20 in 60, 0 turns it off) |
| `NASS_API_KEY`, `METEOMATICS_USERNAME`, `METEOMATICS_PASSWORD` | pipeline only | optional downloads; the app never needs them |

### Field Shift AI (the assistant panel)

`Field Shift AI` is a button of the control strip like `Data Info`: its panel opens below the strip, in
the right column, and the two are mutually exclusive, so opening one closes the other. It answers in
English and Portuguese from the block 6 numbers, and, when a model is configured, through
`POST /experimental/field-shift-ai/chat`.

Nothing needs a key to run: with no key the deterministic adapter answers and the panel says so. To
use the model, set these in the environment of the backend process (never in the repository, never in a
fixture, never in a log):

    FIELD_SHIFT_AI_PROVIDER=openai
    FIELD_SHIFT_AI_OPENAI_API_KEY=<the key, set by the operator>
    FIELD_SHIFT_AI_OPENAI_MODEL=gpt-5.1
    FIELD_SHIFT_AI_OPENAI_BUDGET_USD=0.50

`FIELD_SHIFT_AI_OPENAI_BUDGET_USD` caps one run's spend on the provider's own usage reporting, and it
should be set whenever a key is: the route is public and costs money once a key exists. For the same
reason it carries its own per client rate limit, `FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS` in
`FIELD_SHIFT_AI_RATE_LIMIT_WINDOW_SECONDS` (default 20 in 60, `0` turns it off), the same in process
sliding window as the numbers route and therefore also PER WORKER. Neither `/status` nor any error path
returns the key: the provider reports its name and model only.

The FAO-56 crop water comparison is computed by the backend, not in the browser
(`GET /fields/<id>/crop-water`): ET0 by FAO-56 eq. 52 from the recorded block 6 series, multiplied by
the FAO-56 Table 12 Kc of each crop over that crop's own usual planting window from the NASS state
bulletin (`artifacts/us-windows-cass-nd.json`, North Dakota). A crop with no recorded window for the
field's state, or with no Kc in the tree, abstains and names the missing input: nothing is invented.

### The pipeline

`field-shift-pipeline/` downloads NOAA, NASA POWER, IBGE PAM, USDA NASS and the optional Meteomatics
forecasts and writes the dated JSON the backend reads. It is tooling: the app runs from the fixtures
already in the tree, with no key and no download. `iniciar.cmd` starts everything on Windows and
`atualizar-dados.cmd` refreshes the data.

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

## Publishing on Azure

Two services: a container for the backend and a Static Web App for the frontend. No step needs a
credential written down here. `az login` on the operator's machine is the only one, and the OpenAI key
is set as a secret of the service, never in the repository (see the last paragraph).

**The backend, as a Container App.** `Dockerfile` builds it with `field-shift-app` as the build
context; `.dockerignore` keeps `node_modules`, `dist`, the tests, `.git`, the caches and the
`artifacts/` notes out of the image. The image keeps the repository layout (`backend/`,
`data/polygons/` and the two files of `artifacts/` the backend cites), runs as a non root user on uid
10001, writes its caches under `/tmp/field-shift` and answers `HEALTHCHECK` on `/health`.

    # the image, locally, to check it before publishing
    docker build -t field-shift-api field-shift-app
    docker run --rm -p 8000:8000 field-shift-api
    curl http://127.0.0.1:8000/health          # {"status":"ok"}

    # the Container App; the image is built in Azure, so no registry step is needed
    az containerapp up \
      --name field-shift-api \
      --resource-group <resource-group> \
      --location <region> \
      --source field-shift-app \
      --ingress external --target-port 8000

Then set the variables the backend reads, the same names as `.env.example`:

    az containerapp update --name field-shift-api --resource-group <resource-group> \
      --set-env-vars WEB_CONCURRENCY=2 OUTBOUND_TIMEOUT_SECONDS=20 \
                     NUMBERS_RATE_LIMIT_REQUESTS=60 NUMBERS_RATE_LIMIT_WINDOW_SECONDS=60 \
                     CORS_ALLOW_ORIGINS=https://<your-site-hostname>

`WEB_CONCURRENCY` is the uvicorn worker count (the image defaults to 2). Any `CLIMATE_FIXTURE_DIR` and
`FIELDPHASE_FIXTURE_DIR` may stay unset: the image carries the fixtures and their defaults point inside
it. `TILE_CACHE_DIR` and `NUMBERS_CACHE_DIR` also stay unset: both point into `/tmp/field-shift`, which
the container owns and which is emptied on restart, so the caches are cold after a restart and need no
volume.

**The frontend, as a Static Web App.** App location `field-shift-app`, output `dist`.
`public/staticwebapp.config.json` is what makes `/report/<county>` load the app instead of a 404: the
navigation fallback rewrites unknown paths to `/index.html` and leaves `/assets/*`, `/data/*` and any
path with a file extension alone, so the polygon tiles under `/data/polygons/` keep being served as
static files.

    az staticwebapp create \
      --name field-shift-web \
      --resource-group <resource-group> \
      --location "East US 2" \
      --source . --app-location field-shift-app --output-location dist --branch main

`VITE_API_BASE_URL` is baked in at build time, so set it **before the first build**, pointing at the
backend address:

    az staticwebapp appsettings set --name field-shift-web --setting-names \
      VITE_API_BASE_URL=https://<backend-hostname>

Then set `CORS_ALLOW_ORIGINS` on the backend to the site address, or the browser blocks the calls.
Unset, the backend allows `localhost` only, which is what development uses.

**The OpenAI key.** If the assistant should use a model, the key goes into the service's secret
settings and is only referenced by an environment variable. It never enters the repository, a fixture, a
test or a log:

    az containerapp secret set --name field-shift-api --resource-group <resource-group> \
      --secrets llm-key=<the key>
    az containerapp update --name field-shift-api --resource-group <resource-group> \
      --set-env-vars FIELD_SHIFT_AI_PROVIDER=openai \
                     FIELD_SHIFT_AI_OPENAI_API_KEY=secretref:llm-key \
                     FIELD_SHIFT_AI_OPENAI_MODEL=<model> \
                     FIELD_SHIFT_AI_OPENAI_BUDGET_USD=0.50

Set `FIELD_SHIFT_AI_OPENAI_BUDGET_USD` whenever a key is set, and leave the key unset to publish with
the deterministic adapter only. `/status` reports the provider and the model, never the key.

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
