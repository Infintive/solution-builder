# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST and follow it end-to-end (rsync template → customize → Lakebase → env → smoke test → deploy). This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, and scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md` for what's preserved vs customized, then rewrite domain pieces (home narrative, agent tools, Lakebase schema, analytics SQL, theming) to match this story. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** It is the concrete shape of the three-milestone challenge: **Build 1 (Lakebase)** = the data model in `03_DATA_MODEL.md` (a synced read-only customer-position table + a writable actions table); **Build 2 (Databricks Apps)** = this app's three layers **Visualize → Assist → Act**; **Build 3 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap, guardrails, per-line-of-business attributable inference logging) — talk-track in the app, the "hero question" the whole thing answers is *"CUST-0000214 is at risk — what is the next best action?"*.

## Pitch

AI assistant that **investigates a customer's attrition risk, ranks the next best action, and executes it** in one conversation — not just answers questions. Marcus watches every step happen live: the assistant asks Genie to investigate why CUST-0000214's risk score climbed, reads the live Lakebase position + the maturing CD + the cross-sell eligibility, then **looks up the ranked NBA recommendation** (`app.nba_recommendations`, mirrored from the `gold_nba_recommendations` table the SDP pipeline builds via a heuristic — optionally replaced by an ML model, `03-ml-nba.md`) to rank the three plays — retention offer / cross-sell / RM outreach — each with cost, the customer's value at stake, and predicted retained revenue. It explains *why* the retention offer wins (a large maturing balance + high attrition probability + a rate the competitor is undercutting), offers a what-if, drafts the outreach note, and **stops for approval**. Marcus approves → the action + an audit entry write to Lakebase → the RM queue + KPI tiles tick live. Every action is traced in MLflow and every model call is governed by Unity AI Gateway — defensible to a regulator, with no broad PII exposure.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | The read surface (synced read-only `customer_position` for low-latency per-customer reads) AND the write surface (writable `rm_actions` — the app records approved actions here; a synced UC table is read-only in Postgres, so the app writes to its own table). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` tool routes the "why is this customer at risk?" investigation to the Genie space; reasoning streams into the Thinking panel. |
| **ML model (UC-registered)** | The `nba_recommender` model's batch output feeds the agent's ranking — `app.nba_recommendations(customer_id, recommended_action, predicted_retained_usd, predicted_net_value_usd, action_ranking, …)` is one of the mirrored tables. The app never calls the model directly; it reads the predictions. |
| **AI Functions (`ai_classify`)** | Churn-signal score (0–1) extracted in SDP from each servicing note's free text, mirrored on the position row. The RM view is sortable by churn signal. |
| **Unity AI Gateway** | The assistant's model endpoint is registered through the Gateway — spend cap (~$300K/yr bounded), read guardrails, every call logged to a UC inference table and attributable **per line of business**, defensible to a regulator. Talk-track surfaced via a small "AI spend" panel/link. |
| **MLflow tracing** | Per-turn traces with tool spans. Thumbs up/down → human assessments on traces. |
| **Databricks Apps** | SSO, OBO auth (actions stamped with Marcus's email; PII scoped by OBO), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded as an iframe with SSO — the retention dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Relationships** | The at-risk customer surface — a risk scatter/map + an at-risk queue, KPI cards (Balance-at-risk / Revenue-at-risk / Critical customers), detail drawer with the ranked NBA options + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: attrition-risk trend on the affected cohort, worst accounts, per-tier risk mix | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page. Two surfaces, one brain:
- **Floating dock** (bottom-right) — persistent conversation per user (`kind='demo_dock'`), survives navigation. Hidden on the full-page chat route.
- **Full-page chat** — for longer conversations or reviewing history.

### The three layers (Visualize / Assist / Act)

This is the enablement arc rendered in the app:
- **Visualize** (Relationships page) — the live customer risk scatter + queue makes the important thing obvious at a glance: a red cluster of high-value customers sliding into attrition risk. Reads synced Lakebase position data.
- **Assist** (the agent) — a chat assistant that explains why a customer is flagged, ranks the next best action, and offers a what-if. Reads the NBA model's recommendation + the live position + eligibility.
- **Act** (the write) — after human approval, the app writes the chosen action (retention_offer/cross_sell/rm_outreach) to the writable Lakebase `rm_actions` table; the Relationships page cascades.

### Thinking panel
Top-right floating panel, streams live during agent turns: reasoning steps, the Genie investigation ("querying customer risk", "found maturing CD"), tool calls with inputs/results. Persisted on the message as `thinking[]` JSONB → survives reload (collapsed "Reasoning · N tools" toggle).

### Human-in-the-loop
**Read-only queries** — assistant calls Genie / reads Lakebase, synthesizes an answer. No side effects.

**Action chains** — strict 3-phase:
1. **Discover** — read the at-risk customer (risk score, maturing deposit, balance-at-risk), read the cross-sell eligibility, **look up the ranked NBA recommendation** for this customer (read-only).
2. **Draft + confirm** — present the ranked options (retention_offer/cross_sell/rm_outreach) each with cost, value at stake, and predicted retained $; recommend the top one and explain why; offer a what-if ("what if we match only halfway?"); draft the outreach note → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved action to `rm_actions` (records action_type, offered product/rate, the drafted note, predicted retained $), append an audit entry — one atomic write.

### Agent tools (Meridian)

The agent has five tools, chained so the demo loop is visible: (1) **ask Genie** to investigate, (2) **read Lakebase** for the live at-risk position + maturing deposit, (3) **search the product catalog** to find a cross-sell the customer qualifies for, (4) **read the NBA recommendation** in Lakebase to rank the action, (5) **write Lakebase** atomically after approval.

| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates the risk over the governed lakehouse, streams reasoning to the Thinking panel | Investigation |
| `find_atrisk_customer` | Queries Lakebase: the at-risk position for a `{customer_id}` (or the worst open at-risk) — risk score, maturing deposit, balance-at-risk, revenue-at-risk, days-to-maturity | Discovery |
| `search_products` | Queries Lakebase Search over the product catalog (`products` table: name + description) to find products the customer qualifies for but doesn't hold. Returns ranked candidates with product_id, product_name, segment, rate_apy, min_balance. **Powers the cross-sell action** — when ranking actions, the agent calls this to find a fitting product to offer. Uses hybrid text/vector retrieval over the product catalog indexed in Lakebase Postgres. | Discovery (cross-sell context) |
| `rank_next_best_actions` | Queries Lakebase `app.nba_recommendations` for the `{customer_id}` — returns the `recommended_action`, `predicted_retained_usd`, `predicted_net_value_usd`, and the full `action_ranking` (all three options with their predicted retained $ + net $ + cost). **This is the demo's "ML in the loop" moment** — the agent quotes the ranked options + the recommended action in the draft, and recomputes the what-if arithmetically from `action_ranking`. | Discovery |
| `execute_nba_action` | Bulk/atomic write to Lakebase `app.rm_actions`: records the approved action (action_type, offered product/rate, drafted note, predicted retained $), appends an audit entry. Inputs are a FILTER (`{customer_id, action_type, offered_product_id?, rate_apy?}`) + the drafted note text — never a list of IDs. | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_nba_action` MUST publish a `dataMutated` event on commit. The Relationships page subscribes and refetches: the At-risk KPI ticks down, the affected customer row flips to "action in progress" and gains an action badge (Retention / Cross-sell / Outreach), the scatter's red dot for the customer turns neutral, the balance-at-risk KPI drops by the customer's balance-at-risk, and any open drawer re-fetches its activity timeline. The user must **see** the queue change without reloading — that live cascade is the moment the demo lands.

## Home page

Narrative landing — tells the story in 10s, plays it in 90s.

**Story section:** Persona badge ("Marcus Bell · EVP Consumer & Small Business Banking · Meridian Bank"), headline ("Our best customers are being poached on rate"), situation (a competitor rate promo ~3 weeks ago pushed ~220 high-value, long-tenured customers holding maturing CDs into elevated attrition risk with balance starting to move; ~$159M balance-at-risk, ~$4M revenue-at-risk — *RMs have been feeling it for weeks*), goal (find the at-risk customers → get the next best action → approve it), preview bullets.

**Journey diagram:** 4-beat horizontal strip — See the at-risk book → Relationships | Ask why CUST-0000214 is at risk → starts chat | Rank the next best action → the model | Approve the retention offer → action flow.

**Starter chips:** "Who are our highest-value customers at risk?" / "Why is CUST-0000214 at risk of leaving?" / "What's the next best action for CUST-0000214?" — each starts a fresh conversation.

**Featured action card:** "Recommend a next best action for CUST-0000214 — rank retention offer vs cross-sell vs outreach" — one click triggers the full investigate → rank → draft → approve flow.

**Activity feed:** Live tail of agent actions ("Approved retention offer: match 3.85% on CUST-0000214's maturing CD, predicted +$37K retained", "Logged cross-sell: Wealth Advisory to CUST-0031234", "Ranked NBA for 3 at-risk customers"). Auto-refreshes.

## Scripted demo flow (~3 min)

Assistant supports a scripted chain via `config.assistantScript`. After each response, a "Suggested next" chip appears if trigger keywords are detected in the previous answer.

**Step 1 — "Why is CUST-0000214 at risk of leaving, and what are my options?"**
Always available. `ask_data` → Genie investigates: a risk score that climbed sharply over three weeks, a large CD maturing in nine days, and balance starting to transfer out. `find_atrisk_customer` reads the live position + the maturing deposit. Thinking panel shows the routing live. Suggests ranking the next best action.

**Step 2 — "Rank the next best action. Use the model."**
Unlocks when "risk"/"at risk"/"options"/"CUST-0000214"/"maturing" in the previous answer. Agent calls `rank_next_best_actions` → quotes the ranked options. For the **cross-sell** option, calls `search_products` with a query like *"wealth advisory account for an affluent long-tenure customer"* to find the **Wealth Advisory Account** as a fitting offer → "**Match the competitor's 3.85% on the maturing CD** — predicted +$37K retained, protects a 12-year relationship. Cross-sell Wealth Advisory: +$10K but they're leaving over rate, not product breadth. RM outreach alone: +$5K, weakest save on a rate-shopper." Drafts the outreach note. Shows the ranked list + the what-if slider. Stops and waits.

**Step 3 — "Yes — approve the retention offer."**
Unlocks when "retention"/"offer"/"approve"/"retain" mentioned. `execute_nba_action` runs one atomic write on Lakebase: records the retention offer + drafted note, appends audit. Then emits `dataMutated`. On screen: the At-risk KPI drops, CUST-0000214's row flips to "action in progress" with a **Retention** badge, the scatter's red dot turns neutral, balance-at-risk ticks down, and any open drawer re-fetches its timeline — all without Marcus touching anything. **That live cascade is the story beat — confirm it works before demoing.**

**Performance:** Agent prompt steers toward narrow Genie questions (20–40s). The at-risk + recommendation lookups are Lakebase reads — sub-second.

All narrative config lives in `config/app.json` — persona, story, starter questions, assistantScript (with triggerAfter keywords), featuredAction, resource IDs. Read it directly.
