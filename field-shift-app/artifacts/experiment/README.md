# Experimento: demanda hídrica por cultura (FAO-56) a partir do NASA POWER

Branch `experiment/nasa-decision-engine`, sobre `main` em `153e50b`. **Isto não é um bloco com spec congelada** (ADR 0005). É evidência para avaliar as lacunas registradas em block 6 OD-02 e CO-B6-07 e em block 8 CO-B8-10. Na revisão atual do comparador, M-06 trata dos cenários dos Estados Unidos e M-08 da unidade de break-even; portanto, as antigas citações hídricas a esses dois achados foram retiradas.

## O que foi adicionado

Só arquivos novos. Nenhum arquivo existente foi modificado.

| Arquivo | Papel |
|---|---|
| `backend/crop_water.py` | Funções puras: ET0 Penman-Monteith (FAO-56 eq. 6), Hargreaves (eq. 52) como fallback por dia, curva de Kc (eq. 66), ETc = Kc × ET0 e diferença climática `P - ETc` |
| `backend/sources/power_et0.py` | URL e parse dos parâmetros POWER da ET0. Reutiliza `sources.power` do Bloco 6 |
| `backend/test_crop_water.py` | 36 testes: oráculos FAO-56, regras de janela, domínio físico, cobertura e resposta gravada |
| `artifacts/experiment/power-et0-inputs-2026-07-01-2026-11-14.json` | Resposta POWER gravada em 2026-11-15, no centroide −55,27, −11,91 (Santa Carmem, MT), community AG |

Reaproveita do Bloco 6: `aggregates.Window`, `resolve_window` (janela de 42 dias), `covered` (80%, R-19), `round_half_up`, `is_valid` e `power.parse` (descarta o −999). As linhas de proveniência seguem o formato das linhas de `field_numbers._row`.

## Regras

- **ET0 por dia.** Usa Penman-Monteith quando há radiação, vento e umidade (o ponto de orvalho tem prioridade sobre a RH média). Sem esses dados, usa Hargreaves. Sem as duas temperaturas, o dia fica sem valor.
- **Totais de ET0 e ETc.** Abstêm abaixo de 80% de dias válidos.
- **Diferença climática.** `P - ETc` exige todos os dias de chuva e de ET0, como o balanço hídrico do Bloco 6 (R-22). Não é déficit de irrigação nem balanço de água no solo.
- **Kc.** Usa a Tabela 12 da FAO-56 em clima padrão, sem ajuste pela eq. 62. O modo padrão é o Kc de pico (`mid-season`). A curva só é usada quando o chamador informa a data de semeadura **e** as quatro durações de estágio. Nenhuma duração é assumida.
- **Base.** Todas as linhas têm base `modelled`.

## Oráculos FAO-56 e domínio (todos passam)

| Exemplo | Grandeza | Valor esperado | Tolerância |
|---|---|---|---|
| Ex. 2 | P a 1.800 m e γ | 81,8 kPa e 0,054 | 0,05 e 0,0005 |
| Ex. 3 | e°(24,5), e°(15), es | 3,075, 1,705, 2,39 kPa | 3 casas |
| Ex. 5 | ea com Tdew = 17 °C | 1,938 kPa | 3 casas |
| Ex. 8 | Ra a 20°S em 3 de setembro | 32,2 MJ m⁻² d⁻¹ | 0,05 |
| Ex. 18 | Ra, Rso, Rnl, Δ, **ET0** (Bruxelas, 6 de julho) | 41,09, 30,90, 3,71, 0,122, **3,9 mm/d** | ±0,02, ±0,05 |
| Ex. 28 | Kc nos dias 20, 40, 70 e 95 | 0,15, 0,77, 1,19, 0,56 | 2 casas |

Os testes adicionais cobrem polos, clamp do argumento de `acos`, `Rso = 0`, RH fora de 0–100%, vento zero e negativo, temperaturas negativas, `Tmax < Tmin`, `-999`, série incompleta, semeadura fora da janela e durações fenológicas inválidas.

## Resultado em Santa Carmem (janela de 2026-10-01 a 2026-11-11, 42 dias)

Para rodar: `cd backend && python crop_water.py`

- **ET0:** 197,6 mm. Média de 4,71 mm/d, mínimo 1,51, máximo 6,52. Foram 40 dias com Penman-Monteith e 2 com Hargreaves (11-05 e 11-11, quando a radiação veio como −999).
- **Chuva:** 171,9 mm, idêntica à gravação do Bloco 6.

