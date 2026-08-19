/**
 * CapabilitiesPanel — the home-page picker, split into two tabs.
 *
 *   • "Simple solution" (default) — a curated baseline: synthetic
 *     data → dashboard + Genie + Unity Catalog. Optional opt-in for the
 *     Databricks App + Lakebase pair via one toggle. Everything else is
 *     hidden so first-time users get a fast path.
 *
 *   • "Custom solution" — the full `ProductSelector` so power users can
 *     pick exactly what they want.
 *
 * Both tabs write to the same `selectedProducts` set in the parent, so
 * the downstream build CTA + confirm dialog behave identically regardless
 * of which tab the user used to make selections.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Zap, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DATABRICKS_ICONS } from "@/components/databricks-icons";
import { TIER_CONFIG, type TierType } from "@/lib/architecture-schema";
import { CAPABILITY_META } from "@/lib/capabilities";
import { Capability } from "@/lib/custom-api";
import { ProductSelector } from "@/components/product-selector";

// Full capability set the AI should see when in Simple mode. Three groups:
//   • SIMPLE_VISIBLE_TILES — rendered as tiles in the UI. The user-visible
//     story arc: synthetic data → governance → dashboard → conversational.
//   • SIMPLE_TALK_TRACK — sent to the suggest LLM for context (so it can
//     anchor the story in a realistic stack) but NOT rendered as tiles.
//     Same hidden-from-listing slugs as project-overview's HIDDEN_SLUGS.
//   • APP_BUNDLE — optional add-on toggled by the app/lakebase switch.
const SIMPLE_VISIBLE_TILES = [
  "synthetic-data-gen",
  "aibi-dashboards",
  "genie",
] as const;
const SIMPLE_TALK_TRACK = [
  // Unity Catalog is part of every demo but no longer rendered as a tile (to
  // save horizontal space) — it stays in the baseline via the talk track.
  "unity-catalog",
  "lakeflow-connect",
  "genie-one",
  "genie-code",
] as const;
export const SIMPLE_BASELINE = [
  ...SIMPLE_VISIBLE_TILES,
  ...SIMPLE_TALK_TRACK,
] as const;

// Genie Code workshop simple baseline: the workshop builds a REAL SDP pipeline
// (not the fast SQL load), so `sdp` is in the core arc here — synthetic data →
// SDP → AI/BI dashboard → Genie. No app/lakebase (hidden in the workshop).
export const WORKSHOP_BASELINE = [
  "synthetic-data-gen",
  "sdp",
  "unity-catalog",
  "aibi-dashboards",
  "genie",
  // talk-track context for the suggest LLM
  "lakeflow-connect",
  "genie-code",
] as const;

// Optional toggle in the simple view: flip on the App + Lakebase pair
// together (matches the merged bundle in the custom view).
export const APP_BUNDLE = ["databricks-apps", "lakebase"] as const;

// Tier override per capability id — must mirror the same map in
// product-selector.tsx so a capability tile reads the same color across
// both surfaces. Kept local + minimal (only the ids the simple view
// actually renders).
const CAPABILITY_TIER: Partial<Record<string, TierType>> = {
  "synthetic-data-gen": "ingest",
  "unity-catalog": "governance",
  "aibi-dashboards": "analytics",
  "genie": "ai",
  "databricks-apps": "interface",
  "lakebase": "ingest",
};

interface Props {
  capabilities: Capability[];
  selectedProducts: Set<string>;
  onToggleProduct: (productId: string) => void;
  /** Replace the entire selection AND explicit-status map in one op.
   *  Caller (this panel) computes the right semantics per tab:
   *    - Simple → hard-lock: every non-baseline id explicit "unselected".
   *    - Custom → user-driven: only ids the user touched are explicit. */
  onReplaceSelection: (
    nextSelected: Set<string>,
    nextExplicit: Map<string, "selected" | "unselected">,
  ) => void;
  expanded: boolean;
  isLoading?: boolean;
  explicitSelections?: Map<string, "selected" | "unselected">;
  /** Which tab to open on. The build-from-architecture dialog passes "custom"
   *  when the diagram doesn't fit the simple baseline. Default "simple". */
  initialTab?: "simple" | "custom";
  /** Hide the "add a custom app + Lakebase backend" toggle — set in the Genie
   *  Code workshop, where apps + Lakebase aren't available. */
  hideAppBundle?: boolean;
  /** Notified whenever the active tab changes (and once on mount with the
   *  initial tab). Lets the home page drive its own UX off Simple vs Custom
   *  — e.g. a bigger free-type input + no story suggestions in Custom. */
  onTabChange?: (tab: "simple" | "custom") => void;
  /** Horizontal alignment of the tab header + summary. "center" (default) for
   *  the standalone layout; "left" when the panel sits in a row beside the
   *  Build button so both hug their respective edges. */
  align?: "center" | "left";
}

