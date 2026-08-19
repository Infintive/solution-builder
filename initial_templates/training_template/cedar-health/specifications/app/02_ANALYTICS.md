# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`readmission_risk_trend.sql`** — daily/weekly `AVG(readmission_risk_score)` on the affected cohort vs the rest of the panel, last ~8 weeks, from `silver_risk` (needs the full risk-snapshot history — read `raw_risk_snapshots` or a silver history table). *The line that tells the discharge-wave story: the affected cohort's risk ramps ~3 weeks ago while the rest stays flat.*
- **`highest_exposure_patients.sql`** — top at-risk patients by `readmission_exposure_usd` from `gold_patient_panel WHERE risk_band IN ('critical','elevated')`: patient_id, condition, days_since_discharge, risk, open_gap_count, exposure $. *PT-0000214 near the top.*
- **`risk_mix_by_condition.sql`** — patient count by `primary_condition` × `risk_band` from `gold_patient_panel`. *HF/COPD/PNA/AMI = mostly critical/elevated, others = mostly stable.*
- **`intervention_mix.sql`** *(optional)* — the model's recommended-intervention mix + `SUM(predicted_risk_reduction)` from `gold_intervention_recommendations`.

Each `.sql` uses bare/`${catalog}.${schema}` table names resolved at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Patient drill-down (optional)

A small panel: pick a condition → list its worst at-risk patients → click a patient → navigate to `/panel?patient=<patient_id>` (the queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to patients.
