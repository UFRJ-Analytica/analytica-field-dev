# Proposta de integração — indicador experimental de evapotranspiração de cultura

Status: proposta somente. Nenhuma rota, schema, spec, fixture ou interface foi alterada.

## Problema

O Bloco 6 calcula `remaining = sum(PRECTOTCORR) - sum(EVLAND)`. A própria R-24 declara que
`EVLAND` é evaporação modelada da superfície terrestre, não demanda hídrica específica de uma
cultura, e que nenhuma evapotranspiração de referência é usada. Por isso, o mesmo termo não permite
comparar soja, milho e algodão sob a mesma série climática.

O experimento estima ET0 por FAO-56 Penman–Monteith a partir de entradas diárias NASA POWER e usa
`ETc = Kc × ET0`. A saída `P - ETc` é somente uma diferença climática simplificada. Não é déficit de
irrigação, balanço completo de água no solo, medição de estresse, previsão de produtividade ou
estimativa de economia.

## Solução proposta

Adicionar, após aprovação e emenda de especificação, um indicador opcional e explicitamente
`modelled` de evapotranspiração de cultura. Ele deve carregar:

- cultura e fonte do Kc;
- modo Kc de pico ou curva fenológica;
- data de semeadura e quatro durações de estágio quando houver curva;
- ET0, ETc e `P - ETc`, com unidade e período;
- método diário, dias de fallback e cobertura;
- fonte, resolução, convenção temporal, hipóteses e critérios de abstenção.

## Alternativa A — seção opcional em `/fields/{field_id}/numbers`

Adicionar uma seção opcional `crop_water` ao payload do Bloco 6.

Vantagens:

- reutiliza janela, proveniência, cache e superfície de números;
- mantém indicadores ambientais e hídricos no mesmo contrato;
- reduz chamadas do frontend.

Custos e riscos:

- exige emenda da spec congelada do Bloco 6 e testes de contrato;
- a rota precisaria receber cultura, semeadura e estágios ou obter esses dados de uma fonte aprovada;
- a ausência de entradas do Bloco 7 não pode ser preenchida silenciosamente;
- aumenta um payload já extenso e acopla cálculo agronômico a uma rota ambiental.

Contrato conceitual, não implementado:

```json
{
  "crop_water": {
    "state": "ok | abstained | unavailable",
    "crop_id": "soybean",
    "kc_mode": "mid-season | curve-from-sowing",
    "et0_total_mm": 197.6,
    "etc_total_mm": 227.3,
    "rain_minus_etc_mm": -55.4,
    "basis": "modelled",
    "methods": {"penman-monteith": 40, "hargreaves": 2},
    "assumptions": [],
    "limitations": [],
    "provenance": []
  }
}
```

## Alternativa B — endpoint independente

Criar, em bloco futuro aprovado, uma rota dedicada, por exemplo:

`POST /fields/{field_id}/crop-water`

O corpo declararia cultura e, opcionalmente, fenologia. A resposta seguiria o contrato conceitual
acima e referenciaria a mesma janela climática do Bloco 6.

Vantagens:

- isola o experimento do contrato congelado do Bloco 6;
- torna explícito que cultura e fenologia são entradas agronômicas;
- permite versionar o método sem alterar todos os consumidores de `/numbers`;
- facilita revisão, rollback e testes científicos independentes.

Custos e riscos:

- uma chamada e um contrato adicionais;
- precisa impedir divergência entre a janela climática da rota e a do Bloco 6;
- requer cache e proveniência próprios ou reutilização explícita dos serviços internos do Bloco 6.

## Recomendação

Preferir inicialmente a **Alternativa B**, em PR separado e atrás de spec aprovada. Ela mantém o
limite experimental claro e evita ampliar a rota congelada antes de existirem entradas reais de
semeadura e fenologia. Uma integração posterior pode promover a seção para `/numbers` se o produto
decidir que demanda por cultura é parte permanente do registro ambiental.

## Dependências

- **Bloco 6:** série diária NASA POWER, janela de 42 dias, cobertura, cache e proveniência.
- **Bloco 7:** cultura declarada, data de semeadura e, se aprovado, ciclo/duração fenológica.
- **Bloco 8:** possível consumo futuro por comparador; este experimento não implementa ranking nem
  simulador.

## Leitura dos registros atuais

- **Bloco 6 OD-02:** escolhe `EVLAND` para o balanço atual porque chega em mm/dia e declara que não é
  demanda da cultura. O experimento não substitui silenciosamente essa decisão.
- **CO-B6-07:** pede um produto de evapotranspiração de referência **medido**. O presente experimento
  produz ET0 **modelada** por FAO-56 a partir de entradas POWER; portanto, não fecha literalmente esse
  carry-over. Uma emenda deve corrigir essa diferença antes de afirmar que CO-B6-07 foi atendido.
- **CO-B8-10:** reconhece explicitamente que `EVLAND` não é demanda de cultura e deixa a decisão de
  incorporar um modelo para bloco posterior. Esta proposta é evidência para essa decisão, não sua
  implementação.
- **M-06 atual do comparador:** trata da existência de cenários nos campos fixture dos Estados Unidos;
  não trata de água.
- **M-08 atual do comparador:** trata da unidade de break-even; não trata de água.

O README experimental anterior citava M-06 e M-08 como evidência de que o critério hídrico era igual
entre cenários. Essas referências mudaram na revisão atual e não devem ser reutilizadas para essa
afirmação. O registro hídrico vigente é CO-B8-10, além do próprio contrato do critério `water`.

## Limitações obrigatórias

- Sem balanço completo de água no solo.
- Sem armazenamento, escoamento, drenagem, ascensão capilar, irrigação, TAW, RAW ou Ks.
- Sem calibração local dos coeficientes Kc.
- Sem ajuste climático dos Kc pelas equações 62 e 65.
- Sem validação de campo.
- Sem previsão de produtividade.
- Sem estimativa de economia de irrigação.
- Sem garantia de que uma célula POWER represente a variabilidade intratalhão.
- Kc de pico é somente um cenário ilustrativo de demanda padrão máxima.
- Curva Kc exige semeadura e durações de estágio fornecidas explicitamente.

## Governança e sequência

Qualquer integração exige, nesta ordem:

1. Aprovação de Carlos Pereira.
2. Decisão explícita sobre Alternativa A ou B.
3. Emenda e congelamento de especificação conforme ADR 0005.
4. Definição das entradas e estados de abstenção.
5. Testes de contrato e oráculos científicos.
6. Revisão dos impactos no frontend e no cache.
7. Pull Request separado, sem misturar Blocos 7 ou 8.

## Critérios mínimos para uma integração futura

- Oráculos FAO-56 continuam passando.
- Unidades e convenção temporal são verificadas no payload POWER.
- Cada dia informa Penman–Monteith, Hargreaves ou indisponível, com motivo.
- Não existe curva fenológica sem data de semeadura e quatro durações positivas.
- `P - ETc` nunca é rotulado como déficit real de irrigação.
- Consumidores distinguem `modelled` de `retrieved`, `observed`, `entered` e `simulated`.
- A ausência de qualquer dia necessário impede a diferença climática completa.
