# Field Shift AI: Marco 2, agente bilíngue com ferramentas científicas

Branch `experiment/nasa-decision-engine`, HEAD `9cb91e6`, alterações **não commitadas**.
**Experimento:** não há spec congelada (ADR 0005), e as rotas ficam sob `/experimental/`.
Princípio: **o LLM interpreta e explica; as ferramentas calculam e fornecem as evidências.**

## 1. Arquitetura

```
Painel (FieldShiftAI.tsx) ──status──▶ GET  /experimental/field-shift-ai/status   (uma vez, ao abrir)
        │  llm_enabled=false ─▶ adaptador determinístico do Marco 1 (nenhuma pergunta vai à rede)
        │  llm_enabled=true  ─▶ POST /experimental/field-shift-ai/chat
        ▼
routes.py ─▶ orchestrator.run()
               ├─ context.resolve_context()  campo validado pelo resolver do Bloco 6
               ├─ provider.run_turn() ⇄ tools.ToolBox (5 ferramentas de leitura)  ≤5 turnos, ≤8 chamadas, ≤45 s
               ├─ submit_answer (ferramenta terminal, schema estrito)
               └─ evidence_guard.validate() ─▶ ChatResponse {segments, evidence, limitations}
        ▼
Painel: o texto vem do modelo; cada valor e cada período são impressos pelo frontend a partir da Evidence
```

| Arquivo (backend, novo) | Papel |
|---|---|
| `field_shift_agent/schemas.py` | `ChatRequest` (`extra="forbid"`, pergunta ≤ 500 caracteres, id com regex), `Evidence`, `Segment`, `ChatResponse`, códigos de limitação |
| `field_shift_agent/context.py` | resolve o campo; a geometria de um campo fixture vem do servidor, nunca do cliente |
| `field_shift_agent/tools.py` | as 5 ferramentas e o registro de evidências da execução |
| `field_shift_agent/evidence_guard.py` | Evidence Guard |
| `field_shift_agent/prompts.py` | prompt de sistema e a ferramenta `submit_answer` |
| `field_shift_agent/provider.py` | interface `Provider` e `AnthropicProvider` (desligado por padrão) |
| `field_shift_agent/orchestrator.py` | loop manual de ferramentas com limites; toda falha vira fallback |
| `field_shift_agent/fallback.py` | resposta `mode: "fallback"` com código de motivo |
| `field_shift_agent/routes.py` | `APIRouter` com `prefix="/experimental/field-shift-ai"` |
| `test_field_shift_agent.py` | 35 testes |
| `artifacts/experiment/demo_field_shift_agent.py` → `agent_demo_results.json` | as 3 demonstrações em PT e EN |

| Arquivo (frontend, novo) | Papel |
|---|---|
| `src/lib/assistant/agent-api.ts` | cliente das rotas e verificação `belongsTo` (resposta e evidências do mesmo campo) |
| `src/lib/assistant/use-agent.ts` | status (uma vez), um `AbortController` por pergunta, cancelamento, invalidação por contexto |

**Arquivos existentes modificados neste marco:**
- `backend/main.py`: +4 linhas (comentário, import e `app.include_router`), sem tocar em nenhuma rota existente.
- Frontend, só arquivos do próprio Field Shift AI: `FieldShiftAI.tsx`, `answers.ts`, `evidence.ts`, `types.ts`, `context.ts`, `assistant-catalog.ts` e os testes.

## 2. Fluxo de ferramentas

