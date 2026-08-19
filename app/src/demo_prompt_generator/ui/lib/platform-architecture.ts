/**
 * Platform Architecture Schema + Catalog
 * =======================================
 *
 * The file format is a FLAT graph: `architecture.md` holds a ```json block with
 * just `nodes` (the components shown on the canvas) + `edges` (the lines between
 * them). A node is on the canvas iff it's listed in `nodes` — there is no
 * state / hidden / bands in the file.
 *
 *   { name, story, options?, nodes: [...], edges: [...] }
 *   node:  { id, type, at:[x,y], size?, rot?, scale?, z?, group?,
 *            label?, desc?, icon?, ingest?, style?:{border,shadow,radius,fill,…} }
 *   edge:  { id?, from:"<id>[@handle]", to:"<id>[@handle]", flow?, arrow?, … }
 *
 * `type` is a CATALOG component id (which folds in the composite "kind"), or one
 * of the special kinds source / box / text / logo / image. The CATALOG below is
 * a pure LOOKUP: given a `type` it supplies the default icon / label / desc /
 * size / ports and the band (used only for the tile's color). The library
 * palette renders the full catalog to drag from; the file lists only what's
 * placed.
 *
 * `parseArchitecture` reads the flat file → the internal resolved `PlatformSchema`
 * ({ bands, layout }) that flow-mapping + the canvas consume; `serializeArchitecture`
 * writes the live canvas back out to the flat format.
 */

import type { DatabricksIconName } from "@/components/databricks-icons";

/** An icon reference: a built-in DatabricksIconName, or a file-icon key like
 *  "file:vendor/kafka" / "file:cloud/aws/storage/s3". The `& {}` keeps
 *  autocomplete for the known built-ins while allowing any file-icon string. */
export type IconKey = DatabricksIconName | (string & {});
import { CAPABILITY_META } from "./capabilities";
import type { DeployedResourceLink } from "./custom-api";

// =============================================================================
// Types
// =============================================================================

/** Tri-state visibility/emphasis for a component. */
export type ComponentState = "active" | "mentioned" | "hidden";

export type BandId =
  | "agentic-apps"
  | "agentic-work"
  | "unified-governance"
  | "agentic-data"
  | "sources";

export interface PlatformComponent {
  /** Stable id — for capability-backed tiles this IS the capability slug
   *  (e.g. "genie", "databricks-apps") so resources.json maps 1:1. Source
   *  components get demo-authored ids (e.g. "src-shopify"). */
  id: string;
  label: string;
  icon: IconKey;
  /** Story-tied, per-demo blurb shown in the detail panel. Catalog ships a
   *  generic fallback; the agent overrides it with something demo-specific. */
  desc: string;
  state: ComponentState;
  /** Capability slug this tile is backed by, when different from `id`.
   *  Drives the deployed-resource deep-link lookup. Defaults to `id`. */
  capability?: string;
  /** Renders as a richer COMPOSITE block instead of a plain tile. The first is
   *  "lakeflow" — bundles Lakeflow Connect + Zerobus + direct ingest feeding a
   *  bronze→silver→gold pipeline, with 3 labelled input ports on the left. */
  kind?: CompositeKind;
  /** Small grey sub-line under the label (e.g. a one-line value prop). */
  sublabel?: string;
  /** A tiny colored pill next to the label (e.g. "RT" for real-time). */
  badge?: string;

  // -- Authoring metadata (catalog-only) — the SINGLE source of truth for the
  //    skill's component reference. `scripts/gen-architecture-skill.mjs` reads
  //    these + the default `desc` and writes the catalog section into the
  //    architecture skill doc. Not used at render time; only to guide the agent.
  /** One line for the agent: what it is / what's inside / when to pick it (vs
   *  alternatives). Omit for plain tiles whose `desc` already says it. */
  authoring?: string;
  /** Components with named anchors: handle id → what connects there. e.g.
   *  { "in-lakeflow-connect": "← databases / SaaS apps", "r": "→ compute" }.
   *  THE key metadata — tells the agent which port maps to what. */
  ports?: Record<string, string>;
  /** TYPICAL WIRING — what this component consumes/depends on, so the agent
   *  draws realistic edges (not invented ones). Each entry: the upstream `from`
   *  (a catalog id, or a plain-text concept like "streaming events" when the
   *  source is external), an `action` verb ("reads from" / "queried by" /
   *  "syncs with" / "routes to" …), and `optional` — omitted = the NORMAL /
   *  typical wiring (draw it when the component is present); `optional: true` =
   *  a clearly-optional edge the agent adds only when the story calls for it.
   *  (We DON'T mark edges "required/mandatory" — too strong; a plain entry is
   *  the sensible default, `optional` is the only annotation.) Emitted into the
   *  skill catalog. Catalog-only; not used at render time. */
  wiring?: { from: string; action?: string; optional?: boolean }[];
  /** Optional toggleable PARAMS a component exposes. Each renders as a checkbox
   *  in the right edit panel; enabled values live on the NODE as `params`
   *  (NodePosition.params → the flat file's `params`). A composite reads
   *  `d.params?.<key>` to render conditionally (e.g. the medallion table shows a
   *  Feature Store / Metric Views fork when enabled). General — any component
   *  can declare options; the panel + round-trip are shared. */
  options?: ComponentOption[];
}

/** One component param, rendered in the edit panel's "Options" section. A
 *  `boolean` option (default) is a checkbox; a `text` option is a text input.
 *  Both round-trip through `node.params[key]` — the panel + serialize are
 *  generic, so declaring an option here makes it appear + persist automatically
 *  (no per-component wiring). */
export interface ComponentOption {
  /** Stored under `node.params[key]`. */
  key: string;
  /** Label in the edit panel (checkbox label, or the text input's field label). */
  label: string;
  /** "boolean" (checkbox, default) or "text" (single-line input). */
  type?: "boolean" | "text";
  /** boolean options only: default when the node has no explicit value (false). */
  default?: boolean;
  /** text options only: input placeholder (hint the expected content). */
  placeholder?: string;
}

/** The animated-flow rendering style of an edge. `dot` = a single travelling
 *  dot; `particles` = a dense river of cubes/circles/triangles (realtime);
 *  `docs` = travelling document glyphs (file landing); `laser` = a comet with a
 *  fading tail (explicit-choice only — never auto-derived); `model` = a small ML
 *  model glyph travelling the line (auto-default for edges touching the UC Model
 *  Registry — a served/registered model flowing through). Canonical home for the
 *  union; the UI layer re-uses it so schema + renderer + menu never drift. */
export type FlowStyle = "dot" | "particles" | "docs" | "laser" | "model";

/** Composite block kinds (super-set components that draw an inner mini-diagram
 *  and expose multiple named ports). Extend this as we add more blocks. */
export type CompositeKind = "lakeflow" | "genie-code" | "governance" | "lakeflow-genie" | "agent-bricks" | "db-platform" | "genie-one" | "medallion-table" | "ai-gateway";

/** The 3 left input ports a "lakeflow" composite exposes. Edge handle ids on
 *  the block are `in-${port}` (+ a single `r` output on the right). */
export const LAKEFLOW_PORTS = [
  { id: "lakeflow-connect", label: "Lakeflow Connect" },
  { id: "zerobus", label: "Zerobus" },
  { id: "direct", label: "Direct" },
] as const;
export type LakeflowPort = (typeof LAKEFLOW_PORTS)[number]["id"];

export interface PlatformBand {
  id: BandId;
  label: string;
  sublabel: string;
  components: PlatformComponent[];
}

export interface PlatformSchema {
  name: string;
  /** One-line framing shown under the title (optional, agent-authored). */
  story?: string;
  /** When true, third-party SaaS/vendor source logos render as their real
   *  (trademarked) brand marks. Default false → they render as a neutral
   *  text badge instead. Cloud (AWS/GCP/Azure) + Databricks marks are always
   *  shown regardless (they don't need this opt-in). */
  enableTrademarkLogos?: boolean;
  /** The declared left→right lane names (the file's top-level `columns`). Kept
   *  on the schema so it ROUND-TRIPS: symbolic `col` refs are meaningless without
   *  it, so serialize must re-emit it even after a node is dragged/pinned. */
  columns?: string[];
  /** Shared-row-grid opt-in (file-level `rowGrid`), kept on the schema so it
   *  round-trips like `columns`. See ArchitectureFile.rowGrid. */
  rowGrid?: boolean;
  bands: PlatformBand[];
  /** Canvas layout — node positions + edges. Persisted by the interactive
   *  editor; auto-seeded by band when absent. */
  layout: PlatformLayout;
  /** Inline custom SVG logos, keyed by id. A node references one via
   *  `icon: "custom:<id>"`. Threaded to the renderers via CustomLogosContext. */
  customLogos?: Record<string, string>;
}

// -- Interactive-canvas layout (positions + edges) ---------------------------

export interface NodePosition {
  x: number;
  y: number;
  /** The node's catalog component id (`FileNode.type`) — the SOURCE OF TRUTH for
   *  which component this is (label/icon/desc/ports resolve from it). Carried
   *  verbatim from the file so `id` can be a free-form instance handle
   *  (`id` need NOT equal `type`). For annotation nodes it's the variant
   *  (`box`/`text`/`logo`/`image`) and for a data source it's `"source"`. */
  type: string;
  /** Rotation in degrees (0/90/180/270). Optional; defaults to 0. */
  rot?: number;
  /** User-resized width/height (px). Optional; defaults to the node's natural size. */
  w?: number;
  h?: number;
  /** Manual content scale (0.5..1.5). Optional; defaults to 1. */
  scale?: number;
  /** Canvas-edited label (double-click to rename). Overrides the catalog/agent
   *  label for this node only. */
  label?: string;
  /** AI reasoning (never rendered) — see FileNode.ai_reasoning. Carried so it
   *  survives the RF round-trip on save. */
  ai_reasoning?: string;
  /** Canvas-picked icon — set when the node's TYPE was changed on the canvas.
   *  Overrides the component's default icon. */
  icon?: IconKey;
  /** Free-form annotation node (text / box / logo / image). Present only for
   *  annotation nodes (id starts with "anno-"); catalog nodes leave it unset. */
  annotation?: AnnotationData;
  /** Per-node style overrides (right-click menu) — apply to any node's box. */
  opacity?: number;        // 0..1, whole-node opacity
  fillColor?: string;      // box/background color (hex)
  fontColor?: string;      // text/label color (hex)
  iconColor?: string;      // logo SVG recolor (hex); unset → icon's own color
  /** Border styling. borderWidth 0 = no border. */
  borderWidth?: number;    // px
  borderStyle?: "solid" | "dashed";
  borderColor?: string;    // hex
  borderRadius?: number;   // px corner radius
  shadow?: number | boolean; // drop-shadow intensity 0–100 (legacy boolean ok)
  /** Stacking order (bring to front / send to back). Default 0. */
  z?: number;
  /** RENDER-ONLY default z for a wrapping box (behind its children), derived
   *  from nesting depth so a box never needs a hand-set `z`. Never serialized
   *  (explicit `z` is; this is recomputed on parse). `z` overrides it. */
  autoZ?: number;
  /** A canvas-added data source (from "+ more data sources"). Stores just the
   *  logo-catalog key + icon; label defaults come from the unified
   *  logo-catalog.json. Present only for such nodes. The Lakeflow ingest port a
   *  source feeds is carried on the EDGE handle (`@in-zerobus`, `@in-direct`,
   *  `@in-lakeflow-connect`), not here. */
  source?: { key: string; icon: IconKey };
  /** Source tiles only: label placement relative to the icon (right default |
   *  left | top | bottom). Persisted via the shared FileNode `caption`. */
  sourceCaption?: "right" | "left" | "top" | "bottom";
  /** DERIVED lane-uniform width (computeLayout step 2.5) for a captioned
   *  logo/source in a same-lane group — every member gets the widest member's
   *  width so the cards match + icons align. NOT serialized (recomputed on
   *  parse); flow-mapping + the render honor it over the label-fitted width. */
  laneW?: number;
  /** Source tiles only: label font size (px). Persisted via FileNode `fontSize`. */
  fontSize?: number;
  /** Editable description line shown under the title. For catalog product tiles
   *  this OVERRIDES the CATALOG default `desc`; for sources/logos it's the only
   *  source. Distinguish `undefined` (use default) from `""` (deliberately
   *  cleared). */
  desc?: string;
  /** Whether the description line is shown. `undefined` → default resolution
   *  (product tile with a non-empty desc → shown; source/logo → shown only when
   *  a desc exists); explicit `true`/`false` = user toggled it. */
  showDesc?: boolean;
  /** Group membership — a shared id stamped on every member of a group
   *  (right-click → Group). Selecting one member selects the whole group so
   *  they move together. Cleared on Ungroup. No container node — just a tag. */
  groupId?: string;
  /** Author-time SYMBOLIC placement carried through from the file (`col`/`row`/
   *  relational fields, AND container/pin fields) so it can be RE-EMITTED on save
   *  for nodes the user never moved — instead of flattening to `at`. computeLayout
   *  already resolved it to `x`/`y` (+ derived `w`/`h` for a box); this is kept
   *  only for round-trip. Cleared (and `at`/`size` emitted instead) once `pinned`
   *  flips — see below. Container fields (`wraps`/`bounds`/`pin`) matter most: a
   *  box or pinned banner that flattened to `at` would freeze and stop reflowing
   *  (children escape the box, banners drift off the corner). */
  placement?: {
    col?: string; row?: number;
    alignX?: string; alignY?: string;
    below?: string; above?: string; leftOf?: string; rightOf?: string;
    gap?: number;
    /** Container box: auto-sizes to enclose these child ids (+ `pad`). */
    wraps?: string[]; pad?: number;
    /** Per-side box edge anchors. */
    bounds?: { left?: string; right?: string; top?: string; bottom?: string };
    /** Corner dock for a banner/persona inside a box. */
    pin?: {
      at: "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
      to?: string; pad?: number; float?: boolean;
    };
  };
  /** True once the user has manually positioned this node (dragged it, or it was
   *  authored with an explicit `at`). A pinned node serializes as `at`; an
   *  un-pinned node with `placement` re-emits its symbolic fields. */
  pinned?: boolean;
  /** Component options (round-trips to the file's `params`). Values are usually
   *  BOOLEAN toggles (e.g. the medallion's `feature_store`/`metric_views` forks),
   *  but a param may also be a STRING when an option carries text — e.g. the
   *  medallion's `bronze_desc`/`silver_desc`/`gold_desc` layer captions. See
   *  PlatformComponent.options. */
  params?: Record<string, boolean | string>;
  /** Render this node as a STACK of N cards (N-1 blank offset copies peeking out
   *  the bottom-right of the front card) to signal "many of these" — e.g. deploy
   *  N apps. 1 or absent = a single normal card. Works on any node kind. */
  stack?: number;
}

/** A free-form canvas annotation — not a Databricks catalog component. One node
 *  kind with four variants; all props persist in the layout. */
export type AnnotationVariant = "text" | "box" | "logo" | "image" | "note";
export interface AnnotationData {
  variant: AnnotationVariant;
  /** text/box: the (editable) text. */
  text?: string;
  /** box: an optional title bar across the top of the box. Empty by default
   *  (invisible — but double-clicking where it would be lets you edit it). */
  title?: string;
  /** box: an icon key rendered before the title text (e.g. a small Databricks
   *  logo for the "Databricks Workspace" preset). */
  titleIcon?: string;
  /** text/box: font size in px (default 14). */
  fontSize?: number;
  /** text/box: bold text. */
  bold?: boolean;
  /** box: vertical × horizontal text placement (default "middle"/"center").
   *  text: horizontal placement (default "left"). */
  vAlign?: "top" | "middle" | "bottom";
  hAlign?: "left" | "center" | "right";
  /** text: overflow mode — the single source of truth for how the box behaves.
   *   • `auto` (default, or unset) → the box AUTO-FITS its content: it grows as
   *     you type. No fixed size.
   *   • `wrap` → FIXED box; text flows onto new lines within it.
   *   • `truncate` → FIXED box; single line, ellipsis.
   *  Dragging a resize handle switches an `auto` node to `wrap` (a fixed box). */
  textWrap?: "auto" | "wrap" | "truncate";
  /** @deprecated legacy "user resized it" flag — superseded by textWrap
   *  (wrap/truncate ⇒ fixed). Still read for back-compat with old files. */
  sized?: boolean;
  /** logo: the chosen icon key — a DatabricksIconName OR a file-icon key
   *  ("file:vendor/snowflake", "file:cloud/aws/storage/s3"). */
  icon?: string;
  /** logo: where the text caption sits relative to the icon —
   *  right | left | top | bottom. Legacy "side" == right, "below" == bottom.
   *  Default (unset) renders below (the original logo caption behavior). */
  caption?: "right" | "left" | "top" | "bottom" | "side" | "below";
  /** image: a URL, or a `data:` base64 string for pasted images. */
  src?: string;
  /** logo: an editable description line under the caption (opt-in via showDesc). */
  desc?: string;
  /** logo: whether the description line is shown. */
  showDesc?: boolean;
}

export interface PlatformEdge {
  id: string;
  source: string;
  target: string;
  /** Which handle each end attaches to — a composite port id ("in-zerobus")
   *  or a side ("l"/"r"/"t"/"b"). Preserved so the anchor survives a reload. */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** Red-dot "data flowing" animation along the edge. */
  animated?: boolean;
  /** Dashed/dotted stroke instead of solid. */
  dashed?: boolean;
  /** Routing shape. */
  shape?: "smooth" | "straight" | "step";
  /** Flowing-data animation style. Unset → auto-derived from the origin: any
   *  data SOURCE (a node with an `ingest`) defaults to `laser`; a non-source
   *  origin defaults to `dot`. An explicit value overrides that default. */
  flowStyle?: FlowStyle;
  /** Static arrowheads. Unset/"auto" → auto (arrow for user/Genie-One
   *  relationship edges, else flow). "none" | "end" | "start" | "both" force it.
   *  An arrow edge is a plain relationship line (no data-flow animation). */
  arrow?: "auto" | "none" | "end" | "start" | "both";
  /** Manual X of the vertical elbow segment (smooth/step edges). Unset → the
   *  auto-staggered position. Set by dragging the ↔ handle on the segment. */
  centerX?: number;
  /** Optional edge label. */
  label?: string;
  /** AI reasoning (never rendered) — see FileEdge.ai_reasoning. */
  ai_reasoning?: string;
}

export interface PlatformLayout {
  /** Saved node positions, keyed by component id. Missing → auto-laid out. */
  nodes: Record<string, NodePosition>;
  /** Edges drawn on the canvas. Empty → auto-seeded flow edges. */
  edges: PlatformEdge[];
  /** Component ids removed from the canvas (vs the catalog defaults). */
  hidden: string[];
}

// -- The FLAT file shape the agent + canvas read/write into architecture.md ---
// A node is in `nodes` iff it's on the canvas (no state / hidden / mentioned).
// Position is required; everything else is an override of the catalog default.

/** One placed node in the flat file. `type` is a catalog component id (which
 *  folds in the old `kind`) OR a special kind: "source" | "box" | "text" |
 *  "logo" | "image". */
