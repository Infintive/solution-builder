# Workshop - Streamline Telco (Churn Save on the Call)

**The use case, in plain words:** Streamline is a broadband + mobile carrier. A network outage on one service node collided with a billing problem, and a cluster of subscribers is **about to cancel** — the save moment is on the call, but agents working from last-night's screen can't see the history in time. You build an app that spots each at-risk subscriber, explains **why** they're at risk, recommends the best offer — **a bill credit, a plan discount, or a device upgrade** — matched to the reason, and lets a care lead approve it in one click. The data, the recommendation, and the AI that assists are all governed on Databricks, fast enough for a full contact center, with AI spend that stays predictable per call.

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
- **1.3** Build the SDP pipeline (`01-lakeflow.md`) → silver + gold + the `gold_retention_recommendations` heuristic.
- **1.4** Create the metric view `mv_subscriber_risk` (`02-uc-governance.md`).
- **1.5** Build the AI/BI dashboard + Genie space (`04-ai-bi.md`), saved at the root.
- **1.6** *(Optional)* Train the ML churn model (`03-ml-churn.md`) to overwrite the recommendations.

**Done when:** a running pipeline produces the governed gold tables + metric view + recommendations, with a dashboard and Genie space that answer the story.

#### Milestone 2 — Lakebase
*Serve the data at low latency + add the operational store the app writes to.*

**You'll learn:** Lakebase (managed Postgres) · syncing UC tables (read-only) vs. a writable table · dev branches · Lakebase Search (hybrid).

**Steps:**
- **2.1** Create a Lakebase instance (autoscaling) + a dev branch to iterate safely.
- **2.2** Sync the gold tables in as low-latency **read-only** copies.
- **2.3** Add your own **writable** table `care_actions` for approved decisions (you can't write to a synced table).
- **2.4** Enable Lakebase Search on subscriber service history + `offers` — powers the app's **explain-why + offer** move.

**Done when:** the gold tables are queryable from Postgres, a writable `care_actions` table exists, and history + offer search is ready.

#### Milestone 3 — Databricks App
*Build the internal tool the person actually uses.*

**You'll learn:** create + deploy a Databricks App from the "Spin Up a Databricks App" template (Lakebase + analytics + model-serving plugins) · app scope permissions + OBO (runs as the user) vs. the app service principal (runs as the SP) · iterative Vibe + DAS build · the discover → recommend → act agent loop with human-in-the-loop · build on the dev branch, keep main clean.

**Steps:**
- **3.1** Work locally with **Vibe** (`vibe update` first, for the latest [Databricks Agent Skills](https://github.com/databricks/databricks-agent-skills) via DAS).
- **3.2** Start from the **bootstrap app in `app/`** (boots, reads Lakebase, shows the at-risk subscriber view + a working `ask_data` loop). See **`app/APP_WORKSHOP.md`** for the gaps.
- **3.3** Build the three layers: **Visualize** (done) → **Assist** (agent + tools + drafting) → **Act** (write-back with a human approval stop).

**Done when:** a care lead sees the at-risk subscribers, asks why SUB-0000214 is at risk, gets the reason + a ranked offer, and approves it — writing back to `care_actions` and the queue updates live.

#### Milestone 4 — Unity AI Gateway
*Govern the AI the app calls.*

**You'll learn:** Unity AI Gateway · spend caps · content-filter guardrails · inference logging to UC · per-entity attribution.

**Steps:**
- **4.1** Create the AI Gateway with a spend cap, guardrails, and inference logging to a UC table.
- **4.2** Route the app's model calls through it.

**Done when:** every AI call goes through the governed Gateway — capped, guardrailed, logged, and attributable per call at contact-center scale.

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | Streamline Telco — broadband + mobile + streaming (~$3.2B revenue, ~4M subscribers, ~$68 ARPU) |
| **Hero** | Rae Nakamura, SVP Customer Care & Retention (non-technical) |
| **Problem** | A network outage on one node collided with billing friction and a competitor promo, pushing a cluster of subscribers into churn risk |
| **Investigation** | Rae asks *"Why is SUB-0000214 at risk, and what should I offer?"* — the platform surfaces the reason (service, not price) and ranks bill credit vs. plan discount vs. device upgrade |
| **Root cause** | The save moment is on the call, but agents on last-night's screen can't see the outage + billing history in time |
| **Impact** | ~$0.4M CLV at risk on the sampled at-risk cohort (~$3.9M/yr at the full 4M-subscriber base per 0.1pt of monthly churn avoided), ~350 open tickets — concentrated on the outage node |

---

## Overview

Rae Nakamura (SVP Customer Care & Retention) opens the care-agent console and sees a red cluster on one chart: valuable, long-tenured subscribers whose churn risk spiked after a node outage collided with a billing issue. She asks about the worst account — *"Why is SUB-0000214 at risk, and what do I offer?"* — and the app surfaces the reason (service, not price), ranks **bill credit / plan discount / device upgrade** by retained CLV, recommends the bill credit (it acknowledges the outage), drafts the call-resolution summary, and writes it back after she approves. Governed subscriber data, a governed recommendation, and a governed AI assistant — fast at full contact-center concurrency, with AI spend predictable per call.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Subscribers (sampled) | ~40,000 (the ~4M base is talking-track) |
| Plans | broadband / mobile / bundle |
| Hero subscriber | SUB-0000214 — 5-year, on outage node NODE-OHIO-14, open billing ticket, churn risk ~0.86, reason = service |
| Outage onset | ~3 weeks ago (dynamic — `OUTAGE_ONSET = NOW − 3 weeks`) |
| At-risk subscribers (critical/elevated) | ~215 (open tickets, elevated churn risk) |
| Watch-list subscribers | ~85 (moderate risk, price/device reasons) |
| CLV at risk (sampled) | ~$0.4M (full-base figure ~$3.9M/yr — talking-track) |
| Retention offer ranked by model | bill credit / plan discount / device upgrade + predicted retained CLV |
| Assistant AI spend | Capped, predictable per call at full contact-center concurrency |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Care Desk app: a churn-risk scatter, a red cluster of valuable subscribers at risk, with CLV-at-risk + open-ticket KPIs.
2. **Ask why** — in the chat dock, ask why SUB-0000214 is at risk; the assistant investigates via Genie + the service history over the governed lakehouse.
3. **Get the offer** — the assistant surfaces the reason (service) and ranks bill credit / plan discount / device upgrade by retained CLV, recommending the bill credit, with a what-if.
4. **Act** — approve → the retention offer writes back to Lakebase → the queue and KPIs update live.
5. **Governed AI** — every assistant call runs through Unity AI Gateway (spend cap, guardrails, per-call logging), predictable at contact-center scale.

Full per-component detail is in `specifications/`; the build steps are the four milestones above.
