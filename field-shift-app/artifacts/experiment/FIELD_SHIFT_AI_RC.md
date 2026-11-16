# Field Shift AI — Release Candidate (2026-11-15)

Branch `experiment/nasa-decision-engine`, merge base com `origin/main` em `df8b238`. A `main` (`c8343e3`) tem 7
commits novos em `MapCanvas.tsx`, `index.css` e `panel-store.ts`, sem sobreposição com este trabalho.

## Status: READY (modo determinístico) · OpenAI real NÃO validado

| Jornada | Resultado (navegador, :5184 + :8002) |
|---|---|
| A — Santa Carmem | Janela de 1/out a 11/nov de 2026 (42 dias). Chuva 171,9 mm, −53,0 mm da mediana, p20. Milho × soja: +9,9 mm (4,4%), Kc 1,20 × 1,15, com tabela. Janelas ZARC de 2026/2027 com a posição da data. |
| B — Cass Field 01 | Chuva +21,3 mm, p63. Janelas NASS de Dakota do Norte. FAO-56 "Not available", sem números inventados. Nenhum dado brasileiro. |
| C — Segurança | "Qual cultura devo plantar?" e "Which crop should I plant?" dão resposta parcial: "not enough to choose a crop", com a lista do que falta. Sem produtividade, preço ou previsão. |

## Testes

| Suíte | Resultado |
|---|---|
| Agente e FAO-56 (backend) | 85/85 |
| Field Shift AI (frontend) | 131/131 |
| `tsc -b` | ok |
| `vite build` | ok |
| Frontend completo | 763 passam, 9 falham |
| Backend completo | 238 passam, 2 falham |

As 11 falhas acontecem em arquivos que esta branch não altera. As causas vêm do Windows:

- separador `\` em vez de `/` (`basemap-adapters`, `r36`);
- sha256 do snapshot ZARC diferente por causa das quebras de linha CRLF (`season-band`, `window-source`);
- fixture gravada (`test_the_committed_frontend_fixture...`).

## Arquivos para o PR (diff de três pontos contra `origin/main`)

- **Backend:**
  - `backend/field_shift_agent/*` (novo);
  - `backend/crop_water.py`;
  - `backend/sources/power_et0.py`;
  - `backend/main.py` (inclusão do router);
  - testes `test_field_shift_agent.py` e `test_crop_water.py`;
  - `backend/README.md`;
  - `backend/validate_openai_agent.py` (só manual).
- **Frontend:**
  - `src/components/FieldShiftAI.{tsx,css,test.tsx}`;
  - `src/lib/assistant/*` (incluindo `planting.ts`);
  - `src/strings/assistant*.ts`.
- **Toques em arquivos da equipe:**
  - `src/App.tsx`: 3 linhas;
  - `src/strings/en.ts` e `src/strings/index.ts`: spread das chaves `assistant.*`.
- **Documentação:** `artifacts/experiment/*`.
- **Fora do PR:**
  - `artifacts/experiment/ux-review/` (capturas da auditoria);
  - `artifacts/AC-34-network.txt`, que a suíte reescreve.

Varredura de segredos: nenhum `.env`, nenhuma chave `sk-…` e nenhum token no diff.

## Configuração (somente no processo do backend)

| Variável | Valor |
|---|---|
| `FIELD_SHIFT_AI_PROVIDER` | `openai` |
| `FIELD_SHIFT_AI_OPENAI_MODEL` | `gpt-6-luna` |
| `FIELD_SHIFT_AI_OPENAI_API_KEY` | chave local |

- O padrão sem variáveis é o modo determinístico.
- Nunca usar prefixo `VITE_`.
- O frontend lê `VITE_API_BASE_URL`, que aponta para o backend.

## Teste real único, depois de autorizado

Feito pelo operador, numa janela com as variáveis acima:

```powershell
cd field-shift-app
python -m uvicorn main:app --app-dir backend --port 8000
```

Depois, no app: Field Shift AI → "Abrir Santa Carmem" → PT-BR → "Compare a demanda hídrica do milho e da soja em
Santa Carmem." O selo "Agente com ferramentas" e a lista de evidências citadas confirmam a chamada. Uma falha
volta ao modo determinístico.

## Riscos

1. O modelo `gpt-6-luna` e as tarifas em `OpenAIProvider` não foram validados por uma chamada real.
2. O teto de custo só existe no script de validação. O servidor não tem teto, a menos que
   `FIELD_SHIFT_AI_OPENAI_BUDGET_USD` seja definido.
3. No celular, o painel do assistente cobre o painel da equipe enquanto está aberto.
4. O FAO-56 é um snapshot de um campo e de uma janela.

## Specs que precisam de aprovação (ADR 0005)

- R-41: ocultar COMMAND no app oficial.
- R-01/R-23: seletor de região visível.
- R-37/R-11: interface em PT-BR (`pt-BR.ts` continua vazio).
- Nova spec do assistente: rota `/experimental/field-shift-ai`, Evidence Guard e contrato FAO-56.

## Texto do PR

> **Field Shift AI (experimental): assistente com evidências, FAO-56 e agente opcional**
> Painel bilíngue (EN/PT-BR) ao lado do mapa. Explica chuva contra a mediana de 1991–2025, demanda hídrica
> FAO-56 (snapshot gravado de Santa Carmem) e janelas ZARC/NASS do Bloco 7. Todo número vem de ferramenta
> determinística. O agente LLM (Anthropic ou OpenAI) é opcional e desligado por padrão; cada resposta passa
> pelo Evidence Guard e volta ao modo determinístico em caso de falha. Não recomenda culturas. Toca a equipe
> em 3 linhas de `App.tsx` e no spread de strings.

## Checklist de integração

- [ ] Commit do trabalho local (autorização pendente).
- [ ] Merge de `origin/main` (`c8343e3`) e nova rodada das suítes.
- [ ] Push da branch e PR para `main` (autorização pendente).
- [ ] Revisão de spec (ADR 0005) para os itens acima.
- [ ] Teste real com OpenAI (autorização pendente) ou release em modo determinístico.
