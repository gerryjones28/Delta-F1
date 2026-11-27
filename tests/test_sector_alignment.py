"""Tests for :mod:`src.analysis.sector_alignment`.

These are integration tests: the telemetry comes from the read-only Supabase
database, exactly as the module will use it. When the database is unreachable the
tests skip rather than fail, like the other integration tests in this folder.

Two cases are covered:

* Spa 2025 qualifying, VER lap 2 vs LEC lap 4 - the pair the method was developed
  on, with the known +0.343 / +0.374 / +0.431 s official cumulative deltas.
* Zandvoort 2025 qualifying, PIA lap 14 vs NOR lap 14 - a different circuit, a
  68.6 s lap and a 12 ms lap delta, which is the case where the alignment
  uncertainty is larger than the result itself.
"""

from __future__ import annotations

import json

import numpy as np
import psycopg
import pytest

from src.analysis.sector_alignment import (
    AlignmentError,
    LapSelector,
    SessionSelector,
    compare_laps,
)
from src.database import ConfigurationError

SPA = SessionSelector(year=2025, event_name="Belgian Grand Prix")
ZANDVOORT = SessionSelector(year=2025, event_name="Dutch Grand Prix")

SPA_REFERENCE = LapSelector("VER", 2)
SPA_COMPARE = LapSelector("LEC", 4)
ZANDVOORT_REFERENCE = LapSelector("PIA", 14)
ZANDVOORT_COMPARE = LapSelector("NOR", 14)


def load(session: SessionSelector, reference: LapSelector, compare: LapSelector):
    """Run the comparison, or skip when the database is not reachable."""
    try:
        return compare_laps(session, reference, compare)
    except (ConfigurationError, psycopg.OperationalError) as exc:  # pragma: no cover
        pytest.skip(f"database unavailable: {exc}")


@pytest.fixture(scope="module")
def spa():
    return load(SPA, SPA_REFERENCE, SPA_COMPARE)


@pytest.fixture(scope="module")
def zandvoort():
    return load(ZANDVOORT, ZANDVOORT_REFERENCE, ZANDVOORT_COMPARE)


# ---------------------------------------------------------------------------
# Measured values: must match the laps table exactly
# ---------------------------------------------------------------------------
def test_spa_measured_timing(spa) -> None:
    measured = spa.measured
    assert measured.reference_lap_s == pytest.approx(102.066, abs=1e-6)
    assert measured.compare_lap_s == pytest.approx(101.635, abs=1e-6)
    assert measured.sector_deltas == pytest.approx((0.343, 0.031, 0.057), abs=1e-6)
    assert measured.cumulative_deltas == pytest.approx((0.343, 0.374, 0.431), abs=1e-6)
    assert measured.lap_delta_s == pytest.approx(0.431, abs=1e-6)


def test_spa_sampling_is_preserved(spa) -> None:
    reference, compare = spa.samples
    assert (reference.driver_code, reference.lap_number) == ("VER", 2)
    assert (compare.driver_code, compare.lap_number) == ("LEC", 4)
    assert reference.samples == 745
    assert compare.samples == 751
    assert reference.spans_full_clock and compare.spans_full_clock
    assert reference.distance_span_m == pytest.approx(6938.1, abs=0.1)
    assert compare.distance_span_m == pytest.approx(6964.5, abs=0.1)


def test_zandvoort_measured_timing(zandvoort) -> None:
    measured = zandvoort.measured
    assert measured.reference_lap_s == pytest.approx(68.662, abs=1e-6)
    assert measured.compare_lap_s == pytest.approx(68.674, abs=1e-6)
    assert measured.sector_deltas == pytest.approx((-0.019, 0.082, -0.075), abs=1e-6)
    assert measured.cumulative_deltas == pytest.approx((-0.019, 0.063, -0.012), abs=1e-6)
    assert measured.lap_delta_s == pytest.approx(-0.012, abs=1e-6)

# ---------------------------------------------------------------------------
# Estimated values: what the method guarantees, and what it must not do
# ---------------------------------------------------------------------------
def test_boundaries_equal_measured_sector_deltas_by_construction(spa) -> None:
    """Anchored, not fitted: the curve passes through the measured sector times."""
    axis, delta = spa.axis, spa.delta_s
    for boundary, expected in zip(axis.boundaries, spa.measured.cumulative_deltas):
        assert boundary.progress == pytest.approx(
            boundary.distance_m / axis.length_m, abs=1e-12)
        assert boundary.cumulative_delta_s == pytest.approx(expected, abs=1e-9)
        curve = float(np.interp(boundary.progress, axis.progress, delta))
        assert curve == pytest.approx(expected, abs=2e-3)


def test_curve_is_not_forced_to_the_official_lap_delta(spa) -> None:
    """The interior of the curve is free, so it must overshoot the official value."""
    assert spa.delta_s.max() > spa.measured.lap_delta_s + 0.15
    assert spa.delta_s.min() < 0.0


