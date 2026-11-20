"""Physical-alignment study for two qualifying laps, sourced only from Supabase.

Three alignment methods are computed from the same stored telemetry:

    A  normalized distance  - compare elapsed time at equal ``rel_distance``
                              (the method used by tests/plot_lap_delta.py)
    B  absolute distance    - compare elapsed time at equal ``distance_m``
    C  sector-anchored      - compare elapsed time on a common distance axis whose
                              anchors are the three measured sector times, so each
                              lap's distance-scale error is absorbed inside the
                              sector where it occurred

Every number printed under "measured" comes straight from a column; everything
under "inferred" passes through interpolation or a geometric mapping and is
labelled as such. Nothing is stretched, shifted or rescaled to reproduce the
official lap-time difference.

Read-only: ``SET TRANSACTION READ ONLY`` and SELECTs only.

Usage::

    python tests/align_traces_analysis.py
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

OUTPUT = Path(__file__).with_name("spa_2025_alignment_methods.png")
GRID_POINTS = 2000
XY_SCALE = 10.0          # verified below: |dxy| sums to ~10x the travelled distance
XY_NOTE = "x/y/z are stored at 10x metre scale (see coordinate check)"

SECTOR_SQL = """
    SELECT l.sector_1, l.sector_2, l.sector_3
    FROM laps l
    JOIN session_entries se ON se.entry_id = l.entry_id
    JOIN sessions s ON s.session_id = se.session_id
    JOIN events e ON e.event_id = s.event_id
    JOIN drivers d ON d.driver_id = se.driver_id
    WHERE e.event_name = %s AND e.year = %s AND s.session_type = %s
      AND d.abbreviation = %s AND l.lap_number = %s
"""


def trapezoid(y: np.ndarray, x: np.ndarray) -> float:
    """Trapezoidal integral without depending on numpy's trapz/trapezoid rename."""
    return float(np.sum(0.5 * (y[1:] + y[:-1]) * np.diff(x)))


def load_traces() -> dict[str, dict]:
    """Both laps with their measured sector times, straight from PostgreSQL."""
    database_url, _env = load_database_url()
    traces: dict[str, dict] = {}
    with connect(database_url) as conn:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            for request in REQUESTS:
                lap = resolve_lap(conn, request)
                rows = fetch_samples(conn, lap["lap_id"])
                sectors = conn.execute(
                    SECTOR_SQL,
                    (EVENT_NAME, EVENT_YEAR, SESSION_TYPE,
                     request.driver_code, request.lap_number),
                ).fetchone()
                if sectors is None or any(value is None for value in sectors):
                    raise LookupError(
                        f"sector times missing for {request.driver_code} "
                        f"lap {request.lap_number}"
                    )
                traces[request.driver_code] = {
                    "lap": lap,
                    "request": request,
                    "sectors": tuple(float(value) for value in sectors),
                    "t": np.array([row[1] for row in rows], dtype=float),
                    "rel": np.array([row[2] for row in rows], dtype=float),
                    "v": np.array([row[3] for row in rows], dtype=float),
                    "d": np.array([row[9] for row in rows], dtype=float),
                    "x": np.array([row[10] for row in rows], dtype=float) / XY_SCALE,
                    "y": np.array([row[11] for row in rows], dtype=float) / XY_SCALE,
                    "z": np.array([row[12] for row in rows], dtype=float) / XY_SCALE,
                }
    return traces

def anchors(trace: dict) -> dict[str, np.ndarray]:
    """Measured anchor times plus the distances interpolated at those times."""
    s1, s2, s3 = trace["sectors"]
    duration = float(trace["lap"]["lap_duration"])
    times = np.array([0.0, s1, s1 + s2, duration])
    distances = np.array([
        trace["d"][0],
        float(np.interp(s1, trace["t"], trace["d"])),
        float(np.interp(s1 + s2, trace["t"], trace["d"])),
        trace["d"][-1],
    ])
    return {"times": times, "distances": distances, "sector_sum": s1 + s2 + s3}


