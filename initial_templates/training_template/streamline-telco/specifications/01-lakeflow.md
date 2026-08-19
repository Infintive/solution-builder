# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The company**: Streamline Telco — broadband + mobile + bundled streaming (~4M subscribers, ~$3.2B revenue, ~$68 ARPU, a large contact center). The demo samples ~40K subscribers so joins stay cheap.

**The affected driver**: a **network outage on a specific service node** (`NODE-OHIO-14`) ~3 weeks ago, colliding with billing friction and a competitor promo. The subscribers homed on that node (+ a spread with billing/ticket friction) are the churn-risk cluster.

**The retention-offer catalog** (the three plays an agent can make, plus the plan/device catalog) carries a searchable **`description`** (what the offer is, who it fits, the value) — the text **Lakebase Search** (Milestone 2) indexes, and what the app's service-history search + the **offer** selection query run over. The subscriber-facing **service history** (tickets + network events) is ALSO searchable text — the app's `search_history` grounds the "why is this subscriber at risk" answer on their real outage/billing history without reading irrelevant data.

**Hero subscriber**: `SUB-0000214` — a 5-year subscriber homed on `NODE-OHIO-14`, an **unresolved outage ticket** + a **billing dispute**, churn-risk score ~0.86. The demo's spotlight. Deterministic. The recommended retention offer the heuristic ranks first is a **bill_credit** — because the churn driver is a service/billing grievance (not price), so a one-time credit that acknowledges the outage retains them at the best expected-value; a plan discount or device upgrade addresses the wrong problem.

**The anomaly (one driver, two visible symptoms)**: the node outage + billing friction ~3 weeks ago pushed a cluster of subscribers into churn risk. On the **affected subscribers**:
- **Risk side (the alarm)** — ~200 subscribers (homed on the outage node + billing/ticket friction) crossed into **elevated churn risk** (`churn_risk_score` climbing from a ~0.1 baseline to ~0.7–0.9) in the last ~3 weeks, with **open tickets + a recent network event** on their record (shown RED).
- **Reason side** — the risk is driven by SERVICE (outage/billing), not price, so the right offer acknowledges that — the recommendation must reflect the reason, not just discount blindly.
- **Healthy side** — the rest of the sampled base (~40K) sits at a normal ~0.03–0.2 risk (shown STEEL/blue).

This is the load-bearing shape: **subscribers on a specific outage node + billing friction, rising churn risk, concentrated in a recent 3-week window** — legible on one view (a churn-risk × tenure/ARPU scatter, a red cluster). The recommended offer ("a bill credit") is literally supported by the data because the subscriber HAS an unresolved outage ticket + a billing dispute.

**Churn-signal notes** (verbatim agent/service-note phrases, used predominantly on the affected at-risk subscribers — feed the note pool so `ai_classify` has a clear signal). Churn-signal tone: *"called about outage, still not resolved"*, *"disputes last bill, threatening to leave"*, *"asked about competitor's offer"*, *"service down twice this month"*, *"escalated, wants credit or will cancel"*. Healthy tone (for stable subscribers): *"routine support call, resolved"*, *"satisfied, no issues"*. Exact substrings — Genie + the dashboard search for them.

