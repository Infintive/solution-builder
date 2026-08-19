# Databricks notebook source
# MAGIC %md
# MAGIC # Streamline Telco — Churn Save on the Call · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Streamline demo under `<catalog>.<schema>` using Spark.
# MAGIC Follows the `databricks-synthetic-data-gen` skill: `spark.range` + `F.when` + broadcast joins
# MAGIC + Window + `F.element_at` — no driver loops, no `.collect()` on big tables.
# MAGIC
# MAGIC **The load-bearing anomaly** (one driver, two visible symptoms): a network outage on NODE-OHIO-14
# MAGIC ~3 weeks ago colliding with billing friction pushed a cluster of subscribers into churn risk,
# MAGIC while the rest of the base is stable. Same event, two symptoms: rising churn risk + open tickets.
# MAGIC The hero is `SUB-0000214` (5-year, outage node, open ticket + billing dispute, risk ~0.86); the
# MAGIC retention offer the heuristic ranks first is a **bill_credit** (the reason is service, not price).
# MAGIC See `specifications/01-lakeflow.md`.
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
NOW = STORY_PINNED_NOW if os.environ.get("STREAMLINE_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
OUTAGE_ONSET = NOW - timedelta(days=21)
RISK_RAMP = NOW - timedelta(days=18)
SNAPSHOT_DATE = NOW - timedelta(days=1)
RISK_WINDOW_START = NOW - timedelta(days=14)

# ── Deterministic story anchors ───────────────────────────────────────────────
N_SUBS = 40_000
N_AFFECTED = 200                                  # high-risk subscribers (bill_credit-heavy: service reason)
N_MODERATE = 100                                  # secondary cohort (price/device reasons) → plausible mix
EXPECTED_MONTHS = 24                              # CLV horizon

HERO_SUB = "SUB-0000214"
HERO_NODE = "NODE-OHIO-14"

# The three churn reasons + their matching offer.
REASON_OFFER = {"service": "bill_credit", "price": "plan_upgrade_discount", "device": "device_upgrade"}

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('STREAMLINE_PIN_TIME') == '1' else 'rolling'})")
print(f"OUTAGE_ONSET: {OUTAGE_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_SUB} on {HERO_NODE}, service reason → bill_credit")

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
# MAGIC ## 1. Subscribers — ~40K, plan-tagged, geo-anchored, node-homed
# MAGIC The affected cohort (high churn risk) is a deterministic index set; the hero is forced onto
# MAGIC NODE-OHIO-14 with a service reason. `service_summary` is the searchable blurb.

# COMMAND ----------

print("\n[1/8] Generating subscribers...")

_METROS = [
    ("Columbus", "OH", 39.96, -82.99), ("Cleveland", "OH", 41.50, -81.69),
    ("Chicago", "IL", 41.88, -87.63), ("Dallas", "TX", 32.78, -96.80),
    ("Atlanta", "GA", 33.75, -84.39), ("Denver", "CO", 39.74, -104.99),
    ("Phoenix", "AZ", 33.45, -112.07), ("Seattle", "WA", 47.61, -122.33),
]
_PLANS = ["broadband", "mobile", "bundle"]
_PLAN_P = [0.35, 0.35, 0.30]

metro_arr = F.array(*[F.lit(m[0]) for m in _METROS])
state_arr = F.array(*[F.lit(m[1]) for m in _METROS])
lat_arr = F.array(*[F.lit(float(m[2])) for m in _METROS])
lng_arr = F.array(*[F.lit(float(m[3])) for m in _METROS])
plan_arr = F.array(*[F.lit(p) for p in _PLANS])

AFFECTED_IDX = [213] + [i for i in range(300, 300 + (N_AFFECTED - 1) * 37, 37)][: N_AFFECTED - 1]
affected_idx_arr = F.array(*[F.lit(int(i)) for i in AFFECTED_IDX])
MODERATE_IDX = [i for i in range(20000, 20000 + N_MODERATE * 61, 61)][:N_MODERATE]
moderate_idx_arr = F.array(*[F.lit(int(i)) for i in MODERATE_IDX])