| Ferramenta | Retorna | Fonte |
|---|---|---|
| `get_field_context` | id, tipo, região, nome, local, data, polígono; declara que não há registros agronômicos | fixture do servidor / resolver do Bloco 6 |
| `get_environmental_indicators` | 22 indicadores do Bloco 6 (chuva, normais 1991–2025, percentil, veranico, dias quentes, Tmin, geada, GDD, GWETROOT, balanço com EVLAND, cenas Sentinel-2, solo 0–5 cm) e a distribuição da chuva: dias com ≥ 1 mm, dia mais chuvoso, totais de 7 dias | `field_numbers.build_numbers` (cache por fonte do próprio Bloco 6), lido **uma vez por execução** |
| `get_evidence_gaps` | lacunas registradas pelo Bloco 6 e limites estruturais (espacial, temporal, registros do agricultor, comparador ausente, o que uma janela de plantio não decide) | payload do Bloco 6 |
| `get_crop_water_demand` | ET0, ETc por cultura (Kc de pico), chuva − ETc e `highest_peak_demand` calculado **em código** | `demo_crop_water_results.json` (gravado, sem rede); liberado só para o Field 01 e a janela exata de 2026-10-01 a 2026-11-11 |
| `get_planting_constraints` | janelas de semeadura da safra da data escolhida, uma evidência por cultura (valor = nome da cultura na fonte, período = janela) e a posição da data (antes, dentro, depois). Brasil: envelope `window_risk_20` do ZARC por município (regra R-28 do Bloco 7). EUA: datas usuais NASS da Dakota do Norte, sem ano. Polígono desenhado, safra fora do snapshot ou estado fora da fonte: `available: false` | `artifacts/zarc-mt-snapshot.json` e `artifacts/us-windows-cass-nd.json`, os mesmos que a tela Planting calendar do Bloco 7 lê; os oito envelopes de Santa Carmem conferem com a Tabela F da spec do Bloco 7 (teste) |

Nenhuma ferramenta recebe um id de campo do modelo, então ele não consegue consultar outro campo.

A distribuição da chuva é a única conta nova: soma e contagem sobre a série diária do próprio Bloco 6, com o limiar de 1 mm do Bloco 6. Teste de consistência: a soma das seis semanas bate com o `rain_total` do Bloco 6 dentro do arredondamento.

## 3. Integração com o Bloco 6

- Usa `build_numbers`, a mesma função da rota `/numbers`, com o cache em disco por fonte (6 h para o POWER diário, 30 dias para as normais).
- Lê `provenance` e `gaps`, a parte do contrato que coincide entre a rota e o frontend.
- Valores, unidades, fonte, `as_of`, base e resolução saem da linha de proveniência sem alteração; a janela vem de `query.window`.
- Os testes usam o `ReplayTransport` gravado do próprio Bloco 6.

## 4. Integração com o FAO-56

Nenhuma equação é replicada. O agente lê o JSON gerado offline por `demo_crop_water.py` (`network_used: false`, sha256 das entradas). As regras de liberação são as mesmas do frontend:

1. o campo é fixture;
2. o centro coincide com o ponto do snapshot;
3. a janela do Bloco 6 é idêntica à do snapshot.

Validado com dados reais: na data 2026-11-14 a janela ao vivo é de 2026-10-02 a 2026-11-12 e o resultado **não** é liberado; em 2026-11-11 a janela é de 2026-10-01 a 2026-11-11 e ele é liberado.

## 5. Contratos

`POST /experimental/field-shift-ai/chat`:

```json
{ "field_id": "mt-santa-carmem-01", "locale": "pt-BR", "question": "…", "date": "2026-11-11",
  "ring": [[lon, lat], …], "centroid": [lon, lat], "area_ha": null }
```

`ring` e `centroid` só valem para polígonos `csb:` e `trazo:`.

Resposta:

```json
{ "status": "answered|partial|unavailable|fallback", "locale": "pt-BR", "field_id": "…",
  "mode": "agent|fallback",
  "answer": [[{"t":"text","text":"Choveu "},{"t":"value","evidence":"rain_total"},{"t":"text","text":"."}]],
  "evidence": [{"id":"rain_total","value":171.9,"unit":"mm","decimals":1,"source":"…","period":{…},
                "basis":"modelled","resolution":"0.5 degree cell","limitations":[…],"fieldId":"…"}],
  "limitations": ["coarse_cell", …], "tools_used": ["get_environmental_indicators"],
  "errors": [], "fallback_reason": null }
```

Códigos HTTP: `404` para propriedade desconhecida; `422` para payload inválido (idioma, tamanho, campo extra, id fora do padrão). Um polígono sem anel devolve `200` com `fallback_reason: "ring_missing"`.

`GET /experimental/field-shift-ai/status` → `{experimental, llm_enabled, provider, reason, mode}`, sem nenhum segredo.

## 6. Provedor LLM

`Provider.run_turn(system, messages, tools) → ProviderTurn` usa o formato de blocos da Messages API (`tool_use` / `tool_result`), então outro provedor só precisa de um adaptador.