export interface FileNode {
  id: string;
  type: string;
  /** Canvas position [x, y] (node CENTER). Optional: when omitted, computeLayout
   *  derives it from `col`/`row` (or wraps). An explicit `at` ALWAYS wins. */
  at?: [number, number];
  /** Symbolic layout: which declared `columns` lane this node sits in, and its
   *  order within that lane (else order = order of appearance). Ignored when
   *  `at` is set. */
  col?: string;
  row?: number;
  /** Component options (see PlatformComponent.options), e.g. `{ "feature_store":
   *  true }`. Values are usually boolean toggles, but a param may be a STRING when
   *  the option carries text (e.g. the medallion's `bronze_desc`/`silver_desc`/
   *  `gold_desc` layer captions). Only keys the component declares are meaningful. */
  params?: Record<string, boolean | string>;
  /** Render as a STACK of N cards to signal "many of these" (e.g. N apps): N-1
   *  blank offset copies peek out the bottom-right of the front card. 1/absent =
   *  single card. Works on any node type. */
  stack?: number;
  /** Relational placement — position this node against ANOTHER node's resolved
   *  box, evaluated AFTER columns (so the anchor keeps its own col/row default).
   *  Use these instead of guessing `at` coordinates.
   *    alignX/alignY: "<id>" — copy that node's center X (or Y); keep your other
   *                            axis from col/row. `gap` does NOT apply.
   *    below/above/leftOf/rightOf: "<id>" — sit adjacent to that node on that
   *                            side, centered on its other axis; `gap` = px
   *                            between the boxes (default 40).
   *  Use at MOST ONE per node — if several are set only one applies (precedence
   *  alignX > alignY > leftOf > rightOf > above > below). `at` still wins over
   *  everything. Chains resolve in dependency order. */
  alignX?: string;
  alignY?: string;
  below?: string;
  above?: string;
  leftOf?: string;
  rightOf?: string;
  gap?: number;
  /** Container box: this node (type "box") auto-sizes to enclose these child
   *  node ids (+ `pad`). Recursive — a box may wrap other boxes. */
  wraps?: string[];
  pad?: number;
  /** Per-side edge anchors for a `type:"box"` — places each edge at a reference
   *  point instead of wrapping. Each side is `"<nodeId>:<anchor>"` (anchor =
   *  left|right|top|bottom|center of that node's box) or `"col:<name>:<anchor>"`
   *  (a column's edge/midpoint), or "wrap" to fall back to enclosing `wraps`.
   *  Lets the box cut HALFWAY through a node/column (the node straddles the
   *  border). Unspecified sides fall back to `wraps` (or 0). */
  bounds?: { left?: string; right?: string; top?: string; bottom?: string };
  /** Anchor placement inside a box (instead of `at`/`col`). For banners /
   *  personas sitting on a box corner.
   *    at:    one of the 9 anchors (top-left … center … bottom-right).
   *    to:    the box id to dock into (default: the largest box / overall bounds).
   *    pad:   inset px from the box edge (default 16).
   *    float: false/omitted → RESERVE a band (the box grows so this never
   *           overlaps content); true → overlay at the corner (may sit over it). */
  pin?: {
    at: "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
    to?: string;
    pad?: number;
    float?: boolean;
  };
  /** Resized box [w, h]. */
  size?: [number, number];
  rot?: number;
  scale?: number;
  z?: number;
  group?: string;
  /** Copy overrides (only when they differ from the catalog default). */
  label?: string;
  desc?: string;
  /** Whether the description line is shown (undefined → default resolution). */
  showDesc?: boolean;
  /** AI reasoning — never rendered, never affects layout. Explains WHY this node
   *  is here / what a non-obvious choice means (e.g. that a `lakeflow-jobs` tile
   *  is relabeled as a batch scoring job, or why a `row` is what it is).
   *  Round-trips verbatim so a saved example stays self-documenting. Distinct
   *  from `desc` (the tile's visible description line) and `type:"note"` (the
   *  visible post-it). */
  ai_reasoning?: string;
  icon?: IconKey;
  /** box/text/logo/image annotation props. */
  text?: string;
  /** box: title-bar text + leading icon. */
  title?: string;
  titleIcon?: IconKey;
  /** logo: caption placement (right|left|top|bottom; legacy side|below). */
  caption?: "right" | "left" | "top" | "bottom" | "side" | "below";
  fontSize?: number;
  bold?: boolean;
  vAlign?: "top" | "middle" | "bottom";
  hAlign?: "left" | "center" | "right";
  /** text: overflow mode — "auto" (default, grows) | "wrap" | "truncate". */
  textWrap?: "auto" | "wrap" | "truncate";
  /** @deprecated legacy "sized" flag, superseded by textWrap. */
  sized?: boolean;
  src?: string;
  /** Optional visual overrides. */
  style?: {
    border?: number;        // borderWidth
    borderStyle?: "solid" | "dashed";
    borderColor?: string;
    radius?: number;        // borderRadius
    shadow?: number | boolean;
    fill?: string;          // fillColor
    font?: string;          // fontColor
    icon?: string;          // iconColor (recolor a logo's SVG)
    opacity?: number;
  };
}

/** One edge in the flat file. `from`/`to` may carry an inline `@handle`
 *  (a composite port like `in-zerobus` or a side `l`/`r`/`t`/`b`). */
export interface FileEdge {
  id?: string;
  from: string;
  to: string;
  flow?: boolean;          // ↔ animated
  arrow?: "auto" | "none" | "end" | "start" | "both";
  dashed?: boolean;
  shape?: "smooth" | "straight" | "step";
  flowStyle?: FlowStyle;
  centerX?: number;
  label?: string;
  /** AI reasoning — never rendered, never affects layout. Explains WHY this edge
   *  exists (the reasoning that isn't obvious from from/to). Kept verbatim
   *  through the save round-trip so an example stays self-documenting. Use
   *  `label` for text drawn ON the edge; use `ai_reasoning` for the reasoning. */
  ai_reasoning?: string;
}

/** The whole flat file. */
export interface ArchitectureFile {
  name?: string;
  story?: string;
  options?: { trademarkLogos?: boolean };
  /** Ordered left→right lane names. Nodes reference one via `col`. Optional —
   *  only needed when authoring with symbolic (col-based) placement. */
  columns?: string[];
  /** Opt-in SHARED ROW GRID. When true, a node's `row` is a GLOBAL grid row
   *  aligned across EVERY column (not just order within its own lane): all
   *  nodes with row:1 share the same top band, row:2 the band below it, etc.,
   *  so columns register into horizontal rows even when they hold different
   *  node counts. A column that skips a row simply leaves that slot empty. Rows
   *  sit on a FIXED PITCH (constant grid lines) — a tile at row N lands on the
   *  same Y line in every column, and a node TALLER than one cell overflows
   *  downward in its own column WITHOUT pushing other columns. The grid centers
   *  on y=0. Nodes without a `row` keep appearance order, packed after the
   *  numbered rows. Off (default) → `row` orders within-lane
   *  as before. Relational (`alignY`/`below`/…) and `at` still override. */
  rowGrid?: boolean;
  /** Inline custom SVG logos: `[{ id, svg }]`. Reference one from any node's
   *  `icon` as `"custom:<id>"` (works as a logo node OR a source tile). */
  custom_logos?: { id: string; svg: string }[];
  nodes?: FileNode[];
  edges?: FileEdge[];
}

const ANNOTATION_TYPES = new Set<AnnotationVariant>(["text", "box", "logo", "image", "note"]);

/** "Databricks Architecture" palette presets — ready-made annotations for the
 *  physical Databricks layout: titled container boxes (Workspace / Metastore)
 *  and logo+label tiles (Catalog / Schema / Table). Each seeds an annotation of
 *  the given `variant` with the extra props merged on. */
export interface AnnotationPreset {
  id: string;
  label: string;
  /** Which annotation variant to place (default "box"). */
  variant?: AnnotationVariant;
  /** Extra AnnotationData merged onto the variant defaults when placed. */
  annotation: Partial<AnnotationData>;
}
export const DBX_ARCH_PRESETS: AnnotationPreset[] = [
  {
    id: "dbx-account",
    label: "Databricks Admin Account",
    annotation: { title: "Databricks Admin Account", titleIcon: "file:vendor/databricks-admin" },
  },
  {
    id: "dbx-workspace",
    label: "Databricks Workspace",
    annotation: { title: "Databricks Workspace", titleIcon: "file:vendor/databricks" },
  },
  {
    id: "dbx-metastore",
    label: "Databricks Metastore",
    annotation: { title: "Databricks Metastore", titleIcon: "databricksMetastore" },
  },
  // Catalog / Schema / Table — a logo (nested database cylinder) + an editable
  // label to its side. Placed as `logo` annotations with caption:"side".
  {
    id: "dbx-catalog",
    label: "Catalog",
    variant: "logo",
    annotation: { icon: "dbCatalog", text: "Catalog", caption: "side" },
  },
  {
    id: "dbx-schema",
    label: "Schema",
    variant: "logo",
    annotation: { icon: "dbSchema", text: "Schema", caption: "side" },
  },
  {
    id: "dbx-table",
    label: "Table",
    variant: "logo",
    annotation: { icon: "dbTable", text: "Table", caption: "side" },
  },
  // Cloud-boundary boxes — a titled container carrying a cloud provider's logo,
  // for drawing the "external (non-Databricks) side" of an integration diagram.
  // Drop it, then `wraps` the external systems (or drag them inside).
  {
    id: "cloud-aws",
    label: "AWS boundary",
    annotation: { title: "AWS", titleIcon: "file:cloud/aws/aws" },
  },
  {
    id: "cloud-azure",
    label: "Azure boundary",
    annotation: { title: "Azure", titleIcon: "file:cloud/azure/azure" },
  },
  {
    id: "cloud-gcp",
    label: "GCP boundary",
    annotation: { title: "Google Cloud", titleIcon: "file:cloud/gcp/gcp" },
  },
  // Note — a stylized post-it for a free-floating comment anywhere on the canvas.
  {
    id: "note",
    label: "Note",
    variant: "note",
    annotation: { text: "" },
  },
];
export const DBX_ARCH_PRESET_BY_ID: Record<string, AnnotationPreset> = Object.fromEntries(
  DBX_ARCH_PRESETS.map((p) => [p.id, p]),
);

// =============================================================================
// Band metadata — the fixed marketing framing (top → bottom)
// =============================================================================

// `sublabel` is the marketing tagline shown in the app's band rail. `blurb` is a
// FUNCTIONAL one-liner for the skill catalog — what the band IS and when to pull a
// component from it — emitted under each generated section header (falls back to
// `sublabel` if absent). Keep both in code so the skill can't drift from the app.
export const BAND_META: Record<BandId, { label: string; sublabel: string; blurb?: string }> = {
  "agentic-apps": {
    label: "Agentic Apps",
    sublabel: "Deploy agents and apps at scale to transform work",
    blurb: "The delivery surface — dashboards and custom apps the business actually opens. Reach here for what a user SEES and clicks.",
  },
  "agentic-work": {
    label: "Agentic Work",
    sublabel: "Data-smart coworkers for every employee",
    blurb: "The intelligence layer — models, agents, RAG, ML lifecycle, and the entry points (Genie, Genie One) that answer questions and act on the governed data.",
  },
  "unified-governance": {
    label: "Unified Governance",
    sublabel: "One control plane for data + AI — security, lineage, cost",
    blurb: "The control plane over everything — Unity Catalog, the AI Gateway, and the Databricks-platform banner. Prefer the one `governance-block` bar over the loose tiles unless spotlighting a single feature.",
  },
  "agentic-data": {
    label: "Agentic Data",
    sublabel: "Unified, real-time data foundation",
    blurb: "The data foundation — ingest + the medallion pipeline (bronze→silver→gold) + the lakehouse / Lakebase it lands in. Where the demo's data comes IN and is refined.",
  },
  sources: {
    label: "Sources",
    sublabel: "The systems your business already runs on",
    blurb: "The upstream systems feeding the platform — NOT catalog components; authored as `type:\"source\"` tiles (see the Sources section).",
  },
};

/** The flow columns, left → right (data flows toward the user). Governance is
 *  NOT here — it renders as a full-width foundation bar UNDER these columns
 *  (it underpins every column, like Unity Catalog on the marketing slide). */
export const FLOW_ORDER: BandId[] = [
  "sources",
  "agentic-data",
  "agentic-work",
  "agentic-apps",
];

/** The band rendered as the foundation bar below the flow columns. */
export const FOUNDATION_BAND: BandId = "unified-governance";

/** All bands, for menus / lookups that need the complete set. */
export const BAND_ORDER: BandId[] = [...FLOW_ORDER, FOUNDATION_BAND];

/** Per-band accent — one cohesive navy→indigo family graded by depth, NOT a
 *  rainbow. Matches the reference Architecture Canvas. Used for the band rail
 *  + active-tile rim. Sources stays neutral slate (external estate). */
export const BAND_COLOR: Record<BandId, string> = {
  "agentic-apps": "#313F73",
  "agentic-work": "#41538F",
  "unified-governance": "#5266A6",
  "agentic-data": "#6577B4",
  sources: "#94A3B8",
};

// =============================================================================
// Default catalog — every platform component, in band order
// =============================================================================

/** A catalog entry is a component WITHOUT a state (state is computed). The
 *  id is the capability slug so `CAPABILITY_META` + resources.json line up. */
type CatalogComponent = Omit<PlatformComponent, "state">;

/** Generic, brand-level fallback blurbs. The agent overrides these per demo
 *  with story-tied copy. Kept short — one sentence, what it does for a user.
 *
 *  ID CONVENTION: when a component maps 1:1 to a capability in the demo-gen
 *  skill's `references/platform_architecture.md`, REUSE that capability's id
 *  here (e.g. `ai-bi-dashboard`, `sql-lakehouse`, `text-classification`) so the
 *  two stay cross-searchable — the architecture skill ships that file and the
 *  agent looks up "how components connect" by id. Renaming an id here is a
 *  breaking change for saved `architecture.md` files, but there's no migration:
 *  an unknown id renders a labeled placeholder tile (see flow-mapping.ts). */
/** The three optional per-layer caption inputs (bronze/silver/gold) shared by
 *  every block that draws a medallion — the standalone medallion + both Lakeflow
 *  blocks. Declaring them here (once) makes the text inputs appear in the edit
 *  panel + round-trip automatically for all of them. */
const LAYER_CAPTION_OPTIONS: ComponentOption[] = [
  { key: "bronze_desc", label: "Bronze caption", type: "text", placeholder: "e.g. Raw ingested data" },
  { key: "silver_desc", label: "Silver caption", type: "text", placeholder: "e.g. Cleaned & conformed" },
  { key: "gold_desc", label: "Gold caption", type: "text", placeholder: "e.g. Business marts + metrics" },
];

