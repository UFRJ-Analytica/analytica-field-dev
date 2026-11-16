"""Experimental routes, under their own prefix. Not an official API: no existing route changes.

GET  /experimental/field-shift-ai/status -> whether a model provider is configured (no secret returned)
POST /experimental/field-shift-ai/chat   -> ChatResponse
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from . import orchestrator
from .context import AgentInputError
from .provider import Provider, ProviderError, provider_config, provider_from_env
from .schemas import ChatRequest, ChatResponse

import rate_limit

router = APIRouter(prefix="/experimental/field-shift-ai", tags=["experimental"])


def get_provider() -> tuple[Provider | None, str | None]:
    """Resolved per request, so nothing model-related loads when the app starts."""
    config = provider_config()
    if config.name is None:
        return None, config.reason
    try:
        return provider_from_env(), None
    except ProviderError as error:
        return None, error.code


def get_runner() -> Any:
    return orchestrator.run


@router.get("/status")
def status() -> dict[str, Any]:
    config = provider_config()
    return {"experimental": True, "llm_enabled": config.name is not None, "provider": config.name,
            "model": config.model, "effort": config.effort, "reason": config.reason,
            "mode": "agent" if config.name else "deterministic"}


def chat_rate_limit(request: Request) -> None:
    """429 once a client has used its allowance of this window.

    A separate allowance from the numbers route, because this one costs money the moment a key is
    configured: 20 requests a minute by default, `FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS=0` to turn it off.
    """
    rate_limit.enforce(request, scope="field-shift-ai", limit_env="FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS",
                       window_env="FIELD_SHIFT_AI_RATE_LIMIT_WINDOW_SECONDS", default_limit=20,
                       label="Field Shift AI")


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest = Body(...), provider: tuple[Provider | None, str | None] = Depends(get_provider),
         runner: Any = Depends(get_runner), _limit: None = Depends(chat_rate_limit)) -> ChatResponse:
    model, reason = provider
    try:
        return runner(body, model, provider_reason=reason)
    except AgentInputError as error:
        if error.code == "unknown_field":
            raise HTTPException(status_code=404, detail="Field not found") from error
        return ChatResponse(status="unavailable", locale=body.locale, field_id=body.field_id, mode="fallback",
                            errors=[error.code], fallback_reason=error.code)
