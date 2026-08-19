# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`roas_trend.sql`** — daily/weekly `AVG(roas)` on the winner cluster vs the underperformer cluster, last ~8 weeks, from `silver_perf` (needs the full perf-snapshot history — read `raw_perf_snapshots` or a silver history table). *The line that tells the divergence story: the two clusters split apart over the quarter.*
- **`worst_underperformers.sql`** — top underperformers by `recoverable_spend_usd` from `gold_campaign_position WHERE perf_band='underperformer'`: campaign_id, channel, category, roas, recoverable spend $. *CMP-0000214 near the top.*
- **`perf_mix_by_channel.sql`** — campaign count by `channel` × `perf_band` from `gold_campaign_position`. *social carries winners, display carries underperformers.*
- **`action_mix.sql`** *(optional)* — the model's recommended-action mix + `SUM(predicted_net_value_usd)` from `gold_action_recommendations`.

Each `.sql` uses bare/`${catalog}.${schema}` table names resolved at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Campaign drill-down (optional)

A small panel: pick a channel → list its worst underperformers → click a campaign → navigate to `/campaign-desk?campaign=<campaign_id>` (the queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to campaigns.
