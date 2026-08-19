# Workshop - Meridian Bank (Attrition & Next-Best-Action)

**The use case, in plain words:** Meridian is a regional bank. A competitor launched a savings-rate promotion, and the bank's **most valuable, longest-tenured customers** — the ones with big CDs maturing soon — are starting to **move their money out**. You build an app that spots each at-risk customer, recommends the best save — **match the competitor's rate, cross-sell a product they'd value, or have a relationship manager call** — and lets an executive approve it in one click. The data, the recommendation, and the AI that assists are all governed on Databricks, with no broad exposure of customer PII and every AI call bounded and logged for a regulator.

## 🎓 Start here — you build this, it isn't pre-built

Starting point for the Tech Summit FY27 Live Days **AI Customer Challenge**. It ships the **data
generator + specs + a bootstrap app** — **you build the solution** (that's the exercise). Build like
a citizen developer: **describe your intent to Genie Code and iterate**. Work carries forward
milestone → milestone.

### ▶️ How to start

**1. Get the template into your workspace.** Download it from **go/solution-builder** and import the folder into your Databricks workspace (Workspace → *Import*). Everything you need travels with it — work directly from there.

**2. Open a Genie Code session** in that folder and kick it off with this prompt:

> *"Read `README.md`, then all the files under `specifications/`, to build up the full context of
> this workshop — the story, the data model, and each component I need to create. Then read
> `data_generation/generate_data.py` to understand how the raw data is structured. Before doing
> anything, ask me which **catalog and schema** to use. Then run `data_generation/generate_data.py`
> as a **job run** into that catalog/schema to load the raw data. Put all the files you create in
> this project folder — transformation code under `./transformation`, and the dashboard, Genie
> space, and everything else at the root (`./`)."*

From there, build the four milestones below one at a time (SDP pipeline, dashboard, Genie, Lakebase, app, gateway).

**3. Build the four milestones below**, iterating with Genie Code. For the app, point your agent at `app/APP_WORKSHOP.md`.

### What YOU need to create — the four milestones

#### Milestone 1 — Data
*Build the governed data layer the whole solution runs on.*

**You'll learn:** Spark Declarative Pipelines · the medallion model · in-SQL AI (`ai_classify`) · Metric Views · AI/BI dashboards + Genie.

**Steps:**
- **1.1** Run `data_generation/generate_data.py` as a job to load the raw data.
- **1.2** Ask Genie for a data-exploration notebook to understand the data before modeling.
- **1.3** Build the SDP pipeline (`01-lakeflow.md`) → silver + gold + the `gold_nba_recommendations` heuristic.
- **1.4** Create the metric view `mv_customer_risk` (`02-uc-governance.md`).
- **1.5** Build the AI/BI dashboard + Genie space (`04-ai-bi.md`), saved at the root.
- **1.6** *(Optional)* Train the ML NBA model (`03-ml-nba.md`) to overwrite the recommendations.

**Done when:** a running pipeline produces the governed gold tables + metric view + recommendations, with a dashboard and Genie space that answer the story.

#### Milestone 2 — Lakebase
*Serve the data at low latency + add the operational store the app writes to.*

**You'll learn:** Lakebase (managed Postgres) · syncing UC tables (read-only) vs. a writable table · dev branches · Lakebase Search (hybrid).

**Steps:**
- **2.1** Create a Lakebase instance (autoscaling) + a dev branch to iterate safely.
- **2.2** Sync the gold tables in as low-latency **read-only** copies.
- **2.3** Add your own **writable** table `rm_actions` for approved decisions (you can't write to a synced table).
- **2.4** Enable Lakebase Search on `products` — powers the app's **cross-sell** move.

**Done when:** the gold tables are queryable from Postgres, a writable `rm_actions` table exists, and product search is ready.

#### Milestone 3 — Databricks App
*Build the internal tool the person actually uses.*

**You'll learn:** create + deploy a Databricks App from the "Spin Up a Databricks App" template (Lakebase + analytics + model-serving plugins) · app scope permissions + OBO (runs as the user) vs. the app service principal (runs as the SP) · iterative Vibe + DAS build · the discover → recommend → act agent loop with human-in-the-loop · build on the dev branch, keep main clean.

**Steps:**
- **3.1** Work locally with **Vibe** (`vibe update` first, for the latest [Databricks Agent Skills](https://github.com/databricks/databricks-agent-skills) via DAS).
- **3.2** Start from the **bootstrap app in `app/`** (boots, reads Lakebase, shows the at-risk scatter + a working `ask_data` loop). See **`app/APP_WORKSHOP.md`** for the gaps.
- **3.3** Build the three layers: **Visualize** (done) → **Assist** (agent + tools + drafting) → **Act** (write-back with a human approval stop).

**Done when:** an executive sees the at-risk customers, asks why CUST-0000214 is at risk, gets a ranked next-best-action, and approves it — writing back to `rm_actions` and the queue updates live.

#### Milestone 4 — Unity AI Gateway
*Govern the AI the app calls.*

**You'll learn:** Unity AI Gateway · spend caps · content-filter guardrails · inference logging to UC · per-entity attribution.

**Steps:**
- **4.1** Create the AI Gateway with a spend cap, guardrails, and inference logging to a UC table.
- **4.2** Route the app's model calls through it.

**Done when:** every AI call goes through the governed Gateway — capped, guardrailed, logged, and attributable per line of business, defensible to a regulator.

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | Meridian Bank — regional retail + commercial bank (~$35B assets, ~1.8M customers, ~180 branches) |
| **Hero** | Marcus Bell, EVP Consumer & Small Business Banking (non-technical) |
| **Problem** | A competitor rate promotion ~3 weeks ago pushed the bank's most valuable customers with maturing CDs into elevated attrition risk — balance starting to walk |
| **Investigation** | Marcus asks *"CUST-0000214 is high-risk — what's the next best action?"* — the platform ranks retention offer vs. cross-sell vs. RM outreach |
| **Root cause** | High-value, rate-sensitive customers holding maturing deposits; the overnight extract RMs work from can't see the risk climb until the money has moved |
| **Impact** | ~$159M balance-at-risk across ~220 critical customers, ~$4M/yr revenue-at-risk — concentrated in the affluent/private tiers on the affected deposit products |

---

## Overview

Marcus Bell (EVP Consumer & Small Business Banking) opens his RM console and sees a red cluster on one chart: his most valuable, longest-tenured customers — high balances, maturing CDs — sliding into attrition risk since a competitor launched a savings-rate promotion 3 weeks ago, with balance starting to flow out. He asks about the worst account — *"CUST-0000214 is high-risk, what's the next best action?"* — and the app ranks **retention offer / cross-sell / RM outreach** by retained revenue, recommends the rate-match retention offer, drafts the outreach note, and writes it back after he approves. Governed customer-360 data, a governed recommendation, and a governed AI assistant — end to end, with PII minimized and every AI call defensible to a regulator.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Customers (sampled) | ~40,000 (the ~1.8M book is talking-track) |
| Tiers | mass / mass_affluent / affluent / private (value bands) |
| Hero customer | CUST-0000214 — 12-year affluent, a large 18-Month CD maturing in ~9 days |
| Hero product | 18-Month Certificate of Deposit (`PROD-DEP-2001`) |
| Competitor promo onset | ~3 weeks ago (dynamic — `PROMO_ONSET = NOW − 3 weeks`) |
| Critical at-risk customers | ~220 (affluent/private, attrition risk 0.75–0.9) |
| Watch/elevated at-risk customers | ~120 (moderate risk, smaller balances) |
| Balance at risk | ~$159M on the affected deposits |
| Revenue at risk | ~$4M annualized |
| Next best action ranked by model | retention offer / cross-sell / RM outreach + predicted retained revenue |
| Assistant AI spend | Capped, per-line-of-business attributable, ~$300K/yr bounded, regulator-defensible |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Relationships app: a balance-vs-risk scatter, a red cluster of high-value customers sliding into attrition risk, with balance-at-risk + revenue-at-risk KPIs.
2. **Ask why** — in the chat dock, ask why CUST-0000214 is at risk; the assistant investigates via Genie over the governed lakehouse.
3. **Get the action** — the assistant ranks retention offer / cross-sell / RM outreach by retained revenue and recommends the retention offer, with a what-if.
4. **Act** — approve → the action + an audit entry write back to Lakebase → the queue and KPIs update live.
5. **Governed AI** — every assistant call runs through Unity AI Gateway (spend cap, guardrails, per-line-of-business logging) — no broad PII exposure, defensible to a regulator.

Full per-component detail is in `specifications/`; the build steps are the four milestones above.
