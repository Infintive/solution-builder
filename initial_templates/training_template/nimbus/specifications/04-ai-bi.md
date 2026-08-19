# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-conversion.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products** — do **not** build resources for these: **Databricks One**, **Genie Code**, **Unity Catalog** / **Unity AI Gateway**.

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md`.

Create `Nimbus Growth` Genie Space.

### Tables

`mv_segment_conv` (canonical conversion metric view over `gold_segment_position`), `gold_segment_position` (per-cohort current position: cohort, platform, conversion, MAU, `conv_band`), `gold_open_sliding` (sliding cohorts + matching-experiment context), `gold_action_recommendations` (the ranked feature action per sliding cohort + predicted conversion lift), `raw_experiments` (experiment catalog), `raw_segments` (cohort master).

### Self-sufficient room

- **Space `description`** (via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the change (checkout-flow change landed unevenly → Android/Gen-Z cohorts sliding) + the headline numbers + the ship-a-feature angle. Lift from the README.
- **Story-context `text_instruction`** at the TOP: WHAT HAPPENED · WHAT TO HELP JORDAN DO · TONE. ~5-8 lines.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc.

### Instructions

```
You analyze Nimbus growth data for Jordan Cole (VP Growth, non-technical).

CONTEXT: A checkout-flow change ~3 weeks ago landed unevenly across platforms — it hurt a cluster of
Android/Gen-Z segment cohorts (conversion sliding from ~4% to ~2.8%) while iOS held. ~40 sliding
cohorts, while the rest of the ~500-cohort base is stable. Each sliding cohort has a candidate feature
(a proven experiment variant, or a neighboring flag) that could recover it. Every week of delay is
lost conversion.

BASELINES: conv_band is the single signal: 'sliding' (conversion_drop >= 0.01 AND rate < 0.032),
'watch' (drop >= 0.005), 'healthy'. Conversion ~4% is healthy; ~2.8% is a slide.

HEADLINE NUMBERS — always answer from mv_segment_conv:
- "How much conversion is at risk?" → MEASURE(conversion_at_risk)
- "How many segments are sliding?" → MEASURE(sliding_count)
- "What's the conversion gap?" → MEASURE(avg_conversion) by conv_band (healthy ~4% vs sliding ~2.8%)

INVESTIGATION FLOW for "which segments are sliding and why?":
1. mv_segment_conv → MEASURE(sliding_count) by platform → android/web slide, ios holds
2. gold_segment_position → the sliding cluster is Android/Gen-Z on the checkout change (GROUP BY cohort, platform, conv_band)
3. gold_open_sliding WHERE segment_id='SEG-0000214' → the hero: sliding, a matching proven experiment exists
4. gold_action_recommendations → the recommended feature (ship_proven_variant/rollout_existing_flag/ship_alt_variant) + predicted conversion lift
Conclude + suggest: "Want me to rank the feature to ship for SEG-0000214?"

ACTION FOLLOW-UP:
- "Which feature should ship for SEG-0000214?" → gold_action_recommendations → recommended_action + predicted_conversion_lift + the action_ranking options.
- "How much conversion lift could we capture across all sliding cohorts?" → SUM over gold_action_recommendations.
- "How many cohorts should ship a proven variant vs roll out a flag?" → GROUP BY recommended_action.
```

### Sample Questions — 7-step story arc

1. **Headline** — "How much conversion is at risk right now, and how many segments are sliding?" → `MEASURE(conversion_at_risk)` + `MEASURE(sliding_count)` from `mv_segment_conv`.
2. **The split** — "Which platforms are sliding?" → `MEASURE(sliding_count)` GROUP BY `platform` → android/web slide, ios holds.
3. **Why they slide** — "What do the sliding cohorts have in common?" → `gold_segment_position` GROUP BY `cohort`, `platform`, `conv_band` → Gen-Z/Android on the checkout change.
4. **The hero cohort** — "SEG-0000214 is sliding — how bad, and is there a proven fix?" → `gold_open_sliding WHERE segment_id='SEG-0000214'` → sliding, `has_matching_experiment = true`.
5. **The recommendation** — "Which feature should ship for SEG-0000214, and how much lift?" → `gold_action_recommendations` → `recommended_action = 'ship_proven_variant'`, `predicted_conversion_lift`, the ranked options.
6. **Portfolio impact** — "Across all sliding cohorts, how much conversion lift could we capture, and by which action?" → `gold_action_recommendations` GROUP BY `recommended_action`.
7. **Flag-rollout side** — "Which cohorts have no proven experiment and should get a flag rollout?" → `gold_action_recommendations WHERE recommended_action='rollout_existing_flag'` JOIN `gold_open_sliding`.

### Validation

"How much conversion is at risk?" → from `mv_segment_conv` (`MEASURE(conversion_at_risk)`), matches the dashboard tile. "Which segments slide?" → Android/Gen-Z on the checkout change. "SEG-0000214?" → ship_proven_variant with a conversion-lift figure. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md`. The skill owns the JSON shape; this spec is story-level.

