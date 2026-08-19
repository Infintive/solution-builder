# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_segment_conv`

Source: `gold_segment_position`. Single view, aggregated materialization — the **one governed definition** of Nimbus's conversion metrics (dashboard tiles, Genie, the app all read these).

**Dimensions**: `cohort`, `platform`, `conv_band`, `region`, `segment_id`.

**Measures**:

| Name | Expression |
|------|------------|
| `conversion_at_risk` | `SUM(conversion_at_risk_usd)` |
| `total_mau` | `SUM(mau)` |
| `avg_conversion` | `AVG(conversion_rate)` |
| `segment_count` | `COUNT(1)` |
| `sliding_count` | `SUM(CASE WHEN conv_band = 'sliding' THEN 1 ELSE 0 END)` |
| `watch_count` | `SUM(CASE WHEN conv_band = 'watch' THEN 1 ELSE 0 END)` |
| `atrisk_count` | `SUM(CASE WHEN conv_band IN ('sliding','watch') THEN 1 ELSE 0 END)` |
| `avg_slide_signal` | `AVG(slide_signal_score)` |

Count/flag measures use `SUM(CASE WHEN … )` so they compute at the filtered-slice level. `avg_conversion` is the headline funnel-health signal; `conversion_at_risk` + `sliding_count` are the alarm tiles.

**Materialization**: aggregated on `(cohort, platform, conv_band, region) × all measures`, refresh every 6h.

### Consumers

- **Dashboard KPI tiles** — Conversion at risk ($), Sliding segments (#), Avg conversion (by band), MAU at risk (#) — via `MEASURE(...)`.
- **Genie headline answers** — "how much conversion is at risk?", "how many segments are sliding?", "what's the conversion gap?".
- **The app's KPI cards** — the Growth Desk reads the same measures (via warehouse SQL over the MV).

> The conversion model (`03-ml-conversion.md`) does **not** consume `mv_segment_conv`. It trains on `gold_experiment_outcomes` and scores `gold_open_sliding` — different grain.

### Validation

- `MEASURE(conversion_at_risk)` on sliding ≈ $10M annualized (matches the raw gold rollup ≈ $9.8M).
- `MEASURE(sliding_count)` ≈ 40; `MEASURE(atrisk_count)` ≈ 40.
- `MEASURE(avg_conversion)` filtered to `conv_band='healthy'` ≈ 0.04; to `conv_band='sliding'` ≈ 0.028.
- Genie's "how much conversion is at risk?" matches `MEASURE(conversion_at_risk)` for that slice.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