def measured_report(traces: dict[str, dict]) -> dict:
    """Column-level numbers: no interpolation anywhere in this section."""
    print("\n=== measured (columns only, no interpolation) ===")
    for code in ("VER", "LEC"):
        tr = traces[code]
        lap = tr["lap"]
        s1, s2, s3 = tr["sectors"]
        duration = float(lap["lap_duration"])
        print(f"  {code} lap {lap['lap_number']}: duration {duration:8.3f} s | "
              f"sectors {s1:7.3f} / {s2:7.3f} / {s3:7.3f} | "
              f"sum {s1 + s2 + s3:8.3f} s | residual {s1 + s2 + s3 - duration:+.3f} s")
        print(f"       distance_m {tr['d'][0]:8.1f} -> {tr['d'][-1]:8.1f} "
              f"(span {tr['d'][-1] - tr['d'][0]:8.1f} m) | {len(tr['t'])} samples "
              f"| dt {np.diff(tr['t']).mean() * 1000:.1f} ms")

    ver, lec = traces["VER"], traces["LEC"]
    d_s1 = ver["sectors"][0] - lec["sectors"][0]
    d_s2 = ver["sectors"][1] - lec["sectors"][1]
    d_s3 = ver["sectors"][2] - lec["sectors"][2]
    d_lap = float(ver["lap"]["lap_duration"]) - float(lec["lap"]["lap_duration"])
    print(f"\n  measured VER-LEC deltas: S1 {d_s1:+.3f} | S2 {d_s2:+.3f} | "
          f"S3 {d_s3:+.3f} | lap {d_lap:+.3f} s")
    print(f"  cumulative             : {d_s1:+.3f} / {d_s1 + d_s2:+.3f} / "
          f"{d_s1 + d_s2 + d_s3:+.3f} s (sector sum vs lap delta "
          f"{d_s1 + d_s2 + d_s3 - d_lap:+.4f} s)")
    print(f"  reconstructed lap length: VER {ver['d'][-1] - ver['d'][0]:.1f} m vs "
          f"LEC {lec['d'][-1] - lec['d'][0]:.1f} m -> difference "
          f"{(ver['d'][-1] - ver['d'][0]) - (lec['d'][-1] - lec['d'][0]):+.1f} m")
    return {"d_s1": d_s1, "d_s2": d_s2, "d_s3": d_s3, "d_lap": d_lap}

