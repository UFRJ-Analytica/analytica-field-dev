"""Replaceable language-model providers.

A provider runs one model turn: system prompt, messages and tool definitions in; text, tool calls and a
stop reason out. The message format is the Messages API block format (`tool_use` / `tool_result`); a
provider for another API translates it.

Activation is explicit and off by default:
  FIELD_SHIFT_AI_PROVIDER   unset, "none" or "off" -> no provider (deterministic fallback)
                            "anthropic"           -> AnthropicProvider
  FIELD_SHIFT_AI_API_KEY    the key for that provider (read only here, never logged or returned)
  FIELD_SHIFT_AI_MODEL      default "claude-opus-5-5"
  FIELD_SHIFT_AI_EFFORT     default "medium"
  FIELD_SHIFT_AI_TIMEOUT_S  default 20 (per model turn)
  FIELD_SHIFT_AI_BASE_URL   optional; unset uses the provider's public endpoint

The variables are this project's own names: ambient credentials of the machine are never picked up, so
no field data leaves the backend unless an operator configured this provider on purpose.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Protocol


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


class Provider(Protocol):
    name: str

    def run_turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderTurn: ...


@dataclass
class ProviderConfig:
    name: str | None
    reason: str | None = None  # why no provider is active: "not_configured", "missing_key", "unknown_provider"


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


def provider_config(env: dict[str, str] | None = None) -> ProviderConfig:
    env = dict(os.environ) if env is None else env
    kind = env.get("FIELD_SHIFT_AI_PROVIDER", "").strip().lower()
    if kind in ("", "none", "off"):
        return ProviderConfig(None, "not_configured")
    if kind != "anthropic":
        return ProviderConfig(None, "unknown_provider")
    if not env.get("FIELD_SHIFT_AI_API_KEY", "").strip():
        return ProviderConfig(None, "missing_key")
    return ProviderConfig("anthropic")


def provider_from_env(env: dict[str, str] | None = None) -> Provider | None:
    env = dict(os.environ) if env is None else env
    config = provider_config(env)
    if config.name != "anthropic":
        return None
    try:
        timeout = float(env.get("FIELD_SHIFT_AI_TIMEOUT_S", "20"))
    except ValueError:
        timeout = 20.0
    return AnthropicProvider(
        api_key=env["FIELD_SHIFT_AI_API_KEY"].strip(),
        model=env.get("FIELD_SHIFT_AI_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5",
        effort=env.get("FIELD_SHIFT_AI_EFFORT", "medium").strip() or "medium",
        timeout_s=max(1.0, min(timeout, 60.0)),
        base_url=env.get("FIELD_SHIFT_AI_BASE_URL", "").strip() or None,
    )
