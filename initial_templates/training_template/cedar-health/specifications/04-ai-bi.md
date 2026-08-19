# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-intervention.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products mentioned in the README** — do **not** build resources for these:
> - **Databricks One** is a workspace surface, not a buildable artifact.
> - **Genie Code** is the authoring assist inside the editor — narrative only.
> - **Unity Catalog** / **Unity AI Gateway** are governance layers — the app's model calls run through AI Gateway (talk-track for this data/analytics spec).

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md` before implementing.

Create `Cedar Population Health` Genie Space.

### Tables

`mv_patient_risk` (canonical exposure metric view over `gold_patient_panel` — readmission exposure / open gaps / counts — defined in `02-uc-governance.md`), `gold_patient_panel` (per-patient current position: condition, days-since-discharge, `readmission_risk_score`, open gaps, `risk_band`, geo — used for scatter + condition/payer rollups via GROUP BY), `gold_open_atrisk` (current at-risk patients + gap + capacity context), `gold_intervention_recommendations` (the ranked intervention per patient + predicted risk reduction — built by the pipeline heuristic in `01-lakeflow.md`, optionally by the ML model in `03-ml-intervention.md`), `raw_providers` (provider/program directory), `raw_patients` (patient master + condition + geo).

### Self-sufficient room

Anyone opening the Genie room must understand the story without prior context. Wire all three:

- **Space `description`** (set via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the event (discharge wave + follow-up-capacity lag → recently-discharged HF patients with open care gaps sliding into readmission risk) + the headline exposure + the intervention angle. Lift it from the README.
- **Story-context `text_instruction`** at the TOP of `instructions.text_instructions[]`: WHAT HAPPENED · WHAT TO HELP DR. WREN DO · TONE. ~5-8 lines. Honored every turn.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc below, in the same order.

### Instructions

```
You analyze Cedar Health population-health data for Dr. Alicia Wren (VP Population Health, non-technical).

CONTEXT: A discharge wave + follow-up-capacity lag ~3 weeks ago left recently-discharged heart-failure
(+ COPD/PNA/AMI) patients with OPEN care gaps (no 7-day follow-up completed) and rising 30-day
readmission risk — ~180 critical patients — while the rest of the ~30K-patient panel is stable. Each
avoidable readmission costs ~$15K. The team has finite coordinator capacity, so the recommendation must
weigh risk reduction against the load each intervention adds.

BASELINES: A stable patient sits at readmission_risk_score ~0.03-0.2. risk_band is the single signal:
'critical' (risk >= 0.75 with an open follow-up gap), 'elevated' (>= 0.6), 'watch' (>= 0.4), 'stable'.

HEADLINE NUMBERS — always answer from mv_patient_risk (same definitions the dashboard tiles use):
- "What's our readmission exposure?" → MEASURE(readmission_exposure)
- "How many open care gaps?" → MEASURE(open_gaps)
- "How many patients are critical?" → MEASURE(critical_count)

INVESTIGATION FLOW for "who is at risk of readmission and why?":
1. mv_patient_risk → MEASURE(critical_count) + MEASURE(atrisk_count) by primary_condition → HF/COPD/PNA/AMI dominate
2. gold_patient_panel → the at-risk cluster is confined to recently-discharged patients with open gaps (GROUP BY primary_condition, risk_band)
3. gold_open_atrisk WHERE patient_id='PT-0000214' → the hero: HF, discharged ~8 days ago, open follow-up gap, high risk
4. gold_intervention_recommendations → the recommended intervention (followup_call/med_reconciliation/home_health_referral) + predicted risk reduction
Conclude + suggest: "Want me to rank the intervention for PT-0000214 against team capacity?"

