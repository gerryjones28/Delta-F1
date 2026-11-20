"""Delta F1 source package.

Pipeline layout (populated as the project grows):

``src.extract``  - OpenF1 API and F1DB CSV extraction
``src.transform`` - ETL transformations (not implemented yet)
``src.load``      - PostgreSQL loading and the read-only connection utilities
``src.analysis``  - analysis of telemetry already stored in PostgreSQL
"""

__all__ = ["extract", "transform", "load", "analysis"]
