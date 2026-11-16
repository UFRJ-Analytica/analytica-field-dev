# Field Shift AI — Geospatial Agent Tools

Branch `experiment/nasa-decision-engine`, sem commit. Data: 2026-11-15. O chat passa a operar o mapa: região,
propriedade, data, camadas NASA e enquadramento. Também consulta os indicadores da propriedade e explica o
resultado com evidências.

## Fluxo

```
pergunta ─► interpretador (sem LLM)  ou  modelo com tool calling (LLM, opcional)
              │                                 │ backend valida cada chamada (map_actions.py)
              ▼                                 ▼
        lista de chamadas ─────────► executor no navegador (map-tools.ts)
                                       │ registro fechado · validação · catálogos reais
                                       ▼
                         useMapStore (setRegionId, selectField, setChosenDate, setLayerOn, requestFocus)
                                       │                        │
                                       ▼                        ▼
                                  MapCanvas (câmera,      context.ts → Bloco 6 (/numbers)
                                  camadas, fitBounds)            │
                                                                 ▼
                                                answers.ts (evidências, Evidence Guard no modo LLM)
```

- **Intenção:** o interpretador (`map-commands.ts`) ou o modelo.
- **Planejamento:** uma lista de chamadas, com no máximo 8 passos.
- **Execução:** `executePlan`. Cada passo tem `status`, `code`, `mapStateVersion` e `effect`.
- **Evidências:** respostas calculadas a partir do contexto do mapa depois dos passos.
- **Resposta:** distingue o que foi feito, o que não foi e o que está indisponível.

O app continua com uma única fonte de verdade, o `useMapStore`. O pedido de foco não leva coordenadas: o
`MapCanvas` usa a geometria da própria seleção e confirma o resultado em `focusHandled`.

## Ferramentas

| Ferramenta | Comportamento real |
|---|---|
| `select_region` | Resolve nomes e aliases (Cass County, North Dakota, Santa Carmem, Mato Grosso…) contra `regions.ts`. Sem nome, pede esclarecimento; com nome desconhecido, lista as regiões disponíveis. O store limpa a seleção anterior, e o app escolhe o primeiro campo da região. |
| `select_field` | Aceita número, nome (`/fields`), `current` ou `first`, sempre da região ativa. Um campo de outra região é recusado. Em "minha propriedade" sem nada selecionado, pede esclarecimento, porque o app não sabe qual é a propriedade do usuário. |
| `focus_geometry` | Enquadra o limite real do campo ou o anel do polígono (`fitBounds`). Desconta a largura do painel, para no zoom 13 e confirma no store. |
| `highlight_evidence` | Enquadra só o campo selecionado e explica que os valores climáticos vêm de uma célula de cerca de 50 km. Não desenha nenhuma outra geometria. |
| `set_date` | Valida o formato, a data no calendário e a cobertura do eixo de camadas (2015-04-01 até a data mais recente com dados). Fora disso, recusa e não altera nada. |
| `set_analysis_window` | O Bloco 6 (R-16) só tem 42 dias. Outros tamanhos aparecem como "não suportado", e a análise usa os 42 dias. |
| `show_layer` / `hide_layer` | Usam o catálogo real de `/layers` (SMAP, IMERG, LST, NDVI/EVI, HLS, GRACE) e chamam `setLayerOn`. Camada inexistente ou sem imagem é recusada. O GRACE, desatualizado, nunca é ativado como atual. |
| `query_field_metrics` | Pede ao painel os indicadores do Bloco 6: chuva, umidade, temperatura, visão geral ou sinais hídricos. Vegetação não está disponível, porque o Bloco 6 só tem a contagem de NDVI. |
| `compare_metrics` | Compara duas ou três variáveis na mesma janela, cada uma contra a própria base histórica quando ela existe. Não conclui causalidade. |

## Modos

- **Modo B (determinístico):** reconhece comandos em EN e PT com verbo e alvo conhecidos. As perguntas sugeridas
  do painel continuam indo para as respostas (o teste cobre isso). Comandos compostos são divididos em cláusulas.
  Um "isso" ou "it" usa o assunto anterior.
- **Modo A (LLM):** as dez ferramentas são oferecidas ao modelo com esquemas estritos e enums fechados.
  - O backend valida cada chamada e devolve `map_actions`.
  - O navegador valida tudo de novo antes de executar.
  - Uma resposta do modelo sobre o contexto anterior é ocultada quando as próprias ações dele mudam o contexto.
  - Testado só com modelo simulado. Nenhuma chamada paga.

## Segurança

- Registro fechado: um nome fora da lista é recusado (`tool_not_allowed`).
- Argumentos validados, sem coordenadas, URLs ou código.
- Nenhum acesso ao DOM, `eval` ou rede nas ferramentas.
- Log estruturado (`toolLog`) sem texto livre do usuário.
- Todas as ferramentas são visuais ou de leitura. Uma ferramenta `persistent` futura exige confirmação.
- No modo LLM, o limite de 8 chamadas por pergunta vale também para as ações de mapa, e o Evidence Guard
  continua obrigatório.
- Uma troca manual de campo durante ou depois de um comando limpa a conversa ou oculta a análise; dados antigos
  nunca são reaproveitados.

## Testes e evidências

| Suíte | Resultado |
|---|---|
| `map-commands.test.ts` (interpretador, falsos positivos, injeção, datas) | 59/59 |
| `map-tools.test.ts` (executor sobre o store real) | 16/16 |
| `FieldShiftAI.map.test.tsx` (painel nos dois modos, estado do store) | 7/7 |
| `MapCanvas.focus.test.tsx` (`fitBounds` e confirmação) | 2/2 |
| `test_field_shift_map_actions.py` (backend, modelo simulado) | 8/8 |

- Navegador: os cenários 1 a 18 foram executados (registro em `geospatial-agent/`).
- Playwright não foi usado, porque não está instalado no projeto e instalar exigiria autorização.

## Limitações

- Janela de análise fixa em 42 dias (Bloco 6).
- Vegetação sem valor numérico no Bloco 6.
- Umidade do solo (GWETROOT) sem normal histórica.
- O painel não lê os pixels das camadas.
- Não há geometria de anomalia: o destaque é sempre o limite do campo.
- O interpretador determinístico só entende os comandos listados.
- No celular, o painel ocupa a tela e o enquadramento não desconta a largura dele.
- Toques em arquivos da equipe:
  - `map-store.ts` (pedido de foco);
  - `MapCanvas.tsx` (efeito `fitBounds`);
  - `App.tsx` (passa `fields` ao painel);
  - `test/maplibre-stub.ts` (`fitBounds`).