**Time references**: `NOW = datetime.now()` by default (rolling; set `STREAMLINE_PIN_TIME=1` to freeze). `HISTORY_START = NOW − 18 months` (usage + billing + retention history for the model). `OUTAGE_ONSET = NOW − 21 days` (~3 weeks back — the node outage + billing friction begins). `RISK_RAMP = NOW − 18 days` (affected subscribers' churn risk climbs). `SNAPSHOT_DATE = NOW − 1 day` (the "current" subscriber snapshot). **Causal chain**: stable base before −3w → node outage + billing friction at −3w → affected subscribers' tickets open + risk ramps −3w to −1w → everyone else stable → the CURRENT snapshot shows the at-risk cluster. Peak of the risk divergence sits in the past week-and-a-half, left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen`. Use the pre-provisioned databricks-connect venv (Python 3.12). Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window + `F.element_at`. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, no `raw_` prefix). SDP silver reads via `read_files()` — no bronze:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_subscribers` | ~40,000 | Subscriber master. `plan_type` (`broadband/mobile/bundle`), `tenure_months`, `monthly_arpu_usd`, `service_node_id` (their network node), `home_metro`, `sub_lat`/`sub_lng` (metro anchor + jitter — drives the map), `sub_display_name` (minimal), **`service_summary`** (searchable blurb: tenure, plan, recent service history — the text Lakebase Search indexes). `SUB-0000214` pinned as the 5-year, outage-node hero. |
| `raw_offers` | ~30 | Retention/plan offer catalog: plan-upgrade discounts, bill credits, device upgrades. `offer_type`, `value_usd`, `segment`, plus a searchable **`description`** (what it is, who it fits) — indexed by **Lakebase Search**; the **offer** selection queries it. |
| `raw_usage` | ~3.5M | 18 months of daily usage (one row per subscriber×day). `data_gb`, `voice_min`, `stream_hours`. Realistic rhythm; the affected subscribers' usage dips slightly post-outage (disengagement). |
| `raw_billing` | ~700K | Monthly billing records + disputes. `bill_month`, `amount_usd`, `disputed` (bool), `dispute_reason` (nullable). The affected subscribers have recent disputes. |
| `raw_tickets` | ~250K | Support tickets over 18 months. `ticket_type` (`outage/billing/technical/general`), `opened_date`, `closed_date` (nullable — NULL = open), `channel`, `note_text`. The affected subscribers have OPEN outage/billing tickets. |
| `raw_network_events` | ~120K | Network events (outages, degradations) by node + date. `event_type`, `node_id`, `event_date`, `duration_min`, `subscribers_affected`. The `NODE-OHIO-14` outage ~3 weeks ago lives here. |
| `raw_risk_snapshots` | ~200K | Daily `churn_risk_score` (0–1) for the affected subscribers across the last ~14 days + a current-snapshot sample of everyday subscribers. Affected → 0.7–0.9; everyday → 0.03–0.2. Carries `agent_note_text` (the `ai_classify` signal). |
| `raw_retention_offers` | ~40K | 18-month history of retention offers made to at-risk subscribers, each with an OUTCOME (`retained` bool, `retained_clv_usd`, `offer_cost_usd`) — the **training data for the churn model** (`03-ml-churn.md`). ~3 offer types: `plan_upgrade_discount`, `bill_credit`, `device_upgrade`, each tagged with the churn `reason` it addressed. |

### Data Variation

Usage + risk — the load-bearing shape is the **affected-subscriber churn divergence**, but everyday usage needs realistic rhythm:
- **Weekly rhythm** — streaming/data peaks on weekends; ±15% noise.
- **Baseline risk** — most subscribers sit at low, stable churn risk (0.03–0.2). Keep it calm so the affected ramp dominates.
- **A few everyday churns** — a small background cancellation rate so the base isn't static, placed so it doesn't collide with the affected-cohort signal.

**The affected-subscriber split (the whole story):** churn risk is **service-event-driven**, not uniform. The node outage + billing friction pushes the ~200 affected subscribers from a low baseline to 0.7–0.9 over ~3 weeks; everyone else stays calm. This single rule produces the red cluster without forcing it.

### Note pool (`agent_note_text` on risk snapshots)

~15 hand-coded strings in 2 tones. **Churn-signal** (must include the Shared-Context phrases verbatim): attached predominantly to the affected at-risk subscribers. **Healthy**: "routine support call, resolved", "satisfied, no issues". **Distribution**: affected at-risk → 85% churn-signal / 15% healthy · everyday → 10% churn-signal / 90% healthy.

### Subscriber master + geo

Each subscriber gets `sub_lat`/`sub_lng` (DOUBLE) = home-metro anchor + jitter. The ~200 affected subscribers concentrate on the outage node's metro (Ohio) + a spread with billing friction; `SUB-0000214` pinned to the Ohio metro on `NODE-OHIO-14`. The map colors by `risk_band` (derived in gold), not raw plan.

### The Event

- **Affected subscribers** (~200): `churn_risk_score` ramps from ~0.1 starting `RISK_RAMP`, climbing to 0.7–0.9 over ~10 days, with OPEN outage/billing tickets in `raw_tickets`, a recent dispute in `raw_billing`, and (for the node cohort) a link to the `NODE-OHIO-14` event in `raw_network_events`. Notes churn-signal-toned.
- **Everyday subscribers** (~40K): churn risk 0.03–0.2, tickets resolved, notes healthy.
- **Everything else** normal — the divergence is confined to the affected subscribers.

Quantify the exposure so the KPIs land: **CLV-at-risk exposure** ≈ **$0.4M** on the ~215 sampled at-risk subscribers (`SUM(monthly_arpu × 24 × churn_risk)` — the lifetime value that could walk). This is the *sampled* figure the dashboard tiles show; at the full ~4M-subscriber base the same 0.1pt-of-monthly-churn move is the ~$3.9M/yr headline in the README (talking-track). **open tickets** ≈ ~350 on the affected cohort. Demo targets — roll up roughly to them.

**Retention-offer history (`raw_retention_offers`) — the model's training signal.** Over 18 months, generate realistic offers with outcomes + the churn `reason` they addressed so the model in `03-ml-churn.md` can learn which offer retains the most CLV for which reason:
- `bill_credit` (a one-time credit): low cost; **best when the churn reason is a service/billing grievance** (the hero case) — it acknowledges the problem.
- `plan_upgrade_discount` (a recurring discount): moderate cost; best when the reason is PRICE (a competitor offer), not service.
- `device_upgrade` (a subsidized device): high cost; best for high-ARPU subscribers whose reason is device/experience — over-kill for a billing grievance.
- Make outcomes **learnable**: bill_credit on service/billing-reason subscribers shows the best `retained_clv` per `offer_cost`; plan discount wins on price-reason; device upgrade on device-reason high-ARPU. This lets the model rank `SUB-0000214` (service/billing reason) as **bill_credit**.

### Raw table schemas (gen output)

ID formats: `SUB-NNNNNNN` / `OFFER-NNN` / `TKT-NNNNNNNN` / `NEV-NNNNNNNN` / `RET-NNNNNNNN` / `NODE-XXXX-NN`. PKs in **bold**, FKs marked.

- **`raw_subscribers`** — **subscriber_id**, sub_display_name, plan_type (`broadband/mobile/bundle`), tenure_months (INT), monthly_arpu_usd (DOUBLE), service_node_id, home_metro, state, `sub_lat`/`sub_lng` (DOUBLE), activation_date, **service_summary** (STRING — searchable), is_active.
- **`raw_offers`** — **offer_id**, offer_name, offer_type (`plan_upgrade_discount/bill_credit/device_upgrade`), value_usd (DOUBLE), segment, **description** (STRING — searchable), is_active.
- **`raw_usage`** — subscriber_id (FK), usage_date (DATE), data_gb (DOUBLE), voice_min (INT), stream_hours (DOUBLE). One row per subscriber×day.
- **`raw_billing`** — **bill_id**, subscriber_id (FK), bill_month (DATE), amount_usd (DOUBLE), disputed (BOOLEAN), dispute_reason (STRING, nullable). Monthly.
- **`raw_tickets`** — **ticket_id**, subscriber_id (FK), ticket_type (`outage/billing/technical/general`), opened_date (DATE), closed_date (DATE, nullable), channel (`phone/chat/app`), note_text (STRING). Support tickets.
- **`raw_network_events`** — **event_id**, node_id, event_type (`outage/degradation`), event_date (DATE), duration_min (INT), subscribers_affected (INT). Network events by node.
- **`raw_risk_snapshots`** — subscriber_id (FK), snapshot_date (DATE), churn_risk_score (DOUBLE 0–1), churn_reason (STRING — `service`/`price`/`device`, the dominant driver), open_ticket_count (INT), agent_note_text (STRING, nullable). Daily last ~14 days + `SNAPSHOT_DATE`.
- **`raw_retention_offers`** — **retention_id**, subscriber_id (FK), offer_type (`plan_upgrade_discount/bill_credit/device_upgrade`), churn_reason (`service/price/device`), monthly_arpu_usd (DOUBLE), initiated_date (DATE), offer_cost_usd (DOUBLE), retained (BOOLEAN), retained_clv_usd (DOUBLE). 18-month history — the model's labeled outcomes.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md`.

Create pipeline `streamline_subscriber_360`. Configure with `configuration: {catalog, schema}` and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')`.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (CLV-at-risk $, open tickets #, at-risk #) + trend | risk/CLV exposure by plan + reason + risk band | `mv_subscriber_risk` metric view (over `gold_subscriber_position`) |
| Dashboard scatter/map + at-risk widgets | per subscriber current position with geo + plan + ARPU + risk + band flag | `gold_subscriber_position` |
| Genie "who is at risk and why" | same per-subscriber fact with denormalized tickets + node + note | `gold_subscriber_position` |
| Churn model training | one row per historical offer + features + outcome | `gold_retention_outcomes` |
| Churn model scoring input | one row per OPEN at-risk subscriber + candidate-offer + reason | `gold_open_atrisk` |
| App's care queue (at-risk + ranked offer) | current at-risk with subscriber/tickets/geo + ranked offer + expected retained CLV | `gold_open_atrisk` JOIN `gold_retention_recommendations` |
| App's analytics drill-downs | usage/risk trend, worst accounts, per-plan rollups | `silver_risk`, `gold_subscriber_position` |

### Raw layer (no bronze)

Section A writes 8 raw parquet datasets: `subscribers`, `offers`, `usage`, `billing`, `tickets`, `network_events`, `risk_snapshots`, `retention_offers`. SDP silver reads via `read_files()`.

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

**`note_churn_flags`** — *the `ai_classify` showcase, deduped*. Over `SELECT DISTINCT agent_note_text`, call `ai_classify(note, ARRAY('churn_signal','at_risk','healthy'))` once per distinct string → `churn_signal_score` (1.0/0.6/0.1). `silver_risk` joins back on the note.

**`silver_tickets`** — per-subscriber ticket rollup: `open_ticket_count`, `has_open_outage`, `has_open_billing`, latest ticket type.
**`silver_risk`** — current + recent risk position. `raw_risk_snapshots` JOIN `raw_subscribers` JOIN `note_churn_flags`. Cluster by `snapshot_date`.
**`silver_billing`** — per-subscriber billing rollup: `has_recent_dispute`, last dispute reason.
**`silver_retention`** — retention-offer history denormalized. Powers the model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every dashboard aggregate MUST carry `plan_type`, `churn_reason`, and `risk_band`.

**`gold_subscriber_position`** — *the heart* — one row per subscriber reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with plan, tickets, risk, reason, band. Built from `silver_risk` (current) JOIN `silver_tickets` + `silver_billing` on `subscriber_id`. Dims: `subscriber_id`, `plan_type`, `tenure_months`, `monthly_arpu_usd`, `service_node_id`, `home_metro`, `sub_lat`, `sub_lng`, `service_summary`. Fields: `churn_risk_score`, `churn_reason` (`service`/`price`/`device`), `open_ticket_count`, `has_open_outage`, `has_open_billing`, `has_recent_dispute`, `churn_signal_score`, and derived measures + a status flag:
- `clv_at_risk_usd` — for at-risk subscribers: `monthly_arpu_usd × expected_remaining_months(24) × churn_risk_score` when `churn_risk_score ≥ 0.6` else 0 — the lifetime value that could walk.
- **`risk_band`**: `'critical'` (`churn_risk_score ≥ 0.75` AND `open_ticket_count > 0`), `'elevated'` (`≥ 0.6`), `'watch'` (`≥ 0.4`), `'healthy'` (else). Affected → `critical`/`elevated`.

> `gold_subscriber_position` is the coherence spine — dashboard, metric view, Genie, and the app all read it.

**`gold_open_atrisk`** — `gold_subscriber_position WHERE risk_band IN ('critical','elevated','watch')`, enriched with candidate-offer + reason context: the `churn_reason`, `has_open_outage`, `has_open_billing`, the linked recent network event (if the reason is service), and a candidate offer per reason (`candidate_offer_id` — a `bill_credit` for service, a `plan_upgrade_discount` for price, a `device_upgrade` for device). Columns: subscriber/geo/plan + `churn_risk_score`, `clv_at_risk_usd`, `churn_reason`, `has_open_outage`, `has_open_billing`, `monthly_arpu_usd`, `candidate_offer_id`.

**`gold_retention_outcomes`** — retention-offer history, one row per offer. Pass-through from `silver_retention` + features: `offer_type`, `churn_reason`, `monthly_arpu_usd`, `offer_cost_usd`, `retained`, `retained_clv_usd`. The heuristic's coefficient source + the OPTIONAL ML training table.

**`gold_retention_recommendations`** — *the ranked offer per open at-risk subscriber* — **built by the pipeline HEURISTIC** (ML optional, `03-ml-churn.md`). For each row in `gold_open_atrisk`, construct the three candidate offers and rank by **net value = retained_clv − offer_cost**, where the retain probability depends on whether the offer MATCHES the churn reason:
- **bill_credit**: `P(retain) = 0.7 if churn_reason='service' else 0.3`; `retained_clv ≈ clv_at_risk × P(retain)`; `offer_cost ≈ 40` (a one-time credit). **Best when the reason is service/billing** — the hero.
- **plan_upgrade_discount**: `P(retain) = 0.65 if churn_reason='price' else 0.3`; `retained_clv ≈ clv_at_risk × P(retain)`; `offer_cost ≈ monthly_arpu × 0.2 × 12` (a recurring discount). Wins on price-reason.
- **device_upgrade**: `P(retain) = 0.6 if churn_reason='device' else 0.25`; `retained_clv ≈ clv_at_risk × P(retain)`; `offer_cost ≈ 300`. Wins on device-reason high-ARPU.
- `net_value = retained_clv − offer_cost`; `recommended_offer` = argmax; `offer_ranking` = JSON array of all three with `retained_clv`/`net`/`cost`. Columns match `03-ml-churn.md` → Inference shape. Coefficients mirror `gold_retention_outcomes`, so **bill_credit wins for `SUB-0000214`** (service reason) while plan discount / device upgrade win on their reason cohorts — a plausible mix.

### Consumer routing

- `mv_subscriber_risk` (over `gold_subscriber_position`) → dashboard KPIs + Genie headline answers.
- `gold_subscriber_position` → dashboard scatter/map + at-risk/plan widgets.
- `gold_open_atrisk` → model scoring input AND (joined with output) the app's care queue.
- `gold_retention_recommendations` → app's care queue + dashboard offer widgets.
- `gold_retention_outcomes` → heuristic coefficients + OPTIONAL ML training.
- `silver_risk` → app analytics drill-downs.

---

## C. Validation

Run before `03-ml-churn.md`.

**Load-bearing (must pass):**
- **The hero subscriber exists** — `gold_subscriber_position WHERE subscriber_id='SUB-0000214'` → `churn_risk_score ≥ 0.75`, `risk_band = 'critical'`, `churn_reason = 'service'`, `has_open_outage = true` (or `has_open_billing`), `clv_at_risk_usd > 0`.
- **The hero's reason drives a matching offer** — `gold_open_atrisk WHERE subscriber_id='SUB-0000214'` → `churn_reason = 'service'`, `candidate_offer_id` is a `bill_credit`. The offer story must be true in the data.
- **High-risk cluster** — `gold_subscriber_position` GROUP BY `service_node_id`, `risk_band`: the outage node + billing-friction subscribers dominate critical/elevated; ~200 total.
- **Anomaly confined** — the vast majority of subscribers are `healthy`.
- **Exposure KPIs land** — `SUM(clv_at_risk_usd)` ≈ $0.4M on the sampled at-risk cohort (the $3.9M in the README is the full-4M-base talking-track); open tickets ≈ ~350 (±20% OK).
- **`churn_signal_score` separates** — affected at-risk ≥ 0.6; healthy ≤ 0.2.
- **`note_churn_flags` dedup works** — `COUNT(DISTINCT agent_note_text) << COUNT(*)`.
- **Retention outcomes are learnable** — `gold_retention_outcomes` GROUP BY `offer_type`, `churn_reason`: bill_credit on service-reason shows the best `retained_clv` per `offer_cost`; plan discount on price; device on device. If they don't separate, regenerate.
- **Risk ramp is in the past** — daily `AVG(churn_risk_score)` on affected subscribers shows a build ~2.5w ago.
- **Offer mix is plausible** — the heuristic produces a MIX (bill_credit dominates the service-reason cohort; plan discount + device on their reasons), not 100% one type.

**Smoke checks**: `plan_type` in `{broadband, mobile, bundle}`; subscriber geo non-null + in earth-bounds; `risk_band` enum is the 4 values; `churn_reason` in `{service, price, device}`; `gold_open_atrisk` ~200–350 rows; `churn_risk_score` in [0,1].

Add `pipeline_id` to `resources.json`.
