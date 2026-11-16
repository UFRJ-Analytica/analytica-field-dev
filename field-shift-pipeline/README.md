# field-shift-pipeline

Downloads every data source for Field Shift, builds the climate evidence and the rotation scores, and writes the
JSON files the app's backend serves. It started as the Field Phase pipeline (`nasa_chall_train`) and now covers
five places: Santa Carmem, Tupanciretã and Luís Eduardo Magalhães in Brazil, McLean County (IL) and Lubbock
County (TX) in the US.

| Step | Module | Writes |
|---|---|---|
| Boundaries and centre points (IBGE, US Census) | `pipeline.fetch_regions` | `regions.parquet`, `regions.geojson` |
| ENSO indices, discussion and outlook (NOAA CPC) | `pipeline.fetch_enso` | `enso_*.parquet` |
| Daily weather since 1981 (NASA POWER) | `pipeline.fetch_power` | `power_daily.parquet` |
| Yields, Brazil (IBGE PAM) | `pipeline.fetch_pam` | `pam.parquet` |
| Yields, US (USDA NASS, needs `NASS_API_KEY`) | `pipeline.fetch_nass` | `nass.parquet` |
| Soil water and texture (SoilGrids) | `pipeline.fetch_soil` | `soil_profile.parquet` |
| NDVI, land cover, elevation (Planetary Computer) | `pipeline.fetch_planetary` | `ndvi_*`, `land_cover`, `terrain` |
| Forecasts (Meteomatics, needs an account) | `pipeline.fetch_meteomatics` | `meteomatics_*.parquet` |
| Anomalies, ENSO composites, season to date | `pipeline.build_evidence` | `climate_seasonal`, `composites`, `yield_anomalies`, `season_progress` |
| ET0, soil water, rotation scores | `pipeline.build_scoring` | `rotation_scores.parquet` and friends |
| Files for the map screen | `pipeline.export_fieldshift` | `../field-shift-app/backend/fixtures/climate/` |
| Files for the analysis | `api.export --out ../field-shift-app/backend/fixtures/fieldphase/data/v1` | that folder |

The run order is in the root README. `data/` is not committed and can be rebuilt; each download is cached and
reused unless you pass `--refresh`.

A few rules hold everywhere: no value is typed by hand, every method choice in `config/*.yaml` names its source
(a citation, `project choice` or `suposicao`), and `pipeline/evidence.py` and `pipeline/scoring.py` do no I/O so
they stay easy to test. Each region has its own season calendar in `config/regions.yaml`: July to June in Brazil,
the October to September water year in the US. `docs/` holds the original Field Phase notes on the data sources,
the scoring method and the integrations.
