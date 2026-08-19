# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The company**: Nimbus — a mobile-first marketplace + streaming app (~15M MAU, ~$400M revenue, ~400-person lean team, high-volume clickstream). The demo samples ~500 **segment×platform cohorts** (the analytical grain the growth team works) + ~3.5M raw events so joins stay cheap.

**The entity**: the demo is about **user segments** (cohort × platform), not individual users. A cohort is e.g. `SEG-GENZ-ANDROID` (demographic × platform). The metric that matters is each cohort's **conversion rate** over time.

**The experiment/feature catalog** carries a searchable **`description`** (the experiment hypothesis, which variant, which segment it was tested on, the result) — the text **Lakebase Search** (Milestone 2) indexes, and what the app's "which feature wins for this segment" search + the **ship-variant** play query run over (matching a sliding segment to a variant that won a past experiment for a similar cohort, grounding the decision in real prior outcomes).

**Hero segment**: `SEG-0000214` — Gen-Z on Android, a large cohort whose **conversion slid from ~4.2% to ~2.9%** over the last ~3 weeks after a checkout-flow change landed badly on Android. The demo's spotlight. Deterministic. The recommended feature play the heuristic ranks first is **ship_proven_variant** — because a past experiment (`EXP-0000009`) shipped a checkout variant that lifted conversion for a similar Gen-Z cohort, so its projected lift × the cohort's user count beats an untested alternative or a neighboring flag rollout.

**The anomaly (one change, two visible symptoms)**: ~3 weeks ago a checkout-flow change shipped and landed **unevenly across platforms** — it helped iOS but hurt a cluster of Android/Gen-Z cohorts. On the **affected cohorts**:
- **Slide side (the alarm)** — ~40 segment cohorts whose **conversion rate dropped** (from a ~4% baseline to ~2.5–3%) over the last ~3 weeks, still sliding (shown RED).
- **Feature side** — each sliding cohort has a **candidate feature/variant** that a past experiment proved out for a similar cohort — the recoverable path.
- **Healthy side** — the rest of the ~500 cohorts sit at a stable ~3.5–4.5% conversion (shown STEEL/blue).

This is the load-bearing shape: **specific segment cohorts sliding on conversion after a change, concentrated in a recent 3-week window, each with a proven feature that could recover them** — legible on one view (a conversion × cohort-size scatter, a red sliding cluster). The recommended action ("ship the proven variant") is literally supported by the data because a past experiment lifted conversion for a similar cohort.

**Slide-signal notes** (verbatim PM/analyst-note phrases, used predominantly on the affected cohorts — feed the note pool so `ai_classify` has a clear signal). Slide tone: *"conversion dropping since the checkout change"*, *"android funnel regressed, ios fine"*, *"drop-off at payment step for this segment"*, *"needs a rollback or a proven variant"*, *"losing this cohort week over week"*. Healthy tone (for stable cohorts): *"converting to plan"*, *"funnel healthy, no regressions"*. Exact substrings — Genie + the dashboard search for them.

**Scale posture (the DNB-specific teaching point)**: at 15M MAU the served decision (the feature flag) must read at low latency AND **scale to zero when idle** (near-zero cost) — Lakebase serves it. The AI feature could become the single largest spend slice, so the AI Gateway caps it against margin.

