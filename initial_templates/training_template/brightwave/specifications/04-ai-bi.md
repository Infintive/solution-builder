# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-roas.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products** — do **not** build resources for these: **Databricks One**, **Genie Code**, **Unity Catalog** / **Unity AI Gateway**.

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md`.

Create `Brightwave Campaign Performance` Genie Space.

### Tables

`mv_campaign_perf` (canonical performance metric view over `gold_campaign_position`), `gold_campaign_position` (per-campaign current position: channel, category, ROAS, spend, `perf_band`), `gold_open_underperformers` (active underperformers + matching-winner context), `gold_action_recommendations` (the ranked action per underperformer + predicted ROAS lift), `raw_creatives` (creative catalog), `raw_campaigns` (campaign master).

### Self-sufficient room

- **Space `description`** (via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the dynamic (winners vs underperformers on the same categories, ~20% of spend recoverable mid-quarter) + the headline numbers + the replicate angle. Lift from the README.
- **Story-context `text_instruction`** at the TOP: WHAT'S HAPPENING · WHAT TO HELP PRIYA DO · TONE. ~5-8 lines.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc.

### Instructions

```
You analyze Brightwave campaign-performance data for Priya Anand (CMO, non-technical).

CONTEXT: Over the current quarter a cluster of campaigns split into WINNERS (high ROAS ~4.0 on a
specific social + lifestyle-creative combo) and UNDERPERFORMERS (low ROAS ~1.1, ~20% of paid spend,
still running) on the SAME categories. The goal is to replicate what's working across what isn't,
while the quarter is still in play. The rest of the ~2,000-campaign portfolio is steady (~2.3 ROAS).

BASELINES: perf_band is the single signal: 'winner' (roas >= 3.0), 'underperformer' (roas < 1.5,
active), 'steady' (1.5-3.0), 'paused'.

HEADLINE NUMBERS — always answer from mv_campaign_perf:
- "How much spend is recoverable?" → MEASURE(recoverable_spend)
- "How many underperformers?" → MEASURE(underperformer_count)
- "What's the ROAS gap?" → MEASURE(avg_roas) by perf_band (winner ~4.0 vs underperformer ~1.1)

INVESTIGATION FLOW for "which campaigns are winning and why?":
1. mv_campaign_perf → MEASURE(winner_count) + MEASURE(underperformer_count) by channel → social winners, display underperformers
2. gold_campaign_position → winners cluster on a channel+creative combo (GROUP BY channel, perf_band)
3. gold_open_underperformers WHERE campaign_id='CMP-0000214' → the hero: low ROAS, a matching winner exists
4. gold_action_recommendations → the recommended action (replicate_winner/reallocate_budget/pause) + predicted ROAS lift
Conclude + suggest: "Want me to rank the action for CMP-0000214?"

ACTION FOLLOW-UP:
- "What should I do with CMP-0000214?" → gold_action_recommendations → recommended_action + predicted_roas_lift + the action_ranking options.
- "How much ROAS lift could we capture across all underperformers?" → SUM over gold_action_recommendations.
- "How many underperformers should we replicate a winner vs reallocate?" → GROUP BY recommended_action.
```

### Sample Questions — 7-step story arc

1. **Headline** — "How much spend is recoverable right now, and how many underperformers?" → `MEASURE(recoverable_spend)` + `MEASURE(underperformer_count)` from `mv_campaign_perf`.
2. **The split** — "What's the ROAS gap between winners and underperformers?" → `MEASURE(avg_roas)` GROUP BY `perf_band`.
3. **Why they win** — "What channel are the winners on?" → `gold_campaign_position` GROUP BY `channel`, `perf_band` → winners on social.
4. **The hero campaign** — "CMP-0000214 is underperforming — is there a winner I can copy?" → `gold_open_underperformers WHERE campaign_id='CMP-0000214'` → low ROAS, `has_matching_winner = true`.
5. **The recommendation** — "What should I do with CMP-0000214, and how much lift?" → `gold_action_recommendations` → `recommended_action = 'replicate_winner'`, `predicted_roas_lift`, the ranked options.
6. **Portfolio impact** — "Across all underperformers, how much ROAS lift could we capture, and by which action?" → `gold_action_recommendations` GROUP BY `recommended_action`.
7. **Reallocate side** — "Which underperformers have no matching winner and should be reallocated?" → `gold_action_recommendations WHERE recommended_action='reallocate_budget'` JOIN `gold_open_underperformers`.

### Validation

"How much spend is recoverable?" → from `mv_campaign_perf` (`MEASURE(recoverable_spend)`), matches the dashboard tile. "Which campaigns win?" → social+lifestyle winners. "CMP-0000214?" → replicate_winner with a ROAS-lift figure. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md`. The skill owns the JSON shape; this spec is story-level.

