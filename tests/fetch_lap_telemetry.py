"""Retrieve two qualifying laps and their full telemetry from Supabase.

Read-only. Lap ids are resolved through relational joins on event -> session ->
session_entry -> driver/lap, so no generated primary keys are hardcoded, and
every telemetry sample is pulled from PostgreSQL (no local JSON involved).

Usage::

    python tests/fetch_lap_telemetry.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.load.telemetry_importer import connect, load_database_url, redact

EVENT_NAME = "Belgian Grand Prix"
EVENT_YEAR = 2025
SESSION_TYPE = "Qualifying"
DURATION_TOLERANCE_S = 0.001

TELEMETRY_COLUMNS = (
    "sample_index",
    "elapsed_s",
    "rel_distance",
    "speed_kmh",
    "throttle_pct",
    "brake",
    "gear",
    "rpm",
    "drs",
    "distance_m",
    "x",
    "y",
    "z",
)


@dataclass(frozen=True)
class LapRequest:
    driver_code: str
    lap_number: int
    expected_duration: float
    expected_samples: int


REQUESTS = (
    LapRequest("VER", 2, 102.066, 745),
    LapRequest("LEC", 4, 101.635, 751),
)

LAP_SQL = """
    SELECT l.lap_id, d.abbreviation, d.first_name, d.last_name,
           l.lap_number, l.lap_duration, s.session_id, e.event_id
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    JOIN drivers d ON d.driver_id = se.driver_id
    WHERE e.event_name = %s
      AND e.year = %s
      AND s.session_type = %s
      AND d.abbreviation = %s
      AND l.lap_number = %s
"""


def resolve_lap(conn, request: LapRequest) -> dict:
    """Find one lap by event/session/driver/lap number - never by surrogate key."""
    with conn.cursor() as cur:
        cur.execute(
            LAP_SQL,
            (EVENT_NAME, EVENT_YEAR, SESSION_TYPE, request.driver_code, request.lap_number),
        )
        rows = cur.fetchall()

    if not rows:
        raise LookupError(
            f"no {SESSION_TYPE} lap {request.lap_number} for {request.driver_code} "
            f"at the {EVENT_YEAR} {EVENT_NAME}"
        )
    if len(rows) > 1:
        raise LookupError(
            f"ambiguous: {len(rows)} laps match {request.driver_code} lap "
            f"{request.lap_number} at the {EVENT_YEAR} {EVENT_NAME}"
        )

    row = rows[0]
    return {
        "lap_id": row[0],
        "code": row[1],
        "name": f"{row[2]} {row[3]}",
        "lap_number": row[4],
        "lap_duration": row[5],
        "session_id": row[6],
        "event_id": row[7],
    }


def fetch_samples(conn, lap_id: int) -> list[tuple]:
    """All telemetry rows for one lap, ordered by sample index."""
    columns = ", ".join(TELEMETRY_COLUMNS)
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {columns} FROM telemetry_samples WHERE lap_id = %s ORDER BY sample_index",
            (lap_id,),
        )
        return cur.fetchall()


def count_samples(conn, lap_id: int) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM telemetry_samples WHERE lap_id = %s", (lap_id,))
        return cur.fetchone()[0]


def verify_lap(lap: dict, request: LapRequest, rows: list[tuple],
               stored_count: int) -> list[str]:
    """Structural checks on the retrieved lap and its samples."""
    problems = []
    duration = lap["lap_duration"]
    if duration is None:
        problems.append("recorded lap duration is NULL")
    elif abs(duration - request.expected_duration) > DURATION_TOLERANCE_S:
        problems.append(
            f"lap duration {duration:.3f} s != expected {request.expected_duration:.3f} s"
        )

    if len(rows) != request.expected_samples:
        problems.append(f"{len(rows)} samples retrieved, expected {request.expected_samples}")
    if stored_count != len(rows):
        problems.append(
            f"truncated result: COUNT(*)={stored_count} but {len(rows)} rows returned"
        )

    if [row[0] for row in rows] != list(range(len(rows))):
        problems.append("sample_index is not contiguous from 0 in order")

    times = [row[1] for row in rows]
    if any(later <= earlier for earlier, later in zip(times, times[1:])):
        problems.append("elapsed_s is not strictly increasing")

    return problems


def print_lap(lap: dict, rows: list[tuple]) -> None:
    first, last = rows[0], rows[-1]
    print(
        f"{lap['code']:<4}{lap['lap_number']:>4}{lap['lap_duration']:>11.3f}"
        f"{len(rows):>9}{first[1]:>10.3f}{last[1]:>10.3f}"
        f"{first[2]:>12.6f}{last[2]:>11.6f}"
    )


def main() -> int:
    print("=" * 84)
    print(f"LAP TELEMETRY RETRIEVAL - {EVENT_YEAR} {EVENT_NAME} {SESSION_TYPE} (read-only)")
    print("=" * 84)

    try:
        database_url, env_path = load_database_url()
    except Exception as exc:  # noqa: BLE001
        print(f"configuration : FAILED - {exc}")
        return 2

    print(f".env used      : {env_path}")
    print("DATABASE_URL   : loaded (value not printed)")
    print(f"channels       : {', '.join(TELEMETRY_COLUMNS)}")

    try:
        conn = connect(database_url)
    except Exception as exc:  # noqa: BLE001
        print(f"connection     : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1

    failures = 0
    try:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")

            print()
            print(f"{'drv':<4}{'lap':>4}{'duration':>11}{'samples':>9}"
                  f"{'first_t':>10}{'last_t':>10}{'first_rel':>12}{'last_rel':>11}")

            for request in REQUESTS:
                try:
                    lap = resolve_lap(conn, request)
                except LookupError as exc:
                    print(f"  {request.driver_code} lap {request.lap_number}: {exc}")
                    failures += 1
                    continue

                rows = fetch_samples(conn, lap["lap_id"])
                stored = count_samples(conn, lap["lap_id"])
                print_lap(lap, rows)

                problems = verify_lap(lap, request, rows, stored)
                for problem in problems:
                    print(f"      ! {problem}")
                failures += len(problems)
    except Exception as exc:  # noqa: BLE001
        print(f"query          : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1
    finally:
        conn.close()

    print()
    print(f"resolved {len(REQUESTS)} lap(s) by join (event -> session -> entry -> driver/lap)")
    if failures:
        print(f"RESULT: {failures} problem(s) found")
        return 1
    print("RESULT: both laps retrieved from Supabase with complete, ordered telemetry")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

