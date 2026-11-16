#!/usr/bin/env bash
# Build the block 5 offline polygon product: CO-B5-01 (United States). The
# Brazilian products of CO-B5-02 were removed with the rest of the Brazilian
# polygon path, so this script no longer builds or fetches them. The commands are
# the ones in R-10 of
# specs/bloco-5-poligonos-de-cultura.md, revision 5, kept literal; the only
# addition is `rm -f` before a build, because tippecanoe and pmtiles refuse to
# overwrite an existing output and R-10 names no --force flag.
#
# Usage:
#   scripts/build-polygons.sh [--only us|all] [--label NAME]
#
# Environment:
#   POLYGON_PYTHON     python with pyarrow, pandas, shapely, pyogrio and
#                      mapbox-vector-tile (see scripts/requirements-polygons.txt)
#   TIPPECANOE         tippecanoe binary (v2.82.0 was used)
#   PMTILES_CLI        pmtiles binary (v1.31.2 was used)
#
# Output: data/polygons (products and the two Table G records) and data/work
# (intermediates and the run record). Both are ignored except the small JSON
# records; see .gitignore.

set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Paths below are relative to the app root on purpose: tippecanoe embeds the
# command line, including the output path, in the PMTiles metadata, so an
# absolute path would make two checkouts of the same commit build different
# bytes for identical inputs.
cd "$APP_ROOT"
OUT="${POLYGON_OUT_DIR:-data/polygons}"
WORK="${POLYGON_WORK_DIR:-data/work}"
PY="${POLYGON_PYTHON:-python3}"
TIPPECANOE="${TIPPECANOE:-tippecanoe}"
PMTILES_CLI="${PMTILES_CLI:-pmtiles}"

ONLY="all"
LABEL="run-$(date -u +%Y%m%dT%H%M%SZ)"
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

US_BOX="-97.20,46.90,-97.14,46.96"

mkdir -p "$OUT" "$WORK"

log() { printf '\n== %s\n' "$*"; }
run() {
  printf '+ %s\n' "$*"
  "$@"
}

build_us() {
  log "US: page the CSB 2025 layer 0 for the pilot box $US_BOX"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" fetch-us \
    --box="$US_BOX" --out "$WORK/us-38017.geojson" --summary-out "$WORK/us-fetch.json"

  log "US: probe the detail tile bytes at every candidate zoom 6 to 14"
  rm -f "$WORK/us-38017-probe.pmtiles"
  run "$TIPPECANOE" -l trazo -Z6 -z14 \
    -y csbid -y csbacres \
    -y cdl2018 -y cdl2019 -y cdl2020 -y cdl2021 \
    -y cdl2022 -y cdl2023 -y cdl2024 -y cdl2025 \
    -o "$WORK/us-38017-probe.pmtiles" "$WORK/us-38017.geojson"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" choose-floor \
    --pmtiles "$WORK/us-38017-probe.pmtiles" --box="$US_BOX" \
    --out "$WORK/us-floor.json"
  LOCAL_D="$(jq -r '.detail_minzoom' "$WORK/us-floor.json")"

  log "US: detail tier, detail_minzoom $LOCAL_D to 14"
  rm -f "$OUT/us-38017-detail.pmtiles"
  run "$TIPPECANOE" -l trazo -Z"$LOCAL_D" -z14 \
    -y csbid -y csbacres \
    -y cdl2018 -y cdl2019 -y cdl2020 -y cdl2021 \
    -y cdl2022 -y cdl2023 -y cdl2024 -y cdl2025 \
    -o "$OUT/us-38017-detail.pmtiles" "$WORK/us-38017.geojson"

  log "US: overview tier, $((LOCAL_D - 3)) to $((LOCAL_D - 1))"
  rm -f "$OUT/us-38017-overview.pmtiles"
  run "$TIPPECANOE" -l trazo -Z"$((LOCAL_D - 3))" -z"$((LOCAL_D - 1))" \
    -y cdl2018 -y cdl2019 -y cdl2020 -y cdl2021 \
    -y cdl2022 -y cdl2023 -y cdl2024 -y cdl2025 \
    --coalesce --coalesce-smallest-as-needed --maximum-tile-bytes=300000 \
    -o "$OUT/us-38017-overview.pmtiles" "$WORK/us-38017.geojson"

  log "US: measure the detail tier (budget 250 KB, V1 and V2 pinned views)"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" measure \
    --pmtiles "$OUT/us-38017-detail.pmtiles" --budget-bytes 250000 \
    --box="$US_BOX" --id-property csbid \
    --id-universe-zoom 6 --id-universe-zoom 9 \
    --id-universe-zoom 12 --id-universe-zoom 14 \
    --view "V1:-97.17:46.93:12:1440:900" \
    --view "V2:-97.17:46.93:14:1440:900" \
    --view "V3:-97.17:46.93:12:780:900" \
    --view "V4:-97.17:46.93:12:360:640" \
    --view "W6:-97.17:46.93:6:1440:900" \
    --view "W7:-97.17:46.93:7:1440:900" \
    --view "W9:-97.17:46.93:9:1440:900" \
    --view "W14:-97.17:46.93:14:1440:900" \
    --fail-on-violation \
    --out "$WORK/us-detail-measure.json"

  log "US: measure the overview tier (budget 300 KB)"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" measure \
    --pmtiles "$OUT/us-38017-overview.pmtiles" --budget-bytes 300000 \
    --box="$US_BOX" --fail-on-violation \
    --out "$WORK/us-overview-measure.json"

  log "US: write us-38017.manifest.json and us-38017.tiles.json (Table G keys)"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" write-us-records \
    --floor "$WORK/us-floor.json" \
    --detail-measure "$WORK/us-detail-measure.json" \
    --overview-measure "$WORK/us-overview-measure.json" \
    --outdir "$OUT"

  log "US: class table from the CDL raster attribute table"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" classes-us \
    --out "$OUT/polygon-classes-us.json"

  log "US: verify the detail properties and the overview merge"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" verify \
    --pmtiles "$OUT/us-38017-detail.pmtiles" --zoom 14 \
    --expect-properties "csbid,csbacres,cdl2018,cdl2019,cdl2020,cdl2021,cdl2022,cdl2023,cdl2024,cdl2025" \
    --out "$WORK/verify-us-detail.json"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" verify \
    --pmtiles "$OUT/us-38017-overview.pmtiles" --zoom "$((LOCAL_D - 1))" \
    --expect-properties "cdl2018,cdl2019,cdl2020,cdl2021,cdl2022,cdl2023,cdl2024,cdl2025" \
    --forbid-properties "csbid,csbacres" --class-property cdl2025 \
    --class-columns cdl2018 --class-columns cdl2019 --class-columns cdl2020 \
    --class-columns cdl2021 --class-columns cdl2022 --class-columns cdl2023 \
    --class-columns cdl2024 --class-columns cdl2025 \
    --require-multi-polygon --out "$WORK/verify-us-overview.json"
}

