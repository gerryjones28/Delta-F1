"""Import 2025 Belgian Grand Prix qualifying telemetry into PostgreSQL.

Scope: the *regular qualifying session* of the 2025 Belgian Grand Prix at Spa
(TracingInsights archive, F1DB race 1138, OpenF1 session 9935). Nothing else is
read or written.

What one run does
-----------------
1. Resolves the 20 drivers by **car number**: archive ``drivers.json`` ->
   F1DB ``f1db-races-qualifying-results.csv`` for race 1138. The 3-letter code
   is only used as a cross-check, never as the key (F1DB abbreviations repeat
   across eras).
2. Inserts missing ``drivers`` and ``session_entries`` rows idempotently.
3. Writes one ``laps`` row per archive lap from ``laptimes.json``, keeping NULL
   where the source has no recorded lap time; existing NULL columns are filled
   in, nothing is overwritten.
4. Stores telemetry only for laps with a verified, positive recorded duration.
5. Re-queries the database afterwards and reports stored counts per driver.

Two classes of problem are distinguished
----------------------------------------
*Fatal* (the run aborts before writing anything): unresolved or ambiguous driver
identity, missing event/session, missing channel, unequal channel lengths,
non-monotonic timestamps, fractional values in integer columns, or a trace whose
end does not match the recorded lap duration.

*Ineligible* (that lap is skipped, everything else continues): no recorded lap
duration, or measurements that would violate a CHECK constraint on
``telemetry_samples``. Skipped laps are listed with the exact offending value;
nothing is rounded, clamped or substituted to make them fit.

Usage::

    python -m src.load.telemetry_importer --dry-run          # validate + report
    python -m src.load.telemetry_importer                    # write
    python -m src.load.telemetry_importer --driver VER --driver LEC --lap-id 1 --lap-id 2

The last form reproduces the original two-lap importer behaviour.

Exit codes: 0 success, 1 failure/validation abort, 2 configuration error,
3 post-write verification mismatch.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

import psycopg
import pandas as pd
from dotenv import load_dotenv
from psycopg import sql

if __package__ in (None, ""):  # allow `python src/load/telemetry_importer.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.paths import PROJECT_ROOT

ARCHIVE_ROOT = PROJECT_ROOT / "data/external/tracinginsights-2025"
SESSION_DIR = ARCHIVE_ROOT / "Belgian Grand Prix/Qualifying"
F1DB_DIR = PROJECT_ROOT / "data/raw/f1db-csv"

RACE_ID = 1138          # F1DB 2025 Belgian Grand Prix
SESSION_KEY = 9935      # OpenF1 qualifying session key
SESSION_TYPE = "Qualifying"

# JSON channel -> telemetry_samples column, in insert order.
CHANNEL_MAP = (
    ("time", "elapsed_s"),
    ("distance", "distance_m"),
    ("rel_distance", "rel_distance"),
    ("speed", "speed_kmh"),
    ("throttle", "throttle_pct"),
    ("brake", "brake"),
    ("gear", "gear"),
    ("rpm", "rpm"),
    ("drs", "drs"),
    ("x", "x"),
    ("y", "y"),
    ("z", "z"),
)

INSERT_COLUMNS = ("lap_id", "sample_index") + tuple(column for _, column in CHANNEL_MAP)
INTEGER_COLUMNS = frozenset({"sample_index", "gear", "rpm", "drs"})
# rpm is integer in the database but the archive stores a resampled (fractional)
# channel, so it is rounded to the nearest integer and the rounding is reported.
# gear and drs are integral in the source and stay strict.
ROUNDED_COLUMNS = frozenset({"rpm"})
NOT_NULL_COLUMNS = frozenset({"lap_id", "sample_index", "elapsed_s"})

# Mirrors the CHECK constraints on telemetry_samples: (minimum, maximum).
RANGE_RULES = {
    "elapsed_s": (0.0, None),
    "rel_distance": (0.0, 1.0),
    "speed_kmh": (0.0, None),
    "throttle_pct": (0.0, 100.0),
}

DURATION_TOLERANCE_S = 0.005
CHUNK_SIZE = 500
MAX_REPORTED_ITEMS = 12

SSL_MODE = "require"
CONNECT_TIMEOUT = 10
ENV_CANDIDATES = (PROJECT_ROOT / ".env", PROJECT_ROOT.parent / ".env")
_URL_PATTERN = re.compile(r"(?i)\bpostgres(?:ql)?(?:\+[a-z0-9]+)?://\S+")


class ConfigurationError(RuntimeError):
    """Raised when .env or DATABASE_URL cannot be used."""


class SourceError(RuntimeError):
    """Raised when an archive file is missing or has an unexpected shape."""


class ValidationError(RuntimeError):
    """Raised for a fatal data or mapping problem; the run stops."""


class IdentityError(ValidationError):
    """Raised when a driver cannot be mapped unambiguously."""


def redact(text: object) -> str:
    """Strip anything resembling a connection string before printing it."""
    return _URL_PATTERN.sub("<redacted-connection-string>", str(text))


def load_database_url() -> tuple[str, Path]:
    """Return (DATABASE_URL, env file path) without echoing the URL."""
    for candidate in ENV_CANDIDATES:
        if candidate.is_file():
            load_dotenv(candidate)  # real environment variables win
            database_url = os.getenv("DATABASE_URL")
            if not database_url:
                raise ConfigurationError(f"{candidate} exists but DATABASE_URL is not set")
            return database_url, candidate
    searched = " and ".join(str(path) for path in ENV_CANDIDATES)
    raise ConfigurationError(f"no .env found (looked for {searched})")


def connect(database_url: str) -> psycopg.Connection:
    """Connect with TLS and a bounded timeout, as in the connection test."""
    return psycopg.connect(
        database_url,
        sslmode=SSL_MODE,
        connect_timeout=CONNECT_TIMEOUT,
    )


# ---------------------------------------------------------------------------
# Source discovery and driver identity
# ---------------------------------------------------------------------------
def load_archive_drivers() -> list[dict]:
    path = SESSION_DIR / "drivers.json"
    if not path.is_file():
        raise SourceError(f"missing {path}")
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    drivers = payload.get("drivers")
    if not isinstance(drivers, list) or not drivers:
        raise SourceError(f"{path.name} has no drivers list")
    return drivers


def load_f1db_grid(race_id: int = RACE_ID) -> dict[int, dict]:
    """F1DB qualifying classification for the race, keyed by car number."""
    path = F1DB_DIR / "f1db-races-qualifying-results.csv"
    if not path.is_file():
        raise SourceError(f"missing {path}")
    frame = pd.read_csv(path)
    subset = frame[frame["raceId"] == race_id]
    if subset.empty:
        raise SourceError(f"no F1DB qualifying results for raceId {race_id}")
    grid: dict[int, dict] = {}
    for row in subset.itertuples(index=False):
        grid[int(row.driverNumber)] = {
            "f1db_id": str(row.driverId),
            "constructor": str(row.constructorId),
            "position": None if pd.isna(row.positionNumber) else int(row.positionNumber),
        }
    return grid


def load_f1db_driver_names() -> dict[str, dict]:
    path = F1DB_DIR / "f1db-drivers.csv"
    if not path.is_file():
        raise SourceError(f"missing {path}")
    frame = pd.read_csv(path, usecols=["id", "firstName", "lastName", "abbreviation"])
    return {
        str(row.id): {
            "first_name": str(row.firstName),
            "last_name": str(row.lastName),
            "abbreviation": str(row.abbreviation),
        }
        for row in frame.itertuples(index=False)
    }


def resolve_identities(archive_drivers: list[dict], grid: dict[int, dict],
                       names: dict[str, dict]) -> list[dict]:
    """Map archive driver codes to F1DB ids by car number; the code is a cross-check."""
    identities: list[dict] = []
    problems: list[str] = []
    seen_numbers: set[int] = set()
    seen_codes: set[str] = set()

    for entry in sorted(archive_drivers, key=lambda item: int(item["dn"])):
        code = str(entry["driver"]).strip().upper()
        number = int(entry["dn"])
        if number in seen_numbers or code in seen_codes:
            problems.append(f"duplicate car number {number} / code {code} in drivers.json")
            continue
        seen_numbers.add(number)
        seen_codes.add(code)

        grid_row = grid.get(number)
        if grid_row is None:
            problems.append(
                f"{code} (car {number}): no F1DB entry with that car number in race {RACE_ID}"
            )
            continue

        f1db_id = grid_row["f1db_id"]
        info = names.get(f1db_id)
        if info is None:
            problems.append(f"{code} (car {number}): driver id {f1db_id} missing from f1db-drivers.csv")
            continue
        if info["abbreviation"] != code:
            problems.append(
                f"{code} (car {number}): F1DB {f1db_id} carries abbreviation "
                f"{info['abbreviation']!r} - refusing to guess"
            )
            continue

        identities.append({
            "code": code,
            "number": number,
            "f1db_id": f1db_id,
            "first_name": info["first_name"],
            "last_name": info["last_name"],
            "team": (str(entry.get("team") or "").strip() or None),
            "grid_position": grid_row["position"],
        })

    if problems:
        raise IdentityError("driver identity problems: " + "; ".join(problems))
    return identities


def load_laptimes(code: str) -> list[dict]:
    """Lap metadata from the archive's ``laptimes.json``; missing values stay None."""
    path = SESSION_DIR / code / "laptimes.json"
    if not path.is_file():
        raise SourceError(f"missing {path}")
    with open(path, encoding="utf-8") as handle:
        table = json.load(handle)

    laps = []
    for index, lap_number in enumerate(table["lap"]):
        laps.append({
            "lap_number": int(lap_number),
            "duration": to_number(table["time"][index]),
            "sector_1": to_number(table["s1"][index]),
            "sector_2": to_number(table["s2"][index]),
            "sector_3": to_number(table["s3"][index]),
            # pout/pin are pit-lane crossing timestamps. Their semantics are not
            # unambiguous (a stop lap can carry a pit-exit crossing and a first
            # lap can carry both), so the flags are left NULL rather than guessed.
            # They are still counted for the report.
            "has_pit_out": to_number(table["pout"][index]) is not None,
            "has_pit_in": to_number(table["pin"][index]) is not None,
            "pit_out": None,
            "pit_in": None,
        })
    return laps


