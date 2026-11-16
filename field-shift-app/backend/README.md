# Field Shift backend

FastAPI backend. Na inicialização, `main.py` carrega o fixture de campos; tiles passam pelo proxy local.

## Camadas e catálogo

- `LAYER_REGISTRY` em `backend/main.py` é a única fonte de um id de camada, de um identificador GIBS e de uma matriz de tiles (block 4 R-01). Tem 13 entradas, na ordem da pilha.
- `GET /layers?date=YYYY-MM-DD&z=&x=&y=` devolve um objeto `{chosen_date, axis, layers}` (não um array). Cada linha traz `id`, `label`, `kind`, `basis`, `resolution`, `matrix`, `max_zoom`, `cadence`, `lookback_days`, `time_format`, `optical`, `window_days`, `status`, `effective_date`, `age_days` e `last_observation`. A data efetiva vem da regra de caminhada de R-05; a resposta fica em cache por data escolhida e endereço de tile pelo TTL de 24 h.
- `smap-soil-moisture` continua um alias de `smap-l3`.
- `GET /layers/{id}/coverage?days=N&date=YYYY-MM-DD` devolve a cobertura óptica (status, bytes, `coverage_ok` por data) e responde 400 para camada não óptica e 503 `{status: "unavailable", dates_scanned: [...]}` quando a varredura para num status diferente de 200, 400 ou 404.

## Proxy de tiles

- `GET /tiles/{layer}/{z}/{x}/{y}?date=YYYY-MM-DD` resolve a data efetiva por R-05 e devolve o tile daquela data com `X-Tile-Date`. A URL usa a matriz da entrada do registro (por exemplo `GoogleMapsCompatible_Level9` para os produtos MODIS de 8 dias), nunca uma constante.
- Toda resposta 200 traz `X-Tile-Date`, inclusive as servidas do cache. O cache em disco tem a chave camada/data/z/x/y, e uma entrada vive 24 horas.
- `z` acima de `max_zoom` da camada responde 400 com `Zoom above max_zoom for layer`, sem chamada ao upstream. Camada desconhecida responde 404 antes de qualquer requisição.
- `404`/`400` do upstream avançam a caminhada de datas; qualquer outro status, ou erro de conexão, para a caminhada e reporta `unavailable`. Sem nenhuma resposta 200 dentro do lookback: `none_in_lookback`, 404 sem corpo (`X-Tile-Status: none_in_lookback`).
- Modo degradado (R-25): com o upstream indisponível, o proxy serve o cache mais recente da mesma camada e endereço com data até a data escolhida (`X-Tile-Source: cache-offline` e `X-Tile-Date`), senão a reserva (`reserve/smap-soil-moisture.png`, sem data), senão 404 sem corpo (`X-Tile-Status: no_offline_copy`).
- `GET /tiles/stats/upstream` expõe `{"upstream_requests": N}` para observar quantas chamadas foram feitas ao upstream desde o start do processo.

### Variáveis de ambiente

- `TILE_UPSTREAM_URL` (opcional): origem/base URL do upstream; por padrão usa `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best`. Útil para apontar a um mock/ambiente de teste ou para simular indisponibilidade. O caminho WMTS é acrescentado pelo proxy.
- `TILE_CACHE_DIR` (opcional): diretório do cache em disco; por padrão `backend/.tile-cache`.

### Executar

Na raiz do projeto:

```sh
backend/.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000
```

### Testes

```sh
cd backend
.venv/bin/python -m unittest discover
```

Os testes usam transportes gravados (`artifacts/fixtures/tiles-recorded-2026-11-14.json`) e não chamam a rede.

A reserva incluída em `reserve/smap-soil-moisture.png` é PNG 256×256.

## Field Shift AI: provedor OpenAI

O agente experimental mantém os provedores Anthropic e OpenAI selecionáveis por configuração. O adaptador
OpenAI usa `POST /v1/responses`, function calling estrito, raciocínio `medium`, estado local (`store=false`) e
as cinco ferramentas científicas existentes. Toda resposta continua passando pelo Evidence Guard.

Configure a chave apenas no processo do backend. Em PowerShell, na janela que iniciará o servidor:

```powershell
cd field-shift-app
$env:FIELD_SHIFT_AI_PROVIDER = 'openai'
$env:FIELD_SHIFT_AI_OPENAI_MODEL = 'gpt-6-luna'
$env:FIELD_SHIFT_AI_OPENAI_API_KEY = '<segredo local>'
$env:FIELD_SHIFT_AI_EFFORT = 'medium'
python -m uvicorn main:app --app-dir backend --port 8000
```

Não use prefixo `VITE_`, não grave a chave em arquivo do frontend e não a coloque em `.env` compartilhado. O
adaptador ignora `OPENAI_API_KEY`: somente a variável específica do backend acima ativa credenciais OpenAI.
`GET /experimental/field-shift-ai/status` mostra provedor, modelo e esforço, mas nunca a chave.

Em outra janela, inicie o frontend:

```powershell
cd field-shift-app
npm run dev
```

Abra a URL indicada pelo Vite, selecione `Field 01` em Santa Carmem, abra o botão `Field Shift AI` no canto
inferior direito, escolha português ou inglês e envie a pergunta. O selo `Agente com ferramentas
(experimental)` confirma que o frontend encontrou o provedor; respostas reprovadas ou falhas usam o fallback
determinístico.

### Validação real preparada (não executar sem autorização)

`backend/validate_openai_agent.py` contém as três perguntas aprovadas em português e inglês, registra seleção de
ferramentas, resultado do Evidence Guard, latência, tokens e custo estimado, e impõe teto acumulado de US$ 0,10.
Ele exige a configuração acima e uma confirmação explícita na linha de comando:

```powershell
cd field-shift-app/backend
python validate_openai_agent.py --confirm-real-api
```

O texto da terceira pergunta é validado como acompanhamento, porém cada requisição permanece isolada: o backend
não envia o histórico da conversa ao modelo. O modelo precisa consultar novamente as ferramentas necessárias.
