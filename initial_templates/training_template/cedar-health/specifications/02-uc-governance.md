# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_patient_risk`

Source: `gold_patient_panel` (the current per-patient position). Single view, aggregated materialization. This is the **one governed definition** of Cedar's readmission-exposure metrics — the dashboard KPI tiles, Dr. Wren's Genie answers, and the app all read these same measures, so the numbers match wherever she looks.

**Dimensions**: `primary_condition`, `payer`, `risk_band`, `home_metro`, `patient_id`.

**Measures** (full list — referenced verbatim by dashboard datasets + Genie example SQLs + the app's KPI tiles, so any rename here is a breaking change downstream):

| Name | Expression |
|------|------------|
| `readmission_exposure` | `SUM(readmission_exposure_usd)` |
| `open_gaps` | `SUM(open_gap_count)` |
| `patient_count` | `COUNT(1)` |
| `critical_count` | `SUM(CASE WHEN risk_band = 'critical' THEN 1 ELSE 0 END)` |
| `elevated_count` | `SUM(CASE WHEN risk_band = 'elevated' THEN 1 ELSE 0 END)` |
| `atrisk_count` | `SUM(CASE WHEN risk_band IN ('critical','elevated') THEN 1 ELSE 0 END)` |
| `avg_readmission_risk` | `AVG(readmission_risk_score)` |
| `avg_risk_signal` | `AVG(risk_signal_score)` |

Count/flag measures use `SUM(CASE WHEN … )` (not `MEASURE(x)/MEASURE(y)`) so the engine computes them at the filtered-slice level — correct under any global dashboard filter and safe on empty slices. `avg_readmission_risk` is an average of a per-row score; it's a coarse health signal, not a KPI tile (the exposure $ + open gaps + at-risk count are the tiles).

**Materialization**: aggregated on `(primary_condition, payer, risk_band, home_metro) × all measures`, refresh every 6h. (The panel is a daily snapshot, so 6h refresh comfortably covers it.)

### Consumers

- **Dashboard KPI tiles** — Readmission exposure ($), Open care gaps (#), At-risk patients (#), Critical patients (#) — all via `MEASURE(...)`.
- **Genie headline answers** — "what's our readmission exposure?", "how many open care gaps?", "how many patients are critical?" resolve to these measures. Per-widget bindings live in `04-ai-bi.md`.
- **The app's KPI cards** — the Relationships/Panel page reads the same measures (via warehouse SQL over the MV) so the app header matches the dashboard exactly.

> The intervention model (`03-ml-intervention.md`) does **not** consume `mv_patient_risk`. It trains on `gold_intervention_outcomes` (per-intervention history) and scores `gold_open_atrisk` (per-patient) — different grain. `mv_patient_risk` is the aggregated exposure layer; do not unify.

### Validation

- `MEASURE(readmission_exposure)` across at-risk ≈ $2.5M (matches the raw gold rollup: `SUM(readmission_exposure_usd)` ≈ $2.47M).
- `MEASURE(critical_count)` ≈ 180; `MEASURE(atrisk_count)` ≈ 192.
- Genie's answer to "what's our readmission exposure?" matches `MEASURE(readmission_exposure)` for that slice exactly.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
