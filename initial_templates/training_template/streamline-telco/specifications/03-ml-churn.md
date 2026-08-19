# Churn Retention Recommendation — OPTIONAL ML model (default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_retention_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (`01-lakeflow.md` → Silver→Gold): for each at-risk subscriber it ranks bill_credit /
> plan_upgrade_discount / device_upgrade by **net value = retained_clv − offer_cost** (where the
> retain probability depends on whether the offer matches the churn reason), and **bill_credit wins
> for the hero subscriber** (service reason). The app, dashboard, and Genie read that table — they
> never call a model. **The full solution works end-to-end with no ML at all.**
>
> This file is a **stretch**: train a model that *learns* the retained-CLV from history and
> **overwrite the same `gold_retention_recommendations` table**. Nothing downstream changes. If you
> skip it, drop `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_retention_outcomes` (training) + `gold_open_atrisk` (the subscribers to score). Overwrites `gold_retention_recommendations`.

## The story (same as the heuristic — just learned)

When a subscriber is at churn risk, there are three plays — a **bill credit**, a **plan-upgrade discount**, or a **device upgrade** — and the right choice depends on the **reason** they're leaving (service grievance, price, or device). The model learns how much CLV each offer retained from Streamline's own history, by reason. For the hero (`SUB-0000214`, service reason) it should still rank **bill_credit** first.

## What to train

A **regressor predicting `retained_clv_usd`** for a (subscriber situation, candidate offer) pair — train on `gold_retention_outcomes`. XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.churn_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how*). This spec is *what*.

## Features

From `gold_retention_outcomes` (training) + reconstructable at scoring: `offer_type` (categorical), `churn_reason` (`service`/`price`/`device` — the key interaction), `monthly_arpu_usd`, `offer_cost_usd`. Label = `retained_clv_usd`. Also carry `offer_cost_usd` so the app shows **net value = predicted retained_clv − offer_cost**.

## Inference shape

Same notebook trains AND scores. For every subscriber in `gold_open_atrisk`, construct the three candidate offers, score each, write ranked to `gold_retention_recommendations` (overwrite):

| Column | |
|---|---|
| `subscriber_id` | at-risk subscriber (PK) |
| `recommended_offer` | top-ranked `offer_type` by predicted net value |
| `predicted_retained_clv_usd` | model output for the recommended offer |
| `predicted_net_value_usd` | retained_clv − offer_cost for the recommended offer |
| `offer_ranking` | JSON array of all three with predicted retained + net + cost |
| `scored_at` | now() |

**Batch only — no serving endpoint.**

## Execution

One Databricks notebook (`./transformation/churn_train_score.py`) doing train → register → set `@prod` → build candidates → batch-score → overwrite → `dbutils.notebook.exit(json.dumps({model_version, rmse, subscribers_scored, credit_recommended, plan_recommended, device_recommended}))`. Run as a **serverless job**. Never run locally. **Notebook-source format required.**

## Who consumes the predictions

1. **Care-agent app** — mirrored into Lakebase as `app.retention_recommendations`; the agent's `rank_offers` tool reads it.
2. **Genie** — answers *"what should I offer SUB-0000214?"*, *"how much CLV could we retain across all at-risk subscribers?"*, *"how many are best served by a bill credit vs a plan discount?"*.
3. **AI/BI dashboard** — recommended-offer mix + total predicted retained CLV.

## Functional validation

- **Hero recommendation is bill_credit** — `gold_retention_recommendations WHERE subscriber_id='SUB-0000214'` → `recommended_offer = 'bill_credit'`, and `offer_ranking` has bill_credit above the others. If not, re-check `gold_retention_outcomes` learnability + the reason↔offer interaction.
- **Offer mix is plausible** — a mix driven by `churn_reason` (bill_credit on service, plan on price, device on device). Not 100% one type.
- **Predicted retention rolls up** — `SUM(predicted_retained_clv_usd)` is a believable fraction of the CLV at risk.
- **Model quality** — training RMSE reasonable vs the `retained_clv_usd` scale (autologged).

## resources.json

- `ml_model_name`: `{catalog}.{schema}.churn_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/streamline/experiments/churn_recommender`
