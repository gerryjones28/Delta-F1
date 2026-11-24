"""Verified F1DB <-> OpenF1 circuit-name aliases for the 2025 season.

Both loaders compare circuit names as a guard against attaching the wrong timing
source to a race. The two sources disagree on four 2025 circuits, so the guard
would refuse those events. Each mapping below was verified independently:

    F1DB circuitId   OpenF1 circuit_short_name   race / session / meeting
    bahrain          Sakhir                      1129 / 10010 / 1257
    monaco           Monte Carlo                 1133 /  9975 / 1261
    marina-bay       Singapore                   1143 /  9892 / 1270
    yas-marina       Yas Marina Circuit          1149 /  9835 / 1276

In every case the race date has exactly one OpenF1 Qualifying session within four
days and the countries agree, so the pairing is unambiguous. Nothing else is
aliased: an unlisted mismatch still fails the guard.
"""

from __future__ import annotations

import re

__all__ = ["CIRCUIT_ALIASES", "circuit_matches"]

# Keys and values are stored normalised (lower case, punctuation removed).
CIRCUIT_ALIASES = {
    "bahrain": "sakhir",
    "monaco": "montecarlo",
    "marinabay": "singapore",
    "yasmarina": "yasmarinacircuit",
}


def _normalise(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def circuit_matches(f1db_circuit: object, openf1_circuit: object) -> bool:
    """True when both sources name the same circuit, allowing the verified aliases."""
    left, right = _normalise(f1db_circuit), _normalise(openf1_circuit)
    return left == right or CIRCUIT_ALIASES.get(left) == right
