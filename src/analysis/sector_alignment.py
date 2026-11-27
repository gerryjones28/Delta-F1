"""Sector-anchored alignment of two qualifying laps, read-only from PostgreSQL.

Why this module exists
----------------------
Normalized-distance alignment (``tests/plot_lap_delta.py``) and absolute-distance
alignment both treat the stored distance axis as comparable between laps. It is
not: for a 2025 Spa pair the two ``distance_m`` axes differ by 26.4 m over a lap,
and the divergence accumulates unevenly (+6.1 m in sector 1, +17.2 m in sector 2,
+3.2 m in sector 3). Aligning on normalized progress therefore leaves a position
error that grows from 0 to ~26 m and shows up as a fake 0.4 s swing in the final
chicane; aligning on absolute distance is worse still, because equal distance_m is
not the same physical place.

What this module computes
-------------------------
1. Both laps are resolved through relational joins
   (event -> session -> session_entry -> driver/lap), never by lap_id.
2. The three measured sector times give four anchors: start, S1 end, S2 end, lap
   end. Each lap's distance at an anchor is interpolated from its own samples.
3. A lap's own anchor distances are mapped onto the mean of the two laps', so the
   distance-scale error is absorbed inside the sector where it was accumulated.
4. Elapsed time (and speed/throttle/brake) are interpolated onto that common axis
   and differenced as ``delta = reference - compare``.

What this module does not claim
-------------------------------
* The delta at the three sector boundaries equals the measured sector deltas by
  construction. Those three values are not independent evidence of accuracy.
* Inside a sector nothing anchors the curve. The residual is bounded by that
  sector's own share of the distance divergence, which is reported as an explicit
  uncertainty (see ``AlignmentUncertainty``).
* Features of the delta curve smaller than ``AlignmentUncertainty.stated_seconds``
  are not supported as pace differences; use
  :meth:`AlignmentResult.feature_is_resolved`.

Measured versus estimated
-------------------------
``OfficialTiming`` and ``LapSample`` carry column values only. ``AlignedAxis``,
``AlignedChannels``, ``delta_s`` and ``AlignmentUncertainty`` are all estimates
produced by interpolation and are returned in clearly separate fields.
"""

from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from typing import Any, Sequence

import numpy as np

from src.load.telemetry_importer import connect, load_database_url

__all__ = [
    "AlignedAxis",
    "AlignedChannels",
    "AlignmentError",
    "AlignmentResult",
    "AlignmentUncertainty",
    "LapSample",
    "LapSelector",
    "OfficialTiming",
    "SectorBoundary",
    "SectorUncertainty",
    "SessionSelector",
    "TraceCoverage",
    "compare_laps",
]

GRID_POINTS = 2000            # samples on the returned common axis
MIN_SAMPLES = 50              # below this a lap is not worth aligning
SECTOR_SUM_TOLERANCE_S = 0.05  # sector times must add up to the lap duration
DISTANCE_TOLERANCE_M = 1e-6    # distance_m must be non-decreasing


class AlignmentError(RuntimeError):
    """Raised when a lap cannot be resolved or is not safe to align."""


# ---------------------------------------------------------------------------
# Selectors - what the caller asks for, never a database identifier
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SessionSelector:
    """One session, identified the way a human or API client would identify it."""

    year: int
    event_name: str
    session_type: str = "Qualifying"


@dataclass(frozen=True)
class LapSelector:
    driver_code: str
    lap_number: int


# ---------------------------------------------------------------------------
# Measured results - straight from columns, no interpolation
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class OfficialTiming:
    """Measured timing, exactly as stored in the ``laps`` table."""

    reference_lap_s: float
    compare_lap_s: float
    sector_deltas: tuple[float, float, float]
    cumulative_deltas: tuple[float, float, float]
    lap_delta_s: float
    source: str = "laps.lap_duration / laps.sector_1..3"


@dataclass(frozen=True)
class LapSample:
    """Sampling description of one lap's stored trace (measured)."""

    driver_code: str
    lap_number: int
    samples: int
    first_elapsed_s: float
    last_elapsed_s: float
    first_rel_distance: float
    last_rel_distance: float
    distance_span_m: float
    median_spacing_m: float
    max_spacing_m: float
    median_spacing_s: float
    duration_s: float

    @property
    def spans_full_clock(self) -> bool:
        """True when the trace reaches the recorded lap duration."""
        return abs(self.last_elapsed_s - self.duration_s) <= 0.002


