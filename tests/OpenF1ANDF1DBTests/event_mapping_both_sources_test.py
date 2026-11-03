import requests
import pandas as pd

response = requests.get(
    "https://api.openf1.org/v1/meetings",
    params={
        "year": 2025,
        "country_name": "Belgium"
    },
    timeout=30
)

response.raise_for_status()

meetings = pd.DataFrame(response.json())

columns = [
    "meeting_key",
    "meeting_name",
    "meeting_official_name",
    "circuit_key",
    "circuit_short_name",
    "date_start",
    "date_end",
    "year"
]

print(meetings[columns].to_string(index=False))