| Cálculo | Saída (mm) | Saldo (mm) |
|---|---|---|
| Bloco 6 hoje: chuva − ΣEVLAND | 124,8 | **+47,1** |
| Soja, Kc de pico | ETc 227,3 | **−55,4** |
| Milho, Kc de pico | ETc 237,2 | **−65,2** |
| Algodão, Kc de pico | ETc 227,3 | **−55,4** |
| Soja, curva a partir de 10-01 (estágios ilustrativos 15/15/40/15) | ETc 151,3 | +20,6 |
| Milho, mesma curva | ETc 146,0 | +25,9 |
| Algodão, mesma curva | ETc 146,3 | +25,6 |

## Achados

1. **O sinal da diferença pode se inverter.** Com `EVLAND`, que é evaporação da superfície e não demanda da cultura, `P - EVLAND` é positivo. Com ETc de pico, `P - ETc` é negativo. Isso quantifica a ressalva da R-24, mas não prova déficit de irrigação nem estresse.
2. **A demanda depende da fase da cultura.** Entre o Kc de pico e a curva a partir da semeadura, o ETc muda cerca de 80 mm. Sem data de semeadura, o número honesto é o de pico, rotulado como tal. A data real viria do calendário ZARC e do histórico declarado do Bloco 7.
3. **A demanda separa culturas onde o percentil de chuva não separa** (milho ≠ soja). Mas soja e algodão compartilham Kc mid = 1,15 (o limite inferior da faixa 1,15–1,20 do algodão). No modo de pico os dois empatam, e só a curva com estágios os separa.
4. **`EVPTRNS / 2,45` dá 27,2 mm na janela,** cerca de 0,65 mm/d. A documentação POWER define `EVPTRNS` como fluxo de energia associado à transpiração modelada; ele não é ET0 nem demanda potencial da cultura.
5. **Achado colateral, não relacionado ao experimento:** `test_field_numbers_sources.MapBiomasReaderTests.test_r36_an_absent_sidecar_file_is_unavailable_with_the_path` falha no Windows, porque espera `/` no caminho. A falha também ocorre na `main` limpa.

## Limitações

- Célula de 0,5° (a radiação vem de 1°). Os três talhões fixture compartilham a mesma célula, então o experimento separa culturas, não talhões.
- Kc genérico da FAO, sem calibração para o Cerrado e sem ajuste climático (eq. 62).
- G = 0 (passo diário) e sem balanço de água no solo (nem TAW/RAW, nem Ks). O déficit é atmosférico, não de estresse.
- As durações de estágio da tabela acima são ilustrativas, não observadas localmente. A data de semeadura e as durações precisam vir do produtor ou de uma fonte aprovada.

## Correções da auditoria independente

- A Equação 66 passou a usar explicitamente dias FAO 1-based; o chamador converte a data de semeadura para dia 1. O comportamento anterior deslocava a curva em um dia.
- Entradas não finitas, latitude/dia inválidos, pressão não positiva, RH fora de 0–100%, vento/radiação negativos, `Tmax < Tmin`, `Rso <= 0` e estágios não positivos não são mais aceitos silenciosamente.
- Um ponto de orvalho inconsistente usa RH válida quando disponível e registra a substituição; caso contrário, o dia usa Hargreaves com motivo explícito.
- O fallback Hargreaves e dias indisponíveis carregam motivo por dia.
- O nome `deficit` foi substituído por `climatic_difference`/`rain_minus_etc`.
- A URL experimental fixa `time-standard=LST`, e o snapshot valida unidades, fill value, coordenadas e convenção temporal.

## Demonstração e proposta

- Execute offline: `python artifacts/experiment/demo_crop_water.py` a partir de `field-shift-app/`.
- Resultado estruturado: `demo_crop_water_results.json`.
- Relatório legível: `demo_crop_water_report.md`.
- Alternativas de contrato e governança: `INTEGRATION_PROPOSAL.md`.

Nenhuma integração, merge, commit, push ou PR faz parte deste marco.

## Fontes primárias consultadas

- FAO Irrigation and Drainage Paper 56, índice e capítulos: https://www.fao.org/4/X0490E/X0490E00.htm
- FAO-56, determinação de ET0 e dados ausentes: https://www.fao.org/4/x0490e/x0490e08.htm
- FAO-56, coeficiente simples Kc, Tabela 12 e Equação 66: https://www.fao.org/4/X0490E/x0490e0b.htm
- NASA POWER Daily API, resolução e convenção temporal: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
- NASA POWER, fontes e significado de EVPTRNS/EVLAND: https://power.larc.nasa.gov/docs/methodology/data/sources_hydrology/