def telemetry_path(code: str, lap_number: int) -> Path:
    return SESSION_DIR / code / f"{lap_number}_tel.json"


def load_telemetry(path: Path) -> dict[str, list]:
    """Read the ``tel`` block of one lap file. The file is opened read-only."""
    if not path.is_file():
        raise SourceError(f"missing telemetry file: {path}")
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    telemetry = payload.get("tel")
    if not isinstance(telemetry, dict):
        raise SourceError(f"{path.name} has no 'tel' object")
    return telemetry


# ---------------------------------------------------------------------------
# Conversion and validation
# ---------------------------------------------------------------------------
def to_number(value: object) -> float | None:
    """Return a float, or None when the measurement is missing ("None"/null/NaN)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text or text.lower() in {"none", "nan", "null"}:
            return None
        try:
            number = float(text)
        except ValueError:
            raise ValidationError(f"non-numeric value {value!r}") from None
    else:
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValidationError(f"non-numeric value {value!r}") from None
    if math.isnan(number) or math.isinf(number):
        return None  # non-finite measurement -> SQL NULL
    return number


def to_integer(value: object) -> int | None:
    """Return an int; fractional values are rejected rather than rounded."""
    number = to_number(value)
    if number is None:
        return None
    if number != int(number):
        raise ValidationError(f"expected a whole number, got {number!r}")
    return int(number)


def convert_channels(telemetry: dict[str, list]) -> tuple[dict[str, list], dict[str, dict]]:
    """Map JSON channels to columns, preserving order and length.

    Returns the converted series plus, for any column that had to be rounded,
    how many values were rounded and the largest change applied.
    """
    converted: dict[str, list] = {}
    rounding: dict[str, dict] = {}

    for channel, column in CHANNEL_MAP:
        if channel not in telemetry:
            raise ValidationError(f"channel '{channel}' is missing from the file")
        raw = telemetry[channel]
        if not isinstance(raw, list):
            raise ValidationError(f"channel '{channel}' is not a list")

        if column in ROUNDED_COLUMNS:
            values: list[int | None] = []
            rounded_count = 0
            worst_delta = 0.0
            for value in raw:
                number = to_number(value)
                if number is None:
                    values.append(None)
                    continue
                rounded = int(math.floor(number + 0.5))
                if rounded != number:
                    rounded_count += 1
                    worst_delta = max(worst_delta, abs(number - rounded))
                values.append(rounded)
            converted[column] = values
            if rounded_count:
                rounding[column] = {"count": rounded_count, "max_delta": worst_delta}
        else:
            convert = to_integer if column in INTEGER_COLUMNS else to_number
            converted[column] = [convert(value) for value in raw]

    return converted, rounding


def check_lap(meta: dict, series: dict[str, list]) -> list[str]:
    """Validate one lap.

    Returns a list of reasons the lap is *ineligible* for telemetry (skipped and
    reported). Raises :class:`ValidationError` for fatal problems, which stop the
    run before anything is written.
    """
    duration = meta["duration"]
    if duration is None:
        return ["no recorded lap duration (metadata only)"]
    if duration <= 0:
        return [f"non-positive recorded lap duration ({duration})"]

    lengths = {column: len(values) for column, values in series.items()}
    if len(set(lengths.values())) != 1:
        raise ValidationError(f"channel lengths differ: {lengths}")
    sample_count = len(series["elapsed_s"])
    if sample_count == 0:
        raise ValidationError("no telemetry samples")

    missing = sum(value is None for value in series["elapsed_s"])
    if missing:
        raise ValidationError(f"elapsed_s has {missing} missing value(s) but is NOT NULL")

    times = series["elapsed_s"]
    for index in range(1, sample_count):
        if times[index] <= times[index - 1]:
            raise ValidationError(f"elapsed_s not strictly increasing at sample {index}")

    if abs(times[-1] - duration) > DURATION_TOLERANCE_S:
        raise ValidationError(
            f"trace ends at {times[-1]:.3f} s but lap_duration is {duration:.3f} s"
        )

    reasons = []
    for column, (low, high) in RANGE_RULES.items():
        violations = [
            index
            for index, value in enumerate(series[column])
            if value is not None
            and ((low is not None and value < low) or (high is not None and value > high))
        ]
        if violations:
            first = violations[0]
            bounds = f"{low}..{high}" if high is not None else f">= {low}"
            reasons.append(
                f"{column} outside {bounds}: {len(violations)} sample(s), first at "
                f"index {first} = {series[column][first]:.9f}"
            )
    return reasons


def build_rows(lap_id: int, series: dict[str, list]) -> list[tuple]:
    """One tuple per sample in original order; sample_index = array position."""
    rows = []
    for index in range(len(series["elapsed_s"])):
        row = [lap_id, index]
        row.extend(series[column][index] for _, column in CHANNEL_MAP)
        rows.append(tuple(row))
    return rows


def describe(series: dict[str, list]) -> dict[str, dict]:
    stats = {}
    for _, column in CHANNEL_MAP:
        values = [value for value in series[column] if value is not None]
        stats[column] = {
            "count": len(series[column]),
            "nulls": len(series[column]) - len(values),
            "min": min(values) if values else None,
            "max": max(values) if values else None,
        }
    return stats


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
LAP_METADATA_COLUMNS = (
    "lap_duration",
    "sector_1",
    "sector_2",
    "sector_3",
    "is_pit_out_lap",
    "is_pit_in_lap",
)
ROW_TEMPLATE = sql.SQL("({})").format(
    sql.SQL(", ").join([sql.Placeholder()] * len(INSERT_COLUMNS))
)


def resolve_event(conn: psycopg.Connection, race_id: int = RACE_ID) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT event_id FROM events WHERE f1db_race_id = %s", (race_id,))
        row = cur.fetchone()
    if row is None:
        raise ValidationError(f"no events row with f1db_race_id={race_id}")
    return row[0]


def resolve_session(conn: psycopg.Connection, event_id: int,
                    session_key: int = SESSION_KEY) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT session_id FROM sessions "
            "WHERE event_id = %s AND openf1_session_key = %s AND session_type = %s",
            (event_id, session_key, SESSION_TYPE),
        )
        row = cur.fetchone()
    if row is None:
        raise ValidationError(
            f"no {SESSION_TYPE} session for event {event_id} with OpenF1 key {session_key}"
        )
    return row[0]


def ensure_driver(conn: psycopg.Connection, identity: dict) -> tuple[int, str]:
    """Return (driver_id, 'existing'|'inserted')."""
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id FROM drivers WHERE f1db_id = %s", (identity["f1db_id"],))
        row = cur.fetchone()
        if row is not None:
            return row[0], "existing"
        cur.execute(
            "INSERT INTO drivers (f1db_id, first_name, last_name, abbreviation) "
            "VALUES (%s, %s, %s, %s) RETURNING driver_id",
            (identity["f1db_id"], identity["first_name"], identity["last_name"], identity["code"]),
        )
        return cur.fetchone()[0], "inserted"


def ensure_entry(conn: psycopg.Connection, session_id: int, driver_id: int,
                 number: int, team: str | None) -> tuple[int, str]:
    """Return (entry_id, 'existing'|'inserted')."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT entry_id FROM session_entries WHERE session_id = %s AND driver_id = %s",
            (session_id, driver_id),
        )
        row = cur.fetchone()
        if row is not None:
            return row[0], "existing"
        cur.execute(
            "INSERT INTO session_entries (session_id, driver_id, driver_number, team_name) "
            "VALUES (%s, %s, %s, %s) RETURNING entry_id",
            (session_id, driver_id, number, team),
        )
        return cur.fetchone()[0], "inserted"


