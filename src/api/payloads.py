"""Shape one comparison for HTTP and React consumption.

``src.analysis.sector_alignment`` returns dataclasses holding numpy arrays. This
module only re-packages them: the measured half stays exactly as stored, the
estimated half is rounded for display, and the limitations travel with every
response so a chart cannot be rendered without them.

No timing or alignment arithmetic happens here.
"""

from __future__ import annotations

import numpy as np

from src.analysis.sector_alignment import AlignmentResult

__all__ = [
    "DELTA_SIGN",
    "GRID_DEFAULT",
    "GRID_MAX",
    "GRID_MIN",
    "comparison_payload",
    "session_payload",
]

GRID_DEFAULT = 500     # points per series: enough for a 1400 px chart
GRID_MIN = 50
GRID_MAX = 2000        # hard ceiling on response size
DELTA_SIGN = ("delta = reference - compare; positive means the reference lap "
              "used more time to reach the same position")

DISPLAY_DIGITS = {
    "progress": 5,
    "distance_m": 1,
    "elapsed_s": 3,
    "delta_s": 3,
    "speed_kmh": 1,
    "throttle_pct": 0,
}


def _rounded(values: np.ndarray | list[float], digits: int) -> list[float]:
    return [round(float(value), digits) for value in values]


def session_payload(session) -> dict:
    """The small session description repeated in responses."""
    return session.as_dict()


def _sampling(result: AlignmentResult) -> list[dict]:
    return [
        {
            "driver_code": sample.driver_code,
            "lap_number": sample.lap_number,
            "samples": sample.samples,
            "median_spacing_s": round(sample.median_spacing_s, 3),
            "median_spacing_m": round(sample.median_spacing_m, 1),
            "max_spacing_m": round(sample.max_spacing_m, 1),
            "distance_span_m": round(sample.distance_span_m, 1),
            "last_elapsed_s": round(sample.last_elapsed_s, 3),
            "spans_full_clock": sample.spans_full_clock,
        }
        for sample in result.samples
    ]


def _measured(result: AlignmentResult, sectors: dict[str, list[float]]) -> dict:
    measured = result.measured
    return {
        "lap_duration_s": {
            "reference": round(measured.reference_lap_s, 3),
            "compare": round(measured.compare_lap_s, 3),
        },
        "sector_times_s": sectors,
        "sector_deltas_s": _rounded(measured.sector_deltas, 3),
        "cumulative_deltas_s": _rounded(measured.cumulative_deltas, 3),
        "lap_delta_s": round(measured.lap_delta_s, 3),
        "delta_sign": DELTA_SIGN,
        "source": measured.source,
        "sampling": _sampling(result),
    }

def _estimated(result: AlignmentResult) -> dict:
    axis = result.axis
    series = {
        role: {
            "driver_code": channels.driver_code,
            "lap_number": channels.lap_number,
            "positions": channels.positions,
            "elapsed_s": _rounded(channels.elapsed_s, DISPLAY_DIGITS["elapsed_s"]),
            "speed_kmh": _rounded(channels.speed_kmh, DISPLAY_DIGITS["speed_kmh"]),
            "throttle_pct": _rounded(channels.throttle_pct, 0),
            "brake": [int(round(value)) for value in channels.brake],
            "gear": channels.gear if channels.gear is not None else [None] * len(channels.brake),
        }
        for role, channels in result.elapsed.items()
    }
    return {
        "method": "sector-anchored common distance axis",
        "units": {
            "progress": "fraction of the lap, 0-1",
            "distance_m": "m",
            "elapsed_s": "s",
            "delta_s": "s",
            "speed_kmh": "km/h",
            "throttle_pct": "%",
            "brake": "0 or 1",
        },
        "axis": {
            "progress": _rounded(axis.progress, DISPLAY_DIGITS["progress"]),
            "distance_m": _rounded(axis.distance_m, DISPLAY_DIGITS["distance_m"]),
            "length_m": round(axis.length_m, 1),
            "sector_boundaries": [
                {
                    "sector": boundary.sector,
                    "progress": round(boundary.progress, DISPLAY_DIGITS["progress"]),
                    "distance_m": round(boundary.distance_m, 1),
                    "cumulative_delta_s": round(boundary.cumulative_delta_s, 3),
                    "anchor": "measured sector time",
                }
                for boundary in axis.boundaries
            ],
        },
        "series": series,
        "delta_s": _rounded(result.delta_s, DISPLAY_DIGITS["delta_s"]),
    }


def _coverage(result: AlignmentResult) -> dict:
    coverage = result.coverage
    return {
        "complete_lap": coverage.complete_lap,
        "compared_progress": {
            "start": round(coverage.compared_progress[0], DISPLAY_DIGITS["progress"]),
            "end": round(coverage.compared_progress[1], DISPLAY_DIGITS["progress"]),
        },
        "reference": {
            "progress": round(coverage.reference_progress[1], DISPLAY_DIGITS["progress"]),
            "uncovered_m": round(coverage.reference_uncovered_m, 1),
        },
        "compare": {
            "progress": round(coverage.compare_progress[1], DISPLAY_DIGITS["progress"]),
            "uncovered_m": round(coverage.compare_uncovered_m, 1),
        },
        "notes": list(coverage.notes),
    }


def _uncertainty(result: AlignmentResult) -> dict:
    uncertainty = result.uncertainty
    return {
        "typical_seconds": round(uncertainty.typical_seconds, 3),
        "stated_seconds": round(uncertainty.stated_seconds, 3),
        "sample_spacing": {
            "m": round(uncertainty.sample_spacing_m, 1),
            "seconds": round(uncertainty.sample_spacing_seconds, 3),
        },
        "sectors": [
            {
                "sector": item.sector,
                "divergence_m": round(item.divergence_m, 1),
                "mean_speed_kmh": round(item.mean_speed_kmh, 1),
                "slowest_speed_kmh": round(item.slowest_speed_kmh, 1),
                "seconds_at_mean_speed": round(item.seconds_at_mean_speed, 3),
                "seconds_worst_case": round(item.seconds_worst_case, 3),
            }
            for item in uncertainty.sectors
        ],
        "note": uncertainty.note,
        "guidance": ("do not present a delta change smaller than `stated_seconds` "
                     "as a pace difference; use it as the resolution of the chart"),
    }


def _limitations(result: AlignmentResult) -> list[str]:
    return list(result.caveats) + [
        "measured timings are exact column values; every value under `estimated` "
        "comes from interpolation",
        "series are rounded for display (elapsed and delta to 1 ms, distance to "
        "0.1 m, progress to 1e-5 of a lap)",
    ]


def comparison_payload(result: AlignmentResult, session,
                       reference_sectors: list[float] | tuple[float, ...],
                       compare_sectors: list[float] | tuple[float, ...]) -> dict:
    """One JSON-ready comparison: measured, estimated, coverage, uncertainty."""
    sectors = {"reference": [round(float(v), 3) for v in reference_sectors],
               "compare": [round(float(v), 3) for v in compare_sectors]}
    return {
        "meta": {
            "session": session.as_dict(),
            "reference": {"driver_code": result.reference_lap.driver_code,
                          "lap_number": result.reference_lap.lap_number},
            "compare": {"driver_code": result.compare_lap.driver_code,
                        "lap_number": result.compare_lap.lap_number},
            "grid_points": int(result.axis.grid_points),
            "source": "supabase-postgresql (read-only)",
            "read_only": True,
        },
        "measured": _measured(result, sectors),
        "estimated": _estimated(result),
        "coverage": _coverage(result),
        "uncertainty": _uncertainty(result),
        "limitations": _limitations(result),
    }
