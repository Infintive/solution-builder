# Campaign Desk Page

The CMO write surface — Priya works the underperformer backlog, the agent's actions land in real time. This is the **Visualize** layer, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** A CMO thinks in *campaigns and ROAS* — what's winning, what's leaking. The primary visualization is a **ROAS × spend scatter** (green winners high, red underperformers low), NOT a bare table. If the screenshot reads as "a table with rows", redesign until it reads as "this is a marketing-performance app".

## Layout

**Header:** "Replicate what's working, while the quarter's still in play." / "Every green campaign is a pattern to copy. Every red one is budget leaking that a winner's playbook could rescue."

**"Ask the assistant" banner:** "Ask why a campaign is winning and how to replicate it across the ones that aren't" → opens the dock with the CMP-0000214 starter.

**KPI cards (3 across):**
- **Recoverable spend** ($, red tint) — from the metric view over the current active underperformers.
- **Underperformers** (#, red tint) — count of `underperformer` band. Ticks down live when the agent acts.
- **ROAS gap** (winners vs underperformers, neutral) — `avg_roas` winner ~4.0 vs underperformer ~1.1.

**ROAS × spend scatter** (the hero visual): x = spend to date, y = ROAS, one point per campaign, colored by `perf_band` — **green** winner, **red** underperformer, steel steady, grey paused. Size by spend. CMP-0000214 is the zoom target. Clicking a point filters the queue.

**Underperformer queue:** Filterable, sortable table.
- Status tabs: All / Underperformers / Has matching winner / No match / Action taken
- Search: campaign_id, name, category
- Channel filter chip, Category filter chip
- Sortable: **Recoverable spend** ($), **ROAS**, **Spend to date**
- Columns: Campaign (id + name) | Channel | Category | ROAS | **Matching winner?** | **Recoverable spend** ($) | **Recommended action** (badge: Replicate / Reallocate / Pause — from the model) | Status
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60%).**
- **Campaign tab** — detail grid (campaign, channel, category, target segment, ROAS, spend, recoverable spend) + **the matching winner** (its ROAS + creative — the "why it works") + **the ranked action options** (each with projected ROAS lift, cost, net value) with **Approve recommended / Override** buttons. **A creative search box** ("Find the winning creative to replicate") powers a lightweight search over the creative catalog using Lakebase Search (Milestone 2) — surfaces the transferable winning creative + grounds the on-brand brief.
- **Trend tab** — recent ROAS sparkline (the divergence sharpening over the quarter).
- **Activity tab** — merged timeline (agent audit trail + actions taken + who approved).

## Brightwave data

The queue reads Lakebase `app.campaign_position` (synced, read-only) filtered to underperformers, LEFT JOIN `app.action_recommendations`. The scatter reads the same rows (all bands, colored by `perf_band`). ~90 active underperformers + ~60 winners on the affected clusters; a sample of steady campaigns in the background.

The **Act** write lands in `app.campaign_actions_app` (writable) — an approved action is recorded as an action row (action_type, target campaign if reallocating, drafted brief, predicted ROAS lift, status, approved_by), and the queue derives "action taken" by joining campaign → its latest `campaign_actions_app` row. KPIs recompute as underperformers gain an action. See `03_DATA_MODEL.md`.
