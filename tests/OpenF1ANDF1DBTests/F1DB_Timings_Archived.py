
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

BASE = (
    ROOT
    / "data/external/tracinginsights-2025"
    / "Belgian Grand Prix/Qualifying"
)

for driver, lap_number in [("VER", 2), ("LEC", 4)]:
    path = BASE / driver / "laptimes.json"

    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    idx = data["lap"].index(lap_number)

    print(f"\n--- {driver} LAP {lap_number} ---")

    for field in [
        "time", "s1", "s2", "s3",
        "s1T", "s2T", "s3T"
    ]:
        print(field, ":", data[field][idx])
