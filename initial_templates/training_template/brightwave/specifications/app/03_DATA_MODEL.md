# Data Model

> **This is the Milestone 2 (Lakebase) answer key.** A UC synced table is **read-only** in Postgres, so the app's write actions need a separate writable table. One **synced read-only** campaign-position table + one **writable** campaign-actions table.

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + synced read-only mirrors + a writable table for campaign actions.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock`/`default`), timestamps |
| `messages` | conversationId, role, content, position, traceId, thinking (JSONB), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Brightwave-specific)

Read-only from the app (UC synced tables). SELECT for sub-ms per-campaign reads; never written.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `campaign_position` | `gold_campaign_position` | campaignId, campaignName, channel, category, targetSegment, creativeId, campaignSummary, status, roas, spendToDateUsd, attributedRevenueUsd, perfSignal, recoverableSpendUsd, **perfBand** (`winner`/`underperformer`/`steady`/`paused`) |
| `open_underperformers` | `gold_open_underperformers` | campaignId (PK), channel, category, targetSegment, roas, recoverableSpendUsd, spendToDateUsd, hasMatchingWinner (bool), matchingWinnerCampaignId, matchingWinnerRoas, reallocateTargetCampaignId |
| `action_recommendations` | `gold_action_recommendations` (pipeline heuristic; optionally the ML model in `03-ml-roas.md`) | campaignId (PK), recommendedAction (`replicate_winner`/`reallocate_budget`/`pause`), predictedRoasLift (double), predictedNetValueUsd (double), actionRanking (JSONB — all three options), scoredAt (timestamp) |
| `creatives` | `raw_creatives` (synced) | **creativeId** (PK), creativeName, creativeType, angle, **description** (STRING — searchable), isActive. Indexed by **Lakebase Search** (Milestone 2) over (name, description) — grounds "why a winner works" + the replicate play. |

The `action_recommendations` table is **read-only from the app** — the model's predictions kept in Lakebase so `rank_actions` is sub-second. The model lives in UC (`{catalog}.{schema}.roas_recommender`, `@prod`); the app never calls it. `actionRanking` (JSONB) powers the ranked-options list + arithmetic what-if.

The `creatives` table is a **read-only synced mirror**; the agent's `search_creatives` tool queries it via **Lakebase Search** to ground *why a winning creative works* and to draft on-brand copy for the **replicate_winner** play (hybrid text/vector over name + description).

### Writable operational table (app writes here — the Milestone-2 writable-table requirement)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `campaign_actions_app` | the app / agent's `execute_campaign_action` | id (PK), campaignId, actionType (`replicate_winner`/`reallocate_budget`/`pause`), targetCampaignId (nullable — the winner replicated or the reallocation target), draftedBrief (text — the campaign brief the agent wrote), predictedRoasLift, status (`proposed`/`approved`/`executed`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB), createdAt, decidedAt |

`campaign_actions_app` is the **only** table the app writes. An approved action inserts/updates a row here. The Campaign Desk derives a campaign's live state by LEFT JOIN-ing `campaign_position` → its latest `campaign_actions_app` row (so "action taken" + the badge come from the writable table). The append-only `auditTrail` makes each action a standalone timeline the drawer's Activity tab renders.

## Delta → Lakebase sync

> **Talking-track vs build:** production uses **Lakebase Synced Tables** (managed, continuous). For the demo build: a manual one-shot sync at boot. Same outcome on screen.

1. If synced mirror tables empty → pull via the Databricks SQL Statements API: `campaign_position` (the underperformers + winners + a sample of steady), `open_underperformers`, `action_recommendations`, and the **`creatives`** catalog (all — small, static).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `campaign_actions_app` is **not** synced (the app's own writable state) — starts empty.
4. "Reset demo" → truncate `campaign_actions_app` + re-sync the read-only mirrors. All agent writes wiped; underperformers return to their band, KPIs return to full.

Source tables from `config/app.json` `data.tables`.

## Lakebase provisioning

1. Create Lakebase Postgres project + database.
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod).
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.
