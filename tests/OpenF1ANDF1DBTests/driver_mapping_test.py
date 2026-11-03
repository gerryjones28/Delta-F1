
import pandas as pd
import requests
from pathlib import Path

# 1. Load F1DB driver data
DATA_DIR = Path(__file__).resolve().parents[1] / "data/raw/f1db-csv"

f1db = pd.read_csv(DATA_DIR / "f1db-drivers.csv")

# Only the two specific F1DB driver IDs
f1db = f1db[
    f1db["id"].isin(["max-verstappen", "charles-leclerc"])
].copy()

# 2. Get OpenF1 driver records for Spa 2025 qualifying
url = "https://api.openf1.org/v1/drivers"

response = requests.get(
    url,
    params={"session_key": 9935},
    timeout=30
)
response.raise_for_status()

openf1 = pd.DataFrame(response.json())

openf1 = openf1[
    openf1["name_acronym"].isin(["VER", "LEC"])
].copy()

# 3. Create an explicit source mapping
driver_map = pd.DataFrame([
    {"id": "max-verstappen", "name_acronym": "VER"},
    {"id": "charles-leclerc", "name_acronym": "LEC"}
])

# 4. Merge F1DB with the mapping
mapped = f1db.merge(
    driver_map,
    on="id",
    how="inner",
    validate="one_to_one"
)

# 5. Merge with OpenF1
result = mapped.merge(
    openf1,
    on="name_acronym",
    how="inner",
    validate="one_to_one"
)

# 6. Display the combined records
columns = [
    "id",
    "fullName",
    "name_acronym",
    "driver_number",
    "team_name",
    "session_key"
]

print(result[columns].to_string(index=False))

# 7. Check that both drivers matched
assert len(result) == 2, "Expected two matched drivers"

print("\nSUCCESS: Both drivers matched across sources!")
