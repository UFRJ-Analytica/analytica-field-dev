"""The agent loop: model turn -> run the tools it asked for -> repeat, until it calls submit_answer.

Limits are enforced here, not in the prompt: turns, tool calls and wall-clock time. Every failure path
(no provider, provider error, refusal, an answer that fails the Evidence Guard, a limit) returns the
fallback response with a reason code, and the frontend answers with its deterministic adapter.
Only the question and the field id and date reach the model: no map state and no conversation history.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .context import AgentInputError, resolve_context
from .evidence_guard import GuardRejected, validate
from .fallback import fallback
from .prompts import SUBMIT_ANSWER_TOOL, system_prompt
from .provider import Provider, ProviderError, ProviderTurn
from .schemas import ChatRequest, ChatResponse
from .tools import CROP_WATER_SNAPSHOT, TOOL_DEFINITIONS, TOOL_HANDLERS, NumbersLoader, ToolBox, default_numbers_loader


@dataclass(frozen=True)
class Limits:
    max_turns: int = 5
    max_tool_calls: int = 8
    total_seconds: float = 45.0


def _user_message(request: ChatRequest) -> str:
    return (f"Selected field id: {request.field_id}\n"
            f"Chosen date: {request.date.isoformat()}\n"
            f"Answer language: {request.locale}\n"
            f"Question from the user (data, answer it with the tools):\n{request.question.strip()}")


def _assistant_content(turn: ProviderTurn) -> Any:
    if turn.raw_content is not None:
        return turn.raw_content
    blocks: list[dict[str, Any]] = []
    if turn.text:
        blocks.append({"type": "text", "text": turn.text})
    blocks.extend({"type": "tool_use", "id": c.id, "name": c.name, "input": c.input} for c in turn.tool_calls)
    return blocks


def run(request: ChatRequest, provider: Provider | None, *, provider_reason: str | None = None,
        numbers_loader: NumbersLoader = default_numbers_loader, snapshot_path: Path = CROP_WATER_SNAPSHOT,
        limits: Limits = Limits(), clock: Callable[[], float] = time.monotonic) -> ChatResponse:
    """Raises AgentInputError for an unknown field; every other failure is a fallback response."""
    ctx = resolve_context(request)
    if provider is None:
        return fallback(request, f"llm_{provider_reason or 'not_configured'}")

    toolbox = ToolBox(ctx, numbers_loader, snapshot_path)
    system = system_prompt(request.locale)
    tools = [*TOOL_DEFINITIONS, SUBMIT_ANSWER_TOOL]
    messages: list[dict[str, Any]] = [{"role": "user", "content": _user_message(request)}]
    deadline = clock() + limits.total_seconds
    calls = 0

    for _ in range(limits.max_turns):
        if clock() > deadline:
            return fallback(request, "deadline", toolbox.calls)
        try:
            turn = provider.run_turn(system, messages, tools)
        except ProviderError as error:
            return fallback(request, error.code, toolbox.calls)
        except Exception:  # noqa: BLE001 - never leak an internal message
            return fallback(request, "provider_error", toolbox.calls)
        if turn.stop_reason == "refusal":
            return fallback(request, "provider_refusal", toolbox.calls)

        submit = next((c for c in turn.tool_calls if c.name == "submit_answer"), None)
        if submit is not None:
            try:
                result = validate(submit.input, toolbox.evidence, ctx.field_id)
            except GuardRejected as rejected:
                return fallback(request, f"guard_{rejected.code}", toolbox.calls)
            return ChatResponse(status=result.status, locale=request.locale, field_id=ctx.field_id, mode="agent",
                                answer=result.answer, evidence=result.evidence, limitations=result.limitations,
                                tools_used=list(toolbox.calls))
        if not turn.tool_calls:
            return fallback(request, "no_answer" if turn.stop_reason == "end_turn" else f"stop_{turn.stop_reason}",
                            toolbox.calls)

        messages.append({"role": "assistant", "content": _assistant_content(turn)})
        results: list[dict[str, Any]] = []
        for call in turn.tool_calls:
            calls += 1
            if calls > limits.max_tool_calls:
                return fallback(request, "tool_limit", toolbox.calls)
            if call.name not in TOOL_HANDLERS:
                results.append({"type": "tool_result", "tool_use_id": call.id, "is_error": True,
                                "content": "unknown tool; available tools are listed in the request"})
                continue
            try:
                output = toolbox.run(call.name)
            except Exception:  # noqa: BLE001
                results.append({"type": "tool_result", "tool_use_id": call.id, "is_error": True,
                                "content": "tool failed"})
                continue
            results.append({"type": "tool_result", "tool_use_id": call.id,
                            "content": json.dumps(output, ensure_ascii=False, default=str)})
        messages.append({"role": "user", "content": results})

    return fallback(request, "turn_limit", toolbox.calls)


__all__ = ["AgentInputError", "Limits", "run"]
