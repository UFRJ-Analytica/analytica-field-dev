"""Refresh every dataset and the two exports the app serves, in order, with one command.

    uv run python -m pipeline.update_all            # everything
    uv run python -m pipeline.update_all --skip planetary meteomatics

Steps that need a key (NASS, Meteomatics) are skipped with a message when the key is missing, and
the app keeps the data it already has. Keys come from the shell or from field-shift-pipeline/.env
(see .env.example). Every download is cached, so a second run only fetches what is new.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

from pipeline.common import ENV_FILE, ROOT, load_env_file

APP_DATA = ROOT.parent / "field-shift-app" / "backend" / "fixtures" / "fieldphase" / "data" / "v1"

# (name, module and arguments, keys it needs)
STEPS: list[tuple[str, list[str], list[str]]] = [
    ("regions", ["pipeline.fetch_regions"], []),
    ("enso", ["pipeline.fetch_enso", "--refresh"], []),
    ("power", ["pipeline.fetch_power"], []),
    ("pam", ["pipeline.fetch_pam"], []),
    ("nass", ["pipeline.fetch_nass"], ["NASS_API_KEY"]),
    ("soil", ["pipeline.fetch_soil"], []),
    ("planetary", ["pipeline.fetch_planetary"], []),
    ("meteomatics", ["pipeline.fetch_meteomatics"], ["METEOMATICS_USERNAME", "METEOMATICS_PASSWORD"]),
    ("evidence", ["pipeline.build_evidence"], []),
    ("scoring", ["pipeline.build_scoring"], []),
    ("export-map", ["pipeline.export_fieldshift"], []),
    ("export-analysis", ["api.export", "--out", str(APP_DATA)], []),
]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--skip", nargs="*", default=[], choices=[s[0] for s in STEPS], help="steps to leave out")
    args = p.parse_args()
    load_env_file()

    skipped, failed = [], []
    for name, module, keys in STEPS:
        if name in args.skip:
            skipped.append(f"{name} (asked)")
            continue
        missing = [k for k in keys if not os.environ.get(k)]
        if missing:
            print(f"-- {name}: skipped, {', '.join(missing)} not set (shell or {ENV_FILE.name}); keeping the old data")
            skipped.append(f"{name} (no key)")
            continue
        print(f"-- {name}: {' '.join(module)}", flush=True)
        start = time.time()
        result = subprocess.run([sys.executable, "-m", *module], cwd=ROOT)
        if result.returncode != 0:
            print(f"-- {name}: failed (exit {result.returncode}); later steps use the data already on disk")
            failed.append(name)
        else:
            print(f"-- {name}: done in {time.time() - start:.0f} s")

    print()
    print("Skipped:", ", ".join(skipped) or "none")
    print("Failed:", ", ".join(failed) or "none")
    if not failed:
        print("The app reads the new files on its next start.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
