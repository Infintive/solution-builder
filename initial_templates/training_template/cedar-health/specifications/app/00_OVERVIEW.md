# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST and follow it end-to-end (rsync template → customize → Lakebase → env → smoke test → deploy). This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, and scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md` for what's preserved vs customized, then rewrite domain pieces (home narrative, agent tools, Lakebase schema, analytics SQL, theming) to match this story. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** **Milestone 2 (Lakebase)** = the data model in `03_DATA_MODEL.md` (a synced read-only patient panel + a writable care-actions table); **Milestone 3 (Databricks Apps)** = this app's three layers **Visualize → Assist → Act**; **Milestone 4 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap, guardrails, PHI-boundary-preserving inference logging) — the hero question is *"PT-0000214 is at risk of readmission — which intervention should I run, and can my team absorb it?"*.

## Pitch

AI assistant that **investigates a patient's readmission risk, ranks the intervention against team capacity, and assigns it** in one conversation. Dr. Wren watches every step live: the assistant asks Genie why PT-0000214's risk climbed, reads the live Lakebase panel + the open care gaps + capacity headroom, then **looks up the ranked intervention recommendation** (`app.intervention_recommendations`, mirrored from the `gold_intervention_recommendations` table the pipeline builds via a heuristic — optionally an ML model, `03-ml-intervention.md`) to rank the three plays — follow-up call / med reconciliation / home-health referral — each with projected risk reduction, cost, and the load it adds against current capacity. It explains *why* the follow-up call wins (recent discharge + an open follow-up gap), offers a what-if, drafts the care-plan summary, and **stops for approval**. Dr. Wren approves → the assignment + an audit entry write to Lakebase → the panel + KPI tiles tick live. Every action is traced in MLflow; every model call is governed by Unity AI Gateway, keeping PHI inside the boundary.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | Read surface (synced read-only `patient_position`) AND write surface (writable `care_actions`). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` routes the "why is this patient at risk?" investigation to the Genie space; reasoning streams into the Thinking panel. |
| **ML model (UC-registered)** | The `intervention_recommender` model's batch output feeds the agent's ranking via `app.intervention_recommendations`. The app never calls the model directly; it reads the predictions. |
| **AI Functions (`ai_classify`)** | Risk-signal score (0–1) from each coordinator note's free text, mirrored on the panel row. |
| **Unity AI Gateway** | The assistant's model endpoint runs through the Gateway — spend cap (~$250K/yr bounded on thin margins), guardrails, inference logging inside the PHI boundary, no egress. |
| **MLflow tracing** | Per-turn traces with tool spans; thumbs up/down → human assessments. |
| **Databricks Apps** | SSO, OBO auth (assignments stamped with the coordinator's identity; PHI scoped by OBO), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded iframe with SSO — the population-health dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Patient Panel** | The at-risk patient surface — a risk scatter/map + an at-risk queue, KPI cards (Readmission exposure / Open gaps / Critical patients), detail drawer with the ranked interventions + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: readmission-risk trend on the affected cohort, worst patients, per-condition risk mix | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page (floating dock + full-page chat), one brain.

### The three layers (Visualize / Assist / Act)
- **Visualize** (Patient Panel) — the live patient risk scatter + queue makes the important thing obvious: a red cluster of recently-discharged high-risk patients with open care gaps. Reads synced Lakebase panel data.
- **Assist** (the agent) — explains why a patient is flagged, ranks the intervention against capacity, offers a what-if. Reads the model's recommendation + the live panel + provider directory.
- **Act** (the write) — after human approval, writes the chosen intervention (followup_call/med_reconciliation/home_health_referral) to the writable Lakebase `care_actions` table; the Patient Panel cascades.

### Thinking panel
Streams reasoning + the Genie investigation ("querying patient risk", "found open follow-up gap") + tool calls. Persisted on the message as `thinking[]` JSONB.

### Human-in-the-loop — strict 3-phase action chain
1. **Discover** — read the at-risk patient (risk, open gaps, days since discharge, capacity headroom), **look up the ranked intervention recommendation** (read-only).
2. **Draft + confirm** — present the ranked options (each with projected risk reduction, cost, coordinator hours, and whether it fits current capacity); recommend the top one and explain why; offer a what-if; draft the care-plan summary → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved intervention to `care_actions` (records intervention_type, provider if a referral, the drafted summary, predicted risk reduction), append an audit entry — one atomic write.

### Agent tools (Cedar) — one example set
| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates the risk over the governed lakehouse | Investigation |
| `find_atrisk_patient` | Queries Lakebase: the at-risk position for a `{patient_id}` (or the worst open) — risk, open gaps, days since discharge, exposure, capacity headroom | Discovery |
| `search_providers` | Lakebase Search over the provider directory (`providers`: name + description) to find a suitable **home-health** program for the referral option — ranked candidates | Discovery (referral context) |
| `rank_interventions` | Queries Lakebase `app.intervention_recommendations` — returns `recommended_intervention`, `predicted_risk_reduction`, `predicted_net_value_usd`, and the full `intervention_ranking` (all three options). **The "ML in the loop" moment** | Discovery |
| `execute_care_action` | Atomic write to Lakebase `app.care_actions`: records the approved intervention + drafted summary + audit. Inputs are a FILTER + the drafted summary, never a list of IDs | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_care_action` MUST publish a `dataMutated` event. The Patient Panel refetches: the At-risk KPI ticks down, the patient row flips to "intervention assigned" with a badge, the scatter's red dot turns neutral, the exposure KPI drops. The user must **see** it without reloading — that live cascade is the moment the demo lands.