// Build the explicit-status map for Simple mode: every baseline id (+ app
// bundle if on) marked "selected", every other known capability marked
// "unselected" (hard lock — prevents the LLM from suggesting extras).
function buildSimpleExplicit(
  knownIds: string[],
  appOn: boolean,
): Map<string, "selected" | "unselected"> {
  const selected = new Set<string>(SIMPLE_BASELINE);
  if (appOn) for (const id of APP_BUNDLE) selected.add(id);
  const m = new Map<string, "selected" | "unselected">();
  for (const id of knownIds) {
    m.set(id, selected.has(id) ? "selected" : "unselected");
  }
  return m;
}

function buildSimpleSelected(appOn: boolean): Set<string> {
  const s = new Set<string>(SIMPLE_BASELINE);
  if (appOn) for (const id of APP_BUNDLE) s.add(id);
  return s;
}

export function CapabilitiesPanel({
  capabilities,
  selectedProducts,
  onToggleProduct,
  onReplaceSelection,
  expanded,
  isLoading = false,
  explicitSelections = new Map(),
  initialTab = "simple",
  hideAppBundle = false,
  onTabChange,
  align = "center",
}: Props) {
  const [tab, setTab] = useState<"simple" | "custom">(initialTab);
  // Custom picker is a lightweight hover-popover that spans out from the Custom
  // button. Opens on hover (or on selecting the Custom tab), and shrinks away
  // shortly after the pointer leaves. A small close delay lets the pointer
  // travel from the button down into the popover without it collapsing.
  const [customOpen, setCustomOpen] = useState(initialTab === "custom");
  // The popover renders in a PORTAL (so the card's overflow-hidden can't clip
  // it) and is positioned from the anchor's bounding rect.
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null);
  const positionPopover = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 16;
    // Wide enough to show all four product columns; capped to the viewport.
    const width = Math.min(window.innerWidth - margin * 2, 60 * 16);
    const half = width / 2;
    // Horizontally: center on the anchor, clamped so neither edge clips.
    const left = Math.max(
      margin + half,
      Math.min(r.left + r.width / 2, window.innerWidth - margin - half),
    );
    // Vertically: prefer just below the anchor, but if the popover would run
    // off the bottom, shift it UP so the whole thing stays on-screen (no
    // scrolling to reach it). Measure the live height when we have it.
    const h = popoverRef.current?.offsetHeight ?? 0;
    let top = r.bottom + 8;
    if (h > 0 && top + h > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - h);
    }
    setPopoverPos({ left, top });
  }, []);
  // handleTabChange is defined below; a ref lets openCustomPicker call it
  // without a temporal-dead-zone / ordering problem.
  const handleTabChangeRef = useRef<(t: "simple" | "custom") => void>(() => {});
  // Open the picker (used by the Custom-summary "Edit" button): switch to the
  // custom tab if needed and show the popover.
  const openCustomPicker = useCallback(() => {
    positionPopover();
    if (tab !== "custom") handleTabChangeRef.current("custom");
    setCustomOpen(true);
  }, [positionPopover, tab]);
  // Keep the popover glued to the anchor while it's open (scroll / resize).
  // Also re-run once right after it mounts so the vertical clamp can use the
  // popover's real height (first pass runs before it has one).
  useEffect(() => {
    if (!customOpen) return;
    positionPopover();
    const raf = requestAnimationFrame(() => positionPopover());
    const onMove = () => positionPopover();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [customOpen, positionPopover]);
  // Close the popover on outside-click / Escape (it's not a modal, so there's
  // no backdrop to catch these).
  useEffect(() => {
    if (!customOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      setCustomOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCustomOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [customOpen]);

  // Tell the parent the initial tab once on mount (so its input size / suggest
  // gating starts in the right mode).
  useEffect(() => {
    onTabChange?.(initialTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-tab memory. Each entry stores (selectedProducts, explicitSelections)
  // for that tab so the user can switch back and forth without losing
  // their work in the other tab. The active tab's tuple lives in the
  // parent's state; the OTHER tab's tuple lives here, swapped in on
  // tab change.
  //
  // Custom-tab starts UNINITIALIZED — the first time the user enters
  // Custom we seed it with the current Simple selection (per spec: the
  // user sees the baseline as the starting point, every other id null
  // so the AI can suggest extras).
  const tabMemoryRef = useRef<{
    simple?: { selected: Set<string>; explicit: Map<string, "selected" | "unselected"> };
    custom?: { selected: Set<string>; explicit: Map<string, "selected" | "unselected"> };
  }>({});

  // Whenever the simple tab is the ACTIVE one, lock the selection to
  // the baseline (+ app bundle if currently on). Runs on tab entry AND
  // when capabilities first load (the lock needs the full universe so
  // it can mark every non-baseline id as explicitly unselected).
  useEffect(() => {
    if (tab !== "simple") return;
    if (capabilities.length === 0) return;
    const allKnown = capabilities.map((c) => c.id);
    const appOn = APP_BUNDLE.some((id) => selectedProducts.has(id));
    const nextSelected = buildSimpleSelected(appOn);
    const nextExplicit = buildSimpleExplicit(allKnown, appOn);
    onReplaceSelection(nextSelected, nextExplicit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, capabilities.length]);

  // Tab switch handler — saves the LEAVING tab's state, restores the
  // ENTERING tab's state. First-time Custom entry seeds from the current
  // Simple selection (so the user keeps what they were looking at).
  const handleTabChange = useCallback(
    (nextTab: "simple" | "custom") => {
      if (nextTab === tab) return;
      // Save the leaving tab's tuple.
      tabMemoryRef.current[tab] = {
        selected: new Set(selectedProducts),
        explicit: new Map(explicitSelections),
      };
      if (nextTab === "custom") {
        // Restore Custom memory if any; otherwise seed from current
        // (Simple) selection — the user sees their picks carry over,
        // but Custom's explicit map only carries the BASELINE as
        // "selected" with everything else NULL (LLM may decide).
        const remembered = tabMemoryRef.current.custom;
        if (remembered) {
          onReplaceSelection(remembered.selected, remembered.explicit);
        } else {
          const seedSelected = new Set(selectedProducts);
          const seedExplicit = new Map<string, "selected" | "unselected">();
          // Mark only the currently-selected ids as explicit "selected".
          // Everything else stays absent → null → LLM is free to suggest.
          for (const id of seedSelected) seedExplicit.set(id, "selected");
          onReplaceSelection(seedSelected, seedExplicit);
        }
        // Open the picker modal when entering Custom.
        setCustomOpen(true);
      }
      // For "simple" entry the lock effect above (deps: [tab]) takes
      // over once we flip the state, so we don't need a manual restore
      // here. The lock always reconstructs from SIMPLE_BASELINE + appOn.
      setTab(nextTab);
      onTabChange?.(nextTab);
    },
    [tab, selectedProducts, explicitSelections, onReplaceSelection, onTabChange],
  );
  // Keep the ref current so openCustomPicker (defined above) can call it.
  handleTabChangeRef.current = handleTabChange;

  // App-bundle toggle in Simple — just re-runs the lock with the new
  // app state and lets onReplaceSelection take care of the rest.
  const appBundleOn = APP_BUNDLE.some((id) => selectedProducts.has(id));
  const toggleAppBundle = () => {
    const nextAppOn = !appBundleOn;
    const allKnown = capabilities.map((c) => c.id);
    onReplaceSelection(
      buildSimpleSelected(nextAppOn),
      buildSimpleExplicit(allKnown, nextAppOn),
    );
  };

  return (
    <div
      className={cn(
        "grid transition-all duration-300 ease-in-out overflow-hidden",
        expanded ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0 mt-0",
      )}
    >
      <div className="overflow-hidden">
        <div>
          <Tabs value={tab} onValueChange={(v) => handleTabChange(v as "simple" | "custom")}>
            <div
              className={cn(
                "flex flex-col mb-2.5",
                align === "left" ? "items-start text-left" : "items-center text-center",
              )}
            >
              {/* Anchor for the Custom picker popover — clicking the Custom
                  tab opens it (see handleTabChange); it's positioned from this
                  element's rect. */}
              <div ref={anchorRef}>
                <TabsList>
                  <TabsTrigger value="simple">Simple solution</TabsTrigger>
                  {/* onClick (in addition to the tab's onValueChange) so that
                      re-clicking an already-active Custom tab REOPENS the
                      popover after it was dismissed. */}
                  <TabsTrigger value="custom" onClick={openCustomPicker}>
                    Custom solution
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            {/* Picker popover that spans out from the Custom button. Portaled
                to <body> so the card's overflow-hidden can't clip it. Opens on
                CLICKING the Custom tab; STAYS open while the user toggles
                products — only the ✕ button, an outside-click, or Esc close it.
                Not a modal — no backdrop, no page lock. */}
            {popoverPos &&
              createPortal(
                <div
                  ref={popoverRef}
                  style={{
                    position: "fixed",
                    left: popoverPos.left,
                    top: popoverPos.top,
                    transform: "translateX(-50%)",
                    maxHeight: "calc(100vh - 2rem)",
                  }}
                  className={cn(
                    "z-50 w-[min(calc(100vw-2rem),60rem)] origin-top overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-xl transition-all duration-200 ease-out text-left",
                    customOpen
                      ? "scale-100 opacity-100"
                      : "pointer-events-none scale-95 opacity-0",
                  )}
                >
                  {/* Close (✕) — the popover stays open through product toggles,
                      so an explicit close affordance matters. */}
                  <button
                    type="button"
                    onClick={() => setCustomOpen(false)}
                    aria-label="Close"
                    className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <ProductSelector
                    capabilities={capabilities}
                    selectedProducts={selectedProducts}
                    onToggleProduct={onToggleProduct}
                    expanded={true}
                    isLoading={isLoading}
                    explicitSelections={explicitSelections}
                  />
                </div>,
                document.body,
              )}

            {/* SIMPLE — curated baseline. Collapsed to a one-line summary by
                default (the baseline is predictable); the optional app/lakebase
                pair is a compact inline chip when expanded. */}
            <TabsContent value="simple" className="mt-0">
              <SimpleSummary
                isLoading={isLoading}
                align={align}
                appBundle={
                  hideAppBundle
                    ? undefined
                    : { on: appBundleOn, onToggle: toggleAppBundle, disabled: isLoading }
                }
              />
            </TabsContent>

            {/* CUSTOM — a compact summary of the current selection; hover the
                Custom button (above) to expand the picker popover. */}
            <TabsContent value="custom" className="mt-0">
              <CustomSummary
                isLoading={isLoading}
                align={align}
                capabilities={capabilities}
                selectedProducts={selectedProducts}
                onEdit={openCustomPicker}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple-view widgets
// ---------------------------------------------------------------------------

// One-line Simple baseline: "Included: Synthetic Data · AI/BI Dashboard · Genie
// Agent" on the left, and a compact toggle on the right to add the App +
// Lakebase pair. When the app is on, a small note flags the longer build.
function SimpleSummary({
  isLoading,
  appBundle,
  align = "center",
}: {
  isLoading: boolean;
  appBundle?: { on: boolean; onToggle: () => void; disabled?: boolean };
  align?: "center" | "left";
}) {
  const names = SIMPLE_VISIBLE_TILES.map(
    (id) => CAPABILITY_META[id]?.display ?? id,
  );
  const on = !!appBundle?.on;
  return (
    <div
      className={cn(
        "flex w-fit max-w-2xl flex-col gap-1 rounded-lg border border-border/50 bg-muted/20 px-4 py-2",
        align === "center" && "mx-auto",
        isLoading && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Included:</span>{" "}
          {names.join(" · ")}
        </span>
        {appBundle && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Add a custom app + Lakebase backend"
            onClick={appBundle.onToggle}
            disabled={appBundle.disabled}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
              on
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-primary/40 bg-primary/5 text-primary/90 hover:bg-primary/10 hover:border-primary/60",
            )}
          >
            {on ? "App + Lakebase" : "+ Add app"}
            <span
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                on ? "bg-primary" : "bg-muted-foreground/40",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform",
                  on ? "translate-x-[14px]" : "translate-x-[2px]",
                )}
              />
            </span>
          </button>
        )}
      </div>
      {/* "Takes longer" note — inside the box, under the Included line. */}
      {appBundle && on && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Zap className="mt-0.5 h-3 w-3 shrink-0 text-primary/60" />
          Adding an app + Lakebase backend makes the build take longer.
        </p>
      )}
    </div>
  );
}

// Compact Custom-tab summary shown when the picker modal is closed: the current
// selection (names, or a count if long) + an "Edit" button that reopens the
// modal. Mirrors SimpleSummary's box so the two tabs read consistently.
function CustomSummary({
  isLoading,
  align = "center",
  capabilities,
  selectedProducts,
  onEdit,
}: {
  isLoading: boolean;
  align?: "center" | "left";
  capabilities: Capability[];
  selectedProducts: Set<string>;
  onEdit: () => void;
}) {
  // Names of the selected capabilities, in the catalog's order, skipping the
  // hidden talk-track-only slugs so the summary matches what's on the tiles.
  const selectedNames = capabilities
    .filter((c) => selectedProducts.has(c.id))
    .map((c) => CAPABILITY_META[c.id]?.display ?? c.id);
  const count = selectedNames.length;
  const label =
    count === 0
      ? "No capabilities selected yet"
      : count <= 4
        ? selectedNames.join(" · ")
        : `${selectedNames.slice(0, 3).join(" · ")} +${count - 3} more`;
  return (
    <div
      className={cn(
        "flex w-fit max-w-2xl items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-2",
        align === "center" && "mx-auto",
        isLoading && "opacity-60",
      )}
    >
      <span className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Selected:</span> {label}
      </span>
      <button
        type="button"
        onClick={onEdit}
        disabled={isLoading}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs font-semibold text-primary/90 transition-colors hover:bg-primary/10 hover:border-primary/60 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <SlidersHorizontal className="h-3 w-3" />
        Edit
      </button>
    </div>
  );
}
