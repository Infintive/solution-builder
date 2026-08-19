# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST. This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md`, then rewrite domain pieces. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** **Milestone 2 (Lakebase)** = the data model in `03_DATA_MODEL.md` (synced read-only campaign-position + a writable campaign-actions table); **Milestone 3 (Databricks Apps)** = **Visualize → Assist → Act**; **Milestone 4 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (content-generation spend cap, guardrails, inference logging) — the hero question is *"Which campaigns are winning and why, and how do I replicate that across the ones that aren't?"*.

## Pitch

AI assistant that **isolates the drivers of winning campaigns, ranks the move for each underperformer, and executes it** in one conversation. Priya watches every step live: the assistant asks Genie which campaigns are winning + searches the creative catalog for why, reads the live Lakebase position + the matching winner, then **looks up the ranked recommendation** (`app.action_recommendations`, mirrored from `gold_action_recommendations` — heuristic or optional ML) to rank the three plays — replicate winner / reallocate budget / pause — each with the projected ROAS lift and the spend at stake. It explains *why* replicating the winner wins (a matching winner with a transferable creative exists), offers a what-if, drafts the on-brand campaign brief, and **stops for approval**. Priya approves → the action + the brief write to Lakebase → the queue + KPI tiles tick live. Every action is traced in MLflow; every content-generation call is governed by Unity AI Gateway, on-brand and attributable.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | Read surface (synced read-only `campaign_position`) AND write surface (writable `campaign_actions_app`). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` routes the "which campaigns are winning and why?" investigation to the Genie space. |
| **ML model (UC-registered)** | The `roas_recommender` model's batch output feeds the agent's ranking via `app.action_recommendations`. The app never calls the model directly. |
| **AI Functions (`ai_classify`)** | Performance-signal (winner/underperformer/healthy) from each review note, mirrored on the campaign row. |
| **Unity AI Gateway** | The assistant's content-generation endpoint runs through the Gateway — spend cap (~$300K/yr), on-brand guardrails, inference logging + attribution (content generation is the fastest-growing slice of marketing's AI spend). |
| **MLflow tracing** | Per-turn traces with tool spans; thumbs up/down → human assessments. |
| **Databricks Apps** | SSO, OBO auth (actions stamped with the approver's identity), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded iframe with SSO — the campaign-performance dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Campaign Desk** | The winner/underperformer surface — a ROAS×spend scatter + an underperformer queue, KPI cards (Recoverable spend / Underperformers / ROAS gap), detail drawer with the ranked actions + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: ROAS trend on the affected clusters, worst campaigns, per-channel rollups | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page (floating dock + full-page chat), one brain.

### The three layers (Visualize / Assist / Act)
- **Visualize** (Campaign Desk) — the live ROAS×spend scatter + queue makes the important thing obvious: green winners high, red underperformers low. Reads synced Lakebase position data.
- **Assist** (the agent) — isolates why the winners work (searches the creative catalog), ranks the action for each underperformer, offers a what-if. Reads the model's recommendation + the live position.
- **Act** (the write) — after human approval, writes the chosen action + drafted brief (replicate_winner/reallocate_budget/pause) to the writable Lakebase `campaign_actions_app` table; the Campaign Desk cascades.

### Thinking panel
Streams reasoning + the Genie investigation ("querying campaign ROAS", "found matching winner + creative") + tool calls. Persisted as `thinking[]` JSONB.

### Human-in-the-loop — strict 3-phase action chain
1. **Discover** — read the underperformer (ROAS, spend, matching winner), **search the creative catalog** for why the winner works, **look up the ranked recommendation** (read-only).
2. **Draft + confirm** — present the ranked actions (each with projected ROAS lift, cost, net value); recommend the top one and explain why; offer a what-if; draft the on-brand campaign brief → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved action + brief to `campaign_actions_app`, append an audit entry — one atomic write.

### Agent tools (Brightwave) — one example set
| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates which campaigns win + why over the governed lakehouse | Investigation |
| `find_underperformer` | Queries Lakebase: the underperformer position for a `{campaign_id}` (or the worst open) — ROAS, spend, recoverable spend, matching-winner context | Discovery |
| `search_creatives` | Lakebase Search over the creative catalog (`creatives`: name + description) to ground **why a winner works** + the on-brand copy for the replicate play | Discovery (creative context) |
| `rank_actions` | Queries Lakebase `app.action_recommendations` — returns `recommended_action`, `predicted_roas_lift`, `predicted_net_value_usd`, and the full `action_ranking`. **The "ML in the loop" moment** | Discovery |
| `execute_campaign_action` | Atomic write to Lakebase `app.campaign_actions_app`: records the approved action + drafted brief + audit. Inputs are a FILTER + the drafted brief | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_campaign_action` MUST publish a `dataMutated` event. The Campaign Desk refetches: the Underperformer KPI ticks down, the campaign row flips to "action taken" with a badge, the scatter's red dot moves/turns neutral, the recoverable-spend KPI drops. The user must **see** it without reloading.

## Home page

**Story section:** Persona badge ("Priya Anand · CMO · Brightwave"), headline ("Winners and underperformers, side by side — while the quarter is still in play"), situation (a cluster of campaigns split into ~60 winners on a specific channel+creative and ~90 underperformers burning ~20% of spend; ~$13M recoverable on the sample — the full-budget figure is ~$40M/yr), goal (isolate why the winners work → replicate across the underperformers → approve it), preview bullets.

**Journey diagram:** See the two clusters → Campaign Desk | Ask why CMP-0000214 underperforms → starts chat | Rank replicate vs reallocate vs pause → the model | Replicate the winner → action flow.

**Starter chips:** "Which campaigns are winning, and why?" / "Why is CMP-0000214 underperforming?" / "How do I replicate the winner across CMP-0000214?"

**Featured action card:** "Recommend a move for CMP-0000214 — rank replicate a winner vs reallocate budget vs pause."

**Activity feed:** Live tail ("Replicated winner into CMP-0000214, projected +2.3 ROAS lift", "Reallocated budget from CMP-0031234", "Ranked actions for 3 underperformers"). Auto-refreshes.

## Scripted demo flow (~3 min)

**Step 1 — "Which campaigns are winning, and why is CMP-0000214 underperforming?"** `ask_data` → Genie investigates: winners cluster on a social + lifestyle-creative combo; CMP-0000214 is on display + promo with low ROAS. `find_underperformer` + `search_creatives` read the live position + the matching winner's creative. Suggests ranking the action.

**Step 2 — "Rank the action. Use the model."** (unlocks on "winner"/"underperform"/"ROAS"/"CMP-0000214"/"replicate"). `rank_actions` → quotes the ranked options. → "**Replicate the matching winner's social + lifestyle creative** — projected +2.3 ROAS lift on this campaign's spend. Reallocate its budget to a proven winner: +1.9, but you abandon this audience. Pause: stops the bleed, no upside." Drafts the on-brand campaign brief. Stops.

**Step 3 — "Yes — replicate the winner."** (unlocks on "replicate"/"action"/"approve"/"reallocate"). `execute_campaign_action` writes to Lakebase, appends audit, emits `dataMutated`. On screen: the Underperformer KPI drops, CMP-0000214's row flips to "action taken", the scatter dot shifts, recoverable spend ticks down — no reload. **That live cascade is the story beat.**

**Performance:** narrow Genie questions (20–40s); the position + recommendation lookups are Lakebase reads (sub-second).

All narrative config lives in `config/app.json`. Read it directly.
