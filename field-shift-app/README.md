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
