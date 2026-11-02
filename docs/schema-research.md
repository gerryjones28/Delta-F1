# Schema research (working document)

Status: **in progress - owned by the project author.**
The scaffolding in this repository intentionally makes no schema decisions. Fill
this in as the research progresses, then translate the outcome into SQL DDL under
`sql/`.

## 1. Scope of the analysis questions

- Which performance questions must the database answer? (pace delta, stint
  degradation, qualifying vs race, team-mate comparison, ...)
- Which questions are out of scope for this iteration?

## 2. Candidate entities

| Entity | Source (OpenF1 / F1DB / both) | Notes |
| --- | --- | --- |
| Season | | |
| Meeting / event | | |
| Session | | |
| Circuit | | |
| Driver | | |
| Team / constructor | | |
| Car entry / participation | | |
| Lap | | |
| Stint | | |
| Telemetry sample | | |
| Result / classification | | |

## 3. Candidate identifiers

Record the natural and surrogate identifiers observed in each source, and note
which ones are stable across sources. No decision required yet.

| Entity | Source-provided identifier | Candidate key | Stability concerns |
| --- | --- | --- | --- |
| | | | |

## 4. Relationships and cardinality

Sketch the relationships you settle on, with cardinality and optionality.

- [ ] ...
- [ ] ...

## 5. Normalisation decisions

- Target normal form:
- Intentional denormalisation and why:
- Handling of multi-source rows (OpenF1 vs F1DB overlap):

## 6. Data-quality and integrity rules

- Enumerations / allowed values:
- Uniqueness constraints:
- Nullability rules:
- Timezone and precision conventions:

## 7. Open questions

- ...