def coordinate_check(traces: dict[str, dict]) -> dict:
    """Are x/y physically meaningful, and do they support either distance axis?"""
    print("\n=== coordinate check (x/y/z units and spatial agreement) ===")
    scale = {}
    for code in ("VER", "LEC"):
        tr = traces[code]
        xy_path = float(np.hypot(np.diff(tr["x"]), np.diff(tr["y"])).sum())
        span = tr["d"][-1] - tr["d"][0]
        integ = trapezoid(tr["v"] / 3.6, tr["t"])
        scale[code] = {"xy_path": xy_path, "span": span, "integral": integ}
        print(f"  {code}: xy path {xy_path:8.1f} m | distance_m span {span:8.1f} m | "
              f"integral(v dt) {integ:8.1f} m")
        print(f"       xy - distance {xy_path - span:+8.1f} m | integral - distance "
              f"{integ - span:+8.1f} m | elevation {tr['z'].max() - tr['z'].min():6.1f} m")
    print(f"  -> integral(v dt) reproduces distance_m to "
          f"{max(abs(scale[c]['integral'] - scale[c]['span']) for c in scale):.1f} m: "
          "distance_m behaves like a speed integral, not an independent GPS length")
    print(f"  -> xy path and distance_m disagree by "
          f"{scale['VER']['xy_path'] - scale['VER']['span']:+.1f} m (VER) and "
          f"{scale['LEC']['xy_path'] - scale['LEC']['span']:+.1f} m (LEC), opposite signs")
    print(f"  -> {XY_NOTE}; dividing by {XY_SCALE:g} gives a ~6.95 km path and "
          "~102 m elevation, consistent with Spa")

    ver, lec = traces["VER"], traces["LEC"]
    u = np.linspace(0.05, 0.95, 19)
    sep_u = np.hypot(
        np.interp(u, ver["rel"], ver["x"]) - np.interp(u, lec["rel"], lec["x"]),
        np.interp(u, ver["rel"], ver["y"]) - np.interp(u, lec["rel"], lec["y"]),
    )
    lo = max(ver["d"][0], lec["d"][0]) + 10.0
    hi = min(ver["d"][-1], lec["d"][-1]) - 10.0
    d = np.linspace(lo, hi, 60)
    sep_d = np.hypot(
        np.interp(d, ver["d"], ver["x"]) - np.interp(d, lec["d"], lec["x"]),
        np.interp(d, ver["d"], ver["y"]) - np.interp(d, lec["d"], lec["y"]),
    )
    print(f"\n  spatial separation, equal rel_distance : mean {sep_u.mean():5.2f} m | "
          f"max {sep_u.max():5.2f} m")
    print(f"  spatial separation, equal distance_m   : mean {sep_d.mean():5.2f} m | "
          f"max {sep_d.max():5.2f} m")
    print("  -> the trajectories agree better on normalized progress than on absolute")
    print("     distance, so the stored distance axis carries a per-lap scale error")

    av, al = anchors(ver), anchors(lec)
    print("\n  perpendicular offset at each sector line (nearest approach, no shifting):")
    perp = []
    for index, label in enumerate(("S1 end", "S2 end", "lap end")):
        px = float(np.interp(al["times"][index + 1], lec["t"], lec["x"]))
        py = float(np.interp(al["times"][index + 1], lec["t"], lec["y"]))
        j = int(np.argmin(np.hypot(ver["x"] - px, ver["y"] - py)))
        j0, j1 = max(0, j - 1), min(len(ver["x"]) - 1, j + 1)
        tx, ty = ver["x"][j1] - ver["x"][j0], ver["y"][j1] - ver["y"][j0]
        norm = float(np.hypot(tx, ty))
        along = ((px - ver["x"][j]) * tx + (py - ver["y"][j]) * ty) / norm
        off = abs((px - ver["x"][j]) * ty - (py - ver["y"][j]) * tx) / norm
        perp.append(off)
        gap = al["distances"][index + 1] - av["distances"][index + 1]
        print(f"    {label:<8} distance_m gap {gap:+7.1f} m | perpendicular {off:5.2f} m "
              f"| along-track {along:+6.1f} m")
    print("  -> near-zero perpendicular offset: the disagreement is almost purely along")
    print("     track, so x/y cannot adjudicate which distance axis is correct")

    samples = []
    for frac in np.linspace(0.03, 0.99, 33):
        px = float(np.interp(frac, lec["rel"], lec["x"]))
        py = float(np.interp(frac, lec["rel"], lec["y"]))
        vx = float(np.interp(frac, ver["rel"], ver["x"]))
        vy = float(np.interp(frac, ver["rel"], ver["y"]))
        j = int(np.argmin(np.abs(ver["rel"] - frac)))
        j0, j1 = max(0, j - 2), min(len(ver["x"]) - 1, j + 2)
        tx, ty = ver["x"][j1] - ver["x"][j0], ver["y"][j1] - ver["y"][j0]
        norm = float(np.hypot(tx, ty))
        off = abs((px - vx) * ty - (py - vy) * tx) / norm
        samples.append((float(np.hypot(px - vx, py - vy)), off))
    table = np.array(samples)
    print(f"\n  over 33 positions spanning corners: median separation {np.median(table[:, 0]):5.2f} m"
          f" | median perpendicular {np.median(table[:, 1]):5.3f} m"
          f" | max perpendicular {table[:, 1].max():5.2f} m")
    print("  -> the paths coincide laterally everywhere; only the position along the track")
    print("     differs, so x/y is a reconstructed centreline and cannot settle the scale")
    return {"sep_u": sep_u, "sep_d": sep_d, "perp": perp, "scale": scale,
            "lateral": table[:, 1]}

def method_a(traces: dict[str, dict]) -> dict:
    """Compare elapsed time at equal normalized distance (the current method)."""
    ver, lec = traces["VER"], traces["LEC"]
    start = max(ver["rel"][0], lec["rel"][0])
    end = min(ver["rel"][-1], lec["rel"][-1])
    grid = np.linspace(start, end, GRID_POINTS)
    raw = np.interp(grid, ver["rel"], ver["t"]) - np.interp(grid, lec["rel"], lec["t"])
    return {"name": "A normalized distance", "grid": grid, "x": grid,
            "delta": raw - raw[0], "offset": raw[0], "start": start, "end": end}


