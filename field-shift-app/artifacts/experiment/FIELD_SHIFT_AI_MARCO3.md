# Field Shift AI — Marco 3: integração da jornada agrícola

Branch `experiment/nasa-decision-engine`, sem commit. Data: 2026-11-15. Tudo é experimental e fica
nos arquivos do assistente. Nenhum componente congelado da equipe foi editado.

## O que mudou

| Melhoria | Problema da auditoria | Solução | Evidência |
|---|---|---|---|
| Santa Carmem selecionável | P0-1: só apareciam campos de Cass County | A região `br` existe (`src/lib/regions.ts`), mas a spec só a seleciona por `?region=br` (R-01/R-23). A demonstração guiada do painel chama `setRegionId('br')` e `selectField('mt-santa-carmem-01')` do próprio store. Também ajusta a data para o fim da janela gravada. | Teste de UI; navegador: mapa em MT, "Field 01", janela de 1/out a 11/nov |
| FAO-56 acessível | P0-2/P0-3: "Indisponível" para milho × soja | A data da demonstração é o fim da janela do snapshot. Pela regra R-16 do Bloco 6, a janela termina no último dia válido até a data escolhida, e o `chosen_date` gravado (11-14) dava outra janela depois que o POWER atualizou. A resposta começa pela diferença milho − soja calculada em código. Em seguida vêm uma tabela compacta e a explicação de Kc. | Testes; navegador: 9,9 mm (4,4%), Kc 1,20 × 1,15 |
| Contrato FAO-56 | Seção 6.1 | Reuso de `CropWaterSet`: campo, ponto, janela, ET0, ETc, Kc, chuva, método, cobertura, fonte e limitações. No backend entram `crop_water.<c>.kc_mid` e `crop_water.diff.<a>_minus_<b>`. As regras de liberação continuam as mesmas: campo, ponto, janela exata e `network_used=false`. | `test_crop_water_registers_kc_and_pairwise_differences` |
| Paráfrases | P1-4 | Famílias de intenção ordenadas, com prioridade explícita: falta → janela → água → escolha → chuva → fontes → condições. O classificador continua um só. | 28 paráfrases da auditoria e do prompt, em PT e EN |
| Chuva interpretada | P1-5 | Nova intenção `rainfall`. A resposta abre com a conclusão (abaixo, acima ou na mediana), depois a diferença em mm e %, o percentil e o posto, o "quinto mais seco/chuvoso" e o que um percentil não é. "Suficiente/enough" acrescenta a ressalva e, quando existe, chuva − ETc. | Testes; navegador (BR: abaixo, −53,0 mm, p20; EUA: acima, +21,3 mm, p63) |
| Calendário explicado | P1-6 | Nova intenção `planting`, com as mesmas fontes e a mesma regra do Bloco 7 (`calendarRows`/`seasonlessRows`). Mostra a posição da data na janela e o que significa a janela ZARC (risco de 20%, envelope municipal) ou NASS (5–95%, média de 20 anos). Filtra pela cultura citada. | Testes; navegador |
| COMMAND oculto | P1-7 | `html[data-fsai-dev-tools="off"]` esconde `.command-toggle` e `.agent-anchor` só por CSS. O nó continua no DOM, então o contrato R-41 vale. Há um checkbox "Mostrar ferramentas de desenvolvimento". | Teste; navegador: faixa sem COMMAND |
| Sobreposição | P1-8 | Com o assistente aberto, a coluna direita (Supporting data) fica `visibility: hidden` em vez de meio coberta. A tabela fica logo após a conclusão. | Navegador 1280×800 e 375×812, sem rolagem horizontal |
| Siglas | P2-13 | Glossário expansível: ET0, ETc, Kc, ZARC, NASS, NASA POWER, percentil, GWETROOT, EVLAND. As respostas explicam ET0/Kc/ZARC/NASS no texto. | Teste |
| Datas | P2-11 | Datas MM-DD dos EUA aparecem sem ano ("Apr 26") e com a ressalva de média. | Teste |
| Limite incoerente | P1 (auditoria B.4) | A recomendação só cita "Kc de pico" quando existe estimativa hídrica. | Teste |

## Agente (backend)

- Novas evidências calculadas em código, para o modelo nunca comparar nem subtrair:
  - `rain_vs_median` (below, above ou equal) e `rain_minus_median`;
  - `kc_mid` por cultura;
  - as diferenças de ETc entre pares de culturas.
- `get_planting_constraints` usa as janelas do Bloco 7, como já fazia antes deste marco.
- O prompt do sistema pede três coisas: conclusão primeiro, explicação de siglas e percentil não tratado como probabilidade.
- O Evidence Guard não foi afrouxado. Há teste mostrando que um modelo que escreve "cerca de 10 mm" é rejeitado (`guard_unverified_number`).
- Demonstração `demo_field_shift_agent.py` com modelo simulado: 6 cenários em PT e EN, incluindo os novos 4 (diferença e Kc) e 5 (chuva e janela). Todos passam pelo guard, e a recomendação continua rejeitada.
- Nenhum LLM real foi chamado. A rota ao vivo sem provedor responde `fallback` / `llm_not_configured`.

## Limitações

- **Científicas:**
  - FAO-56 com Kc de pico, sem data de semeadura;
  - célula de 0,5°;
  - a janela ZARC é o envelope municipal de solos e ciclos;
  - a janela NASS é estadual e a data final é média.
- **De dados:**
  - o snapshot FAO-56 existe para um campo e uma janela só;
  - os outros campos recebem a indisponibilidade explicada, com o caminho até a demonstração.
- **Técnicas:**
  - a troca de região pela demonstração é um atalho experimental;
  - ocultar COMMAND e a coluna direita é CSS do assistente aplicado a classes da equipe.
- **De integração (precisam de aprovação):**
  1. Um seletor de região visível exige emenda de R-01/R-23.
  2. Ocultar COMMAND no app oficial exige decisão sobre R-41.
  3. A interface principal em PT-BR exige emenda de R-37/R-11, e `pt-BR.ts` continua vazio.
  4. O rótulo acessível do mapa ("…Santa Carmem fields") fica em `MapCanvas.tsx` da equipe e não foi alterado.
  5. A `main` avançou com o Bloco 5.5 (um mapa, quatro painéis), que muda a coluna direita e os painéis. O CSS de sobreposição deve ser revisto depois do merge.
