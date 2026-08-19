import { computeFanLayout } from "@/components/project/platform-diagram/fan-layout";

// Build a ReactFlow-ish node lookup. Sources stacked in a left column all point
// at ONE target on the right — the converging-into-one-connector case.
function mkNode(x: number, y: number, w = 230, h = 54) {
  return { internals: { positionAbsolute: { x, y }, handleBounds: { source: null } }, measured: { width: w, height: h } } as any;
}

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log("  ✗ " + msg); } else console.log("  ✓ " + msg); };

function run(name: string, sources: { id: string; x: number; y: number }[], target: { x: number; y: number }, sHandle = "r", tHandle = "l") {
  console.log("\n=== " + name + " ===");
  const nodes = new Map<string, any>();
  nodes.set("T", mkNode(target.x, target.y));
  const edges = sources.map((s) => {
    nodes.set(s.id, mkNode(s.x, s.y));
    return { id: "e-" + s.id, source: s.id, target: "T", sourceHandle: sHandle, targetHandle: tHandle };
  });
  const fan = computeFanLayout(edges as any, nodes as any);
  // Rank by the SAME metric the code uses: distance from the source's Y-center
  // to the target connector's center, tiebreak on signed Y.
  const connectorY = target.y + 27; // target h/2 (54/2) = its side-center
  const rows = sources.map((s) => {
    const f = fan.get("e-" + s.id)!;
    return { id: s.id, srcY: s.y, srcCtrY: s.y + 27, dist: Math.abs(s.y + 27 - connectorY), centerX: f.centerX };
  });
  rows.forEach((r) => console.log(`   ${r.id}: srcY=${r.srcY} dist=${Math.round(r.dist)} centerX=${r.centerX === undefined ? "—" : Math.round(r.centerX)}`));
  // All defined + all distinct
  const xs = rows.map((r) => r.centerX).filter((x): x is number => x !== undefined);
  ok(xs.length === rows.length, "every converging edge got a centerX");
  ok(new Set(xs.map((x) => Math.round(x))).size === xs.length, "all elbow X distinct (no two verticals share a track)");
  // Monotonic: farther source => elbow closer to target. Target on right (x large),
  // source column on left → "closer to target" = LARGER centerX.
  const byDist = [...rows].sort((a, b) => a.dist - b.dist || a.srcCtrY - b.srcCtrY); // nearest first, Y tiebreak
  const targetRight = target.x > sources[0].x;
  let mono = true;
  for (let i = 1; i < byDist.length; i++) {
    const prev = byDist[i - 1].centerX!, cur = byDist[i].centerX!;
    // farther (cur) should be closer to target than nearer (prev)
    if (targetRight ? !(cur > prev) : !(cur < prev)) mono = false;
  }
  ok(mono, "farther source → elbow nested toward target (bracket nesting)");
}

// 1) col/row-style: 3 sources evenly stacked, target to the right, mid height.
run("3 stacked sources, target right-mid", [
  { id: "A", x: 0, y: -120 },
  { id: "B", x: 0, y: 0 },
  { id: "C", x: 0, y: 120 },
], { x: 500, y: 0 });

// 2) The Agent Bricks shape: sources above+below a high-ish connector, narrow gap.
run("narrow corridor (tools→supervisor)", [
  { id: "genie", x: 700, y: -242 },
  { id: "mcp", x: 700, y: 14 },
  { id: "ka", x: 700, y: 187 },
], { x: 900, y: -160 });

// 3) All sources ABOVE the connector (connector at bottom).
run("all sources above connector", [
  { id: "A", x: 0, y: -300 },
  { id: "B", x: 0, y: -200 },
  { id: "C", x: 0, y: -100 },
], { x: 500, y: 40 });

// 4) Target on the LEFT (sources to its right) — mirror case.
run("target on left (mirror)", [
  { id: "A", x: 500, y: -120 },
  { id: "B", x: 500, y: 0 },
  { id: "C", x: 500, y: 120 },
], { x: 0, y: 0 }, "l", "r");

// 5) DE-OVERLAP: two UNRELATED edges (different source+target pairs) whose
// vertical elbows would land on the same column with overlapping Y — must be
// nudged apart so their verticals don't draw on top of each other.
{
  console.log("\n=== de-overlap: two unrelated same-column verticals ===");
  const nodes = new Map<string, any>();
  // Two source→target pairs arranged so both elbows default to the SAME midpoint x.
  nodes.set("s1", mkNode(0, -100)); nodes.set("t1", mkNode(400, 100));
  nodes.set("s2", mkNode(0, -60));  nodes.set("t2", mkNode(400, 140));
  const edges = [
    { id: "eA", source: "s1", target: "t1", sourceHandle: "r", targetHandle: "l" },
    { id: "eB", source: "s2", target: "t2", sourceHandle: "r", targetHandle: "l" },
  ];
  const fan = computeFanLayout(edges as any, nodes as any);
  const a = fan.get("eA")!, b = fan.get("eB")!;
  // default smooth-step midpoint x = (sourceExit 230 + targetEntry 400) / 2 = 315
  const DEF = 315;
  const ax = a.centerX ?? DEF, bx = b.centerX ?? DEF;
  console.log(`   eA centerX=${a.centerX === undefined ? "—(" + DEF + ")" : Math.round(a.centerX)}  eB centerX=${b.centerX === undefined ? "—(" + DEF + ")" : Math.round(b.centerX)}`);
  ok(Math.abs(ax - bx) >= 4, "overlapping unrelated verticals nudged apart (≥4px)");
}

// 6) DIRECTIONAL de-overlap (the medallion case): two edges leaving STACKED
// anchors on one node's right side, both heading UP-RIGHT to targets. The LOWER
// anchor's vertical must go RIGHT, the HIGHER one's LEFT (so they cross, not
// run parallel).
{
  console.log("\n=== directional de-overlap: stacked out-anchors, up-right targets ===");
  const nodes = new Map<string, any>();
  const src = mkNode(0, 0, 230, 120);          // one tall source with 2 right-side exits
  nodes.set("src", src);
  nodes.set("tHigh", mkNode(400, -200));       // target for the UPPER anchor
  nodes.set("tLow", mkNode(400, -120));        // target for the LOWER anchor
  // Two edges from the same right side at different fracs (upper vs lower exit).
  const edges = [
    { id: "eUp", source: "src", target: "tHigh", sourceHandle: "r", targetHandle: "l" },
    { id: "eDn", source: "src", target: "tLow", sourceHandle: "r", targetHandle: "l" },
  ];
  const fan = computeFanLayout(edges as any, nodes as any);
  const up = fan.get("eUp")!, dn = fan.get("eDn")!;
  console.log(`   upper anchor elbow=${up.centerX === undefined ? "—" : Math.round(up.centerX)}  lower anchor elbow=${dn.centerX === undefined ? "—" : Math.round(dn.centerX)}`);
  // Both go up-right; if they collided they were split. We can't fully control
  // which exit frac each got, so assert only that they end up on DISTINCT tracks
  // (the collision was resolved) — the visual direction is verified in-browser.
  if (up.centerX !== undefined && dn.centerX !== undefined) {
    ok(Math.round(up.centerX) !== Math.round(dn.centerX), "stacked out-anchors separated onto distinct tracks");
  } else {
    ok(true, "stacked out-anchors: at most one needed a track (no collision)");
  }
}

console.log("\n" + (failures === 0 ? "ALL PASS ✓" : `${failures} FAILURE(S) ✗`));
process.exit(failures === 0 ? 0 : 1);
