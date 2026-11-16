"""Experimental routes, under their own prefix. Not an official API: no existing route changes.

GET  /experimental/field-shift-ai/status -> whether a model provider is configured (no secret returned)
POST /experimental/field-shift-ai/chat   -> ChatResponse
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from . import orchestrator
from .context import AgentInputError
from .provider import Provider, ProviderError, provider_config, provider_from_env
from .schemas import ChatRequest, ChatResponse

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


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest = Body(...), provider: tuple[Provider | None, str | None] = Depends(get_provider),
         runner: Any = Depends(get_runner)) -> ChatResponse:
    model, reason = provider
    try:
        return runner(body, model, provider_reason=reason)
    except AgentInputError as error:
        if error.code == "unknown_field":
            raise HTTPException(status_code=404, detail="Field not found") from error
        return ChatResponse(status="unavailable", locale=body.locale, field_id=body.field_id, mode="fallback",
                            errors=[error.code], fallback_reason=error.code)
