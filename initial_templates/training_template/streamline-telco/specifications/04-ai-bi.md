# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-churn.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products** — do **not** build resources for these: **Databricks One**, **Genie Code**, **Unity Catalog** / **Unity AI Gateway**.

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md`.

Create `Streamline Retention` Genie Space.

### Tables

`mv_subscriber_risk` (canonical exposure metric view over `gold_subscriber_position`), `gold_subscriber_position` (per-subscriber current position: plan, tickets, `churn_risk_score`, `churn_reason`, `risk_band`, geo), `gold_open_atrisk` (current at-risk + reason + candidate offer), `gold_retention_recommendations` (the ranked offer per subscriber + predicted retained CLV), `raw_offers` (offer catalog), `raw_subscribers` (subscriber master).

### Self-sufficient room

- **Space `description`** (via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the event (node outage + billing friction → subscribers sliding into churn risk) + the headline exposure + the offer angle. Lift from the README.
- **Story-context `text_instruction`** at the TOP: WHAT HAPPENED · WHAT TO HELP RAE DO · TONE. ~5-8 lines.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc.

### Instructions

```
You analyze Streamline Telco subscriber-retention data for Rae Nakamura (SVP Customer Care & Retention, non-technical).

CONTEXT: A network outage on NODE-OHIO-14 ~3 weeks ago collided with billing friction and a
competitor promo, pushing a cluster of subscribers into churn risk — ~200 critical subscribers with
open tickets — while the rest of the ~40K-subscriber sample is stable. The churn REASON matters
(service / price / device); the right retention offer matches the reason.

BASELINES: A stable subscriber sits at churn_risk_score ~0.03-0.2. risk_band is the single signal:
'critical' (risk >= 0.75 with an open ticket), 'elevated' (>= 0.6), 'watch' (>= 0.4), 'healthy'.
churn_reason is 'service', 'price', or 'device'.

HEADLINE NUMBERS — always answer from mv_subscriber_risk:
- "What's our CLV at risk?" → MEASURE(clv_at_risk)
- "How many open tickets?" → MEASURE(open_tickets)
- "How many subscribers are critical?" → MEASURE(critical_count)

INVESTIGATION FLOW for "who is at risk and why?":
1. mv_subscriber_risk → MEASURE(critical_count) + MEASURE(atrisk_count) by churn_reason → service dominates
2. gold_subscriber_position → the at-risk cluster is on the outage node with open tickets (GROUP BY service_node_id, risk_band)
3. gold_open_atrisk WHERE subscriber_id='SUB-0000214' → the hero: service reason, open ticket, high risk
4. gold_retention_recommendations → the recommended offer (bill_credit/plan_upgrade_discount/device_upgrade) + predicted retained CLV
Conclude + suggest: "Want me to rank the offer for SUB-0000214?"

OFFER FOLLOW-UP:
- "What should I offer SUB-0000214?" → gold_retention_recommendations → recommended_offer + predicted_retained_clv_usd + the offer_ranking options.
- "How much CLV could we retain across all at-risk subscribers?" → SUM(predicted_retained_clv_usd).
- "How many are best served by a bill credit vs a plan discount?" → GROUP BY recommended_offer.
```

### Sample Questions — 7-step story arc

1. **Headline** — "What's our CLV at risk right now, and how many open tickets?" → `MEASURE(clv_at_risk)` + `MEASURE(open_tickets)` from `mv_subscriber_risk`.
2. **The cluster** — "What's driving the churn risk — by reason?" → `MEASURE(atrisk_count)` GROUP BY `churn_reason`.
3. **Drill to the node** — "Which service node are the at-risk subscribers on?" → `gold_subscriber_position` GROUP BY `service_node_id`, `risk_band` → the outage node.
4. **The hero subscriber** — "SUB-0000214 is at risk — why, and how much is at stake?" → `gold_open_atrisk WHERE subscriber_id='SUB-0000214'` → service reason, open ticket, CLV at risk.
5. **The recommendation** — "What should I offer SUB-0000214, and how much would it retain?" → `gold_retention_recommendations` → `recommended_offer = 'bill_credit'`, `predicted_retained_clv_usd`, the ranked options.
6. **Portfolio impact** — "Across all at-risk subscribers, how much CLV could we retain, and by which offer?" → `gold_retention_recommendations` SUM + GROUP BY `recommended_offer`.
7. **Price side** — "Which subscribers are best served by a plan discount instead?" → `gold_retention_recommendations WHERE recommended_offer='plan_upgrade_discount'` JOIN `gold_open_atrisk`.

### Validation

"What's our CLV at risk?" → from `mv_subscriber_risk` (`MEASURE(clv_at_risk)`), matches the dashboard tile. "Who is at risk?" → subscribers on the outage node with open tickets. "SUB-0000214?" → bill_credit with a retained-CLV figure. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md`. The skill owns the JSON shape; this spec is story-level.

Create `Streamline Retention` dashboard. Save at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less**. Link the Genie space. (Save the Genie space at the project root too — `./genie_space.json`.)

### Why this dashboard works

- **Two pages, one story**: page 1 the glance — *"a cluster of subscribers is sliding into churn risk after a node outage; here's the exposure and why."* Page 2 the deep-dive — *"which subscribers, which reason, and what the model recommends."*
- **One metric view + two datasets**: `mv_subscriber_risk` (KPI tiles + reason splits), `gold_subscriber_position` (scatter, node/plan rollups), `gold_retention_recommendations` (offer-mix + retained-CLV widget).
- **A risk scatter is the visual hook**: full-width scatter — x = `tenure_months`, y = `churn_risk_score`, color = `risk_band` — a red cluster of valuable, long-tenured subscribers at high risk. (A geo map by `sub_lat`/`sub_lng` clustering on the outage metro is a fine second view.)
- **One AI showcase per page**: page 1's scatter carries the `ai_classify` churn signal; page 2 surfaces the **retention recommendation**.
- **Clean theme — no borders, white canvas**: red = critical, amber = watch.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the event.

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

