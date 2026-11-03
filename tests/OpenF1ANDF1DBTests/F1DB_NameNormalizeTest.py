import pandas as pd

drivers = pd.read_csv(
    "C:/Delta F1/Delta F1 Test/data/raw/f1db-csv/f1db-drivers.csv"
)

selected = drivers[drivers["abbreviation"].isin(["VER", "LEC"])]

print(selected[["id", "fullName", "abbreviation", "permanentNumber"]].to_string(index=False))