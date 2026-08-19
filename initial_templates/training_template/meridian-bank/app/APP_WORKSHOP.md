# Meridian Relationship Desk — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships: **(1)** the plumbing
> (routing, OBO auth, MLflow tracing, SSE streaming, chat dock), **(2) Layer 1 — Visualize**
> (the at-risk customer surface reading Lakebase), and **(3)** the agent loop with a working
> `ask_data` tool (Genie/MAS investigation). You (the trainee, with an agent) build the rest:
> **Layer 2 — Assist**, **Layer 3 — Act**, and **Milestone 4 — Unity AI Gateway**. Each section
> tells you what ships vs what you build, the file paths + tool signatures + Lakebase tables/columns,
> an acceptance check, and a prompt you can paste to an agent. *The tool names below are ONE example
> set — your design is your own; what's graded is the discover → recommend → human-approve → act loop.*

---

## The story (one paragraph)

A competitor rate promotion pushed Meridian's most valuable, longest-tenured customers — big CDs maturing soon — into elevated attrition risk, with balance starting to move out. The hero: **CUST-0000214**, a 12-year affluent customer with a large 18-Month CD (`PROD-DEP-2001`) maturing in ~9 days and a risk score ~0.88. The whole app answers one hero question: **"CUST-0000214 is at risk — what is the next best action?"** The three plays: a **retention offer** (match the competitor rate), a **cross-sell** (a product they qualify for but don't hold), or an **RM outreach** call.

The three layers map 1:1 to the enablement build arc: **Visualize (Milestone 3 Apps)** → **Assist (Milestone 3 Apps + the ML step)** → **Act (Milestone 3 Apps)**, all governed by **Unity AI Gateway (Milestone 4)** — with PII minimized (scoped fields + de-identified `profile_summary` grounding) and every model call bounded, logged, and attributable per line of business.

---

