# Streamline Care Desk — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the care desk queue reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Build 3 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

A network outage on a telecom backbone (`NODE-OHIO-14`) ~3 weeks ago collided with billing friction and a competitor promotion, pushing ~200 high-value subscribers into **elevated churn risk**. The hero: **SUB-0000214** (a 5-year, $68/month subscriber homed on the outage node, with an unresolved outage ticket + a billing dispute open, churn risk ~0.86). The recommended retention move: a **bill_credit** (a one-time service credit acknowledging the outage) — because the churn driver is SERVICE/BILLING, not price. The whole app answers one hero question: **"Why is SUB-0000214 at risk of churning, and what should I offer?"**

The three layers map 1:1 to the enablement build arc: **Visualize (Build-1 Apps)** → **Assist (Build-2 Apps + the ML step)** → **Act (Build-2 Apps)**, all governed by **Unity AI Gateway (Build 3)**.

---

## The data (already generated + validated in `ai_demo_gen.streamline_telco`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.care_actions`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `subscriber_position` | `gold_subscriber_position` | yes (synced) | `id`(=`subscriber_id`), `subscriber_id`, `plan_type`, `tenure_months`, `monthly_arpu_usd`, `service_node_id`, `home_metro`, `sub_lat`, `sub_lng`, `service_summary`, `churn_risk_score`, `churn_reason`, `open_ticket_count`, `has_open_outage`, `has_open_billing`, `churn_signal_score`, `clv_at_risk_usd`, `risk_band` (`critical`/`elevated`/`watch`/`healthy`) |
| `open_atrisk` | `gold_open_atrisk` | yes (synced) | `subscriber_id`, `plan_type`, `monthly_arpu_usd`, `churn_risk_score`, `churn_reason`, `has_open_outage`, `has_open_billing`, `clv_at_risk_usd`, `candidate_offer_id` |
| `retention_recommendations` | `gold_retention_recommendations` | yes (synced) | `subscriber_id`, `recommended_offer`, `predicted_retained_clv_usd`, `predicted_net_value_usd`, `offer_ranking` (JSONB: all three options) |
| `offers` | `raw_offers` | yes (synced) | `offer_id`, `offer_name`, `offer_type`, `value_usd`, `description` (searchable) |
| **`care_actions`** | — (the app's own) | **NO — writable** | `id`(uuid), `subscriber_id`, `offer_type`, `offer_id`, `drafted_summary`, `predicted_retained_clv_usd`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_retention_recommendations` is NOT built yet.** It is produced by the ML step of Build 2 (`specifications/03-ml-churn.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_retention_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_offers` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/subscribers.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/caredesk.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/subscribers.ts` |
| The data-backend `ask_data` tool | already wired in `caredesk.ts` (delegates to `server/agent/tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by care desk UI |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `caredesk.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Build 1 (Lakebase) — already wired for you

The synced mirrors + the writable `care_actions` table are the Build-1 answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Build-1 workshop task in the workspace is to set up the **real Lakebase Synced Tables** for the four Gold tables and pick your **`ask_data` backend** (Genie space):

- Set **`GENIE_SPACE_ID`** in `.env` (or the DAB). The app registers the Genie space as the `ask_data` tool — no code change needed. Leave **`MAS_ENDPOINT_NAME` empty** (Streamline uses Genie). The default Streamline flow uses **Genie** ("ask why SUB-0000214 is at risk").

**Acceptance:** open the app → chat → ask *"Why is SUB-0000214 at risk, and what's their service history?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Build 2): `find_atrisk_subscriber` + `rank_offers`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/caredesk.ts` that TELL the model to call these tools. Both tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented"`** until you implement them.

**What YOU build:** replace the two stub `execute` bodies in `server/agent/caredesk.ts`. The Lakebase query helpers are already written in `server/db/queries/subscribers.ts` — you mostly wire them up.

### 2a. `find_atrisk_subscriber`

Read the live at-risk subscriber for a subscriber_id (or the worst at-risk one) + its candidate offer.

- **File:** `server/agent/caredesk.ts`, the tool named `find_atrisk_subscriber` (search for `TODO — BUILD 2`).
- **Signature (already declared):** `find_atrisk_subscriber({ subscriber_id: string | null })`. `null` → return the worst at-risk subscriber.
- **Lakebase helpers to use** (from `server/db/queries/subscribers.ts`, imported at the top of `caredesk.ts`):
  - `getAtriskSubscriber(ctx.db, subscriberId)` → `AtriskSubscriber | null` — reads `app.open_atrisk`.
  - `worstAtriskSubscriber(ctx.db)` → `AtriskSubscriber | null` — the worst by `clv_at_risk_usd`.
  - `getSubscriberPosition(ctx.db, subscriberId)` → `SubscriberRow | null` — the live position (risk score, reason, tickets, geo, CLV).
- **Expected tool output shape** (an object the model reads):
  ```
  {
    subscriber_id, tenure_months, monthly_arpu_usd, churn_risk_score, churn_reason,
    open_ticket_count, has_open_outage, has_open_billing, clv_at_risk_usd,
    home_metro, sub_lat, sub_lng, service_summary, candidate_offer_id
  }
  ```
  Combine the `AtriskSubscriber` fields with the `SubscriberRow` fields. If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_atrisk_subscriber', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_offers`

Read the ML model's ranked retention offers — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/caredesk.ts`, the tool named `rank_offers`.
- **Signature (already declared):** `rank_offers({ subscriber_id: string })`.
- **Lakebase helper to use:** `getRecommendation(ctx.db, subscriberId)` → `RetentionRecommendation | null` — reads `app.retention_recommendations` (mirrored from `gold_retention_recommendations`).
- **Expected tool output shape:**
  ```
  {
    subscriber_id, recommended_offer,               // 'bill_credit' | 'plan_upgrade_discount' | 'device_upgrade'
    predicted_retained_clv_usd, predicted_net_value_usd,
    offer_ranking: [                                // ALL three options — quote these in the draft
      { offerType, costUsd, predictedRetainedClvUsd, predictedNetValueUsd },
      ...
    ]
  }
  ```
  Return `getRecommendation(...)` directly (its shape already matches). If it returns `null`, return `{ scored: false, note: 'No retention recommendation yet — build + score the churn_recommender model (Build 2 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

**Also add the "explain / what-if / draft" behavior:** the instructions in `caredesk.ts` already steer the model to quote the ranked options, recommend the top move + explain *why*, offer an arithmetic what-if from `offer_ranking`, and draft the offer memo — once these two tools return data, that behavior lights up. No extra code needed beyond the two tool bodies.

**Acceptance (2a + 2b):** after building + scoring the model and restarting, chat:
1. *"Why is SUB-0000214 at risk of churning, and what should I offer?"* → `ask_data` investigates + `find_atrisk_subscriber` returns the live position + candidate offer (bill_credit for service reason).
2. *"Rank the offers. Use the model."* → `rank_offers` returns the ranking; the agent quotes **bill_credit / plan_upgrade_discount / device_upgrade** each with predicted retained CLV, recommends bill_credit, drafts the memo, and **STOPS for approval**.
   Both tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2 (2a + 2b):**
> In `server/agent/caredesk.ts`, implement the `find_atrisk_subscriber` and `rank_offers` tools (they currently throw "Not implemented"). Use the ready-made helpers from `server/db/queries/subscribers.ts`: `getAtriskSubscriber`, `worstAtriskSubscriber`, `getSubscriberPosition` for `find_atrisk_subscriber`; `getRecommendation` for `rank_offers`. Match the output shapes documented in `APP_WORKSHOP.md` §Layer 2. Wrap each body in `mlflow.withSpan(...)` like the `ask_data` tool. Return a `{found:false}` / `{scored:false}` object instead of throwing when the row is missing. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

### 2c. `search_history` — Service history search via Lakebase Search (OPTIONAL, Milestone 2)

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it to explain "why is this subscriber at risk" by searching their tickets + network events, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_history` tool body + a Lakebase query helper to perform **text search** over the subscriber's service history indexed in Lakebase Postgres.

See APP_WORKSHOP.md notes above for the full pattern (this is the Lakebase Search showcase for Streamline).

**Acceptance (2c):** after wiring Lakebase Search on the subscriber service history tables and implementing the helper + tool:
1. Run the full script: *"What's the best retention move for SUB-0000214?"* → investigate → rank → draft.
2. In the investigation phase, the agent may call `search_history` with a query like *"outage" or "billing disputes"* to ground the "why" on real tickets + notes.
3. The Thinking panel shows the `search_history` tool call + results; the agent quotes them in the narrative.

---

## Layer 3 — Act (Build 2): `execute_retention_action`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/subscribers.ts`)

Add `recordRetentionAction(db, args)` following the **filter-driven, transactional** pattern:

- **Signature:**
  ```ts
  recordRetentionAction(db: AppDb, args: {
    subscriberId: string; offerType: OfferType; offerId: string | null;
    draftedSummary: string; predictedRetainedClvUsd: number | null;
    userEmail: string;
  }): Promise<{ actionId: string }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.care_actions` a row: `subscriber_id`, `offer_type`, `offer_id`, `drafted_summary`, `predicted_retained_clv_usd`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'approved', notes: 'Retention action recorded', tool: 'execute_retention_action' }]::jsonb`. Return the generated `id`.

### 3b. The tool body (in `server/agent/caredesk.ts`)

Replace the `execute_retention_action` stub's `execute` (search `TODO — BUILD 3`):

- **Signature (already declared):** `execute_retention_action({ subscriber_id, offer_type, offer_id, drafted_summary, predicted_retained_clv_usd })`.
- Call `recordRetentionAction(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_retention_action', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, action_id, subscriber_id, offer_type, predicted_retained_clv_usd }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Care Desk refresh cascade

The client is already wired: the care desk queue subscribes to `dataMutated` from `client/src/lib/events.ts` and refetches on every emit. The chat turn already emits `dataMutated` when the agent's turn ends. **So once `execute_retention_action` writes to `app.care_actions`, the moment the turn completes:** the at-risk queue updates, the action badge appears on the subscriber row, and any open drawer re-fetches. **You do not need to add any client code** — just make the write land.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"What's the best retention move for SUB-0000214?"* → investigate → rank → draft → **STOP**.
2. *"Yes — apply the bill credit."* → `execute_retention_action` writes to `app.care_actions`. **Watch the Care Desk queue cascade live without a reload:** at-risk count −1, SUB-0000214 row → "Action recorded · bill_credit", drawer gains the action in the Activity timeline.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/subscribers.ts` add `recordRetentionAction(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.care_actions` row (status='approved', approved_by from userEmail, an audit entry). (2) In `server/agent/caredesk.ts` implement the `execute_retention_action` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Care Desk queue updates live after approval.

---

## Build 3 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-subscriber-attributable inference logging** to a UC table.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/caredesk.ts`). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$200K/yr bounded per the story), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-subscriber attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `care_actions.subscriber_id` / `approved_by` columns to attribute spend per subscriber. (Optional talk-track: surface an "AI spend" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Build 3):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the subscriber the action targeted.

**Paste-to-agent prompt for Build 3:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/caredesk.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a spend cap, guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per subscriber using `care_actions.subscriber_id` / `approved_by`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (care desk queue reading Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie investigation) | ✅ | pick backend in Build 1 |
| `find_atrisk_subscriber`, `rank_offers` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_history` (Lakebase Search) | stub (throws) | **Layer 2c (optional, Milestone 2)** |
| `execute_retention_action` + `recordRetentionAction` write | stub (throws) | **Layer 3** |
| `dataMutated` → Care Desk live cascade | ✅ (fires on your write) | — |
| Unity AI Gateway governance | scope declared | **Build 3** |

**Run it locally:** `./start.sh` (installs deps, builds the frontend, boots on `DATABRICKS_APP_PORT` or `8765`). Reset the demo between runs with the Reset-demo admin action — it truncates `care_actions` + re-syncs the read-only mirrors, so at-risk subscribers return to their original risk state and CLV at-risk returns to full.
