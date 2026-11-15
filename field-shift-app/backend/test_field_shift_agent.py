"""Field Shift AI agent (experiment): tools, Evidence Guard, orchestrator, provider and routes.

No test calls a real model or the network: block 6 runs on its recorded transport (block6_replay) and
the model is a scripted provider whose turns are written here.
"""

from __future__ import annotations

import json
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import field_numbers
import main
from block6_replay import ReplayTransport
from field_shift_agent import orchestrator
from field_shift_agent.context import AgentInputError, resolve_context
from field_shift_agent.evidence_guard import GuardRejected, validate
from field_shift_agent.orchestrator import Limits, run
from field_shift_agent.provider import (AnthropicProvider, ProviderError, ProviderTurn, ToolCall, provider_config,
                                        provider_from_env)
from field_shift_agent.routes import get_provider
from field_shift_agent.schemas import ChatRequest, Evidence
from field_shift_agent.tools import CROP_WATER_SNAPSHOT, ToolBox

FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
FIELD = "mt-santa-carmem-01"
DATE = "2026-11-12"  # block 6 window 2026-10-01 to 2026-11-11, the window of the FAO-56 snapshot
SNAPSHOT = json.loads(CROP_WATER_SNAPSHOT.read_text(encoding="utf-8"))


def request(question: str = "Quais são as condições ambientais desta propriedade?", locale: str = "pt-BR",
            field_id: str = FIELD, day: str = DATE, **extra: Any) -> ChatRequest:
    return ChatRequest(field_id=field_id, locale=locale, question=question, date=date.fromisoformat(day), **extra)


class ScriptedProvider:
    """A model stand-in: each turn is a function of the messages so far. Records every call."""

    name = "scripted"

    def __init__(self, turns: list[Callable[[list[dict[str, Any]]], ProviderTurn] | ProviderTurn | Exception]) -> None:
        self.turns = list(turns)
        self.calls: list[tuple[str, list[dict[str, Any]], list[str]]] = []

    def run_turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ProviderTurn:
        self.calls.append((system, json.loads(json.dumps(messages, default=str)), [t["name"] for t in tools]))
        step = self.turns.pop(0)
        if isinstance(step, Exception):
            raise step
        return step(messages) if callable(step) else step


def use(*names: str) -> ProviderTurn:
    return ProviderTurn("tool_use", [ToolCall(f"call_{i}_{n}", n, {}) for i, n in enumerate(names)])


def submit(status: str, paragraphs: list[str], ids: list[str], codes: list[str] | None = None) -> ProviderTurn:
    return ProviderTurn("tool_use", [ToolCall("call_submit", "submit_answer", {
        "status": status, "paragraphs": paragraphs, "evidence_ids": ids, "limitation_codes": codes or []})])


ENV_PT = submit("answered", [
    "Na janela de {{period:rain_total}}, choveu {{value:rain_total}}; a mediana de 1991 a 2025 seria outra coisa.",
], ["rain_total"])


