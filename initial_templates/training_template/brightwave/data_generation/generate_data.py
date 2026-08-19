# Databricks notebook source
# MAGIC %md
# MAGIC # Brightwave — Campaign Replication & Budget Rescue · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Brightwave demo under `<catalog>.<schema>` using Spark.
# MAGIC Follows the `databricks-synthetic-data-gen` skill: `spark.range` + `F.when` + broadcast joins
# MAGIC + Window + `F.element_at` — no driver loops, no `.collect()` on big tables.
# MAGIC
# MAGIC **The load-bearing anomaly** (one dynamic, two visible symptoms): over the current quarter a
# MAGIC cluster of campaigns split into WINNERS (high ROAS on a specific channel+creative combo) and
# MAGIC UNDERPERFORMERS (low ROAS, ~20% of paid spend, still running), on the same categories. The hero
# MAGIC is `CMP-0000214` (underperformer, ROAS ~1.1) whose matching winner `CMP-0000009` (ROAS ~4.0) has
# MAGIC a transferable creative; the play the heuristic ranks first is **replicate_winner**. See
# MAGIC `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template.** Writes RAW
# MAGIC parquet only; silver + gold are the SDP pipeline's job.

# COMMAND ----------

from __future__ import annotations

import os
from datetime import datetime, timedelta

import numpy as np
from pyspark.sql import DataFrame
from pyspark.sql import functions as F

# ── Config ─────────────────────────────────────────────────────────────────
IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")
    dbutils.widgets.text("schema", "", "Schema")
    CATALOG = dbutils.widgets.get("catalog")
    SCHEMA = dbutils.widgets.get("schema")
else:
    import argparse

    _p = argparse.ArgumentParser()
    _p.add_argument("--catalog", default=os.environ.get("DEMO_CATALOG"))
    _p.add_argument("--schema", default=os.environ.get("DEMO_SCHEMA"))
    _a, _ = _p.parse_known_args()
    CATALOG, SCHEMA = _a.catalog, _a.schema
assert CATALOG and SCHEMA, "catalog + schema required (widgets in-job, --catalog/--schema or DEMO_CATALOG/DEMO_SCHEMA locally)"

RAW_VOL = "raw_data"

# ── Story timeline ───────────────────────────────────────────────────────────
STORY_PINNED_NOW = datetime(2026, 8, 1)
NOW = STORY_PINNED_NOW if os.environ.get("BRIGHTWAVE_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
QUARTER_START = NOW - timedelta(days=60)
DIVERGENCE_RAMP = NOW - timedelta(days=21)
SNAPSHOT_DATE = NOW - timedelta(days=1)
PERF_WINDOW_START = NOW - timedelta(days=14)

# ── Deterministic story anchors ───────────────────────────────────────────────
N_CAMPAIGNS = 2_000
N_WINNERS = 60                                    # high-ROAS winners
N_UNDERPERFORMERS = 90                            # active low-ROAS underperformers
N_NOMATCH = 30                                    # of the underperformers, this many have NO matching
                                                  # winner → reallocate wins for them (plausible mix)

HERO_CAMPAIGN = "CMP-0000214"                      # the active underperformer
HERO_WINNER = "CMP-0000009"                        # its matching winner (same category + segment)

CHANNELS = ["social", "search", "display", "video", "email"]
CATEGORIES = ["apparel", "beauty", "home", "electronics", "outdoor"]
ANGLES = ["lifestyle", "promo", "testimonial", "product"]
SEGMENTS = ["gen_z", "millennial", "gen_x", "boomer", "value_seeker"]
# The WINNING combo: social + lifestyle. Underperformers use display + promo (weaker) in the same cats.

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('BRIGHTWAVE_PIN_TIME') == '1' else 'rolling'})")
print(f"DIVERGENCE_RAMP: {DIVERGENCE_RAMP.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_CAMPAIGN} (underperformer) ~ matching winner {HERO_WINNER}")

try:
    spark  # noqa: F821
