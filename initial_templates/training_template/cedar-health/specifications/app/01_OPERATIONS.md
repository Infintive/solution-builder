# Patient Panel Page

The care-coordinator write surface — Dr. Wren works the at-risk backlog, the agent's interventions land in real time. This is the **Visualize** layer, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** Coordinators think in *patient panels* — who's rising, who's overdue. The primary visualization is a **readmission-risk × days-since-discharge scatter** (red recent-discharge/high-risk cluster) OR a **metro map** colored by risk band, NOT a bare table. If the screenshot reads as "a table with rows", redesign until it reads as "this is a care-coordination app".

## Layout

**Header:** "Work the at-risk panel." / "Every red patient is a recent discharge sliding toward an avoidable readmission. Every one you reach in time is a readmission prevented."

**"Ask the assistant" banner:** "Ask why a patient is at risk and get the intervention that fits your team's capacity" → opens the dock with the PT-0000214 starter.

**KPI cards (3 across):**
- **Readmission exposure** ($, red tint) — from the exposure metric view over the current at-risk patients.
- **Open care gaps** (#, amber tint) — open follow-up + med-recon gaps on the cohort.
- **Critical patients** (#, neutral) — count of `critical`/`elevated`. Ticks down live when the agent acts.

**Risk scatter / map** (the hero visual): x = days since discharge, y = readmission risk, one point per at-risk patient, colored by `risk_band` — **red** critical, **amber** watch/elevated, steel stable. Size by open_gap_count. PT-0000214 is the zoom target. Clicking a point filters the queue. (A metro map by `home_metro` recolored to `risk_band` is a fine alternative.)

**At-risk queue:** Filterable, sortable table.
- Status tabs: All / Critical / Elevated / Watch / Intervention assigned
- Search: patient_id, condition, metro
- Condition filter chip (HF/COPD/PNA/AMI/…), Risk-band filter chip
- Sortable: **Readmission exposure** ($), **Readmission risk** (score), **Days since discharge**
- Columns: Patient (id + condition) | Metro | Days since discharge | Readmission risk | **Open gaps** | **Exposure** ($) | **Recommended intervention** (badge: Follow-up / Med-recon / Home-health — from the model) | Status
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60%).**
- **Risk tab** — detail grid (patient, condition, age band, payer, days since discharge, readmission risk, open gaps, exposure) + capacity context (team headroom hours) + **the ranked intervention options** (each with projected risk reduction, cost, coordinator hours, fits-capacity flag) with **Assign recommended / Override** buttons. **For the home-health option:** a small **provider search box** ("Find a home-health program") powers a lightweight search over the provider directory using Lakebase Search — ranked candidate programs with name, specialty, description.
- **Patient tab** — the de-identified `clinical_summary` + recent risk-score sparkline. *(PHI teaching point: scoped fields only, never a raw PHI dump.)*
- **Activity tab** — merged timeline (agent audit trail + assigned interventions + who approved).

## Cedar data

The queue reads Lakebase `app.patient_position` (synced, read-only) filtered to at-risk, LEFT JOIN `app.intervention_recommendations`. The scatter/map reads the same rows. ~180 critical + ~110 watch/elevated at-risk patients; a sample of stable patients in the background.

The **Act** write lands in `app.care_actions` (writable) — an approved intervention is recorded as an action row (intervention_type, provider if a referral, drafted summary, predicted risk reduction, status, approved_by), and the queue derives "intervention assigned" by joining panel → its latest `care_action`. KPIs recompute as patients gain an action. See `03_DATA_MODEL.md`.
