#!/usr/bin/env bash
# Fetch the block 5 polygon products and verify them against the build manifest.
#
# The PMTiles files are gitignored, because they are hundreds of megabytes. The Brazilian
# products were removed from the repository with the rest of the Brazilian polygon path, so
# only the United States tiers are fetched; the build manifest still records the Brazilian
# files it was written with, and they are skipped below.
# 280 MB. They are published as the assets of the GitHub release `polygons-v1`
# instead, and this script is the supported way to obtain them: it downloads
# each file, checks its sha256 against artifacts/polygon-build-manifest.json and
# only then leaves it in place. A file that does not match is deleted and the
# script fails, so a corrupt or half written download never reaches the app.
#
# Usage:
#   scripts/fetch-polygons.sh                 # into field-shift-app/data/polygons
#   scripts/fetch-polygons.sh /some/dir       # into another directory
#
# Requirements: gh (authenticated, with access to the private repository),
# python3 and sha256sum. The script is idempotent: files already present with
# the right hash are skipped, so a second run costs nothing.

set -euo pipefail

TAG="polygons-v1"
REPO="UFRJ-Analytica/analytica-field-dev"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$APP_DIR/artifacts/polygon-build-manifest.json"
DEST="${1:-$APP_DIR/data/polygons}"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh is required to download the release assets" >&2
  exit 1
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "error: manifest not found at $MANIFEST" >&2
  exit 1
fi

mkdir -p "$DEST"

# name<TAB>sha256 for every pmtiles product the manifest records.
expected="$(python3 - "$MANIFEST" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
for product in manifest.get("products", []):
    path = product.get("path", "")
    if not path.endswith(".pmtiles"):
        continue
    name = path.rsplit("/", 1)[-1]
    # The United States tiers only: the Brazilian products are no longer part of the app, and the
    # manifest that records them is a build record, not a fetch list.
    if not name.startswith("us-"):
        continue
    print(f"{name}\t{product['sha256']}\t{product['bytes']}")
PY
)"

if [[ -z "$expected" ]]; then
  echo "error: the manifest lists no pmtiles product" >&2
  exit 1
fi

status=0
while IFS=$'\t' read -r name want_sha want_bytes; do
  target="$DEST/$name"

  if [[ -f "$target" ]]; then
    have_sha="$(sha256sum "$target" | cut -d' ' -f1)"
    if [[ "$have_sha" == "$want_sha" ]]; then
      echo "ok        $name (already present, $want_bytes bytes)"
      continue
    fi
    echo "mismatch  $name (present with $have_sha, expected $want_sha), refetching"
    rm -f "$target"
  fi

  echo "fetching  $name ($want_bytes bytes)"
  tmp_dir="$(mktemp -d)"
  if ! gh release download "$TAG" --repo "$REPO" --pattern "$name" --dir "$tmp_dir" --clobber; then
    echo "error: download failed for $name" >&2
    rm -rf "$tmp_dir"
    status=1
    continue
  fi

  got_sha="$(sha256sum "$tmp_dir/$name" | cut -d' ' -f1)"
  got_bytes="$(wc -c <"$tmp_dir/$name" | tr -d ' ')"
  if [[ "$got_sha" != "$want_sha" ]]; then
    echo "error: $name has sha256 $got_sha, the manifest says $want_sha" >&2
    rm -rf "$tmp_dir"
    status=1
    continue
  fi
  if [[ "$got_bytes" != "$want_bytes" ]]; then
    echo "error: $name is $got_bytes bytes, the manifest says $want_bytes" >&2
    rm -rf "$tmp_dir"
    status=1
    continue
  fi

  mv "$tmp_dir/$name" "$target"
  rm -rf "$tmp_dir"
  echo "verified  $name"
done <<<"$expected"

if [[ "$status" -ne 0 ]]; then
  echo "one or more products could not be verified; the app will not draw those polygons" >&2
  exit "$status"
fi

echo
echo "all polygon products present in $DEST and verified against the manifest"
