# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_customer_risk`

Source: `gold_customer_position` (the current per-customer position). Single view, aggregated materialization. This is the **one governed definition** of Meridian's attrition-exposure metrics — the dashboard KPI tiles, Marcus's Genie answers, and the app all read these same measures, so the numbers match wherever he looks.

**Dimensions**: `tier`, `segment` (derive a coarse `segment` on the position if useful, or drop it and keep `tier`), `risk_band`, `home_metro`, `customer_id`.

> NOTE: `gold_customer_position` is per-customer (not per-segment). Keep the metric view's dimensions to what the position row carries: `tier`, `risk_band`, `home_metro`. If a `segment` filter is wanted on the dashboard, add it as a derived column on the gold table first (e.g. the customer's dominant holding segment).

**Measures** (full list — referenced verbatim by dashboard datasets + Genie example SQLs + the app's KPI tiles, so any rename here is a breaking change downstream):

| Name | Expression |
|------|------------|
| `balance_at_risk` | `SUM(balance_at_risk_usd)` |
| `revenue_at_risk` | `SUM(revenue_at_risk_usd)` |
| `total_balance` | `SUM(total_balance_usd)` |
| `customer_count` | `COUNT(1)` |
| `critical_count` | `SUM(CASE WHEN risk_band = 'critical' THEN 1 ELSE 0 END)` |
| `elevated_count` | `SUM(CASE WHEN risk_band = 'elevated' THEN 1 ELSE 0 END)` |
| `atrisk_count` | `SUM(CASE WHEN risk_band IN ('critical','elevated') THEN 1 ELSE 0 END)` |
| `avg_attrition_risk` | `AVG(attrition_risk_score)` |
| `avg_churn_signal` | `AVG(churn_signal_score)` |

Count/flag measures use `SUM(CASE WHEN … )` (not `MEASURE(x)/MEASURE(y)`) so the engine computes them at the filtered-slice level — correct under any global dashboard filter and safe on empty slices. `avg_attrition_risk` is an average of a per-row score; it's a coarse health signal, not a KPI tile (the two exposure $ measures + the at-risk count are the tiles).

**Materialization**: aggregated on `(tier, risk_band, home_metro) × all measures`, refresh every 6h. (The position table is a daily snapshot, so 6h refresh comfortably covers it.)

### Consumers

- **Dashboard KPI tiles** — Balance-at-risk ($), Revenue-at-risk ($), At-risk customers (#), Critical customers (#) — all via `MEASURE(...)`.
- **Genie headline answers** — "how much balance is at risk?", "what's our revenue-at-risk?", "how many customers are critical?" resolve to these measures. Per-widget bindings live in `04-ai-bi.md`.
- **The app's KPI cards** — the RM page reads the same measures (via warehouse SQL over the MV) so the app header matches the dashboard exactly.

> The NBA model (`03-ml-nba.md`) does **not** consume `mv_customer_risk`. It trains on `gold_campaign_outcomes` (per-action history) and scores `gold_open_atrisk` (per-customer) — different grain. `mv_customer_risk` is the aggregated exposure layer; do not unify.

### Validation

- `MEASURE(balance_at_risk)` filtered to `risk_band='critical'` ≈ $150M+; `MEASURE(revenue_at_risk)` across at-risk ≈ $4M (matches the raw gold rollup: `SUM(balance_at_risk_usd)` ≈ $159M).
- `MEASURE(critical_count)` ≈ 220; `MEASURE(atrisk_count)` ≈ 235.
- Genie's answer to "how much balance is at risk?" matches `MEASURE(balance_at_risk)` for that slice exactly.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
