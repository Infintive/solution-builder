# Next-Best-Action Recommendation — OPTIONAL ML model (the default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_nba_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (defined in `01-lakeflow.md` → Silver→Gold → `gold_nba_recommendations`): for each
> at-risk customer it ranks retention_offer / cross_sell / rm_outreach by **net value =
> retained_revenue − cost − margin_impact**, computed in SQL, and **retention_offer wins for the
> hero customer**. The app, dashboard, and Genie all read that table — they never call a model.
> **So the full solution works end-to-end with no ML at all.**
>
> This file is a **stretch**: if a team wants to showcase ML, train a model that *learns* the
> retained-$ from history and **overwrite the same `gold_nba_recommendations` table** with its
> scored output. Nothing downstream changes — same schema, same app. If you skip it, drop
> `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_campaign_outcomes` (training) + `gold_open_atrisk` (the at-risk customers to score) from `01-lakeflow.md`. Overwrites `gold_nba_recommendations`.

## The story (same as the heuristic — just learned instead of coded)

When a valuable customer is at risk, there are three plays — **retention_offer** (match/beat the competitor rate on the maturing deposit), **cross_sell** (offer a product they qualify for but don't hold), or **rm_outreach** (a relationship-manager call) — and the right choice is **situational** (balance at risk, attrition probability, tier, product fit). The model **learns** how much revenue each action retained from Meridian's own history, instead of the heuristic's hand-set coefficients. For the hero customer (`CUST-0000214`) it should still rank **retention_offer** first — the history is generated so that holds.

## What to train

A **regressor predicting `retained_revenue_usd`** for a (customer situation, candidate action) pair — train on `gold_campaign_outcomes` (one row per historical action + its realized outcome). XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.nba_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how* — UC registry URI, experiment parent-folder trap, `@prod` alias, Optuna+autolog, `spark_udf` env_manager rules, serverless-job `--no-wait` + TASK-run_id pattern, gotchas table). This spec is *what*.

> Regression, not classification: the app needs a **predicted retained-$ per action** to rank the three plays AND show the RM the tradeoff, not just a single "best action" label. Ranking falls out of scoring each candidate action and ordering by predicted net value — the same ordering step the heuristic does.

## Features

All derivable from `gold_campaign_outcomes` (training) and reconstructable for each candidate action at scoring time:

- `action_type` — `retention_offer` / `cross_sell` / `rm_outreach` (categorical; the model learns each type's outcome profile).
- `balance_at_risk_usd` — the account balance exposed (the affected maturing deposit).
- `attrition_risk_score` — the customer's current risk (higher ⇒ more urgent, and shifts which action lands).
- `tier` — `mass` / `mass_affluent` / `affluent` / `private` (value band, affects product fit).
- `tenure_years` — relationship length (a lifetime-value proxy).
- `days_to_maturity` — days until the deposit matures (the retention window).
- `rate_gap` — competitor rate − current rate (drives the retention-offer cost + effectiveness).
- `product_type` — the at-risk product's type (CD / Savings).

`retained_revenue_usd` is the label. Also carry `margin_impact_usd` + `cost_usd` from history so the app can show **net value = predicted retained_revenue − cost − margin_impact** per action (the ranking key), not just gross retained revenue.

## Inference shape

Same notebook trains AND scores. After training, for every at-risk customer in `gold_open_atrisk`, construct the **three candidate actions** (retention_offer at the competitor rate, cross_sell of `candidate_cross_sell_product_id`, rm_outreach), score each with `spark_udf(models:/...@prod)`, and write the ranked result to `gold_nba_recommendations` (overwrite):

| Column | |
|---|---|
| `customer_id` | at-risk customer (PK) |
| `recommended_action` | the top-ranked `action_type` by predicted net value |
| `recommended_offer_product_id` | cross-sell product for a cross_sell (NULL for retention/outreach) |
| `recommended_rate_apy` | the offered rate for a retention_offer (the competitor rate; NULL otherwise) |
| `predicted_retained_usd` | model output for the recommended action |
| `predicted_net_value_usd` | retained − cost − margin_impact for the recommended action |
| `action_ranking` | JSON array of all three candidate actions with their predicted retained_$ + net_$ + cost — the app renders this as the "ranked options" list + what-if base |
| `scored_at` | now() |

**Batch only — no serving endpoint.** Every downstream consumer reads from a table; serving would add cost + quota for zero narrative gain. (Real-time re-scoring on a what-if slider is talk-track: the app recomputes the tradeoff arithmetically from `action_ranking` for the demo.)

## Execution

One Databricks notebook (e.g. `./transformation/nba_train_score.py`, alongside the pipeline SQL) doing train → register → set `@prod` → build candidate actions → batch-score → overwrite `gold_nba_recommendations` → `dbutils.notebook.exit(json.dumps({model_version, rmse, customers_scored, retention_recommended, cross_sell_recommended, outreach_recommended}))`. Run as a **serverless job** (~10-15 min). Never run locally. Nightly re-score is talk-track only.

**Notebook-source format is required** (`# Databricks notebook source` header + `# MAGIC %md` cells + `# COMMAND ----------` separators) — without it the file uploads as a plain `.py`, cells don't render.

## Who consumes the predictions

1. **RM app** — Delta `gold_nba_recommendations` is mirrored into Lakebase as `app.nba_recommendations` on app boot + on "Reset demo" (see `specifications/app/03_DATA_MODEL.md`). The agent's `rank_next_best_actions` tool reads it from Lakebase so hot-path lookups are sub-ms; the app renders `action_ranking` as the ranked options + what-if base. Talking-track: production uses Lakebase Synced Tables for continuous replication; the demo does a one-shot manual sync to keep moving parts visible.
2. **Genie** — reads from Delta directly. Answers *"what's the next best action for CUST-0000214?"*, *"how much revenue could we retain across all at-risk customers?"*, *"how many at-risk customers are best served by a retention offer vs cross-sell?"*.
3. **AI/BI dashboard** (`04-ai-bi.md`) — reads from Delta, a widget showing recommended-action mix + total predicted retained $ across at-risk customers.

## Functional validation

- **Hero recommendation is retention_offer** — `gold_nba_recommendations WHERE customer_id='CUST-0000214'` → `recommended_action = 'retention_offer'`, `predicted_retained_usd > 0`, and `action_ranking` has retention_offer ranked above cross_sell + rm_outreach. If retention isn't on top for the hero, re-check `gold_campaign_outcomes` learnability (`01-lakeflow.md` validation) and the candidate-action construction.
- **Action mix is plausible** — across all at-risk customers, `recommended_action` is a mix (not 100% one type): retention_offer dominates the high-value/high-risk critical cohort, cross_sell wins on the lower-risk, smaller-balance moderate cohort. If it collapses to a single action type everywhere, the features or the training outcomes aren't separating.
- **Predicted retention rolls up** — `SUM(predicted_retained_usd)` across at-risk customers is a believable fraction of the revenue-at-risk (retention doesn't save 100%).
- **Model quality** — training RMSE is reasonable vs the `retained_revenue_usd` scale (autologged); the notebook exit JSON reports it.

## resources.json

- `ml_model_name`: `{catalog}.{schema}.nba_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/meridian/experiments/nba_recommender`
