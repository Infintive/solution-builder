# Databricks notebook source
# MAGIC %md
# MAGIC # Cedar Health — Readmission Risk & Intervention · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Cedar demo under `<catalog>.<schema>` using Spark
# MAGIC (Databricks Connect serverless when run locally, the runtime's `spark` when run as a
# MAGIC job). Follows the `databricks-synthetic-data-gen` skill: `spark.range` + `F.when` +
# MAGIC broadcast joins + Window + `F.element_at` against literal arrays — no driver loops,
# MAGIC no `.collect()` on big tables, no `.cache()`.
# MAGIC
# MAGIC **The load-bearing anomaly** (one driver, two visible symptoms): a discharge wave +
# MAGIC follow-up-capacity lag ~3 weeks ago left recently-discharged heart-failure (+ COPD/PNA/
# MAGIC AMI) patients with OPEN care gaps and rising 30-day readmission risk, while the rest of
# MAGIC the panel is stable. Same event, two symptoms: rising risk + open gaps. The hero at-risk
# MAGIC patient is `PT-0000214` (HF, discharged ~8 days ago, open follow-up gap); the intervention
# MAGIC the heuristic ranks first is a **7-day follow-up call**. See `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template** —
# MAGIC a different demo rewrites the domain, schema, and anomaly. This script writes the RAW
# MAGIC parquet datasets only; silver + gold are the SDP pipeline's job (`transformation/*.sql`).

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
NOW = STORY_PINNED_NOW if os.environ.get("CEDAR_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)        # 18-month encounter + intervention history
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
SURGE_ONSET = NOW - timedelta(days=21)            # discharge wave / follow-up lag begins ~3 weeks ago
RISK_RAMP = NOW - timedelta(days=18)              # affected patients' risk scores climb
SNAPSHOT_DATE = NOW - timedelta(days=1)           # the "current" patient-panel snapshot
RISK_WINDOW_START = NOW - timedelta(days=14)      # daily risk snapshots for the last ~14 days

# ── Deterministic story anchors (must match specs) ───────────────────────────
N_PATIENTS = 30_000
N_AFFECTED = 180                                  # recently-discharged high-risk patients (followup wins)
N_MODERATE = 110                                  # secondary cohort at MODERATE risk / other gap profiles
                                                  # (so the intervention mix isn't 100% followup_call)
READMIT_COST = 15000.0                            # avoidable-readmission cost (exposure factor)

HERO_PT = "PT-0000214"                            # HF, discharged ~8 days ago — the demo's spotlight
HERO_CONDITION = "HF"

# Affected conditions: (code, name, baseline_readmit_rate, severity_weight)
CONDITIONS = [
    ("HF", "Heart Failure (CHF)", 0.22, 1.0),
    ("COPD", "Chronic Obstructive Pulmonary Disease", 0.19, 0.85),
    ("PNA", "Pneumonia", 0.16, 0.7),
    ("AMI", "Acute Myocardial Infarction", 0.18, 0.9),
]
AFFECTED_CONDITIONS = [c[0] for c in CONDITIONS]
# Everyday (non-affected) conditions — low readmission risk.
OTHER_CONDITIONS = ["HTN", "DM2", "CKD", "OA", "GERD", "ASTHMA", "DEPR", "THY"]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('CEDAR_PIN_TIME') == '1' else 'rolling'})")
print(f"SURGE_ONSET: {SURGE_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_PT} ({HERO_CONDITION}) discharged ~8d ago, open follow-up gap")

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
# MAGIC ## 1. Patients — ~30K sampled patients, condition-tagged, geo-anchored
# MAGIC The affected cohort (recently discharged, affected conditions) is drawn deterministically
# MAGIC with the hero pinned. `clinical_summary` is the de-identified searchable blurb Lakebase
# MAGIC Search indexes.

# COMMAND ----------

print("\n[1/7] Generating patients...")

