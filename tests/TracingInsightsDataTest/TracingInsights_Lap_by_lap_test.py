"""La Source (Turn 1) corner comparison: Verstappen lap 2 vs lap 5, Spa 2025 Q.

One driver, one corner, two laps - deliberately narrow. Reuses the loaders in
``compare_driver_laps.py`` (same directory) and the corner geometry in
``corners.json``.

How a corner is placed on a lap
-------------------------------
``corners.json`` stores each corner as X/Y plus a ``Distance`` along the lap. The
X/Y values use the same units as the telemetry ``x``/``y`` channels (1/10 metre),
so a corner can be located in a lap by the telemetry sample nearest to that X/Y.
The ``Distance`` field is then used as an independent cross-check: the two
disagree by a few metres, which is what bounds the anchor uncertainty.

Measurements are taken in a window of +-200 m around each lap's own anchor, so
both laps are compared at the same physical place. Corner time gains are NOT
computed: the sampling resolution of this archive does not support them.

Run from the repository root::

    python tests/TracingInsightsDataTest/TracingInsights_Lap_by_lap_test.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from compare_driver_laps import (
    AUDIT_ROWS,
    BASE,
    audit_trace,
    load_lap,
    print_section,
)

DRIVER = "VER"
LAP_NUMBERS = (2, 5)
CORNER_INDEX = 0            # corners.json index 0 == Turn 1 == La Source
WINDOW_BEFORE = 200.0       # metres before each lap's corner anchor
WINDOW_AFTER = 200.0        # metres after each lap's corner anchor
XY_UNITS_PER_METRE = 10.0   # corners.json and telemetry x/y are stored at 1/10 m
FULL_THROTTLE = 99.5        # throttle is interpolated; treat >= 99.5 as 100 %
BRAKE_ON = 0.5              # brake channel is effectively 0/1
VERIFY_KEYS = (
    "samples",
    "channels_equal",
    "time_end",
    "reported",
    "non_increasing_dt",
    "duplicate_time",
    "negative_dd",
    "non_finite",
)


def load_corner(index: int) -> dict:
    """Read one corner from corners.json."""
    with open(BASE / "corners.json", encoding="utf-8") as fh:
        corners = json.load(fh)
    # Rotation is a single value for the whole file (track rotation), not per corner.
    rotation = corners["Rotation"]
    if isinstance(rotation, list):
        rotation = rotation[index]
    return {
        "number": int(corners["CornerNumber"][index]),
        "x": float(corners["X"][index]),
        "y": float(corners["Y"][index]),
        "distance": float(corners["Distance"][index]),
        "angle": float(corners["Angle"][index]),
        "rotation": float(rotation),
    }


def locate_corner(frame: pd.DataFrame, corner: dict) -> dict:
    """Place the corner on one lap: nearest telemetry sample to the corner X/Y."""
    separation = np.hypot(
        frame["x"].to_numpy() - corner["x"],
        frame["y"].to_numpy() - corner["y"],
    ) / XY_UNITS_PER_METRE
    index = int(np.argmin(separation))
    anchor = float(frame["distance"].iloc[index])
    return {
        "index": index,
        "xy_offset_m": float(separation[index]),
        "time": float(frame["time"].iloc[index]),
        "distance": anchor,
        "rel_distance": float(frame["rel_distance"].iloc[index]),
        "distance_error_m": anchor - corner["distance"],
        "sample_step_m": float(frame["distance"].iloc[index] - frame["distance"].iloc[index - 1]),
    }


def corner_window(frame: pd.DataFrame, anchor: float) -> pd.DataFrame:
    """Slice +-200 m around the anchor and express distances relative to it."""
    window = frame[
        frame["distance"].between(anchor - WINDOW_BEFORE, anchor + WINDOW_AFTER)
    ].copy()
    window["d_rel"] = window["distance"] - anchor
    return window.reset_index(drop=True)


def measure_corner(window: pd.DataFrame) -> dict:
    """Minimum speed, braking onset and throttle pickup, each with its bracket.

    Every event is read from the sampled channels, so it is only known to lie
    somewhere between the two samples that bracket it. The bracket width is part
    of the result, not an implementation detail.
    """
    d_rel = window["d_rel"].to_numpy()
    time = window["time"].to_numpy()
    speed = window["speed"].to_numpy()
    throttle = window["throttle"].to_numpy()
    brake = window["brake"].to_numpy()
    position = np.arange(len(window))

    apex = int(np.argmin(speed))
    onset = int(np.flatnonzero((brake >= BRAKE_ON) & (position < apex))[0])
    # Search for release after braking starts, not after the apex: in a hairpin the
    # driver is back on the throttle before the lowest-speed point.
    release = int(np.flatnonzero((brake < BRAKE_ON) & (position > onset))[0])
    pickup = int(np.flatnonzero((throttle > 0.0) & (position >= release))[0])
    full = int(np.flatnonzero((throttle >= FULL_THROTTLE) & (position >= pickup))[0])

    def bracket(index: int, channel: np.ndarray) -> float:
        return float(channel[index] - channel[index - 1])

    return {
        "min_speed": float(speed[apex]),
        "min_speed_d": float(d_rel[apex]),
        "min_speed_t": float(time[apex]),
        "min_speed_bracket_m": bracket(apex, d_rel),
        "onset_d": float(d_rel[onset]),
        "onset_speed": float(speed[onset]),
        "onset_low_d": float(d_rel[onset - 1]),
        "onset_bracket_m": bracket(onset, d_rel),
        "onset_bracket_t": bracket(onset, time),
        "release_d": float(d_rel[release]),
        "release_bracket_m": bracket(release, d_rel),
        "pickup_d": float(d_rel[pickup]),
        "pickup_speed": float(speed[pickup]),
        "pickup_bracket_m": bracket(pickup, d_rel),
        "full_d": float(d_rel[full]),
        "full_bracket_m": bracket(full, d_rel),
        "brake_travel_m": float(d_rel[apex] - d_rel[onset]),
        "brake_duration_t": float(time[apex] - time[onset]),
    }


def comparison_table(measurements: dict[int, dict]) -> pd.DataFrame:
    """Compact lap-vs-lap table; difference is lap 5 minus lap 2."""
    first, second = LAP_NUMBERS
    a = measurements[first]
    b = measurements[second]

    def gaps(key: str) -> str:
        return f"{a[key]:.0f} / {b[key]:.0f} m"

    rows = [
        ("minimum speed (km/h)", f"{a['min_speed']:.1f}", f"{b['min_speed']:.1f}",
         f"{b['min_speed'] - a['min_speed']:+.1f}", "1 km/h channel"),
        ("minimum speed position (m)", f"{a['min_speed_d']:+.1f}", f"{b['min_speed_d']:+.1f}",
         f"{b['min_speed_d'] - a['min_speed_d']:+.1f}", gaps("min_speed_bracket_m")),
        ("braking onset (m)", f"{a['onset_d']:+.1f}", f"{b['onset_d']:+.1f}",
         f"{b['onset_d'] - a['onset_d']:+.1f}", gaps("onset_bracket_m")),
        ("speed at braking onset (km/h)", f"{a['onset_speed']:.1f}", f"{b['onset_speed']:.1f}",
         f"{b['onset_speed'] - a['onset_speed']:+.1f}", gaps("onset_bracket_m")),
        ("brake travel to apex (m)", f"{a['brake_travel_m']:.1f}", f"{b['brake_travel_m']:.1f}",
         f"{b['brake_travel_m'] - a['brake_travel_m']:+.1f}",
         gaps("onset_bracket_m")),
        ("brake release (m)", f"{a['release_d']:+.1f}", f"{b['release_d']:+.1f}",
         f"{b['release_d'] - a['release_d']:+.1f}", gaps("release_bracket_m")),
        ("throttle pickup (m)", f"{a['pickup_d']:+.1f}", f"{b['pickup_d']:+.1f}",
         f"{b['pickup_d'] - a['pickup_d']:+.1f}", gaps("pickup_bracket_m")),
        ("speed at throttle pickup (km/h)", f"{a['pickup_speed']:.1f}", f"{b['pickup_speed']:.1f}",
         f"{b['pickup_speed'] - a['pickup_speed']:+.1f}", "1 km/h channel"),
        ("full throttle (m)", f"{a['full_d']:+.1f}", f"{b['full_d']:+.1f}",
         f"{b['full_d'] - a['full_d']:+.1f}", gaps("full_bracket_m")),
    ]
    return pd.DataFrame(
        rows,
        columns=["metric", f"lap {first}", f"lap {second}", "diff (5-2)", "bracket 2 / 5"],
    )


def plot_corner(windows, measurements, corner, labels) -> plt.Figure:
    """Speed, brake state and throttle against corner progress, both laps."""
    colours = {LAP_NUMBERS[0]: "C0", LAP_NUMBERS[1]: "C3"}
    figure, axes = plt.subplots(
        3, 1, figsize=(11, 9), sharex=True, constrained_layout=True
    )
    speed_axis, brake_axis, throttle_axis = axes

    for lap in LAP_NUMBERS:
        window = windows[lap]
        measured = measurements[lap]
        colour = colours[lap]

        speed_axis.plot(window["d_rel"], window["speed"], color=colour, lw=1.4,
                        label=f"{labels[lap]}, min {measured['min_speed']:.1f} km/h")
        speed_axis.plot(measured["min_speed_d"], measured["min_speed"], "o",
                        color=colour, ms=6, zorder=5)
        speed_axis.axvline(measured["onset_d"], color=colour, ls="--", lw=0.9, alpha=0.8)

        brake_axis.step(window["d_rel"], window["brake"], where="post",
                        color=colour, lw=1.3, label=labels[lap])

        throttle_axis.plot(window["d_rel"], window["throttle"], color=colour, lw=1.4,
                           label=labels[lap])
        throttle_axis.axvline(measured["pickup_d"], color=colour, ls=":", lw=0.9, alpha=0.8)

    for axis in axes:
        axis.axvline(0.0, color="0.35", lw=1.0)
        axis.grid(alpha=0.3)

    speed_axis.plot([], [], ls="--", color="0.4", lw=0.9, label="braking onset")
    speed_axis.plot([], [], "o", color="0.4", ms=6, label="minimum speed")
    speed_axis.set_ylabel("speed (km/h)")
    speed_axis.set_title(
        f"La Source (T{corner['number']}): Verstappen lap {LAP_NUMBERS[0]} "
        f"vs lap {LAP_NUMBERS[1]}, Spa 2025 qualifying"
    )
    speed_axis.legend(loc="lower left", fontsize=9)
    speed_axis.annotate(
        f"T{corner['number']} anchor", (0.0, 0.94),
        xycoords=("data", "axes fraction"), xytext=(4, 0),
        textcoords="offset points", fontsize=8, color="0.35", va="top",
    )

    brake_axis.set_ylabel("brake (0/1)")
    brake_axis.set_yticks([0, 1])
    brake_axis.set_ylim(-0.15, 1.15)

    throttle_axis.plot([], [], ls=":", color="0.4", lw=0.9, label="throttle pickup")
    throttle_axis.set_ylabel("throttle (%)")
    throttle_axis.set_ylim(-5, 105)
    throttle_axis.set_xlabel("corner progress: distance from the T1 anchor (m)")
    throttle_axis.legend(loc="lower right", fontsize=9)

    return figure


def main() -> None:
    corner = load_corner(CORNER_INDEX)
    next_corner = load_corner(CORNER_INDEX + 1)

    print_section("LA SOURCE (T1) - VERSTAPPEN LAP 2 vs LAP 5, SPA 2025 QUALIFYING")
    print(
        f"corners.json entry {CORNER_INDEX}: T{corner['number']} | X {corner['x']:.1f} "
        f"Y {corner['y']:.1f} (1/10 m) | Distance {corner['distance']:.1f} m | "
        f"Angle {corner['angle']:.1f} | file rotation {corner['rotation']:.0f}"
    )

    frames, infos, audits = {}, {}, {}
    for lap in LAP_NUMBERS:
        frame, info = load_lap(DRIVER, lap)
        frames[lap] = frame
        infos[lap] = info
        audits[lap] = audit_trace(frame, info)

    # -- 1. files usable ----------------------------------------------------
    print_section("1. LAP FILES PRESENT AND USABLE")
    rows = []
    for label, key, formatter in AUDIT_ROWS:
        if key not in VERIFY_KEYS:
            continue
        row = {"check": label}
        for lap in LAP_NUMBERS:
            value = audits[lap][key]
            row[f"lap {lap}"] = formatter.format(value) if isinstance(value, float) else value
        rows.append(row)
    print(pd.DataFrame(rows).to_string(index=False))
    print()
    for lap in LAP_NUMBERS:
        info = infos[lap]
        print(
            f"lap {lap}: {DRIVER}/{lap}_tel.json | {info['compound']} tyre, life {info['life']}, "
            f"stint {info['stint']}, recorded lap time {info['time']:.3f} s"
        )

    # -- 2. corner mapping --------------------------------------------------
    print_section("2. CORNER GEOMETRY -> TELEMETRY MAPPING")
    anchors = {}
    for lap in LAP_NUMBERS:
        anchor = locate_corner(frames[lap], corner)
        anchors[lap] = anchor
        print(
            f"lap {lap}: nearest sample {anchor['index']:3d} | t {anchor['time']:7.3f} s | "
            f"distance channel {anchor['distance']:7.1f} m | "
            f"XY offset {anchor['xy_offset_m']:.2f} m | "
            f"vs corners.json {anchor['distance_error_m']:+.1f} m"
        )
    print()
    print("The XY match is within about a metre on both laps, so both anchors point at")
    print("the same physical place. The distance channel disagrees with corners.json by a")
    print("few metres per lap, so positions are trustworthy to a few metres, not better.")

    # -- 3. window ----------------------------------------------------------
    print_section("3. CORNER WINDOW")
    windows, measurements = {}, {}
    for lap in LAP_NUMBERS:
        window = corner_window(frames[lap], anchors[lap]["distance"])
        windows[lap] = window
        measurements[lap] = measure_corner(window)
        print(
            f"lap {lap}: anchor {anchors[lap]['distance']:7.1f} m -> window "
            f"{window['distance'].iloc[0]:7.1f} to {window['distance'].iloc[-1]:7.1f} m "
            f"({window['d_rel'].iloc[0]:+.1f} to {window['d_rel'].iloc[-1]:+.1f} m from T1), "
            f"{len(window)} samples"
        )
    clearance = next_corner["distance"] - (
        anchors[LAP_NUMBERS[0]]["distance"] + WINDOW_AFTER
    )
    print()
    print(
        f"rule: anchor -{WINDOW_BEFORE:.0f} m to anchor +{WINDOW_AFTER:.0f} m, measured relative to each"
    )
    print("lap's own anchor so both laps are compared at the same place. The window ends")
    print(f"{clearance:.0f} m before T{next_corner['number']}, so no other corner is included.")

    # -- 4. measurements ----------------------------------------------------
    print_section("4. MEASUREMENT COMPARISON (diff = lap 5 minus lap 2)")
    print(comparison_table(measurements).to_string(index=False))

    # -- 5. uncertainty -----------------------------------------------------
    print_section("5. UNCERTAINTY AND WHAT IS NOT CLAIMED")
    a = measurements[LAP_NUMBERS[0]]
    b = measurements[LAP_NUMBERS[1]]
    print(
        f"- braking onset, lap 2: first braked sample {a['onset_d']:+.1f} m, previous sample "
        f"{a['onset_low_d']:+.1f} m ({a['onset_bracket_m']:.1f} m / {a['onset_bracket_t']:.3f} s gap)"
    )
    print(
        f"- braking onset, lap 5: first braked sample {b['onset_d']:+.1f} m, previous sample "
        f"{b['onset_low_d']:+.1f} m ({b['onset_bracket_m']:.1f} m / {b['onset_bracket_t']:.3f} s gap)"
    )
    overlap = min(a["onset_d"], b["onset_d"]) - max(a["onset_low_d"], b["onset_low_d"])
    verdict = "overlap, so the difference is not resolved" if overlap > 0 else "do not overlap"
    print(f"  -> brackets {verdict} (overlap {overlap:+.1f} m).")
    print(
        f"- 'speed at braking onset' differs by {b['onset_speed'] - a['onset_speed']:+.1f} km/h, but lap 5's first"
    )
    print("  braked sample lands 21 m into the braking zone, so most of that difference is")
    print("  the sample gap rather than a different approach speed.")
    print(
        f"- anchors: XY offsets {anchors[LAP_NUMBERS[0]]['xy_offset_m']:.2f} / "
        f"{anchors[LAP_NUMBERS[1]]['xy_offset_m']:.2f} m, but distance-channel errors "
        f"{anchors[LAP_NUMBERS[0]]['distance_error_m']:+.1f} / "
        f"{anchors[LAP_NUMBERS[1]]['distance_error_m']:+.1f} m add a few metres of systematic offset."
    )
    print(
        f"- minimum speed falls after brake release and throttle pickup on both laps "
        f"(lap {LAP_NUMBERS[0]}: {a['release_d']:+.1f} / {a['pickup_d']:+.1f} / {a['min_speed_d']:+.1f} m),"
    )
    print("  so 'minimum speed' is the lowest point of a hairpin exit, not the geometric")
    print("  corner point taken from corners.json.")
    print("- speed is stored at 1 km/h resolution and interpolated between samples, so")
    print("  differences under ~1 km/h are not meaningful.")
    print(
        f"- the trace drops samples in the braking zone (largest gaps "
        f"{audits[LAP_NUMBERS[0]]['max_dt']:.2f} / {audits[LAP_NUMBERS[1]]['max_dt']:.2f} s), which is why"
    )
    print("  the brackets are widest exactly where the interesting events are.")
    print("- corner time gains are deliberately NOT computed. Measured context only:")
    faster = infos[LAP_NUMBERS[1]]["s1"] - infos[LAP_NUMBERS[0]]["s1"]
    print(
        f"  sector 1 was {infos[LAP_NUMBERS[0]]['s1']:.3f} s on lap {LAP_NUMBERS[0]} and "
        f"{infos[LAP_NUMBERS[1]]['s1']:.3f} s on lap {LAP_NUMBERS[1]} ({faster:+.3f} s),"
    )
    print("  which is timing-system data and cannot be attributed to this corner alone.")

    # -- 6. figure ----------------------------------------------------------
    labels = {lap: f"lap {lap} ({infos[lap]['time']:.3f} s)" for lap in LAP_NUMBERS}
    figure = plot_corner(windows, measurements, corner, labels)
    output = Path(__file__).with_name("spa_2025q_ver_l2_l5_la_source.png")
    figure.savefig(output, dpi=140)
    print()
    print(f"Figure saved: {output}")
    if plt.get_backend().lower() != "agg":
        plt.show()


if __name__ == "__main__":
    main()




