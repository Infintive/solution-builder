# Care Desk Page

The care-agent write surface — Rae works the at-risk-subscriber backlog, the agent's retention offers land in real time. This is the **Visualize** layer, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** Care agents think in *subscribers on a call* — who's valuable, who's about to leave and why. The primary visualization is a **churn-risk × tenure scatter** (red high-value/high-risk cluster) OR a **metro map** colored by risk band, NOT a bare table. If the screenshot reads as "a table with rows", redesign until it reads as "this is a care-agent app".

## Layout

**Header:** "Work the at-risk book." / "Every red subscriber is a valuable relationship about to walk — and the save is on the call. See why, make the right offer."

**"Ask the assistant" banner:** "Ask why a subscriber is at risk and get the offer matched to the reason" → opens the dock with the SUB-0000214 starter.

**KPI cards (3 across):**
- **CLV at risk** ($, red tint) — from the exposure metric view over the current at-risk subscribers.
- **Open tickets** (#, amber tint) — open outage/billing tickets on the cohort.
- **Critical subscribers** (#, neutral) — count of `critical`/`elevated`. Ticks down live when the agent acts.

**Risk scatter / map** (the hero visual): x = tenure, y = churn risk, one point per at-risk subscriber, colored by `risk_band` — **red** critical, **amber** watch/elevated, steel healthy. Size by CLV at risk. SUB-0000214 is the zoom target. Clicking a point filters the queue. (A metro map by `sub_lat`/`sub_lng` clustering on the outage metro is a fine alternative.)

**At-risk queue:** Filterable, sortable table.
- Status tabs: All / Critical / Elevated / Watch / Offer applied
- Search: subscriber_id, plan, metro
- Plan filter chip, Churn-reason filter chip (service/price/device), Risk-band filter chip
- Sortable: **CLV at risk** ($), **Churn risk** (score), **Tenure**
- Columns: Subscriber (id + plan) | Metro | Tenure | Churn risk | **Reason** | **CLV at risk** ($) | **Recommended offer** (badge: Bill credit / Plan discount / Device — from the model) | Status
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60%).**
- **Subscriber tab** — detail grid (subscriber, plan, tenure, ARPU, churn risk, reason, open tickets, CLV at risk) + **the service history** (the outage + billing ticket — the "why") + **the ranked offer options** (each with retained CLV, cost, net value) with **Approve recommended / Override** buttons. **A service-history search box** ("Why is this subscriber at risk?") powers a lightweight search over their tickets + network events using Lakebase Search (Milestone 2) — surfaces the outage + billing context that grounds the reason.
- **Usage tab** — recent usage sparkline (a slight dip post-outage).
- **Activity tab** — merged timeline (agent audit trail + offers applied + who approved).

## Streamline data

The queue reads Lakebase `app.subscriber_position` (synced, read-only) filtered to at-risk, LEFT JOIN `app.retention_recommendations`. The scatter/map reads the same rows. ~200 critical + ~100 watch/elevated at-risk subscribers; a sample of healthy subscribers in the background.

The **Act** write lands in `app.care_actions` (writable) — an approved offer is recorded as an action row (offer_type, drafted call-resolution summary, predicted retained CLV, status, approved_by), and the queue derives "offer applied" by joining subscriber → its latest `care_action` row. KPIs recompute as subscribers gain an action. See `03_DATA_MODEL.md`.
