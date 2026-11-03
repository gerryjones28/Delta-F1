
import requests
import pandas as pd

url = "https://api.openf1.org/v1/laps"

response = requests.get(
    url,
    params={"session_key": 9935},
    timeout=30
)
response.raise_for_status()

laps = pd.DataFrame(response.json())

# Select Verstappen and Leclerc
selected = laps[
    laps["driver_number"].isin([1, 16])
].copy()

columns = [
    "session_key",
    "driver_number",
    "lap_number",
    "lap_duration",
    "duration_sector_1",
    "duration_sector_2",
    "duration_sector_3"
]

print(selected[columns].head(12).to_string(index=False))

# Confirm the session and drivers match
assert selected["session_key"].eq(9935).all()
assert {1, 16}.issubset(set(selected["driver_number"]))

print("\nSUCCESS: Both drivers have lap records in session 9935!")
