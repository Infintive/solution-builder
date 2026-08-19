/**
 * platform-diagram/fan-layout — the edge fan-out geometry, computed for ALL
 * edges AT ONCE (O(E)) and cached, instead of per-edge (which was O(E²) per
 * store tick during a drag: every FlowEdge's useStore selector re-scanned the
 * whole edge list + both-endpoint rects).
 *
 * `computeFanLayout(edges, nodeLookup)` returns a Map<edgeId, FanEntry>. It's
 * memoized on a cheap signature of the inputs (edge endpoints + each node's
 * position/size), so the E FlowEdge selectors that call it within one store
 * tick share ONE computation + E O(1) lookups. Pure — no React, no ReactFlow
 * context; it only reads the plain rect/side helpers from edge-routing.
 */
import {
  type Side,
  type Rect,
  type HandleBound,
  sidePoint,
  spreadFrac,
  endSide,
  rectOf,
  anchorFromBounds,
} from "./edge-routing";
import { portAnchor } from "./composite-lakeflow";

/** A named port anchor for an edge end: prefer ReactFlow's MEASURED handle
 *  bounds (ground truth — works for ANY composite's custom handles with zero
 *  per-handle config), fall back to the hand-tuned `portAnchor` table. Only
 *  consulted for non-plain-side handles (a `t/r/b/l` handle keeps the fan). */
function resolvePort(
  bounds: HandleBound[] | null | undefined,
  handleId: string | null | undefined,
  w: number,
  h: number,
): { side: Side; frac: number } | null {
  if (handleId && ["t", "r", "b", "l"].includes(handleId)) return null;
  return anchorFromBounds(bounds, handleId, w, h) ?? portAnchor(handleId);
}

export interface FanEntry {
  sSide: Side;
  tSide: Side;
  sFrac: number;
  tFrac: number;
  centerX: number | undefined;
}

/** Minimal shape of a ReactFlow edge we read (source/target + handles). */
interface FanEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
/** Minimal shape of ReactFlow's internal node (from `s.nodeLookup`). */
interface FanNode {
  internals: {
    positionAbsolute: { x: number; y: number };
    handleBounds?: { source?: HandleBound[] | null; target?: HandleBound[] | null } | null;
  };
  measured: { width?: number; height?: number };
}
type NodeLookup = Map<string, FanNode>;

// --- 1-deep memo cache -----------------------------------------------------
// The layout depends only on (edge endpoints/handles) + (each node's rect).
// During a drag, `edges` keeps the same array ref but node positions change,
// so we key on a signature that folds in both. Computing the signature is O(E)
// + O(N); the heavy grouping/sort work then runs once and is reused by every
// edge in the same tick.
let cacheSig = "";
let cacheMap: Map<string, FanEntry> = new Map();

function signature(edges: FanEdge[], nodeLookup: NodeLookup): string {
  let s = "";
  for (const e of edges) {
    s += `${e.id}:${e.source}>${e.target}:${e.sourceHandle ?? ""}/${e.targetHandle ?? ""};`;
  }
  s += "|";
  // Only the nodes that participate in an edge affect the layout.
  const seen = new Set<string>();
  for (const e of edges) {
    for (const nid of [e.source, e.target]) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const n = nodeLookup.get(nid);
      if (!n) continue;
      const p = n.internals.positionAbsolute;
      s += `${nid}:${Math.round(p.x)},${Math.round(p.y)},${n.measured.width ?? 0}x${n.measured.height ?? 0}`;
      // Fold in the source-handle bounds (id@y) so a re-measure of custom ports
      // — e.g. after toggling a fork option — busts the cache even if the node
      // rect is unchanged. Cheap: a handful of handles per node.
      const hb = n.internals.handleBounds?.source;
      if (hb) for (const h of hb) s += `~${h.id}@${Math.round(h.y)}`;
      s += ";";
    }
  }
  return s;
}

