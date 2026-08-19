# Nimbus Growth Desk — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the growth desk queue reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Build 3 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

A segment cohort **SEG-0000214** (Gen-Z / Android) is sliding on conversion — from ~4% to ~2.8% over three weeks after a checkout-flow change — costing ~$10M annualized conversion at risk across ~40 cohorts. Meanwhile, a past experiment proved a feature flag **won +2.25pt on a similar Gen-Z/Android cohort**. The hero question: **"Conversion is sliding in this segment — which feature should ship next?"** The app isolates the sliding cohorts, ranks the feature to ship (proven variant / rollout existing flag / ship alternative), and executes it — all at the moment when the conversion is recoverable and the data is fresh. AI Gateway attributes every model call to this segment so growth can see the actual impact on conversion.

The three layers map 1:1 to the enablement build arc: **Visualize (Build-1 Apps)** → **Assist (Build-2 Apps + the ML step)** → **Act (Build-2 Apps)**, all governed by **Unity AI Gateway (Build 3)**.

---

## The data (already generated + validated in `ai_demo_gen.nimbus`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.feature_decisions_app`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `segment_position` | `gold_segment_position` | yes (synced) | `id`(=`segment_id`), `segment_id`, `cohort`, `platform`, `region`, `mau`, `segment_summary`, `conversion_rate`, `conversion_rate_3w_ago`, `conversion_drop`, `sessions`, `slide_signal_score`, `conversion_at_risk_usd`, `conv_band` (`sliding`/`watch`/`healthy`) |
| `open_sliding` | `gold_open_sliding` | yes (synced) | `segment_id`, `cohort`, `platform`, `mau`, `conversion_rate`, `conversion_drop`, `conversion_at_risk_usd`, `has_matching_experiment`, `matching_experiment_id`, `matching_experiment_lift`, `neighbor_flag_key` |
| `action_recommendations` | `gold_action_recommendations` | yes (synced) | `segment_id`, `recommended_action`, `predicted_conversion_lift`, `predicted_net_value_usd`, `action_ranking` (JSONB: all three options) |
| `experiments` | `raw_experiments` | yes (synced) | `experiment_id`, `experiment_name`, `variant`, `feature_area`, `tested_cohort`, `tested_platform`, `won`, `observed_lift`, `description` (searchable), `is_active` |
| **`feature_decisions_app`** | — (the app's own) | **NO — writable** | `id`(uuid), `segment_id`, `action_type`, `target_experiment_id`, `flag_key`, `variant`, `rollout_pct`, `drafted_note`, `predicted_conversion_lift`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_action_recommendations` is NOT built yet.** It is produced by the ML step of Build 2 (`specifications/03-ml-conversion.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_action_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_actions` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/segments.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/growthdesk.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/segments.ts` |
| The data-backend `ask_data` tool | already wired in `growthdesk.ts` (delegates to `server/agent/tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by growth desk UI |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `growthdesk.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Build 1 (Lakebase) — already wired for you

The synced mirrors + the writable `feature_decisions_app` table are the Build-1 answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Build-1 workshop task in the workspace is to set up the **real Lakebase Synced Tables** for the four Gold tables and pick your **`ask_data` backend** (Genie space):

- Set **`GENIE_SPACE_ID`** in `.env` (or the DAB). The app registers the Genie space as the `ask_data` tool — no code change needed. Leave **`MAS_ENDPOINT_NAME` empty** (Nimbus uses Genie). The default Nimbus flow uses **Genie** ("ask why segments are sliding on conversion").

**Acceptance:** open the app → chat → ask *"Which segments are sliding on conversion, and why is SEG-0000214 sliding?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Build 2): `find_sliding_segment` + `rank_actions`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/growthdesk.ts` that TELL the model to call these tools. Both tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented"`** until you implement them.

**What YOU build:** replace the two stub `execute` bodies in `server/agent/growthdesk.ts`. The Lakebase query helpers are already written in `server/db/queries/segments.ts` — you mostly wire them up.

### 2a. `find_sliding_segment`

Read the live sliding segment for a segment_id (or the worst sliding segment) + its matching experiment.

- **File:** `server/agent/growthdesk.ts`, the tool named `find_sliding_segment` (search for `TODO — BUILD 2`).
- **Signature (already declared):** `find_sliding_segment({ segment_id: string | null })`. `null` → return the worst sliding segment.
- **Lakebase helpers to use** (from `server/db/queries/segments.ts`, imported at the top of `growthdesk.ts`):
  - `getSlidingSegment(ctx.db, segmentId)` → `SlidingSegment | null` — reads `app.open_sliding`.
  - `worstSlidingSegment(ctx.db)` → `SlidingSegment | null` — the worst by `conversion_at_risk_usd`.
- **Expected tool output shape** (an object the model reads):
  ```
  {
    segment_id, cohort, platform, mau, conversion_rate, conversion_drop,
    conversion_at_risk_usd, has_matching_experiment, matching_experiment_id,
    matching_experiment_lift
  }
  ```
  Combine the `SlidingSegment` fields. If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_sliding_segment', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_actions`

Read the ML model's ranked feature actions — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/growthdesk.ts`, the tool named `rank_actions`.
- **Signature (already declared):** `rank_actions({ segment_id: string })`.
- **Lakebase helper to use:** `getRecommendation(ctx.db, segmentId)` → `ActionRecommendation | null` — reads `app.action_recommendations` (mirrored from `gold_action_recommendations`).
- **Expected tool output shape:**
  ```
  {
    segment_id, recommended_action,               // 'ship_proven_variant' | 'rollout_existing_flag' | 'ship_alt_variant'
    predicted_conversion_lift, predicted_net_value_usd,
    action_ranking: [                              // ALL three options — quote these in the draft
      { actionType, predictedConversionLift, predictedNetValueUsd },
      ...
    ]
  }
  ```
  Return `getRecommendation(...)` directly (its shape already matches). If it returns `null`, return `{ scored: false, note: 'No action recommendation yet — build + score the conversion_recommender model (Build 2 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

**Also add the "explain / what-if / draft" behavior:** the instructions in `growthdesk.ts` already steer the model to quote the ranked options, recommend the top move + explain *why*, offer an arithmetic what-if from `action_ranking`, and draft the rollout note — once these two tools return data, that behavior lights up. No extra code needed beyond the two tool bodies.

**Acceptance (2a + 2b):** after building + scoring the model and restarting, chat:
1. *"Why is SEG-0000214 sliding on conversion, and what should I ship?"* → `ask_data` investigates + `find_sliding_segment` returns the live position + matching experiment (a past win on a similar Gen-Z/Android cohort).
2. *"Rank the action. Use the model."* → `rank_actions` returns the ranking; the agent quotes **ship_proven_variant / rollout_existing_flag / ship_alt_variant** each with predicted conversion lift, recommends ship_proven_variant, drafts the rollout note, and **STOPS for approval**.
   Both tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2 (2a + 2b):**
> In `server/agent/growthdesk.ts`, implement the `find_sliding_segment` and `rank_actions` tools (they currently throw "Not implemented"). Use the ready-made helpers from `server/db/queries/segments.ts`: `getSlidingSegment`, `worstSlidingSegment` for `find_sliding_segment`; `getRecommendation` for `rank_actions`. Match the output shapes documented in `APP_WORKSHOP.md` §Layer 2. Wrap each body in `mlflow.withSpan(...)` like the `ask_data` tool. Return a `{found:false}` / `{scored:false}` object instead of throwing when the row is missing. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

### 2c. `search_experiments` — Experiment search via Lakebase Search (OPTIONAL, Milestone 2)

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it to ground "which feature won for a similar cohort" by searching the experiment catalog for matching keywords, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_experiments` tool body + a Lakebase query helper to perform **text search** over the experiments indexed in Lakebase Postgres.

See APP_WORKSHOP.md notes above for the full pattern (this is the Lakebase Search showcase for Nimbus).

**Acceptance (2c):** after wiring Lakebase Search on the experiments table and implementing the helper + tool:
1. Run the full script: *"Why is SEG-0000214 sliding and what feature should ship?"* → investigate → rank → draft.
2. In the drafting phase, the agent may call `search_experiments` with a query like *"checkout android gen-z"* to ground the ship_proven_variant play on the real matched experiment.
3. The Thinking panel shows the `search_experiments` tool call + results; the agent quotes them in the rollout note.

---

## Layer 3 — Act (Build 2): `execute_feature_decision`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/segments.ts`)

Add `recordFeatureDecision(db, args)` following the **filter-driven, transactional** pattern:

- **Signature:**
  ```ts
  recordFeatureDecision(db: AppDb, args: {
    segmentId: string; actionType: ActionType; targetExperimentId: string | null;
    flagKey: string; variant: string; rolloutPct: number | null;
    draftedNote: string; predictedConversionLift: number | null;
    userEmail: string;
  }): Promise<{ decisionId: string }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.feature_decisions_app` a row: `segment_id`, `action_type`, `target_experiment_id`, `flag_key`, `variant`, `rollout_pct`, `drafted_note`, `predicted_conversion_lift`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'approved', notes: 'Feature decision recorded', tool: 'execute_feature_decision' }]::jsonb`. Return the generated `id`.

### 3b. The tool body (in `server/agent/growthdesk.ts`)

Replace the `execute_feature_decision` stub's `execute` (search `TODO — BUILD 3`):

- **Signature (already declared):** `execute_feature_decision({ segment_id, action_type, target_experiment_id, flag_key, variant, rollout_pct, drafted_note, predicted_conversion_lift })`.
- Call `recordFeatureDecision(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_feature_decision', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, decision_id, segment_id, action_type, predicted_conversion_lift }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Growth Desk refresh cascade

The client is already wired: the growth desk queue subscribes to `dataMutated` from `client/src/lib/events.ts` and refetches on every emit. The chat turn already emits `dataMutated` when the agent's turn ends. **So once `execute_feature_decision` writes to `app.feature_decisions_app`, the moment the turn completes:** the sliding cohort queue updates, the decision badge appears on the segment row, and any open drawer re-fetches. **You do not need to add any client code** — just make the write land.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"Why is SEG-0000214 sliding and what feature should ship?"* → investigate → rank → draft → **STOP**.
2. *"Yes — ship the proven variant."* → `execute_feature_decision` writes to `app.feature_decisions_app`. **Watch the Growth Desk queue cascade live without a reload:** sliding KPI −1, SEG-0000214 row → "shipping · ship_proven_variant", drawer gains the decision in the Activity timeline, conversion-at-risk KPI ticks down.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/segments.ts` add `recordFeatureDecision(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.feature_decisions_app` row (status='approved', approved_by from userEmail, an audit entry). (2) In `server/agent/growthdesk.ts` implement the `execute_feature_decision` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Growth Desk queue updates live after approval.

---

## Build 3 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-segment-attributable inference logging** to a UC table. ML-driven conversions optimization is high-value, high-volume — make it visible and governed.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/growthdesk.ts`). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$150K/yr bounded per the story to model-driven recommendations), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII, brand compliance).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-segment attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `feature_decisions_app.segment_id` / `approved_by` columns to attribute spend per segment. (Optional talk-track: surface an "AI spend" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Build 3):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the segment the decision targeted.