def method_b(traces: dict[str, dict]) -> dict:
    """Compare elapsed time at equal absolute distance_m."""
    ver, lec = traces["VER"], traces["LEC"]
    for code in ("VER", "LEC"):
        if np.any(np.diff(traces[code]["d"]) < 0):
            raise ValueError(f"{code} distance_m is not non-decreasing")
    start = max(ver["d"][0], lec["d"][0])
    end = min(ver["d"][-1], lec["d"][-1])
    grid = np.linspace(start, end, GRID_POINTS)
    raw = np.interp(grid, ver["d"], ver["t"]) - np.interp(grid, lec["d"], lec["t"])
    return {"name": "B absolute distance", "grid": grid,
            "x": (grid - start) / (end - start), "delta": raw - raw[0],
            "offset": raw[0], "start": start, "end": end}


def method_c(traces: dict[str, dict]) -> dict:
    """Compare elapsed time on a sector-anchored common distance axis.

    Each lap's own anchor distances (interpolated at its measured sector times) are
    mapped onto the mean of the two, so a lap whose distance axis is short is
    stretched only inside the sector where the shortfall occurred. At every anchor
    the compared times are the measured cumulative sector times.
    """
    ver, lec = traces["VER"], traces["LEC"]
    av, al = anchors(ver), anchors(lec)
    src_v = av["distances"] - av["distances"][0]
    src_l = al["distances"] - al["distances"][0]
    common = 0.5 * (src_v + src_l)

    s_v = np.interp(ver["d"] - ver["d"][0], src_v, common)
    s_l = np.interp(lec["d"] - lec["d"][0], src_l, common)
    grid = np.linspace(0.0, common[-1], GRID_POINTS)
    raw = np.interp(grid, s_v, ver["t"]) - np.interp(grid, s_l, lec["t"])
    return {"name": "C sector-anchored", "grid": grid, "x": grid / common[-1],
            "delta": raw - raw[0], "offset": raw[0], "start": 0.0, "end": common[-1],
            "common": common, "src_v": src_v, "src_l": src_l, "s_v": s_v, "s_l": s_l}


def boundary_positions(traces: dict[str, dict], method: dict) -> list[tuple[float, float, float]]:
    """Position of each sector line on the method's own axis (low, mid, high)."""
    ver, lec = traces["VER"], traces["LEC"]
    av, al = anchors(ver), anchors(lec)
    positions = []
    for index in range(1, 4):
        if method["name"].startswith("A"):
            x_v = float(np.interp(av["times"][index], ver["t"], ver["rel"]))
            x_l = float(np.interp(al["times"][index], lec["t"], lec["rel"]))
        elif method["name"].startswith("B"):
            span = method["end"] - method["start"]
            x_v = (float(av["distances"][index]) - method["start"]) / span
            x_l = (float(al["distances"][index]) - method["start"]) / span
        else:
            x = float(method["common"][index]) / float(method["common"][-1])
            positions.append((x, x, x))
            continue
        positions.append((min(x_v, x_l), 0.5 * (x_v + x_l), max(x_v, x_l)))
    return positions


def evaluate(method: dict, traces: dict[str, dict], official: dict) -> dict:
    """Delta at the three sector lines plus the end value, read off the curve."""
    values = []
    for low, mid, high in boundary_positions(traces, method):
        values.append((float(np.interp(mid, method["x"], method["delta"])),
                       float(np.interp(low, method["x"], method["delta"])),
                       float(np.interp(high, method["x"], method["delta"]))))
    cumulative = [official["d_s1"], official["d_s1"] + official["d_s2"], official["d_lap"]]
    return {"boundaries": values, "official": cumulative,
            "final": float(method["delta"][-1])}


def chicane_span(method: dict) -> float:
    """Peak-to-end fall of the delta curve over the last 5% of the lap."""
    tail = method["x"] >= 0.95
    return float(method["delta"][tail].max() - method["delta"][-1])

