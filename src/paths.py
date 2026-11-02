"""Shared project paths.

Kept intentionally tiny: this module only answers "where is the project root?".
It makes no decisions about database structure.
"""

from __future__ import annotations

from pathlib import Path

# src/paths.py -> src -> <project root>
PROJECT_ROOT = Path(__file__).resolve().parents[1]

SRC_DIR = PROJECT_ROOT / "src"
SQL_DIR = PROJECT_ROOT / "sql"
TESTS_DIR = PROJECT_ROOT / "tests"
DOCS_DIR = PROJECT_ROOT / "docs"
DATA_DIR = PROJECT_ROOT / "data"
RAW_DATA_DIR = DATA_DIR / "raw"
SAMPLE_DATA_DIR = DATA_DIR / "samples"

__all__ = [
    "PROJECT_ROOT",
    "SRC_DIR",
    "SQL_DIR",
    "TESTS_DIR",
    "DOCS_DIR",
    "DATA_DIR",
    "RAW_DATA_DIR",
    "SAMPLE_DATA_DIR",
]