INTERVENTION FOLLOW-UP:
- "What's the recommended intervention for PT-0000214?" → gold_intervention_recommendations for that patient → recommended_intervention + predicted_risk_reduction + the ranked options.
- "How much readmission risk could we reduce across all at-risk patients?" → SUM(predicted_risk_reduction) from gold_intervention_recommendations.
- "How many patients are best served by a follow-up call vs home-health?" → GROUP BY recommended_intervention.
```

### Sample Questions — 7-step story arc

Ship 7 questions, in this order, each as both a chip (`config.sample_questions`) AND a curated SQL (`instructions.example_question_sqls`):

1. **Headline** — "What's our readmission exposure right now, and how many open care gaps?" → `MEASURE(readmission_exposure)` + `MEASURE(open_gaps)` from `mv_patient_risk`.
2. **The cluster** — "Which conditions is the readmission risk concentrated in?" → `MEASURE(atrisk_count)` from `mv_patient_risk` GROUP BY `primary_condition`.
3. **Drill to the driver** — "What do these at-risk patients have in common?" → `gold_open_atrisk` GROUP BY `has_open_followup`, `risk_band` → open follow-up gaps + recent discharges dominate.
4. **The hero patient** — "PT-0000214 is high-risk — how bad is it and what's open?" → `gold_open_atrisk WHERE patient_id='PT-0000214'` → HF, discharged ~8 days ago, open follow-up gap, risk score.
5. **The recommendation** — "What's the recommended intervention for PT-0000214, and how much risk would it reduce?" → `gold_intervention_recommendations` for that patient → `recommended_intervention = 'followup_call'`, `predicted_risk_reduction`, the ranked options.
6. **Portfolio impact** — "Across all at-risk patients, how much readmission risk could we reduce, and by which intervention?" → `gold_intervention_recommendations` SUM(`predicted_risk_reduction`) + GROUP BY `recommended_intervention`.
7. **Capacity side** — "Which patients need a home-health referral instead of a call?" → `gold_intervention_recommendations WHERE recommended_intervention='home_health_referral'` JOIN `gold_open_atrisk` for severity.

### Validation

"What's our readmission exposure?" → answered from `mv_patient_risk` (`MEASURE(readmission_exposure)`), matches the dashboard tile. "Who is at risk?" → HF/COPD/PNA/AMI patients with open gaps. "Best intervention for PT-0000214?" → followup_call with a risk-reduction figure, from `gold_intervention_recommendations`. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md` before implementing. The skill owns the JSON shape, encoding rules, grid math; this spec is story-level.

Create `Cedar Population Health` dashboard. Save it at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less** (bare table names) so `lakeview create --dataset-catalog/--dataset-schema` inject the target. Link the Genie space from section A. (Save the Genie space definition at the project root too — `./genie_space.json`.)

### Why this dashboard works (design principles)

- **Two pages, one story**: page 1 is the glance — *"a cohort of recently-discharged patients is sliding into readmission risk with open care gaps; here's the exposure and who."* Page 2 is the deep-dive — *"which patients, which conditions, and what the model recommends against team capacity."*
- **One metric view + two datasets**: `mv_patient_risk` is the canonical exposure layer (KPI tiles + condition splits — same numbers Genie uses). `gold_patient_panel` powers every per-patient widget (the scatter, condition/band rollups). `gold_intervention_recommendations` is the third dataset for the intervention-mix + risk-reduction widget.
- **A risk scatter is the visual hook**: full-width scatter on page 1 — x = `days_since_discharge`, y = `readmission_risk_score`, color = `risk_band` — a red cluster in the recent-discharge / high-risk quadrant standing apart from the calm stable mass. (A geo map by `home_metro` is a fine second view; the days-since-discharge × risk scatter is the sharper clinical hook.)
- **One AI showcase per page**: page 1's scatter + exposure tiles carry the `ai_classify`-driven risk signal; page 2 surfaces the **intervention recommendation** (recommended-intervention mix + total predicted risk reduction).
- **Clean theme — no borders, white canvas**: red = critical/at-risk, amber = watch, so the risk levels are color-coded consistently everywhere.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the event (what / when / cause / the symptom). Lift the situation from the README.

### Theme

```
canvasBackgroundColor: #F5F7FB (light) / #0F1419 (dark)
widgetBackgroundColor: #FFFFFF (light) / #161B22 (dark)
widgetBorderColor:     same as widgetBackgroundColor (= no visible border)
fontColor:             #1F2530 (light) / #E8ECF0 (dark)
selectionColor:        #4F7CE3 (light) / #8ACAFF (dark)
visualizationColors:   ["#094074","#3C6997","#5ADBFF","#FFB020","#E5484D"]
widgetHeaderAlignment: LEFT
```

**Semantic colors (literal-hex pinned everywhere, NEVER `themeColorType: position N`):**
- **Critical / at-risk** → `#E5484D` red.
- **Watch / elevated** → `#FFB020` amber.
- **Stable** → `#3C6997` steel blue.

**`risk_band` color pins (literal-hex on EVERY widget that colors by band):**

