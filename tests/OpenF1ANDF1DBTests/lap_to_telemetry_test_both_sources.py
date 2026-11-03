
import requests
import pandas as pd

BASE = "https://api.openf1.org/v1"

# Step 1: Get Verstappen's lap 2 from Spa 2025 Qualifying
response = requests.get(
    f"{BASE}/laps",
    params={
        "session_key": 9935,
        "driver_number": 1,
        "lap_number": 2
    },
    timeout=30
)

response.raise_for_status()
laps = response.json()

if not laps:
    raise ValueError("No lap records found.")

lap = laps[0]

# Step 2: Determine the lap's start and end times
start = pd.to_datetime(lap["date_start"], utc=True)

end = start + pd.to_timedelta(
    lap["lap_duration"],
    unit="s"
)

# Format as UTC without the timezone suffix
start_str = start.strftime("%Y-%m-%dT%H:%M:%S.%f")
end_str = end.strftime("%Y-%m-%dT%H:%M:%S.%f")

print("Lap number:", lap["lap_number"])
print("Lap duration:", lap["lap_duration"])
print("Start:", start_str)
print("End:", end_str)

# Step 3: Retrieve telemetry within that lap
params = {
    "session_key": 9935,
    "driver_number": 1,
    "date>=": start_str,
    "date<": end_str
}

response = requests.get(
    f"{BASE}/car_data",
    params=params,
    timeout=60
)

# Debugging information
print("\nHTTP status:", response.status_code)
print("Request URL:", response.url)

if response.status_code != 200:
    print("Error response:", response.text[:500])

response.raise_for_status()

# Step 4: Convert telemetry JSON to DataFrame
telemetry = pd.DataFrame(response.json())

if telemetry.empty:
    raise ValueError("No telemetry records returned.")

telemetry["date"] = pd.to_datetime(
    telemetry["date"],
    utc=True
)

telemetry = telemetry.sort_values("date")

# Step 5: Display five telemetry records
columns = [
    "date",
    "speed",
    "throttle",
    "brake",
    "n_gear",
    "rpm"
]

print("\nFirst five telemetry records:")
print(telemetry[columns].head(5).to_string(index=False))

# Step 6: Check telemetry completeness
gaps = telemetry["date"].diff().dt.total_seconds()

print("\n--- DATA QUALITY CHECK ---")
print("Total telemetry rows:", len(telemetry))
print("Largest sampling gap:", gaps.max(), "seconds")
print("Median sampling gap:", gaps.median(), "seconds")
print(
    "Duplicate timestamps:",
    telemetry["date"].duplicated().sum()
)
print("\nMissing values:")
print(telemetry[columns].isna().sum())