Create `Brightwave Campaign Performance` dashboard. Save at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less**. Link the Genie space. (Save the Genie space at the project root too — `./genie_space.json`.)

### Why this dashboard works

- **Two pages, one story**: page 1 the glance — *"winners and underperformers side by side; here's the recoverable spend and the ROAS gap."* Page 2 the deep-dive — *"which underperformers, do they have a matching winner, and what the model recommends."*
- **One metric view + two datasets**: `mv_campaign_perf` (KPI tiles + channel splits), `gold_campaign_position` (the ROAS×spend scatter, channel/category rollups), `gold_action_recommendations` (action-mix + ROAS-lift widget).
- **A ROAS×spend scatter is the visual hook**: full-width scatter — x = `spend_to_date_usd`, y = `roas`, color = `perf_band` — a green cluster high (winners) and a red cluster low (underperformers), the recoverable spend visible as the red mass. Instantly readable.
- **One AI showcase per page**: page 1's scatter carries the `ai_classify` performance signal; page 2 surfaces the **action recommendation**.
- **Clean theme — no borders, white canvas**: green = winner, red = underperformer, amber = steady/watch.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the dynamic.

### Theme

```
canvasBackgroundColor: #F5F7FB (light) / #0F1419 (dark)
widgetBackgroundColor: #FFFFFF (light) / #161B22 (dark)
widgetBorderColor:     same as widgetBackgroundColor
fontColor:             #1F2530 (light) / #E8ECF0 (dark)
selectionColor:        #4F7CE3 (light) / #8ACAFF (dark)
visualizationColors:   ["#094074","#3C6997","#2FB380","#FFB020","#E5484D"]
widgetHeaderAlignment: LEFT
```

**Semantic colors (literal-hex pinned, NEVER `themeColorType: position N`):** Winner → `#2FB380` green · Underperformer → `#E5484D` red · Steady → `#3C6997` steel blue · Paused → `#8A94A6` grey.

