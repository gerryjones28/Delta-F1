"""Regression tests for the importer's post-write verification scope.

The bug: verification compared session-wide stored counts with a plan that had
been filtered by ``--lap-id``, so every targeted run reported MISMATCH (exit 3)
even though the rows were correct. These tests pin the scoped comparison without
touching a database.
"""

from __future__ import annotations

from src.load.telemetry_importer import compare_planned_laps, planned_lap_samples


def make_plan(*entries: tuple[str, int, int]) -> list[dict]:
    """Build a minimal plan: (driver code, lap number, samples) triples."""
    items: dict[str, dict] = {}
    for code, lap_number, samples in entries:
        item = items.setdefault(code, {
            "identity": {"code": code},
            "laps": [],
            "eligible": [],
            "skips": [],
            "corrections": [],
            "samples": 0,
        })
        item["eligible"].append(({"lap_number": lap_number}, samples))
        item["samples"] += samples
    return list(items.values())


def test_planned_lap_samples_is_keyed_by_driver_and_lap() -> None:
    plan = make_plan(("VER", 2, 745), ("VER", 5, 774), ("LEC", 4, 751))

    assert planned_lap_samples(plan) == {
        ("VER", 2): 745,
        ("VER", 5): 774,
        ("LEC", 4): 751,
    }


def test_filtered_plan_ignores_laps_outside_its_scope() -> None:
    """A --lap-id run must not be compared with the whole session."""
    expected = {("VER", 2): 745}
    session_wide = {("VER", 2): 745, ("VER", 5): 774, ("LEC", 4): 751}

    assert compare_planned_laps(expected, session_wide) == []


def test_missing_lap_is_reported() -> None:
    assert compare_planned_laps({("VER", 2): 745}, {}) == [
        "VER lap 2: stored 0 != planned 745"
    ]


def test_short_lap_is_reported() -> None:
    problems = compare_planned_laps({("VER", 2): 745}, {("VER", 2): 700})

    assert len(problems) == 1
    assert "stored 700 != planned 745" in problems[0]


def test_extra_rows_on_a_planned_lap_are_reported() -> None:
    problems = compare_planned_laps({("VER", 2): 745}, {("VER", 2): 746})

    assert len(problems) == 1
    assert "stored 746 != planned 745" in problems[0]


def test_full_session_plan_still_checks_every_lap() -> None:
    expected = {("VER", 2): 745, ("VER", 5): 774}
    stored = {("VER", 2): 745}

    assert compare_planned_laps(expected, stored) == ["VER lap 5: stored 0 != planned 774"]
