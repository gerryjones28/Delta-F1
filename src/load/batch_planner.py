"""Read-only batch planner for 2025 regular qualifying sessions.

Answers "what is left to import, what would it cost, and is it safe?" without
touching the database. It never writes: the actual load stays
``python -m src.load.telemetry_importer --race-id ... --session-key ... --session-dir ...``.

Sources cross-checked per event:
    F1DB calendar   -> race id, round, date, circuit, sprint-weekend flag
    OpenF1          -> regular Qualifying session key, meeting key, date
    TracingInsights -> archive folder and lap-file count (read from the git tree,
                       so nothing is downloaded)

Safeguards reported for every event
-----------------------------------
* only OpenF1 sessions named exactly ``Qualifying`` are considered (sprint
  qualifying, sprint, race and practice sessions are never candidates);
* an event already present in ``events`` is reported as imported and is never
  proposed again;
* the projected database size (current size + pending estimates) is compared
  with ``--budget-mb``.

Usage::

    python -m src.load.batch_planner                    # plan only (default)
    python -m src.load.batch_planner --budget-mb 450
    python -m src.load.batch_planner --validate 1140    # reuse the importer's dry run

Exit codes: 0 plan fits the budget, 1 failure, 3 plan exceeds the budget.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import date
from pathlib import Path

import pandas as pd

if __package__ in (None, ""):  # allow `python src/load/batch_planner.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.load.telemetry_importer import (
    ARCHIVE_ROOT,
    F1DB_DIR,
    SESSION_TYPE,
    ValidationError,
    build_plan,
    build_target,
    connect,
    load_archive_drivers,
    load_database_url,
    load_f1db_driver_names,
    load_f1db_grid,
    normalise,
    print_plan,
    print_skips,
    redact,
    resolve_identities,
    scalar,
)

YEAR = 2025
BUDGET_MB_DEFAULT = 450

# Calibrated on the two imported sessions: 260,823 samples / 556 archive lap files.
SAMPLES_PER_LAP_FILE = 469
# Measured: pg_total_relation_size('telemetry_samples') / rows after Hungary.
BYTES_PER_SAMPLE_ROW = 165

# F1DB grandPrixId -> TracingInsights folder. Every entry is verified against the
# git tree at run time, so a missing folder is reported rather than assumed.
GRAND_PRIX_FOLDERS = {
    "australia": "Australian Grand Prix",
    "china": "Chinese Grand Prix",
    "japan": "Japanese Grand Prix",
    "bahrain": "Bahrain Grand Prix",
    "saudi-arabia": "Saudi Arabian Grand Prix",
    "miami": "Miami Grand Prix",
    "emilia-romagna": "Emilia Romagna Grand Prix",
    "monaco": "Monaco Grand Prix",
    "spain": "Spanish Grand Prix",
    "canada": "Canadian Grand Prix",
    "austria": "Austrian Grand Prix",
    "great-britain": "British Grand Prix",
    "belgium": "Belgian Grand Prix",
    "hungary": "Hungarian Grand Prix",
    "netherlands": "Dutch Grand Prix",
    "italy": "Italian Grand Prix",
    "azerbaijan": "Azerbaijan Grand Prix",
    "singapore": "Singapore Grand Prix",
    "united-states": "United States Grand Prix",
    "mexico": "Mexico City Grand Prix",
    "sao-paulo": "São Paulo Grand Prix",
    "las-vegas": "Las Vegas Grand Prix",
    "qatar": "Qatar Grand Prix",
    "abu-dhabi": "Abu Dhabi Grand Prix",
}


def load_calendar(year: int = YEAR) -> list[dict]:
    """F1DB calendar rows for one season."""
    path = F1DB_DIR / "f1db-races.csv"
    if not path.is_file():
        raise ValidationError(f"missing {path}")
    frame = pd.read_csv(path)
    subset = frame[frame["year"] == year].sort_values("round")
    races = []
    for row in subset.itertuples(index=False):
        races.append({
            "race_id": int(row.id),
            "round": int(row.round),
            "grand_prix_id": str(row.grandPrixId),
            "circuit": str(row.circuitId),
            "date": str(row.date)[:10],
            "sprint": not pd.isna(row.sprintQualifyingFormat),
        })
    return races


def archive_lap_counts() -> dict[str, int]:
    """folder -> number of ``*_tel.json`` files, read from the git tree (no blobs)."""
    result = subprocess.run(
        ["git", "-c", "core.quotepath=false", "-C", str(ARCHIVE_ROOT),
         "ls-tree", "-r", "--name-only", "HEAD"],
        capture_output=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode != 0:
        raise ValidationError(f"git ls-tree failed in {ARCHIVE_ROOT}: {result.stderr.strip()}")

    counts: dict[str, int] = {}
    for line in result.stdout.splitlines():
        parts = line.split("/")
        # layout: "<Grand Prix>/Qualifying/<DRIVER>/<lap>_tel.json"
        if (len(parts) == 4 and parts[1] == SESSION_TYPE
                and parts[3].endswith("_tel.json")):
            counts[parts[0]] = counts.get(parts[0], 0) + 1
    return counts


def openf1_qualifying(year: int = YEAR) -> list[dict]:
    """Regular Qualifying sessions only (sprint qualifying is filtered out by name)."""
    from src.extract.openf1_client import OpenF1Client, OpenF1Error  # lazy import

    try:
        with OpenF1Client(timeout=30) as client:
            sessions = client.get_sessions(year=year)
    except OpenF1Error as exc:
        raise ValidationError(f"OpenF1 session lookup failed: {exc}") from exc

    regular = []
    for session in sessions:
        if session.get("session_name") != SESSION_TYPE:
            continue
        if session.get("session_type") != SESSION_TYPE:
            continue
        start = str(session.get("date_start") or "")
        regular.append({
            "session_key": int(session["session_key"]),
            "meeting_key": int(session["meeting_key"]),
            "circuit": session.get("circuit_short_name"),
            "country": session.get("country_name"),
            "day": start[:10],
            "start": start,
        })
    return regular


def match_session(race: dict, sessions: list[dict]) -> tuple[dict | None, str]:
    """Match a race to its regular qualifying session: date first, circuit as tie-break."""
    race_day = date.fromisoformat(race["date"])
    candidates = []
    for session in sessions:
        try:
            day = date.fromisoformat(session["day"])
        except ValueError:
            continue
        if 0 <= (race_day - day).days <= 4:
            candidates.append(session)

    if not candidates:
        return None, "no OpenF1 Qualifying session within 4 days of the race"
    if len(candidates) > 1:
        exact = [s for s in candidates if normalise(s["circuit"]) == normalise(race["circuit"])]
        if len(exact) != 1:
            return None, f"ambiguous: {len(candidates)} candidate sessions"
        candidates = exact
    return candidates[0], ""


def db_status(conn, race_id: int, session_key: int | None) -> dict:
    """What the database already holds for this event/session."""
    row = conn.execute("SELECT event_id FROM events WHERE f1db_race_id = %s", (race_id,)).fetchone()
    event_id = row[0] if row else None

    session_id = None
    if event_id is not None and session_key is not None:
        row = conn.execute(
            "SELECT session_id FROM sessions WHERE event_id = %s "
            "AND openf1_session_key = %s AND session_type = %s",
            (event_id, session_key, SESSION_TYPE),
        ).fetchone()
        session_id = row[0] if row else None

    laps = samples = 0
    if session_id is not None:
        laps = scalar(
            conn,
            "SELECT COUNT(*) FROM laps l JOIN session_entries se ON se.entry_id = l.entry_id "
            "WHERE se.session_id = %s",
            (session_id,),
        )
        samples = scalar(
            conn,
            "SELECT COUNT(*) FROM telemetry_samples t JOIN laps l ON l.lap_id = t.lap_id "
            "JOIN session_entries se ON se.entry_id = l.entry_id WHERE se.session_id = %s",
            (session_id,),
        )
    return {"event_id": event_id, "session_id": session_id, "laps": laps, "samples": samples}


def build_rows(conn, races: list[dict], sessions: list[dict],
               lap_counts: dict[str, int]) -> list[dict]:
    rows = []
    for race in races:
        folder = GRAND_PRIX_FOLDERS.get(race["grand_prix_id"])
        matched, match_note = match_session(race, sessions)
        session_key = matched["session_key"] if matched else None
        status = db_status(conn, race["race_id"], session_key)

        blockers = []
        if folder is None:
            blockers.append("no archive folder mapping")
        elif folder not in lap_counts:
            blockers.append("qualifying session absent from the archive")
        if matched is None:
            blockers.append(match_note)
        elif normalise(matched["circuit"]) != normalise(race["circuit"]):
            blockers.append(
                f"circuit alias needed (OpenF1 {matched['circuit']!r} vs F1DB {race['circuit']!r})"
            )

        lap_files = lap_counts.get(folder, 0) if folder else 0
        if status["session_id"] is not None:
            state = "imported"
        elif blockers:
            state = "blocked"
        else:
            state = "ready"

        rows.append({
            "round": race["round"],
            "event": folder or race["grand_prix_id"],
            "race_id": race["race_id"],
            "session_key": session_key,
            "folder": folder,
            "sprint": race["sprint"],
            "lap_files": lap_files,
            "downloaded": bool(folder) and (ARCHIVE_ROOT / folder / SESSION_TYPE).is_dir(),
            "state": state,
            "blockers": blockers,
            "db_laps": status["laps"],
            "db_samples": status["samples"],
            "est_samples": lap_files * SAMPLES_PER_LAP_FILE,
            "est_mb": lap_files * SAMPLES_PER_LAP_FILE * BYTES_PER_SAMPLE_ROW / 1024 / 1024,
            "blocked_by_budget": False,
        })
    return rows


def apply_budget(rows: list[dict], current_mb: float, budget_mb: float) -> None:
    """Mark ready rows that would push the database past the configured budget."""
    projected = current_mb
    for row in sorted(rows, key=lambda item: item["round"]):
        if row["state"] != "ready":
            continue
        if projected + row["est_mb"] > budget_mb:
            row["state"] = "blocked"
            row["blockers"].append(
                f"storage budget: {projected + row['est_mb']:.0f} MB > {budget_mb:.0f} MB"
            )
            row["blocked_by_budget"] = True
        else:
            projected += row["est_mb"]


def print_report(rows: list[dict], current_mb: float, budget_mb: float) -> None:
    imported = [row for row in rows if row["state"] == "imported"]
    ready = [row for row in rows if row["state"] == "ready"]
    blocked = [row for row in rows if row["state"] == "blocked"]

    print("=" * 108)
    print(f"{YEAR} REGULAR QUALIFYING - BATCH PLAN (read-only, nothing is written)")
    print("=" * 108)
    print(f"database now {current_mb:.0f} MB | budget {budget_mb:.0f} MB | "
          f"imported {len(imported)}/{len(rows)} | ready {len(ready)} | blocked {len(blocked)}")
    print()
    print(f"{'R':>3} {'event':<24}{'race':>6}{'session':>9}{'laps':>6}{'status':>10}"
          f"{'est.rows':>10}{'est.MB':>8}  note")
    print("-" * 108)
    for row in rows:
        session = row["session_key"] if row["session_key"] is not None else "-"
        if row["state"] == "imported":
            note = f"stored {row['db_samples']:,} samples / {row['db_laps']} laps"
            estimates = f"{'-':>10}{'-':>8}"
        else:
            estimates = f"{row['est_samples']:>10,}{row['est_mb']:>8.0f}"
            if row["blockers"]:
                note = "; ".join(row["blockers"])
            elif not row["downloaded"]:
                note = "in archive, not downloaded locally"
            else:
                note = "archive downloaded locally"
        print(f"{row['round']:>3} {row['event'][:23]:<24}{row['race_id']:>6}{session:>9}"
              f"{row['lap_files']:>6}{row['state']:>10}{estimates}  {note}")

    print("-" * 108)
    print(f"estimates: {SAMPLES_PER_LAP_FILE} samples per archive lap file, "
          f"{BYTES_PER_SAMPLE_ROW} B per stored row (calibrated on Belgium + Hungary).")
    print("exact numbers for one event: --validate <race id> (reuses the importer's dry run).")


def validate_event(race_id: int, rows: list[dict]) -> int:
    """Run the importer's own dry run for one event; read-only, needs the archive."""
    row = next((item for item in rows if item["race_id"] == race_id), None)
    if row is None:
        print(f"\nrace id {race_id} is not on the {YEAR} calendar")
        return 1
    if row["session_key"] is None or row["folder"] is None:
        print(f"\n{row['event']}: no session/archive match - cannot validate")
        return 1

    session_dir = ARCHIVE_ROOT / row["folder"] / SESSION_TYPE
    print(f"\n=== VALIDATION: {row['event']} (race {race_id}, session {row['session_key']}) ===")
    if not session_dir.is_dir():
        print(f"archive not downloaded: {session_dir}")
        print(f'fetch it with: git -C "{ARCHIVE_ROOT}" sparse-checkout add '
              f'"{row["folder"]}/{SESSION_TYPE}/*"')
        return 1

    target = build_target(race_id, row["session_key"], str(session_dir))
    grid = load_f1db_grid(race_id)
    identities = resolve_identities(
        load_archive_drivers(target.session_dir), grid, load_f1db_driver_names())
    print(f"drivers resolved: {len(identities)}/{len(grid)}")
    plan, skipped = build_plan(identities, None, None, target.session_dir)
    print_plan(plan)
    print_skips(skipped)

    laps = sum(len(item["laps"]) for item in plan)
    eligible = sum(len(item["eligible"]) for item in plan)
    samples = sum(item["samples"] for item in plan)
    print(f"\nvalidated: {laps} laps, {eligible} with telemetry, {samples:,} samples "
          f"(~{samples * BYTES_PER_SAMPLE_ROW / 1024 / 1024:.0f} MB)")
    return 0


