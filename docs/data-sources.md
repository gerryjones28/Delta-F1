# Data source notes

Factual access notes only. No schema, key or mapping decisions are recorded here.

## OpenF1

- Base URL: `https://api.openf1.org/v1`
- Historical data (2023 onwards) is free and needs no authentication; real-time
  data requires a paid subscription and is out of scope.
- Endpoints used or planned: `sessions`, `meetings`, `drivers`, `laps`,
  `car_data`, `position`, `intervals`, `stints`, `weather`, `pit`,
  `race_control`, `session_result`, `starting_grid`, `team_radio`, `overtakes`.
- Filtering: query parameters filter by attribute value, e.g.
  `?year=2025&country_name=Belgium&session_name=Qualifying`. Comparison filters
  are written inline, e.g. `?date_start>=2025-07-01`.
- `csv=true` returns CSV instead of JSON.
- Response shape quirk: a query matching exactly one record returns a single JSON
  object, not a one-element array. `src/extract/openf1_client.py` normalises this.
- Sessions distinguish `session_name` values such as `Practice 1`,
  `Sprint Qualifying`, `Qualifying`, `Sprint`, `Race`. Sprint weekends therefore
  contain two qualifying sessions, which is relevant when selecting by name.
- Shared identifier names visible in responses include `session_key`,
  `meeting_key`, `driver_number`, `circuit_key`, `country_key`. How (or whether)
  these become relational keys is an open research question.

### Verified example (2025 Belgian Grand Prix, Spa-Francorchamps)

```text
GET https://api.openf1.org/v1/sessions?year=2025&country_name=Belgium&session_name=Qualifying
-> 1 session: session_key=9935, meeting_key=1265, circuit_key=7,
   date_start=2025-07-26T14:00:00+00:00, date_end=2025-07-26T15:00:00+00:00
```

## F1DB

- Repository: `https://github.com/f1db/f1db` (historical F1 data as CSV).
- The project does not download or clone it automatically. Clone/export it
  locally and point `F1DB_DATA_DIR` at the directory containing the CSV files.
- Files are read on demand by `src/extract/f1db_csv_loader.py`; no assumptions
  about file names, columns or relationships are baked into the code.
- Encoding is read as UTF-8 (BOM tolerant) and files are loaded with
  `low_memory=False`. Override via `load_csv(..., **read_csv_kwargs)` if needed.

## Constraints respected by the scaffolding

- No database tables, primary keys, foreign keys or mappings defined.
- No FastF1 or Jolpica usage.
- No bulk telemetry downloads.
