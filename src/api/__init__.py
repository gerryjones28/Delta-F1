"""Read-only HTTP API over the stored telemetry.

``src.api.main`` builds the FastAPI application (``uvicorn src.api.main:app``),
``src.api.catalog`` holds the catalogue queries and ``src.api.payloads`` shapes
responses for the client. Nothing here writes to the database.

The package deliberately does not import the application at import time, so the
modules stay usable (and testable) on their own.
"""

from __future__ import annotations

__all__ = ["catalog", "main", "payloads"]
