"""One-command refresh: key handling and the .env file."""

from __future__ import annotations

import os

from pipeline import common, update_all


def test_env_file_sets_missing_keys_only(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nNASS_API_KEY=abc123\nMETEOMATICS_USERNAME='someone'\nEMPTY=\n", encoding="utf-8")
    monkeypatch.delenv("NASS_API_KEY", raising=False)
    monkeypatch.setenv("METEOMATICS_USERNAME", "from-shell")
    names = common.load_env_file(env)
    assert names == ["NASS_API_KEY"]
    assert os.environ["NASS_API_KEY"] == "abc123"
    assert os.environ["METEOMATICS_USERNAME"] == "from-shell"
    assert "EMPTY" not in os.environ


def test_keyed_steps_are_the_only_ones_needing_keys():
    keyed = {name for name, _, keys in update_all.STEPS if keys}
    assert keyed == {"nass", "meteomatics"}
    assert [s[0] for s in update_all.STEPS][-2:] == ["export-map", "export-analysis"]
