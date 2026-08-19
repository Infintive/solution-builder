# Databricks notebook source
# MAGIC %md
# MAGIC # Nimbus — Conversion Slide & Feature Velocity · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Nimbus demo under `<catalog>.<schema>` using Spark.
# MAGIC Follows the `databricks-synthetic-data-gen` skill: `spark.range` + `F.when` + broadcast joins
# MAGIC + Window + `F.element_at` — no driver loops, no `.collect()` on big tables.
# MAGIC
# MAGIC **The load-bearing anomaly** (one change, two visible symptoms): a checkout-flow change ~3 weeks
# MAGIC ago landed unevenly across platforms and pushed a cluster of Android/Gen-Z segment cohorts into a
# MAGIC conversion slide, while iOS held and the rest of the base is stable. The hero is `SEG-0000214`
# MAGIC (Gen-Z/Android, conversion 4.2% → 2.9%) with a matching proven experiment; the play the heuristic
# MAGIC ranks first is **ship_proven_variant**. See `specifications/01-lakeflow.md`.
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
NOW = STORY_PINNED_NOW if os.environ.get("NIMBUS_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
CHANGE_ONSET = NOW - timedelta(days=21)
SLIDE_RAMP = NOW - timedelta(days=18)
SNAPSHOT_DATE = NOW - timedelta(days=1)
CONV_WINDOW_START = NOW - timedelta(days=14)

# ── Deterministic story anchors ───────────────────────────────────────────────
N_SEGMENTS = 500
N_AFFECTED = 40                                   # sliding cohorts (ship_proven_variant-heavy)
N_NOMATCH = 14                                    # of the affected, this many have NO matching experiment
                                                  # → rollout_existing_flag wins for them (plausible mix)
PER_CONV_REV = 8.0                                # per-conversion revenue (exposure factor)

HERO_SEG = "SEG-0000214"                           # Gen-Z / Android
HERO_EXP = "EXP-0000009"                           # its matching proven experiment

COHORTS = ["gen_z", "millennial", "gen_x", "boomer"]
PLATFORMS = ["ios", "android", "web"]
REGIONS = ["NA", "EMEA", "APAC", "LATAM"]
FEATURE_AREAS = ["checkout", "onboarding", "discovery", "pricing"]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('NIMBUS_PIN_TIME') == '1' else 'rolling'})")
print(f"CHANGE_ONSET: {CHANGE_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_SEG} (gen_z/android) sliding ~ matching experiment {HERO_EXP}")

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
# MAGIC ## 1. Segments — ~500 cohort×platform segments; hero Gen-Z/Android pinned
# MAGIC The affected cohorts are a deterministic index set (Android/web-heavy); the hero is forced in.

# COMMAND ----------

print("\n[1/6] Generating segments...")

cohort_arr = F.array(*[F.lit(c) for c in COHORTS])
plat_arr = F.array(*[F.lit(p) for p in PLATFORMS])
region_arr = F.array(*[F.lit(r) for r in REGIONS])

AFFECTED_IDX = [213] + [i for i in range(20, 20 + (N_AFFECTED - 1) * 11, 11)][: N_AFFECTED - 1]
affected_idx_arr = F.array(*[F.lit(int(i)) for i in AFFECTED_IDX])
NOMATCH_IDX = set(AFFECTED_IDX[-N_NOMATCH:])
nomatch_idx_arr = F.array(*[F.lit(int(i)) for i in NOMATCH_IDX])

