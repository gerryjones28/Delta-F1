"""Read-only catalogue queries behind the HTTP API.

Everything the frontend needs to *choose* laps comes from here: which qualifying
sessions exist, who drove in one, and which of a driver's laps are actually
comparable. No timing or telemetry arithmetic lives in this module - it only
reports column values - so ``src.analysis.sector_alignment`` stays the single
source of alignment logic.

Every function takes an open connection and runs inside a read-only transaction
established by :func:`read_only_connection`.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

import psycopg

from src.load.telemetry_importer import connect, load_database_url

__all__ = [
    "LapRow",
    "SessionRow",
    "SessionRef",
    "catalogue_session",
    "eligible_laps",
    "find_lap",
    "list_sessions",
    "read_only_connection",
    "resolve_session",
    "session_drivers",
    "slug_for",
]

SESSION_TYPE = "Qualifying"
MIN_ALIGNABLE_SAMPLES = 50   # mirrors the analysis module's MIN_SAMPLES


def slug_for(year: int, event_name: str, session_type: str) -> str:
    """Stable, URL-safe identifier: ``2025-belgian-grand-prix-qualifying``."""
    name = re.sub(r"[^a-z0-9]+", "-", event_name.lower()).strip("-")
    return f"{year}-{name}-{session_type.lower()}"


@contextmanager
def read_only_connection() -> Iterator[psycopg.Connection]:
    """One short read-only connection per request; credentials stay server-side."""
    database_url, _env = load_database_url()
    conn = connect(database_url)
    try:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            yield conn
    finally:
        conn.close()


@dataclass(frozen=True)
class SessionRef:
    """A session the API can talk about."""

    year: int
    event_name: str
    session_type: str

    @property
    def id(self) -> str:
        return slug_for(self.year, self.event_name, self.session_type)

    def as_dict(self) -> dict:
        return {"id": self.id, "year": self.year, "event_name": self.event_name,
                "session_type": self.session_type}


@dataclass(frozen=True)
class SessionRow:
    session: SessionRef
    laps: int
    drivers: int
    laps_with_telemetry: int
    best_lap_s: float | None


@dataclass(frozen=True)
class LapRow:
    lap_number: int
    lap_duration_s: float | None
    sector_times_s: tuple[float, float, float] | None
    telemetry_samples: int

    @property
    def eligible(self) -> bool:
        return (self.lap_duration_s is not None
                and self.sector_times_s is not None
                and self.telemetry_samples >= MIN_ALIGNABLE_SAMPLES)

    @property
    def reason(self) -> str | None:
        if self.lap_duration_s is None:
            return "no recorded lap time"
        if self.sector_times_s is None:
            return "no sector times stored"
        if self.telemetry_samples == 0:
            return "no telemetry stored"
        if not self.eligible:
            return f"only {self.telemetry_samples} telemetry samples"
        return None


SESSIONS_SQL = """
    SELECT e.year, e.event_name, s.session_type,
           count(*) AS laps,
           count(DISTINCT se.driver_id) AS drivers,
           count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM telemetry_samples t WHERE t.lap_id = l.lap_id)
           ) AS laps_with_telemetry,
           min(l.lap_duration) AS best_lap_s
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    WHERE s.session_type = %s
    GROUP BY e.year, e.event_name, s.session_type
    ORDER BY e.year DESC, e.event_name
"""

DRIVERS_SQL = """
    SELECT d.abbreviation, d.first_name, d.last_name,
           count(l.lap_id) AS laps,
           count(l.lap_id) FILTER (
               WHERE EXISTS (SELECT 1 FROM telemetry_samples t WHERE t.lap_id = l.lap_id)
           ) AS laps_with_telemetry,
           min(l.lap_duration) AS best_lap_s
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    JOIN drivers d ON d.driver_id = se.driver_id
    WHERE e.year = %s AND e.event_name = %s AND s.session_type = %s
    GROUP BY d.abbreviation, d.first_name, d.last_name
    ORDER BY min(l.lap_duration) NULLS LAST, d.abbreviation
"""

LAPS_SQL = """
    SELECT l.lap_number, l.lap_duration, l.sector_1, l.sector_2, l.sector_3,
           (SELECT count(*) FROM telemetry_samples t WHERE t.lap_id = l.lap_id)
               AS samples
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    JOIN drivers d ON d.driver_id = se.driver_id
    WHERE e.year = %s AND e.event_name = %s AND s.session_type = %s
      AND d.abbreviation = %s
    ORDER BY l.lap_number
"""


def list_sessions(conn: psycopg.Connection) -> list[SessionRow]:
    """Every qualifying session that has laps stored, newest first."""
    rows = conn.execute(SESSIONS_SQL, (SESSION_TYPE,)).fetchall()
    return [
        SessionRow(
            session=SessionRef(year=row[0], event_name=row[1], session_type=row[2]),
            laps=int(row[3]),
            drivers=int(row[4]),
            laps_with_telemetry=int(row[5]),
            best_lap_s=float(row[6]) if row[6] is not None else None,
        )
        for row in rows
    ]


def catalogue_session(conn: psycopg.Connection, session_id: str) -> SessionRef | None:
    """Look a session up by its slug (never by a database identifier)."""
    for row in list_sessions(conn):
        if row.session.id == session_id:
            return row.session
    return None


def resolve_session(conn: psycopg.Connection, session_id: str) -> SessionRef:
    """As :func:`catalogue_session`, but raise :class:`LookupError` when absent."""
    session = catalogue_session(conn, session_id)
    if session is None:
        raise LookupError(f"unknown session id '{session_id}'")
    return session


def session_drivers(conn: psycopg.Connection, session: SessionRef) -> list[dict]:
    """Drivers in one session, fastest stored lap first."""
    rows = conn.execute(DRIVERS_SQL, (session.year, session.event_name,
                                      session.session_type)).fetchall()
    return [
        {
            "driver_code": row[0],
            "full_name": f"{row[1]} {row[2]}".strip(),
            "laps": int(row[3]),
            "laps_with_telemetry": int(row[4]),
            "best_lap_s": float(row[5]) if row[5] is not None else None,
        }
        for row in rows
    ]


def eligible_laps(conn: psycopg.Connection, session: SessionRef,
                  driver_code: str) -> list[dict]:
    """Every stored lap of one driver, flagged ``eligible`` for comparison."""
    rows = conn.execute(LAPS_SQL, (session.year, session.event_name,
                                   session.session_type, driver_code)).fetchall()
    laps = []
    for row in rows:
        sectors = None if any(value is None for value in row[2:5]) else (
            float(row[2]), float(row[3]), float(row[4]))
        lap = LapRow(
            lap_number=int(row[0]),
            lap_duration_s=float(row[1]) if row[1] is not None else None,
            sector_times_s=sectors,
            telemetry_samples=int(row[5]),
        )
        laps.append({
            "lap_number": lap.lap_number,
            "lap_duration_s": lap.lap_duration_s,
            "sector_times_s": list(lap.sector_times_s) if lap.sector_times_s else None,
            "telemetry_samples": lap.telemetry_samples,
            "eligible": lap.eligible,
            "reason": lap.reason,
        })
    return laps


def find_lap(conn: psycopg.Connection, session: SessionRef,
             driver_code: str, lap_number: int) -> dict | None:
    """One lap of one driver, or ``None`` when it is not stored."""
    for lap in eligible_laps(conn, session, driver_code):
        if lap["lap_number"] == lap_number:
            return lap
    return None
