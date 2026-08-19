# Data Model

> **This is the Build 1 (Lakebase) answer key.** The enablement scenario's Build 1 asks teams to sync a governed UC table into Lakebase AND model a writable operational table — because a UC synced table is **read-only** in Postgres (only SELECT / CREATE INDEX / DROP TABLE), so the app's write actions need a separate writable table next to it. This spec encodes exactly that: one **synced read-only** position table + one **writable** actions table.

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse queries + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + a synced read-only mirror of the position/recommendation data the RM screen reads + a writable table the app records actions to.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock` / `default`), timestamps |
| `messages` | conversationId, role, content, position, traceId (MLflow), thinking (JSONB — tool calls + reasoning for reload-safe history), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Meridian-specific)

These mirror Gold/Delta tables and are **read-only from the app** (in Build 1 terms, UC synced tables). The app SELECTs from them for sub-ms per-customer reads; it never writes them.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `customer_position` | `gold_customer_position` | customerId, tier, tenureYears, homeMetro, **customerLat**, **customerLng** (DOUBLE PRECISION — drives the Relationships map/scatter), profileSummary, attritionRiskScore, balanceOutflow30dUsd, churnSignalScore (0–1 from `ai_classify`, pass-through), totalBalanceUsd, depositBalanceUsd, affectedDepositBalanceUsd, minDaysToMaturity, productCount, balanceAtRiskUsd, revenueAtRiskUsd, **riskBand** (`critical`/`elevated`/`watch`/`healthy` — the UI colors the scatter + badges by this) |
| `open_atrisk` | `gold_open_atrisk` | customerId (PK), attritionRiskScore, balanceAtRiskUsd, revenueAtRiskUsd, atriskProductId, atriskBalanceUsd, daysToMaturity, currentRateApy, candidateCrossSellProductId |
| `nba_recommendations` | `gold_nba_recommendations` (built by the SDP pipeline heuristic; optionally overwritten by the ML model in `03-ml-nba.md`) | customerId (PK), recommendedAction (`retention_offer`/`cross_sell`/`rm_outreach`), recommendedOfferProductId, recommendedRateApy, predictedRetainedUsd (double), predictedNetValueUsd (double), actionRanking (JSONB — all three options with predicted retained $ + net $ + cost), scoredAt (timestamp) |
| `products` | `raw_products` (synced from Delta) | **productId** (PK), productName, productType, segment, rateApy, minBalanceUsd, **description** (STRING — searchable text on features + eligibility for matching cross-sells), isActive. Indexed by **Lakebase Search** (Milestone 2) for hybrid text/vector retrieval over (name, description). |

The `nba_recommendations` table is **read-only from the app** — a copy of the model's predictions kept in Lakebase so the agent's `rank_next_best_actions` lookup is sub-second. The model itself lives in Unity Catalog (`{catalog}.{schema}.nba_recommender`, `@prod`); the app never calls it directly. `actionRanking` (JSONB) is what powers the ranked-options list + the arithmetic what-if in the drawer.

The `products` table is a **read-only synced mirror** of the product catalog. Unlike `customer_position` (which reflects current risk), `products` is relatively static and serves two purposes: (1) the **product search** affordance in the UI uses it to populate a cross-sell-candidate lookup, (2) the agent's `search_products` tool queries it via **Lakebase Search** to find products a customer qualifies for but doesn't hold when ranking the **cross-sell** action. **Lakebase Search** is a Milestone-2 Lakebase capability (hybrid text/vector indexes over the product name + description fields); the app's `search_products` tool issues hybrid search queries to find products by semantic similarity (e.g., "wealth advisory for an affluent long-tenure customer" matches the Wealth Advisory Account).

### Writable operational table (app writes here — the Build 1 writable-table requirement)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `rm_actions` | the app / agent's `execute_nba_action` | id (PK), customerId, actionType (`retention_offer`/`cross_sell`/`rm_outreach`), offeredProductId (nullable), rateApy (nullable), draftedNote (text — the outreach note the agent wrote), predictedRetainedUsd, status (`proposed`/`approved`/`executed`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB array), createdAt, decidedAt |

`rm_actions` is the **only** table the app writes. An approved retention offer inserts/updates a row here (action + drafted note + who approved). The Relationships queue derives a customer's live state by LEFT JOIN-ing `customer_position` → its latest `rm_actions` row (so "action in progress" + the action badge come from the writable table, and the read-only synced position is never mutated). The append-only `auditTrail` makes each action row a standalone timeline the drawer's Activity tab renders from one read — and the regulator-defensible audit the story promises.

## Delta → Lakebase sync

> **Talking-track vs build:** in production this is **Lakebase Synced Tables** — managed, continuous Delta→Lakebase replication with the same UC governance ("the Gold tables your pipeline produces are synced into Lakebase automatically"). For the demo build we keep it simple: a manual one-shot sync at boot, code we can show, no extra resource. Same outcome on screen. (In the enablement build, teams set up the actual synced table — this manual sync is the app-template's stand-in so the demo boots without the Build-1 wiring.)

1. If synced mirror tables empty → pull via Databricks SQL Statements API: `customer_position` (the at-risk + a sample of healthy customers), `open_atrisk`, `nba_recommendations` for the same at-risk set, and the **`products`** catalog (all products — small, static; feeds the product search / cross-sell lookup).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `rm_actions` is **not** synced (it's the app's own writable state) — it starts empty.
4. "Reset demo" button → clean slate: truncate `rm_actions` + re-sync the read-only mirrors. **All agent writes are wiped** — every action clears, at-risk customers return to their band, KPI exposure returns to full. Intentional: between presentations Marcus wants the backlog to look untouched.

Source tables from `config/app.json` `data.tables` (maps logical names → Delta table names, used by sync + analytics queries).

## Lakebase provisioning

1. Create Lakebase Postgres project + database in the workspace.
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod). `databricks apps run-local` injects env vars from the bound resource.
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.