export const CATALOG: Record<BandId, CatalogComponent[]> = {
  "agentic-apps": [
    { id: "databricks-apps", label: "Databricks Apps", icon: "databricksApps", desc: "Custom web app where the team does the work — queue, actions, all in one place.",
      authoring: "LEGACY app tile — prefer `databricks-apps-work` for the custom business app. Kept for back-compat; use it only when an existing diagram already references it.",
      wiring: [{ from: "lakebase", action: "reads/writes app state from" }, { from: "supervisor-agent", action: "calls", optional: true }, { from: "model-serving", action: "calls", optional: true }, { from: "ai-gateway", action: "model calls governed by", optional: true }] },
    { id: "ai-bi-dashboard", label: "AI/BI Dashboard", icon: "aibiBrand", sublabel: "Analyst consult & build insight", desc: "Governed dashboards on the same data — one set of numbers, one page.", capability: "aibi-dashboards",
      wiring: [{ from: "sql-lakehouse", action: "queries (SQL Warehouse)", optional: true }] },
    { id: "lakewatch", label: "LakeWatch", icon: "lakeWatchBrand", sublabel: "Agentic SIEM", desc: "Agentic SIEM on the lakehouse — unify security logs + telemetry (OCSF), AI agents detect, investigate and respond at machine speed.",
      authoring: "The security app: an agentic SIEM built ON the lakehouse. Use for security / SOC / threat-detection stories. Consumes governed telemetry from the data layer; SOC analysts + threat hunters use it.",
      wiring: [{ from: "sdp", action: "reads security logs + telemetry (OCSF) from" }, { from: "genie-one", action: "opened by (SOC analysts)", optional: true }] },
    { id: "customerlake", label: "CustomerLake", icon: "customerLakeBrand", sublabel: "Agentic CDP", desc: "Agentic customer data platform embedded in Databricks — unify profiles into a Customer 360, run always-on campaigns, no data copies.",
      authoring: "The marketing app: an agentic CDP on the lakehouse. Use for customer-360 / marketing / personalization / campaign stories. Consumes customer data from the data layer; marketers + analytics teams use it.",
      wiring: [{ from: "sdp", action: "builds Customer 360 from governed data of" }, { from: "genie-one", action: "opened by (marketers)", optional: true }] },
  ],
  "agentic-work": [
    { id: "databricks-apps-work", label: "Databricks Apps", icon: "databricksAppsBrand", sublabel: "Deploy business apps", desc: "Deploy business apps",
      authoring: "The custom business app — PREFERRED over the legacy databricks-apps tile. Runs on Lakebase; can embed the dashboard + Genie Agent.",
      wiring: [{ from: "lakebase", action: "reads/writes app state from" }, { from: "supervisor-agent", action: "calls", optional: true }, { from: "model-serving", action: "calls", optional: true }, { from: "ai-gateway", action: "model calls governed by", optional: true }] },
    { id: "genie-one", label: "Genie One", icon: "genieOneBrand", kind: "genie-one", sublabel: "The business user's front door", desc: "The enterprise AI coworker — the simplified Databricks front door where business users reach dashboards, Genie, and apps without technical expertise (formerly Databricks One).",
      authoring: "The business-user entry point / front door. It has a Business-users persona built IN (a small user icon docked above the Genie One mark) — so you do NOT need a separate file:persona/user node beside it. Wire Genie One --> dashboard / Genie Agent / app (auto-arrows; leave `arrow` out).",
      wiring: [{ from: "databricks-apps-work", action: "fronts / opens" }, { from: "genie", action: "fronts / opens" }, { from: "supervisor-agent", action: "fronts / opens" }, { from: "ai-bi-dashboard", action: "fronts / opens" }, { from: "lakewatch", action: "fronts / opens", optional: true }, { from: "customerlake", action: "fronts / opens", optional: true }] },
    { id: "genie", label: "Genie Agent", icon: "genieBrand", sublabel: "Ask anything about your data", desc: "ask anything about your data",
      wiring: [{ from: "sql-lakehouse", action: "runs governed SQL over" }, { from: "genie-ontology", action: "grounded in (semantics)", optional: true }, { from: "supervisor-agent", action: "routed to by", optional: true }] },
    { id: "knowledge-assistant", label: "Knowledge Assistant", icon: "knowledgeAssistant", desc: "Chat with your documents — grounded, cited answers from unstructured content.",
      wiring: [{ from: "uc-volume", action: "reads documents from (RAG)" }, { from: "supervisor-agent", action: "routed to by" }] },
    { id: "supervisor-agent", label: "Supervisor Agent", icon: "multiAgentSupervisor", desc: "Routes a question to the right specialist agent and composes the answer.",
      authoring: "The Multi-Agent Supervisor (MAS) — routes to specialist agents/tools + composes the answer. It can orchestrate MANY types (up to 50): Genie · Knowledge Assistant · Model Serving endpoints · Unity Catalog functions/tables/volumes · Vector/AI Search index · published dashboards · MCP servers (external / UC / custom / Hosted MCPs) · web search · custom agents (Databricks Apps) · nested supervisors. Wire in the ones the demo actually uses.",
      wiring: [
        { from: "genie", action: "routes to" },
        { from: "knowledge-assistant", action: "routes to" },
        { from: "model-serving", action: "routes to (custom model)" },
        { from: "hosted-mcps", action: "calls tools via (MCP)" },
        { from: "vector-search", action: "queries (AI Search index)" },
        { from: "ai-bi-dashboard", action: "queries (published dashboard)" },
        { from: "uc-volume", action: "reads files/tools from (UC function/table/volume)" },
        { from: "databricks-apps-work", action: "routes to (custom agent)" },
        { from: "lakebase", action: "reads/writes agent memory + task queue from", optional: true },
        { from: "genie-ontology", action: "grounded in (semantics)", optional: true },
      ] },
    // Composite "Agent Bricks" block: the bundled agent building blocks
    // (supervisor + extraction + document parsing + classification).
    { id: "agent-bricks", label: "Agent Bricks", icon: "file:vendor/agent-bricks", kind: "agent-bricks",
      desc: "Databricks' managed agents — a multi-agent supervisor plus information extraction, document parsing, and classification, built and governed for you.",
      authoring: "The whole managed agent layer in ONE tile: a Supervisor with all its sub-capabilities inside it (Knowledge Assistant · Genie agent · MCP · Functions · classification · extraction · doc parsing). Input comes directly from a data source or from the lakehouse/medallion; output goes to an app, a Genie Space, or Genie One. USE THIS SINGLE TILE when the diagram is NOT centered on Agent Bricks — it keeps the overview simple, one block standing in for the entire agentic layer. But if the architecture IS ABOUT Agent Bricks (it's the focus), DON'T collapse it — SPLIT it into a `supervisor-agent` tile plus one tile per specialist (`knowledge-assistant`, `genie`, `hosted-mcps`, functions…), each wired separately, so the sub-agents are visible.",
      wiring: [{ from: "medallion-table", action: "reads governed data from" }, { from: "genie", action: "linked to (Genie Space)", optional: true }, { from: "databricks-apps-work", action: "answers surfaced in", optional: true }, { from: "genie-one", action: "serves business users via", optional: true }, { from: "lakebase", action: "agent memory in", optional: true }, { from: "genie-ontology", action: "grounded in", optional: true }] },
    { id: "ml-training-serving", label: "ML Models", icon: "mlModel", desc: "Train, register, and serve models on governed data.",
      authoring: "Two consumption patterns, same model: BATCH — score over Delta → a gold predictions table that dashboards/Genie/apps read (simplest, a good default); REAL-TIME endpoint when per-request scoring fits the story (fraud at auth, rec at page-load). Lean batch unless the demo needs live scoring.",
      wiring: [{ from: "sdp", action: "trains on gold features from" }, { from: "feature-store", action: "trains on features from" }, { from: "sdp", action: "batch predictions written back to a gold table of (default path)" }, { from: "databricks-apps-work", action: "real-time endpoint called by", optional: true }] },
    { id: "ml-model", label: "Machine Learning Model", icon: "mlModelBrand", desc: "A trained model on governed data — classification, forecasting, recommendations, and more.",
      wiring: [{ from: "sdp", action: "trains on gold features from" }] },
    { id: "model-training", label: "Model Training", icon: "mlflowBrand", desc: "Train + track experiments with MLflow — parameters, metrics, and artifacts, all governed.",
      wiring: [{ from: "sdp", action: "trains on gold features from" }, { from: "feature-store", action: "trains on features from" }, { from: "uc-model-registry", action: "registers trained model to" }, { from: "model-serving", action: "feedback loop from" }] },
    { id: "mlops", label: "MLOps", icon: "mlopsBrand", desc: "The full model lifecycle — train, evaluate, register, deploy, and monitor, governed end to end." },
    // Medallion layers (orange brand marks) — used inside the SDP/pipeline block.
    { id: "bronze-layer", label: "Bronze", icon: "bronzeLayer", desc: "Raw ingested data, landed as-is." },
    { id: "silver-layer", label: "Silver", icon: "silverLayer", desc: "Cleaned, conformed, deduplicated." },
    { id: "gold-layer", label: "Gold", icon: "goldLayer", desc: "Curated, business-ready aggregates." },
    { id: "medallion-table", label: "Medallion Table", icon: "goldLayer", kind: "medallion-table",
      desc: "Bronze → Silver → Gold in one block — the medallion refinement of a governed table.",
      authoring: "The whole medallion (bronze → silver → gold) as ONE block, with the metal-toned layer marks and an internal flow. Prefer this over three separate bronze/silver/gold tiles when you just want to show the layered data itself. OPTIONS (params): `feature_store` and `metric_views` (booleans) — each adds a fork off the GOLD layer (Feature Store above, Metric Views below) shown inside the block, and exposes an extra right-side OUTPUT handle so you can wire it: `@out-gold` (always), `@out-fs` (when feature_store), `@out-mv` (when metric_views). Also `bronze_desc` / `silver_desc` / `gold_desc` (optional strings) — a SHORT caption under each layer (e.g. `gold_desc:\"Business marts + metrics\"`); the block grows to fit. Keep each to a few words.",
      options: [
        { key: "feature_store", label: "Feature store" },
        { key: "metric_views", label: "Metric views" },
        ...LAYER_CAPTION_OPTIONS,
      ],
      ports: { "l": "← sources / ingest", "out-gold": "→ gold output", "out-fs": "→ feature store (when enabled)", "out-mv": "→ metric views (when enabled)" },
      wiring: [{ from: "sources / ingest (@l)", action: "reads raw data from" }, { from: "sql-lakehouse", action: "gold consumed by (@out-gold)" }, { from: "model-serving", action: "gold trains model (@out-gold / @out-fs)" }] },
    { id: "feature-store", label: "Feature Store", icon: "featureStoreBrand", desc: "Governed, reusable features for training and real-time serving — consistent offline and online.",
      wiring: [{ from: "sdp", action: "computes features from gold tables of" }] },
    { id: "uc-model-registry", label: "UC Model Registry", icon: "modelRegistryBrand", desc: "Version, stage, and govern models in Unity Catalog with full lineage.",
      wiring: [{ from: "model-training", action: "registers models from" }, { from: "model-serving", action: "loads model into" }, { from: "lakeflow-jobs", action: "loads model into (batch scoring)" }] },
    { id: "model-serving", label: "Model Serving Endpoint", icon: "modelServing", desc: "Serve a custom model behind a governed, autoscaling REST endpoint for real-time inference.",
      authoring: "A deployed serving endpoint (real-time inference over a custom/registered model). Best fit when the story needs per-request scoring (fraud at authorization, rec at page-load). For a plain train→register→batch-score story, batch is usually simpler — the model writes a gold predictions table (via ml-training-serving / the medallion) that dashboards/apps read; reach for a live endpoint when real-time matters.",
      wiring: [{ from: "uc-model-registry", action: "loads registered model from" }, { from: "databricks-apps-work", action: "called for real-time predictions by", optional: true }, { from: "supervisor-agent", action: "called by", optional: true }] },
    { id: "hosted-mcps", label: "Hosted MCPs", icon: "mcp", desc: "Managed MCP servers that let agents call external tools — Genie, Atlassian, GitHub, Slack, SharePoint, Gmail, and more.",
      authoring: "The governed tool/connector layer for agents — hosted MCP servers (Genie / Atlassian / GitHub / Slack / SharePoint / Gmail …). Use when the demo's agent reaches OUT to external systems via MCP.",
      wiring: [{ from: "external tools (Genie, GitHub, Slack, …)", action: "exposes as tools" }, { from: "supervisor-agent", action: "tools called by" }] },
    { id: "vector-search", label: "Vector Search", icon: "vectorSearchBrand", desc: "Embeddings",
      authoring: "Two build modes: (a) MANAGED — auto-sync an index FROM a Delta table (data must land in Delta first via sdp; easiest, higher latency); (b) STANDALONE — a direct index updated via a real-time API to add/remove entries (low latency). Pick the one the demo's freshness needs.",
      wiring: [
        { from: "sdp", action: "auto-syncs index from a Delta table of (managed mode)" },
        { from: "realtime API", action: "direct add/remove entries (standalone mode, low-latency)" },
        { from: "supervisor-agent", action: "queried as AI Search index by (RAG)" },
      ] },
    { id: "information-extraction", label: "Information Extraction", icon: "unstructuredData", desc: "Pull specific data points, entities, and fields from unstructured text (ai_extract).",
      wiring: [{ from: "uc-volume", action: "reads unstructured text from" }, { from: "supervisor-agent", action: "orchestrated by" }] },
    // The Agent Bricks building blocks (also surfaced inside the composite).
    { id: "document-parsing", label: "Document Parsing", icon: "inputData", desc: "Extract structured content from documents — text, tables, and metadata (ai_parse_document).",
      wiring: [{ from: "uc-volume", action: "reads documents from" }, { from: "supervisor-agent", action: "orchestrated by" }] },
    { id: "text-classification", label: "Text Classification", icon: "aiFunctions", desc: "Categorize text into predefined or dynamic labels (ai_classify).",
      authoring: "Two typical shapes: (a) INLINE in the pipeline — a bi-directional arrow with `sdp` (enriches tables in place with ai_classify, usually drawn just below SDP); or (b) a STANDALONE job reading docs from a `uc-volume` and writing labels to a table. Pick per demo.",
      wiring: [{ from: "sdp", action: "enriches tables in-pipeline (bi-directional, ai_classify)" }, { from: "uc-volume", action: "standalone job reads docs from" }, { from: "supervisor-agent", action: "orchestrated by" }] },
    { id: "genie-code", label: "Built with Genie Code", icon: "genieCodeBrand", kind: "genie-code",
      desc: "Autonomous AI coding partner built into every Databricks surface (notebooks, pipelines, dashboards, MLflow) — Unity Catalog–aware, so it writes code against your real tables.",
      authoring: "The 'built/maintained by Genie Code' beat — an AI coding partner for developers/practitioners (business users get the simpler no-code experience via Genie One). No need to add it separately when you're already using lakeflow-genie-block (that block has the Genie Code footer built in)." },
  ],
  "unified-governance": [
    // Composite "Unified Governance" bar: Unity Catalog + Unity AI Gateway (all
    // foundation models) + Genie Ontology, rendered as one horizontal strip.
    { id: "governance-block", label: "Unified Governance", icon: "unityCatalogBrand", kind: "governance",
      desc: "One control plane for data + AI: Unity Catalog governs access/lineage/audit (ACL · ABAC); the Unity AI Gateway governs every foundation-model call (OpenAI, Anthropic, Gemini, …); Genie Ontology is the shared semantic layer.",
      authoring: "One governance bar with up to three surfaces: Access control (ACL · ABAC · Audit across Data + AI) + Unity AI Gateway (access any model) + Genie Ontology. Prefer over the loose unity-catalog / ai-gateway / data-quality / abac / data-classification tiles (use those only to spotlight one feature). OPTIONS (params, booleans, all default TRUE — set false to HIDE that surface): `access_control` / `ai_gateway` / `genie_ontology`; the bar tightens to the surfaces shown. Governance SPANS everything (data, jobs, dashboards, apps, end-user access…), so show it STRUCTURALLY — `pin` it as a bar across the top or bottom of the platform box; its position implies it governs all tiles under it, so draw NO per-tile edges. DEFAULT: the one-line spanning bar with NO edges — keep it low-touch, don't map it to every component. If a surface DOES need wiring, each shown one has a top+bottom handle (`@acl` / `@ai-gateway` / `@ontology`, + `-b`) and typically connects to: `@acl` → the DATA layer (medallion/lakehouse; the compute layer too if needed); `@ontology` → Genie (Genie Space / Genie agents); `@ai-gateway` → apps or model-serving (the frontier-model callers). Wire only the one or two that the story calls for, not all three. Any edge touching this block renders as a plain DASHED line with NO flow animation (governance governs, it doesn't flow data) — automatic, don't set `flow`/`dashed`.",
      options: [
        { key: "access_control", label: "Access control (ACL · ABAC · Audit)", type: "boolean", default: true },
        { key: "ai_gateway", label: "Unity AI Gateway", type: "boolean", default: true },
        { key: "genie_ontology", label: "Genie Ontology", type: "boolean", default: true },
      ],
      ports: { "acl": "↑ access control (ACL · ABAC · Audit)", "acl-b": "↓ access control (bottom)", "ai-gateway": "↑ Unity AI Gateway", "ai-gateway-b": "↓ Unity AI Gateway (bottom)", "ontology": "↑ Genie Ontology", "ontology-b": "↓ Genie Ontology (bottom)" } },
    { id: "db-platform", label: "Databricks Platform", icon: "file:vendor/databricks-wordmark", kind: "db-platform",
      desc: "The Databricks Data + AI platform — one governed foundation for all data + AI.",
      authoring: "Title banner (the Databricks wordmark). Pin it top-left, usually paired with a big background box wrapping everything (a wrapping box auto-renders behind its children — no z needed) → reads as 'all of this is the platform'." },
    { id: "unity-catalog", label: "Unity Catalog", icon: "unityCatalogBrand", desc: "One governed catalog — access, lineage, and semantics across data + AI.",
      authoring: "Governs EVERYTHING — data, jobs, dashboards, apps, end-user access. So don't wire it to every tile (overkill/noise). Best default: the spanning governance bar (this tile or `governance-block`) pinned top/bottom of the platform box, NO edges — position implies it governs all. If you use the single tile with edges (to spotlight governance), link only the 1–2 MAIN anchors (e.g. the data layer, or end-user access), not everything. Follow the user if they ask to show it governing something specific." },
    { id: "ai-gateway", label: "Unity AI Gateway", icon: "aiGatewayBrand", kind: "ai-gateway", desc: "Security, governance, cost and rate limits.",
      wiring: [{ from: "databricks-apps-work", action: "governs model calls of" }, { from: "model-serving", action: "governs" }],
      authoring: "The Unity AI Gateway tile with a row of foundation-model logos (OpenAI · Anthropic · Gemini · Grok · Kimi) across the top — conveys 'govern + access ANY model' at a glance. Use standalone; the Unified Governance bar already embeds a compact gateway if you want the whole control plane. It governs the model calls that apps / model-serving endpoints make — wire it to whatever actually makes those calls (an app or model endpoint typically routes through it), labeled 'model calls governed by'. Keep that edge SHORT and adjacent to what it governs; don't drag the tile far away and route a long line across unrelated tiles (that reads as if the source 'calls the gateway' — the confusion to avoid)." },
    { id: "data-quality", label: "Data Quality", icon: "unityCatalog", desc: "Expectations and monitors keep bad data out of the gold layer." },
    { id: "abac", label: "ABAC", icon: "unityCatalog", desc: "Attribute-based access control — fine-grained, policy-driven permissions." },
    { id: "data-classification", label: "Data Classification", icon: "unityCatalog", desc: "Automatically tag and govern sensitive data." },
  ],
  "agentic-data": [
    // Composite "Lakeflow" super-block: Lakeflow Connect + Zerobus + direct
    // ingest feeding a bronze→silver→gold pipeline, with 3 left input ports.
    { id: "lakeflow-block", label: "Lakeflow", icon: "lakeflowConnectBrand", kind: "lakeflow",
      desc: "One block: managed ingest (Lakeflow Connect), real-time streams (Zerobus) and direct file landing, all flowing into a declarative bronze → silver → gold pipeline.",
      authoring: "The whole ingest + bronze→silver→gold SDP in one block (no Genie Code framing). Contains SDP — never add a separate sdp tile beside it. OPTIONS (params, all optional strings): `bronze_desc` / `silver_desc` / `gold_desc` — a SHORT caption under that layer's cylinder (e.g. `gold_desc:\"Business marts + metrics\"`); the block grows to fit. Keep each to a few words.",
      options: LAYER_CAPTION_OPTIONS,
      ports: { "in-lakeflow-connect": "← databases / SaaS apps", "in-zerobus": "← realtime streams / sensors", "in-direct": "← files: PDF / CSV / Parquet", "r": "→ the compute layer" },
      wiring: [{ from: "sources (via @in-* ports)", action: "ingests from" }, { from: "sql-lakehouse", action: "feeds gold tables to" }, { from: "lakebase", action: "syncs gold tables to" }] },
    // Combined box: the Lakeflow super-block stacked over the Genie Code block.
    { id: "lakeflow-genie-block", label: "Lakeflow + Genie", icon: "lakeflowConnectBrand", kind: "lakeflow-genie",
      desc: "Lakeflow ingest + declarative pipeline, with Genie Code building and maintaining it — one box, end to end.",
      authoring: "The PREFERRED data-layer block — ingest + bronze→silver→gold SDP, built/maintained by Genie Code. It IS the data layer; contains SDP + Genie Code, so never add separate sdp / genie-code tiles beside it. OPTIONS (params, all optional strings): `bronze_desc` / `silver_desc` / `gold_desc` — a SHORT caption under that layer's cylinder; the block grows to fit. Keep each to a few words.",
      options: LAYER_CAPTION_OPTIONS,
      ports: { "in-lakeflow-connect": "← databases / SaaS apps", "in-zerobus": "← realtime streams / sensors", "in-direct": "← files: PDF / CSV / Parquet", "r": "→ the compute layer" },
      wiring: [{ from: "sources (via @in-* ports)", action: "ingests from" }, { from: "sql-lakehouse", action: "feeds gold tables to" }, { from: "lakebase", action: "syncs gold tables to" }] },
    { id: "lakeflow-connect", label: "Lakeflow Connect", icon: "lakeflowConnectBrand", desc: "A few-click interface to connect and ingest data from 100+ sources — SaaS apps, databases, files and knowledge systems.",
      wiring: [{ from: "external connectors / SaaS / DBs", action: "ingests from" }, { from: "sdp", action: "lands raw tables into" }] },
    { id: "zerobus-ingest", label: "Lakeflow Zerobus", icon: "zerobus", desc: "Real-time, direct ingest of streaming events into the lakehouse.",
      wiring: [{ from: "streaming / live events (apps, devices)", action: "receives push from" }, { from: "sdp", action: "lands raw tables into" }] },
    { id: "sdp", label: "Lakeflow SDP", icon: "sdpBrand", desc: "Spark Declarative Pipelines — declarative bronze → silver → gold that self-heal and scale.",
      wiring: [{ from: "lakeflow-connect", action: "reads ingested data from" }, { from: "zerobus-ingest", action: "reads streams from" }, { from: "uc-volume", action: "reads files from (Auto Loader)" }, { from: "lakeflow-jobs", action: "orchestrated by", optional: true }] },
    { id: "uc-volume", label: "UC Volume", icon: "volume", desc: "Governed file storage in Unity Catalog — where raw documents (PDFs) land.",
      wiring: [{ from: "files / documents (PDF, CSV, images)", action: "stores" }] },
    { id: "lakeflow-jobs", label: "Lakeflow Jobs", icon: "lakeflowJobsBrand", sublabel: "Orchestrate anything", desc: "The orchestrator for any workflow — ingestion, SDP pipelines, notebooks, SQL queries, ML training/scoring, and deployment — on a schedule or trigger.",
      authoring: "The workspace orchestrator. It can run ANY component as a task: data ingestion (Lakeflow Connect, notebooks, SDP), SQL queries, ML training/scoring, and deployment steps — chained with dependencies, on a schedule or trigger. Wire an `orchestrates` edge from Lakeflow Jobs to every step it runs.",
      wiring: [{ from: "sdp", action: "orchestrates" }, { from: "ml-training-serving", action: "orchestrates" }, { from: "notebooks-eda", action: "orchestrates" }, { from: "lakeflow-connect", action: "orchestrates" }] },
    { id: "notebooks-eda", label: "Notebooks", icon: "notebooks", desc: "Interactive exploration and analysis on governed data.",
      wiring: [{ from: "sdp", action: "explores tables from" }] },
    { id: "delta-sharing", label: "Delta Sharing", icon: "deltaSharing", desc: "Open, cross-org data sharing with no copies." },
    { id: "marketplace", label: "Marketplace", icon: "deltaSharing", desc: "Discover and consume third-party data and AI assets." },
    { id: "lakebase", label: "Lakebase", icon: "lakebaseBrand", sublabel: "Serverless Postgres — instant start, branch", desc: "Managed Postgres for app state — reads/writes the live queue.",
      wiring: [{ from: "sdp", action: "syncs with Delta — EITHER reverse-ETL Delta→Postgres, OR live app writes Postgres→Delta for analysis" }, { from: "databricks-apps", action: "powers state + agent memory for" }, { from: "supervisor-agent", action: "stores agent memory / task queue for" }] },
    { id: "sql-lakehouse", label: "Lakehouse", icon: "lakehouseBrand", badge: "RT", sublabel: "~100 ms charts, thousands of concurrent users", desc: "One copy of governed data for BI + AI — real-time queries at scale (SQL Warehouse; RT = Lakehouse Real Time).",
      wiring: [{ from: "sdp", action: "queries gold tables from" }, { from: "ai-bi-dashboard", action: "serves queries to" }, { from: "genie", action: "serves queries to" }] },
  ],
  // Sources are demo-authored. The catalog ships the LuxeBeauty example set so
  // the diagram reads as a complete architecture out of the box; the agent
  // REPLACES these (via the `sources` band `add` + hiding these) with the
  // demo's real systems. Each declares its `ingest` path.
  // Sources are demo-authored. The catalog ships the LuxeBeauty example set so
  // the diagram reads as a complete architecture out of the box; the agent
  // REPLACES these per demo. Third-party logos render as a name badge until the
  // trademark toggle is enabled.
  sources: [
    // Default sources are license-safe (OSS logos) + generic feeds — a clean
    // starting estate. The agent swaps in the demo's real systems (Shopify,
    // Zendesk, …) per story; those vendor logos live in the icon bank / "+ more
    // data sources" picker and the palette search.
    { id: "src-kafka", label: "Kafka", icon: "file:vendor/kafka", desc: "Streaming events ingested in real time via Zerobus." },
    { id: "src-postgres", label: "Postgres", icon: "file:vendor/postgresql", desc: "Operational database ingested via Lakeflow Connect." },
    { id: "src-sensors", label: "Sensor data", icon: "sensorSource", desc: "Real-time sensor / IoT telemetry, streamed via Zerobus." },
    { id: "src-pdf", label: "PDF documents", icon: "pdfLogo", desc: "Documents (PDFs) — landed as files on a UC Volume." },
  ],
};

