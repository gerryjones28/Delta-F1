import requests
import pandas as pd

BASE = "https://api.openf1.org/v1"

# Find the session
response = requests.get(
    f"{BASE}/sessions",
    params={
        "year": 2025,
        "country_name": "Belgium",
        "session_name": "Qualifying"
    },
    timeout=30
)
response.raise_for_status()

sessions = response.json()
session_key = sessions[0]["session_key"]

# Get the drivers
response = requests.get(
    f"{BASE}/drivers",
    params={"session_key": session_key},
    timeout=30
)
response.raise_for_status()

drivers = pd.DataFrame(response.json())

selected = drivers[
    drivers["name_acronym"].isin(["VER", "LEC"])
]

columns = [
    "session_key",
    "driver_number",
    "full_name",
    "name_acronym",
    "team_name"
]

print(selected[columns].to_string(index=False))