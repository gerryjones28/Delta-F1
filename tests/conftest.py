"""Shared pytest fixtures.

Integration tests must never fail just because the environment is offline or the
F1DB exports have not been downloaded yet: the fixtures below raise
``pytest.skip`` instead of errors.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.extract.f1db_csv_loader import (
    F1DBDirectoryNotFound,
    get_data_dir,
    list_csv_files,
)
from src.extract.openf1_client import OpenF1Client


@pytest.fixture(scope="session")
def openf1_client() -> OpenF1Client:
    """A real OpenF1 client with a shorter timeout, so offline runs fail fast."""
    with OpenF1Client(timeout=20) as client:
        yield client


@pytest.fixture(scope="session")
def f1db_dir() -> Path:
    """The local F1DB CSV directory, or a skip when it is unavailable/empty."""
    directory = get_data_dir()
    try:
        files = list_csv_files(directory)
    except F1DBDirectoryNotFound as exc:
        pytest.skip(f"F1DB CSVs not available ({exc})")

    if not files:
        pytest.skip(f"No CSV files found in F1DB directory: {directory}")
    return directory
