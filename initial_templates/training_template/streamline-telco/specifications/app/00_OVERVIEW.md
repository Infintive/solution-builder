# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST. This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md`, then rewrite domain pieces. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** **Milestone 2 (Lakebase)** = the data model in `03_DATA_MODEL.md` (synced read-only subscriber-position + a writable care-actions table); **Milestone 3 (Databricks Apps)** = **Visualize → Assist → Act**; **Milestone 4 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap predictable per call, guardrails, inference logging) — the hero question is *"Why is SUB-0000214 at risk, and what do I offer?"*.

## Pitch

AI assistant that **investigates a subscriber's churn risk, explains why, ranks the offer, and applies it** in one conversation. Rae watches every step live: the assistant asks Genie why SUB-0000214's risk spiked, reads the live Lakebase position + searches the service history (the outage + billing ticket), then **looks up the ranked recommendation** (`app.retention_recommendations`, mirrored from `gold_retention_recommendations` — heuristic or optional ML) to rank the three plays — bill credit / plan discount / device upgrade — each matched to the churn reason with its retained CLV. It explains *why* the bill credit wins (the reason is service, not price), offers a what-if, drafts the call-resolution summary, and **stops for approval**. Rae approves → the offer + an audit entry write to Lakebase → the queue + KPI tiles tick live. Every action is traced in MLflow; every model call is governed by Unity AI Gateway, predictable per call.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | Read surface (synced read-only `subscriber_position`) AND write surface (writable `care_actions`). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` routes the "why is this subscriber at risk?" investigation to the Genie space. |
| **ML model (UC-registered)** | The `churn_recommender` model's batch output feeds the agent's ranking via `app.retention_recommendations`. The app never calls the model directly. |
| **AI Functions (`ai_classify`)** | Churn-signal score (0–1) from each agent note, mirrored on the subscriber row. |
| **Unity AI Gateway** | The assistant's model endpoint runs through the Gateway — spend cap predictable per call at full contact-center concurrency, guardrails, inference logging. |
| **MLflow tracing** | Per-turn traces with tool spans; thumbs up/down → human assessments. |
| **Databricks Apps** | SSO, OBO auth (offers stamped with the agent's identity), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded iframe with SSO — the retention dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Care Desk** | The at-risk subscriber surface — a risk scatter/map + an at-risk queue, KPI cards (CLV at risk / Open tickets / Critical subscribers), detail drawer with the ranked offers + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: churn-risk trend on the affected cohort, worst accounts, per-plan risk mix | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page (floating dock + full-page chat), one brain.

### The three layers (Visualize / Assist / Act)
- **Visualize** (Care Desk) — the live subscriber risk scatter + queue makes the important thing obvious: a red cluster of valuable subscribers at churn risk. Reads synced Lakebase position data.
- **Assist** (the agent) — explains why a subscriber is at risk (searches the service history), ranks the offer matched to the reason, offers a what-if. Reads the model's recommendation + the live position.
- **Act** (the write) — after human approval, writes the chosen offer (bill_credit/plan_upgrade_discount/device_upgrade) to the writable Lakebase `care_actions` table; the Care Desk cascades.

### Thinking panel
Streams reasoning + the Genie investigation ("querying subscriber risk", "found open outage ticket") + tool calls. Persisted as `thinking[]` JSONB.

### Human-in-the-loop — strict 3-phase action chain
1. **Discover** — read the at-risk subscriber (risk, reason, open tickets), **search the service history** for why, **look up the ranked recommendation** (read-only).
2. **Draft + confirm** — present the ranked offers (each with retained CLV, cost, net value) matched to the reason; recommend the top one and explain why; offer a what-if; draft the call-resolution summary → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved offer to `care_actions` (records offer_type, the drafted summary, predicted retained CLV), append an audit entry — one atomic write.

### Agent tools (Streamline) — one example set
| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates the churn risk over the governed lakehouse | Investigation |
| `find_atrisk_subscriber` | Queries Lakebase: the at-risk position for a `{subscriber_id}` (or the worst open) — risk, reason, open tickets, CLV at risk | Discovery |
| `search_history` | Lakebase Search over the subscriber's service history (tickets + network events, `service_summary`) to explain **why** they're at risk (the outage + billing ticket) | Discovery (reason context) |
| `rank_offers` | Queries Lakebase `app.retention_recommendations` — returns `recommended_offer`, `predicted_retained_clv_usd`, `predicted_net_value_usd`, and the full `offer_ranking`. **The "ML in the loop" moment** | Discovery |
| `execute_retention_action` | Atomic write to Lakebase `app.care_actions`: records the approved offer + drafted summary + audit. Inputs are a FILTER + the drafted summary | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_retention_action` MUST publish a `dataMutated` event. The Care Desk refetches: the At-risk KPI ticks down, the subscriber row flips to "offer applied" with a badge, the scatter's red dot turns neutral, the CLV-at-risk KPI drops. The user must **see** it without reloading.

## Home page

**Story section:** Persona badge ("Rae Nakamura · SVP Customer Care & Retention · Streamline Telco"), headline ("Our best subscribers are cancelling after an outage"), situation (a node outage + billing friction ~3 weeks ago pushed ~215 valuable subscribers into churn risk with open tickets; ~$0.4M CLV at risk on the sample — the full-base figure is ~$3.9M/yr), goal (find the at-risk subscribers → understand why → make the right offer → approve it), preview bullets.

**Journey diagram:** See the at-risk book → Care Desk | Ask why SUB-0000214 is at risk → starts chat | Rank the offer by reason → the model | Apply the bill credit → action flow.

**Starter chips:** "Which valuable subscribers are at risk?" / "Why is SUB-0000214 about to cancel?" / "What should I offer SUB-0000214?"

**Featured action card:** "Recommend a retention offer for SUB-0000214 — rank bill credit vs plan discount vs device upgrade."

**Activity feed:** Live tail ("Applied bill credit: SUB-0000214, predicted +$1.6K retained CLV", "Offered plan discount to SUB-0031234", "Ranked offers for 3 at-risk subscribers"). Auto-refreshes.

## Scripted demo flow (~3 min)

**Step 1 — "Why is SUB-0000214 at risk of churning, and what should I offer?"** `ask_data` → Genie investigates: a churn score that spiked over three weeks, an open ticket, a node outage on their service. `find_atrisk_subscriber` + `search_history` read the live position + the service history (outage + billing). Suggests ranking the offer.

**Step 2 — "Rank the offer. Use the model."** (unlocks on "risk"/"churn"/"offer"/"SUB-0000214"/"outage"). `rank_offers` → quotes the ranked options. → "**Apply a one-time bill credit** — predicted +$1.6K retained CLV, and it acknowledges the outage (the reason they're leaving). A plan discount: +$0.7K — but they're not leaving over price. A device upgrade: +$0.6K and costs more." Drafts the call-resolution summary. Stops.

**Step 3 — "Yes — apply the bill credit."** (unlocks on "credit"/"offer"/"apply"/"retain"). `execute_retention_action` writes to Lakebase, appends audit, emits `dataMutated`. On screen: the At-risk KPI drops, SUB-0000214's row flips to "offer applied", the scatter dot turns neutral, CLV-at-risk ticks down — no reload. **That live cascade is the story beat.**

**Performance:** narrow Genie questions (20–40s); the position + recommendation lookups are Lakebase reads (sub-second).

All narrative config lives in `config/app.json`. Read it directly.