## The data (already generated + validated in `ai_demo_gen.meridian_bank`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.rm_actions`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `customer_position` | `gold_customer_position` | yes (synced) | `customer_id`, `tier`, `tenure_years`, `home_metro`, `customer_lat`, `customer_lng`, `profile_summary`, `attrition_risk_score`, `total_balance_usd`, `affected_deposit_balance_usd`, `min_days_to_maturity`, `balance_at_risk_usd`, `revenue_at_risk_usd`, `risk_band` (`critical`/`elevated`/`watch`/`healthy`) |
| `open_atrisk` | `gold_open_atrisk` | yes (synced) | `customer_id`, `attrition_risk_score`, `balance_at_risk_usd`, `atrisk_product_id`, `atrisk_balance_usd`, `days_to_maturity`, `current_rate_apy`, `candidate_cross_sell_product_id` |
| `nba_recommendations` | `gold_nba_recommendations` | yes (synced) | `customer_id`, `recommended_action` (`retention_offer`/`cross_sell`/`rm_outreach`), `recommended_offer_product_id`, `recommended_rate_apy`, `predicted_retained_usd`, `predicted_net_value_usd`, `action_ranking` (JSONB: all three options) |
| `products` | `raw_products` | yes (synced) | `product_id`, `product_name`, `product_type`, `segment`, `rate_apy`, `min_balance_usd`, `description` (searchable text — **Lakebase Search** target) |
| **`rm_actions`** | — (the app's own) | **NO — writable** | `id`(uuid), `customer_id`, `action_type`, `offered_product_id`, `rate_apy`, `drafted_note`, `predicted_retained_usd`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_nba_recommendations` is produced by Milestone 1** (the SDP pipeline heuristic, or the optional ML model in `specifications/03-ml-nba.md`). The app tolerates it being absent — `server/db/sync.ts` leaves that mirror empty and the app still boots + the Visualize layer works. **Once you build the pipeline + it produces `gold_nba_recommendations`, restart the app (or hit Reset-demo) and the mirror fills.** Then `rank_next_best_actions` returns real data.

The Drizzle schema is in `server/db/schema.ts`; query helpers are in `server/db/queries/relationships.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/relationshipdesk.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/relationships.ts` |
| The data-backend `ask_data` tool | already wired in `relationshipdesk.ts` (delegates to `server/agent/tools/mas.ts` OR `tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by the Relationships view |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper, not the raw SDK `tool`.

---

## Milestone 2 (Lakebase) — mostly wired for you

The synced mirrors + the writable `rm_actions` table are the Lakebase answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts` (the `execSql` Delta-read helper is a stub — wire it to the Databricks SQL Statements API as part of your Lakebase work). Your workshop tasks:

- **Set up the real Lakebase Synced Tables** for the four Gold/catalog tables (or keep the boot-time manual sync for the demo).
- **Enable Lakebase Search** on the synced `products` table (hybrid text/vector over `product_name` + `description`) — this powers `search_products` below.
- **Pick your `ask_data` backend:** set **ONE** of `GENIE_SPACE_ID` / `MAS_ENDPOINT_NAME` in `.env` (or the DAB). The default Meridian flow uses **Genie** ("ask why CUST-0000214 is at risk").

**Acceptance:** open the app → chat → ask *"Who are our highest-value customers at risk?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Milestone 3): `find_atrisk_customer` + `search_products` + `rank_next_best_actions`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/relationshipdesk.ts` that TELL the model to call these tools. The tools are **registered** (so the model knows they exist) but **throw `"Not implemented — see APP_WORKSHOP.md"`** until you implement them.

**What YOU build:** replace the stub `execute` bodies. Wire in the query helpers in `server/db/queries/relationships.ts`.

### 2a. `find_atrisk_customer`
Read the live at-risk position for a `{customer_id}` (or the worst open at-risk) + the maturing deposit + cross-sell candidate.
- **Signature:** `find_atrisk_customer({ customer_id: string | null })`. Null → the worst open at-risk by `revenue_at_risk_usd`.
- **Reads:** `app.open_atrisk` + `app.customer_position` (join on `customer_id`).
- **Output shape:** `{ customer_id, tier, tenure_years, attrition_risk_score, total_balance_usd, atrisk_product_id, atrisk_balance_usd, days_to_maturity, current_rate_apy, balance_at_risk_usd, revenue_at_risk_usd, candidate_cross_sell_product_id }`. If nothing found → `{ found: false }` (do not throw). Wrap in an `mlflow.withSpan(...)` TOOL span like `ask_data`.

### 2b. `search_products` (Lakebase Search)
Find a product the customer qualifies for but doesn't hold — **powers the cross-sell option.**
- **Signature:** `search_products({ query: string })` — e.g. *"wealth advisory account for an affluent long-tenure customer"*.
- **Reads:** `app.products` via **Lakebase Search** (hybrid text/vector over `product_name` + `description`). Returns ranked candidates `{ product_id, product_name, segment, rate_apy, min_balance_usd }`.
- **Acceptance:** a query for a wealth/advisory product returns `PROD-INV-3001` (Wealth Advisory Account) near the top.

### 2c. `rank_next_best_actions`
Read the model's ranked actions — **the demo's "ML in the loop" moment.**
- **Signature:** `rank_next_best_actions({ customer_id: string })`.
- **Reads:** `app.nba_recommendations` for that customer → `{ recommended_action, recommended_offer_product_id, recommended_rate_apy, predicted_retained_usd, predicted_net_value_usd, action_ranking }`. Return `action_ranking` (the three options) verbatim so the model can quote the tradeoff + recompute the what-if arithmetically.
- **Acceptance:** for `CUST-0000214` → `recommended_action = 'retention_offer'` with `action_ranking` showing retention above cross_sell + rm_outreach.

**Paste-to-agent prompt:** *"In `server/agent/relationshipdesk.ts`, implement the three stubbed tools `find_atrisk_customer`, `search_products`, `rank_next_best_actions` using the helpers in `server/db/queries/relationships.ts` and the Lakebase tables in APP_WORKSHOP.md. Keep `.nullable()` (never `.optional()`), snake_case fields, `.describe()` on each, and wrap each body in an mlflow TOOL span. Don't touch `ask_data`."*

---

## Layer 3 — Act (Milestone 3): `execute_nba_action`

The **write** — after the human approves, record the chosen action to the writable `app.rm_actions` table and cascade the UI.

- **Signature:** `execute_nba_action({ customer_id: string, action_type: 'retention_offer'|'cross_sell'|'rm_outreach', offered_product_id: string | null, rate_apy: number | null, drafted_note: string })`. Inputs are a FILTER + the drafted note — never a list of IDs.
- **Writes:** ONE atomic insert/update into `app.rm_actions` (action_type, offered product/rate, drafted note, `predicted_retained_usd` from the recommendation, `status='approved'`, `approved_by`=the OBO email), append an `audit_trail` entry.
- **MUST emit `dataMutated`** so the Relationships page refetches: the At-risk KPI ticks down, the customer's row flips to "action in progress" with an action badge, the scatter's red dot turns neutral, balance-at-risk drops.
- **Human-in-the-loop:** the agent DRAFTS + presents the action and STOPS; `execute_nba_action` only runs after the user confirms ("yes — approve").
- **Acceptance:** approve the hero's retention offer → a `rm_actions` row is written, the Activity tab shows the audit entry, and the queue + KPIs update live without a reload.

**Paste-to-agent prompt:** *"Implement `execute_nba_action` in `server/agent/relationshipdesk.ts`: one atomic write to `app.rm_actions` (see APP_WORKSHOP.md columns), stamp `approved_by` from the OBO identity, append an audit_trail entry, and publish a `dataMutated` event so the Relationships view refetches. It must only run after human approval."*

---

## Milestone 4 — Unity AI Gateway (govern the AI)

Route the agent's model calls through a Unity AI Gateway endpoint instead of the model directly.

- **What to do:** create the Gateway endpoint (spend cap ~$300K/yr, content-filter guardrails, inference logging to a UC table), then point `config/app.json` `agentModel` (and/or the endpoint the Agents SDK calls) at the governed Gateway endpoint.
- **The teaching point:** every model call the agent makes is then bounded, logged, and attributable per line of business — defensible to a regulator, with no broad PII exposure (the agent already grounds on the de-identified `profile_summary`, not raw PII).
- **Acceptance:** run a chat turn → the call appears in the Gateway's inference log (UC table) with usage attributed; exceeding the cap is rejected.

**Paste-to-agent prompt:** *"Point the app's agent model at my Unity AI Gateway endpoint <name> in `config/app.json` (`agentModel`) and confirm a chat turn's model call shows up in the Gateway inference log with per-LOB attribution."*

---

## Definition of done (the graded loop)

Open the app, ask why CUST-0000214 is at risk → the agent investigates (`ask_data` + `find_atrisk_customer`), ranks the next best action (`rank_next_best_actions` + `search_products` for the cross-sell option), recommends the **retention offer** with a what-if, drafts the outreach note, and **stops**. You approve → `execute_nba_action` writes to `rm_actions` and the queue + KPIs cascade live. Every model call runs through the AI Gateway. That discover → recommend → **human-approve** → act loop is the deliverable.
