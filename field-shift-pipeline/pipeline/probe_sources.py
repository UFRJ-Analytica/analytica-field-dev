"""Check that every source in config/sources.yaml still answers, without downloading data.

Each probe streams at most PROBE_BYTES of the response and then closes it, so even the 16 MB NLCD
capabilities document or a PRISM zip costs a few KB. Nothing is written to data/.

    uv run python -m pipeline.probe_sources               # everything
    uv run python -m pipeline.probe_sources --coverage brazil global
    uv run python -m pipeline.probe_sources --only nasa_power ibge_sidra
"""

from __future__ import annotations

import time

import requests

from pipeline.common import USER_AGENT, base_parser, load_config, setup_logging

PROBE_BYTES = 64 * 1024
TIMEOUT = 45


def probe(url: str) -> dict[str, object]:
    t0 = time.monotonic()
    try:
        with requests.get(url, stream=True, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as r:
            got = 0
            for chunk in r.iter_content(8192):
                got += len(chunk)
                if got >= PROBE_BYTES:
                    break
            return {
                "status": r.status_code,
                "type": (r.headers.get("Content-Type") or "").split(";")[0],
                "bytes": got,
                "size": r.headers.get("Content-Length"),
                "ms": int((time.monotonic() - t0) * 1000),
                "error": "",
            }
    except requests.RequestException as exc:
        return {"status": None, "type": "", "bytes": 0, "size": None,
                "ms": int((time.monotonic() - t0) * 1000), "error": type(exc).__name__}


def main() -> None:
    p = base_parser(__doc__ or "")
    p.add_argument("--only", nargs="*", help="source ids to probe")
    p.add_argument("--coverage", nargs="*", choices=["global", "brazil"])
    args = p.parse_args()
    setup_logging(args.verbose)

    sources = load_config("sources.yaml")["sources"]
    if args.only:
        sources = [s for s in sources if s["id"] in args.only]
    if args.coverage:
        sources = [s for s in sources if s["coverage"] in args.coverage]

    print(f"{'id':18} {'cov':6} {'access':7} {'auth':10} {'status':>6} {'ms':>6}  type / error")
    for s in sources:
        r = probe(s["probe"])
        ok = r["status"] is not None and 200 <= int(r["status"]) < 300
        detail = r["error"] or r["type"]
        if r["size"]:
            detail += f" ({int(r['size']) / 1024:.0f} KB full)"
        mark = "ok " if ok else "-- "
        print(f"{s['id']:18} {s['coverage']:6} {s['access']:7} {str(s['auth'])[:10]:10} "
              f"{str(r['status'] or '-'):>6} {r['ms']:>6}  {mark}{detail}")


if __name__ == "__main__":
    main()
