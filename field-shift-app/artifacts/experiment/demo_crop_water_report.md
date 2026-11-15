# Demonstração reproduzível: demanda hídrica por cultura

> Experimento científico isolado. `P - ETc` é uma diferença climática simplificada, não um déficit de irrigação, balanço de água no solo, medição de estresse, previsão de produtividade ou estimativa de economia.

## Entrada e cobertura

- Ponto: -11.91, -55.27; elevação 354.49 m.
- Período: 2026-10-01 a 2026-11-11 (42 dias).
- Fonte: NASA POWER Daily Point API, community AG; base `modelled`; tempo `LST`.
- Precipitação acumulada: **171.9 mm**.
- ET0: **197.6 mm**, média **4.71 mm/dia**.
- Métodos: 40 dias Penman–Monteith, 2 Hargreaves, 0 indisponíveis.

Dias de fallback: 2026-11-05 (missing or invalid ALLSKY_SFC_SW_DWN), 2026-11-11 (missing or invalid ALLSKY_SFC_SW_DWN).

## Método utilizado por dia

| Data | ET0 (mm/dia) | Método | Motivo/observação |
|---|---:|---|---|
| 2026-10-01 | 5.0054 | penman-monteith | — |
| 2026-10-02 | 3.7683 | penman-monteith | — |
| 2026-10-03 | 4.3887 | penman-monteith | — |
| 2026-10-04 | 4.475 | penman-monteith | — |
| 2026-10-05 | 4.2923 | penman-monteith | — |
| 2026-10-06 | 4.0947 | penman-monteith | — |
| 2026-10-07 | 5.2022 | penman-monteith | — |
| 2026-10-08 | 5.7686 | penman-monteith | — |
| 2026-10-09 | 5.5141 | penman-monteith | — |
| 2026-10-10 | 5.2047 | penman-monteith | — |
| 2026-10-11 | 2.9071 | penman-monteith | — |
| 2026-10-12 | 5.3788 | penman-monteith | — |
| 2026-10-13 | 5.5081 | penman-monteith | — |
| 2026-10-14 | 4.7184 | penman-monteith | — |
| 2026-10-15 | 1.5052 | penman-monteith | — |
| 2026-10-16 | 4.8282 | penman-monteith | — |
| 2026-10-17 | 5.3313 | penman-monteith | — |
| 2026-10-18 | 5.0727 | penman-monteith | — |
| 2026-10-19 | 4.0437 | penman-monteith | — |
| 2026-10-20 | 3.7744 | penman-monteith | — |
| 2026-10-21 | 5.4382 | penman-monteith | — |
| 2026-10-22 | 5.5771 | penman-monteith | — |
| 2026-10-23 | 5.5912 | penman-monteith | — |
| 2026-10-24 | 5.8299 | penman-monteith | — |
| 2026-10-25 | 3.3714 | penman-monteith | — |
| 2026-10-26 | 4.7713 | penman-monteith | — |
| 2026-10-27 | 1.8305 | penman-monteith | — |
| 2026-10-28 | 5.0464 | penman-monteith | — |
| 2026-10-29 | 3.7343 | penman-monteith | — |
| 2026-10-30 | 3.7505 | penman-monteith | — |
| 2026-10-31 | 5.0792 | penman-monteith | — |
| 2026-11-01 | 5.4128 | penman-monteith | — |
| 2026-11-02 | 5.1085 | penman-monteith | — |
| 2026-11-03 | 3.9591 | penman-monteith | — |
| 2026-11-04 | 5.8503 | penman-monteith | — |
| 2026-11-05 | 6.5199 | hargreaves | missing or invalid ALLSKY_SFC_SW_DWN |
| 2026-11-06 | 5.7351 | penman-monteith | — |
| 2026-11-07 | 5.4299 | penman-monteith | — |
| 2026-11-08 | 4.0953 | penman-monteith | — |
| 2026-11-09 | 3.5948 | penman-monteith | — |
| 2026-11-10 | 5.5705 | penman-monteith | — |
| 2026-11-11 | 5.567 | hargreaves | missing or invalid ALLSKY_SFC_SW_DWN |

## Comparação quantitativa

| Indicador/cultura | ET ou saída (mm) | P menos saída (mm) | Interpretação |
|---|---:|---:|---|
| Bloco 6: EVLAND | 124.8 | 47.1 | Evaporação modelada da superfície; não é demanda da cultura |
| Soybeans, Kc de pico | 227.3 | -55.4 | Cenário ilustrativo de demanda máxima padrão |
| Maize, field (grain), Kc de pico | 237.2 | -65.2 | Cenário ilustrativo de demanda máxima padrão |
| Cotton, Kc de pico | 227.3 | -55.4 | Cenário ilustrativo de demanda máxima padrão |

## Sensibilidade à fase de desenvolvimento

Hipótese explícita: semeadura em 2026-10-01; estágios 15/15/40/15 dias. Não é observação local.

| Cultura | ETc com Kc de pico (mm) | ETc com curva (mm) | Curva menos pico (mm) |
|---|---:|---:|---:|
| Soybeans | 227.3 | 151.3 | -76.0 |
| Maize, field (grain) | 237.2 | 146.0 | -91.2 |
| Cotton | 227.3 | 146.3 | -81.0 |

## Hipóteses

- O fluxo de calor no solo G é zero, como admite a FAO-56 para o passo diário.
- Os Kc simples da Tabela 12 descrevem culturas sem estresse, bem manejadas e em clima padrão.
- Os valores de Kc não foram ajustados pelas equações 62 ou 65 da FAO-56.
- Hargreaves é usado somente quando uma entrada auxiliar de Penman–Monteith está ausente ou inválida.
- A mesma célula POWER representa os campos fixture; o experimento diferencia culturas, não talhões.

## Limitações

- Não há armazenamento no solo, escoamento, drenagem, ascensão capilar, irrigação, profundidade radicular, TAW, RAW ou Ks.
- Não há calibração local de Kc, validação de campo, coeficiente de estresse ou resposta de produtividade.
- As durações de estágio e a semeadura são ilustrativas e não podem ser apresentadas como dados do produtor.
- P - ETc é diferença climática simplificada, não déficit de irrigação nem prova de estresse.
- Hargreaves é empírico e menos informativo que Penman–Monteith nos dias de fallback.
- A grade POWER é mais grosseira que um talhão e os valores diários usam Local Solar Time.

## Critérios de abstenção

- Sem dia válido de precipitação no lookback de 120 dias: não há janela.
- Tmax ou Tmin ausente/inválida: ET0 indisponível no dia.
- Cobertura de ET0/ETc abaixo de 80%: a demanda se abstém.
- Qualquer dia de chuva ou ET0 ausente/inválido: P - ETc se abstém.
- Curva sem semeadura e quatro durações positivas: entrada rejeitada.
- Unidade, tempo, fill value ou ponto incompatível no payload: demonstração se abstém.

## Reprodução

```powershell
cd field-shift-app/artifacts/experiment
python demo_crop_water.py
```

Snapshot ET0 SHA-256: `c753da79c08ae1267a3022685b4cd8e317fd73d30f0e64b20ec1619fd3e0f1c1`  
Snapshot Bloco 6 SHA-256: `133e5bca15988a9f54d1a9c67828f919427635e407258355ba6b77fe55b50cb5`