def test_aligned_channels_are_consistent(spa) -> None:
    axis = spa.axis
    assert len(axis.progress) == axis.grid_points == len(spa.delta_s)
    assert np.all(np.diff(axis.progress) > 0)
    assert axis.progress[0] == pytest.approx(0.0, abs=1e-12)
    assert axis.progress[-1] == pytest.approx(1.0, abs=1e-9)
    assert axis.length_m == pytest.approx(6951.3, abs=0.5)

    for role in ("reference", "compare"):
        channels = spa.elapsed[role]
        assert np.all(np.diff(channels.elapsed_s) > 0)
        assert channels.speed_kmh.min() >= 0.0
        assert channels.speed_kmh.max() < 380.0
        assert channels.throttle_pct.min() >= -0.01
        assert channels.throttle_pct.max() <= 100.01
        assert set(np.unique(channels.brake)) <= {0.0, 1.0}

    assert spa.elapsed["reference"].elapsed_s[0] == pytest.approx(0.0, abs=1e-9)
    assert spa.delta_s[0] == pytest.approx(0.0, abs=1e-9)


def test_coverage_is_reported(spa) -> None:
    coverage = spa.coverage
    assert coverage.complete_lap
    assert coverage.compared_progress[0] == 0.0
    assert coverage.compared_progress[1] <= 1.0
    assert coverage.reference_uncovered_m < 1.0
    assert coverage.compare_uncovered_m < 1.0


def test_spa_uncertainty_flags_the_chicane_feature(spa) -> None:
    """The residual final-chicane bump cannot be attributed to pace."""
    uncertainty = spa.uncertainty
    assert [item.sector for item in uncertainty.sectors] == [1, 2, 3]
    # sector 2 carries most of the distance-scale divergence for this pair
    assert uncertainty.sectors[1].divergence_m == pytest.approx(17.2, abs=1.0)
    assert (uncertainty.sectors[1].seconds_worst_case
            > uncertainty.sectors[2].seconds_worst_case)

    tail = spa.axis.progress >= 0.95
    swing = float(spa.delta_s[tail].max() - spa.delta_s[-1])
    assert swing > 0.1                      # the feature exists on the curve
    assert abs(swing) < uncertainty.stated_seconds
    # 0.20 s at chicane speed is ~4-5 m of position, the same order as sector 3's
    # own 3.2 m divergence, so the bump is not a supportable pace difference.
    assert swing < 2 * uncertainty.sectors[2].seconds_worst_case
    assert uncertainty.sectors[2].seconds_worst_case < uncertainty.stated_seconds
    assert not spa.feature_is_resolved(swing)
    assert uncertainty.typical_seconds <= uncertainty.stated_seconds


def test_zandvoort_alignment_error_exceeds_the_lap_delta(zandvoort) -> None:
    """A 12 ms lap delta cannot be decomposed into corner gains."""
    result = zandvoort
    assert result.axis.length_m == pytest.approx(4247.0, abs=1.0)
    for boundary, expected in zip(result.axis.boundaries,
                                  result.measured.cumulative_deltas):
        curve = float(np.interp(boundary.progress, result.axis.progress, result.delta_s))
        assert curve == pytest.approx(expected, abs=2e-3)
    assert result.uncertainty.stated_seconds > 10 * abs(result.measured.lap_delta_s)
    assert not result.feature_is_resolved(0.05)

# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------
def test_missing_lap_raises_alignment_error() -> None:
    try:
        compare_laps(SPA, SPA_REFERENCE, LapSelector("LEC", 99))
    except (ConfigurationError, psycopg.OperationalError) as exc:  # pragma: no cover
        pytest.skip(f"database unavailable: {exc}")
    except AlignmentError as exc:
        assert "LEC" in str(exc) and "99" in str(exc)
    else:  # pragma: no cover
        pytest.fail("a missing lap must not be aligned silently")


def test_same_lap_is_rejected() -> None:
    same = LapSelector("VER", 2)
    with pytest.raises(AlignmentError):
        compare_laps(SPA, same, same)


def test_grid_points_are_validated() -> None:
    with pytest.raises(AlignmentError):
        compare_laps(SPA, SPA_REFERENCE, SPA_COMPARE, grid_points=5)


# ---------------------------------------------------------------------------
# API shape
# ---------------------------------------------------------------------------
def test_result_is_json_serialisable(spa) -> None:
    payload = json.loads(json.dumps(spa.as_dict()))
    assert set(payload) == {
        "session", "reference_lap", "compare_lap", "measured", "samples", "axis",
        "elapsed", "delta_s", "coverage", "uncertainty", "caveats",
    }
    assert payload["measured"]["lap_delta_s"] == pytest.approx(0.431)
    assert len(payload["axis"]["progress"]) == spa.axis.grid_points
    assert set(payload["elapsed"]) == {"reference", "compare"}
    assert set(payload["elapsed"]["reference"]) == {
        "driver_code", "lap_number", "elapsed_s", "speed_kmh", "throttle_pct", "brake", "positions", "gear",
    }
    assert payload["samples"][0]["samples"] == 745
    assert payload["uncertainty"]["stated_seconds"] > 0
    assert any("not independent evidence" in caveat for caveat in payload["caveats"])
