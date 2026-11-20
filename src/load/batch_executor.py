"""Controlled multi-event batch executor for 2025 regular qualifying sessions.

Thin orchestration over the two modules that already do the work - no ETL is
reimplemented here:

    batch_planner        discovery, archive lap counts, budget rule
    telemetry_importer   validation (build_plan), inserts, transactions, idempotency

Planning is the default: nothing is downloaded and nothing is written unless
``--execute`` is given. In execute mode each selected event goes through:

    fetch only that qualifying folder (sparse checkout)
    -> complete dry run using the importer's own validation path
    -> budget recheck against the measured database size
    -> import through telemetry_importer.main(...)
    -> independent verification on a fresh connection
    -> stop on the first discrepancy

Earlier imports are protected by the importer's per-driver commits and
``ON CONFLICT DO NOTHING``, and every run compares all previously stored
sessions against a snapshot taken before the batch.

Usage::

    python -m src.load.batch_executor                  # plan only (default)
    python -m src.load.batch_executor --max-events 2
    python -m src.load.batch_executor --execute --max-events 1

Exit codes: 0 ok, 1 failure or verification mismatch, 2 configuration error,
3 budget would be exceeded.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

if __package__ in (None, ""):  # allow `python src/load/batch_executor.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.load import telemetry_importer as importer
from src.load.batch_planner import (
    BYTES_PER_SAMPLE_ROW,
    apply_budget,
    archive_lap_counts,
    build_rows,
    load_calendar,
    openf1_qualifying,
)

DEFAULT_MAX_EVENTS = 2
DEFAULT_BUDGET_MB = 425.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan or execute a small batch of 2025 regular qualifying imports."
    )
    parser.add_argument("--max-events", type=int, default=DEFAULT_MAX_EVENTS, metavar="N",
                        help=f"maximum events in this batch (default {DEFAULT_MAX_EVENTS})")
    parser.add_argument("--budget-mb", type=float, default=DEFAULT_BUDGET_MB, metavar="MB",
                        help=f"database size budget (default {DEFAULT_BUDGET_MB:.0f} MB)")
    parser.add_argument("--execute", action="store_true",
                        help="perform the imports; without this flag nothing is written")
    return parser


def archive_dir(row: dict) -> Path:
    return importer.ARCHIVE_ROOT / row["folder"] / importer.SESSION_TYPE


def download_event(row: dict) -> None:
    """Fetch only this event's qualifying folder through the sparse checkout."""
    pattern = f"{row['folder']}/{importer.SESSION_TYPE}/*"
    print(f"  fetching archive: {pattern}")
    result = subprocess.run(
        ["git", "-c", "core.quotepath=false", "-C", str(importer.ARCHIVE_ROOT),
         "sparse-checkout", "add", pattern],
        capture_output=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode != 0:
        raise importer.ValidationError(
            f"sparse-checkout add failed: {result.stderr.strip()}"
        )


def database_mb(conn) -> float:
    return importer.scalar(conn, "SELECT pg_database_size(current_database())") / 1024 / 1024


def snapshot(conn) -> dict[int, tuple[int, int]]:
    """(laps, samples) per stored session - used to prove earlier imports are intact."""
    rows = conn.execute(
        """
        SELECT s.session_id,
          (SELECT COUNT(*) FROM laps l JOIN session_entries se ON se.entry_id = l.entry_id
             WHERE se.session_id = s.session_id),
          (SELECT COUNT(*) FROM telemetry_samples t JOIN laps l ON l.lap_id = t.lap_id
             JOIN session_entries se ON se.entry_id = l.entry_id
             WHERE se.session_id = s.session_id)
        FROM sessions s ORDER BY s.session_id
        """
    ).fetchall()
    return {row[0]: (row[1], row[2]) for row in rows}


def select_events(conn, max_events: int, budget_mb: float) -> tuple[list[dict], float, bool]:
    """Next ready events in round order, already filtered by state and budget."""
    races = load_calendar()
    sessions = openf1_qualifying()
    rows = build_rows(conn, races, sessions, archive_lap_counts())
    current_mb = database_mb(conn)
    apply_budget(rows, current_mb, budget_mb)

    ready = [row for row in rows if row["state"] == "ready"]
    imported_rounds = [row["round"] for row in rows if row["state"] == "imported"]
    frontier = max(imported_rounds) if imported_rounds else 0
    # Continue the season after the highest imported round; earlier rounds stay as
    # backfill and only come up once the frontier is exhausted.
    ready.sort(key=lambda item: (item["round"] <= frontier, item["round"]))
    if frontier:
        print(f"continuing after round {frontier} (highest imported round)")
    budget_limited = any(row["blocked_by_budget"] for row in rows)
    return ready[:max_events], current_mb, budget_limited


def plan_event(row: dict) -> dict:
    """Complete dry run through the importer's validation path (same code as --dry-run)."""
    target = importer.build_target(row["race_id"], row["session_key"], str(archive_dir(row)))
    grid = importer.load_f1db_grid(row["race_id"])
    identities = importer.resolve_identities(
        importer.load_archive_drivers(target.session_dir), grid,
        importer.load_f1db_driver_names(),
    )
    plan, skipped = importer.build_plan(identities, None, None, target.session_dir)

    laps = sum(len(item["laps"]) for item in plan)
    eligible = sum(len(item["eligible"]) for item in plan)
    samples = sum(item["samples"] for item in plan)
    blocked = [skip for skip in skipped if skip[2] != ["no recorded lap duration"]]
    return {
        "drivers": len(identities),
        "grid": len(grid),
        "laps": laps,
        "eligible": eligible,
        "untimed": len(skipped) - len(blocked),
        "blocked": blocked,
        "samples": samples,
        "mb": samples * BYTES_PER_SAMPLE_ROW / 1024 / 1024,
    }


def print_selection(rows: list[dict], current_mb: float, budget_mb: float,
                    max_events: int) -> None:
    print(f"\nselected {len(rows)} of at most {max_events} ready events "
          f"| database {current_mb:.0f} MB of {budget_mb:.0f} MB budget")
    print(f"{'R':>3} {'event':<24}{'race':>6}{'session':>9}{'laps':>6}{'est.MB':>8}  archive")
    print("-" * 78)
    for row in rows:
        state = "downloaded" if archive_dir(row).is_dir() else "not fetched"
        print(f"{row['round']:>3} {row['event'][:23]:<24}{row['race_id']:>6}"
              f"{row['session_key']:>9}{row['lap_files']:>6}{row['est_mb']:>8.0f}  {state}")


def print_plan(row: dict, plan: dict) -> None:
    print(f"\n--- dry run: {row['event']} (race {row['race_id']}, "
          f"session {row['session_key']}) ---")
    print(f"  driver identity  : {plan['drivers']}/{plan['grid']} resolved")
    print(f"  laps / eligible  : {plan['laps']} / {plan['eligible']}")
    print(f"  telemetry rows   : {plan['samples']:,} (~{plan['mb']:.0f} MB)")
    print(f"  skipped          : {plan['untimed']} untimed, "
          f"{len(plan['blocked'])} blocked by a CHECK constraint")
    for code, lap_number, reasons in plan["blocked"][:5]:
        print(f"    {code} lap {lap_number}: {'; '.join(reasons)}")
    if len(plan["blocked"]) > 5:
        print(f"    ... and {len(plan['blocked']) - 5} more")


def run_import(row: dict) -> int:
    """Write the event through the existing importer CLI entry point."""
    return importer.main([
        "--race-id", str(row["race_id"]),
        "--session-key", str(row["session_key"]),
        "--session-dir", f"{row['folder']}/{importer.SESSION_TYPE}",
    ])


SESSION_LAPS_SQL = (
    "SELECT COUNT(*) FROM laps l JOIN session_entries se ON se.entry_id = l.entry_id "
    "WHERE se.session_id = %s"
)
SESSION_SAMPLES_SQL = (
    "SELECT COUNT(*) FROM telemetry_samples t JOIN laps l ON l.lap_id = t.lap_id "
    "JOIN session_entries se ON se.entry_id = l.entry_id WHERE se.session_id = %s"
)
SESSION_DUPLICATES_SQL = (
    "SELECT COUNT(*) FROM (SELECT t.lap_id, t.sample_index FROM telemetry_samples t "
    "JOIN laps l ON l.lap_id = t.lap_id JOIN session_entries se ON se.entry_id = l.entry_id "
    "WHERE se.session_id = %s GROUP BY 1, 2 HAVING COUNT(*) > 1) d"
)
SESSION_GAPS_SQL = (
    "SELECT COUNT(*) FROM (SELECT l.lap_id FROM telemetry_samples t "
    "JOIN laps l ON l.lap_id = t.lap_id JOIN session_entries se ON se.entry_id = l.entry_id "
    "WHERE se.session_id = %s GROUP BY l.lap_id "
    "HAVING COUNT(*) <> MAX(t.sample_index) + 1) g"
)


def verify_event(database_url: str, row: dict, plan: dict,
                 baseline: dict[int, tuple[int, int]]) -> tuple[list[str], dict, dict]:
    """Independent check on a fresh connection; also proves earlier sessions are intact."""
    problems: list[str] = []
    with importer.connect(database_url) as conn:
        event_id = importer.lookup_event(conn, row["race_id"])
        session_id = importer.lookup_session(conn, event_id, row["session_key"])
        if session_id is None:
            return [f"{row['event']}: session row missing after import"], baseline, {}
        laps = importer.scalar(conn, SESSION_LAPS_SQL, (session_id,))
        samples = importer.scalar(conn, SESSION_SAMPLES_SQL, (session_id,))
        duplicates = importer.scalar(conn, SESSION_DUPLICATES_SQL, (session_id,))
        gaps = importer.scalar(conn, SESSION_GAPS_SQL, (session_id,))
        current = snapshot(conn)

    if laps != plan["laps"]:
        problems.append(f"laps stored {laps} != planned {plan['laps']}")
    if samples != plan["samples"]:
        problems.append(f"samples stored {samples:,} != planned {plan['samples']:,}")
    if duplicates:
        problems.append(f"{duplicates} duplicate (lap_id, sample_index) row(s)")
    if gaps:
        problems.append(f"{gaps} lap(s) with sample-index gaps")
    for session, counts in baseline.items():
        if session != session_id and current.get(session) != counts:
            problems.append(
                f"earlier session {session} changed: {counts} -> {current.get(session)}"
            )
    return problems, current, {"laps": laps, "samples": samples}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    mode = "EXECUTE" if args.execute else "PLAN ONLY (no downloads, no writes)"
    print("=" * 88)
    print(f"2025 QUALIFYING BATCH EXECUTOR - {mode}")
    print("=" * 88)

    try:
        database_url, env_path = importer.load_database_url()
    except Exception as exc:  # noqa: BLE001
        print(f"configuration : FAILED - {exc}")
        return 2
    print(f".env used      : {env_path}")
    print("DATABASE_URL   : loaded (value not printed)")

    try:
        conn = importer.connect(database_url)
    except Exception as exc:  # noqa: BLE001
        print(f"connection     : FAILED - {type(exc).__name__}: {importer.redact(exc)}")
        return 1

    try:
        rows, current_mb, budget_limited = select_events(conn, args.max_events, args.budget_mb)
        baseline = snapshot(conn)
    except Exception as exc:  # noqa: BLE001
        print(f"discovery      : FAILED - {type(exc).__name__}: {importer.redact(exc)}")
        return 1
    finally:
        conn.close()

    if not rows:
        if budget_limited:
            print(f"\nno event fits the {args.budget_mb:.0f} MB budget at {current_mb:.0f} MB")
            return 3
        print("\nno ready event available - nothing to do")
        return 0
    print_selection(rows, current_mb, args.budget_mb, args.max_events)

    # ---------------------------------------------------------------- plan only
    if not args.execute:
        for row in rows:
            if not archive_dir(row).is_dir():
                print(f"\n--- dry run: {row['event']} (race {row['race_id']}) --- "
                      f"archive not fetched")
                print(f"    would run: git sparse-checkout add "
                      f"\"{row['folder']}/{importer.SESSION_TYPE}/*\"")
                continue
            try:
                print_plan(row, plan_event(row))
            except Exception as exc:  # noqa: BLE001
                print(f"\n--- dry run: {row['event']} FAILED - "
                      f"{type(exc).__name__}: {importer.redact(exc)}")
        print("\nPLAN ONLY: no downloads, no database writes. "
              "Re-run with --execute to import.")
        return 0

    # ------------------------------------------------------------------ execute
    for index, row in enumerate(rows, start=1):
        print(f"\n{'=' * 88}")
        print(f"EVENT {index}/{len(rows)}: {row['event']} (race {row['race_id']})")
        print("=" * 88)

        try:
            if not archive_dir(row).is_dir():
                download_event(row)
            plan = plan_event(row)
        except Exception as exc:  # noqa: BLE001
            print(f"ABORT: {type(exc).__name__}: {importer.redact(exc)}")
            return 1
        print_plan(row, plan)

        with importer.connect(database_url) as check:
            size_before = database_mb(check)
        if size_before + plan["mb"] > args.budget_mb:
            print(f"\nABORT: {size_before:.0f} MB + ~{plan['mb']:.0f} MB exceeds the "
                  f"{args.budget_mb:.0f} MB budget")
            return 3
        print(f"  budget           : {size_before:.0f} MB + ~{plan['mb']:.0f} MB "
              f"<= {args.budget_mb:.0f} MB")

        if run_import(row) != 0:
            print("\nABORT: importer returned a non-zero exit code - stopping")
            return 1

        problems, current, actual = verify_event(database_url, row, plan, baseline)
        if problems:
            for problem in problems:
                print(f"  VERIFICATION: {problem}")
            print("\nABORT: verification failed - stopping before the next event")
            return 1

        with importer.connect(database_url) as check:
            size_after = database_mb(check)
        print(f"  stored           : {actual['laps']} laps, {actual['samples']:,} samples, "
              f"{len(plan['blocked'])} laps skipped by CHECK")
        print(f"  size             : {size_before:.0f} MB -> {size_after:.0f} MB "
              f"(+{size_after - size_before:.0f} MB)")
        baseline = current

    print(f"\nBATCH COMPLETE: {len(rows)} event(s) imported and verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



