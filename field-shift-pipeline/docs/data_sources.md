# Data sources: what answers, how, and whether it fits Field Phase

**Scope: Brazil only.** Every source below is either Brazilian or global with coverage of Brazil.
US-only datasets are excluded (see [Excluded](#excluded-us-only-datasets)).

Probed on **2026-11-14** from a Linux cloud runner. Re-run at any time with:

```bash
uv run python -m pipeline.probe_sources
```

The machine-readable registry behind this page is [`config/sources.yaml`](../config/sources.yaml).

## The short version

1. **ENSO data is fully automatable, and mostly without scraping.** CPC publishes ONI, **RONI** and the
   weekly Niño SSTs as plain text. Only the monthly *Diagnostic Discussion* and the *Strength
   Probabilities* table are HTML, and both are now scraped by `pipeline/fetch_enso.py`.
2. **The project is Brazil-only.** Eight of the fifteen datasets originally proposed cover only the
   United States, so they were dropped. Each has a global or Brazilian replacement, listed under
   [Excluded](#excluded-us-only-datasets).
3. **Only one source is truly real-time:** the CPC weekly Niño SSTs. The others are near-real-time
   (NASA POWER, CHIRPS prelim, INMET), monthly (ONI/RONI, discussion), annual (PAM) or static (soil).
   For a crop-planning tool that is the right cadence: decisions are seasonal.

## Proposed links that cover Brazil

| Link | Covers | Access | Verdict for Field Phase |
|---|---|---|---|
| CPC ENSO page (`enso.shtml`) | global | HTML hub | **Core.** Hub only; the data behind it is below. |
| ↳ `oni.ascii.txt`, `RONI.ascii.txt` | global | **plain-text file** | **Core, done.** RONI has a text file too. The README used to say it didn't. |
| ↳ `wksst9120.for` (weekly Niño) | global | fixed-width text | **Core, done.** Weekly; latest week 4 Nov 2026, Niño-3.4 +3.3 °C. |
| ↳ ENSO Diagnostic Discussion | global | **scrape** | **Core, done.** Alert status, synopsis, next issue date. |
| ↳ ENSO Strength Probabilities | global | **scrape** (HTML table) | **Core, done.** % chance per RONI bin, next 9 seasons. |
| NASA POWER | global | REST/JSON | **Core.** Verified at the LEM centroid; precipitation, Tmax, root-zone wetness. |
| GAEZ (FAO) | global | ArcGIS Hub portal | **Phase 3 candidate** for crop suitability / attainable yield. Raster endpoint not mapped yet. |
| SRTM (Earthdata) | global | Earthdata download | **Optional.** Slope is useful for erosion risk; needs Earthdata login. Metadata visible via CMR. |
| EarthExplorer | global | M2M JSON API | **Optional.** API alive; every call needs an ERS account *and* a separately approved M2M access request. |

## Excluded: US-only datasets

Each of these was proposed and probed on 2026-11-14 (most answered fine), but none has data for a
Brazilian municipality. They are not in `config/sources.yaml`.

| Dataset | What it would have given | Brazilian / global replacement |
|---|---|---|
| Web Soil Survey, NRCS soils (SSURGO) | soil texture, carbon, drainage | **SoilGrids** 250 m (verified) |
| CropScape (Cropland Data Layer) | crop type map, rotation history | **MapBiomas** (not yet probed) + **IBGE PAM** |
| NLCD | land-cover history | **MapBiomas** |
| PRISM | gridded daily rain and temperature | **NASA POWER**, **CHIRPS v3.0** (verified) |
| CoCoRaHS | volunteer rain gauges | **INMET** automatic stations (verified) |
| USGS water data (NWIS) | streamflow, groundwater | ANA HidroWeb (not checked); **SMAP** for soil water |
| NAIP | aerial imagery | Landsat / Sentinel-2 via Earthdata or EarthExplorer |
| USDA Ag Data Commons | research datasets, mostly US | none needed; Embrapa publications if a parameter needs a citation |

## Sources the project already relies on (Brazil and global)

| Source | Access | Status from the runner | Notes |
|---|---|---|---|
| IBGE SIDRA (PAM 1612) | REST/JSON | **ok** | Confirms the README's LEM soybean yield: 3 240 kg/ha in 2015, 2 100 in 2016. |
| IBGE localidades / malhas | REST/JSON | **connection reset** | Drops connections from outside Brazil; Phase 0 ran fine from a Brazilian network. |
| INMET automatic stations | REST/JSON | **ok, needs a User-Agent** | 668 stations with coordinates. Without a User-Agent header the server sends an empty reply. `pipeline/common.py` already sets one. |
| CHIRPS | HTTP file tree | **ok, moved** | `products/CHIRPS-2.0/` now returns 404. **CHIRPS v3.0** (Jan 2025) is at `products/CHIRPS/v3.0/`, 0.05°, 1981 to near-real time, with a `latam/` subset. One HTTP 429 seen, so throttle. |
| NASA CMR (SMAP, IMERG, MODIS) | REST/JSON | **ok** | Search needs no login; granule downloads need Earthdata (Phase 2). |
| ISRIC SoilGrids | REST/JSON | **ok, slow** | Clay 0–5 cm at LEM = 289 g/kg. The first call timed out once, so allow retries. |
| MapBiomas | — | **not probed** | Host not on this environment's allowlist; access route still open (see README). |

## When scraping is the answer, and how this repo does it

Only two pages need it today. Both follow the same rules, in `pipeline/fetch_enso.py`:

- **Cache the raw page** in `data/raw/` and re-parse from the cache; `--refresh` re-downloads. A
  parser fix never costs a request, and the exact text behind each published number stays on disk.
- **Match on structure, then check the result.** Strength rows are matched by shape (season code
  plus nine integers), de-duplicated across CPC's nested tables, and rejected if the row doesn't sum
  to about 100 %.
- **Strip HTML comments before matching.** CPC leaves last month's text in comments
  (`Issued April 2026 -->`); a naive regex would publish stale values.
- **Fail loudly on layout changes.** Required fields raise `LayoutChanged`; optional numbers come back
  as `None`, never guessed.
- **Be polite:** a fixed User-Agent and one request per page per run. CPC updates monthly, so
  a daily cron is already more than enough.

Don't scrape a site that serves a bot challenge (Ag Data Commons) or one with a real API next to
it. Use the API.

## What changed in our own docs because of this run

- **The ENSO numbers in the README were a month old.** The 12 Nov 2026 discussion has Niño-3.4 at
  +2.5 °C and the chance of a historic event (RONI ≥ +2.5 °C) at about 60 % for OND and NDJ, down
  from 83 %. The latest RONI is ASO 2026 = +1.97 °C (very strong). `enso_current.parquet` now
  carries these values with their issue date, so the UI never has to hard-code them.
- **RONI is machine-readable.** The project can classify historical analog years with the official
  index instead of ONI. ONI is kept beside it for comparison.
- **Historical check:** since 1950 RONI's highest value is +2.40 °C (1982–83), so +2.5 °C really
  would be unprecedented on this index. The 1982–83, 1997–98 and 2015–16 events come out as El Niño
  across their summer-crop seasons, as expected.