def ensure_lap(conn: psycopg.Connection, entry_id: int, meta: dict) -> tuple[int, str]:
    """Return (lap_id, 'existing'|'inserted'|'updated').

    NULL columns on an existing row are filled from the archive; values already in
    the database are never overwritten.
    """
    values = {
        "lap_duration": meta["duration"],
        "sector_1": meta["sector_1"],
        "sector_2": meta["sector_2"],
        "sector_3": meta["sector_3"],
        "is_pit_out_lap": meta["pit_out"],
        "is_pit_in_lap": meta["pit_in"],
    }
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL("SELECT lap_id, {columns} FROM laps WHERE entry_id = %s AND lap_number = %s").format(
                columns=sql.SQL(", ").join(map(sql.Identifier, LAP_METADATA_COLUMNS))
            ),
            (entry_id, meta["lap_number"]),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(
                sql.SQL("INSERT INTO laps (entry_id, lap_number, {columns}) "
                        "VALUES (%s, %s, {placeholders}) RETURNING lap_id").format(
                    columns=sql.SQL(", ").join(map(sql.Identifier, LAP_METADATA_COLUMNS)),
                    placeholders=sql.SQL(", ").join([sql.Placeholder()] * len(LAP_METADATA_COLUMNS)),
                ),
                (entry_id, meta["lap_number"], *[values[c] for c in LAP_METADATA_COLUMNS]),
            )
            return cur.fetchone()[0], "inserted"

        lap_id = row[0]
        current = dict(zip(LAP_METADATA_COLUMNS, row[1:]))
        updates = {c: v for c, v in values.items() if current[c] is None and v is not None}
        if not updates:
            return lap_id, "existing"
        cur.execute(
            sql.SQL("UPDATE laps SET {} WHERE lap_id = %s").format(
                sql.SQL(", ").join(
                    sql.SQL("{} = {}").format(sql.Identifier(column), sql.Placeholder())
                    for column in updates
                )
            ),
            (*updates.values(), lap_id),
        )
        return lap_id, "updated"