/** Flat id → (catalog component + its band), built once from CATALOG. The new
 *  flat file format keys nodes by `type` = catalog id; this resolves the
 *  defaults (icon/label/desc/sublabel/badge/kind/ingest) + the band (tile
 *  color). */
const CATALOG_BY_ID: Map<string, { c: CatalogComponent; band: BandId }> = (() => {
  const m = new Map<string, { c: CatalogComponent; band: BandId }>();
  for (const band of BAND_ORDER) for (const c of CATALOG[band]) m.set(c.id, { c, band });
  return m;
})();

// =============================================================================
// Natural sizes — the canonical [w,h] each node type renders at (before any
// user resize). Single source of truth: shared.tsx `baseSize` delegates here,
// and `computeLayout` uses it to stack columns + size wrapper boxes.
// =============================================================================

/** Default annotation sizes (mirror of ANNOTATION_DEFAULT_SIZE in annotations.tsx —
 *  kept here to avoid a lib→component import cycle). */
const ANNOTATION_SIZE: Record<AnnotationVariant, { w: number; h: number }> = {
  text: { w: 160, h: 40 },
  box: { w: 180, h: 100 },
  logo: { w: 64, h: 64 },
  image: { w: 200, h: 140 },
  note: { w: 180, h: 140 },
};

/** Medallion-table footprint — grows when a fork option (`feature_store` /
 *  `metric_views`) is on: the last column becomes a vertical MV/Gold/FS stack,
 *  so it gets a bit WIDER (labels) and TALLER (one row per option). Also grows
 *  when a LAYER DESCRIPTION (`bronze_desc`/`silver_desc`/`gold_desc`) is set:
 *  each layer's mark+label gains a short caption line below it, so the block
 *  gets TALLER (room for the line) and WIDER (the layers spread out to fit the
 *  captions without crowding). SINGLE source of truth for the medallion box —
 *  `naturalSize` (→ layout/`sizeOf`), `nodeFootprint` (the ReactFlow selection
 *  frame), and the composite render (`shared.tsx` re-exports this) all resolve
 *  through here, so symbolic layout, the resize frame, and the visual agree. */
export function medallionSize(params?: Record<string, boolean | string>): { w: number; h: number } {
  const fs = !!params?.feature_store;
  const mv = !!params?.metric_views;
  // Any layer desc set → reserve a caption line under the marks + a wider box so
  // the bronze/silver/gold columns get more breathing room for the text.
  const hasLayerDesc = !!(layerDescOf(params, "bronze") || layerDescOf(params, "silver") || layerDescOf(params, "gold"));
  const descH = hasLayerDesc ? 30 : 0;   // ~2 lines at the small caption font
  const descW = hasLayerDesc ? 84 : 0;   // spread the 3 columns apart for captions
  if (!fs && !mv) return { w: 268 + descW, h: 96 + descH };
  const forkRows = 1 + (fs ? 1 : 0) + (mv ? 1 : 0);
  return { w: 300 + descW, h: Math.max(96, 44 + forkRows * 38) + descH };
}

/** Governance-bar footprint. Three governed surfaces (access-control, AI Gateway,
 *  Genie Ontology) shown side by side; each is an OPT-OUT `params` boolean
 *  (`access_control`/`ai_gateway`/`genie_ontology`) — ABSENT or true = shown,
 *  false = hidden. No params → all three (back-compat). Width scales with the
 *  count of shown surfaces so the bar tightens when some are off. */
export function governanceSize(params?: Record<string, boolean | string>): { w: number; h: number } {
  const shown = governanceSurfaces(params);
  // Every surface is the SAME width (ontology included); width scales with count.
  const n = shown.acl + shown.gateway + shown.ontology || 1;
  return { w: Math.round(96 + n * 158), h: 92 };
}

/** Which governance surfaces are shown (opt-out: absent/true = shown). */
export function governanceSurfaces(params?: Record<string, boolean | string>): { acl: number; gateway: number; ontology: number } {
  const on = (k: string) => (params?.[k] === false ? 0 : 1);
  return { acl: on("access_control"), gateway: on("ai_gateway"), ontology: on("genie_ontology") };
}

/** Read a layer-caption param (`bronze_desc`/`silver_desc`/`gold_desc`) as a
 *  trimmed string, or undefined when absent/blank/non-string. Shared by the size
 *  helper and the composite render so both agree on when a caption exists. */
export function layerDescOf(
  params: Record<string, boolean | string> | undefined,
  layer: "bronze" | "silver" | "gold",
): string | undefined {
  const v = params?.[`${layer}_desc`];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Normalize a `stack` value from the file (agent- or hand-authored, so it may
 *  be a float, string, huge, or garbage) to a clean integer in [2, 5], or
 *  `undefined` when there's no meaningful stack (≤1, NaN, non-finite). The
 *  renderer caps at 5 anyway; coercing here keeps the file honest and avoids a
 *  fractional value silently floor-truncating the shadow-card count. */
export function sanitizeStack(v: unknown): number | undefined {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 1) return undefined;
  return Math.min(n, 5);
}

/** Natural [w,h] for a file `type` (catalog id / composite kind / source /
 *  annotation variant). Mirrors shared.tsx `baseSize`. `params` is read for a
 *  `medallion-table` (fork options) and for the `lakeflow*` blocks (a medallion
 *  LAYER DESC grows them); pass `n.params` so symbolic layout reserves the same
 *  box the node actually renders at. */
export function naturalSize(type: string, params?: Record<string, boolean | string>): { w: number; h: number } {
  if (ANNOTATION_TYPES.has(type as AnnotationVariant)) return ANNOTATION_SIZE[type as AnnotationVariant];
  const c = CATALOG_BY_ID.get(type)?.c;
  const kind = c?.kind;
  // Lakeflow blocks grow when any medallion layer desc is set (matches baseSize).
  const lfDesc = !!(layerDescOf(params, "bronze") || layerDescOf(params, "silver") || layerDescOf(params, "gold"));
  if (kind === "lakeflow") return lfDesc ? { w: 312, h: 176 } : { w: 268, h: 148 };
  if (kind === "lakeflow-genie") return lfDesc ? { w: 380, h: 232 } : { w: 360, h: 208 };
  if (kind === "agent-bricks") return { w: 230, h: 170 };
  if (kind === "genie-code") return { w: 360, h: 112 };
  if (kind === "governance") return governanceSize(params);
  if (kind === "db-platform") return { w: 380, h: 60 };
  if (kind === "genie-one") return { w: 230, h: 78 }; // tile; persona pill floats over the top edge
  if (kind === "ai-gateway") return { w: 240, h: 104 }; // model-logo row on top + gateway body below
  if (kind === "medallion-table") return medallionSize(params);
  if (type === "sdp") return { w: 230, h: 112 };
  // EVERY plain single-line catalog tile shares ONE footprint (230×54) so any
  // column of them lines up — Lakehouse, Genie Agent, Knowledge Assistant,
  // Supervisor Agent, Model Serving, … all identical. (Previously the size keyed
  // on whether a tile happened to carry a `sublabel`, so sibling agent tiles came
  // out different sizes — the bug this fixes.)
  if (c) return { w: 230, h: 54 };
  // Non-catalog ids: a demo-authored data source (`type:"source"`) has no catalog
  // entry — its own narrower default (a vertical caption swaps to VERTICAL_SOURCE_SIZE
  // via nodeFootprint).
  return { w: 200, h: 56 };
}

/** The full footprint of a captioned LOGO annotation — the icon square PLUS the
 *  caption laid out beside/below it (with a gap + a little padding). The logo
 *  now renders as a CENTERED flex of [icon][gap][text] filling this box (see
 *  AnnotationNode + RotatableCard), so the icon+caption reads as ONE centered
 *  unit inside a wrapping box / column. SINGLE source of truth so the layout
 *  (`computeLayout.sizeOf`), the ReactFlow node box (`nodeFootprint`), and the
 *  render all agree — otherwise the reserved slot and the drawn unit drift and
 *  the caption spills off-center (the bug this fixes).
 *
 *  Text width is ESTIMATED here (the lib can't measureText — that's the UI-only
 *  `logoFitSize`); the estimate is a slight over-reserve, which is harmless: the
 *  centered flex splits any spare space evenly so the unit stays centered.
 *  A caption-less logo returns the bare icon square. */
export const LOGO_CAP_GAP = 8;  // gap between icon and caption (matches the render)
export const LOGO_CAP_PAD = 4;  // breathing room so the caption never kisses the edge
export function logoFootprint(
  iconW: number,
  iconH: number,
  a: { caption?: AnnotationData["caption"]; text?: string; fontSize?: number; showDesc?: boolean; desc?: string },
): { w: number; h: number } {
  if (!a.text) return { w: iconW, h: iconH };
  const fs = a.fontSize ?? 13;
  // Medium-weight caption ≈ 0.62em/char (matches sizeOf's prior estimate).
  const textW = Math.ceil(a.text.length * fs * 0.62);
  const capNorm = a.caption === "side" ? "right" : a.caption === "below" ? "bottom" : (a.caption ?? "bottom");
  const horiz = capNorm === "right" || capNorm === "left";
  const lineH = Math.ceil(fs * 1.3);
  // A DESC (2nd caption line, top/bottom only) reserves ~2 lines at the smaller font.
  const descFs = Math.max(10, fs - 2);
  const hasDesc = !!(a.showDesc && a.desc && !horiz);
  const descH = hasDesc ? Math.ceil(descFs * 1.3) * 2 + 2 : 0;
  const descW = hasDesc ? Math.min(220, Math.ceil((a.desc ?? "").length * descFs * 0.30) + 24) : 0;
  if (horiz) return { w: iconW + LOGO_CAP_GAP + textW + LOGO_CAP_PAD * 2, h: iconH };
  // top/bottom (vertical): stack icon over caption (+ optional desc lines).
  return { w: Math.max(iconW, textW, descW) + LOGO_CAP_PAD * 2, h: iconH + LOGO_CAP_GAP + lineH + descH };
}

// A SOURCE tile's label-fitted width for a horizontal (right/left) caption —
// the analog of `logoFootprint` for the `type:"source"` card (component-node →
// NodeCard "tile"): a fixed 36px icon square + a 10px gap + the label, inside
// 12px horizontal padding each side. Text width is ESTIMATED the same way as
// logoFootprint (semibold ≈ 0.62em/char) since the lib can't measureText. Used
// ONLY to size a lane group to its widest source; the natural (unfitted) box
// stays 200 for a lone source. */
const SOURCE_ICON = 36;   // h-9 w-9
const SOURCE_GAP = 10;    // gap-2.5
const SOURCE_PAD = 12;    // px-3
export function sourceCaptionWidth(label: string | undefined, fontSize = 13): number {
  const textW = Math.ceil((label ?? "").length * fontSize * 0.62);
  return SOURCE_PAD + SOURCE_ICON + SOURCE_GAP + textW + SOURCE_PAD;
}

// =============================================================================
// Build: catalog + resources.json defaults + agent override → final schema
// =============================================================================

/** The catalog as resolved bands (every component, state "active"). The render
 *  path uses `layout.nodes` for WHAT is shown; `bands` is only consulted via
 *  componentLookup (resolve a type → defaults) and for band color, so shipping
 *  the full catalog here is correct and keeps those lookups total. */
function catalogSchemaBands(): PlatformBand[] {
  return BAND_ORDER.map((bandId) => ({
    id: bandId,
    label: BAND_META[bandId].label,
    sublabel: BAND_META[bandId].sublabel,
    components: CATALOG[bandId].map((c) => ({ ...c, state: "active" as ComponentState })),
  }));
}

/** Split `"id@handle"` → `{ id, handle }`. */
function splitHandle(ref: string): { id: string; handle?: string } {
  const at = ref.indexOf("@");
  return at === -1 ? { id: ref } : { id: ref.slice(0, at), handle: ref.slice(at + 1) };
}

// =============================================================================
// computeLayout — resolve symbolic placement (columns + wraps) into pixel
// positions. Explicit `at` always wins; only nodes without `at` are placed.
// =============================================================================

const INTER_COL_GAP = 78; // x gap between the EDGES of adjacent lanes (tight — lanes hug their content)
const DEFAULT_COL_W = 200; // assumed width for a declared-but-empty lane
const ROW_GAP = 30;   // vertical gap between stacked tiles in a lane (a little
                      //   breathing room, but still grouped — not scattered)
const WRAP_PAD = 34;   // default container padding (breathing room so wrapped
                       //   content / nested boxes never sit flush to the border)

export interface ResolvedBox {
  x: number; y: number; w: number; h: number;
  /** DERIVED lane-uniform width for a captioned logo/source that's part of a
   *  same-lane group (see step 2.5). When set, every member of the group carries
   *  the SAME value (= the widest member's footprint), so the rendered card
   *  boxes match. Not persisted — recomputed on every parse. */
  laneW?: number;
}

/** Resolve every node's CENTER [x,y] (and, for wrapper boxes, its [w,h]) from
 *  the file's `columns`/`col`/`row` + `wraps`. A node with an explicit `at` is
 *  pinned there (and excluded from column stacking). Returns a map id→box.
 *
 *  Column widths are PROPORTIONAL to content: each lane is as wide as its
 *  widest node (rotation-aware), and lanes sit INTER_COL_GAP apart edge-to-
 *  edge — a narrow lane (a rotated Genie One, a persona logo) pulls its
 *  neighbours in instead of reserving a fixed-width slot. */