class Block6Recorded(unittest.TestCase):
    """Block 6 on its recorded transport, a temporary cache and a frozen clock."""

    def setUp(self) -> None:
        self.cache = TemporaryDirectory()
        self.mapbiomas = TemporaryDirectory()
        self.transport = ReplayTransport()
        self.patches = [
            patch.object(field_numbers, "CACHE_DIR", Path(self.cache.name)),
            patch.object(field_numbers, "clock", lambda: FROZEN_NOW),
            patch.object(field_numbers, "MAPBIOMAS_DB", Path(self.mapbiomas.name) / "none.sqlite"),
            patch.object(field_numbers, "transport", self.transport),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()
        self.cache.cleanup()
        self.mapbiomas.cleanup()

    def toolbox(self, **kwargs: Any) -> ToolBox:
        return ToolBox(resolve_context(request(**kwargs)))


class ToolTests(Block6Recorded):
    def test_a_fixture_field_uses_the_server_geometry_not_the_client_ring(self) -> None:
        ctx = resolve_context(request(ring=[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]], centroid=[0.5, 0.2]))
        self.assertEqual(ctx.kind, "fixture")
        self.assertEqual(ctx.center, (-55.27, -11.91))
        self.assertEqual(ctx.numbers_request.ring[0], [-55.285, -11.9])

    def test_an_unknown_field_and_a_polygon_without_ring_are_refused(self) -> None:
        with self.assertRaises(AgentInputError) as unknown:
            resolve_context(request(field_id="nowhere-01"))
        self.assertEqual(unknown.exception.code, "unknown_field")
        with self.assertRaises(AgentInputError) as ring:
            resolve_context(request(field_id="trazo:123"))
        self.assertEqual(ring.exception.code, "ring_missing")

    def test_field_context_reports_no_agronomic_records(self) -> None:
        context = self.toolbox().get_field_context()
        self.assertEqual(context["field_id"], FIELD)
        self.assertEqual(context["name"], "Field 01")
        self.assertIn("no sowing date", context["agronomic_records"])

    def test_indicators_keep_block_6_values_units_sources_and_periods(self) -> None:
        box = self.toolbox()
        result = box.get_environmental_indicators()
        self.assertTrue(result["available"])
        payload = field_numbers.build_numbers(FIELD, resolve_context(request()).numbers_request,
                                              fixture_fields=main.FIXTURE["fields"])
        row = next(r for r in payload["provenance"] if r["metric"] == "rain_total")
        rain = box.evidence["rain_total"]
        self.assertEqual(rain.value, row["value"])
        self.assertEqual(rain.unit, "mm")
        self.assertEqual(rain.source, row["source"])
        self.assertIn("power.larc.nasa.gov", rain.source)
        self.assertEqual(rain.period.model_dump(), {"start": "2026-10-01", "end": "2026-11-11"})
        self.assertEqual(rain.fieldId, FIELD)
        self.assertIn("historical_not_forecast", rain.limitations)
        self.assertEqual(box.evidence["rain_percentile"].basis, "derived")

    def test_the_rain_distribution_adds_up_to_the_block_6_total(self) -> None:
        box = self.toolbox()
        box.get_environmental_indicators()
        weeks = [box.evidence[f"rain_week.{i}"].value for i in range(1, 7)]
        self.assertTrue(all(isinstance(w, float) for w in weeks))
        self.assertAlmostEqual(sum(weeks), box.evidence["rain_total"].value, delta=0.31)  # six 0.05 roundings
        self.assertIsInstance(box.evidence["rain_wet_days"].value, int)
        self.assertLessEqual(box.evidence["rain_wet_days"].value, 42)
        self.assertTrue(box.evidence["rain_max_day"].asOf.startswith("2026-1"))

    def test_indicators_report_unavailable_when_block_6_is_offline(self) -> None:
        with patch.object(field_numbers, "transport", ReplayTransport(offline=True)):
            box = self.toolbox()
            result = box.get_environmental_indicators()
        if result["available"]:  # block 6 answers with sections in abstention: nothing invented
            values = [box.evidence[m].value for m in ("rain_total", "dry_spell_days") if m in box.evidence]
            self.assertTrue(all(v is None for v in values))
        else:
            self.assertIn("numbers", result["reason"])

    def test_the_numbers_are_read_once_per_run(self) -> None:
        calls = []
        def loader(ctx):
            calls.append(ctx.field_id)
            return field_numbers.build_numbers(ctx.field_id, ctx.numbers_request, fixture_fields=main.FIXTURE["fields"])
        box = ToolBox(resolve_context(request()), loader)
        box.get_environmental_indicators()
        box.get_evidence_gaps()
        box.get_crop_water_demand()
        self.assertEqual(calls, [FIELD])

    def test_crop_water_is_released_for_field_01_and_its_window_only(self) -> None:
        box = self.toolbox()
        result = box.get_crop_water_demand()
        self.assertTrue(result["available"])
        self.assertEqual(box.evidence["crop_water.maize.etc_total"].value, SNAPSHOT["crops_peak_kc"]["maize"]["etc_total_mm"])
        self.assertEqual(box.evidence["crop_water.et0_total"].value, SNAPSHOT["et0"]["total_mm"])
        self.assertEqual(box.evidence["crop_water.highest_peak_demand"].value, "maize")
        self.assertTrue(all(e.basis == "fixture" for k, e in box.evidence.items() if k.startswith("crop_water")))
        self.assertIn("experimental_snapshot", box.evidence["crop_water.et0_total"].limitations)

    def test_crop_water_is_not_attributed_to_a_neighbour_in_the_same_cell_or_another_window(self) -> None:
        self.assertFalse(self.toolbox(field_id="mt-santa-carmem-02").get_crop_water_demand()["available"])
        self.assertFalse(self.toolbox(day="2026-11-01").get_crop_water_demand()["available"])

    def test_planting_constraints_are_unavailable_and_invent_nothing(self) -> None:
        box = self.toolbox()
        result = box.get_planting_constraints()
        self.assertFalse(result["available"])
        self.assertEqual(box.evidence, {})

    def test_gaps_carry_recorded_gaps_and_structural_limits(self) -> None:
        gaps = self.toolbox().get_evidence_gaps()
        self.assertTrue(gaps["recorded_gaps"])
        codes = {item["code"] for item in gaps["structural_limitations"]}
        self.assertTrue({"comparator_not_built", "needs_sowing_date", "historical_not_forecast"} <= codes)