# ---------------------------------------------------------------------------
# Estimated results - produced by interpolation and re-parameterisation
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SectorBoundary:
    """One sector line placed on the common axis (estimated position)."""

    sector: int
    progress: float          # 0..1 along the common axis
    distance_m: float        # common-axis distance at the line
    cumulative_delta_s: float  # equals the measured sector delta by construction


@dataclass(frozen=True)
class AlignedAxis:
    """The common progress axis and the sector lines placed on it."""

    progress: np.ndarray
    distance_m: np.ndarray
    boundaries: tuple[SectorBoundary, SectorBoundary, SectorBoundary]
    grid_points: int

    @property
    def length_m(self) -> float:
        return float(self.distance_m[-1])


@dataclass(frozen=True)
class AlignedChannels:
    """One lap's channels interpolated onto the common axis (all estimated)."""

    driver_code: str
    lap_number: int
    elapsed_s: np.ndarray
    speed_kmh: np.ndarray
    throttle_pct: np.ndarray
    brake: np.ndarray
    positions: list | None = None
    gear: list[int | None] | None = None


@dataclass(frozen=True)
class TraceCoverage:
    """How much of the lap each trace actually covers (measured end points)."""

    reference_progress: tuple[float, float]
    compare_progress: tuple[float, float]
    compared_progress: tuple[float, float]
    reference_uncovered_m: float
    compare_uncovered_m: float
    complete_lap: bool
    notes: tuple[str, ...]


@dataclass(frozen=True)
class SectorUncertainty:
    """Residual alignment error left inside one sector.

    ``divergence_m`` is the difference between the two laps' own distance spans
    over the sector - the part of the scale error the anchors cannot see. Turning
    it into seconds needs a speed, so both a mean-speed indicator and a worst-case
    bound (at the sector's slowest sample) are reported.
    """

    sector: int
    reference_span_m: float
    compare_span_m: float
    divergence_m: float
    mean_speed_kmh: float
    slowest_speed_kmh: float
    seconds_at_mean_speed: float
    seconds_worst_case: float


@dataclass(frozen=True)
class AlignmentUncertainty:
    """Estimated (not measured) alignment accuracy, stated conservatively."""

    sectors: tuple[SectorUncertainty, SectorUncertainty, SectorUncertainty]
    sample_spacing_m: float
    sample_spacing_seconds: float
    typical_seconds: float
    stated_seconds: float
    note: str


@dataclass(frozen=True)
class AlignmentResult:
    """Everything one comparison returns.

    ``measured`` and ``samples`` are column values. ``axis``, ``elapsed``,
    ``delta_s``, ``coverage`` and ``uncertainty`` are estimates.
    """

    session: SessionSelector
    reference_lap: LapSelector
    compare_lap: LapSelector
    measured: OfficialTiming
    samples: tuple[LapSample, LapSample]
    axis: AlignedAxis
    elapsed: dict[str, AlignedChannels]
    delta_s: np.ndarray
    coverage: TraceCoverage
    uncertainty: AlignmentUncertainty
    caveats: tuple[str, ...]

    def sector_at(self, progress: float) -> SectorUncertainty:
        """The sector containing ``progress`` (0..1 on the common axis)."""
        for boundary in self.axis.boundaries:
            if progress <= boundary.progress:
                return self.uncertainty.sectors[boundary.sector - 1]
        return self.uncertainty.sectors[-1]

    def feature_is_resolved(self, change_s: float, progress: float | None = None,
                            conservative: bool = True) -> bool:
        """True only when a delta change exceeds the alignment error there.

        Apply this to features read off the curve, not to ``measured`` values: the
        sector and lap times need no alignment. With ``progress`` the local sector
        bound is used, otherwise the worst sector. ``conservative=False`` relaxes
        the bound to the mean-speed estimate, which is an indicator rather than a
        guarantee.
        """
        if progress is not None:
            sector = self.sector_at(progress)
            limit = sector.seconds_worst_case if conservative else sector.seconds_at_mean_speed
        else:
            limit = self.uncertainty.stated_seconds if conservative \
                else self.uncertainty.typical_seconds
        return abs(change_s) > limit

    def as_dict(self) -> dict[str, Any]:
        """JSON-friendly copy (numpy arrays become lists)."""
        return _jsonable(self)

