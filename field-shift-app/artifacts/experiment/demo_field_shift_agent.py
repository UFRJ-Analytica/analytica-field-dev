"""Field Shift AI agent: the three demonstration questions in Portuguese and English, end to end
through the real HTTP route, offline.

What runs for real: the FastAPI route, input validation, field resolution, the five tools, block 6
(`build_numbers` on its recorded transport, artifacts/block6), the FAO-56 snapshot release rules and the
Evidence Guard. What is SIMULATED: the language model. Its turns (which tools to call, the wording of
the answer) are scripted below, so this validates the contract and the guard, not a model's judgement.
For demo 3 two scripts run: one that tries to recommend a crop (the guard must reject it) and one
that names the limits.

Run: python -I artifacts/experiment/demo_field_shift_agent.py   (from field-shift-app)
Writes agent_demo_results.json beside this file.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402

import field_numbers  # noqa: E402
import main  # noqa: E402
from block6_replay import ReplayTransport  # noqa: E402
from field_shift_agent.provider import ProviderTurn, ToolCall  # noqa: E402
from field_shift_agent.routes import get_provider  # noqa: E402

FIELD, DATE = "mt-santa-carmem-01", "2026-11-12"


class Scripted:
    name = "scripted (simulated model)"

    def __init__(self, turns):
        self.turns = list(turns)

    def run_turn(self, system, messages, tools):
        return self.turns.pop(0)


def use(*names):
    return ProviderTurn("tool_use", [ToolCall(f"c{i}", n, {}) for i, n in enumerate(names)])


def answer(status, paragraphs, ids, codes):
    return ProviderTurn("tool_use", [ToolCall("s", "submit_answer", {
        "status": status, "paragraphs": paragraphs, "evidence_ids": ids, "limitation_codes": codes})])


DEMOS = {
    "1_environment": {
        "pt-BR": ("Quais são as condições ambientais desta propriedade?", [use("get_environmental_indicators"), answer(
            "answered", [
                "Na janela de {{period:rain_total}} choveu {{value:rain_total}}, contra uma mediana histórica de "
                "{{value:rain_median}} para as mesmas datas; a janela ficou no percentil {{value:rain_percentile}}.",
                "Houve {{value:rain_wet_days}} com chuva, a maior sequência seca foi de {{value:dry_spell_days}} e "
                "foram registrados {{value:hot_days}} acima do limite de calor.",
                "A umidade média do solo na zona radicular foi {{value:gwetroot_mean}}. São valores de uma célula de "
                "reanálise que descrevem o passado, não uma previsão."],
            ["rain_total", "rain_median", "rain_percentile", "rain_wet_days", "dry_spell_days", "hot_days", "gwetroot_mean"],
            ["historical_not_forecast"])]),
        "en": ("What are the environmental conditions of this field?", [use("get_environmental_indicators"), answer(
            "answered", [
                "Over {{period:rain_total}} it rained {{value:rain_total}}, against a historical median of "
                "{{value:rain_median}} for the same dates; the window sits at percentile {{value:rain_percentile}}.",
                "There were {{value:rain_wet_days}} with rain, the longest dry spell lasted {{value:dry_spell_days}}, "
                "and {{value:hot_days}} were above the heat threshold.",
                "Mean root-zone soil wetness was {{value:gwetroot_mean}}. These values come from a reanalysis cell and "
                "describe the past, not a forecast."],
            ["rain_total", "rain_median", "rain_percentile", "rain_wet_days", "dry_spell_days", "hot_days", "gwetroot_mean"],
            ["historical_not_forecast"])]),
    },
    "2_crop_water": {
        "pt-BR": ("Compare a demanda hídrica estimada do milho e da soja.", [use("get_crop_water_demand"), answer(
            "answered", [
                "Resultado experimental gravado (FAO-56) para {{period:crop_water.et0_total}}: evapotranspiração de "
                "referência (ET0) de {{value:crop_water.et0_total}}.",
                "Com coeficientes de pico, o milho tem ETc de {{value:crop_water.maize.etc_total}} e a soja "
                "{{value:crop_water.soybean.etc_total}}; a maior demanda estimada é de "
                "{{value:crop_water.highest_peak_demand}}.",
                "Chuva menos ETc ({{value:crop_water.maize.rain_minus_etc}} para o milho e "
                "{{value:crop_water.soybean.rain_minus_etc}} para a soja) é uma diferença climática, não uma "
                "necessidade de irrigação."],
            [], ["needs_sowing_date"])]),
        "en": ("Compare the estimated water demand of corn and soybean.", [use("get_crop_water_demand"), answer(
            "answered", [
                "Recorded experimental result (FAO-56) for {{period:crop_water.et0_total}}: reference "
                "evapotranspiration (ET0) of {{value:crop_water.et0_total}}.",
                "At peak coefficients, maize has an ETc of {{value:crop_water.maize.etc_total}} and soybean "
                "{{value:crop_water.soybean.etc_total}}; the highest estimated demand is for "
                "{{value:crop_water.highest_peak_demand}}.",
                "Rain minus ETc ({{value:crop_water.maize.rain_minus_etc}} for maize and "
                "{{value:crop_water.soybean.rain_minus_etc}} for soybean) is a climatic difference, not an "
                "irrigation requirement."],
            [], ["needs_sowing_date"])]),
    },
    "3_which_crop_rejected": {
        "pt-BR": ("Com esses dados, qual cultura devo plantar?", [use("get_crop_water_demand"), answer(
            "answered", ["Recomendo plantar soja, que usa menos água."], [], [])]),
        "en": ("With this data, which crop should I plant?", [use("get_crop_water_demand"), answer(
            "answered", ["You should plant soybean because it uses less water."], [], [])]),
    },
    "3_which_crop_limits": {
        "pt-BR": ("Com esses dados, qual cultura devo plantar?", [
            use("get_evidence_gaps", "get_planting_constraints", "get_crop_water_demand"), answer(
                "partial", [
                    "Esses dados não bastam para escolher uma cultura. O comparador de rotações e o calendário de "
                    "plantio não estão disponíveis, e não há data de semeadura, histórico, preços nem custos.",
                    "O que existe é uma estimativa gravada de demanda hídrica, maior para "
                    "{{value:crop_water.highest_peak_demand}} com coeficientes de pico; isso sozinho não decide uma "
                    "cultura."],
                ["crop_water.highest_peak_demand"],
                ["comparator_not_built", "planting_calendar_not_integrated", "needs_farm_records", "needs_sowing_date"])]),
        "en": ("With this data, which crop should I plant?", [
            use("get_evidence_gaps", "get_planting_constraints", "get_crop_water_demand"), answer(
                "partial", [
                    "These data are not enough to choose a crop. The rotation comparator and the planting calendar "
                    "are not available, and there is no sowing date, history, prices or costs.",
                    "What exists is a recorded estimate of water demand, highest for "
                    "{{value:crop_water.highest_peak_demand}} at peak coefficients; that alone does not decide a crop."],
                ["crop_water.highest_peak_demand"],
                ["comparator_not_built", "planting_calendar_not_integrated", "needs_farm_records", "needs_sowing_date"])]),
    },
}


def main_run() -> dict:
    results: dict = {"simulated_model": True, "field_id": FIELD, "date": DATE,
                     "note": "Model turns are scripted; tools, block 6 (recorded), FAO-56 snapshot and Evidence Guard ran for real.",
                     "demos": {}}
    with TemporaryDirectory() as cache, TemporaryDirectory() as sidecar, \
            patch.object(field_numbers, "CACHE_DIR", Path(cache)), \
            patch.object(field_numbers, "clock", lambda: datetime(2026, 11, 15, 3, 0, tzinfo=timezone.utc)), \
            patch.object(field_numbers, "MAPBIOMAS_DB", Path(sidecar) / "none.sqlite"), \
            patch.object(field_numbers, "transport", ReplayTransport()):
        client = TestClient(main.app)
        for demo, locales in DEMOS.items():
            results["demos"][demo] = {}
            for locale, (question, turns) in locales.items():
                main.app.dependency_overrides[get_provider] = lambda turns=turns: (Scripted(turns), None)
                body = client.post("/experimental/field-shift-ai/chat", json={
                    "field_id": FIELD, "locale": locale, "question": question, "date": DATE}).json()
                results["demos"][demo][locale] = {
                    "question": question, "mode": body["mode"], "status": body["status"],
                    "fallback_reason": body["fallback_reason"], "tools_used": body["tools_used"],
                    "evidence": {e["id"]: [e["value"], e["unit"], e["basis"]] for e in body["evidence"]},
                    "limitations": body["limitations"],
                    "answer_segments": sum(len(p) for p in body["answer"]),
                }
        main.app.dependency_overrides.clear()
    return results


if __name__ == "__main__":
    out = main_run()
    (HERE / "agent_demo_results.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    for demo, locales in out["demos"].items():
        pt, en = locales["pt-BR"], locales["en"]
        same = pt["evidence"] == en["evidence"] and pt["limitations"] == en["limitations"] and pt["status"] == en["status"]
        print(f"{demo:24s} pt={pt['mode']}/{pt['status']}/{pt['fallback_reason']} "
              f"en={en['mode']}/{en['status']}/{en['fallback_reason']} same_evidence={same} tools={pt['tools_used']}")
        for key, value in pt["evidence"].items():
            print(f"    {key:38s} {value}")
