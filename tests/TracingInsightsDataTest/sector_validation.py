
import requests
import pandas as pd

BASE = "https://api.openf1.org/v1"

# Our two confirmed timed laps
drivers = [
    {"name": "Verstappen", "number": 1, "lap": 2},
    {"name": "Leclerc", "number": 16, "lap": 4}
]

results = []

for driver in drivers:
    response = requests.get(
        f"{BASE}/laps",
        params={
            "session_key": 9935,
            "driver_number": driver["number"],
            "lap_number": driver["lap"]
        },
        timeout=30
    )

    response.raise_for_status()
    records = response.json()

    if len(records) != 1:
        raise ValueError(
            f"Expected one lap for {driver['name']}, "
            f"received {len(records)}"
        )

    lap = records[0]

    results.append({
        "driver": driver["name"],
        "lap": lap["lap_number"],
        "S1": lap["duration_sector_1"],
        "S2": lap["duration_sector_2"],
        "S3": lap["duration_sector_3"],
        "Total": lap["lap_duration"]
    })

df = pd.DataFrame(results).set_index("driver")

print("\n--- OFFICIAL SECTOR TIMES ---")
print(df.to_string())

ver = df.loc["Verstappen"]
lec = df.loc["Leclerc"]

sector_deltas = [
    ver["S1"] - lec["S1"],
    ver["S2"] - lec["S2"],
    ver["S3"] - lec["S3"]
]

print("\n--- SECTOR DELTAS (VER - LEC) ---")

cumulative = 0

for i, difference in enumerate(sector_deltas, start=1):
    cumulative += difference
    print(
        f"Sector {i}: {difference:+.3f} s | "
        f"Cumulative: {cumulative:+.3f} s"
    )

print("\nRecorded full-lap difference:",
      round(ver["Total"] - lec["Total"], 3), "s")

print("Sum of sector differences:",
      round(sum(sector_deltas), 3), "s")
