# Databricks notebook source
# MAGIC %md
# MAGIC # Meridian Bank — Attrition & Next-Best-Action · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Meridian demo under `<catalog>.<schema>`
# MAGIC using Spark (Databricks Connect serverless when run locally, the runtime's
# MAGIC `spark` when run as a job). Follows the `databricks-synthetic-data-gen` skill:
# MAGIC `spark.range` + `F.when` + broadcast joins + Window + `F.element_at` against
# MAGIC literal arrays — no driver loops, no `.collect()` on big tables, no `.cache()`.
# MAGIC
# MAGIC **The load-bearing anomaly** (one cause, two visible symptoms): a competitor
# MAGIC savings-rate promotion ~3 weeks ago pushed the bank's most valuable, longest-tenured
# MAGIC customers holding maturing CDs / high-balance savings into elevated attrition risk,
# MAGIC with balance starting to flow out. Same event, two symptoms: rising risk score +
# MAGIC balance outflow. The hero at-risk account is `CUST-0000214` (12-year affluent, a
# MAGIC large CD maturing in ~9 days); the next-best-action the heuristic ranks first is a
# MAGIC rate-match **retention offer**. See `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template** —
# MAGIC a different demo rewrites the domain, schema, and anomaly. What carries over is the
# MAGIC *shape*: Spark-native idioms + one concentrated, explainable anomaly against a
# MAGIC realistic baseline. This script writes the RAW parquet datasets only; silver + gold
# MAGIC are the SDP pipeline's job (`transformation/*.sql`).

# COMMAND ----------

from __future__ import annotations

import os
from datetime import datetime, timedelta

import numpy as np
from pyspark.sql import DataFrame
from pyspark.sql import functions as F

# ── Config ─────────────────────────────────────────────────────────────────
# Catalog/schema are parametrized (widgets in-job, env locally) so a DAB can
# deploy this to any workspace.
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

# Volume holding the raw parquet datasets — the single source of raw truth.
# The SDP silver layer reads these via read_files() (no bronze, no raw Delta).
RAW_VOL = "raw_data"