export function computeLayout(file: ArchitectureFile): Map<string, ResolvedBox> {
  const out = new Map<string, ResolvedBox>();
  const nodes = file.nodes ?? [];
  // On-canvas footprint: explicit `size` (or natural), with w/h SWAPPED for a
  // 90°/270° rotation — a rotated tall node is a narrow one on the canvas.
  const sizeOf = (n: FileNode): { w: number; h: number } => {
    let s = n.size ? { w: n.size[0], h: n.size[1] } : naturalSize(n.type, n.params);
    // A captioned LOGO's full footprint = icon square + caption beside/below it
    // (the logo renders as a CENTERED icon+caption flex filling this box). Its
    // bare 60×60 icon size UNDER-reports the real footprint, so a `wraps` box or
    // column built from it would be too small for the label. Reserve the caption
    // room via the shared `logoFootprint` (same math the ReactFlow node box +
    // render use), so the reserved slot and the drawn unit agree. Explicit `size`
    // always wins.
    if (n.type === "logo" && !n.size && n.text) {
      s = logoFootprint(s.w, s.h, n);
    }
    const q = (((n.rot ?? 0) % 360) + 360) % 360;
    return q === 90 || q === 270 ? { w: s.h, h: s.w } : s;
  };

  // 1) Pinned nodes (explicit `at`) — use verbatim. Wrapper boxes are resolved
  //    later (their size/pos derive from children) unless they too were pinned.
  for (const n of nodes) {
    if (Array.isArray(n.at)) {
      const s = sizeOf(n);
      out.set(n.id, { x: n.at[0], y: n.at[1], w: s.w, h: s.h });
    }
  }

  // 2) Column stacking — only non-wrapper, un-pinned nodes that declare a `col`.
  //    A node whose position is set RELATIONALLY opts out of stacking so it never
  //    reserves a ghost slot in a lane it gets pulled out of:
  //      • `leftOf`/`rightOf` → horizontal satellite: leaves the lane entirely
  //        (no lane width / no stack row).
  //      • `alignY`/`below`/`above` → its Y is external, so it must NOT take a
  //        stack row (else the remaining lane nodes stack around a phantom).
  //        It still gets its lane's X later (step 3) so it sits IN the column,
  //        just at the relationally-chosen height.
  //    (`alignX` only overrides X, so it keeps its normal stack row.)
  const cols = file.columns ?? [];
  const colIndex = new Map(cols.map((c, i) => [c, i]));
  const yRelational = (n: FileNode) => !!(n.alignY || n.below || n.above);
  const laned = nodes.filter(
    (n) =>
      !out.has(n.id) && !n.wraps && !n.leftOf && !n.rightOf && !yRelational(n) &&
      n.col && colIndex.has(n.col),
  );
  const byCol = new Map<string, FileNode[]>();
  for (const n of laned) {
    const arr = byCol.get(n.col!) ?? [];
    arr.push(n);
    byCol.set(n.col!, arr);
  }
  // Lane width = the widest node it holds (rotation-aware); lane centers are
  // cumulative so a narrow lane takes only the room it needs. The FIRST lane
  // stays centered at x=0 (the historical origin).
  const colWidth = new Map<string, number>();
  for (const [col, list] of byCol) {
    // A captioned SOURCE's natural size is a fixed 200 that truncates its label;
    // its real (label-fitted) width is what step 2.5 imposes on the lane group, so
    // reserve THAT here too — otherwise a wide source column would overlap its
    // neighbour (inter-column spacing keys off colWidth).
    const laneCapW = (n: FileNode) =>
      n.type === "source" && !n.size && n.label && !Array.isArray(n.at)
        ? sourceCaptionWidth(n.label, n.fontSize)
        : 0;
    colWidth.set(col, Math.max(...list.map((n) => Math.max(sizeOf(n).w, laneCapW(n)))));
  }
  // How much a column's content is INSET by the boxes wrapping it: each ancestor
  // box adds its `pad` to every side, so the box's outer edge sits `Σpad` beyond
  // the lane content. Two adjacent lanes wrapped in nested boxes would otherwise
  // have their OUTER boxes overlap (INTER_COL_GAP is a lane-content gap, but the
  // boxes bulge into it). We widen the lane separation by the facing insets so
  // the gap survives BETWEEN the boxes, at whatever nesting depth. A node belongs
  // to a column iff it's laned there; a box wraps the column iff it (transitively)
  // wraps any of that column's laned nodes.
  const colNodeIds = new Map<string, Set<string>>();
  for (const [col, list] of byCol) colNodeIds.set(col, new Set(list.map((n) => n.id)));
  // The boxes (with their pad) that transitively wrap a given column's content.
  // Used to space adjacent lanes: a box wrapping BOTH lanes is a common ancestor
  // and does NOT separate them (it just contains the pair); only boxes wrapping
  // exactly ONE side push its edge toward the neighbour, so only those count as
  // "facing" overhang. This keeps the visible gap between adjacent boxes equal to
  // INTER_COL_GAP at any nesting depth (unboxed lanes → no boxes → plain gap).
  const boxesForCol = (col: string): Map<string, number> => {
    const ids = colNodeIds.get(col);
    const res = new Map<string, number>();
    if (!ids || !ids.size) return res;
    const wrapsCol = (boxId: string, seen = new Set<string>()): boolean => {
      if (seen.has(boxId)) return false;
      seen.add(boxId);
      const b = nodes.find((n) => n.id === boxId);
      for (const cid of b?.wraps ?? []) {
        if (ids.has(cid) || wrapsCol(cid, seen)) return true;
      }
      return false;
    };
    for (const n of nodes) {
      if (n.wraps && n.wraps.length && !Array.isArray(n.at) && wrapsCol(n.id)) {
        res.set(n.id, n.pad ?? WRAP_PAD);
      }
    }
    return res;
  };
  const colBoxes = new Map(cols.map((c) => [c, boxesForCol(c)]));
  // Facing overhang from a lane toward its right neighbour = Σpad of boxes that
  // wrap THIS lane but not the neighbour (common ancestors excluded).
  const facingInset = (col: string, other: string): number => {
    const mine = colBoxes.get(col) ?? new Map();
    const theirs = colBoxes.get(other) ?? new Map();
    let s = 0;
    for (const [id, pad] of mine) if (!theirs.has(id)) s += pad;
    return s;
  };
  const colX = new Map<string, number>();
  {
    let prevRightFacing = 0; // right-facing overhang of the previous lane's boxes
    let contentRight = 0;    // running right edge of the previous lane's CONTENT
    cols.forEach((c, i) => {
      const w = colWidth.get(c) ?? DEFAULT_COL_W;
      const leftFacing = i === 0 ? 0 : facingInset(c, cols[i - 1]);
      // gap between CONTENT edges = INTER_COL_GAP + both facing overhangs, so the
      // BOX edges end up exactly INTER_COL_GAP apart.
      const cx = i === 0 ? 0 : contentRight + prevRightFacing + INTER_COL_GAP + leftFacing + w / 2;
      colX.set(c, cx);
      contentRight = cx + w / 2;
      prevRightFacing = i + 1 < cols.length ? facingInset(c, cols[i + 1]) : 0;
    });
  }
  if (file.rowGrid) {
    // SHARED ROW GRID: `row` aligns across ALL columns. Every laned node with the
    // same `row` shares one horizontal band; the band's height is the tallest
    // node in it; bands stack top→bottom (ROW_GAP apart) centered on y=0. X still
    // comes from the node's own column lane.
    //
    // A node WITHOUT a `row` falls back to stacking within its OWN column, exactly
    // like non-grid mode: it takes the next free band DOWN from that column's last
    // numbered node (so two unnumbered nodes in a lane stack, they don't each grab
    // a separate band). So `rowGrid` works with or without `row` set — set it to
    // align across columns, omit it to just stack in the lane.
    const rowOf = new Map<string, number>();
    const nextFree = new Map<string, number>(); // per-column running row for unnumbered nodes
    // Cells a node occupies (≥1) — a node taller than one pitch spans extra rows.
    const cellSpan = (n: FileNode) => Math.max(1, Math.ceil(sizeOf(n).h / (54 + ROW_GAP)));
    for (const n of laned) {
      if (n.row !== undefined) {
        rowOf.set(n.id, n.row);
        // an unnumbered node in this lane resumes stacking BELOW this row's span
        nextFree.set(n.col!, Math.max(nextFree.get(n.col!) ?? 1, n.row + cellSpan(n)));
      } else {
        const r = nextFree.get(n.col!) ?? 1;
        rowOf.set(n.id, r);
        nextFree.set(n.col!, r + cellSpan(n)); // advance by this node's span
      }
    }
    // FIXED-PITCH GRID. Every row sits on a CONSTANT grid line (row r at
    // r × ROW_PITCH), so a tile at row 3 in one column ALWAYS lands on the same
    // Y line regardless of a taller node at row 3 in another column. A node
    // TALLER than one cell simply OVERFLOWS downward past its line (into the
    // next cell's space) — it does NOT push other columns or inflate the row.
    // Nodes are TOP-ALIGNED to their row line, so a short tool and a tall
    // medallion sharing a row both start at the same top edge (no gap). The
    // per-column `cellSpan` above keeps a tall node from getting another node
    // stacked on top of it WITHIN its own lane, but the shared grid lines are
    // fixed and independent of node heights.
    const CELL_H = 54;             // a standard single-line tile's height
    const ROW_PITCH = CELL_H + ROW_GAP; // one grid cell = a standard tile + gap (matches cellSpan above)
    const present = [...new Set([...rowOf.values()])];
    const minR = Math.min(...present);
    const maxR = Math.max(...present);
    // Fixed line (TOP of the cell) for each integer row; walking min→max means a
    // SKIPPED row number still consumes one pitch (the 0,2,4 spacing lever).
    const rowTopY = new Map<number, number>();
    for (let r = minR; r <= maxR; r++) rowTopY.set(r, (r - minR) * ROW_PITCH);
    const totalH = (maxR - minR) * ROW_PITCH + CELL_H; // last cell's tile height
    const shift = totalH / 2; // recenter the whole grid on y=0
    for (const n of laned) {
      const s = sizeOf(n);
      const r = rowOf.get(n.id)!;
      // Top-align the node to its row line (its center = line-top + own h/2), so
      // tiles on the same row share a top edge and a tall node overflows down.
      const y = rowTopY.get(r)! + s.h / 2 - shift;
      out.set(n.id, { x: colX.get(n.col!) ?? 0, y, w: s.w, h: s.h });
    }
  } else {
    for (const [col, list] of byCol) {
      list.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)); // stable-ish; appearance order kept for ties
      const x = colX.get(col) ?? 0;
      const heights = list.map((n) => sizeOf(n).h);
      const total = heights.reduce((s, h) => s + h, 0) + ROW_GAP * (list.length - 1);
      let cy = -total / 2; // center the stack on y=0
      list.forEach((n, i) => {
        const s = sizeOf(n);
        out.set(n.id, { x, y: cy + heights[i] / 2, w: s.w, h: s.h });
        cy += heights[i] + ROW_GAP;
      });
    }
  }

  // 2.5) UNIFORM-WIDTH + ICON-ALIGN a lane's captioned tiles. A frequent pattern
  //   is a column of right-caption LOGOS (a domain / table list) OR captioned
  //   SOURCE tiles (Salesforce / Kafka streams / PDF contracts) with DIFFERENT-
  //   length labels. Each tile's box hugs its own icon+text, so the boxes come out
  //   different widths and — since every box is centered on the lane X — the ICONS
  //   zigzag. Instead, size the whole GROUP to the WIDEST member and give every
  //   member that SAME width, then align each tile's ICON to the lane's caption-
  //   side content edge: the boxes read as one clean column of equal cards and the
  //   icons form a single vertical line. Only runs for a GROUP (2+ such tiles on
  //   one caption side in a lane); a lone tile keeps its natural width + centering.
  //
  //   The uniform width is stashed on the resolved box as `laneW` (DERIVED — never
  //   serialized) so the ReactFlow node box + the card render honor it instead of
  //   re-deriving from the label. Sources also get `box.w`/`box.h` set to the
  //   fitted footprint (their natural size is a fixed 200 that truncates the label).
  {
    // A captioned LOGO or SOURCE with a horizontal (right/left) caption + label.
    // "side" is the legacy alias for right. Pinned (`at`) tiles are left alone.
    const horizCapTile = (n: FileNode): "left" | "right" | null => {
      if (Array.isArray(n.at)) return null;
      const label = n.type === "logo" ? n.text : n.type === "source" ? n.label : undefined;
      if (!label) return null;
      // A SOURCE with no explicit caption renders "right" by default (matches
      // component-node's `d.sourceCaption ?? "right"`); a LOGO with no caption
      // renders "bottom" (vertical), so it's NOT part of a horizontal group.
      const raw = n.caption ?? (n.type === "source" ? "right" : undefined);
      const c = raw === "side" ? "right" : raw;
      return c === "right" ? "right" : c === "left" ? "left" : null;
    };
    // Fitted horizontal footprint width for a group member (label-dependent):
    // logos via logoFootprint, sources via the source-card estimate. Explicit
    // `size` wins (the tile isn't reflowed).
    const fittedW = (n: FileNode): number => {
      if (n.size) return sizeOf(n).w;
      if (n.type === "logo") return sizeOf(n).w; // sizeOf already applies logoFootprint
      return Math.max(sourceCaptionWidth(n.label, n.fontSize), naturalSize(n.type, n.params).w);
    };
    for (const [col, list] of byCol) {
      const tiles = list.filter((n) => horizCapTile(n));
      if (tiles.length < 2) continue;
      const laneCx = colX.get(col) ?? 0;
      // Group by caption side (a lane could mix, though rare) so each side aligns
      // to its own edge: right-caption icons hug the lane's LEFT edge; left-caption
      // icons (text-then-icon) hug the lane's RIGHT edge.
      for (const side of ["right", "left"] as const) {
        const group = tiles.filter((n) => horizCapTile(n) === side);
        if (group.length < 2) continue;
        // The GROUP's uniform width = the widest member's fitted footprint. Every
        // member is sized to this so the cards match; the icons then line up
        // because equal box widths + equal inner pad ⇒ equal icon edges.
        const maxW = Math.max(...group.map(fittedW));
        for (const n of group) {
          const box = out.get(n.id);
          if (!box) continue;
          box.w = maxW;
          box.laneW = maxW; // DERIVED signal to flow-mapping + the render
          // The icon sits at the box's caption-side edge (right-caption → icon at
          // box LEFT; left-caption → icon at box RIGHT). Shift the center so that
          // edge aligns to the lane's matching content edge — shared across the
          // group (all boxes now share `maxW`, so this yields ONE x for all).
          box.x = side === "right"
            ? laneCx - maxW / 2 + box.w / 2   // icon (box left) → lane left edge
            : laneCx + maxW / 2 - box.w / 2;  // icon (box right) → lane right edge
        }
      }
    }
  }

  // 3) Any node still unplaced (no `at`, no resolvable `col`, not a wrapper) →
  //    park at origin (shouldn't happen with well-formed files).
  //    EXCEPTION: a node whose ONLY placement is "inside a wrapping box" (no
  //    col/at/relational, but named in some box's `wraps`) is AUTO-SEEDED: it
  //    stacks vertically inside its box starting at row 0, in wraps-order. This
  //    lets you author `wraps:[a,b]` + `below:x` with NO position on a/b at all
  //    — step 4 sizes the box around the seeds, then recenters them inside it
  //    (see `autoSeeded` below). Mixed boxes work too: explicit col/row children
  //    keep their lane; bare children fill the box body underneath.
  const autoSeeded = new Set<string>();
  // Provisional Y per wrapped-only child, cumulative by actual height + ROW_GAP,
  // so the box that wraps them sizes to the SAME tight stack the recenter uses
  // (a fixed step would size the box wrong for >1 seed). In a MIXED box (some
  // children placed by col/at/relational, some bare) the bare ones stack BELOW
  // the placed ones — we start `cy` at the bottom of the already-resolved
  // wrapped children (they were placed in steps 1–2) so seeds don't overlap them.
  const isBare = (c: FileNode | undefined): c is FileNode =>
    !!c && !Array.isArray(c.at) && !c.wraps && !c.col && !c.leftOf && !c.rightOf &&
    !c.alignX && !c.alignY && !c.below && !c.above;
  const seedY = new Map<string, number>();
  for (const b of nodes) {
    // Bottom of this box's placed (non-bare) wrapped children, if any — bare
    // children begin their stack a ROW_GAP below that; else at 0 (pure box).
    let placedBottom = -Infinity;
    for (const cid of b.wraps ?? []) {
      const r = out.get(cid);
      if (r) placedBottom = Math.max(placedBottom, r.y + r.h / 2);
    }
    let cy = placedBottom > -Infinity ? placedBottom + ROW_GAP : 0;
    for (const cid of b.wraps ?? []) {
      if (seedY.has(cid)) continue; // first wrapping box wins
      const c = nodes.find((x) => x.id === cid);
      if (!isBare(c)) continue; // only bare children are auto-seeded
      const h = sizeOf(c).h;
      seedY.set(cid, cy + h / 2);
      cy += h + ROW_GAP;
    }
  }
  for (const n of nodes) {
    if (out.has(n.id) || n.wraps) continue;
    const s = sizeOf(n);
    // A y-relational node that names a real `col` keeps that lane's X (so it
    // stays IN the column at its relational height).
    if (n.col && colX.has(n.col)) {
      out.set(n.id, { x: colX.get(n.col)!, y: 0, w: s.w, h: s.h });
      continue;
    }
    // Wrapped-only node with no position → auto-seed, stacked by wraps-order.
    if (seedY.has(n.id)) {
      autoSeeded.add(n.id);
      out.set(n.id, { x: 0, y: seedY.get(n.id)!, w: s.w, h: s.h });
      continue;
    }
    // True orphan → park at origin.
    out.set(n.id, { x: 0, y: 0, w: s.w, h: s.h });
  }

  // 3.5) Relational placement — position a node against ANOTHER node's box.
  //   alignX/alignY: copy the anchor's center on that axis (keep the other axis).
  //   below/above/leftOf/rightOf: butt up against the anchor's edge (+`gap`),
  //     centered on the anchor's other axis. `at` is never overridden.
  //   Resolved in dependency order so a chain (A rightOf B, B rightOf C) settles.
  //   Then TWO de-overlap passes keep the default readable without an auto-layout
  //   engine: (a) FAN-OUT — several nodes bound to the same anchor+direction
  //   spread evenly along the perpendicular axis, centered on the anchor, instead
  //   of piling on one point; (b) NUDGE — a relational node still overlapping a
  //   FIXED node (lane / `at` / box) slides along its free axis until it clears.
  //   Only relational nodes ever move; anchors and authored lane nodes stay put.
  const SIB_GAP = 24; // spacing between sibling satellites of the same anchor
  {
    // A node's single relational directive (first set wins), + which axis it
    // pins (the anchor's edge/center it copies) vs. its FREE axis (fanned/nudged).
    type Dir = "alignX" | "alignY" | "leftOf" | "rightOf" | "above" | "below";
    const DIRS: Dir[] = ["alignX", "alignY", "leftOf", "rightOf", "above", "below"];
    const dirOf = (n: FileNode): Dir | undefined => DIRS.find((d) => n[d]);
    const isRel = (n: FileNode) =>
      !Array.isArray(n.at) && !n.wraps && dirOf(n) !== undefined;
    const rels = nodes.filter(isRel);
    // Free axis = the one the relation does NOT pin, so it's safe to fan/nudge on.
    //   leftOf/rightOf/alignX pin X  → free axis is Y.
    //   above/below/alignY   pin Y  → free axis is X.
    const freeAxisOf = (d: Dir): "x" | "y" =>
      d === "leftOf" || d === "rightOf" || d === "alignX" ? "y" : "x";

    // (0) Base placement — dependency-ordered so anchors resolve first.
    const done = new Set<string>();
    const place = (n: FileNode, seen: Set<string>): void => {
      if (done.has(n.id) || seen.has(n.id)) return;
      seen.add(n.id);
      for (const d of DIRS) {
        const ref = n[d] as string | undefined;
        const dep = ref && rels.find((r) => r.id === ref);
        if (dep) place(dep, seen);
      }
      const self = out.get(n.id);
      if (!self) return;
      const gap = n.gap ?? 40;
      const a = out.get((n[dirOf(n)!] as string) ?? "");
      if (!a) { done.add(n.id); return; }
      const d = dirOf(n)!;
      if (d === "alignX") self.x = a.x;
      else if (d === "alignY") self.y = a.y;
      else if (d === "leftOf") { self.x = a.x - a.w / 2 - gap - self.w / 2; self.y = a.y; }
      else if (d === "rightOf") { self.x = a.x + a.w / 2 + gap + self.w / 2; self.y = a.y; }
      else if (d === "above") { self.y = a.y - a.h / 2 - gap - self.h / 2; self.x = a.x; }
      else if (d === "below") { self.y = a.y + a.h / 2 + gap + self.h / 2; self.x = a.x; }
      done.add(n.id);
    };
    for (const n of rels) place(n, new Set());

    // Lane-anchored nodes (`alignX`/`alignY` WITH a resolvable `col`) are lane
    // members whose free axis is owned by the lane, not free to fan — they're
    // handled by reserve-a-slot (pass b), NOT by fan-out. Compute the set up front
    // so fan-out can skip them.
    const isLaneAligned = (n: FileNode) =>
      !!(n.col && colX.has(n.col) && (n.alignX || n.alignY) &&
        !n.below && !n.above && !n.leftOf && !n.rightOf);
    const laneAligned = rels.filter(isLaneAligned);

    // (a) FAN-OUT — group siblings by (anchor, direction). Distribute each group
    //     of >1 along its free axis, centered on the anchor's center on that axis.
    //     Lane-anchored nodes are excluded (reserve-a-slot owns them).
    const groups = new Map<string, FileNode[]>();
    for (const n of rels) {
      if (isLaneAligned(n)) continue;
      const d = dirOf(n)!;
      const key = `${n[d]}|${d}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(n);
    }
    for (const [key, sibs] of groups) {
      if (sibs.length < 2) continue;
      const anchor = out.get(key.split("|")[0]);
      if (!anchor) continue;
      const axis = freeAxisOf(dirOf(sibs[0])!);
      const ext = (b: ResolvedBox) => (axis === "y" ? b.h : b.w);
      const center = axis === "y" ? anchor.y : anchor.x;
      const boxes = sibs.map((n) => out.get(n.id)!).filter(Boolean);
      const total = boxes.reduce((s, b) => s + ext(b), 0) + SIB_GAP * (boxes.length - 1);
      let cursor = center - total / 2;
      boxes.forEach((b) => {
        const c = cursor + ext(b) / 2;
        if (axis === "y") b.y = c; else b.x = c;
        cursor += ext(b) + SIB_GAP;
      });
    }

    const relIds = new Set(rels.map((r) => r.id));
    const overlaps = (a: ResolvedBox, b: ResolvedBox) =>
      Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

    // (b) RESERVE-A-SLOT — `alignX`/`alignY` nodes that live IN a lane (`col`) are
    //     lane members pinned to an external position: they keep their slots and
    //     the lane's PLAIN (row-stacked) mates flow into the gaps around them, in
    //     row order, so the lane stays contiguous with no overlap. Handled PER
    //     LANE so several aligned nodes in one column share the same reflow (one
    //     independent re-stack per aligned node would fight the others).
    const laneGroups = new Map<string, FileNode[]>();
    for (const n of laneAligned) {
      const laneAxis = n.alignY ? "y" : "x";
      const k = `${n.col}|${laneAxis}`;
      (laneGroups.get(k) ?? laneGroups.set(k, []).get(k)!).push(n);
    }
    for (const [key, aligned] of laneGroups) {
      const laneAxis = key.split("|")[1] as "x" | "y";
      const col = key.split("|")[0];
      const ext = (b: ResolvedBox) => (laneAxis === "y" ? b.h : b.w);
      const pos = (b: ResolvedBox) => (laneAxis === "y" ? b.y : b.x);
      const setPos = (b: ResolvedBox, v: number) => { if (laneAxis === "y") b.y = v; else b.x = v; };
      // Two+ aligned nodes pointing at the SAME target (or targets closer than
      // their combined size) would pin to the same spot — spread each such
      // cluster like siblings, centered on the cluster's mean, so they don't
      // stack. (A single aligned node keeps its exact target.)
      const alignedBoxes = aligned.map((n) => out.get(n.id)!).filter(Boolean).sort((a, b) => pos(a) - pos(b));
      let ci = 0;
      while (ci < alignedBoxes.length) {
        const cluster = [alignedBoxes[ci]];
        let cj = ci + 1;
        while (cj < alignedBoxes.length &&
               pos(alignedBoxes[cj]) - pos(cluster[cluster.length - 1]) < (ext(alignedBoxes[cj]) + ext(cluster[cluster.length - 1])) / 2 + SIB_GAP) {
          cluster.push(alignedBoxes[cj]); cj++;
        }
        if (cluster.length > 1) {
          const mean = cluster.reduce((s, b) => s + pos(b), 0) / cluster.length;
          const totalC = cluster.reduce((s, b) => s + ext(b), 0) + SIB_GAP * (cluster.length - 1);
          let cur = mean - totalC / 2;
          for (const b of cluster) { setPos(b, cur + ext(b) / 2); cur += ext(b) + SIB_GAP; }
        }
        ci = cj;
      }
      // Reserved intervals = each aligned node's footprint at its (now spread)
      // pinned position (+SIB_GAP margin), sorted along the lane axis.
      const reserved = alignedBoxes
        .map((b) => ({ lo: pos(b) - ext(b) / 2 - SIB_GAP, hi: pos(b) + ext(b) / 2 + SIB_GAP }))
        .sort((a, b) => a.lo - b.lo);
      // Plain (non-relational) lane-mates in row order flow around the reserved
      // slots: walk the lane, and whenever the next mate would land inside a
      // reserved interval, jump the cursor past it.
      const mates = nodes
        .filter((m) => !relIds.has(m.id) && !m.wraps && m.col === col && out.has(m.id))
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
      if (!mates.length) continue;
      // Flow mates in row order, skipping reserved slots. Run it once as a DRY
      // pass to measure the block's extent, then re-run shifted so the whole lane
      // (mates + pinned slots) is CENTERED on the lane's natural center (0) — the
      // aligned nodes stay pinned; the mates balance around them, no side-drift.
      const runFrom = (start: number, commit: boolean): { min: number; max: number } => {
        let cursor = start, min = Infinity, max = -Infinity;
        for (const m of mates) {
          const b = out.get(m.id)!;
          const e = ext(b);
          for (const r of reserved) {
            if (cursor < r.hi && cursor + e > r.lo) cursor = r.hi;
          }
          if (commit) setPos(b, cursor + e / 2);
          min = Math.min(min, cursor);
          max = Math.max(max, cursor + e);
          cursor += e + SIB_GAP;
        }
        return { min, max };
      };
      const dry = runFrom(0, false);
      const extMin = Math.min(dry.min, ...reserved.map((r) => r.lo));
      const extMax = Math.max(dry.max, ...reserved.map((r) => r.hi));
      runFrom(-((extMin + extMax) / 2), true);
    }

    // (c) NUDGE — any OTHER relational node still overlapping something slides
    //     along its free axis (away from the overlap) until clear. It de-conflicts
    //     against FIXED nodes AND against other satellites already positioned
    //     earlier in the list — only `self` moves per hit, so processing in order
    //     is asymmetric (later satellites yield to earlier ones) → no oscillation.
    //     Anchors and authored lane nodes never move. A few passes settle chains.
    const nudgeable = rels.filter((n) => !laneAligned.includes(n));
    const fixed = nodes.filter((n) => !relIds.has(n.id) && !n.wraps && out.has(n.id));
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      nudgeable.forEach((n, i) => {
        const self = out.get(n.id);
        if (!self) return;
        const axis = freeAxisOf(dirOf(n)!);
        // Obstacles = every fixed node + every satellite placed BEFORE this one.
        const obstacles = [
          ...fixed.map((f) => f.id),
          ...nudgeable.slice(0, i).map((o) => o.id),
        ].filter((oid) => oid !== n.id);
        for (const oid of obstacles) {
          const ob = out.get(oid)!;
          if (!ob || !overlaps(self, ob)) continue;
          if (axis === "y") {
            const need = (self.h + ob.h) / 2 - Math.abs(self.y - ob.y) + SIB_GAP;
            self.y += (self.y <= ob.y ? -need : need);
          } else {
            const need = (self.w + ob.w) / 2 - Math.abs(self.x - ob.x) + SIB_GAP;
            self.x += (self.x <= ob.x ? -need : need);
          }
          moved = true;
        }
      });
      if (!moved) break;
    }
  }

  // 4) Box nodes (wrappers and/or explicit `bounds`) — innermost first.
  //    `wraps` → enclose children + pad. `bounds` → place each named side at a
  //    node/column anchor (can cut halfway through a node). A box may use both:
  //    `bounds` sides win, unspecified sides fall back to the wrap rect (or 0).
  const boxes = nodes.filter((n) => (n.wraps && n.wraps.length) || n.bounds);
  const depth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const parent = boxes.find((w) => w.wraps?.includes(id));
    return parent ? 1 + depth(parent.id, seen) : 0;
  };
  // Deepest children first (a box sizes around already-placed children); at equal
  // depth, a box positioned relative to ANOTHER box (below/above/alignY) resolves
  // AFTER its anchor so the anchor's rect exists when we shift.
  const relRef = (n: FileNode) => (n.alignY ?? n.above ?? n.below) as string | undefined;
  boxes.sort((a, b) => {
    const d = depth(b.id) - depth(a.id);
    if (d) return d;
    if (relRef(a) === b.id) return 1;  // a depends on b → a after b
    if (relRef(b) === a.id) return -1;
    return 0;
  });

  // Resolve a `bounds` side string → an absolute coordinate on the given axis.
  //   "<nodeId>:<anchor>"  | "col:<name>:<anchor>"  | "wrap"
  // anchor ∈ left|right|center (x axis) / top|bottom|center (y axis).
  const sideCoord = (spec: string, axis: "x" | "y"): number | undefined => {
    if (spec === "wrap") return undefined;
    if (spec.startsWith("col:")) {
      const [, name, anchor = "center"] = spec.split(":");
      const cx = colX.get(name);
      if (cx === undefined || axis !== "x") return undefined;
      // The lane's real half-extent: half its content width + half the edge gap
      // (so col:left/right cut midway between adjacent lanes).
      const half = (colWidth.get(name) ?? DEFAULT_COL_W) / 2 + INTER_COL_GAP / 2;
      return cx + (anchor === "left" ? -half : anchor === "right" ? half : 0);
    }
    const [id, anchor = "center"] = spec.split(":");
    const b = out.get(id);
    if (!b) return undefined;
    if (axis === "x") return anchor === "left" ? b.x - b.w / 2 : anchor === "right" ? b.x + b.w / 2 : b.x;
    return anchor === "top" ? b.y - b.h / 2 : anchor === "bottom" ? b.y + b.h / 2 : b.y;
  };

  for (const w of boxes) {
    if (Array.isArray(w.at)) continue; // pinned box: leave as-is
    const pad = w.pad ?? WRAP_PAD;
    // Wrap rect from children (if any) — the fallback for unspecified sides.
    const kids = (w.wraps ?? []).map((cid) => out.get(cid)).filter(Boolean) as ResolvedBox[];
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    for (const k of kids) {
      L = Math.min(L, k.x - k.w / 2); T = Math.min(T, k.y - k.h / 2);
      R = Math.max(R, k.x + k.w / 2); B = Math.max(B, k.y + k.h / 2);
    }
    if (kids.length) { L -= pad; T -= pad; R += pad; B += pad; }
    // Override sides from explicit `bounds`.
    const bn = w.bounds;
    const left = bn?.left ? sideCoord(bn.left, "x") ?? L : L;
    const right = bn?.right ? sideCoord(bn.right, "x") ?? R : R;
    const top = bn?.top ? sideCoord(bn.top, "y") ?? T : T;
    const bottom = bn?.bottom ? sideCoord(bn.bottom, "y") ?? B : B;
    if (![left, right, top, bottom].every(Number.isFinite)) {
      out.set(w.id, { x: 0, y: 0, w: 200, h: 100 });
      continue;
    }
    // RESERVE bands for NON-float pinned children docking into this box: a top
    // pin pushes the top edge up by its height (+pad); a bottom pin extends the
    // bottom edge down. Float pins overlay and reserve nothing.
    let top2 = top, bottom2 = bottom;
    const docked = nodes.filter((n) => n.pin && !n.pin.float && !Array.isArray(n.at) && n.pin.to === w.id);
    const bandH = (vside: "top" | "bottom") => {
      const hs = docked
        .filter((n) => (n.pin!.at.startsWith("top") ? "top" : n.pin!.at.startsWith("bottom") ? "bottom" : "") === vside)
        .map((n) => sizeOf(n).h);
      return hs.length ? Math.max(...hs) + 2 * (/* band pad */ 12) : 0;
    };
    top2 -= bandH("top");
    bottom2 += bandH("bottom");
    out.set(w.id, { x: (left + right) / 2, y: (top2 + bottom2) / 2, w: right - left, h: bottom2 - top2 });

    // A wrapping box may ALSO be positioned relative to another node/box via
    // `below`/`above`/`alignY` (a box's position is otherwise 100% wrap-derived,
    // so there was no way to say "metastore BELOW the workspaces"). We do it HERE,
    // after the box is sized, and SHIFT the box + its whole wrapped subtree by the
    // delta — so its contents move with it. Boxes resolve deepest-first, so an
    // ANCESTOR box (resolved later) re-sizes around the moved box automatically.
    // (leftOf/rightOf intentionally not supported for boxes yet — below/above/
    // alignY cover the "stack a container under/over another" case.)
    const bdir = w.alignY ? "alignY" : w.above ? "above" : w.below ? "below" : undefined;
    if (bdir) {
      const self = out.get(w.id)!;
      const a = out.get((w[bdir] as string) ?? "");
      if (a) {
        const gap = w.gap ?? 40;
        const targetY =
          bdir === "alignY" ? a.y
          : bdir === "below" ? a.y + a.h / 2 + gap + self.h / 2
          : a.y - a.h / 2 - gap - self.h / 2; // above
        const dy = targetY - self.y;
        if (dy) {
          // Shift this box + every descendant it (transitively) wraps.
          const subtree = new Set<string>([w.id]);
          const collect = (id: string) => {
            const bx = boxes.find((b) => b.id === id);
            for (const cid of bx?.wraps ?? []) if (!subtree.has(cid)) { subtree.add(cid); collect(cid); }
          };
          collect(w.id);
          for (const id of subtree) { const r = out.get(id); if (r) r.y += dy; }
        }
      }
    }

    // Recenter this box's AUTO-SEEDED children into its interior: center them on
    // the box's X and stack them in wraps order. Placed (col/at/relational)
    // children are untouched — so a MIXED box keeps its explicit children in
    // place and stacks the bare ones BELOW them (starting a ROW_GAP under the
    // lowest placed child, or from the top pad if the box is pure auto-seed).
    // Done last so it uses the box's FINAL rect (after any below/above shift).
    const self = out.get(w.id);
    const seeds = (w.wraps ?? []).filter((cid) => autoSeeded.has(cid));
    if (self && seeds.length) {
      // Bottom of the placed (non-seed) wrapped children within this box.
      let placedBottom = -Infinity;
      for (const cid of w.wraps ?? []) {
        if (autoSeeded.has(cid)) continue;
        const r = out.get(cid);
        if (r) placedBottom = Math.max(placedBottom, r.y + r.h / 2);
      }
      let cy = placedBottom > -Infinity ? placedBottom + ROW_GAP : self.y - self.h / 2 + pad;
      seeds.forEach((cid, i) => {
        const r = out.get(cid);
        if (!r) return;
        r.x = self.x;
        r.y = cy + r.h / 2;
        cy += r.h + (i < seeds.length - 1 ? ROW_GAP : 0); // tight in-box stack
      });
    }
  }

  // 5) Pinned-by-anchor nodes (`pin`) — resolved LAST, after boxes are sized.
  //    Anchor against `pinTo` (a box id) or, if absent, the largest box / the
  //    overall content bounds. NON-float pins sit in their reserved band at the
  //    box edge (left/center/right by the h anchor); float pins inset inward.
  const ANCHORS: Record<string, [number, number]> = {
    "top-left": [-1, -1], top: [0, -1], "top-right": [1, -1],
    left: [-1, 0], center: [0, 0], right: [1, 0],
    "bottom-left": [-1, 1], bottom: [0, 1], "bottom-right": [1, 1],
  };
  const pinned = nodes.filter((n) => n.pin && !Array.isArray(n.at));
  if (pinned.length) {
    // Default target = the biggest box, else the bounding box of everything.
    const allBoxes = boxes.map((w) => out.get(w.id)).filter(Boolean) as ResolvedBox[];
    const biggest = allBoxes.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    let fallback = biggest;
    if (!fallback) {
      let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
      for (const b of out.values()) { L = Math.min(L, b.x - b.w / 2); T = Math.min(T, b.y - b.h / 2); R = Math.max(R, b.x + b.w / 2); B = Math.max(B, b.y + b.h / 2); }
      fallback = Number.isFinite(L) ? { x: (L + R) / 2, y: (T + B) / 2, w: R - L, h: B - T } : { x: 0, y: 0, w: 0, h: 0 };
    }
    for (const n of pinned) {
      const target = (n.pin!.to ? out.get(n.pin!.to) : undefined) ?? fallback;
      const s = sizeOf(n);
      const pad = n.pin!.pad ?? 16;
      const [ax, ay] = ANCHORS[n.pin!.at] ?? [0, 0];
      if (!n.pin!.float) {
        // Docked into a reserved band: x = left/center/right edge of the box
        // (inset by half size + pad); y = the band centre at the box edge
        // (the box already grew to make room, so it sits BELOW/ABOVE content).
        const x = target.x + ax * (target.w / 2 - s.w / 2 - pad);
        const y = target.y + ay * (target.h / 2 - s.h / 2 - 12);
        out.set(n.id, { x, y, w: s.w, h: s.h });
        continue;
      }
      // Inset by half the node size + pad so the node sits INSIDE the corner.
      const x = target.x + ax * (target.w / 2 - s.w / 2 - pad);
      const y = target.y + ay * (target.h / 2 - s.h / 2 - pad);
      out.set(n.id, { x, y, w: s.w, h: s.h });
    }
  }

  return out;
}

/** Parse the flat ArchitectureFile into the internal PlatformSchema the canvas
 *  consumes. `bands` = the full catalog (for lookup/color); `layout.nodes` =
 *  exactly the placed nodes from the file; `layout.edges` = the file edges. */
/** Pull the symbolic placement fields off a file node, or undefined if it has
 *  none (→ the node is pinned to pixels). */
function pickPlacement(n: FileNode): NodePosition["placement"] | undefined {
  const p: NonNullable<NodePosition["placement"]> = {};
  if (n.col !== undefined) p.col = n.col;
  if (n.row !== undefined) p.row = n.row;
  if (n.alignX !== undefined) p.alignX = n.alignX;
  if (n.alignY !== undefined) p.alignY = n.alignY;
  if (n.below !== undefined) p.below = n.below;
  if (n.above !== undefined) p.above = n.above;
  if (n.leftOf !== undefined) p.leftOf = n.leftOf;
  if (n.rightOf !== undefined) p.rightOf = n.rightOf;
  if (n.gap !== undefined) p.gap = n.gap;
  // Container / pin fields — a box or pinned banner MUST keep these symbolic, or
  // it flattens to a frozen `at`+`size` (children escape the box, banners drift).
  if (n.wraps !== undefined) p.wraps = n.wraps;
  if (n.pad !== undefined) p.pad = n.pad;
  if (n.bounds !== undefined) p.bounds = n.bounds;
  if (n.pin !== undefined) p.pin = n.pin;
  return Object.keys(p).length ? p : undefined;
}

/** Parse a single-architecture body into the resolved schema.
 *  `defaultLogosOn` sets the vendor-logo toggle's initial state ONLY when the
 *  file hasn't explicitly set `options.trademarkLogos` — so an env-driven /
 *  build-time default (public off, internal on) applies to un-toggled diagrams
 *  while an explicit per-diagram choice always wins. Defaults to `false` (the
 *  public default) so existing callers are unchanged. */
/** Automatic z-index for wrapping boxes so they render BEHIND their children
 *  without the author having to set `z` by hand. A box that `wraps` sits at a
 *  NEGATIVE z; nesting goes one level deeper (children above parents): a box
 *  whose deepest wrap-chain (counting itself) is D boxes gets z = -D. So a leaf
 *  wrapper (wraps only tiles) = -1, a box wrapping that = -2, etc. Tiles/edges
 *  stay at their defaults (≥0), always above every box. An EXPLICIT `z` on a box
 *  still wins (the author can override). Returns a map of box id → auto z. */
function autoBoxZ(file: ArchitectureFile): Map<string, number> {
  const nodes = file.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isBox = (id: string) => !!byId.get(id)?.wraps?.length;
  const depthMemo = new Map<string, number>();
  // Longest chain of NESTED boxes starting at this box (counting itself).
  const boxDepth = (id: string, seen = new Set<string>()): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (seen.has(id)) return 1; // cycle guard
    seen.add(id);
    let deepestChild = 0;
    for (const cid of byId.get(id)?.wraps ?? []) {
      if (isBox(cid)) deepestChild = Math.max(deepestChild, boxDepth(cid, seen));
    }
    seen.delete(id);
    const d = 1 + deepestChild;
    depthMemo.set(id, d);
    return d;
  };
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.wraps?.length && n.z === undefined) out.set(n.id, -boxDepth(n.id));
  }
  return out;
}

export function parseArchitecture(content: string, defaultLogosOn = false): PlatformSchema {
  const file = parseArchitectureFile(content) ?? {};
  const nodes: Record<string, NodePosition> = {};
  // Default z for wrapping boxes (behind their children) — see autoBoxZ.
  const boxZ = autoBoxZ(file);

  // Resolve symbolic placement (columns + wraps) → pixel positions. Explicit
  // `at` wins; this fills in the rest + sizes wrapper boxes.
  const placed = computeLayout(file);
  // file node id → the canvas node id we store under (catalog nodes may be
  // re-keyed to `type`), and its resolved box — used for edge-handle inference.
  const fileToNode = new Map<string, string>();
  const boxOf = new Map<string, ResolvedBox>();

  for (const n of file?.nodes ?? []) {
    if (!n?.id || !n.type) continue;
    const box = placed.get(n.id) ?? { x: 0, y: 0, ...naturalSize(n.type, n.params) };
    const [x, y] = [box.x, box.y];
    const st = n.style ?? {};
    // A container box's size is derived by computeLayout (from `wraps` and/or
    // `bounds`); otherwise an explicit `size` wins (a plain node keeps its
    // natural size → no w/h stored).
    const derivedSize = (n.wraps || n.bounds) && !n.size ? [box.w, box.h] as [number, number] : n.size;
    // Preserve symbolic placement for round-trip. A node authored WITHOUT `at`
    // that carries symbolic fields (col/relational/wraps/bounds/pin) is un-`pinned`:
    // on save it re-emits those fields (not `at`) unless the user drags it. A node
    // authored WITH `at`, or with no symbolic fields at all, is pinned to pixels.
    const placement = pickPlacement(n);
    const pinned = Array.isArray(n.at) || !placement;
    const pos: NodePosition = {
      x: x ?? 0,
      y: y ?? 0,
      type: n.type,
      ...(placement ? { placement } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(n.params && Object.keys(n.params).length ? { params: n.params } : {}),
      ...(sanitizeStack(n.stack) ? { stack: sanitizeStack(n.stack)! } : {}),
      ...(n.rot !== undefined ? { rot: n.rot } : {}),
      ...(derivedSize ? { w: derivedSize[0], h: derivedSize[1] } : {}),
      // DERIVED lane-uniform width (step 2.5) for a captioned logo/source group —
      // never persisted, but the RF node box + render honor it (flow-mapping).
      ...(box.laneW && !n.size ? { laneW: box.laneW } : {}),
      ...(n.scale !== undefined ? { scale: n.scale } : {}),
      ...(n.z !== undefined ? { z: n.z } : {}),
      // Auto z for a wrapping box (behind its children) — a RENDER default only,
      // kept OFF `z` so it never serializes back as an explicit z. Explicit `z`
      // above still wins at render time (see flow-mapping zIndex resolution).
      ...(n.z === undefined && boxZ.has(n.id) ? { autoZ: boxZ.get(n.id)! } : {}),
      ...(n.group !== undefined ? { groupId: n.group } : {}),
      ...(n.label !== undefined ? { label: n.label } : {}),
      ...(n.ai_reasoning !== undefined ? { ai_reasoning: n.ai_reasoning } : {}),
      ...(n.desc !== undefined ? { desc: n.desc } : {}),
      ...(n.showDesc !== undefined ? { showDesc: n.showDesc } : {}),
      ...(n.icon !== undefined ? { icon: n.icon } : {}),
      ...(st.opacity !== undefined ? { opacity: st.opacity } : {}),
      ...(st.fill !== undefined ? { fillColor: st.fill } : {}),
      ...(st.font !== undefined ? { fontColor: st.font } : {}),
      ...(st.icon !== undefined ? { iconColor: st.icon } : {}),
      ...(st.border !== undefined ? { borderWidth: st.border } : {}),
      ...(st.borderStyle !== undefined ? { borderStyle: st.borderStyle } : {}),
      ...(st.borderColor !== undefined ? { borderColor: st.borderColor } : {}),
      ...(st.radius !== undefined ? { borderRadius: st.radius } : {}),
      ...(st.shadow !== undefined ? { shadow: st.shadow } : {}),
    };

    if (ANNOTATION_TYPES.has(n.type as AnnotationVariant)) {
      // Free-form annotation node (box/text/logo/image).
      pos.annotation = {
        variant: n.type as AnnotationVariant,
        ...(n.text !== undefined ? { text: n.text } : {}),
        ...(n.title !== undefined ? { title: n.title } : {}),
        ...(n.titleIcon !== undefined ? { titleIcon: n.titleIcon } : {}),
        ...(n.fontSize !== undefined ? { fontSize: n.fontSize } : {}),
        ...(n.bold !== undefined ? { bold: n.bold } : {}),
        ...(n.vAlign !== undefined ? { vAlign: n.vAlign } : {}),
        ...(n.hAlign !== undefined ? { hAlign: n.hAlign } : {}),
        ...(n.sized !== undefined ? { sized: n.sized } : {}),
        ...(n.textWrap !== undefined ? { textWrap: n.textWrap } : {}),
        ...(n.icon !== undefined ? { icon: n.icon } : {}),
        ...(n.caption !== undefined ? { caption: n.caption } : {}),
        ...(n.desc !== undefined ? { desc: n.desc } : {}),
        ...(n.showDesc !== undefined ? { showDesc: n.showDesc } : {}),
        ...(n.src !== undefined ? { src: n.src } : {}),
      };
    } else if (n.type === "source") {
      // A data source: carry its logo key + icon so flow-mapping renders it via
      // the canvas-added-source path. The Lakeflow ingest port it feeds is set
      // by the edge handle (`@in-zerobus` / `@in-direct` / `@in-lakeflow-connect`).
      const key = (n.icon ?? "").replace(/^file:.*\//, "").replace(/^file:/, "").toLowerCase() || baseId(n.id).replace(/^src-/, "");
      pos.source = { key, icon: (n.icon ?? "inputData") as IconKey };
      if (n.label !== undefined) pos.label = n.label;
      // Source label placement (right default | left | top | bottom). Reuse the
      // shared FileNode `caption`; ignore the legacy logo values (side/below).
      if (n.caption === "right" || n.caption === "left" || n.caption === "top" || n.caption === "bottom") {
        pos.sourceCaption = n.caption;
      }
      // Source label size (reuse the shared FileNode `fontSize`).
      if (n.fontSize !== undefined) pos.fontSize = n.fontSize;
    }
    // The id is kept VERBATIM — a node's component identity comes from `pos.type`
    // (flow-mapping resolves the catalog by `type`), so `id` is a free-form
    // instance handle and need NOT equal `type`. Duplicate ids are the only thing
    // we fix up: a genuine collision (two nodes sharing an id) would clobber the
    // earlier node and re-target its edges to the survivor, so disambiguate with a
    // `#N` suffix. `fileToNode` records any such rename so edges + placement refs
    // follow it; for the common case it's an identity mapping.
    let nodeId = n.id;
    if (nodes[nodeId]) {
      const base = baseId(nodeId);
      let k = 2;
      while (nodes[`${base}#${k}`]) k++;
      nodeId = `${base}#${k}`;
    }
    nodes[nodeId] = pos;
    fileToNode.set(n.id, nodeId);
    boxOf.set(n.id, box);
  }

  // Remap placement references through `fileToNode`, so a node whose id got
  // disambiguated on a collision has its CONTAINER + RELATIONAL refs follow the
  // rename (identity in the common case). Without this, a `wraps`/`below`/`pin.to`
  // that named the pre-rename id would dangle — the exact bug that broke boxes
  // when ids were re-keyed. Runs after the node loop so `fileToNode` is complete.
  const remapRef = (r: string | undefined) => (r === undefined ? r : (fileToNode.get(r) ?? r));
  for (const pos of Object.values(nodes)) {
    const p = pos.placement;
    if (!p) continue;
    if (p.wraps) p.wraps = p.wraps.map((w) => remapRef(w)!);
    for (const k of ["below", "above", "leftOf", "rightOf", "alignX", "alignY"] as const) {
      if (p[k] !== undefined) p[k] = remapRef(p[k]);
    }
    if (p.pin?.to !== undefined) p.pin = { ...p.pin, to: remapRef(p.pin.to) };
    if (p.bounds) {
      // Each side is "<id>:<anchor>" | "col:<name>:<anchor>" | "wrap" — only the
      // "<id>:<anchor>" form carries a node id to remap (col:/wrap have no id).
      const remapSide = (v: string | undefined) => {
        if (v === undefined || v === "wrap" || v.startsWith("col:")) return v;
        const i = v.indexOf(":");
        if (i === -1) return remapRef(v);
        return `${remapRef(v.slice(0, i))}:${v.slice(i + 1)}`;
      };
      p.bounds = {
        ...(p.bounds.left !== undefined ? { left: remapSide(p.bounds.left) } : {}),
        ...(p.bounds.right !== undefined ? { right: remapSide(p.bounds.right) } : {}),
        ...(p.bounds.top !== undefined ? { top: remapSide(p.bounds.top) } : {}),
        ...(p.bounds.bottom !== undefined ? { bottom: remapSide(p.bounds.bottom) } : {}),
      };
    }
  }

  // Edge-handle inference: when `from`/`to` carry no explicit `@handle`, derive
  // it from geometry. To target a specific Lakeflow ingest PORT, the edge must
  // name it explicitly (`@in-lakeflow-connect` / `@in-zerobus` / `@in-direct`) —
  // there is no source-ingest-based port inference.
  const inferHandles = (sId: string, tId: string): { sh?: string; th?: string } => {
    const sb = boxOf.get(sId), tb = boxOf.get(tId);
    if (!sb || !tb) return {};
    const dx = tb.x - sb.x, dy = tb.y - sb.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? { sh: "r", th: "l" } : { sh: "l", th: "r" };
    }
    return dy >= 0 ? { sh: "b", th: "t" } : { sh: "t", th: "b" };
  };

  // A GOVERNANCE tile (Unity Catalog / the governance bar) governs — it doesn't
  // exchange data — so an edge touching one defaults to a plain DASHED line with
  // NO flow animation, unless the author set `flow`/`dashed` explicitly.
  const GOVERNS_TYPES = new Set(["governance-block", "unity-catalog"]);
  const isGovEndpoint = (fileId: string) => {
    const nid = fileToNode.get(fileId) ?? fileId;
    return GOVERNS_TYPES.has(nodes[nid]?.type ?? "");
  };
  const edges: PlatformEdge[] = (file?.edges ?? []).map((e, i) => {
    const s = splitHandle(e.from);
    const t = splitHandle(e.to);
    const inf = (!s.handle || !t.handle) ? inferHandles(s.id, t.id) : {};
    const sourceHandle = s.handle ?? inf.sh;
    const targetHandle = t.handle ?? inf.th;
    const touchesGov = isGovEndpoint(s.id) || isGovEndpoint(t.id);
    // A GOVERNANCE line governs — it doesn't flow data — so it's a plain DASHED
    // line with NO flow animation + an arrowHEAD at the end (governs → the thing).
    // Force dashed/no-flow for any edge touching a governance tile (an explicit
    // `dashed:false` can still un-dash it, but flow stays off); default the arrow
    // to "end" unless the author set one explicitly.
    const animated = touchesGov ? false : !!e.flow;
    const dashed = e.dashed !== undefined ? !!e.dashed : touchesGov;
    const arrow = e.arrow && e.arrow !== "auto" ? e.arrow : (touchesGov ? "end" : undefined);
    return {
      id: e.id ?? `e-${s.id}-${t.id}-${i}`,
      source: fileToNode.get(s.id) ?? s.id,
      target: fileToNode.get(t.id) ?? t.id,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      animated,
      ...(dashed ? { dashed: true } : {}),
      ...(e.shape ? { shape: e.shape } : {}),
      ...(e.flowStyle ? { flowStyle: e.flowStyle } : {}),
      ...(arrow ? { arrow } : {}),
      ...(typeof e.centerX === "number" ? { centerX: e.centerX } : {}),
      ...(e.label ? { label: e.label } : {}),
      ...(e.ai_reasoning ? { ai_reasoning: e.ai_reasoning } : {}),
    };
  });

  const customLogos: Record<string, string> = {};
  for (const c of file?.custom_logos ?? []) {
    if (c?.id && typeof c.svg === "string") customLogos[c.id] = c.svg;
  }

  return {
    name: file?.name ?? "Solution architecture",
    story: file?.story,
    enableTrademarkLogos: file?.options?.trademarkLogos ?? defaultLogosOn,
    ...(file?.columns?.length ? { columns: file.columns } : {}),
    ...(file?.rowGrid ? { rowGrid: true } : {}),
    bands: catalogSchemaBands(),
    layout: { nodes, edges, hidden: [] },
    ...(Object.keys(customLogos).length ? { customLogos } : {}),
  };
}

