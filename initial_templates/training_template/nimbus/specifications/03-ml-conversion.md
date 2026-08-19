# Conversion-Lift Recommendation — OPTIONAL ML model (default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_action_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (`01-lakeflow.md` → Silver→Gold): for each sliding cohort it ranks ship_proven_variant /
> rollout_existing_flag / ship_alt_variant by **net value = conversion_lift × mau × per_conversion_revenue
> − ship_cost**, and **ship_proven_variant wins for the hero cohort** (a matching proven experiment
> exists). The app, dashboard, and Genie read that table — they never call a model. **The full solution
> works end-to-end with no ML.**
>
> This file is a **stretch**: train a model that *learns* the conversion_lift from history and
> **overwrite the same `gold_action_recommendations` table**. Nothing downstream changes. If you skip
> it, drop `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_experiment_outcomes` (training) + `gold_open_sliding` (the cohorts to score). Overwrites `gold_action_recommendations`.

## The story (same as the heuristic — just learned)

When a cohort's conversion slides, there are three plays — **ship a variant that won a past experiment** for a similar cohort, **roll out an existing flag** that lifted a neighboring cohort, or **ship an untested alternative** — and the right choice depends on whether a **matching proven experiment** exists (same cohort + platform). The model learns how much conversion lift each action delivered from Nimbus's own experiment history. For the hero (`SEG-0000214`, a matching experiment exists) it should still rank **ship_proven_variant** first.

## What to train

A **regressor predicting `conversion_lift`** for a (cohort situation, candidate action) pair — train on `gold_experiment_outcomes`. XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.conversion_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how*). This spec is *what*.

## Features

From `gold_experiment_outcomes` (training) + reconstructable at scoring: `action_type` (categorical), `had_matching_experiment` (bool — the key interaction), `conversion_at_action`, `ship_cost_usd`. Label = `conversion_lift`. Also carry `ship_cost_usd` so the app shows **net value = predicted conversion_lift × mau × per_conversion_revenue − ship_cost**.

## Inference shape

Same notebook trains AND scores. For every cohort in `gold_open_sliding`, construct the three candidate actions, score each, write ranked to `gold_action_recommendations` (overwrite):

| Column | |
|---|---|
| `segment_id` | sliding cohort (PK) |
| `recommended_action` | top-ranked `action_type` by predicted net value |
| `predicted_conversion_lift` | model output for the recommended action |
| `predicted_net_value_usd` | conversion_lift × mau × per_conversion_revenue − ship_cost for the recommended action |
| `action_ranking` | JSON array of all three with predicted conversion_lift + net + cost |
| `scored_at` | now() |

**Batch only — no serving endpoint.** (The served artifact is the FLAG the app writes back — not a model endpoint.)

## Execution

One Databricks notebook (`./transformation/conversion_train_score.py`) doing train → register → set `@prod` → build candidates → batch-score → overwrite → `dbutils.notebook.exit(json.dumps({model_version, rmse, cohorts_scored, proven_recommended, flag_recommended, alt_recommended}))`. Run as a **serverless job**. Never run locally. **Notebook-source format required.**

## Who consumes the predictions

1. **Growth Desk app** — mirrored into Lakebase as `app.action_recommendations`; the agent's `rank_actions` tool reads it.
2. **Genie** — answers *"which feature should ship next for SEG-0000214?"*, *"how much conversion lift could we capture across all sliding cohorts?"*, *"how many should ship a proven variant vs roll out a flag?"*.
3. **AI/BI dashboard** — recommended-action mix + total predicted conversion lift / net value.

## Functional validation

- **Hero recommendation is ship_proven_variant** — `gold_action_recommendations WHERE segment_id='SEG-0000214'` → `recommended_action = 'ship_proven_variant'`, and `action_ranking` has it above the others. If not, re-check `gold_experiment_outcomes` learnability + the `had_matching_experiment` interaction.
- **Action mix is plausible** — a mix driven by `has_matching_experiment` (ship_proven_variant on matching cohorts, rollout_existing_flag on no-match). Not 100% one type.
- **Predicted lift rolls up** — `SUM(predicted_conversion_lift × mau × 8 × 12)` is a believable annualized recovery.
- **Model quality** — training RMSE reasonable vs the `conversion_lift` scale (autologged).

## resources.json

- `ml_model_name`: `{catalog}.{schema}.conversion_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/nimbus/experiments/conversion_recommender`
