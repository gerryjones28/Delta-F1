"""OpenF1 connectivity check.

Retrieves the 2025 Belgian Grand Prix qualifying session from ``/sessions`` and
prints its identifier plus basic metadata.

Usage (from the project root, virtual environment active)::

    python -m src.extract.openf1_check

Exit codes:
    0 - session retrieved and printed
    1 - OpenF1 could not be reached / returned an HTTP error or timeout
    2 - the request succeeded but no matching session was returned
"""

from __future__ import annotations

import sys
from typing import Any

from src.extract.openf1_client import OpenF1Client, OpenF1Error

TARGET_YEAR = 2025
TARGET_COUNTRY = "Belgium"
TARGET_SESSION_NAME = "Qualifying"

DISPLAY_FIELDS: tuple[str, ...] = (
    "session_key",
    "session_name",
    "session_type",
    "meeting_key",
    "circuit_short_name",
    "location",
    "country_name",
    "date_start",
    "date_end",
    "gmt_offset",
    "year",
    "is_cancelled",
)


def fetch_target_session(client: OpenF1Client) -> list[dict[str, Any]]:
    """Return all OpenF1 sessions matching the configured target."""
    return client.get_sessions(
        year=TARGET_YEAR,
        country_name=TARGET_COUNTRY,
        session_name=TARGET_SESSION_NAME,
    )


def print_session(session: dict[str, Any]) -> None:
    print(f"session identifier (session_key): {session.get('session_key')}")
    print("basic metadata:")
    for field in DISPLAY_FIELDS:
        if field == "session_key":
            continue
        print(f"  {field:<18} {session.get(field)}")


def main() -> int:
    target = (
        f"year={TARGET_YEAR}, country_name={TARGET_COUNTRY!r}, "
        f"session_name={TARGET_SESSION_NAME!r}"
    )
    print(f"Querying OpenF1 /sessions with {target} ...")

    try:
        with OpenF1Client() as client:
            sessions = fetch_target_session(client)
    except OpenF1Error as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1

    if not sessions:
        print(
            "[WARN] OpenF1 responded normally but returned no matching session.",
            file=sys.stderr,
        )
        return 2

    print(f"[OK] OpenF1 reachable; {len(sessions)} matching session(s) returned.\n")
    print_session(sessions[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
