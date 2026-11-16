"""Tests for the CPC ENSO parsers and the episode classifier.

Fixtures are minimal copies of the real layouts (fetched 2026-11-14), keeping the quirks the
parsers have to survive: glued negative numbers, nested duplicate tables, stale HTML comments.
They are test inputs only -- no value here reaches the UI.
"""

from __future__ import annotations

import pandas as pd
import pytest

from pipeline.common import load_config
from pipeline.fetch_enso import (
    LayoutChanged,
    build_seasonal,
    classify_phases,
    parse_discussion,
    parse_index_ascii,
    parse_strength_table,
    parse_weekly,
    strength_class,
)

ONI_TXT = """ SEAS  YR   TOTAL   ANOM
  DJF 1950  25.01  -1.32
  JFM 1950  25.36  -1.20
  NDJ 1950  25.00  -0.80
"""

RONI_TXT = """SEAS   YR  ANOM
DJF  1950 -1.19
JFM  1950 -1.08
NDJ  1950 -0.70
"""

WEEKLY_TXT = """ Weekly SST data starts week centered on 2Sept1981

                Nino1+2      Nino3        Nino34        Nino4
 Week          SST SSTA     SST SSTA     SST SSTA     SST SSTA
 02SEP1981     20.6-0.1     24.8-0.1     26.5-0.2     28.3-0.3
 04NOV2026     27.0 5.6     29.5 4.4     30.1 3.3     30.1 1.5
"""

DISCUSSION_HTML = """<html><body>
<p>issued by<br>CLIMATE PREDICTION CENTER/NCEP/NWS<br>12 November 2026</p>
<strong>ENSO Alert System Status: </strong> El Ni&ntilde;o Advisory<br>
<u>Synopsis:</u>&nbsp;<strong>El Ni&ntilde;o continues to strengthen (greater than a 79% chance).</strong>
<p>Compared to last month, the Ni&ntilde;o indices increased, reaching +2.5&deg;C in Ni&ntilde;o-3.4.</p>
<p>The next ENSO Diagnostics Discussion is scheduled for 10 December 2026.</p>
<p>This discussion is a consolidated effort of NOAA.</p>
</body></html>"""

# Outer layout table wrapping the data table -> each data row is reachable twice via find_all.
STRENGTH_HTML = """<html><body><table><tr><td>
<!-- Issued April 2026 -->
<p>Official NOAA CPC ENSO Strength Probabilities Issued November 2026</p>
<table>
<tr><th>Season</th><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th><th>f</th><th>g</th><th>h</th><th>i</th></tr>
<tr><td>OND Oct Nov Dec</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>100</td></tr>
<tr><td>JJA Jun Jul Aug</td><td>0</td><td>0</td><td>6</td><td>27</td><td>61</td><td>6</td><td>0</td><td>0</td><td>0</td></tr>
</table>
</td></tr></table></body></html>"""


@pytest.fixture(scope="module")
def cfg():
    return load_config("enso.yaml")


class TestIndexAscii:
    def test_oni_and_roni_layouts_both_parse(self):
        oni, roni = parse_index_ascii(ONI_TXT), parse_index_ascii(RONI_TXT)
        assert oni.anom.tolist() == [-1.32, -1.20, -0.80]  # ANOM column, not TOTAL
        assert roni.anom.tolist() == [-1.19, -1.08, -0.70]

    def test_center_month_and_crop_year(self):
        df = parse_index_ascii(ONI_TXT).set_index("season")
        assert df.loc["DJF", "center_month"] == 1
        assert df.loc["NDJ", "center_month"] == 12
        # Dec 1950 belongs to the Jul 1950 - Jun 1951 crop year, labelled by harvest year 1951.
        assert df.loc["NDJ", "crop_year"] == 1951
        assert df.loc["DJF", "crop_year"] == 1950

    def test_unknown_header_is_rejected(self):
        with pytest.raises(LayoutChanged):
            parse_index_ascii("YEAR MONTH VALUE\n1950 1 -1.0\n")

    def test_unknown_season_is_rejected(self):
        with pytest.raises(LayoutChanged):
            parse_index_ascii("SEAS YR ANOM\nXYZ 1950 -1.0\n")