**`perf_band` color pins (on EVERY widget that colors by band):** winner `#2FB380` · underperformer `#E5484D` · steady `#3C6997` · paused `#8A94A6`.

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_perf` | `SELECT channel, category, perf_band, target_segment, MEASURE(\`recoverable_spend\`) AS recoverable_spend_usd, MEASURE(\`total_spend\`) AS total_spend_usd, MEASURE(\`avg_roas\`) AS avg_roas, MEASURE(\`winner_count\`) AS winner_count, MEASURE(\`underperformer_count\`) AS underperformer_count, MEASURE(\`campaign_count\`) AS campaign_count FROM mv_campaign_perf GROUP BY ALL` | 4 KPI counters + channel/band split bars |
| `ds_campaigns` | `SELECT campaign_id, campaign_name, channel, category, target_segment, perf_band, roas, spend_to_date_usd, recoverable_spend_usd FROM gold_campaign_position` | ROAS×spend scatter, per-channel rollups, worst-campaign tables |
| `ds_actions` | `SELECT campaign_id, recommended_action, predicted_roas_lift, predicted_net_value_usd FROM gold_action_recommendations` | Recommended-action mix + total predicted ROAS lift |

**No hardcoded clamps** — the global filters scope.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Channel | `channel` | ds_perf, ds_campaigns | All |
| Category | `category` | ds_perf, ds_campaigns | All |
| Perf band | `perf_band` | ds_perf, ds_campaigns | All |

Bind only the datasets above — **do NOT bind `ds_actions`** (keyed by underperformer).

### Page 1 — Performance (the glance)

**Row 1** — title markdown. *"Brightwave Campaign Performance. Priya Anand, CMO. This quarter a cluster of campaigns split into winners (green, high ROAS on social + lifestyle) and underperformers (red, ~20% of spend, still running). This dashboard tracks the recoverable spend and the replication opportunity."*

**Row 2 — 4 × `counter`** (`ds_perf`):
- **Recoverable spend** · `SUM(\`recoverable_spend_usd\`)` · `number-currency` USD compact · red.
- **Underperformers** · `SUM(\`underperformer_count\`)` · number compact · red.
- **Winners** · `SUM(\`winner_count\`)` · number compact · green (`#2FB380`).
- **Avg ROAS** · `AVG(\`avg_roas\`)` · number (2 decimals) · steel.

**Row 3 — `scatter` · "ROAS vs spend"** (full width). `ds_campaigns`. x = `spend_to_date_usd`, y = `roas`, color = `perf_band` (pins), size = `spend_to_date_usd`. Sample steady campaigns (`WHERE perf_band != 'steady' OR rand() < 0.1`). Tooltip: campaign_id, channel, category, roas, spend, perf_band. *The two clusters: green winners high, red underperformers low — the recoverable spend is the red mass. CMP-0000214 is the zoom target.*

**Row 4 — two side-by-side**
- **`bar` grouped · "Campaigns by channel & band"** · `ds_perf` · x = `channel`, y = `SUM(campaign_count)`, color = `perf_band` (pins) · *social carries the green winners, display the red underperformers.*
- **`bar` horizontal · "Recoverable spend by category"** · `ds_perf` · y = `category`, x = `SUM(recoverable_spend_usd)`.

### Page 2 — Replication (the deep-dive)

**Row 1** — title markdown. *"Replication — what do we do about it? The worst underperformers, whether a matching winner exists, and the model's recommended action with the ROAS lift it captures."*

**Row 2 — worst campaigns**
- **`table` · "Worst underperformers"** · `ds_campaigns` · `WHERE perf_band='underperformer'`, columns campaign_id, channel, category, roas, `recoverable_spend_usd`, sort recoverable_spend DESC · *CMP-0000214 near the top.*
- **`table` · "Top winners (the patterns to replicate)"** · `ds_campaigns` · `WHERE perf_band='winner'`, columns campaign_id, channel, category, roas, sort roas DESC.

**Row 3 — the model**
- **`bar` · "Recommended action (mix)"** · `ds_actions` · x = `recommended_action`, y = `COUNT(1)` · *replicate_winner where a matching winner exists; reallocate where none does — the model follows the data.*
- **`counter` · "Total predicted net value"** · `ds_actions` · `SUM(\`predicted_net_value_usd\`)` · `number-currency` USD compact · color `#094074`.

**Row 4 — `table` · "Action recommendations"** (full width) · `ds_actions` joined to `ds_campaigns` for names · columns campaign_id, channel, `recommended_action`, `predicted_roas_lift`, `predicted_net_value_usd`, sort net value DESC.

### Validation

Open the published dashboard and confirm: the scatter shows a green winner cluster + a red underperformer cluster, the tiles land (~$13M recoverable spend on the sample — the $40M is the full-year-budget talking-track; ROAS gap ~4.0 vs ~1.1), CMP-0000214 appears in the worst-underperformers table, the recommended-action mix is a plausible blend (replicate_winner + reallocate_budget), and the global filters update every widget. Sanity-check that Genie's "how much spend is recoverable?" matches `MEASURE(recoverable_spend)`. Add `dashboard_id` to `resources.json`.

---
