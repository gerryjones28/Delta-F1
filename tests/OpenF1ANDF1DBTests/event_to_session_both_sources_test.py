import requests
import pandas as pd

response = requests.get(
    "https://api.openf1.org/v1/sessions",
    params={"meeting_key": 1265},
    timeout=30
)
response.raise_for_status()

sessions = pd.DataFrame(response.json())

print(
    sessions[
        ["meeting_key", "session_key", "session_name",
         "date_start", "date_end"]
    ].to_string(index=False)
)