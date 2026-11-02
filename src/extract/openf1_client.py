"""Minimal, dependency-light client for the OpenF1 REST API.

Design notes
------------
* Historical OpenF1 data needs no authentication; only a base URL and a timeout
  are configurable (see ``.env.example``).
* OpenF1 returns a JSON **list** for most queries, but a single JSON **object**
  when exactly one record matches. :meth:`OpenF1Client.get_records` normalises
  both shapes into a list so callers do not have to care.
* All network and HTTP failures are surfaced as :class:`OpenF1Error` so callers
  (scripts and tests) can handle them in one place.
* Responses are returned as plain ``dict``/``list`` objects. No schema, key or
  relationship assumptions are made here.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import requests
from dotenv import load_dotenv

from src.paths import PROJECT_ROOT

DEFAULT_BASE_URL = "https://api.openf1.org/v1"
DEFAULT_TIMEOUT = 30.0


class OpenF1Error(RuntimeError):
    """Raised when OpenF1 cannot be reached or returns an unusable response."""


class OpenF1Client:
    """Small wrapper around ``GET {base_url}/{endpoint}``."""

    def __init__(
        self,
        base_url: str | None = None,
        timeout: float | None = None,
        session: requests.Session | Any | None = None,
    ) -> None:
        # .env is optional; real environment variables win over .env values.
        load_dotenv(PROJECT_ROOT / ".env")

        self.base_url = (
            base_url or os.getenv("OPENF1_BASE_URL") or DEFAULT_BASE_URL
        ).rstrip("/")
        self.timeout = float(timeout or os.getenv("OPENF1_TIMEOUT") or DEFAULT_TIMEOUT)
        # ``session`` is injectable so tests can run without network access.
        self._session = session if session is not None else requests.Session()

    # -- context manager ---------------------------------------------------
    def __enter__(self) -> "OpenF1Client":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        close = getattr(self._session, "close", None)
        if callable(close):
            close()

    # -- core request ------------------------------------------------------
    def get(self, endpoint: str, params: Mapping[str, Any] | None = None) -> Any:
        """GET an endpoint and return the decoded JSON payload."""
        url = f"{self.base_url}/{endpoint.lstrip('/')}"

        try:
            response = self._session.get(
                url,
                params=dict(params) if params else None,
                timeout=self.timeout,
                headers={"Accept": "application/json"},
            )
            response.raise_for_status()
        except requests.Timeout as exc:
            raise OpenF1Error(
                f"Request to {url} timed out after {self.timeout:g}s"
            ) from exc
        except requests.HTTPError as exc:
            status = getattr(exc.response, "status_code", "unknown")
            raise OpenF1Error(f"OpenF1 returned HTTP {status} for {url}") from exc
        except requests.RequestException as exc:
            raise OpenF1Error(f"Could not reach OpenF1 at {url}: {exc}") from exc

        try:
            return response.json()
        except ValueError as exc:
            raise OpenF1Error(f"OpenF1 returned non-JSON content for {url}") from exc

    def get_records(
        self, endpoint: str, params: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """GET an endpoint and always return a list of records."""
        payload = self.get(endpoint, params)

        if payload is None:
            return []
        if isinstance(payload, dict):
            # OpenF1 collapses single-record results into one object.
            return [payload]
        if isinstance(payload, list):
            return list(payload)

        raise OpenF1Error(
            f"Unexpected JSON payload type from {endpoint}: {type(payload).__name__}"
        )

    # -- endpoint helpers --------------------------------------------------
    def get_sessions(self, **filters: Any) -> list[dict[str, Any]]:
        """Query ``/sessions``.

        Any keyword argument is passed through as a query parameter, e.g.
        ``client.get_sessions(year=2025, country_name="Belgium")``.
        """
        return self.get_records("sessions", filters or None)


def find_session(sessions: list[dict[str, Any]], **expected: Any) -> dict[str, Any] | None:
    """Return the first session matching every ``expected`` field/value pair.

    OpenF1 treats ``session_name="Qualifying"`` and ``session_name="Sprint
    Qualifying"`` as different sessions, so exact matching is intentional.
    """
    for session in sessions:
        if all(session.get(field) == value for field, value in expected.items()):
            return session
    return None


__all__ = ["OpenF1Client", "OpenF1Error", "find_session", "DEFAULT_BASE_URL", "DEFAULT_TIMEOUT"]