`AnthropicProvider` usa o SDK oficial `anthropic`, importado só quando o provedor é ativado:
- O SDK **não** está no `requirements.txt`: instalá-lo faz parte da ativação e exige autorização da equipe.
- Configuração: `claude-opus-5-5`, `effort` `medium`, `max_tokens` 4096, `tool_choice` automático e ferramentas `strict`.
- Fallback de recusa no servidor ligado (`betas: server-side-fallback-2026-07-01`, `fallbacks: "default"`); uma recusa que persiste vira fallback determinístico.
- Erros tipados: limite de taxa, autenticação, status HTTP e conexão.
- **Não houve nenhuma chamada a modelo real.** O adaptador foi testado com um cliente falso.

## 7. Configuração por ambiente (backend)

| Variável | Padrão | Efeito |
|---|---|---|
| `FIELD_SHIFT_AI_PROVIDER` | vazio → desligado | `anthropic` ativa |
| `FIELD_SHIFT_AI_API_KEY` | — | obrigatória para ativar; nunca devolvida nem registrada em log |
| `FIELD_SHIFT_AI_MODEL` | `claude-opus-5-5` | |
| `FIELD_SHIFT_AI_EFFORT` | `medium` | |
| `FIELD_SHIFT_AI_TIMEOUT_S` | `20` (1–60) | por turno; o total fica limitado a 45 s |
| `FIELD_SHIFT_AI_BASE_URL` | endpoint público | opcional |

Variáveis de ambiente da máquina, como `ANTHROPIC_API_KEY` e `ANTHROPIC_BASE_URL`, **nunca são lidas**. Há teste para isso.

## 8. Modo determinístico

Sem provedor, com o provedor falhando, com resposta rejeitada pelo guard ou com algum limite atingido, a rota devolve `mode: "fallback"` e o código do motivo. O painel então responde com o adaptador do Marco 1 e explica o motivo ("o modelo de linguagem não foi usado: …").

O adaptador ganhou a intenção `recommendation` ("qual cultura devo plantar?", "best crop", "melhor cultura…"). Ela responde com abstenção: o que existe, o que falta e nenhuma recomendação.

## 9. Bilinguismo

- A chave de idioma continua sendo `fs.locale`. O `locale` vai na requisição e o prompt instrui a responder nesse idioma.
- **Valores e datas nunca vêm do texto do modelo.** O frontend os formata a partir da Evidence, no idioma em que a resposta foi escrita.
- Se o usuário troca de idioma, os cartões de evidência e as limitações acompanham, e o texto livre do modelo recebe o aviso "Esta resposta foi escrita em inglês" com um botão "Perguntar de novo em português", que faz uma nova chamada explícita. Nada é traduzido de improviso e nenhum histórico é reenviado.
- Teste: as mesmas perguntas em PT e EN retornam evidências, limitações e status idênticos (teste do backend e `agent_demo_results.json`).

## 10. Validação de evidências (Evidence Guard)

1. **Estrutura primeiro:** `{{value:id}}` e `{{period:id}}` viram segmentos, e qualquer `{{` solto é rejeitado.
2. **Ids:** só valem os registrados por uma ferramenta **nesta execução**, com `fieldId` igual ao do campo pedido (`unknown_evidence`, `evidence_of_another_field`).
3. **Números no texto livre:** qualquer dígito ou `%` fora dos marcadores é rejeitado (`unverified_number`). A exceção são nomes técnicos como `FAO-56`, `ET0`, `Sentinel-2` e `B04`. A regex aqui é uma segunda barreira: a garantia principal é que o número exibido vem da Evidence.
4. **Afirmações sem suporte, em PT e EN:** recomendação, "a melhor cultura é", previsão, produtividade e economia de água (`unsupported_claim`). Uma negação também é rejeitada, porque a falha segura é cair no fallback.
5. **Status:** sem evidência citada, `answered` vira `partial`. Status inválido, listas inválidas ou código de limitação desconhecido também são rejeitados.
6. **Limitações:** as de cada evidência citada são somadas às declaradas.
7. **No cliente:** a resposta só é exibida se `field_id` e todas as `evidence[].fieldId` forem do campo da pergunta, e mudar de campo, data ou anel aborta as requisições em curso.

**Quando o guard falha,** a resposta do modelo é descartada e entra o fallback determinístico.

## 11. Segurança

