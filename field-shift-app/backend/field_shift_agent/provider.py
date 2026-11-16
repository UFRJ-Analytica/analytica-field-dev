"""Replaceable language-model providers.

A provider runs one model turn: system prompt, messages and tool definitions in; text, tool calls and a
stop reason out. The message format is the Messages API block format (`tool_use` / `tool_result`); a
provider for another API translates it.

Activation is explicit and off by default:
  FIELD_SHIFT_AI_PROVIDER   unset, "none" or "off" -> no provider (deterministic fallback)
                            "anthropic"           -> AnthropicProvider
                            "openai"              -> OpenAIProvider (Responses API)
  FIELD_SHIFT_AI_API_KEY    Anthropic key (read only here, never logged or returned)
  FIELD_SHIFT_AI_MODEL      Anthropic model, default "claude-opus-5-5"
  FIELD_SHIFT_AI_OPENAI_API_KEY  OpenAI key (read only here, never logged or returned)
  FIELD_SHIFT_AI_OPENAI_MODEL    OpenAI model, default "gpt-6-luna"
  FIELD_SHIFT_AI_EFFORT     default "medium"
  FIELD_SHIFT_AI_TIMEOUT_S  default 20 (per model turn)
  FIELD_SHIFT_AI_BASE_URL   optional Anthropic endpoint
  FIELD_SHIFT_AI_OPENAI_BASE_URL optional; default "https://api.openai.com/v1"
  FIELD_SHIFT_AI_MAX_OUTPUT_TOKENS default 4096 (per model turn)
  FIELD_SHIFT_AI_OPENAI_BUDGET_USD optional hard ceiling for one provider instance

The variables are this project's own names: ambient credentials of the machine are never picked up, so
no field data leaves the backend unless an operator configured this provider on purpose.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx


class ProviderError(Exception):
    """A provider failure. `code` is safe to return to the client."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class ProviderTurn:
    stop_reason: str  # "tool_use", "end_turn", "max_tokens", "refusal" or another provider value
    tool_calls: list[ToolCall] = field(default_factory=list)
    text: str = ""
    # The assistant content exactly as the provider returned it, appended back on the next turn.
    raw_content: Any = None


@dataclass(frozen=True)
class ProviderTelemetry:
    """Safe operational data for local validation. Never contains prompts, results or credentials."""

    latency_ms: float
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated_cost_usd: float


class Provider(Protocol):
    name: str

    def run_turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderTurn: ...


@dataclass
class ProviderConfig:
    name: str | None
    reason: str | None = None  # why no provider is active: "not_configured", "missing_key", "unknown_provider"
    model: str | None = None
    effort: str | None = None


