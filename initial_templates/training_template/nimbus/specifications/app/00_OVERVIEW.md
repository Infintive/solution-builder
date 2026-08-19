# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST. This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md`, then rewrite domain pieces. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** **Milestone 2 (Lakebase)** = the data model in `03_DATA_MODEL.md` (synced read-only segment-position + a writable feature-decisions table the product reads); **Milestone 3 (Databricks Apps)** = **Visualize → Assist → Act**; **Milestone 4 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap against margin, guardrails, inference logging) — the hero question is *"Conversion is sliding in this segment — which feature should ship next?"*.

## Pitch

AI assistant that **investigates a sliding cohort, ranks the feature to ship, and serves the decision** in one conversation. Jordan watches every step live: the assistant asks Genie why SEG-0000214's conversion slid + searches the experiment history for a proven fix, reads the live Lakebase position + the matching experiment, then **looks up the ranked recommendation** (`app.action_recommendations`, mirrored from `gold_action_recommendations` — heuristic or optional ML) to rank the three plays — ship a proven variant / roll out an existing flag / ship an alternative — each with the projected conversion lift and the users at stake. It explains *why* shipping the proven variant wins (a past experiment lifted a similar cohort), offers a what-if, drafts the rollout note, and **stops for approval**. Jordan approves → the feature-flag decision writes to Lakebase for the product to read at low latency → the queue + KPI tiles tick live. Every action is traced in MLflow; every model call is governed by Unity AI Gateway, capped against margin.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | Read surface (synced read-only `segment_position`) AND write surface (writable `feature_decisions_app` — the served flag the product reads at low latency, scale-to-zero when idle). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` routes the "which segments are sliding and why?" investigation to the Genie space. |
| **ML model (UC-registered)** | The `conversion_recommender` model's batch output feeds the agent's ranking via `app.action_recommendations`. The app never calls the model directly. |
| **AI Functions (`ai_classify`)** | Slide-signal (sliding/at_risk/healthy) from each PM note, mirrored on the cohort row. |
| **Unity AI Gateway** | The assistant's model endpoint runs through the Gateway — spend cap against margin (at 15M MAU the AI feature could be the largest spend slice), guardrails, inference logging. |
| **MLflow tracing** | Per-turn traces with tool spans; thumbs up/down → human assessments. |
| **Databricks Apps** | SSO, OBO auth (decisions stamped with the PM's identity), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded iframe with SSO — the growth dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Growth Desk** | The sliding-segment surface — a conversion×MAU scatter + a sliding queue, KPI cards (Conversion at risk / Sliding segments / Avg conversion), detail drawer with the ranked actions + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: conversion trend on the sliding cohorts, worst cohorts, per-platform rollups | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page (floating dock + full-page chat), one brain.

### The three layers (Visualize / Assist / Act)
- **Visualize** (Growth Desk) — the live conversion×MAU scatter + queue makes the important thing obvious: a red cluster of large sliding cohorts. Reads synced Lakebase position data.
- **Assist** (the agent) — explains why a cohort is sliding (searches the experiment history), ranks the feature to ship, offers a what-if. Reads the model's recommendation + the live position.
- **Act** (the write) — after human approval, writes the chosen feature-flag decision (ship_proven_variant/rollout_existing_flag/ship_alt_variant) to the writable Lakebase `feature_decisions_app` table — **the product reads it at low latency**; the Growth Desk cascades.

### Thinking panel
Streams reasoning + the Genie investigation ("querying cohort conversion", "found a matching won experiment") + tool calls. Persisted as `thinking[]` JSONB.

### Human-in-the-loop — strict 3-phase action chain
1. **Discover** — read the sliding cohort (conversion, drop, MAU, matching experiment), **search the experiment history** for a proven fix, **look up the ranked recommendation** (read-only).
2. **Draft + confirm** — present the ranked actions (each with projected conversion lift, cost, net value); recommend the top one and explain why; offer a what-if; draft the rollout note → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved feature-flag decision to `feature_decisions_app`, append an audit entry — one atomic write the product reads.

### Agent tools (Nimbus) — one example set
| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates which cohorts slide + why over the governed lakehouse | Investigation |
| `find_sliding_segment` | Queries Lakebase: the sliding position for a `{segment_id}` (or the worst open) — conversion, drop, MAU, matching-experiment context | Discovery |
| `search_experiments` | Lakebase Search over the experiment catalog (`experiments`: hypothesis + result) to ground **which feature won for a similar cohort** | Discovery (evidence context) |
| `rank_actions` | Queries Lakebase `app.action_recommendations` — returns `recommended_action`, `predicted_conversion_lift`, `predicted_net_value_usd`, and the full `action_ranking`. **The "ML in the loop" moment** | Discovery |
| `execute_feature_decision` | Atomic write to Lakebase `app.feature_decisions_app`: records the approved feature-flag decision + rollout note + audit (the product reads it). Inputs are a FILTER + the drafted note | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_feature_decision` MUST publish a `dataMutated` event. The Growth Desk refetches: the Sliding KPI ticks down, the cohort row flips to "shipping" with a badge, the scatter's red dot moves/turns neutral, the conversion-at-risk KPI drops. The user must **see** it without reloading.

## Home page

**Story section:** Persona badge ("Jordan Cole · VP Growth · Nimbus"), headline ("A checkout change is quietly costing us conversion"), situation (a checkout-flow change ~3 weeks ago hurt ~40 Android/Gen-Z cohorts while iOS held; ~$10M annualized conversion at risk, conversion sliding ~4% → ~2.8%), goal (spot the sliding cohorts → decide the feature to ship → serve it to the product), preview bullets.

**Journey diagram:** See the sliding cohorts → Growth Desk | Ask why SEG-0000214 slid → starts chat | Rank ship vs roll-out vs alt → the model | Ship the proven variant → decision served to the product.

**Starter chips:** "Which segments are sliding on conversion?" / "Why is SEG-0000214 sliding?" / "Which feature should ship next for SEG-0000214?"

**Featured action card:** "Recommend a feature for SEG-0000214 — rank ship a proven variant vs roll out a flag vs ship an alternative."

**Activity feed:** Live tail ("Shipped proven variant to SEG-0000214, projected +2.2pt conversion", "Rolled out existing flag to SEG-0031234", "Ranked features for 3 sliding cohorts"). Auto-refreshes.

## Scripted demo flow (~3 min)

**Step 1 — "Why is SEG-0000214 sliding on conversion, and what should I ship?"** `ask_data` → Genie investigates: conversion slid over three weeks after the checkout change, on Android specifically. `find_sliding_segment` + `search_experiments` read the live position + a matching won experiment. Suggests ranking the action.

**Step 2 — "Rank the action. Use the model."** (unlocks on "slide"/"conversion"/"SEG-0000214"/"feature"/"ship"). `rank_actions` → quotes the ranked options. → "**Ship the proven variant from EXP-0000009** (won +2.25pt for a similar Gen-Z/Android cohort) — projected +2.2pt on this cohort's ~420K MAU. Roll out the neighboring flag: +0.6pt, cheaper but smaller. Ship an untested alternative: +0.4pt, riskier." Drafts the rollout note. Stops.

**Step 3 — "Yes — ship the proven variant."** (unlocks on "ship"/"variant"/"approve"/"roll out"). `execute_feature_decision` writes the flag decision to Lakebase, appends audit, emits `dataMutated`. On screen: the Sliding KPI drops, SEG-0000214's row flips to "shipping", the scatter dot shifts, conversion-at-risk ticks down — no reload. **That live cascade is the story beat.**

**Performance:** narrow Genie questions (20–40s); the position + recommendation lookups are Lakebase reads (sub-second).

All narrative config lives in `config/app.json`. Read it directly.
