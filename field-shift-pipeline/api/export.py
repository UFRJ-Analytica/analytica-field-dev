"""Write every API response to static JSON files, so the web app can run with no server.

    uv run python -m api.export                    # -> web/public/data/v1/
    uv run python -m api.export --out some/dir     # anywhere else

The layout mirrors the API paths: /api/v1/enso -> <out>/enso.json,
/api/v1/municipalities/2919553 -> <out>/municipalities/2919553.json. Point the web app at it
with VITE_DATA_MODE=static (see web/README.md).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from api import repository as repo
from pipeline.common import ROOT

DEFAULT_OUT = ROOT / "web" / "public" / "data" / "v1"


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} "
          f"({path.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = p.parse_args()

    write(args.out / "meta.json", repo.meta_payload())
    write(args.out / "enso.json", repo.enso_payload())
    muns = repo.municipalities_payload()
    write(args.out / "municipalities.json", muns)
    for m in muns["municipalities"]:
        write(args.out / "municipalities" / f"{m['code']}.json", repo.municipality_payload(m["code"]))


if __name__ == "__main__":
    main()
