"""Tests for the OpenF1 client and the /sessions connectivity check.

The first group runs fully offline against a stub HTTP session; the marked
integration tests talk to the real API and skip when it is unreachable.
"""

from __future__ import annotations

from typing import Any

import pytest
import requests

from src.extract.openf1_check import TARGET_COUNTRY, TARGET_SESSION_NAME, TARGET_YEAR
from src.extract.openf1_client import OpenF1Client, OpenF1Error, find_session


# ---------------------------------------------------------------------------
# Test doubles (no network)
# ---------------------------------------------------------------------------
class StubResponse:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(
                f"HTTP {self.status_code}", response=self, request=None
            )

    def json(self) -> Any:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class StubSession:
    """Mimics ``requests.Session`` just enough for the client."""

    def __init__(
        self,
        response: StubResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def get(self, url: str, params: Any = None, **kwargs: Any) -> StubResponse:
        self.calls.append({"url": url, "params": params, **kwargs})
        if self.error is not None:
            raise self.error
        assert self.response is not None, "stub session has no response configured"
        return self.response

    def close(self) -> None:
        pass


def build_client(stub: StubSession) -> OpenF1Client:
    return OpenF1Client(base_url="https://example.invalid/v1", timeout=5, session=stub)


# ---------------------------------------------------------------------------
# Offline behaviour
# ---------------------------------------------------------------------------
def test_single_object_response_is_normalised_to_list() -> None:
    stub = StubSession(StubResponse({"session_key": 9935, "session_name": "Qualifying"}))
    records = build_client(stub).get_sessions(year=2025, country_name="Belgium")

    assert isinstance(records, list)
    assert records == [{"session_key": 9935, "session_name": "Qualifying"}]


def test_list_response_is_preserved() -> None:
    payload = [{"session_key": 1}, {"session_key": 2}]
    stub = StubSession(StubResponse(payload))

    assert build_client(stub).get_sessions(year=2025) == payload


def test_query_parameters_and_url_are_forwarded() -> None:
    stub = StubSession(StubResponse([]))
    build_client(stub).get_sessions(year=2025, country_name="Belgium")

    assert stub.calls[0]["url"] == "https://example.invalid/v1/sessions"
    assert stub.calls[0]["params"] == {"year": 2025, "country_name": "Belgium"}
    assert stub.calls[0]["timeout"] == 5


def test_http_error_becomes_openf1_error() -> None:
    stub = StubSession(StubResponse({"detail": "nope"}, status_code=503))

    with pytest.raises(OpenF1Error, match="HTTP 503"):
        build_client(stub).get_sessions(year=2025)


def test_timeout_becomes_openf1_error() -> None:
    stub = StubSession(error=requests.Timeout("read timed out"))

    with pytest.raises(OpenF1Error, match="timed out"):
        build_client(stub).get_sessions(year=2025)


def test_connection_error_becomes_openf1_error() -> None:
    stub = StubSession(error=requests.ConnectionError("name resolution failed"))

    with pytest.raises(OpenF1Error, match="Could not reach OpenF1"):
        build_client(stub).get_sessions(year=2025)


def test_non_json_payload_becomes_openf1_error() -> None:
    stub = StubSession(StubResponse(ValueError("not json")))

    with pytest.raises(OpenF1Error, match="non-JSON"):
        build_client(stub).get_sessions(year=2025)


def test_find_session_uses_exact_matching() -> None:
    sessions = [
        {"session_key": 9930, "session_name": "Sprint Qualifying"},
        {"session_key": 9935, "session_name": "Qualifying"},
    ]

    found = find_session(sessions, session_name="Qualifying")

    assert found is not None
    assert found["session_key"] == 9935
    assert find_session(sessions, session_name="Sprint Qualifying")["session_key"] == 9930
    assert find_session(sessions, session_name="Race") is None


# ---------------------------------------------------------------------------
# Live API (skipped when OpenF1 is unreachable)
# ---------------------------------------------------------------------------
@pytest.mark.integration
def test_belgian_gp_qualifying_response_contains_expected_identifiers(
    openf1_client: OpenF1Client,
) -> None:
    try:
        sessions = openf1_client.get_sessions(
            year=TARGET_YEAR,
            country_name=TARGET_COUNTRY,
            session_name=TARGET_SESSION_NAME,
        )
    except OpenF1Error as exc:
        pytest.skip(f"OpenF1 unavailable: {exc}")

    assert sessions, "expected at least one qualifying session for the 2025 Belgian GP"

    session = sessions[0]
    expected_fields = (
        "session_key",
        "meeting_key",
        "year",
        "country_name",
        "session_name",
        "date_start",
    )
    for field in expected_fields:
        assert field in session, f"missing expected field: {field}"

    # Identifiers the API exposes today; no schema decisions are implied.
    assert isinstance(session["session_key"], int)
    assert isinstance(session["meeting_key"], int)
    assert session["year"] == TARGET_YEAR
    assert session["country_name"] == TARGET_COUNTRY
    assert session["session_name"] == TARGET_SESSION_NAME
    assert session["date_start"].startswith("20")
