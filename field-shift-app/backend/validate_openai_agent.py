"""Explicit, budget-capped real OpenAI validation for Field Shift AI.

This file is intentionally not a unit test. It makes no request unless both the OpenAI backend configuration
and ``--confirm-real-api`` are present. Run it only after the operator explicitly authorizes real API use.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import date
from typing import Any

from field_shift_agent.orchestrator import run
from field_shift_agent.provider import OpenAIProvider, provider_config, provider_from_env
from field_shift_agent.schemas import ChatRequest

BUDGET_USD = 0.10
FIELD_ID = "mt-santa-carmem-01"
CHOSEN_DATE = date(2026, 11, 12)
QUESTIONS = {
    "pt-BR": [
        "Como estão as condições ambientais de Santa Carmem?",
        "Compare a demanda hídrica do milho e da soja.",
        "Com essas informações, qual cultura devo plantar?",
    ],
    "en": [
        "How are the environmental conditions in Santa Carmem?",
        "Compare the water demand of maize and soybean.",
        "With this information, which crop should I plant?",
    ],
}


def _metrics(rows: list[Any]) -> dict[str, Any]:
    return {
        "model_calls": len(rows),
        "latency_ms": round(sum(row.latency_ms for row in rows), 2),
        "input_tokens": sum(row.input_tokens for row in rows),
        "cached_input_tokens": sum(row.cached_input_tokens for row in rows),
        "output_tokens": sum(row.output_tokens for row in rows),
        "total_tokens": sum(row.total_tokens for row in rows),
        "estimated_cost_usd": round(sum(row.estimated_cost_usd for row in rows), 8),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the six approved Field Shift OpenAI validation prompts.")
    parser.add_argument("--confirm-real-api", action="store_true",
                        help="required acknowledgement that this command makes billable OpenAI API calls")
    args = parser.parse_args()
    if not args.confirm_real_api:
        parser.error("real calls are disabled; use --confirm-real-api only after explicit operator authorization")

    env = dict(os.environ)
    config = provider_config(env)
    if config.name != "openai":
        raise SystemExit("FIELD_SHIFT_AI_PROVIDER must be openai and its backend-only key must be configured")
    if config.model != "gpt-6-luna":
        raise SystemExit("FIELD_SHIFT_AI_OPENAI_MODEL must be exactly gpt-6-luna for this validation")
    if config.effort != "medium":
        raise SystemExit("FIELD_SHIFT_AI_EFFORT must be medium for this validation")
    env["FIELD_SHIFT_AI_OPENAI_BUDGET_USD"] = str(BUDGET_USD)
    env.setdefault("FIELD_SHIFT_AI_MAX_OUTPUT_TOKENS", "4096")
    provider = provider_from_env(env)
    if not isinstance(provider, OpenAIProvider):
        raise SystemExit("OpenAI provider could not be initialized")

    report: dict[str, Any] = {
        "provider": "openai",
        "api": "responses",
        "model": config.model,
        "reasoning_effort": config.effort,
        "budget_usd": BUDGET_USD,
        "conversation_context": "request-local; follow-up wording is validated without server-side chat history",
        "runs": [],
    }
    for locale, questions in QUESTIONS.items():
        for index, question in enumerate(questions, start=1):
            start_telemetry = len(provider.telemetry)
            started = time.monotonic()
            response = run(ChatRequest(field_id=FIELD_ID, locale=locale, question=question, date=CHOSEN_DATE),
                           provider)
            turns = provider.telemetry[start_telemetry:]
            report["runs"].append({
                "locale": locale,
                "question_index": index,
                "question": question,
                "status": response.status,
                "mode": response.mode,
                "fallback_reason": response.fallback_reason,
                "tools_used": response.tools_used,
                "evidence_ids": [item.id for item in response.evidence],
                "limitations": response.limitations,
                "evidence_guard": "passed" if response.mode == "agent" else "fallback",
                "end_to_end_latency_ms": round((time.monotonic() - started) * 1000, 2),
                "usage": _metrics(turns),
            })
    report["totals"] = _metrics(provider.telemetry)
    report["within_budget"] = provider.estimated_cost_usd <= BUDGET_USD
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["within_budget"] and all(row["mode"] == "agent" for row in report["runs"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