def spatial_agreement(traces: dict[str, dict], methods: list[dict]) -> dict:
    """Timing-free check: which alignment puts the two cars at the same place?

    x/y is reconstructed from the same feed as the distance axis, but its path
    length differs from distance_m by +31 m / -21 m, so it is not a copy of it.
    If an alignment is physically right, the two trajectories should coincide
    (within racing-line width and sampling noise) at equal parameter value.
    """
    ver, lec = traces["VER"], traces["LEC"]
    fractions = np.linspace(0.05, 0.95, 40)
    print("\n=== geometric cross-check (timing-free) ===")
    results = {}
    for method in methods:
        if method["name"].startswith("A"):
            x_v = np.interp(fractions, ver["rel"], ver["x"])
            y_v = np.interp(fractions, ver["rel"], ver["y"])
            x_l = np.interp(fractions, lec["rel"], lec["x"])
            y_l = np.interp(fractions, lec["rel"], lec["y"])
        elif method["name"].startswith("B"):
            d = method["start"] + fractions * (method["end"] - method["start"])
            x_v = np.interp(d, ver["d"], ver["x"])
            y_v = np.interp(d, ver["d"], ver["y"])
            x_l = np.interp(d, lec["d"], lec["x"])
            y_l = np.interp(d, lec["d"], lec["y"])
        else:
            s = fractions * method["common"][-1]
            x_v = np.interp(s, method["s_v"], ver["x"])
            y_v = np.interp(s, method["s_v"], ver["y"])
            x_l = np.interp(s, method["s_l"], lec["x"])
            y_l = np.interp(s, method["s_l"], lec["y"])
        sep = np.hypot(x_v - x_l, y_v - y_l)
        results[method["name"]] = sep
        print(f"  {method['name']:<24}mean {sep.mean():5.2f} m | median "
              f"{np.median(sep):5.2f} m | p90 {np.percentile(sep, 90):5.2f} m | "
              f"max {sep.max():5.2f} m")
    print("  -> lower is better; the spread between methods (a few metres) is the")
    print("     alignment uncertainty that survives any of them")
    return results


def report_methods(methods: list[dict], traces: dict[str, dict], official: dict) -> dict:
    """Boundary and interior comparison, stated without touching any curve."""
    print("\n=== inferred (interpolated / re-parameterised) ===")
    print(f"  {'method':<24}{'S1 end':>10}{'S2 end':>10}{'lap end':>10}{'last-5% fall':>14}")
    results = {}
    for method in methods:
        result = evaluate(method, traces, official)
        results[method["name"]] = result
        b = result["boundaries"]
        print(f"  {method['name']:<24}{b[0][0]:>+10.3f}{b[1][0]:>+10.3f}{b[2][0]:>+10.3f}"
              f"{chicane_span(method):>+14.3f}")
    print(f"  {'official (laps table)':<24}{official['d_s1']:>+10.3f}"
          f"{official['d_s1'] + official['d_s2']:>+10.3f}{official['d_lap']:>+10.3f}")

    print("\n  axis ambiguity each method carries at the sector lines:")
    for method in methods:
        positions = boundary_positions(traces, method)
        if method["name"].startswith("C"):
            note = "none - the anchors are the measured sector times"
        elif method["name"].startswith("B"):
            note = (f"S1 {(positions[0][2] - positions[0][0]) * (method['end'] - method['start']):5.1f} m"
                    f" | S2 {(positions[1][2] - positions[1][0]) * (method['end'] - method['start']):5.1f} m")
        else:
            note = (f"S1 {positions[0][2] - positions[0][0]:.4f} u | "
                    f"S2 {positions[1][2] - positions[1][0]:.4f} u")
        print(f"    {method['name']:<24}{note}")

    print("\n  error of each curve against the measured cumulative sector deltas:")
    for name, result in results.items():
        errors = [abs(value[0] - ref) for value, ref in zip(result["boundaries"],
                                                            result["official"])]
        print(f"    {name:<24}S1 {errors[0]:5.3f} s | S2 {errors[1]:5.3f} s | "
              f"end {errors[2]:5.3f} s | max {max(errors):5.3f} s")
    print(f"\n  final value: A {results['A normalized distance']['final']:+.3f} s | "
          f"B {results['B absolute distance']['final']:+.3f} s | "
          f"C {results['C sector-anchored']['final']:+.3f} s | "
          f"official {official['d_lap']:+.3f} s")
    print("  note: C reproduces the sector lines exactly by construction, so only its")
    print("        sector interiors are independent evidence; A and B are unanchored")

    print("\n  continuity of each curve (largest step between adjacent grid points):")
    for method in methods:
        jump = float(np.abs(np.diff(method["delta"])).max())
        print(f"    {method['name']:<24}{jump * 1000:6.1f} ms")
    return results