def insert_telemetry(conn: psycopg.Connection, rows: list[tuple]) -> int:
    """Insert one lap's samples in chunks; returns how many rows were offered."""
    if not rows:
        return 0
    columns = sql.SQL(", ").join(map(sql.Identifier, INSERT_COLUMNS))
    with conn.cursor() as cur:
        for start in range(0, len(rows), CHUNK_SIZE):
            chunk = rows[start:start + CHUNK_SIZE]
            query = sql.SQL(
                "INSERT INTO telemetry_samples ({columns}) VALUES {values} "
                "ON CONFLICT (lap_id, sample_index) DO NOTHING"
            ).format(columns=columns, values=sql.SQL(", ").join([ROW_TEMPLATE] * len(chunk)))
            cur.execute(query, [value for row in chunk for value in row])
    return len(rows)


def scalar(conn: psycopg.Connection, query: str, params: tuple = ()) -> int:
    with conn.cursor() as cur:
        cur.execute(query, params)
        return int(cur.fetchone()[0])


def existing_lap_targets(conn: psycopg.Connection, lap_ids: list[int]) -> dict[int, tuple[str, int]]:
    """Map lap_id -> (driver code, lap_number) for the given lap ids."""
    query = """
        SELECT l.lap_id, d.abbreviation, l.lap_number
        FROM laps l
        JOIN session_entries se ON se.entry_id = l.entry_id
        JOIN drivers d ON d.driver_id = se.driver_id
        WHERE l.lap_id = ANY(%s)
    """
    with conn.cursor() as cur:
        cur.execute(query, (list(lap_ids),))
        return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


