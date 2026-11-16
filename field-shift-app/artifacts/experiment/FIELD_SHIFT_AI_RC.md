# Field Shift AI — Release Candidate (2026-11-15)

- Branch: `experiment/nasa-decision-engine`, sincronizada com `origin/main` (`162e98f`).
- Pendências: nada para receber da `main`. Os commits locais não foram enviados.
- Commits deste RC:
  - `9c99f09`: feat;
  - `ec180e8`: merge da `main` (limpeza da faixa);
  - `67d02b0`: o assistente acompanha a limpeza.

## Status: READY no modo determinístico · OpenAI real NÃO validado

## Testes

| Verificação | Resultado |
|---|---|
| Agente e FAO-56 (backend) | 85/85 |
| Field Shift AI e `lib/assistant` (frontend) | 131/131 |
| `vite build` | ok |
| `tsc -b` | falha |
| Frontend completo | 683 passam, 66 falham |
| Backend completo | 241 passam, 2 falham |

**Type-check.** Há 32 erros, todos em 7 arquivos de teste da equipe que são idênticos aos da `origin/main`. A própria
`main` mantém `DecisionView.test.tsx` e `FieldRecordView.test.tsx` sem os componentes, e testes que usam painéis
removidos. Nenhum erro está em arquivos do assistente. Como `npm run build` executa `tsc -b && vite build`, ele
também falha na `main`.

**Frontend completo.** As 66 falhas são exatamente as mesmas da `origin/main` pura. Comparei a lista de testes
(68 linhas `FAIL`) numa cópia da `main` feita com `git archive` e o resultado foi idêntico.

**Backend completo.** As 2 falhas acontecem em arquivos que a branch não altera:

