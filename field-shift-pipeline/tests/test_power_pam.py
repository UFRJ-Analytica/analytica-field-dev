"""Tests for the NASA POWER and IBGE SIDRA parsers."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from pipeline.fetch_pam import parse_sidra, parse_value
from pipeline.fetch_power import chunks, drop_unpublished_tail, parse_power


def power_payload(values: dict[str, dict[str, float]], units: dict[str, str] | None = None) -> dict:
    units = units or {k: {"PRECTOTCORR": "mm/day", "T2M_MAX": "C"}.get(k, "1") for k in values}
    return {
        "header": {"fill_value": -999.0, "sources": ["MERRA2", "POWER"], "api": {"version": "v2.10.3"}},
        "properties": {"parameter": values},
        "parameters": {k: {"units": u} for k, u in units.items()},
    }


class TestPower:
    def test_fill_value_becomes_nan(self):
        df, info = parse_power(power_payload({"PRECTOTCORR": {"20240101": 4.0, "20240102": -999.0}}))
        assert df.PRECTOTCORR.iloc[0] == 4.0
        assert np.isnan(df.PRECTOTCORR.iloc[1])
        assert df.date.iloc[0] == pd.Timestamp(2024, 1, 1)
        assert info["sources"] == "MERRA2,POWER"

    def test_unit_change_is_refused(self):
        with pytest.raises(ValueError, match="unit"):
            parse_power(power_payload({"PRECTOTCORR": {"20240101": 4.0}}, {"PRECTOTCORR": "in/day"}))

    def test_publication_lag_is_trimmed_but_interior_gaps_are_kept(self):
        df = pd.DataFrame({
            "date": pd.date_range("2026-11-08", periods=5),
            "PRECTOTCORR": [1.0, np.nan, 2.0, np.nan, np.nan],
        })
        out = drop_unpublished_tail(df)
        assert len(out) == 3  # interior NaN survives, trailing two dropped
        assert out.PRECTOTCORR.isna().sum() == 1

    def test_chunks_are_decade_aligned_and_cover_the_range(self):
        c = chunks(date(1981, 1, 1), date(2026, 11, 14))
        assert c[0] == (date(1981, 1, 1), date(1989, 12, 31))
        assert c[1] == (date(1990, 1, 1), date(1999, 12, 31))
        assert c[-1] == (date(2020, 1, 1), date(2026, 11, 14))
        for (_, b), (a, _) in zip(c, c[1:]):
            assert (a - b).days == 1  # contiguous, no gap, no overlap


HEADER = {"NC": "x", "NN": "x", "MC": "x", "MN": "x", "V": "Valor", "D1C": "x", "D1N": "x",
          "D2C": "x", "D2N": "x", "D3C": "x", "D3N": "x", "D4C": "x", "D4N": "x"}


def sidra_row(v: str, var: str = "112", year: str = "2016") -> dict:
    return {"NC": "6", "NN": "Município", "MC": "33", "MN": "Quilogramas por Hectare", "V": v,
            "D1C": "2919553", "D1N": "Luís Eduardo Magalhães (BA)", "D2C": var,
            "D2N": "Rendimento médio da produção", "D3C": year, "D3N": year,
            "D4C": "2713", "D4N": "Soja (em grão)"}


class TestSidra:
    @pytest.mark.parametrize("raw,value,flag", [
        ("2100", 2100.0, ""), ("-", 0.0, "zero"), ("...", np.nan, "not_available"),
        ("..", np.nan, "not_applicable"), ("X", np.nan, "suppressed"),
    ])
    def test_symbols(self, raw, value, flag):
        v, f = parse_value(raw)
        assert f == flag
        assert (np.isnan(v) and np.isnan(value)) or v == value

    def test_unknown_symbol_raises(self):
        with pytest.raises(ValueError, match="unknown SIDRA symbol"):
            parse_value("n/d")

    def test_rows(self):
        df = parse_sidra([HEADER, sidra_row("3240", year="2015"), sidra_row("2100")], 1612)
        assert df.value.tolist() == [3240.0, 2100.0]
        assert df.variable.unique().tolist() == ["yield_kg_ha"]
        assert df.crop.iloc[0] == "Soja (em grão)"
        assert df.code.iloc[0] == 2919553

    def test_header_is_required(self):
        with pytest.raises(ValueError, match="header"):
            parse_sidra([sidra_row("1")], 1612)
