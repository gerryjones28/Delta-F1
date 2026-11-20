"""Endpoint tests for the read-only HTTP API.

The tests hit the real Supabase database through the app, like the analysis
tests do, and skip when it is unreachable. No test writes anything.
"""

from __future__ import annotations

import json

import psycopg
import pytest
from fastapi.testclient import TestClient

from src.api import catalog
from src.api.main import create_app
from src.load.telemetry_importer import ConfigurationError

SPA = "2025-belgian-grand-prix-qualifying"
AUSTRALIA = "2025-australian-grand-prix-qualifying"
DEV_ORIGIN = "http://localhost:5173"


@pytest.fixture(scope="module")
def client():
    app = TestClient(create_app())
    try:
        with catalog.read_only_connection() as conn:
            catalog.list_sessions(conn)
    except (ConfigurationError, psycopg.OperationalError) as exc:  # pragma: no cover
        pytest.skip(f"database unavailable: {exc}")
    return app


def compare_body(reference: tuple[str, int], compare: tuple[str, int],
                 session: str = SPA, **extra) -> dict:
    return {
        "reference": {"session_id": session, "driver_code": reference[0],
                      "lap_number": reference[1]},
        "compare": {"session_id": session, "driver_code": compare[0],
                    "lap_number": compare[1]},
        **extra,
    }


def test_health_does_not_touch_the_database() -> None:
    response = TestClient(create_app()).get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["read_only"] is True
    assert body["grid_points"] == {"default": 500, "min": 50, "max": 2000}


def test_sessions_lists_qualifying_events(client) -> None:
    response = client.get("/api/sessions")
    assert response.status_code == 200
    sessions = response.json()["sessions"]
    assert len(sessions) >= 5
    spa = next(item for item in sessions if item["id"] == SPA)
    assert spa["year"] == 2025
    assert spa["event_name"] == "Belgian Grand Prix"
    assert spa["session_type"] == "Qualifying"
    assert spa["drivers"] == 20
    assert spa["laps_with_telemetry"] > 0
    assert all(set(item) == {"id", "year", "event_name", "session_type", "laps",
                             "drivers", "laps_with_telemetry", "best_lap_s"}
               for item in sessions)


def test_drivers_are_listed_fastest_first(client) -> None:
    response = client.get(f"/api/sessions/{SPA}/drivers")
    assert response.status_code == 200
    body = response.json()
    assert body["session"]["id"] == SPA
    codes = [driver["driver_code"] for driver in body["drivers"]]
    assert len(codes) == 20
    assert {"VER", "LEC"} <= set(codes)
    best = [driver["best_lap_s"] for driver in body["drivers"] if driver["best_lap_s"]]
    assert best == sorted(best)


def test_laps_report_eligibility(client) -> None:
    response = client.get(f"/api/sessions/{SPA}/laps", params={"driver_code": "VER"})
    assert response.status_code == 200
    body = response.json()
    assert body["driver_code"] == "VER"
    assert 2 in body["eligible_lap_numbers"]
    lap2 = next(lap for lap in body["laps"] if lap["lap_number"] == 2)
    assert lap2["lap_duration_s"] == pytest.approx(102.066)
    assert lap2["sector_times_s"] == pytest.approx([30.344, 43.578, 28.144])
    assert lap2["eligible"] is True and lap2["reason"] is None


def test_laps_explain_why_a_lap_is_ineligible(client) -> None:
    response = client.get(f"/api/sessions/{AUSTRALIA}/laps", params={"driver_code": "ALB"})
    assert response.status_code == 200
    lap1 = next(lap for lap in response.json()["laps"] if lap["lap_number"] == 1)
    assert lap1["eligible"] is False
    assert lap1["reason"] == "no telemetry stored"
    assert lap1["telemetry_samples"] == 0

