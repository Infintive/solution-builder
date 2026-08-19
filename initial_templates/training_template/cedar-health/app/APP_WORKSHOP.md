# Cedar Care Coordinator — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the at-risk patient queue reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie/MAS investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Milestone 4 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

Cedar Health's care-coordination team manages ~30K patients. A wave of Heart-Failure (+ COPD/pneumonia/AMI) discharges ~3 weeks ago created a post-acute-care-gap backlog — ~180 recently-discharged high-risk patients now have **open 7-day follow-up gaps + medication-reconciliation gaps**, driving readmission risk from a stable ~0.15 baseline to 0.7–0.9. The hero: **PT-0000214** (Heart Failure, discharged ~8 days ago, readmission_risk_score ~0.88, **no 7-day follow-up completed**). The whole app answers one hero question: **"This patient is at risk of readmission — which intervention should I run, and can my team absorb it?"** The three plays: a **7-day follow-up call** (low coordinator load, best risk reduction for recent-discharge + gap-open profile), a **medication reconciliation** (pharmacist review), or a **home-health referral** (highest load + cost; best for frailest/highest-severity). The app ranks them, and the coordinator approves + assigns the chosen action.

The three layers map 1:1 to the enablement build arc: **Visualize (Milestone 3 Apps)** → **Assist (Milestone 3 Apps + the ML step)** → **Act (Milestone 3 Apps)**, all governed by **Unity AI Gateway (Milestone 4)** — with PHI minimized (scoped fields + de-identified `clinical_summary` grounding) and every model call bounded, logged, and attributable per patient/provider.

---