| risk_band | Hex |
|---|---|
| critical | `#E5484D` red |
| elevated | `#FFB020` amber |
| watch | `#FFB020` amber |
| stable | `#3C6997` steel blue |

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_exposure` | `SELECT primary_condition, payer, risk_band, home_metro, MEASURE(\`readmission_exposure\`) AS readmission_exposure_usd, MEASURE(\`open_gaps\`) AS open_gaps, MEASURE(\`critical_count\`) AS critical_count, MEASURE(\`atrisk_count\`) AS atrisk_count, MEASURE(\`patient_count\`) AS patient_count FROM mv_patient_risk GROUP BY ALL` | 4 KPI counters + condition/band split bars |
| `ds_patients` | `SELECT patient_id, primary_condition, age_band, payer, home_metro, patient_lat, patient_lng, risk_band, readmission_risk_score, days_since_discharge, open_gap_count, readmission_exposure_usd FROM gold_patient_panel` | Risk scatter, per-condition rollups, worst-patient tables |
| `ds_intervention` | `SELECT patient_id, recommended_intervention, recommended_provider_id, predicted_risk_reduction, predicted_net_value_usd FROM gold_intervention_recommendations` | Recommended-intervention mix + total predicted risk reduction |

**No hardcoded clamps** — the global filters are the single source of scoping.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Condition | `primary_condition` | ds_exposure, ds_patients | All |
| Payer | `payer` | ds_exposure, ds_patients | All |
| Risk band | `risk_band` | ds_exposure, ds_patients | All |

Each filter widget binds only the datasets above — **do NOT bind `ds_intervention`** (keyed by at-risk patient, not the filter dims).

### Page 1 — Population Health (the glance)

**Row 1** — title markdown. *"Cedar Population Health. Dr. Alicia Wren, VP Population Health. A discharge wave + follow-up-capacity lag ~3 weeks ago left recently-discharged heart-failure patients with open care gaps and rising readmission risk (red). This dashboard tracks the exposure and the interventions."*

**Row 2 — 4 × `counter`**. Source: `ds_exposure`.
- **Readmission exposure** · `SUM(\`readmission_exposure_usd\`)` · `number-currency` USD compact · color `#E5484D` red · *the avoidable readmission cost at stake.*
- **Open care gaps** · `SUM(\`open_gaps\`)` · number compact · color `#FFB020` amber.
- **Critical patients** · `SUM(\`critical_count\`)` · number compact · color `#E5484D` red.
- **At-risk patients** · `SUM(\`atrisk_count\`)` · number compact · color `#FFB020` amber.

**Row 3 — `scatter` · "Readmission risk vs days since discharge"** (full width). Source: `ds_patients`. x = `days_since_discharge`, y = `readmission_risk_score`, **color = `risk_band`** (literal-hex pins), size = `open_gap_count`. Sample stable patients at the widget level (`WHERE risk_band != 'stable' OR rand() < 0.05`) so the scatter is legible. Tooltip: patient_id, primary_condition, days_since_discharge, readmission_risk, risk_band.

- *The scatter is the wow: a red cluster in the recent-discharge / high-risk region — the patients about to be readmitted — apart from the calm stable mass. PT-0000214 is a red dot the demo zooms to.*

**Row 4 — two side-by-side**

- **`bar` grouped · "At-risk patients by condition & band"** · `ds_exposure` · x = `primary_condition`, y = `SUM(atrisk_count)`, color = `risk_band` (pins) · *HF/COPD/PNA/AMI carry the critical red; other conditions are mostly stable.*
- **`bar` horizontal · "Readmission exposure by condition"** · `ds_exposure` · y = `primary_condition`, x = `SUM(readmission_exposure_usd)` · *HF dwarfs the rest — the exposure is in the high-severity conditions.*

### Page 2 — Interventions (the deep-dive)

**Row 1** — title markdown. *"Interventions — what do we do about it? The highest-risk patients, what's open, and the model's recommended intervention with the risk it reduces against team capacity."*

**Row 2 — worst patients**

- **`table` · "Highest readmission exposure"** · `ds_patients` · `WHERE risk_band IN ('critical','elevated')`, columns patient_id, primary_condition, days_since_discharge, readmission_risk_score, open_gap_count, `readmission_exposure_usd`, sort exposure DESC · *PT-0000214 near the top.*
- **`table` · "Rising-risk watch list"** · `ds_patients` · `WHERE risk_band='watch'`, columns patient_id, primary_condition, readmission_risk_score, open_gap_count, sort risk DESC · *the moderate cohort — where med-reconciliation or home-health often beats a call.*

**Row 3 — the intervention model**

- **`bar` · "Recommended intervention (mix)"** · `ds_intervention` · x = `recommended_intervention`, y = `COUNT(1)` · *follow-up calls dominate the recent-discharge cohort; med-reconciliation on adherence cases; home-health on high-severity — the model isn't a fixed rule.*
- **`counter` · "Total predicted risk reduction"** · `ds_intervention` · `SUM(\`predicted_risk_reduction\`)` · number · color `#094074` · *the recoverable slice of the readmission risk — the "so what" of acting.*

**Row 4 — `table` · "Intervention recommendations"** (full width) · `ds_intervention` joined to `ds_patients` for condition (or a denormalized dataset) · columns patient_id, primary_condition, `recommended_intervention`, `predicted_risk_reduction`, `predicted_net_value_usd`, sort net value DESC · *the actionable list the coordination team works.*

### Validation

Open the published dashboard and confirm the story reads at a glance: the scatter shows a red recent-discharge/high-risk cluster, the exposure tiles land (~$2.5M readmission exposure), PT-0000214 appears in the highest-exposure table, the recommended-intervention mix is a plausible blend (followup + med-recon + home-health), and the global filters update every widget. Sanity-check that Genie's "what's our readmission exposure?" matches `MEASURE(readmission_exposure)` on `mv_patient_risk`. Add `dashboard_id` to `resources.json`.

---
