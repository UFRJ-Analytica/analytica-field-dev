# Field Shift AI: Marco 1, MVP bilíngue do copiloto agrícola

Branch `experiment/nasa-decision-engine`, worktree `analytica-decision-lab`, base `origin/main` em `9cb91e6`.
**Experimento.** Nada foi commitado, enviado por push ou aberto como PR. Não existe spec congelada para este
trabalho (ADR 0005); veja a seção 12.

## 1. Objetivo

Painel contextual sobre o mapa que reconhece a propriedade selecionada, lê os indicadores ambientais do Bloco 6,
responde a um conjunto fixo de perguntas em português ou inglês e mostra, em cada resposta, as evidências e as
limitações usadas. **Neste marco não há LLM:** as respostas são montadas por regras determinísticas, e a interface
diz isso ("Prévia baseada em evidências" / "Evidence-based preview").

## 2. Arquitetura

```
useMapStore (seleção, região, data, polígono, cache numbersLastRead)
        │
        ▼
Context Adapter ── lib/assistant/context.ts ── fetchNumbers() do Bloco 6 (só com o painel aberto)
        │  FieldContext { fieldId, kind, nome, região, data, key, numbers: NumbersStatus }
        ▼
Evidence Adapter ── lib/assistant/evidence.ts      (payload.provenance + payload.gaps → Evidence[])
Crop water (opc.) ── lib/assistant/crop-water.ts   (snapshot FAO-56 gravado, liberado só se tudo bater)
        │
        ▼
Answer Adapter ── lib/assistant/answers.ts  (classifyIntent → answerIntent → AssistantResponse)
        │
        ▼
UI ── components/FieldShiftAI.tsx (+ .css)  FieldShiftAIToggle + FieldShiftAIPanel
```

A resposta é recalculada na renderização a partir da intenção de cada pergunta e do contexto atual. Por isso, a
troca de idioma reescreve a mesma resposta, com as mesmas evidências, e uma troca de propriedade, data ou polígono
apaga a conversa (`context.key`), avisando o usuário.

## 3. Componentes criados (todos novos)

| Arquivo | Papel |
|---|---|
| `src/components/FieldShiftAI.tsx` | Lançador e painel: contexto, visão geral (4 indicadores), perguntas sugeridas, conversa, evidências, limitações, seletor EN/PT-BR, teclado (Esc fecha, foco volta ao lançador) |
| `src/components/FieldShiftAI.css` | Estilos com escopo `.fsai-*`, na identidade visual do app; layout desktop e estreito (≤ 760 px) |
| `src/lib/assistant/types.ts` | Contratos `Evidence`, `AssistantResponse`, `FieldContext`, `NumbersStatus`, `CropWaterResult/Set` |
| `src/lib/assistant/context.ts` | Context Adapter (`useFieldContext`) |
| `src/lib/assistant/evidence.ts` | Evidence Adapter, códigos de limitação, tradução de seções e status de lacuna |
| `src/lib/assistant/crop-water.ts` | Adaptador opcional do experimento FAO-56 (somente leitura de JSON gravado) |
| `src/lib/assistant/answers.ts` | Classificador de intenção e respostas determinísticas |
| `src/lib/assistant/format.ts` | Números, datas, unidades e resoluções por idioma |
| `src/lib/assistant/locale.ts` | `useLocale()` sobre o `fs.locale` do app |
| `src/lib/assistant/ui-store.ts` | Estado aberto/fechado do painel (zustand, sem dados de mapa) |
| `src/strings/assistant-catalog.ts` | Catálogo EN e PT-BR do assistente (sem imports, para evitar ciclo) |
| `src/strings/assistant.ts` | `at(locale, key)` |
| `src/lib/assistant/assistant.test.ts` | Testes de catálogo, formatação, classificação, evidências, respostas e snapshot |
| `src/components/FieldShiftAI.test.tsx` | Testes de interface e de contexto |
| `artifacts/experiment/FIELD_SHIFT_AI_MVP.md` | Este documento |

### Arquivos compartilhados modificados (mínimo necessário)

