# Profiling the user's real tables (grounded / "use existing data" demos)

When a demo is grounded on the user's own Unity Catalog tables (i.e.
`specifications/source-tables.md` exists), that file lists the real
`catalog.schema.table` names and their **schema only** (columns, types,
comments). It intentionally does **not** carry a data profile — you gather that
yourself, read-only, off a live SQL warehouse, so it's fresh at build time and
grounded in the tables as they are right now.

Do this in **Step 1** of `stages/03.1r-build-on-real.md`, right after confirming
each table is readable, and before you design dashboards / Genie / metric views.
It tells you which measures, time axes, dimensions, and joins the real data can
actually support.

**Everything here is READ-ONLY `SELECT`.** Never write to, copy, or alter the
user's tables (see the non-negotiable rule in `03.1r-build-on-real.md`).

## How to run the queries

Use the SQL-warehouse query tool the `databricks-dbsql` / analytics DAS
documents (**not** Databricks Connect serverless). Bound the work so a wide fact
table can't blow up cost or your context:

- Profile **at most ~40 columns** per table; if a table is wider, profile the
  columns your use case actually needs.
- Use `approx_count_distinct` / `approx_percentile` — approximate is fine.
- Keep it to a few queries per table (the wide aggregate below is one pass).

## What to gather, per table

1. **Schema + a few sample rows** — `SELECT * FROM cat.sch.tbl LIMIT 4`. The rows
   make the column meanings concrete; the result also confirms the column list.

2. **One wide aggregate pass** — distinct count, non-null count (→ null %), and
   min/max for every column, plus mean/stddev/quartiles for numerics, in a single
   query. Backtick every identifier. Sketch:

   ```sql
   SELECT
     COUNT(*)                                   AS n,
     approx_count_distinct(`col_a`)             AS d_col_a,
     count(`col_a`)                             AS nn_col_a,     -- non-null count
     CAST(min(`ts_col`)  AS STRING)             AS min_ts_col,   -- numeric/temporal
     CAST(max(`ts_col`)  AS STRING)             AS max_ts_col,
     CAST(avg(`amount`)  AS STRING)             AS avg_amount,   -- numeric only
     CAST(approx_percentile(`amount`, 0.5) AS STRING) AS med_amount
     -- …one block per column…
   FROM `cat`.`sch`.`tbl`
   ```

   `null % = 1 - nn/n`. `COUNT(*)` doubles as the row count — no separate query.

3. **Top values for LOW-cardinality categoricals** — only for string/bool/date
   columns whose distinct count from step 2 is small (say `≤ 50`), and only for a
   handful of columns per table. One small `GROUP BY` each:

   ```sql
   SELECT CAST(`region` AS STRING) AS v, COUNT(*) AS c
   FROM `cat`.`sch`.`tbl`
   WHERE `region` IS NOT NULL
   GROUP BY `region` ORDER BY c DESC LIMIT 5
   ```

   High-cardinality strings (ids, free text) aren't worth listing — skip them.

## Turn the profile into capability signals

From the columns + profile, classify what the data can support. Bucket a column
by its type:

- **Time columns** — `date` / `timestamp` types. These are your trend/forecast
  axes. **None present** → a time-trend story needs synthetic dates (so it's a
  weaker fit for that shape).
- **Measures** — numeric types (`int`/`bigint`/`float`/`double`/`decimal`/…)
  that are **not identifiers**. Demote id-ish names (a column whose name is or
  contains a token like `id`, `key`, `code`, `guid`, `uuid`, `number`/`num`/`no`
  — e.g. `customer_id`, `order_no`, `sku_code`) — you don't `SUM(customer_id)`.
  The rest are aggregatable measures.
- **Dimensions** — low-cardinality categoricals (`string`/`char`/`varchar`/
  `boolean`) with a small distinct count (`≤ 50`). These are your slice-by axes;
  keep their top values for the story.
- **Join keys** — an id-ish column name that appears in **≥ 2 different tables**
  is a cross-table join (the common hub shape: `orders.customer_id ↔
  customers.customer_id`). These are NOT obvious from a single table's schema —
  finding them is the main reason to profile the whole selected set together.

## Use it to choose (and fit-check) the use case

A use case that **trends a measure over a time column, sliced by a dimension**
(and, for multi-table, **joined on a key**) is a **great** fit — the real data
carries it end to end. One whose central measure or entity is **absent** here
leans on synthetic data, so it's a weaker (but still buildable) fit. Ground the
persona, the KPI, and any trend in these real columns and their profiled ranges —
the story is whatever the real data shows; don't fabricate a spike, lean on a
real one only if the profile reveals it.

If `specifications/data-discovery.md` exists, the use case is already **chosen**
(with its data-fit rationale and join keys) — profile to *build it well*, not to
re-pick a different one.
