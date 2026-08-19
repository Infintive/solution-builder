/**
 * Grounding table picker — home-page panel shown when "Use synthetic data" is
 * OFF. The user picks catalogs → schemas → the real Unity Catalog tables to
 * GROUND the demo in. Only table NAMES are read here (metadata, never data);
 * the backend reads column metadata into specifications/source-tables.md at create.
 *
 * Catalogs and schemas are both MULTI-select and browsable: each dropdown
 * loads its list up-front (the `browse` flag on listCatalogs/listSchemas) so
 * the user clicks rather than types, and typing filters server-side. Schemas
 * are held catalog-qualified ("catalog.schema") so selections across different
 * catalogs can't collide. The table list is fetched per selected schema and
 * rendered grouped, with one flat cap across all groups.
 */

import { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import {
  Search,
  RefreshCw,
  X,
  ChevronDown,
  Check,
  ExternalLink,
} from "lucide-react";
import {
  listCatalogs,
  listSchemas,
  listTables,
  getWorkspaceInfo,
  ucExploreUrl,
  type WorkspaceInfo,
} from "@/lib/custom-api";
import { cn } from "@/lib/utils";

/** Cap on how many schemas we'll fan out table-list requests for at once. */
const MAX_BROWSED_SCHEMAS = 10;

/** How many picked tables the demo actually profiles + builds on. Mirrors the
 *  backend `table_stats.MAX_TABLES` (kept in sync by hand); it only drives the
 *  warning below, so minor drift just shifts when the note appears — it never
 *  blocks selection. */
const MAX_GROUNDING_TABLES = 40;

interface GroundingTablePickerProps {
  /** Selected catalog names. */
  catalogs: string[];
  /** Selected schemas, catalog-qualified as "catalog.schema". */
  schemas: string[];
  /** Fully-qualified selected tables (catalog.schema.table). */
  selectedTables: string[];
  onCatalogsChange: (catalogs: string[]) => void;
  onSchemasChange: (schemas: string[]) => void;
  onSelectedTablesChange: (tables: string[]) => void;
}

/** One optionally-headed run of options. A single header-less section is the
 *  flat case (catalogs, schemas); the table picker passes one per schema. */
interface OptionSection {
  /** Omit for a flat list; set to render a sticky group header. */
  header?: string;
  options: string[];
}

/** A multi-select dropdown over one or more option sections, with
 *  server-side filtering and an optional per-option disabled rule. */
function MultiSelectDropdown({
  label,
  placeholder,
  emptyHint,
  disabled,
  sections,
  selected,
  isLoading,
  filter,
  onFilterChange,
  onToggle,
  /** Renders an option's display text (selections may be qualified names). */
  renderOption = (o: string) => o,
  /** Greys out and blocks an unselected option (used for the table cap). */
  isOptionDisabled,
  /** Per-option "view in workspace" URL; null hides the link for that row. */
  hrefFor,
  /** Extra line under the option list (e.g. a cap notice). */
  footer,
  /** When set, renders a "select all" checkbox to the left of the search box
   *  that toggles ALL currently-listed (filtered) options at once. */
  onSelectAll,
}: {
  label: string;
  placeholder: string;
  emptyHint: string;
  disabled?: boolean;
  sections: OptionSection[];
  selected: string[];
  isLoading?: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  onToggle: (value: string) => void;
  renderOption?: (option: string) => string;
  isOptionDisabled?: (option: string) => boolean;
  hrefFor?: (option: string) => string | null;
  footer?: React.ReactNode;
  onSelectAll?: (options: string[], allSelected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  // The menu is PORTALED (position:fixed) so the dialog's overflow-y-auto can't
  // clip it. We portal into the nearest [role="dialog"] ancestor (NOT document.
  // body) — a Radix Dialog traps pointer/focus to its own subtree, so a menu on
  // <body> would be click-through-dead. Falls back to body outside any dialog.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // Menu position, expressed RELATIVE TO the portal target's own box (not the
  // viewport): the target may be the Radix DialogContent, which carries a
  // `translate(-50%,-50%)` transform — and a CSS transform makes even
  // position:fixed resolve against that ancestor, so viewport coords would be
  // offset. We therefore use position:absolute inside the target and subtract
  // the target's rect. `up` = the menu's bottom is anchored to the trigger top.
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
  } | null>(null);

  // Recompute the menu's position from the trigger's rect, relative to the
  // portal target's rect (so it's correct even inside a transformed dialog).
  const positionMenu = () => {
    const el = triggerRef.current;
    const target =
      triggerRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const base = target.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const dropUp = spaceBelow < 280 && r.top > spaceBelow;
    setMenuPos({
      left: r.left - base.left,
      width: r.width,
      ...(dropUp
        ? { bottom: base.bottom - r.top + 4 }
        : { top: r.bottom - base.top + 4 }),
    });
  };

  // Keep the portaled menu glued to the trigger while open (scroll/resize).
  useLayoutEffect(() => {
    if (!open) return;
    // Portal into the enclosing dialog (so Radix's focus/pointer trap includes
    // the menu); fall back to <body> when not inside a dialog.
    const dialog = triggerRef.current?.closest<HTMLElement>('[role="dialog"]');
    setPortalTarget(dialog ?? document.body);
    positionMenu();
    // Focus the filter so the user can type immediately. Deferred a frame so it
    // wins against the dialog's focus scope trying to pull focus back.
    const focusTimer = window.setTimeout(() => filterInputRef.current?.focus(), 0);
    const onMove = () => positionMenu();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled OUTSIDE wrapRef, so check both the trigger wrap
      // and the menu itself before treating a click as "outside".
      if (
        wrapRef.current && !wrapRef.current.contains(t) &&
        menuRef.current && !menuRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop the home page's own Escape handling (collapsing the hero) from
        // also firing — closing the dropdown is the expected scope here.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const totalOptions = sections.reduce((n, s) => n + s.options.length, 0);

  // Collapsing to a count keeps the trigger from growing unboundedly; the
  // chips below the control are the authoritative view of what's selected.
  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? renderOption(selected[0])
        : `${selected.length} selected`;

  return (
    <div className="space-y-1" ref={wrapRef}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <button
          type="button"
          ref={triggerRef}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-input",
            "bg-background px-3 py-2 text-sm shadow-xs transition-colors cursor-pointer",
            "hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            disabled && "cursor-not-allowed opacity-50 hover:bg-background",
          )}
        >
          <span
            className={cn(
              "truncate text-left",
              (selected.length === 0 || isLoading) && "text-muted-foreground",
            )}
          >
            {/* When loading with nothing picked yet, say what's loading (rather
                than a bare "Select …" next to a spinner) — the catalog list is a
                UC metadata call that can take a few seconds on a big metastore. */}
            {disabled
              ? emptyHint
              : isLoading && selected.length === 0
                ? `Loading ${label.toLowerCase()}…`
                : summary}
          </span>
          {isLoading ? (
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          )}
        </button>

        {open && !disabled && menuPos && portalTarget && createPortal(
          <div
            ref={menuRef}
            style={{
              position: "absolute",
              left: menuPos.left,
              width: menuPos.width,
              ...(menuPos.top !== undefined ? { top: menuPos.top } : {}),
              ...(menuPos.bottom !== undefined ? { bottom: menuPos.bottom } : {}),
            }}
            className="z-[60] overflow-hidden rounded-md border border-border bg-popover shadow-md"
          >
            <div className="flex items-center gap-2 border-b border-border p-2">
              {onSelectAll && (() => {
                // Select-all toggles every currently-LISTED (filtered) option.
                const listed = sections.flatMap((s) => s.options);
                const allSelected =
                  listed.length > 0 && listed.every((o) => selected.includes(o));
                return (
                  <button
                    type="button"
                    onClick={() => onSelectAll(listed, allSelected)}
                    disabled={listed.length === 0}
                    aria-label={allSelected ? "Deselect all tables" : "Select all tables"}
                    title={allSelected ? "Deselect all" : "Select all"}
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      allSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input hover:border-primary",
                      listed.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                    )}
                  >
                    {allSelected && <Check className="h-3 w-3" />}
                  </button>
                );
              })()}
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={filterInputRef}
                  value={filter}
                  onChange={(e) => onFilterChange(e.target.value)}
                  placeholder="Filter…"
                  className="h-8 pl-7 text-sm"
                />
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {isLoading && totalOptions === 0 && (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  Loading {label.toLowerCase()}…
                </p>
              )}
              {totalOptions === 0 && !isLoading && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {filter ? "No matches." : emptyHint}
                </p>
              )}
              {sections.map((section, i) => (
                <div key={section.header ?? `section-${i}`}>
                  {section.header && section.options.length > 0 && (
                    <div className="sticky top-0 bg-muted/80 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
                      {section.header}
                    </div>
                  )}
                  {section.options.map((o) => {
                    const checked = selected.includes(o);
                    const optDisabled = !checked && !!isOptionDisabled?.(o);
                    const href = hrefFor?.(o) ?? null;
                    // A link can't nest in the toggle <button>, so the row is a
                    // flex container: the button fills it, the link sits beside.
                    return (
                      <div
                        key={o}
                        className="group/opt flex w-full items-center transition-colors hover:bg-accent"
                      >
                        <button
                          type="button"
                          disabled={optDisabled}
                          onClick={() => onToggle(o)}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm",
                            optDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input",
                            )}
                          >
                            {checked && <Check className="h-3 w-3" />}
                          </span>
                          <span className="truncate">{renderOption(o)}</span>
                        </button>
                        {href && (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              "mr-2 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity",
                              "hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/opt:opacity-100",
                            )}
                            aria-label={`View ${o} in the workspace`}
                            title="View in workspace"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {footer}
          </div>,
          portalTarget,
        )}
      </div>
    </div>
  );
}

/** Removable chip row for a set of selections. When `hrefFor` returns a URL
 *  for a value, the chip also shows a "view in workspace" link icon that opens
 *  Catalog Explorer for that asset in a new tab. */
function ChipRow({
  values,
  onRemove,
  render = (v: string) => v,
  hrefFor,
}: {
  values: string[];
  onRemove: (value: string) => void;
  render?: (value: string) => string;
  hrefFor?: (value: string) => string | null;
}) {
  if (values.length === 0) return null;
  return (
    // Cap the height + scroll IN PLACE so a large selection (many schemas or
    // dozens of tables) doesn't push the controls below it off the dialog — each
    // chip group (catalogs / schemas / tables) stays compact and scrolls itself.
    <div className="flex max-h-28 flex-wrap content-start gap-1.5 overflow-y-auto">
      {values.map((v) => {
        const href = hrefFor?.(v) ?? null;
        return (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
          >
            <span className="max-w-[220px] truncate">{render(v)}</span>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="opacity-60 hover:opacity-100"
                aria-label={`View ${v} in the workspace`}
                title="View in workspace"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <button
              type="button"
              onClick={() => onRemove(v)}
              className="hover:text-foreground"
              aria-label={`Remove ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function GroundingTablePicker({
  catalogs,
  schemas,
  selectedTables,
  onCatalogsChange,
  onSchemasChange,
  onSelectedTablesChange,
}: GroundingTablePickerProps) {
  const [catalogFilter, setCatalogFilter] = useState("");
  const [schemaFilter, setSchemaFilter] = useState("");
  const [tableFilter, setTableFilter] = useState("");

  const [catalogOptions, setCatalogOptions] = useState<string[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  /** schema-qualified key ("catalog.schema") → its table names. */
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, string[]>>({});

  const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(false);
  const [isLoadingSchemas, setIsLoadingSchemas] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);

  // Connected workspace host + id, fetched once, so each selected asset can
  // link out to Catalog Explorer. Best-effort: on failure the links just
  // don't render (ucExploreUrl returns null).
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    getWorkspaceInfo()
      .then((info) => {
        if (!cancelled) setWorkspaceInfo(info);
      })
      .catch((error) => console.error("Failed to get workspace info:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  // Catalogs: browse up-front, then filter server-side as the user types.
  useEffect(() => {
    const timer = setTimeout(async () => {
      setIsLoadingCatalogs(true);
      try {
        // selectableOnly: only catalogs the user can actually build on (they
        // hold effective USE) — the demo queries as the user, not the app SP.
        setCatalogOptions(
          await listCatalogs(catalogFilter.trim() || undefined, true, true),
        );
      } catch (error) {
        console.error("Failed to list catalogs:", error);
      } finally {
        setIsLoadingCatalogs(false);
      }
    }, catalogFilter ? 200 : 0);
    return () => clearTimeout(timer);
  }, [catalogFilter]);

  // Schemas: union across every selected catalog, held catalog-qualified so
  // same-named schemas in different catalogs stay distinct.
  const catalogsKey = catalogs.join(",");
  useEffect(() => {
    if (catalogs.length === 0) {
      setSchemaOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoadingSchemas(true);
      try {
        const q = schemaFilter.trim() || undefined;
        const perCatalog = await Promise.all(
          catalogs.map(async (c) => {
            try {
              return (await listSchemas(c, q, true, true)).map((s) => `${c}.${s}`);
            } catch (error) {
              console.error(`Failed to list schemas for ${c}:`, error);
              return [];
            }
          }),
        );
        if (!cancelled) setSchemaOptions(perCatalog.flat().sort());
      } finally {
        if (!cancelled) setIsLoadingSchemas(false);
      }
    }, schemaFilter ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // catalogsKey stands in for the catalogs array (stable string identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogsKey, schemaFilter]);

  // Tables: one request per selected schema, merged into a per-schema map so
  // the list can render grouped. The filter narrows each request server-side.
  const schemasKey = schemas.join(",");
  useEffect(() => {
    if (schemas.length === 0) {
      setTablesBySchema({});
      setTablesError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoadingTables(true);
      setTablesError(null);
      const q = tableFilter.trim() || undefined;
      let anyFailed = false;
      const entries = await Promise.all(
        schemas.slice(0, MAX_BROWSED_SCHEMAS).map(async (qualified) => {
          // Split on the FIRST dot only: catalog names can't contain dots but
          // this keeps the schema half intact regardless.
          const dot = qualified.indexOf(".");
          const c = qualified.slice(0, dot);
          const s = qualified.slice(dot + 1);
          try {
            return [qualified, await listTables(c, s, q, true)] as const;
          } catch (error) {
            console.error(`Failed to list tables for ${qualified}:`, error);
            anyFailed = true;
            return [qualified, []] as const;
          }
        }),
      );
      if (cancelled) return;
      setTablesBySchema(Object.fromEntries(entries));
      if (anyFailed) {
        setTablesError(
          "Couldn't list tables for some schemas. The app's service principal " +
            "may need read access to them.",
        );
      }
      setIsLoadingTables(false);
    }, tableFilter ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // schemasKey stands in for the schemas array (stable string identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemasKey, tableFilter]);

  const toggleCatalog = (c: string) => {
    if (catalogs.includes(c)) {
      // Dropping a catalog must drop its schemas and their selected tables,
      // or we'd submit tables the user can no longer see.
      onCatalogsChange(catalogs.filter((x) => x !== c));
      onSchemasChange(schemas.filter((s) => !s.startsWith(`${c}.`)));
      onSelectedTablesChange(selectedTables.filter((t) => !t.startsWith(`${c}.`)));
    } else {
      onCatalogsChange([...catalogs, c]);
    }
  };

  const toggleSchema = (qualified: string) => {
    if (schemas.includes(qualified)) {
      onSchemasChange(schemas.filter((x) => x !== qualified));
      onSelectedTablesChange(
        selectedTables.filter((t) => !t.startsWith(`${qualified}.`)),
      );
    } else {
      onSchemasChange([...schemas, qualified]);
    }
  };

  const toggleTable = (fq: string) => {
    if (selectedTables.includes(fq)) {
      onSelectedTablesChange(selectedTables.filter((t) => t !== fq));
    } else {
      onSelectedTablesChange([...selectedTables, fq]);
    }
  };

  // One section per selected schema, in the order the user picked them. Option
  // VALUES are fully qualified so a bare table name appearing in two schemas
  // stays distinct; the header (shown only with >1 schema) supplies context.
  const tableSections = useMemo<OptionSection[]>(
    () =>
      schemas
        .filter((s) => (tablesBySchema[s]?.length ?? 0) > 0)
        .map((s) => ({
          header: schemas.length > 1 ? s : undefined,
          options: (tablesBySchema[s] ?? []).map((t) => `${s}.${t}`),
        })),
    [schemas, tablesBySchema],
  );

  return (
    // No header/box here — the picker lives in a standalone dialog that supplies
    // the "Ground this demo…" title + description (see index.tsx). Kept flush so
    // it isn't a box-in-a-box.
    <div className="space-y-4 text-left">
      <p className="text-xs text-muted-foreground">
        Showing only catalogs, schemas, and tables you can query — the demo is
        built on your access.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <MultiSelectDropdown
            label="Catalogs"
            placeholder="Select catalogs…"
            emptyHint="No catalogs you can query."
            sections={[{ options: catalogOptions }]}
            selected={catalogs}
            isLoading={isLoadingCatalogs}
            filter={catalogFilter}
            onFilterChange={setCatalogFilter}
            onToggle={toggleCatalog}
            hrefFor={(c) => ucExploreUrl(workspaceInfo, [c])}
          />
          <ChipRow
            values={catalogs}
            onRemove={toggleCatalog}
            hrefFor={(c) => ucExploreUrl(workspaceInfo, [c])}
          />
        </div>

        <div className="space-y-1.5">
          <MultiSelectDropdown
            label="Schemas"
            placeholder="Select schemas…"
            emptyHint={
              catalogs.length === 0 ? "Pick a catalog first" : "No schemas you can query."
            }
            disabled={catalogs.length === 0}
            sections={[{ options: schemaOptions }]}
            selected={schemas}
            isLoading={isLoadingSchemas}
            filter={schemaFilter}
            onFilterChange={setSchemaFilter}
            onToggle={toggleSchema}
            // Qualified internally; show the bare schema name when a single
            // catalog is in play, since the prefix is then redundant.
            renderOption={(s) =>
              catalogs.length > 1 ? s : s.slice(s.indexOf(".") + 1)
            }
            hrefFor={(s) => {
              const dot = s.indexOf(".");
              return ucExploreUrl(workspaceInfo, [s.slice(0, dot), s.slice(dot + 1)]);
            }}
          />
          <ChipRow
            values={schemas}
            onRemove={toggleSchema}
            render={(s) => (catalogs.length > 1 ? s : s.slice(s.indexOf(".") + 1))}
            hrefFor={(s) => {
              // Qualified "catalog.schema" — split on the FIRST dot.
              const dot = s.indexOf(".");
              return ucExploreUrl(workspaceInfo, [s.slice(0, dot), s.slice(dot + 1)]);
            }}
          />
        </div>
      </div>

      {schemas.length > MAX_BROWSED_SCHEMAS && (
        <p className="text-xs text-muted-foreground">
          Showing tables from the first {MAX_BROWSED_SCHEMAS} selected schemas.
        </p>
      )}

      {/* Tables — same dropdown, one section per selected schema. Full width:
          the options are bare table names but the chips below are qualified. */}
      <div className="space-y-1.5">
        <MultiSelectDropdown
          label="Tables"
          placeholder="Select tables…"
          emptyHint={
            schemas.length === 0
              ? "Pick a schema first"
              : "No tables here you can query."
          }
          disabled={schemas.length === 0}
          sections={tableSections}
          selected={selectedTables}
          isLoading={isLoadingTables}
          filter={tableFilter}
          onFilterChange={setTableFilter}
          onToggle={toggleTable}
          onSelectAll={(listed, allSelected) => {
            if (allSelected) {
              // Deselect every listed table (keep selections from other,
              // now-unlisted schemas untouched).
              onSelectedTablesChange(
                selectedTables.filter((t) => !listed.includes(t)),
              );
            } else {
              // Select every listed table (deduped).
              onSelectedTablesChange([
                ...selectedTables,
                ...listed.filter((t) => !selectedTables.includes(t)),
              ]);
            }
          }}
          // Options are fully-qualified values, but the group header already
          // carries the catalog.schema — so always show just the table name.
          // (The chips below stay fully qualified.)
          renderOption={(fq) => fq.slice(fq.lastIndexOf(".") + 1)}
          hrefFor={(fq) => {
            const parts = fq.split(".");
            return parts.length === 3 ? ucExploreUrl(workspaceInfo, parts) : null;
          }}
        />
        {tablesError && <p className="text-xs text-destructive">{tablesError}</p>}
        {/* Selected tables — always fully qualified, across all groups */}
        <ChipRow
          values={selectedTables}
          onRemove={toggleTable}
          hrefFor={(fq) => {
            // "catalog.schema.table" — catalog/schema names can't contain
            // dots, so the first two dots split it cleanly.
            const parts = fq.split(".");
            return parts.length === 3 ? ucExploreUrl(workspaceInfo, parts) : null;
          }}
        />
        {/* Honest, non-blocking cap notice — selecting a whole schema (dozens of
            tables) is fine, but we only profile + build on the first N, so say so
            rather than silently clipping. */}
        {selectedTables.length > MAX_GROUNDING_TABLES && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            You've selected {selectedTables.length} tables — the demo will profile and
            build on the first {MAX_GROUNDING_TABLES}. Narrow your pick to the tables
            that matter for a more focused demo.
          </p>
        )}
      </div>
    </div>
  );
}