segments_df = (
    spark.range(0, N_SEGMENTS)
    .withColumn("segment_id", F.concat(F.lit("SEG-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_affected", F.array_contains(affected_idx_arr, F.col("id").cast("int")))
    .withColumn("is_nomatch", F.array_contains(nomatch_idx_arr, F.col("id").cast("int")))
    # cohort: affected skew gen_z/millennial; hero gen_z.
    .withColumn(
        "cohort",
        F.when(F.col("segment_id") == HERO_SEG, F.lit("gen_z"))
        .when(F.col("is_affected") & (F.rand(1) < 0.6), F.lit("gen_z"))
        .when(F.col("is_affected"), F.lit("millennial"))
        .otherwise(F.element_at(cohort_arr, (F.rand(2) * len(COHORTS) + 1).cast("int"))),
    )
    # platform: affected are android (+ some web); hero android. iOS never affected.
    .withColumn(
        "platform",
        F.when(F.col("segment_id") == HERO_SEG, F.lit("android"))
        .when(F.col("is_affected") & (F.rand(3) < 0.75), F.lit("android"))
        .when(F.col("is_affected"), F.lit("web"))
        .otherwise(F.element_at(plat_arr, (F.rand(4) * len(PLATFORMS) + 1).cast("int"))),
    )
    .withColumn("region", F.element_at(region_arr, (F.rand(5) * len(REGIONS) + 1).cast("int")))
    .withColumn("mau", F.when(F.col("segment_id") == HERO_SEG, F.lit(420000)).otherwise((20000 + F.rand(6) * 400000).cast("int")))
    .withColumn(
        "segment_summary",
        F.concat_ws(" ", F.col("cohort"), F.lit("cohort on"), F.col("platform"), F.lit("in"), F.col("region"), F.lit("."),
                    F.when(F.col("is_affected"), F.lit("Conversion sliding since the checkout change; a proven variant may recover it."))
                    .otherwise(F.lit("Funnel healthy, converting to plan."))),
    )
    .withColumn("is_active", F.lit(True))
    .select("segment_id", "cohort", "platform", "region", "mau", "segment_summary", "is_active")
)
_save(segments_df, "raw_segments")

AFFECTED_SEGS = [f"SEG-{i + 1:07d}" for i in AFFECTED_IDX]
NOMATCH_SEGS = [f"SEG-{i + 1:07d}" for i in NOMATCH_IDX]

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Experiments — the experiment/feature catalog (searchable)
# MAGIC A proven checkout experiment for a Gen-Z cohort (EXP-0000009) is the hero's matching variant.

# COMMAND ----------

print("\n[2/6] Generating experiments...")

fa_arr = F.array(*[F.lit(f) for f in FEATURE_AREAS])
experiments_df = (
    spark.range(0, 60)
    .withColumn("experiment_id", F.concat(F.lit("EXP-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("feature_area", F.element_at(fa_arr, (F.rand(11) * len(FEATURE_AREAS) + 1).cast("int")))
    # Pin EXP-0000009 (index 8) as a WON checkout experiment tested on gen_z — the hero's match.
    .withColumn("feature_area", F.when(F.col("experiment_id") == HERO_EXP, F.lit("checkout")).otherwise(F.col("feature_area")))
    .withColumn("variant", F.concat(F.lit("variant_"), F.element_at(F.array(F.lit("a"), F.lit("b"), F.lit("c")), (F.rand(12) * 3 + 1).cast("int"))))
    .withColumn("tested_cohort", F.when(F.col("experiment_id") == HERO_EXP, F.lit("gen_z")).otherwise(F.element_at(cohort_arr, (F.rand(13) * len(COHORTS) + 1).cast("int"))))
    .withColumn("tested_platform", F.when(F.col("experiment_id") == HERO_EXP, F.lit("android")).otherwise(F.element_at(plat_arr, (F.rand(14) * len(PLATFORMS) + 1).cast("int"))))
    .withColumn("won", F.when(F.col("experiment_id") == HERO_EXP, F.lit(True)).otherwise(F.rand(15) < 0.45))
    .withColumn("observed_lift", F.when(F.col("won"), F.round(0.008 + F.rand(16) * 0.02, 4)).otherwise(F.round(-0.005 + F.rand(17) * 0.008, 4)))
    .withColumn("experiment_name", F.concat(F.initcap(F.col("feature_area")), F.lit(" "), F.col("variant"), F.lit(" ["), F.col("tested_cohort"), F.lit("]")))
    .withColumn(
        "description",
        F.concat_ws(" ", F.lit("Experiment on the"), F.col("feature_area"), F.lit("flow,"), F.col("variant"), F.lit(", tested on"),
                    F.col("tested_cohort"), F.lit("/"), F.col("tested_platform"), F.lit("."),
                    F.when(F.col("won"), F.concat(F.lit("WON: lifted conversion by"), F.round(F.col("observed_lift") * 100, 2).cast("string"), F.lit(" points. A proven variant to replicate for similar cohorts.")))
                    .otherwise(F.lit("Did not lift conversion; not recommended."))),
    )
    .withColumn("is_active", F.lit(True))
    .select("experiment_id", "experiment_name", "variant", "feature_area", "tested_cohort", "tested_platform", "won", "observed_lift", "description", "is_active")
)
_save(experiments_df, "raw_experiments")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Events — 18 months of sampled sessions; the conversion slide on the affected cohorts

# COMMAND ----------

print("\n[3/6] Generating events...")

affected_seg_arr = F.array(*[F.lit(s) for s in AFFECTED_SEGS])
# Baseline sessions: sampled over 18 months across cohorts at ~4% conversion.
_all_segs_arr = F.array(*[F.lit(f"SEG-{i + 1:07d}") for i in range(N_SEGMENTS)])
events_baseline = (
    spark.range(0, 3_300_000)
    .withColumn("segment_id", F.element_at(_all_segs_arr, (F.rand(21) * N_SEGMENTS + 1).cast("int")))
    .withColumn("event_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(22) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("session_id", F.concat(F.lit("S"), F.col("id").cast("string")))
    .withColumn("converted", F.rand(23) < 0.04)  # ~4% baseline
    .withColumn("revenue_usd", F.when(F.col("converted"), F.round(5 + F.rand(24) * 40, 2)).otherwise(F.lit(0.0)))
    .select("segment_id", "event_date", "session_id", "converted", "revenue_usd")
)
# Affected recent sessions (last 21 days): conversion slides from 4% to ~2.8%.
ramp_off = (SNAPSHOT_DATE - SLIDE_RAMP).days
affected_events = (
    spark.range(0, 200_000)
    .withColumn("segment_id", F.element_at(affected_seg_arr, (F.rand(25) * len(AFFECTED_SEGS) + 1).cast("int")))
    .withColumn("day_offset", (F.rand(26) * 21).cast("int"))
    .withColumn("event_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("day_offset")))
    .withColumn("session_id", F.concat(F.lit("SA"), F.col("id").cast("string")))
    # conversion probability slides down as day_offset → 0 (more recent = lower).
    .withColumn("_p", 0.028 + (F.col("day_offset") / 21.0) * 0.014)  # 0.028 now → 0.042 three weeks ago
    .withColumn("converted", F.rand(27) < F.col("_p"))
    .withColumn("revenue_usd", F.when(F.col("converted"), F.round(5 + F.rand(28) * 40, 2)).otherwise(F.lit(0.0)))
    .select("segment_id", "event_date", "session_id", "converted", "revenue_usd")
)
events_df = events_baseline.unionByName(affected_events)
_save(events_df, "raw_events")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Feature flags — current flag state per (segment, feature_area)

# COMMAND ----------

print("\n[4/6] Generating feature flags...")

flags_df = (
    segments_df.select("segment_id")
    .crossJoin(spark.createDataFrame([(f,) for f in FEATURE_AREAS], "feature_area string"))
    .withColumn("flag_id", F.concat(F.lit("FLAG-"), F.lpad((F.monotonically_increasing_id() % 90000 + 1).cast("string"), 5, "0")))
    .withColumn("flag_key", F.concat(F.col("feature_area"), F.lit("_flow")))
    .withColumn("variant", F.element_at(F.array(F.lit("control"), F.lit("variant_a"), F.lit("variant_b")), (F.rand(31) * 3 + 1).cast("int")))
    .withColumn("rollout_pct", F.element_at(F.array(F.lit(0), F.lit(25), F.lit(50), F.lit(100)), (F.rand(32) * 4 + 1).cast("int")))
    .withColumn("updated_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (F.rand(33) * 90).cast("int")))
    .select("flag_id", "segment_id", "feature_area", "flag_key", "variant", "rollout_pct", "updated_date")
)
_save(flags_df, "raw_feature_flags")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Conversion snapshots — daily conversion for the last ~14 days + current

# COMMAND ----------

print("\n[5/6] Generating conversion snapshots...")

_SLIDE_NOTES = [
    "conversion dropping since the checkout change", "android funnel regressed, ios fine",
    "drop-off at payment step for this segment", "needs a rollback or a proven variant", "losing this cohort week over week",
]
_HEALTHY_NOTES = ["converting to plan", "funnel healthy, no regressions", None, None]
slide_arr = F.array(*[F.lit(x) for x in _SLIDE_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

n_snap_days = (SNAPSHOT_DATE - CONV_WINDOW_START).days + 1

# Affected: daily, conversion slides to 2.8-3.0% now; hero pinned ~2.9%. Include a 3-weeks-ago
# baseline snapshot (d = n_snap_days-1 area) implicitly via the ramp so conversion_drop is derivable
# — but gold derives drop from the oldest-in-window; to make that clean, set the oldest snapshot to ~4%.
affected_conv = (
    spark.createDataFrame([(s,) for s in AFFECTED_SEGS], "segment_id string")
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    # d=0 current (lowest); older d → higher (~4%). Linear slide.
    .withColumn("_frac", (F.lit(n_snap_days - 1) - F.col("d")) / F.lit(float(max(n_snap_days - 1, 1))))  # 1.0 at current, 0.0 oldest
    .withColumn(
        "conversion_rate",
        F.when(F.col("segment_id") == HERO_SEG, F.round(0.042 - F.col("_frac") * 0.013, 4))  # 0.042 → 0.029
        .otherwise(F.round(0.041 - F.col("_frac") * (0.011 + F.rand(41) * 0.006), 4)),
    )
    .withColumn("sessions", (2000 + F.rand(42) * 8000).cast("int"))
    .withColumn(
        "pm_note_text",
        F.when(F.rand(43) < 0.85, F.element_at(slide_arr, (F.rand(44) * len(_SLIDE_NOTES) + 1).cast("int")))
        .when(F.rand(45) < 0.3, F.element_at(healthy_arr, (F.rand(46) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("segment_id", "snapshot_date", "conversion_rate", "sessions", "pm_note_text")
)
# Healthy: current-snapshot only, stable 3.5-4.5%.
healthy_conv = (
    spark.range(0, N_SEGMENTS)
    .withColumn("segment_id", F.concat(F.lit("SEG-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_affected", F.array_contains(affected_seg_arr, F.col("segment_id")))
    .filter(~F.col("is_affected"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("conversion_rate", F.round(0.035 + F.rand(47) * 0.01, 4))
    .withColumn("sessions", (2000 + F.rand(48) * 8000).cast("int"))
    .withColumn("pm_note_text", F.element_at(healthy_arr, (F.rand(49) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("segment_id", "snapshot_date", "conversion_rate", "sessions", "pm_note_text")
)
conv_df = affected_conv.unionByName(healthy_conv)
_save(conv_df, "raw_conv_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Experiment outcomes — 18 months of ships with outcomes (model training)
# MAGIC ship_proven_variant WITH a matching experiment lifts conversion most per dollar; rollout_existing_flag
# MAGIC reliable-but-smaller; ship_alt_variant the fallback. This ranks the hero as ship_proven_variant.

# COMMAND ----------

print("\n[6/6] Generating experiment outcomes...")

seg_pop_arr = F.array(*[F.lit(f"SEG-{i + 1:07d}") for i in range(N_SEGMENTS)])
outcomes_df = (
    spark.range(0, 35_000)
    .withColumn("outcome_id", F.concat(F.lit("EXO-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("segment_id", F.element_at(seg_pop_arr, (F.rand(51) * N_SEGMENTS + 1).cast("int")))
    .withColumn("action_type", F.element_at(F.array(F.lit("ship_proven_variant"), F.lit("rollout_existing_flag"), F.lit("ship_alt_variant")), (F.rand(52) * 3 + 1).cast("int")))
    .withColumn("had_matching_experiment", F.rand(53) < 0.5)
    .withColumn("conversion_at_action", F.round(0.025 + F.rand(54) * 0.01, 4))
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(55) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("ship_cost_usd", F.when(F.col("action_type") == "rollout_existing_flag", F.lit(500.0)).otherwise(F.lit(5000.0)))
    # conversion_lift: proven+match best; rollout reliable-smaller; alt low.
    .withColumn(
        "conversion_lift",
        F.when((F.col("action_type") == "ship_proven_variant") & F.col("had_matching_experiment"), F.round(0.012 + F.rand(56) * 0.012, 4))
        .when(F.col("action_type") == "ship_proven_variant", F.round(0.002 + F.rand(57) * 0.002, 4))
        .when(F.col("action_type") == "rollout_existing_flag", F.round(0.005 + F.rand(58) * 0.004, 4))
        .otherwise(F.round(0.002 + F.rand(59) * 0.004, 4)),
    )
    .withColumn("users_recovered", (F.col("conversion_lift") * (50000 + F.rand(60) * 400000)).cast("int"))
    .select("outcome_id", "segment_id", "action_type", "had_matching_experiment", "conversion_at_action", "initiated_date", "ship_cost_usd", "conversion_lift", "users_recovered")
)
_save(outcomes_df, "raw_experiment_outcomes")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Six raw datasets written. Next: run the SDP pipeline (`transformation/*.sql`) to build silver
# MAGIC + gold, then the metric view, the conversion model (`transformation/conversion_train_score.py`),
# MAGIC the dashboard, and the Genie space. Validate against `01-lakeflow.md` Section C.

# COMMAND ----------

print("\n✅ Nimbus raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_SEG} (gen_z/android) sliding ~ matching experiment {HERO_EXP}")
print(f"   Affected cohorts: {len(AFFECTED_SEGS)}  (no-match: {len(NOMATCH_SEGS)})")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_segment": HERO_SEG, "hero_experiment": HERO_EXP,
        "affected_cohorts": len(AFFECTED_SEGS),
    }))
