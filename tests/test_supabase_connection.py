"""PostgreSQL connection smoke test for the Delta F1 database.

Read-only: connect, read ``current_database()`` and six row counts, compare them
with the counts produced by the manual inserts. The connection string is never
printed and nothing is written to the database.

Run as a script::

    python tests/test_supabase_connection.py

Run with pytest::

    python -m pytest tests/test_supabase_connection.py -v

Exit codes (script mode): 0 ok, 1 connection/query failure, 2 configuration
problem (no .env or no DATABASE_URL), 3 row counts do not match EXPECTED_COUNTS.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import psycopg
import pytest
from dotenv import load_dotenv
from psycopg import sql

# The git repository lives one level below the project folder, and the .env file
# has been placed in the project folder, so both locations are checked in order.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_CANDIDATES = (PROJECT_ROOT / ".env", PROJECT_ROOT.parent / ".env")

SSL_MODE = "require"      # Supabase requires TLS
CONNECT_TIMEOUT = 10      # seconds

TABLES = (
    "drivers",
    "events",
    "sessions",
    "session_entries",
    "laps",
    "telemetry_samples",
)

# Snapshot produced by the manual inserts, plus the 1,496 telemetry rows loaded
# by src/load/telemetry_importer.py (VER lap 2 = 745, LEC lap 4 = 751).
EXPECTED_COUNTS = {
    "drivers": 2,
    "events": 1,
    "sessions": 1,
    "session_entries": 2,
    "laps": 2,
    "telemetry_samples": 1496,
}

_URL_PATTERN = re.compile(r"(?i)\bpostgres(?:ql)?(?:\+[a-z0-9]+)?://\S+")


class ConfigurationError(RuntimeError):
    """Raised when .env or DATABASE_URL cannot be found."""


def redact(text: object) -> str:
    """Remove anything resembling a connection string before it is printed."""
    return _URL_PATTERN.sub("<redacted-connection-string>", str(text))


def find_env_file() -> Path | None:
    """First .env that exists, in documented search order."""
    for candidate in ENV_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def load_database_url() -> tuple[str, Path]:
    """Return (DATABASE_URL, env file path) without ever echoing the URL."""
    env_file = find_env_file()
    if env_file is None:
        searched = " and ".join(str(path) for path in ENV_CANDIDATES)
        raise ConfigurationError(f"no .env found (looked for {searched})")

    load_dotenv(env_file)  # real environment variables win over .env values
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ConfigurationError(f".env found at {env_file} but DATABASE_URL is not set")
    return database_url, env_file


def connect(database_url: str) -> psycopg.Connection:
    """Connect with TLS and a bounded timeout."""
    return psycopg.connect(
        database_url,
        sslmode=SSL_MODE,
        connect_timeout=CONNECT_TIMEOUT,
    )


def read_report(conn: psycopg.Connection) -> dict:
    """Run the read-only queries; the transaction is marked read-only on purpose."""
    with conn.transaction():
        conn.execute("SET TRANSACTION READ ONLY")
        database = conn.execute("SELECT current_database()").fetchone()[0]
        server_version = conn.execute("SHOW server_version").fetchone()[0]
        counts = {}
        for table in TABLES:
            query = sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))
            counts[table] = conn.execute(query).fetchone()[0]
    return {"database": database, "server_version": server_version, "counts": counts}


def diagnose(exc: BaseException) -> str:
    """Plain-language hint for common failures; never contains credentials."""
    message = str(exc).lower()
    if "could not translate host name" in message or "name or service not known" in message:
        return "DNS lookup failed - check the host in DATABASE_URL, or your network/VPN."
    if "tenant or user not found" in message:
        return "Supabase rejected the pooler user - check the username/project ref in DATABASE_URL."
    if "password authentication failed" in message or "no password supplied" in message:
        return "Authentication rejected - check the user and password in DATABASE_URL."
    if "timeout" in message:
        return "Timed out - project paused, port blocked, or network too slow for 10 s."
    if "ssl" in message:
        return "TLS negotiation failed - sslmode=require was requested; check the project allows SSL."
    if "does not exist" in message:
        return "A database, table or role was not found - check the project ref and the tables."
    return "Failed before any query ran; see the type/message above (no credentials printed)."


def print_counts(counts: dict[str, int]) -> int:
    """Print the counts table; return how many tables disagree with EXPECTED_COUNTS."""
    print()
    print(f"{'table':<20}{'rows':>8}{'expected':>10}   status")
    print("-" * 52)
    mismatches = 0
    for table in TABLES:
        actual = counts[table]
        expected = EXPECTED_COUNTS[table]
        status = "ok" if actual == expected else "MISMATCH"
        if actual != expected:
            mismatches += 1
        print(f"{table:<20}{actual:>8}{expected:>10}   {status}")
    return mismatches


def main() -> int:
    print("=" * 60)
    print("DATABASE CONNECTION TEST")
    print("=" * 60)

    try:
        database_url, env_file = load_database_url()
    except ConfigurationError as exc:
        print("configuration : FAILED")
        print(f"  {exc}")
        return 2

    print(f".env used      : {env_file}")
    if env_file != PROJECT_ROOT / ".env":
        print("  note: the repository root has no .env; using the one one level above it")
    print("DATABASE_URL   : loaded (value not printed)")
    print(f"connect params : sslmode={SSL_MODE}, connect_timeout={CONNECT_TIMEOUT}s")

    started = time.perf_counter()
    try:
        conn = connect(database_url)
    except Exception as exc:  # noqa: BLE001 - diagnostic script, report and stop
        print("connection     : FAILED")
        print(f"  {type(exc).__name__}: {redact(exc)}")
        print(f"  hint: {diagnose(exc)}")
        return 1
    elapsed = time.perf_counter() - started

    try:
        with conn:
            report = read_report(conn)
    except Exception as exc:  # noqa: BLE001
        print("connection     : OK, but a query failed")
        print(f"  {type(exc).__name__}: {redact(exc)}")
        print(f"  hint: {diagnose(exc)}")
        return 1

    print("connection     : OK")
    print(f"  latency      : {elapsed * 1000:.0f} ms")
    print(f"  server       : PostgreSQL {report['server_version']}")
    print(f"  database     : {report['database']}")

    mismatches = print_counts(report["counts"])
    print()
    if mismatches:
        print(f"RESULT: connected, {mismatches} table(s) differ from the expected inserts")
        return 3
    print("RESULT: connected, all row counts match the expected inserts")
    return 0


@pytest.mark.integration
def test_database_connection_and_expected_counts() -> None:
    """Connection works and the five populated tables hold the inserted rows."""
    try:
        database_url, _ = load_database_url()
    except ConfigurationError as exc:
        pytest.skip(f"DATABASE_URL not configured: {exc}")

    try:
        with connect(database_url) as conn:
            report = read_report(conn)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"{type(exc).__name__}: {redact(exc)}")

    assert report["database"], "current_database() returned nothing"
    assert report["counts"] == EXPECTED_COUNTS, (
        "row counts changed - update EXPECTED_COUNTS once the importer adds rows"
    )


if __name__ == "__main__":
    raise SystemExit(main())

