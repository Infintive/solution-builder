# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-nba.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products mentioned in the README** — do **not** build resources for these:
> - **Databricks One** is a workspace surface, not a buildable artifact — the dashboard + Genie space appear there once built.
> - **Genie Code** is the authoring assist inside the editor — narrative only.
> - **Unity Catalog** / **Unity AI Gateway** are governance layers — the app's model calls run through AI Gateway (talk-track for this data/analytics spec; the app spec covers the assistant).

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md` before implementing.

Create `Meridian Customer Retention` Genie Space.

### Tables

`mv_customer_risk` (canonical exposure metric view over `gold_customer_position` — balance/revenue-at-risk / counts — defined in `02-uc-governance.md`), `gold_customer_position` (per-customer current position: balances, tenure, `attrition_risk_score`, `risk_band`, geo, tier — used for scatter + tier/band rollups via GROUP BY), `gold_open_atrisk` (current at-risk customers + maturing-deposit + cross-sell context), `gold_nba_recommendations` (the ranked next-best-action per customer + predicted retained $ — built by the pipeline heuristic in `01-lakeflow.md`, optionally by the ML model in `03-ml-nba.md`), `raw_products` (product catalog + eligibility), `raw_customers` (customer master + tier + geo).

### Self-sufficient room

Anyone opening the Genie room must understand the story without prior context. Wire all three:

- **Space `description`** (set via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the event (competitor rate promo → high-value customers with maturing CDs sliding into attrition risk) + the headline exposure numbers + the next-best-action angle, pointing to the suggested questions in order. Lift it from the README.
- **Story-context `text_instruction`** at the TOP of `instructions.text_instructions[]`: WHAT HAPPENED · WHAT TO HELP MARCUS DO · TONE. ~5-8 lines. Honored every turn.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc below, in the same order.

### Instructions

```
You analyze Meridian Bank customer-retention data for Marcus Bell (EVP Consumer & Small Business Banking, non-technical).

CONTEXT: A competitor launched a savings-rate promotion ~3 weeks ago aimed at maturing CDs and
high-balance savings. The bank's most valuable, longest-tenured customers holding those affected
deposits (18-Month CD PROD-DEP-2001 + 2 others) have slid into elevated attrition risk — ~220
critical customers with balance starting to flow out — while the rest of the ~40K-customer book is
stable. High value, rising risk, concentrated in a recent window.

BASELINES: A healthy customer sits at attrition_risk_score ~0.05-0.25. risk_band is the single
signal: 'critical' (risk >= 0.75 with balance at risk), 'elevated' (>= 0.6), 'watch' (>= 0.4),
'healthy'. Balance-at-risk and revenue-at-risk are only non-zero for at-risk customers.

HEADLINE NUMBERS — always answer from mv_customer_risk (same definitions the dashboard tiles use):
- "How much balance is at risk?" → MEASURE(balance_at_risk)
- "What's our revenue at risk?" → MEASURE(revenue_at_risk)
- "How many customers are critical?" → MEASURE(critical_count)

INVESTIGATION FLOW for "who is at risk and why?":
1. mv_customer_risk → MEASURE(critical_count) + MEASURE(atrisk_count) by tier → affluent/private dominate
2. gold_customer_position → the at-risk cluster is confined to high-value tiers holding affected deposits (GROUP BY tier, risk_band)
3. gold_open_atrisk WHERE customer_id='CUST-0000214' → the hero: a large CD maturing in ~9 days, high risk
4. gold_nba_recommendations → the recommended next-best-action (retention_offer/cross_sell/rm_outreach) + predicted retained $
Conclude + suggest: "Want me to rank the next best action for CUST-0000214?"

NBA FOLLOW-UP:
- "What's the next best action for CUST-0000214?" → gold_nba_recommendations for that customer → recommended_action + predicted_retained_usd + the action_ranking options.
- "How much could we retain across all at-risk customers?" → SUM(predicted_retained_usd) from gold_nba_recommendations.
- "How many at-risk customers are best served by a retention offer vs cross-sell?" → GROUP BY recommended_action.
```

### Sample Questions — 7-step story arc

Ship 7 questions, in this order, each as both a chip (`config.sample_questions`) AND a curated SQL (`instructions.example_question_sqls`):

1. **Headline** — "How much balance is at risk right now, and what's the revenue at risk?" → `MEASURE(balance_at_risk)` + `MEASURE(revenue_at_risk)` from `mv_customer_risk`.
2. **The cluster** — "Which customer tiers is the risk concentrated in?" → `MEASURE(atrisk_count)` from `mv_customer_risk` GROUP BY `tier`.
3. **Drill to the driver** — "What are these at-risk customers holding?" → `gold_open_atrisk` GROUP BY `atrisk_product_id` → the 3 affected deposit products dominate.
4. **The hero customer** — "CUST-0000214 is high-risk — how much is at stake and what are they holding?" → `gold_open_atrisk WHERE customer_id='CUST-0000214'` → large maturing CD, days_to_maturity, balance-at-risk.
5. **The recommendation** — "What's the next best action for CUST-0000214, and how much would it retain?" → `gold_nba_recommendations` for that customer → `recommended_action = 'retention_offer'`, `predicted_retained_usd`, the ranked options.
6. **Portfolio retention** — "Across all at-risk customers, how much could we retain, and by which action?" → `gold_nba_recommendations` SUM(`predicted_retained_usd`) + GROUP BY `recommended_action`.
7. **Cross-sell side** — "Which at-risk customers are best served by a cross-sell instead of a retention offer?" → `gold_nba_recommendations WHERE recommended_action='cross_sell'` JOIN `gold_open_atrisk` for tier/balance.

### Validation

"How much balance is at risk?" → answered from `mv_customer_risk` (`MEASURE(balance_at_risk)`), matches the dashboard tile. "Who is at risk?" → affluent/private customers on affected deposits. "Best action for CUST-0000214?" → retention_offer with a retained-$ figure, from `gold_nba_recommendations`. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md` before implementing. The skill owns the JSON shape, encoding rules, grid math; this spec is story-level.

