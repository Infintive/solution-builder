# ROAS-Lift Recommendation — OPTIONAL ML model (default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_action_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (`01-lakeflow.md` → Silver→Gold): for each active underperformer it ranks replicate_winner
> / reallocate_budget / pause by **net value = roas_lift × spend_to_date − action_cost**, and
> **replicate_winner wins for the hero campaign** (a matching winner exists). The app, dashboard, and
> Genie read that table — they never call a model. **The full solution works end-to-end with no ML.**
>
> This file is a **stretch**: train a model that *learns* the roas_lift from history and **overwrite
> the same `gold_action_recommendations` table**. Nothing downstream changes. If you skip it, drop
> `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_action_outcomes` (training) + `gold_open_underperformers` (the campaigns to score). Overwrites `gold_action_recommendations`.

## The story (same as the heuristic — just learned)

When a campaign is underperforming, there are three plays — **replicate a winner's channel/creative**, **reallocate its budget** to a proven winner, or **pause** it — and the right choice depends on whether a **matching winner** exists in the same category + segment. The model learns how much ROAS lift each action delivered from Brightwave's own history. For the hero (`CMP-0000214`, a matching winner exists) it should still rank **replicate_winner** first.

## What to train

A **regressor predicting `roas_lift`** for a (campaign situation, candidate action) pair — train on `gold_action_outcomes`. XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.roas_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how*). This spec is *what*.

## Features

From `gold_action_outcomes` (training) + reconstructable at scoring: `action_type` (categorical), `had_matching_winner` (bool — the key interaction), `roas_at_action`, `action_cost_usd`. Label = `roas_lift`. Also carry `action_cost_usd` so the app shows **net value = predicted roas_lift × spend_to_date − action_cost**.

## Inference shape

Same notebook trains AND scores. For every campaign in `gold_open_underperformers`, construct the three candidate actions, score each, write ranked to `gold_action_recommendations` (overwrite):

| Column | |
|---|---|
| `campaign_id` | active underperformer (PK) |
| `recommended_action` | top-ranked `action_type` by predicted net value |
| `predicted_roas_lift` | model output for the recommended action |
| `predicted_net_value_usd` | roas_lift × spend_to_date − action_cost for the recommended action |
| `action_ranking` | JSON array of all three with predicted roas_lift + net + cost |
| `scored_at` | now() |

**Batch only — no serving endpoint.**

## Execution

One Databricks notebook (`./transformation/roas_train_score.py`) doing train → register → set `@prod` → build candidates → batch-score → overwrite → `dbutils.notebook.exit(json.dumps({model_version, rmse, campaigns_scored, replicate_recommended, reallocate_recommended, pause_recommended}))`. Run as a **serverless job**. Never run locally. **Notebook-source format required.**

## Who consumes the predictions

1. **Campaign Desk app** — mirrored into Lakebase as `app.action_recommendations`; the agent's `rank_actions` tool reads it.
2. **Genie** — answers *"what should I do with CMP-0000214?"*, *"how much ROAS lift could we capture across all underperformers?"*, *"how many underperformers should we replicate a winner vs reallocate?"*.
3. **AI/BI dashboard** — recommended-action mix + total predicted ROAS lift / revenue impact.

## Functional validation

- **Hero recommendation is replicate_winner** — `gold_action_recommendations WHERE campaign_id='CMP-0000214'` → `recommended_action = 'replicate_winner'`, and `action_ranking` has replicate above the others. If not, re-check `gold_action_outcomes` learnability + the `had_matching_winner` interaction.
- **Action mix is plausible** — a mix driven by `has_matching_winner` (replicate on matching-winner underperformers, reallocate on no-match, occasional pause). Not 100% one type.
- **Predicted lift rolls up** — `SUM(predicted_roas_lift × spend_to_date)` is a believable revenue impact.
- **Model quality** — training RMSE reasonable vs the `roas_lift` scale (autologged).

## resources.json

- `ml_model_name`: `{catalog}.{schema}.roas_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/brightwave/experiments/roas_recommender`