def session_counts(conn: psycopg.Connection, session_id: int) -> dict[str, dict[str, int]]:
    """Per-driver stored lap and telemetry-sample counts."""
    laps_query = """
        SELECT d.abbreviation, COUNT(*)
        FROM laps l
        JOIN session_entries se ON se.entry_id = l.entry_id
        JOIN drivers d ON d.driver_id = se.driver_id
        WHERE se.session_id = %s
        GROUP BY d.abbreviation
    """
    samples_query = """
        SELECT d.abbreviation, COUNT(*)
        FROM telemetry_samples t
        JOIN laps l ON l.lap_id = t.lap_id
        JOIN session_entries se ON se.entry_id = l.entry_id
        JOIN drivers d ON d.driver_id = se.driver_id
        WHERE se.session_id = %s
        GROUP BY d.abbreviation
    """
    with conn.cursor() as cur:
        cur.execute(laps_query, (session_id,))
        laps = dict(cur.fetchall())
        cur.execute(samples_query, (session_id,))
        samples = dict(cur.fetchall())
    return {"laps": laps, "samples": samples}


# ---------------------------------------------------------------------------
# Planning and reporting
# ---------------------------------------------------------------------------
def build_plan(identities: list[dict], lap_targets: set[tuple[str, int]] | None,
               limit: int | None) -> tuple[list[dict], list[tuple[str, int, list[str]]]]:
    """Read every candidate lap, validate it and classify it.

    Returns (plan, skipped) where each plan item carries the lap metadata to
    persist plus the eligible laps (metadata + sample count). Telemetry values are
    not kept in memory - the write phase re-reads only the eligible files.
    """
    plan: list[dict] = []
    skipped: list[tuple[str, int, list[str]]] = []
    processed = 0

    for identity in identities:
        code = identity["code"]
        item = {"identity": identity, "laps": [], "eligible": [], "skips": [], "samples": 0}
        for meta in load_laptimes(code):
            if lap_targets is not None and (code, meta["lap_number"]) not in lap_targets:
                continue
            if limit is not None and processed >= limit:
                break
            processed += 1
            item["laps"].append(meta)

            if meta["duration"] is None:
                item["skips"].append((meta["lap_number"], ["no recorded lap duration"]))
                continue

            telemetry = load_telemetry(telemetry_path(code, meta["lap_number"]))
            series, _rounding = convert_channels(telemetry)
            reasons = check_lap(meta, series)
            if reasons:
                item["skips"].append((meta["lap_number"], reasons))
            else:
                count = len(series["elapsed_s"])
                item["eligible"].append((meta, count))
                item["samples"] += count

        if item["laps"]:
            plan.append(item)
        skipped.extend((code, number, reasons) for number, reasons in item["skips"])

    return plan, skipped