def evidence(eid: str, value: Any = 1.0, field_id: str = FIELD, **kw: Any) -> Evidence:
    return Evidence(id=eid, metric=eid, value=value, unit="mm", source="s", basis="modelled", route="api",
                    fieldId=field_id, period={"start": "2026-10-01", "end": "2026-11-11"}, **kw)


class GuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.known = {"rain_total": evidence("rain_total", limitations=["coarse_cell"]), "hot_days": evidence("hot_days")}

    def answer(self, paragraphs: list[str], ids: list[str] | None = None, status: str = "answered", codes=None):
        return validate({"status": status, "paragraphs": paragraphs, "evidence_ids": ids or [],
                         "limitation_codes": codes or []}, self.known, FIELD)

    def test_placeholders_become_segments_and_limitations_merge(self) -> None:
        result = self.answer(["Choveu {{value:rain_total}} entre {{period:rain_total}} (FAO-56, Sentinel-2)."],
                             codes=["historical_not_forecast"])
        kinds = [s.t for s in result.answer[0]]
        self.assertEqual(kinds, ["text", "value", "text", "period", "text"])
        self.assertEqual([e.id for e in result.evidence], ["rain_total"])
        self.assertEqual(result.limitations, ["historical_not_forecast", "coarse_cell"])

    def test_a_number_written_by_the_model_is_rejected(self) -> None:
        for text in ("Choveu 172 mm.", "It rained {{value:rain_total}}, about 20% above normal.", "Rain was 171,9."):
            with self.assertRaises(GuardRejected) as rejected:
                self.answer([text])
            self.assertEqual(rejected.exception.code, "unverified_number")

    def test_unknown_or_foreign_evidence_is_rejected(self) -> None:
        with self.assertRaises(GuardRejected) as unknown:
            self.answer(["{{value:yield_estimate}}"])
        self.assertEqual(unknown.exception.code, "unknown_evidence")
        self.known["old"] = evidence("old", field_id="mt-santa-carmem-02")
        with self.assertRaises(GuardRejected) as foreign:
            self.answer(["{{value:old}}"])
        self.assertEqual(foreign.exception.code, "evidence_of_another_field")

    def test_recommendations_and_forecasts_are_rejected_in_both_languages(self) -> None:
        for text in ("Recomendo plantar milho.", "You should plant maize.", "A melhor cultura é a soja.",
                     "It will rain next month.", "Vai chover na próxima safra.", "This saves water for you."):
            with self.assertRaises(GuardRejected) as rejected:
                self.answer([text])
            self.assertEqual(rejected.exception.code, "unsupported_claim", text)

    def test_an_answer_without_evidence_cannot_be_answered(self) -> None:
        self.assertEqual(self.answer(["Não há dados suficientes."], status="answered").status, "partial")

    def test_malformed_answers_are_rejected(self) -> None:
        for bad, code in (({"status": "ok"}, "bad_status"),
                          ({"status": "partial", "paragraphs": []}, "bad_paragraphs"),
                          ({"status": "partial", "paragraphs": ["{{value:rain_total"]}, "malformed_placeholder"),
                          ({"status": "partial", "paragraphs": ["x"], "limitation_codes": ["made_up"]}, "unknown_limitation")):
            with self.assertRaises(GuardRejected) as rejected:
                validate(bad, self.known, FIELD)
            self.assertEqual(rejected.exception.code, code)