# ---------------------------------------------------------------------------
# Retrieval - read-only, resolved through relational joins
# ---------------------------------------------------------------------------
LAP_SQL = """
    SELECT l.lap_id, l.lap_duration, l.sector_1, l.sector_2, l.sector_3
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    JOIN drivers d ON d.driver_id = se.driver_id
    WHERE e.year = %s
      AND e.event_name = %s
      AND s.session_type = %s
      AND d.abbreviation = %s
      AND l.lap_number = %s
"""

SAMPLE_SQL = """
    SELECT t.elapsed_s, t.rel_distance, t.distance_m,
           t.speed_kmh, t.throttle_pct, t.brake, t.x, t.y, t.gear
    FROM telemetry_samples t
    WHERE t.lap_id = %s
    ORDER BY t.sample_index
"""


def _to_float(value: object) -> float:
    """Coerce a database scalar (bool/int/Decimal/str) to float."""
    if value is None:
        raise AlignmentError("a required telemetry value is NULL")
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    return float(value)


def _resolve_lap(conn, session: SessionSelector, lap: LapSelector) -> dict:
    """One lap row, matched by event/session/driver/lap number."""
    with conn.cursor() as cur:
        cur.execute(
            LAP_SQL,
            (session.year, session.event_name, session.session_type,
             lap.driver_code, lap.lap_number),
        )
        rows = cur.fetchall()

    if not rows:
        raise AlignmentError(
            f"no {session.session_type} lap {lap.lap_number} for {lap.driver_code} "
            f"at the {session.year} {session.event_name}"
        )
    if len(rows) > 1:
        raise AlignmentError(
            f"ambiguous: {len(rows)} laps match {lap.driver_code} lap "
            f"{lap.lap_number} at the {session.year} {session.event_name}"
        )

    lap_id, duration, s1, s2, s3 = rows[0]
    if duration is None or None in (s1, s2, s3):
        raise AlignmentError(
            f"{lap.driver_code} lap {lap.lap_number} has no usable timing "
            f"(duration={duration}, sectors={s1}/{s2}/{s3})"
        )
    return {"lap_id": lap_id, "duration": float(duration),
            "sectors": (float(s1), float(s2), float(s3))}


def _fetch_samples(conn, lap_id: int) -> dict[str, np.ndarray]:
    """All samples of one lap as float arrays, ordered by sample_index."""
    with conn.cursor() as cur:
        cur.execute(SAMPLE_SQL, (lap_id,))
        rows = cur.fetchall()
    if not rows:
        raise AlignmentError(f"lap {lap_id} has no telemetry samples")

    columns = ("elapsed_s", "rel_distance", "distance_m", "speed_kmh",
               "throttle_pct", "brake")
    series = {
        name: np.array([_to_float(row[index]) for row in rows], dtype=float)
        for index, name in enumerate(columns)
    }
    if len(rows[0]) >= 8:
        series["xy"] = np.asarray([row[6:8] for row in rows], dtype=float)
    if len(rows[0]) >= 9:
        series["gear"] = np.asarray([row[8] for row in rows], dtype=float)
    return series


def _validate_and_describe(lap: dict, series: dict[str, np.ndarray],
                          selector: LapSelector) -> LapSample:
    """Reject laps that cannot be aligned; return their sampling description."""
    elapsed = series["elapsed_s"]
    distance = series["distance_m"]
    if len(elapsed) < MIN_SAMPLES:
        raise AlignmentError(
            f"{selector.driver_code} lap {selector.lap_number}: "
            f"{len(elapsed)} samples, need at least {MIN_SAMPLES}"
        )
    if np.any(np.diff(elapsed) <= 0):
        raise AlignmentError(
            f"{selector.driver_code} lap {selector.lap_number}: elapsed_s is not "
            "strictly increasing"
        )
    if np.any(np.diff(distance) < -DISTANCE_TOLERANCE_M):
        raise AlignmentError(
            f"{selector.driver_code} lap {selector.lap_number}: distance_m "
            "decreases"
        )
    span = float(distance[-1] - distance[0])
    if span < 1000.0:
        raise AlignmentError(
            f"{selector.driver_code} lap {selector.lap_number}: distance_m spans "
            f"only {span:.1f} m"
        )
    sector_sum = sum(lap["sectors"])
    if abs(sector_sum - lap["duration"]) > SECTOR_SUM_TOLERANCE_S:
        raise AlignmentError(
            f"{selector.driver_code} lap {selector.lap_number}: sector times sum "
            f"to {sector_sum:.3f} s but the lap is {lap['duration']:.3f} s"
        )

    spacing = np.diff(distance)
    spacing_s = np.diff(elapsed)
    return LapSample(
        driver_code=selector.driver_code,
        lap_number=selector.lap_number,
        samples=int(len(elapsed)),
        first_elapsed_s=float(elapsed[0]),
        last_elapsed_s=float(elapsed[-1]),
        first_rel_distance=float(series["rel_distance"][0]),
        last_rel_distance=float(series["rel_distance"][-1]),
        distance_span_m=span,
        median_spacing_m=float(np.median(spacing)),
        max_spacing_m=float(spacing.max()),
        median_spacing_s=float(np.median(spacing_s)),
        duration_s=lap["duration"],
    )

