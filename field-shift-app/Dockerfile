# syntax=docker/dockerfile:1
#
# The Field Shift backend: FastAPI served by uvicorn.
#
# The layout of the repository is kept inside the image, because the backend resolves its own paths
# from `Path(__file__)` and from the parent folder:
#
#   /app/backend/        the app (`--app-dir backend`), its fixtures and the reserve tile
#   /app/data/polygons/  `us-38017.manifest.json`, the one file under `data/` the backend reads
#   /app/artifacts/      the two cited sources of the planting window and of the crop water Kc path
#
# Nothing else is in the image: no `node_modules`, no `dist`, no tests, no `.git`, no `.env`.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, so a change to the code does not reinstall them.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# What the app reads at run time, in the same layout as the repository.
COPY backend/ /app/backend/
COPY data/polygons/ /app/data/polygons/
COPY artifacts/us-windows-cass-nd.json /app/artifacts/us-windows-cass-nd.json
COPY artifacts/zarc-mt-snapshot.json /app/artifacts/zarc-mt-snapshot.json

# The caches the app writes: the tile cache of `GET /tiles/...` and the block 6 numbers cache. They
# live under /tmp, which the non root user below owns, so the container needs no writable volume.
ENV TILE_CACHE_DIR=/tmp/field-shift/tile-cache \
    NUMBERS_CACHE_DIR=/tmp/field-shift/numbers-cache \
    WEB_CONCURRENCY=2

RUN useradd --system --uid 10001 --create-home --home-dir /home/appuser appuser \
    && mkdir -p /tmp/field-shift/tile-cache /tmp/field-shift/numbers-cache \
    && chown -R appuser:appuser /tmp/field-shift

USER appuser

EXPOSE 8000

# `/health` answers `{"status":"ok"}` and reads nothing, which is why it is the probe. The image has no
# curl, so the check uses the interpreter that is already there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

# Workers follow `WEB_CONCURRENCY` (default 2). Every worker keeps its own rate limit window and its
# own fixture cache, as the README says; the tile and numbers caches are shared on disk.
CMD ["sh", "-c", "exec python -m uvicorn main:app --app-dir backend --host 0.0.0.0 --port 8000 --workers \"${WEB_CONCURRENCY:-2}\""]
