
import json
from pathlib import Path

BASE = (
    Path(__file__).resolve().parents[2]
    / "data"
    / "external"
    / "tracinginsights-2025"
    / "Belgian Grand Prix"
    / "Qualifying"
    / "VER"
)

file_path = BASE / "4_tel.json"

with open(file_path, "r", encoding="utf-8") as f:
    data = json.load(f)

telemetry = data["tel"]

print("Available telemetry channels:")
print(list(telemetry.keys()))

print("\nChannel lengths:")
for key, values in telemetry.items():
    print(f"{key}: {len(values)}")

for key in ["time", "distance", "rel_distance", "speed"]:
    if key in telemetry and telemetry[key]:
        print(f"\n{key}:")
        print("First 5:", telemetry[key][:5])
        print("Last 5:", telemetry[key][-5:])