Create `Meridian Customer Retention` dashboard. Save it at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less** (bare table names) so `lakeview create --dataset-catalog/--dataset-schema` inject the target — ONE file works in any catalog/schema. Link the Genie space from section A. (Save the Genie space definition at the project root too — `./genie_space.json`.)

### Why this dashboard works (design principles)

- **Two pages, one story**: page 1 is the glance — *"our most valuable customers are sliding into attrition risk on the products a competitor is poaching; here's the exposure and who."* Page 2 is the deep-dive — *"which customers, which products, and what the model recommends."*
- **One metric view + two datasets**: `mv_customer_risk` is the canonical exposure layer (KPI tiles + tier splits — same numbers Genie uses). `gold_customer_position` powers every per-customer widget (the scatter, tier/band rollups). `gold_nba_recommendations` is the third dataset for the action-mix + retained-$ widget.
- **A risk scatter is the visual hook**: full-width scatter on page 1 — x = `total_balance_usd`, y = `attrition_risk_score`, color = `risk_band` — a red cluster in the high-balance / high-risk quadrant (the valuable customers about to leave) standing apart from the calm blue mass. Instantly readable; beats any table for *"where's the problem?"*. (A geo map by `home_metro` is a fine alternative/second view, but the balance×risk scatter is the sharper hook for FSI.)
- **One AI showcase per page**: page 1's scatter + exposure tiles carry the `ai_classify`-driven churn-signal; page 2 surfaces the **NBA recommendation** (recommended-action mix + total predicted retained $) — AI-native analytics inside a dashboard.
- **Clean theme — no borders, white canvas**: widgets float on the canvas; left-aligned headers; a cohesive palette where red = critical/at-risk and amber = watch, so the risk levels are color-coded consistently everywhere.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the event (what / when / cause / the symptom) and telling the reader which widget answers which question. Lift the situation from the README.

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

Palette runs calm → warning → alarm: deep navy → steel blue → sky cyan → amber → red. The two warm stops are semantic and pinned everywhere:

**Semantic colors (literal-hex pinned everywhere they appear, NEVER `themeColorType: position N`):**
- **Critical / at-risk** → `#E5484D` red (the alarm — high-value high-risk customers).
- **Watch / elevated** → `#FFB020` amber (the warning — rising risk).
- **Healthy** → `#3C6997` steel blue.

**`risk_band` color pins (literal-hex on EVERY widget that colors by band)** — Lakeview cycles the palette by result order, which differs across widgets; pinning guarantees `critical` is the same red on the scatter AND on the band bars:

