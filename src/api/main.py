"""Minimal read-only HTTP API in front of the stored telemetry.

All calculation is delegated to :mod:`src.analysis.sector_alignment`; this layer
only resolves identifiers, validates the request and shapes the response for a
React client.

Endpoints::

    GET  /api/health
    GET  /api/sessions
    GET  /api/sessions/{session_id}/drivers
    GET  /api/sessions/{session_id}/laps?driver_code=VER
    POST /api/compare

Run locally::

    uvicorn src.api.main:app --reload --port 8000

``DATABASE_URL`` is read from ``.env`` by the existing importer utilities and is
never echoed back to the client.
"""

from __future__ import annotations

import os

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.analysis.sector_alignment import (
    AlignmentError,
    LapSelector,
    SessionSelector,
    compare_laps,
)
from src.api import catalog, payloads
from src.load.telemetry_importer import ConfigurationError, redact

DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173",     # Vite dev server
    "http://127.0.0.1:5173",
    "http://localhost:3000",     # CRA / next dev
    "http://127.0.0.1:3000",
)
# Name kept from the earlier project name so existing local setups keep working;
# only the human-facing brand changed to Delta F1.
CORS_ENV_VAR = "DELTATRACE_CORS_ORIGINS"

__all__ = ["compare", "create_app", "health", "laps", "sessions", "session_drivers"]


class LapRef(BaseModel):
    """One lap, identified the way the UI selects it."""

    session_id: str = Field(min_length=3, examples=["2025-belgian-grand-prix-qualifying"])
    driver_code: str = Field(min_length=2, max_length=4, examples=["VER"])
    lap_number: int = Field(ge=1, examples=[2])


class CompareRequest(BaseModel):
    """Two laps of the same session, plus the requested chart resolution."""

    reference: LapRef
    compare: LapRef
    grid_points: int = Field(default=payloads.GRID_DEFAULT,
                             ge=payloads.GRID_MIN, le=payloads.GRID_MAX)


def _analysis_session(session: catalog.SessionRef) -> SessionSelector:
    """Catalogue identifier -> the selector the analysis module expects."""
    return SessionSelector(year=session.year, event_name=session.event_name,
                           session_type=session.session_type)


def _session_or_404(conn, session_id: str) -> catalog.SessionRef:
    session = catalog.catalogue_session(conn, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"unknown session id '{session_id}'")
    return session


def _lap_or_error(conn, session: catalog.SessionRef, lap: LapRef) -> dict:
    """Resolve one lap, rejecting missing and unusable traces."""
    stored = catalog.find_lap(conn, session, lap.driver_code.upper(), lap.lap_number)
    if stored is None:
        raise HTTPException(
            status_code=404,
            detail=(f"lap {lap.lap_number} of {lap.driver_code.upper()} is not stored "
                    f"in {session.id}"),
        )
    if not stored["eligible"]:
        raise HTTPException(
            status_code=422,
            detail=(f"lap {lap.lap_number} of {lap.driver_code.upper()} cannot be "
                    f"aligned: {stored['reason']}"),
        )
    return stored


def create_app(cors_origins: list[str] | None = None) -> FastAPI:
    """Build the application; origins default to the local dev servers."""
    app = FastAPI(
        title="Delta F1 API",
        version="0.1.0",
        summary="Read-only lap telemetry comparison backed by Supabase PostgreSQL",
    )
    origins = cors_origins if cors_origins is not None else [
        origin.strip()
        for origin in os.getenv(CORS_ENV_VAR, ",".join(DEFAULT_CORS_ORIGINS)).split(",")
        if origin.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,          # explicit list, never "*"
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
        allow_credentials=False,
    )

    @app.exception_handler(psycopg.OperationalError)
    async def _database_unavailable(_request, exc):  # pragma: no cover - env dependent
        return JSONResponse(status_code=503,
                            content={"detail": f"database unavailable: {redact(exc)}"})

    @app.exception_handler(ConfigurationError)
    async def _misconfigured(_request, exc):  # pragma: no cover - env dependent
        return JSONResponse(status_code=503,
                            content={"detail": f"database is not configured: {redact(exc)}"})

    @app.get("/api/health")
    def health() -> dict:
        """Liveness only - deliberately does not touch the database."""
        return {
            "status": "ok",
            "read_only": True,
            "grid_points": {
                "default": payloads.GRID_DEFAULT,
                "min": payloads.GRID_MIN,
                "max": payloads.GRID_MAX,
            },
        }

    @app.get("/api/sessions")
    def sessions() -> dict:
        """Qualifying sessions that have laps stored."""
        with catalog.read_only_connection() as conn:
            rows = catalog.list_sessions(conn)
        return {
            "sessions": [
                {
                    **row.session.as_dict(),
                    "laps": row.laps,
                    "drivers": row.drivers,
                    "laps_with_telemetry": row.laps_with_telemetry,
                    "best_lap_s": round(row.best_lap_s, 3) if row.best_lap_s else None,
                }
                for row in rows
            ]
        }

    @app.get("/api/sessions/{session_id}/drivers")
    def session_drivers(session_id: str) -> dict:
        """Everybody who set a lap in one session, fastest first."""
        with catalog.read_only_connection() as conn:
            session = _session_or_404(conn, session_id)
            drivers = catalog.session_drivers(conn, session)
        return {"session": session.as_dict(), "drivers": drivers}

    @app.get("/api/sessions/{session_id}/laps")
    def laps(session_id: str,
             driver_code: str = Query(min_length=2, max_length=4,
                                      description="three-letter driver code, e.g. VER")) -> dict:
        """Every stored lap of one driver, each flagged as eligible or not."""
        with catalog.read_only_connection() as conn:
            session = _session_or_404(conn, session_id)
            stored = catalog.eligible_laps(conn, session, driver_code.upper())
        if not stored:
            raise HTTPException(
                status_code=404,
                detail=f"no laps stored for {driver_code.upper()} in {session.id}",
            )
        return {
            "session": session.as_dict(),
            "driver_code": driver_code.upper(),
            "laps": stored,
            "eligible_lap_numbers": [lap["lap_number"] for lap in stored if lap["eligible"]],
        }

    @app.post("/api/compare")
    def compare(request: CompareRequest) -> dict:
        """Align two laps of the same qualifying session (read-only)."""
        reference, compare_lap = request.reference, request.compare
        if reference.session_id != compare_lap.session_id:
            raise HTTPException(
                status_code=400,
                detail=("both laps must come from the same qualifying session "
                        f"('{reference.session_id}' != '{compare_lap.session_id}')"),
            )
        if (reference.driver_code.upper(), reference.lap_number) == (
                compare_lap.driver_code.upper(), compare_lap.lap_number):
            raise HTTPException(status_code=400,
                                detail="reference and compare point at the same lap")

        with catalog.read_only_connection() as conn:
            session = _session_or_404(conn, reference.session_id)
            stored_reference = _lap_or_error(conn, session, reference)
            stored_compare = _lap_or_error(conn, session, compare_lap)

        try:
            result = compare_laps(
                _analysis_session(session),
                LapSelector(reference.driver_code.upper(), reference.lap_number),
                LapSelector(compare_lap.driver_code.upper(), compare_lap.lap_number),
                grid_points=request.grid_points,
            )
        except AlignmentError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        return payloads.comparison_payload(
            result, session,
            stored_reference["sector_times_s"], stored_compare["sector_times_s"],
        )

    return app


app = create_app()
