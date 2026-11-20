"""Regression tests for the pit-out lap policy.

A pit-out lap's telemetry window starts after the official lap clock, so its
trace is legitimately shorter than the recorded duration. That is only excusable
when the source explicitly flags the lap as pit-out; every other short trace must
stay fatal.
"""

from __future__ import annotations

import pytest

from src.load.telemetry_importer import CHANNEL_MAP, ValidationError, check_lap


def make_series(samples: int, end_time: float) -> dict[str, list]:
    """A minimal, valid telemetry series whose elapsed time ends at ``end_time``."""
    series: dict[str, list] = {column: [None] * samples for _, column in CHANNEL_MAP}
    series["elapsed_s"] = [round(end_time * i / (samples - 1), 4) for i in range(samples)]
    for index in range(samples):
        series["rel_distance"][index] = index / (samples - 1)
        series["speed_kmh"][index] = 200.0
        series["throttle_pct"][index] = 100.0
    return series


def make_meta(duration: float, pit_out: bool = False) -> dict:
    return {
        "lap_number": 1,
        "duration": duration,
        "sector_1": None,
        "sector_2": None,
        "sector_3": None,
        "has_pit_out": pit_out,
        "has_pit_in": False,
        "pit_out": None,
        "pit_in": None,
    }


def test_pit_out_short_trace_is_ineligible_not_fatal() -> None:
    """Australia VER lap 1: 96.680 s of trace against a 98.807 s lap."""
    reasons = check_lap(make_meta(98.807, pit_out=True), make_series(50, 96.680), pit_out=True)

    assert len(reasons) == 1
    assert reasons[0].startswith("pit-out lap:")
    assert "2.127 s shorter" in reasons[0]


def test_non_pit_out_short_trace_is_still_fatal() -> None:
    with pytest.raises(ValidationError, match="trace ends at 96.680 s"):
        check_lap(make_meta(98.807), make_series(50, 96.680))


def test_pit_out_does_not_excuse_a_longer_trace() -> None:
    """Only shortfalls are a pit-out artefact; extra time is a real problem."""
    with pytest.raises(ValidationError, match="trace ends at"):
        check_lap(make_meta(98.807, pit_out=True), make_series(50, 101.0), pit_out=True)


def test_openf1_pit_out_flag_excuses_a_short_trace() -> None:
    """The archive did not flag it, OpenF1 did - still explicit metadata."""
    assert check_lap(make_meta(98.807, pit_out=False), make_series(50, 96.680), pit_out=True)


def test_matching_trace_passes_for_a_pit_out_lap() -> None:
    assert check_lap(make_meta(98.807, pit_out=True), make_series(50, 98.807), pit_out=True) == []


def test_pit_out_lap_with_non_monotonic_time_is_still_fatal() -> None:
    series = make_series(50, 96.680)
    series["elapsed_s"][10] = series["elapsed_s"][9]

    with pytest.raises(ValidationError, match="not strictly increasing"):
        check_lap(make_meta(98.807, pit_out=True), series, pit_out=True)


def test_pit_out_lap_with_missing_elapsed_is_still_fatal() -> None:
    series = make_series(50, 96.680)
    series["elapsed_s"][5] = None

    with pytest.raises(ValidationError, match="missing value"):
        check_lap(make_meta(98.807, pit_out=True), series, pit_out=True)