def test_compare_spa_returns_measured_and_estimated(client) -> None:
    response = client.post("/api/compare", json=compare_body(("VER", 2), ("LEC", 4)))
    assert response.status_code == 200
    body = response.json()

    assert set(body) == {"meta", "measured", "estimated", "coverage",
                         "uncertainty", "limitations"}
    assert body["meta"]["session"]["id"] == SPA
    assert body["meta"]["reference"] == {"driver_code": "VER", "lap_number": 2}
    assert body["meta"]["compare"] == {"driver_code": "LEC", "lap_number": 4}
    assert body["meta"]["read_only"] is True

    measured = body["measured"]
    assert measured["lap_duration_s"] == {"reference": 102.066, "compare": 101.635}
    assert measured["sector_times_s"]["reference"] == pytest.approx([30.344, 43.578, 28.144])
    assert measured["sector_times_s"]["compare"] == pytest.approx([30.001, 43.547, 28.087])
    assert measured["sector_deltas_s"] == pytest.approx([0.343, 0.031, 0.057])
    assert measured["cumulative_deltas_s"] == pytest.approx([0.343, 0.374, 0.431])
    assert measured["lap_delta_s"] == pytest.approx(0.431)
    assert [item["samples"] for item in measured["sampling"]] == [745, 751]

    estimated = body["estimated"]
    assert len(estimated["axis"]["progress"]) == 500
    assert len(estimated["delta_s"]) == 500
    assert estimated["axis"]["progress"][0] == 0.0
    assert estimated["axis"]["progress"][-1] == pytest.approx(1.0, abs=1e-4)
    assert estimated["axis"]["length_m"] == pytest.approx(6951.3, abs=0.5)
    assert [boundary["cumulative_delta_s"]
            for boundary in estimated["axis"]["sector_boundaries"]] == pytest.approx(
                [0.343, 0.374, 0.431])
    for role in ("reference", "compare"):
        series = estimated["series"][role]
        assert len(series["elapsed_s"]) == 500
        assert len(series["speed_kmh"]) == 500
        assert len(series["throttle_pct"]) == 500
        assert set(series["brake"]) <= {0, 1}
    assert estimated["delta_s"][0] == 0.0

    assert body["coverage"]["complete_lap"] is True
    assert body["coverage"]["compared_progress"]["start"] == 0.0
    assert body["uncertainty"]["stated_seconds"] == pytest.approx(0.608, abs=0.01)
    assert len(body["uncertainty"]["sectors"]) == 3
    assert len(body["limitations"]) >= 5
    assert any("construction" in item for item in body["limitations"])


def test_compare_respects_grid_points(client) -> None:
    response = client.post("/api/compare",
                           json=compare_body(("VER", 2), ("LEC", 4), grid_points=120))
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["grid_points"] == 120
    assert len(body["estimated"]["delta_s"]) == 120


def test_compare_rejects_different_sessions(client) -> None:
    body = {
        "reference": {"session_id": SPA, "driver_code": "VER", "lap_number": 2},
        "compare": {"session_id": "2025-dutch-grand-prix-qualifying",
                    "driver_code": "PIA", "lap_number": 14},
    }
    response = client.post("/api/compare", json=body)
    assert response.status_code == 400
    assert "same qualifying session" in response.json()["detail"]


def test_compare_rejects_the_same_lap_twice(client) -> None:
    response = client.post("/api/compare", json=compare_body(("VER", 2), ("VER", 2)))
    assert response.status_code == 400
    assert "same lap" in response.json()["detail"]


def test_compare_rejects_unknown_lap(client) -> None:
    response = client.post("/api/compare", json=compare_body(("VER", 2), ("LEC", 99)))
    assert response.status_code == 404
    assert "not stored" in response.json()["detail"]


def test_compare_rejects_missing_telemetry(client) -> None:
    response = client.post("/api/compare",
                           json=compare_body(("ALB", 1), ("ALB", 13), session=AUSTRALIA))
    assert response.status_code == 422
    assert "no telemetry stored" in response.json()["detail"]


def test_grid_points_are_bounded(client) -> None:
    response = client.post("/api/compare",
                           json=compare_body(("VER", 2), ("LEC", 4), grid_points=5000))
    assert response.status_code == 422


def test_unknown_session_is_404(client) -> None:
    response = client.get("/api/sessions/2025-narnia-grand-prix-qualifying/drivers")
    assert response.status_code == 404


def test_cors_allows_the_local_dev_origin_only(client) -> None:
    preflight = {"Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type"}
    allowed = client.options("/api/compare",
                             headers={"Origin": DEV_ORIGIN, **preflight})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == DEV_ORIGIN

    blocked = client.options("/api/compare",
                             headers={"Origin": "https://example.invalid", **preflight})
    assert "access-control-allow-origin" not in blocked.headers


def test_response_never_contains_credentials(client) -> None:
    response = client.post("/api/compare", json=compare_body(("VER", 2), ("LEC", 4)))
    text = json.dumps(response.json()).lower()
    for marker in ("postgres://", "postgresql://", "sslmode", "database_url",
                   "password", "supabase.co"):
        assert marker not in text, f"response leaks {marker!r}"