class TestClassifyPhases:
    def test_five_seasons_make_an_episode_four_do_not(self):
        s = pd.Series([0.0, 0.6, 0.7, 0.8, 0.9, 1.0, 0.0, 0.6, 0.7, 0.8, 0.9, 0.0])
        labels = classify_phases(s, 0.5, 5, 1).tolist()
        assert labels[1:6] == ["el_nino"] * 5
        assert labels[7:11] == ["neutral"] * 4  # only four in a row

    def test_cold_episode(self):
        s = pd.Series([-0.5, -0.6, -1.0, -0.9, -0.5, 0.0])
        assert classify_phases(s, 0.5, 5, 1).tolist()[:5] == ["la_nina"] * 5

    def test_rounding_reproduces_cpc_table(self):
        """0.46 is printed as 0.5 by CPC and coloured warm, so it must count."""
        s = pd.Series([0.46, 0.6, 0.7, 0.8, 0.9])
        assert classify_phases(s, 0.5, 5, 1).tolist() == ["el_nino"] * 5

    def test_open_run_at_end_is_provisional_not_neutral(self):
        s = pd.Series([0.0, 0.0, 0.6, 0.9])
        assert classify_phases(s, 0.5, 5, 1).tolist()[2:] == ["el_nino_provisional"] * 2


class TestStrength:
    @pytest.mark.parametrize(
        "value,expected",
        [(0.4, "none"), (0.5, "weak"), (-1.2, "moderate"), (1.5, "strong"), (1.97, "very_strong")],
    )
    def test_bins(self, cfg, value, expected):
        assert strength_class(value, cfg["strength"], 1) == expected

    def test_historic_flag(self, cfg):
        roni = parse_index_ascii("SEAS YR ANOM\nDJF 2027 2.46\nJFM 2027 2.44\n")
        oni = roni.copy()
        out = build_seasonal(oni, roni, cfg)
        # 2.46 rounds to 2.5 -> historic; 2.44 rounds to 2.4 -> not.
        assert out.roni_historic.tolist() == [True, False]


class TestWeekly:
    def test_glued_negative_anomalies(self):
        df = parse_weekly(WEEKLY_TXT)
        first = df.iloc[0]
        assert first.week_center == pd.Timestamp(1981, 9, 2)
        assert (first.nino12_sst, first.nino12_anom) == (20.6, -0.1)
        assert first.nino34_anom == -0.2

    def test_latest_row(self):
        last = parse_weekly(WEEKLY_TXT).iloc[-1]
        assert last.week_center == pd.Timestamp(2026, 11, 4)
        assert last.nino34_anom == 3.3

    def test_no_rows_is_an_error(self):
        with pytest.raises(LayoutChanged):
            parse_weekly("nothing here\n")


class TestDiscussion:
    def test_headline_fields(self):
        d = parse_discussion(DISCUSSION_HTML)
        assert d["issued"] == "2026-11-12"
        assert d["alert_status"] == "El Niño Advisory"
        assert d["synopsis"].startswith("El Niño continues to strengthen")
        assert d["next_issue"] == "2026-12-10"
        assert d["nino34_quoted_c"] == 2.5

    def test_optional_number_is_none_not_guessed(self):
        html = DISCUSSION_HTML.replace("reaching +2.5&deg;C in Ni&ntilde;o-3.4", "reaching new highs")
        assert parse_discussion(html)["nino34_quoted_c"] is None

    def test_missing_required_field_raises(self):
        with pytest.raises(LayoutChanged, match="alert status"):
            parse_discussion(DISCUSSION_HTML.replace("ENSO Alert System Status:", "Status:"))


class TestStrengthTable:
    def test_rows_deduplicated_and_aggregated(self):
        df = parse_strength_table(STRENGTH_HTML)
        assert df.season.tolist() == ["OND", "JJA"]
        assert df.lead.tolist() == [1, 2]
        jja = df.set_index("season").loc["JJA"]
        assert (jja.p_la_nina, jja.p_neutral, jja.p_el_nino) == (33, 61, 6)

    def test_issue_month_ignores_html_comments(self):
        assert parse_strength_table(STRENGTH_HTML).issued.iloc[0] == "2026-11"

    def test_bad_sum_means_wrong_cells(self):
        bad = STRENGTH_HTML.replace("<td>61</td>", "<td>16</td>")
        with pytest.raises(LayoutChanged, match="sum"):
            parse_strength_table(bad)
