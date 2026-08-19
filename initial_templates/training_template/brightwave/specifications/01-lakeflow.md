# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The company**: Brightwave — a ~$1B consumer brand (~$200M annual media spend, ~120-person marketing org, dozens of concurrent campaigns). The demo samples ~2,000 campaigns over 18 months so joins stay cheap.

**The entity + the anomaly's two sides**: the demo is about **campaigns**, not people. A cluster of campaigns has sharply diverging ROAS: a set of **winners** (high ROAS on a specific channel + creative + targeting combination) and a set of **underperformers** (low ROAS, burning ~20% of paid spend). The story is *"replicate what's working across what isn't, while the quarter is still in play."*

**The channel/creative catalog** carries a searchable **`description`** (the creative angle, channel, audience, why it works) — the text **Lakebase Search** (Milestone 2) indexes, and what the app's "why is this winning" search + the **replicate-winner** play query run over (matching an underperformer to a transferable winning creative/channel + grounding on-brand copy).

**Hero campaign**: `CMP-0000214` — an active **underperformer** (ROAS ~1.1 against a winners portfolio near 4.0), on a channel/creative combo that a proven winner (`CMP-0000009`) beats. The demo's spotlight. Deterministic. The recommended play the heuristic ranks first is **replicate_winner** — because a matching winner exists whose channel + creative are transferable to the underperformer's audience, so the projected ROAS lift beats reallocating the budget away or pausing.

**The anomaly (one dynamic, two visible symptoms)**: over the current quarter (last ~3 weeks the divergence sharpened), a cluster of campaigns split into winners and underperformers on the SAME categories:
- **Winner side** — ~60 campaigns with **high ROAS** (~3.5–5.0) driven by a specific channel + creative + targeting combination (shown GREEN).
- **Underperformer side** — ~90 active campaigns with **low ROAS** (~0.8–1.5), ~20% of paid spend, still running (shown RED).
- **Healthy/steady side** — the rest of the ~2,000 campaigns sit at a normal ~1.8–2.8 ROAS (shown STEEL/blue).

This is the load-bearing shape: **the same brand, the same categories, winners and underperformers side by side, ~20% of spend recoverable while the quarter is in play** — legible on one view (a ROAS × spend scatter, a red cluster low + a green cluster high). The recommended action ("replicate the winner") is literally supported by the data because a proven winner with a transferable channel/creative exists for the underperformer's segment.

**Performance-signal notes** (verbatim marketer/campaign-review-note phrases, used predominantly on the affected campaigns — feed the note pool so `ai_classify` has a clear signal). Winner tone: *"crushing it on this creative, scale it"*, *"best ROAS in the portfolio"*. Underperformer tone: *"spend leaking, ROAS below target"*, *"creative not landing with this audience"*, *"consider pausing or reworking"*, *"budget better spent elsewhere"*. These must be exact substrings — Genie + the dashboard search for them.

**Brand posture (the marketing-specific teaching point)**: the story is about acting **on-brand** — the recommendation grounds on the brand's own winning creatives (via Lakebase Search over the creative catalog), and the assistant's content-generation AI spend is the fastest-growing slice, so the AI Gateway caps it + keeps output attributable. No PII here; the sensitivity is brand + budget.

