"""Fetch the ENSO state from NOAA CPC: history, the latest weekly reading, and the official outlook.

Five CPC products, none needing authentication:

=====================  ==========================================  ======================
Product                URL                                         Access
=====================  ==========================================  ======================
ONI, 1950-             data/indices/oni.ascii.txt                  plain-text file
RONI, 1950-            data/indices/RONI.ascii.txt                 plain-text file
Weekly Nino SSTs       data/indices/wksst9120.for                  fixed-width text
Diagnostic Discussion  .../enso_advisory/ensodisc.shtml            HTML, scraped
Strength outlook       .../enso/roni/strengths/                    HTML table, scraped
=====================  ==========================================  ======================

RONI has been CPC's official index since Feb 2026 (NWS PIS 26-05), so it drives the current phase
and the strength classes. ONI is kept alongside for comparison with older literature.

The two HTML pages are the only things without a machine-readable twin, so they are the only
things scraped. Each parser fails loudly when the page layout changes rather than returning a
plausible-looking guess.

Outputs (data/processed/):
    enso_seasonal.parquet           one row per overlapping 3-month season, ONI + RONI + phases
    enso_weekly.parquet             weekly Nino-1+2/3/3.4/4 SST and anomaly, 1981-
    enso_current.parquet            one row: latest discussion + latest index values
    enso_strength_forecast.parquet  CPC strength probabilities for the next 9 seasons
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

import pandas as pd
from bs4 import BeautifulSoup, Comment

from pipeline.common import (
    base_parser,
    fetch_text,
    load_config,
    log,
    setup_logging,
    write_parquet,
)

CPC = "https://www.cpc.ncep.noaa.gov"
ONI_URL = f"{CPC}/data/indices/oni.ascii.txt"
RONI_URL = f"{CPC}/data/indices/RONI.ascii.txt"
WEEKLY_URL = f"{CPC}/data/indices/wksst9120.for"
DISCUSSION_URL = f"{CPC}/products/analysis_monitoring/enso_advisory/ensodisc.shtml"
STRENGTH_URL = f"{CPC}/products/analysis_monitoring/enso/roni/strengths/"

# Overlapping 3-month seasons in CPC order. Index i is centred on calendar month i + 1, and CPC's
# YR column is the year of that centre month (DJF 1951 = Dec 1950 - Feb 1951; NDJ 1950 =
# Nov 1950 - Jan 1951).
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
CENTER_MONTH = {s: i + 1 for i, s in enumerate(SEASONS)}

# Column keys for the nine RONI bins of the strength outlook, coldest to warmest.
STRENGTH_BINS = [
    "le_m2.0",
    "m2.0_m1.5",
    "m1.5_m1.0",
    "m1.0_m0.5",
    "neutral",
    "p0.5_p1.0",
    "p1.0_p1.5",
    "p1.5_p2.0",
    "ge_p2.0",
]

MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], start=1
)}


class LayoutChanged(ValueError):
    """An upstream page no longer has the structure the parser was written against."""


# --------------------------------------------------------------------------------------------
# Plain-text indices
# --------------------------------------------------------------------------------------------


def parse_index_ascii(text: str) -> pd.DataFrame:
    """Parse CPC's ``SEAS YR [TOTAL] ANOM`` files (ONI and RONI share this layout).

    Returns columns: season, year, center_month, crop_year, anom.
    ``crop_year`` follows the project convention (Jul-Jun, labelled by harvest year).
    """
    lines = [ln.split() for ln in text.strip().splitlines() if ln.strip()]
    header = [h.upper() for h in lines[0]]
    if header[:2] != ["SEAS", "YR"] or "ANOM" not in header:
        raise LayoutChanged(f"unexpected index header: {lines[0]}")
    anom_col = header.index("ANOM")

    rows = []
    for parts in lines[1:]:
        season = parts[0].upper()
        if season not in CENTER_MONTH:
            raise LayoutChanged(f"unknown season code {parts[0]!r}")
        year = int(parts[1])
        month = CENTER_MONTH[season]
        rows.append(
            {
                "season": season,
                "year": year,
                "center_month": month,
                "crop_year": year + 1 if month >= 7 else year,
                "anom": float(parts[anom_col]),
            }
        )
    return pd.DataFrame(rows)


def classify_phases(anom: pd.Series, threshold: float, min_run: int, decimals: int) -> pd.Series:
    """Label each season el_nino / la_nina / neutral by CPC's consecutive-season rule.

    A run that has not yet reached ``min_run`` seasons *and* touches the end of the series is still
    open: it may become an episode next month. It is labelled ``*_provisional`` rather than being
    called neutral (which would be wrong) or an episode (which CPC has not yet declared).
    """
    values = anom.round(decimals).to_numpy()
    sign = [1 if v >= threshold else -1 if v <= -threshold else 0 for v in values]
    labels = ["neutral"] * len(sign)

    i = 0
    while i < len(sign):
        if sign[i] == 0:
            i += 1
            continue
        j = i
        while j < len(sign) and sign[j] == sign[i]:
            j += 1
        name = "el_nino" if sign[i] > 0 else "la_nina"
        if j - i >= min_run:
            labels[i:j] = [name] * (j - i)
        elif j == len(sign):
            labels[i:j] = [f"{name}_provisional"] * (j - i)
        i = j
    return pd.Series(labels, index=anom.index)


def strength_class(value: float, bins: dict[str, float], decimals: int) -> str:
    """weak / moderate / strong / very_strong by |index|, or 'none' below the weak threshold."""
    v = abs(round(value, decimals))
    label = "none"
    for name in ("weak", "moderate", "strong", "very_strong"):
        if v >= bins[name]:
            label = name
    return label


def parse_weekly(text: str) -> pd.DataFrame:
    """Parse ``wksst9120.for``: weekly SST and anomaly for Nino 1+2, 3, 3.4, 4.

    Fixed-width, and negative anomalies abut the SST with no space (``20.6-0.1``), so it is parsed
    by pattern rather than by splitting on whitespace.
    """
    num = r"(-?\d+\.\d)"
    pat = re.compile(r"^\s*(\d{2})([A-Z]{3})(\d{4})" + (r"\s*" + num + r"\s*" + num) * 4 + r"\s*$")
    rows = []
    for line in text.splitlines():
        m = pat.match(line)
        if not m:
            continue
        d, mon, y, *vals = m.groups()
        if mon not in MONTHS:
            raise LayoutChanged(f"unknown month {mon!r} in weekly file")
        v = [float(x) for x in vals]
        rows.append(
            {
                "week_center": pd.Timestamp(int(y), MONTHS[mon], int(d)),
                "nino12_sst": v[0], "nino12_anom": v[1],
                "nino3_sst": v[2], "nino3_anom": v[3],
                "nino34_sst": v[4], "nino34_anom": v[5],
                "nino4_sst": v[6], "nino4_anom": v[7],
            }
        )
    if not rows:
        raise LayoutChanged("no weekly rows matched")
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------------
# Scraped HTML
# --------------------------------------------------------------------------------------------


def _soup(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    # CPC leaves stale text in HTML comments (e.g. "Issued April 2026 -->"); drop it so a regex
    # can never match last month's value.
    for c in soup.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup


def _text(soup: BeautifulSoup) -> str:
    return re.sub(r"\s+", " ", soup.get_text(" ")).strip()


def _date(s: str) -> str:
    """'12 November 2026' -> '2026-11-12'."""
    return datetime.strptime(s, "%d %B %Y").date().isoformat()


def parse_discussion(html: str) -> dict[str, Any]:
    """Extract the headline fields of the monthly ENSO Diagnostic Discussion.

    Required fields (issue date, alert status, synopsis) raise LayoutChanged if absent. Optional
    numbers that are phrased differently from month to month (the Nino-3.4 value) are returned as
    None when not found -- never filled in. The full text is kept so the UI can quote CPC verbatim.
    """
    text = _text(_soup(html))

    def need(pattern: str, what: str) -> str:
        m = re.search(pattern, text)
        if not m:
            raise LayoutChanged(f"ENSO discussion: could not find {what}")
        return m.group(1).strip()

    issued = need(r"issued by CLIMATE PREDICTION CENTER/NCEP/NWS (\d{1,2} \w+ \d{4})", "issue date")
    status = need(r"ENSO Alert System Status:\s*(.+?)\s*Synopsis:", "alert status")
    synopsis = need(r"Synopsis:\s*(.+?\.)(?=\s+[A-Z])", "synopsis")

    nxt = re.search(r"next ENSO Diagnostics? Discussion is scheduled for (\d{1,2} \w+ \d{4})", text)
    n34 = re.search(r"([+\-−]?\d+\.\d)\s*°C in Niño-3\.4", text)

    start = text.find("ENSO Alert System Status")
    end = text.find("This discussion is a consolidated effort")
    body = text[start:end].strip() if start >= 0 and end > start else text

    return {
        "issued": _date(issued),
        "alert_status": status,
        "synopsis": synopsis,
        "next_issue": _date(nxt.group(1)) if nxt else None,
        "nino34_quoted_c": float(n34.group(1).replace("−", "-")) if n34 else None,
        "discussion_text": body,
        "source_url": DISCUSSION_URL,
    }


def parse_strength_table(html: str) -> pd.DataFrame:
    """Parse CPC's Official ENSO Strength Probabilities table (percent per RONI bin, per season).

    The page nests tables, so the same row appears several times; rows are matched by shape
    (season code + nine integers) and de-duplicated.
    """
    soup = _soup(html)
    issued_m = re.search(r"Issued (\w+ \d{4})", _text(soup))
    if not issued_m:
        raise LayoutChanged("strength page: no 'Issued <Month YYYY>' line")
    issued = datetime.strptime(issued_m.group(1), "%B %Y").strftime("%Y-%m")

    seen: dict[str, list[int]] = {}
    for tr in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"], recursive=False)]
        if len(cells) != 10:
            continue
        code = cells[0].split(" ")[0].upper()
        if code not in CENTER_MONTH or not all(re.fullmatch(r"\d{1,3}", c) for c in cells[1:]):
            continue
        seen.setdefault(code, [int(c) for c in cells[1:]])

    if not seen:
        raise LayoutChanged("strength page: no probability rows found")

    rows = []
    for order, (code, probs) in enumerate(seen.items()):
        total = sum(probs)
        # CPC rounds each bin, so rows sum to 100 +/- a couple of points; anything further off
        # means we are reading the wrong cells.
        if not 97 <= total <= 103:
            raise LayoutChanged(f"strength page: {code} probabilities sum to {total}")
        row = {"lead": order + 1, "season": code, "issued": issued}
        row.update({f"p_{k}": v for k, v in zip(STRENGTH_BINS, probs)})
        row["p_la_nina"] = sum(probs[:4])
        row["p_neutral"] = probs[4]
        row["p_el_nino"] = sum(probs[5:])
        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------------------------


def build_seasonal(oni: pd.DataFrame, roni: pd.DataFrame, cfg: dict[str, Any]) -> pd.DataFrame:
    ep = cfg["episode"]
    keys = ["season", "year", "center_month", "crop_year"]
    df = oni.rename(columns={"anom": "oni"}).merge(
        roni.rename(columns={"anom": "roni"}), on=keys, how="outer"
    )
    df = df.sort_values(["year", "center_month"]).reset_index(drop=True)
    args = (ep["threshold_c"], ep["min_consecutive_seasons"], ep["round_decimals"])
    for col in ("oni", "roni"):
        present = df[col].notna()
        df.loc[present, f"{col}_phase"] = classify_phases(df.loc[present, col], *args)
    df["roni_strength"] = df["roni"].map(
        lambda v: None if pd.isna(v) else strength_class(v, cfg["strength"], ep["round_decimals"])
    )
    df["roni_historic"] = df["roni"].round(ep["round_decimals"]) >= cfg["historic"]["threshold_c"]
    return df


def build_current(seasonal: pd.DataFrame, weekly: pd.DataFrame, disc: dict[str, Any]) -> pd.DataFrame:
    def latest(col: str) -> pd.Series:
        return seasonal.dropna(subset=[col]).iloc[-1]

    r, o, w = latest("roni"), latest("oni"), weekly.iloc[-1]
    row = {
        **disc,
        "roni_latest_season": f"{r.season} {r.year}",
        "roni_latest": r.roni,
        "roni_latest_phase": r.roni_phase,
        "roni_latest_strength": r.roni_strength,
        "oni_latest_season": f"{o.season} {o.year}",
        "oni_latest": o.oni,
        "weekly_latest_week": w.week_center.date().isoformat(),
        "weekly_nino34_anom": w.nino34_anom,
        "fetched_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
    }
    return pd.DataFrame([row])


def main() -> None:
    args = base_parser(__doc__ or "").parse_args()
    setup_logging(args.verbose)
    cfg = load_config("enso.yaml")

    oni = parse_index_ascii(fetch_text(ONI_URL, "cpc_oni.ascii.txt", args.refresh))
    roni = parse_index_ascii(fetch_text(RONI_URL, "cpc_roni.ascii.txt", args.refresh))
    weekly = parse_weekly(fetch_text(WEEKLY_URL, "cpc_wksst9120.for", args.refresh))
    disc = parse_discussion(fetch_text(DISCUSSION_URL, "cpc_ensodisc.html", args.refresh))
    strength = parse_strength_table(fetch_text(STRENGTH_URL, "cpc_roni_strengths.html", args.refresh))

    seasonal = build_seasonal(oni, roni, cfg)
    current = build_current(seasonal, weekly, disc)

    common = {"generated_by": "pipeline/fetch_enso.py", "rules": "config/enso.yaml"}
    write_parquet(
        seasonal,
        "enso_seasonal.parquet",
        {
            **common,
            "source_oni": ONI_URL,
            "source_roni": RONI_URL,
            "baseline_oni": "centered 30-year base periods updated every 5 years (CPC ONI v5)",
            "baseline_roni": "Nino-3.4 minus tropical-mean (20N-20S) SST anomaly, variance-rescaled (CPC)",
            "official_index": "RONI (NWS PIS 26-05, Feb 2026)",
        },
    )
    write_parquet(weekly, "enso_weekly.parquet",
                  {**common, "source": WEEKLY_URL, "climatology_baseline": "1991-2020"})
    write_parquet(current, "enso_current.parquet",
                  {**common, "source_discussion": DISCUSSION_URL, "source_index": RONI_URL})
    write_parquet(strength, "enso_strength_forecast.parquet",
                  {**common, "source": STRENGTH_URL, "verified_against": "RONI"})

    c = current.iloc[0]
    print(f"Discussion {c.issued}: {c.alert_status}")
    print(f"  {c.synopsis}")
    print(f"RONI {c.roni_latest_season}: {c.roni_latest:+.2f} C ({c.roni_latest_phase}, {c.roni_latest_strength})"
          f" | ONI {c.oni_latest_season}: {c.oni_latest:+.2f} C")
    print(f"Weekly Nino-3.4 anomaly, week of {c.weekly_latest_week}: {c.weekly_nino34_anom:+.1f} C")
    print(f"Next discussion: {c.next_issue}")
    print("\nStrength outlook (issued %s), %% chance:" % strength.issued.iloc[0])
    print(strength[["season", "p_la_nina", "p_neutral", "p_el_nino", "p_p1.5_p2.0", "p_ge_p2.0"]]
          .to_string(index=False))

    episodes = seasonal[seasonal.roni_phase == "el_nino"]
    log.info("RONI El Nino seasons since 1950: %d; very strong: %d",
             len(episodes), (episodes.roni_strength == "very_strong").sum())


if __name__ == "__main__":
    main()
