"""Block 6 wave 1: the pure climate rules (R-16, R-18, R-19, R-20) and their rounding.

Every function takes the parsed series of sources.power (fill value already dropped, so a fill day
is an absent key) and a Window. No function reads the network, the clock or a file.
"""

from __future__ import annotations

import math
import statistics
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Callable, Iterable

FILL = -999.0
WINDOW_DAYS = 42
LOOKBACK_DAYS = 120
COVERAGE_NUMERATOR = 4  # R-19: at least 80 percent, expressed as 4 of 5
COVERAGE_DENOMINATOR = 5
HOT_DAY_THRESHOLD_C = 35.0
DRY_SPELL_THRESHOLD_MM = 1.0
GDD_BASE_C = 10.0


@dataclass(frozen=True)
class Window:
    """R-16: the window, its valid rain days and the unconsolidated days after its end."""

    start: date
    end: date
    days: int
    valid_days: int
    dropped_days: int
    chosen: date


@dataclass
class Normals:
    """The included years and their values, plus the years a fill day excluded (R-20, Table B2)."""

    included: dict[int, float] = field(default_factory=dict)
    excluded: list[int] = field(default_factory=list)


def is_valid(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value != FILL


def window_days(window: Window) -> list[date]:
    return [window.start + timedelta(days=offset) for offset in range(window.days)]


def covered(valid: int, total: int) -> bool:
    """R-19: valid / total at or above 80 percent, in integers so no float rounding can move the line."""
    return valid * COVERAGE_DENOMINATOR >= total * COVERAGE_NUMERATOR


def resolve_window(rain: dict[date, float], chosen: date) -> Window | None:
    """R-16: 42 consecutive days ending on the last day at or before `chosen` with a valid rain value.

    Returns None when no valid rain day exists within LOOKBACK_DAYS before `chosen`. The window never
    moves to a neighbouring year and is never shortened: a short window is a None, not a Window.
    """
    end: date | None = None
    for offset in range(LOOKBACK_DAYS + 1):
        candidate = chosen - timedelta(days=offset)
        if is_valid(rain.get(candidate)):
            end = candidate
            break
    if end is None:
        return None
    start = end - timedelta(days=WINDOW_DAYS - 1)
    valid = sum(1 for d in _span(start, end) if is_valid(rain.get(d)))
    return Window(start=start, end=end, days=WINDOW_DAYS, valid_days=valid,
                  dropped_days=(chosen - end).days, chosen=chosen)


def _span(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def _values(series: dict[date, float], window: Window) -> list[float]:
    return [series[d] for d in window_days(window) if is_valid(series.get(d))]


def round_half_up(value: float, decimals: int):
    """Round half up at the given decimals (Table A). Zero decimals return an int."""
    quantum = Decimal(1).scaleb(-decimals)
    rounded = Decimal(repr(float(value))).quantize(quantum, rounding=ROUND_HALF_UP)
    if decimals == 0:
        return int(rounded)
    return float(rounded)


def median(values: Iterable[float]) -> float:
    return float(statistics.median(list(values)))


def percentile_rank(rank: int, of_years: int) -> int:
    """R-20: round(100 * rank / of_years), half up."""
    return round_half_up(100.0 * rank / of_years, 0)


def rank_of(current: float, earlier: dict[int, float]) -> int:
    """R-20: the number of earlier years whose total is strictly lower than the current total."""
    return sum(1 for total in earlier.values() if total < current)


def rank_for_window(window: Window, current: float, earlier: dict[int, float]) -> int | None:
    """The rank needs the whole window. A partial total compared with whole years would be a false rank."""
    if window.valid_days != window.days:
        return None
    return rank_of(current, earlier)


# --- aggregates over one window (R-18, with the R-19 coverage per aggregate) -----------------

def rain_total(rain: dict[date, float], window: Window) -> tuple[float | None, int]:
    values = _values(rain, window)
    valid = len(values)
    if not covered(valid, window.days):
        return None, valid
    return round_half_up(sum(values), 1), valid


def dry_spell_days(rain: dict[date, float], window: Window) -> tuple[int | None, int]:
    """The longest run of consecutive calendar days with rain below 1.0 mm. A missing day breaks a run."""
    valid = sum(1 for d in window_days(window) if is_valid(rain.get(d)))
    if not covered(valid, window.days):
        return None, valid
    longest = current = 0
    for day in window_days(window):
        value = rain.get(day)
        if is_valid(value) and value < DRY_SPELL_THRESHOLD_MM:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest, valid


def gdd10(tmax: dict[date, float], tmin: dict[date, float], window: Window) -> tuple[float | None, int]:
    """Sum of max(0, (T2M_MAX + T2M_MIN) / 2 - 10) over the days where both are valid."""
    days = [d for d in window_days(window) if is_valid(tmax.get(d)) and is_valid(tmin.get(d))]
    if not covered(len(days), window.days):
        return None, len(days)
    total = sum(max(0.0, (tmax[d] + tmin[d]) / 2.0 - GDD_BASE_C) for d in days)
    return round_half_up(total, 0), len(days)


def frost_days(frost: dict[date, float], window: Window) -> tuple[int | None, int]:
    values = _values(frost, window)
    if not covered(len(values), window.days):
        return None, len(values)
    return round_half_up(sum(values), 0), len(values)


def tmin_min(tmin: dict[date, float], window: Window) -> tuple[float | None, int]:
    values = _values(tmin, window)
    if not covered(len(values), window.days):
        return None, len(values)
    return round_half_up(min(values), 1), len(values)


def gwetroot_mean(root: dict[date, float], window: Window) -> tuple[float | None, int]:
    values = _values(root, window)
    if not covered(len(values), window.days):
        return None, len(values)
    return round_half_up(sum(values) / len(values), 2), len(values)


def hot_days(tmax: dict[date, float], window: Window) -> tuple[int | None, int]:
    values = _values(tmax, window)
    if not covered(len(values), window.days):
        return None, len(values)
    return sum(1 for v in values if v >= HOT_DAY_THRESHOLD_C), len(values)


# --- normals over the same calendar window in earlier years (R-20, Table B2) ------------------

def _clamped(year: int, month: int, day: int) -> date:
    """The same month and day in another year, clamped to that month's last day.

    The normals re-express the climate window in each earlier year by keeping its month and day, and
    a window built from a recent year can carry 29 February. The window is a calendar span, so when
    the day does not exist in that year the nearest valid day, the month's last, is used: that keeps
    the span within one day of its original length, where skipping the year would throw away a
    measurement and inventing another month or day would answer a different question.
    """
    return date(year, month, min(day, monthrange(year, month)[1]))


def _calendar_window(window: Window, year: int) -> list[date]:
    start = _clamped(year, window.start.month, window.start.day)
    end = _clamped(year, window.end.month, window.end.day)
    if end < start:
        # The only pair that clamps backwards is a span that crosses the new year (a December start
        # and a January end): both endpoints land in `year` and the end comes before the start. The
        # span is the one that ends in the following year, so the end moves there instead of the
        # window being shortened or dropped.
        end = _clamped(year + 1, window.end.month, window.end.day)
    return _span(start, end)


def normal_totals(
    series_by_year: dict[int, dict[date, float]],
    window: Window,
    years: Iterable[int],
    reducer: Callable[[list[float]], float] | None = None,
) -> Normals:
    """Reduce each year's calendar window. A year with any invalid day in its window is excluded."""
    reduce = reducer or (lambda values: sum(values))
    result = Normals()
    for year in years:
        if year == window.end.year:
            continue  # the current year is not one of the earlier years
        series = series_by_year.get(year, {})
        days = _calendar_window(window, year)
        if not all(is_valid(series.get(d)) for d in days):
            result.excluded.append(year)
            continue
        result.included[year] = reduce([series[d] for d in days])
    return result


def hot_counts(series_by_year: dict[int, dict[date, float]], window: Window, years: Iterable[int]) -> Normals:
    return normal_totals(
        series_by_year,
        window,
        years,
        reducer=lambda values: sum(1 for v in values if v >= HOT_DAY_THRESHOLD_C),
    )
