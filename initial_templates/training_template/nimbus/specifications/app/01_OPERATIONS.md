# Growth Desk Page

The PM write surface — Jordan works the sliding-cohort backlog, the agent's feature decisions land in real time and are served to the product. This is the **Visualize** layer, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** A growth PM thinks in *segments and conversion* — who's sliding, what to ship. The primary visualization is a **conversion × MAU scatter** (red sliding cohorts, sized by users), NOT a bare table. If the screenshot reads as "a table with rows", redesign until it reads as "this is a growth app".

## Layout

**Header:** "Ship the fix before the week's lost." / "Every red cohort is conversion sliding after the checkout change — and a proven feature that could recover it."

**"Ask the assistant" banner:** "Ask why a segment is sliding and get the feature to ship next" → opens the dock with the SEG-0000214 starter.

**KPI cards (3 across):**
- **Conversion at risk** ($, red tint) — annualized, from the metric view over the current sliding cohorts.
- **Sliding segments** (#, red tint) — count of `sliding` band. Ticks down live when the agent acts.
- **Avg conversion** (healthy vs sliding, neutral) — `avg_conversion` healthy ~4% vs sliding ~2.8%.

**Conversion × MAU scatter** (the hero visual): x = MAU, y = conversion rate, one point per cohort, colored by `conv_band` — **red** sliding, **amber** watch, steel healthy. Size by MAU. SEG-0000214 is the zoom target. Clicking a point filters the queue.

**Sliding queue:** Filterable, sortable table.
- Status tabs: All / Sliding / Watch / Has proven fix / Shipping
- Search: segment_id, cohort, platform
- Cohort filter chip, Platform filter chip
- Sortable: **Conversion at risk** ($), **Conversion drop**, **MAU**
- Columns: Segment (id + cohort) | Platform | MAU | Conversion (now vs 3w ago) | **Drop** | **Proven fix?** | **Recommended action** (badge: Ship variant / Roll out flag / Ship alt — from the model) | Status
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60%).**
- **Segment tab** — detail grid (segment, cohort, platform, region, MAU, conversion now vs 3w ago, drop, conversion at risk) + **the matching experiment** (its variant + observed lift — the "proven fix") + **the ranked action options** (each with projected conversion lift, cost, net value) with **Approve recommended / Override** buttons. **An experiment search box** ("Find the winning variant for this cohort") powers a lightweight search over the experiment catalog using Lakebase Search (Milestone 2) — surfaces the proven variant + grounds the rollout note.
- **Trend tab** — recent conversion sparkline (the slide over the last 3 weeks).
- **Activity tab** — merged timeline (agent audit trail + decisions shipped + who approved).

## Nimbus data

The queue reads Lakebase `app.segment_position` (synced, read-only) filtered to sliding cohorts, LEFT JOIN `app.action_recommendations`. The scatter reads the same rows (all bands, colored by `conv_band`). ~40 sliding cohorts; a sample of healthy cohorts in the background.

The **Act** write lands in `app.feature_decisions_app` (writable) — an approved decision is recorded as a row (action_type, target experiment/flag, rollout note, predicted conversion lift, status, approved_by), and the queue derives "shipping" by joining cohort → its latest `feature_decisions_app` row. **The product reads this table at low latency** to serve the flag; the app writes it. KPIs recompute as cohorts gain a decision. See `03_DATA_MODEL.md`.