**Time references**: `NOW = datetime.now()` by default (rolling; set `BRIGHTWAVE_PIN_TIME=1` to freeze). `HISTORY_START = NOW − 18 months` (campaign + spend + conversion history). `QUARTER_START = NOW − 60 days` (the current quarter's campaigns launch). `DIVERGENCE_RAMP = NOW − 21 days` (~3 weeks back — the winner/underperformer ROAS divergence sharpens). `SNAPSHOT_DATE = NOW − 1 day` (the "current" campaign snapshot). **Causal chain**: steady portfolio before the quarter → quarter's campaigns launch at −60d → the winner/underperformer divergence sharpens −3w to −1w as spend accumulates and attribution resolves → the CURRENT snapshot shows both clusters. Peak of the divergence sits in the past week-and-a-half, left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen`. Use the pre-provisioned databricks-connect venv (Python 3.12). Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window + `F.element_at`. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, no `raw_` prefix). SDP silver reads via `read_files()` — no bronze:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_campaigns` | ~2,000 | Campaign master. `channel` (`social/search/display/video/email`), `creative_id` (FK), `target_segment`, `category` (product category), `launch_date`, `status` (`active/completed/paused`), `budget_usd`, plus a searchable **`campaign_summary`** (channel + creative angle + audience — the text Lakebase Search indexes). `CMP-0000214` pinned as the active underperformer; `CMP-0000009` as its matching winner. |
| `raw_creatives` | ~400 | Creative catalog: the ad creatives campaigns use. `creative_type` (`image/video/carousel/copy`), `angle` (`lifestyle/promo/testimonial/product`), plus a searchable **`description`** (the creative angle + why it works) — indexed by **Lakebase Search**; the **replicate-winner** play queries it. |
| `raw_ad_spend` | ~3.5M | Daily campaign×channel ad spend + delivery, 18 months. One row per (campaign, spend_date) with `spend_usd`, `impressions`, `clicks`. The affected campaigns' spend accumulates over the quarter. |
| `raw_conversions` | ~1.2M | Daily campaign conversions + revenue. One row per (campaign, conv_date) with `conversions`, `revenue_usd`. The ROAS divergence (revenue/spend) lives in the join of this + ad_spend. |
| `raw_attribution` | ~250K | Media-mix + attribution outputs per campaign (the modeled contribution). `attributed_revenue_usd`, `incrementality_score`, `attribution_model`. Resolves over the quarter — the "landed too late" signal. |
| `raw_perf_snapshots` | ~120K | Daily `roas` + `perf_band` inputs for the affected campaigns across the last ~14 days + a current-snapshot sample of steady campaigns. Affected winners → ROAS 3.5–5; underperformers → 0.8–1.5; steady → 1.8–2.8. Carries `review_note_text` (the `ai_classify` signal). |
| `raw_campaign_actions` | ~35K | 18-month history of actions taken on campaigns, each with an OUTCOME (`roas_lift`, `revenue_impact_usd`, `action_cost_usd`) — the **training data for the ROAS-lift model** (`03-ml-roas.md`). ~3 action types: `replicate_winner`, `reallocate_budget`, `pause`. |

### Data Variation

Spend + ROAS — the load-bearing shape is the **winner/underperformer ROAS divergence**, but everyday campaigns need realistic rhythm:
- **Weekly rhythm** — spend + conversions dip on weekends; ±15% noise.
- **Baseline ROAS** — most campaigns sit at a steady 1.8–2.8 ROAS. Keep it calm so the divergence dominates.
- **Seasonal** — a gentle spend uptick around key retail windows, placed so it doesn't collide with the affected-cohort signal.

**The winner/underperformer split (the whole story):** ROAS is **channel+creative+targeting-driven**, not uniform. The quarter's cluster splits into ~60 winners (high ROAS on a specific combo) and ~90 underperformers (low ROAS) on the same categories; everyone else stays steady. This single rule produces the two clusters without forcing it.

### Note pool (`review_note_text` on perf snapshots)

~15 hand-coded strings in 2 tones. **Winner** + **Underperformer** (must include the Shared-Context phrases verbatim): attached predominantly to the affected campaigns by side. **Healthy**: "performing to plan", "steady spend". **Distribution**: affected underperformers → 85% underperformer-tone / 15% healthy · winners → 85% winner-tone / 15% healthy · steady → 10% affected-tone / 90% healthy.

### Campaign master

Each campaign has a `category` + `channel` + `creative_id` + `target_segment`. The ~60 winners cluster on a specific (channel, creative angle) combo; the ~90 underperformers on a different, weaker combo in the SAME categories. `CMP-0000214` pinned as an underperformer whose category + segment MATCH winner `CMP-0000009` (so the winner's creative is transferable). No geo needed — the dashboard hook is a ROAS×spend scatter, not a map.

### The Event

- **Winners** (~60): `roas` ramps to 3.5–5.0 over the quarter, high `attributed_revenue`, winner-tone notes. Their (channel, creative angle) combo is the transferable pattern.
- **Underperformers** (~90, active): `roas` 0.8–1.5, ~20% of total paid spend, still running (`status='active'`), underperformer-tone notes. `CMP-0000214` is one.
- **Steady campaigns** (~2,000 total): ROAS 1.8–2.8, notes healthy.
- **Everything else** normal — the divergence is confined to the affected campaigns.

Quantify the exposure so the KPIs land: **recoverable spend** ≈ **$40M** (the ~20% of the $200M annual media spend sitting in underperformers — talking-track; the SAMPLED figure is `SUM(spend)` on the ~90 sampled active underperformers, roughly **$3–5M** over the quarter); **ROAS gap** — winners ~4.0 vs underperformers ~1.1. Demo targets — roll up roughly to them.

**Campaign-action history (`raw_campaign_actions`) — the model's training signal.** Over 18 months, generate realistic actions with outcomes so the model in `03-ml-roas.md` can learn which action lifts ROAS most for which situation:
- `replicate_winner` (apply a winning campaign's channel/creative to an underperformer): moderate cost; **best when a matching winner exists in the same category/segment** (the hero case) — the pattern transfers.
- `reallocate_budget` (shift the underperformer's budget to a proven winner): low cost; captures the winner's ROAS on the moved dollars, but abandons the underperformer's audience — wins when no transferable winner exists for THAT segment.
- `pause` (stop the campaign): zero cost, zero lift, just stops the bleed — the floor option, best only when the campaign is hopeless.
- Make outcomes **learnable**: replicate_winner on underperformers WITH a matching winner shows the best `roas_lift` per `action_cost`; reallocate wins when no match; pause is the floor. This lets the model rank `CMP-0000214` (matching winner exists) as **replicate_winner**.

### Raw table schemas (gen output)

ID formats: `CMP-NNNNNNN` / `CRE-NNNNN` / `ACT-NNNNNNNN`. PKs in **bold**, FKs marked.

- **`raw_campaigns`** — **campaign_id**, campaign_name, channel (`social/search/display/video/email`), creative_id (FK), target_segment, category, launch_date (DATE), status (`active/completed/paused`), budget_usd (DOUBLE), **campaign_summary** (STRING — searchable), is_active.
- **`raw_creatives`** — **creative_id**, creative_name, creative_type (`image/video/carousel/copy`), angle (`lifestyle/promo/testimonial/product`), **description** (STRING — searchable), is_active.
- **`raw_ad_spend`** — campaign_id (FK), spend_date (DATE), spend_usd (DOUBLE), impressions (INT), clicks (INT). One row per campaign×day.
- **`raw_conversions`** — campaign_id (FK), conv_date (DATE), conversions (INT), revenue_usd (DOUBLE). One row per campaign×day.
- **`raw_attribution`** — campaign_id (FK), as_of_date (DATE), attributed_revenue_usd (DOUBLE), incrementality_score (DOUBLE 0–1), attribution_model (STRING). Modeled contribution per campaign.
- **`raw_perf_snapshots`** — campaign_id (FK), snapshot_date (DATE), roas (DOUBLE), spend_to_date_usd (DOUBLE), review_note_text (STRING, nullable). Daily last ~14 days + `SNAPSHOT_DATE`.
- **`raw_campaign_actions`** — **action_id**, campaign_id (FK), action_type (`replicate_winner/reallocate_budget/pause`), had_matching_winner (BOOLEAN), roas_at_action (DOUBLE), initiated_date (DATE), action_cost_usd (DOUBLE), roas_lift (DOUBLE), revenue_impact_usd (DOUBLE). 18-month history — the model's labeled outcomes.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md`.

Create pipeline `brightwave_campaign_360`. Configure with `configuration: {catalog, schema}` and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')`.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (recoverable spend $, ROAS gap, underperformer #) + trend | ROAS/spend exposure by channel + category + perf band | `mv_campaign_perf` metric view (over `gold_campaign_position`) |
| Dashboard scatter + at-risk widgets | per campaign current position with channel + category + ROAS + spend + band flag | `gold_campaign_position` |
| Genie "which campaigns are winning and why" | same per-campaign fact with denormalized creative + note | `gold_campaign_position` |
| ROAS-lift model training | one row per historical action + features + outcome | `gold_action_outcomes` |
| ROAS-lift model scoring input | one row per active UNDERPERFORMER + candidate-action + matching-winner context | `gold_open_underperformers` |
| App's campaign queue (underperformers + ranked action) | current underperformers with campaign/creative + ranked action + projected ROAS lift | `gold_open_underperformers` JOIN `gold_action_recommendations` |
| App's analytics drill-downs | ROAS trend, worst campaigns, per-channel rollups | `silver_perf`, `gold_campaign_position` |

### Raw layer (no bronze)

Section A writes 7 raw parquet datasets: `campaigns`, `creatives`, `ad_spend`, `conversions`, `attribution`, `perf_snapshots`, `campaign_actions`. SDP silver reads via `read_files()`.

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

**`note_perf_flags`** — *the `ai_classify` showcase, deduped*. Over `SELECT DISTINCT review_note_text`, call `ai_classify(note, ARRAY('winner','underperformer','healthy'))` once per distinct string → `perf_signal` (`'winner'`/`'underperformer'`/`'healthy'`) + a `signal_score`. `silver_perf` joins back on the note.

**`silver_spend`** — per campaign×day spend + conversions denormalized. `raw_ad_spend` JOIN `raw_conversions` (on campaign_id, date) JOIN `raw_campaigns`. Daily ROAS = revenue/spend. Cluster by `spend_date`.
**`silver_perf`** — current + recent perf position. `raw_perf_snapshots` JOIN `raw_campaigns` JOIN `raw_creatives` JOIN `note_perf_flags`. Cluster by `snapshot_date`.
**`silver_attribution`** — latest attribution per campaign.
**`silver_actions`** — action history denormalized. Powers the model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every dashboard aggregate MUST carry `channel`, `category`, and `perf_band`.

**`gold_campaign_position`** — *the heart* — one row per campaign reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with channel, category, ROAS, spend, band. Built from `silver_perf` (current) JOIN a `silver_spend` rollup + `silver_attribution` on `campaign_id`. Dims: `campaign_id`, `campaign_name`, `channel`, `category`, `target_segment`, `creative_id`, `creative_angle`, `campaign_summary`, `status`. Fields: `roas`, `spend_to_date_usd`, `attributed_revenue_usd`, `incrementality_score`, `perf_signal`, and derived measures + a status flag:
- `recoverable_spend_usd` — for active underperformers: `spend_to_date_usd` when `perf_band = 'underperformer'` else 0 — the spend that could be redirected.
- **`perf_band`** (the single column the UI colors by): `'winner'` (`roas ≥ 3.0`), `'underperformer'` (`roas < 1.5` AND `status='active'`), `'steady'` (`roas` in [1.5, 3.0)), `'paused'` (`status='paused'`). The affected winners → `winner`, the affected underperformers → `underperformer`.

> `gold_campaign_position` is the coherence spine — dashboard, metric view, Genie, and the app all read it.

**`gold_open_underperformers`** — `gold_campaign_position WHERE perf_band = 'underperformer'`, enriched with candidate-action + matching-winner context: whether a **matching winner** exists in the same `category` + `target_segment` (`has_matching_winner` bool, `matching_winner_campaign_id`, that winner's `roas` + `creative_id`), the candidate `reallocate_target_campaign_id` (a top winner), and the underperformer's `spend_to_date_usd`. Columns: campaign/channel/category + `roas`, `recoverable_spend_usd`, `has_matching_winner`, `matching_winner_campaign_id`, `matching_winner_roas`, `reallocate_target_campaign_id`.

**`gold_action_outcomes`** — action history, one row per action. Pass-through from `silver_actions` + features: `action_type`, `had_matching_winner`, `roas_at_action`, `action_cost_usd`, `roas_lift`, `revenue_impact_usd`. The heuristic's coefficient source + the OPTIONAL ML training table.

**`gold_action_recommendations`** — *the ranked action per active underperformer* — **built by the pipeline HEURISTIC** (ML optional, `03-ml-roas.md`). For each row in `gold_open_underperformers`, construct the three candidate actions and rank by **net value = revenue_impact − action_cost**, where `revenue_impact = roas_lift × spend_to_date`:
- **replicate_winner**: `roas_lift ≈ (matching_winner_roas − roas) × 0.6 if has_matching_winner else 0.1`; `action_cost ≈ 2000` (creative rework). **Best when a matching winner exists** (the pattern transfers) — the hero.
- **reallocate_budget**: `roas_lift ≈ (portfolio_top_roas − roas) × 0.5` (the moved dollars earn the winner's ROAS, but you abandon this audience); `action_cost ≈ 200`. Wins when NO matching winner exists for this segment.
- **pause**: `roas_lift ≈ 0` (just stops the bleed — the recoverable spend isn't lost further, but no upside); `action_cost ≈ 0`. The floor — wins only when both others are negative (a hopeless campaign).
- `net_value = roas_lift × spend_to_date − action_cost`; `recommended_action` = argmax; `action_ranking` = JSON array of all three with `roas_lift`/`net`/`cost`. Columns match `03-ml-roas.md` → Inference shape. Coefficients mirror `gold_action_outcomes`, so **replicate_winner wins for `CMP-0000214`** (a matching winner exists) while reallocate wins on no-match underperformers — a plausible mix.

### Consumer routing

- `mv_campaign_perf` (over `gold_campaign_position`) → dashboard KPIs + Genie headline answers.
- `gold_campaign_position` → dashboard scatter + winner/underperformer widgets.
- `gold_open_underperformers` → model scoring input AND (joined with output) the app's campaign queue.
- `gold_action_recommendations` → app's campaign queue + dashboard action widgets.
- `gold_action_outcomes` → heuristic coefficients + OPTIONAL ML training.
- `silver_perf` → app analytics drill-downs.

---

## C. Validation

Run before `03-ml-roas.md`.

**Load-bearing (must pass):**
- **The hero campaign exists** — `gold_campaign_position WHERE campaign_id='CMP-0000214'` → `perf_band = 'underperformer'`, `roas` low (~1.1), `status = 'active'`, `recoverable_spend_usd > 0`.
- **The hero has a matching winner** — `gold_open_underperformers WHERE campaign_id='CMP-0000214'` → `has_matching_winner = true`, `matching_winner_campaign_id` present (e.g. `CMP-0000009`), `matching_winner_roas` high (~4.0). The replicate story must be true in the data.
- **Winner/underperformer split** — `gold_campaign_position` GROUP BY `perf_band`: ~60 winners, ~90 underperformers, the rest steady/paused.
- **Anomaly confined** — the vast majority of campaigns are `steady`; the divergence doesn't bleed everywhere.
- **Exposure KPIs land** — `SUM(recoverable_spend_usd)` on active underperformers ≈ $3–5M on the sample (the $40M is the full-year-budget talking-track); ROAS gap winners ~4.0 vs underperformers ~1.1 (±20% OK).
- **`perf_signal` separates** — winners classify `winner`, underperformers `underperformer`, steady `healthy` (via `ai_classify`).
- **`note_perf_flags` dedup works** — `COUNT(DISTINCT review_note_text) << COUNT(*)`.
- **Action outcomes are learnable** — `gold_action_outcomes` GROUP BY `action_type`, `had_matching_winner`: replicate_winner WITH a matching winner shows the best `roas_lift` per `action_cost`; reallocate wins on no-match; pause is the floor. If they don't separate, regenerate.
- **Divergence ramp is in the past** — daily `AVG(roas)` on the affected clusters shows the split sharpening ~2.5w ago.
- **Action mix is plausible** — the heuristic produces a MIX (replicate_winner on matching-winner underperformers; reallocate on no-match; occasional pause), not 100% one type.

**Smoke checks**: `channel` in the 5 values; `perf_band` enum is the 4 values; `roas` never negative; `gold_open_underperformers` ~90 rows; `spend_to_date_usd` never negative.

Add `pipeline_id` to `resources.json`.
