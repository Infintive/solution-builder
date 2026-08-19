# Brightwave Campaign Desk — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the campaign desk queue reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Build 3 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

A marketing campaign **CMP-0000214** is underperforming with a **~1.1 ROAS** on **$2.3M spend** (recoverable: $600K) — demand is there (high volumes), but the creative isn't resonating. Meanwhile, a sister campaign on **social + lifestyle** is delivering **~3.2 ROAS** on the same audience. The hero question: **"Which campaigns are winning and why, and how do I replicate the winner's creative across CMP-0000214?"** The app isolates the drivers, ranks the action (replicate winner / reallocate budget / pause), and executes it — all at the moment when the quarter is still in play and the action matters. AI Gateway attributes every content-generation call to this campaign so marketing can see the actual ROI on the agent's help.

The three layers map 1:1 to the enablement build arc: **Visualize (Build-1 Apps)** → **Assist (Build-2 Apps + the ML step)** → **Act (Build-2 Apps)**, all governed by **Unity AI Gateway (Build 3)**.

---

## The data (already generated + validated in `ai_demo_gen.brightwave`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.campaign_actions_app`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `campaign_position` | `gold_campaign_position` | yes (synced) | `id`(=`campaign_id`), `campaign_id`, `campaign_name`, `channel`, `category`, `target_segment`, `creative_id`, `campaign_summary`, `status`, `roas`, `spend_to_date_usd`, `attributed_revenue_usd`, `perf_signal`, `recoverable_spend_usd`, `perf_band` (`winner`/`underperformer`/`steady`/`paused`) |
| `open_underperformers` | `gold_open_underperformers` | yes (synced) | `campaign_id`, `channel`, `category`, `target_segment`, `roas`, `recoverable_spend_usd`, `spend_to_date_usd`, `has_matching_winner`, `matching_winner_campaign_id`, `matching_winner_roas`, `reallocate_target_campaign_id` |
| `action_recommendations` | `gold_action_recommendations` | yes (synced) | `campaign_id`, `recommended_action`, `predicted_roas_lift`, `predicted_net_value_usd`, `action_ranking` (JSONB: all three options) |
| `creatives` | `raw_creatives` | yes (synced) | `creative_id`, `creative_name`, `creative_type`, `angle`, `description` (searchable), `is_active` |
| **`campaign_actions_app`** | — (the app's own) | **NO — writable** | `id`(uuid), `campaign_id`, `action_type`, `target_campaign_id`, `drafted_brief`, `predicted_roas_lift`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_action_recommendations` is NOT built yet.** It is produced by the ML step of Build 2 (`specifications/03-ml-roas.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_action_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_actions` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/campaigns.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/campaigndesk.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/campaigns.ts` |
| The data-backend `ask_data` tool | already wired in `campaigndesk.ts` (delegates to `server/agent/tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by campaign desk UI |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `campaigndesk.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Build 1 (Lakebase) — already wired for you

The synced mirrors + the writable `campaign_actions_app` table are the Build-1 answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Build-1 workshop task in the workspace is to set up the **real Lakebase Synced Tables** for the four Gold tables and pick your **`ask_data` backend** (Genie space):

- Set **`GENIE_SPACE_ID`** in `.env` (or the DAB). The app registers the Genie space as the `ask_data` tool — no code change needed. Leave **`MAS_ENDPOINT_NAME` empty** (Brightwave uses Genie). The default Brightwave flow uses **Genie** ("ask which campaigns are winning and why").

**Acceptance:** open the app → chat → ask *"Which campaigns are winning and why is CMP-0000214 underperforming?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Build 2): `find_underperformer` + `rank_actions`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/campaigndesk.ts` that TELL the model to call these tools. Both tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented"`** until you implement them.

**What YOU build:** replace the two stub `execute` bodies in `server/agent/campaigndesk.ts`. The Lakebase query helpers are already written in `server/db/queries/campaigns.ts` — you mostly wire them up.

### 2a. `find_underperformer`

Read the live underperforming campaign for a campaign_id (or the worst underperformer) + its matching winner.

- **File:** `server/agent/campaigndesk.ts`, the tool named `find_underperformer` (search for `TODO — BUILD 2`).
- **Signature (already declared):** `find_underperformer({ campaign_id: string | null })`. `null` → return the worst underperformer.
- **Lakebase helpers to use** (from `server/db/queries/campaigns.ts`, imported at the top of `campaigndesk.ts`):
  - `getUnderperformer(ctx.db, campaignId)` → `Underperformer | null` — reads `app.open_underperformers`.
  - `worstUnderperformer(ctx.db)` → `Underperformer | null` — the worst by `recoverable_spend_usd`.
  - `getCampaign(ctx.db, campaignId)` → `CampaignRow | null` — the live position (ROAS, spend, band, creative).
- **Expected tool output shape** (an object the model reads):
  ```
  {
    campaign_id, channel, category, target_segment, roas, spend_to_date_usd,
    recoverable_spend_usd, has_matching_winner, matching_winner_campaign_id,
    matching_winner_roas
  }
  ```
  Combine the `Underperformer` fields with the `CampaignRow` fields. If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_underperformer', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_actions`

Read the ML model's ranked campaign actions — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/campaigndesk.ts`, the tool named `rank_actions`.
- **Signature (already declared):** `rank_actions({ campaign_id: string })`.
- **Lakebase helper to use:** `getRecommendation(ctx.db, campaignId)` → `ActionRecommendation | null` — reads `app.action_recommendations` (mirrored from `gold_action_recommendations`).
- **Expected tool output shape:**
  ```
  {
    campaign_id, recommended_action,               // 'replicate_winner' | 'reallocate_budget' | 'pause'
    predicted_roas_lift, predicted_net_value_usd,
    action_ranking: [                              // ALL three options — quote these in the draft
      { actionType, predictedRoasLift, predictedNetValueUsd },
      ...
    ]
  }
  ```
  Return `getRecommendation(...)` directly (its shape already matches). If it returns `null`, return `{ scored: false, note: 'No action recommendation yet — build + score the roas_recommender model (Build 2 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

**Also add the "explain / what-if / draft" behavior:** the instructions in `campaigndesk.ts` already steer the model to quote the ranked options, recommend the top move + explain *why*, offer an arithmetic what-if from `action_ranking`, and draft the on-brand campaign brief — once these two tools return data, that behavior lights up. No extra code needed beyond the two tool bodies.

**Acceptance (2a + 2b):** after building + scoring the model and restarting, chat:
1. *"Which campaigns are winning and why is CMP-0000214 underperforming?"* → `ask_data` investigates + `find_underperformer` returns the live position + matching winner (social/lifestyle combo).
2. *"Rank the action. Use the model."* → `rank_actions` returns the ranking; the agent quotes **replicate_winner / reallocate_budget / pause** each with predicted ROAS lift, recommends replicate_winner, drafts the on-brand brief, and **STOPS for approval**.
   Both tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2 (2a + 2b):**
> In `server/agent/campaigndesk.ts`, implement the `find_underperformer` and `rank_actions` tools (they currently throw "Not implemented"). Use the ready-made helpers from `server/db/queries/campaigns.ts`: `getUnderperformer`, `worstUnderperformer`, `getCampaign` for `find_underperformer`; `getRecommendation` for `rank_actions`. Match the output shapes documented in `APP_WORKSHOP.md` §Layer 2. Wrap each body in `mlflow.withSpan(...)` like the `ask_data` tool. Return a `{found:false}` / `{scored:false}` object instead of throwing when the row is missing. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

### 2c. `search_creatives` — Creative search via Lakebase Search (OPTIONAL, Milestone 2)

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it to explain "why does the winner work" by searching the creative catalog for similar angle/creative-type combinations, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_creatives` tool body + a Lakebase query helper to perform **text search** over the creatives indexed in Lakebase Postgres.

See APP_WORKSHOP.md notes above for the full pattern (this is the Lakebase Search showcase for Brightwave).

**Acceptance (2c):** after wiring Lakebase Search on the creatives table and implementing the helper + tool:
1. Run the full script: *"Which campaigns are winning and how do I replicate the winner?"* → investigate → rank → draft.
2. In the drafting phase, the agent may call `search_creatives` with a query like *"social lifestyle"* to ground the replicate play on real creative assets.
3. The Thinking panel shows the `search_creatives` tool call + results; the agent quotes them in the on-brand brief.

---

## Layer 3 — Act (Build 2): `execute_campaign_action`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/campaigns.ts`)

Add `recordCampaignAction(db, args)` following the **filter-driven, transactional** pattern:

- **Signature:**
  ```ts
  recordCampaignAction(db: AppDb, args: {
    campaignId: string; actionType: ActionType; targetCampaignId: string | null;
    draftedBrief: string; predictedRoasLift: number | null;
    userEmail: string;
  }): Promise<{ actionId: string }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.campaign_actions_app` a row: `campaign_id`, `action_type`, `target_campaign_id`, `drafted_brief`, `predicted_roas_lift`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'approved', notes: 'Campaign action recorded', tool: 'execute_campaign_action' }]::jsonb`. Return the generated `id`.

### 3b. The tool body (in `server/agent/campaigndesk.ts`)

Replace the `execute_campaign_action` stub's `execute` (search `TODO — BUILD 3`):

- **Signature (already declared):** `execute_campaign_action({ campaign_id, action_type, target_campaign_id, drafted_brief, predicted_roas_lift })`.
- Call `recordCampaignAction(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_campaign_action', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, action_id, campaign_id, action_type, predicted_roas_lift }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Campaign Desk refresh cascade

The client is already wired: the campaign desk queue subscribes to `dataMutated` from `client/src/lib/events.ts` and refetches on every emit. The chat turn already emits `dataMutated` when the agent's turn ends. **So once `execute_campaign_action` writes to `app.campaign_actions_app`, the moment the turn completes:** the underperformer queue updates, the action badge appears on the campaign row, and any open drawer re-fetches. **You do not need to add any client code** — just make the write land.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"Which campaigns are winning and how do I replicate the winner?"* → investigate → rank → draft → **STOP**.
2. *"Yes — replicate the winner."* → `execute_campaign_action` writes to `app.campaign_actions_app`. **Watch the Campaign Desk queue cascade live without a reload:** underperformer count −1, CMP-0000214 row → "Action recorded · replicate_winner", drawer gains the action in the Activity timeline, recoverable-spend KPI ticks down.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/campaigns.ts` add `recordCampaignAction(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.campaign_actions_app` row (status='approved', approved_by from userEmail, an audit entry). (2) In `server/agent/campaigndesk.ts` implement the `execute_campaign_action` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Campaign Desk queue updates live after approval.

---

## Build 3 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-campaign-attributable inference logging** to a UC table. Content generation is the fastest-growing slice of marketing's AI spend — make it visible and governed.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/campaigndesk.ts`). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$300K/yr bounded per the story to content-generation capacity), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII, brand compliance).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-campaign attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `campaign_actions_app.campaign_id` / `approved_by` columns to attribute spend per campaign. (Optional talk-track: surface an "AI spend" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Build 3):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the campaign the action targeted.

**Paste-to-agent prompt for Build 3:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/campaigndesk.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a ~$300K/yr spend cap, guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per campaign using `campaign_actions_app.campaign_id` / `approved_by`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (campaign desk queue reading Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie investigation) | ✅ | pick backend in Build 1 |
| `find_underperformer`, `rank_actions` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_creatives` | stub (throws) | **Layer 2c** (optional) |
| `execute_campaign_action` | stub (throws) | **Layer 3** (3a + 3b) |
| `dataMutated` queue cascade | ✅ | — |
| Unity AI Gateway spend cap + attribution | — | **Build 3** |
