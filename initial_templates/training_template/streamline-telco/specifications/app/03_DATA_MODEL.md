# Data Model

> **This is the Milestone 2 (Lakebase) answer key.** A UC synced table is **read-only** in Postgres, so the app's write actions need a separate writable table. One **synced read-only** subscriber-position table + one **writable** care-actions table.

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + synced read-only mirrors + a writable table for care actions.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock`/`default`), timestamps |
| `messages` | conversationId, role, content, position, traceId, thinking (JSONB), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Streamline-specific)

Read-only from the app (UC synced tables). SELECT for sub-ms per-subscriber reads; never written.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `subscriber_position` | `gold_subscriber_position` | subscriberId, planType, tenureMonths, monthlyArpuUsd, serviceNodeId, homeMetro, **subLat**, **subLng** (drives the map), serviceSummary, churnRiskScore, churnReason (`service`/`price`/`device`), openTicketCount, hasOpenOutage, hasOpenBilling, churnSignalScore (0–1 from `ai_classify`), clvAtRiskUsd, **riskBand** (`critical`/`elevated`/`watch`/`healthy`) |
| `open_atrisk` | `gold_open_atrisk` | subscriberId (PK), churnRiskScore, clvAtRiskUsd, churnReason, hasOpenOutage, hasOpenBilling, monthlyArpuUsd, candidateOfferId |
| `retention_recommendations` | `gold_retention_recommendations` (pipeline heuristic; optionally the ML model in `03-ml-churn.md`) | subscriberId (PK), recommendedOffer (`bill_credit`/`plan_upgrade_discount`/`device_upgrade`), predictedRetainedClvUsd (double), predictedNetValueUsd (double), offerRanking (JSONB — all three options), scoredAt (timestamp) |
| `offers` | `raw_offers` (synced) | **offerId** (PK), offerName, offerType, valueUsd, segment, **description** (STRING — searchable), isActive. Indexed by **Lakebase Search** (Milestone 2) over (name, description). |

The `retention_recommendations` table is **read-only from the app** — the model's predictions kept in Lakebase so `rank_offers` is sub-second. The model lives in UC (`{catalog}.{schema}.churn_recommender`, `@prod`); the app never calls it. `offerRanking` (JSONB) powers the ranked-options list + arithmetic what-if.

The `offers` table is a **read-only synced mirror**; the agent's `search_history` tool ALSO uses **Lakebase Search** over the subscriber's `service_summary` (+ the tickets/network-events history if you mirror it) to explain *why* a subscriber is at risk — the outage + billing history — without reading irrelevant data.

### Writable operational table (app writes here — the Milestone-2 writable-table requirement)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `care_actions` | the app / agent's `execute_retention_action` | id (PK), subscriberId, offerType (`bill_credit`/`plan_upgrade_discount`/`device_upgrade`), offerId (nullable), draftedSummary (text — the call-resolution summary), predictedRetainedClvUsd, status (`proposed`/`approved`/`executed`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB), createdAt, decidedAt |

`care_actions` is the **only** table the app writes. An approved offer inserts/updates a row here. The Care Desk derives a subscriber's live state by LEFT JOIN-ing `subscriber_position` → its latest `care_actions` row (so "offer applied" + the badge come from the writable table). The append-only `auditTrail` makes each action a standalone timeline the drawer's Activity tab renders.

## Delta → Lakebase sync

> **Talking-track vs build:** production uses **Lakebase Synced Tables** (managed, continuous). For the demo build: a manual one-shot sync at boot. Same outcome on screen.

1. If synced mirror tables empty → pull via the Databricks SQL Statements API: `subscriber_position` (the at-risk + a sample of healthy subscribers), `open_atrisk`, `retention_recommendations`, and the **`offers`** catalog (all — small, static).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `care_actions` is **not** synced (the app's own writable state) — starts empty.
4. "Reset demo" → truncate `care_actions` + re-sync the read-only mirrors. All agent writes wiped; at-risk subscribers return to their band, KPIs return to full.

Source tables from `config/app.json` `data.tables`.

## Lakebase provisioning

1. Create Lakebase Postgres project + database.
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod).
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.