if [ "$ONLY" = "all" ] || [ "$ONLY" = "us" ]; then
  build_us
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" layers \
    --pmtiles "$OUT/us-38017-detail.pmtiles" --out "$US_DETAIL_LAYER"
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" layers \
    --pmtiles "$OUT/us-38017-overview.pmtiles" --out "$US_OVERVIEW_LAYER"
fi

log "record the products of run $LABEL with size and sha256"
PRODUCTS=()
for candidate in \
  us-38017-detail.pmtiles us-38017-overview.pmtiles us-38017.manifest.json \
  us-38017.tiles.json polygon-classes-us.json; do
  [ -f "$OUT/$candidate" ] && PRODUCTS+=(--product "$OUT/$candidate")
done
run "$PY" "$APP_ROOT/scripts/polygon_build.py" run-record \
  --label "$LABEL" --repo-root "$APP_ROOT" "${PRODUCTS[@]}" \
  --out "$WORK/run-$LABEL.json"

# Fold the layer name verification into the run record so one file carries it.
LAYER_ARGS=()
for candidate in "$US_DETAIL_LAYER" "$US_OVERVIEW_LAYER"; do
  [ -f "$candidate" ] && LAYER_ARGS+=(--layers "$candidate")
done
run "$PY" "$APP_ROOT/scripts/polygon_build.py" attach-layers \
  --record "$WORK/run-$LABEL.json" "${LAYER_ARGS[@]}"

log "write the AC-03, AC-04 and AC-06 artifacts and the tile fixtures"
if [ -f "$WORK/us-detail-measure.json" ] && [ -f "$WORK/us-overview-measure.json" ]; then
  run "$PY" "$APP_ROOT/scripts/polygon_build.py" evidence \
    --us-measure "$WORK/us-detail-measure.json" \
    --us-overview-measure "$WORK/us-overview-measure.json" \
    --floor "$WORK/us-floor.json" --runs "$WORK/run-$LABEL.json" \
    --fetch "$WORK/us-fetch.json" --artifacts "$APP_ROOT/artifacts"
fi

log "run $LABEL complete"
for product in "${PRODUCTS[@]}"; do
  case "$product" in
    --product) ;;
    *) printf '%12s  sha256:%s  %s\n' "$(stat -c %s "$product")" "$(sha256sum "$product" | cut -d' ' -f1)" "$product" ;;
  esac
done

# The tile budget is reported, not smoothed over: R-08 and AC-06 fail the build
# when a requested tile is above its budget. Exit 3 means the products were
# built and recorded but the budget criterion does not hold.
log "tile budget at the named views and the zoom walk"
BUDGET_STATUS=0
MEASURE_ARGS=()
for measure_file in "$WORK"/us-detail-measure.json "$WORK"/us-overview-measure.json; do
  [ -f "$measure_file" ] && MEASURE_ARGS+=(--measure "$measure_file")
done
"$PY" "$APP_ROOT/scripts/polygon_build.py" budget-report "${MEASURE_ARGS[@]}" || BUDGET_STATUS=3
exit "$BUDGET_STATUS"
