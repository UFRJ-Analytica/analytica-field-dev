"""End-to-end contract test: synthetic inputs -> build_evidence -> API -> JSON contract.

The inputs are synthetic (clearly so: municipality code 9999999, "Testopolis") and never leave
the temp directory. What is under test is the plumbing and the contract, not the numbers.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from pipeline.common import load_config
from pipeline.fetch_enso import build_seasonal

CODE = 9999999


def _write(df: pd.DataFrame, path, meta: dict | None = None) -> None:
    table = pa.Table.from_pandas(df, preserve_index=False)
    if meta:
        table = table.replace_schema_metadata({**(table.schema.metadata or {}),
                                               **{k.encode(): v.encode() for k, v in meta.items()}})
    pq.write_table(table, path)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    d = tmp_path_factory.mktemp("processed")
    rng = np.random.default_rng(0)

    regions = pd.DataFrame([{
        "code": CODE, "name": "Testopolis", "uf": "RS", "mesoregion": "x", "region_id": "rs",
        "region_name": "Rio Grande do Sul", "enso_signal": "excess", "hazards": "waterlogging,erosion",
        "centroid_lon": -54.0, "centroid_lat": -29.0, "min_lon": -54.1, "min_lat": -29.1,
        "max_lon": -53.9, "max_lat": -28.9, "geometry_source": "synthetic",
    }])
    _write(regions, d / "regions.parquet", {"source": "synthetic"})
    (d / "regions.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": []}))

    dates = pd.date_range("1981-01-01", "2026-11-11")
    daily = pd.DataFrame({"code": CODE, "date": dates,
                          "PRECTOTCORR": rng.gamma(0.5, 8, len(dates)),
                          "GWETROOT": 0.5, "T2M_MAX": 28.0, "T2M_MIN": 16.0, "RH2M": 70.0,
                          "WS2M": 2.0, "ALLSKY_SFC_SW_DWN": 20.0, "elevation_m": 400.0})
    _write(daily, d / "power_daily.parquet")
    _write(pd.DataFrame([{"code": CODE, "top_cm": t, "bottom_cm": b, "fc": 0.30, "wp": 0.18}
                         for t, b in ((0, 5), (5, 15), (15, 30), (30, 60), (60, 100), (100, 200))]),
           d / "soil_profile.parquet")

    years = np.arange(1974, 2026)
    pam = pd.concat([
        pd.DataFrame({"code": CODE, "municipality": "Testopolis", "table": 1612, "year": years,
                      "crop_code": crop, "crop": name, "variable_code": var, "variable": vname,
                      "unit": "x", "value": value, "flag": ""})
        for crop, name in ((2713, "Soja (em grão)"), (2716, "Trigo (em grão)"))
        for var, vname, value in ((109, "area_planted_ha", 1000.0), (216, "area_harvested_ha", 1000.0),
                                  (215, "production_value", 3000.0),
                                  (112, "yield_kg_ha", 1500 + 30 * (years - 1974) + rng.normal(0, 100, len(years))))
    ])
    _write(pam, d / "pam.parquet")

    # Alternate strong El Nino / La Nina / neutral blocks so every class has members.
    seasons = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
    rows = []
    for y in range(1950, 2027):
        amp = {0: 2.0, 1: -1.0, 2: 0.0, 3: 1.0}[y % 4]
        for i, s in enumerate(seasons):
            if y == 2026 and i > 8:
                break
            rows.append({"season": s, "year": y, "center_month": i + 1,
                         "crop_year": y + 1 if i + 1 >= 7 else y, "anom": amp})
    idx = pd.DataFrame(rows)
    _write(build_seasonal(idx, idx, load_config("enso.yaml")), d / "enso_seasonal.parquet")

    outlook = pd.DataFrame([{"lead": 1, "season": "NDJ", "issued": "2026-11",
                             **{f"p_{k}": 0 for k in ["le_m2.0", "m2.0_m1.5", "m1.5_m1.0", "m1.0_m0.5",
                                                      "neutral", "p0.5_p1.0", "p1.0_p1.5"]},
                             "p_p1.5_p2.0": 4, "p_ge_p2.0": 96, "p_la_nina": 0, "p_neutral": 0, "p_el_nino": 100}])
    _write(outlook, d / "enso_strength_forecast.parquet", {"source": "synthetic"})
    _write(pd.DataFrame([{
        "issued": "2026-11-12", "alert_status": "El Niño Advisory", "synopsis": "Synthetic.",
        "next_issue": "2026-12-10", "nino34_quoted_c": 2.5, "discussion_text": "Synthetic.",
        "source_url": "synthetic", "roni_latest_season": "ASO 2026", "roni_latest": 1.97,
        "roni_latest_phase": "el_nino", "roni_latest_strength": "very_strong",
        "oni_latest_season": "ASO 2026", "oni_latest": 2.46, "weekly_latest_week": "2026-11-04",
        "weekly_nino34_anom": 3.3, "fetched_at": "2026-11-14T00:00:00+00:00"}]), d / "enso_current.parquet")
    _write(pd.DataFrame({"week_center": pd.date_range("2026-05-06", periods=27, freq="7D"),
                         "nino34_anom": 1.0, "nino12_anom": 2.0}), d / "enso_weekly.parquet")
    return d


@pytest.fixture(scope="module")
def client(built):
    import pipeline.build_evidence as be
    import pipeline.build_scoring as bs
    import pipeline.common as common
    from api import repository as repo

    mp = pytest.MonkeyPatch()
    mp.setattr(common, "PROCESSED_DIR", built)
    mp.setattr(be, "PROCESSED_DIR", built)
    mp.setattr(bs, "PROCESSED_DIR", built)
    mp.setattr(sys, "argv", ["build_evidence"])
    mp.setenv("FIELD_PHASE_DATA_DIR", str(built))
    be.main()
    bs.main()
    repo.clear_cache()

    from api.main import app
    yield TestClient(app)
    repo.clear_cache()
    mp.undo()


def test_meta(client):
    m = client.get("/api/v1/meta").json()
    assert m["contract_version"] == "1.2"
    assert m["mock"] is False
    assert m["current_crop_year"] == 2027
    assert m["enso_classes"] == ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"]
    assert all(a["source"] == "suposicao" for a in m["assumptions"])


def test_enso(client):
    e = client.get("/api/v1/enso").json()
    assert e["current"]["roni"]["value"] == 1.97
    assert e["outlook"][0]["p_el_nino"] == 100
    assert {"season", "year", "roni", "roni_phase"} <= e["history"][0].keys()
    assert e["crop_years"][-1]["forecast"] is True


def test_municipality_list(client):
    m = client.get("/api/v1/municipalities").json()
    assert [x["code"] for x in m["municipalities"]] == [CODE]
    assert m["geojson"]["type"] == "FeatureCollection"


def test_municipality_detail(client):
    r = client.get(f"/api/v1/municipalities/{CODE}").json()
    assert r["municipality"]["hazards"] == ["waterlogging", "erosion"]
    assert r["current_crop_year"]["forecast"] is True

    prog = r["season_progress"]
    assert prog["start"] == "2026-09-01"
    assert prog["last_observed"] == "2026-11-11"
    assert len(prog["days"]) == 242

    comp = r["climate"]["composites"]["early_rain_mm_anom_pct"]
    assert [c["enso_class"] for c in comp["by_class"]] == ["el_nino_strong", "el_nino_moderate", "neutral", "la_nina"]
    assert all(c["n"] > 0 for c in comp["by_class"])

    crops = {c["crop_code"]: c for c in r["yield"]["crops"]}
    assert crops[2716]["season"] == "winter" and crops[2716]["assumption"] is True
    wheat = {s["crop_year"]: s for s in crops[2716]["series"]}
    assert wheat[2015]["enso_crop_year"] == 2016  # winter crop -> the ENSO it grew through
    assert crops[2713]["series"][0]["enso_crop_year"] == crops[2713]["series"][0]["crop_year"]


def test_json_is_strict(client):
    """No NaN/Infinity tokens -- browsers' JSON.parse rejects them."""
    text = client.get(f"/api/v1/municipalities/{CODE}").text
    assert "NaN" not in text and "Infinity" not in text