Create `Nimbus Growth` dashboard. Save at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less**. Link the Genie space. (Save the Genie space at the project root too — `./genie_space.json`.)

### Why this dashboard works

- **Two pages, one story**: page 1 the glance — *"a cluster of cohorts is sliding on conversion after the checkout change; here's the conversion at risk and where."* Page 2 the deep-dive — *"which cohorts, do they have a proven fix, and what the model recommends shipping."*
- **One metric view + two datasets**: `mv_segment_conv` (KPI tiles + platform splits), `gold_segment_position` (the conversion×MAU scatter, cohort/platform rollups), `gold_action_recommendations` (action-mix + lift widget).
- **A conversion×MAU scatter is the visual hook**: full-width scatter — x = `mau`, y = `conversion_rate`, color = `conv_band` — a red sliding cluster (large cohorts, low conversion) apart from the healthy mass. Instantly readable.
- **One AI showcase per page**: page 1's scatter carries the `ai_classify` slide signal; page 2 surfaces the **feature recommendation**.
- **Clean theme — no borders, white canvas**: red = sliding, amber = watch.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the change.

### Theme

```
canvasBackgroundColor: #F5F7FB (light) / #0F1419 (dark)
widgetBackgroundColor: #FFFFFF (light) / #161B22 (dark)
widgetBorderColor:     same as widgetBackgroundColor
fontColor:             #1F2530 (light) / #E8ECF0 (dark)
selectionColor:        #4F7CE3 (light) / #8ACAFF (dark)
visualizationColors:   ["#094074","#3C6997","#5ADBFF","#FFB020","#E5484D"]
widgetHeaderAlignment: LEFT
```

