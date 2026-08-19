# Data Model

> **This is the Milestone 2 (Lakebase) answer key.** The scenario asks teams to sync a governed UC table into Lakebase AND model a writable operational table — a UC synced table is **read-only** in Postgres, so the app's write actions need a separate writable table. This spec encodes exactly that: one **synced read-only** panel table + one **writable** actions table.

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + synced read-only mirrors of the panel/recommendation data + a writable table for care actions.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock`/`default`), timestamps |
| `messages` | conversationId, role, content, position, traceId, thinking (JSONB), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Cedar-specific)

Read-only from the app (UC synced tables). The app SELECTs for sub-ms per-patient reads; never writes them.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `patient_position` | `gold_patient_panel` | patientId, primaryCondition, ageBand, payer, homeMetro, **patientLat**, **patientLng** (drives the map), clinicalSummary (de-identified), daysSinceDischarge, readmissionRiskScore, openGapCount, hasOpenFollowup, hasOpenMedRecon, riskSignalScore (0–1 from `ai_classify`), severityWeight, readmissionExposureUsd, **riskBand** (`critical`/`elevated`/`watch`/`stable`) |
| `open_atrisk` | `gold_open_atrisk` | patientId (PK), readmissionRiskScore, readmissionExposureUsd, daysSinceDischarge, hasOpenFollowup, hasOpenMedRecon, severityWeight, capacityHeadroomHours, candidateProviderId |
| `intervention_recommendations` | `gold_intervention_recommendations` (pipeline heuristic; optionally the ML model in `03-ml-intervention.md`) | patientId (PK), recommendedIntervention (`followup_call`/`med_reconciliation`/`home_health_referral`), recommendedProviderId, predictedRiskReduction (double), predictedNetValueUsd (double), interventionRanking (JSONB — all three options), scoredAt (timestamp) |
| `providers` | `raw_providers` (synced) | **providerId** (PK), providerName, specialty, programType (`home_health`/`pcp`/`cardiology`/`pulmonology`), **description** (STRING — searchable), acceptingReferrals. Indexed by **Lakebase Search** (Milestone 2) over (name, description) for the home-health-referral lookup. |

The `intervention_recommendations` table is **read-only from the app** — the model's predictions kept in Lakebase so the agent's `rank_interventions` lookup is sub-second. The model lives in UC (`{catalog}.{schema}.intervention_recommender`, `@prod`); the app never calls it. `interventionRanking` (JSONB) powers the ranked-options list + arithmetic what-if.

The `providers` table is a **read-only synced mirror**; the agent's `search_providers` tool queries it via **Lakebase Search** to find a suitable home-health program when ranking the **home-health referral** intervention (hybrid text/vector over name + description).

### Writable operational table (app writes here — the Milestone-2 writable-table requirement)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `care_actions` | the app / agent's `execute_care_action` | id (PK), patientId, interventionType (`followup_call`/`med_reconciliation`/`home_health_referral`), providerId (nullable), draftedNote (text — the care-plan summary), predictedRiskReduction, status (`proposed`/`approved`/`executed`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB), createdAt, decidedAt |

`care_actions` is the **only** table the app writes. An approved intervention inserts/updates a row here. The Patient Panel derives a patient's live state by LEFT JOIN-ing `patient_position` → its latest `care_actions` row (so "intervention assigned" + the badge come from the writable table). The append-only `auditTrail` makes each action a standalone timeline the drawer's Activity tab renders.

## Delta → Lakebase sync

> **Talking-track vs build:** production uses **Lakebase Synced Tables** (managed, continuous). For the demo build we keep it simple: a manual one-shot sync at boot. Same outcome on screen.

1. If synced mirror tables empty → pull via the Databricks SQL Statements API: `patient_position` (the at-risk + a sample of stable patients), `open_atrisk`, `intervention_recommendations`, and the **`providers`** directory (all — small, static).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `care_actions` is **not** synced (the app's own writable state) — starts empty.
4. "Reset demo" → truncate `care_actions` + re-sync the read-only mirrors. All agent writes wiped; at-risk patients return to their band, KPIs return to full.

Source tables from `config/app.json` `data.tables`.

## Lakebase provisioning

1. Create Lakebase Postgres project + database.
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod).
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.
