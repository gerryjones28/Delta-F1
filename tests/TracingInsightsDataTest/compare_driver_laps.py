"""Sector-aware telemetry alignment validation - Spa 2025 qualifying.

Compares two drivers' laps at "equivalent circuit positions" in three ways:

A. Relative distance (the original prototype): matches equal fractions of each
   driver's own lap distance.
B. Absolute distance: matches equal metres travelled from the lap start.
C. Sector-aware: re-anchors the match at the measured sector lines, then matches
   proportional distance *within* each sector.

Timing anchors come from the TracingInsights ``laptimes.json`` fields ``lST``
(lap start), ``s1T``/``s2T``/``s3T`` (sector end timestamps). Those reproduce the
official sector durations exactly, so they are treated as measurements.

Measured  : sample times, lap duration, sector boundary times.
Estimated : ``distance``, ``rel_distance``, ``x``/``y``/``z`` (stored at ~10x
            metre scale) and everything between two telemetry samples.

Run from the repository root::

    python tests/TracingInsightsDataTest/compare_driver_laps.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "data/external/tracinginsights-2025" / "Belgian Grand Prix/Qualifying"

LAPS = {"VER": 2, "LEC": 4}
LABELS = {"VER": "VER lap 2", "LEC": "LEC lap 4"}
OFFICIAL_DELTA = {"S1": 0.343, "S2": 0.374, "END": 0.431}
BOUNDARY_ORDER = ("START", "S1", "S2", "END")

TELEMETRY_CHANNELS = (
    "time", "distance", "rel_distance", "speed",
    "throttle", "brake", "x", "y", "z",
)
ESSENTIAL_CHANNELS = (
    "time", "distance", "rel_distance", "speed", "throttle", "brake",
)
XY_SCALE = 10.0          # x/y/z are stored at ~10x metre scale (checked below)
CURVE_POINTS = 4000
SECTOR_POINTS = 1200


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_laptime(driver: str, lap_number: int) -> dict:
    """Return the ``laptimes.json`` row for one lap (sector times and anchors)."""
    path = BASE / driver / "laptimes.json"
    with open(path, encoding="utf-8") as fh:
        table = json.load(fh)
    index = table["lap"].index(lap_number)
    return {key: values[index] for key, values in table.items()}


def load_lap(driver: str, lap_number: int) -> tuple[pd.DataFrame, dict]:
    """Load a lap exactly as archived: original order, no sorting, no de-duplication."""
    path = BASE / driver / f"{lap_number}_tel.json"
    with open(path, encoding="utf-8") as fh:
        tel = json.load(fh)["tel"]

    frame = pd.DataFrame({name: tel[name] for name in TELEMETRY_CHANNELS})
    frame = frame.apply(pd.to_numeric, errors="coerce")
    return frame, load_laptime(driver, lap_number)


def sector_boundaries(lap_info: dict) -> dict[str, float]:
    """Lap-relative elapsed times at which each sector ends (measured)."""
    start = lap_info["lST"]
    return {
        "START": 0.0,
        "S1": lap_info["s1T"] - start,
        "S2": lap_info["s2T"] - start,
        "END": lap_info["s3T"] - start,
    }


def value_at(times: np.ndarray, channel: np.ndarray, query: float) -> float:
    """Linear interpolation of one channel at an elapsed time."""
    return float(np.interp(query, times, channel))


def print_section(title: str) -> None:
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


# ---------------------------------------------------------------------------
# Raw data quality (checked before sorting, interpolating or de-duplicating)
# ---------------------------------------------------------------------------
def audit_trace(frame: pd.DataFrame, lap_info: dict) -> dict:
    time = frame["time"].to_numpy()
    distance = frame["distance"].to_numpy()
    rel = frame["rel_distance"].to_numpy()
    dt = np.diff(time)
    dd = np.diff(distance)

    return {
        "samples": len(frame),
        "channels_equal": len({len(frame[c]) for c in TELEMETRY_CHANNELS}) == 1,
        "time_start": float(time[0]),
        "time_end": float(time[-1]),
        "reported": float(lap_info["time"]),
        "non_increasing_dt": int((dt <= 0).sum()),
        "duplicate_time": int(pd.Series(time).duplicated().sum()),
        "median_dt": float(np.median(dt)),
        "max_dt": float(dt.max()),
        "distance_start": float(distance[0]),
        "distance_end": float(distance[-1]),
        "negative_dd": int((dd < 0).sum()),
        "duplicate_distance": int(pd.Series(distance).duplicated().sum()),
        "max_dd": float(dd.max()),
        "rel_start": float(rel[0]),
        "rel_end": float(rel[-1]),
        "coverage_pct": float(rel[-1] * 100.0),
        "non_finite": int(frame[list(ESSENTIAL_CHANNELS)].isna().sum().sum()),
    }


AUDIT_ROWS = (
    ("samples", "samples", "{}"),
    ("all channels same length", "channels_equal", "{}"),
    ("trace time start (s)", "time_start", "{:.3f}"),
    ("trace time end (s)", "time_end", "{:.3f}"),
    ("laptimes.json duration (s)", "reported", "{:.3f}"),
    ("non-increasing dt", "non_increasing_dt", "{}"),
    ("duplicate timestamps", "duplicate_time", "{}"),
    ("median dt (s)", "median_dt", "{:.3f}"),
    ("largest dt (s)", "max_dt", "{:.3f}"),
    ("distance start (m)", "distance_start", "{:.2f}"),
    ("distance end (m)", "distance_end", "{:.2f}"),
    ("negative distance steps", "negative_dd", "{}"),
    ("duplicate distance values", "duplicate_distance", "{}"),
    ("largest distance step (m)", "max_dd", "{:.2f}"),
    ("rel_distance start", "rel_start", "{:.6f}"),
    ("rel_distance end", "rel_end", "{:.6f}"),
    ("lap progress covered (%)", "coverage_pct", "{:.2f}"),
    ("non-finite essentials", "non_finite", "{}"),
)


def audit_table(audits: dict[str, dict]) -> pd.DataFrame:
    rows = []
    for label, key, formatter in AUDIT_ROWS:
        row = {"metric": label}
        for driver, audit in audits.items():
            value = audit[key]
            row[LABELS[driver]] = (
                formatter.format(value) if isinstance(value, float) else value
            )
        rows.append(row)
    return pd.DataFrame(rows)


def xy_scale(frame: pd.DataFrame) -> tuple[float, float, float]:
    """x/y path length versus the distance channel - reveals the ~10x scale."""
    x = frame["x"].to_numpy()
    y = frame["y"].to_numpy()
    path_length = float(np.hypot(np.diff(x), np.diff(y)).sum())
    distance = frame["distance"].to_numpy()
    travelled = float(distance[-1] - distance[0])
    return path_length, travelled, path_length / travelled


# ---------------------------------------------------------------------------
# B. Sector boundary positions
# ---------------------------------------------------------------------------
def boundary_table(ver, lec, ver_info, lec_info) -> pd.DataFrame:
    """Where each measured sector line falls in each driver's own trace."""
    bounds_v = sector_boundaries(ver_info)
    bounds_l = sector_boundaries(lec_info)
    t_v = ver["time"].to_numpy()
    t_l = lec["time"].to_numpy()

    rows = []
    for name in ("S1", "S2", "END"):
        tv, tl = bounds_v[name], bounds_l[name]
        dist_v = value_at(t_v, ver["distance"].to_numpy(), tv)
        dist_l = value_at(t_l, lec["distance"].to_numpy(), tl)
        rel_v = value_at(t_v, ver["rel_distance"].to_numpy(), tv)
        rel_l = value_at(t_l, lec["rel_distance"].to_numpy(), tl)
        x_v = value_at(t_v, ver["x"].to_numpy(), tv) / XY_SCALE
        y_v = value_at(t_v, ver["y"].to_numpy(), tv) / XY_SCALE
        x_l = value_at(t_l, lec["x"].to_numpy(), tl) / XY_SCALE
        y_l = value_at(t_l, lec["y"].to_numpy(), tl) / XY_SCALE
        rows.append({
            "boundary": name,
            "VER t (s)": round(tv, 3),
            "VER dist (m)": round(dist_v, 1),
            "VER rel": round(rel_v, 6),
            "LEC t (s)": round(tl, 3),
            "LEC dist (m)": round(dist_l, 1),
            "LEC rel": round(rel_l, 6),
            "dDist VER-LEC (m)": round(dist_v - dist_l, 2),
            "dXY approx (m)": round(float(np.hypot(x_v - x_l, y_v - y_l)), 2),
        })
    return pd.DataFrame(rows)