**Paste-to-agent prompt for Build 3:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/growthdesk.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a ~$150K/yr spend cap, guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per segment using `feature_decisions_app.segment_id` / `approved_by`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (growth desk queue reading Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie investigation) | ✅ | pick backend in Build 1 |
| `find_sliding_segment`, `rank_actions` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_experiments` | stub (throws) | **Layer 2c** (optional, Milestone 2) |
| `execute_feature_decision` | stub (throws) | **Layer 3** (3a + 3b) |
| Client `dataMutated` cascade | ✅ | — |
| Unity AI Gateway routing | — | **Build 3** (config + workspace) |

## Definition of done

- ✅ Segments slide and the Growth Desk queue shows them.
- ✅ Chat "Why is SEG-0000214 sliding?" → `ask_data` → Genie investigates + you get a synthesized answer.
- ✅ Chat "Rank the action" → `find_sliding_segment` + `rank_actions` return live data + the agent ranks the options, drafts the rollout note, and stops for approval.
- ✅ Chat "Ship the proven variant" → `execute_feature_decision` writes to Lakebase → Growth Desk queue cascades live (no reload), SEG-0000214's sliding KPI ticks down.
- ✅ (Optional) `search_experiments` finds matching won experiments to ground the decision.
- ✅ (Optional) Unity AI Gateway governs model calls with a spend cap + per-segment attribution.