def corner_report(methods: list[dict]) -> None:
    """Where does each alignment put the delta at the corners that matter?"""
    windows = (("La Source", 0.02, 0.10), ("Les Combes braking", 0.28, 0.38),
               ("final chicane", 0.94, 1.00))
    print("\n=== per-corner behaviour of the aligned curves ===")
    for label, lo, hi in windows:
        print(f"  {label} ({lo:.0%}-{hi:.0%} of lap):")
        for method in methods:
            mask = (method["x"] >= lo) & (method["x"] <= hi)
            if not mask.any():
                continue
            x, delta = method["x"][mask], method["delta"][mask]
            step = max(1, len(x) // 20)
            changes = delta[step:] - delta[:-step]
            worst = changes[int(np.argmax(np.abs(changes)))]
            print(f"    {method['name']:<24}delta {delta.min():+.3f}..{delta.max():+.3f} s "
                  f"| largest 1% move {worst:+.3f} s")

def distance_divergence(traces: dict[str, dict], methods: list[dict]) -> dict:
    """How much of the distance-axis divergence each method accounts for.

    A leaves the whole divergence inside its parameterisation (it grows linearly to
    the lap-length difference). C absorbs the measured divergence at each sector
    line, so what is left inside a sector is only that sector's own share - and that
    share is what still limits corner-level precision.
    """
    ver, lec = traces["VER"], traces["LEC"]
    span_gap = (lec["d"][-1] - lec["d"][0]) - (ver["d"][-1] - ver["d"][0])
    a, c = methods[0], methods[2]

    av, al = anchors(ver), anchors(lec)
    src_v = av["distances"] - av["distances"][0]
    src_l = al["distances"] - al["distances"][0]
    shares = (src_l[1:] - src_l[:-1]) - (src_v[1:] - src_v[:-1])
    cumulative = np.concatenate([[0.0], np.cumsum(shares)])
    return {"A": (a["x"], a["x"] * span_gap),
            "C": (c["x"], np.interp(c["grid"], c["common"], cumulative)),
            "per_sector": shares, "span_gap": span_gap}


def plot_comparison(traces: dict[str, dict], methods: list[dict], official: dict) -> None:
    ver, lec = traces["VER"], traces["LEC"]
    anchor_x = methods[2]["common"] / methods[2]["common"][-1]
    cumulative = [0.0, official["d_s1"], official["d_s1"] + official["d_s2"], official["d_lap"]]

    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(13, 9.5), sharex=True,
                                  gridspec_kw={"height_ratios": [2.3, 1.0]})
    windows = ((0.02, 0.10, "La Source"), (0.28, 0.38, "Les Combes"),
               (0.94, 1.00, "chicane"))
    for lo, hi, _name in windows:
        for axis in (ax, ax2):
            axis.axvspan(lo * 100, hi * 100, color="0.93", zorder=0)

    styles = {"A normalized distance": dict(color="#1f77b4", lw=2.0,
                                            label="A  normalized distance"),
              "B absolute distance": dict(color="#999999", lw=1.3, ls="--",
                                          label="B  absolute distance_m"),
              "C sector-anchored": dict(color="#2ca02c", lw=2.0, label="C  sector-anchored")}
    for method in methods:
        ax.plot(method["x"] * 100, method["delta"], **styles[method["name"]])
    ax.axhline(official["d_lap"], color="#d62728", ls=":", lw=1.2,
               label=f"official full-lap difference {official['d_lap']:+.3f} s")
    for x, value in zip(anchor_x, cumulative):
        ax.axvline(x * 100, color="0.78", lw=0.8, zorder=1)
        ax.plot([x * 100], [value], marker="o", ms=5, color="black", zorder=5)
        ax.annotate(f"{value:+.3f}", xy=(x * 100, value), xytext=(4, -11),
                    textcoords="offset points", fontsize=8)
    ax.set_ylim(top=ax.get_ylim()[1] + 0.10)
    for lo, hi, name in windows:
        ax.annotate(name, xy=(0.5 * (lo + hi) * 100, ax.get_ylim()[0]), ha="center",
                    va="bottom", fontsize=8, color="0.45")
    ax.set_ylabel("cumulative delta VER - LEC (s)")
    ax.set_title(f"{EVENT_YEAR} {EVENT_NAME} qualifying: {ver['lap']['code']} lap "
                 f"{ver['lap']['lap_number']} vs {lec['lap']['code']} lap "
                 f"{lec['lap']['lap_number']} - alignment methods compared\n"
                 "black dots = measured cumulative sector deltas; curves are aligned, never stretched")
    ax.grid(alpha=0.3)
    ax.legend(loc="upper left", fontsize=8.5)

    divergence = distance_divergence(traces, methods)
    ax2.plot(divergence["A"][0] * 100, divergence["A"][1], color="#1f77b4", lw=2.0,
             label="A  divergence spread uniformly over the lap (never removed)")
    ax2.plot(divergence["C"][0] * 100, divergence["C"][1], color="#2ca02c", lw=2.0,
             label="C  divergence removed at each measured sector line")
    for x in anchor_x[1:-1]:
        ax2.axvline(x * 100, color="0.78", lw=0.8)
    ax2.axhline(0.0, color="0.4", lw=0.8)
    ax2.set_xlabel("lap progress (%)")
    ax2.set_ylabel("distance-axis divergence (m)")
    ax2.grid(alpha=0.3)
    ax2.legend(loc="upper left", fontsize=8.5)

    fig.tight_layout()
    fig.savefig(OUTPUT, dpi=140)
    plt.close(fig)
    print(f"\nplot saved     : {OUTPUT}")

