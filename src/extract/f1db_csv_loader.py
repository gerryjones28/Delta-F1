"""Read F1DB CSV exports from a local directory.

F1DB (https://github.com/f1db/f1db) publishes historical Formula 1 data as CSV
files. This module deliberately does **not** download anything and does not know
which files matter for DeltaTrace: it only lists and loads CSVs from a directory
you provide.

Directory resolution order for every function:

1. the ``data_dir`` argument,
2. the ``F1DB_DATA_DIR`` environment variable (or ``.env``),
3. the default ``data/raw/f1db`` inside the project.

Relative paths are resolved from the project root, not from the current working
directory, so scripts behave the same wherever they are started from.

Example::

    from src.extract.f1db_csv_loader import list_csv_files, load_csv

    print([p.name for p in list_csv_files()])
    races = load_csv("races")          # -> pandas.DataFrame
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pandas as pd
from dotenv import load_dotenv

from src.paths import PROJECT_ROOT, RAW_DATA_DIR

DEFAULT_DATA_DIR = RAW_DATA_DIR / "f1db"


class F1DBError(RuntimeError):
    """Base error for F1DB CSV access problems."""


class F1DBDirectoryNotFound(F1DBError):
    """Raised when the configured F1DB directory does not exist."""


class F1DBFileNotFound(F1DBError):
    """Raised when a requested CSV file is not present in the directory."""


def get_data_dir(data_dir: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the F1DB CSV directory without checking that it exists."""
    load_dotenv(PROJECT_ROOT / ".env")

    candidate = data_dir or os.getenv("F1DB_DATA_DIR") or DEFAULT_DATA_DIR
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path


def list_csv_files(data_dir: str | os.PathLike[str] | None = None) -> list[Path]:
    """Return the ``*.csv`` files in the directory, sorted by name.

    Raises:
        F1DBDirectoryNotFound: the directory is missing, so pointing the loader
            at the wrong place fails loudly instead of returning ``[]``.
    """
    directory = get_data_dir(data_dir)
    if not directory.is_dir():
        raise F1DBDirectoryNotFound(
            f"F1DB CSV directory not found: {directory}\n"
            "Set F1DB_DATA_DIR in .env or pass data_dir=... explicitly. "
            "A local clone/export of https://github.com/f1db/f1db is required; "
            "this project does not download it automatically."
        )
    return sorted(path for path in directory.glob("*.csv") if path.is_file())


def resolve_csv_path(
    filename: str | os.PathLike[str],
    data_dir: str | os.PathLike[str] | None = None,
) -> Path:
    """Return the full path of one CSV file, accepting an optional ``.csv`` suffix."""
    directory = get_data_dir(data_dir)
    name = Path(filename).name
    if not name.lower().endswith(".csv"):
        name = f"{name}.csv"

    path = directory / name
    if not path.is_file():
        raise F1DBFileNotFound(
            f"F1DB CSV file not found: {path}\n"
            f"Available files: {[p.name for p in list_csv_files(directory)] or 'none'}"
        )
    return path


def load_csv(
    filename: str | os.PathLike[str],
    data_dir: str | os.PathLike[str] | None = None,
    **read_csv_kwargs: Any,
) -> pd.DataFrame:
    """Load one F1DB CSV file into a DataFrame.

    ``read_csv_kwargs`` are forwarded to :func:`pandas.read_csv`, so callers can
    override dtypes, the separator, ``usecols`` and so on.
    """
    path = resolve_csv_path(filename, data_dir)
    options: dict[str, Any] = {
        "encoding": "utf-8-sig",  # tolerates a UTF-8 BOM if the export has one
        "low_memory": False,
    }
    options.update(read_csv_kwargs)
    try:
        return pd.read_csv(path, **options)
    except (OSError, pd.errors.ParserError) as exc:
        raise F1DBError(f"Could not read F1DB CSV file {path}: {exc}") from exc


__all__ = [
    "DEFAULT_DATA_DIR",
    "F1DBError",
    "F1DBDirectoryNotFound",
    "F1DBFileNotFound",
    "get_data_dir",
    "list_csv_files",
    "resolve_csv_path",
    "load_csv",
]