# ── Story timeline ───────────────────────────────────────────────────────────
# NOW is the single source of truth. Default is ROLLING (datetime.now()) so the
# dashboard's right edge is always yesterday-real. Set MERIDIAN_PIN_TIME=1 to
# freeze for recorded demos / baked-in IDs.
STORY_PINNED_NOW = datetime(2026, 8, 1)
NOW = STORY_PINNED_NOW if os.environ.get("MERIDIAN_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)        # 18-month txn + campaign history
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
PROMO_ONSET = NOW - timedelta(days=21)            # competitor promo begins ~3 weeks ago
RISK_RAMP = NOW - timedelta(days=18)              # affected customers' risk scores climb
SNAPSHOT_DATE = NOW - timedelta(days=1)           # the "current" customer-360 snapshot
RISK_WINDOW_START = NOW - timedelta(days=14)      # daily risk snapshots for the last ~14 days

# ── Deterministic story anchors (must match specs) ───────────────────────────
N_CUSTOMERS = 40_000
N_AFFECTED = 220                                  # high-value customers pushed into HIGH risk (retention wins)
N_MODERATE = 120                                  # secondary cohort at MODERATE risk / smaller balances
                                                  # (so the NBA mix isn't 100% retention — cross-sell /
                                                  #  outreach win here; see 01-lakeflow The Event)
NIM = 0.025                                       # net interest margin (revenue-at-risk factor)

HERO_CUST = "CUST-0000214"                        # 12-year affluent — the demo's spotlight
HERO_CD = "PROD-DEP-2001"                         # the maturing 18-month CD the hero holds

# The competitor's targets — deposit products a rate-shopper moves for.
AFFECTED_PRODUCTS = ["PROD-DEP-2001", "PROD-DEP-2002", "PROD-DEP-2003"]
COMPETITOR_RATE = 0.0385                           # the promo rate customers are chasing

# Fixed-ID catalog products (affected deposits + cross-sell targets + a few everyday).
# (product_id, name, product_type, segment, rate_apy_or_None, min_balance, description)
CATALOG_PRODUCTS = [
    ("PROD-DEP-2001", "18-Month Certificate of Deposit", "CD", "deposit", 0.0325, 1000.0,
     "18-month term CD for savers locking in a fixed rate; penalty on early withdrawal. For rate-focused deposit customers."),
    ("PROD-DEP-2002", "High-Yield Savings", "Savings", "deposit", 0.0290, 0.0,
     "Liquid high-yield savings account, tiered rate on higher balances. For customers holding cash who want yield with access."),
    ("PROD-DEP-2003", "12-Month Certificate of Deposit", "CD", "deposit", 0.0300, 1000.0,
     "12-month term CD, shorter lock for rate-focused savers. Alternative to the 18-month CD."),
    ("PROD-INV-3001", "Wealth Advisory Account", "Advisory", "investment", None, 100000.0,
     "Managed wealth advisory account with a dedicated advisor. For affluent and private-tier customers with investable assets; a cross-sell for high-balance depositors."),
    ("PROD-CRD-4001", "Premier Rewards Credit Card", "Card", "lending", None, 0.0,
     "Premium rewards credit card, travel + cashback perks. For mass-affluent and above with strong relationship tenure; a cross-sell for depositors without a card."),
    ("PROD-LN-5001", "Home Equity Line of Credit", "HELOC", "lending", 0.0725, 0.0,
     "Revolving home-equity line of credit. For homeowners with equity; a lending cross-sell for established relationship customers."),
    ("PROD-DEP-2010", "Everyday Checking", "Checking", "deposit", 0.0010, 0.0,
     "No-frills everyday checking account with direct deposit and bill pay. The core relationship anchor product."),
    ("PROD-DEP-2011", "Money Market Account", "Savings", "deposit", 0.0250, 2500.0,
     "Money market account, tiered yield with limited monthly transactions. For savers wanting a blend of yield and access."),
    ("PROD-LN-5002", "30-Year Fixed Mortgage", "Mortgage", "lending", 0.0665, 0.0,
     "30-year fixed-rate home mortgage. For homebuyers; a long-tenure relationship product."),
    ("PROD-LN-5003", "Auto Loan", "Auto", "lending", 0.0620, 0.0,
     "Fixed-rate auto loan for new and used vehicles. Broad-eligibility lending product."),
    ("PROD-INV-3002", "Self-Directed Brokerage", "Brokerage", "investment", None, 0.0,
     "Self-directed online brokerage account. For customers who want to invest without an advisor; a cross-sell for affluent depositors."),
]
CROSS_SELL_TARGETS = ["PROD-INV-3001", "PROD-CRD-4001", "PROD-LN-5001"]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('MERIDIAN_PIN_TIME') == '1' else 'rolling'})")
print(f"PROMO_ONSET: {PROMO_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_CUST} at risk on {HERO_CD}; competitor rate {COMPETITOR_RATE:.2%}")

# Reuse the runtime's spark when run as a job/notebook; else build a
# databricks-connect serverless session for local runs.
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
    """Volume subdir for a raw dataset: strip the `raw_` prefix."""
    return f"{RAW_VOL_ROOT}/{table.removeprefix('raw_')}"


def _save(df: DataFrame, table: str) -> None:
    """Write a raw dataset as parquet FILES into the UC Volume."""
    path = _raw_path(table)
    df.write.mode("overwrite").parquet(path)
    n = spark.read.parquet(path).count()
    print(f"  ✓ {table:26s} rows={n:>10,}  → {path}")


# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Customers — ~40K sampled customers, tiered, geo-anchored
# MAGIC `tier` (mass/mass_affluent/affluent/private) is the value band. The affected
# MAGIC high-value cohort is drawn from affluent/private tiers, with the hero customer
# MAGIC pinned. `profile_summary` is the non-PII searchable blurb Lakebase Search indexes.

# COMMAND ----------

print("\n[1/6] Generating customers...")

# Metro anchors: (metro, state, lat, lng). The book is national; the affected cohort
# spreads across metros (attrition is book-wide) but concentrates in high-value tiers.
_METROS = [
    ("New York", "NY", 40.71, -74.01), ("Boston", "MA", 42.36, -71.06),
    ("Chicago", "IL", 41.88, -87.63), ("San Francisco", "CA", 37.77, -122.42),
    ("Dallas", "TX", 32.78, -96.80), ("Atlanta", "GA", 33.75, -84.39),
    ("Denver", "CO", 39.74, -104.99), ("Seattle", "WA", 47.61, -122.33),
    ("Miami", "FL", 25.76, -80.19), ("Philadelphia", "PA", 39.95, -75.16),
    ("Charlotte", "NC", 35.23, -80.84), ("Minneapolis", "MN", 44.98, -93.27),
]
_TIERS = ["mass", "mass_affluent", "affluent", "private"]
_TIER_P = [0.55, 0.28, 0.14, 0.03]
_INCOME_BANDS = ["<50k", "50-100k", "100-200k", "200-500k", "500k+"]