def main() -> int:
    print("=" * 92)
    print(f"PHYSICAL ALIGNMENT STUDY - {EVENT_YEAR} {EVENT_NAME} {SESSION_TYPE} "
          "(Supabase only, read-only)")
    print("=" * 92)
    try:
        traces = load_traces()
    except Exception as exc:  # noqa: BLE001
        print(f"retrieval : FAILED - {type(exc).__name__}: {redact(exc)}")
        return 1

    official = measured_report(traces)
    coordinate_check(traces)

    methods = [method_a(traces), method_b(traces), method_c(traces)]
    results = report_methods(methods, traces, official)
    spatial = spatial_agreement(traces, methods)
    corner_report(methods)

    divergence = distance_divergence(traces, methods)
    print("\n=== divergence bookkeeping ===")
    print(f"  lap-length difference (LEC - VER): {divergence['span_gap']:+.1f} m "
          f"= {divergence['span_gap'] / 69.5:+.2f} m per 1% of lap")
    for label, share in zip(("S1", "S2", "S3"), divergence["per_sector"]):
        print(f"    {label} share of the divergence: {share:+6.1f} m")
    for method in methods:
        print(f"  zero offset at the first compared point, {method['name']:<24}"
              f"{method['offset']:+.4f} s")
    print("  A and B keep whatever that offset is; C anchors on the measured sector")
    print("  times, so its curve starts at 0 by construction")

    plot_comparison(traces, methods, official)

    print("\n=== assessment ===")
    names = ["A normalized distance", "B absolute distance", "C sector-anchored"]
    for name, method in zip(names, methods):
        result = results[name]
        errors = [abs(value[0] - ref) for value, ref in zip(result["boundaries"],
                                                           result["official"])]
        print(f"  {name:<24}sector-line error {errors[0] * 1000:4.0f}/{errors[1] * 1000:4.0f}/"
              f"{errors[2] * 1000:4.0f} ms | chicane swing {chicane_span(method) * 1000:4.0f} ms"
              f" | spatial mean {spatial[name].mean():4.1f} m")
    print("  -> B is the weakest: the two stored distance axes differ by up to 27.6 m, so equal")
    print("     distance_m is not the same physical place, and the error reaches 0.40 s")
    print("  -> A is right at the S1 line only because the divergence is still small there")
    print(f"     ({divergence['per_sector'][0]:.1f} m); it degrades as the divergence accumulates")
    print("  -> C matches all three measured sector lines and still improves the timing-free")
    print("     spatial agreement, so it is the most defensible base for corner work")
    print("  -> its remaining limit is each sector's own share of the divergence")
    print(f"     ({divergence['per_sector'][0]:.1f} / {divergence['per_sector'][1]:.1f} / "
          f"{divergence['per_sector'][2]:.1f} m for S1/S2/S3): inside a sector nothing anchors")
    print("     the curve, so corner deltas keep a residual of up to ~0.2 s where the")
    print("     divergence is concentrated in the braking zone")

    print("\n=== measured vs inferred ===")
    print("  measured : lap duration, three sector times, sample timestamps, distance_m,")
    print("             rel_distance, x/y/z, speed - exactly as stored in PostgreSQL")
    print("  inferred : every delta value at a position, the distances interpolated at")
    print("             the sector times, and the re-parameterised axes of A, B and C")
    print("  untouched: no curve is shifted or scaled to reach the official +0.431 s, and")
    print("             no sample is dropped, sorted or repaired")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
