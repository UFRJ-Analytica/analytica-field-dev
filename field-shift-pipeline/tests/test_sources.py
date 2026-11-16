"""Guard the source registry: Field Phase is Brazil-only, and every entry must be probe-able."""

from __future__ import annotations

from urllib.parse import urlparse

from pipeline.common import load_config

SOURCES = load_config("sources.yaml")["sources"]
REQUIRED = {"id", "name", "coverage", "access", "auth", "cadence", "use", "probe", "verified"}


def test_every_source_covers_brazil():
    """A US-only dataset has no data for a Brazilian municipality; it must not be re-added."""
    bad = [s["id"] for s in SOURCES if s["coverage"] not in {"global", "brazil"}]
    assert bad == []


def test_entries_are_complete():
    for s in SOURCES:
        assert REQUIRED <= s.keys(), s["id"]


def test_ids_are_unique():
    ids = [s["id"] for s in SOURCES]
    assert len(ids) == len(set(ids))


def test_probes_are_https():
    for s in SOURCES:
        assert urlparse(s["probe"]).scheme == "https", s["id"]


def test_access_and_use_vocabularies():
    for s in SOURCES:
        assert s["access"] in {"api", "file", "scrape", "portal"}, s["id"]
        assert s["use"] in {"core", "phase2", "phase3", "reference"}, s["id"]