| Arquivo | Mudança | Motivo |
|---|---|---|
| `src/App.tsx` | +1 import, +2 elementos (`<FieldShiftAIToggle />`, `<FieldShiftAIPanel />`) e 1 comentário, antes do `NumbersView` | Montar o painel como filho direto do shell, para que `.is-numbers-open` o oculte como o restante. **Fora** da faixa de controles do topo, cuja composição é contrato congelado (block 4 R-41, teste `R-41, AC-22`) |
| `src/strings/en.ts` | +1 import e `...assistantCatalogEn` na 1ª linha do objeto | Os textos em inglês do assistente entram no catálogo do app e passam por `t()`, então o scan de literais da equipe cobre o assistente. Fica longe dos trechos que a `block6/wave3-rotation` edita (linhas 39 e 324) |
| `src/strings/index.ts` | `getLocale`, `LOCALE_STORAGE_KEY` exportados; `setLocale` e `LOCALE_CHANGE_EVENT` novos; `translationKeyFor` ignora `assistant.*` | Uma única fonte de verdade para o idioma (`fs.locale`), troca de idioma reativa, e a busca reversa da equipe não passa a responder com chaves do assistente (20 textos coincidem, ex. `SMAP soil moisture`) |

`src/strings/pt-BR.ts` **não foi alterado** (veja a seção 8).

## 4. Integrações reutilizadas

- **Bloco 6:** `fetchNumbers`, `numbersLastReadKey`, `NumbersHttpError` e `NumbersNetworkError` (`lib/numbers-api.ts`); tipos
  `NumbersPayload`, `ProvenanceRow`, `GapRow`, `interiorPoint`, `METRICS`, `familyOf` e `roundHalfUp` (`lib/numbers.ts`);
  o cache `numbersLastRead` da store. Nenhum cliente POWER novo e nenhum indicador recalculado.
- **Mapa:** `useMapStore` (`selectedFieldId` via `selectedField`, `selectedPolygonId`, `polygonRing`, `regionId`,
  `chosenDateOf`), `regionAdapter`, `commandFieldId`.
- **Experimento FAO-56:** `artifacts/experiment/demo_crop_water_results.json` (saída de `demo_crop_water.py`), lido
  como JSON. Nenhuma fórmula é replicada no frontend; `crop_water.py` não foi alterado.

## 5. Contratos

`Evidence` (adaptado da `ProvenanceRow` do Bloco 6, sem campos duplicados):
`id, metric, value (number|string|null), unit, source, asOf, period {start,end}|null, basis, sourceBasis, resolution, route, limitations[]`.
O campo `basis` assume `retrieved | modelled | observed | entered` (da própria linha), `derived` (rota `derived`) ou
`fixture` (demonstração gravada); `sourceBasis` guarda a base original da linha.

`AssistantResponse`: `id, fieldId, contextKey, locale, intent, answer[] (parágrafos), evidence[], limitations[] (códigos), status (answered|partial|unavailable), mode ('deterministic' | 'agent')`.

`CropWaterSet` / `CropWaterResult`: ET0, ETc, chuva, chuva − ETc, Kc (inicial, meio, fim), modo de Kc, contagem de
métodos (Penman-Monteith, Hargreaves, indisponível), cobertura, fonte, período, origem
(`experimental_snapshot | api`).

**Risco de contrato conhecido:** em `sections.climate`, os nomes das chaves diferem entre a rota da `main`
(`rain_day`, `aggregates.*.value`, `rain_rank`) e os tipos do frontend (`rain`, `aggregates.*` como número, `rank`).
O assistente lê só `provenance` e `gaps`, em que os dois lados coincidem campo a campo, e por isso não é afetado.
A divergência continua no `NumbersView` e deve ser comunicada ao autor da wave 2.

## 6. Limitações

- O classificador é por palavras-chave (PT/EN, sem acentos). Perguntas fora das cinco intenções recebem a lista do
  que é suportado, e nunca um palpite.
- A visão geral mostra 4 indicadores; a lista completa fica na tela Field numbers, que o assistente não replica.
- Para polígonos do Brasil, o corpo da requisição envia `area_ha: null` (o `NumbersView` usa o sidecar). Nesse caso
  o resultado **não** é gravado no cache compartilhado, para não divergir do que o `NumbersView` gravaria.
- A demanda hídrica só existe como snapshot gravado: **Field 01 (Santa Carmem) e janela de 2026-10-01 a 2026-11-11**.
  Ela é liberada apenas se (1) a propriedade for fixture e o centro coincidir com o ponto do snapshot, (2) a janela
  do Bloco 6 for exatamente a do snapshot e (3) o snapshot tiver sido gerado sem rede. Em qualquer outro caso, aparece
  a frase "ainda não está disponível". Os Fields 02 e 03 ficam na mesma célula climática, mas **não** recebem o resultado.
