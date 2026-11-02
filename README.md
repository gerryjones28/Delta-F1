# DeltaTrace

A solo graduate-level database project: a Formula 1 telemetry and driver
performance analysis platform. This repository currently contains **only** the
development environment and scaffolding - the relational schema is intentionally
undesigned.

## Objective

Build an ETL pipeline and analysis platform that combines Formula 1 timing,
telemetry and historical results, then loads them into PostgreSQL for driver
performance analysis (pace deltas, stint behaviour, qualifying vs race
performance, and so on).

## Data sources

| Source | Description | Access |
| --- | --- | --- |
| [OpenF1](https://openf1.org/docs/) | REST API with live and historical F1 telemetry, laps, sessions, drivers, car positions. Historical data from 2023 onwards. | Free, no authentication (historical) |
| [F1DB](https://github.com/f1db/f1db) | Downloadable historical F1 data (results, standings, driver and team history) in CSV format. | Local CSV export |

OpenF1 is consumed through `requests`; F1DB files are read from a local
directory. Nothing is downloaded automatically, and no telemetry bulk downloads
happen yet.

## Status / scope

Included now:

- Python virtual environment and pinned dependency list
- Project directory layout for extract / transform / load / SQL / tests / data / docs
- OpenF1 API client with timeouts, HTTP error handling and response normalisation
- OpenF1 connectivity check against the 2025 Belgian Grand Prix qualifying session
- F1DB CSV loader utility that reads from a configurable directory
- Tests that run offline and skip integration cases gracefully

Deliberately **not** included yet:

- Relational schema design (tables, primary keys, foreign keys, normalisation)
- Any PostgreSQL DDL or loading code
- Data mappings between OpenF1 and F1DB
- Frontend / application framework
- Large telemetry dataset downloads

## Repository layout

```
.
├── data/
│   ├── raw/            # downloaded / exported source data (git-ignored)
│   └── samples/        # small example datasets, safe to commit
├── docs/               # documentation and schema research notes
├── sql/                # database schema and analysis queries (empty for now)
├── src/
│   ├── extract/        # OpenF1 API client, F1DB CSV loader
│   ├── transform/      # future ETL transformations
│   ├── load/           # future PostgreSQL loading code
│   └── paths.py        # shared project paths
├── tests/              # unit tests + gracefully skipping integration tests
├── .env.example        # placeholder configuration (copy to .env)
├── pytest.ini          # pytest configuration
└── requirements.txt    # development dependencies
```

## Development setup (Windows 11)

Prerequisites: Python 3.13 (or 3.11+), Git, and PowerShell.

### 1. Create and activate the virtual environment

The environment is created once in the repository root:

```powershell
py -3.13 -m venv .venv
```

PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script, allow it for the current shell
session only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Command Prompt (cmd.exe):

```bat
.venv\Scripts\activate.bat
```

Git Bash:

```bash
source .venv/Scripts/activate
```

Deactivate with `deactivate`. You can also skip activation entirely and call the
interpreter directly: `.\.venv\Scripts\python.exe ...`

### 2. Install dependencies

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 3. Configure local environment variables

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and fill in your local PostgreSQL placeholders. `.env` is
git-ignored; never commit real credentials.

### 4. Check OpenF1 connectivity

```powershell
python -m src.extract.openf1_check
```

Expected output (identifier values will vary as OpenF1 data changes):

```
Querying OpenF1 /sessions with year=2025, country_name='Belgium', session_name='Qualifying' ...
[OK] OpenF1 reachable; 1 matching session(s) returned.

session identifier (session_key): 9935
basic metadata:
  session_name       Qualifying
  session_type       Qualifying
  meeting_key        1265
  circuit_short_name Spa-Francorchamps
  ...
```

Exit codes: `0` success, `1` network/HTTP/timeout failure, `2` request succeeded
but no matching session was returned.

### 5. Point the F1DB loader at your local CSV export

The loader never downloads the F1DB repository. Clone or export it separately,
for example:

```powershell
git clone https://github.com/f1db/f1db.git "C:\data\f1db"
```

Then set the directory in `.env` (relative paths resolve from the project root):

```
F1DB_DATA_DIR=data/raw/f1db
```

Use it from Python:

```python
from src.extract.f1db_csv_loader import list_csv_files, load_csv

print([path.name for path in list_csv_files()])
frame = load_csv("races")          # .csv suffix optional
```

If the directory is missing you get a clear `F1DBDirectoryNotFound` error rather
than a silent empty result.

## Running the tests

```powershell
python -m pytest                  # everything (integration tests skip if unavailable)
python -m pytest -m "not integration"   # offline unit tests only
python -m pytest -m integration          # data-source tests only
```

`pytest.ini` puts the project root on `sys.path`, so imports work without
installing the package. It also sets `--basetemp=.pytest_tmp` because the default
`%TEMP%\pytest-of-<user>` directory on this machine is not readable, which makes
any test using `tmp_path` error out. Both `.pytest_tmp/` and `.pytest_cache/` are
git-ignored; drop that option if your temp directory works normally.

Integration tests skip - never fail - when OpenF1 is unreachable or when no F1DB
CSV directory is configured. To exercise the F1DB integration test without a full
export, point the loader at the committed sample data:

```powershell
$env:F1DB_DATA_DIR = "data/samples"
python -m pytest -m integration
```

## Next steps

1. Complete the schema research in `docs/schema-research.md` (entities,
   identifiers, cardinalities, normalisation trade-offs).
2. Translate that research into SQL DDL under `sql/`.
3. Add transformations in `src/transform/` and loading code in `src/load/`.
4. Decide on an application/frontend layer only after the data model is stable.

## Notes

DeltaTrace is an unofficial student project and is not associated with Formula 1,
the FIA, or OpenF1.
