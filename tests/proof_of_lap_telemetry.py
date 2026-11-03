
import json
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

# --------------------------------------------------
# Paths
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]

BASE = (
    ROOT
    / "data"
    / "external"
    / "tracinginsights-2025"
    / "Belgian Grand Prix"
    / "Qualifying"
)


def load_lap(driver, lap_number):
    path = BASE / driver / f"{lap_number}_tel.json"

    with open(path, "r", encoding="utf-8") as f:
        tel = json.load(f)["tel"]

    columns = [
        "time",
        "rel_distance",
        "speed",
        "throttle",
        "brake"
    ]

    df = pd.DataFrame({
        column: tel[column]
        for column in columns
    })

    for column in columns:
        df[column] = pd.to_numeric(
            df[column], errors="coerce"
        )

    df = df.dropna(subset=columns)
    df = df.sort_values("rel_distance")

    return df


# --------------------------------------------------
# Load verified qualifying laps
# --------------------------------------------------

ver = load_lap("VER", 2)
lec = load_lap("LEC", 4)

print("Verstappen samples:", len(ver))
print("Leclerc samples:", len(lec))

# Plot each original trace against its own relative
# lap distance. No cross-driver time alignment.

ver_x = ver["rel_distance"] * 100
lec_x = lec["rel_distance"] * 100


# --------------------------------------------------
# Plot full-lap telemetry
# --------------------------------------------------

fig, axes = plt.subplots(
    3, 1,
    figsize=(14, 9),
    sharex=True,
    gridspec_kw={"height_ratios": [2, 1, 1]}
)

fig.suptitle(
    "2025 Belgian Grand Prix — Qualifying Telemetry\n"
    "Verstappen Lap 2 (1:42.066) vs "
    "Leclerc Lap 4 (1:41.635)",
    fontsize=16,
    fontweight="bold"
)

colors = {
    "VER": "#1976D2",
    "LEC": "#E53935"
}

# SPEED
axes[0].plot(
    ver_x, ver["speed"],
    color=colors["VER"],
    label="Verstappen",
    linewidth=1.8
)

axes[0].plot(
    lec_x, lec["speed"],
    color=colors["LEC"],
    label="Leclerc",
    linewidth=1.8
)

axes[0].set_ylabel("Speed (km/h)")
axes[0].legend(loc="upper right")
axes[0].set_title("Speed")

# THROTTLE
axes[1].plot(
    ver_x, ver["throttle"],
    color=colors["VER"],
    linewidth=1.5
)

axes[1].plot(
    lec_x, lec["throttle"],
    color=colors["LEC"],
    linewidth=1.5
)

axes[1].set_ylabel("Throttle (%)")
axes[1].set_ylim(-5, 105)
axes[1].set_title("Throttle")

# BRAKE
axes[2].step(
    ver_x, ver["brake"],
    where="post",
    color=colors["VER"],
    linewidth=1.6
)

axes[2].step(
    lec_x, lec["brake"],
    where="post",
    color=colors["LEC"],
    linewidth=1.6
)

axes[2].set_ylabel("Brake")
axes[2].set_yticks([0, 1])
axes[2].set_yticklabels(["Off", "On"])
axes[2].set_title("Braking")
axes[2].set_xlabel("Lap progress (%)")

# Formatting
for ax in axes:
    ax.grid(True, alpha=0.25)
    ax.set_xlim(0, 100)

fig.text(
    0.5, 0.015,
    "Source: TracingInsights Archive | "
    "Original sampled telemetry; "
    "each lap shown on its own relative-distance scale.",
    ha="center",
    fontsize=9,
    color="gray"
)

plt.tight_layout(rect=[0, 0.035, 1, 0.94])

# Save high-quality image for email
output = Path(__file__).parent / "spa_2025_full_lap_telemetry.png"

plt.savefig(output, dpi=200, bbox_inches="tight")

print(f"Saved figure: {output}")

plt.show()
