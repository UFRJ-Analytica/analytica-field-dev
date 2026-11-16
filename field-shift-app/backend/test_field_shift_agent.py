"""Field Shift AI agent (experiment): tools, Evidence Guard, orchestrator, provider and routes.

No test calls a real model or the network: block 6 runs on its recorded transport (block6_replay) and
the model is a scripted provider whose turns are written here.
"""

from __future__ import annotations

import json
import os
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
from field_shift_agent.provider import (AnthropicProvider, OpenAIProvider, ProviderError, ProviderTurn, ToolCall,
                                        provider_config, provider_from_env)
from field_shift_agent.routes import get_provider

import rate_limit
from field_shift_agent.schemas import ChatRequest, Evidence
from field_shift_agent.tools import ToolBox

FROZEN_NOW = datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)
FIELD = "mt-santa-carmem-01"
DATE = "2026-11-12"  # block 6 window 2026-10-01 to 2026-11-11, the window of the FAO-56 snapshot


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



    def test_crop_water_on_a_united_states_field_names_the_missing_window_and_kc(self) -> None:
        box = self.toolbox(field_id="381825001868504")  # Cass Field 01; the recorded window is October
        result = box.get_crop_water_demand()
        self.assertFalse(result["available"])
        self.assertIn("does not cover the crop's planting window", result["abstained"]["maize"])
        self.assertIn("no FAO-56 Kc", result["abstained"]["spring wheat"])
        self.assertEqual(box.evidence, {})

    def test_crop_water_abstains_for_a_field_outside_the_united_states(self) -> None:
        result = self.toolbox().get_crop_water_demand()  # Santa Carmem, the Brazilian fixture
        self.assertFalse(result["available"])
        self.assertEqual(result["limitations"], ["region_not_supported"])

    def test_rain_is_compared_with_the_median_in_code(self) -> None:
        box = self.toolbox()
        box.get_environmental_indicators()
        rain, median = box.evidence["rain_total"].value, box.evidence["rain_median"].value
        self.assertEqual(box.evidence["rain_vs_median"].value, "below" if rain < median else "above")
        self.assertAlmostEqual(box.evidence["rain_minus_median"].value, round(rain - median, 1), places=6)
        self.assertEqual(box.evidence["rain_minus_median"].basis, "derived")


    def test_planting_windows_match_block_7_table_f(self) -> None:
        # Block 7 spec, Table F (2026/2027, Santa Carmem, window_risk_20 envelope over soils and cycles).
        box = self.toolbox()
        result = box.get_planting_constraints()
        self.assertTrue(result["available"])
        self.assertEqual(result["season"], "2026/2027")
        expected = {"planting.soja.window": ("Soja", "2026-10-01", "2027-01-10", 18, "inside_window"),
                    "planting.milho_1a_safra.window": ("Milho 1ª Safra", "2026-10-01", "2026-12-31", 18, "inside_window"),
                    "planting.milho_2a_safra.window": ("Milho 2ª Safra", "2027-01-01", "2027-03-10", 12, "before_window"),
                    "planting.algodao_herbaceo.window": ("Algodão Herbáceo", "2026-12-21", "2027-02-20", 6, "before_window")}
        self.assertEqual(set(box.evidence), set(expected))
        for window in result["windows"]:
            eid = window["evidence"]["id"]
            crop, start, end, rows, where = expected[eid]
            item = box.evidence[eid]
            self.assertEqual((item.value, item.period.start, item.period.end), (crop, start, end))
            self.assertEqual((window["rows_enveloped"], window["chosen_date_position"]), (rows, where))
            self.assertEqual((item.basis, item.fieldId), ("retrieved", FIELD))
            self.assertIn("zarc_municipal_envelope", item.limitations)
        self.assertIn("Port.202_de_03-07-2026", box.evidence["planting.soja.window"].source)

    def test_planting_windows_follow_the_season_of_the_chosen_date(self) -> None:
        box = self.toolbox(day="2025-12-01")
        self.assertEqual(box.get_planting_constraints()["season"], "2025/2026")
        self.assertEqual(box.evidence["planting.milho_1a_safra.window"].period.start, "2025-10-11")

    def test_a_season_the_snapshot_does_not_hold_invents_nothing(self) -> None:
        box = self.toolbox(day="2028-01-01")
        result = box.get_planting_constraints()
        self.assertEqual((result["available"], result["reason"]), (False, "season_not_held"))
        self.assertEqual(result["held_seasons"], ["2025/2026", "2026/2027"])
        self.assertEqual(box.evidence, {})

    def test_us_fixture_reads_the_seasonless_north_dakota_source(self) -> None:
        box = self.toolbox(field_id="381825001868504", day="2026-05-10")
        result = box.get_planting_constraints()
        self.assertTrue(result["available"])
        corn = box.evidence["planting.corn.window"]
        self.assertEqual((corn.period.start, corn.period.end), ("04-26", "06-04"))
        self.assertIn("seasonless_state_average", corn.limitations)
        self.assertNotIn("planting.canola.window", box.evidence)  # null window in the source stays absent
        self.assertIn({"crop": "Canola", "window": None}, result["windows"])

    def test_a_drawn_polygon_has_no_municipality_and_no_window(self) -> None:
        box = self.toolbox(field_id="trazo:123", ring=[[-55.3, -11.9], [-55.2, -11.9], [-55.2, -11.8], [-55.3, -11.9]],
                           centroid=[-55.25, -11.87])
        self.assertEqual(box.get_planting_constraints()["reason"], "municipality_not_resolved")
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





    def test_milestone_3_rain_comparison_and_planting_window_pass(self) -> None:
        provider = ScriptedProvider([use("get_environmental_indicators", "get_planting_constraints"), submit("answered", [
            "Choveu {{value:rain_vs_median}}: {{value:rain_total}} contra {{value:rain_median}}, "
            "uma diferença de {{value:rain_minus_median}}.",
            "A janela do ZARC para {{value:planting.soja.window}} vai de {{period:planting.soja.window}}, e a data "
            "escolhida está dentro dela; isso diz quando semear tem baixo risco, não garante a safra.",
        ], ["rain_vs_median", "rain_total", "rain_median", "rain_minus_median", "planting.soja.window"],
            ["historical_not_forecast", "planting_window_not_decision"])])
        response = self.run_agent(provider, request("Choveu menos que o normal e quando posso plantar soja?"))
        self.assertEqual((response.mode, response.status), ("agent", "answered"))
        self.assertIn("zarc_municipal_envelope", response.limitations)

    def test_demo_3_a_crop_recommendation_is_refused_by_the_guard(self) -> None:
        provider = ScriptedProvider([use("get_environmental_indicators", "get_planting_constraints"),
                                     submit("answered", ["Recomendo plantar milho nesta safra."], [])])
        response = self.run_agent(provider, request("Com esses dados, qual cultura devo plantar?"))
        self.assertEqual((response.mode, response.fallback_reason), ("fallback", "guard_unsupported_claim"))

    def test_demo_3_an_answer_that_names_the_limits_passes_as_partial(self) -> None:
        provider = ScriptedProvider([use("get_evidence_gaps", "get_planting_constraints",
                                          "get_environmental_indicators"),
                                     submit("partial", [
                                         "Esses dados não bastam para escolher uma cultura: o comparador de rotações "
                                         "não está disponível e não há registros da propriedade.",
                                         "O que existe é a chuva registrada na janela, {{value:rain_total}}, e a "
                                         "janela do ZARC de {{value:planting.soja.window}}, de "
                                         "{{period:planting.soja.window}}, que diz quando semear tem baixo risco, "
                                         "não qual cultura escolher.",
                                     ], ["rain_total", "planting.soja.window"],
                                         ["comparator_not_built", "planting_window_not_decision", "needs_farm_records"])])
        response = self.run_agent(provider, request("Com esses dados, qual cultura devo plantar?"))
        self.assertEqual((response.mode, response.status), ("agent", "partial"))
        self.assertEqual(response.tools_used, ["get_evidence_gaps", "get_planting_constraints",
                                               "get_environmental_indicators"])
        self.assertIn("comparator_not_built", response.limitations)

    def test_consecutive_tool_turns_and_english_follow_up_are_guarded(self) -> None:
        provider = ScriptedProvider([
            use("get_field_context"),
            use("get_evidence_gaps"),
            use("get_environmental_indicators", "get_planting_constraints"),
            submit("partial", [
                "The available evidence is not enough to choose a crop because farm records and a rotation "
                "comparator are missing.",
                "It does show the rain recorded for the window, {{value:rain_total}}, and the planting window "
                "for {{value:planting.soja.window}} ({{period:planting.soja.window}}), but neither is a crop "
                "ranking.",
            ], ["rain_total", "planting.soja.window"],
                ["needs_farm_records", "comparator_not_built", "planting_window_not_decision"]),
        ])
        response = self.run_agent(provider, request("With this information, which crop should I plant?", locale="en"))
        self.assertEqual((response.mode, response.status), ("agent", "partial"))
        self.assertEqual(response.tools_used, ["get_field_context", "get_evidence_gaps",
                                               "get_environmental_indicators", "get_planting_constraints"])
        self.assertEqual(len(provider.calls), 4)

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
        self.assertEqual(provider_config({"FIELD_SHIFT_AI_PROVIDER": "openai"}).reason, "missing_key")
        self.assertEqual(provider_config({"FIELD_SHIFT_AI_PROVIDER": "openai", "OPENAI_API_KEY": "ambient"}).reason,
                         "missing_key")
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

    def test_openai_responses_adapter_uses_stateless_function_calling_and_records_usage(self) -> None:
        provider = provider_from_env({
            "FIELD_SHIFT_AI_PROVIDER": "openai",
            "FIELD_SHIFT_AI_OPENAI_API_KEY": "test-key",
            "FIELD_SHIFT_AI_OPENAI_MODEL": "gpt-6-luna",
        })
        self.assertIsInstance(provider, OpenAIProvider)

        class FakeResponse:
            status_code = 200
            def json(self):
                return {"status": "completed", "output": [
                    {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque"},
                    {"type": "function_call", "call_id": "call_1", "name": "get_field_context",
                     "arguments": "{}", "status": "completed"},
                ], "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
                              "input_tokens_details": {"cached_tokens": 10}}}

        class FakeClient:
            def __init__(self):
                self.path = None
                self.payload = None
            def post(self, path, json):
                self.path, self.payload = path, json
                return FakeResponse()

        fake = FakeClient()
        provider._client.close()
        provider._client = fake
        turn = provider.run_turn("system", [{"role": "user", "content": "question"}], [
            {"name": "get_field_context", "description": "field", "strict": True,
             "input_schema": {"type": "object", "properties": {}, "required": [],
                              "additionalProperties": False}},
        ])
        self.assertEqual((fake.path, turn.stop_reason, turn.tool_calls[0].id),
                         ("responses", "tool_use", "call_1"))
        self.assertEqual(fake.payload["model"], "gpt-6-luna")
        self.assertEqual(fake.payload["reasoning"], {"effort": "medium"})
        self.assertEqual(fake.payload["max_output_tokens"], 4096)
        self.assertFalse(fake.payload["store"])
        self.assertEqual(fake.payload["tools"][0]["type"], "function")
        self.assertEqual(fake.payload["tools"][0]["parameters"]["additionalProperties"], False)
        self.assertEqual(provider.telemetry[0].total_tokens, 120)
        self.assertGreater(provider.telemetry[0].estimated_cost_usd, 0)

    def test_openai_replays_reasoning_and_returns_consecutive_function_outputs_by_call_id(self) -> None:
        provider = OpenAIProvider("test-key", "gpt-6-luna", "medium", 20, None)

        class FakeResponse:
            status_code = 200
            def json(self):
                return {"status": "completed", "output": [
                    {"type": "function_call", "call_id": "call_2", "name": "get_evidence_gaps",
                     "arguments": "{}", "status": "completed"},
                ], "usage": {"input_tokens": 50, "output_tokens": 10, "total_tokens": 60}}

        class FakeClient:
            payload = None
            def post(self, path, json):
                self.payload = json
                return FakeResponse()

        fake = FakeClient()
        provider._client.close()
        provider._client = fake
        prior = [{"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque"},
                 {"type": "function_call", "call_id": "call_1", "name": "get_field_context",
                  "arguments": "{}", "status": "completed"}]
        turn = provider.run_turn("system", [
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": prior},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_1",
                                             "content": "{\"field_id\":\"field-1\"}"}]},
        ], [])
        self.assertEqual(turn.tool_calls[0].name, "get_evidence_gaps")
        self.assertEqual(fake.payload["input"][1], prior[0])
        self.assertEqual(fake.payload["input"][-1], {
            "type": "function_call_output", "call_id": "call_1", "output": "{\"field_id\":\"field-1\"}"})

    def test_openai_maps_errors_rejects_bad_arguments_and_enforces_budget(self) -> None:
        provider = OpenAIProvider("test-key", "gpt-6-luna", "medium", 20, None, budget_usd=0.000001)
        with self.assertRaises(ProviderError) as budget:
            provider.run_turn("system", [{"role": "user", "content": "q"}], [])
        self.assertEqual(budget.exception.code, "provider_budget_exceeded")

        class BadArguments:
            status_code = 200
            def json(self):
                return {"status": "completed", "output": [
                    {"type": "function_call", "call_id": "call_1", "name": "tool", "arguments": "{"}],
                        "usage": {}}
        class FakeClient:
            def post(self, path, json):
                return BadArguments()
        provider = OpenAIProvider("test-key", "gpt-6-luna", "medium", 20, None)
        provider._client.close()
        provider._client = FakeClient()
        with self.assertRaises(ProviderError) as bad:
            provider.run_turn("system", [{"role": "user", "content": "q"}], [])
        self.assertEqual(bad.exception.code, "provider_invalid_tool_arguments")


