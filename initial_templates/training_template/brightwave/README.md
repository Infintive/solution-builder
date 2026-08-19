# Workshop - Brightwave (Campaign Replication & Budget Rescue)

**The use case, in plain words:** Brightwave is a $1B consumer brand. Some marketing campaigns are **winning big** on a specific channel-and-creative combination while others are **burning about a fifth of the paid budget** — and by the time attribution lands, the quarter is over. You build an app that spots the winners and the underperformers side by side, explains **why** the winners work, recommends the best move for each underperformer — **copy a winning campaign's template, shift its budget to a proven winner, or pause it** — and lets the CMO approve it while the quarter is still in play. The data, the recommendation, and the AI that drafts on-brand copy are all governed on Databricks, with content-generation AI spend capped and observable.

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
- **1.3** Build the SDP pipeline (`01-lakeflow.md`) → silver + gold + the `gold_action_recommendations` heuristic.
- **1.4** Create the metric view `mv_campaign_perf` (`02-uc-governance.md`).
- **1.5** Build the AI/BI dashboard + Genie space (`04-ai-bi.md`), saved at the root.
- **1.6** *(Optional)* Train the ML ROAS-lift model (`03-ml-roas.md`) to overwrite the recommendations.

**Done when:** a running pipeline produces the governed gold tables + metric view + recommendations, with a dashboard and Genie space that answer the story.

#### Milestone 2 — Lakebase
*Serve the data at low latency + add the operational store the app writes to.*

**You'll learn:** Lakebase (managed Postgres) · syncing UC tables (read-only) vs. a writable table · dev branches · Lakebase Search (hybrid).

**Steps:**
- **2.1** Create a Lakebase instance (autoscaling) + a dev branch to iterate safely.
- **2.2** Sync the gold tables in as low-latency **read-only** copies.
- **2.3** Add your own **writable** table `campaign_actions_app` for approved decisions (you can't write to a synced table).
- **2.4** Enable Lakebase Search on the `creatives` catalog — powers the app's **replicate-winner** move.

**Done when:** the gold tables are queryable from Postgres, a writable `campaign_actions_app` table exists, and creative search is ready.

#### Milestone 3 — Databricks App
*Build the internal tool the person actually uses.*

**You'll learn:** create + deploy a Databricks App from the "Spin Up a Databricks App" template (Lakebase + analytics + model-serving plugins) · app scope permissions + OBO (runs as the user) vs. the app service principal (runs as the SP) · iterative Vibe + DAS build · the discover → recommend → act agent loop with human-in-the-loop · build on the dev branch, keep main clean.

**Steps:**
- **3.1** Work locally with **Vibe** (`vibe update` first, for the latest [Databricks Agent Skills](https://github.com/databricks/databricks-agent-skills) via DAS).
- **3.2** Start from the **bootstrap app in `app/`** (boots, reads Lakebase, shows the winner/underperformer view + a working `ask_data` loop). See **`app/APP_WORKSHOP.md`** for the gaps.
- **3.3** Build the three layers: **Visualize** (done) → **Assist** (agent + tools + drafting) → **Act** (write-back with a human approval stop).

**Done when:** the CMO sees the winners vs. underperformers, asks why CMP-0000214 underperforms, gets a ranked action (replicate/reallocate/pause) + a drafted brief, and approves it — writing back to `campaign_actions_app` and the queue updates live.

#### Milestone 4 — Unity AI Gateway
*Govern the AI the app calls.*

**You'll learn:** Unity AI Gateway · spend caps · content-filter guardrails · inference logging to UC · per-entity attribution.

**Steps:**
- **4.1** Create the AI Gateway with a spend cap, guardrails, and inference logging to a UC table.
- **4.2** Route the app's model calls through it.

**Done when:** every AI call goes through the governed Gateway — capped, guardrailed, logged, and attributable on-brand and per-campaign attributable.

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | Brightwave — a ~$1B consumer brand (~$200M annual media spend, dozens of concurrent campaigns) |
| **Hero** | Priya Anand, CMO (non-technical) |
| **Problem** | A cluster of campaigns split into winners (high ROAS on a specific channel+creative) and underperformers (~20% of spend), and attribution lands too late to act mid-quarter |
| **Investigation** | Priya asks *"Which campaigns are winning and why, and how do I replicate that across the ones that aren't?"* — the platform ranks replicate vs. reallocate vs. pause per underperformer |
| **Root cause** | The winning channel+creative+targeting combination is understood weeks later when attribution resolves, after the budget is spent |
| **Impact** | ~$13M recoverable spend on the sampled active underperformers (~$40M/yr at the full $200M media budget — talking-track), ROAS gap of ~4.0 (winners) vs ~1.1 (underperformers) |

---

## Overview

Priya Anand (CMO) opens the marketing console and sees two clusters on one chart: green winners quietly outperforming on a specific social + lifestyle-creative combination, and red underperformers burning ~20% of the paid budget while the quarter is still in play. She asks — *"which campaigns are winning, and how do I replicate that across the ones that aren't?"* — and the app isolates the winners' drivers, ranks **replicate / reallocate / pause** for each underperformer by projected ROAS lift, recommends replicating the winner (a matching winner with a transferable creative exists), drafts the new campaign brief, and writes it back after she approves. Governed campaign + spend data, a governed recommendation, and a governed AI assistant — on-brand, with content-generation AI spend capped and observable.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Campaigns (sampled) | ~2,000 over 18 months |
| Channels | social / search / display / video / email |
| Hero campaign | CMP-0000214 — active underperformer (ROAS ~1.1) with a matching winner (ROAS ~4-5, transferable creative) |
| Divergence sharpened | ~3 weeks ago (dynamic — `DIVERGENCE_RAMP = NOW − 3 weeks`) |
| Winners | ~60 (high ROAS on social + lifestyle creative) |
| Active underperformers | ~90 (low ROAS, ~20% of paid spend, still running) |
| Recoverable spend (sampled) | ~$13M (full-year-budget figure ~$40M — talking-track) |
| ROAS gap | winners ~4.0 vs underperformers ~1.1 |
| Action ranked by model | replicate winner / reallocate budget / pause + predicted ROAS lift |
| Assistant AI spend | Capped ~$300K/yr, on-brand, content-generation attributable |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Campaign Desk app: a ROAS×spend scatter, green winners high + red underperformers low, with recoverable-spend + ROAS-gap KPIs.
2. **Ask why** — in the chat dock, ask which campaigns are winning and why CMP-0000214 is underperforming; the assistant investigates via Genie + the creative catalog over the governed lakehouse.
3. **Get the action** — the assistant ranks replicate / reallocate / pause by projected ROAS lift and recommends replicating the winner, with a what-if + a drafted on-brand brief.
4. **Act** — approve → the action + the brief write back to Lakebase → the queue and KPIs update live.
5. **Governed AI** — every content-generation call runs through Unity AI Gateway (spend cap, guardrails, attribution), keeping it on-brand + bounded.

Full per-component detail is in `specifications/`; the build steps are the four milestones above.
