"""Field Phase HTTP API -- a thin, read-only layer over data/processed/.

    uv run uvicorn api.main:app --reload

Interactive docs at /docs. All payloads come from api/repository.py, which the static exporter
(api/export.py) also uses, so both deployments serve the same contract.
"""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from api import repository as repo

app = FastAPI(
    title="Field Phase API",
    version=repo.CONTRACT_VERSION,
    description="ENSO-conditioned evidence for Brazilian municipalities. Read-only; no mock data.",
)

# The web app may be served from anywhere (Vite dev server, GitHub Pages, another team's site), and
# the API is read-only public data, so CORS is open for GET. Narrow with FIELD_PHASE_CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("FIELD_PHASE_CORS", "*").split(","),
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _guard(fn, *args):
    try:
        return fn(*args)
    except repo.DataMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/meta")
def meta() -> dict:
    return _guard(repo.meta_payload)


@app.get("/api/v1/enso")
def enso() -> dict:
    return _guard(repo.enso_payload)


@app.get("/api/v1/municipalities")
def municipalities() -> dict:
    return _guard(repo.municipalities_payload)


@app.get("/api/v1/municipalities/{code}")
def municipality(code: int) -> dict:
    try:
        return _guard(repo.municipality_payload, code)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"municipality {code} is not in the pilot set") from None


@app.get("/api/v1/municipalities/{code}/rotations")
def rotations(
    code: int,
    enso_class: str = "el_nino_strong",
    soil: float = Query(1.0, ge=0, description="weight for 'protect soil'"),
    water: float = Query(1.0, ge=0, description="weight for 'conserve water'"),
    income: float = Query(1.0, ge=0, description="weight for 'income stability'"),
) -> dict:
    """Candidate rotations ranked for the given weights. Every component, raw value and score is
    returned with the total, so the arithmetic can be checked."""
    weights = {"soil": soil, "water": water, "income": income}
    try:
        ranked = _guard(repo.ranked_rotations, code, enso_class, weights)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no rotations for {code} / {enso_class}") from None
    return {"code": code, "enso_class": enso_class, "weights": weights, "rotations": ranked}


@app.post("/api/v1/reload", include_in_schema=False)
def reload() -> dict:
    """Drop cached frames after the pipeline has been re-run."""
    repo.clear_cache()
    return {"reloaded": True}