/** The raw global catalog as bands — every component with its CATALOG label /
 *  icon / desc, with NO per-project overrides merged in. The library palette
 *  (left menu) renders from this so it always shows the canonical component
 *  set, not a demo's story-tied relabels (e.g. a demo renaming Genie Agent must
 *  not change what the palette calls it). `state` is omitted — the palette only
 *  needs id/label/icon/desc. */
export function catalogBands(): { id: BandId; label: string; sublabel?: string; components: CatalogComponent[] }[] {
  return BAND_ORDER.map((bandId) => ({
    id: bandId,
    label: BAND_META[bandId].label,
    sublabel: BAND_META[bandId].sublabel,
    components: [...CATALOG[bandId]],
  }));
}

// =============================================================================
// Node id helper
// =============================================================================

/** A canvas node id is `<componentId>` or, for an extra placement of the same
 *  component, `<componentId>#2`, `#3`, … `baseId` recovers the catalog
 *  component id from any node/layout/edge id. */
export function baseId(nodeId: string): string {
  const h = nodeId.indexOf("#");
  return h === -1 ? nodeId : nodeId.slice(0, h);
}

/** Inline custom-logo icon keys: `custom:<id>` → renders `customLogos[id]`. */
export function isCustomIconKey(key: string | undefined): key is string {
  return typeof key === "string" && key.startsWith("custom:");
}
export function customLogoId(key: string): string {
  return key.slice("custom:".length);
}

