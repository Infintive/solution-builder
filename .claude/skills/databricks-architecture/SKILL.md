---
name: databricks-architecture
description: Create or edit a Databricks solution-architecture diagram — a Lucidchart-style platform diagram (sources → Lakeflow/Genie pipeline → lakehouse/lakebase → dashboards, Genie, apps → end user, on a governed platform). Use when someone wants to draw, generate, or edit an architecture diagram, visualize a Databricks solution's components and data flow, or produce an architecture image. Produces a self-contained HTML you render to a PNG and iterate on.
---

# Databricks Architecture Diagram

**Section map** (jump to the one canonical home for each topic):
- *Designing from a request* → **Step 0** read the request's shape · **Step 0.5** where extra context goes (`desc`/`note`/`label`/`ai_reasoning`) · **Step 1** which diagram kind · **Step 2** how much to infer · **Step 2.5** how to draw the data layer.
- *Workflow* → copy a renderer HTML, render to PNG, iterate.
- *The format* → the JSON schema, worked example, **Tabs**, **Positioning** (placement resolution order), **Columns/rowGrid**, **Relational placement**, field tables (**A node** / **An edge**), **Containers**, **physical layout**, **Annotations**, **Custom logos**.
- *Component catalog* → the per-component `wiring:` map (the authoritative edge guide) + icon bank + **Sources**.
- *Authoring rules* → the terse do/don't checklist. *Reference files* → the `.jsonc` examples.

A Databricks solution architecture, drawn to fit **what the request actually describes**. That might be:
- a left→right **flow** (sources → pipeline → compute → dashboards/Genie/apps), the common shape for a single use-case; OR
- a **layered platform** — Databricks added ALONGSIDE an existing stack, or an ask written as explicit LAYERS (ingestion / governance / intelligence / agents / apps) → the layers organize the diagram (usually into lanes); OR
- a **governance / infra** containment picture (UC hierarchy, or cloud/VPC boxes).

**Do NOT force every request into the sources→serve funnel.** The funnel is one shape among several — match the diagram to the request's own structure (see *Designing the architecture* → Step 0). A prompt that lists layers, names external (non-Databricks) systems, or asks for an integration seam wants the **layered** shape, not the funnel.

**The architecture must ultimately make sense.** A user describes what they want in their own words and often leaves out the connective tissue — if they name dashboards and agents but no data layer or compute, ADD what's needed so the story holds together; a diagram missing its ingestion / compute / governance backbone isn't right. Respect what they asked for and keep their emphasis. Equally, don't over-engineer: if a detail wasn't asked for and doesn't help the story, leave it out. Aim for the **smallest architecture that is complete and correct for THIS ask.**

**Overarching principle — fidelity scales with how specific the ask is.** Two goals are in tension: *do exactly what the user said* and *make the architecture make sense*. Which wins depends on how precise and how recent the instruction is:
- **A loose first description** (a use-case, pasted notes, a rough vision — often hand-wavy, sometimes not 100% internally consistent) → your job is **interpretive**: honor the intent and emphasis as much as possible, but fill the gaps and quietly reconcile contradictions so the result holds together. Here *make-it-make-sense* leads. Don't refuse or flag every inconsistency — resolve it into a coherent diagram.
- **A specific instruction** ("connect X to Y", "put the model upstream", "drop the dashboard", "these three are one block") → **respect it literally**, even if you'd have drawn it differently. Precise beats your sense of a tidier architecture.
- **A follow-up correction is the STRONGEST signal there is.** When the user edits or corrects the diagram, do exactly that and do NOT silently revert it toward what seems cleaner to you — if their change looks odd, keep it and record the why in `ai_reasoning`, don't overrule it. Later + more-specific always wins over earlier + vaguer (and over your own defaults).

The rule of thumb: **the vaguer the ask, the more you shape it; the more specific or corrective the ask, the more you obey it verbatim.**

The file is a **flat list of `nodes` + `edges`** — a node is on the canvas iff it's in `nodes` (no visibility/state/diffing). **Author STRUCTURE, not pixels:** place with `col`/`row` lanes, relational fields, `wraps` boxes, and `pin` banners — you almost never write `at`. These compose in a fixed resolution order — full rules in *Positioning* below.

**Edges follow the catalog `wiring:` lines.** Each component's `wiring:` line (in the *Component catalog*) is the authoritative map of what it consumes/depends on: a plain entry is the **normal** edge (draw it when both components are present), one marked *(optional)* is added when the story calls for it. They're the typical connections, not an exhaustive whitelist — a genuine edge the story needs is fine; just don't invent a connection a component wouldn't actually have. **Read the relevant rows before wiring.**

**Avoid floating components.** A **participating** component — one that's IN the data flow — **should** connect to something; by default it doesn't sit on the canvas unwired. `sql-lakehouse` reads from the medallion; `ai-bi-dashboard`/`genie` read from the lakehouse; an app reads from `lakebase`/features and fronts a model; `lakebase` syncs from the pipeline and powers the app. If you place one of these and can't trace an edge into or out of it (following its `wiring:` line), you either forgot the edge or the tile doesn't belong — fix one or the other. The **exception is GLOBAL / cross-cutting things that are ABOUT the whole architecture, not a step in it**: a `type:"note"`/`text` annotation, the `db-platform` banner, a wrapping `box`, and platform-spanning governance (`unity-catalog`/`governance-block`) legitimately have no data-flow edge — they frame the diagram rather than participate in it. But a consumption/app/state tile (`ai-bi-dashboard`, `databricks-apps`, `lakebase`, `genie`, `sql-lakehouse`, a model) is NOT global — it should be wired. This is the failure to watch for in wide multi-lane layouts: those tiles land far from the data they read and get left stranded. **Wiring is a design step, not an afterthought:** after placing tiles, trace the flow end-to-end — walk each source through the pipeline to a consumer/entry point and draw every hop. When a global/governing tile DOES draw an edge, it attaches to what it actually governs — `ai-gateway` to MODEL calls (`model-serving`, apps), `unity-catalog` to data — never chained through whatever tile happens to sit next to it.

## Designing the architecture from a request (architecture-first)

Design a **coherent, functionally-complete architecture that solves the ask** from **the user's request** (their prompt / pasted text) — not from any pre-existing file or default, not a word-for-word transcription, not a fixed template.

### Step 0 — READ THE REQUEST'S OWN STRUCTURE FIRST (do this before anything)

The request usually TELLS you the shape. Extract it before you pick components:

- **Does it list LAYERS / SECTIONS?** ("Layer 1 — ingestion, Layer 2 — governance, Layer 3 — intelligence, …", or numbered/bulleted sections.) → Use the **layered shape** (not the funnel), honoring the request's order and names. Layers often map to left→right lanes, but a layer→column mapping is a starting point, not a rule: a governance/cross-cutting layer usually SPANS the others (a pinned bar/band, not a lane), thin adjacent layers can share a lane, and a layer can run top→bottom. Choose the fewest lanes that keep the flow legible and the connected tiles near each other — many sparse lanes push consumers away from the data they read and leave them stranded. Do NOT collapse a rich multi-layer ask into the 5-tile funnel — that's the #1 failure mode. When the ask *doesn't* dictate its own order, a sane default spine is **sources → data processing → domain + governance → compute → ML / agentic → apps → Genie One** — a starting skeleton only; the ask's own structure and names always win. **Keep each layer coherent** — group same-role tiles into the same lane rather than scattering them (e.g. compute sits as one layer between data and the consumers). This is a preference, not a rule: a layered ask mentioning related tiles in different sentences isn't a reason to split them across lanes unless the ask actually wants them separated.
- **Does it name EXTERNAL (non-Databricks) systems?** (AWS Lambda/Kinesis/S3, an existing app, a third-party bus, "keep X, add Databricks alongside".) → Draw the external side in its OWN boundary `box` and Databricks in ANOTHER; the gap between them is the **integration seam**. Show it **both ways** if the ask mentions callbacks/bi-directional (subscribe IN + call APIs back OUT). Use `file:cloud/<provider>/…` logos for the external side.
- **Does it map future-state to current gaps, name reference customers, or carry other context?** → Those are **`type:"note"` post-its by default** (a `text`/`box` annotation only when you specifically want a plain caption or a titled badge), not core components — place them near what they describe (beside the relevant tile, or below/beside the diagram), just don't let them overlap or crowd the tiles.

**Honor the structure the user handed you** — if they wrote the layers/sections, use those names and order.

### Step 0.5 — where does the EXTRA CONTEXT go? (keep the diagram dense)

A rich request carries far more detail than there are components. Don't drop it, and don't inflate the diagram with it — route each piece to the right lightweight slot, keeping every line **short** so the picture stays scannable:

