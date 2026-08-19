# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The system**: Cedar Health — a value-based-care system (~12 hospitals + ~90 clinics, ~$1.5B net patient revenue, ~20K annual discharges). The demo samples ~30K patients so joins stay cheap.

**The affected condition cohort** (deterministic — the readmission-risk cluster; must exist with these exact values). These are the high-readmission-risk conditions the demo spotlights (post-acute care gaps drive readmits):

| condition_code | condition_name | baseline_readmit_rate | severity_weight |
|----------------|----------------|-----------------------|-----------------|
| HF | Heart Failure (CHF) | 0.22 | 1.0 |
| COPD | Chronic Obstructive Pulmonary Disease | 0.19 | 0.85 |
| PNA | Pneumonia | 0.16 | 0.7 |
| AMI | Acute Myocardial Infarction | 0.18 | 0.9 |

`HF` (**Heart Failure**) is the **hero condition** — the highest-volume, highest-cost readmission driver the demo spotlights on the hero patient.

The **intervention catalog** (the three plays a coordinator can run, plus the provider directory for referrals) carries a searchable **`description`** (what the intervention is, who it's for, expected effect) — the text **Lakebase Search** (Milestone 2) indexes, and what the app's care-context search + the **home-health referral** intervention query run over (matching a patient to a suitable home-health provider / program).

**Hero patient**: `PT-0000214` — a Heart Failure patient discharged ~8 days ago, **no completed 7-day follow-up**, a **medication-adherence flag**, and an open care gap. The demo's spotlight at-risk patient. Deterministic. Its readmission-risk score is high (~0.88) and the recommended intervention the heuristic ranks first is a **7-day follow-up call** — because for this patient's gap profile (recent discharge, missed follow-up), the projected risk reduction per unit of coordinator capacity beats medication reconciliation and a home-health referral.

**The anomaly (one driver, two visible symptoms)**: ~3 weeks ago a wave of Heart-Failure (+ the other affected conditions) discharges hit a stretch where post-discharge follow-up capacity lagged, leaving **care gaps open** (missed 7-day follow-up, unreconciled meds). On the **affected-condition cohort**:
- **Risk side (the alarm)** — ~180 recently-discharged affected-condition patients crossed into **elevated 30-day readmission risk** (`readmission_risk_score` climbing from a ~0.15 baseline to ~0.7–0.9) in the last ~3 weeks, with **open care gaps** (no follow-up completed) → avoidable readmissions building (shown RED).
- **Capacity side** — the coordination team has finite weekly capacity; the at-risk queue now exceeds what they can touch, so the ranking must weigh **risk reduction against the load each intervention adds** (the "can my team absorb it?" half of the hero question).
- **Healthy side** — the rest of the sampled patient panel (~30K) sits at a normal ~0.03–0.2 risk with follow-ups completed (shown STEEL/blue).

This is the load-bearing shape: **recently-discharged high-risk-condition patients, rising readmission risk, open care gaps, concentrated in a recent 3-week window, against finite coordinator capacity** — legible on one panel (a readmission-risk × days-since-discharge scatter, a red cluster in the high-risk/recent-discharge quadrant). The recommended action ("run a 7-day follow-up call") is literally supported by the data because the patient has an OPEN follow-up gap and history says closing it cuts readmission risk most for this profile.

**Care-gap notes** (verbatim coordinator/clinical-note phrases, used predominantly on the affected at-risk patients — feed the note pool in Section A so `ai_classify` has a clear signal). Rising-risk tone: *"no follow-up completed, 8 days post-discharge"*, *"patient reports missed medication doses"*, *"unable to reach for follow-up call"*, *"symptoms worsening, edema noted"*, *"no PCP appointment scheduled"*. Healthy tone (for stable patients): *"follow-up completed, stable"*, *"adherent, no concerns"*. These must be exact substrings — Genie + the dashboard search for them.

**PHI posture (the HLS-specific teaching point)**: the patient panel carries names + MRN only as a minimal display field; the story is about serving a coordinator screen + grounding an intervention recommendation **while PHI stays inside the governed boundary (no egress)** — the app reads scoped fields, Lakebase Search grounds on `clinical_summary` text (de-identified, condition + gap + course, not raw PHI), and the AI Gateway keeps model calls inside the boundary + logged. Generate a `patient_display_name` (minimal) + a de-identified `clinical_summary` (condition, days since discharge, care gaps, adherence) — the latter is what search + the assistant ground on.

**Time references**: `NOW = datetime.now()` by default (rolling — the panel's right edge is always yesterday-real; set `CEDAR_PIN_TIME=1` to freeze `NOW` for recorded videos / baked-in IDs). `HISTORY_START = NOW − 18 months` (encounter + intervention history for the model). `SURGE_ONSET = NOW − 21 days` (~3 weeks back — the discharge wave / follow-up-capacity lag begins). `RISK_RAMP = NOW − 18 days` (affected patients' risk scores climb). `SNAPSHOT_DATE = NOW − 1 day` (the "current" patient-panel snapshot the app + dashboard read). **Causal chain**: stable panel before −3w → discharge wave + follow-up lag at −3w → affected patients' care gaps stay open and risk ramps −3w to −1w → everyone else stable → the CURRENT snapshot (yesterday) shows the at-risk cluster. Peak of the risk divergence sits in the past week-and-a-half, clearly to the left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen` (read `SKILLS/databricks-synthetic-data-gen/SKILL.md`). Use the pre-provisioned databricks-connect venv (Python 3.12 + faker + numpy + pandas + pyarrow) — system prompt has the path; do NOT create a new venv. Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window functions + `F.element_at` against literal arrays. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, named without the `raw_` prefix). This Volume is the raw landing zone; SDP silver reads it via `read_files()` — no bronze pass-through, no raw Delta tables:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_patients` | ~30,000 | Sampled patient master. `primary_condition` (the affected codes + a spread of others), `age_band`, `home_clinic_id`, `patient_lat`/`patient_lng` (metro anchor + jitter — drives the panel map), `payer` (Medicare/Medicaid/Commercial), `patient_display_name` (minimal), **`clinical_summary`** (de-identified searchable blurb: condition, recent course, care gaps — the text Lakebase Search indexes). `PT-0000214` pinned as the HF hero. |
| `raw_encounters` | ~180,000 | 18 months of encounters (admissions, discharges, ED visits, clinic visits). One row per encounter with `encounter_type`, `admit_date`, `discharge_date` (nullable), `primary_condition`, `length_of_stay_days`, `is_readmission` (30-day). The affected cohort's recent discharges live here (discharge ~8–21 days ago). |
| `raw_care_gaps` | ~90,000 | Open + closed care gaps per patient. `gap_type` (`followup_7day`/`med_reconciliation`/`pcp_visit`/`home_health`), `opened_date`, `closed_date` (nullable — NULL = open), `status`. The affected cohort has OPEN `followup_7day` + `med_reconciliation` gaps; the hero's follow-up gap is open. |
| `raw_risk_snapshots` | ~200K | Daily `readmission_risk_score` (0–1) for the affected patients across the last ~14 days + a current-snapshot (`SNAPSHOT_DATE`) sample of everyday patients. Affected → risk ramps to 0.7–0.9; everyday → 0.03–0.2. Carries `coordinator_note_text` (the `ai_classify` signal). |
| `raw_interventions` | ~40K | 18-month history of coordinator interventions on at-risk patients, each with an OUTCOME (`prevented_readmission` bool, `risk_reduction`, `cost_usd`, `coordinator_hours`) — the **training data for the intervention model** (`03-ml-intervention.md`). ~3 intervention types: `followup_call`, `med_reconciliation`, `home_health_referral`. |
| `raw_capacity` | ~5K | Weekly coordination-team capacity by clinic (`available_coordinator_hours`, `committed_hours`) over 18 months — context for the "can my team absorb it?" ranking. Recent weeks show committed approaching available (the squeeze). |

### Data Variation

Encounter volume + risk (on `raw_encounters` / `raw_risk_snapshots`) — the load-bearing shape is the **affected-cohort readmission divergence**, but everyday encounters need realistic rhythm so the anomaly stands out, not drowns:

- **Weekly rhythm** — admissions dip on weekends; ED visits spike Mon; apply ±15% noise.
- **Baseline risk** — most discharged patients sit at a low, stable readmission risk (0.03–0.2) with follow-ups completed. Keep it calm so the affected ramp dominates.
- **Seasonal** — a gentle winter uptick in HF/PNA/COPD admissions (respiratory season) so volume isn't flat, placed so it doesn't collide with the affected-cohort signal (the anomaly reads because it's recent-discharge-and-gapped, not because it's the only movement).

**The affected-cohort split (the whole story):** readmission risk is **condition-and-gap-driven**, not uniform. The discharge wave + follow-up lag pushes the ~180 recently-discharged affected-condition patients with OPEN care gaps from a low baseline to 0.7–0.9 over ~3 weeks; everyone else stays calm. This single rule produces the red high-risk cluster without forcing it.

### Note pool (`coordinator_note_text` on risk snapshots)

~15 hand-coded strings in 2 tones — keeps synth deterministic and gives `ai_classify` a clear signal. **Rising-risk** (must include the Shared-Context care-gap phrases verbatim): assertive "this patient is slipping" tone, attached predominantly to the affected at-risk patients. **Healthy**: "follow-up completed, stable", "adherent, no concerns" — everyday patients. **Distribution** (the classifier's signal): affected at-risk patients → 85% rising-risk / 15% healthy · everyday patients → 10% rising-risk / 90% healthy.

### Patient master + geo

Each patient gets `patient_lat` + `patient_lng` (DOUBLE PRECISION) = home-clinic metro anchor + ~0.05° jitter so points spread. **Required for the story**: the ~180 affected patients spread across the clinic network but concentrate in the affected conditions (HF first). `PT-0000214` pinned to a fixed metro (the flagship hospital's metro). The panel colors by `risk_band` (derived in gold from `readmission_risk_score`), not the raw condition. Lat/lng to 2 decimals is enough.

### The Event

The discharge-wave + follow-up-lag is a **patient×condition risk + care-gap divergence**, not a total-admissions spike:

- **Affected patients** (~180) with an affected condition + a recent discharge (~8–21 days ago): `readmission_risk_score` ramps from a ~0.15 baseline starting `RISK_RAMP` (~2.5 weeks ago), climbing to 0.7–0.9 over ~10 days. `raw_care_gaps` shows their `followup_7day` (+ often `med_reconciliation`) gap **OPEN** (`closed_date` NULL). `coordinator_note_text` on these is predominantly rising-risk-toned.
- **Everyday patients** (~30K): `readmission_risk_score` stays 0.03–0.2, follow-ups completed, notes healthy.
- **Everything else** behaves normally — the divergence is confined to the affected recently-discharged cohort so the anomaly is legible.

Quantify the exposure so the KPIs land: **avoidable-readmission exposure** ≈ **$2.7M** (affected at-risk patients × per-patient readmission probability × ~$15K per readmission); **open care gaps** ≈ **~300** on the affected cohort. These are demo targets — the generation should produce data that rolls up roughly to them.

**Intervention history (`raw_interventions`) — the model's training signal.** Over the 18-month history, generate realistic interventions with outcomes so the model in `03-ml-intervention.md` can learn which intervention reduces readmission risk most in which situation, per unit of coordinator load:
- `followup_call` (a 7-day post-discharge call): low coordinator load (~0.5h); **best risk reduction when a follow-up gap is open and the discharge is recent** (the hero case) — closing the gap early prevents the readmit.
- `med_reconciliation` (a pharmacist medication review): moderate load (~1.5h); best when the driver is medication non-adherence; strong but heavier.
- `home_health_referral` (refer to a home-health program): highest load + cost (external); best for the frailest / highest-severity patients who need in-home monitoring, but slower and more expensive — over-kill for a patient a call would save.
- Make the outcomes **learnable**: follow-up calls on recently-discharged patients with an open follow-up gap show the best `risk_reduction` per `coordinator_hours`; med reconciliation wins on adherence-flagged patients; home-health wins on the highest-severity/frailty cases. This is what lets the model rank `PT-0000214`'s situation as a **follow-up call** — because history says so.

### Raw table schemas (gen output)

ID formats: `PT-NNNNNNN` / `ENC-NNNNNNNN` / `GAP-NNNNNNNN` / `INT-NNNNNNNN` / `PROV-NNNN`. PKs in **bold**, FKs marked. Tables prefix with `raw_` (no bronze).

- **`raw_patients`** — **patient_id**, patient_display_name, primary_condition (`HF/COPD/PNA/AMI` + a spread of others), age_band, home_clinic_id, home_metro, state, `patient_lat`/`patient_lng` (DOUBLE, metro anchor + jitter), payer (`Medicare/Medicaid/Commercial`), enroll_date, **clinical_summary** (STRING — de-identified searchable blurb; the text Lakebase Search + the intervention grounding match on), is_active.
- **`raw_encounters`** — **encounter_id**, patient_id (FK), encounter_type (`inpatient/ed/clinic`), admit_date (DATE), discharge_date (DATE, nullable), primary_condition, length_of_stay_days (INT), is_readmission (BOOLEAN), attending_provider_id (FK to provider directory). One row per encounter.
- **`raw_care_gaps`** — **gap_id**, patient_id (FK), gap_type (`followup_7day/med_reconciliation/pcp_visit/home_health`), opened_date (DATE), closed_date (DATE, nullable — NULL = open), status (`open/closed`). One row per gap.
- **`raw_risk_snapshots`** — patient_id (FK), snapshot_date (DATE), readmission_risk_score (DOUBLE 0–1), open_gap_count (INT), coordinator_note_text (STRING, nullable — populated on affected + a sample of everyday patients). Daily for the last ~14 days + `SNAPSHOT_DATE`.
- **`raw_interventions`** — **intervention_id**, patient_id (FK), intervention_type (`followup_call/med_reconciliation/home_health_referral`), condition (the patient's condition at intervention), risk_at_intervention (DOUBLE), initiated_date (DATE), coordinator_hours (DOUBLE), cost_usd (DOUBLE), prevented_readmission (BOOLEAN), risk_reduction (DOUBLE). 18-month history — the intervention model's labeled outcomes.
- **`raw_capacity`** — clinic_id, week_start (DATE), available_coordinator_hours (DOUBLE), committed_hours (DOUBLE). Weekly coordination-team capacity.
- **`raw_providers`** — **provider_id**, provider_name, specialty, program_type (`home_health/pcp/cardiology/pulmonology`), **description** (STRING — what the program covers, who it's for; the text Lakebase Search + the home-health-referral lookup match on), accepting_referrals (BOOLEAN). The provider/program directory for the home-health referral intervention.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md` before implementing.

Create pipeline `cedar_population_health` transforming raw parquet → analytics tables. Configure with a `configuration: {catalog, schema}` block and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')` so it works on any target catalog/schema.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (readmission exposure $, open gaps #, at-risk #) + trend | readmission/gap exposure metrics by condition + payer + risk band | `mv_patient_risk` metric view (over `gold_patient_panel`, defined in `02-uc-governance.md`) |
| Dashboard scatter/map + at-risk widgets | per patient current position with geo + condition + risk + gaps + band flag | `gold_patient_panel` (widget-level GROUP BY for condition/payer rollups) |
| Genie "who is at risk and why" | same per-patient fact with denormalized encounter + gaps + note | `gold_patient_panel` |
| Intervention model training (`03-ml-intervention.md`) | one row per historical intervention with situational features + outcome label | `gold_intervention_outcomes` |
| Intervention model scoring input | one row per OPEN at-risk patient + candidate-intervention + capacity context | `gold_open_atrisk` |
| App's coordinator queue (at-risk + ranked intervention) | current at-risk with patient/gaps/geo + ranked intervention + projected risk reduction + load | `gold_open_atrisk` JOIN `gold_intervention_recommendations` (built by the pipeline heuristic; ML optional) |
| App's analytics drill-downs (Delta via warehouse) | risk trend, worst patients, per-condition rollups | `silver_risk`, `gold_patient_panel` |

### Raw layer (no bronze pass-through)

The data-gen step in Section A writes 7 raw parquet datasets into the `raw_data` Volume: `patients`, `encounters`, `care_gaps`, `risk_snapshots`, `interventions`, `capacity`, `providers`. SDP silver reads these files via `read_files()` — there is no bronze layer (the gen's output is already typed and clean).

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

Silver materialized views — facts (`silver_encounters`, `silver_risk`, `silver_interventions`, `silver_gaps`) plus one small dedup helper (`note_risk_flags`).

**`note_risk_flags`** — *the `ai_classify` showcase, sized down*. The synth uses a canned pool of ~15 distinct `coordinator_note_text` strings across hundreds of thousands of risk rows. Running `ai_classify` per-row would issue that many LLM calls; instead build a small MV over `SELECT DISTINCT coordinator_note_text` and call `ai_classify` once per distinct string:

```sql
SELECT coordinator_note_text,
  CASE ai_classify(coordinator_note_text,
        ARRAY('rising_risk','at_risk','stable'))
    WHEN 'rising_risk' THEN 1.0
    WHEN 'at_risk'     THEN 0.6
    ELSE 0.1
  END AS risk_signal_score
FROM (SELECT DISTINCT coordinator_note_text FROM raw_risk_snapshots
      WHERE coordinator_note_text IS NOT NULL)
```

`silver_risk` joins back on `coordinator_note_text` so every snapshot inherits the score without a second LLM call. Talking-track: *"one built-in SQL function turns a coordinator's free-text note into a risk signal — no UDF, no separate service, and it scales because we dedup."*

**`silver_encounters`** — per-encounter denormalized fact. `raw_encounters` JOIN `raw_patients` (→ condition, age, geo, payer). Latest discharge per patient + `days_since_discharge`. Cluster by `patient_id`.

**`silver_risk`** — current + recent risk position, denormalized. `raw_risk_snapshots` JOIN `raw_patients` JOIN `note_risk_flags` (→ risk_signal_score). Cluster by `snapshot_date`.

**`silver_gaps`** — open/closed care gaps, denormalized to patient + condition. A per-patient rollup: `open_gap_count`, `has_open_followup` (bool), `has_open_med_recon` (bool).

**`silver_interventions`** — intervention history, denormalized. `raw_interventions` JOIN `raw_patients` (→ condition, age). Powers the intervention-model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every aggregate consumed by the dashboard MUST carry `primary_condition`, `payer`, and `risk_band` as filter dimensions. `gold_patient_panel` enforces this directly.

**`gold_patient_panel`** — *the heart of the demo* — one row per patient reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with condition, recent discharge, open gaps, risk, and a band flag. Built from `silver_risk` (current snapshot) JOIN latest `silver_encounters` + `silver_gaps` rollup on `patient_id`. Dims: `patient_id`, `patient_display_name`, `primary_condition`, `age_band`, `payer`, `home_metro`, `patient_lat`, `patient_lng`, `clinical_summary` (pass-through). Metrics/fields: `days_since_discharge` (nullable), `readmission_risk_score`, `open_gap_count`, `has_open_followup`, `has_open_med_recon`, `risk_signal_score`, and derived measures + a status flag:
- `readmission_exposure_usd` — for at-risk patients: `readmission_risk_score × 15000` (per-readmission cost) when `readmission_risk_score ≥ 0.6` else 0 — the avoidable readmission cost at stake.
- `severity_weight` — the condition's severity weight (join the affected-condition table), used to weight home-health suitability.
- **`risk_band`** (the single column the UI colors by): `'critical'` (`readmission_risk_score ≥ 0.75` AND `has_open_followup`), `'elevated'` (`readmission_risk_score ≥ 0.6`), `'watch'` (`readmission_risk_score ≥ 0.4`), `'stable'` (else). The affected patients → `critical`/`elevated`; everyone else → `stable`.

> `gold_patient_panel` is what the dashboard scatter/map, the metric view, Genie, and the app's coordinator view all read. It is the coherence spine.

**`gold_open_atrisk`** — the current critical/elevated/watch patients the app + model act on. `gold_patient_panel WHERE risk_band IN ('critical','elevated','watch')`, enriched with candidate-intervention + capacity context: the open gaps (`has_open_followup`, `has_open_med_recon`), the `severity_weight`, and the patient's clinic's recent **capacity headroom** (`available_hours − committed_hours` from `raw_capacity`, the "can my team absorb it?" input), plus a candidate home-health `provider_id` (from `raw_providers WHERE accepting_referrals AND program_type='home_health'`). Columns: patient/geo/condition + `readmission_risk_score`, `readmission_exposure_usd`, `days_since_discharge`, `has_open_followup`, `has_open_med_recon`, `severity_weight`, `capacity_headroom_hours`, `candidate_provider_id`.

**`gold_intervention_outcomes`** — intervention history, one row per historical intervention. Pass-through from `silver_interventions` + situational features: `intervention_type`, `risk_at_intervention`, `condition`, `days_since_discharge_at_intervention`, `coordinator_hours`, `cost_usd`, and the OUTCOME `prevented_readmission` + `risk_reduction`. Two uses: (a) the heuristic can derive coefficients from it; (b) the training table for the OPTIONAL ML path.

**`gold_intervention_recommendations`** — *the ranked intervention per open at-risk patient* — **built by the pipeline with a hardcoded HEURISTIC** (no ML needed; ML optional, see `03-ml-intervention.md`). For each row in `gold_open_atrisk`, construct the three candidate interventions and rank by **net value = benefit − cost**, where `benefit = risk_reduction × readmission_cost` ($15K) and cost blends dollar cost + a capacity penalty (interventions that exceed the team's headroom are penalized — the "can my team absorb it?" factor):
- **followup_call**: `risk_reduction ≈ 0.35` when `has_open_followup` AND `days_since_discharge ≤ 14` (best on the hero profile) else ~0.12; `coordinator_hours ≈ 0.5`; `cost ≈ 60 + capacity_penalty(0.5h)`. **Best net for a recently-discharged patient with an open follow-up gap** — the hero.
- **med_reconciliation**: `risk_reduction ≈ 0.28` when `has_open_med_recon` else ~0.1; `coordinator_hours ≈ 1.5`; `cost ≈ 180 + capacity_penalty(1.5h)`. Wins on adherence-flagged patients.
- **home_health_referral**: `risk_reduction ≈ 0.22 × severity_weight` (best on the frailest/highest-severity); `coordinator_hours ≈ 0.5` coordinator + external cost; `cost ≈ 1200 + capacity_penalty(0.5h)`. Highest cost — over-kill for a patient a call would save, wins only on high-severity cases.
- `capacity_penalty(h) = GREATEST(0, h − capacity_headroom_hours) × 200` (a soft penalty when the team is over capacity — so the ranking respects "can my team absorb it?"). `net_value = risk_reduction × 15000 − cost`; `recommended_intervention` = argmax net_value; `intervention_ranking` = a JSON array of all three with their `risk_reduction`/`net`/`cost`/`coordinator_hours`. Columns match `03-ml-intervention.md` → Inference shape. The coefficients mirror `gold_intervention_outcomes`, so **followup_call wins for the hero patient** (`PT-0000214`).

### Consumer routing

- `mv_patient_risk` (over `gold_patient_panel`) → dashboard KPIs + Genie headline answers.
- `gold_patient_panel` → dashboard scatter/map + at-risk/condition widgets via widget-level `GROUP BY`.
- `gold_open_atrisk` → intervention-model scoring input AND (joined with the model output) the app's coordinator queue.
- `gold_intervention_recommendations` → the app's coordinator queue + the dashboard's intervention widgets.
- `gold_intervention_outcomes` → the heuristic's coefficient source AND the training table for the OPTIONAL ML path.
- `silver_risk` → app analytics drill-downs (risk trend) via warehouse SQL.

---

## C. Validation

Run before `03-ml-intervention.md`. Each row = a one-line query; if it fails, fix the synth before publishing downstream resources.

**Load-bearing (must pass — these gate the story):**
- **The hero patient exists** — `gold_patient_panel WHERE patient_id='PT-0000214'` → `readmission_risk_score ≥ 0.75`, `risk_band = 'critical'`, `primary_condition = 'HF'`, `has_open_followup = true`, `days_since_discharge` small (≈ 8), `readmission_exposure_usd > 0`.
- **The hero has an open follow-up gap + capacity context** — `gold_open_atrisk WHERE patient_id='PT-0000214'` → `has_open_followup = true`, `capacity_headroom_hours` present, `candidate_provider_id` present. The follow-up-call story must be true in the data.
- **High-risk/condition cluster** — `gold_patient_panel` GROUP BY `primary_condition`, `risk_band`: `critical`/`elevated` rows are overwhelmingly in the affected conditions (HF/COPD/PNA/AMI); ~180 critical/elevated patients total.
- **Anomaly confined to the affected cohort** — the vast majority of patients are `stable`; the divergence doesn't bleed everywhere.
- **Exposure KPIs land** — `SUM(readmission_exposure_usd)` ≈ $2.7M; open care gaps ≈ ~300 (±20% OK).
- **`risk_signal_score` separates** — `AVG(risk_signal_score)` on affected at-risk patients ≥ 0.6; on stable patients ≤ 0.2.
- **`note_risk_flags` dedup is doing its job** — `COUNT(DISTINCT coordinator_note_text) << COUNT(*)` on `raw_risk_snapshots`; MV row count matches the distinct count.
- **Intervention outcomes are learnable** — `gold_intervention_outcomes` GROUP BY `intervention_type`: `followup_call` on recently-discharged, follow-up-gapped patients shows the best `risk_reduction` per `coordinator_hours`; `med_reconciliation` wins on adherence cases; `home_health_referral` on high-severity. If they don't separate, regenerate.
- **Risk ramp is in the past** — daily `AVG(readmission_risk_score)` on affected patients shows a build starting ~2.5w ago, not a cliff at the current day.
- **Intervention mix is plausible** — the heuristic across `gold_open_atrisk` produces a MIX (followup_call dominates the recent-discharge cohort; med_reconciliation + home_health appear on their respective profiles), NOT 100% one type.

**Smoke checks**: `primary_condition` includes the 4 affected codes; patient geo non-null and in earth-bounds; `risk_band` enum is the 4 values; `gold_open_atrisk` has ~180-300 rows; `readmission_risk_score` in [0,1]; `days_since_discharge` never negative.

Add `pipeline_id` to `resources.json`.
