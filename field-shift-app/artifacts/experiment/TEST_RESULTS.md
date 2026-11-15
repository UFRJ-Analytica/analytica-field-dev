# Resultados de verificação do experimento

Ambiente: Windows, Python 3.13, branch `experiment/nasa-decision-engine`.

## Testes específicos

Comando:

```powershell
cd field-shift-app/backend
python -m unittest test_crop_water -v
```

Resultado:

- 36 executados.
- 36 aprovados.
- 0 falhas.
- 0 erros.
- 0 skips.
- Duração interna da última execução completa registrada: 0,025 s.

## Suíte do backend

Comando:

```powershell
cd field-shift-app/backend
python -m unittest discover -v
```

Resultado:

- 159 executados.
- 157 aprovados.
- 1 falha.
- 0 erros.
- 1 skip (`BLOCK6_LIVE=1` não habilitado).
- Duração interna: 4,503 s; duração de parede observada: 6,51 s.

Falha preexistente e não corrigida por restrição de escopo:

```text
test_field_numbers_sources.MapBiomasReaderTests.
test_r36_an_absent_sidecar_file_is_unavailable_with_the_path
```

No Windows, a implementação retorna `\\nonexistent\\polygon-mapbiomas.sqlite`, enquanto o teste
procura `/nonexistent/polygon-mapbiomas.sqlite`. Nenhum arquivo do projeto principal foi alterado.

## Compilação dos módulos experimentais

`python -m py_compile` passou para:

- `backend/crop_water.py`
- `backend/sources/power_et0.py`
- `backend/test_crop_water.py`
- `artifacts/experiment/demo_crop_water.py`

## Reprodutibilidade da demonstração

Duas execuções consecutivas produziram arquivos byte a byte idênticos:

- JSON SHA-256: `6CE80CA50F718615B1FD963F80105863B6BCA7D52787D3B758DBDB0F1FFC1238`
- Markdown SHA-256: `5DA0CDE5BAA350FCF9FAABDAC0C2A17F988968D201D8A08652F2D954D0F41421`

A versão final é determinística: não usa rede, relógio ou timestamp, e o script sobrescreve os dois
resultados a partir dos snapshots. Os hashes acima foram idênticos em duas execuções consecutivas.