def print_section(title: str) -> None:
    print()
    print("-" * 78)
    print(title)
    print("-" * 78)


def print_identity_table(identities: list[dict]) -> None:
    print(f"{'code':<5}{'car':>4}  {'f1db_id':<20}{'team':<20}{'grid':>5}")
    for identity in identities:
        grid = identity["grid_position"] if identity["grid_position"] else "-"
        print(
            f"{identity['code']:<5}{identity['number']:>4}  {identity['f1db_id']:<20}"
            f"{(identity['team'] or '-'):<20}{grid:>5}"
        )


def print_plan(plan: list[dict]) -> None:
    print(f"{'code':<5}{'laps':>6}{'timed':>7}{'elig':>6}{'skip':>6}{'rows':>10}")
    for item in plan:
        timed = sum(1 for meta in item["laps"] if meta["duration"] is not None)
        print(
            f"{item['identity']['code']:<5}{len(item['laps']):>6}{timed:>7}"
            f"{len(item['eligible']):>6}{len(item['skips']):>6}{item['samples']:>10,}"
        )


def print_skips(skipped: list[tuple[str, int, list[str]]]) -> None:
    untimed = [s for s in skipped if s[2] == ["no recorded lap duration"]]
    blocked = [s for s in skipped if s not in untimed]

    print(f"\nlaps without a recorded duration (metadata only, no telemetry): {len(untimed)}")
    if blocked:
        print(f"\nlaps skipped because a measurement would violate a CHECK constraint: {len(blocked)}")
        for code, number, reasons in blocked:
            print(f"  {code} lap {number}: " + "; ".join(reasons))
    else:
        print("\nno laps were skipped for constraint violations")


