"""Analysis helpers for telemetry already stored in PostgreSQL.

``sector_alignment`` compares two laps on a common distance axis anchored to the
measured sector times. Nothing here writes to the database.
"""

from __future__ import annotations

from .sector_alignment import (
    AlignedAxis,
    AlignedChannels,
    AlignmentError,
    AlignmentResult,
    AlignmentUncertainty,
    LapSample,
    LapSelector,
    OfficialTiming,
    SectorBoundary,
    SectorUncertainty,
    SessionSelector,
    TraceCoverage,
    compare_laps,
)

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
