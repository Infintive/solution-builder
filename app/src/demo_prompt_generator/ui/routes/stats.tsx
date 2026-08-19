/**
 * /stats — usage dashboard.
 *
 * Renders KPI tiles, per-interval activity charts (day/week/month buckets over
 * an arbitrary date range), stage + entry-mode breakdowns, top contributors,
 * and a filterable, paginated project table. Everything is exportable (JSON
 * snapshot or per-table CSV via the export dialog). Backed by GET /api/stats
 * and GET /api/stats/projects/export. Charts use recharts.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppLayout } from "@/components/layout/app-layout";
import {
  getStats,
  exportStatsProjectsCsv,
  type Stats,
  type StatsDayCount,
  type StatsGranularity,
} from "@/lib/custom-api";
import {
  Activity,
  BarChart3,
  Loader2,
  Users,
  FolderOpen,
  Zap,
  MessageSquare,
  Search,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function StatsWithLayout() {
  return <AppLayout><StatsPage /></AppLayout>;
}

export const Route = createFileRoute("/stats")({
  component: StatsWithLayout,
});

const PRESETS = [
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
  { value: 180, label: "6mo" },
  { value: 365, label: "1y" },
];

const GRANULARITIES: { value: StatsGranularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const DEFAULT_PRESET = 90;
const PAGE_SIZE = 25;
const ALL = "__all__"; // Select sentinel — Radix disallows an empty-string value.
const TOP_OWNER_OPTIONS = [3, 5, 10, 25, 50];

// Slice colors for the breakdown pies (from the theme's chart ramp).
const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

// Range mode: either a rolling preset (days) or an explicit start/end range.
type RangeState =
  | { kind: "preset"; days: number }
  | { kind: "custom"; start: string; end: string };

function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState<RangeState>({ kind: "preset", days: DEFAULT_PRESET });
  const [granularity, setGranularity] = useState<StatsGranularity>("day");

  const [page, setPage] = useState(1);
  const [ownerInput, setOwnerInput] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("");
  const [topOwnersLimit, setTopOwnersLimit] = useState(10);

  const [exportOpen, setExportOpen] = useState(false);

  // Serialize the range into API query params.
  const rangeQuery = useMemo(
    () =>
      range.kind === "preset"
        ? { days: range.days }
        : { start: range.start, end: range.end },
    [range],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStats({
      ...rangeQuery,
      granularity,
      page,
      page_size: PAGE_SIZE,
      owner_filter: ownerFilter || undefined,
      stage_filter: stageFilter || undefined,
      mode_filter: modeFilter || undefined,
      top_owners_limit: topOwnersLimit,
    })
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rangeQuery, granularity, page, ownerFilter, stageFilter, modeFilter, topOwnersLimit]);

  const applyOwnerFilter = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setOwnerFilter(ownerInput.trim());
  };

  const clearAllFilters = () => {
    setOwnerInput("");
    setOwnerFilter("");
    setStageFilter("");
    setModeFilter("");
    setPage(1);
  };

  const hasTableFilters = !!(ownerFilter || stageFilter || modeFilter);

  if (loading && !stats) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Card>
          <CardContent className="p-6 text-destructive">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!stats) return null;

  const rangeLabel =
    stats.range_start === stats.range_end
      ? stats.range_start
      : `${stats.range_start} → ${stats.range_end}`;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage stats</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Aggregate project + agent activity across all users.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setExportOpen(true)}
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </header>

      {/* Range + granularity controls */}
      <RangeControls
        range={range}
        granularity={granularity}
        onRangeChange={(r) => {
          setRange(r);
          setPage(1);
        }}
        onGranularityChange={setGranularity}
      />

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi icon={FolderOpen} label="Projects" value={stats.total_projects} />
        <Kpi icon={Users} label="Unique users" value={stats.total_users} />
        <Kpi icon={MessageSquare} label="Messages" value={stats.total_messages} />
        <Kpi icon={Zap} label="New (7d)" value={stats.projects_last_7d} />
        <Kpi icon={Activity} label="New (30d)" value={stats.projects_last_30d} />
        <Kpi
          icon={BarChart3}
          label="Live runs"
          value={stats.active_executions}
          accent={stats.active_executions > 0}
        />
      </div>

      {/* Activity charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <IntervalChart
          title="Projects created"
          subtitle={rangeLabel}
          data={stats.projects_per_day}
          color="var(--chart-1)"
          range={range}
          granularity={granularity}
        />
        <IntervalChart
          title="Messages"
          subtitle={rangeLabel}
          data={stats.messages_per_day}
          color="var(--chart-2)"
          range={range}
          granularity={granularity}
        />
      </div>

      {/* Breakdowns + top contributors — click a slice/owner to cross-filter */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <PieBreakdown
          title="Stage distribution"
          rows={stats.by_stage.map((s) => ({ key: s.stage, label: s.stage, count: s.count }))}
          activeKey={stageFilter}
          onSelect={(key) => {
            setStageFilter((prev) => (prev === key ? "" : key));
            setPage(1);
          }}
        />
        <PieBreakdown
          title="Entry mode"
          rows={stats.by_mode.map((m) => ({
            key: m.mode,
            label: MODE_LABELS[m.mode] ?? m.mode,
            count: m.count,
          }))}
          activeKey={modeFilter}
          onSelect={(key) => {
            setModeFilter((prev) => (prev === key ? "" : key));
            setPage(1);
          }}
        />

        {/* Top contributors — vertical list */}
        <Card className="md:col-span-2 lg:col-span-1">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">
                Top contributors{" "}
                <span className="text-muted-foreground font-normal">
                  ({stats.top_owners.length})
                </span>
              </CardTitle>
              <Select
                value={String(topOwnersLimit)}
                onValueChange={(v) => setTopOwnersLimit(Number(v))}
              >
                <SelectTrigger className="h-7 w-[78px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOP_OWNER_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Top {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto pr-1">
              {stats.top_owners.map((o, i) => {
                const active = ownerFilter === o.user_email;
                return (
                  <button
                    key={o.user_email}
                    onClick={() => {
                      setOwnerInput(active ? "" : o.user_email);
                      setOwnerFilter(active ? "" : o.user_email);
                      setPage(1);
                    }}
                    className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded text-left hover:bg-muted/50 ${
                      active ? "bg-primary/10" : ""
                    }`}
                    title={active ? "Clear this owner filter" : "Filter the table by this owner"}
                  >
                    <span className="text-muted-foreground tabular-nums w-4 shrink-0">
                      {i + 1}
                    </span>
                    <span className="truncate font-medium flex-1">{o.user_email}</span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {o.project_count}
                    </span>
                  </button>
                );
              })}
              {stats.top_owners.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">No data yet.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Projects table */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-sm">
              Projects{" "}
              <span className="text-muted-foreground font-normal tabular-nums">
                ({stats.total_filtered.toLocaleString()})
              </span>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Stage filter */}
              <Select
                value={stageFilter || ALL}
                onValueChange={(v) => {
                  setStageFilter(v === ALL ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue placeholder="All stages" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All stages</SelectItem>
                  {stats.by_stage.map((s) => (
                    <SelectItem key={s.stage} value={s.stage}>
                      {s.stage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Mode filter */}
              <Select
                value={modeFilter || ALL}
                onValueChange={(v) => {
                  setModeFilter(v === ALL ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue placeholder="All modes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All modes</SelectItem>
                  {stats.by_mode.map((m) => (
                    <SelectItem key={m.mode} value={m.mode}>
                      {MODE_LABELS[m.mode] ?? m.mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Owner search */}
              <form onSubmit={applyOwnerFilter} className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={ownerInput}
                    onChange={(e) => setOwnerInput(e.target.value)}
                    placeholder="Filter by owner email…"
                    className="pl-8 h-8 w-56 text-xs"
                  />
                </div>
                <Button type="submit" size="sm" variant="secondary" className="h-8">
                  Filter
                </Button>
              </form>
              {hasTableFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1"
                  onClick={clearAllFilters}
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <Th>Name</Th>
                  <Th>Owner</Th>
                  <Th>Stage</Th>
                  <Th>Mode</Th>
                  <Th className="text-right">Messages</Th>
                  <Th>Template</Th>
                  <Th>Created</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {stats.projects.map((p) => (
                  <tr key={p.id} className="border-t border-border hover:bg-muted/30">
                    <Td>
                      <Link
                        to="/project/$projectId"
                        params={{ projectId: p.id }}
                        className="font-medium hover:underline truncate block max-w-[280px]"
                      >
                        {p.name}
                      </Link>
                    </Td>
                    <Td className="text-muted-foreground truncate max-w-[220px]">
                      {p.user_email}
                    </Td>
                    <Td>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {p.stage}
                      </Badge>
                      {p.has_active_execution && (
                        <span
                          className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse"
                          title="Currently running"
                        />
                      )}
                    </Td>
                    <Td className="text-muted-foreground">
                      {MODE_LABELS[p.mode] ?? p.mode}
                    </Td>
                    <Td className="text-right tabular-nums">{p.message_count}</Td>
                    <Td className="text-muted-foreground">
                      {p.source_template_id ? (
                        <span title={p.source_template_id}>forked</span>
                      ) : (
                        <span className="opacity-50">—</span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground whitespace-nowrap">
                      {fmtDate(p.created_at)}
                    </Td>
                    <Td className="text-muted-foreground whitespace-nowrap">
                      {fmtRelative(p.updated_at)}
                    </Td>
                  </tr>
                ))}
                {stats.projects.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      No projects match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {stats.total_pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-xs text-muted-foreground">
                Page {stats.page} of {stats.total_pages}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={page >= stats.total_pages || loading}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        stats={stats}
        rangeLabel={rangeLabel}
        granularity={granularity}
        range={range}
        tableFilters={{
          owner_filter: ownerFilter || undefined,
          stage_filter: stageFilter || undefined,
          mode_filter: modeFilter || undefined,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range + granularity controls
// ---------------------------------------------------------------------------

function RangeControls({
  range,
  granularity,
  onRangeChange,
  onGranularityChange,
}: {
  range: RangeState;
  granularity: StatsGranularity;
  onRangeChange: (r: RangeState) => void;
  onGranularityChange: (g: StatsGranularity) => void;
}) {
  const today = todayIso();
  // Local draft for the custom-range inputs so a half-typed date doesn't fire
  // a query on every keystroke — committed on change of a valid pair.
  const customStart = range.kind === "custom" ? range.start : "";
  const customEnd = range.kind === "custom" ? range.end : today;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Presets */}
      <div className="flex gap-1 rounded-md border border-border bg-muted/30 p-0.5">
        {PRESETS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onRangeChange({ kind: "preset", days: opt.value })}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              range.kind === "preset" && range.days === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Custom range */}
      <div
        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 ${
          range.kind === "custom" ? "border-primary/50 bg-primary/5" : "border-border"
        }`}
      >
        <input
          type="date"
          max={today}
          value={customStart}
          onChange={(e) => {
            const start = e.target.value;
            if (!start) return;
            const end = range.kind === "custom" ? range.end : today;
            onRangeChange({ kind: "custom", start, end: end < start ? start : end });
          }}
          className="bg-transparent text-xs text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
        />
        <span className="text-muted-foreground text-xs">→</span>
        <input
          type="date"
          max={today}
          value={customEnd}
          onChange={(e) => {
            const end = e.target.value;
            if (!end) return;
            const start = range.kind === "custom" && range.start ? range.start : end;
            onRangeChange({ kind: "custom", start: start > end ? end : start, end });
          }}
          className="bg-transparent text-xs text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
        />
      </div>

      {/* Granularity */}
      <div className="flex gap-1 rounded-md border border-border bg-muted/30 p-0.5 ml-auto">
        {GRANULARITIES.map((g) => (
          <button
            key={g.value}
            onClick={() => onGranularityChange(g.value)}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              granularity === g.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export dialog
// ---------------------------------------------------------------------------

type ExportTable = "projects" | "projects_per_day" | "messages_per_day" | "by_stage" | "by_mode" | "top_owners";

const EXPORT_TABLES: { key: ExportTable; label: string }[] = [
  { key: "projects", label: "Projects (full list, respects table filters)" },
  { key: "projects_per_day", label: "Projects over time" },
  { key: "messages_per_day", label: "Messages over time" },
  { key: "by_stage", label: "Stage distribution" },
  { key: "by_mode", label: "Entry-mode breakdown" },
  { key: "top_owners", label: "Top contributors" },
];

type ExportFormat = "html" | "json" | "csv";

function ExportDialog({
  open,
  onOpenChange,
  stats,
  rangeLabel,
  granularity,
  range,
  tableFilters,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stats: Stats;
  rangeLabel: string;
  granularity: StatsGranularity;
  range: RangeState;
  tableFilters: { owner_filter?: string; stage_filter?: string; mode_filter?: string };
}) {
  const [format, setFormat] = useState<ExportFormat>("html");
  const [selected, setSelected] = useState<Set<ExportTable>>(
    new Set(EXPORT_TABLES.map((t) => t.key)),
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = (key: ExportTable) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runExport = async () => {
    setBusy(true);
    setNote(null);
    try {
      const stamp = todayIso();
      if (format === "json") {
        // One full snapshot. The `projects` array here is the current page only;
        // add a full CSV export for the complete list.
        downloadBlob(
          JSON.stringify(stats, null, 2),
          `stats-snapshot-${stamp}.json`,
          "application/json",
        );
      } else if (format === "html") {
        // Self-contained report — pull the FULL project list so it isn't just
        // the current page.
        const { projects, truncated } = await fetchAllProjects(tableFilters);
        const html = buildStatsHtml(stats, {
          rangeLabel,
          granularity,
          range,
          projects,
          filters: tableFilters,
          generatedAt: stamp,
        });
        downloadBlob(html, `stats-report-${stamp}.html`, "text/html");
        if (truncated) setNote("Project list in the report was capped at 20,000 rows.");
      } else {
        for (const key of EXPORT_TABLES.map((t) => t.key)) {
          if (!selected.has(key)) continue;
          if (key === "projects") {
            // Full list from the server (un-paginated, filter-respecting).
            const { csv, truncated } = await exportStatsProjectsCsv(tableFilters);
            downloadBlob(csv, `projects-${stamp}.csv`, "text/csv");
            if (truncated) {
              setNote("Projects export was capped at 20,000 rows.");
            }
          } else {
            downloadBlob(csvForTable(key, stats), `${key}-${stamp}.csv`, "text/csv");
          }
        }
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Export failed.");
      setBusy(false);
      return;
    }
    setBusy(false);
    onOpenChange(false);
  };

  const csvDisabled = format === "csv" && selected.size === 0;
  const FORMAT_TABS: { key: ExportFormat; label: string }[] = [
    { key: "html", label: "Report (HTML)" },
    { key: "json", label: "Snapshot (JSON)" },
    { key: "csv", label: "Tables (CSV)" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export stats</DialogTitle>
          <DialogDescription>
            Download a shareable HTML report, one JSON snapshot, or individual
            tables as CSV.
          </DialogDescription>
        </DialogHeader>

        {/* Format toggle */}
        <div className="flex gap-1 rounded-md border border-border bg-muted/30 p-0.5 w-fit">
          {FORMAT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setFormat(t.key)}
              className={`px-4 py-1.5 text-xs font-medium rounded transition-colors ${
                format === t.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {format === "html" && (
          <p className="text-xs text-muted-foreground">
            A self-contained HTML report — KPIs, charts (as SVG), breakdowns,
            top contributors, and the full project list (respecting the current
            table filters). Opens in any browser; nothing external is loaded.
          </p>
        )}
        {format === "json" && (
          <p className="text-xs text-muted-foreground">
            Exports the full stats payload — KPIs, all breakdowns, the time
            series, and the current project page — as a single JSON file. For
            the complete project list, use CSV → Projects.
          </p>
        )}
        {format === "csv" && (
          <div className="space-y-2">
            {EXPORT_TABLES.map((t) => (
              <label
                key={t.key}
                className="flex items-center gap-2.5 text-sm cursor-pointer py-0.5"
              >
                <Checkbox
                  checked={selected.has(t.key)}
                  onCheckedChange={() => toggle(t.key)}
                />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        )}

        {note && <p className="text-xs text-amber-600">{note}</p>}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={runExport} disabled={busy || csvDisabled} className="gap-1.5">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {format === "html" && "Download HTML"}
            {format === "json" && "Download JSON"}
            {format === "csv" && `Download ${selected.size} CSV${selected.size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  story: "Story",
  architecture: "Architecture",
  workshop: "Workshop",
};

function Kpi({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <div
          className={`mt-1.5 text-2xl font-semibold tabular-nums ${
            accent ? "text-green-600" : ""
          }`}
        >
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function IntervalChart({
  title,
  subtitle,
  data,
  color,
  range,
  granularity,
}: {
  title: string;
  subtitle: string;
  data: StatsDayCount[];
  color: string;
  range: RangeState;
  granularity: StatsGranularity;
}) {
  // Dense series so empty buckets render as zero bars and the x-axis stays
  // aligned to the whole window regardless of which buckets had activity.
  const dense = useMemo(
    () => fillBuckets(data, range, granularity),
    [data, range, granularity],
  );

  // Thin x-axis labels so they don't overlap. ~12 labels reads cleanly.
  const labelInterval = Math.max(0, Math.floor(dense.length / 12) - 1);
  const fmtTick = (iso: string) => fmtBucket(iso, granularity);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-[11px] text-muted-foreground tabular-nums">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dense} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
              <XAxis
                dataKey="date"
                interval={labelInterval}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={fmtTick}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={28}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  padding: "4px 8px",
                }}
                labelFormatter={(v) => fmtBucket(v as string, granularity)}
              />
              <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

type BreakdownRow = { key: string; label: string; count: number };

/**
 * A donut breakdown that cross-filters the page. Clicking a slice (or its
 * legend row) calls onSelect(key); clicking the active slice again clears it.
 * Zero-count rows are dropped from the pie but still listed in the legend so
 * the reader sees the full set of categories.
 */
function PieBreakdown({
  title,
  rows,
  activeKey,
  onSelect,
}: {
  title: string;
  rows: BreakdownRow[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const slices = rows.filter((r) => r.count > 0);
  const colorFor = (key: string) =>
    PIE_COLORS[rows.findIndex((r) => r.key === key) % PIE_COLORS.length];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {activeKey && (
            <button
              onClick={() => onSelect(activeKey)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="Clear this filter"
            >
              <X className="h-3 w-3" />
              Filtered
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No data yet.</p>
        ) : (
          <div className="flex items-center gap-4">
            {/* Donut */}
            <div className="h-40 w-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="count"
                    nameKey="label"
                    innerRadius={40}
                    outerRadius={70}
                    paddingAngle={1}
                    isAnimationActive={false}
                    onClick={(d: unknown) => {
                      const key = (d as { payload?: BreakdownRow })?.payload?.key;
                      if (key) onSelect(key);
                    }}
                  >
                    {slices.map((s) => {
                      const dim = activeKey && activeKey !== s.key;
                      return (
                        <Cell
                          key={s.key}
                          fill={colorFor(s.key)}
                          fillOpacity={dim ? 0.3 : 1}
                          stroke={activeKey === s.key ? "var(--foreground)" : "var(--background)"}
                          strokeWidth={activeKey === s.key ? 2 : 1}
                          className="cursor-pointer outline-none"
                        />
                      );
                    })}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                      padding: "4px 8px",
                    }}
                    formatter={((v: unknown, _n: unknown, p: { payload?: BreakdownRow }) => {
                      const n = Number(v) || 0;
                      return [`${n} (${Math.round((n / total) * 100)}%)`, p.payload?.label ?? ""];
                    }) as never}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Legend (clickable) */}
            <div className="flex-1 space-y-1 min-w-0">
              {rows.map((r) => {
                const dim = activeKey && activeKey !== r.key;
                return (
                  <button
                    key={r.key}
                    onClick={() => onSelect(r.key)}
                    className={`flex items-center gap-2 w-full text-left text-xs py-1 px-1.5 rounded hover:bg-muted/50 transition-opacity ${
                      dim ? "opacity-40" : ""
                    }`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
                      style={{ background: colorFor(r.key) }}
                    />
                    <span className="font-medium truncate flex-1">{r.label}</span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {r.count}
                      <span className="ml-1 opacity-60">
                        {total ? Math.round((r.count / total) * 100) : 0}%
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`text-left font-medium px-3 py-2 ${className}`}>{children}</th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

function todayIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Build a gap-free bucket series over the active window at the given
 * granularity, so missing buckets show as zeros and the axis is stable.
 *
 * Buckets are keyed by their start date in UTC to match the backend's
 * date_trunc output: day = each day, week = each ISO-Monday, month = each 1st.
 */
function fillBuckets(
  data: StatsDayCount[],
  range: RangeState,
  granularity: StatsGranularity,
): StatsDayCount[] {
  const byDate = new Map(data.map((d) => [d.date, d.count]));

  // Resolve the [start, end] window (UTC midnights) from the range state.
  const endMs =
    range.kind === "custom" ? isoToUtcMs(range.end) : isoToUtcMs(todayIso());
  const startMs =
    range.kind === "custom"
      ? isoToUtcMs(range.start)
      : endMs - (range.days - 1) * DAY_MS;

  const out: StatsDayCount[] = [];
  let cursor = truncBucketMs(startMs, granularity);
  const endBucket = truncBucketMs(endMs, granularity);
  // Guard against pathological ranges producing an unbounded loop.
  let guard = 0;
  while (cursor <= endBucket && guard++ < 5000) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
    cursor = advanceBucketMs(cursor, granularity);
  }
  return out;
}

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

// Truncate a UTC ms timestamp to its bucket start (matches Postgres date_trunc).
function truncBucketMs(ms: number, g: StatsGranularity): number {
  const d = new Date(ms);
  if (g === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (g === "week") {
    // date_trunc('week') → Monday. getUTCDay: 0=Sun..6=Sat.
    const dow = d.getUTCDay();
    const backToMon = (dow + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - backToMon * DAY_MS;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function advanceBucketMs(ms: number, g: StatsGranularity): number {
  const d = new Date(ms);
  if (g === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  if (g === "week") return ms + 7 * DAY_MS;
  return ms + DAY_MS;
}

function fmtBucket(iso: string, g: StatsGranularity): string {
  const d = new Date(iso);
  if (g === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDate(iso);
}

// ── CSV helpers ────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvFromRows(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

function csvForTable(key: ExportTable, stats: Stats): string {
  switch (key) {
    case "projects_per_day":
      return csvFromRows(["date", "count"], stats.projects_per_day.map((d) => [d.date, d.count]));
    case "messages_per_day":
      return csvFromRows(["date", "count"], stats.messages_per_day.map((d) => [d.date, d.count]));
    case "by_stage":
      return csvFromRows(["stage", "count"], stats.by_stage.map((s) => [s.stage, s.count]));
    case "by_mode":
      return csvFromRows(["mode", "count"], stats.by_mode.map((m) => [m.mode, m.count]));
    case "top_owners":
      return csvFromRows(
        ["user_email", "project_count", "last_active"],
        stats.top_owners.map((o) => [o.user_email, o.project_count, o.last_active ?? ""]),
      );
    case "projects":
      // Handled via the server export path; fall back to the current page.
      return csvFromRows(
        ["id", "name", "user_email", "stage", "mode", "message_count", "created_at", "updated_at"],
        stats.projects.map((p) => [
          p.id, p.name, p.user_email, p.stage, p.mode, p.message_count, p.created_at, p.updated_at,
        ]),
      );
  }
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── HTML report ──────────────────────────────────────────────────────────

type ExportProjectRow = Record<string, string>;

/**
 * Pull the complete (filter-respecting) project list via the CSV export
 * endpoint and parse it back into row objects for the HTML report.
 */
async function fetchAllProjects(
  filters: { owner_filter?: string; stage_filter?: string; mode_filter?: string },
): Promise<{ projects: ExportProjectRow[]; truncated: boolean }> {
  const { csv, truncated } = await exportStatsProjectsCsv(filters);
  return { projects: parseCsv(csv), truncated };
}

/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, embedded newlines). */
function parseCsv(text: string): ExportProjectRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj: ExportProjectRow = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ""; });
    return obj;
  });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

/** Render one breakdown as an inline SVG donut + a legend list. */
function svgDonut(rows: BreakdownRow[], colors: string[]): string {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const cx = 80, cy = 80, r = 64, rin = 36;
  if (total === 0) return `<p class="muted">No data yet.</p>`;
  let angle = -Math.PI / 2;
  const paths: string[] = [];
  rows.forEach((row, i) => {
    if (row.count === 0) return;
    const frac = row.count / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    // Full-circle guard: a single 100% slice can't be drawn as an arc.
    if (frac >= 0.9999) {
      paths.push(
        `<circle cx="${cx}" cy="${cy}" r="${(r + rin) / 2}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="${r - rin}"/>`,
      );
      return;
    }
    const p = (rad: number, radius: number) => [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
    const [x0, y0] = p(a0, r);
    const [x1, y1] = p(a1, r);
    const [x2, y2] = p(a1, rin);
    const [x3, y3] = p(a0, rin);
    paths.push(
      `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rin} ${rin} 0 ${large} 0 ${x3} ${y3} Z" fill="${colors[i % colors.length]}"/>`,
    );
  });
  const legend = rows
    .map(
      (row, i) =>
        `<div class="legend-row"><span class="swatch" style="background:${colors[i % colors.length]}"></span><span class="legend-label">${esc(row.label)}</span><span class="legend-val">${row.count} · ${Math.round((row.count / total) * 100)}%</span></div>`,
    )
    .join("");
  return `<div class="donut-wrap"><svg width="160" height="160" viewBox="0 0 160 160">${paths.join("")}</svg><div class="legend">${legend}</div></div>`;
}

/** Render a per-interval series as an inline SVG bar chart. */
function svgBars(data: StatsDayCount[], color: string): string {
  if (data.length === 0) return `<p class="muted">No data.</p>`;
  const W = 560, H = 140, pad = 20;
  const max = Math.max(...data.map((d) => d.count), 1);
  const bw = (W - pad * 2) / data.length;
  const bars = data
    .map((d, i) => {
      const h = (d.count / max) * (H - pad * 2);
      const x = pad + i * bw;
      const y = H - pad - h;
      return `<rect x="${x + bw * 0.1}" y="${y}" width="${bw * 0.8}" height="${h}" fill="${color}" rx="1"><title>${esc(d.date)}: ${d.count}</title></rect>`;
    })
    .join("");
  // A few axis labels.
  const step = Math.max(1, Math.floor(data.length / 8));
  const labels = data
    .map((d, i) =>
      i % step === 0
        ? `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" font-size="9" text-anchor="middle" fill="#888">${esc(d.date.slice(5))}</text>`
        : "",
    )
    .join("");
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><text x="${pad}" y="12" font-size="9" fill="#888">max ${max}</text>${bars}${labels}</svg>`;
}

/** Build a self-contained, dependency-free HTML report of the current stats. */
function buildStatsHtml(
  stats: Stats,
  opts: {
    rangeLabel: string;
    granularity: StatsGranularity;
    range: RangeState;
    projects: ExportProjectRow[];
    filters: { owner_filter?: string; stage_filter?: string; mode_filter?: string };
    generatedAt: string;
  },
): string {
  const kpis: [string, number][] = [
    ["Projects", stats.total_projects],
    ["Unique users", stats.total_users],
    ["Messages", stats.total_messages],
    ["New (7d)", stats.projects_last_7d],
    ["New (30d)", stats.projects_last_30d],
    ["Live runs", stats.active_executions],
  ];
  const kpiHtml = kpis
    .map(
      ([label, v]) =>
        `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-val">${v.toLocaleString()}</div></div>`,
    )
    .join("");

  const projDense = fillBuckets(stats.projects_per_day, opts.range, opts.granularity);
  const msgDense = fillBuckets(stats.messages_per_day, opts.range, opts.granularity);

  const stageRows: BreakdownRow[] = stats.by_stage.map((s) => ({ key: s.stage, label: s.stage, count: s.count }));
  const modeRows: BreakdownRow[] = stats.by_mode.map((m) => ({
    key: m.mode,
    label: MODE_LABELS[m.mode] ?? m.mode,
    count: m.count,
  }));

  const ownerHtml = stats.top_owners
    .map(
      (o) =>
        `<tr><td>${esc(o.user_email)}</td><td class="num">${o.project_count}</td><td>${o.last_active ? esc(o.last_active.slice(0, 10)) : "—"}</td></tr>`,
    )
    .join("");

  const projHtml = opts.projects
    .map(
      (p) =>
        `<tr><td>${esc(p.name)}</td><td>${esc(p.user_email)}</td><td>${esc(p.stage)}</td><td>${esc(p.mode)}</td><td class="num">${esc(p.message_count)}</td><td>${esc((p.created_at || "").slice(0, 10))}</td><td>${esc((p.updated_at || "").slice(0, 10))}</td></tr>`,
    )
    .join("");

  const palette = ["#2f6fdb", "#1fa8a0", "#6a52c9", "#4a9de0", "#2fa876"];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage stats — ${esc(opts.generatedAt)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f7f8fa; color: #1a1a1a; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 12px; }
  .sub { color: #667; font-size: 13px; margin: 0 0 4px; }
  .card { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-top: 20px; }
  .kpi { background:#fff; border:1px solid #e4e7ec; border-radius:10px; padding:14px; }
  .kpi-label { color:#667; font-size:12px; }
  .kpi-val { font-size:24px; font-weight:600; margin-top:4px; font-variant-numeric: tabular-nums; }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  .donut-wrap { display:flex; align-items:center; gap:16px; }
  .legend { flex:1; }
  .legend-row { display:flex; align-items:center; gap:8px; font-size:12px; padding:2px 0; }
  .swatch { width:11px; height:11px; border-radius:3px; display:inline-block; }
  .legend-label { flex:1; font-weight:500; }
  .legend-val { color:#667; font-variant-numeric: tabular-nums; }
  table { width:100%; border-collapse: collapse; font-size:12px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid #eef0f3; }
  th { color:#667; font-weight:600; background:#fafbfc; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
  .muted { color:#889; font-size:12px; }
  .filters { font-size:12px; color:#667; margin-top:6px; }
  .tag { display:inline-block; background:#eef2fb; color:#2f6fdb; border-radius:5px; padding:1px 7px; margin-right:6px; }
  footer { margin-top:40px; color:#99a; font-size:11px; }
</style></head>
<body><div class="wrap">
  <h1>Usage stats</h1>
  <p class="sub">Aggregate project + agent activity across all users.</p>
  <p class="sub">Range: <strong>${esc(opts.rangeLabel)}</strong> · bucketed by ${esc(opts.granularity)} · generated ${esc(opts.generatedAt)}</p>
  ${tableFilterTags(opts.filters)}

  <div class="kpis">${kpiHtml}</div>

  <h2>Activity</h2>
  <div class="grid2">
    <div class="card"><div class="sub">Projects created</div>${svgBars(projDense, palette[0])}</div>
    <div class="card"><div class="sub">Messages</div>${svgBars(msgDense, palette[1])}</div>
  </div>

  <h2>Breakdowns</h2>
  <div class="grid2">
    <div class="card"><div class="sub">Stage distribution</div>${svgDonut(stageRows, palette)}</div>
    <div class="card"><div class="sub">Entry mode</div>${svgDonut(modeRows, palette)}</div>
  </div>

  <h2>Top contributors (${stats.top_owners.length})</h2>
  <div class="card"><table><thead><tr><th>Owner</th><th class="num">Projects</th><th>Last active</th></tr></thead><tbody>${ownerHtml || `<tr><td colspan="3" class="muted">No data.</td></tr>`}</tbody></table></div>

  <h2>Projects (${opts.projects.length.toLocaleString()})</h2>
  <div class="card"><table><thead><tr><th>Name</th><th>Owner</th><th>Stage</th><th>Mode</th><th class="num">Msgs</th><th>Created</th><th>Updated</th></tr></thead><tbody>${projHtml || `<tr><td colspan="7" class="muted">No projects match.</td></tr>`}</tbody></table></div>

  <footer>Generated from the Databricks Solution Builder usage dashboard.</footer>
</div></body></html>`;
}

function tableFilterTags(filters: {
  owner_filter?: string;
  stage_filter?: string;
  mode_filter?: string;
}): string {
  const chips: string[] = [];
  if (filters.owner_filter) chips.push(`owner: ${esc(filters.owner_filter)}`);
  if (filters.stage_filter) chips.push(`stage: ${esc(filters.stage_filter)}`);
  if (filters.mode_filter) chips.push(`mode: ${esc(filters.mode_filter)}`);
  if (chips.length === 0) return "";
  return `<p class="filters">Project list filtered by ${chips.map((c) => `<span class="tag">${c}</span>`).join("")}</p>`;
}
