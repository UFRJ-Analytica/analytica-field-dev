"""Shared paths, config loading and a caching HTTP fetcher.

Every fetch_* script caches its raw response under data/raw/ and is idempotent: re-running does
nothing unless --refresh is passed. Nothing here invents a value.
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Any

import requests
import yaml

# TLS-inspecting proxies and antivirus products are common on Windows: the intercepting root CA
# lives in the Windows certificate store but not in certifi's bundle, so `requests` fails with
# CERTIFICATE_VERIFY_FAILED on hosts that plain `curl` reaches. truststore routes verification
# through the OS trust store, which fixes it without ever weakening verification -- we do not set
# verify=False anywhere.
try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover - optional on platforms that do not need it
    pass

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
RAW_DIR = ROOT / "data" / "raw"
PROCESSED_DIR = ROOT / "data" / "processed"
ENV_FILE = ROOT / ".env"


def load_env_file(path: Path = ENV_FILE) -> list[str]:
    """Read KEY=VALUE lines from field-shift-pipeline/.env into the environment.

    The file is gitignored and optional; it only saves typing the keys in every new shell. A variable
    already set in the shell wins over the file. Returns the names it set (never the values).
    """
    import os

    if not path.exists():
        return []
    set_now = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = (part.strip() for part in line.split("=", 1))
        value = value.strip('"').strip("'")
        if name and value and name not in os.environ:
            os.environ[name] = value
            set_now.append(name)
    return set_now


load_env_file()

USER_AGENT = "field-phase/0.1 (NASA Space Apps 2026; contact via repository)"
TIMEOUT = 120

log = logging.getLogger("field_phase")


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )


def base_parser(description: str) -> argparse.ArgumentParser:
    """Argument parser shared by every fetch_* / build_* script."""
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        "--refresh",
        action="store_true",
        help="re-download even if a cached raw response exists",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return p


def load_config(name: str) -> dict[str, Any]:
    """Load a YAML file from config/. Raises if it is missing -- never falls back to defaults."""
    path = CONFIG_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"missing config file: {path}")
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def pilot_municipalities() -> list[dict[str, Any]]:
    """Flatten config/regions.yaml into one row per municipality, carrying its region fields."""
    cfg = load_config("regions.yaml")
    rows: list[dict[str, Any]] = []
    for region in cfg["regions"]:
        for mun in region["municipalities"]:
            rows.append(
                {
                    **mun,
                    "region_id": region["id"],
                    "region_name": region["name"],
                    "country": region.get("country", "BR"),
                    "enso_signal": region["enso_signal"],
                    "hazards": list(region["hazards"]),
                }
            )
    return rows


def region_calendars() -> dict[str, dict[str, Any]]:
    """Season calendar of every region: its own `calendar:` block, else the Brazilian defaults.

    Keys: crop_year_start_month, season_months, sub_seasons, ndvi_peak_months, source.
    """
    regions = load_config("regions.yaml")
    analysis = load_config("analysis.yaml")
    default = {
        "crop_year_start_month": regions["meta"]["crop_year_start_month"],
        "season_months": regions["meta"]["season_months"],
        "sub_seasons": {k: v for k, v in analysis["sub_seasons"].items() if k != "source"},
        "ndvi_peak_months": analysis["ndvi"]["peak_months"],
        "source": analysis["sub_seasons"]["source"].strip(),
    }
    out = {}
    for region in regions["regions"]:
        cal = {**default, **region.get("calendar", {})}
        cal["sub_seasons"] = {k: v for k, v in cal["sub_seasons"].items() if k != "source"}
        cal["source"] = str(cal["source"]).strip()
        out[region["id"]] = cal
    return out


def fetch_text(url: str, cache_name: str, refresh: bool = False) -> str:
    """GET a text resource, caching the raw body under data/raw/.

    The cache is the raw upstream bytes, so a parser bug never means re-downloading, and the exact
    text behind every published number stays on disk for audit.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache = RAW_DIR / cache_name
    if cache.exists() and not refresh:
        log.info("cache hit: %s", cache.name)
        return cache.read_text(encoding="utf-8")

    log.info("GET %s", url)
    resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    text = resp.text
    cache.write_text(text, encoding="utf-8")
    log.info("cached %s (%.1f KB)", cache.name, len(text.encode("utf-8")) / 1024)
    return text


def fetch_file(url: str, cache_name: str, refresh: bool = False) -> Path:
    """Download a binary file to data/raw/, streaming, and return its path.

    Sends a HEAD first and logs the size before committing to the download (project rule 6). The
    file is written to a .part name and renamed only when complete, so an interrupted download is
    never mistaken for a cached one.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache = RAW_DIR / cache_name
    if cache.exists() and not refresh:
        log.info("cache hit: %s", cache.name)
        return cache

    headers = {"User-Agent": USER_AGENT}
    head = requests.head(url, timeout=TIMEOUT, headers=headers, allow_redirects=True)
    size = head.headers.get("Content-Length")
    log.info("GET %s (%s)", url, f"{int(size) / 1e6:.1f} MB" if size else "size unknown")

    part = cache.with_suffix(cache.suffix + ".part")
    with requests.get(url, timeout=TIMEOUT, headers=headers, stream=True) as resp:
        resp.raise_for_status()
        with part.open("wb") as fh:
            for chunk in resp.iter_content(1 << 20):
                fh.write(chunk)
    part.replace(cache)
    log.info("cached %s (%.1f MB)", cache.name, cache.stat().st_size / 1e6)
    return cache


def fetch_json(url: str, cache_name: str, refresh: bool = False) -> Any:
    import json

    return json.loads(fetch_text(url, cache_name, refresh=refresh))


def write_parquet(df, name: str, metadata: dict[str, str] | None = None) -> Path:
    """Write a DataFrame to data/processed/, embedding provenance in the Parquet key-value metadata.

    Provenance travels with the file: anyone reading the Parquet can recover which source and which
    climatology baseline produced it without consulting the code.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    path = PROCESSED_DIR / name

    table = pa.Table.from_pandas(df, preserve_index=False)
    if metadata:
        existing = table.schema.metadata or {}
        merged = {**existing, **{k.encode(): str(v).encode() for k, v in metadata.items()}}
        table = table.replace_schema_metadata(merged)

    pq.write_table(table, path, compression="snappy")
    log.info("wrote %s (%d rows, %.1f KB)", path.name, len(df), path.stat().st_size / 1024)
    return path