**Semantic colors (literal-hex pinned, NEVER `themeColorType: position N`):** Sliding → `#E5484D` red · Watch → `#FFB020` amber · Healthy → `#3C6997` steel blue.
**`conv_band` color pins:** sliding `#E5484D` · watch `#FFB020` · healthy `#3C6997`.

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_conv` | `SELECT cohort, platform, conv_band, region, MEASURE(\`conversion_at_risk\`) AS conversion_at_risk_usd, MEASURE(\`total_mau\`) AS total_mau, MEASURE(\`avg_conversion\`) AS avg_conversion, MEASURE(\`sliding_count\`) AS sliding_count, MEASURE(\`atrisk_count\`) AS atrisk_count, MEASURE(\`segment_count\`) AS segment_count FROM mv_segment_conv GROUP BY ALL` | 4 KPI counters + platform/band split bars |
| `ds_segments` | `SELECT segment_id, cohort, platform, region, conv_band, conversion_rate, conversion_drop, mau, conversion_at_risk_usd FROM gold_segment_position` | Conversion×MAU scatter, per-platform rollups, worst-cohort tables |
| `ds_actions` | `SELECT segment_id, recommended_action, predicted_conversion_lift, predicted_net_value_usd FROM gold_action_recommendations` | Recommended-action mix + total predicted lift |

**No hardcoded clamps** — the global filters scope.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Cohort | `cohort` | ds_conv, ds_segments | All |
| Platform | `platform` | ds_conv, ds_segments | All |
| Conv band | `conv_band` | ds_conv, ds_segments | All |

Bind only the datasets above — **do NOT bind `ds_actions`** (keyed by sliding cohort).

### Page 1 — Growth (the glance)

**Row 1** — title markdown. *"Nimbus Growth. Jordan Cole, VP Growth. A checkout-flow change ~3 weeks ago landed unevenly — a cluster of Android/Gen-Z cohorts is sliding on conversion (red) while iOS holds. This dashboard tracks the conversion at risk and the fix."*

**Row 2 — 4 × `counter`** (`ds_conv`):
- **Conversion at risk** · `SUM(\`conversion_at_risk_usd\`)` · `number-currency` USD compact · red.
- **Sliding segments** · `SUM(\`sliding_count\`)` · number compact · red.
- **MAU at risk** · `SUM(\`total_mau\`)` (filtered to sliding via the band filter) · number compact · amber.
- **Avg conversion** · `AVG(\`avg_conversion\`)` · percent (2 decimals) · steel.

**Row 3 — `scatter` · "Conversion vs cohort size (MAU)"** (full width). `ds_segments`. x = `mau`, y = `conversion_rate`, color = `conv_band` (pins), size = `mau`. Sample healthy cohorts (`WHERE conv_band != 'healthy' OR rand() < 0.3`). Tooltip: segment_id, cohort, platform, conversion_rate, conversion_drop, conv_band. *The red sliding cluster (large cohorts, dropped conversion) apart from the healthy mass. SEG-0000214 is the zoom target.*

**Row 4 — two side-by-side**
- **`bar` grouped · "Sliding segments by platform & band"** · `ds_conv` · x = `platform`, y = `SUM(sliding_count)`, color = `conv_band` (pins) · *android/web carry the red; ios is healthy — the change hurt those platforms.*
- **`bar` horizontal · "Conversion at risk by cohort"** · `ds_conv` · y = `cohort`, x = `SUM(conversion_at_risk_usd)`.

### Page 2 — Features (the deep-dive)

**Row 1** — title markdown. *"Features — what do we ship? The worst-sliding cohorts, whether a proven experiment exists, and the model's recommended feature with the conversion lift it captures."*

**Row 2 — worst cohorts**
- **`table` · "Worst-sliding cohorts"** · `ds_segments` · `WHERE conv_band='sliding'`, columns segment_id, cohort, platform, conversion_rate, conversion_drop, `conversion_at_risk_usd`, sort at-risk DESC · *SEG-0000214 near the top.*
- **`table` · "Watch list"** · `ds_segments` · `WHERE conv_band='watch'`, columns segment_id, cohort, platform, conversion_rate, sort conversion_drop DESC.

**Row 3 — the model**
- **`bar` · "Recommended feature action (mix)"** · `ds_actions` · x = `recommended_action`, y = `COUNT(1)` · *ship_proven_variant where a matching experiment exists; rollout_existing_flag where none does — the model follows the evidence.*
- **`counter` · "Total predicted net value"** · `ds_actions` · `SUM(\`predicted_net_value_usd\`)` · `number-currency` USD compact · color `#094074`.

**Row 4 — `table` · "Feature recommendations"** (full width) · `ds_actions` joined to `ds_segments` for names · columns segment_id, cohort, platform, `recommended_action`, `predicted_conversion_lift`, `predicted_net_value_usd`, sort net value DESC.

### Validation

Open the published dashboard and confirm: the scatter shows a red sliding cluster (Android/Gen-Z, large MAU, low conversion), the tiles land (~$10M annualized conversion at risk; conversion gap ~4% vs ~2.8%), SEG-0000214 appears in the worst-sliding table, the recommended-action mix is a plausible blend (ship_proven_variant + rollout_existing_flag), and the global filters update every widget. Sanity-check that Genie's "how much conversion is at risk?" matches `MEASURE(conversion_at_risk)`. Add `dashboard_id` to `resources.json`.

---