metro_arr = F.array(*[F.lit(m[0]) for m in _METROS])
state_arr = F.array(*[F.lit(m[1]) for m in _METROS])
lat_arr = F.array(*[F.lit(float(m[2])) for m in _METROS])
lng_arr = F.array(*[F.lit(float(m[3])) for m in _METROS])
tier_arr = F.array(*[F.lit(t) for t in _TIERS])
income_arr = F.array(*[F.lit(b) for b in _INCOME_BANDS])

# The affected cohort = a deterministic set of customer indices in the high-value
# tiers. We force the hero (index 213 → CUST-0000214) in, then pick a spread of
# high indices so they're identifiable and reproducible.
AFFECTED_IDX = [213] + [i for i in range(400, 400 + (N_AFFECTED - 1) * 37, 37)][: N_AFFECTED - 1]
affected_idx_arr = F.array(*[F.lit(int(i)) for i in AFFECTED_IDX])
# The MODERATE cohort — a separate deterministic set (disjoint from AFFECTED_IDX):
# moderate risk + smaller affected-deposit balances, so cross_sell / rm_outreach
# win the NBA net-value ranking for these (keeps the recommended-action mix plausible).
MODERATE_IDX = [i for i in range(20000, 20000 + N_MODERATE * 53, 53)][:N_MODERATE]
moderate_idx_arr = F.array(*[F.lit(int(i)) for i in MODERATE_IDX])