class AgentTests(Block6Recorded):
    def run_agent(self, provider, req: ChatRequest | None = None, **kw):
        return run(req or request(), provider, **kw)

    def test_no_provider_falls_back_without_touching_block_6(self) -> None:
        def loader(ctx):
            raise AssertionError("block 6 must not be read without a model")
        response = run(request(), None, provider_reason="not_configured", numbers_loader=loader)
        self.assertEqual((response.mode, response.fallback_reason), ("fallback", "llm_not_configured"))

    def test_demo_1_environment_question_in_both_languages_uses_the_same_numbers(self) -> None:
        responses = {}
        for locale, text in (("pt-BR", "Na janela de {{period:rain_total}} choveu {{value:rain_total}}, com "
                                       "{{value:hot_days}} acima de trinta e cinco graus."),
                             ("en", "Over {{period:rain_total}} it rained {{value:rain_total}}, with "
                                    "{{value:hot_days}} above thirty-five degrees.")):
            provider = ScriptedProvider([use("get_environmental_indicators"),
                                         submit("answered", [text.replace("trinta e cinco graus", "o limite de calor")
                                                             .replace("thirty-five degrees", "the heat threshold")],
                                                ["rain_total", "hot_days"], ["historical_not_forecast"])])
            response = self.run_agent(provider, request(locale=locale))
            self.assertEqual(response.mode, "agent", response.fallback_reason)
            self.assertEqual(response.tools_used, ["get_environmental_indicators"])
            self.assertIn(("Brazilian Portuguese" if locale == "pt-BR" else "English"), provider.calls[0][0])
            responses[locale] = response
        pt, en = responses["pt-BR"], responses["en"]
        self.assertEqual([e.model_dump() for e in pt.evidence], [e.model_dump() for e in en.evidence])
        self.assertEqual(pt.limitations, en.limitations)
        self.assertEqual(pt.status, en.status)

    def test_tool_results_reach_the_model_and_only_the_question_is_sent(self) -> None:
        provider = ScriptedProvider([use("get_environmental_indicators"), ENV_PT])
        self.run_agent(provider)
        first_messages = provider.calls[0][1]
        self.assertEqual(len(first_messages), 1)
        self.assertIn("Quais são as condições", first_messages[0]["content"])
        tool_result = provider.calls[1][1][-1]["content"][0]
        self.assertEqual(tool_result["type"], "tool_result")
        self.assertIn("rain_total", tool_result["content"])

    def test_demo_1_rejects_a_number_the_model_wrote(self) -> None:
        provider = ScriptedProvider([use("get_environmental_indicators"), ENV_PT])
        response = self.run_agent(provider)
        self.assertEqual(response.fallback_reason, "guard_unverified_number")
        self.assertEqual(response.evidence, [])

    def test_demo_2_crop_water_comparison_cites_the_recorded_snapshot(self) -> None:
        provider = ScriptedProvider([use("get_crop_water_demand"), submit("answered", [
            "Resultado experimental gravado: o milho tem ETc de {{value:crop_water.maize.etc_total}} e a soja "
            "{{value:crop_water.soybean.etc_total}}; a maior demanda estimada é de "
            "{{value:crop_water.highest_peak_demand}}.",
            "Chuva menos ETc ({{value:crop_water.maize.rain_minus_etc}}) é uma diferença climática, não irrigação.",
        ], ["crop_water.et0_total"], ["needs_sowing_date"])])
        response = self.run_agent(provider, request("Compare a demanda hídrica estimada do milho e da soja."))
        self.assertEqual(response.mode, "agent", response.fallback_reason)
        values = {e.id: e.value for e in response.evidence}
        self.assertEqual(values["crop_water.maize.etc_total"], SNAPSHOT["crops_peak_kc"]["maize"]["etc_total_mm"])
        self.assertEqual(values["crop_water.highest_peak_demand"], "maize")
        self.assertIn("experimental_snapshot", response.limitations)
        self.assertIn("climatic_difference_not_irrigation", response.limitations)
        self.assertTrue(all(e.basis == "fixture" for e in response.evidence))

    def test_demo_2_on_another_field_has_no_crop_water_evidence_to_cite(self) -> None:
        provider = ScriptedProvider([use("get_crop_water_demand"), submit("answered", [
            "O milho tem ETc de {{value:crop_water.maize.etc_total}}."], [])])
        response = self.run_agent(provider, request("Compare a demanda hídrica", field_id="mt-santa-carmem-02"))
        self.assertEqual(response.fallback_reason, "guard_unknown_evidence")

    def test_demo_3_a_crop_recommendation_is_refused_by_the_guard(self) -> None:
        provider = ScriptedProvider([use("get_crop_water_demand", "get_planting_constraints"),
                                     submit("answered", ["Recomendo plantar milho nesta safra."], [])])
        response = self.run_agent(provider, request("Com esses dados, qual cultura devo plantar?"))
        self.assertEqual((response.mode, response.fallback_reason), ("fallback", "guard_unsupported_claim"))

    def test_demo_3_an_answer_that_names_the_limits_passes_as_partial(self) -> None:
        provider = ScriptedProvider([use("get_evidence_gaps", "get_planting_constraints", "get_crop_water_demand"),
                                     submit("partial", [
                                         "Esses dados não bastam para escolher uma cultura: o comparador de rotações "
                                         "e o calendário de plantio não estão disponíveis, e não há registros da "
                                         "propriedade.",
                                         "O que existe é a demanda hídrica estimada, que é maior para "
                                         "{{value:crop_water.highest_peak_demand}} com coeficientes de pico.",
                                     ], ["crop_water.highest_peak_demand"],
                                         ["comparator_not_built", "planting_calendar_not_integrated", "needs_farm_records"])])
        response = self.run_agent(provider, request("Com esses dados, qual cultura devo plantar?"))
        self.assertEqual((response.mode, response.status), ("agent", "partial"))
        self.assertEqual(response.tools_used, ["get_evidence_gaps", "get_planting_constraints", "get_crop_water_demand"])
        self.assertIn("comparator_not_built", response.limitations)

    def test_provider_failures_fall_back_without_leaking_details(self) -> None:
        for error, code in ((ProviderError("provider_unreachable"), "provider_unreachable"),
                            (RuntimeError("secret path C:/x token=abc"), "provider_error")):
            response = self.run_agent(ScriptedProvider([error]))
            self.assertEqual(response.fallback_reason, code)
            self.assertNotIn("secret", json.dumps(response.model_dump()))

    def test_refusal_end_turn_and_unknown_tools(self) -> None:
        self.assertEqual(self.run_agent(ScriptedProvider([ProviderTurn("refusal")])).fallback_reason, "provider_refusal")
        self.assertEqual(self.run_agent(ScriptedProvider([ProviderTurn("end_turn", text="hi")])).fallback_reason,
                         "no_answer")
        provider = ScriptedProvider([use("run_shell"), ENV_PT])
        response = self.run_agent(provider)
        result = provider.calls[1][1][-1]["content"][0]
        self.assertTrue(result["is_error"])
        self.assertEqual(response.tools_used, [])

    def test_limits_on_tool_calls_turns_and_time(self) -> None:
        many = ScriptedProvider([use(*["get_field_context"] * 9)])
        self.assertEqual(self.run_agent(many).fallback_reason, "tool_limit")
        loop = ScriptedProvider([use("get_field_context")] * 5)
        self.assertEqual(self.run_agent(loop).fallback_reason, "turn_limit")
        ticks = iter([0.0, 100.0, 200.0])
        slow = ScriptedProvider([use("get_field_context"), ENV_PT])
        self.assertEqual(self.run_agent(slow, clock=lambda: next(ticks), limits=Limits(total_seconds=10)).fallback_reason,
                         "deadline")

    def test_an_invalid_provider_answer_falls_back(self) -> None:
        provider = ScriptedProvider([ProviderTurn("tool_use", [ToolCall("x", "submit_answer", {"status": "great"})])])
        self.assertEqual(self.run_agent(provider).fallback_reason, "guard_bad_status")


