/**
 * platform-diagram/group-resize — a SINGLE resize frame around a MULTI-selection.
 *
 * Per-node NodeResizeControls are hidden for a multi-selection (mounting 5×N
 * controls lags the lasso, and one node's handle can't resize a group anyway —
 * see shared.tsx `showResize`). Instead we draw ONE frame around the whole
 * selection's bounding box; dragging a corner scales EVERY selected node
 * UNIFORMLY — both its size and its position relative to the fixed opposite
 * corner — so the group resizes as one and keeps its internal layout.
 *
 * Rendered INSIDE <ReactFlow> (like CollabCursors) so it reads the live viewport
 * transform via useStore and stays glued to the nodes on pan/zoom.
 */
import { useRef, useState } from "react";
import { useStore } from "@xyflow/react";
import { GripStroke, type NodeData } from "./shared";

export interface GroupRect { id: string; x: number; y: number; w: number; h: number }

/** A committed group scale: for each id, its new top-left + size (flow coords). */
export interface GroupScale { id: string; x: number; y: number; w: number; h: number }

const MIN_SCALE = 0.2; // don't let a drag collapse the group past this factor

/** Selected nodes' rects (flow coords, top-left origin) → the union bounding box. */
function unionBounds(rects: GroupRect[]): { x: number; y: number; w: number; h: number } | null {
  if (rects.length < 2) return null;
  let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
  for (const r of rects) {
    L = Math.min(L, r.x); T = Math.min(T, r.y);
    R = Math.max(R, r.x + r.w); B = Math.max(B, r.y + r.h);
  }
  return { x: L, y: T, w: R - L, h: B - T };
}

const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;
type Corner = (typeof CORNERS)[number];

export function GroupResize({
  rects,
  toFlow,
  onScale,
}: {
  /** Rects of the currently-selected nodes (flow coords). <2 → nothing renders. */
  rects: GroupRect[];
  /** Screen (client) point → flow coords, for mapping the pointer during a drag. */
  toFlow: (clientX: number, clientY: number) => { x: number; y: number };
  /** Commit the scaled rects (one history burst). Called live during the drag. */
  onScale: (next: GroupScale[]) => void;
}) {
  // Live viewport transform so the frame maps flow → screen and tracks pan/zoom.
  const [tx, ty, zoom] = useStore((s) => s.transform);
  // The active drag lives in a REF (not state): `move` must read it synchronously
  // the instant the first pointermove fires — a state update wouldn't have
  // committed yet, so the first moves would be dropped. A tiny `dragging` state
  // just forces the re-render that repaints the frame during the drag.
  type Drag = { corner: Corner; anchor: { x: number; y: number }; start: { x: number; y: number }; base: { x: number; y: number; w: number; h: number }; baseRects: GroupRect[] };
  const dragRef = useRef<Drag | null>(null);
  const [, setDragging] = useState(false);

  const bounds = unionBounds(rects);
  if (!bounds) return null;

  // Frame in screen space.
  const sx = bounds.x * zoom + tx;
  const sy = bounds.y * zoom + ty;
  const sw = bounds.w * zoom;
  const sh = bounds.h * zoom;

  const start = (corner: Corner) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    // The FIXED anchor is the corner diagonally opposite the dragged one.
    const anchor = {
      x: corner.includes("left") ? bounds.x + bounds.w : bounds.x,
      y: corner.includes("top") ? bounds.y + bounds.h : bounds.y,
    };
    // Snapshot the rects at drag start so every frame scales from the ORIGINAL
    // layout (no compounding drift).
    dragRef.current = { corner, anchor, start: toFlow(e.clientX, e.clientY), base: { ...bounds }, baseRects: rects.map((r) => ({ ...r })) };
    setDragging(true);
  };

  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !(e.buttons & 1)) return;
    e.stopPropagation();
    const f = toFlow(e.clientX, e.clientY);
    // Uniform scale: compare the dragged corner's distance-from-anchor before vs
    // now, on whichever axis has the larger base extent (keeps aspect ratio +
    // avoids blow-up when one axis is tiny). Anchor stays fixed.
    const baseDX = Math.abs(d.start.x - d.anchor.x);
    const baseDY = Math.abs(d.start.y - d.anchor.y);
    const curDX = Math.abs(f.x - d.anchor.x);
    const curDY = Math.abs(f.y - d.anchor.y);
    const sX = baseDX > 1 ? curDX / baseDX : 1;
    const sY = baseDY > 1 ? curDY / baseDY : 1;
    // Drive the uniform factor from the axis with the bigger original span.
    let scale = d.base.w >= d.base.h ? sX : sY;
    if (!Number.isFinite(scale) || scale < MIN_SCALE) scale = MIN_SCALE;
    const a = d.anchor;
    onScale(d.baseRects.map((r) => ({
      id: r.id,
      x: a.x + (r.x - a.x) * scale,
      y: a.y + (r.y - a.y) * scale,
      w: r.w * scale,
      h: r.h * scale,
    })));
  };

  const end = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    dragRef.current = null;
    setDragging(false);
  };

  // Corner points (screen coords) for the 4 grips.
  const cornerPt: Record<Corner, { left: number; top: number }> = {
    "top-left": { left: sx, top: sy },
    "top-right": { left: sx + sw, top: sy },
    "bottom-right": { left: sx + sw, top: sy + sh },
    "bottom-left": { left: sx, top: sy + sh },
  };
  const GRIP = 18; // hit-target box around the L-bracket ink

  return (
    // Overlay sits above the pane; only the handles capture pointer events.
    <div className="pointer-events-none absolute inset-0 z-20">
      {/* Selection frame */}
      <div
        className="absolute rounded-[2px] border border-dashed border-primary/70"
        style={{ left: sx, top: sy, width: sw, height: sh }}
      />
      {/* Corner grips — the SAME L-bracket marker single-element resize uses
          (GripStroke), so the two look identical. Centered on each corner. */}
      {CORNERS.map((corner) => {
        const p = cornerPt[corner];
        return (
          <div
            key={corner}
            onPointerDown={start(corner)}
            onPointerMove={move}
            onPointerUp={end}
            className="pointer-events-auto absolute grid place-items-center"
            style={{ left: p.left - GRIP / 2, top: p.top - GRIP / 2, width: GRIP, height: GRIP }}
          >
            <GripStroke shape={corner} />
          </div>
        );
      })}
    </div>
  );
}

/** Read a node's flow-coord rect (top-left origin) from its RF node. Mirrors the
 *  size fallback used across the canvas (width → data.w → default). */
export function rectOfNode(n: { position: { x: number; y: number }; width?: number | null; height?: number | null; data: unknown; origin?: [number, number] }): GroupRect {
  const dd = n.data as NodeData;
  const w = (n.width ?? dd.w ?? 200) as number;
  const h = (n.height ?? dd.h ?? 56) as number;
  const [ox, oy] = n.origin ?? [0.5, 0.5];
  return { id: dd.nodeId, x: n.position.x - ox * w, y: n.position.y - oy * h, w, h };
}