- `r36`: separador `\` do Windows;
- a fixture gravada.

## Jornadas (navegador, frontend :5184 e backend :8002)

| Jornada | Resultado |
|---|---|
| BR em PT-BR | Field 01, janela de 1/out a 11/nov de 2026 (42 dias). Chuva 53,0 mm abaixo da mediana, p20. Milho 9,9 mm acima da soja (4,4%), Kc 1,20 × 1,15, com tabela e limitações. Janelas ZARC 2026/2027. Sem chaves internas na tela. |
| EUA em EN | Cass Field 01. Chuva 21,4 mm acima, p63. Janelas NASS. FAO-56 "Not available". Nenhum número brasileiro. |
| Segurança | "Qual cultura devo plantar?" e "Which crop should I plant?" recebem "não bastam para escolher uma cultura", com a lista do que falta e nenhum ranking. |

## OpenAI

O adaptador usa `POST /v1/responses` com function calling estrito, `store=false`, as 5 ferramentas e o Evidence
Guard. Os erros viram códigos seguros e a resposta cai no modo determinístico.

**Variáveis (somente no backend):**

| Variável | Valor ou padrão |
|---|---|
| `FIELD_SHIFT_AI_PROVIDER` | `openai` |
| `FIELD_SHIFT_AI_OPENAI_API_KEY` | chave local |
| `FIELD_SHIFT_AI_OPENAI_MODEL` | padrão `gpt-6-luna` |
| `FIELD_SHIFT_AI_MAX_OUTPUT_TOKENS` | padrão 4096, limitado a 8192 |
| `FIELD_SHIFT_AI_TIMEOUT_S` | padrão 20 s por turno, limitado a 60 |
| `FIELD_SHIFT_AI_OPENAI_BUDGET_USD` | opcional |

**Limites do orquestrador:** 5 turnos, 8 chamadas de ferramenta e 45 s por pergunta.

**Validação real:** não feita.

- Nenhum backend local está com o provedor ativo.
- O identificador `gpt-6-luna` e as tarifas fixas no código (US$ 0,10 e 0,50 por milhão de tokens) não foram confirmados.

## Segurança

- **Chave:** fica só no processo do backend.
  - O frontend lê apenas `VITE_API_BASE_URL`.
  - O bundle não tem chave; as ocorrências de `sk-` em `dist` são nomes de CSS (`mask-…`).
  - O diff não tem `.env` nem credenciais.
- **Orçamento:**
  - O provedor é criado a cada requisição (`routes.get_provider`). Por isso `FIELD_SHIFT_AI_OPENAI_BUDGET_USD`
    limita uma única pergunta, não o gasto acumulado do servidor. Não é um controle de custo efetivo.
  - O teto acumulado de US$ 0,10 existe só no script `validate_openai_agent.py`.
- **Endpoint:** `/experimental/field-shift-ai/chat` é separado, mas não tem autenticação nem limite de taxa.
  - Com o provedor ativo, qualquer cliente que alcance o backend gasta créditos da API.
  - **Não publicar com o provedor ligado** sem limite de taxa, autenticação e teto global.
- **Padrão seguro:** sem as variáveis, a rota responde `llm_not_configured` e o frontend usa o modo determinístico.

## Pull Request (não aberto)

**Título:** `feat: Field Shift AI — bilingual agricultural copilot with NASA evidence`

**Descrição**

1. **Problema.** O produtor vê números do campo, mas não sabe o que eles significam. O assistente explica chuva,
   demanda hídrica e janelas de plantio do campo selecionado, sempre com evidência e limitações.
2. **Arquitetura.** Painel React ao lado do mapa (`FieldShiftAI.tsx`). No frontend, há adaptadores de contexto,
   evidências e respostas determinísticas (`src/lib/assistant/`). No backend, o agente opcional fica em
   `backend/field_shift_agent/`, com ferramentas determinísticas, orquestrador e Evidence Guard.
3. **Bloco 6.** Lê `POST /fields/{id}/numbers`, com a mesma janela R-16, chuva comparada à mediana de
   1991–2025, percentil e posto. Não há um segundo cliente NASA POWER no frontend.
4. **Bloco 7.** Usa as mesmas fontes (`zarc-mt-snapshot.json` e `us-windows-cass-nd.json`) e as funções
   `calendarRows` e `seasonlessRows`. Mostra a posição da data escolhida e nunca escolhe uma data.
5. **FAO-56.** ETc = Kc × ET0, com Kc de pico, a partir de um snapshot gravado (Santa Carmem Field 01, de 1/out
   a 11/nov de 2026). As diferenças entre culturas são calculadas em código. Fora desse campo e dessa janela,
   aparece a indisponibilidade explicada.
6. **Evidências.** Todo número é citado por marcador e vem de ferramenta ou fonte. O Evidence Guard rejeita
   números livres e afirmações proibidas.
7. **OpenAI opcional.** Responses API ou Anthropic, configurados por variável de ambiente e desligados por padrão.
8. **Fallback.** Qualquer falha do provedor ou do guard volta ao modo determinístico, com o motivo indicado.
9. **Bilinguismo.** Catálogo EN/PT-BR tipado com as mesmas chaves (`assistant-catalog.ts`). O restante do app
   continua em inglês, e `pt-BR.ts` permanece vazio.
10. **Testes.** São 85 no backend (agente e FAO-56) e 131 no frontend (assistente), mais as jornadas BR, EUA e de
    segurança no navegador.
11. **Limitações.**
    - O FAO-56 cobre um campo e uma janela, com Kc de pico.
    - A célula de reanálise é de 0,5°.
    - A janela ZARC é um envelope municipal; a janela NASS é uma média estadual.
    - O modo LLM não foi validado.
    - No celular, o painel aberto cobre os painéis da equipe.
12. **Deploy.** Sem variáveis, o modo é determinístico. O provedor só deve ser ativado com limite de taxa,
    autenticação e teto global.

**Toques em arquivos da equipe:**

- `App.tsx`: 1 import e 2 tags;
- `backend/main.py`: inclusão do router;
- `strings/en.ts` e `strings/index.ts`: spread das chaves `assistant.*`.

**Arquivos excluídos do PR:**

- `artifacts/experiment/ux-review/`, capturas da auditoria, não versionadas;
- `artifacts/AC-34-network.txt`, que os testes reescrevem;
- `.env.development.local`, `node_modules/`, `dist/`, `__pycache__/` e `.pytest_cache/`, todos ignorados.

## Governança (ADR 0005)

| Decisão | O que precisa de aprovação |
|---|---|
| Agente experimental | Spec nova: rota `/experimental/field-shift-ai`, contrato `ChatRequest`/`ChatResponse` e Evidence Guard |
| Internacionalização | R-37/R-11: catálogo PT-BR próprio do assistente, com `pt-BR.ts` vazio |
| Superfície visual | Launcher e painel fora da faixa congelada (R-41). Com o painel aberto, a coluna da direita fica oculta. |
| Contrato FAO-56 | `CropWaterSet` e as regras de liberação (campo, ponto, janela exata e snapshot) |
| Configuração OpenAI | Provedor, modelo e onde a chave fica no deploy |
| Controles de custo | Teto global, limite de taxa e autenticação, que hoje não existem |
| Seletor de região | R-01/R-23: a demonstração troca a região sem um controle visível |