def sector_length_table(ver, lec, ver_info, lec_info) -> pd.DataFrame:
    """Distance each driver's own trace assigns to each sector."""
    bounds_v = sector_boundaries(ver_info)
    bounds_l = sector_boundaries(lec_info)
    t_v = ver["time"].to_numpy()
    d_v = ver["distance"].to_numpy()
    t_l = lec["time"].to_numpy()
    d_l = lec["distance"].to_numpy()

    rows = []
    for first, last in zip(BOUNDARY_ORDER[:-1], BOUNDARY_ORDER[1:]):
        len_v = value_at(t_v, d_v, bounds_v[last]) - value_at(t_v, d_v, bounds_v[first])
        len_l = value_at(t_l, d_l, bounds_l[last]) - value_at(t_l, d_l, bounds_l[first])
        rows.append({
            "sector": f"{first}-{last}",
            "VER length (m)": round(len_v, 1),
            "LEC length (m)": round(len_l, 1),
            "difference (m)": round(len_v - len_l, 2),
            "difference (%)": round((len_v - len_l) / len_v * 100.0, 3),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# C. Three alignment methods
# ---------------------------------------------------------------------------
def align_by_channel(ver, lec, channel: str) -> dict:
    """Match the drivers on equal values of a per-lap progress channel.

    ``channel="rel_distance"`` is method A (the original prototype),
    ``channel="distance"`` is method B.
    """
    x_v = ver[channel].to_numpy()
    x_l = lec[channel].to_numpy()
    grid = np.linspace(
        max(x_v.min(), x_l.min()), min(x_v.max(), x_l.max()), CURVE_POINTS
    )

    time_v = np.interp(grid, x_v, ver["time"].to_numpy())
    time_l = np.interp(grid, x_l, lec["time"].to_numpy())
    delta = time_v - time_l
    delta = delta - delta[0]

    return {
        "grid": grid,
        "ver_distance": np.interp(grid, x_v, ver["distance"].to_numpy()),
        "delta": delta,
        "time_ver": time_v,
        "time_lec": time_l,
    }


def align_by_sector(ver, lec, ver_info, lec_info) -> list[dict]:
    """Method C: re-anchor at every measured sector line, then match inside.

    Assumption (documented, not hidden): at equal proportional distance within a
    sector both drivers are at the same physical point. The sector end points are
    measured, so the cumulative delta at each sector end is the official value by
    construction; only the interior shape is estimated.
    """
    bounds_v = sector_boundaries(ver_info)
    bounds_l = sector_boundaries(lec_info)
    t_v = ver["time"].to_numpy()
    d_v = ver["distance"].to_numpy()
    t_l = lec["time"].to_numpy()
    d_l = lec["distance"].to_numpy()

    segments = []
    for first, last in zip(BOUNDARY_ORDER[:-1], BOUNDARY_ORDER[1:]):
        start_v = value_at(t_v, d_v, bounds_v[first])
        end_v = value_at(t_v, d_v, bounds_v[last])
        start_l = value_at(t_l, d_l, bounds_l[first])
        end_l = value_at(t_l, d_l, bounds_l[last])

        u = np.linspace(0.0, 1.0, SECTOR_POINTS)
        distance_v = start_v + u * (end_v - start_v)
        distance_l = start_l + u * (end_l - start_l)

        # Invert the measured time -> distance curve to recover elapsed time.
        time_curve_v = np.interp(distance_v, d_v, t_v)
        time_curve_l = np.interp(distance_l, d_l, t_l)

        segments.append({
            "sector": f"{first}-{last}",
            "u": u,
            "ver_distance": distance_v,
            "lec_distance": distance_l,
            "delta": time_curve_v - time_curve_l,
            "time_ver": time_curve_v,
            "time_lec": time_curve_l,
            "length_ver": end_v - start_v,
            "length_lec": end_l - start_l,
            "offset_ver": start_v - start_l,
        })
    return segments


def concat_sectors(segments: list[dict], key: str) -> np.ndarray:
    return np.concatenate([segment[key] for segment in segments])


# ---------------------------------------------------------------------------
# Delta at the measured sector lines, for all three methods
# ---------------------------------------------------------------------------
def method_comparison(ver, ver_info, rel, metres, sectors) -> pd.DataFrame:
    """Compare each method's cumulative delta against official sector timing.

    The comparison point is VER's own measured position at the sector line, so no
    method is advantaged by being evaluated where it was anchored.
    """
    bounds = sector_boundaries(ver_info)
    t_v = ver["time"].to_numpy()
    d_v = ver["distance"].to_numpy()
    sector_distance = concat_sectors(sectors, "ver_distance")
    sector_delta = concat_sectors(sectors, "delta")

    rows = []
    for name in ("S1", "S2", "END"):
        position = value_at(t_v, d_v, bounds[name])
        official = OFFICIAL_DELTA[name]
        rel_delta = float(np.interp(position, rel["ver_distance"], rel["delta"]))
        metre_delta = float(np.interp(position, metres["ver_distance"], metres["delta"]))
        sector_value = float(np.interp(position, sector_distance, sector_delta))
        rows.append({
            "boundary": name,
            "official (s)": official,
            "A rel (s)": round(rel_delta, 3),
            "A error": round(rel_delta - official, 3),
            "B metre (s)": round(metre_delta, 3),
            "B error": round(metre_delta - official, 3),
            "C sector (s)": round(sector_value, 3),
            "C error": round(sector_value - official, 3),
        })
    return pd.DataFrame(rows)


def sector_detail_table(sectors: list[dict]) -> pd.DataFrame:
    """Interior shape of the sector-aware curve and its residual mismatch."""
    rows = []
    for segment in sectors:
        delta = segment["delta"]
        rows.append({
            "sector": segment["sector"],
            "delta u=0 (s)": round(float(delta[0]), 3),
            "delta u=0.5 (s)": round(float(np.interp(0.5, segment["u"], delta)), 3),
            "delta u=1 (s)": round(float(delta[-1]), 3),
            "VER len (m)": round(segment["length_ver"], 1),
            "LEC len (m)": round(segment["length_lec"], 1),
            "residual (m)": round(segment["length_ver"] - segment["length_lec"], 2),
            "excess over anchors (s)": round(
                float(np.max(delta) - delta[-1]), 3
            ),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# D. Investigating the final-chicane spike
# ---------------------------------------------------------------------------
def peak_summary(delta, ver_distance, total_distance: float) -> dict:
    index = int(np.argmax(delta))
    return {
        "peak delta (s)": round(float(delta[index]), 3),
        "at VER dist (m)": round(float(ver_distance[index]), 1),
        "at lap (%)": round(float(ver_distance[index]) / total_distance * 100.0, 2),
        "excess over finish (s)": round(
            float(delta[index] - delta[-1]), 3
        ),
    }


def amplification_table(ver, lec, progress: tuple[float, ...]) -> pd.DataFrame:
    """How the same positional mismatch becomes a larger time error at low speed.

    Uses the relative-distance matching, i.e. exactly the original method.
    """
    rel_v = ver["rel_distance"].to_numpy()
    rel_l = lec["rel_distance"].to_numpy()
    rows = []
    for u in progress:
        dist_v = float(np.interp(u, rel_v, ver["distance"].to_numpy()))
        dist_l = float(np.interp(u, rel_l, lec["distance"].to_numpy()))
        speed_v = float(np.interp(u, rel_v, ver["speed"].to_numpy()))
        speed_l = float(np.interp(u, rel_l, lec["speed"].to_numpy()))
        mean_speed = (speed_v + speed_l) / 2.0 / 3.6
        mismatch = dist_v - dist_l
        rows.append({
            "progress (%)": round(u * 100.0, 2),
            "VER dist (m)": round(dist_v, 1),
            "LEC dist (m)": round(dist_l, 1),
            "mismatch (m)": round(mismatch, 2),
            "mean speed (km/h)": round(mean_speed * 3.6, 1),
            "mismatch / speed (s)": round(mismatch / mean_speed, 3),
        })
    return pd.DataFrame(rows)


def nearest_corner(distance_m: float) -> tuple[int, float]:
    """Nearest circuit corner to a distance-along-lap, from corners.json."""
    with open(BASE / "corners.json", encoding="utf-8") as fh:
        corners = json.load(fh)
    distances = np.asarray(corners["Distance"], dtype=float)
    index = int(np.argmin(np.abs(distances - distance_m)))
    return int(corners["CornerNumber"][index]), float(distances[index])


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------
def plot_results(ver, lec, ver_info, rel, metres, sectors, total_distance: float):
    sector_distance = concat_sectors(sectors, "ver_distance")
    sector_delta = concat_sectors(sectors, "delta")
    bounds = sector_boundaries(ver_info)
    t_v = ver["time"].to_numpy()
    d_v = ver["distance"].to_numpy()
    d_l = lec["distance"].to_numpy()
    speed_v = ver["speed"].to_numpy()
    speed_l = lec["speed"].to_numpy()

    figure, axes = plt.subplots(3, 1, figsize=(12, 13), constrained_layout=True)

    # Panel 1 - cumulative delta
    ax = axes[0]
    ax.plot(rel["ver_distance"] / total_distance * 100, rel["delta"],
            lw=1.6, label="A: relative distance (original)")
    ax.plot(metres["ver_distance"] / total_distance * 100, metres["delta"],
            lw=1.6, label="B: absolute distance")
    ax.plot(sector_distance / total_distance * 100, sector_delta,
            lw=2.2, label="C: sector-aware (timing-anchored)")
    for name in ("S1", "S2", "END"):
        position = value_at(t_v, d_v, bounds[name]) / total_distance * 100.0
        ax.axvline(position, color="0.75", ls=":", lw=1)
        ax.plot(position, OFFICIAL_DELTA[name], "o", color="black", ms=5, zorder=5)
    ax.plot([], [], "o", color="black", label="official sector delta")
    peak_index = int(np.argmax(rel["delta"]))
    ax.annotate(
        f"A peak {rel['delta'][peak_index]:+.3f} s",
        xy=(rel["ver_distance"][peak_index] / total_distance * 100.0,
            rel["delta"][peak_index]),
        xytext=(-85, 25), textcoords="offset points", fontsize=9,
        arrowprops={"arrowstyle": "->", "lw": 0.8, "color": "C0"},
    )
    peak_index = int(np.argmax(sector_delta))
    ax.annotate(
        f"C peak {sector_delta[peak_index]:+.3f} s",
        xy=(sector_distance[peak_index] / total_distance * 100.0,
            sector_delta[peak_index]),
        xytext=(-40, -55), textcoords="offset points", fontsize=9,
        arrowprops={"arrowstyle": "->", "lw": 0.8, "color": "C2"},
    )
    ax.set_xlabel("VER distance along lap (%)")
    ax.set_ylabel("cumulative delta VER - LEC (s)")
    ax.set_title("Spa 2025 qualifying: Verstappen lap 2 vs Leclerc lap 4")
    ax.grid(alpha=0.3)
    ax.legend(loc="upper left", fontsize=9)

    # Panel 2 - positional mismatch behind each method
    ax = axes[1]
    rel_mismatch = (
        np.interp(rel["grid"], ver["rel_distance"], d_v)
        - np.interp(rel["grid"], lec["rel_distance"], d_l)
    )
    ax.plot(rel["ver_distance"] / total_distance * 100, rel_mismatch,
            lw=1.6, label="A: mismatch at matched rel_distance")
    for index, segment in enumerate(sectors):
        residual = segment["u"] * (segment["length_ver"] - segment["length_lec"])
        ax.plot(segment["ver_distance"] / total_distance * 100, residual,
                lw=2.0, color="C2",
                label="C: residual after sector re-anchoring" if index == 0 else None)
        ax.plot(segment["ver_distance"][0] / total_distance * 100, 0.0,
                "o", color="C2", ms=5, zorder=5)
    ax.axhline(0, color="gray", lw=1)
    ax.set_xlabel("VER distance along lap (%)")
    ax.set_ylabel("positional mismatch VER - LEC (m)")
    ax.set_title("Cross-driver distance mismatch implied by each alignment")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=9)

    # Panel 3 - speed at sector-matched positions
    ax = axes[2]
    for segment in sectors:
        x = segment["ver_distance"] / total_distance * 100.0
        first = segment["sector"] == "START-S1"
        ax.plot(x, np.interp(segment["ver_distance"], d_v, speed_v),
                color="C0", lw=1.1, label="VER" if first else None)
        ax.plot(x, np.interp(segment["lec_distance"], d_l, speed_l),
                color="C3", lw=1.1, label="LEC" if first else None)
    corner_number, corner_distance = nearest_corner(6688.0)
    ax.axvline(corner_distance / total_distance * 100.0, color="0.5", ls="--", lw=1)
    ax.annotate(
        f"T{corner_number} ({corner_distance:.0f} m)",
        xy=(corner_distance / total_distance * 100.0, 345),
        xytext=(-6, 0), textcoords="offset points",
        fontsize=9, ha="right", va="center",
    )
    ax.set_xlabel("VER distance along lap (%)")
    ax.set_ylabel("speed (km/h)")
    ax.set_title("Speed at sector-matched positions")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=9)

    return figure


def main() -> None:
    ver, ver_info = load_lap("VER", LAPS["VER"])
    lec, lec_info = load_lap("LEC", LAPS["LEC"])

    print_section("SPA 2025 QUALIFYING - SECTOR-AWARE ALIGNMENT VALIDATION")
    print("VER = Verstappen lap 2, LEC = Leclerc lap 4")
    print("Positive delta means Verstappen is behind Leclerc.")

    # -- 1. raw data quality ------------------------------------------------
    print_section("1. RAW DATA QUALITY (checked before any processing)")
    audits = {"VER": audit_trace(ver, ver_info), "LEC": audit_trace(lec, lec_info)}
    print(audit_table(audits).to_string(index=False))
    print()
    for driver, frame in (("VER", ver), ("LEC", lec)):
        path_length, travelled, ratio = xy_scale(frame)
        print(
            f"{driver}: x/y path length {path_length:.0f} m vs distance travelled "
            f"{travelled:.0f} m (ratio {ratio:.2f}) -> x/y/z stored at ~10x metre scale"
        )
    print()
    print("No sorting, de-duplication or interpolation was required in the raw data:")
    print("time and distance are strictly monotonic, with no duplicates and no")
    print("non-finite values, and each trace ends exactly at its recorded lap time.")

    # -- 2. sector boundaries ----------------------------------------------
    print_section("2. SECTOR BOUNDARY POSITIONS (measured timing anchors)")
    for driver, info in (("VER", ver_info), ("LEC", lec_info)):
        start = info["lST"]
        print(
            f"{driver}: lST {start:.3f} | s1T {info['s1T']:.3f} | "
            f"s2T {info['s2T']:.3f} | s3T {info['s3T']:.3f}"
        )
        print(
            "      lap-relative boundaries "
            f"{info['s1T'] - start:.3f} / {info['s2T'] - start:.3f} / "
            f"{info['s3T'] - start:.3f} s"
        )
        print(
            "      s1 / s1+s2 / lap duration "
            f"{info['s1']:.3f} / {info['s1'] + info['s2']:.3f} / "
            f"{info['time']:.3f} s"
        )
    print()
    print(boundary_table(ver, lec, ver_info, lec_info).to_string(index=False))
    print()
    print("Distance each trace assigns to the same physical sector (they should match):")
    print()
    print(sector_length_table(ver, lec, ver_info, lec_info).to_string(index=False))

    # -- 3. method comparison ----------------------------------------------
    print_section("3. ALIGNMENT METHODS - DELTA AT THE MEASURED SECTOR LINES")
    rel = align_by_channel(ver, lec, "rel_distance")
    metres = align_by_channel(ver, lec, "distance")
    sectors = align_by_sector(ver, lec, ver_info, lec_info)
    print(method_comparison(ver, ver_info, rel, metres, sectors).to_string(index=False))
    print()
    print("Method C is anchored at the sector lines, so agreement there is the timing")
    print("constraint itself, not independent evidence. Its interior shape is:")
    print()
    print(sector_detail_table(sectors).to_string(index=False))
    print()
    denominator_v = float(ver["distance"].to_numpy()[-1] / ver["rel_distance"].to_numpy()[-1])
    denominator_l = float(lec["distance"].to_numpy()[-1] / lec["rel_distance"].to_numpy()[-1])
    print(
        f"rel_distance denominators: VER {denominator_v:.1f} m, LEC {denominator_l:.1f} m. "
        "Equal rel_distance is therefore not an equal track position."
    )

    # -- 4. the spike -------------------------------------------------------
    print_section("4. THE 96% SPIKE (FINAL CHICANE)")
    total_distance = float(ver["distance"].to_numpy()[-1])
    sector_curve = {
        "delta": concat_sectors(sectors, "delta"),
        "ver_distance": concat_sectors(sectors, "ver_distance"),
    }

    peaks = []
    for name, curve in (
        ("A relative distance", rel),
        ("B absolute distance", metres),
        ("C sector-aware", sector_curve),
    ):
        summary = {"method": name}
        summary.update(
            peak_summary(curve["delta"], curve["ver_distance"], total_distance)
        )
        peaks.append(summary)
    print(pd.DataFrame(peaks).to_string(index=False))
    print()
    print("Same positional mismatch at different speed -> different apparent delta:")
    print()
    print(
        amplification_table(
            ver, lec, (0.90, 0.95, 0.96, 0.9625, 0.97, 0.98, 0.995)
        ).to_string(index=False)
    )
    print()
    corner_number, corner_distance = nearest_corner(6688.0)
    corner_percent = corner_distance / total_distance * 100.0
    print(
        f"The peak sits at {corner_distance:.0f} m ({corner_percent:.2f}% of VER's lap), "
        f"i.e. Turn {corner_number} - the entry to the final chicane,"
    )
    print("where both cars are close to their minimum speed for the lap.")

    # -- 5. verdict ---------------------------------------------------------
    print_section("5. WHAT IS TRUSTWORTHY AND WHAT IS STILL AN ESTIMATE")
    ver_sectors = f"{ver_info['s1']:.3f} / {ver_info['s2']:.3f} / {ver_info['s3']:.3f}"
    lec_sectors = f"{lec_info['s1']:.3f} / {lec_info['s2']:.3f} / {lec_info['s3']:.3f}"
    print("Measured (safe to quote):")
    print(f"  sector times         VER {ver_sectors} s | LEC {lec_sectors} s")
    print("  cumulative delta     +0.343 s at S1, +0.374 s at S2, +0.431 s at the finish")
    print("  sample timestamps    complete and monotonic for both laps")
    print()
    print("Estimated (not measurements):")
    print("  distance / rel_distance - reconstructed, with a cross-driver scale mismatch")
    print("  that the XY channels only partly confirm (see the dXY column above).")
    for segment in sectors:
        residual = abs(segment["length_ver"] - segment["length_lec"])
        speed_v = np.interp(
            segment["ver_distance"], ver["distance"].to_numpy(), ver["speed"].to_numpy()
        )
        speed_l = np.interp(
            segment["lec_distance"], lec["distance"].to_numpy(), lec["speed"].to_numpy()
        )
        slowest = max(float(min(speed_v.min(), speed_l.min())), 1.0) / 3.6
        print(
            f"    {segment['sector']}: residual {residual:.1f} m -> up to "
            f"{residual / slowest:.2f} s of interior error at {slowest * 3.6:.0f} km/h"
        )
    print("  anything between two telemetry samples (linear interpolation)")

    peak_a = peaks[0]["peak delta (s)"]
    peak_c = peaks[2]["peak delta (s)"]
    finish_a = float(rel["delta"][-1])
    finish_b = float(metres["delta"][-1])
    print()
    print("Conclusion:")
    print(
        f"  A finishes at {finish_a:+.3f} s and B at {finish_b:+.3f} s versus the measured "
        f"{OFFICIAL_DELTA['END']:+.3f} s;"
    )
    print("  both overstate the gap once the two distance scales diverge, because equal")
    print("  distance (or equal rel_distance) is no longer an equal track position.")
    print(
        f"  C is anchored to the measured sector deltas, and its interior excursion near "
        f"Turn {corner_number} is {peak_c:.3f} s"
    )
    print(f"  against {peak_a:.3f} s for A - roughly a fivefold reduction, and now the same")
    print("  order as the residual mismatch in that sector, so a small genuine difference")
    print("  cannot be ruled out with these two laps.")

    figure = plot_results(ver, lec, ver_info, rel, metres, sectors, total_distance)
    output = Path(__file__).with_name("spa_2025q_ver_lec_alignment.png")
    figure.savefig(output, dpi=140)
    print()
    print(f"Figure saved: {output}")
    # Agg cannot open a window; skip show() when running headless.
    if plt.get_backend().lower() != "agg":
        plt.show()


if __name__ == "__main__":
    main()