/** Compute (or return cached) fan entries for every edge. */
export function computeFanLayout(edges: FanEdge[], nodeLookup: NodeLookup): Map<string, FanEntry> {
  // NOTE: we intentionally do NOT short-circuit on input IDENTITY
  // (edges===last && nodeLookup===last). In @xyflow/react v12 the store's
  // `nodeLookup` Map is created ONCE and mutated in place (adoptUserNodes clears
  // + repopulates the same Map), and `edges` keeps its reference across a whole
  // node drag — so an identity check would be TRUE every tick and freeze the fan
  // geometry mid-drag. The signature (which folds in node positions) is the
  // correct, cheap-enough invalidator; every FlowEdge selector rebuilds the O(E)
  // string per tick but the heavy grouping/sort work is shared via the sig memo.
  const sig = signature(edges, nodeLookup);
  if (sig === cacheSig) return cacheMap;

  const rect = (nid: string): Rect | null => {
    const n = nodeLookup.get(nid);
    return n ? rectOf(n as never) : null;
  };
  // Measured source-handle bounds for a node (ground truth for custom handle
  // positions). Node-local coords; sized by `measured`.
  const boundsOf = (nid: string): HandleBound[] | null =>
    nodeLookup.get(nid)?.internals?.handleBounds?.source ?? null;
  const sizeOf = (nid: string): { w: number; h: number } => {
    const n = nodeLookup.get(nid);
    return { w: n?.measured.width ?? 0, h: n?.measured.height ?? 0 };
  };
  const portOf = (nid: string, handleId: string | null | undefined) => {
    const { w, h } = sizeOf(nid);
    return resolvePort(boundsOf(nid), handleId, w, h);
  };
  const sideForEnd = (e: FanEdge, end: "source" | "target"): Side | null => {
    const selfR = rect(end === "source" ? e.source : e.target);
    const otherR = rect(end === "source" ? e.target : e.source);
    if (!selfR || !otherR) return null;
    const oc = { x: otherR.x + otherR.w / 2, y: otherR.y + otherR.h / 2 };
    return endSide(selfR, end === "source" ? e.sourceHandle : e.targetHandle, oc);
  };

  // Group key = nodeId|side (or nodeId|port). For each edge end, remember the
  // OTHER endpoint's center along the side's perpendicular axis, so sorting a
  // group orders the fan to follow the other tiles' positions (no crossings),
  // and re-sorts live as nodes drag.
  const groups = new Map<string, { id: string; key: number }[]>();
  for (const e of edges) {
    for (const end of ["source", "target"] as const) {
      const side = sideForEnd(e, end);
      if (!side) continue;
      const nid = end === "source" ? e.source : e.target;
      const otherR = rect(end === "source" ? e.target : e.source);
      if (!otherR) continue;
      const sortKey =
        side === "l" || side === "r"
          ? otherR.y + otherR.h / 2
          : otherR.x + otherR.w / 2;
      const handle = end === "source" ? e.sourceHandle : e.targetHandle;
      // A handle counts as a distinct PORT (own group, no side-fan) when it
      // resolves to a fixed anchor (measured bounds or the hand-tuned table).
      const port = portOf(nid, handle) ? handle : null;
      const key = port ? `${nid}|${port}` : `${nid}|${side}`;
      const arr = groups.get(key) ?? [];
      arr.push({ id: e.id, key: sortKey });
      groups.set(key, arr);
    }
  }
  // Pre-sort each group ONCE (was re-sorted per edge lookup before).
  const sortedGroups = new Map<string, { id: string; key: number }[]>();
  for (const [k, arr] of groups) {
    sortedGroups.set(k, arr.slice().sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : 1)));
  }
  const idxIn = (key: string, id: string): { i: number; n: number } => {
    const arr = sortedGroups.get(key) ?? [];
    return { i: arr.findIndex((x) => x.id === id), n: arr.length };
  };

  const portFan = (base: number, i: number, n: number) =>
    n <= 1 ? base : Math.min(0.95, Math.max(0.05, base + (i - (n - 1) / 2) * 0.06));

  const out = new Map<string, FanEntry>();
  // Vertical elbow of each horizontal-run edge: its effective x + Y-extent (+
  // source-anchor Y and target direction), used by the de-overlap pass after the
  // main loop.
  const vertSpans = new Map<string, { y0: number; y1: number; effX: number; sy: number; toTarget: number; hasCenter: boolean }>();
  for (const e of edges) {
    const sR = rect(e.source);
    const tR = rect(e.target);
    if (!sR || !tR) continue;
    const sCtr = { x: sR.x + sR.w / 2, y: sR.y + sR.h / 2 };
    const tCtr = { x: tR.x + tR.w / 2, y: tR.y + tR.h / 2 };
    const ss = endSide(sR, e.sourceHandle, tCtr);
    const ts = endSide(tR, e.targetHandle, sCtr);
    const sPort = portOf(e.source, e.sourceHandle);
    const tPort = portOf(e.target, e.targetHandle);
    const sg = idxIn(sPort ? `${e.source}|${e.sourceHandle}` : `${e.source}|${ss}`, e.id);
    const tg = idxIn(tPort ? `${e.target}|${e.targetHandle}` : `${e.target}|${ts}`, e.id);

    const tEndSide = tPort?.side ?? ts;
    const tFrac = tPort ? portFan(tPort.frac, tg.i < 0 ? 0 : tg.i, tg.n) : spreadFrac(tg.i < 0 ? 0 : tg.i, tg.n);
    let centerX: number | undefined;
    // The source side (as resolved for this edge) — needed to bound the corridor
    // the vertical elbow lives in.
    const sEndSide = sPort?.side ?? ss;
    if (
      tg.n > 1 &&
      (tEndSide === "l" || tEndSide === "r") &&
      (sEndSide === "l" || sEndSide === "r")
    ) {
      // Rank against the connector's FIXED center Y (same reference for every
      // sibling) — NOT this edge's own fanned anchor, which varies per edge and
      // would make two symmetric sources rank identically and collide.
      const connectorY = tPort ? sidePoint(tR, tPort.side, tPort.frac).y : tCtr.y;
      const sibs = sortedGroups.get(tPort ? `${e.target}|${e.targetHandle}` : `${e.target}|${ts}`) ?? [];
      // NESTING RULE — edges from stacked sources converging on ONE target
      // connector must nest like concentric brackets so their vertical elbows
      // never overlap. Rank ALL siblings converging on this connector by DISTANCE
      // from it (nearest = innermost) and give each a distinct X track *inside the
      // actual corridor* between the source exit and the target entry — so the
      // offset ALWAYS fits (no clamp collapse) however narrow the gap, and works
      // for any placement (col/row/at/relational). Every edge gets a UNIQUE track,
      // so no two verticals share an X.
      const ranked = sibs
        .slice()
        // Primary: distance from the connector (nearest = innermost). Tiebreak on
        // signed Y so two EQUIDISTANT sources (one above, one below) still get
        // DISTINCT tracks instead of colliding on the same X.
        .sort((a, b) =>
          Math.abs(a.key - connectorY) - Math.abs(b.key - connectorY) || a.key - b.key,
        );
      const rank = ranked.findIndex((x) => x.id === e.id); // 0 = nearest (innermost)
      const n = ranked.length;
      // Corridor between the source's exit edge and the target's entry edge.
      const srcExitX = sEndSide === "r" ? sR.x + sR.w : sR.x;
      const tgtEntryX = tEndSide === "l" ? tR.x : tR.x + tR.w;
      const MARGIN = 24; // keep elbows off the tile faces + clear of the step stub
      const lo = Math.min(srcExitX, tgtEntryX) + MARGIN;
      const hi = Math.max(srcExitX, tgtEntryX) - MARGIN;
      if (n > 0) {
        // The FARTHER a source is from the connector, the closer its vertical
        // elbow sits to the TARGET (outer bracket) — its long horizontal run
        // wraps AROUND the nearer siblings and its vertical drops in past them,
        // never overlapping. The NEAREST source keeps the shortest, innermost
        // path (elbow toward the source side). `t` = distance to target, (0..1]:
        //   rank 0 (nearest)  → t small  → elbow toward SOURCE
        //   rank n-1 (farthest) → t large → elbow toward TARGET
        const t = (rank + 1) / n;
        const toward = tEndSide === "l" ? 1 : -1; // sign toward the target side
        if (hi > lo) {
          // Enough room: distribute the nested tracks across the real corridor.
          centerX = toward === 1 ? lo + t * (hi - lo) : hi - t * (hi - lo);
        } else {
          // Corridor too narrow (or source overlaps target): fall back to a fixed
          // STEP fan out from the mid-gap so the verticals still never share an X.
          const midX = (srcExitX + tgtEntryX) / 2;
          const STEP = 16;
          centerX = midX + toward * (rank + 1) * STEP;
        }
      }
    }
    out.set(e.id, {
      sSide: sPort?.side ?? ss,
      tSide: tPort?.side ?? ts,
      sFrac: sPort ? portFan(sPort.frac, sg.i < 0 ? 0 : sg.i, sg.n) : spreadFrac(sg.i < 0 ? 0 : sg.i, sg.n),
      tFrac,
      centerX,
    });
    // For any HORIZONTAL-to-HORIZONTAL edge (both ends l/r) record its vertical
    // elbow's EFFECTIVE x (explicit centerX, else the smooth-step default = the
    // midpoint between the two anchor x's) + its Y-extent, so the de-overlap pass
    // can separate even edges that have NO fan centerX of their own.
    if ((sEndSide === "l" || sEndSide === "r") && (tEndSide === "l" || tEndSide === "r")) {
      const sy = sidePoint(sR, sEndSide, out.get(e.id)!.sFrac).y;
      const ty = sidePoint(tR, tEndSide, tFrac).y;
      const sx = sEndSide === "r" ? sR.x + sR.w : sR.x;
      const tx = tEndSide === "l" ? tR.x : tR.x + tR.w;
      vertSpans.set(e.id, {
        y0: Math.min(sy, ty),
        y1: Math.max(sy, ty),
        effX: centerX ?? (sx + tx) / 2,
        sy,        // source-anchor Y (orders which of two colliding verticals is "lower")
        toTarget: Math.sign(tx - sx) || 1, // +1 target is to the right, −1 to the left
        hasCenter: centerX !== undefined,
      });
    }
  }

  // De-overlap pass — two edges leaving/entering stacked anchors on the same
  // side (e.g. the medallion's `@out-gold` above `@out-mv`, both heading up-right
  // to Genie / the dashboard) can land their vertical elbows on the SAME x with
  // overlapping Y and run parallel/on top of each other. Separate them
  // DIRECTIONALLY by source-anchor order: the LOWER anchor's elbow moves TOWARD
  // its target, the HIGHER anchor's moves AWAY — so the two lines cross cleanly
  // (lower→right, upper→left when the targets are up-right; mirrored otherwise)
  // instead of doubling up. Fan-nested edges (hasCenter) already have a track and
  // are left alone. O(E²) over horizontal-run edges only; cheap in practice.
  const STEP = 12;
  const X_TOL = 6; // elbows within 6px count as "the same vertical line"
  const runs = [...vertSpans.entries()]
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => a.effX - b.effX || a.sy - b.sy);
  for (let i = 0; i < runs.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(runs[i].effX - runs[j].effX) > X_TOL) continue; // different column
      if (!(runs[i].y0 <= runs[j].y1 && runs[j].y0 <= runs[i].y1)) continue; // no Y overlap
      // Two overlapping verticals on the same column → split them so they CROSS
      // instead of running parallel: the one whose source anchor is LOWER moves
      // TOWARD its target, the HIGHER one moves AWAY. (Targets up-right ⇒ lower→
      // right, upper→left.) Skip fan-nested edges — they own their track.
      const [lower, higher] = runs[i].sy >= runs[j].sy ? [runs[i], runs[j]] : [runs[j], runs[i]];
      if (!lower.hasCenter) {
        lower.effX += lower.toTarget * STEP;      // lower anchor → toward its target
        out.get(lower.id)!.centerX = lower.effX;
      }
      if (!higher.hasCenter) {
        higher.effX -= higher.toTarget * STEP;    // higher anchor → away from its target
        out.get(higher.id)!.centerX = higher.effX;
      }
    }
  }

  cacheSig = sig;
  cacheMap = out;
  return out;
}