// =============================================================================
// Parse — pull the flat ArchitectureFile JSON out of architecture.md
// =============================================================================

/** Extract the flat file JSON from architecture.md (fenced ```json block or a
 *  bare top-level object). Returns null if absent/unparseable — the caller
 *  then renders an empty canvas. (`parseArchitecture` wraps this into a
 *  PlatformSchema.) */
export function parseArchitectureFile(content: string): ArchitectureFile | null {
  try {
    const block = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    const raw = block ? block[1].trim() : content.trim();
    if (!raw.startsWith("{")) return null;
    return JSON.parse(raw) as ArchitectureFile;
  } catch {
    return null;
  }
}

// =============================================================================
// Multi-tab — the top-level file is an ARRAY of architectures (one per tab).
// This layer sits ABOVE the single-architecture parse/serialize: it splits the
// array into per-tab bodies (each a bare JSON object the existing
// parseArchitecture consumes) and joins them back into one fenced array.
// =============================================================================

/** One tab: a display `name` + `body` — the single-architecture JSON string
 *  (fenced, exactly what serializeArchitecture emits) that the existing
 *  parse/serialize pipeline round-trips. */
export interface ArchitectureTab {
  name: string;
  body: string;
}

/** Extract the raw top-level value (array OR single object) from architecture.md
 *  — unwrapping the ```json fence when present. Returns the parsed JS value, or
 *  null if absent/unparseable. */