**Time references**: `NOW = datetime.now()` by default (rolling; set `NIMBUS_PIN_TIME=1` to freeze). `HISTORY_START = NOW − 18 months` (event + experiment history). `CHANGE_ONSET = NOW − 21 days` (~3 weeks back — the checkout-flow change ships). `SLIDE_RAMP = NOW − 18 days` (affected cohorts' conversion starts sliding). `SNAPSHOT_DATE = NOW − 1 day` (the "current" cohort snapshot). **Causal chain**: stable cohorts before −3w → checkout change ships at −3w → affected Android/Gen-Z cohorts' conversion slides −3w to −1w while iOS holds → the CURRENT snapshot shows the sliding cluster. Peak of the divergence (the steepest slide) sits in the past week-and-a-half, left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen`. Use the pre-provisioned databricks-connect venv (Python 3.12). Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window + `F.element_at`. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, no `raw_` prefix). SDP silver reads via `read_files()` — no bronze:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_segments` | ~500 | Segment cohort master. `cohort` (demographic — `gen_z/millennial/gen_x/boomer`), `platform` (`ios/android/web`), `region`, `mau` (cohort size), plus a searchable **`segment_summary`** (cohort + platform + recent behavior — the text Lakebase Search indexes). `SEG-0000214` pinned as the Gen-Z/Android hero. |
| `raw_experiments` | ~60 | Experiment/feature catalog: past + proposed experiments. `variant`, `feature_area` (`checkout/onboarding/discovery/pricing`), `tested_cohort`, `tested_platform`, `won` (bool — did it lift conversion), `observed_lift`, plus a searchable **`description`** (hypothesis + result) — indexed by **Lakebase Search**; the **ship-variant** play queries it for a proven match. |
| `raw_events` | ~3.5M | 18 months of clickstream/app events (one row per session — sampled). `event_date`, `segment_id` (FK), `session_id`, `converted` (bool), `revenue_usd`. The conversion slide on the affected cohorts lives here. |
| `raw_feature_flags` | ~5K | Current feature-flag state per (segment, feature_area). `flag_key`, `variant`, `rollout_pct`, `updated_date`. The served state the product reads — and the writable target the app updates. |
| `raw_conv_snapshots` | ~120K | Daily `conversion_rate` for the affected cohorts across the last ~14 days + a current-snapshot sample of healthy cohorts. Affected → slid to 2.5–3%; healthy → 3.5–4.5%. Carries `pm_note_text` (the `ai_classify` signal). |
| `raw_experiment_outcomes` | ~35K | 18-month history of feature ships to sliding cohorts, each with an OUTCOME (`conversion_lift`, `users_recovered`, `ship_cost_usd`) — the **training data for the conversion-lift model** (`03-ml-conversion.md`). ~3 action types: `ship_proven_variant`, `ship_alt_variant`, `rollout_existing_flag`. |

### Data Variation

Events + conversion — the load-bearing shape is the **affected-cohort conversion slide**, but everyday cohorts need realistic rhythm:
- **Weekly rhythm** — sessions + conversions peak on weekends; ±15% noise.
- **Baseline conversion** — most cohorts sit at a stable 3.5–4.5%. Keep it calm so the slide dominates.
- **Platform mix** — iOS slightly higher baseline than Android; keep the gap gentle so the anomaly (a SHARP Android/Gen-Z slide) reads as an event, not a baseline.

**The conversion-slide split (the whole story):** conversion is **cohort-and-change-driven**, not uniform. The checkout change pushes the ~40 affected Android/Gen-Z cohorts from ~4% to ~2.5–3% over ~3 weeks; everyone else stays stable (iOS even ticks up). This single rule produces the red sliding cluster without forcing it.

### Note pool (`pm_note_text` on conv snapshots)

~15 hand-coded strings in 2 tones. **Slide** (must include the Shared-Context phrases verbatim): attached predominantly to the affected cohorts. **Healthy**: "converting to plan", "funnel healthy, no regressions". **Distribution**: affected → 85% slide-tone / 15% healthy · healthy cohorts → 10% slide-tone / 90% healthy.

### Segment master

Each cohort has `cohort` × `platform` × `region` + a `mau` (size). The ~40 affected cohorts are Android (+ some web) across Gen-Z / millennial; `SEG-0000214` pinned to Gen-Z/Android with a large MAU. No geo lat/lng needed — the dashboard hook is a conversion×size scatter, not a map (region is a filter dim).

### The Event

- **Affected cohorts** (~40): `conversion_rate` slides from ~4% starting `SLIDE_RAMP`, dropping to 2.5–3% over ~10 days, still sliding. Each has a matching proven experiment. Notes slide-toned.
- **Healthy cohorts** (~500 total): conversion 3.5–4.5%, notes healthy.
- **Everything else** normal — the slide is confined to the affected cohorts.

Quantify the exposure so the KPIs land: **conversion-at-risk exposure** ≈ **$10M annualized** (`SUM(mau × conversion_drop × per_conversion_revenue($8) × 12)` over the ~40 affected cohorts — a believable annualized figure at these cohort sizes; the README frames it as ~$4M/yr per 1pt of overall conversion, talking-track); **conversion gap** — healthy ~4% vs sliding ~2.8%. Demo targets — roll up roughly to them.

**Experiment-outcome history (`raw_experiment_outcomes`) — the model's training signal.** Over 18 months, generate realistic feature ships to sliding cohorts with outcomes so the model in `03-ml-conversion.md` can learn which action lifts conversion most for which cohort:
- `ship_proven_variant` (ship a variant that WON a past experiment for a similar cohort): moderate cost; **best when a matching proven experiment exists** (the hero case) — the lift transfers.
- `ship_alt_variant` (ship an untested alternative): moderate cost; lower expected lift + higher variance (it's a guess) — wins only when no proven variant exists.
- `rollout_existing_flag` (expand a flag that lifted a NEIGHBORING cohort): low cost; a smaller but reliable lift — wins when the neighboring-cohort signal is strong but there's no exact-match experiment.
- Make outcomes **learnable**: ship_proven_variant on cohorts WITH a matching proven experiment shows the best `conversion_lift` per `ship_cost`; rollout_existing_flag on cohorts with a strong neighbor; ship_alt_variant is the fallback. This lets the model rank `SEG-0000214` (matching proven experiment exists) as **ship_proven_variant**.

### Raw table schemas (gen output)

ID formats: `SEG-NNNNNNN` / `EXP-NNNNNNN` / `FLAG-NNNNN` / `EVT-NNNNNNNN` / `EXO-NNNNNNNN`. PKs in **bold**, FKs marked.

- **`raw_segments`** — **segment_id**, cohort (`gen_z/millennial/gen_x/boomer`), platform (`ios/android/web`), region, mau (INT), **segment_summary** (STRING — searchable), is_active.
- **`raw_experiments`** — **experiment_id**, experiment_name, variant, feature_area (`checkout/onboarding/discovery/pricing`), tested_cohort, tested_platform, won (BOOLEAN), observed_lift (DOUBLE), **description** (STRING — hypothesis + result, searchable), is_active.
- **`raw_events`** — segment_id (FK), event_date (DATE), session_id, converted (BOOLEAN), revenue_usd (DOUBLE). One row per sampled session.
- **`raw_feature_flags`** — **flag_id**, segment_id (FK), feature_area, flag_key, variant, rollout_pct (INT), updated_date (DATE). Current flag state.
- **`raw_conv_snapshots`** — segment_id (FK), snapshot_date (DATE), conversion_rate (DOUBLE), sessions (INT), pm_note_text (STRING, nullable). Daily last ~14 days + `SNAPSHOT_DATE`.
- **`raw_experiment_outcomes`** — **outcome_id**, segment_id (FK), action_type (`ship_proven_variant/ship_alt_variant/rollout_existing_flag`), had_matching_experiment (BOOLEAN), conversion_at_action (DOUBLE), initiated_date (DATE), ship_cost_usd (DOUBLE), conversion_lift (DOUBLE), users_recovered (INT). 18-month history — the model's labeled outcomes.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md`.

Create pipeline `nimbus_growth_360`. Configure with `configuration: {catalog, schema}` and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')`.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (conversion-at-risk $, conversion gap, sliding # ) + trend | conversion/user exposure by cohort + platform + conv band | `mv_segment_conv` metric view (over `gold_segment_position`) |
| Dashboard scatter + at-risk widgets | per cohort current position with cohort + platform + conversion + MAU + band flag | `gold_segment_position` |
| Genie "which segments are sliding and why" | same per-cohort fact with denormalized experiment + note | `gold_segment_position` |
| Conversion model training | one row per historical ship + features + outcome | `gold_experiment_outcomes` |
| Conversion model scoring input | one row per SLIDING cohort + candidate-action + matching-experiment context | `gold_open_sliding` |
| App's growth queue (sliding + ranked action) | current sliding cohorts with cohort/experiment + ranked action + projected conversion lift | `gold_open_sliding` JOIN `gold_action_recommendations` |
| App's analytics drill-downs | conversion trend, worst cohorts, per-platform rollups | `silver_conv`, `gold_segment_position` |

### Raw layer (no bronze)

Section A writes 6 raw parquet datasets: `segments`, `experiments`, `events`, `feature_flags`, `conv_snapshots`, `experiment_outcomes`. SDP silver reads via `read_files()`.

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

**`note_slide_flags`** — *the `ai_classify` showcase, deduped*. Over `SELECT DISTINCT pm_note_text`, call `ai_classify(note, ARRAY('sliding','at_risk','healthy'))` once per distinct string → `slide_signal_score` (1.0/0.6/0.1). `silver_conv` joins back on the note.

**`silver_events`** — per cohort×day conversion rollup. `raw_events` GROUP BY (segment_id, event_date) → sessions, conversions, conversion_rate, revenue. JOIN `raw_segments`. Cluster by `event_date`.
**`silver_conv`** — current + recent conversion position. `raw_conv_snapshots` JOIN `raw_segments` JOIN `note_slide_flags`. Cluster by `snapshot_date`.
**`silver_flags`** — current flag state per (segment, feature_area).
**`silver_experiment_outcomes`** — ship-outcome history denormalized. Powers the model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every dashboard aggregate MUST carry `cohort`, `platform`, and `conv_band`.

**`gold_segment_position`** — *the heart* — one row per cohort reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with cohort, platform, conversion, MAU, band. Built from `silver_conv` (current) JOIN a `silver_events` recent rollup on `segment_id`. Dims: `segment_id`, `cohort`, `platform`, `region`, `segment_summary`, `mau`. Fields: `conversion_rate`, `conversion_rate_3w_ago` (from the oldest snapshot in the window — the baseline), `conversion_drop` (baseline − current), `sessions`, `slide_signal_score`, and derived measures + a status flag:
- `conversion_at_risk_usd` — for sliding cohorts: `mau × conversion_drop × per_conversion_revenue(demo ~$8) × 12` (annualized) when `conv_band IN ('sliding','watch')` else 0 — the revenue leaking from the slide.
- **`conv_band`** (the single column the UI colors by): `'sliding'` (`conversion_drop ≥ 0.01` AND `conversion_rate < 0.032`), `'watch'` (`conversion_drop ≥ 0.005`), `'healthy'` (else). The affected cohorts → `sliding`.

> `gold_segment_position` is the coherence spine — dashboard, metric view, Genie, and the app all read it.

**`gold_open_sliding`** — `gold_segment_position WHERE conv_band IN ('sliding','watch')`, enriched with candidate-action + matching-experiment context: whether a **matching proven experiment** exists for the SAME `cohort` + `platform` (`has_matching_experiment` bool = a `won` checkout experiment `tested_cohort=cohort AND tested_platform=platform` exists, `matching_experiment_id`, that experiment's `observed_lift`) — this is what makes the `web`-platform sliding cohorts (no matching won experiment) fall to the flag-rollout path; a candidate neighboring flag (`neighbor_flag_key`); and the cohort's `mau`. Columns: cohort/platform + `conversion_rate`, `conversion_drop`, `conversion_at_risk_usd`, `mau`, `has_matching_experiment`, `matching_experiment_id`, `matching_experiment_lift`, `neighbor_flag_key`.

**`gold_experiment_outcomes`** — ship history, one row per action. Pass-through from `silver_experiment_outcomes` + features: `action_type`, `had_matching_experiment`, `conversion_at_action`, `ship_cost_usd`, `conversion_lift`, `users_recovered`. The heuristic's coefficient source + the OPTIONAL ML training table.

**`gold_action_recommendations`** — *the ranked feature action per sliding cohort* — **built by the pipeline HEURISTIC** (ML optional, `03-ml-conversion.md`). For each row in `gold_open_sliding`, construct the three candidate actions and rank by **net value = users_recovered_value − ship_cost**, where `users_recovered_value = conversion_lift × mau × per_conversion_revenue($8) × 12`:
- **ship_proven_variant**: `conversion_lift ≈ matching_experiment_lift × 0.7 if has_matching_experiment else 0.003`; `ship_cost ≈ 5000` (build + rollout). **Best when a matching proven experiment exists** (the lift transfers) — the hero.
- **rollout_existing_flag**: `conversion_lift ≈ 0.006` (a smaller, reliable lift from a neighboring cohort's flag); `ship_cost ≈ 500`. Wins when there's a strong neighbor but NO exact-match experiment.
- **ship_alt_variant**: `conversion_lift ≈ 0.004` (an untested guess, lower + riskier); `ship_cost ≈ 5000`. The fallback — wins only when neither of the above applies.
- `net_value = conversion_lift × mau × 8 × 12 − ship_cost`; `recommended_action` = argmax; `action_ranking` = JSON array of all three with `conversion_lift`/`net`/`cost`. Columns match `03-ml-conversion.md` → Inference shape. Coefficients mirror `gold_experiment_outcomes`, so **ship_proven_variant wins for `SEG-0000214`** (a matching experiment exists) while rollout_existing_flag wins on no-match cohorts — a plausible mix.

### Consumer routing

- `mv_segment_conv` (over `gold_segment_position`) → dashboard KPIs + Genie headline answers.
- `gold_segment_position` → dashboard scatter + sliding/platform widgets.
- `gold_open_sliding` → model scoring input AND (joined with output) the app's growth queue.
- `gold_action_recommendations` → app's growth queue + dashboard action widgets.
- `gold_experiment_outcomes` → heuristic coefficients + OPTIONAL ML training.
- `silver_conv` → app analytics drill-downs.

---

## C. Validation

Run before `03-ml-conversion.md`.

**Load-bearing (must pass):**
- **The hero cohort exists** — `gold_segment_position WHERE segment_id='SEG-0000214'` → `conv_band = 'sliding'`, `conversion_rate` low (~0.029), `conversion_drop` ≥ 0.01, `cohort='gen_z'`, `platform='android'`, `conversion_at_risk_usd > 0`.
- **The hero has a matching experiment** — `gold_open_sliding WHERE segment_id='SEG-0000214'` → `has_matching_experiment = true`, `matching_experiment_id` present, `matching_experiment_lift` positive. The ship-proven-variant story must be true in the data.
- **Sliding cluster** — `gold_segment_position` GROUP BY `platform`, `conv_band`: sliding cohorts are overwhelmingly android/web; ~40 sliding total.
- **Anomaly confined** — the vast majority of cohorts are `healthy`; iOS doesn't slide.
- **Exposure KPIs land** — `SUM(conversion_at_risk_usd)` ≈ $10M annualized (the ~$4M/yr in the README is the per-1pt-of-overall-conversion talking-track); conversion gap healthy ~4% vs sliding ~2.8% (±20% OK).
- **`slide_signal_score` separates** — affected sliding ≥ 0.6; healthy ≤ 0.2.
- **`note_slide_flags` dedup works** — `COUNT(DISTINCT pm_note_text) << COUNT(*)`.
- **Ship outcomes are learnable** — `gold_experiment_outcomes` GROUP BY `action_type`, `had_matching_experiment`: ship_proven_variant WITH a matching experiment shows the best `conversion_lift` per `ship_cost`; rollout_existing_flag reliable-but-smaller; ship_alt_variant the fallback. If they don't separate, regenerate.
- **Slide ramp is in the past** — daily `AVG(conversion_rate)` on affected cohorts shows the drop starting ~2.5w ago.
- **Action mix is plausible** — the heuristic produces a MIX (ship_proven_variant on matching-experiment cohorts; rollout_existing_flag on no-match), not 100% one type.

**Smoke checks**: `platform` in `{ios, android, web}`; `conv_band` enum is the 3 values; `conversion_rate` in [0,1]; `gold_open_sliding` ~40 rows; `mau` never negative.

Add `pipeline_id` to `resources.json`.
