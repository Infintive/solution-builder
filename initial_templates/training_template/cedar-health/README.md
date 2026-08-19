# Workshop - Cedar Health (Readmission Risk & Intervention)

**The use case, in plain words:** Cedar Health is a hospital system paid to keep patients well. Some recently-discharged patients are **sliding toward an avoidable readmission** — a missed follow-up call, a medication problem — and each readmission costs ~$15K and puts reimbursement at risk. You build an app that spots each rising-risk patient, recommends the best intervention — **a 7-day follow-up call, a medication reconciliation, or a home-health referral** — weighed against what the coordination team can actually absorb, and lets a population-health lead approve it in one click. The data, the recommendation, and the AI that assists are all governed on Databricks, with PHI kept inside the boundary and AI spend capped on thin margins.

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
- **1.3** Build the SDP pipeline (`01-lakeflow.md`) → silver + gold + the `gold_intervention_recommendations` heuristic.
- **1.4** Create the metric view `mv_patient_risk` (`02-uc-governance.md`).
- **1.5** Build the AI/BI dashboard + Genie space (`04-ai-bi.md`), saved at the root.
- **1.6** *(Optional)* Train the ML intervention model (`03-ml-intervention.md`) to overwrite the recommendations.

**Done when:** a running pipeline produces the governed gold tables + metric view + recommendations, with a dashboard and Genie space that answer the story.

#### Milestone 2 — Lakebase
*Serve the data at low latency + add the operational store the app writes to.*

**You'll learn:** Lakebase (managed Postgres) · syncing UC tables (read-only) vs. a writable table · dev branches · Lakebase Search (hybrid).

**Steps:**
- **2.1** Create a Lakebase instance (autoscaling) + a dev branch to iterate safely.
- **2.2** Sync the gold tables in as low-latency **read-only** copies.
- **2.3** Add your own **writable** table `care_actions` for approved decisions (you can't write to a synced table).
- **2.4** Enable Lakebase Search on the `providers` directory — powers the app's **home-health referral** move.

**Done when:** the gold tables are queryable from Postgres, a writable `care_actions` table exists, and provider search is ready.

#### Milestone 3 — Databricks App
*Build the internal tool the person actually uses.*

**You'll learn:** create + deploy a Databricks App from the "Spin Up a Databricks App" template (Lakebase + analytics + model-serving plugins) · app scope permissions + OBO (runs as the user) vs. the app service principal (runs as the SP) · iterative Vibe + DAS build · the discover → recommend → act agent loop with human-in-the-loop · build on the dev branch, keep main clean.

**Steps:**
- **3.1** Work locally with **Vibe** (`vibe update` first, for the latest [Databricks Agent Skills](https://github.com/databricks/databricks-agent-skills) via DAS).
- **3.2** Start from the **bootstrap app in `app/`** (boots, reads Lakebase, shows the patient panel + a working `ask_data` loop). See **`app/APP_WORKSHOP.md`** for the gaps.
- **3.3** Build the three layers: **Visualize** (done) → **Assist** (agent + tools + drafting) → **Act** (write-back with a human approval stop).

**Done when:** a coordinator sees the at-risk patients, asks why PT-0000214 is at risk, gets a ranked intervention (weighed against capacity), and approves it — writing back to `care_actions` and the panel updates live.

#### Milestone 4 — Unity AI Gateway
*Govern the AI the app calls.*

**You'll learn:** Unity AI Gateway · spend caps · content-filter guardrails · inference logging to UC · per-entity attribution.

**Steps:**
- **4.1** Create the AI Gateway with a spend cap, guardrails, and inference logging to a UC table.
- **4.2** Route the app's model calls through it.

**Done when:** every AI call goes through the governed Gateway — capped, guardrailed, logged, and attributable inside the PHI boundary (no egress).

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | Cedar Health — a value-based-care system (~12 hospitals + ~90 clinics, ~$1.5B net patient revenue) |
| **Hero** | Dr. Alicia Wren, VP Population Health (non-technical) |
| **Problem** | A discharge wave + a follow-up-capacity lag left recently-discharged heart-failure patients with open care gaps and rising 30-day readmission risk |
| **Investigation** | Dr. Wren asks *"PT-0000214 is at risk of readmission — which intervention should I run, and can my team absorb it?"* — the platform ranks follow-up call vs. med reconciliation vs. home-health referral against capacity |
| **Root cause** | Post-discharge follow-up capacity lagged a discharge wave; the batch report surfaces the drift after it's too late to act |
| **Impact** | ~$2.5M avoidable-readmission exposure across ~180 at-risk patients, ~300 open care gaps — concentrated in the affected conditions (HF/COPD/PNA/AMI) |

---

## Overview

Dr. Alicia Wren (VP Population Health) opens the care-coordinator panel and sees a red cluster on one chart: recently-discharged heart-failure patients whose 30-day readmission risk climbed after their follow-up gaps stayed open. She asks about the worst — *"PT-0000214 is at risk, which intervention should I run and can my team absorb it?"* — and the app ranks **follow-up call / medication reconciliation / home-health referral** by projected readmission-risk reduction weighed against the team's capacity, recommends the follow-up call (recent discharge + an open follow-up gap, low coordinator load), drafts the care-plan summary, and writes it back after she approves. Governed clinical data, a governed recommendation, and a governed AI assistant — PHI kept inside the boundary, with AI spend capped on thin margins.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Patients (sampled) | ~30,000 |
| Affected conditions | Heart Failure (HF), COPD, Pneumonia (PNA), Acute MI (AMI) |
| Hero patient | PT-0000214 — Heart Failure, discharged ~8 days ago, open 7-day follow-up gap, readmission risk ~0.88 |
| Discharge-wave onset | ~3 weeks ago (dynamic — `SURGE_ONSET = NOW − 3 weeks`) |
| Critical at-risk patients | ~180 (rising readmission risk, open follow-up gaps) |
| Watch-list patients | ~110 (moderate risk, other gap profiles) |
| Avoidable-readmission exposure | ~$2.5M (per-readmission cost ~$15K) |
| Open care gaps | ~300 on the affected cohort |
| Intervention ranked by model | follow-up call / medication reconciliation / home-health referral + projected risk reduction |
| Assistant AI spend | Capped ~$250K/yr on thin margins, PHI kept inside the governed boundary (no egress) |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Patient Panel app: a readmission-risk × days-since-discharge scatter, a red cluster of recently-discharged high-risk patients, with readmission-exposure + open-gap KPIs.
2. **Ask why** — in the chat dock, ask why PT-0000214 is at risk; the assistant investigates via Genie over the governed lakehouse (PHI stays inside).
3. **Get the intervention** — the assistant ranks follow-up call / med reconciliation / home-health referral by projected risk reduction against capacity and recommends the follow-up call, with a what-if.
4. **Act** — approve → the assignment + an audit entry write back to Lakebase → the panel and KPIs update live.
5. **Governed AI** — every assistant call runs through Unity AI Gateway (spend cap, guardrails, PHI-boundary logging), no egress.

Full per-component detail is in `specifications/`; the build steps are the four milestones above.