- Ferramentas só de leitura. Não há execução de código, comando, escrita nem acesso arbitrário à rede.
- Resultados de ferramentas e nomes vindos da fixture são marcados como dados no prompt, e o guard não depende do prompt.
- Limites aplicados: tamanho da pergunta, 5 turnos, 8 chamadas de ferramenta, 45 s, `max_tokens` 4096 e histórico zero (só a pergunta atual vai ao modelo).
- Erros devolvem só códigos. Exceções internas, caminhos e chaves nunca saem do backend; há teste com uma exceção contendo "secret".
- O provedor fica desligado por padrão, e sem ele nenhum dado sai do backend.

## 12. Limitações

- **Modo LLM não validado com modelo real:** não há credencial configurada. Os testes usam um provedor roteirizado, que valida contrato, ferramentas e guard, mas não a qualidade das respostas de um modelo.
- O guard não verifica o sentido de comparações qualitativas escritas pelo modelo ("maior", "acima"). Para comparar culturas existe `highest_peak_demand`, calculado em código. Números por extenso ("vinte") não são detectados.
- O idioma do texto do modelo não é verificado por código.
- A demanda hídrica existe só para um campo e uma janela.
- As janelas de plantio são do município (Brasil) ou do estado (EUA), não do solo do talhão; o registro do produtor do Bloco 7 (data de semeadura declarada, histórico) fica no navegador e ainda não chega ao agente.

## 13. Testes

| Suíte | Resultado |
|---|---|
| `backend/test_field_shift_agent.py` | **35 ok**: ferramentas, guard, orquestrador (demos 1, 2 e 3, PT/EN), falhas do provedor, recusa, ferramenta desconhecida, limites de chamadas, turnos e tempo, resposta inválida, adaptador Anthropic com cliente falso, rotas, status sem segredo |
| `backend/` completo (`unittest discover`) | 194 testes, 1 falha antiga (`test_r36…`, caminho no Windows) |
| `src/lib/assistant/assistant.test.ts` | 60 ok, incluindo as 14 perguntas do brief |
| `src/components/FieldShiftAI.test.tsx` | 20 ok: 12 do Marco 1 e 8 do agente (sem modelo, com modelo, fallback do backend, rede, outro campo, troca de idioma com regeneração, cancelamento e mudança de campo, demo 3) |
| Frontend completo (`vitest run`) | 476 ok, 9 falhas antigas (`window-source`, `season-band`, `basemap-adapters`) |
| `npm run build` | ok |
| Compatibilidade com `origin/main` (`79c1f5f`) numa cópia temporária | backend: os 71 testes nossos passam, mais a única falha antiga da `main` (a fixture gravada, que também falha na `main` limpa); frontend: `tsc` ok e 137 testes ok (assistente, `App`, `App.numbers`, strings) |
| Ponta a ponta no navegador (backend e frontend reais, sem provedor) | Field 01: as 3 demonstrações em PT (data 14/11, demanda indisponível) e em EN (data 11/11, demanda liberada); o painel só consultou o status |

## 14. Execução local

```bash
cd field-shift-app
python -m uvicorn main:app --app-dir backend --port 8001
npm run dev -- --port 5183          # .env.development.local: VITE_API_BASE_URL=http://localhost:8001
cd backend && python -m unittest test_field_shift_agent
python -I artifacts/experiment/demo_field_shift_agent.py
```

Para ativar o modo LLM, que exige autorização: instale o SDK (`pip install anthropic`) e defina `FIELD_SHIFT_AI_PROVIDER=anthropic` e `FIELD_SHIFT_AI_API_KEY` **no ambiente do backend**. Nunca coloque a chave no frontend.

## 15. Integração futura

1. **Sincronizar:** `git merge origin/main` só com autorização, porque há alterações rastreadas não commitadas. O único conflito previsto é **uma linha de import** no `App.tsx`; `main.py`, `en.ts` e `index.ts` aplicam limpo.
2. **Spec:** propor emenda à `bloco-8-agente-e-voz.md` (rev. 1, F-20), que já prevê agente e superfície própria (OD-01), e decidir sobre o `pt-BR` (block 3 R-37).
3. **Dependência:** aprovação de `anthropic` no `requirements.txt` e de um provedor e orçamento.
4. **Validação real:** rodar as 3 demonstrações com o modelo (custo baixo) e medir a taxa de rejeição do guard.
5. **Dados:** `get_planting_constraints` já lê as fontes do calendário do Bloco 7; falta levar ao agente a data de semeadura declarada (fica em `localStorage`), que permitiria o Kc pela curva; quando existir uma rota aprovada de demanda hídrica, `get_crop_water_demand` lê dela em vez do snapshot.