customers_df = (
    spark.range(0, N_CUSTOMERS)
    .withColumn("customer_id", F.concat(F.lit("CUST-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("_mi", (F.rand(1) * len(_METROS)).cast("int"))
    .withColumn("is_affected", F.array_contains(affected_idx_arr, F.col("id").cast("int")))
    .withColumn("is_moderate", F.array_contains(moderate_idx_arr, F.col("id").cast("int")))
    # Affected customers are forced into affluent/private; moderate into mass_affluent;
    # everyone else sampled.
    .withColumn("_tier_pick", (F.rand(2) * 4).cast("int"))
    .withColumn(
        "tier",
        F.when(F.col("customer_id") == HERO_CUST, F.lit("affluent"))
        .when(F.col("is_affected") & (F.rand(3) < 0.7), F.lit("affluent"))
        .when(F.col("is_affected"), F.lit("private"))
        .when(F.col("is_moderate"), F.lit("mass_affluent"))
        .when(F.col("_tier_pick") == 3, F.lit("private"))
        .when(F.col("_tier_pick") == 2, F.lit("affluent"))
        .when(F.col("_tier_pick") == 1, F.lit("mass_affluent"))
        .otherwise(F.lit("mass")),
    )
    .withColumn(
        "tenure_years",
        F.when(F.col("customer_id") == HERO_CUST, F.lit(12))
        .when(F.col("is_affected"), (8 + F.rand(4) * 12).cast("int"))
        .when(F.col("is_moderate"), (3 + F.rand(41) * 8).cast("int"))
        .otherwise((1 + F.rand(5) * 15).cast("int")),
    )
    .withColumn("home_metro", F.element_at(metro_arr, F.col("_mi") + 1))
    .withColumn("state", F.element_at(state_arr, F.col("_mi") + 1))
    .withColumn("customer_lat", F.round(F.element_at(lat_arr, F.col("_mi") + 1) + (F.rand(6) - 0.5) * 0.1, 2))
    .withColumn("customer_lng", F.round(F.element_at(lng_arr, F.col("_mi") + 1) + (F.rand(7) - 0.5) * 0.1, 2))
    .withColumn("annual_income_band", F.element_at(income_arr, (F.rand(8) * len(_INCOME_BANDS) + 1).cast("int")))
    .withColumn("home_branch_id", F.concat(F.lit("BR-"), F.lpad(((F.rand(9) * 180 + 1).cast("int")).cast("string"), 4, "0")))
    .withColumn("join_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), (F.col("tenure_years") * 365 + (F.rand(10) * 200).cast("int"))))
    .withColumn("customer_display_name", F.concat(F.lit("Customer "), F.substring(F.col("customer_id"), 6, 7)))
    # Non-PII searchable blurb — tenure + tier + a relationship phrase. This is what
    # Lakebase Search indexes and the NBA grounds on (never raw PII).
    .withColumn(
        "profile_summary",
        F.concat_ws(
            " ",
            F.col("tier"), F.lit("tier relationship,"),
            F.col("tenure_years").cast("string"), F.lit("year tenure,"),
            F.lit("home metro"), F.col("home_metro"), F.lit("."),
            F.when(F.col("is_affected") | F.col("is_moderate"), F.lit("Holds a maturing certificate of deposit; rate-sensitive, comparing competitor savings rates."))
            .otherwise(F.lit("Stable deposit relationship, routine servicing, no active concerns.")),
        ),
    )
    .withColumn("is_active", F.lit(True))
    .select(
        "customer_id", "customer_display_name", "tier", "tenure_years", "home_branch_id",
        "home_metro", "state", "customer_lat", "customer_lng", "annual_income_band",
        "join_date", "profile_summary", "is_active",
    )
)
_save(customers_df, "raw_customers")

# Driver-side id lists for reuse (small).
AFFECTED_CUSTS = [f"CUST-{i + 1:07d}" for i in AFFECTED_IDX]
MODERATE_CUSTS = [f"CUST-{i + 1:07d}" for i in MODERATE_IDX]
# The full at-risk set (both cohorts hold a maturing affected deposit + get risk snapshots).
ATRISK_CUSTS = AFFECTED_CUSTS + MODERATE_CUSTS

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Products — the fixed-ID catalog (affected deposits + cross-sell + everyday)

# COMMAND ----------

print("\n[2/6] Generating products...")

products_df = (
    spark.createDataFrame(
        [(p[0], p[1], p[2], p[3], p[4], p[5], p[6]) for p in CATALOG_PRODUCTS],
        "product_id string, product_name string, product_type string, segment string, "
        "rate_apy double, min_balance_usd double, description string",
    )
    .withColumn("is_active", F.lit(True))
)
_save(products_df, "raw_products")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Holdings — accounts per customer. The hero's large maturing CD lives here.
# MAGIC Affected high-value customers hold a maturing affected deposit with a big balance;
# MAGIC everyone holds checking + a spread. Deposit balances drive balance-at-risk.

# COMMAND ----------

print("\n[3/6] Generating holdings...")

affected_cust_arr = F.array(*[F.lit(c) for c in AFFECTED_CUSTS])
moderate_cust_arr = F.array(*[F.lit(c) for c in MODERATE_CUSTS])
atrisk_cust_arr = F.array(*[F.lit(c) for c in ATRISK_CUSTS])
_deposit_prods = [p[0] for p in CATALOG_PRODUCTS if p[3] == "deposit"]
_other_prods = [p[0] for p in CATALOG_PRODUCTS if p[3] != "deposit"]
dep_arr = F.array(*[F.lit(p) for p in _deposit_prods])
other_arr = F.array(*[F.lit(p) for p in _other_prods])
prod_rate = {p[0]: (p[4] if p[4] is not None else 0.0) for p in CATALOG_PRODUCTS}
rate_map = F.create_map(*[x for pid, r in prod_rate.items() for x in (F.lit(pid), F.lit(float(r)))])

# Everyone holds a checking anchor + 1-3 more products. We build holdings as a
# customer × slot grid (slot 0 = checking, slots 1-3 = sampled products), then
# override the affected customers' "affected deposit" holding to be large + maturing.
cust_base = (
    customers_df.select("customer_id", "tier")
    .withColumn("is_affected", F.array_contains(affected_cust_arr, F.col("customer_id")))
    .withColumn("is_moderate", F.array_contains(moderate_cust_arr, F.col("customer_id")))
)

# slot 0: everyday checking (everyone)
checking = (
    cust_base
    .withColumn("product_id", F.lit("PROD-DEP-2010"))
    .withColumn("balance_usd", F.round(500 + F.rand(11) * 8000, 2))
    .withColumn("maturity_date", F.lit(None).cast("date"))
)
# slots 1-2: sampled non-checking products (deposit or other)
def _sampled_slot(seed_a, seed_b, seed_c):
    return (
        cust_base
        .withColumn("_use_dep", F.rand(seed_a) < 0.6)
        .withColumn(
            "product_id",
            F.when(F.col("_use_dep"), F.element_at(dep_arr, (F.rand(seed_b) * len(_deposit_prods) + 1).cast("int")))
            .otherwise(F.element_at(other_arr, (F.rand(seed_b) * len(_other_prods) + 1).cast("int"))),
        )
        .withColumn(
            "balance_usd",
            F.when(F.col("product_id").isin(_deposit_prods), F.round(2000 + F.rand(seed_c) * 60000, 2))
            .otherwise(F.round(F.rand(seed_c) * 40000, 2)),
        )
        .withColumn("maturity_date", F.lit(None).cast("date"))
        .drop("_use_dep")
    )

slot1 = _sampled_slot(12, 13, 14)
slot2 = _sampled_slot(15, 16, 17)

# The affected-deposit holding: for the at-risk cohorts, a maturing affected-product
# holding. High-value AFFECTED customers get a LARGE balance ($200K–$1.2M, hero $650K);
# MODERATE customers get a SMALLER balance ($30K–$120K) so cross_sell / rm_outreach can
# out-net a retention offer for them (the retention offer's value scales with balance).
# Non-at-risk customers don't get this special holding.
_aff_prod_arr = F.array(*[F.lit(p) for p in AFFECTED_PRODUCTS])
affected_holding = (
    cust_base.filter(F.col("is_affected") | F.col("is_moderate"))
    .withColumn(
        "product_id",
        F.when(F.col("customer_id") == HERO_CUST, F.lit(HERO_CD))
        .otherwise(F.element_at(_aff_prod_arr, (F.rand(18) * len(AFFECTED_PRODUCTS) + 1).cast("int"))),
    )
    .withColumn(
        "balance_usd",
        F.when(F.col("customer_id") == HERO_CUST, F.lit(650000.0))
        .when(F.col("is_moderate"), F.round(30000 + F.rand(19) * 90000, 2))
        .otherwise(F.round(200000 + F.rand(19) * 1000000, 2)),
    )
    # Maturing soon: hero at NOW+9d; others spread 2–40 days out.
    .withColumn(
        "maturity_date",
        F.when(F.col("customer_id") == HERO_CUST, F.lit((NOW + timedelta(days=9)).date().isoformat()).cast("date"))
        .otherwise(F.date_add(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (2 + F.rand(20) * 38).cast("int"))),
    )
)

holdings_all = (
    checking.unionByName(slot1).unionByName(slot2).unionByName(affected_holding)
    .withColumn("rate_apy", F.coalesce(F.element_at(rate_map, F.col("product_id")), F.lit(0.0)))
    .withColumn("open_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), (F.rand(21) * 3000 + 200).cast("int")))
    .withColumn(
        "status",
        F.when(F.col("maturity_date").isNotNull() & (F.col("maturity_date") < F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date")), F.lit("matured"))
        .otherwise(F.lit("active")),
    )
    .withColumn("account_id", F.concat(F.lit("ACCT-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("account_id", "customer_id", "product_id", "balance_usd", "open_date", "maturity_date", "rate_apy", "status")
)
_save(holdings_all, "raw_holdings")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Transactions — 18 months of account activity + the balance-outflow signal
# MAGIC Baseline activity for a broad set of customers, PLUS the balance outflow on the
# MAGIC affected customers ramping from RISK_RAMP (transfer_out / withdrawal) — the money
# MAGIC starting to move. Pure Spark: a dense affected grid + a sampled baseline grid.

# COMMAND ----------

print("\n[4/6] Generating transactions...")

# --- Affected outflow: affected customers × last 60 days, transfer_out/withdrawal
# ramping after RISK_RAMP. This is the "money starting to walk" signal.
ramp_off = (SNAPSHOT_DATE - RISK_RAMP).days
affected_txn = (
    spark.createDataFrame([(c,) for c in AFFECTED_CUSTS], "customer_id string")
    .crossJoin(spark.range(0, 60).withColumnRenamed("id", "day_offset"))
    .withColumn("txn_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("day_offset").cast("int")))
    .withColumn("_ramped", F.col("day_offset") <= F.lit(ramp_off))
    # Outflow only after the ramp; sparse otherwise. Amounts scale with the big balances.
    .filter(F.col("_ramped") & (F.rand(31) < 0.5))
    .withColumn("txn_type", F.when(F.rand(32) < 0.6, F.lit("transfer_out")).otherwise(F.lit("withdrawal")))
    .withColumn("amount_usd", F.round(-(5000 + F.rand(33) * 80000), 2))
    .withColumn("channel", F.element_at(F.array(F.lit("online"), F.lit("mobile"), F.lit("branch")), (F.rand(34) * 3 + 1).cast("int")))
    .withColumn("account_id", F.lit("ACCT-OUTFLOW"))
    .select("customer_id", "account_id", "txn_date", "amount_usd", "txn_type", "channel")
)

# --- Baseline transactions: sampled broad grid (everyday). Sparse, 18 months.
N_BASELINE = 3_500_000
cust_all_arr = F.array(*[F.lit(f"CUST-{i + 1:07d}") for i in range(3000)])  # popular subset for cheap joins
_n_cust_subset = 3000
baseline_txn = (
    spark.range(0, N_BASELINE)
    .withColumn("customer_id", F.element_at(cust_all_arr, (F.rand(41) * _n_cust_subset + 1).cast("int")))
    .withColumn("txn_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(42) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("_r", F.rand(43))
    .withColumn(
        "txn_type",
        F.when(F.col("_r") < 0.45, F.lit("deposit")).when(F.col("_r") < 0.8, F.lit("withdrawal"))
        .when(F.col("_r") < 0.9, F.lit("fee")).otherwise(F.lit("interest")),
    )
    .withColumn(
        "amount_usd",
        F.when(F.col("txn_type") == "deposit", F.round(100 + F.rand(44) * 5000, 2))
        .when(F.col("txn_type") == "withdrawal", F.round(-(50 + F.rand(45) * 2000), 2))
        .when(F.col("txn_type") == "fee", F.round(-(5 + F.rand(46) * 35), 2))
        .otherwise(F.round(1 + F.rand(47) * 120, 2)),
    )
    .withColumn("channel", F.element_at(F.array(F.lit("online"), F.lit("mobile"), F.lit("branch"), F.lit("atm")), (F.rand(48) * 4 + 1).cast("int")))
    .withColumn("account_id", F.lit("ACCT-BASELINE"))
    .select("customer_id", "account_id", "txn_date", "amount_usd", "txn_type", "channel")
)

txn_df = (
    affected_txn.unionByName(baseline_txn)
    .withColumn("txn_id", F.concat(F.lit("TXN-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("txn_id", "customer_id", "account_id", "txn_date", "amount_usd", "txn_type", "channel")
)
_save(txn_df, "raw_transactions")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Risk snapshots — daily attrition-risk for the last ~14 days + current
# MAGIC The current snapshot is where the alarm lives: affected customers → risk 0.7–0.9;
# MAGIC everyday customers → 0.05–0.25. `servicing_note_text` (the `ai_classify` signal)
# MAGIC skews churn-toned on the affected cohort.

# COMMAND ----------

print("\n[5/6] Generating risk snapshots...")

_CHURN_NOTES = [
    "asked about competitor CD rates", "mentioned moving funds at maturity",
    "rate shopping, called twice this week", "large transfer out pending", "unhappy with renewal rate",
]
_HEALTHY_NOTES = ["routine service call", "satisfied, no concerns", None, None]
churn_arr = F.array(*[F.lit(x) for x in _CHURN_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

n_snap_days = (SNAPSHOT_DATE - RISK_WINDOW_START).days + 1

# Affected (high-value): daily snapshots, risk ramps from ~0.2 to 0.75-0.9 now; outflow
# grows. The hero is pinned solidly critical (~0.86) so rolling-time never drops it below
# the 0.75 'critical' threshold.
affected_risk = (
    spark.createDataFrame([(c,) for c in AFFECTED_CUSTS], "customer_id string")
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    # d=0 is current (highest risk); older d → lower. Ramp to 0.75-0.9 now.
    .withColumn("_progress", (F.lit(n_snap_days - 1) - F.col("d")) / F.lit(float(max(n_snap_days - 1, 1))))
    .withColumn(
        "attrition_risk_score",
        F.when(
            F.col("customer_id") == HERO_CUST,
            F.round(F.least(F.lit(0.9), 0.25 + F.col("_progress") * 0.61), 3),  # hero → ~0.86 now
        ).otherwise(F.round(F.least(F.lit(0.95), 0.2 + F.col("_progress") * (0.6 + F.rand(51) * 0.2)), 3)),
    )
    .withColumn("balance_outflow_30d_usd", F.round(F.col("_progress") * (20000 + F.rand(52) * 120000), 2))
    .withColumn(
        "servicing_note_text",
        F.when(F.rand(53) < 0.85, F.element_at(churn_arr, (F.rand(54) * len(_CHURN_NOTES) + 1).cast("int")))
        .when(F.rand(55) < 0.3, F.element_at(healthy_arr, (F.rand(56) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("customer_id", "snapshot_date", "attrition_risk_score", "balance_outflow_30d_usd", "servicing_note_text")
)

# Moderate cohort: current-snapshot only, MODERATE risk (0.42-0.63 → 'watch'/'elevated'),
# smaller balances. These are the customers where cross_sell / rm_outreach out-net a
# retention offer, so the recommended-action mix isn't 100% retention. Churn-toned notes.
moderate_risk = (
    spark.createDataFrame([(c,) for c in MODERATE_CUSTS], "customer_id string")
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("attrition_risk_score", F.round(0.42 + F.rand(57) * 0.21, 3))
    .withColumn("balance_outflow_30d_usd", F.round(2000 + F.rand(58) * 15000, 2))
    .withColumn(
        "servicing_note_text",
        F.when(F.rand(59) < 0.6, F.element_at(churn_arr, (F.rand(60) * len(_CHURN_NOTES) + 1).cast("int")))
        .otherwise(F.element_at(healthy_arr, (F.rand(66) * len(_HEALTHY_NOTES) + 1).cast("int"))),
    )
    .select("customer_id", "snapshot_date", "attrition_risk_score", "balance_outflow_30d_usd", "servicing_note_text")
)

# Everyday: current-snapshot only, low stable risk, HEALTHY notes only. The anomaly
# is confined to the at-risk cohorts — everyday customers must never read elevated
# (that would paint red noise on the scatter for customers the story isn't about).
everyday_risk = (
    spark.range(0, N_CUSTOMERS)
    .withColumn("customer_id", F.concat(F.lit("CUST-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_atrisk", F.array_contains(atrisk_cust_arr, F.col("customer_id")))
    .filter(~F.col("is_atrisk"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("attrition_risk_score", F.round(0.05 + F.rand(61) * 0.2, 3))
    .withColumn("balance_outflow_30d_usd", F.round(F.rand(62) * 2000, 2))
    .withColumn("servicing_note_text", F.element_at(healthy_arr, (F.rand(63) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("customer_id", "snapshot_date", "attrition_risk_score", "balance_outflow_30d_usd", "servicing_note_text")
)

risk_df = affected_risk.unionByName(moderate_risk).unionByName(everyday_risk)
_save(risk_df, "raw_risk_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Retention campaigns — 18 months of NBAs with outcomes (model training)
# MAGIC The NBA model learns from these: `retention_offer` on high-balance/high-risk
# MAGIC customers retains the most value per dollar; `cross_sell` wins on lower-risk
# MAGIC good-fit; `rm_outreach` on moderate-risk soft cases. This separation is what lets
# MAGIC the model rank the hero customer as a retention offer.

# COMMAND ----------

print("\n[6/6] Generating retention campaigns...")

cust_pop_arr = F.array(*[F.lit(f"CUST-{i + 1:07d}") for i in range(8000)])
aff_prod_arr2 = F.array(*[F.lit(p) for p in AFFECTED_PRODUCTS])
xsell_arr = F.array(*[F.lit(p) for p in CROSS_SELL_TARGETS])

campaigns_df = (
    spark.range(0, 35_000)
    .withColumn("campaign_id", F.concat(F.lit("CMP-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("customer_id", F.element_at(cust_pop_arr, (F.rand(71) * 8000 + 1).cast("int")))
    .withColumn("action_type", F.element_at(F.array(F.lit("retention_offer"), F.lit("retention_offer"), F.lit("cross_sell"), F.lit("rm_outreach")), (F.rand(72) * 4 + 1).cast("int")))
    .withColumn("product_id", F.element_at(aff_prod_arr2, (F.rand(73) * len(AFFECTED_PRODUCTS) + 1).cast("int")))
    .withColumn("offered_product_id", F.when(F.col("action_type") == "cross_sell", F.element_at(xsell_arr, (F.rand(74) * len(CROSS_SELL_TARGETS) + 1).cast("int"))).otherwise(F.lit(None).cast("string")))
    .withColumn("balance_at_risk_usd", F.round(20000 + F.rand(75) * 900000, 2))
    .withColumn("attrition_risk_at_action", F.round(0.3 + F.rand(76) * 0.65, 3))
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(77) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("days_to_resolve", F.when(F.col("action_type") == "retention_offer", (3 + F.rand(78) * 10).cast("int")).when(F.col("action_type") == "cross_sell", (5 + F.rand(79) * 20).cast("int")).otherwise((1 + F.rand(80) * 5).cast("int")))
    # --- Learnable outcomes (ranked by NET VALUE = retained_revenue − cost − margin_impact) ---
    # retention_offer: retains high value when balance-at-risk is large AND risk is high
    #                  (the hero case). P(retain) high for a rate-match on a rate-shopper.
    # cross_sell:      lands on lower-risk good-fit customers; P(retain) LOW on a high-risk
    #                  rate-shopper (they're leaving over rate, not product breadth).
    # rm_outreach:     cheapest; a soft save that works on moderate risk, weak on the
    #                  high-balance rate-shopper — clearly the worst on the hero-type account.
    .withColumn(
        "_p_retain",
        F.when(F.col("action_type") == "retention_offer", F.least(F.lit(0.9), 0.45 + F.col("attrition_risk_at_action") * 0.4))
        .when(F.col("action_type") == "cross_sell", F.greatest(F.lit(0.1), 0.6 - F.col("attrition_risk_at_action") * 0.5))
        .otherwise(F.greatest(F.lit(0.05), 0.4 - F.col("attrition_risk_at_action") * 0.35)),
    )
    .withColumn("retained", (F.rand(81) < F.col("_p_retain")))
    .withColumn(
        "retained_revenue_usd",
        F.when(F.col("retained"), F.round(F.col("balance_at_risk_usd") * F.lit(NIM) * 3 * F.col("_p_retain"), 2)).otherwise(F.lit(0.0)),
    )
    .withColumn(
        "cost_usd",
        F.when(F.col("action_type") == "retention_offer", F.round(F.col("balance_at_risk_usd") * 0.006, 2))  # ~1yr rate concession
        .when(F.col("action_type") == "cross_sell", F.lit(50.0))
        .otherwise(F.lit(40.0)),
    )
    .withColumn(
        "margin_impact_usd",
        # cross_sell to the wrong customer can erode margin slightly; keep others clean.
        F.when((F.col("action_type") == "cross_sell") & (~F.col("retained")), F.round(F.rand(82) * 200, 2)).otherwise(F.lit(0.0)),
    )
    .select(
        "campaign_id", "customer_id", "product_id", "action_type", "offered_product_id",
        "balance_at_risk_usd", "attrition_risk_at_action", "initiated_date", "days_to_resolve",
        "retained", "retained_revenue_usd", "margin_impact_usd", "cost_usd",
    )
)
_save(campaigns_df, "raw_retention_campaigns")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Six raw datasets written to the Volume. Next: run the SDP pipeline
# MAGIC (`transformation/*.sql`) to build silver + gold, then the metric view, the NBA
# MAGIC model (`transformation/nba_train_score.py`), the dashboard, and the Genie space.
# MAGIC Validate against `specifications/01-lakeflow.md` Section C before publishing.

# COMMAND ----------

print("\n✅ Meridian raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_CUST} at risk on {HERO_CD}  (competitor rate {COMPETITOR_RATE:.2%})")
print(f"   Affected high-value customers: {len(AFFECTED_CUSTS)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_customer": HERO_CUST, "hero_cd": HERO_CD,
        "affected_customers": len(AFFECTED_CUSTS),
    }))
