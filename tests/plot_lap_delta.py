"""Cumulative lap-time delta between two laps, computed only from Supabase.

Reuses the retrieval module (`tests/fetch_lap_telemetry.py`); no local
TracingInsights JSON is read. Each driver's elapsed-time channel is interpolated
onto the shared normalized-distance overlap and differenced as

    delta(u) = VER elapsed time at u  -  LEC elapsed time at u

so a **positive** value means Verstappen has used more time to reach that
position, i.e. Leclerc is ahead.

Nothing is extrapolated past either trace, and the curve is never forced to end
at the official full-lap difference.

Usage::

    python tests/plot_lap_delta.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests"))

from src.load.telemetry_importer import connect, load_database_url, redact
from fetch_lap_telemetry import EVENT_NAME, EVENT_YEAR, REQUESTS, SESSION_TYPE, fetch_samples, resolve_lap

OUTPUT = Path(__file__).with_name("spa_2025_ver_lec_cumulative_delta.png")
GRID_POINTS = 2000
MONOTONIC_TOLERANCE = 1e-5   # allowed backward wobble before we refuse to interpolate
OFFICIAL_FULL_LAP_DELTA = 0.431


def load_traces() -> dict[str, dict]:
    """Full telemetry for every requested lap, straight from PostgreSQL."""
    database_url, _env = load_database_url()
    traces: dict[str, dict] = {}
    with connect(database_url) as conn:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            for request in REQUESTS:
                lap = resolve_lap(conn, request)
                rows = fetch_samples(conn, lap["lap_id"])
                traces[request.driver_code] = {
                    "lap": lap,
                    "request": request,
                    "rel": np.array([row[2] for row in rows], dtype=float),
                    "time": np.array([row[1] for row in rows], dtype=float),
                    "speed": np.array([row[3] for row in rows], dtype=float),
                }
    return traces


def validate_trace(code: str, rel: np.ndarray, times: np.ndarray) -> list[str]:
    """Finiteness, range and monotonicity - reported, never silently repaired."""
    problems = []
    if not np.all(np.isfinite(rel)):
        problems.append(f"{code}: {int((~np.isfinite(rel)).sum())} non-finite rel_distance value(s)")
    if not np.all(np.isfinite(times)):
        problems.append(f"{code}: {int((~np.isfinite(times)).sum())} non-finite elapsed_s value(s)")
    if np.any(rel < 0) or np.any(rel > 1):
        problems.append(f"{code}: rel_distance outside [0, 1]")

    steps = np.diff(rel)
    if steps.size and steps.min() < -MONOTONIC_TOLERANCE:
        problems.append(
            f"{code}: {int((steps < -MONOTONIC_TOLERANCE).sum())} backward rel_distance "
            f"step(s), worst {steps.min():.3e}"
        )
    elif steps.size and steps.min() < 0:
        print(f"  note: {code} has a backward rel_distance step of {steps.min():.2e} "
              f"(within the {MONOTONIC_TOLERANCE:g} tolerance, kept as-is)")

    if np.any(np.diff(times) <= 0):
        problems.append(f"{code}: elapsed_s is not strictly increasing")

    return problems


def interpolate_delta(traces: dict[str, dict]) -> dict:
    """Interpolate both elapsed-time traces onto the shared distance overlap."""
    ver, lec = traces["VER"], traces["LEC"]
    start = max(float(ver["rel"][0]), float(lec["rel"][0]))
    end = min(float(ver["rel"][-1]), float(lec["rel"][-1]))
    if end <= start:
        raise RuntimeError("the two traces share no overlapping distance range")

    grid = np.linspace(start, end, GRID_POINTS)
    time_ver = np.interp(grid, ver["rel"], ver["time"])
    time_lec = np.interp(grid, lec["rel"], lec["time"])
    raw = time_ver - time_lec          # positive => Verstappen has used more time
    return {
        "grid": grid,
        "time_ver": time_ver,
        "time_lec": time_lec,
        "raw": raw,
        "offset": float(raw[0]),       # sampling offset at the first shared position
        "start": start,
        "end": end,
    }


def artifact_report(grid: np.ndarray, delta: np.ndarray) -> tuple[list[str], int, float]:
    """Describe suspicious regions instead of smoothing them away."""
    findings: list[str] = []
    peak_index = int(np.argmax(delta))
    peak = float(delta[peak_index])
    if peak_index < len(delta) - 2:
        drop = peak - float(delta[peak_index:].min())
        if drop > 0.1:
            findings.append(
                f"delta peaks at {peak:+.3f} s at {grid[peak_index] * 100:.2f}% and then falls "
                f"{drop:.3f} s by {grid[-1] * 100:.2f}% - the shape of the final-chicane "
                f"alignment artefact, not a change of pace"
            )

    gradient = np.gradient(delta, grid)
    steepest = int(np.argmax(np.abs(gradient)))
    findings.append(
        f"steepest local gradient {gradient[steepest]:+.1f} s per unit rel_distance at "
        f"{grid[steepest] * 100:.2f}% (1% of lap = {abs(gradient[steepest]) * 0.01:.3f} s)"
    )

    window = max(1, len(grid) // 100)
    changes = delta[window:] - delta[:-window]
    span = window / len(grid) * 100.0
    rise = int(np.argmax(changes))
    fall = int(np.argmin(changes))
    findings.append(
        f"largest rise {changes[rise]:+.3f} s per {span:.0f}% of lap around "
        f"{grid[rise] * 100:.2f}%"
    )
    findings.append(
        f"largest fall {changes[fall]:+.3f} s per {span:.0f}% of lap around "
        f"{grid[fall] * 100:.2f}%"
    )
    return findings, peak_index, peak


def plot_result(result: dict, peak_index: int) -> None:
    grid = result["grid"]
    delta = result["raw"] - result["offset"]

    figure, axis = plt.subplots(figsize=(11, 5.5))
    axis.plot(grid * 100, delta, lw=1.8, color="C0", label="VER - LEC cumulative delta")
    axis.axhline(0.0, color="0.4", lw=0.9)
    axis.axhline(OFFICIAL_FULL_LAP_DELTA, color="C3", ls="--", lw=1.0,
                 label=f"official full-lap difference +{OFFICIAL_FULL_LAP_DELTA:.3f} s")

    axis.plot([grid[-1] * 100], [delta[-1]], "o", color="C0")
    axis.annotate(f"last shared position {delta[-1]:+.3f} s",
                  (grid[-1] * 100, delta[-1]), xytext=(-10, -26),
                  textcoords="offset points", ha="right", fontsize=9)
    axis.plot([grid[peak_index] * 100], [delta[peak_index]], "o", color="C1")
    axis.annotate(f"peak {delta[peak_index]:+.3f} s",
                  (grid[peak_index] * 100, delta[peak_index]), xytext=(-10, 10),
                  textcoords="offset points", ha="right", fontsize=9, color="C1")

    axis.set_xlabel("lap progress (% of normalized lap distance)")
    axis.set_ylabel("cumulative delta VER - LEC (s)")
    axis.set_title("2025 Belgian GP qualifying: Verstappen lap 2 vs Leclerc lap 4\n"
                   "telemetry retrieved from Supabase")
    axis.grid(alpha=0.3)
    axis.legend(loc="upper left", fontsize=9)
    figure.tight_layout()
    figure.savefig(OUTPUT, dpi=140)
    print(f"\nplot saved     : {OUTPUT}")
    if plt.get_backend().lower() != "agg":
        plt.show()


def main() -> int:
    print("=" * 84)
    print(f"CUMULATIVE LAP DELTA - {EVENT_YEAR} {EVENT_NAME} {SESSION_TYPE} (Supabase only)")
    print("=" * 84)
    print("sign convention: delta = VER elapsed time - LEC elapsed time; "
          "positive => Leclerc is ahead")

    try:
        traces = load_traces()
    except Exception as exc:  # noqa: BLE001
        print(f"retrieval : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1

    print("\ntraces:")
    problems: list[str] = []
    for code in ("VER", "LEC"):
        trace = traces[code]
        lap = trace["lap"]
        print(f"  {code}: lap {lap['lap_number']}, {lap['lap_duration']:.3f} s, "
              f"{len(trace['rel'])} samples, rel {trace['rel'][0]:.6f}..{trace['rel'][-1]:.6f}, "
              f"t {trace['time'][0]:.3f}..{trace['time'][-1]:.3f} s")
        problems += validate_trace(code, trace["rel"], trace["time"])

    print("\nvalidation:")
    if problems:
        for problem in problems:
            print(f"  ! {problem}")
        print("\nRESULT: refusing to interpolate - the traces are not safe to align")
        return 1
    print("  rel_distance finite, inside [0, 1] and monotonic within tolerance; "
          "elapsed_s strictly increasing")

    result = interpolate_delta(traces)
    delta = result["raw"] - result["offset"]
    findings, peak_index, peak = artifact_report(result["grid"], delta)

    print("\nshared overlap:")
    print(f"  normalized distance : {result['start']:.6f} .. {result['end']:.6f} "
          f"({result['start'] * 100:.2f}% .. {result['end'] * 100:.2f}% of the lap)")
    print(f"  VER lap duration    : {traces['VER']['lap']['lap_duration']:.3f} s")
    print(f"  LEC lap duration    : {traces['LEC']['lap']['lap_duration']:.3f} s")
    print(f"  offset at first shared position : {result['offset']:+.4f} s "
          "(sampling offset, removed from the plotted curve)")

    print("\nresult:")
    print(f"  final interpolated delta at {result['end'] * 100:.2f}% : {delta[-1]:+.3f} s "
          f"(raw {result['raw'][-1]:+.3f} s)")
    print(f"  official full-lap difference            : +{OFFICIAL_FULL_LAP_DELTA:.3f} s")
    print(f"  gap to the official figure (not forced) : "
          f"{delta[-1] - OFFICIAL_FULL_LAP_DELTA:+.3f} s")
    print(f"  peak delta {peak:+.3f} s at {result['grid'][peak_index] * 100:.2f}%")
    trough = int(np.argmin(delta))
    print(f"  minimum delta {delta[trough]:+.3f} s at {result['grid'][trough] * 100:.2f}%")

    print("\nartefact scan (reported, not smoothed):")
    for finding in findings:
        print(f"  - {finding}")

    remaining = (1.0 - result["end"]) * 100
    print("\nwhy the final delta is not the official +0.431 s:")
    print(f"  - the shared overlap ends at {result['end'] * 100:.2f}% of the lap, so the final "
          f"{remaining:.2f}% is outside")
    print("    the common range of both traces and is never compared")
    print("  - rel_distance is normalized per driver (each by its own reconstructed lap length),")
    print("    so equal relative distance is not exactly the same physical position")
    print("  - nothing is extrapolated, shifted or rescaled to close the gap")

    plot_result(result, peak_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


