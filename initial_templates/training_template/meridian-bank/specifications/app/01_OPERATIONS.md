# Relationships Page

The RM write surface — Marcus works the at-risk backlog, the agent's next-best-actions land in real time. This is the **Visualize** layer of the enablement arc, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** Marcus and his RMs think in *customers and books of business* — who's valuable, who's slipping. The primary visualization is therefore a **balance-vs-risk scatter** (red high-value/high-risk cluster) OR a **US metro map** colored by risk band, NOT a bare table. The queue is the secondary, drill-in surface. If the screenshot would read as "a table with rows", redesign until it reads as "this is a customer-retention app" at a glance.

## Layout

**Header:** "Work the at-risk book." / "Every red customer is a valuable, long-tenured relationship a competitor is trying to poach on rate. Every one you save is revenue that stays."

**"Ask the assistant" banner:** Sparkle-icon card — "Ask why a customer is at risk and get the next best action" → opens the dock with the CUST-0000214 starter.

**KPI cards (3 across):**
- **Balance at risk** ($, red tint) — from the exposure metric view over the current at-risk customers.
- **Revenue at risk** ($, red tint) — the annualized revenue at stake.
- **Critical customers** (#, neutral) — count of `critical`/`elevated` positions. Ticks down live when the agent acts.

**Risk scatter / map** (the hero visual, between the KPIs and the queue): a balance-vs-risk scatter (x = total balance, y = attrition risk) with one point per at-risk customer, colored by `risk_band` — **red** for critical, **amber** for watch/elevated, steel for healthy. Size by balance-at-risk. CUST-0000214 is the demo's zoom target. Clicking a point filters the queue to that customer. (Reuse the template's `CityMap` bubble-map component recolored/rekeyed to customers + `risk_band` if you prefer a geo view by `home_metro`; the scatter is the sharper FSI hook.)

**At-risk queue:** Filterable, sortable table.
- Status tabs: All / Critical / Elevated / Watch / Action in progress
- Search: free-text across customer_id, tier, home_metro
- Tier filter chip (mass / mass_affluent / affluent / private), Risk-band filter chip
- Sortable columns: **Revenue at risk** ($), **Attrition risk** (score), **Balance** ($)
- Columns: Customer (id + tier) | Home metro | Total balance | Attrition risk | **Days to maturity** | **Balance at risk** ($) | **Recommended action** (badge: Retention / Cross-sell / Outreach — from the model) | Status
- Recommended-action badge variants: `retention_offer` (solid) | `cross_sell` (outline) | `rm_outreach` (muted); shown once the model has scored the customer.
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60% width).**
- **At-risk tab** — detail grid (customer, tier, tenure, total balance, attrition risk, maturing deposit, days-to-maturity, balance-at-risk, revenue-at-risk) + **the ranked NBA options** (retention_offer/cross_sell/rm_outreach, each with cost, value at stake, predicted retained $) with **Approve recommended action / Override** buttons. **For the cross-sell option:** a small **product search box** below the option ("Find a product this customer qualifies for") powers a lightweight search over the product catalog using Lakebase Search (Milestone 2 Lakebase work) — returns ranked candidate products with name, segment, rate, min balance so the agent can suggest a contextual cross-sell.
- **Customer tab** — customer profile (tier, tenure, home metro, holdings) + recent risk-score sparkline + the `profile_summary` (non-PII). *(PII teaching point: this tab shows only scoped fields, never a raw PII dump.)*
- **Activity tab** — merged timeline (agent audit trail + approved actions with timestamps + who approved).

## Meridian data

The queue reads from Lakebase `app.customer_position` (synced, read-only) filtered to at-risk customers, LEFT JOIN `app.nba_recommendations` (the ranked action per customer). The scatter/map reads the same position rows. ~220 critical + ~120 watch/elevated at-risk customers on the affected deposits; a sample of healthy customers in the background so the affected ones stand out.

The **Act** write lands in `app.rm_actions` (writable) — the synced position table is read-only, so an approved retention offer is recorded as an action row (action_type, offered product/rate, drafted note, predicted retained $, status, approved_by), and the queue derives "action in progress" by joining position → its latest `rm_action`. The KPI exposure numbers recompute as customers gain an action. See `03_DATA_MODEL.md`.