function parseTopLevel(content: string): unknown {
  try {
    const block = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    const raw = (block ? block[1] : content).trim();
    if (!raw.startsWith("[") && !raw.startsWith("{")) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Detect the LEGACY architecture format (the pre-flat-file schema, replaced by
 *  the interactive editor). The old format nested nodes INSIDE column objects
 *  (`columns: [{ nodes: [...], bars: [...] }, …]`) and had no top-level `nodes`;
 *  the new flat format has `columns` as a list of lane-name STRINGS plus a
 *  top-level `nodes` array. So a file is legacy iff any tab's `columns` holds
 *  OBJECTS rather than strings (with a secondary tell: no top-level `nodes`).
 *  Returns false for empty/unparseable/new-format content — we only flag a file
 *  we're confident is the old shape. */
export function isLegacyArchitectureFormat(content: string): boolean {
  const top = parseTopLevel(content ?? "");
  if (top == null) return false;
  const objs: unknown[] = Array.isArray(top) ? top : [top];
  return objs.some((o) => {
    if (!o || typeof o !== "object") return false;
    const rec = o as { columns?: unknown; nodes?: unknown };
    // New format: columns is string[] AND nodes is a top-level array.
    const cols = rec.columns;
    const legacyColumns =
      Array.isArray(cols) && cols.length > 0 && typeof cols[0] === "object" && cols[0] !== null;
    const missingFlatNodes = !Array.isArray(rec.nodes);
    // Only OBJECT columns is a hard tell; missing flat nodes alone could be a
    // blank/partial file, so require the column shape.
    return legacyColumns && missingFlatNodes;
  });
}

// =============================================================================
// Validate — a pure integrity check over the flat file. Catches the class of
// SILENT-WRONG mistakes computeLayout tolerates (it just skips a bad ref rather
// than erroring): dangling id references, unknown component types, bad edge
// endpoints/handles, duplicate ids. The UI surfaces the results and can hand a
// formatted report to the chat agent to fix. NEVER throws — returns [] on an
// unparseable/empty file (that's the parser's problem, not a diagram error).
// =============================================================================

/** One diagnostic from validateArchitecture. `tab` is the tab NAME (for the
 *  agent report + jump-to); `nodeId`/`edgeId` locate the offending element;
 *  `field` names the offending property; `message` is human-readable. */
export interface ArchitectureIssue {
  tab: string;
  /** The node the problem is ON (for jump-to). Absent for edge-only issues. */
  nodeId?: string;
  edgeId?: string;
  /** The property at fault, e.g. "wraps", "from", "type", "col". */
  field?: string;
  message: string;
}

/** Canonical geometric edge-handle sides (any node exposes these). Port handles
 *  beyond these must be declared in the target component's catalog `ports`. */
const SIDE_HANDLES = new Set(["l", "r", "t", "b"]);

/** Is `type` a thing we can actually render? A catalog id, an annotation variant
 *  (text/box/logo/image/note), or the built-in "source" tile. */
function isKnownNodeType(type: string): boolean {
  return (
    CATALOG_BY_ID.has(type) ||
    ANNOTATION_TYPES.has(type as AnnotationVariant) ||
    type === "source"
  );
}

/** Validate ONE tab's flat file. Pushes issues (tagged with `tabName`) into
 *  `out`. Pure — reads only the file + the static catalog. */
function validateArchitectureFileInto(
  file: ArchitectureFile,
  tabName: string,
  out: ArchitectureIssue[],
): void {
  const nodes = Array.isArray(file.nodes) ? file.nodes : [];
  const edges = Array.isArray(file.edges) ? file.edges : [];
  const columns = Array.isArray(file.columns) ? file.columns : [];
  const columnSet = new Set(columns);

  // Every id that names a placeable element on THIS tab.
  const ids = new Set<string>();
  const nodeById = new Map<string, FileNode>();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || !n.id) {
      out.push({ tab: tabName, field: "id", message: `A node is missing an \`id\`.` });
      continue;
    }
    if (ids.has(n.id)) {
      out.push({ tab: tabName, nodeId: n.id, field: "id", message: `Duplicate node id \`${n.id}\` — ids must be unique within a tab.` });
    }
    ids.add(n.id);
    nodeById.set(n.id, n);
  }

  // A ref may carry a `#instance` suffix (a 2nd copy of a catalog tile) or an
  // `@handle` (edges). Resolve to the base node id present on the tab.
  const refExists = (ref: string): boolean => {
    if (ids.has(ref)) return true;
    const base = baseId(ref);
    return ids.has(base);
  };

  // ---- per-node checks -----------------------------------------------------
  for (const n of nodes) {
    if (!n?.id) continue;
    const type = n.type ?? baseId(n.id);

    // Unknown component type — computeLayout would render an "Unknown component"
    // placeholder (the exact symptom we've hit with a typo'd type).
    if (type && type !== "box" && !isKnownNodeType(type)) {
      out.push({ tab: tabName, nodeId: n.id, field: "type", message: `Node \`${n.id}\` has unknown type \`${type}\` — not a catalog component, annotation, or "source".` });
    }

    // Column reference must be a declared lane.
    if (n.col && columns.length && !columnSet.has(n.col)) {
      out.push({ tab: tabName, nodeId: n.id, field: "col", message: `Node \`${n.id}\` references column \`${n.col}\` which isn't in \`columns\` [${columns.join(", ")}].` });
    }

    // Relational anchors + box refs — each must point at an existing node.
    const REL: (keyof FileNode)[] = ["alignX", "alignY", "below", "above", "leftOf", "rightOf"];
    for (const f of REL) {
      const ref = n[f];
      if (typeof ref === "string" && ref && !refExists(ref)) {
        out.push({ tab: tabName, nodeId: n.id, field: f as string, message: `Node \`${n.id}\` \`${f}\` points at \`${ref}\`, which is not a node on this tab.` });
      }
    }

    // wraps: every child must exist (this is the bug that started all this).
    if (Array.isArray(n.wraps)) {
      for (const w of n.wraps) {
        if (typeof w !== "string" || !refExists(w)) {
          out.push({ tab: tabName, nodeId: n.id, field: "wraps", message: `Box \`${n.id}\` wraps \`${w}\`, which is not a node on this tab.` });
        }
      }
      if (type !== "box") {
        out.push({ tab: tabName, nodeId: n.id, field: "wraps", message: `Node \`${n.id}\` has \`wraps\` but is type \`${type}\` — only \`type:"box"\` nodes wrap children.` });
      }
    }

    // pin.to / bounds.<side> reference a box/node/column midpoint.
    if (n.pin?.to && !refExists(n.pin.to)) {
      out.push({ tab: tabName, nodeId: n.id, field: "pin.to", message: `Node \`${n.id}\` pins to \`${n.pin.to}\`, which is not a node on this tab.` });
    }
    if (n.bounds) {
      for (const [side, spec] of Object.entries(n.bounds)) {
        if (typeof spec !== "string" || !spec) continue;
        if (spec === "wrap") continue;
        // "<nodeId>:<anchor>" or "col:<name>:<anchor>".
        const parts = spec.split(":");
        const target = parts[0] === "col" ? null : parts[0];
        const colName = parts[0] === "col" ? parts[1] : null;
        if (target && !refExists(target)) {
          out.push({ tab: tabName, nodeId: n.id, field: `bounds.${side}`, message: `Box \`${n.id}\` bounds.${side} references node \`${target}\`, which is not on this tab.` });
        }
        if (colName && columns.length && !columnSet.has(colName)) {
          out.push({ tab: tabName, nodeId: n.id, field: `bounds.${side}`, message: `Box \`${n.id}\` bounds.${side} references column \`${colName}\`, not in \`columns\`.` });
        }
      }
    }
  }

  // ---- per-edge checks -----------------------------------------------------
  edges.forEach((e, i) => {
    const eid = e?.id ?? `edge #${i + 1}`;
    if (!e || typeof e.from !== "string" || typeof e.to !== "string" || !e.from || !e.to) {
      out.push({ tab: tabName, edgeId: eid, field: "from/to", message: `Edge \`${eid}\` is missing a \`from\` or \`to\`.` });
      return;
    }
    for (const end of ["from", "to"] as const) {
      const { id, handle } = splitHandle(e[end]);
      if (!refExists(id)) {
        out.push({ tab: tabName, edgeId: eid, field: end, message: `Edge \`${eid}\` \`${end}\` targets \`${id}\`, which is not a node on this tab.` });
        continue;
      }
      // Handle: a geometric side (l/r/t/b) or a port the node's catalog declares.
      if (handle && !SIDE_HANDLES.has(handle)) {
        const target = nodeById.get(id) ?? nodeById.get(baseId(id));
        const type = target ? (target.type ?? baseId(target.id)) : undefined;
        const ports = type ? CATALOG_BY_ID.get(type)?.c.ports : undefined;
        if (!ports || !(handle in ports)) {
          const known = ports ? Object.keys(ports).join(", ") : "(none)";
          out.push({ tab: tabName, edgeId: eid, field: end, message: `Edge \`${eid}\` ${end} handle \`@${handle}\` isn't a valid side (l/r/t/b) or a port of \`${id}\` (ports: ${known}).` });
        }
      }
    }
  });
}

/** Validate architecture.md (any number of tabs). Returns every integrity issue
 *  across all tabs, or [] when the file is clean / empty / unparseable. Pure. */
export function validateArchitecture(content: string): ArchitectureIssue[] {
  const top = parseTopLevel(content ?? "");
  if (top == null) return [];
  const objs: ArchitectureFile[] = Array.isArray(top)
    ? (top as ArchitectureFile[])
    : typeof top === "object"
      ? [top as ArchitectureFile]
      : [];
  const out: ArchitectureIssue[] = [];
  objs.forEach((obj, i) => {
    if (!obj || typeof obj !== "object") return;
    const name = (typeof obj.name === "string" && obj.name.trim()) || `Architecture ${i + 1}`;
    validateArchitectureFileInto(obj, name, out);
  });
  return out;
}

/** Split architecture.md into tabs. A top-level ARRAY → one tab per element; a
 *  single OBJECT → one tab (auto-wrap, so existing single-architecture files
 *  keep working). Each tab's `body` is that element re-stringified as a fenced
 *  ```json object, so it feeds straight into parseArchitecture. Empty/absent →
 *  a single blank tab so there's always at least one. */
export function parseArchitectureTabs(content: string): ArchitectureTab[] {
  const top = parseTopLevel(content ?? "");
  const objs: ArchitectureFile[] = Array.isArray(top)
    ? (top as ArchitectureFile[])
    : top && typeof top === "object"
      ? [top as ArchitectureFile]
      : [];
  if (objs.length === 0) return [{ name: "Architecture", body: "" }];
  return objs.map((obj, i) => ({
    name: (typeof obj?.name === "string" && obj.name.trim()) || `Architecture ${i + 1}`,
    body: "```json\n" + JSON.stringify(obj, null, 2) + "\n```\n",
  }));
}

/** Join per-tab bodies (each the fenced ```json a tab's serializeArchitecture
 *  produced) into ONE fenced ```json ARRAY — the on-disk multi-tab format. */
export function serializeArchitectureTabs(bodies: string[]): string {
  const objs = bodies.map((b) => parseArchitectureFile(b) ?? {});
  return "```json\n" + JSON.stringify(objs, null, 2) + "\n```\n";
}

// =============================================================================
// Serialize — write the editor's live layout back into the flat file format
// =============================================================================

/** Map a NodePosition's optional visual overrides into the flat `style` object
 *  (only the keys that are actually set). */
function styleOf(pos: NodePosition): FileNode["style"] | undefined {
  const s: NonNullable<FileNode["style"]> = {};
  if (pos.borderWidth !== undefined) s.border = pos.borderWidth;
  if (pos.borderStyle !== undefined) s.borderStyle = pos.borderStyle;
  if (pos.borderColor !== undefined) s.borderColor = pos.borderColor;
  if (pos.borderRadius !== undefined) s.radius = pos.borderRadius;
  if (pos.shadow !== undefined) s.shadow = pos.shadow;
  if (pos.fillColor !== undefined) s.fill = pos.fillColor;
  if (pos.fontColor !== undefined) s.font = pos.fontColor;
  if (pos.iconColor !== undefined) s.icon = pos.iconColor;
  if (pos.opacity !== undefined) s.opacity = pos.opacity;
  return Object.keys(s).length ? s : undefined;
}

/** Build the architecture.md string from the live layout. Walks layout.nodes
 *  (the source of truth for what's placed) → flat `nodes`, and layout.edges →
 *  compact `from`/`to@handle` edges. Only emits overrides that differ from the
 *  catalog default. The `schema` carries name/story/trademark + the catalog. */
export function serializeArchitecture(
  schema: PlatformSchema,
  layout: PlatformLayout,
): string {
  const nodes: FileNode[] = [];
  for (const [id, pos] of Object.entries(layout.nodes)) {
    // Positional fragment: a node the user never moved (un-`pinned`) with symbolic
    // `placement` re-emits those authored fields so the file keeps its structure;
    // anything pinned (dragged, or authored with `at`) serializes as pixel `at`.
    const at: [number, number] = [Math.round(pos.x), Math.round(pos.y)];
    const pl = pos.placement;
    const symbolic = !pos.pinned && !!pl;
    // A symbolic container (box with `wraps`/`bounds`) is NOT `pinned`; it re-emits
    // its container fields and computeLayout re-derives its size — so we must NOT
    // also emit a frozen `size` for it (that would stop it reflowing).
    const isSymbolicBox = symbolic && !!(pl!.wraps?.length || pl!.bounds);
    const place: Partial<FileNode> =
      symbolic
        ? {
            ...(pl!.col !== undefined ? { col: pl!.col } : {}),
            ...(pl!.row !== undefined ? { row: pl!.row } : {}),
            ...(pl!.alignX !== undefined ? { alignX: pl!.alignX } : {}),
            ...(pl!.alignY !== undefined ? { alignY: pl!.alignY } : {}),
            ...(pl!.below !== undefined ? { below: pl!.below } : {}),
            ...(pl!.above !== undefined ? { above: pl!.above } : {}),
            ...(pl!.leftOf !== undefined ? { leftOf: pl!.leftOf } : {}),
            ...(pl!.rightOf !== undefined ? { rightOf: pl!.rightOf } : {}),
            ...(pl!.gap !== undefined ? { gap: pl!.gap } : {}),
            ...(pl!.wraps !== undefined ? { wraps: pl!.wraps } : {}),
            ...(pl!.pad !== undefined ? { pad: pl!.pad } : {}),
            ...(pl!.bounds !== undefined ? { bounds: pl!.bounds } : {}),
            ...(pl!.pin !== undefined ? { pin: pl!.pin } : {}),
          }
        : { at };
    const common: Partial<FileNode> = {
      ...(pos.w !== undefined && pos.h !== undefined && !isSymbolicBox ? { size: [pos.w, pos.h] as [number, number] } : {}),
      ...(pos.rot ? { rot: pos.rot } : {}),
      ...(pos.scale !== undefined && pos.scale !== 1 ? { scale: pos.scale } : {}),
      ...(pos.z ? { z: pos.z } : {}),
      ...(pos.groupId ? { group: pos.groupId } : {}),
      ...(pos.params && Object.keys(pos.params).length ? { params: pos.params } : {}),
      ...(sanitizeStack(pos.stack) ? { stack: sanitizeStack(pos.stack)! } : {}),
      ...(pos.ai_reasoning ? { ai_reasoning: pos.ai_reasoning } : {}),
    };
    const style = styleOf(pos);

    if (pos.annotation) {
      const a = pos.annotation;
      nodes.push({
        id, type: a.variant, ...place, ...common,
        ...(a.text !== undefined ? { text: a.text } : {}),
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.titleIcon !== undefined ? { titleIcon: a.titleIcon as IconKey } : {}),
        ...(a.fontSize !== undefined ? { fontSize: a.fontSize } : {}),
        ...(a.bold !== undefined ? { bold: a.bold } : {}),
        ...(a.vAlign !== undefined ? { vAlign: a.vAlign } : {}),
        ...(a.hAlign !== undefined ? { hAlign: a.hAlign } : {}),
        ...(a.sized !== undefined ? { sized: a.sized } : {}),
        ...(a.textWrap !== undefined ? { textWrap: a.textWrap } : {}),
        ...(a.icon !== undefined ? { icon: a.icon } : {}),
        ...(a.caption !== undefined ? { caption: a.caption } : {}),
        ...(a.desc !== undefined ? { desc: a.desc } : {}),
        ...(a.showDesc !== undefined ? { showDesc: a.showDesc } : {}),
        ...(a.src !== undefined ? { src: a.src } : {}),
        ...(style ? { style } : {}),
      });
      continue;
    }
    if (pos.source) {
      nodes.push({
        id, type: "source", ...place, ...common,
        // label: `undefined` → OMIT (stays auto-derived on reload); `""` →
        // EMIT (user deliberately cleared it → renders nothing).
        ...(pos.label !== undefined ? { label: pos.label } : {}),
        icon: (pos.icon ?? pos.source.icon) as IconKey,
        ...(pos.sourceCaption !== undefined ? { caption: pos.sourceCaption } : {}),
        ...(pos.fontSize !== undefined ? { fontSize: pos.fontSize } : {}),
        ...(pos.desc !== undefined ? { desc: pos.desc } : {}),
        ...(pos.showDesc !== undefined ? { showDesc: pos.showDesc } : {}),
        ...(style ? { style } : {}),
      });
      continue;
    }
    // Catalog component: `type` is the persisted component identity (NOT derived
    // from the id — the id is a free-form instance handle). Emit label/desc/icon
    // only when they differ from the catalog default.
    const type = pos.type ?? baseId(id);
    const def = CATALOG_BY_ID.get(type)?.c;
    nodes.push({
      id, type, ...place, ...common,
      ...(pos.label !== undefined && pos.label !== def?.label ? { label: pos.label } : {}),
      ...(pos.desc !== undefined && pos.desc !== def?.desc ? { desc: pos.desc } : {}),
      ...(pos.showDesc !== undefined ? { showDesc: pos.showDesc } : {}),
      ...(pos.icon !== undefined && pos.icon !== def?.icon ? { icon: pos.icon } : {}),
      ...(style ? { style } : {}),
    });
  }

  const edges: FileEdge[] = layout.edges.map((e) => {
    const from = e.sourceHandle ? `${e.source}@${e.sourceHandle}` : e.source;
    const to = e.targetHandle ? `${e.target}@${e.targetHandle}` : e.target;
    return {
      id: e.id, from, to,
      ...(e.animated ? { flow: true } : {}),
      ...(e.arrow && e.arrow !== "auto" ? { arrow: e.arrow } : {}),
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.shape && e.shape !== "smooth" ? { shape: e.shape } : {}),
      ...(e.flowStyle ? { flowStyle: e.flowStyle } : {}),
      ...(typeof e.centerX === "number" ? { centerX: e.centerX } : {}),
      ...(e.label ? { label: e.label } : {}),
      ...(e.ai_reasoning ? { ai_reasoning: e.ai_reasoning } : {}),
    };
  });

  // Round-trip custom logos: keep every `custom:<id>` an emitted node references.
  const usedCustom = new Set<string>();
  for (const n of nodes) {
    if (isCustomIconKey(n.icon)) usedCustom.add(customLogoId(n.icon));
  }
  const custom_logos = [...usedCustom]
    .map((id) => ({ id, svg: schema.customLogos?.[id] }))
    .filter((c): c is { id: string; svg: string } => typeof c.svg === "string");

  const out: ArchitectureFile = {
    name: schema.name,
    ...(schema.story ? { story: schema.story } : {}),
    ...(schema.enableTrademarkLogos ? { options: { trademarkLogos: true } } : {}),
    // Re-emit the lane declaration: symbolic `col` refs on un-pinned nodes are
    // meaningless without it, so dropping it (as the old serializer did) made a
    // single drag collapse every remaining symbolic node to the origin.
    ...(schema.columns?.length ? { columns: schema.columns } : {}),
    // Re-emit the shared-row-grid opt-in so `row`'s cross-column meaning survives
    // a save (same round-trip reason as `columns`).
    ...(schema.rowGrid ? { rowGrid: true } : {}),
    ...(custom_logos.length ? { custom_logos } : {}),
    nodes,
    edges,
  };
  return "```json\n" + JSON.stringify(out, null, 2) + "\n```\n";
}

// =============================================================================
// Deployed-resource deep-link resolution
// =============================================================================

/** Resolve the live workspace URL for a component, if its backing resource
 *  has been deployed. Mirrors the Summary tab's capability→deployed_type join
 *  (CAPABILITY_META.deployed_type vs DeployedResourceLink.resource_type). */
export function resolveDeepLink(
  component: PlatformComponent,
  deployed: DeployedResourceLink[] | undefined,
): string | null {
  if (!deployed?.length) return null;
  const slug = component.capability ?? component.id;
  const meta = CAPABILITY_META[slug];
  if (!meta?.deployed_type) return null;
  const types = Array.isArray(meta.deployed_type) ? meta.deployed_type : [meta.deployed_type];
  for (const t of types) {
    const hit = deployed.find((d) => d.resource_type === t && d.url);
    if (hit?.url) return hit.url;
  }
  return null;
}