| risk_band | Hex |
|---|---|
| critical | `#E5484D` red |
| elevated | `#FFB020` amber |
| watch | `#FFB020` amber |
| healthy | `#3C6997` steel blue |

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_exposure` | `SELECT tier, risk_band, home_metro, MEASURE(\`balance_at_risk\`) AS balance_at_risk_usd, MEASURE(\`revenue_at_risk\`) AS revenue_at_risk_usd, MEASURE(\`critical_count\`) AS critical_count, MEASURE(\`atrisk_count\`) AS atrisk_count, MEASURE(\`customer_count\`) AS customer_count FROM mv_customer_risk GROUP BY ALL` | 4 KPI counters + tier/band split bars |
| `ds_customers` | `SELECT customer_id, tier, tenure_years, home_metro, customer_lat, customer_lng, risk_band, attrition_risk_score, total_balance_usd, affected_deposit_balance_usd, balance_at_risk_usd, revenue_at_risk_usd FROM gold_customer_position` | Risk scatter, per-tier rollups, worst-customer tables |
| `ds_nba` | `SELECT customer_id, recommended_action, recommended_offer_product_id, predicted_retained_usd, predicted_net_value_usd FROM gold_nba_recommendations` | Recommended-action mix + total predicted retained $ |

**No hardcoded clamps** — the global filters are the single source of scoping.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Tier | `tier` | ds_exposure, ds_customers | All |
| Risk band | `risk_band` | ds_exposure, ds_customers | All |
| Home metro | `home_metro` | ds_exposure, ds_customers | All |

Each filter widget has an explicit `filterTargets[]` binding only the datasets above — **do NOT bind `ds_nba`** (it's keyed by at-risk customer, not the filter dims; auto-binding on shared column names would drop rows unexpectedly).

### Page 1 — Retention (the glance)

**Row 1** — title markdown. *"Meridian Customer Retention. Marcus Bell, EVP Consumer & Small Business Banking. A competitor rate promotion ~3 weeks ago pushed our most valuable customers with maturing CDs into attrition risk (red — about to walk). This dashboard tracks the exposure and the recovery."*

**Row 2 — 4 × `counter`**. Source: `ds_exposure`. No `period` encoding — each shows the dataset-level sum over the global filter selection.

- **Balance at risk** · `SUM(\`balance_at_risk_usd\`)` · `number-currency` USD compact · color `#E5484D` red · *the deposit money that could walk.*
- **Revenue at risk** · `SUM(\`revenue_at_risk_usd\`)` · `number-currency` USD compact · color `#E5484D` red · *the annual revenue at stake.*
- **Critical customers** · `SUM(\`critical_count\`)` · number compact · color `#E5484D` red.
- **At-risk customers** · `SUM(\`atrisk_count\`)` · number compact · color `#FFB020` amber.

**Row 3 — `scatter` · "Customer balance vs attrition risk"** (full width). Source: `ds_customers`. Encoding x = `total_balance_usd`, y = `attrition_risk_score`, **color = `risk_band`** via the literal-hex pins (red critical / amber watch / steel healthy), size = `balance_at_risk_usd` (or constant). To keep the scatter legible with 40K points, either sample healthy customers at the widget level (`WHERE risk_band != 'healthy' OR rand() < 0.05`) or rely on the color to make the red cluster pop. Tooltip: customer_id, tier, tenure_years, total_balance, attrition_risk, risk_band.

- *The scatter is the wow: a red cluster in the top-right (high balance, high risk) — the valuable customers about to leave — standing apart from the calm blue mass. CUST-0000214 is a red dot the demo zooms to.*

**Row 4 — two side-by-side**

- **`bar` grouped · "At-risk customers by tier & band"** · `ds_exposure` · x = `tier`, y = `SUM(atrisk_count)`, color = `risk_band` (literal-hex pins) · *affluent + private bars carry the critical red; mass/mass_affluent are mostly healthy — the risk is concentrated in the high-value tiers.*
- **`bar` horizontal · "Balance at risk by tier"** · `ds_exposure` · y = `tier`, x = `SUM(balance_at_risk_usd)` · *affluent + private dwarf the rest — the exposure is in the high-value book, not the mass market.*

### Page 2 — Next Best Action (the deep-dive)

**Row 1** — title markdown. *"Next Best Action — what do we do about it? The most at-risk customers, what they hold, and the model's recommended action with the revenue it retains."*

**Row 2 — worst customers**

- **`table` · "Highest revenue at risk"** · `ds_customers` · `WHERE risk_band IN ('critical','elevated')`, columns customer_id, tier, tenure_years, total_balance_usd, attrition_risk_score, `revenue_at_risk_usd`, sort revenue DESC · *CUST-0000214 near the top — the demo's spotlight row.*
- **`table` · "Rising-risk watch list"** · `ds_customers` · `WHERE risk_band='watch'`, columns customer_id, tier, total_balance_usd, attrition_risk_score, `balance_at_risk_usd`, sort risk DESC · *the moderate cohort — where a cross-sell often beats a retention offer.*

**Row 3 — the NBA model**

- **`bar` · "Recommended next best action (mix)"** · `ds_nba` · x = `recommended_action` (`retention_offer`/`cross_sell`/`rm_outreach`), y = `COUNT(1)` · *retention offers dominate the high-value critical cohort; cross-sell wins on the lower-risk moderate cohort — the model isn't a fixed rule.*
- **`counter` · "Total predicted retained revenue"** · `ds_nba` · `SUM(\`predicted_retained_usd\`)` · `number-currency` USD compact · color `#094074` · *the recoverable slice of the revenue-at-risk — the "so what" of acting on the recommendations.*

**Row 4 — `table` · "Next-best-action recommendations"** (full width) · `ds_nba` joined to `ds_customers` for tier/balance (or a denormalized dataset) · columns customer_id, tier, `recommended_action`, `recommended_offer_product_id`, `predicted_retained_usd`, `predicted_net_value_usd`, sort net value DESC · *the actionable list the RM team works — the app turns each row into an approve-and-execute action.*

### Validation

Open the published dashboard and confirm the story reads at a glance: the scatter shows a red high-balance/high-risk cluster, the exposure tiles land (~$150M+ balance-at-risk, ~$4M revenue-at-risk), CUST-0000214 appears in the highest-revenue-at-risk table, the recommended-action mix is a plausible blend (retention_offer + cross_sell), and the global filters update every widget. Sanity-check that Genie's "how much balance is at risk?" matches `MEASURE(balance_at_risk)` on `mv_customer_risk`. Add `dashboard_id` to `resources.json`.

---