subs_df = (
    spark.range(0, N_SUBS)
    .withColumn("subscriber_id", F.concat(F.lit("SUB-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("_mi", (F.rand(1) * len(_METROS)).cast("int"))
    .withColumn("is_affected", F.array_contains(affected_idx_arr, F.col("id").cast("int")))
    .withColumn("is_moderate", F.array_contains(moderate_idx_arr, F.col("id").cast("int")))
    # Affected subscribers home on the Ohio metros (0,1); hero on Columbus.
    .withColumn("_mi", F.when(F.col("is_affected") & (F.rand(2) < 0.5), F.lit(0)).when(F.col("is_affected"), F.lit(1)).otherwise(F.col("_mi")))
    .withColumn("_mi", F.when(F.col("subscriber_id") == HERO_SUB, F.lit(0)).otherwise(F.col("_mi")))
    .withColumn("plan_type", F.element_at(plan_arr, (F.rand(3) * len(_PLANS) + 1).cast("int")))
    .withColumn("tenure_months", F.when(F.col("subscriber_id") == HERO_SUB, F.lit(60)).otherwise((3 + F.rand(4) * 90).cast("int")))
    .withColumn("monthly_arpu_usd", F.round(45 + F.rand(5) * 80, 2))
    # service_node_id: hero + Ohio-affected on NODE-OHIO-14; others random nodes.
    .withColumn(
        "service_node_id",
        F.when(F.col("subscriber_id") == HERO_SUB, F.lit(HERO_NODE))
        .when(F.col("is_affected") & (F.col("_mi") == 0), F.lit(HERO_NODE))
        .otherwise(F.concat(F.lit("NODE-"), F.element_at(state_arr, F.col("_mi") + 1), F.lit("-"), F.lpad(((F.rand(6) * 40 + 1).cast("int")).cast("string"), 2, "0"))),
    )
    .withColumn("home_metro", F.element_at(metro_arr, F.col("_mi") + 1))
    .withColumn("state", F.element_at(state_arr, F.col("_mi") + 1))
    .withColumn("sub_lat", F.round(F.element_at(lat_arr, F.col("_mi") + 1) + (F.rand(7) - 0.5) * 0.1, 2))
    .withColumn("sub_lng", F.round(F.element_at(lng_arr, F.col("_mi") + 1) + (F.rand(8) - 0.5) * 0.1, 2))
    .withColumn("activation_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), F.col("tenure_months") * 30))
    .withColumn("sub_display_name", F.concat(F.lit("Subscriber "), F.substring(F.col("subscriber_id"), 5, 7)))
    .withColumn(
        "service_summary",
        F.concat_ws(" ",
            F.col("plan_type"), F.lit("plan,"), F.col("tenure_months").cast("string"), F.lit("months tenure, node"), F.col("service_node_id"), F.lit("."),
            F.when(F.col("is_affected"), F.lit("Recent outage on their node and a billing dispute; open ticket, elevated churn risk."))
            .when(F.col("is_moderate"), F.lit("Some recent friction; moderate churn risk, monitor."))
            .otherwise(F.lit("Stable service, tickets resolved, no active issues.")),
        ),
    )
    .withColumn("is_active", F.lit(True))
    .select("subscriber_id", "sub_display_name", "plan_type", "tenure_months", "monthly_arpu_usd", "service_node_id", "home_metro", "state", "sub_lat", "sub_lng", "activation_date", "service_summary", "is_active")
)
_save(subs_df, "raw_subscribers")

AFFECTED_SUBS = [f"SUB-{i + 1:07d}" for i in AFFECTED_IDX]
MODERATE_SUBS = [f"SUB-{i + 1:07d}" for i in MODERATE_IDX]
ATRISK_SUBS = AFFECTED_SUBS + MODERATE_SUBS

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Offers — retention/plan offer catalog (searchable)

# COMMAND ----------

print("\n[2/8] Generating offers...")

_OFFERS = [
    ("OFFER-001", "One-Time Bill Credit $50", "bill_credit", 50.0, "all", "A one-time account credit that acknowledges a service or billing issue. Best for subscribers whose churn reason is a service outage or billing dispute."),
    ("OFFER-002", "One-Time Bill Credit $100", "bill_credit", 100.0, "high_value", "A larger one-time credit for high-value subscribers with a service or billing grievance."),
    ("OFFER-003", "20% Plan Discount 12mo", "plan_upgrade_discount", 0.2, "all", "A recurring 20% discount for 12 months. Best for subscribers leaving over price or a competitor offer."),
    ("OFFER-004", "Unlimited Upgrade Discount", "plan_upgrade_discount", 0.15, "mobile", "A discounted unlimited-plan upgrade. For price-sensitive mobile subscribers."),
    ("OFFER-005", "Subsidized Device Upgrade", "device_upgrade", 300.0, "high_value", "A subsidized new device. Best for high-ARPU subscribers whose churn reason is device or experience."),
]
offers_df = (
    spark.createDataFrame([(o[0], o[1], o[2], o[3], o[4], o[5]) for o in _OFFERS],
        "offer_id string, offer_name string, offer_type string, value_usd double, segment string, description string")
    .withColumn("is_active", F.lit(True))
)
_save(offers_df, "raw_offers")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Usage — 18 months daily usage (baseline rhythm; affected dip post-outage)

# COMMAND ----------

print("\n[3/8] Generating usage...")

_baseline_subs = [f"SUB-{i + 1:07d}" for i in range(6000) if i not in set(AFFECTED_IDX) | set(MODERATE_IDX)]
sub_arr = F.array(*[F.lit(s) for s in _baseline_subs])
_n_baseline = len(_baseline_subs)
usage_df = (
    spark.range(0, 3_500_000)
    .withColumn("subscriber_id", F.element_at(sub_arr, (F.rand(21) * _n_baseline + 1).cast("int")))
    .withColumn("usage_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(22) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("dow_mult", F.when(F.dayofweek("usage_date").isin(1, 7), 1.4).otherwise(1.0))
    .withColumn("data_gb", F.round(F.col("dow_mult") * (1 + F.rand(23) * 8), 2))
    .withColumn("voice_min", (F.col("dow_mult") * (F.rand(24) * 60)).cast("int"))
    .withColumn("stream_hours", F.round(F.col("dow_mult") * F.rand(25) * 5, 2))
    .select("subscriber_id", "usage_date", "data_gb", "voice_min", "stream_hours")
)
_save(usage_df, "raw_usage")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Billing — monthly bills + disputes on the affected cohort

# COMMAND ----------

print("\n[4/8] Generating billing...")

# Affected: a recent disputed bill. Everyone: 18 monthly bills (sampled subset for size).
atrisk_sub_arr = F.array(*[F.lit(s) for s in ATRISK_SUBS])
affected_bill = (
    spark.createDataFrame([(s,) for s in AFFECTED_SUBS], "subscriber_id string")
    .withColumn("bill_month", F.lit((SNAPSHOT_DATE.replace(day=1)).date().isoformat()).cast("date"))
    .withColumn("amount_usd", F.round(60 + F.rand(31) * 90, 2))
    .withColumn("disputed", F.lit(True))
    .withColumn("dispute_reason", F.lit("charged during outage window"))
    .select("subscriber_id", "bill_month", "amount_usd", "disputed", "dispute_reason")
)
baseline_bill = (
    spark.range(0, 680_000)
    .withColumn("subscriber_id", F.element_at(sub_arr, (F.rand(32) * _n_baseline + 1).cast("int")))
    .withColumn("bill_month", F.trunc(F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(33) * HIST_SPAN_DAYS).cast("int")), "MM"))
    .withColumn("amount_usd", F.round(45 + F.rand(34) * 100, 2))
    .withColumn("disputed", F.rand(35) < 0.02)
    .withColumn("dispute_reason", F.when(F.rand(35) < 0.02, F.lit("billing question")).otherwise(F.lit(None).cast("string")))
    .select("subscriber_id", "bill_month", "amount_usd", "disputed", "dispute_reason")
)
billing_df = (
    affected_bill.unionByName(baseline_bill)
    .withColumn("bill_id", F.concat(F.lit("BILL-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("bill_id", "subscriber_id", "bill_month", "amount_usd", "disputed", "dispute_reason")
)
_save(billing_df, "raw_billing")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Tickets — open outage/billing tickets on the affected cohort

# COMMAND ----------

print("\n[5/8] Generating tickets...")

_TKT_COLS = ["subscriber_id", "ticket_type", "opened_date", "closed_date", "channel", "note_text"]
affected_tkt = (
    spark.createDataFrame([(s,) for s in AFFECTED_SUBS], "subscriber_id string")
    .withColumn("ticket_type", F.when(F.rand(41) < 0.6, F.lit("outage")).otherwise(F.lit("billing")))
    .withColumn("opened_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (2 + F.rand(42) * 14).cast("int")))
    .withColumn("closed_date", F.lit(None).cast("date"))
    .withColumn("channel", F.element_at(F.array(F.lit("phone"), F.lit("chat"), F.lit("app")), (F.rand(43) * 3 + 1).cast("int")))
    .withColumn("note_text", F.when(F.col("ticket_type") == "outage", F.lit("called about outage, still not resolved")).otherwise(F.lit("disputes last bill, threatening to leave")))
    .select(*_TKT_COLS)
)
baseline_tkt = (
    spark.range(0, 245_000)
    .withColumn("subscriber_id", F.element_at(sub_arr, (F.rand(44) * _n_baseline + 1).cast("int")))
    .withColumn("ticket_type", F.element_at(F.array(F.lit("technical"), F.lit("billing"), F.lit("general"), F.lit("outage")), (F.rand(45) * 4 + 1).cast("int")))
    .withColumn("opened_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (10 + F.rand(46) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("closed_date", F.expr("date_add(opened_date, cast(rand(47)*5+1 as int))"))
    .withColumn("channel", F.element_at(F.array(F.lit("phone"), F.lit("chat"), F.lit("app")), (F.rand(48) * 3 + 1).cast("int")))
    .withColumn("note_text", F.lit("routine support call, resolved"))
    .select(*_TKT_COLS)
)
tickets_df = (
    affected_tkt.unionByName(baseline_tkt)
    .withColumn("ticket_id", F.concat(F.lit("TKT-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("ticket_id", "subscriber_id", "ticket_type", "opened_date", "closed_date", "channel", "note_text")
)
_save(tickets_df, "raw_tickets")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Network events — the NODE-OHIO-14 outage ~3 weeks ago

# COMMAND ----------

print("\n[6/8] Generating network events...")

state_all = ["OH", "IL", "TX", "GA", "CO", "AZ", "WA"]
node_state_arr = F.array(*[F.lit(s) for s in state_all])
hero_event = spark.createDataFrame(
    [(HERO_NODE, "outage", OUTAGE_ONSET.date().isoformat(), 480, 1200)],
    "node_id string, event_type string, event_date string, duration_min int, subscribers_affected int",
).withColumn("event_date", F.to_date("event_date"))
baseline_events = (
    spark.range(0, 120_000)
    .withColumn("node_id", F.concat(F.lit("NODE-"), F.element_at(node_state_arr, (F.rand(51) * len(state_all) + 1).cast("int")), F.lit("-"), F.lpad(((F.rand(52) * 40 + 1).cast("int")).cast("string"), 2, "0")))
    .withColumn("event_type", F.when(F.rand(53) < 0.3, F.lit("outage")).otherwise(F.lit("degradation")))
    .withColumn("event_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(54) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("duration_min", (5 + F.rand(55) * 120).cast("int"))
    .withColumn("subscribers_affected", (10 + F.rand(56) * 500).cast("int"))
    .select("node_id", "event_type", "event_date", "duration_min", "subscribers_affected")
)
net_df = (
    hero_event.unionByName(baseline_events)
    .withColumn("event_id", F.concat(F.lit("NEV-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("event_id", "node_id", "event_type", "event_date", "duration_min", "subscribers_affected")
)
_save(net_df, "raw_network_events")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Risk snapshots — daily churn-risk for the last ~14 days + current
# MAGIC Affected → 0.75-0.9 (mostly service reason; hero pinned service). Moderate → 0.42-0.63
# MAGIC with price/device reasons so the offer mix is plausible.

# COMMAND ----------

print("\n[7/8] Generating risk snapshots...")

_CHURN_NOTES = [
    "called about outage, still not resolved", "disputes last bill, threatening to leave",
    "asked about competitor's offer", "service down twice this month", "escalated, wants credit or will cancel",
]
_HEALTHY_NOTES = ["routine support call, resolved", "satisfied, no issues", None, None]
churn_arr = F.array(*[F.lit(x) for x in _CHURN_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])
reason_arr = F.array(F.lit("service"), F.lit("price"), F.lit("device"))

n_snap_days = (SNAPSHOT_DATE - RISK_WINDOW_START).days + 1

# Affected: daily, risk ramps to 0.75-0.9; reason mostly 'service' (the outage), hero pinned service.
affected_risk = (
    spark.createDataFrame([(s,) for s in AFFECTED_SUBS], "subscriber_id string")
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    .withColumn("_progress", (F.lit(n_snap_days - 1) - F.col("d")) / F.lit(float(max(n_snap_days - 1, 1))))
    .withColumn(
        "churn_risk_score",
        F.when(F.col("subscriber_id") == HERO_SUB, F.round(F.least(F.lit(0.92), 0.2 + F.col("_progress") * 0.64), 3))
        .otherwise(F.round(F.least(F.lit(0.95), 0.15 + F.col("_progress") * (0.62 + F.rand(61) * 0.2)), 3)),
    )
    .withColumn(
        "churn_reason",
        F.when(F.col("subscriber_id") == HERO_SUB, F.lit("service"))
        .when(F.rand(62) < 0.7, F.lit("service")).when(F.rand(63) < 0.6, F.lit("price")).otherwise(F.lit("device")),
    )
    .withColumn("open_ticket_count", (1 + F.col("_progress") * 2 + F.rand(64)).cast("int"))
    .withColumn(
        "agent_note_text",
        F.when(F.rand(65) < 0.85, F.element_at(churn_arr, (F.rand(66) * len(_CHURN_NOTES) + 1).cast("int")))
        .when(F.rand(67) < 0.3, F.element_at(healthy_arr, (F.rand(68) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("subscriber_id", "snapshot_date", "churn_risk_score", "churn_reason", "open_ticket_count", "agent_note_text")
)
# Moderate: current only, risk 0.42-0.63, reasons weighted to price/device (so plan/device offers win).
moderate_risk = (
    spark.createDataFrame([(s,) for s in MODERATE_SUBS], "subscriber_id string")
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("churn_risk_score", F.round(0.42 + F.rand(71) * 0.21, 3))
    .withColumn("churn_reason", F.when(F.rand(72) < 0.55, F.lit("price")).otherwise(F.lit("device")))
    .withColumn("open_ticket_count", (1 + F.rand(73)).cast("int"))
    .withColumn("agent_note_text", F.when(F.rand(74) < 0.6, F.element_at(churn_arr, (F.rand(75) * len(_CHURN_NOTES) + 1).cast("int"))).otherwise(F.element_at(healthy_arr, (F.rand(76) * len(_HEALTHY_NOTES) + 1).cast("int"))))
    .select("subscriber_id", "snapshot_date", "churn_risk_score", "churn_reason", "open_ticket_count", "agent_note_text")
)
everyday_risk = (
    spark.range(0, N_SUBS)
    .withColumn("subscriber_id", F.concat(F.lit("SUB-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_atrisk", F.array_contains(atrisk_sub_arr, F.col("subscriber_id")))
    .filter(~F.col("is_atrisk"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("churn_risk_score", F.round(0.03 + F.rand(77) * 0.17, 3))
    .withColumn("churn_reason", F.element_at(reason_arr, (F.rand(78) * 3 + 1).cast("int")))
    .withColumn("open_ticket_count", (F.rand(79)).cast("int"))
    .withColumn("agent_note_text", F.element_at(healthy_arr, (F.rand(80) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("subscriber_id", "snapshot_date", "churn_risk_score", "churn_reason", "open_ticket_count", "agent_note_text")
)
risk_df = affected_risk.unionByName(moderate_risk).unionByName(everyday_risk)
_save(risk_df, "raw_risk_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8. Retention offers — 18 months of offers with outcomes (model training)
# MAGIC bill_credit on service-reason retains the most CLV per dollar; plan discount on price;
# MAGIC device on device. This ranks the hero (service) as bill_credit.

# COMMAND ----------

print("\n[8/8] Generating retention offers...")

sub_pop_arr = F.array(*[F.lit(f"SUB-{i + 1:07d}") for i in range(8000)])
offer_type_arr = F.array(F.lit("bill_credit"), F.lit("plan_upgrade_discount"), F.lit("device_upgrade"))
reason_arr2 = F.array(F.lit("service"), F.lit("price"), F.lit("device"))
retention_df = (
    spark.range(0, 40_000)
    .withColumn("retention_id", F.concat(F.lit("RET-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("subscriber_id", F.element_at(sub_pop_arr, (F.rand(81) * 8000 + 1).cast("int")))
    .withColumn("offer_type", F.element_at(offer_type_arr, (F.rand(82) * 3 + 1).cast("int")))
    .withColumn("churn_reason", F.element_at(reason_arr2, (F.rand(83) * 3 + 1).cast("int")))
    .withColumn("monthly_arpu_usd", F.round(45 + F.rand(84) * 80, 2))
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(85) * HIST_SPAN_DAYS).cast("int")))
    .withColumn(
        "offer_cost_usd",
        F.when(F.col("offer_type") == "bill_credit", F.lit(50.0))
        .when(F.col("offer_type") == "plan_upgrade_discount", F.round(F.col("monthly_arpu_usd") * 0.2 * 12, 2))
        .otherwise(F.lit(300.0)),
    )
    # retain probability HIGH when the offer matches the reason.
    .withColumn(
        "_match",
        (F.col("offer_type") == "bill_credit") & (F.col("churn_reason") == "service")
        | (F.col("offer_type") == "plan_upgrade_discount") & (F.col("churn_reason") == "price")
        | (F.col("offer_type") == "device_upgrade") & (F.col("churn_reason") == "device"),
    )
    .withColumn("_p_retain", F.when(F.col("_match"), 0.65 + F.rand(86) * 0.1).otherwise(0.25 + F.rand(87) * 0.1))
    .withColumn("retained", F.rand(88) < F.col("_p_retain"))
    .withColumn("retained_clv_usd", F.when(F.col("retained"), F.round(F.col("monthly_arpu_usd") * 24 * F.col("_p_retain"), 2)).otherwise(F.lit(0.0)))
    .select("retention_id", "subscriber_id", "offer_type", "churn_reason", "monthly_arpu_usd", "initiated_date", "offer_cost_usd", "retained", "retained_clv_usd")
)
_save(retention_df, "raw_retention_offers")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Eight raw datasets written. Next: run the SDP pipeline (`transformation/*.sql`) to build silver
# MAGIC + gold, then the metric view, the churn model (`transformation/churn_train_score.py`), the
# MAGIC dashboard, and the Genie space. Validate against `01-lakeflow.md` Section C.

# COMMAND ----------

print("\n✅ Streamline raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_SUB} on {HERO_NODE} (service reason → bill_credit)")
print(f"   Affected subscribers: {len(AFFECTED_SUBS)}  moderate: {len(MODERATE_SUBS)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_subscriber": HERO_SUB, "hero_node": HERO_NODE,
        "affected_subscribers": len(AFFECTED_SUBS), "moderate_subscribers": len(MODERATE_SUBS),
    }))