- O painel desktop pode cobrir a coluna direita (Command/Supporting data) se as duas estiverem abertas ao mesmo tempo.
  Ele não cobre a faixa do topo, o zoom, a bússola, a faixa de camadas nem a atribuição (verificado por geometria em 1280×800).

## 7. Estados de disponibilidade

| `numbers.kind` | Quando | O que o assistente faz |
|---|---|---|
| `no_field` | nada selecionado | pede uma seleção; nenhuma requisição |
| `ring_missing` | polígono sem contorno renderizado | declara indisponível; nunca usa outro talhão |
| `loading` | requisição em curso | responde "carregando" com o motivo |
| `ready` (`cached` true/false) | payload do Bloco 6 | responde com evidências |
| `held` | rede caiu e há leitura anterior na sessão | usa a leitura anterior, rotulada como offline |
| `error` | HTTP 4xx/5xx | declara HTTP {status}, sem valores |
| `offline` | sem rede e sem leitura anterior | declara inacessível, sem valores |

Valores nulos aparecem como "sem valor" / "no value", **nunca como zero**.

## 8. Suporte bilíngue

- **Idioma:** a fonte única é `fs.locale` (a mesma de `t()`). O seletor EN | PT-BR no painel chama `setLocale`, e a
  troca reescreve as respostas já dadas. As perguntas sugeridas acompanham a troca; o texto digitado fica como foi digitado.
- **Inglês:** chaves `assistant.*` dentro de `en.ts`, renderizadas por `t()`.
- **Português:** `assistantPtBR` em `assistant-catalog.ts`, tipado como `Record<AssistantKey, string>` (uma tradução
  ausente quebra o build).
- **⚠ Decisão pendente da equipe:** a block 3 R-37, mantida pela block 6 R-11 e pela block 8 R-43, determina que
  `src/strings/pt-BR.ts` **fique vazio** (o app é só em inglês), e o teste `keeps the pt-BR catalogue empty (R-11)`
  verifica isso. Por isso o português do assistente não foi colocado em `pt-BR.ts`. Integrar o bilinguismo exige uma
  emenda de spec; a alternativa técnica é mover `assistantPtBR` para `pt-BR.ts`.
- **Números:** usam `Intl` com as casas decimais da Tabela A (`171,9 mm` / `171.9 mm`; `12.788.611 ha` / `12,788,611 ha`).
- **Datas:** UTC, formato médio (`1 de out. de 2026` / `Oct 1, 2026`).
- **Unidades:** são valores de dados (exceção da R-11) e ficam fora de `en.ts`. Exemplos: `dias`/`days`, `°C`, `°C·dia`.
- **Resoluções conhecidas:** reescritas em PT mantendo os números (`célula de 0,5° (meteorologia)`).
- **Textos livres das lacunas (em inglês):** não são reescritos; o status é traduzido por código, e o que não é
  reconhecido vira "uma lacuna registrada pela fonte".
- **O que permanece em inglês:** nomes próprios e URLs de fontes (ex. `NASA POWER Daily Point API`) e o nome do botão
  "Field numbers" da equipe.

## 9. Testes

