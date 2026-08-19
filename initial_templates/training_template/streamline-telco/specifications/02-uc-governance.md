# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_subscriber_risk`

Source: `gold_subscriber_position`. Single view, aggregated materialization — the **one governed definition** of Streamline's churn-exposure metrics (dashboard tiles, Genie, the app all read these).

**Dimensions**: `plan_type`, `churn_reason`, `risk_band`, `home_metro`, `service_node_id`, `subscriber_id`.

**Measures**:

| Name | Expression |
|------|------------|
| `clv_at_risk` | `SUM(clv_at_risk_usd)` |
| `open_tickets` | `SUM(open_ticket_count)` |
| `subscriber_count` | `COUNT(1)` |
| `critical_count` | `SUM(CASE WHEN risk_band = 'critical' THEN 1 ELSE 0 END)` |
| `elevated_count` | `SUM(CASE WHEN risk_band = 'elevated' THEN 1 ELSE 0 END)` |
| `atrisk_count` | `SUM(CASE WHEN risk_band IN ('critical','elevated') THEN 1 ELSE 0 END)` |
| `avg_churn_risk` | `AVG(churn_risk_score)` |
| `avg_churn_signal` | `AVG(churn_signal_score)` |

Count/flag measures use `SUM(CASE WHEN … )` so they compute at the filtered-slice level. `avg_*` are coarse signals, not KPI tiles (CLV-at-risk + open tickets + at-risk count are the tiles).

**Materialization**: aggregated on `(plan_type, churn_reason, risk_band, home_metro) × all measures`, refresh every 6h.

### Consumers

- **Dashboard KPI tiles** — CLV at risk ($), Open tickets (#), At-risk subscribers (#), Critical subscribers (#) — via `MEASURE(...)`.
- **Genie headline answers** — "what's our CLV at risk?", "how many open tickets?", "how many subscribers are critical?".
- **The app's KPI cards** — the Care page reads the same measures (via warehouse SQL over the MV).

> The churn model (`03-ml-churn.md`) does **not** consume `mv_subscriber_risk`. It trains on `gold_retention_outcomes` and scores `gold_open_atrisk` — different grain.

### Validation

- `MEASURE(clv_at_risk)` across at-risk ≈ $0.4M on the sample (matches the raw gold rollup ≈ $0.37M).
- `MEASURE(critical_count)` ≈ 200; `MEASURE(atrisk_count)` ≈ 215.
- Genie's "what's our CLV at risk?" matches `MEASURE(clv_at_risk)` for that slice.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
