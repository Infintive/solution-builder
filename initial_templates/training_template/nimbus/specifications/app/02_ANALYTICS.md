# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`conversion_trend.sql`** — daily/weekly `AVG(conversion_rate)` on the sliding cohorts vs the rest of the base, last ~8 weeks, from `silver_conv` (needs the full snapshot history — read `raw_conv_snapshots` or a silver history table). *The line that tells the change story: the affected cohorts' conversion slides ~3 weeks ago while the rest stays flat (and iOS ticks up).*
- **`worst_sliding.sql`** — top sliding cohorts by `conversion_at_risk_usd` from `gold_segment_position WHERE conv_band='sliding'`: segment_id, cohort, platform, conversion_rate, drop, at-risk $. *SEG-0000214 near the top.*
- **`slide_mix_by_platform.sql`** — cohort count by `platform` × `conv_band` from `gold_segment_position`. *android/web slide, iOS healthy.*
- **`action_mix.sql`** *(optional)* — the model's recommended-action mix + `SUM(predicted_net_value_usd)` from `gold_action_recommendations`.

Each `.sql` uses bare/`${catalog}.${schema}` table names resolved at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Cohort drill-down (optional)

A small panel: pick a platform → list its worst sliding cohorts → click a cohort → navigate to `/growth-desk?segment=<segment_id>` (the queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to segments.
