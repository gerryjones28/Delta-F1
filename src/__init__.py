"""DeltaTrace source package.

Pipeline layout (populated as the project grows):

``src.extract``  - OpenF1 API and F1DB CSV extraction
``src.transform`` - ETL transformations (not implemented yet)
``src.load``      - PostgreSQL loading (not implemented yet)
"""

__all__ = ["extract", "transform", "load"]