def suggest_pilot(rows: list[dict]) -> dict | None:
    """Next ready event after the highest imported round, else the first ready one."""
    imported = [row["round"] for row in rows if row["state"] == "imported"]
    last = max(imported) if imported else 0
    ready = [row for row in rows if row["state"] == "ready"]
    later = [row for row in ready if row["round"] > last]
    if later:
        return min(later, key=lambda item: item["round"])
    return min(ready, key=lambda item: item["round"]) if ready else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan 2025 regular qualifying imports (read-only batch controller)."
    )
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="default and only mode: this controller never writes")
    parser.add_argument("--budget-mb", type=float, default=BUDGET_MB_DEFAULT, metavar="MB",
                        help=f"storage budget for the whole database "
                             f"(default {BUDGET_MB_DEFAULT} MB)")
    parser.add_argument("--validate", type=int, metavar="RACE_ID",
                        help="run the importer's dry run for one race id")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        database_url, env_path = load_database_url()
    except Exception as exc:  # noqa: BLE001
        print(f"configuration: FAILED - {exc}")
        return 2
    print(f".env used      : {env_path}")
    print("DATABASE_URL   : loaded (value not printed)")

    try:
        conn = connect(database_url)
    except Exception as exc:  # noqa: BLE001
        print(f"connection     : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1

    try:
        races = load_calendar()
        sessions = openf1_qualifying()
        lap_counts = archive_lap_counts()
        rows = build_rows(conn, races, sessions, lap_counts)
        current_mb = scalar(conn, "SELECT pg_database_size(current_database())") / 1024 / 1024
        apply_budget(rows, current_mb, args.budget_mb)
        print_report(rows, current_mb, args.budget_mb)

        alias_needed = [
            row["event"] for row in rows
            if any("circuit alias" in blocker for blocker in row["blockers"])
        ]
        print(f"\nOpenF1 regular Qualifying sessions for {YEAR}: {len(sessions)}")
        if alias_needed:
            print("importer would refuse these (circuit alias needed): " + ", ".join(alias_needed))

        pilot = suggest_pilot(rows)
        if pilot is None:
            print("\nno ready event left within the budget")
        else:
            print(f"\nnext pilot: round {pilot['round']} {pilot['event']} "
                  f"(race {pilot['race_id']}, session {pilot['session_key']}, "
                  f"~{pilot['est_samples']:,} samples, ~{pilot['est_mb']:.0f} MB)")
            print(f"  archive: {'downloaded' if pilot['downloaded'] else 'NOT downloaded'}")
            if not pilot["downloaded"]:
                print(f'  fetch: git -C "{ARCHIVE_ROOT}" sparse-checkout add '
                      f'"{pilot["folder"]}/{SESSION_TYPE}/*"')

        if args.validate:
            return validate_event(args.validate, rows)
        return 3 if any(row["blocked_by_budget"] for row in rows) else 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())