## Home page

**Story section:** Persona badge ("Dr. Alicia Wren · VP Population Health · Cedar Health"), headline ("Recently-discharged patients are slipping through the follow-up gap"), situation (a discharge wave + follow-up-capacity lag ~3 weeks ago left ~180 recently-discharged HF/COPD/PNA/AMI patients with open care gaps and rising readmission risk; ~$2.5M avoidable-readmission exposure, ~300 open gaps — against finite coordinator capacity), goal (find the at-risk patients → get the intervention that fits capacity → assign it), preview bullets.

**Journey diagram:** See the at-risk panel → Patient Panel | Ask why PT-0000214 is at risk → starts chat | Rank the intervention vs capacity → the model | Assign the follow-up call → action flow.

**Starter chips:** "Which recently-discharged patients are at highest readmission risk?" / "Why is PT-0000214 at risk of readmission?" / "Which intervention should we run for PT-0000214, and can we absorb it?"

**Featured action card:** "Recommend an intervention for PT-0000214 — rank follow-up call vs med reconciliation vs home-health against team capacity."

**Activity feed:** Live tail ("Assigned follow-up call: PT-0000214 (HF), projected −0.35 readmission risk", "Referred PT-0031234 to home health", "Ranked interventions for 3 at-risk patients"). Auto-refreshes.

## Scripted demo flow (~3 min)

**Step 1 — "Why is PT-0000214 at risk of readmission, and what are my options?"** `ask_data` → Genie investigates: a risk score that climbed over three weeks, an HF discharge eight days ago, no completed follow-up. `find_atrisk_patient` reads the live panel + open gaps + capacity. Suggests ranking the intervention.

**Step 2 — "Rank the intervention. Use the model."** (unlocks on "risk"/"readmission"/"options"/"PT-0000214"/"gap"). `rank_interventions` → quotes the ranked options. For the **home-health** option, `search_providers` finds a suitable program. → "**Run the 7-day follow-up call** — projected −0.35 readmission risk, 0.5 coordinator hours, fits this week's capacity. Med reconciliation: −0.10 (no adherence flag), 1.5 hours. Home-health referral: −0.22 but $1,200 and over-kill for a patient a call would save." Drafts the care-plan summary. Stops.

**Step 3 — "Yes — assign the follow-up call."** (unlocks on "intervention"/"follow-up"/"assign"/"reduce"). `execute_care_action` writes to Lakebase, appends audit, emits `dataMutated`. On screen: the At-risk KPI drops, PT-0000214's row flips to "intervention assigned", the scatter dot turns neutral, exposure ticks down — no reload. **That live cascade is the story beat.**

**Performance:** narrow Genie questions (20–40s); the panel + recommendation lookups are Lakebase reads (sub-second).

All narrative config lives in `config/app.json`. Read it directly.