**Semantic colors (literal-hex pinned):** Critical/at-risk → `#E5484D` red · Watch/elevated → `#FFB020` amber · Healthy → `#3C6997` steel blue.
**`risk_band` color pins:** critical `#E5484D` · elevated `#FFB020` · watch `#FFB020` · healthy `#3C6997`.

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_exposure` | `SELECT plan_type, churn_reason, risk_band, home_metro, MEASURE(\`clv_at_risk\`) AS clv_at_risk_usd, MEASURE(\`open_tickets\`) AS open_tickets, MEASURE(\`critical_count\`) AS critical_count, MEASURE(\`atrisk_count\`) AS atrisk_count, MEASURE(\`subscriber_count\`) AS subscriber_count FROM mv_subscriber_risk GROUP BY ALL` | 4 KPI counters + reason/band split bars |
| `ds_subscribers` | `SELECT subscriber_id, plan_type, tenure_months, monthly_arpu_usd, service_node_id, home_metro, sub_lat, sub_lng, risk_band, churn_risk_score, churn_reason, open_ticket_count, clv_at_risk_usd FROM gold_subscriber_position` | Risk scatter, per-node rollups, worst-subscriber tables |
| `ds_retention` | `SELECT subscriber_id, recommended_offer, predicted_retained_clv_usd, predicted_net_value_usd FROM gold_retention_recommendations` | Recommended-offer mix + total predicted retained CLV |

**No hardcoded clamps** — the global filters scope.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Plan | `plan_type` | ds_exposure, ds_subscribers | All |
| Churn reason | `churn_reason` | ds_exposure, ds_subscribers | All |
| Risk band | `risk_band` | ds_exposure, ds_subscribers | All |

Bind only the datasets above — **do NOT bind `ds_retention`** (keyed by at-risk subscriber).

### Page 1 — Retention (the glance)

**Row 1** — title markdown. *"Streamline Retention. Rae Nakamura, SVP Customer Care & Retention. A node outage + billing friction ~3 weeks ago pushed a cluster of subscribers into churn risk (red — about to leave). This dashboard tracks the CLV at risk and the save."*

**Row 2 — 4 × `counter`** (`ds_exposure`):
- **CLV at risk** · `SUM(\`clv_at_risk_usd\`)` · `number-currency` USD compact · red.
- **Open tickets** · `SUM(\`open_tickets\`)` · number compact · amber.
- **Critical subscribers** · `SUM(\`critical_count\`)` · number compact · red.
- **At-risk subscribers** · `SUM(\`atrisk_count\`)` · number compact · amber.

**Row 3 — `scatter` · "Churn risk vs tenure"** (full width). `ds_subscribers`. x = `tenure_months`, y = `churn_risk_score`, color = `risk_band` (pins), size = `monthly_arpu_usd`. Sample healthy subscribers (`WHERE risk_band != 'healthy' OR rand() < 0.05`). Tooltip: subscriber_id, plan_type, tenure, churn_risk, churn_reason, risk_band. *The red cluster (long tenure, high risk) — the valuable subscribers about to leave. SUB-0000214 is the zoom target.*

**Row 4 — two side-by-side**
- **`bar` grouped · "At-risk subscribers by reason & band"** · `ds_exposure` · x = `churn_reason`, y = `SUM(atrisk_count)`, color = `risk_band` (pins) · *service dominates the critical red — the outage is the driver.*
- **`bar` horizontal · "CLV at risk by plan"** · `ds_exposure` · y = `plan_type`, x = `SUM(clv_at_risk_usd)`.

### Page 2 — Offers (the deep-dive)

**Row 1** — title markdown. *"Offers — what do we do about it? The most at-risk subscribers, why they're leaving, and the model's recommended offer with the CLV it retains."*

**Row 2 — worst subscribers**
- **`table` · "Highest CLV at risk"** · `ds_subscribers` · `WHERE risk_band IN ('critical','elevated')`, columns subscriber_id, plan_type, tenure_months, churn_reason, churn_risk_score, `clv_at_risk_usd`, sort CLV DESC · *SUB-0000214 near the top.*
- **`table` · "Rising-risk watch list"** · `ds_subscribers` · `WHERE risk_band='watch'`, columns subscriber_id, plan_type, churn_reason, churn_risk_score, sort risk DESC.

**Row 3 — the churn model**
- **`bar` · "Recommended offer (mix)"** · `ds_retention` · x = `recommended_offer`, y = `COUNT(1)` · *bill credit dominates the service-reason cohort; plan discount + device on their reasons — the offer follows the reason.*
- **`counter` · "Total predicted retained CLV"** · `ds_retention` · `SUM(\`predicted_retained_clv_usd\`)` · `number-currency` USD compact · color `#094074`.

**Row 4 — `table` · "Retention recommendations"** (full width) · `ds_retention` joined to `ds_subscribers` for names · columns subscriber_id, plan_type, `recommended_offer`, `predicted_retained_clv_usd`, `predicted_net_value_usd`, sort net value DESC.

### Validation

Open the published dashboard and confirm: the scatter shows a red long-tenure/high-risk cluster, the exposure tiles land (~$0.4M CLV at risk on the sample — the $3.9M full-base figure is talking-track), SUB-0000214 appears in the highest-CLV table, the recommended-offer mix is a plausible blend (bill_credit + plan + device), and the global filters update every widget. Sanity-check that Genie's "what's our CLV at risk?" matches `MEASURE(clv_at_risk)`. Add `dashboard_id` to `resources.json`.

---
