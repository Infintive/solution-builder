# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The bank**: Meridian Bank — a regional retail + commercial bank (~$35B assets, ~1.8M customers, ~180 branches), relationship-manager model. The demo samples ~40K customers so joins stay cheap (the "1.8M" is talking-track).

**The affected products** (deterministic — the ones the competitor's rate promotion targets; must exist with these exact values). These are the deposit products a rate-shopping customer moves for:

| product_id | product_name | product_type | rate_apy | segment |
|------------|--------------|--------------|----------|---------|
| PROD-DEP-2001 | 18-Month Certificate of Deposit | CD | 0.0325 | deposit |
| PROD-DEP-2002 | High-Yield Savings | Savings | 0.0290 | deposit |
| PROD-DEP-2003 | 12-Month Certificate of Deposit | CD | 0.0300 | deposit |

The **cross-sell / retention product catalog** also holds products a customer may NOT yet hold and could be offered: `PROD-INV-3001` (Wealth Advisory Account), `PROD-CRD-4001` (Premier Rewards Credit Card), `PROD-LN-5001` (Home Equity Line of Credit), plus a spread of everyday products. Each product carries a searchable **`description`** (features, eligibility, who it's for) — the text **Lakebase Search** (Milestone 2) indexes and the app's product/eligibility search + the **cross-sell** next-best-action query run over.

**Hero customer**: `CUST-0000214` — a 12-year relationship, `mass_affluent` → `affluent` tier, holds `PROD-DEP-2001` (an 18-month CD) **maturing in ~9 days** with a large balance, plus a checking + savings relationship. The demo's spotlight at-risk account. Deterministic. Its attrition-risk score is high (~0.86) and the recommended next-best-action the heuristic ranks first is a **retention offer** (rate-match on the maturing CD) — because the customer's balance-at-risk × attrition probability × retention-offer effectiveness beats cross-sell and outreach for this account.

**The anomaly (one cause, two visible symptoms)**: ~3 weeks ago a competitor launched a savings-rate promotion aimed at maturing CDs and high-balance savings. On the **affected deposit products**, among the bank's **high-value customers** (high balance, long tenure — the ones worth the most to lose):
- **Attrition side (the alarm)** — ~220 high-value customers with a maturing/at-risk deposit crossed into **elevated attrition risk** (`attrition_risk_score` climbing from a ~0.2 baseline to ~0.7–0.9) in the last ~3 weeks, with **balance outflow** showing in recent transactions (partial withdrawals / transfers out) → real money about to walk (shown RED).
- **Healthy side** — the rest of the sampled book (~40K customers) sits at a normal ~0.05–0.25 risk with stable balances (shown STEEL/blue).

This is the load-bearing shape: **the bank's most valuable customers, rising risk, concentrated in a recent 3-week window on the products a competitor is poaching** — legible on one chart (balance-at-risk × attrition-risk scatter, a red cluster in the high-value/high-risk quadrant). The recommended action ("match the rate to retain the CD") is literally supported by the data because the customer holds a large maturing CD and history says a rate-match retains customers like them.

**Attrition-signal notes** (verbatim RM/servicing-note phrases, used predominantly on the affected high-value at-risk customers — feed the note pool in Section A so `ai_classify` has a clear signal). Churn-signal tone: *"asked about competitor CD rates"*, *"mentioned moving funds at maturity"*, *"rate shopping, called twice this week"*, *"large transfer out pending"*, *"unhappy with renewal rate"*. Healthy tone (for everyday customers): *"routine service call"*, *"satisfied, no concerns"*. These must be exact substrings — Genie + the dashboard search for them.

**PII posture (the FSI-specific teaching point)**: the customer-360 carries names + contact only as a minimal display field; the story is about serving an RM screen + grounding an NBA **without broad PII exposure** — the app reads scoped fields, Lakebase Search grounds on `profile_summary`/product text (not raw PII), and the AI Gateway logs are attributable per line of business. Generate a `customer_display_name` + a non-PII `profile_summary` (tenure, tier, holdings, relationship notes) — the latter is what search + the assistant ground on.

**Time references**: `NOW = datetime.now()` by default (rolling — the dashboard's right edge is always yesterday-real; set `MERIDIAN_PIN_TIME=1` to freeze `NOW` for recorded videos / baked-in IDs). `HISTORY_START = NOW − 18 months` (transaction + retention-campaign history for the model). `PROMO_ONSET = NOW − 21 days` (~3 weeks back — the competitor promotion begins). `RISK_RAMP = NOW − 18 days` (affected customers' attrition scores climb). `SNAPSHOT_DATE = NOW − 1 day` (the "current" customer-360 snapshot the app + dashboard read). **Causal chain**: stable book before −3w → competitor promo at −3w → affected high-value customers' risk scores ramp −3w to −1w and balance outflow begins → everyone else stable → the CURRENT snapshot (yesterday) shows the at-risk cluster. Peak of the risk divergence sits in the past week-and-a-half, clearly to the left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen` (read `SKILLS/databricks-synthetic-data-gen/SKILL.md`). Use the pre-provisioned databricks-connect venv (Python 3.12 + faker + numpy + pandas + pyarrow) — system prompt has the path; do NOT create a new venv. Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window functions + `F.element_at` against literal arrays. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, named without the `raw_` prefix). This Volume is the raw landing zone; SDP silver reads it via `read_files()` — no bronze pass-through, no raw Delta tables:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_customers` | ~40,000 | Sampled customer master. `tier` (`mass/mass_affluent/affluent/private` — value bands), `tenure_years`, `home_branch_id`, `customer_lat`/`customer_lng` (metro anchor + jitter — drives the map), `annual_income_band`, `customer_display_name` (minimal PII), **`profile_summary`** (non-PII searchable blurb: tenure, tier, holdings, relationship notes — the text Lakebase Search indexes). `CUST-0000214` pinned as the affluent, 12-year hero. |
| `raw_products` | ~40 | Product catalog: deposits (CD/Savings/Checking), lending (mortgage/HELOC/card/auto), investments (advisory/brokerage). `product_type`, `rate_apy` (deposits), `segment`, plus a searchable **`description`** (features + who qualifies) — indexed by **Lakebase Search**; the **cross-sell** NBA queries it for "a product this customer qualifies for but doesn't hold". The 3 affected deposit products + the 3 cross-sell products sit at fixed IDs. |
| `raw_holdings` | ~140,000 | Customer↔product holdings (accounts). One row per (customer, product) held: `balance_usd`, `open_date`, `maturity_date` (deposits only, nullable), `rate_apy`, `status` (`active/matured/closed`). The hero's maturing CD lives here (`maturity_date ≈ NOW+9d`, large balance). High-value affected customers hold a maturing deposit with a big balance. |
| `raw_transactions` | ~3.5M | 18 months of account transactions. One row per (customer, account, txn_date) with `amount_usd` (signed — deposits +, withdrawals −), `txn_type` (`deposit/withdrawal/transfer_out/fee/interest`), `channel`. The **balance-outflow signal** lives here: affected customers show transfer_out / withdrawal activity ramping from `RISK_RAMP`. |
| `raw_risk_snapshots` | ~255K | Daily `attrition_risk_score` (0–1) for the affected customers across the last ~14 days + a current-snapshot (`SNAPSHOT_DATE`) sample of everyday customers. Affected → risk ramps to 0.7–0.9; everyday → 0.05–0.25. Carries `servicing_note_text` (the `ai_classify` signal). |
| `raw_retention_campaigns` | ~35K | 18-month history of retention/cross-sell actions taken on at-risk customers, each with an OUTCOME (`retained` bool, `retained_revenue_usd`, `cost_usd`, `margin_impact_usd`) — the **training data for the NBA model** (`03-ml-nba.md`). ~3 action types: `retention_offer`, `cross_sell`, `rm_outreach`. |

### Data Variation

Account activity + risk (on `raw_transactions` / `raw_risk_snapshots`) — the load-bearing shape is the **high-value attrition divergence**, but everyday activity needs realistic rhythm so the anomaly stands out, not drowns:

- **Monthly rhythm** — payroll deposits cluster near month start/mid; apply ±15% noise. Interest postings monthly on deposits.
- **Baseline risk** — most customers sit at a low, stable attrition risk (0.05–0.25) with gentle drift; balances stable. Keep it calm so the affected ramp dominates.
- **A few everyday closures** — a small background rate of normal attrition (a handful of low-value closures) so the book isn't unnaturally static, placed so it doesn't collide with the affected cohort's signal (the anomaly reads because it's high-value-and-recent, not because it's the only movement).

**The high-value attrition split (the whole story):** attrition risk is **value-and-event-driven**, not uniform. The competitor promo pushes the ~220 high-value customers holding a maturing/at-risk affected deposit from a low baseline to 0.7–0.9 over ~3 weeks, with matching balance outflow; everyone else stays calm. This single rule produces the red high-value/high-risk cluster without forcing it.

### Note pool (`servicing_note_text` on risk snapshots)

~15 hand-coded strings in 2 tones — keeps synth deterministic and gives `ai_classify` a clear signal. **Churn-signal** (must include the Shared-Context attrition-signal phrases verbatim): assertive "this customer is leaving" tone, attached predominantly to the affected high-value at-risk customers. **Healthy**: "routine service call", "satisfied, no concerns" — everyday customers. **Distribution** (the classifier's signal): affected at-risk customers → 85% churn-signal / 15% healthy · everyday customers → 10% churn-signal / 90% healthy.

### Customer master + geo

Each customer gets `customer_lat` + `customer_lng` (DOUBLE PRECISION) = home-branch metro anchor + ~0.05° jitter so points spread. **Required for the story**: the ~220 affected high-value customers are spread across the branch network (not one metro — attrition is a book-wide event) but concentrated in the high-value tiers (`affluent`/`private`). `CUST-0000214` pinned to a fixed metro (e.g. the flagship branch metro). The map colors by `risk_band` (derived in gold from `attrition_risk_score`), not the raw tier. Lat/lng to 2 decimals is enough.

### The Event

The competitor promo is a **customer×product risk + balance divergence**, not a total-attrition spike:

- **Affected high-value customers** (~220) holding an affected maturing/at-risk deposit: `attrition_risk_score` ramps from a ~0.2 baseline starting `RISK_RAMP` (~2.5 weeks ago), climbing to 0.7–0.9 over ~10 days. `raw_transactions` shows matching **balance outflow** (transfer_out / partial withdrawal) beginning at `RISK_RAMP` — the money starting to move. Their `raw_holdings` deposit has a large balance and (for CDs) a near-term `maturity_date`.
- **Everyday customers** (~40K): `attrition_risk_score` stays 0.05–0.25, balances stable, `servicing_note_text` predominantly healthy.
- **Everything else** behaves normally — the divergence is confined to the affected high-value cohort so the anomaly is legible.

Quantify the exposure so the KPIs land: total **balance-at-risk** on the affected customers ≈ **$180M** (sum of their affected-deposit balances); annualized **revenue-at-risk** ≈ **$5.2M** (balance-at-risk × net interest margin + lost fee/cross-sell revenue per lost relationship). These are demo targets — the generation should produce data that rolls up roughly to them.

**Retention-action history (`raw_retention_campaigns`) — the model's training signal.** Over the 18-month history, generate realistic next-best-actions with outcomes so the model in `03-ml-nba.md` can learn which action retains the most value in which situation:
- `retention_offer` (match/beat the competitor rate on the maturing product): moderate cost (the rate concession); retains **high value** when the customer's balance-at-risk is large and attrition probability is high (the hero case); `retained_revenue_usd` high, `margin_impact_usd` = the rate concession cost.
- `cross_sell` (offer a product they qualify for but don't hold): low cost; retains value AND adds revenue, but only lands when the customer is a **good fit** (right tier, doesn't already hold it) and NOT already halfway out the door — weaker on the highest-risk accounts.
- `rm_outreach` (a relationship-manager call, no offer): cheapest; a soft touch that works on **moderate**-risk accounts but rarely saves a high-balance customer who's actively rate-shopping — lower `retained_revenue_usd` on the hero-type account.
- Make the outcomes **learnable**: retention offers on high-balance, high-risk, maturing-deposit customers show the best `retained_revenue_usd` per dollar; cross-sell wins on lower-risk good-fit customers; outreach wins on moderate-risk soft cases. This is what lets the model rank `CUST-0000214`'s situation as **retention offer** — because history says so.

### Raw table schemas (gen output)

ID formats: `CUST-NNNNNNN` / `PROD-XXX-NNNN` / `ACCT-NNNNNNNN` / `TXN-NNNNNNNN` / `CMP-NNNNNNNN`. PKs in **bold**, FKs marked. Tables prefix with `raw_` (no bronze).

- **`raw_customers`** — **customer_id**, customer_display_name, tier (`mass/mass_affluent/affluent/private`), tenure_years (INT), home_branch_id, home_metro, state, `customer_lat`/`customer_lng` (DOUBLE, metro anchor + jitter), annual_income_band, join_date, **profile_summary** (STRING — non-PII searchable blurb; the text Lakebase Search + the NBA grounding match on), is_active.
- **`raw_products`** — **product_id**, product_name, product_type (`CD/Savings/Checking/Mortgage/HELOC/Card/Auto/Advisory/Brokerage`), segment (`deposit/lending/investment`), rate_apy (DOUBLE, nullable — deposits), min_balance_usd, **description** (STRING — features + eligibility; the text Lakebase Search + the cross-sell lookup match on), is_active.
- **`raw_holdings`** — **account_id**, customer_id (FK), product_id (FK), balance_usd (DOUBLE), open_date (DATE), maturity_date (DATE, nullable — deposits), rate_apy (DOUBLE), status (`active/matured/closed`). One row per account held.
- **`raw_transactions`** — **txn_id**, customer_id (FK), account_id (FK), txn_date (DATE), amount_usd (DOUBLE, signed), txn_type (`deposit/withdrawal/transfer_out/fee/interest`), channel (`branch/online/mobile/atm`). One row per account transaction.
- **`raw_risk_snapshots`** — customer_id (FK), snapshot_date (DATE), attrition_risk_score (DOUBLE 0–1), balance_outflow_30d_usd (DOUBLE — recent net outflow), servicing_note_text (STRING, nullable — populated on affected + a sample of everyday customers). Daily for the last ~14 days + `SNAPSHOT_DATE`.
- **`raw_retention_campaigns`** — **campaign_id**, customer_id (FK), product_id (FK, nullable — the product the action concerns), action_type (`retention_offer/cross_sell/rm_outreach`), offered_product_id (FK, nullable — cross-sell target), balance_at_risk_usd (DOUBLE), initiated_date (DATE), days_to_resolve (INT), retained (BOOLEAN), retained_revenue_usd (DOUBLE), margin_impact_usd (DOUBLE), cost_usd (DOUBLE). 18-month history — the NBA model's labeled outcomes.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md` before implementing.

Create pipeline `meridian_customer_360` transforming raw parquet → analytics tables. Configure with a `configuration: {catalog, schema}` block and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')` so it works on any target catalog/schema.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (balance-at-risk $, revenue-at-risk $, at-risk count) + trend | risk/value exposure metrics by tier + segment + risk band | `mv_customer_risk` metric view (over `gold_customer_position`, defined in `02-uc-governance.md`) |
| Dashboard scatter/map + at-risk widgets | per customer current position with geo + tier + balances + risk + band flag | `gold_customer_position` (widget-level GROUP BY for tier/segment rollups) |
| Genie "who is at risk and why" | same per-customer fact with denormalized holdings + note | `gold_customer_position` |
| NBA model training (`03-ml-nba.md`) | one row per historical action with situational features + outcome label | `gold_campaign_outcomes` |
| NBA model scoring input | one row per OPEN at-risk customer + candidate-action context | `gold_open_atrisk` |
| App's RM queue (at-risk customers + ranked NBA) | current at-risk with customer/holdings/geo + ranked action + predicted retained $ | `gold_open_atrisk` JOIN `gold_nba_recommendations` (built by the pipeline heuristic; ML optional — `03-ml-nba.md`) |
| App's analytics drill-downs (Delta via warehouse) | risk trend, worst accounts, per-tier rollups | `silver_risk`, `gold_customer_position` |

### Raw layer (no bronze pass-through)

The data-gen step in Section A writes 6 raw parquet datasets into the `raw_data` Volume: `customers`, `products`, `holdings`, `transactions`, `risk_snapshots`, `retention_campaigns`. SDP silver reads these files via `read_files()` — there is no bronze layer (the gen's output is already typed and clean).

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

Four silver materialized views — three facts (`silver_holdings`, `silver_risk`, `silver_campaigns`) plus one small dedup helper (`note_churn_flags`).

**`note_churn_flags`** — *the `ai_classify` showcase, sized down*. The synth uses a canned pool of ~15 distinct `servicing_note_text` strings across hundreds of thousands of risk rows. Running `ai_classify` per-row would issue that many LLM calls; instead build a small MV over `SELECT DISTINCT servicing_note_text` and call `ai_classify` once per distinct string:

```sql
SELECT servicing_note_text,
  CASE ai_classify(servicing_note_text,
        ARRAY('churn_signal','at_risk','healthy'))
    WHEN 'churn_signal' THEN 1.0
    WHEN 'at_risk'      THEN 0.6
    ELSE 0.1
  END AS churn_signal_score
FROM (SELECT DISTINCT servicing_note_text FROM raw_risk_snapshots
      WHERE servicing_note_text IS NOT NULL)
```

`silver_risk` joins back on `servicing_note_text` so every snapshot inherits the score without a second LLM call. Talking-track: *"one built-in SQL function turns a servicing rep's free-text note into a churn-risk signal — no UDF, no separate service, and it scales because we dedup."*

**`silver_holdings`** — per customer×account denormalized fact. `raw_holdings` JOIN `raw_customers` (→ tier, tenure, geo, metro) JOIN `raw_products` (→ product_name, product_type, segment, rate_apy). Columns: `customer_id`, `customer_display_name`, `tier`, `tenure_years`, `home_metro`, `customer_lat`, `customer_lng`, `account_id`, `product_id`, `product_name`, `product_type`, `segment`, `balance_usd`, `maturity_date`, `rate_apy`, `status`, plus `days_to_maturity` (maturity_date − SNAPSHOT_DATE, NULL for non-deposits). Cluster by `customer_id`.

**`silver_risk`** — current + recent risk position, denormalized. `raw_risk_snapshots` JOIN `raw_customers` JOIN `note_churn_flags` (→ churn_signal_score). Columns: customer denormalized dims (as above), `snapshot_date` (DATE), `attrition_risk_score`, `balance_outflow_30d_usd`, `servicing_note_text`, **`churn_signal_score`** (COALESCE → 0.1 on no match). Cluster by `snapshot_date`.

**`silver_campaigns`** — retention-action history, denormalized. `raw_retention_campaigns` JOIN `raw_customers` (→ tier, tenure) JOIN `raw_products` (→ product_name, product_type, segment). Columns: `campaign_id`, `customer_id`, `tier`, `tenure_years`, `product_id`, `product_name`, `action_type`, `offered_product_id`, `balance_at_risk_usd`, `initiated_date` (DATE), `days_to_resolve`, `retained`, `retained_revenue_usd`, `margin_impact_usd`, `cost_usd`. Powers the NBA-model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every aggregate consumed by the dashboard MUST carry `tier`, `segment`, and `risk_band` as filter dimensions. `gold_customer_position` enforces this directly; any future gold MV must follow the same rule or global filters silently stop applying.

**`gold_customer_position`** — *the heart of the demo* — one row per customer reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with total balances, top affected holding, risk, and a band flag. Built from `silver_risk` (current snapshot) JOIN a `silver_holdings` rollup on `customer_id`. Dims: `customer_id`, `customer_display_name`, `tier`, `tenure_years`, `home_metro`, `customer_lat`, `customer_lng`, `profile_summary` (pass-through from `raw_customers`). Metrics/fields: `total_balance_usd` (SUM of active holdings), `deposit_balance_usd`, `affected_deposit_balance_usd` (balance in the 3 affected products), `min_days_to_maturity` (nearest maturing affected deposit), `attrition_risk_score`, `balance_outflow_30d_usd`, `churn_signal_score`, `product_count`, and two derived $ measures + a status flag:
- `balance_at_risk_usd` — for at-risk customers: `affected_deposit_balance_usd` when `attrition_risk_score ≥ 0.6` else 0 — the deposit money that could walk.
- `revenue_at_risk_usd` — `balance_at_risk_usd × net_interest_margin` (demo NIM ≈ 0.025) + a per-relationship fee/cross-sell value (`GREATEST(0, tenure_years × 40)`) when at risk — the annual revenue at stake if the relationship leaves.
- **`risk_band`** (the single column the UI colors by): `'critical'` (`attrition_risk_score ≥ 0.75` AND `balance_at_risk_usd > 0`), `'elevated'` (`attrition_risk_score ≥ 0.6`), `'watch'` (`attrition_risk_score ≥ 0.4`), `'healthy'` (else). The affected high-value customers → `critical`/`elevated`; everyone else → `healthy`.

> `gold_customer_position` is what the dashboard scatter/map, the metric view, Genie, and the app's RM view all read. It is the coherence spine — every downstream "who's at risk and why" answer resolves here.

**`gold_open_atrisk`** — the current at-risk customers the app + model act on. `gold_customer_position WHERE risk_band IN ('critical','elevated','watch')` (include `watch` so the moderate cohort, where cross_sell/outreach win, is scored too), enriched with candidate-action context: for each at-risk customer, their maturing affected deposit (`atrisk_product_id`, `atrisk_balance_usd`, `days_to_maturity`, `current_rate_apy` — the highest-balance affected holding via `ROW_NUMBER() … ORDER BY balance_usd DESC`), the competitor rate gap, and a candidate cross-sell product they qualify for but don't hold (`candidate_cross_sell_product_id` — the first segment they lack: investment → `PROD-INV-3001`, else lending → `PROD-CRD-4001`, else `PROD-LN-5001`). Columns: customer/geo/tier + `attrition_risk_score`, `balance_at_risk_usd`, `revenue_at_risk_usd`, `atrisk_product_id`, `atrisk_balance_usd`, `days_to_maturity`, `current_rate_apy`, `candidate_cross_sell_product_id`. This is BOTH the model's scoring input (`03-ml-nba.md`) and, joined to the model's output, the app's RM queue.

**`gold_campaign_outcomes`** — retention-action history, one row per historical action. Pass-through from `silver_campaigns` + situational features derived at action time: `action_type`, `balance_at_risk_usd`, `tier`, `tenure_years`, `attrition_risk_at_action` (reconstructed from `silver_risk` around `initiated_date`), `days_to_resolve`, `product_type`, and the OUTCOME `retained` + `retained_revenue_usd` + `margin_impact_usd` + `cost_usd`. Two uses: (a) the heuristic below can derive its rate coefficients from it (`AVG(...) GROUP BY action_type`); (b) it's the training table if a team takes the OPTIONAL ML path (`03-ml-nba.md`).

**`gold_nba_recommendations`** — *the ranked next-best-action per open at-risk customer* — **built by the pipeline with a hardcoded HEURISTIC** (no ML needed; ML is an optional swap, see `03-ml-nba.md`). For each row in `gold_open_atrisk`, construct the three candidate actions and rank by **net value = retained_revenue − cost − margin_impact**, computed in SQL from the candidate economics. Let `eff_bal = GREATEST(atrisk_balance_usd, balance_at_risk_usd)` (the exposed deposit — use the account balance so `watch`-band customers, whose `balance_at_risk_usd` is 0 by the ≥0.6 gate, still rank), `nim ≈ 0.025`:
- **retention_offer** (rate-match on the maturing deposit): `retained_revenue ≈ eff_bal × nim × 3 × P(retain | risk)` — retain the relationship ~3 years — where `P(retain) = LEAST(0.9, 0.45 + attrition_risk_score × 0.4)` (HIGH for a rate-match on a high-risk rate-shopper); `cost ≈ eff_bal × GREATEST(0.001, competitor_rate − current_rate_apy)` (one year of the rate concession, `competitor_rate ≈ 0.0385`); `margin_impact ≈ 0`. Best net when the balance is large — the **critical** cohort.
- **cross_sell** (offer `candidate_cross_sell_product_id`): `retained_revenue ≈ eff_bal × nim × 3 × P(retain | cross_sell) + cross_sell_annual_value` where `P(retain | cross_sell) = GREATEST(0.1, 0.6 − attrition_risk_score × 0.5)` (LOW on a high-risk rate-shopper — they're leaving over rate, not product breadth) and `cross_sell_annual_value ≈ 1200`; `cost ≈ 50`; `margin_impact ≈ 0`. **Wins on the lower-risk, smaller-balance moderate cohort**, not the hero.
- **rm_outreach** (a call, no offer): `retained_revenue ≈ eff_bal × nim × 3 × P(retain | outreach)` where `P(retain | outreach) = GREATEST(0.05, 0.4 − attrition_risk_score × 0.35)` (LOWEST on a high-balance rate-shopper); `cost ≈ 40`; `margin_impact ≈ 0`. Cheapest, but the weakest save on the hero-type account.
- `net_value = retained_revenue − cost − margin_impact`; `recommended_action` = argmax net_value; `predicted_retained_usd` = the retained_revenue of the chosen action; `action_ranking` = a JSON array of all three actions with their `retained`/`net`/`cost`. Columns match the schema in `03-ml-nba.md` → Inference shape (`customer_id`, `recommended_action`, `recommended_offer_product_id`, `recommended_rate_apy`, `predicted_retained_usd`, `predicted_net_value_usd`, `action_ranking`, `scored_at`). The coefficients mirror the outcomes in `gold_campaign_outcomes`, so **retention_offer wins for the hero customer** (`CUST-0000214`) while cross_sell wins across the moderate cohort — a plausible mix, not 100% one action.

### Consumer routing

- `mv_customer_risk` (over `gold_customer_position`) → dashboard KPIs + Genie headline answers. Same definitions everywhere (`02-uc-governance.md`).
- `gold_customer_position` → dashboard scatter/map + at-risk/tier widgets via widget-level `GROUP BY`.
- `gold_open_atrisk` → NBA-model scoring input AND (joined with the model output) the app's RM queue.
- `gold_nba_recommendations` → the app's RM queue (ranked action per customer) + the dashboard's NBA widgets. Built by the pipeline heuristic; optionally overwritten by the ML path.
- `gold_campaign_outcomes` → the heuristic's coefficient source AND the training table for the OPTIONAL ML path (`03-ml-nba.md`). Dashboard + app read `gold_nba_recommendations`, not the raw outcomes.
- `silver_risk` → app analytics drill-downs (risk trend) via warehouse SQL.

---

## C. Validation

Run before `03-ml-nba.md`. Each row = a one-line query the LLM writes against the table; if it fails, fix the synth before publishing downstream resources.

**Load-bearing (must pass — these gate the story):**
- **The hero customer exists** — `gold_customer_position WHERE customer_id='CUST-0000214'` → `attrition_risk_score ≥ 0.75`, `risk_band = 'critical'`, `affected_deposit_balance_usd` large (a big maturing CD), `balance_at_risk_usd > 0`, `min_days_to_maturity` small (≈ 9).
- **The hero has a maturing affected deposit** — `gold_open_atrisk WHERE customer_id='CUST-0000214'` → `atrisk_product_id` ∈ the 3 affected products, `atrisk_balance_usd` large, `days_to_maturity` ≈ 9, `current_rate_apy` present, `candidate_cross_sell_product_id` present. The retention story must be true in the data.
- **High-value/high-risk cluster** — `gold_customer_position` GROUP BY `tier`, `risk_band`: `critical`/`elevated` rows are overwhelmingly in `affluent`/`private` tiers; ~220 critical/elevated customers total.
- **Anomaly confined to the affected cohort** — the vast majority of customers are `healthy`; the divergence doesn't bleed everywhere (or the scatter is noise).
- **Exposure KPIs land** — `SUM(balance_at_risk_usd)` ≈ $180M; `SUM(revenue_at_risk_usd)` ≈ $5.2M (±20% OK).
- **`churn_signal_score` separates** — `AVG(churn_signal_score)` on affected at-risk customers ≥ 0.6; on healthy customers ≤ 0.2.
- **`note_churn_flags` dedup is doing its job** — `COUNT(DISTINCT servicing_note_text) << COUNT(*)` on `raw_risk_snapshots`; MV row count matches the distinct count.
- **Retention outcomes are learnable** — `gold_campaign_outcomes` GROUP BY `action_type`: `retention_offer` on high-balance/high-risk customers shows the best `retained_revenue_usd` per `cost_usd`; `cross_sell` wins on lower-risk good-fit; `rm_outreach` on moderate-risk soft cases. If the three action types don't separate on outcome, the model can't rank them — regenerate.
- **Risk ramp is in the past** — daily `AVG(attrition_risk_score)` on affected customers shows a build starting ~2.5w ago, not a cliff at the current day.

**Smoke checks** (the LLM derives these — verify upstream invariants didn't break): `tier` enum is `{mass, mass_affluent, affluent, private}`; customer geo non-null and in earth-bounds (lat [-90,90], lng [-180,180]); `risk_band` enum is the 4 values above; `gold_open_atrisk` has a couple hundred rows (not zero, not tens of thousands); `attrition_risk_score` in [0,1]; `balance_usd` never negative.

Add `pipeline_id` to `resources.json`.