class AnthropicProvider:
    """Claude through the official `anthropic` Python SDK, imported only when this provider is built.

    The SDK is not in requirements.txt: installing it is part of activating the provider."""

    name = "anthropic"

    def __init__(self, api_key: str, model: str, effort: str, timeout_s: float, base_url: str | None) -> None:
        try:
            import anthropic  # noqa: PLC0415 - lazy on purpose, no import at app start
        except ImportError as error:
            raise ProviderError("provider_sdk_missing") from error
        self._anthropic = anthropic
        kwargs: dict[str, Any] = {"api_key": api_key, "timeout": timeout_s, "max_retries": 1}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = anthropic.Anthropic(**kwargs)
        self._model = model
        self._effort = effort

    def run_turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderTurn:
        anthropic = self._anthropic
        try:
            response = self._client.beta.messages.create(
                model=self._model,
                max_tokens=4096,
                system=system,
                messages=messages,
                tools=tools,
                output_config={"effort": self._effort},
                # Server-side fallback on a policy refusal (opt-in); a refusal that still ends the
                # chain is handled below as a provider error and falls back to the deterministic path.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.RateLimitError as error:
            raise ProviderError("provider_rate_limited") from error
        except anthropic.AuthenticationError as error:
            raise ProviderError("provider_auth_failed") from error
        except anthropic.APIStatusError as error:
            raise ProviderError(f"provider_http_{error.status_code}") from error
        except anthropic.APIConnectionError as error:
            raise ProviderError("provider_unreachable") from error
        calls = [ToolCall(id=b.id, name=b.name, input=dict(b.input) if isinstance(b.input, dict) else {})
                 for b in response.content if getattr(b, "type", None) == "tool_use"]
        text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
        return ProviderTurn(stop_reason=response.stop_reason or "", tool_calls=calls, text=text,
                            raw_content=response.content)


class OpenAIProvider:
    """OpenAI Responses API over the project's existing httpx dependency.

    The adapter uses stateless Responses (`store=false`) and manually replays every output item. This
    preserves reasoning items between consecutive function calls without persisting a server-side response.
    """

    name = "openai"
    INPUT_USD_PER_MILLION = 0.10
    CACHED_INPUT_USD_PER_MILLION = 0.01
    OUTPUT_USD_PER_MILLION = 0.50

    def __init__(self, api_key: str, model: str, effort: str, timeout_s: float, base_url: str | None,
                 max_output_tokens: int = 4096, budget_usd: float | None = None) -> None:
        self._model = model
        self._effort = effort
        self._max_output_tokens = max_output_tokens
        self._budget_usd = budget_usd
        self.telemetry: list[ProviderTelemetry] = []
        self._client = httpx.Client(
            base_url=(base_url or "https://api.openai.com/v1").rstrip("/") + "/",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=timeout_s,
        )

    @property
    def estimated_cost_usd(self) -> float:
        return sum(item.estimated_cost_usd for item in self.telemetry)

    @staticmethod
    def _tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{"type": "function", "name": tool["name"], "description": tool.get("description", ""),
                 "parameters": tool["input_schema"], "strict": tool.get("strict", True)} for tool in tools]

    @staticmethod
    def _input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for message in messages:
            content = message.get("content")
            if message.get("role") == "assistant":
                if not isinstance(content, list):
                    raise ProviderError("provider_bad_transcript")
                items.extend(content)
                continue
            if isinstance(content, str):
                items.append({"role": "user", "content": content})
                continue
            if not isinstance(content, list):
                raise ProviderError("provider_bad_transcript")
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    raise ProviderError("provider_bad_transcript")
                output = block.get("content", "")
                if not isinstance(output, str):
                    output = json.dumps(output, ensure_ascii=False, default=str)
                if block.get("is_error"):
                    output = json.dumps({"error": output}, ensure_ascii=False)
                items.append({"type": "function_call_output", "call_id": block.get("tool_use_id"),
                              "output": output})
        return items

    @classmethod
    def _cost(cls, usage: dict[str, Any]) -> float:
        input_tokens = int(usage.get("input_tokens") or 0)
        cached = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        uncached = max(0, input_tokens - cached)
        return ((uncached * cls.INPUT_USD_PER_MILLION + cached * cls.CACHED_INPUT_USD_PER_MILLION
                 + output_tokens * cls.OUTPUT_USD_PER_MILLION) / 1_000_000)

    def _check_budget(self, payload: dict[str, Any]) -> None:
        if self._budget_usd is None:
            return
        # UTF-8 bytes are a conservative upper bound for text tokens in this JSON payload. Reserve the full
        # configured output allowance before making the request, so the local validation ceiling is hard.
        input_upper_bound = len(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"))
        next_upper_bound = (input_upper_bound * self.INPUT_USD_PER_MILLION
                            + self._max_output_tokens * self.OUTPUT_USD_PER_MILLION) / 1_000_000
        if self.estimated_cost_usd + next_upper_bound > self._budget_usd:
            raise ProviderError("provider_budget_exceeded")

    def run_turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderTurn:
        payload = {
            "model": self._model,
            "instructions": system,
            "input": self._input(messages),
            "tools": self._tools(tools),
            "tool_choice": "auto",
            "parallel_tool_calls": True,
            "reasoning": {"effort": self._effort},
            "max_output_tokens": self._max_output_tokens,
            "store": False,
        }
        self._check_budget(payload)
        started = time.monotonic()
        try:
            response = self._client.post("responses", json=payload)
        except httpx.TimeoutException as error:
            raise ProviderError("provider_timeout") from error
        except httpx.HTTPError as error:
            raise ProviderError("provider_unreachable") from error
        latency_ms = (time.monotonic() - started) * 1000
        if response.status_code in (401, 403):
            raise ProviderError("provider_auth_failed")
        if response.status_code == 429:
            raise ProviderError("provider_rate_limited")
        if response.status_code >= 400:
            raise ProviderError(f"provider_http_{response.status_code}")
        try:
            body = response.json()
        except ValueError as error:
            raise ProviderError("provider_bad_response") from error
        if not isinstance(body, dict) or not isinstance(body.get("output"), list):
            raise ProviderError("provider_bad_response")

        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        input_tokens = int(usage.get("input_tokens") or 0)
        cached_tokens = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        self.telemetry.append(ProviderTelemetry(
            latency_ms=round(latency_ms, 2), input_tokens=input_tokens, cached_input_tokens=cached_tokens,
            output_tokens=output_tokens, total_tokens=int(usage.get("total_tokens") or input_tokens + output_tokens),
            estimated_cost_usd=self._cost(usage),
        ))

        calls: list[ToolCall] = []
        text_parts: list[str] = []
        refused = False
        for item in body["output"]:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "function_call":
                try:
                    arguments = json.loads(item.get("arguments") or "{}")
                except (TypeError, ValueError) as error:
                    raise ProviderError("provider_invalid_tool_arguments") from error
                if not isinstance(arguments, dict) or not item.get("call_id") or not item.get("name"):
                    raise ProviderError("provider_invalid_tool_call")
                calls.append(ToolCall(id=item["call_id"], name=item["name"], input=arguments))
            if item.get("type") == "message":
                for content in item.get("content") or []:
                    if content.get("type") == "output_text":
                        text_parts.append(content.get("text", ""))
                    elif content.get("type") == "refusal":
                        refused = True
        if refused:
            stop_reason = "refusal"
        elif calls:
            stop_reason = "tool_use"
        elif body.get("status") == "incomplete":
            reason = (body.get("incomplete_details") or {}).get("reason") or "incomplete"
            stop_reason = "max_tokens" if reason == "max_output_tokens" else reason
        else:
            stop_reason = "end_turn"
        return ProviderTurn(stop_reason=stop_reason, tool_calls=calls, text="".join(text_parts),
                            raw_content=body["output"])


def provider_config(env: dict[str, str] | None = None) -> ProviderConfig:
    env = dict(os.environ) if env is None else env
    kind = env.get("FIELD_SHIFT_AI_PROVIDER", "").strip().lower()
    if kind in ("", "none", "off"):
        return ProviderConfig(None, "not_configured")
    if kind not in ("anthropic", "openai"):
        return ProviderConfig(None, "unknown_provider")
    key_name = "FIELD_SHIFT_AI_OPENAI_API_KEY" if kind == "openai" else "FIELD_SHIFT_AI_API_KEY"
    if not env.get(key_name, "").strip():
        return ProviderConfig(None, "missing_key")
    if kind == "openai":
        model = env.get("FIELD_SHIFT_AI_OPENAI_MODEL", "gpt-6-luna").strip() or "gpt-6-luna"
    else:
        model = env.get("FIELD_SHIFT_AI_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5"
    return ProviderConfig(kind, model=model, effort=env.get("FIELD_SHIFT_AI_EFFORT", "medium").strip() or "medium")


def provider_from_env(env: dict[str, str] | None = None) -> Provider | None:
    env = dict(os.environ) if env is None else env
    config = provider_config(env)
    if config.name is None:
        return None
    try:
        timeout = float(env.get("FIELD_SHIFT_AI_TIMEOUT_S", "20"))
    except ValueError:
        timeout = 20.0
    effort = env.get("FIELD_SHIFT_AI_EFFORT", "medium").strip() or "medium"
    timeout_s = max(1.0, min(timeout, 60.0))
    if config.name == "anthropic":
        return AnthropicProvider(
            api_key=env["FIELD_SHIFT_AI_API_KEY"].strip(),
            model=env.get("FIELD_SHIFT_AI_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5",
            effort=effort, timeout_s=timeout_s,
            base_url=env.get("FIELD_SHIFT_AI_BASE_URL", "").strip() or None,
        )
    try:
        max_output_tokens = int(env.get("FIELD_SHIFT_AI_MAX_OUTPUT_TOKENS", "4096"))
    except ValueError:
        max_output_tokens = 4096
    budget: float | None = None
    if env.get("FIELD_SHIFT_AI_OPENAI_BUDGET_USD", "").strip():
        try:
            budget = float(env["FIELD_SHIFT_AI_OPENAI_BUDGET_USD"])
        except ValueError as error:
            raise ProviderError("provider_bad_budget") from error
        if budget <= 0:
            raise ProviderError("provider_bad_budget")
    return OpenAIProvider(
        api_key=env["FIELD_SHIFT_AI_OPENAI_API_KEY"].strip(),
        model=env.get("FIELD_SHIFT_AI_OPENAI_MODEL", "gpt-6-luna").strip() or "gpt-6-luna",
        effort=effort, timeout_s=timeout_s,
        base_url=env.get("FIELD_SHIFT_AI_OPENAI_BASE_URL", "").strip() or None,
        max_output_tokens=max(16, min(max_output_tokens, 8192)), budget_usd=budget,
    )
