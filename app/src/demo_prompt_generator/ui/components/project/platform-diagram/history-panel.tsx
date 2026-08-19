import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Eye, Loader2, RotateCcw, X } from "lucide-react";
import {
  listArchitectureHistory,
  getArchitectureHistoryContent,
  restoreArchitectureHistory,
  type ArchitectureHistoryEntry,
} from "@/lib/custom-api";

// Read-only architecture render (same recipe the template gallery uses): the full
// ReactFlow editor in view-only mode. Lazy so the heavy diagram chunk isn't pulled
// into the workspace bundle until a preview is actually opened.
const PlatformDiagram = lazy(() => import("@/components/project/platform-diagram"));

/** Relative "3 min ago" / "2 h ago" / "Jul 30" label for a snapshot timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Full absolute date + time down to the minute, e.g. "Jul 30, 2026, 3:08 PM". */
function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * Right-side slide-in panel listing this project's architecture-history snapshots
 * (newest first). Each row can be PREVIEWED (read-only render in a popup) or
 * RESTORED (swaps that version back onto the canvas + records a protected entry).
 *
 * In-app only (the standalone editor / read-only viewer have no backend history).
 */
export function ArchitectureHistoryPanel({
  projectId,
  open,
  onClose,
  onRestore,
  refreshSignal,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onRestore: (content: string) => void;
  /** Changes whenever the persisted architecture content changes (a save, an
   *  agent write, a collaborator op) → the open panel refetches its list so the
   *  "latest change" row stays current. */
  refreshSignal?: number;
}) {
  const [entries, setEntries] = useState<ArchitectureHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  // The entry currently open in the preview popup: tracked by ID (so Prev/Next +
  // list refreshes resolve against the live `entries`), plus its loaded content
  // (null = still loading, "" = load failed).
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // `silent` refetches (a live update while the panel is already showing a list)
  // swap the data in place without flashing the loading spinner — only the very
  // first load shows the spinner.
  const refresh = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    listArchitectureHistory(projectId)
      .then(setEntries)
      .catch(() => setError("Couldn't load history"))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Load on OPEN (with spinner). While open, a refreshSignal change (a save /
  // agent / collaborator write) refetches SILENTLY so the latest-change row stays
  // current without flashing the spinner. Only fetches while open (no background work).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    const firstOpen = !wasOpen.current;
    wasOpen.current = true;
    refresh(!firstOpen); // silent for signal-driven updates, spinner on first open
  }, [open, refresh, refreshSignal]);

  const handleRestore = useCallback(
    (id: number) => {
      setRestoringId(id);
      // The backend writes architecture.md + records a PROTECTED restore entry,
      // then returns the content so we re-seed the canvas immediately.
      restoreArchitectureHistory(projectId, id)
        .then((res) => {
          onRestore(res.content);
          setPreviewId(null);
          refresh(true); // silently pull in the new restore entry (now tops the list)
        })
        .catch(() => setError("Couldn't restore that version"))
        .finally(() => setRestoringId(null));
    },
    [projectId, onRestore, refresh],
  );

  // Load a version's content into the preview popup. Guarded by previewId so a
  // late fetch for a version we've since navigated away from is ignored.
  useEffect(() => {
    if (previewId == null) { setPreviewContent(null); return; }
    let stale = false;
    setPreviewContent(null); // show the loading spinner for the new version
    getArchitectureHistoryContent(projectId, previewId)
      .then((res) => { if (!stale) setPreviewContent(res.content); })
      .catch(() => { if (!stale) setPreviewContent(""); });
    return () => { stale = true; };
  }, [projectId, previewId]);

  // The previewed entry + its position in the live list → drives Prev/Next.
  const previewIndex = previewId == null ? -1 : entries.findIndex((e) => e.id === previewId);
  const previewEntry = previewIndex >= 0 ? entries[previewIndex] : null;
  // "Prev" = older (further down the newest-first list), "Next" = newer (up).
  const goOlder = previewIndex >= 0 && previewIndex < entries.length - 1
    ? () => setPreviewId(entries[previewIndex + 1].id) : undefined;
  const goNewer = previewIndex > 0
    ? () => setPreviewId(entries[previewIndex - 1].id) : undefined;

  if (!open) return null;

  return (
    <>
      <div className="absolute inset-y-0 right-0 z-40 flex w-72 flex-col border-l border-border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
            <Clock className="h-3.5 w-3.5" /> Architecture history
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading && entries.length === 0 && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {error && <div className="px-2 py-3 text-[11.5px] text-destructive">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="px-2 py-8 text-center text-[11.5px] text-muted-foreground">
              No history yet — changes to the architecture are saved here.
            </div>
          )}
          <div className="space-y-1">
            {entries.map((e, i) => (
              <div
                key={e.id}
                className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {relativeTime(e.created_at)}
                    {i === 0 && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(latest)</span>}
                  </div>
                  {/* Full date + time down to the minute. */}
                  <div className="truncate text-[10.5px] text-muted-foreground">{absoluteTime(e.created_at)}</div>
                  {e.is_restore && (
                    <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-medium text-primary">
                      <RotateCcw className="h-2.5 w-2.5" /> Restored
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setPreviewId(e.id)}
                    className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-background hover:text-foreground"
                    title="Preview this version"
                  >
                    <Eye className="h-3 w-3" /> Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRestore(e.id)}
                    disabled={restoringId !== null}
                    className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-default disabled:opacity-50"
                    title="Restore this version"
                  >
                    {restoringId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {previewEntry && (
        <ArchitecturePreviewModal
          entry={previewEntry}
          content={previewContent}
          restoring={restoringId === previewEntry.id}
          onClose={() => setPreviewId(null)}
          onRestore={() => handleRestore(previewEntry.id)}
          absoluteLabel={absoluteTime(previewEntry.created_at)}
          position={{ index: previewIndex, total: entries.length }}
          onOlder={goOlder}
          onNewer={goNewer}
        />
      )}
    </>
  );
}

/** Full-screen popup rendering ONE history snapshot read-only, with a Restore
 *  action. Uses the same view-only PlatformDiagram recipe as the template gallery
 *  (readOnly + hideChrome + no-op onSave → no editing, no collab, no history). */
function ArchitecturePreviewModal({
  entry,
  content,
  restoring,
  onClose,
  onRestore,
  absoluteLabel,
  position,
  onOlder,
  onNewer,
}: {
  entry: ArchitectureHistoryEntry;
  content: string | null;
  restoring: boolean;
  onClose: () => void;
  onRestore: () => void;
  absoluteLabel: string;
  /** 0-based index in the newest-first list + total count (for "3 of 12"). */
  position: { index: number; total: number };
  /** Step to the OLDER version (down the list); undefined at the oldest. */
  onOlder?: () => void;
  /** Step to the NEWER version (up the list); undefined at the newest. */
  onNewer?: () => void;
}) {
  // Escape closes; ←/→ step to the newer/older version.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
      else if (ev.key === "ArrowLeft") onNewer?.();
      else if (ev.key === "ArrowRight") onOlder?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNewer, onOlder]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <Eye className="h-4 w-4 text-muted-foreground" />
            Preview — {absoluteLabel}
            {entry.is_restore && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <RotateCcw className="h-2.5 w-2.5" /> Restored
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Prev / Next through history: ← newer, → older. */}
            <div className="mr-1 flex items-center gap-0.5">
              <button
                type="button"
                onClick={onNewer}
                disabled={!onNewer}
                className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted disabled:cursor-default disabled:opacity-30"
                title="Newer version (←)"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[54px] text-center text-[11px] tabular-nums text-muted-foreground">
                {position.index + 1} of {position.total}
              </span>
              <button
                type="button"
                onClick={onOlder}
                disabled={!onOlder}
                className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted disabled:cursor-default disabled:opacity-30"
                title="Older version (→)"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={onRestore}
              disabled={restoring || content == null}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
              title="Restore this version"
            >
              {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Restore this version
            </button>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-card">
          {content == null ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : content === "" ? (
            <div className="flex h-full items-center justify-center text-[12px] text-destructive">
              Couldn't load this version.
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              }
            >
              <PlatformDiagram
                content={content}
                capabilities={null}
                projectId={`hist-${entry.id}`}
                defaultEditMode={false}
                readOnly
                hideChrome
                onSave={() => {}}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