class RouteTests(Block6Recorded):
    def setUp(self) -> None:
        super().setUp()
        # The chat route is rate limited once a key exists; the class turns it off and the one case
        # that tests it turns it back on, so no other case spends the allowance.
        previous = os.environ.get("FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS")
        os.environ["FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS"] = "0"
        rate_limit.reset()

        def restore() -> None:
            if previous is None:
                os.environ.pop("FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS", None)
            else:
                os.environ["FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS"] = previous

        self.addCleanup(restore)
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

    def test_status_reports_openai_model_and_effort_without_the_key(self) -> None:
        env = {"FIELD_SHIFT_AI_PROVIDER": "openai", "FIELD_SHIFT_AI_OPENAI_API_KEY": "secret-test-key",
               "FIELD_SHIFT_AI_OPENAI_MODEL": "gpt-6-luna", "FIELD_SHIFT_AI_EFFORT": "medium"}
        with patch.dict("os.environ", env, clear=True):
            body = self.client.get("/experimental/field-shift-ai/status").json()
        self.assertEqual((body["provider"], body["model"], body["effort"]), ("openai", "gpt-6-luna", "medium"))
        self.assertNotIn("secret-test-key", json.dumps(body))

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

    def test_chat_is_rate_limited_per_client_and_never_echoes_the_key(self) -> None:
        rate_limit.reset()
        main.app.dependency_overrides[get_provider] = lambda: (None, "not_configured")
        env = {"FIELD_SHIFT_AI_RATE_LIMIT_REQUESTS": "2", "FIELD_SHIFT_AI_RATE_LIMIT_WINDOW_SECONDS": "60",
               "FIELD_SHIFT_AI_PROVIDER": "openai",
               "FIELD_SHIFT_AI_OPENAI_API_KEY": "secret-test-key", "FIELD_SHIFT_AI_BUDGET_USD": "0.10"}
        with patch.dict("os.environ", env):
            first, second, third = self.post(), self.post(), self.post()
            status = self.client.get("/experimental/field-shift-ai/status")
        self.assertEqual([first.status_code, second.status_code, third.status_code], [200, 200, 429])
        self.assertEqual(third.headers["Retry-After"].isdigit(), True)
        for response in (first, second, third, status):
            self.assertNotIn("secret-test-key", response.text)
        self.assertNotIn("secret-test-key", json.dumps(status.json()))

    def test_chat_without_a_model_is_a_fallback(self) -> None:
        main.app.dependency_overrides[get_provider] = lambda: (None, "not_configured")
        body = self.post().json()
        self.assertEqual((body["mode"], body["fallback_reason"]), ("fallback", "llm_not_configured"))


if __name__ == "__main__":
    unittest.main()