| Suíte | Resultado |
|---|---|
| `src/lib/assistant/assistant.test.ts` | catálogo (paridade de chaves, placeholders, frases exatas), formatação, classificação das 10 perguntas do brief, evidências, respostas nos dois idiomas, "nenhum número fora das evidências", sem recomendação, snapshot liberado só para Field 01 e a janela certa, ET0 ≠ ETc |
| `src/components/FieldShiftAI.test.tsx` (12) | abrir/fechar/Esc/foco, nenhuma requisição com o painel fechado, reuso do cache, cache de outro talhão rejeitado, sugestão com evidências, pergunta digitada em PT, troca de idioma, troca de propriedade, troca de data, polígono sem contorno, sem propriedade, serviço inacessível |
| Suíte completa `npx vitest run` | **451 passam, 9 falham.** As 9 falhas existem igualmente numa cópia limpa do HEAD (`git archive`): `window-source` (7) e `season-band` (1), por hash do snapshot ZARC, e `basemap-adapters` (1), por caminho com `\` no Windows |
| `npx tsc -b` | sem erros |
| `npm run build` | ok (o aviso de bundle acima de 500 kB já existia) |

Testes da equipe que este trabalho precisou respeitar e que passam: `R-41, AC-22` (faixa do topo), o scan de literais
com `t()` em modo de chaves, `keeps the pt-BR catalogue empty (R-11)` e `R-30`.

### Inspeção visual (navegador do app, backend e frontend locais nas portas 8001 e 5183)

- Verificado em 1280×800 e 375×812 (mobile): lançador, painel aberto e fechado, Cass Field 01 (EUA, dados reais),
  Field 01 (Brasil, dados reais), troca EN/PT-BR, pergunta rápida, evidências expandidas, ocultação com Field numbers aberto.
- Com dados reais, a janela de Field 01 em 2026-11-14 foi 2026-10-01 a 2026-11-11, o snapshot foi liberado e a resposta
  mostrou ET0 de 197,6 mm e milho como a maior demanda com Kc de pico.
- **Limite da inspeção:** a ferramenta de captura cortava a borda direita em alguns tamanhos emulados. Nesses casos,
  sobreposições e textos foram confirmados por geometria (`getBoundingClientRect`) e pelo DOM, não só pela imagem.

## 10. Execução

```bash
cd field-shift-app
npm ci                                   # já feito nesta worktree, com autorização
python -m uvicorn main:app --app-dir backend --port 8001
echo VITE_API_BASE_URL=http://localhost:8001 > .env.development.local   # ignorado pelo git; só vale para `vite dev`
npm run dev -- --port 5183
npx vitest run src/lib/assistant src/components/FieldShiftAI.test.tsx
```

As portas 8000 e 5173 estavam ocupadas por outros processos (provavelmente o app da equipe) e não foram tocadas.
Não use `.env.local`: ele também é lido pelo Vitest e quebra os testes que esperam `localhost:8000`.

Para ver a demanda hídrica: `?region=br` → Fields → Field 01 → Field Shift AI → "Compare a demanda hídrica".

## 11. Dependências futuras

1. **Contrato de clima unificado** (wave 1 × wave 2), para o assistente poder ler `sections.*` além de `provenance`.
2. **Rota aprovada de demanda hídrica** (`crop_water` na `/numbers` ou rota irmã) no lugar do snapshot. O adaptador
   já aceita `origin: 'api'`.
3. **Bloco 7:** data de semeadura e histórico declarado (Kc pela curva em vez do pico).
4. **Bloco 8:** comparador. O assistente não ranqueia nem recomenda até que ele exista.
5. **Agente com ferramentas:** substituir `classifyIntent` por seleção de ferramenta via LLM, mantendo
   `summaryEvidence`, `gapsOf`, `cropWaterFor` e o `AssistantResponse` (`mode: 'agent'`), e validando que todo
   número da resposta exista nas evidências (o teste "no number outside its evidence" já é esse validador).
6. **Decisão de produto** sobre o português (block 3 R-37) e sobre a superfície do agente (block 8 agente e voz, OD-01).

## 12. Estratégia de integração

- **Sobreposição com a equipe:** `specs/bloco-8-agente-e-voz.md` (rev. 1) especifica o agente: text-to-SQL, voz e a
  explicação da tela (F-20), com a posição da superfície como decisão aberta (OD-01). Não há implementação em nenhuma
  branch. Este MVP antecipa parte do F-20 de forma isolada; deve ser apresentado como protótipo para a emenda dessa
  spec, não como PR direto na `main`.
- **Pull Request (quando autorizado):**
  1. `git fetch`;
  2. `git merge --ff-only origin/main` se não houver commits nossos (ou merge controlado);
  3. rodar `npx vitest run` e comparar com as mesmas 9 falhas antigas;
  4. `npm run build`;
  5. abrir PR **draft** com este documento.
- **Conflitos possíveis:** `App.tsx` (2 elementos e 1 import, num ponto que a wave 3 não toca), `en.ts` (linha 1;
  a wave 3 edita as linhas 39 e 324) e `index.ts` (nenhuma branch toca).
- **Se a equipe criar algo equivalente:** reutilizar e remover a duplicata (por exemplo, se o Bloco 8 entregar o
  registro de comandos do agente, o painel passa a ser a superfície dele).
