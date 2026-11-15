"""IBGE SIDRA table 1612, API v3 (R-37, R-38): soy planted area, hectares, category 2713.

The route reads the state row at level `N3`, which the SIDRA API addresses by the two digit IBGE
state code, not by the UF sigla (a live `N3[MT]` call answers HTTP 500, `N3[51]` answers 200). The
codes below are the IBGE Unidade da Federacao codes, read from
`https://servicodados.ibge.gov.br/api/v1/localidades/estados` on 2026-11-15, and `state_code()`
resolves a field's `location` text through them. That read is the one block 4 R-31 documents for the
Brazil fixture data (`Santa Carmem, Mato Grosso` gives UF `MT`); a text that matches no state is
unresolved, never a neighbouring state, and no municipality code is ever inferred from it (R-38).
"""

from __future__ import annotations

from typing import Any, Iterable

YEARS = range(2021, 2026)

# sigla, IBGE code, name
STATES = (
    ("AC", "12", "Acre"),
    ("AL", "27", "Alagoas"),
    ("AM", "13", "Amazonas"),
    ("AP", "16", "Amapá"),
    ("BA", "29", "Bahia"),
    ("CE", "23", "Ceará"),
    ("DF", "53", "Distrito Federal"),
    ("ES", "32", "Espírito Santo"),
    ("GO", "52", "Goiás"),
    ("MA", "21", "Maranhão"),
    ("MG", "31", "Minas Gerais"),
    ("MS", "50", "Mato Grosso do Sul"),
    ("MT", "51", "Mato Grosso"),
    ("PA", "15", "Pará"),
    ("PB", "25", "Paraíba"),
    ("PE", "26", "Pernambuco"),
    ("PI", "22", "Piauí"),
    ("PR", "41", "Paraná"),
    ("RJ", "33", "Rio de Janeiro"),
    ("RN", "24", "Rio Grande do Norte"),
    ("RO", "11", "Rondônia"),
    ("RR", "14", "Roraima"),
    ("RS", "43", "Rio Grande do Sul"),
    ("SC", "42", "Santa Catarina"),
    ("SE", "28", "Sergipe"),
    ("SP", "35", "São Paulo"),
    ("TO", "17", "Tocantins"),
)
STATE_CODES = {sigla: code for sigla, code, _ in STATES}
STATE_CODES_BY_NAME = {name.casefold(): code for _, code, name in STATES}


def state_code(location: str | None) -> str | None:
    """The IBGE state code of a field's `location` text (`Santa Carmem, Mato Grosso` is `51`).

    The state is the text after the last comma, matched against the IBGE state names and siglas.
    A location that names no known state, or carries no comma, resolves to None.
    """
    if not location or "," not in location:
        return None
    tail = location.rsplit(",", 1)[1].strip()
    if tail.upper() in STATE_CODES:
        return STATE_CODES[tail.upper()]
    return STATE_CODES_BY_NAME.get(tail.casefold())


def url(level: str, code: str) -> str:
    return (
        "https://servicodados.ibge.gov.br/api/v3/agregados/1612/periodos/2021-2025/variaveis/109"
        f"?localidades={level}%5B{code}%5D&classificacao=81%5B2713%5D"
    )


def _to_int(raw: Any) -> int | None:
    """A SIDRA cell is a digit string, or '-', '...' or another marker for no value (R-38)."""
    if raw is None:
        return None
    text = str(raw).strip()
    return int(text) if text.isdigit() else None


def parse(payload: list, code: str, years: Iterable[int]) -> dict[int, int | None]:
    """The planted area per year for one locality. An unknown code is a LookupError, never a guess."""
    for variable in payload:
        for result in variable.get("resultados", []):
            for series in result.get("series", []):
                if str(series["localidade"]["id"]) == str(code):
                    values = series.get("serie", {})
                    return {year: _to_int(values.get(str(year))) for year in years}
    raise LookupError(f"no SIDRA series for locality {code}")


def locality_name(payload: list, code: str) -> str:
    """The locality's own name as the response writes it (`Mato Grosso`), never one written here."""
    for variable in payload:
        for result in variable.get("resultados", []):
            for series in result.get("series", []):
                if str(series["localidade"]["id"]) == str(code):
                    return str(series["localidade"]["nome"])
    raise LookupError(f"no SIDRA locality name for {code}")
