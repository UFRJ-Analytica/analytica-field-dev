"""One in-process sliding window rate limiter, per client address and per scope.

Not a service and not shared: each uvicorn worker has its own window, so `--workers 4` multiplies the
allowance by four. That is the documented limit of a limiter this small. A route opts in by depending
on `enforce` with its own environment variables, so one route's allowance never spends another's.
"""

from __future__ import annotations

import math
import os
import threading
from time import monotonic
from typing import Any

from fastapi import HTTPException, Request

_lock = threading.Lock()
_hits: dict[tuple[str, str], list[float]] = {}


def limit_of(limit_env: str, window_env: str, default_limit: int,
             default_window: float = 60.0) -> tuple[int, float]:
    """The configured allowance: at most this many requests in this many seconds.

    A limit of zero or less turns the limiter off, which is what a test suite that calls the route in
    a loop from one address sets.
    """
    try:
        limit = int(os.environ.get(limit_env, str(default_limit)))
    except ValueError:
        limit = default_limit
    try:
        window = float(os.environ.get(window_env, str(default_window)))
    except ValueError:
        window = default_window
    return limit, max(window, 0.001)


def enforce(request: Request, *, scope: str, limit_env: str, window_env: str, default_limit: int,
            label: str, default_window: float = 60.0) -> None:
    """429 once a client has used its allowance of this window.

    The window is counted from the oldest request still inside it, so a client that waits the
    `Retry-After` it is given is served again. The address is the socket peer, which behind a proxy is
    the proxy unless the proxy is trusted to set a forwarding header.
    """
    limit, window = limit_of(limit_env, window_env, default_limit, default_window)
    if limit <= 0:
        return
    key = (scope, request.client.host if request.client else "unknown")
    now = monotonic()
    with _lock:
        hits = [hit for hit in _hits.get(key, []) if now - hit < window]
        if len(hits) >= limit:
            _hits[key] = hits
            retry_after = max(1, math.ceil(window - (now - hits[0])))
            raise HTTPException(
                status_code=429,
                detail=f"too many {label} requests: at most {limit} in {window:g} s",
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        _hits[key] = hits


def reset() -> None:
    """For tests: forget every window."""
    with _lock:
        _hits.clear()


def scope_of(request: Request) -> Any:  # pragma: no cover - convenience for tests
    return request.client.host if request.client else "unknown"
