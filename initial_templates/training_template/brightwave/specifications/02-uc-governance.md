# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_campaign_perf`

Source: `gold_campaign_position`. Single view, aggregated materialization — the **one governed definition** of Brightwave's campaign-performance metrics (dashboard tiles, Genie, the app all read these).

**Dimensions**: `channel`, `category`, `perf_band`, `target_segment`, `campaign_id`.

**Measures**:

| Name | Expression |
|------|------------|
| `recoverable_spend` | `SUM(recoverable_spend_usd)` |
| `total_spend` | `SUM(spend_to_date_usd)` |
| `attributed_revenue` | `SUM(attributed_revenue_usd)` |
| `avg_roas` | `AVG(roas)` |
| `campaign_count` | `COUNT(1)` |
| `winner_count` | `SUM(CASE WHEN perf_band = 'winner' THEN 1 ELSE 0 END)` |
| `underperformer_count` | `SUM(CASE WHEN perf_band = 'underperformer' THEN 1 ELSE 0 END)` |

Count/flag measures use `SUM(CASE WHEN … )` so they compute at the filtered-slice level. `avg_roas` is a coarse signal, not a headline tile (recoverable spend + underperformer count + the winner-vs-underperformer ROAS gap are the tiles).

**Materialization**: aggregated on `(channel, category, perf_band, target_segment) × all measures`, refresh every 6h.

### Consumers

- **Dashboard KPI tiles** — Recoverable spend ($), Underperformers (#), Winners (#), Avg ROAS (winners vs underperformers) — via `MEASURE(...)`.
- **Genie headline answers** — "how much spend is recoverable?", "how many underperformers?", "what's the ROAS gap between winners and underperformers?".
- **The app's KPI cards** — the Campaign Desk reads the same measures (via warehouse SQL over the MV).

> The ROAS-lift model (`03-ml-roas.md`) does **not** consume `mv_campaign_perf`. It trains on `gold_action_outcomes` and scores `gold_open_underperformers` — different grain.

### Validation

- `MEASURE(recoverable_spend)` on underperformers ≈ $13M on the sample (matches the raw gold rollup ≈ $13.4M; the $40M is the full-year-budget talking-track).
- `MEASURE(underperformer_count)` ≈ 89; `MEASURE(winner_count)` ≈ 61.
- `MEASURE(avg_roas)` filtered to `perf_band='winner'` ≈ 4.0; to `perf_band='underperformer'` ≈ 1.1.
- Genie's "how much spend is recoverable?" matches `MEASURE(recoverable_spend)` for that slice.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