def test_unknown_municipality_is_404(client):
    assert client.get("/api/v1/municipalities/1234567").status_code == 404


def test_optional_integrations_are_null_when_not_run(client):
    """No Meteomatics / Planetary Computer outputs in the fixture -> those blocks are null, and
    everything else still works (a team without those accounts gets a valid payload)."""
    r = client.get(f"/api/v1/municipalities/{CODE}").json()
    for block in ("forecast", "vegetation", "land_cover", "terrain"):  # rotations *are* built here
        assert r[block] is None
    assert r["season_progress"]["forecast_model"] is None


def test_rotations_block(client):
    r = client.get(f"/api/v1/municipalities/{CODE}").json()["rotations"]
    assert r["current_class_is_forecast"] is True
    assert set(r["by_class"]) == {"el_nino_strong", "el_nino_moderate", "neutral", "la_nina"}
    assert r["assumptions"][0]["source"] == "suposicao"  # calendars are flagged
    rows = {x["id"]: x for x in r["by_class"]["el_nino_strong"]}
    # Only soy and wheat exist in the synthetic PAM: other cash crops cannot be scored on income.
    assert rows["soja_trigo"]["income"]["value"] is not None
    assert rows["soja_canola"]["income"]["value"] is None and rows["soja_canola"]["rank"] is None
    for comp in ("soil", "water", "income"):
        assert {"value", "score"} <= rows["soja_trigo"][comp].keys()


def test_rotation_endpoint_reranks_with_weights(client):
    def order(**w):
        q = "&".join(f"{k}={v}" for k, v in w.items())
        res = client.get(f"/api/v1/municipalities/{CODE}/rotations?enso_class=el_nino_strong&{q}").json()
        return [x["id"] for x in res["rotations"] if x["rank"] is not None]

    soil_only = order(soil=1, water=0, income=0)
    # A cover crop leaves no month bare, so it cannot lose on soil to soy followed by fallow.
    assert soil_only.index("soja_aveia_cobertura") < soil_only.index("soja_pousio")
    # With income weighted, rotations lacking income data drop out of the ranking.
    assert "soja_canola" not in order(soil=1, water=1, income=1)
    assert "soja_canola" in order(soil=1, water=1, income=0)


def test_rotation_endpoint_404(client):
    assert client.get(f"/api/v1/municipalities/{CODE}/rotations?enso_class=nope").status_code == 404


def test_water_comes_from_the_soil_water_balance(client):
    r = client.get(f"/api/v1/municipalities/{CODE}").json()["rotations"]
    w = {x["id"]: x["water"] for x in r["by_class"]["neutral"]}["soja_trigo"]
    assert w["model"] == "FAO-56 daily soil water balance"
    assert w["n_years"] > 0 and w["value"] >= 0 and w["stress_days"] >= 0