class ProviderTests(unittest.TestCase):
    def test_off_by_default_and_never_reads_ambient_credentials(self) -> None:
        self.assertEqual(provider_config({}).reason, "not_configured")
        self.assertEqual(provider_config({"ANTHROPIC_API_KEY": "k", "ANTHROPIC_BASE_URL": "u"}).reason, "not_configured")
        self.assertEqual(provider_config({"FIELD_SHIFT_AI_PROVIDER": "anthropic"}).reason, "missing_key")
        self.assertEqual(provider_config({"FIELD_SHIFT_AI_PROVIDER": "acme", "FIELD_SHIFT_AI_API_KEY": "k"}).reason,
                         "unknown_provider")
        self.assertIsNone(provider_from_env({}))

    def test_the_anthropic_adapter_parses_tool_calls_and_maps_errors(self) -> None:
        provider = provider_from_env({"FIELD_SHIFT_AI_PROVIDER": "anthropic", "FIELD_SHIFT_AI_API_KEY": "test-key"})
        self.assertIsInstance(provider, AnthropicProvider)
        import anthropic

        class Block:
            def __init__(self, **kw):
                self.__dict__.update(kw)

        class FakeMessages:
            def __init__(self):
                self.kwargs = None
            def create(self, **kwargs):
                self.kwargs = kwargs
                return Block(stop_reason="tool_use", content=[
                    Block(type="thinking", thinking=""), Block(type="text", text="Reading."),
                    Block(type="tool_use", id="tu_1", name="get_field_context", input={})])

        fake = FakeMessages()
        provider._client = Block(beta=Block(messages=fake))
        turn = provider.run_turn("sys", [{"role": "user", "content": "q"}], [{"name": "t"}])
        self.assertEqual((turn.stop_reason, turn.tool_calls[0].name, turn.text), ("tool_use", "get_field_context", "Reading."))
        self.assertEqual(fake.kwargs["model"], "claude-opus-5-5")
        self.assertEqual(fake.kwargs["output_config"], {"effort": "medium"})
        self.assertNotIn("thinking", fake.kwargs)

        class Failing:
            def create(self, **kwargs):
                raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://example.invalid"))
        provider._client = Block(beta=Block(messages=Failing()))
        with self.assertRaises(ProviderError) as failed:
            provider.run_turn("sys", [], [])
        self.assertEqual(failed.exception.code, "provider_unreachable")


