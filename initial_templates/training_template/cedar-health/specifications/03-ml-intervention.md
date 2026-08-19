# Intervention Recommendation — OPTIONAL ML model (the default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_intervention_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (defined in `01-lakeflow.md` → Silver→Gold → `gold_intervention_recommendations`): for
> each at-risk patient it ranks followup_call / med_reconciliation / home_health_referral by **net
> value = risk_reduction × readmission_cost − cost (incl. a capacity penalty)**, computed in SQL, and
> **followup_call wins for the hero patient**. The app, dashboard, and Genie all read that table —
> they never call a model. **So the full solution works end-to-end with no ML at all.**
>
> This file is a **stretch**: if a team wants to showcase ML, train a model that *learns* the
> risk-reduction from history and **overwrite the same `gold_intervention_recommendations` table**
> with its scored output. Nothing downstream changes — same schema, same app. If you skip it, drop
> `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_intervention_outcomes` (training) + `gold_open_atrisk` (the patients to score) from `01-lakeflow.md`. Overwrites `gold_intervention_recommendations`.

## The story (same as the heuristic — just learned instead of coded)

When a patient is at risk of readmission, there are three plays — a **7-day follow-up call**, a **medication reconciliation**, or a **home-health referral** — and the right choice is **situational** (how recent the discharge, which care gaps are open, severity, and the coordination team's capacity). The model **learns** how much each intervention reduced readmission risk from Cedar's own history, instead of the heuristic's hand-set coefficients. For the hero patient (`PT-0000214`) it should still rank the **follow-up call** first — the history is generated so that holds — while weighing it against team capacity.

## What to train

A **regressor predicting `risk_reduction`** for a (patient situation, candidate intervention) pair — train on `gold_intervention_outcomes` (one row per historical intervention + its realized outcome). XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.intervention_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how*). This spec is *what*.

> Regression, not classification: the app needs a **predicted risk_reduction per intervention** to rank the plays AND show the coordinator the tradeoff (× the $15K readmission cost, minus cost + a capacity penalty = net value), not just a single "best intervention" label.

## Features

All derivable from `gold_intervention_outcomes` (training) and reconstructable at scoring time:

- `intervention_type` — `followup_call` / `med_reconciliation` / `home_health_referral` (categorical).
- `readmission_risk_score` — the patient's current risk (higher ⇒ more to reduce).
- `days_since_discharge` — recency of discharge (follow-up calls work best early).
- `has_open_followup` / `has_open_med_recon` — which care gaps are open (the intervention that closes an open gap wins).
- `severity_weight` — the condition's severity (home-health suits the frailest).
- `coordinator_hours` — the load the intervention adds (the capacity-penalty input).

`risk_reduction` is the label. Also carry `cost_usd` + `coordinator_hours` from history so the app can compute **net value = predicted risk_reduction × $15,000 − cost − capacity_penalty** per intervention (the ranking key).

## Inference shape

Same notebook trains AND scores. After training, for every at-risk patient in `gold_open_atrisk`, construct the **three candidate interventions**, score each with `spark_udf(models:/...@prod)`, apply the capacity penalty from `capacity_headroom_hours`, and write the ranked result to `gold_intervention_recommendations` (overwrite):

| Column | |
|---|---|
| `patient_id` | at-risk patient (PK) |
| `recommended_intervention` | the top-ranked `intervention_type` by predicted net value |
| `recommended_provider_id` | the home-health provider for a referral (NULL otherwise) |
| `predicted_risk_reduction` | model output for the recommended intervention |
| `predicted_net_value_usd` | risk_reduction × $15,000 − cost − capacity_penalty for the recommended intervention |
| `intervention_ranking` | JSON array of all three candidate interventions with predicted risk_reduction + net_$ + cost + hours — the app renders this as the "ranked options" list + what-if base |
| `scored_at` | now() |

**Batch only — no serving endpoint.** Every downstream consumer reads from a table.

## Execution

One Databricks notebook (e.g. `./transformation/intervention_train_score.py`) doing train → register → set `@prod` → build candidate interventions → batch-score → apply capacity penalty → overwrite `gold_intervention_recommendations` → `dbutils.notebook.exit(json.dumps({model_version, rmse, patients_scored, followup_recommended, medrecon_recommended, homehealth_recommended}))`. Run as a **serverless job**. Never run locally.

**Notebook-source format is required** (`# Databricks notebook source` header + `# MAGIC %md` cells + `# COMMAND ----------` separators).

## Who consumes the predictions

1. **Coordinator app** — Delta `gold_intervention_recommendations` is mirrored into Lakebase as `app.intervention_recommendations` on app boot + on "Reset demo" (see `specifications/app/03_DATA_MODEL.md`). The agent's `rank_interventions` tool reads it from Lakebase.
2. **Genie** — reads from Delta directly. Answers *"what's the recommended intervention for PT-0000214?"*, *"how much readmission risk could we reduce across all at-risk patients?"*, *"how many patients are best served by a follow-up call vs home-health?"*.
3. **AI/BI dashboard** (`04-ai-bi.md`) — reads from Delta, a widget showing recommended-intervention mix + total predicted risk reduction.

## Functional validation

- **Hero recommendation is followup_call** — `gold_intervention_recommendations WHERE patient_id='PT-0000214'` → `recommended_intervention = 'followup_call'`, `predicted_risk_reduction > 0`, and `intervention_ranking` has followup_call ranked above med_reconciliation + home_health_referral. If not on top, re-check `gold_intervention_outcomes` learnability + the candidate construction + the capacity penalty.
- **Intervention mix is plausible** — across all at-risk patients, `recommended_intervention` is a mix (not 100% one type): followup_call dominates the recent-discharge cohort, med_reconciliation on adherence cases, home_health on high-severity. If it collapses to a single type everywhere, the features aren't separating.
- **Predicted reduction rolls up** — `SUM(predicted_risk_reduction × 15000)` is a believable fraction of the readmission exposure.
- **Model quality** — training RMSE reasonable vs the `risk_reduction` scale (autologged).

## resources.json

- `ml_model_name`: `{catalog}.{schema}.intervention_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/cedar/experiments/intervention_recommender`