_METROS = [
    ("Boston", "MA", 42.36, -71.06), ("Providence", "RI", 41.82, -71.41),
    ("Worcester", "MA", 42.26, -71.80), ("Hartford", "CT", 41.76, -72.69),
    ("Portland", "ME", 43.66, -70.26), ("Manchester", "NH", 42.99, -71.46),
    ("Springfield", "MA", 42.10, -72.59), ("New Haven", "CT", 41.31, -72.93),
]
_AGE_BANDS = ["18-39", "40-54", "55-64", "65-74", "75+"]
_AGE_P = [0.12, 0.18, 0.2, 0.28, 0.22]
_PAYERS = ["Medicare", "Medicaid", "Commercial"]
_PAYER_P = [0.52, 0.18, 0.30]

metro_arr = F.array(*[F.lit(m[0]) for m in _METROS])
state_arr = F.array(*[F.lit(m[1]) for m in _METROS])
lat_arr = F.array(*[F.lit(float(m[2])) for m in _METROS])
lng_arr = F.array(*[F.lit(float(m[3])) for m in _METROS])
age_arr = F.array(*[F.lit(a) for a in _AGE_BANDS])
payer_arr = F.array(*[F.lit(p) for p in _PAYERS])
aff_cond_arr = F.array(*[F.lit(c) for c in AFFECTED_CONDITIONS])
other_cond_arr = F.array(*[F.lit(c) for c in OTHER_CONDITIONS])

# Affected cohort = deterministic indices; hero forced in (index 213 → PT-0000214).
AFFECTED_IDX = [213] + [i for i in range(300, 300 + (N_AFFECTED - 1) * 41, 41)][: N_AFFECTED - 1]
affected_idx_arr = F.array(*[F.lit(int(i)) for i in AFFECTED_IDX])
# Moderate cohort — disjoint indices, other gap profiles.
MODERATE_IDX = [i for i in range(15000, 15000 + N_MODERATE * 61, 61)][:N_MODERATE]
moderate_idx_arr = F.array(*[F.lit(int(i)) for i in MODERATE_IDX])