class RouteTests(Block6Recorded):
    def setUp(self) -> None:
        super().setUp()
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        main.app.dependency_overrides.clear()
        super().tearDown()

    def post(self, **body: Any):
        payload = {"field_id": FIELD, "locale": "en", "question": "What are the conditions?", "date": DATE, **body}
        return self.client.post("/experimental/field-shift-ai/chat", json=payload)

    def test_status_reports_the_mode_and_never_a_secret(self) -> None:
        with patch.dict("os.environ", {"FIELD_SHIFT_AI_PROVIDER": "anthropic", "FIELD_SHIFT_AI_API_KEY": "sk-test-123"}):
            body = self.client.get("/experimental/field-shift-ai/status").json()
        self.assertTrue(body["llm_enabled"])
        self.assertNotIn("sk-test-123", json.dumps(body))
        with patch.dict("os.environ", {"FIELD_SHIFT_AI_PROVIDER": ""}):
            self.assertFalse(self.client.get("/experimental/field-shift-ai/status").json()["llm_enabled"])

    def test_chat_validates_its_input(self) -> None:
        self.assertEqual(self.post(field_id="nowhere-01").status_code, 404)
        self.assertEqual(self.post(locale="fr").status_code, 422)
        self.assertEqual(self.post(question="x" * 501).status_code, 422)
        self.assertEqual(self.post(field_id="../etc").status_code, 422)
        self.assertEqual(self.post(extra="field").status_code, 422)
        self.assertEqual(self.post(field_id="trazo:12").json()["fallback_reason"], "ring_missing")

    def test_chat_returns_the_agent_answer_with_verified_evidence(self) -> None:
        provider = ScriptedProvider([use("get_environmental_indicators"), submit("answered", [
            "It rained {{value:rain_total}} over {{period:rain_total}}."], ["rain_total"])])
        main.app.dependency_overrides[get_provider] = lambda: (provider, None)
        body = self.post().json()
        self.assertEqual((body["mode"], body["status"], body["field_id"]), ("agent", "answered", FIELD))
        self.assertEqual(body["answer"][0][1], {"t": "value", "text": None, "evidence": "rain_total"})
        self.assertEqual(body["evidence"][0]["unit"], "mm")

    def test_chat_without_a_model_is_a_fallback(self) -> None:
        main.app.dependency_overrides[get_provider] = lambda: (None, "not_configured")
        body = self.post().json()
        self.assertEqual((body["mode"], body["fallback_reason"]), ("fallback", "llm_not_configured"))


if __name__ == "__main__":
    unittest.main()