except NameError:
    from databricks.connect import DatabricksSession

    spark = (
        DatabricksSession.builder.profile(os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
        .serverless(True)
        .getOrCreate()
    )

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.{RAW_VOL}")
RAW_VOL_ROOT = f"/Volumes/{CATALOG}/{SCHEMA}/{RAW_VOL}"


def _raw_path(table: str) -> str:
    return f"{RAW_VOL_ROOT}/{table.removeprefix('raw_')}"


def _save(df: DataFrame, table: str) -> None:
    path = _raw_path(table)
    df.write.mode("overwrite").parquet(path)
    n = spark.read.parquet(path).count()
    print(f"  ✓ {table:26s} rows={n:>10,}  → {path}")


# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Creatives — the creative catalog (searchable)

# COMMAND ----------

print("\n[1/7] Generating creatives...")

ctype_arr = F.array(F.lit("image"), F.lit("video"), F.lit("carousel"), F.lit("copy"))
angle_arr = F.array(*[F.lit(a) for a in ANGLES])
creatives_df = (
    spark.range(0, 400)
    .withColumn("creative_id", F.concat(F.lit("CRE-"), F.lpad((F.col("id") + 1).cast("string"), 5, "0")))
    .withColumn("creative_type", F.element_at(ctype_arr, (F.rand(11) * 4 + 1).cast("int")))
    .withColumn("angle", F.element_at(angle_arr, (F.rand(12) * len(ANGLES) + 1).cast("int")))
    .withColumn("creative_name", F.concat(F.col("angle"), F.lit(" "), F.col("creative_type"), F.lit(" "), (F.col("id") + 1).cast("string")))
    .withColumn(
        "description",
        F.concat_ws(" ", F.col("angle"), F.col("creative_type"), F.lit("creative."),
                    F.when(F.col("angle") == "lifestyle", F.lit("Aspirational lifestyle imagery; the highest-performing angle on social for younger segments."))
                    .when(F.col("angle") == "promo", F.lit("Discount-led promotional creative; broad reach but lower brand lift."))
                    .when(F.col("angle") == "testimonial", F.lit("Customer testimonial; strong trust signal for consideration."))
                    .otherwise(F.lit("Straight product shot; workhorse creative for search and display."))),
    )
    .withColumn("is_active", F.lit(True))
    .select("creative_id", "creative_name", "creative_type", "angle", "description", "is_active")
)
_save(creatives_df, "raw_creatives")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Campaigns — ~2K; winners (social+lifestyle) vs underperformers (display+promo)
# MAGIC The hero underperformer + its matching winner are pinned to the same category + segment so the
# MAGIC winner's creative is transferable. A subset of underperformers get a UNIQUE segment (no matching
# MAGIC winner) so reallocate wins for them → plausible action mix.

# COMMAND ----------

print("\n[2/7] Generating campaigns...")

# Deterministic index sets. Hero underperformer at index 213 → CMP-0000214; hero winner at index 8 → CMP-0000009.
WINNER_IDX = [8] + [i for i in range(50, 50 + (N_WINNERS - 1) * 11, 11)][: N_WINNERS - 1]
UNDER_IDX = [213] + [i for i in range(600, 600 + (N_UNDERPERFORMERS - 1) * 9, 9)][: N_UNDERPERFORMERS - 1]
# The no-match underperformers: the LAST N_NOMATCH of UNDER_IDX get a unique segment.
NOMATCH_IDX = set(UNDER_IDX[-N_NOMATCH:])

winner_idx_arr = F.array(*[F.lit(int(i)) for i in WINNER_IDX])
under_idx_arr = F.array(*[F.lit(int(i)) for i in UNDER_IDX])
nomatch_idx_arr = F.array(*[F.lit(int(i)) for i in NOMATCH_IDX])
channel_arr = F.array(*[F.lit(c) for c in CHANNELS])
cat_arr = F.array(*[F.lit(c) for c in CATEGORIES])
seg_arr = F.array(*[F.lit(s) for s in SEGMENTS])

campaigns_df = (
    spark.range(0, N_CAMPAIGNS)
    .withColumn("campaign_id", F.concat(F.lit("CMP-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_winner", F.array_contains(winner_idx_arr, F.col("id").cast("int")))
    .withColumn("is_under", F.array_contains(under_idx_arr, F.col("id").cast("int")))
    .withColumn("is_nomatch", F.array_contains(nomatch_idx_arr, F.col("id").cast("int")))
    # category: hero + hero-winner share category 0 (apparel) + segment gen_z. Other affected share
    # a category by a hash so matching winners exist; no-match underperformers get category 4 + a rare segment.
    .withColumn(
        "category",
        F.when(F.col("campaign_id").isin(HERO_CAMPAIGN, HERO_WINNER), F.lit("apparel"))
        .when(F.col("is_nomatch"), F.lit("outdoor"))
        .when(F.col("is_winner") | F.col("is_under"), F.element_at(cat_arr, (F.col("id") % 3 + 1).cast("int")))  # cats 0-2 shared
        .otherwise(F.element_at(cat_arr, (F.rand(21) * len(CATEGORIES) + 1).cast("int"))),
    )
    .withColumn(
        "target_segment",
        F.when(F.col("campaign_id").isin(HERO_CAMPAIGN, HERO_WINNER), F.lit("gen_z"))
        .when(F.col("is_nomatch"), F.lit("value_seeker"))  # underperformers with no winner in this seg
        .when(F.col("is_winner") | F.col("is_under"), F.element_at(seg_arr, (F.col("id") % 3 + 1).cast("int")))
        .otherwise(F.element_at(seg_arr, (F.rand(22) * len(SEGMENTS) + 1).cast("int"))),
    )
    # Winners use the winning combo (social+lifestyle); underperformers the weak combo (display+promo).
    .withColumn(
        "channel",
        F.when(F.col("is_winner"), F.lit("social"))
        .when(F.col("is_under"), F.lit("display"))
        .otherwise(F.element_at(channel_arr, (F.rand(23) * len(CHANNELS) + 1).cast("int"))),
    )
    # Creative: winners → a lifestyle creative (CRE in a fixed lifestyle band); underperformers → promo.
    .withColumn(
        "creative_id",
        F.when(F.col("is_winner"), F.concat(F.lit("CRE-"), F.lpad(((F.col("id") % 50 + 1)).cast("string"), 5, "0")))
        .when(F.col("is_under"), F.concat(F.lit("CRE-"), F.lpad(((F.col("id") % 50 + 200)).cast("string"), 5, "0")))
        .otherwise(F.concat(F.lit("CRE-"), F.lpad(((F.rand(24) * 400 + 1).cast("int")).cast("string"), 5, "0"))),
    )
    .withColumn(
        "status",
        F.when(F.col("is_under"), F.lit("active"))
        .when(F.col("is_winner"), F.lit("active"))
        .when(F.rand(25) < 0.5, F.lit("completed")).when(F.rand(26) < 0.1, F.lit("paused")).otherwise(F.lit("active")),
    )
    .withColumn(
        "launch_date",
        F.when(F.col("is_winner") | F.col("is_under"), F.date_add(F.lit(QUARTER_START.date().isoformat()).cast("date"), (F.rand(27) * 30).cast("int")))
        .otherwise(F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (30 + F.rand(28) * HIST_SPAN_DAYS).cast("int"))),
    )
    .withColumn("budget_usd", F.round(F.when(F.col("is_winner") | F.col("is_under"), 50000 + F.rand(29) * 200000).otherwise(20000 + F.rand(30) * 80000), 2))
    .withColumn("campaign_name", F.concat(F.initcap(F.col("category")), F.lit(" "), F.initcap(F.col("channel")), F.lit(" Q"), (F.col("id") % 4 + 1).cast("int").cast("string")))
    .withColumn(
        "campaign_summary",
        F.concat_ws(" ", F.col("channel"), F.lit("campaign for"), F.col("category"), F.lit("targeting"), F.col("target_segment"), F.lit("."),
                    F.when(F.col("is_winner"), F.lit("Top-performing lifestyle creative on social; the pattern to replicate."))
                    .when(F.col("is_under"), F.lit("Underperforming promo creative on display; ROAS below target, spend leaking."))
                    .otherwise(F.lit("Steady performer, on plan."))),
    )
    .withColumn("is_active", F.col("status") == "active")
    .select("campaign_id", "campaign_name", "channel", "creative_id", "target_segment", "category", "launch_date", "status", "budget_usd", "campaign_summary", "is_active")
)
_save(campaigns_df, "raw_campaigns")

WINNER_CMPS = [f"CMP-{i + 1:07d}" for i in WINNER_IDX]
UNDER_CMPS = [f"CMP-{i + 1:07d}" for i in UNDER_IDX]
AFFECTED_CMPS = WINNER_CMPS + UNDER_CMPS

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Ad spend — 18 months daily campaign spend + delivery

# COMMAND ----------

print("\n[3/7] Generating ad spend...")

# Affected campaigns: dense last 60 days (the quarter). Winners high revenue efficiency, underperformers low.
affected_arr = F.array(*[F.lit(c) for c in AFFECTED_CMPS])
winner_arr = F.array(*[F.lit(c) for c in WINNER_CMPS])
under_arr = F.array(*[F.lit(c) for c in UNDER_CMPS])

affected_spend = (
    spark.createDataFrame([(c,) for c in AFFECTED_CMPS], "campaign_id string")
    .crossJoin(spark.range(0, 60).withColumnRenamed("id", "day_offset"))
    .withColumn("spend_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("day_offset").cast("int")))
    .withColumn("spend_usd", F.round(1000 + F.rand(31) * 4000, 2))
    .withColumn("impressions", (F.col("spend_usd") * (20 + F.rand(32) * 30)).cast("int"))
    .withColumn("clicks", (F.col("impressions") * (0.01 + F.rand(33) * 0.03)).cast("int"))
    .select("campaign_id", "spend_date", "spend_usd", "impressions", "clicks")
)
# Baseline spend: steady campaigns over 18 months.
_baseline_cmps = [f"CMP-{i + 1:07d}" for i in range(N_CAMPAIGNS) if f"CMP-{i + 1:07d}" not in set(AFFECTED_CMPS)]
cmp_arr = F.array(*[F.lit(c) for c in _baseline_cmps[:1500]])
_n_base = len(_baseline_cmps[:1500])
baseline_spend = (
    spark.range(0, 3_400_000)
    .withColumn("campaign_id", F.element_at(cmp_arr, (F.rand(34) * _n_base + 1).cast("int")))
    .withColumn("spend_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(35) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("spend_usd", F.round(200 + F.rand(36) * 2000, 2))
    .withColumn("impressions", (F.col("spend_usd") * (20 + F.rand(37) * 30)).cast("int"))
    .withColumn("clicks", (F.col("impressions") * (0.01 + F.rand(38) * 0.03)).cast("int"))
    .select("campaign_id", "spend_date", "spend_usd", "impressions", "clicks")
)
spend_df = affected_spend.unionByName(baseline_spend)
_save(spend_df, "raw_ad_spend")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Conversions — daily campaign conversions + revenue (drives ROAS)
# MAGIC Winners: high revenue per spend (ROAS ~4). Underperformers: low (ROAS ~1.1). Steady: ~2.3.

# COMMAND ----------

print("\n[4/7] Generating conversions...")

# Build conversions off the same grids so ROAS = revenue/spend lands where we want.
def _conv_from_spend(spend, roas_expr):
    return (
        spend
        .withColumnRenamed("spend_date", "conv_date")
        .withColumn("revenue_usd", F.round(F.col("spend_usd") * roas_expr, 2))
        .withColumn("conversions", (F.col("revenue_usd") / (40 + F.rand(41) * 60)).cast("int"))
        .select("campaign_id", "conv_date", "conversions", "revenue_usd")
    )

winner_roas = F.lit(3.5) + F.rand(42) * 1.5      # 3.5-5.0
# hero underperformer pinned ~1.1; others 0.8-1.5
under_roas = F.when(F.col("campaign_id") == F.lit(HERO_CAMPAIGN), F.lit(1.1)).otherwise(F.lit(0.8) + F.rand(43) * 0.7)
steady_roas = F.lit(1.8) + F.rand(44) * 1.0      # 1.8-2.8

affected_conv = (
    affected_spend
    .withColumn("_is_winner", F.array_contains(winner_arr, F.col("campaign_id")))
    .withColumn("revenue_usd", F.round(F.col("spend_usd") * F.when(F.col("_is_winner"), winner_roas).otherwise(under_roas), 2))
    .withColumnRenamed("spend_date", "conv_date")
    .withColumn("conversions", (F.col("revenue_usd") / (40 + F.rand(45) * 60)).cast("int"))
    .select("campaign_id", "conv_date", "conversions", "revenue_usd")
)
baseline_conv = _conv_from_spend(baseline_spend, steady_roas)
conv_df = affected_conv.unionByName(baseline_conv)
_save(conv_df, "raw_conversions")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Attribution — modeled contribution per campaign (resolves over the quarter)

# COMMAND ----------

print("\n[5/7] Generating attribution...")

attribution_df = (
    campaigns_df.select("campaign_id")
    .crossJoin(spark.range(0, 30).withColumnRenamed("id", "d"))
    .withColumn("as_of_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (F.col("d") * 2).cast("int")))
    .withColumn("attributed_revenue_usd", F.round(5000 + F.rand(51) * 200000, 2))
    .withColumn("incrementality_score", F.round(0.3 + F.rand(52) * 0.6, 3))
    .withColumn("attribution_model", F.lit("mmm_v3"))
    .select("campaign_id", "as_of_date", "attributed_revenue_usd", "incrementality_score", "attribution_model")
)
_save(attribution_df, "raw_attribution")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Perf snapshots — daily ROAS for the last ~14 days + current

# COMMAND ----------

print("\n[6/7] Generating perf snapshots...")

_WINNER_NOTES = ["crushing it on this creative, scale it", "best ROAS in the portfolio"]
_UNDER_NOTES = ["spend leaking, ROAS below target", "creative not landing with this audience", "consider pausing or reworking", "budget better spent elsewhere"]
_HEALTHY_NOTES = ["performing to plan", "steady spend", None, None]
winner_notes_arr = F.array(*[F.lit(x) for x in _WINNER_NOTES])
under_notes_arr = F.array(*[F.lit(x) for x in _UNDER_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

n_snap_days = (SNAPSHOT_DATE - PERF_WINDOW_START).days + 1

affected_perf = (
    spark.createDataFrame([(c,) for c in AFFECTED_CMPS], "campaign_id string")
    .withColumn("_is_winner", F.array_contains(winner_arr, F.col("campaign_id")))
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    .withColumn(
        "roas",
        F.when(F.col("campaign_id") == HERO_CAMPAIGN, F.lit(1.1))
        .when(F.col("_is_winner"), F.round(3.5 + F.rand(61) * 1.5, 2))
        .otherwise(F.round(0.8 + F.rand(62) * 0.7, 2)),
    )
    .withColumn("spend_to_date_usd", F.round(50000 + F.rand(63) * 200000, 2))
    .withColumn(
        "review_note_text",
        F.when(F.col("_is_winner") & (F.rand(64) < 0.85), F.element_at(winner_notes_arr, (F.rand(65) * len(_WINNER_NOTES) + 1).cast("int")))
        .when(~F.col("_is_winner") & (F.rand(66) < 0.85), F.element_at(under_notes_arr, (F.rand(67) * len(_UNDER_NOTES) + 1).cast("int")))
        .otherwise(F.element_at(healthy_arr, (F.rand(68) * len(_HEALTHY_NOTES) + 1).cast("int"))),
    )
    .select("campaign_id", "snapshot_date", "roas", "spend_to_date_usd", "review_note_text")
)
# Steady campaigns: current-snapshot only.
steady_perf = (
    spark.range(0, N_CAMPAIGNS)
    .withColumn("campaign_id", F.concat(F.lit("CMP-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_affected", F.array_contains(affected_arr, F.col("campaign_id")))
    .filter(~F.col("is_affected"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("roas", F.round(1.8 + F.rand(71) * 1.0, 2))
    .withColumn("spend_to_date_usd", F.round(10000 + F.rand(72) * 80000, 2))
    .withColumn("review_note_text", F.element_at(healthy_arr, (F.rand(73) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("campaign_id", "snapshot_date", "roas", "spend_to_date_usd", "review_note_text")
)
perf_df = affected_perf.unionByName(steady_perf)
_save(perf_df, "raw_perf_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Campaign actions — 18 months of actions with outcomes (model training)
# MAGIC replicate_winner WITH a matching winner lifts ROAS most per dollar; reallocate wins on no-match;
# MAGIC pause is the floor. This ranks the hero (matching winner exists) as replicate_winner.

# COMMAND ----------

print("\n[7/7] Generating campaign actions...")

cmp_pop_arr = F.array(*[F.lit(f"CMP-{i + 1:07d}") for i in range(N_CAMPAIGNS)])
actions_df = (
    spark.range(0, 35_000)
    .withColumn("action_id", F.concat(F.lit("ACT-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("campaign_id", F.element_at(cmp_pop_arr, (F.rand(81) * N_CAMPAIGNS + 1).cast("int")))
    .withColumn("action_type", F.element_at(F.array(F.lit("replicate_winner"), F.lit("reallocate_budget"), F.lit("pause")), (F.rand(82) * 3 + 1).cast("int")))
    .withColumn("had_matching_winner", F.rand(83) < 0.5)
    .withColumn("roas_at_action", F.round(0.8 + F.rand(84) * 0.8, 2))  # underperformers
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(85) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("action_cost_usd", F.when(F.col("action_type") == "replicate_winner", F.lit(2000.0)).when(F.col("action_type") == "reallocate_budget", F.lit(200.0)).otherwise(F.lit(0.0)))
    # roas_lift: replicate best WITH matching winner; reallocate steady; pause zero.
    .withColumn(
        "roas_lift",
        F.when((F.col("action_type") == "replicate_winner") & F.col("had_matching_winner"), F.round(1.5 + F.rand(86) * 1.5, 2))
        .when(F.col("action_type") == "replicate_winner", F.round(0.1 + F.rand(87) * 0.2, 2))
        .when(F.col("action_type") == "reallocate_budget", F.round(0.6 + F.rand(88) * 0.6, 2))
        .otherwise(F.lit(0.0)),
    )
    .withColumn("revenue_impact_usd", F.round(F.col("roas_lift") * (50000 + F.rand(89) * 150000), 2))
    .select("action_id", "campaign_id", "action_type", "had_matching_winner", "roas_at_action", "initiated_date", "action_cost_usd", "roas_lift", "revenue_impact_usd")
)
_save(actions_df, "raw_campaign_actions")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Seven raw datasets written. Next: run the SDP pipeline (`transformation/*.sql`) to build silver
# MAGIC + gold, then the metric view, the ROAS-lift model (`transformation/roas_train_score.py`), the
# MAGIC dashboard, and the Genie space. Validate against `01-lakeflow.md` Section C.

# COMMAND ----------

print("\n✅ Brightwave raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_CAMPAIGN} (underperformer) ~ matching winner {HERO_WINNER}")
print(f"   Winners: {len(WINNER_CMPS)}  underperformers: {len(UNDER_CMPS)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_campaign": HERO_CAMPAIGN, "hero_winner": HERO_WINNER,
        "winners": len(WINNER_CMPS), "underperformers": len(UNDER_CMPS),
    }))