patients_df = (
    spark.range(0, N_PATIENTS)
    .withColumn("patient_id", F.concat(F.lit("PT-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("_mi", (F.rand(1) * len(_METROS)).cast("int"))
    .withColumn("is_affected", F.array_contains(affected_idx_arr, F.col("id").cast("int")))
    .withColumn("is_moderate", F.array_contains(moderate_idx_arr, F.col("id").cast("int")))
    # Affected + moderate get an affected condition (hero = HF); everyone else sampled
    # mostly from the everyday conditions with some affected sprinkled in.
    .withColumn(
        "primary_condition",
        F.when(F.col("patient_id") == HERO_PT, F.lit("HF"))
        .when(F.col("is_affected") | F.col("is_moderate"), F.element_at(aff_cond_arr, (F.rand(2) * len(AFFECTED_CONDITIONS) + 1).cast("int")))
        .when(F.rand(3) < 0.18, F.element_at(aff_cond_arr, (F.rand(4) * len(AFFECTED_CONDITIONS) + 1).cast("int")))
        .otherwise(F.element_at(other_cond_arr, (F.rand(5) * len(OTHER_CONDITIONS) + 1).cast("int"))),
    )
    .withColumn(
        "age_band",
        F.when(F.col("is_affected") | F.col("is_moderate"), F.element_at(F.array(F.lit("65-74"), F.lit("75+"), F.lit("55-64")), (F.rand(6) * 3 + 1).cast("int")))
        .otherwise(F.element_at(age_arr, (F.rand(7) * len(_AGE_BANDS) + 1).cast("int"))),
    )
    .withColumn("home_metro", F.element_at(metro_arr, F.col("_mi") + 1))
    .withColumn("state", F.element_at(state_arr, F.col("_mi") + 1))
    .withColumn("patient_lat", F.round(F.element_at(lat_arr, F.col("_mi") + 1) + (F.rand(8) - 0.5) * 0.1, 2))
    .withColumn("patient_lng", F.round(F.element_at(lng_arr, F.col("_mi") + 1) + (F.rand(9) - 0.5) * 0.1, 2))
    .withColumn("payer", F.element_at(payer_arr, (F.rand(10) * len(_PAYERS) + 1).cast("int")))
    .withColumn("home_clinic_id", F.concat(F.lit("CL-"), F.lpad(((F.rand(11) * 90 + 1).cast("int")).cast("string"), 4, "0")))
    .withColumn("enroll_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), (F.rand(12) * 3000 + 200).cast("int")))
    .withColumn("patient_display_name", F.concat(F.lit("Patient "), F.substring(F.col("patient_id"), 4, 7)))
    # De-identified searchable blurb — condition + recent course + gaps. This is what
    # Lakebase Search indexes and the intervention grounds on (never raw PHI).
    .withColumn(
        "clinical_summary",
        F.concat_ws(
            " ",
            F.col("primary_condition"), F.lit("patient, age band"), F.col("age_band"), F.lit(","),
            F.col("payer"), F.lit("."),
            F.when(F.col("is_affected"), F.lit("Recently discharged, no completed 7-day follow-up, medication-adherence concern, rising readmission risk."))
            .when(F.col("is_moderate"), F.lit("Recently discharged, some open care gaps, moderate readmission risk, monitor."))
            .otherwise(F.lit("Stable, follow-up completed, no active care gaps.")),
        ),
    )
    .withColumn("is_active", F.lit(True))
    .select(
        "patient_id", "patient_display_name", "primary_condition", "age_band", "home_clinic_id",
        "home_metro", "state", "patient_lat", "patient_lng", "payer", "enroll_date",
        "clinical_summary", "is_active",
    )
)
_save(patients_df, "raw_patients")

AFFECTED_PTS = [f"PT-{i + 1:07d}" for i in AFFECTED_IDX]
MODERATE_PTS = [f"PT-{i + 1:07d}" for i in MODERATE_IDX]
ATRISK_PTS = AFFECTED_PTS + MODERATE_PTS

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Providers — home-health + PCP + specialty directory (referral targets)

# COMMAND ----------

print("\n[2/7] Generating providers...")

_PROGRAMS = [
    ("home_health", "Home Health", "In-home nursing visits, remote monitoring, medication management for recently-discharged high-risk patients. For frail or high-severity patients needing in-home support."),
    ("pcp", "Primary Care", "Primary care follow-up and chronic-disease management. For post-discharge follow-up visits."),
    ("cardiology", "Cardiology", "Specialty cardiology care for heart-failure and post-MI patients. For HF and AMI patients needing specialist oversight."),
    ("pulmonology", "Pulmonology", "Specialty pulmonary care for COPD and pneumonia patients. For respiratory-condition patients."),
]
prog_type_arr = F.array(*[F.lit(p[0]) for p in _PROGRAMS])
prog_name_arr = F.array(*[F.lit(p[1]) for p in _PROGRAMS])
prog_desc_arr = F.array(*[F.lit(p[2]) for p in _PROGRAMS])

providers_df = (
    spark.range(0, 200)
    .withColumn("provider_id", F.concat(F.lit("PROV-"), F.lpad((F.col("id") + 1).cast("string"), 4, "0")))
    .withColumn("_pi", (F.rand(21) * len(_PROGRAMS)).cast("int"))
    .withColumn("program_type", F.element_at(prog_type_arr, F.col("_pi") + 1))
    .withColumn("specialty", F.element_at(prog_name_arr, F.col("_pi") + 1))
    .withColumn("provider_name", F.concat(F.element_at(prog_name_arr, F.col("_pi") + 1), F.lit(" Group "), (F.col("id") + 1).cast("string")))
    .withColumn("description", F.element_at(prog_desc_arr, F.col("_pi") + 1))
    .withColumn("accepting_referrals", F.rand(22) < 0.8)
    .select("provider_id", "provider_name", "specialty", "program_type", "description", "accepting_referrals")
)
_save(providers_df, "raw_providers")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Encounters — 18 months; the affected cohort's recent discharges live here

# COMMAND ----------

print("\n[3/7] Generating encounters...")

all_cond_arr = F.array(*[F.lit(c) for c in AFFECTED_CONDITIONS + OTHER_CONDITIONS])
affected_pt_arr = F.array(*[F.lit(p) for p in AFFECTED_PTS])
moderate_pt_arr = F.array(*[F.lit(p) for p in MODERATE_PTS])
atrisk_pt_arr = F.array(*[F.lit(p) for p in ATRISK_PTS])
pt_cond = patients_df.select("patient_id", "primary_condition")

# Recent discharge for the at-risk cohort: hero ~8d ago, others 8-21d ago.
atrisk_discharge = (
    spark.createDataFrame([(p,) for p in ATRISK_PTS], "patient_id string")
    .join(F.broadcast(pt_cond), "patient_id")
    .withColumn("encounter_type", F.lit("inpatient"))
    .withColumn(
        "discharge_date",
        F.when(F.col("patient_id") == HERO_PT, F.lit((SNAPSHOT_DATE - timedelta(days=7)).date().isoformat()).cast("date"))
        .otherwise(F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (7 + F.rand(31) * 14).cast("int"))),
    )
    .withColumn("length_of_stay_days", (2 + F.rand(32) * 6).cast("int"))
    .withColumn("admit_date", F.date_sub(F.col("discharge_date"), F.col("length_of_stay_days")))
    .withColumn("is_readmission", F.lit(False))
    .withColumn("attending_provider_id", F.concat(F.lit("PROV-"), F.lpad(((F.rand(33) * 200 + 1).cast("int")).cast("string"), 4, "0")))
    .select("patient_id", "encounter_type", "admit_date", "discharge_date", "primary_condition", "length_of_stay_days", "is_readmission", "attending_provider_id")
)

# Baseline encounters: sampled broad grid over 18 months (mix of inpatient/ed/clinic).
# Draw from patients OUTSIDE the at-risk cohorts so a random recent baseline discharge
# never overwrites an at-risk patient's pinned recent discharge (which sets days_since_discharge).
N_BASELINE_ENC = 175_000
_baseline_pt_pool = [f"PT-{i + 1:07d}" for i in range(6000) if i not in set(AFFECTED_IDX) | set(MODERATE_IDX)]
pt_pop_arr = F.array(*[F.lit(p) for p in _baseline_pt_pool])
_n_baseline_pt = len(_baseline_pt_pool)
baseline_enc = (
    spark.range(0, N_BASELINE_ENC)
    .withColumn("patient_id", F.element_at(pt_pop_arr, (F.rand(34) * _n_baseline_pt + 1).cast("int")))
    .withColumn("_et", F.rand(35))
    .withColumn("encounter_type", F.when(F.col("_et") < 0.3, F.lit("inpatient")).when(F.col("_et") < 0.55, F.lit("ed")).otherwise(F.lit("clinic")))
    .withColumn("discharge_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(36) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("length_of_stay_days", F.when(F.col("encounter_type") == "inpatient", (1 + F.rand(37) * 7).cast("int")).otherwise(F.lit(0)))
    .withColumn("admit_date", F.date_sub(F.col("discharge_date"), F.col("length_of_stay_days")))
    .withColumn("primary_condition", F.element_at(all_cond_arr, (F.rand(38) * (len(AFFECTED_CONDITIONS) + len(OTHER_CONDITIONS)) + 1).cast("int")))
    .withColumn("is_readmission", F.rand(39) < 0.12)
    .withColumn("attending_provider_id", F.concat(F.lit("PROV-"), F.lpad(((F.rand(40) * 200 + 1).cast("int")).cast("string"), 4, "0")))
    .select("patient_id", "encounter_type", "admit_date", "discharge_date", "primary_condition", "length_of_stay_days", "is_readmission", "attending_provider_id")
)

encounters_df = (
    atrisk_discharge.unionByName(baseline_enc)
    .withColumn("encounter_id", F.concat(F.lit("ENC-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("encounter_id", "patient_id", "encounter_type", "admit_date", "discharge_date", "primary_condition", "length_of_stay_days", "is_readmission", "attending_provider_id")
)
_save(encounters_df, "raw_encounters")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Care gaps — open on the affected cohort (followup + med recon), closed elsewhere

# COMMAND ----------

print("\n[4/7] Generating care gaps...")

# Affected cohort: OPEN follow-up gap (all), + open med_reconciliation on many. Moderate:
# a spread of open gaps (pcp/med_recon) but NOT always followup — so their best intervention
# differs. Everyday: closed gaps.
_GAP_COLS = ["patient_id", "gap_type", "opened_date", "closed_date", "status"]
affected_gaps = (
    spark.createDataFrame([(p,) for p in AFFECTED_PTS], "patient_id string")
    .withColumn("gap_type", F.lit("followup_7day"))
    .withColumn("opened_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (5 + F.rand(41) * 10).cast("int")))
    .withColumn("closed_date", F.lit(None).cast("date"))
    .withColumn("status", F.lit("open"))
    .select(*_GAP_COLS)
)
affected_medrecon = (
    spark.createDataFrame([(p,) for p in AFFECTED_PTS], "patient_id string")
    .filter(F.rand(42) < 0.6)  # ~60% also have an open med-recon gap
    .withColumn("gap_type", F.lit("med_reconciliation"))
    .withColumn("opened_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (5 + F.rand(43) * 10).cast("int")))
    .withColumn("closed_date", F.lit(None).cast("date"))
    .withColumn("status", F.lit("open"))
    .select(*_GAP_COLS)
)
# Moderate: open med_reconciliation or pcp_visit gaps (NOT followup) → med_recon/home_health win.
_mod_gap_arr = F.array(F.lit("med_reconciliation"), F.lit("pcp_visit"), F.lit("home_health"))
moderate_gaps = (
    spark.createDataFrame([(p,) for p in MODERATE_PTS], "patient_id string")
    .withColumn("gap_type", F.element_at(_mod_gap_arr, (F.rand(44) * 3 + 1).cast("int")))
    .withColumn("opened_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (5 + F.rand(45) * 12).cast("int")))
    .withColumn("closed_date", F.lit(None).cast("date"))
    .withColumn("status", F.lit("open"))
    .select(*_GAP_COLS)
)
# Everyday: sampled closed gaps (history) so the panel isn't empty.
everyday_gaps = (
    spark.range(0, 60_000)
    .withColumn("patient_id", F.element_at(pt_pop_arr, (F.rand(46) * _n_baseline_pt + 1).cast("int")))
    .withColumn("gap_type", F.element_at(F.array(F.lit("followup_7day"), F.lit("med_reconciliation"), F.lit("pcp_visit")), (F.rand(47) * 3 + 1).cast("int")))
    .withColumn("opened_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (30 + F.rand(48) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("closed_date", F.date_add(F.col("opened_date"), (3 + F.rand(49) * 20).cast("int")))
    .withColumn("status", F.lit("closed"))
    .select(*_GAP_COLS)
)

gaps_df = (
    affected_gaps.unionByName(affected_medrecon).unionByName(moderate_gaps).unionByName(everyday_gaps)
    .withColumn("gap_id", F.concat(F.lit("GAP-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("gap_id", "patient_id", "gap_type", "opened_date", "closed_date", "status")
)
_save(gaps_df, "raw_care_gaps")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Risk snapshots — daily readmission-risk for the last ~14 days + current

# COMMAND ----------

print("\n[5/7] Generating risk snapshots...")

_RISK_NOTES = [
    "no follow-up completed, 8 days post-discharge", "patient reports missed medication doses",
    "unable to reach for follow-up call", "symptoms worsening, edema noted", "no PCP appointment scheduled",
]
_HEALTHY_NOTES = ["follow-up completed, stable", "adherent, no concerns", None, None]
risk_notes_arr = F.array(*[F.lit(x) for x in _RISK_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

n_snap_days = (SNAPSHOT_DATE - RISK_WINDOW_START).days + 1

# Affected: daily, risk ramps to 0.75-0.9 now; hero pinned ~0.88.
affected_risk = (
    spark.createDataFrame([(p,) for p in AFFECTED_PTS], "patient_id string")
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    .withColumn("_progress", (F.lit(n_snap_days - 1) - F.col("d")) / F.lit(float(max(n_snap_days - 1, 1))))
    .withColumn(
        "readmission_risk_score",
        F.when(F.col("patient_id") == HERO_PT, F.round(F.least(F.lit(0.92), 0.25 + F.col("_progress") * 0.63), 3))
        .otherwise(F.round(F.least(F.lit(0.95), 0.15 + F.col("_progress") * (0.62 + F.rand(51) * 0.2)), 3)),
    )
    .withColumn("open_gap_count", (1 + F.col("_progress") * 2 + F.rand(52) * 1).cast("int"))
    .withColumn(
        "coordinator_note_text",
        F.when(F.rand(53) < 0.85, F.element_at(risk_notes_arr, (F.rand(54) * len(_RISK_NOTES) + 1).cast("int")))
        .when(F.rand(55) < 0.3, F.element_at(healthy_arr, (F.rand(56) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("patient_id", "snapshot_date", "readmission_risk_score", "open_gap_count", "coordinator_note_text")
)

# Moderate: current-snapshot only, risk 0.42-0.63 → 'watch'/'elevated'.
moderate_risk = (
    spark.createDataFrame([(p,) for p in MODERATE_PTS], "patient_id string")
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("readmission_risk_score", F.round(0.42 + F.rand(57) * 0.21, 3))
    .withColumn("open_gap_count", (1 + F.rand(58) * 2).cast("int"))
    .withColumn(
        "coordinator_note_text",
        F.when(F.rand(59) < 0.6, F.element_at(risk_notes_arr, (F.rand(60) * len(_RISK_NOTES) + 1).cast("int")))
        .otherwise(F.element_at(healthy_arr, (F.rand(66) * len(_HEALTHY_NOTES) + 1).cast("int"))),
    )
    .select("patient_id", "snapshot_date", "readmission_risk_score", "open_gap_count", "coordinator_note_text")
)

# Everyday: current-snapshot only, low stable risk, HEALTHY notes only.
everyday_risk = (
    spark.range(0, N_PATIENTS)
    .withColumn("patient_id", F.concat(F.lit("PT-"), F.lpad((F.col("id") + 1).cast("string"), 7, "0")))
    .withColumn("is_atrisk", F.array_contains(atrisk_pt_arr, F.col("patient_id")))
    .filter(~F.col("is_atrisk"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("readmission_risk_score", F.round(0.03 + F.rand(61) * 0.17, 3))
    .withColumn("open_gap_count", (F.rand(62) * 1).cast("int"))
    .withColumn("coordinator_note_text", F.element_at(healthy_arr, (F.rand(63) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("patient_id", "snapshot_date", "readmission_risk_score", "open_gap_count", "coordinator_note_text")
)

risk_df = affected_risk.unionByName(moderate_risk).unionByName(everyday_risk)
_save(risk_df, "raw_risk_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Interventions — 18 months of coordinator interventions with outcomes (training)
# MAGIC The model learns: followup_call on recently-discharged, follow-up-gapped patients gives
# MAGIC the best risk_reduction per coordinator hour; med_reconciliation wins on adherence cases;
# MAGIC home_health_referral on high-severity. This separation ranks the hero as a followup_call.

# COMMAND ----------

print("\n[6/7] Generating interventions...")

pt_pop2_arr = F.array(*[F.lit(f"PT-{i + 1:07d}") for i in range(8000)])
cond_arr2 = F.array(*[F.lit(c) for c in AFFECTED_CONDITIONS])

interventions_df = (
    spark.range(0, 40_000)
    .withColumn("intervention_id", F.concat(F.lit("INT-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("patient_id", F.element_at(pt_pop2_arr, (F.rand(71) * 8000 + 1).cast("int")))
    .withColumn("intervention_type", F.element_at(F.array(F.lit("followup_call"), F.lit("followup_call"), F.lit("med_reconciliation"), F.lit("home_health_referral")), (F.rand(72) * 4 + 1).cast("int")))
    .withColumn("condition", F.element_at(cond_arr2, (F.rand(73) * len(AFFECTED_CONDITIONS) + 1).cast("int")))
    .withColumn("risk_at_intervention", F.round(0.35 + F.rand(74) * 0.6, 3))
    .withColumn("days_since_discharge_at_intervention", (2 + F.rand(75) * 25).cast("int"))
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(76) * HIST_SPAN_DAYS).cast("int")))
    .withColumn(
        "coordinator_hours",
        F.when(F.col("intervention_type") == "followup_call", F.lit(0.5))
        .when(F.col("intervention_type") == "med_reconciliation", F.lit(1.5))
        .otherwise(F.lit(0.5)),
    )
    .withColumn(
        "cost_usd",
        F.when(F.col("intervention_type") == "followup_call", F.lit(60.0))
        .when(F.col("intervention_type") == "med_reconciliation", F.lit(180.0))
        .otherwise(F.lit(1200.0)),
    )
    # Learnable risk_reduction: followup best when recent discharge; med_recon steady; home_health scales with severity.
    .withColumn(
        "risk_reduction",
        F.when(
            F.col("intervention_type") == "followup_call",
            F.round(F.greatest(F.lit(0.05), 0.4 - F.col("days_since_discharge_at_intervention") * 0.012 + F.rand(77) * 0.06), 3),
        ).when(
            F.col("intervention_type") == "med_reconciliation",
            F.round(0.24 + F.rand(78) * 0.1, 3),
        ).otherwise(F.round(0.20 + F.rand(79) * 0.12, 3)),  # home_health
    )
    .withColumn("prevented_readmission", F.rand(80) < F.col("risk_reduction") * 2.2)
    .select(
        "intervention_id", "patient_id", "intervention_type", "condition", "risk_at_intervention",
        "days_since_discharge_at_intervention", "initiated_date", "coordinator_hours", "cost_usd",
        "prevented_readmission", "risk_reduction",
    )
)
_save(interventions_df, "raw_interventions")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Capacity — weekly coordination-team hours by clinic (the "can my team absorb it?" input)

# COMMAND ----------

print("\n[7/7] Generating capacity...")

n_weeks = 78
capacity_df = (
    spark.range(0, 90 * n_weeks)  # ~90 clinics × 78 weeks
    .withColumn("clinic_id", F.concat(F.lit("CL-"), F.lpad(((F.col("id") % 90 + 1)).cast("string"), 4, "0")))
    .withColumn("week_start", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), ((F.col("id") % n_weeks) * 7).cast("int")))
    .withColumn("available_coordinator_hours", F.round(30 + F.rand(81) * 20, 1))
    # Recent weeks: committed approaches available (the squeeze).
    .withColumn("_recent", (F.col("id") % n_weeks) < 4)
    .withColumn(
        "committed_hours",
        F.when(F.col("_recent"), F.round(F.col("available_coordinator_hours") * (0.85 + F.rand(82) * 0.2), 1))
        .otherwise(F.round(F.col("available_coordinator_hours") * (0.5 + F.rand(83) * 0.3), 1)),
    )
    .select("clinic_id", "week_start", "available_coordinator_hours", "committed_hours")
)
_save(capacity_df, "raw_capacity")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Seven raw datasets written to the Volume. Next: run the SDP pipeline
# MAGIC (`transformation/*.sql`) to build silver + gold, then the metric view, the intervention
# MAGIC model (`transformation/intervention_train_score.py`), the dashboard, and the Genie space.
# MAGIC Validate against `specifications/01-lakeflow.md` Section C before publishing.

# COMMAND ----------

print("\n✅ Cedar raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_PT} ({HERO_CONDITION}) discharged ~8d ago, open follow-up gap")
print(f"   Affected patients: {len(AFFECTED_PTS)}  moderate: {len(MODERATE_PTS)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_patient": HERO_PT, "hero_condition": HERO_CONDITION,
        "affected_patients": len(AFFECTED_PTS), "moderate_patients": len(MODERATE_PTS),
    }))
