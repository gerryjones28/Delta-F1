"""Tests for the F1DB CSV loader.

Most tests build small temporary CSVs so they always run; the marked integration
test uses whatever F1DB export is configured locally and skips otherwise.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.extract.f1db_csv_loader import (
    F1DBDirectoryNotFound,
    F1DBFileNotFound,
    get_data_dir,
    list_csv_files,
    load_csv,
    resolve_csv_path,
)
from src.paths import PROJECT_ROOT


def write_csv(directory: Path, name: str, text: str) -> Path:
    path = directory / name
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Configuration / path resolution (offline)
# ---------------------------------------------------------------------------
def test_default_data_dir_is_inside_the_project() -> None:
    directory = get_data_dir()

    assert directory == PROJECT_ROOT / "data" / "raw" / "f1db"


def test_relative_data_dir_resolves_from_project_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("F1DB_DATA_DIR", "data/samples")

    assert get_data_dir() == PROJECT_ROOT / "data" / "samples"


def test_absolute_data_dir_is_used_as_is(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("F1DB_DATA_DIR", str(tmp_path))

    assert get_data_dir() == tmp_path


def test_explicit_argument_overrides_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("F1DB_DATA_DIR", str(tmp_path / "from_env"))

    assert get_data_dir(tmp_path) == tmp_path


# ---------------------------------------------------------------------------
# Reading CSVs (offline, temporary files)
# ---------------------------------------------------------------------------
def test_list_csv_files_returns_sorted_csv_only(tmp_path: Path) -> None:
    write_csv(tmp_path, "b_table.csv", "id,name\n2,second\n")
    write_csv(tmp_path, "a_table.csv", "id,name\n1,first\n")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")

    assert [p.name for p in list_csv_files(tmp_path)] == ["a_table.csv", "b_table.csv"]


def test_load_csv_reads_columns_and_rows(tmp_path: Path) -> None:
    write_csv(tmp_path, "seasons.csv", "year,champion\n2024,Verstappen\n2023,Verstappen\n")

    frame = load_csv("seasons.csv", data_dir=tmp_path)

    assert list(frame.columns) == ["year", "champion"]
    assert len(frame) == 2
    assert frame.loc[0, "champion"] == "Verstappen"


def test_load_csv_accepts_name_without_extension(tmp_path: Path) -> None:
    write_csv(tmp_path, "circuits.csv", "id,name\n1,Spa\n")

    assert resolve_csv_path("circuits", tmp_path).name == "circuits.csv"
    assert len(load_csv("circuits", data_dir=tmp_path)) == 1


def test_load_csv_forwards_read_csv_kwargs(tmp_path: Path) -> None:
    write_csv(tmp_path, "wide.csv", "a,b,c\n1,2,3\n")

    frame = load_csv("wide.csv", data_dir=tmp_path, usecols=["a", "c"])

    assert list(frame.columns) == ["a", "c"]


def test_missing_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(F1DBDirectoryNotFound):
        list_csv_files(tmp_path / "does-not-exist")


def test_missing_file_raises(tmp_path: Path) -> None:
    write_csv(tmp_path, "races.csv", "id,year\n1,2024\n")

    with pytest.raises(F1DBFileNotFound, match="drivers.csv"):
        load_csv("drivers.csv", data_dir=tmp_path)


# ---------------------------------------------------------------------------
# Configured local F1DB export (skipped when absent)
# ---------------------------------------------------------------------------
@pytest.mark.integration
def test_configured_f1db_directory_can_be_read(f1db_dir: Path) -> None:
    files = list_csv_files(f1db_dir)
    assert files, "expected at least one CSV file"

    smallest = min(files, key=lambda path: path.stat().st_size)
    frame = load_csv(smallest.name, data_dir=f1db_dir)

    assert list(frame.columns), f"{smallest.name} produced a DataFrame without columns"