- **Context ABOUT a component** (what a source/domain/table holds, what a tile is for) → a **`desc`** line under it (title + one short subtitle, like "Lakebase" / "Managed Postgres for app state"). Works on catalog tiles (override only when the default can't say it), and on **`source`** and **`logo`** nodes (set `desc` + it shows; a logo desc is a muted 2nd caption line). **One tight phrase, not a sentence** — the tile stays compact and the layout reserves room for it. If it needs a paragraph, it's not a `desc`.
- **Context from the REQUEST that isn't about any one component** (a rationale, a "keep X / we'll add Y", future-state wins, reference customers, an SLA, a caveat, a team/ownership fact) → a **VISIBLE `type:"note"` post-it, placed beside/below the component it relates to. This is the DEFAULT for request context** — if the user wrote it and it matters, it belongs on the canvas as a note, not compressed into a tile `desc` and NEVER parked in the hidden `ai_reasoning` field. **Lean toward MORE notes:** add one per distinct point rather than cramming several into one or dropping them. (Use a plain `text`/`box` annotation only for a genuine caption/badge; never invent a fake component.)
- **Context about a CONNECTION** (why A feeds B, what flows, an order/step, a non-obvious hop) → a short **edge `label`** drawn ON the edge. Use it whenever the relationship isn't self-evident from position — but keep it to a few words ("Subscribe (streams)", "Query shared context", "Trigger APIs after decision") so edges stay legible and the diagram dense.
- **Your OWN reasoning you want to keep but NOT show** (why you chose a handle, a "don't add X" caution, why a row/col) → the node/edge **`ai_reasoning`** field — it round-trips verbatim and never renders (see rule 10). This is ONLY for your authoring rationale, never for request content the user should see — that goes to a visible post-it above.

The bar: every component and edge that isn't obvious gets a short label or `desc`; everything narrative goes to a note/annotation; nothing becomes a bogus tile, and no line runs long. Dense and self-explanatory beats sparse-but-cryptic or cluttered-with-paragraphs.

### Step 1 — which KIND of diagram is this?

Pick the shape that fits what Step 0 found. Most SINGLE-use-case asks are (1); a multi-layer / "alongside an existing stack" ask is (2).

1. **Flow (solution / demo)** — a left→right DATA-FLOW story: a few sources (default ~4, see *Sources*) → Lakeflow+Genie → lakehouse/Lakebase → dashboard/Genie/app → Genie One → user. The common shape for ONE use-case ("predictive maintenance", "customer 360") or a data+AI feature ask ("Lakeflow Connect + SDP → a model endpoint"). Uses the catalog **tiles** + composites; how much to infer → Step 2; which reference(s) to learn from → *Pick a starting point*. **Layout conventions:** one `box` `wraps` the whole flow (usually not the raw sources) = "the Databricks Platform" (auto-renders behind its children — see *Containers*); `db-platform` + `governance-block` `pin` to its `top-left`/`top-right` (never a raw `at`); Genie One fronts the consumption tiles with auto-arrows.
2. **Layered platform / integration** — the request is organized as **layers**, and/or Databricks sits **alongside an existing (non-Databricks) system**. The layers organize the diagram in the ask's order (usually lanes, but see Step 0 — governance spans, thin layers merge, pick the fewest legible lanes); external systems get their own **boundary box** with an **integration seam** to the Databricks boundary box; governance (Unity Catalog) SPANS the layers as a pinned top bar or full-height band, not one lane tile. Build it from the ask's actual layers (boundary boxes + seam + layers-as-columns). This is the shape for enterprise / "add Databricks to our stack" asks — do NOT reduce it to the funnel. **Logical DOMAINS / knowledge areas** (a "five-domain context", a shared semantic layer, a set of business subject areas any agent can query) → draw each as a `type:"logo"` with **`icon:"file:vendor/genie-ontology"`** (the Genie Ontology mark = logical domain / knowledge), wrapped in a `box` titled for the layer.
3. **Physical / governance** — the Unity Catalog HIERARCHY: workspace → metastore → catalogs → schemas → tables. A **containment** picture (nested boxes), NOT a flow. Trigger: the ask is about UC objects / org structure. Use the container-box presets — see *Databricks physical layout* below.
4. **Infra / networking** — cloud/account topology: VPC / subnets / PrivateLink. Also containment (nested cloud boxes, the *Containers* pattern). Trigger: the ask is about networking / deployment / cloud accounts.

If the ask blends kinds (e.g. "the layered flow, inside our VPC"), compose them.

### Step 2 — (solution/demo only) how much to infer

- **Broad / use-case ask** ("predictive maintenance", "fraud detection", "a governed data platform"): **infer the full end-to-end shape** the use-case implies. Predictive maintenance is a MODEL story → sensors/history → pipeline → ML training → registry → serving → scoring + dashboards. **Don't under-scope** to the couple of nouns typed — add the components that make it actually work.
- **Named-component ask** ("Lakeflow Connect + SDP into UC, served by a model endpoint"): **assemble exactly those into a working whole** — honor what they named + add the connective tissue that wires it (platform `box`, ingest ports, an entry point, the edges). **Don't over-build** past what they asked, **don't under-build** to isolated unconnected tiles.

Either way, components that belong together, wired so the flow reads correctly, on the governed platform.

**Don't copy a reference verbatim — adapt it to THIS ask. References are for inspiration.** Read the reference(s) to learn the PATTERN (which components connect, how the layout/handles/pins work), then build a fresh diagram for THIS ask. **Read as many references as are relevant** — most real asks mix several: take the ML platform's serving lane, add the agent-bricks supervisor, drop the governance bar on top, wrap it in the layered shape's boundary boxes, swap the sources. Pick whichever references inform the ask, learn from each, and compose your own. A reference matches the ask 1:1 only rarely — even then, adapt it (names, sources, which components) rather than reproduce it. See **Pick a starting point** for what each offers.

### Step 2.5 — pick how to draw the DATA / INGEST layer (3 ways)

The bronze→silver→gold data layer can be drawn three ways. Pick by **what the story emphasizes** — don't default to one:

1. **`lakeflow-genie-block` (or `lakeflow-block`) — the big unified block.** Shows the whole ingest story in ONE block: Connect · Zerobus · raw-file landing on the left rail, the SDP medallion (bronze→silver→gold), Delta/Iceberg, and (genie variant) a "Built with Genie Code" footer. **Use when ingestion IS part of the story** — you want to showcase how data lands + gets processed, all products in one tidy block. Optional `bronze_desc`/`silver_desc`/`gold_desc` params add a short caption under each layer.
   ```json
   { "id": "data", "type": "lakeflow-genie-block", "col": "pipeline",
     "params": { "gold_desc": "Business marts + metrics" } }
   ```
2. **`medallion-table` — the simpler block.** Just bronze→silver→gold in one compact tile, no ingest rail. **Use when ingestion is NOT the focus** but you still need the medallion — especially when you want the **Feature Store / Metric Views** forks off gold (`params:{feature_store,metric_views}`, wired via `@out-fs`/`@out-mv`/`@out-gold`). Same `*_desc` layer-caption params.
   ```json
   { "id": "med", "type": "medallion-table", "col": "pipeline",
     "params": { "feature_store": true, "metric_views": true } }
   ```
3. **DIY — compose it yourself.** When you want to go into DETAIL and list the actual tables: a `type:"box"` per layer (title `"Bronze"`/`"Silver"`/`"Gold"`) wrapping `type:"logo"` tiles (icon `bronzeLayer`/`silverLayer`/`goldLayer`, `text` = the table name). Tiles use `col`/`row` inside the box's column; each box needs no `col`/`pad`/size/`z` — it auto-sizes around its tiles (z is automatic — see *Containers*). Flow edges box→box. Optionally wrap all three in a **parent box** titled "Lakeflow Spark Declarative Pipelines" with the SDP logo (`titleIcon:"sdpBrand"`) — a box `titleIcon` accepts ANY icon-library key.
   ```json
   { "id": "b1", "type": "logo", "icon": "bronzeLayer", "text": "orders_raw",   "caption": "right", "col": "bronze", "row": 1 },
   { "id": "b2", "type": "logo", "icon": "bronzeLayer", "text": "events_raw",   "caption": "right", "col": "bronze", "row": 2 },
   { "id": "s1", "type": "logo", "icon": "silverLayer", "text": "orders",       "caption": "right", "col": "silver", "row": 1 },
   { "id": "s2", "type": "logo", "icon": "silverLayer", "text": "events",       "caption": "right", "col": "silver", "row": 2 },
   { "id": "g1", "type": "logo", "icon": "goldLayer",   "text": "customer_360", "caption": "right", "col": "gold",   "row": 1,
     "ai_reasoning": "only add ai_reasoning when there's a real authoring choice to record — don't invent" },
   { "id": "bronze-box", "type": "box", "title": "Bronze", "wraps": ["b1", "b2"] },
   { "id": "silver-box", "type": "box", "title": "Silver", "wraps": ["s1", "s2"] },
   { "id": "gold-box",   "type": "box", "title": "Gold",   "wraps": ["g1"] },
   { "id": "sdp-box", "type": "box", "title": "Lakeflow Spark Declarative Pipelines", "titleIcon": "sdpBrand",
     "wraps": ["bronze-box", "silver-box", "gold-box"], "pad": 28,
     "ai_reasoning": "hidden rationale goes INLINE as an ai_reasoning field — the JSON has no // comments" },
   { "id": "note-residency", "type": "note", "text": "PII stays in the EU region; owned by the Data Platform team.", "below": "sdp-box",  "gap": 32 },
   { "id": "note-sla",       "type": "note", "text": "Data refreshed every 15 min · end-to-end latency ~2 min source→Gold.", "below": "gold-box", "gap": 32 },
   { "id": "note-ownership", "type": "note", "text": "Gold layer owned by the data-insights team.", "rightOf": "note-sla", "gap": 24 }
   ```
   The block is **plain JSON — no `//` comments.** Anything you'd write as a comment about a node is either a visible caption (`desc`/`label`), a visible `type:"note"` post-it, or the invisible `ai_reasoning` field ON that node — never a `//` line. Edges for this block: `bronze-box@r → silver-box@l` and `silver-box@r → gold-box@l` (`flow: true`). Feed any of the three from the left with a few `source` tiles (vary them per demo) — into the ingest ports for option 1 (`@in-lakeflow-connect`/`@in-zerobus`/`@in-direct`), or into `@l` for options 2/3.

   **Add AS MANY `type:"note"` post-its as the request has context for** — one per distinct piece of non-component context (a constraint, an SLA, residency, ownership, a "keep X / add Y" principle, a caveat). The example shows three; a rich prompt may warrant more. Don't cram several facts into one post-it, and don't drop context because there's no tile for it — that's exactly what post-its are for. (Visible post-it vs invisible `ai_reasoning` field: the distinction lives in *Step 0.5* — request narrative the user should see → `type:"note"`; your own hidden rationale → `ai_reasoning`.)

---

<!-- BEGIN: local-render-workflow (stripped when the skill runs inside Solution Builder — the app renders architecture.md live in its own canvas) -->
## Workflow — how to make a diagram

The diagram is **one self-contained HTML file** with its JSON in an inline block. Steps:

1. `cp renderer/architecture-viewer.html my-arch.html` (or `architecture-editor.html` for a browser-editable copy with Load/Download buttons).
2. Replace the JSON inside `<script type="application/json" id="architecture">…</script>` with your array (schema below; plain JSON, no `//`). Learn the schema from **The format** below + the relevant `reference/*.jsonc` — then author your OWN diagram for the ask (don't paste a reference in whole).
3. Open in any browser (no server), or render + read the PNG to iterate (below).

**Render loop (do this every edit):**

```
npx playwright install chromium-headless-shell   # one-time (~90MB)
node renderer/render-arch.mjs my-arch.html        # → my-arch.png
```

**Read `my-arch.png`** — check components present, wired right, laid out clean; fix the JSON; repeat. Uses `chromium-headless-shell` over CDP (just the shell + node 18+, auto-found in Playwright's cache). If it reports "No Chrome/Chromium found", run the install line or set `CHROME_PATH=/path/to/chrome`.
<!-- END: local-render-workflow -->
<!-- BEGIN: in-app-workflow (injected only when the skill runs inside Solution Builder) -->
<!-- END: in-app-workflow -->

---

## Pick a starting point and read trusted example

Which reference(s) each request style maps to (most asks draw from more than one; see *Designing the architecture* above):

| If the user wants… (example prompt) | Start / borrow from | Shows |
|---|---|---|
| A general **data + AI / analytics demo** on a single use-case, or a broad "governed platform / data platform" ask with no named layers | `reference/architecture-complete.jsonc` — a worked **flow** example | The full sources → Lakeflow+Genie → lakehouse/Lakebase → dashboard/Genie/app → Genie One flow. Extend it with what the use-case implies (Step 2). |
| An **enterprise / layered** ask — organized as LAYERS, or "add Databricks ALONGSIDE our existing (AWS/other) stack", or naming an integration seam | *Step 1 shape #2* (no reference file — build from the ask) | Layers-as-columns + an external cloud **boundary box** (Kinesis/Lambda/S3…) beside a Databricks **boundary box**, a bi-directional integration seam, governance spanning the top. Use this the moment the ask has explicit layers or an external system — NOT the funnel. |
| Anything **model-driven** — "predictive maintenance", "churn", "recommendations", "fraud", "ML platform" | `reference/ml-platform.jsonc` | `rowGrid` matrix, medallion Feature Store fork (`@out-fs`), Vector Search / RAG, model training → registry → real-time + batch serving. Predictive-maintenance-shaped. |
| An **assistant / RAG / multi-agent** demo — "route questions across our data + docs + tools" | `reference/agent-bricks.jsonc` | Supervisor over Knowledge Assistant · Genie Agent · Hosted MCPs over a governed medallion → Genie One. |
| A **minimal** "ingest → lakehouse → dashboard + Genie for the business" | *The format* inline example (below) | The smallest ingest → lakehouse → dashboard/Genie → Genie One flow. Use only when the ask is genuinely that small. |
| A **physical / governance** layout — "show workspace, metastore, catalogs, schemas" | `reference/governance-layout.jsonc` (+ *Databricks physical layout* below) | Nested Workspace / Metastore / Catalog / Schema / Table boxes — a governance picture, not a data-flow one. |

You can open multiple to compose them for trusted layout.

## The format

The example below is the **use-case starting point**: when the user types a plain USE-CASE with no named components or layers ("a customer-360 demo", "churn analytics for retail"), start from this funnel and **ADD the components that use-case requires** — a prediction story adds ML training → registry → serving; an assistant story adds a supervisor + Knowledge Assistant; a real-time story adds streaming ingest. A pattern to build ON, not a floor to reduce everything to. (When the ask NAMES layers or an external stack, it is NOT this shape — use the layered reference per Step 0/1.) It also teaches the JSON schema + edges/handles/pins. Emit an array of tabs (`[ … ]`, see *Tabs*). **Plain JSON — no `//` comments.** Any explanation lives INLINE as an `ai_reasoning` field on the node/edge it's about (never rendered, round-trips on save) — the example uses it to teach the schema, exactly as you'd document your own non-obvious choices:

```json
{
  "name": "Customer 360",
  "story": "Ingest our Postgres, ERP, sensor, and PDF data into a governed lakehouse, then give the business a dashboard and a Genie Agent to ask questions in plain language — reached through Genie One, all on Databricks.",
  "columns": ["sources", "pipeline", "compute", "work", "entry"],
  "nodes": [
    { "id": "src-postgres", "type": "source", "col": "sources", "row": 1, "label": "Postgres", "icon": "file:vendor/postgresql",
      "ai_reasoning": "sources stack by row; each source's edge (below) names the Lakeflow ingest PORT it lands on — that target handle drives BOTH the port anchor and the flow animation" },
    { "id": "src-erp", "type": "source", "col": "sources", "row": 2, "label": "Acme ERP", "icon": "text",
      "ai_reasoning": "no vendor logo for this internal ERP → icon:\"text\" draws the label as a brand-colored text badge (niche/internal systems)" },
    { "id": "src-sensors", "type": "source", "col": "sources", "row": 3, "label": "Sensor data", "icon": "sensorSource",
      "ai_reasoning": "realtime stream → its edge targets @in-zerobus (particle-river animation)" },
    { "id": "src-docs", "type": "source", "col": "sources", "row": 4, "label": "PDF documents", "icon": "pdfLogo",
      "ai_reasoning": "files → its edge targets @in-direct (travelling-docs animation)" },
    { "id": "lakeflow-genie-block", "type": "lakeflow-genie-block", "col": "pipeline",
      "ai_reasoning": "the one data-layer block: ingest + bronze→silver→gold, built by Genie Code" },
    { "id": "sql-lakehouse", "type": "sql-lakehouse", "col": "compute",
      "ai_reasoning": "governed serving copy; the consumption lane (dashboard + Genie) reads from here" },
    { "id": "ai-bi-dashboard", "type": "ai-bi-dashboard", "col": "work", "row": 1 },
    { "id": "genie", "type": "genie", "col": "work", "row": 2 },
    { "id": "genie-one", "type": "genie-one", "col": "entry", "rot": 90,
      "ai_reasoning": "business-user entry point / interface onto everything to its left; persona pill built IN (no separate user node); rotated 90° into a slim lane; its edges auto-arrow (no flow/arrow needed)" },
    { "id": "db-platform", "type": "db-platform", "pin": { "at": "top-left", "to": "platform-box" },
      "ai_reasoning": "top-band banner PINNED to the box corner (never absolute at — those drift off-corner when the node set changes); a non-float pin RESERVES a top band so the box grows to enclose it" },
    { "id": "governance-block", "type": "governance-block", "pin": { "at": "top-right", "to": "platform-box" } },
    { "id": "platform-box", "type": "box",
      "ai_reasoning": "one white box wrapping the whole flow = 'all of this is the platform'; no z needed — a wrapping box auto-renders behind its children (see Containers)",
      "wraps": ["src-postgres", "src-erp", "src-sensors", "src-docs", "lakeflow-genie-block", "sql-lakehouse", "ai-bi-dashboard", "genie", "genie-one"] }
  ],
  "edges": [
    { "id": "e1", "from": "src-postgres", "to": "lakeflow-genie-block@in-lakeflow-connect", "flow": true,
      "ai_reasoning": "databases/SaaS land on @in-lakeflow-connect; naming the port on the target handle drives the port anchor AND the flow animation" },
    { "id": "e1b", "from": "src-erp", "to": "lakeflow-genie-block@in-lakeflow-connect", "flow": true },
    { "id": "e1c", "from": "src-sensors", "to": "lakeflow-genie-block@in-zerobus", "flow": true },
    { "id": "e1d", "from": "src-docs", "to": "lakeflow-genie-block@in-direct", "flow": true },
    { "id": "e2", "from": "lakeflow-genie-block", "to": "sql-lakehouse", "flow": true },
    { "id": "e3", "from": "sql-lakehouse", "to": "ai-bi-dashboard", "flow": true },
    { "id": "e4", "from": "sql-lakehouse", "to": "genie", "flow": true },
    { "id": "e6", "from": "genie-one", "to": "ai-bi-dashboard",
      "ai_reasoning": "Genie One fronts the consumption tiles; its edges auto-arrow away from it toward the resource" },
    { "id": "e7", "from": "genie-one", "to": "genie" }
  ]
}
```

### Tabs — the file is an ARRAY of architectures

Top level is a JSON **array**, one element (the shape above) per **tab**; its `name` is the tab label. Multiple tabs = multiple views of one diagram (e.g. "Ingestion" / "Serving"). **Always emit the full array** `[ { … } ]`, even for one tab (a bare object is accepted but re-serialized as an array). Emit every tab each time.

### Positioning: how the strategies compose

You have several placement strategies and they are designed to **layer**, not compete. They resolve in this fixed order — each stage respects everything placed before it, so you can freely combine them:

1. **`at`** (explicit `[x,y]` pixels) — used verbatim, **always wins**. Escape hatch; you rarely write it.
2. **Columns** — `col` (lane) + `row` (order in lane), or a shared **`rowGrid`** matrix. The backbone of most diagrams.
3. **Auto-seed** — a bare node (no `col`/`at`/relational) that is *only* placed by being in some box's `wraps` gets stacked inside that box automatically (see *Containers*).
4. **Relational** — `below`/`above`/`leftOf`/`rightOf`/`alignX`/`alignY` position a node against another node's resolved box (see below). Runs after columns, so the anchor already has its place.
5. **Boxes** — `wraps`/`bounds` size around whatever their children resolved to (columns + relational + seeds), innermost first; a box may itself be placed with `below`/`above`/`alignY`.
6. **Pins** — `pin` docks a banner/persona into a box corner, last of all.

**Precedence per node:** `at` > `pin` > relational > `col`/`row`. Set at most ONE relational field per node.

**Composition cheatsheet** (all verified to work together):
- A `rowGrid` matrix (col+row) **with** a `rightOf` satellite off one tile **inside** a `wraps` platform box **with** a pinned governance banner — all at once. The box grows to include the satellite; the pin reserves its band on top.
- A `wraps` box whose children are a mix of `col`-placed tiles **and** bare auto-seeded ones — the placed tiles keep their lane, the bare ones stack **below** them inside the box.
- Nested boxes (`wraps` of `wraps`), one placed `below` another via a box-level `below` — the whole subtree shifts together.

### Columns, and the optional row-grid

Default placement: **`col` = X** (which lane), **`row` = order WITHIN that lane** (top→bottom); each lane centers its own stack independently. Lanes don't line up row-for-row.

Set top-level **`rowGrid: true`** to turn `row` into a **shared horizontal band across ALL lanes** — same `row` number = same Y line in every column. `col` still sets X; only Y changes. Use it when you want a clean matrix (rows reading straight across):

```
rowGrid: true                columns →   pipeline    ml            serving
                            row 0                     UC Registry   Model Serving
                            row 1   ← (skipped: empty band = vertical space)
                            row 2    Batch Job        Model Training
                            row 3    Medallion        …             Lakebase
```

Rules under `rowGrid`:
- **Rows sit on a FIXED PITCH** — row `N` lands on the same Y line in every column, so tiles across columns register into clean horizontal rows. The whole grid is centered on y=0.
- **`row` numbers are grid coordinates, not just order.** SKIP a number to insert an empty row of vertical space (rows `0,2,4` are more spread out than `0,1,2`) — the lever for opening room when edge labels between two rows collide.
- **No `row`** → that node falls back to stacking within its own `col` (e.g. leave the data sources row-less to just stack them).
- **`at` / `alignY` / `below` / `above` still override** a node's grid position (per node).
- **Line the source up with what it feeds** — give a source the SAME `row` as its target so the feed edge is a clean horizontal line (e.g. `src-pdf` and `knowledge-assistant` both on row 4; `src-postgres` and `medallion-table` both on row 3).
- **A TALL node (medallion with forks, agent-bricks, lakeflow blocks) OVERFLOWS DOWNWARD in its OWN column** — it spans into the next cell's space without pushing other columns or inflating the shared row. So a short tile at the same `row` in another column stays put (no gap from the tall neighbor). Just don't place another node in this column on the row(s) the tall node overflows into, or they'll overlap — give the tall node room below it in its lane.

### Relational placement (place a node against another)

When a node's spot is best described *relative to another node* rather than by a lane, use ONE of these instead of guessing `at`. Each references another node's **id**; it resolves AFTER columns (so the anchor keeps its own place), and the engine auto-de-overlaps the result.

| field | effect |
|---|---|
| `alignX: "<id>"` | copy that node's center **X** (keep your own Y from col/row). |
| `alignY: "<id>"` | copy that node's center **Y** (keep your own X). |
| `leftOf` / `rightOf: "<id>"` | sit just left/right of that node, centered on its Y; `gap` = px between them (default 40). |
| `above` / `below: "<id>"` | sit just above/below that node, centered on its X; `gap` = px (default 40). |

- **One per node.** If several are set only one applies (precedence `alignX > alignY > leftOf > rightOf > above > below`). `at` still wins over all.
- **Chains resolve in order** — `A rightOf B`, `B rightOf C` settles C→B→A.
- **Siblings fan out** — several nodes `rightOf` the SAME anchor spread along the perpendicular axis instead of stacking on one point.
- **A satellite inside a `wraps` box is still enclosed** — the box grows to include it. So `rightOf` a tile that's inside the platform box keeps the satellite in the box.
- **Boxes may use `below`/`above`/`alignY` too** (not leftOf/rightOf) — see *Containers*.

### Top level  *(each element of the tabs array)*
| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | The **tab label** for this architecture. Defaults to "Architecture N". |
| `story` | No | One-line description of this architecture. Metadata (kept in the file); not rendered on the canvas. |
| `options.trademarkLogos` | No | `true` → render real third-party brand logos. Default `false` (neutral badges). |
| `columns` | No | Ordered left→right **lane names**. Nodes reference one via `col`. Add/rename/insert lanes freely for a different shape — no fixed taxonomy. |
| `rowGrid` | No | `true` → `row` aligns across ALL lanes into shared horizontal bands (a matrix). Off (default) → `row` orders within a lane. Full rules in *Positioning* above. |
| `custom_logos` | No | `[{ id, svg }]` — inline SVG logos. Reference one from any node's `icon` as `"custom:<id>"`. See *Custom logos & images*. |
| `nodes` | Yes | The components on the canvas (see below). |
| `edges` | Yes | The lines between them. |

### A node
| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique (per tab) free-form handle that `edges`/`wraps`/relational fields reference. Need NOT match `type` (`{id:"gold-medallion", type:"medallion-table"}` is fine). 2nd instance of a component: `type#2` or any unique id. |
| `type` | Yes | The **catalog component id** — this is what identifies the component (label/icon/desc/ports resolve from it): `genie`, `sql-lakehouse`, `lakeflow-genie-block`, `governance-block`, `db-platform`, … (see the catalog below; folds in the old composite "kind") OR a special kind: `source` · `box` · `text` · `logo` · `image`. |
| `col` | placement | The lane (from `columns`) this node sits in. Nodes in a lane stack vertically, centered. **Primary way to place a node.** |
| `row` | No | Within-lane order (default), or a shared cross-lane band with `rowGrid: true` — see *Positioning* above. |
| `wraps` | container | On a `type:"box"`: the node ids this box ENCLOSES. The box auto-sizes around them (+ `pad`, default 24). Nesting works (a box may wrap boxes) — see *Containers*. |
| `bounds` | container | On a `type:"box"`: per-side edge anchors `{ left?, right?, top?, bottom? }`. Each side = `"<nodeId>:<anchor>"` (anchor ∈ `left`/`right`/`center` for x, `top`/`bottom`/`center` for y), or `"col:<name>:<anchor>"` (a lane's edge/midpoint), or `"wrap"`. Lets the box edge cut HALFWAY through a node/column. Unspecified sides fall back to `wraps`. |
| `title` · `titleIcon` | box | On a `type:"box"`: the label drawn on the container's top-left corner (`title`) + an optional icon beside it (`titleIcon` — an icon key like `dbCatalog`, `databricksMetastore`, `file:vendor/databricks`). **Prefer these over `label` for a titled container** (Workspace / Metastore / Catalog / platform boxes). `label` also works but has no icon slot. |
| `pin` | placement | Dock this node into a box corner (overrides `col`). An object `{ at, to?, pad?, float? }`: `at` = one of `top-left`·`top`·`top-right`·`left`·`center`·`right`·`bottom-left`·`bottom`·`bottom-right`; `to` = box id to dock into (default: the largest box); `pad` = inset px (default 16); `float` = `false`/omitted → **reserve a band** (the box GROWS so this never overlaps content — top pin pushes content down, bottom extends the box down), `true` → **overlay** at the corner (may sit over content). Use for banners / personas. |
| `at` | No | `[x, y]` **explicit** position (node center). **Overrides `col`/`pin`.** Use for fully manual placement. (A user drag also persists here.) |
| `size` | No | `[w, h]` if resized from the natural size. |
| `rot` · `scale` · `z` · `pad` | No | Rotation° (0/90/180/270), content scale, stacking order (negative = behind), container padding. |
| `group` | No | A shared string id stamped on several nodes → they form a GROUP: selecting one selects all, and they move together on the canvas. |
| `label` · `icon` | No | Override the catalog default label/icon (only when it differs). **Exception — a `type:"source"` has NO catalog default, so it REQUIRES an explicit `label`** (omit it and the tile falls back to an ugly icon-derived name like "Pdflogo"). `icon` may be a built-in name, a `file:vendor/…`/`file:cloud/…` key, or a `custom:<id>` (see *Custom logos & images*). |
| `ai_reasoning` | No | **AI reasoning — NEVER rendered, never affects layout.** Free text explaining WHY this node is here or what a non-obvious choice means (a relabeled generic tile, why a `row`/`col` was picked, a param's effect). Round-trips verbatim (survives drags/saves). Distinct from `desc` (the visible line) and `type:"note"` (the visible post-it). For your own authoring rationale only — request content the user should see goes to a `type:"note"` post-it. Use it so an example stays self-documenting — see rule 10. |
| `desc` | No | Description line under the label. **On a catalog component: OMIT it** — the catalog default (see the catalog table) renders and is the source of truth. Set `desc` ONLY to override that default with something the default can't say — e.g. a **relabeled** tile whose default no longer matches (`lakeflow-jobs`→"Batch Scoring Job", `model-serving#2`→"RAG Endpoint"). On a `source`/`logo` there's no catalog default, so `desc` is its only description (optional). `""` clears it. If you find yourself paraphrasing the default, delete the `desc` (or improve the default in code). |
| `showDesc` | No | `true`/`false` to force the description line on/off. **Default:** a catalog tile shows its description when it has one; a `source`/`logo` shows it only when you set `desc`. |
| `caption` | source · logo | Where the label sits relative to the icon: `right` · `left` · `top` · `bottom`. **Default:** `right` for a source, below (`bottom`) for a logo. |
| `fontSize` | source · logo · text/box | Label font size in px. Applies to source/logo captions and to `text`/`box` annotations. |
| `text`·`bold`·`vAlign`·`hAlign`·`src` | box/text/logo/image | Annotation props — see *Annotations*. (`fontSize` and `caption` are in the rows above.) |
| `style` | No | `{ border, borderStyle, borderColor, radius, shadow, fill, font, opacity }` — visual overrides; emit only what differs. `border` = width px (0 = none); `borderStyle` = `solid`/`dashed`; `borderColor`/`fill`/`font` = hex; `radius` = corner px; `shadow` = 0–100 intensity (0 = none); `opacity` = 0–1. |

The **band** a component belongs to (which sets its tile color) is derived from its `type` — you never write it.

### An edge
`{ "id"?, "from": "<srcId>[@handle]", "to": "<tgtId>[@handle]", "flow"?, "arrow"?, "dashed"?, "shape"?, "flowStyle"?, "centerX"?, "label"?, "ai_reasoning"? }`

- **Write `from`/`to` by node id; the `@handle` is INFERRED** from geometry: left→right ⇒ source `@r` → target `@l`; vertical ⇒ `@b`/`@t`. A **source** feeding the Lakeflow block must name the target ingest port EXPLICITLY on the handle — `@in-lakeflow-connect` (databases/SaaS), `@in-zerobus` (realtime streams/sensors), or `@in-direct` (files: PDF/CSV/Parquet). That handle also picks the flow animation: `@in-zerobus` → particle stream, `@in-direct` → travelling docs, else → laser beam.
- Add an explicit **`@handle`** only to override the inference — a composite port (`in-lakeflow-connect`, `in-zerobus`, `in-direct`, `r`) or a side (`l`/`r`/`t`/`b`). E.g. force a vertical link with `@b`/`@t`.
- `flow: true` → animated "data flowing" line. Omit for a static line.
- `arrow`: omit/`"auto"` (default — auto-draws an arrowhead for edges touching the **user persona** or **Genie One**) · `"none"` · `"end"` · `"start"` · `"both"`. An explicit arrow is a static relationship line.
- `shape`: `smooth` (default) · `straight` · `step`. `flowStyle`: `dot`·`particles`·`docs`·`laser`.
- `label` = text drawn ON the edge (short — it's rendered). `ai_reasoning` = **NEVER rendered** — the *reasoning* for the edge (why it exists, why a handle was chosen, a "don't add X" caution). It round-trips verbatim, so use it to make an example self-explanatory. See rule 10.

### Containers (wrapper boxes)
A `type:"box"` with `wraps: [ids]` becomes a **labeled container** that auto-sizes to enclose those nodes (+ `pad`) and auto-renders behind them. It's how the big white **platform box** works (`wraps` the whole flow). Nesting is recursive — model a cloud diagram by wrapping wrappers:

```json
{ "id": "aws", "type": "box", "label": "AWS", "wraps": ["vpc"], "pad": 28 },
{ "id": "vpc", "type": "box", "label": "VPC 10.0.0.0/16", "wraps": ["subnet-a"], "pad": 22 },
{ "id": "subnet-a", "type": "box", "label": "Private subnet", "wraps": ["app", "db"], "pad": 16 },
{ "id": "app", "type": "databricks-apps-work", "col": "compute" },
{ "id": "db",  "type": "lakebase", "col": "compute" }
```

The inner nodes get placed (by `col` or `at`); each box sizes itself around its members, innermost first. You never compute a box's `at`/`size`. **Z is automatic** — a wrapping box renders behind its children and nesting deepens on its own (outer boxes drop further back), so you don't set `z` on the boxes above; a box's title/border still sits on top. (Set `z` only to deliberately override that ordering.)

**Auto-seed — a box can arrange its own children.** A child that has NO placement of its own (`col`/`at`/relational) but is listed in a box's `wraps` is **auto-seeded**: it stacks vertically inside that box, in `wraps` order, centered on the box. So the minimal container is just `wraps` + nothing on the children — e.g. one Unity Catalog tile inside a Metastore needs no `col`. **Mixed boxes work**: if some wrapped children ARE placed (by `col`) and some are bare, the placed ones keep their lane and the bare ones stack BELOW them inside the box. (Prefer `col` when you have several siblings you want lined up in a specific order; lean on auto-seed for a lone child or a quick stack.)

**Positioning a box relative to another box** — a box's position is normally derived from what it `wraps`, so two sibling boxes can't be arranged by wrapping alone. To place one under/over/aligned-with another, a box may use **`below` / `above` / `alignY`** (with `gap`) referencing another node or box; it shifts with its whole subtree and its parent re-sizes around it. Width still comes from its contents or `bounds`. E.g. a full-width **Metastore** bar under two side-by-side Workspace boxes: `{ "id":"metastore", "type":"box", "below":"ws-prod", "gap":50, "bounds":{ "left":"col:prod:left", "right":"col:dev:right" }, "wraps":["unity-catalog"] }`.

### Databricks physical layout (workspace / metastore / catalog)

For a **governance / physical** ask ("show our workspace, metastore, catalogs, schemas") draw the Unity Catalog hierarchy as **nested container boxes + logo annotations** — NOT the data-flow tiles. The pieces are ordinary boxes/logos:

- **Admin Account** → `type:"box"` container (`title` "Databricks Admin Account"; icon `file:vendor/databricks-admin` — the Databricks mark + an admin persona). The top of the org hierarchy; wraps the workspace(s).
- **Workspace** / **Metastore** → `type:"box"` containers (`title` "Databricks Workspace" / "Databricks Metastore"; icons `file:vendor/databricks` / `databricksMetastore`).
- **Catalog** / **Schema** / **Table** → `type:"logo"` marks (icons `dbCatalog` / `dbSchema` / `dbTable`) with a side caption.

Nest by containment: Workspace `wraps` the Metastore, Metastore `wraps` Catalogs, a Catalog `wraps` its Schemas — same recursive `wraps` as the cloud example above. **See `reference/governance-layout.jsonc` for the worked pattern** — read it, then build your own for the actual catalogs/schemas.

Two things that WILL bite if you author this from scratch (both in that reference):
- **Placing the leaves.** Use `columns` (one lane per catalog) so sibling schemas line up in tidy per-catalog stacks, then the catalog box `wraps` them. You *can* also leave a leaf **bare** (no `col`/`at`) and let it auto-seed inside its box — good for a lone child (e.g. one Unity Catalog tile inside the Metastore); for several siblings a `col` reads cleaner. Either way the box sizes around them.
- **Nested-box stacking is automatic** (z — see *Containers*): each level renders behind the one it contains (workspace behind metastore behind catalog behind the leaf logos).

### Annotations (free-form, not catalog components)

Four `type`s let you add labels and marks that aren't Databricks components:

| type | props | use |
|------|-------|-----|
| `text` | `text`, `fontSize`, `bold`, `vAlign`/`hAlign` | a free-floating text label. |
| `box` | `text`, `fontSize`, `vAlign`/`hAlign`, + `wraps`/`bounds`/`pad` | a labeled rectangle / container (the platform box, cloud/VPC boxes). |
| `logo` | `icon` (any icon key, incl. `file:…` or `custom:<id>`), `text` (the caption), `caption` (right/left/top/bottom — default below), `fontSize`, `desc`/`showDesc` | a standalone logo — e.g. the `file:persona/user` end-user marker. |
| `image` | `src` | a standalone image (URL or base64 — see below). |

> A `box` shows a 1px border by default; `text` shows none. The border is controlled ONLY by `style` — set `style.border` (px width, `0` = none), `style.borderColor`, `style.borderStyle` (`solid`/`dashed`). There is no separate border boolean.

### Node text: caption positions (source / logo)

Tiles/sources/logos = icon + `label` + optional `desc` line. Sources & logos also take a `caption` = where the label sits vs. the icon (`top`/`bottom` use a taller box):

```
right:  [icon] Label      left:  Label [icon]
top:      Label           bottom:   [icon]
         [icon]                     Label
```

```json
{ "id": "src-crm", "type": "source", "icon": "file:vendor/salesforce",
  "label": "Salesforce", "caption": "bottom", "fontSize": 12,
  "desc": "Nightly account + opportunity export" }
```

### Default look per node kind (what's actually drawn)

The renderer gives each kind a different **default** chrome, so the same `style` fields land differently. Set `style` only to deviate:

| kind | border | shadow | fill | notes |
|------|--------|--------|------|-------|
| catalog **tile** (product/source) | thin band-tinted border | subtle drop shadow | `bg-card` (theme surface) | the standard boxed tile; band color comes from its `type`. |
| **logo** annotation | **none** | **none** | **transparent** | just the mark + caption, no box. Add `style.border`/`style.fill` to turn it INTO a boxed tile (a border/fill auto-adds a default shadow). |
| **box** annotation | 1px | none | transparent (a `box` used as a plain rectangle is solid white; a `wraps` container is transparent) | labeled container. |
| **text** annotation | none | none | none | bare text. |
| composite (`lakeflow`, `governance`, `agent-bricks`, `db-platform`, …) | own internal chrome | varies | own | self-contained blocks; `db-platform` defaults to no outer border, `governance` has a thin 1px border. |

### Custom logos & images

- **Label-only source (no logo)** — for a source or partner you have no logo for, set `"icon": "text"` (or omit `icon`) on a `type:"source"` node. It renders the `label` as a brand-colored text badge (the same style as a trademark-gated logo) — no icon file needed. Prefer this over an unrelated logo when there's no real mark.
- **Custom SVG logos** — add inline SVGs in the top-level `custom_logos` array and reference them by id from ANY node's `icon`:
  ```json
  "custom_logos": [
    { "id": "acme", "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='#7C3AED' d='M12 2l3 7 7 .5-5 4.5 1.5 7L12 17l-6 4 1.5-7-5-4.5 7-.5z'/></svg>" }
  ]
  ```
  Then `"icon": "custom:acme"` on a `type:"source"` tile (a named data source with a custom brand) OR a `type:"logo"` node (a standalone mark). Custom logos are never trademark-gated — always shown. (Escape the SVG quotes for JSON, or use single quotes inside the SVG as above.)
- **Images (base64)** — a `type:"image"` node with `"src": "data:image/png;base64,…"` (or an http URL). **Standalone only** — an image is its own node; you can't use it as a component/source `icon` (use a `custom_logos` SVG for that).

---

## Component facts live in the catalog

Per-component facts (title, `ports`/`@handle`s, composite internals, when-to-use) live in the generated **Component catalog** below — the single source of truth; read the row, don't restate it in a `desc`. (The per-shape layout — the flow's platform box + banners + Genie One, the layered shape's columns + boundary boxes, the governance shape's nested containment — lives with each shape in *Step 1* and its reference file.)

---

## Component catalog (dense reference)

<!-- BEGIN: generated-catalog -->

<!-- AUTO-GENERATED from CATALOG in app/.../lib/platform-architecture.ts
     by `bun run scripts/gen-architecture-skill.ts` — DO NOT EDIT BY HAND. -->

Use the `type` id; the renderer supplies the icon, label, default description and size. Override `label`/`desc` only when story-specific. Composite blocks carry their own internal layout — treat each as ONE node (don't also add its sub-parts).

### Agentic Data `agentic-data`

*The data foundation — ingest + the medallion pipeline (bronze→silver→gold) + the lakehouse / Lakebase it lands in. Where the demo's data comes IN and is refined.*

| type | default title | default description (shown on the tile) | size | when to use |
|------|---------------|-----------------------------------------|------|-------------|
| `lakeflow-block` | Lakeflow | One block: managed ingest (Lakeflow Connect), real-time streams (Zerobus) and direct file landing, all flowing into a declarative bronze → silver → gold pipeline. | 268×148 | The whole ingest + bronze→silver→gold SDP in one block (no Genie Code framing). Contains SDP — never add a separate sdp tile beside it. OPTIONS (params, all optional strings): `bronze_desc` / `silver_desc` / `gold_desc` — a SHORT caption under that layer's cylinder (e.g. `gold_desc:"Business marts + metrics"`); the block grows to fit. Keep each to a few words. |
| | | | | **ports:** `in-lakeflow-connect` ← databases / SaaS apps · `in-zerobus` ← realtime streams / sensors · `in-direct` ← files: PDF / CSV / Parquet · `r` → the compute layer |
| | | | | **wiring:** ingests from `sources (via @in-* ports)` · feeds gold tables to `sql-lakehouse` · syncs gold tables to `lakebase` |
| `lakeflow-genie-block` | Lakeflow + Genie | Lakeflow ingest + declarative pipeline, with Genie Code building and maintaining it — one box, end to end. | 360×208 | The PREFERRED data-layer block — ingest + bronze→silver→gold SDP, built/maintained by Genie Code. It IS the data layer; contains SDP + Genie Code, so never add separate sdp / genie-code tiles beside it. OPTIONS (params, all optional strings): `bronze_desc` / `silver_desc` / `gold_desc` — a SHORT caption under that layer's cylinder; the block grows to fit. Keep each to a few words. |
| | | | | **ports:** `in-lakeflow-connect` ← databases / SaaS apps · `in-zerobus` ← realtime streams / sensors · `in-direct` ← files: PDF / CSV / Parquet · `r` → the compute layer |
| | | | | **wiring:** ingests from `sources (via @in-* ports)` · feeds gold tables to `sql-lakehouse` · syncs gold tables to `lakebase` |
| `lakeflow-connect` | Lakeflow Connect | A few-click interface to connect and ingest data from 100+ sources — SaaS apps, databases, files and knowledge systems. | 230×54 |  |
| | | | | **wiring:** ingests from `external connectors / SaaS / DBs` · lands raw tables into `sdp` |
| `zerobus-ingest` | Lakeflow Zerobus | Real-time, direct ingest of streaming events into the lakehouse. | 230×54 |  |
| | | | | **wiring:** receives push from `streaming / live events (apps, devices)` · lands raw tables into `sdp` |
| `sdp` | Lakeflow SDP | Spark Declarative Pipelines — declarative bronze → silver → gold that self-heal and scale. | 230×112 |  |
| | | | | **wiring:** reads ingested data from `lakeflow-connect` · reads streams from `zerobus-ingest` · reads files from (Auto Loader) `uc-volume` · orchestrated by `lakeflow-jobs` *(optional)* |
| `uc-volume` | UC Volume | Governed file storage in Unity Catalog — where raw documents (PDFs) land. | 230×54 |  |
| | | | | **wiring:** stores `files / documents (PDF, CSV, images)` |
| `lakeflow-jobs` | Lakeflow Jobs | The orchestrator for any workflow — ingestion, SDP pipelines, notebooks, SQL queries, ML training/scoring, and deployment — on a schedule or trigger. | 230×54 | The workspace orchestrator. It can run ANY component as a task: data ingestion (Lakeflow Connect, notebooks, SDP), SQL queries, ML training/scoring, and deployment steps — chained with dependencies, on a schedule or trigger. Wire an `orchestrates` edge from Lakeflow Jobs to every step it runs. |
| | | | | **wiring:** orchestrates `sdp` · orchestrates `ml-training-serving` · orchestrates `notebooks-eda` · orchestrates `lakeflow-connect` |
| `notebooks-eda` | Notebooks | Interactive exploration and analysis on governed data. | 230×54 |  |
| | | | | **wiring:** explores tables from `sdp` |
| `delta-sharing` | Delta Sharing | Open, cross-org data sharing with no copies. | 230×54 |  |
| `marketplace` | Marketplace | Discover and consume third-party data and AI assets. | 230×54 |  |
| `lakebase` | Lakebase | Managed Postgres for app state — reads/writes the live queue. | 230×54 |  |
| | | | | **wiring:** syncs with Delta — EITHER reverse-ETL Delta→Postgres, OR live app writes Postgres→Delta for analysis `sdp` · powers state + agent memory for `databricks-apps` · stores agent memory / task queue for `supervisor-agent` |
| `sql-lakehouse` | Lakehouse | One copy of governed data for BI + AI — real-time queries at scale (SQL Warehouse; RT = Lakehouse Real Time). | 230×54 |  |
| | | | | **wiring:** queries gold tables from `sdp` · serves queries to `ai-bi-dashboard` · serves queries to `genie` |

### Agentic Work `agentic-work`

*The intelligence layer — models, agents, RAG, ML lifecycle, and the entry points (Genie, Genie One) that answer questions and act on the governed data.*

| type | default title | default description (shown on the tile) | size | when to use |
|------|---------------|-----------------------------------------|------|-------------|
| `databricks-apps-work` | Databricks Apps | Deploy business apps | 230×54 | The custom business app — PREFERRED over the legacy databricks-apps tile. Runs on Lakebase; can embed the dashboard + Genie Agent. |
| | | | | **wiring:** reads/writes app state from `lakebase` · calls `supervisor-agent` *(optional)* · calls `model-serving` *(optional)* · model calls governed by `ai-gateway` *(optional)* |
| `genie-one` | Genie One | The enterprise AI coworker — the simplified Databricks front door where business users reach dashboards, Genie, and apps without technical expertise (formerly Databricks One). | 230×78 | The business-user entry point / front door. It has a Business-users persona built IN (a small user icon docked above the Genie One mark) — so you do NOT need a separate file:persona/user node beside it. Wire Genie One --> dashboard / Genie Agent / app (auto-arrows; leave `arrow` out). |
| | | | | **wiring:** fronts / opens `databricks-apps-work` · fronts / opens `genie` · fronts / opens `supervisor-agent` · fronts / opens `ai-bi-dashboard` · fronts / opens `lakewatch` *(optional)* · fronts / opens `customerlake` *(optional)* |
| `genie` | Genie Agent | ask anything about your data | 230×54 |  |
| | | | | **wiring:** runs governed SQL over `sql-lakehouse` · grounded in (semantics) `genie-ontology` *(optional)* · routed to by `supervisor-agent` *(optional)* |
| `knowledge-assistant` | Knowledge Assistant | Chat with your documents — grounded, cited answers from unstructured content. | 230×54 |  |
| | | | | **wiring:** reads documents from (RAG) `uc-volume` · routed to by `supervisor-agent` |
| `supervisor-agent` | Supervisor Agent | Routes a question to the right specialist agent and composes the answer. | 230×54 | The Multi-Agent Supervisor (MAS) — routes to specialist agents/tools + composes the answer. It can orchestrate MANY types (up to 50): Genie · Knowledge Assistant · Model Serving endpoints · Unity Catalog functions/tables/volumes · Vector/AI Search index · published dashboards · MCP servers (external / UC / custom / Hosted MCPs) · web search · custom agents (Databricks Apps) · nested supervisors. Wire in the ones the demo actually uses. |
| | | | | **wiring:** routes to `genie` · routes to `knowledge-assistant` · routes to (custom model) `model-serving` · calls tools via (MCP) `hosted-mcps` · queries (AI Search index) `vector-search` · queries (published dashboard) `ai-bi-dashboard` · reads files/tools from (UC function/table/volume) `uc-volume` · routes to (custom agent) `databricks-apps-work` · reads/writes agent memory + task queue from `lakebase` *(optional)* · grounded in (semantics) `genie-ontology` *(optional)* |
| `agent-bricks` | Agent Bricks | Databricks' managed agents — a multi-agent supervisor plus information extraction, document parsing, and classification, built and governed for you. | 230×170 | The whole managed agent layer in ONE tile: a Supervisor with all its sub-capabilities inside it (Knowledge Assistant · Genie agent · MCP · Functions · classification · extraction · doc parsing). Input comes directly from a data source or from the lakehouse/medallion; output goes to an app, a Genie Space, or Genie One. USE THIS SINGLE TILE when the diagram is NOT centered on Agent Bricks — it keeps the overview simple, one block standing in for the entire agentic layer. But if the architecture IS ABOUT Agent Bricks (it's the focus), DON'T collapse it — SPLIT it into a `supervisor-agent` tile plus one tile per specialist (`knowledge-assistant`, `genie`, `hosted-mcps`, functions…), each wired separately, so the sub-agents are visible. |
| | | | | **wiring:** reads governed data from `medallion-table` · linked to (Genie Space) `genie` *(optional)* · answers surfaced in `databricks-apps-work` *(optional)* · serves business users via `genie-one` *(optional)* · agent memory in `lakebase` *(optional)* · grounded in `genie-ontology` *(optional)* |
| `ml-training-serving` | ML Models | Train, register, and serve models on governed data. | 230×54 | Two consumption patterns, same model: BATCH — score over Delta → a gold predictions table that dashboards/Genie/apps read (simplest, a good default); REAL-TIME endpoint when per-request scoring fits the story (fraud at auth, rec at page-load). Lean batch unless the demo needs live scoring. |
| | | | | **wiring:** trains on gold features from `sdp` · trains on features from `feature-store` · batch predictions written back to a gold table of (default path) `sdp` · real-time endpoint called by `databricks-apps-work` *(optional)* |
| `ml-model` | Machine Learning Model | A trained model on governed data — classification, forecasting, recommendations, and more. | 230×54 |  |
| | | | | **wiring:** trains on gold features from `sdp` |
| `model-training` | Model Training | Train + track experiments with MLflow — parameters, metrics, and artifacts, all governed. | 230×54 |  |
| | | | | **wiring:** trains on gold features from `sdp` · trains on features from `feature-store` · registers trained model to `uc-model-registry` · feedback loop from `model-serving` |
| `mlops` | MLOps | The full model lifecycle — train, evaluate, register, deploy, and monitor, governed end to end. | 230×54 |  |
| `bronze-layer` | Bronze | Raw ingested data, landed as-is. | 230×54 |  |
| `silver-layer` | Silver | Cleaned, conformed, deduplicated. | 230×54 |  |
| `gold-layer` | Gold | Curated, business-ready aggregates. | 230×54 |  |
| `medallion-table` | Medallion Table | Bronze → Silver → Gold in one block — the medallion refinement of a governed table. | 268×96 | The whole medallion (bronze → silver → gold) as ONE block, with the metal-toned layer marks and an internal flow. Prefer this over three separate bronze/silver/gold tiles when you just want to show the layered data itself. OPTIONS (params): `feature_store` and `metric_views` (booleans) — each adds a fork off the GOLD layer (Feature Store above, Metric Views below) shown inside the block, and exposes an extra right-side OUTPUT handle so you can wire it: `@out-gold` (always), `@out-fs` (when feature_store), `@out-mv` (when metric_views). Also `bronze_desc` / `silver_desc` / `gold_desc` (optional strings) — a SHORT caption under each layer (e.g. `gold_desc:"Business marts + metrics"`); the block grows to fit. Keep each to a few words. |
| | | | | **ports:** `l` ← sources / ingest · `out-gold` → gold output · `out-fs` → feature store (when enabled) · `out-mv` → metric views (when enabled) |
| | | | | **wiring:** reads raw data from `sources / ingest (@l)` · gold consumed by (@out-gold) `sql-lakehouse` · gold trains model (@out-gold / @out-fs) `model-serving` |
| `feature-store` | Feature Store | Governed, reusable features for training and real-time serving — consistent offline and online. | 230×54 |  |
| | | | | **wiring:** computes features from gold tables of `sdp` |
| `uc-model-registry` | UC Model Registry | Version, stage, and govern models in Unity Catalog with full lineage. | 230×54 |  |
| | | | | **wiring:** registers models from `model-training` · loads model into `model-serving` · loads model into (batch scoring) `lakeflow-jobs` |
| `model-serving` | Model Serving Endpoint | Serve a custom model behind a governed, autoscaling REST endpoint for real-time inference. | 230×54 | A deployed serving endpoint (real-time inference over a custom/registered model). Best fit when the story needs per-request scoring (fraud at authorization, rec at page-load). For a plain train→register→batch-score story, batch is usually simpler — the model writes a gold predictions table (via ml-training-serving / the medallion) that dashboards/apps read; reach for a live endpoint when real-time matters. |
| | | | | **wiring:** loads registered model from `uc-model-registry` · called for real-time predictions by `databricks-apps-work` *(optional)* · called by `supervisor-agent` *(optional)* |
| `hosted-mcps` | Hosted MCPs | Managed MCP servers that let agents call external tools — Genie, Atlassian, GitHub, Slack, SharePoint, Gmail, and more. | 230×54 | The governed tool/connector layer for agents — hosted MCP servers (Genie / Atlassian / GitHub / Slack / SharePoint / Gmail …). Use when the demo's agent reaches OUT to external systems via MCP. |
| | | | | **wiring:** exposes as tools `external tools (Genie, GitHub, Slack, …)` · tools called by `supervisor-agent` |
| `vector-search` | Vector Search | Embeddings | 230×54 | Two build modes: (a) MANAGED — auto-sync an index FROM a Delta table (data must land in Delta first via sdp; easiest, higher latency); (b) STANDALONE — a direct index updated via a real-time API to add/remove entries (low latency). Pick the one the demo's freshness needs. |
| | | | | **wiring:** auto-syncs index from a Delta table of (managed mode) `sdp` · direct add/remove entries (standalone mode, low-latency) `realtime API` · queried as AI Search index by (RAG) `supervisor-agent` |
| `information-extraction` | Information Extraction | Pull specific data points, entities, and fields from unstructured text (ai_extract). | 230×54 |  |
| | | | | **wiring:** reads unstructured text from `uc-volume` · orchestrated by `supervisor-agent` |
| `document-parsing` | Document Parsing | Extract structured content from documents — text, tables, and metadata (ai_parse_document). | 230×54 |  |
| | | | | **wiring:** reads documents from `uc-volume` · orchestrated by `supervisor-agent` |
| `text-classification` | Text Classification | Categorize text into predefined or dynamic labels (ai_classify). | 230×54 | Two typical shapes: (a) INLINE in the pipeline — a bi-directional arrow with `sdp` (enriches tables in place with ai_classify, usually drawn just below SDP); or (b) a STANDALONE job reading docs from a `uc-volume` and writing labels to a table. Pick per demo. |
| | | | | **wiring:** enriches tables in-pipeline (bi-directional, ai_classify) `sdp` · standalone job reads docs from `uc-volume` · orchestrated by `supervisor-agent` |
| `genie-code` | Built with Genie Code | Autonomous AI coding partner built into every Databricks surface (notebooks, pipelines, dashboards, MLflow) — Unity Catalog–aware, so it writes code against your real tables. | 360×112 | The 'built/maintained by Genie Code' beat — an AI coding partner for developers/practitioners (business users get the simpler no-code experience via Genie One). No need to add it separately when you're already using lakeflow-genie-block (that block has the Genie Code footer built in). |

### Agentic Apps `agentic-apps`

*The delivery surface — dashboards and custom apps the business actually opens. Reach here for what a user SEES and clicks.*

| type | default title | default description (shown on the tile) | size | when to use |
|------|---------------|-----------------------------------------|------|-------------|
| `databricks-apps` | Databricks Apps | Custom web app where the team does the work — queue, actions, all in one place. | 230×54 | LEGACY app tile — prefer `databricks-apps-work` for the custom business app. Kept for back-compat; use it only when an existing diagram already references it. |
| | | | | **wiring:** reads/writes app state from `lakebase` · calls `supervisor-agent` *(optional)* · calls `model-serving` *(optional)* · model calls governed by `ai-gateway` *(optional)* |
| `ai-bi-dashboard` | AI/BI Dashboard | Governed dashboards on the same data — one set of numbers, one page. | 230×54 |  |
| | | | | **wiring:** queries (SQL Warehouse) `sql-lakehouse` *(optional)* |
| `lakewatch` | LakeWatch | Agentic SIEM on the lakehouse — unify security logs + telemetry (OCSF), AI agents detect, investigate and respond at machine speed. | 230×54 | The security app: an agentic SIEM built ON the lakehouse. Use for security / SOC / threat-detection stories. Consumes governed telemetry from the data layer; SOC analysts + threat hunters use it. |
| | | | | **wiring:** reads security logs + telemetry (OCSF) from `sdp` · opened by (SOC analysts) `genie-one` *(optional)* |
| `customerlake` | CustomerLake | Agentic customer data platform embedded in Databricks — unify profiles into a Customer 360, run always-on campaigns, no data copies. | 230×54 | The marketing app: an agentic CDP on the lakehouse. Use for customer-360 / marketing / personalization / campaign stories. Consumes customer data from the data layer; marketers + analytics teams use it. |
| | | | | **wiring:** builds Customer 360 from governed data of `sdp` · opened by (marketers) `genie-one` *(optional)* |

### Unified Governance `unified-governance`

*The control plane over everything — Unity Catalog, the AI Gateway, and the Databricks-platform banner. Prefer the one `governance-block` bar over the loose tiles unless spotlighting a single feature.*

| type | default title | default description (shown on the tile) | size | when to use |
|------|---------------|-----------------------------------------|------|-------------|
| `governance-block` | Unified Governance | One control plane for data + AI: Unity Catalog governs access/lineage/audit (ACL · ABAC); the Unity AI Gateway governs every foundation-model call (OpenAI, Anthropic, Gemini, …); Genie Ontology is the shared semantic layer. | 570×92 | One governance bar with up to three surfaces: Access control (ACL · ABAC · Audit across Data + AI) + Unity AI Gateway (access any model) + Genie Ontology. Prefer over the loose unity-catalog / ai-gateway / data-quality / abac / data-classification tiles (use those only to spotlight one feature). OPTIONS (params, booleans, all default TRUE — set false to HIDE that surface): `access_control` / `ai_gateway` / `genie_ontology`; the bar tightens to the surfaces shown. Governance SPANS everything (data, jobs, dashboards, apps, end-user access…), so show it STRUCTURALLY — `pin` it as a bar across the top or bottom of the platform box; its position implies it governs all tiles under it, so draw NO per-tile edges. DEFAULT: the one-line spanning bar with NO edges — keep it low-touch, don't map it to every component. If a surface DOES need wiring, each shown one has a top+bottom handle (`@acl` / `@ai-gateway` / `@ontology`, + `-b`) and typically connects to: `@acl` → the DATA layer (medallion/lakehouse; the compute layer too if needed); `@ontology` → Genie (Genie Space / Genie agents); `@ai-gateway` → apps or model-serving (the frontier-model callers). Wire only the one or two that the story calls for, not all three. Any edge touching this block renders as a plain DASHED line with NO flow animation (governance governs, it doesn't flow data) — automatic, don't set `flow`/`dashed`. |
| | | | | **ports:** `acl` ↑ access control (ACL · ABAC · Audit) · `acl-b` ↓ access control (bottom) · `ai-gateway` ↑ Unity AI Gateway · `ai-gateway-b` ↓ Unity AI Gateway (bottom) · `ontology` ↑ Genie Ontology · `ontology-b` ↓ Genie Ontology (bottom) |
| `db-platform` | Databricks Platform | The Databricks Data + AI platform — one governed foundation for all data + AI. | 380×60 | Title banner (the Databricks wordmark). Pin it top-left, usually paired with a big background box wrapping everything (a wrapping box auto-renders behind its children — no z needed) → reads as 'all of this is the platform'. |
| `unity-catalog` | Unity Catalog | One governed catalog — access, lineage, and semantics across data + AI. | 230×54 | Governs EVERYTHING — data, jobs, dashboards, apps, end-user access. So don't wire it to every tile (overkill/noise). Best default: the spanning governance bar (this tile or `governance-block`) pinned top/bottom of the platform box, NO edges — position implies it governs all. If you use the single tile with edges (to spotlight governance), link only the 1–2 MAIN anchors (e.g. the data layer, or end-user access), not everything. Follow the user if they ask to show it governing something specific. |
| `ai-gateway` | Unity AI Gateway | Security, governance, cost and rate limits. | 240×104 | The Unity AI Gateway tile with a row of foundation-model logos (OpenAI · Anthropic · Gemini · Grok · Kimi) across the top — conveys 'govern + access ANY model' at a glance. Use standalone; the Unified Governance bar already embeds a compact gateway if you want the whole control plane. It governs the model calls that apps / model-serving endpoints make — wire it to whatever actually makes those calls (an app or model endpoint typically routes through it), labeled 'model calls governed by'. Keep that edge SHORT and adjacent to what it governs; don't drag the tile far away and route a long line across unrelated tiles (that reads as if the source 'calls the gateway' — the confusion to avoid). |
| | | | | **wiring:** governs model calls of `databricks-apps-work` · governs `model-serving` |
| `data-quality` | Data Quality | Expectations and monitors keep bad data out of the gold layer. | 230×54 |  |
| `abac` | ABAC | Attribute-based access control — fine-grained, policy-driven permissions. | 230×54 |  |
| `data-classification` | Data Classification | Automatically tag and govern sensitive data. | 230×54 |  |

> Sources are demo-authored (not in this catalog): use `type:"source"` with a vendor `icon` (`file:vendor/<name>`; see the icon bank below) and wire the edge to the Lakeflow block's ingest port via an explicit `@in-*` handle.

<!-- END: generated-catalog -->

### Sources
Use `type:"source"` with a vendor `icon` (`file:vendor/<name>` — e.g. `postgresql`, `kafka`, `sap`, `salesforce`, `shopify`). Generic fallbacks: `pdfLogo`, `csv`, `parquet`, `sensorSource`, `inputData`, `unstructuredData`. Wire the source's edge to the Lakeflow block's ingest port with an explicit `@in-*` handle (see *An edge*). A custom shapes source: `file:vendor/custom-source`. A persona/user marker: `file:persona/user` (as a `logo` node).

Show **real, NAMED source systems** — avoid a single "Synthetic Data" / "synthetic" placeholder (it reads as fake and tells no story).
- **Follow the user first:** if they named their sources (one or many), use exactly those.
- **Default when you have no signal:** add **~4** plausible real systems with real vendor logos, spanning the three ingest ports so the Lakeflow block's three ports are used — e.g. a database (`postgresql`/`mysql`, edge `@in-lakeflow-connect`), a SaaS app (`salesforce`/`shopify`, `@in-lakeflow-connect`), **sensor / IoT data** (`sensorSource`, `@in-zerobus`), and documents (`pdfLogo`, `@in-direct`). Fit the industry if one is implied; otherwise this generic mix is fine. This is just the fallback — a demo that clearly wants one source should show one.
- For the streaming/`zerobus` path lead with **sensor data**, NOT Kafka — Zerobus is Databricks' direct ingest that *replaces* a Kafka-style broker, so showing Kafka alongside it is contradictory.
- Only use `file:vendor/custom-source` for a source that genuinely has no real-world product behind it.

### Available logos (icon bank)

<!-- BEGIN: generated-icons -->

<!-- AUTO-GENERATED from the icon bank (icons/vendor + icons/cloud) — DO NOT EDIT BY HAND. -->

Logos you can set as a node `icon`. Keys are self-explanatory; use them verbatim.

**Vendor / product logos** — `file:vendor/<name>`:

`adyen`, `agent-bricks`, `airbyte`, `airtable`, `amplitude`, `anthropic`, `apache-airflow`, `apache-couchdb`, `apache-flink`, `apache-hbase`, `apache-nifi`, `apache-spark`, `atlassian`, `aws-redshift`, `bigcommerce`, `box`, `braze`, `brevo`, `cassandra`, `chroma`, `clickhouse`, `cloudflare`, `cockroachdb`, `confluence`, `couchbase`, `csv`, `custom-source`, `databricks`, `databricks-admin`, `databricks-wordmark`, `dbt`, `docker`, `dropbox`, `duckdb`, `elasticsearch`, `fastapi`, `gemini`, `genie-ontology`, `github`, `gitlab`, `glean`, `google-ads`, `google-analytics`, `google-docs`, `google-drive`, `google-sheets`, `gradio`, `grafana`, `grok`, `hootsuite`, `hubspot`, `hugging-face`, `ibm`, `influxdb`, `informatica`, `intercom`, `jira`, `kafka`, `kimi`, `klarna`, `kubernetes`, `looker`, `mailchimp`, `mariadb`, `marketo`, `mastercard`, `mcp`, `meta`, `metabase`, `microsoft`, `microsoft-sql-server`, `milvus`, `mistral`, `mixpanel`, `mongodb`, `mqtt`, `mysql`, `neo4j`, `netlify`, `nextjs`, `node-red`, `nodejs`, `notion`, `openai`, `oracle`, `parquet`, `paypal`, `perplexity`, `pinecone`, `planetscale`, `postgresql`, `power-bi`, `prestashop`, `presto`, `pulsar`, `python`, `qdrant`, `qlik`, `quickbooks`, `rabbitmq`, `react`, `redis`, `salesforce`, `sap`, `scylladb`, `segment`, `sendgrid`, `shopify`, `shopware`, `siemens`, `singlestore`, `slack`, `snapchat`, `snowflake`, `sqlite`, `square`, `streamlit`, `stripe`, `supabase`, `superset`, `tableau`, `talend`, `teradata`, `terraform`, `tiktok`, `trino`, `twilio`, `vercel`, `visa`, `woocommerce`, `xero`, `youtube`, `zapier`, `zendesk`, `zeroops`, `zoho`

**Cloud logos** — `file:cloud/<provider>/<category>/<name>` (e.g. `file:cloud/aws/storage/s3`):

- **aws**: `analytics/athena`, `analytics/glue`, `analytics/redshift`, `compute/ec2`, `compute/lambda`, `database/dynamodb`, `database/rds`, `ml/sagemaker`, `networking/route53`, `networking/vpc`, `storage/s3`, `streaming/kinesis`
- **azure**: `analytics/data-factory`, `analytics/synapse`, `compute/functions`, `compute/virtual-machines`, `database/cosmos-db`, `database/sql-database`, `ml/machine-learning`, `networking/virtual-network`, `storage/blob-storage`, `streaming/event-hubs`
- **gcp**: `analytics/bigquery`, `analytics/dataflow`, `analytics/dataproc`, `compute/cloud-functions`, `compute/compute-engine`, `database/bigtable`, `database/cloud-sql`, `ml/vertex-ai`, `networking/vpc`, `storage/cloud-storage`, `streaming/pubsub`

Also: `file:persona/user` (a person — normally the business-user persona is built into the `genie-one` component, but you can place it as a standalone `logo` node if needed), `file:vendor/custom-source` (generic animated shapes source when no real logo fits).

<!-- END: generated-icons -->

---

## Authoring rules

1. **Prefer composites** (fewer nodes, richer): `lakeflow-genie-block` over `sdp`+`lakeflow-connect`; `governance-block` over the five loose governance tiles; `agent-bricks` for managed multi-agent. Never add a composite's sub-parts beside it (see each catalog `authoring` note).
2. **Place by `col`/`row`, not hand-picked pixels.** Banners (`db-platform`, `governance-block`) `pin` to the platform box's corners — an absolute `at` drifts off-corner the moment the node set changes.
3. **Source → Lakeflow edge MUST name the ingest port** (`@in-lakeflow-connect`/`@in-zerobus`/`@in-direct`) — it's not inferred; all other handles infer from geometry. Full detail (which port for which source + its animation) in *An edge*.
4. **Genie One / user edges: auto-arrow** — leave `arrow`/`flow` out. Data-flow edges: `flow: true`.
5. **`id` is a free-form handle; `type` is identity** (`{id:"rag-endpoint", type:"model-serving"}` is fine). Every `edges`/`wraps`/`below`/`pin.to` reference must resolve to an id that exists on the tab.
6. **Crowded/unreadable edge labels → add vertical space.** Render, look: if labels between two rows collide, with `rowGrid` **skip a row number** (`0, 2` not `0, 1`) so an empty band opens for them; without it, bump the `below`/`above` `gap`. Prefer space over shrinking/dropping labels.
7. **Record non-obvious choices in `ai_reasoning`** (per-node/edge hidden rationale — full rules in *Step 0.5* + the *A node* table): a relabeled tile, a deliberate omission, why a handle/row was chosen — so the next edit isn't a guess. Also where a **user's** non-obvious change belongs: if someone edits the diagram in a way the components don't explain (renamed a tile, an unusual edge, an intentionally orphaned component), capture the intent in `ai_reasoning` so it survives.

---

## Reference files

The `reference/*.jsonc` examples are listed with when-to-use in **Pick a starting point** at the top. Read the relevant one(s) for the pattern, then author your own (never copy — see Step 2). When you reuse a snippet, strip `//` and emit plain JSON. Each file's header comment explains what it demonstrates.
<!-- BEGIN: local-render-files (stripped inside Solution Builder — renderer/ isn't shipped into a project) -->
Local render helpers: `renderer/architecture-viewer.html` / `architecture-editor.html` (copy one, edit its inline JSON) · `renderer/render-arch.mjs` (`node renderer/render-arch.mjs <file>.html` → PNG).
<!-- END: local-render-files -->
