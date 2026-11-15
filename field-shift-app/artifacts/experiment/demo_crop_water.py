"""Offline, reproducible crop-water demonstration over recorded NASA POWER responses.

Run from any directory with Python 3.13. It performs no network request and writes the JSON and
Markdown files beside this script. The climatic difference P - ETc is not an irrigation deficit,
soil-water balance, stress measurement, yield forecast, or estimate of water savings.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parent.parent
BACKEND = APP_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import aggregates as agg  # noqa: E402
import crop_water as cw  # noqa: E402
from sources import power, power_et0  # noqa: E402

ET0_SNAPSHOT = HERE / "power-et0-inputs-2026-07-01-2026-11-14.json"
BLOCK6_SNAPSHOT = APP_ROOT / "artifacts" / "block6" / "power-climate-2026-07-01-2026-11-14.json"
JSON_OUTPUT = HERE / "demo_crop_water_results.json"
MARKDOWN_OUTPUT = HERE / "demo_crop_water_report.md"

REFERENCE_START = date(2026, 10, 1)
REFERENCE_END = date(2026, 11, 11)
CHOSEN_DATE = date(2026, 11, 14)
ILLUSTRATIVE_SOWING = REFERENCE_START
ILLUSTRATIVE_STAGES = (15, 15, 40, 15)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _window_coverage(series: dict[str, dict[date, float]], window: agg.Window) -> dict[str, Any]:
    days = agg.window_days(window)
    result: dict[str, Any] = {}
    for name in power_et0.PARAMETERS:
        valid = sum(1 for day in days if agg.is_valid(series.get(name, {}).get(day)))
        result[name] = {
            "valid_days": valid,
            "window_days": window.days,
            "percent": agg.round_half_up(100.0 * valid / window.days, 1),
        }
    return result


def _sum_complete(series: dict[str, dict[date, float]], name: str, window: agg.Window) -> float | None:
    values = [series.get(name, {}).get(day) for day in agg.window_days(window)]
    if not all(agg.is_valid(value) and value >= 0 for value in values):
        return None
    return agg.round_half_up(sum(values), 1)


def _crop_summary(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "crop_id": result["crop_id"],
        "crop": result["crop"],
        "state": result["state"],
        "reason": result["reason"],
        "kc_mode": result["kc_mode"],
        "kc_source": result["kc_source"],
        "kc_values": {
            "initial": cw.CROPS[result["crop_id"]]["kc_ini"],
            "mid": cw.CROPS[result["crop_id"]]["kc_mid"],
            "end": cw.CROPS[result["crop_id"]]["kc_end"],
        },
        "valid_days": result["valid_days"],
        "et0_total_mm": result["et0_total"],
        "etc_total_mm": result["etc_total"],
        "rain_total_mm": result["rain_total"],
        "rain_minus_etc_mm": result["climatic_difference"],
        "statement": result["statement"],
    }


def build_results() -> dict[str, Any]:
    payload = _read_json(ET0_SNAPSHOT)
    payload_issues = power_et0.validate_payload(payload)
    series = power_et0.parse(payload)
    longitude, latitude, elevation = power_et0.point(payload)
    window = agg.resolve_window(series["PRECTOTCORR"], CHOSEN_DATE)
    if window is None:
        raise RuntimeError("abstained: no valid precipitation day within the configured lookback")
    if window.start != REFERENCE_START or window.end != REFERENCE_END:
        raise RuntimeError(f"abstained: resolved window {window.start}..{window.end} differs from reference")
    if payload_issues:
        raise RuntimeError("abstained: POWER payload validation failed: " + "; ".join(payload_issues))

    daily = cw.daily_et0(series, latitude=latitude, elevation=elevation, window=window)
    valid_et0 = [row["et0"] for row in daily if row["et0"] is not None]
    if len(valid_et0) != window.days:
        raise RuntimeError(f"abstained: ET0 exists on {len(valid_et0)} of {window.days} days")

    peak: dict[str, dict[str, Any]] = {}
    curve: dict[str, dict[str, Any]] = {}
    for crop_id in cw.CROPS:
        peak[crop_id] = _crop_summary(cw.crop_water(
            series, latitude=latitude, elevation=elevation, window=window, crop_id=crop_id,
        ))
        curve[crop_id] = _crop_summary(cw.crop_water(
            series, latitude=latitude, elevation=elevation, window=window, crop_id=crop_id,
            sowing=ILLUSTRATIVE_SOWING, stages=ILLUSTRATIVE_STAGES,
        ))

    block6_payload = _read_json(BLOCK6_SNAPSHOT)
    block6_series = power.parse(block6_payload)
    block6_point = tuple(float(value) for value in block6_payload["geometry"]["coordinates"][:3])
    if block6_point != (longitude, latitude, elevation):
        raise RuntimeError(f"abstained: Block 6 point {block6_point} does not match ET0 point")
    rain_total = _sum_complete(series, "PRECTOTCORR", window)
    block6_rain = _sum_complete(block6_series, "PRECTOTCORR", window)
    evland_total = _sum_complete(block6_series, "EVLAND", window)
    if rain_total is None or block6_rain != rain_total or evland_total is None:
        raise RuntimeError("abstained: Block 6 comparison needs complete, matching rain and EVLAND")

    pm_days = [row["date"] for row in daily if row["method"] == "penman-monteith"]
    fallback_rows = [row for row in daily if row["method"] == "hargreaves"]
    unavailable_rows = [row for row in daily if row["method"] is None]

    results: dict[str, Any] = {
        "experiment": "Field Shift experimental crop water demand, FAO-56",
        "reproducibility": {
            "network_used": False,
            "python": "3.13 compatible, standard library plus project modules",
            "et0_snapshot": str(ET0_SNAPSHOT.relative_to(APP_ROOT)).replace("\\", "/"),
            "et0_snapshot_sha256": _sha256(ET0_SNAPSHOT),
            "block6_snapshot": str(BLOCK6_SNAPSHOT.relative_to(APP_ROOT)).replace("\\", "/"),
            "block6_snapshot_sha256": _sha256(BLOCK6_SNAPSHOT),
            "power_api_version": payload.get("header", {}).get("api", {}).get("version"),
            "time_standard": payload.get("header", {}).get("time_standard"),
        },
        "point": {"longitude": longitude, "latitude": latitude, "elevation_m": elevation,
                  "place": "Santa Carmem, Mato Grosso, fixture centroid"},
        "period": {"start": window.start.isoformat(), "end": window.end.isoformat(),
                   "days": window.days, "chosen_date": CHOSEN_DATE.isoformat()},
        "source": {
            "name": "NASA POWER Daily Point API, community AG",
            "basis": "modelled",
            "resolution": cw.RESOLUTION,
            "parameters": list(power_et0.PARAMETERS),
            "units": power_et0.UNITS,
            "payload_validation_issues": payload_issues,
        },
        "coverage": _window_coverage(series, window),
        "precipitation": {"total_mm": rain_total},
        "et0": {
            "total_mm": agg.round_half_up(sum(valid_et0), 1),
            "mean_mm_day": agg.round_half_up(sum(valid_et0) / len(valid_et0), 2),
            "minimum_mm_day": agg.round_half_up(min(valid_et0), 2),
            "maximum_mm_day": agg.round_half_up(max(valid_et0), 2),
            "method_counts": {"penman-monteith": len(pm_days), "hargreaves": len(fallback_rows),
                              "unavailable": len(unavailable_rows)},
            "penman_monteith_days": pm_days,
            "fallback_days": [{"date": row["date"], "reason": row["reason"]} for row in fallback_rows],
            "unavailable_days": [{"date": row["date"], "reason": row["reason"]}
                                 for row in unavailable_rows],
            "daily": [{"date": row["date"], "et0_mm": (None if row["et0"] is None else
                                                          agg.round_half_up(row["et0"], 4)),
                       "method": row["method"], "reason": row["reason"]} for row in daily],
        },
        "block6_comparison": {
            "indicator": "sum(PRECTOTCORR) - sum(EVLAND)",
            "rain_total_mm": rain_total,
            "evland_total_mm": evland_total,
            "rain_minus_evland_mm": agg.round_half_up(rain_total - evland_total, 1),
            "meaning": "EVLAND is modelled land-surface evaporation, not crop water demand.",
        },
        "crops_peak_kc": peak,
        "crops_stage_curve": curve,
        "sensitivity": {
            "culture_test": {
                crop_id: {"etc_total_mm": row["etc_total_mm"],
                          "rain_minus_etc_mm": row["rain_minus_etc_mm"]}
                for crop_id, row in peak.items()
            },
            "development_stage_test": {
                crop_id: {
                    "peak_kc_etc_mm": peak[crop_id]["etc_total_mm"],
                    "stage_curve_etc_mm": curve[crop_id]["etc_total_mm"],
                    "curve_minus_peak_mm": agg.round_half_up(
                        curve[crop_id]["etc_total_mm"] - peak[crop_id]["etc_total_mm"], 1),
                }
                for crop_id in peak
            },
        },
        "illustrative_phenology": {
            "sowing_date": ILLUSTRATIVE_SOWING.isoformat(),
            "stage_lengths_days": dict(zip(("initial", "development", "mid", "late"),
                                             ILLUSTRATIVE_STAGES)),
            "status": "explicit illustrative hypothesis, not a field observation or local calibration",
        },
        "assumptions": [
            "O fluxo de calor no solo G é zero, como admite a FAO-56 para o passo diário.",
            "Os Kc simples da Tabela 12 descrevem culturas sem estresse, bem manejadas e em clima padrão.",
            "Os valores de Kc não foram ajustados pelas equações 62 ou 65 da FAO-56.",
            "Hargreaves é usado somente quando uma entrada auxiliar de Penman–Monteith está ausente ou inválida.",
            "A mesma célula POWER representa os campos fixture; o experimento diferencia culturas, não talhões.",
        ],
        "limitations": [
            "Não há armazenamento no solo, escoamento, drenagem, ascensão capilar, irrigação, profundidade radicular, TAW, RAW ou Ks.",
            "Não há calibração local de Kc, validação de campo, coeficiente de estresse ou resposta de produtividade.",
            "As durações de estágio e a semeadura são ilustrativas e não podem ser apresentadas como dados do produtor.",
            "P - ETc é diferença climática simplificada, não déficit de irrigação nem prova de estresse.",
            "Hargreaves é empírico e menos informativo que Penman–Monteith nos dias de fallback.",
            "A grade POWER é mais grosseira que um talhão e os valores diários usam Local Solar Time.",
        ],
        "abstention_criteria": [
            "Sem dia válido de precipitação no lookback de 120 dias: não há janela.",
            "Tmax ou Tmin ausente/inválida: ET0 indisponível no dia.",
            "Cobertura de ET0/ETc abaixo de 80%: a demanda se abstém.",
            "Qualquer dia de chuva ou ET0 ausente/inválido: P - ETc se abstém.",
            "Curva sem semeadura e quatro durações positivas: entrada rejeitada.",
            "Unidade, tempo, fill value ou ponto incompatível no payload: demonstração se abstém.",
        ],
    }
    return results


def _markdown(results: dict[str, Any]) -> str:
    lines = [
        "# Demonstração reproduzível: demanda hídrica por cultura",
        "",
        "> Experimento científico isolado. `P - ETc` é uma diferença climática simplificada, não um déficit de irrigação, balanço de água no solo, medição de estresse, previsão de produtividade ou estimativa de economia.",
        "",
        "## Entrada e cobertura",
        "",
        f"- Ponto: {results['point']['latitude']}, {results['point']['longitude']}; elevação {results['point']['elevation_m']} m.",
        f"- Período: {results['period']['start']} a {results['period']['end']} ({results['period']['days']} dias).",
        f"- Fonte: {results['source']['name']}; base `{results['source']['basis']}`; tempo `{results['reproducibility']['time_standard']}`.",
        f"- Precipitação acumulada: **{results['precipitation']['total_mm']} mm**.",
        f"- ET0: **{results['et0']['total_mm']} mm**, média **{results['et0']['mean_mm_day']} mm/dia**.",
        f"- Métodos: {results['et0']['method_counts']['penman-monteith']} dias Penman–Monteith, {results['et0']['method_counts']['hargreaves']} Hargreaves, {results['et0']['method_counts']['unavailable']} indisponíveis.",
        "",
        "Dias de fallback: " + (", ".join(f"{row['date']} ({row['reason']})" for row in results['et0']['fallback_days']) or "nenhum") + ".",
        "",
        "## Método utilizado por dia",
        "",
        "| Data | ET0 (mm/dia) | Método | Motivo/observação |",
        "|---|---:|---|---|",
    ]
    for row in results["et0"]["daily"]:
        lines.append(f"| {row['date']} | {row['et0_mm'] if row['et0_mm'] is not None else '—'} | {row['method'] or 'indisponível'} | {row['reason'] or '—'} |")
    lines.extend([
        "",
        "## Comparação quantitativa",
        "",
        "| Indicador/cultura | ET ou saída (mm) | P menos saída (mm) | Interpretação |",
        "|---|---:|---:|---|",
        f"| Bloco 6: EVLAND | {results['block6_comparison']['evland_total_mm']} | {results['block6_comparison']['rain_minus_evland_mm']} | Evaporação modelada da superfície; não é demanda da cultura |",
    ])
    for crop_id, row in results["crops_peak_kc"].items():
        lines.append(f"| {row['crop']}, Kc de pico | {row['etc_total_mm']} | {row['rain_minus_etc_mm']} | Cenário ilustrativo de demanda máxima padrão |")
    lines.extend(["", "## Sensibilidade à fase de desenvolvimento", "",
                  "Hipótese explícita: semeadura em 2026-10-01; estágios 15/15/40/15 dias. Não é observação local.", "",
                  "| Cultura | ETc com Kc de pico (mm) | ETc com curva (mm) | Curva menos pico (mm) |",
                  "|---|---:|---:|---:|"])
    for crop_id, row in results["sensitivity"]["development_stage_test"].items():
        lines.append(f"| {results['crops_peak_kc'][crop_id]['crop']} | {row['peak_kc_etc_mm']} | {row['stage_curve_etc_mm']} | {row['curve_minus_peak_mm']} |")
    lines.extend(["", "## Hipóteses", ""] + [f"- {item}" for item in results["assumptions"]])
    lines.extend(["", "## Limitações", ""] + [f"- {item}" for item in results["limitations"]])
    lines.extend(["", "## Critérios de abstenção", ""] + [f"- {item}" for item in results["abstention_criteria"]])
    lines.extend(["", "## Reprodução", "", "```powershell",
                  "cd field-shift-app/artifacts/experiment", "python demo_crop_water.py", "```", "",
                  f"Snapshot ET0 SHA-256: `{results['reproducibility']['et0_snapshot_sha256']}`  ",
                  f"Snapshot Bloco 6 SHA-256: `{results['reproducibility']['block6_snapshot_sha256']}`", ""])
    return "\n".join(lines)


def main() -> None:
    results = build_results()
    JSON_OUTPUT.write_text(json.dumps(results, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                           encoding="utf-8")
    MARKDOWN_OUTPUT.write_text(_markdown(results), encoding="utf-8")
    print(f"wrote {JSON_OUTPUT}")
    print(f"wrote {MARKDOWN_OUTPUT}")
    print(f"rain={results['precipitation']['total_mm']} mm; ET0={results['et0']['total_mm']} mm")
    for crop_id, row in results["crops_peak_kc"].items():
        print(f"{crop_id}: ETc={row['etc_total_mm']} mm; P-ETc={row['rain_minus_etc_mm']} mm")


if __name__ == "__main__":
    main()
