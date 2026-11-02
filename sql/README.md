# SQL

Database schema and analysis queries. **Empty on purpose** for now - the
relational design (tables, primary keys, foreign keys, normalisation) is being
researched independently and has not been decided.

Suggested layout once the design is settled:

```
sql/
├── schema/           # DDL: CREATE TABLE, constraints, indexes
├── queries/          # reusable analysis queries
└── README.md
```

Conventions to adopt when the first files land: UTF-8, lower_snake_case
identifiers, one statement per file where practical, and a header comment naming
the source tables.
