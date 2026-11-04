
import requests
import pandas as pd

BASE = "https://api.openf1.org/v1"
SESSION_KEY = 11400

# Retrieve all drivers in the qualifying session
drivers_response = requests.get(
    f"{BASE}/drivers",
    params={"session_key": SESSION_KEY},
    timeout=30
)
drivers_response.raise_for_status()
drivers = pd.DataFrame(drivers_response.json())

# Retrieve all lap records in the qualifying session
laps_response = requests.get(
    f"{BASE}/laps",
    params={"session_key": SESSION_KEY},
    timeout=30
)
laps_response.raise_for_status()
laps = pd.DataFrame(laps_response.json())

# Keep laps with valid recorded durations
timed = laps[
    laps["lap_duration"].notna()
    & (laps["lap_duration"] > 0)
].copy()

# Summarize each driver's available data
summary = (
    timed.groupby("driver_number")
    .agg(
        timed_laps=("lap_number", "count"),
        fastest_lap=("lap_duration", "min"),
        slowest_lap=("lap_duration", "max")
    )
    .reset_index()
)

# Join against ALL drivers, including those without timed laps
driver_info = drivers[
    ["driver_number", "full_name", "team_name"]
].drop_duplicates(subset=["driver_number"])

result = driver_info.merge(
    summary,
    on="driver_number",
    how="left",
    validate="one_to_one"
)

result["timed_laps"] = result["timed_laps"].fillna(0).astype(int)

result = result.sort_values(
    ["fastest_lap", "driver_number"],
    na_position="last"
)

print("\n2026 MEXICO CITY GP — QUALIFYING DATA COVERAGE")
print("=" * 85)

print(
    result[
        ["driver_number", "full_name", "team_name",
         "timed_laps", "fastest_lap"]
    ].to_string(index=False)
)

print("\nSUMMARY")
print(f"Drivers in session: {len(result)}")
print(f"Drivers with timed laps: {(result['timed_laps'] > 0).sum()}")
print(f"Total timed lap records: {len(timed)}")
print(f"All lap records: {len(laps)}")
