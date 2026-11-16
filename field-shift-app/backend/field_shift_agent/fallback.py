"""The fallback answer: no model text, no evidence, and the reason code.

The deterministic adapter already exists in the frontend (src/lib/assistant/answers.ts) and works
offline, so the backend does not re-implement it: `mode: "fallback"` tells the panel to answer with
that adapter and to say why the model was not used.
"""

from __future__ import annotations

from .schemas import ChatRequest, ChatResponse


def fallback(request: ChatRequest, reason: str, tools_used: list[str] | None = None) -> ChatResponse:
    return ChatResponse(status="fallback", locale=request.locale, field_id=request.field_id, mode="fallback",
                        tools_used=tools_used or [], errors=[reason], fallback_reason=reason)