# ---------------------------------------------------------------------------
# The sector-anchored alignment itself
# ---------------------------------------------------------------------------
def _anchors(lap: dict, series: dict[str, np.ndarray]) -> tuple[np.ndarray, list[str]]:
    """Measured anchor times and the distances interpolated at those times."""
    s1, s2, s3 = lap["sectors"]
    times = np.array([series["elapsed_s"][0], s1, s1 + s2, lap["duration"]])
    notes: list[str] = []
    missing_s = lap["duration"] - float(series["elapsed_s"][-1])
    if missing_s > 0.002:
        final_speed = float(series["speed_kmh"][-1]) / 3.6
        notes.append(
            f"trace ends {missing_s:.3f} s before the recorded lap clock "
            f"(~{missing_s * final_speed:.0f} m at the final speed); the last anchor "
            "is clamped to the last sample"
        )
    distances = np.array([
        series["distance_m"][0],
        float(np.interp(s1, series["elapsed_s"], series["distance_m"])),
        float(np.interp(s1 + s2, series["elapsed_s"], series["distance_m"])),
        series["distance_m"][-1],
    ])
    return np.column_stack([times, distances]), notes


def _step_interp(query: np.ndarray, xp: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """Value of the last sample at or before each query (for boolean channels)."""
    index = np.searchsorted(xp, query, side="right") - 1
    return fp[np.clip(index, 0, len(fp) - 1)]


def _sector_uncertainty(series_ref: dict[str, np.ndarray],
                        series_cmp: dict[str, np.ndarray],
                        src_ref: np.ndarray, src_cmp: np.ndarray,
                        sectors_ref: Sequence[float],
                        sectors_cmp: Sequence[float]) -> tuple[SectorUncertainty, ...]:
    """Residual error C leaves inside each sector, from that sector's own divergence."""
    items = []
    for index in range(3):
        span_ref = float(src_ref[index + 1] - src_ref[index])
        span_cmp = float(src_cmp[index + 1] - src_cmp[index])
        divergence = abs(span_cmp - span_ref)
        mean_speed = min(span_ref / sectors_ref[index] * 3.6,
                         span_cmp / sectors_cmp[index] * 3.6)
        slowest = min(_sector_min_speed(series_ref, src_ref, index),
                      _sector_min_speed(series_cmp, src_cmp, index))
        items.append(SectorUncertainty(
            sector=index + 1,
            reference_span_m=span_ref,
            compare_span_m=span_cmp,
            divergence_m=divergence,
            mean_speed_kmh=mean_speed,
            slowest_speed_kmh=slowest,
            seconds_at_mean_speed=divergence / (mean_speed / 3.6) if mean_speed > 0 else float("inf"),
            seconds_worst_case=divergence / (slowest / 3.6) if slowest > 0 else float("inf"),
        ))
    return tuple(items)  # type: ignore[return-value]


def _sector_min_speed(series: dict[str, np.ndarray], src: np.ndarray, index: int) -> float:
    """Slowest stored speed inside one sector (measured, no interpolation)."""
    distance = series["distance_m"] - series["distance_m"][0]
    mask = (distance >= src[index]) & (distance <= src[index + 1])
    if not mask.any():
        return float(series["speed_kmh"].min())
    return float(series["speed_kmh"][mask].min())


def _jsonable(value: Any) -> Any:
    """Recursively convert dataclasses and numpy arrays to plain Python."""
    if is_dataclass(value) and not isinstance(value, type):
        return {item.name: _jsonable(getattr(value, item.name)) for item in fields(value)}
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


CAVEATS = (
    "the delta at the three sector boundaries equals the measured sector deltas by "
    "construction and is not independent evidence of accuracy",
    "inside a sector nothing anchors the curve: the residual is bounded by that "
    "sector's own distance divergence, reported in `uncertainty`",
    "the first stored sample is treated as the start line for both laps, which is "
    "the definition of the lap; no other offset is applied anywhere",
    "the common axis ends where the shorter trace ends, so the last few metres are "
    "outside the compared range",
)

def compare_laps(
    session: SessionSelector,
    reference: LapSelector,
    compare: LapSelector,
    *,
    grid_points: int = GRID_POINTS,
    database_url: str | None = None,
) -> AlignmentResult:
    """Align two laps of one session on a sector-anchored common axis.

    Args:
        session: which session the laps belong to.
        reference: lap whose elapsed time is the minuend (``delta > 0`` means the
            reference lap used more time to reach the same position).
        compare: the lap it is compared against.
        grid_points: resolution of the returned common axis.
        database_url: optional override; by default ``DATABASE_URL`` is loaded
            through the existing importer utilities.

    Returns:
        :class:`AlignmentResult` with measured timing and sampling kept separate
        from the interpolated axis, channels and delta.

    Raises:
        AlignmentError: the lap cannot be resolved, is ambiguous, has no usable
            sector times, or its trace is not safe to interpolate.
    """
    if (reference.driver_code, reference.lap_number) == (
            compare.driver_code, compare.lap_number):
        raise AlignmentError("reference and compare selectors point at the same lap")
    if grid_points < 10:
        raise AlignmentError("grid_points must be at least 10")

    if database_url is None:
        database_url, _env = load_database_url()

    conn = connect(database_url)
    try:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            lap_ref = _resolve_lap(conn, session, reference)
            lap_cmp = _resolve_lap(conn, session, compare)
            series_ref = _fetch_samples(conn, lap_ref["lap_id"])
            series_cmp = _fetch_samples(conn, lap_cmp["lap_id"])
    finally:
        conn.close()

    sample_ref = _validate_and_describe(lap_ref, series_ref, reference)
    sample_cmp = _validate_and_describe(lap_cmp, series_cmp, compare)
    return _build_result(session, reference, compare, lap_ref, lap_cmp,
                         series_ref, series_cmp, sample_ref, sample_cmp, grid_points)

def _build_result(session: SessionSelector, reference: LapSelector,
                  compare: LapSelector, lap_ref: dict, lap_cmp: dict,
                  series_ref: dict[str, np.ndarray], series_cmp: dict[str, np.ndarray],
                  sample_ref: LapSample, sample_cmp: LapSample,
                  grid_points: int) -> AlignmentResult:
    """Assemble the alignment from validated inputs."""
    anchors_ref, notes_ref = _anchors(lap_ref, series_ref)
    anchors_cmp, notes_cmp = _anchors(lap_cmp, series_cmp)
    src_ref = anchors_ref[:, 1] - anchors_ref[0, 1]
    src_cmp = anchors_cmp[:, 1] - anchors_cmp[0, 1]
    common = 0.5 * (src_ref + src_cmp)

    s_ref = np.interp(series_ref["distance_m"] - series_ref["distance_m"][0],
                      src_ref, common)
    s_cmp = np.interp(series_cmp["distance_m"] - series_cmp["distance_m"][0],
                      src_cmp, common)
    end = float(min(s_ref[-1], s_cmp[-1]))
    if end <= 1.0:
        raise AlignmentError("the two traces have no usable common range")
    grid = np.linspace(0.0, end, grid_points)

    def channels(series: dict[str, np.ndarray], mapped: np.ndarray,
                 selector: LapSelector) -> AlignedChannels:
        times = series["elapsed_s"]
        aligned_time = np.interp(grid, mapped, times)
        positions = None
        if "xy" in series:
            right = np.searchsorted(times, aligned_time).clip(0, len(times)-1)
            left = (right-1).clip(0)
            closest = np.where(aligned_time-times[left] < times[right]-aligned_time, left, right)
            positions = [
                series["xy"][j].tolist()
                if abs(times[j]-t) <= .35 and np.isfinite(series["xy"][j]).all() else None
                for t, j in zip(aligned_time, closest)
            ]
        return AlignedChannels(
            positions=positions,
            driver_code=selector.driver_code,
            lap_number=selector.lap_number,
            elapsed_s=aligned_time,
            speed_kmh=np.interp(grid, mapped, series["speed_kmh"]),
            throttle_pct=np.interp(grid, mapped, series["throttle_pct"]),
            brake=_step_interp(grid, mapped, series["brake"]),
            gear=([int(g) if np.isfinite(g) else None
                   for g in _step_interp(grid, mapped, series["gear"])]
                  if "gear" in series else None),
        )

    elapsed = {"reference": channels(series_ref, s_ref, reference),
               "compare": channels(series_cmp, s_cmp, compare)}
    delta = elapsed["reference"].elapsed_s - elapsed["compare"].elapsed_s

    sector_deltas = tuple(a - b for a, b in zip(lap_ref["sectors"], lap_cmp["sectors"]))
    lap_delta = lap_ref["duration"] - lap_cmp["duration"]
    cumulative = (sector_deltas[0], sector_deltas[0] + sector_deltas[1], lap_delta)
    measured = OfficialTiming(
        reference_lap_s=lap_ref["duration"],
        compare_lap_s=lap_cmp["duration"],
        sector_deltas=sector_deltas,  # type: ignore[arg-type]
        cumulative_deltas=cumulative,  # type: ignore[arg-type]
        lap_delta_s=lap_delta,
    )
    total = float(common[-1])
    boundaries = tuple(
        SectorBoundary(sector=index + 1,
                       progress=float(common[index + 1] / total),
                       distance_m=float(common[index + 1]),
                       cumulative_delta_s=cumulative[index])
        for index in range(3)  # type: ignore[arg-type]
    )
    axis = AlignedAxis(progress=grid / total, distance_m=grid,
                       boundaries=boundaries,  # type: ignore[arg-type]
                       grid_points=grid_points)

    sectors_unc = _sector_uncertainty(series_ref, series_cmp, src_ref, src_cmp,
                                      lap_ref["sectors"], lap_cmp["sectors"])
    spacing_m = max(sample_ref.median_spacing_m, sample_cmp.median_spacing_m)
    spacing_s = 0.5 * max(sample_ref.median_spacing_s, sample_cmp.median_spacing_s)
    typical = max(item.seconds_at_mean_speed for item in sectors_unc) + spacing_s
    stated = max(item.seconds_worst_case for item in sectors_unc) + spacing_s
    uncertainty = AlignmentUncertainty(
        sectors=sectors_unc,  # type: ignore[arg-type]
        sample_spacing_m=spacing_m,
        sample_spacing_seconds=spacing_s,
        typical_seconds=typical,
        stated_seconds=stated,
        note=("per-sector distance divergence divided by speed, plus half a sample "
              "spacing: `typical_seconds` uses the sector's mean speed and "
              "`stated_seconds` its slowest sample. Both assume the divergence "
              "accumulates monotonically inside the sector; a local reversal can make "
              "the true local error larger, which the stored telemetry cannot "
              "quantify. Neither figure is a confidence interval"),
    )
    uncovered_ref = total - float(s_ref[-1])
    uncovered_cmp = total - float(s_cmp[-1])
    notes = list(notes_ref) + list(notes_cmp)
    if max(uncovered_ref, uncovered_cmp) > 1.0:
        notes.append(
            f"the compared range stops {max(uncovered_ref, uncovered_cmp):.1f} m "
            f"before the end of the lap ({end / total:.4f} of the lap is compared)"
        )
    coverage = TraceCoverage(
        reference_progress=(0.0, float(s_ref[-1] / total)),
        compare_progress=(0.0, float(s_cmp[-1] / total)),
        compared_progress=(0.0, float(end / total)),
        reference_uncovered_m=uncovered_ref,
        compare_uncovered_m=uncovered_cmp,
        complete_lap=(sample_ref.spans_full_clock and sample_cmp.spans_full_clock
                      and max(uncovered_ref, uncovered_cmp) <= 1.0),
        notes=tuple(notes),
    )

    caveats = CAVEATS + (
        f"delta features smaller than {uncertainty.stated_seconds:.3f} s are not "
        "supported as pace differences by this alignment",
    )
    return AlignmentResult(
        session=session,
        reference_lap=reference,
        compare_lap=compare,
        measured=measured,
        samples=(sample_ref, sample_cmp),
        axis=axis,
        elapsed=elapsed,
        delta_s=delta,
        coverage=coverage,
        uncertainty=uncertainty,
        caveats=caveats,
    )