## The data (already generated + validated in `ai_demo_gen.cedar_health`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.care_actions`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `patient_position` | `gold_patient_panel` | yes (synced) | `patient_id`, `primary_condition`, `age_band`, `payer`, `home_metro`, `patient_lat`, `patient_lng`, `clinical_summary`, `days_since_discharge`, `readmission_risk_score`, `open_gap_count`, `has_open_followup`, `has_open_med_recon`, `risk_signal_score`, `severity_weight`, `readmission_exposure_usd`, `risk_band` (`critical`/`elevated`/`watch`/`stable`) |
| `open_atrisk` | `gold_open_atrisk` | yes (synced) | `patient_id`, `readmission_risk_score`, `readmission_exposure_usd`, `days_since_discharge`, `has_open_followup`, `has_open_med_recon`, `severity_weight`, `capacity_headroom_hours`, `candidate_provider_id` |
| `intervention_recommendations` | `gold_intervention_recommendations` | yes (synced) | `patient_id`, `recommended_intervention` (`followup_call`/`med_reconciliation`/`home_health_referral`), `recommended_provider_id`, `predicted_risk_reduction`, `predicted_net_value_usd`, `intervention_ranking` (JSONB: all three options) |
| `providers` | `raw_providers` | yes (synced) | `provider_id`, `provider_name`, `specialty`, `program_type` (`home_health`/`pcp`/`cardiology`/`pulmonology`), `description` (searchable — Lakebase Search target), `accepting_referrals` |
| **`care_actions`** | — (the app's own) | **NO — writable** | `id`(uuid), `patient_id`, `intervention_type`, `provider_id`, `drafted_note`, `predicted_risk_reduction`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_intervention_recommendations` is NOT built yet.** It is produced by the ML step of Milestone 3 (`specifications/03-ml-intervention.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_intervention_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_interventions` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/carecoordination.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/carecoordinator.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/carecoordination.ts` |
| The data-backend `ask_data` tool | already wired in `carecoordinator.ts` (delegates to `server/agent/tools/mas.ts` OR `tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by the Care Coordinator view |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `carecoordinator.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Milestone 2 (Lakebase) — already wired for you

The synced mirrors + the writable `care_actions` table are the Lakebase answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Milestone 2 workshop task is to set up the **real Lakebase Synced Tables** for the three Gold tables and pick your **`ask_data` backend** (a Genie space OR a MAS endpoint):

- Set **ONE** of `GENIE_SPACE_ID` / `MAS_ENDPOINT_NAME` in `.env` (or the DAB). The app registers whichever is set as the `ask_data` tool — no code change needed. The default Cedar Health flow uses **Genie** ("ask why PT-0000214 is at risk").

**Acceptance:** open the app → chat → ask *"Why is PT-0000214 at risk of readmission?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Milestone 3): `find_atrisk_patient` + `rank_interventions` + `search_providers`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/carecoordinator.ts` that TELL the model to call these tools. All three tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented — see APP_WORKSHOP.md"`** until you implement them.

**What YOU build:** replace the three stub `execute` bodies in `server/agent/carecoordinator.ts`. The Lakebase query helpers are waiting in `server/db/queries/carecoordination.ts` — you wire them up.

### 2a. `find_atrisk_patient`

Read the live at-risk position for a patient (or the worst open at-risk if patientId is null) + the open care gaps + intervention context.

- **File:** `server/agent/carecoordinator.ts`, the tool named `find_atrisk_patient` (search for `Not implemented — see APP_WORKSHOP.md Layer 2a`).
- **Signature (already declared):** `find_atrisk_patient({ patientId: string | null })`. Null → return the worst open at-risk by `readmission_exposure_usd`.
- **Lakebase helpers to use** (from `server/db/queries/carecoordination.ts`, imported at the top of `carecoordinator.ts`):
  - `findAtriskPatient(ctx.db, patientId)` → `AtriskPatient | null` — reads `app.patient_position` + `app.open_atrisk` and returns the live position (condition, days since discharge, open gaps, readmission risk, exposure).
- **Expected tool output shape** (an object the model reads):
  ```
  {
    patientId, primaryCondition, readmissionRiskScore, daysSinceDischarge,
    openGapCount, hasOpenFollowup, hasOpenMedRecon,
    readmissionExposureUsd, clinicalSummary
  }
  ```
  If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_atrisk_patient', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_interventions`

Read the ML model's ranked interventions — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/carecoordinator.ts`, the tool named `rank_interventions`.
- **Signature (already declared):** `rank_interventions({ patientId: string })`.
- **Lakebase helper to use:** `rankInterventions(ctx.db, patientId)` → `InterventionRanking | null` — reads `app.intervention_recommendations` (mirrored from `gold_intervention_recommendations`).
- **Expected tool output shape:**
  ```
  {
    patientId, recommendedIntervention,  // 'followup_call' | 'med_reconciliation' | 'home_health_referral'
    recommendedProviderId,               // e.g. PROV-0123 for a home-health referral
    predictedRiskReduction,
    predictedNetValueUsd,
    interventionRanking: [               // ALL three options — quote these in the draft
      { intervention, predictedRiskReduction, predictedNetValueUsd, providerId? },
      ...
    ]
  }
  ```
  Return the ranking directly. If it returns `null`, return `{ scored: false, note: 'No intervention recommendation yet — build + score the intervention_recommender model (Milestone 3 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

### 2c. `search_providers` — Provider search via Lakebase Search

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it when recommending a home-health referral, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_providers` tool body + a Lakebase query helper to perform **hybrid text/vector search** over the provider directory indexed in Lakebase Postgres.

#### 2c-i. The query helper (add to `server/db/queries/carecoordination.ts`)

Add `searchProviders(db, query)` that executes a hybrid search over the `providers` table using **Lakebase Search**:

- **Signature:**
  ```ts
  searchProviders(db: AppDb, query: string): Promise<ProviderResult[]>
  ```
- **What it does:** Lakebase Search is a Milestone-2 capability (set up during Milestone 2 provisioning — see specifications notes on the `providers` table having `Lakebase Search` enabled over name + description fields). Issue a **hybrid full-text + vector search** query over `app.providers` matching on (provider_name, description) and return the top 5–10 ranked candidates sorted by relevance. Each result carries provider_id, provider_name, specialty, program_type, and accepting_referrals.
- **Example behavior:** search query `"home health services for heart failure patients"` → returns **Home Health Direct** (PROV-0045, program_type=home_health, "provides post-discharge monitoring...") and **CardioHome Monitor** (PROV-0089, "specializes in cardiac patients...") as top matches.
- **SQL pattern** — Lakebase Postgres supports full-text search via `tsquery` or `websearch_to_tsquery`, and (if a vector embedding extension is provisioned) vector similarity. Write the query to match your Lakebase provisioning. At minimum, use a **full-text search** over provider_name + description (fast, no ML deps). If vectors are indexed, add a vector similarity clause for hybrid ranking.

#### 2c-ii. The tool body (in `server/agent/carecoordinator.ts`)

Add a new tool `search_providers` or replace the stub:

- **Signature (already declared):** `search_providers({ query: string })`.
- Call `searchProviders(ctx.db, query)` (from the helper above). Wrap in `mlflow.withSpan(..., { name: 'search_providers', spanType: mlflow.SpanType.TOOL })`.
- **Return:**
  ```ts
  {
    found: true,
    candidates: [
      { providerId, providerName, specialty, programType, acceptingReferrals },
      ...
    ]
  }
  ```
  If no matches, return `{ found: false, note: 'No providers match that criteria.' }`.
- **Integration with home-health ranking:** the agent instructions already tell the model: when the ranked options include **home_health_referral**, call `search_providers` with a descriptive query (e.g., *"home health services for heart failure patients"*) to find suitable providers. The tool returns the top candidates; the agent picks the best and quotes it in the draft.

**Acceptance (2a + 2b + 2c):** after building + scoring the model and restarting, chat:
1. *"Why is PT-0000214 at risk, and what are my options?"* → `ask_data` investigates + `find_atrisk_patient` returns the live position (days since discharge, open gaps, risk score).
2. *"Rank the intervention. Use the model."* → `rank_interventions` returns the ranking; the agent quotes **followup_call / med_reconciliation / home_health_referral** each with predicted risk reduction, recommends followup_call (because history says it's best for recent-discharge + gap-open profiles), drafts the care note, and **STOPS for approval**. All tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2:**
> In `server/agent/carecoordinator.ts`, implement the three stubbed tools `find_atrisk_patient`, `rank_interventions`, and `search_providers` (they currently throw "Not implemented"). Use the ready-made helpers from `server/db/queries/carecoordination.ts`: `findAtriskPatient`, `rankInterventions`, `searchProviders`. Match the output shapes documented in `APP_WORKSHOP.md` §Layer 2. Wrap each body in `mlflow.withSpan(...)` like the `ask_data` tool. Return a `{found:false}` / `{scored:false}` object instead of throwing when the row is missing. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

---

## Layer 3 — Act (Milestone 3): `execute_care_action`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval; the client Care Coordinator page + drawer already subscribe to `dataMutated` and will refetch when a write lands. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/carecoordination.ts`)

Add `recordCareAction(db, args)` following the **filter-driven, transactional** pattern (inputs are a FILTER + drafted text, never a list of ids; wrap in `db.transaction`):

- **Signature:**
  ```ts
  recordCareAction(db: AppDb, args: {
    patientId: string;
    interventionType: 'followup_call' | 'med_reconciliation' | 'home_health_referral';
    providerId: string | null;
    draftedNote: string;
    predictedRiskReduction: number;
    userEmail: string;
  }): Promise<{ actionId: string }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.care_actions` a row: `patient_id`, `intervention_type`, `provider_id`, `drafted_note`, `predicted_risk_reduction`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'assigned', notes: 'Care action recorded', tool: 'execute_care_action' }]::jsonb`. Return the generated `id`.
- Use the drizzle `careActions` table import (already exported from `server/db/schema.ts`) or raw `sql` inserts — either is fine; keep it inside `db.transaction(async (tx) => {...})`.

### 3b. The tool body (in `server/agent/carecoordinator.ts`)

Replace the `execute_care_action` stub's `execute` (search `Not implemented — see APP_WORKSHOP.md Layer 3`):

- **Signature (already declared):** `execute_care_action({ patientId, interventionType, providerId, draftedNote, predictedRiskReduction })`.
- Call `recordCareAction(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_care_action', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, actionId, patientId, interventionType, providerId, predictedRiskReduction }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Care Coordinator refresh cascade

The client is already wired: `client/src/lib/events.ts` (`dataMutated`), consumed by the coordinator queue view. The chat turn already emits `dataMutated` when the agent's turn ends (see relevant client code). **So once `execute_care_action` writes to `app.care_actions`, the moment the turn completes:** the at-risk KPI ticks down, the patient row flips to **"Action assigned · followup_call"** status, risk exposure drops by the predicted reduction, and any open detail drawer re-fetches its Activity timeline. **You do not need to add any client code** — just make the write land. If the cascade doesn't fire, confirm `dataMutated.emit()` runs on turn end and that your write committed.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"Why is PT-0000214 at risk and what do I do?"* → investigate → rank → draft → **STOP**.
2. *"Yes — assign the follow-up call."* → `execute_care_action` writes to `app.care_actions`. **Watch the coordinator queue cascade live without a reload:** at-risk count −1, PT-0000214 row → "Action assigned · followup_call", risk exposure −$X, drawer Activity tab gains the recorded action.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/carecoordination.ts` add `recordCareAction(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.care_actions` row (status='approved', approved_by from userEmail, an audit entry). (2) In `server/agent/carecoordinator.ts` implement the `execute_care_action` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Care Coordinator queue updates live after approval.

---

## Milestone 4 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-patient-attributable inference logging** to a UC table.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/carecoordinator.ts`, `baseURL: \`${ctx.databricksHost}/serving-endpoints\``). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$250K/yr bounded per the story), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-patient attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `care_actions.patient_id` / `approved_by` columns to attribute spend per patient / provider / intervention type. (Optional talk-track: surface an "AI spend by intervention" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Milestone 4):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the patient the action targeted.

**Paste-to-agent prompt for Milestone 4:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/carecoordinator.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a spend cap (~$250K/yr), guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per patient/intervention using `care_actions.patient_id` / `approved_by` / `intervention_type`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (patient queue + KPIs from Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie/MAS, config-driven) | ✅ | pick backend in Milestone 2 |
| `find_atrisk_patient`, `rank_interventions` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_providers` (Lakebase Search for home-health) | stub (throws) | **Layer 2c** |
| `execute_care_action` + `recordCareAction` write | stub (throws) | **Layer 3** |
| `dataMutated` → Care Coordinator live cascade | ✅ (fires on your write) | — |
| Unity AI Gateway governance | scope declared | **Milestone 4** |

**Run it locally:** `./start.sh` (installs deps, builds the frontend, boots on `DATABRICKS_APP_PORT` or `8765`). Reset the demo between runs with the Reset-demo admin action (`POST /api/admin/reset`) — it truncates `care_actions` + re-syncs the read-only mirrors, so at-risk patients return to their baseline risk and the queue resets.