def write_plan(conn: psycopg.Connection, plan: list[dict], session_id: int) -> list[dict]:
    """Persist one driver at a time, committing explicitly after each driver."""
    results = []
    for item in plan:
        identity = item["identity"]
        record = {
            "code": identity["code"],
            "driver": "existing",
            "entry": "existing",
            "lap_inserted": 0,
            "lap_updated": 0,
            "lap_existing": 0,
            "rows": 0,
        }
        try:
            driver_id, driver_action = ensure_driver(conn, identity)
            entry_id, entry_action = ensure_entry(
                conn, session_id, driver_id, identity["number"], identity["team"]
            )
            record["driver"] = driver_action
            record["entry"] = entry_action

            lap_ids = {}
            for meta in item["laps"]:
                lap_id, action = ensure_lap(conn, entry_id, meta)
                lap_ids[meta["lap_number"]] = lap_id
                record[f"lap_{action}"] += 1

            for meta, _count in item["eligible"]:
                series, _rounding = convert_channels(
                    load_telemetry(telemetry_path(identity["code"], meta["lap_number"]))
                )
                record["rows"] += insert_telemetry(
                    conn, build_rows(lap_ids[meta["lap_number"]], series)
                )

            conn.commit()  # explicit commit: one transaction per driver
        except Exception:
            conn.rollback()
            raise

        results.append(record)
        print(
            f"  {identity['code']:<5} driver {record['driver']:<8} entry {record['entry']:<8} "
            f"laps +{record['lap_inserted']:<3} ~{record['lap_updated']:<3} "
            f"={record['lap_existing']:<3} rows offered {record['rows']:>8,}"
        )
    return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Import 2025 Belgian Grand Prix qualifying telemetry into telemetry_samples."
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="validate and report without touching the database")
    parser.add_argument("--driver", action="append", metavar="CODE",
                        help="limit to these driver codes, e.g. --driver VER (repeatable)")
    parser.add_argument("--lap-id", action="append", type=int, metavar="ID",
                        help="limit to these existing lap ids (repeatable)")
    parser.add_argument("--limit", type=int, metavar="N",
                        help="process at most N laps (for smoke tests)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    mode = "DRY RUN (no database changes)" if args.dry_run else "WRITE MODE"
    print("=" * 78)
    print(f"SPA 2025 QUALIFYING IMPORT - {mode}")
    print("=" * 78)

    try:
        database_url, env_path = load_database_url()
    except ConfigurationError as exc:
        print(f"configuration : FAILED - {exc}")
        return 2
    print(f".env used      : {env_path}")
    print("DATABASE_URL   : loaded (value not printed)")

    try:
        conn = connect(database_url)
    except Exception as exc:  # noqa: BLE001 - report and stop, no credentials
        print(f"connection     : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1

    expected: dict[str, int] = {}
    try:
        event_id = resolve_event(conn)
        session_id = resolve_session(conn, event_id)
        print(f"event_id       : {event_id} (F1DB race {RACE_ID})")
        print(f"session_id     : {session_id} (OpenF1 session {SESSION_KEY}, {SESSION_TYPE})")

        grid = load_f1db_grid()
        identities = resolve_identities(load_archive_drivers(), grid, load_f1db_driver_names())
        print_section(f"DRIVER IDENTITY - {len(identities)}/{len(grid)} grid drivers resolved by car number")
        print_identity_table(identities)

        lap_targets = None
        if args.lap_id:
            mapping = existing_lap_targets(conn, args.lap_id)
            missing = sorted(set(args.lap_id) - set(mapping))
            if missing:
                raise ValidationError(f"--lap-id not present in laps: {missing}")
            lap_targets = set(mapping.values())
            print(f"\nrestricted to lap ids {sorted(args.lap_id)} -> {sorted(lap_targets)}")

        drivers = identities
        if args.driver:
            wanted = {code.upper() for code in args.driver}
            unknown = wanted - {identity["code"] for identity in identities}
            if unknown:
                raise ValidationError(f"--driver not in this session: {sorted(unknown)}")
            drivers = [identity for identity in identities if identity["code"] in wanted]

        plan, skipped = build_plan(drivers, lap_targets, args.limit)

        print_section("IMPORT PLAN")
        print_plan(plan)
        print_skips(skipped)

        total_laps = sum(len(item["laps"]) for item in plan)
        eligible_laps = sum(len(item["eligible"]) for item in plan)
        total_rows = sum(item["samples"] for item in plan)
        stored_samples = sum(session_counts(conn, session_id)["samples"].values())
        print_section("TOTALS")
        print(f"laps with metadata    : {total_laps}")
        print(f"laps with telemetry   : {eligible_laps}")
        print(f"telemetry rows planned: {total_rows:,}")
        print(f"rows already stored   : {stored_samples:,} (this session)")
        print(f"rows expected after   : {max(total_rows, stored_samples):,}")
        pit_out = sum(1 for item in plan for meta in item["laps"] if meta["has_pit_out"])
        pit_in = sum(1 for item in plan for meta in item["laps"] if meta["has_pit_in"])
        print(f"laps with pit-exit    : {pit_out} (is_pit_out_lap left NULL: pout/pin semantics ambiguous)")
        print(f"laps with pit-entry   : {pit_in} (is_pit_in_lap left NULL: pout/pin semantics ambiguous)")

        if args.dry_run:
            print("\nDRY RUN: nothing written to the database.")
            return 0

        print_section("WRITE - one explicit commit per driver")
        write_plan(conn, plan, session_id)
        expected = {item["identity"]["code"]: item["samples"] for item in plan}
    except (ValidationError, SourceError, psycopg.Error) as exc:
        print(f"\nABORTED: {type(exc).__name__}: {redact(exc)}")
        try:
            conn.rollback()
        except psycopg.Error:
            pass
        return 1
    finally:
        conn.close()

    print_section("INDEPENDENT VERIFICATION - new connection")
    try:
        verify = connect(database_url)
    except Exception as exc:  # noqa: BLE001
        print(f"reconnect      : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1
    try:
        counts = session_counts(verify, session_id)
        drivers_total = scalar(verify, "SELECT COUNT(*) FROM drivers")
        entries_total = scalar(
            verify, "SELECT COUNT(*) FROM session_entries WHERE session_id = %s", (session_id,)
        )
        laps_total = scalar(
            verify,
            "SELECT COUNT(*) FROM laps l JOIN session_entries se ON se.entry_id = l.entry_id "
            "WHERE se.session_id = %s",
            (session_id,),
        )
        samples_total = scalar(verify, "SELECT COUNT(*) FROM telemetry_samples")
    finally:
        verify.close()

    print(f"drivers (whole table) : {drivers_total}")
    print(f"session_entries       : {entries_total}")
    print(f"laps in this session  : {laps_total}")
    print(f"telemetry_samples     : {samples_total:,}")
    print()
    print(f"{'code':<5}{'stored':>10}{'planned':>10}   status")
    mismatches = 0
    for code in sorted(expected):
        actual = counts["samples"].get(code, 0)
        planned = expected[code]
        if actual != planned:
            mismatches += 1
        print(f"{code:<5}{actual:>10,}{planned:>10,}   {'OK' if actual == planned else 'MISMATCH'}")

    stored_for_plan = sum(counts["samples"].get(code, 0) for code in expected)
    planned_total = sum(expected.values())
    print(f"{'TOTAL':<5}{stored_for_plan:>10,}{planned_total:>10,}   "
          f"{'OK' if stored_for_plan == planned_total else 'MISMATCH'}")

    if mismatches:
        print(f"\nRESULT: {mismatches} driver(s) do not match the plan")
        return 3
    print("\nRESULT: stored counts match the plan")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())







