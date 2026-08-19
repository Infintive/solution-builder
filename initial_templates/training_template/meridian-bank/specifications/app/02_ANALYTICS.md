# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard, useful for one or two drill-downs tied to the story. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`attrition_risk_trend.sql`** — daily/weekly `AVG(attrition_risk_score)` on the affected cohort vs the rest of the book, last ~8 weeks, from `silver_risk` (needs the full risk-snapshot history, not just the current snapshot — read `raw_risk_snapshots` or a silver history table). *The line that tells the competitor-promo story: the affected cohort's risk ramps ~3 weeks ago while the rest stays flat — the divergence, in one chart.*
- **`highest_revenue_at_risk.sql`** — top at-risk customers by `revenue_at_risk_usd` from `gold_customer_position WHERE risk_band IN ('critical','elevated')`: customer_id, tier, tenure_years, total_balance, attrition_risk, revenue-at-risk $. *CUST-0000214 near the top.*
- **`risk_mix_by_tier.sql`** — customer count by `tier` × `risk_band` from `gold_customer_position`. *affluent/private = mostly critical/elevated, mass = mostly healthy — the split as a grouped bar.*
- **`nba_recommendations.sql`** *(optional)* — the model's recommended-action mix + `SUM(predicted_retained_usd)` from `gold_nba_recommendations`. *What the NBA model recommends across the book + the retainable revenue.*

Each `.sql` uses bare/`${catalog}.${schema}` table names that the app resolves to the demo's catalog + schema at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Customer drill-down (optional)

A small panel: pick a tier → list its worst at-risk customers → click a customer → navigate to `/relationships?customer=<customer_id>` (the Relationships queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to customers.
