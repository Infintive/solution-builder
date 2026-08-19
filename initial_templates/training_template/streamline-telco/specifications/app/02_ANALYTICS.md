# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`churn_risk_trend.sql`** — daily/weekly `AVG(churn_risk_score)` on the affected cohort vs the rest of the base, last ~8 weeks, from `silver_risk` (needs the full risk-snapshot history — read `raw_risk_snapshots` or a silver history table). *The line that tells the outage story: the affected cohort's risk ramps ~3 weeks ago while the rest stays flat.*
- **`highest_clv_at_risk.sql`** — top at-risk subscribers by `clv_at_risk_usd` from `gold_subscriber_position WHERE risk_band IN ('critical','elevated')`: subscriber_id, plan, tenure, churn_reason, churn_risk, CLV at risk $. *SUB-0000214 near the top.*
- **`risk_mix_by_reason.sql`** — subscriber count by `churn_reason` × `risk_band` from `gold_subscriber_position`. *service dominates the critical band.*
- **`offer_mix.sql`** *(optional)* — the model's recommended-offer mix + `SUM(predicted_retained_clv_usd)` from `gold_retention_recommendations`.

Each `.sql` uses bare/`${catalog}.${schema}` table names resolved at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Subscriber drill-down (optional)

A small panel: pick a churn reason → list its worst at-risk subscribers → click a subscriber → navigate to `/care-desk?subscriber=<subscriber_id>` (the queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to subscribers.
