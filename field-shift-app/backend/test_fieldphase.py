"""The static Field Phase export is served read-only under /fieldphase."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

import main
from main import app


class FieldPhaseFileTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.original = main.FIELDPHASE_DIR
        self.tmp = TemporaryDirectory()
        root = Path(self.tmp.name) / "data" / "v1"
        (root / "municipalities").mkdir(parents=True)
        (root / "enso.json").write_bytes(b'{"ok":true}')
        (root / "municipalities" / "17113.json").write_bytes(b'{"code":17113}')
        main.FIELDPHASE_DIR = Path(self.tmp.name)

    def tearDown(self):
        main.FIELDPHASE_DIR = self.original
        self.tmp.cleanup()

    def test_serves_the_file_bytes(self):
        response = self.client.get("/fieldphase/data/v1/enso.json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'{"ok":true}')
        self.assertEqual(self.client.get("/fieldphase/data/v1/municipalities/17113.json").json(), {"code": 17113})

    def test_rejects_paths_outside_the_export(self):
        self.assertEqual(self.client.get("/fieldphase/data/v1/..%2F..%2F..%2Fmain.py").status_code, 404)
        self.assertEqual(self.client.get("/fieldphase/data/v1/%2E%2E/%2E%2E/secret.json").status_code, 404)
        self.assertEqual(self.client.get("/fieldphase/data/v1/enso.txt").status_code, 404)

    def test_missing_file_is_503(self):
        response = self.client.get("/fieldphase/data/v1/meta.json")
        self.assertEqual(response.status_code, 503)
        self.assertIn("meta.json", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
