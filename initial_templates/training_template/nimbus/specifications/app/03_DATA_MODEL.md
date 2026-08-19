# Data Model

> **This is the Milestone 2 (Lakebase) answer key.** A UC synced table is **read-only** in Postgres, so the app's write actions need a separate writable table. One **synced read-only** segment-position table + one **writable** feature-decisions table the product reads at low latency (scale-to-zero when idle).

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + synced read-only mirrors + a writable table for the served feature-flag decisions.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock`/`default`), timestamps |
| `messages` | conversationId, role, content, position, traceId, thinking (JSONB), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Nimbus-specific)

Read-only from the app (UC synced tables). SELECT for sub-ms per-cohort reads; never written.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `segment_position` | `gold_segment_position` | segmentId, cohort, platform, region, mau, segmentSummary, conversionRate, conversionRate3wAgo, conversionDrop, sessions, slideSignalScore (0–1 from `ai_classify`), conversionAtRiskUsd, **convBand** (`sliding`/`watch`/`healthy`) |
| `open_sliding` | `gold_open_sliding` | segmentId (PK), cohort, platform, mau, conversionRate, conversionDrop, conversionAtRiskUsd, hasMatchingExperiment (bool), matchingExperimentId, matchingExperimentLift, neighborFlagKey |
| `action_recommendations` | `gold_action_recommendations` (pipeline heuristic; optionally the ML model in `03-ml-conversion.md`) | segmentId (PK), recommendedAction (`ship_proven_variant`/`rollout_existing_flag`/`ship_alt_variant`), predictedConversionLift (double), predictedNetValueUsd (double), actionRanking (JSONB — all three options), scoredAt (timestamp) |
| `experiments` | `raw_experiments` (synced) | **experimentId** (PK), experimentName, variant, featureArea, testedCohort, testedPlatform, won, observedLift, **description** (STRING — hypothesis + result, searchable), isActive. Indexed by **Lakebase Search** (Milestone 2) over (name, description). |

The `action_recommendations` table is **read-only from the app** — the model's predictions kept in Lakebase so `rank_actions` is sub-second. The model lives in UC (`{catalog}.{schema}.conversion_recommender`, `@prod`); the app never calls it. `actionRanking` (JSONB) powers the ranked-options list + arithmetic what-if.

The `experiments` table is a **read-only synced mirror**; the agent's `search_experiments` tool queries it via **Lakebase Search** to ground *which feature won for a similar cohort* (hybrid text/vector over name + description) — the evidence behind the **ship_proven_variant** play.

### Writable operational table (app writes here — the Milestone-2 writable-table requirement; the product reads it)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `feature_decisions_app` | the app / agent's `execute_feature_decision` | id (PK), segmentId, actionType (`ship_proven_variant`/`rollout_existing_flag`/`ship_alt_variant`), targetExperimentId (nullable), flagKey, variant, rolloutPct, draftedNote (text — the rollout note the agent wrote), predictedConversionLift, status (`proposed`/`approved`/`shipped`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB), createdAt, decidedAt |

`feature_decisions_app` is the **only** table the app writes — and **the product reads it at low latency** to serve the flag (the "a human decision takes effect for real users at machine speed" beat). An approved decision inserts/updates a row here. The Growth Desk derives a cohort's live state by LEFT JOIN-ing `segment_position` → its latest `feature_decisions_app` row (so "shipping" + the badge come from the writable table). The append-only `auditTrail` makes each decision a standalone timeline the drawer's Activity tab renders.

## Delta → Lakebase sync

> **Talking-track vs build:** production uses **Lakebase Synced Tables** (managed, continuous). For the demo build: a manual one-shot sync at boot. Same outcome on screen.

1. If synced mirror tables empty → pull via the Databricks SQL Statements API: `segment_position` (the sliding + a sample of healthy cohorts), `open_sliding`, `action_recommendations`, and the **`experiments`** catalog (all — small, static).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `feature_decisions_app` is **not** synced (the app's own writable state — the served flag) — starts empty.
4. "Reset demo" → truncate `feature_decisions_app` + re-sync the read-only mirrors. All agent writes wiped; sliding cohorts return to their band, KPIs return to full.

Source tables from `config/app.json` `data.tables`.

## Lakebase provisioning

1. Create Lakebase Postgres project + database (scale-to-zero for near-zero idle cost — the DNB scale point).
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod).
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.
