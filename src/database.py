"""Connection settings for the read-only analysis service."""
import os

import psycopg
from dotenv import dotenv_values

from src.paths import PROJECT_ROOT


class ConfigurationError(RuntimeError):
    pass


def load_database_url() -> str:
    if url := os.getenv("DATABASE_URL"):
        return url
    if not os.getenv("VERCEL"):
        for folder in (PROJECT_ROOT, PROJECT_ROOT.parent):
            if (folder / ".env").is_file():
                if url := dotenv_values(folder / ".env").get("DATABASE_URL"):
                    return url
                break
    raise ConfigurationError("DATABASE_URL is required")


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, sslmode="require", connect_timeout=10,
                           prepare_threshold=None)
