"""Table stats scan + process-level cache — grounds the suggest stream in real data.

When a user chooses "Use existing data" on the home page and picks real Unity
Catalog tables, we scan those tables ONCE (schema + a per-column profile + a few
sample rows) and cache the result in memory. The suggest endpoint then injects
that scan into the LLM prompt so the proposed story is grounded in the actual
data — real ranges, cardinalities, null rates, and dominant categorical values.

Per table the scan runs, at most:
  1. one `SELECT * … LIMIT N`  → column schema + sample rows,
  2. one wide aggregate query  → per-column distinct/null/min/max (+ mean/stddev/
     quartiles for numerics), all columns in a single pass,
  3. a bounded set of small `GROUP BY` value-counts for LOW-cardinality
     string/bool/date columns (top-N frequent values).
All use APPROX functions and cap columns (MAX_COLUMNS_PER_TABLE) so a wide fact
table can't blow the query cost or the prompt budget.

Runs as the app service principal (OBO tokens can't run warehouse queries on
Databricks Apps — see `Dependencies` docs), on a warehouse resolved by
`routes.resources.pick_query_warehouse`.

The cache is a process-level TTL dict (like `PreviewRegistry` / the resource
cache) — good enough for a single-replica pre-create scan; not persisted, not
shared across replicas.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Iterator

from databricks.sdk import WorkspaceClient

from ..core._config import logger

# Bounds so a wide warehouse table can't blow the prompt budget or query cost.
# Also the SINGLE source of truth for "how many picked tables we build the demo
# on" — the source-tables.md writer imports this so the scan, the LLM profile,
# and the durable record all agree (no silent 20-vs-15 mismatch). Scanning is
# parallel now, so a larger cap stays fast; the ceiling is really the LLM prompt
# size for the suggest step.
MAX_TABLES = 40
MAX_COLUMNS_PER_TABLE = 40
SAMPLE_ROWS = 4

# Top-N frequent values are collected only for LOW-cardinality categorical
# columns, and only for the first few such columns per table (each is its own
# GROUP BY query, so this bounds the fan-out).
TOP_VALUES_N = 5
MAX_DISTINCT_FOR_TOP_VALUES = 50
MAX_TOP_VALUE_COLUMNS = 8

# How long a scanned table's stats stay warm. A pre-create scan is short-lived;
# 30 min comfortably covers "pick tables → generate a story → refine".
CACHE_TTL_SECONDS = 30 * 60

# Guard rails for the query itself.
_QUERY_TIMEOUT = "50s"

# Type buckets (matched against the lower-cased type_text prefix).
_NUMERIC_PREFIXES = (
    "tinyint", "smallint", "int", "bigint", "float", "double", "decimal", "numeric",
)
_TEMPORAL_PREFIXES = ("date", "timestamp")
_CATEGORICAL_PREFIXES = ("string", "char", "varchar", "boolean")


@dataclass
class ColumnStat:
    """A per-column profile for one table.

    Everything beyond `name`/`type_text` is best-effort — a field stays None when
    it doesn't apply to the type or the profiling query failed. Values are kept
    as strings (the warehouse casts them) so rendering is uniform."""

    name: str
    type_text: str = ""
    distinct: int | None = None
    null_frac: float | None = None
    min_val: str | None = None
    max_val: str | None = None
    mean_val: str | None = None
    stddev_val: str | None = None
    q1_val: str | None = None
    median_val: str | None = None
    q3_val: str | None = None
    # Top-N (value, count) for low-cardinality categorical columns.
    top_values: list[tuple[str, int]] = field(default_factory=list)


@dataclass
class TableScan:
    """The scanned picture of one table: schema, row count, profile, samples."""

    full_name: str
    columns: list[ColumnStat] = field(default_factory=list)
    row_count: int | None = None
    sample_rows: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


@dataclass
class _CacheEntry:
    scan: TableScan
    expires_at: float


# ---------------------------------------------------------------------------
# Process-level cache
# ---------------------------------------------------------------------------

_cache: dict[tuple[str, str], _CacheEntry] = {}
_cache_lock = threading.Lock()


def _cache_key(ws: WorkspaceClient, full_name: str) -> tuple[str, str]:
    host = str(getattr(getattr(ws, "config", None), "host", "") or "")
    return (host, full_name)


def get_cached(ws: WorkspaceClient, full_name: str) -> TableScan | None:
    """Return a cached scan for `full_name` if present and unexpired."""
    key = _cache_key(ws, full_name)
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        if time.time() > entry.expires_at:
            del _cache[key]
            return None
        return entry.scan


def _store(ws: WorkspaceClient, scan: TableScan) -> None:
    key = _cache_key(ws, scan.full_name)
    with _cache_lock:
        _cache[key] = _CacheEntry(scan=scan, expires_at=time.time() + CACHE_TTL_SECONDS)


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------


def _run(ws: WorkspaceClient, warehouse_id: str, statement: str):
    """Execute one statement synchronously and return the StatementResponse."""
    return ws.statement_execution.execute_statement(
        warehouse_id=warehouse_id,
        statement=statement,
        wait_timeout=_QUERY_TIMEOUT,
    )


def _bucket(type_text: str) -> str:
    """Classify a column type → 'numeric' | 'temporal' | 'categorical' | 'other'."""
    t = (type_text or "").strip().lower()
    if t.startswith(_NUMERIC_PREFIXES):
        return "numeric"
    if t.startswith(_TEMPORAL_PREFIXES):
        return "temporal"
    if t.startswith(_CATEGORICAL_PREFIXES):
        return "categorical"
    return "other"


def _fq(full_name: str) -> str:
    """Backtick each part of a catalog.schema.table name for safe interpolation."""
    return ".".join(f"`{p}`" for p in full_name.split(".") if p)


def _profile_columns(
    ws: WorkspaceClient, warehouse_id: str, fq: str, cols: list[ColumnStat]
) -> int | None:
    """Fill distinct/null/min/max (+ numeric moments/quartiles) for every column
    in ONE aggregate pass, then top-N values for low-cardinality categoricals.

    Mutates `cols` in place; a failure at any step is swallowed (best-effort).
    Returns the table's `COUNT(*)` (the `__n` the aggregate already computes) so
    the caller can use it as the row count WITHOUT a second COUNT(*) round-trip,
    or None if the aggregate didn't yield one.
    """
    row_count: int | None = None
    # 1) Wide single-pass aggregate. Alias each expression positionally so we can
    #    map results back to columns without depending on result column names.
    selects: list[str] = ["COUNT(*) AS __n"]
    plan: list[tuple[int, str, list[str]]] = []  # (col_index, bucket, [alias,...])
    for i, c in enumerate(cols):
        col = f"`{c.name}`"
        bucket = _bucket(c.type_text)
        aliases = [f"d{i}", f"nn{i}"]
        selects.append(f"approx_count_distinct({col}) AS d{i}")
        selects.append(f"count({col}) AS nn{i}")  # non-null count
        if bucket in ("numeric", "temporal"):
            selects.append(f"CAST(min({col}) AS STRING) AS mn{i}")
            selects.append(f"CAST(max({col}) AS STRING) AS mx{i}")
            aliases += [f"mn{i}", f"mx{i}"]
        if bucket == "numeric":
            selects.append(f"CAST(avg({col}) AS STRING) AS av{i}")
            selects.append(f"CAST(stddev({col}) AS STRING) AS sd{i}")
            selects.append(f"CAST(approx_percentile({col}, 0.25) AS STRING) AS p1{i}")
            selects.append(f"CAST(approx_percentile({col}, 0.5) AS STRING) AS p2{i}")
            selects.append(f"CAST(approx_percentile({col}, 0.75) AS STRING) AS p3{i}")
            aliases += [f"av{i}", f"sd{i}", f"p1{i}", f"p2{i}", f"p3{i}"]
        plan.append((i, bucket, aliases))

    try:
        resp = _run(ws, warehouse_id, f"SELECT {', '.join(selects)} FROM {fq}")
        row = None
        names: list[str] = []
        if resp.manifest and resp.manifest.schema and resp.manifest.schema.columns:
            names = [c.name or "" for c in resp.manifest.schema.columns]
        if resp.result and resp.result.data_array:
            row = resp.result.data_array[0]
        if row is not None and names:
            val = {names[j]: row[j] for j in range(min(len(names), len(row)))}
            n = _to_int(val.get("__n"))
            row_count = n
            for i, _bucket_name, _aliases in plan:
                c = cols[i]
                c.distinct = _to_int(val.get(f"d{i}"))
                nonnull = _to_int(val.get(f"nn{i}"))
                if n and nonnull is not None:
                    c.null_frac = round(1 - (nonnull / n), 4) if n else None
                c.min_val = _clean(val.get(f"mn{i}"))
                c.max_val = _clean(val.get(f"mx{i}"))
                c.mean_val = _clean(val.get(f"av{i}"))
                c.stddev_val = _clean(val.get(f"sd{i}"))
                c.q1_val = _clean(val.get(f"p1{i}"))
                c.median_val = _clean(val.get(f"p2{i}"))
                c.q3_val = _clean(val.get(f"p3{i}"))
    except Exception as e:  # noqa: BLE001 — profile is best-effort
        logger.debug("table_stats: profile aggregate failed for %s: %s", fq, e)

    # 2) Top-N frequent values for LOW-cardinality categorical columns only.
    #    (High-cardinality → the top values aren't a useful summary and the query
    #    is wasteful.) Bounded to MAX_TOP_VALUE_COLUMNS columns per table.
    picked = 0
    for c in cols:
        if picked >= MAX_TOP_VALUE_COLUMNS:
            break
        if _bucket(c.type_text) != "categorical":
            continue
        if c.distinct is None or c.distinct == 0 or c.distinct > MAX_DISTINCT_FOR_TOP_VALUES:
            continue
        picked += 1
        try:
            col = f"`{c.name}`"
            resp = _run(
                ws,
                warehouse_id,
                f"SELECT CAST({col} AS STRING) AS v, COUNT(*) AS c FROM {fq} "
                f"WHERE {col} IS NOT NULL GROUP BY {col} ORDER BY c DESC LIMIT {TOP_VALUES_N}",
            )
            if resp.result and resp.result.data_array:
                for r in resp.result.data_array:
                    cnt = _to_int(r[1])
                    c.top_values.append((_truncate(r[0], 40), cnt if cnt is not None else 0))
        except Exception as e:  # noqa: BLE001 — per-column best-effort
            logger.debug("table_stats: top-values failed for %s.%s: %s", fq, c.name, e)

    return row_count


def _scan_one(ws: WorkspaceClient, warehouse_id: str, full_name: str) -> TableScan:
    """Scan a single table: schema + row count + per-column profile + sample rows.

    Degrades gracefully — any failure is captured on `scan.error` and the caller
    keeps going with the other tables.
    """
    scan = TableScan(full_name=full_name)

    parts = [p for p in full_name.split(".") if p]
    if len(parts) != 3:
        scan.error = f"expected catalog.schema.table, got {full_name!r}"
        return scan
    fq = _fq(full_name)

    # 1) Sample rows (also yields the column schema from the result manifest).
    try:
        resp = _run(ws, warehouse_id, f"SELECT * FROM {fq} LIMIT {SAMPLE_ROWS}")
        col_infos = []
        if resp.manifest and resp.manifest.schema and resp.manifest.schema.columns:
            col_infos = list(resp.manifest.schema.columns)
        col_names: list[str] = []
        for c in col_infos[:MAX_COLUMNS_PER_TABLE]:
            name = c.name or ""
            col_names.append(name)
            scan.columns.append(
                ColumnStat(
                    name=name,
                    type_text=c.type_text or (c.type_name.value if c.type_name else ""),
                )
            )
        if resp.result and resp.result.data_array:
            for row in resp.result.data_array:
                scan.sample_rows.append(
                    {col_names[i]: row[i] for i in range(min(len(col_names), len(row)))}
                )
    except Exception as e:  # noqa: BLE001 — record + continue
        logger.warning("table_stats: sample read failed for %s: %s", full_name, e)
        scan.error = str(e)
        return scan

    # 2) Per-column profile (distinct/null/min/max/moments/quartiles + top values).
    #    The aggregate already computes COUNT(*) AS __n, which _profile_columns
    #    returns — so the row count comes back for free, no separate query.
    if scan.columns:
        scan.row_count = _profile_columns(ws, warehouse_id, fq, scan.columns)

    # 3) Row count fallback — ONLY if the aggregate above didn't yield one (it
    #    failed, or the table had no profileable columns). The common path skips
    #    this entirely; here it's a cheap best-effort backstop, not a per-scan tax.
    if scan.row_count is None:
        try:
            resp = _run(ws, warehouse_id, f"SELECT COUNT(*) FROM {fq}")
            if resp.result and resp.result.data_array and resp.result.data_array[0]:
                scan.row_count = _to_int(resp.result.data_array[0][0])
        except Exception as e:  # noqa: BLE001 — count is best-effort
            logger.debug("table_stats: count failed for %s: %s", full_name, e)

    return scan


# How many tables to scan CONCURRENTLY. Each worker uses its OWN WorkspaceClient
# (the SDK's requests.Session isn't thread-safe), so scans of a multi-table
# selection run in parallel instead of serially — the dominant cost when a user
# picks many tables. Bounded so we don't open too many clients / overload the
# warehouse; a serverless warehouse handles this many concurrent statements fine.
_SCAN_WORKERS = 8


def _scan_one_isolated(warehouse_id: str, full_name: str) -> TableScan:
    """Scan one table on a FRESH `WorkspaceClient()` so parallel scans never
    share one client's non-thread-safe `requests.Session`. The app SP client is
    itself built as ambient `WorkspaceClient()` (see core/_defaults), so a fresh
    one has identical auth + host — the cache key (host-scoped) stays consistent."""
    try:
        return _scan_one(WorkspaceClient(), warehouse_id, full_name)
    except Exception as e:  # noqa: BLE001 — never let one table kill the batch
        logger.warning("table_stats: scan failed for %s: %s", full_name, e)
        return TableScan(full_name=full_name, error=str(e))


def scan_tables_progress(
    ws: WorkspaceClient,
    tables: list[str],
    warehouse_id: str,
) -> Iterator[dict[str, Any]]:
    """Scan up to MAX_TABLES tables IN PARALLEL, caching each, yielding progress.

    Yields, in order:
      {"type": "scanning", "done": k, "total": n, "table": fq | None}
      … one per completed table (plus an initial one for the cached-hit count) …
      {"type": "done", "scans": [TableScan, …]}   # in the INPUT order

    Cached (unexpired) tables are returned from cache and NOT re-queried. Errors
    are isolated per table (each scan carries its own `.error`)."""
    picked = [t.strip() for t in tables if t.strip()][:MAX_TABLES]
    total = len(picked)
    results: dict[str, TableScan] = {}
    to_scan: list[str] = []
    for full_name in picked:
        cached = get_cached(ws, full_name)
        if cached is not None:
            results[full_name] = cached
        else:
            to_scan.append(full_name)

    done = total - len(to_scan)
    yield {"type": "scanning", "done": done, "total": total, "table": None}

    if to_scan:
        with ThreadPoolExecutor(max_workers=min(_SCAN_WORKERS, len(to_scan))) as ex:
            future_map = {
                ex.submit(_scan_one_isolated, warehouse_id, fq): fq for fq in to_scan
            }
            for fut in as_completed(future_map):
                fq = future_map[fut]
                scan = fut.result()  # _scan_one_isolated never raises
                _store(ws, scan)
                results[fq] = scan
                done += 1
                yield {"type": "scanning", "done": done, "total": total, "table": fq}

    yield {"type": "done", "scans": [results[fq] for fq in picked]}


def scan_tables(
    ws: WorkspaceClient,
    tables: list[str],
    warehouse_id: str,
) -> list[TableScan]:
    """Scan up to MAX_TABLES tables (in parallel), caching each. Returns per-table
    scans in the input order. Thin wrapper over `scan_tables_progress` for callers
    that don't need progress (e.g. the suggest endpoint's lazy scan)."""
    scans: list[TableScan] = []
    for ev in scan_tables_progress(ws, tables, warehouse_id):
        if ev["type"] == "done":
            scans = ev["scans"]
    return scans


# ---------------------------------------------------------------------------
# Capability signals — deterministic "what can this data support" summary
# ---------------------------------------------------------------------------
#
# The grounded story flow uses this to let the LLM RATE each idea's fit against
# the data's real coverage (a measure to aggregate, a time column to trend, a
# dimension to slice, a key to join) instead of inventing one. It's pure over
# the already-scanned columns — NO extra warehouse queries.

# A categorical column is a usable "dimension" only when it's low-cardinality
# (same bar the top-values scan uses) — a 10k-distinct string isn't sliceable.
_MAX_DISTINCT_FOR_DIMENSION = MAX_DISTINCT_FOR_TOP_VALUES

# Substrings that mark a numeric column as an identifier/key rather than a
# measure (so we don't tell the LLM `customer_id` is something to sum).
_ID_NAME_HINTS = ("id", "key", "code", "guid", "uuid", "number", "num", "no")

# Cap each rendered list so a wide multi-table selection can't blow the budget.
_MAX_SIGNALS_PER_KIND = 12


def _looks_like_id(name: str) -> bool:
    """True if a column NAME reads like an identifier/key (not a measure)."""
    n = (name or "").strip().lower()
    if not n:
        return False
    if n in ("id", "key", "guid", "uuid", "code"):
        return True
    # token-boundary match on common id suffixes/segments (customer_id, order_no…)
    tokens = n.replace("-", "_").split("_")
    return any(tok in _ID_NAME_HINTS for tok in tokens)


def derive_capability_signals(scans: list[TableScan]) -> dict[str, Any]:
    """Derive deterministic data-capability signals from scanned tables.

    Returns a dict:
      - time_columns:  [(table, col)]           temporal columns (trend axes)
      - measures:      [(table, col)]            numeric, non-identifier (aggregatable)
      - dimensions:    [(table, col, [values])]  low-card categoricals (sliceable)
      - join_keys:     [(table_a, col, table_b, col)]  id-ish columns shared by name

    Pure over already-scanned columns — no warehouse queries. Best-effort: a
    table with only an `error` contributes nothing.
    """
    time_columns: list[tuple[str, str]] = []
    measures: list[tuple[str, str]] = []
    dimensions: list[tuple[str, str, list[str]]] = []

    # (normalized_name, bucket) → list[(table, original_col)] for join detection.
    by_name: dict[str, list[tuple[str, str]]] = {}

    for s in scans:
        for c in s.columns:
            bucket = _bucket(c.type_text)
            if bucket == "temporal":
                time_columns.append((s.full_name, c.name))
            elif bucket == "numeric" and not _looks_like_id(c.name):
                measures.append((s.full_name, c.name))
            elif bucket == "categorical":
                if (
                    c.distinct is not None
                    and 0 < c.distinct <= _MAX_DISTINCT_FOR_DIMENSION
                ):
                    values = [v for v, _cnt in c.top_values]
                    dimensions.append((s.full_name, c.name, values))
            # Any id-ish column is a join-key candidate, tracked by name.
            if _looks_like_id(c.name):
                by_name.setdefault(c.name.strip().lower(), []).append(
                    (s.full_name, c.name)
                )

    # Join keys: an id-ish column name that appears in ≥2 DIFFERENT tables.
    join_keys: list[tuple[str, str, str, str]] = []
    for _norm, occ in by_name.items():
        # de-dup to distinct tables, keep first column spelling per table
        seen: dict[str, str] = {}
        for tbl, col in occ:
            seen.setdefault(tbl, col)
        tables = list(seen.items())
        if len(tables) < 2:
            continue
        # Emit pairwise links between the first table and the rest (a hub is the
        # common shape: orders.customer_id ↔ customers.customer_id).
        (ta, ca) = tables[0]
        for tb, cb in tables[1:]:
            join_keys.append((ta, ca, tb, cb))

    return {
        "time_columns": time_columns,
        "measures": measures,
        "dimensions": dimensions,
        "join_keys": join_keys,
    }


def render_capability_signals(scans: list[TableScan]) -> str:
    """Render `derive_capability_signals` as a compact prompt block the grounded
    flow uses to judge each idea's FIT. Returns "" when there's nothing useful."""
    sig = derive_capability_signals(scans)
    time_cols = sig["time_columns"]
    measures = sig["measures"]
    dims = sig["dimensions"]
    joins = sig["join_keys"]
    if not (time_cols or measures or dims or joins):
        return ""

    lines = ["DATA CAPABILITY SIGNALS (derived from the profiled tables):"]
    if time_cols:
        rendered = ", ".join(f"{t}.{c}" for t, c in time_cols[:_MAX_SIGNALS_PER_KIND])
        lines.append(f"- Time columns (trend/forecast axes): {rendered}")
    else:
        lines.append("- Time columns: NONE (no date/timestamp — a time-trend story needs synthetic dates)")
    if measures:
        rendered = ", ".join(f"{t}.{c}" for t, c in measures[:_MAX_SIGNALS_PER_KIND])
        lines.append(f"- Measures (numeric, aggregatable): {rendered}")
    else:
        lines.append("- Measures: NONE (no numeric measure — a KPI/aggregation story needs synthetic values)")
    if dims:
        parts = []
        for t, c, values in dims[:_MAX_SIGNALS_PER_KIND]:
            vals = "{" + ", ".join(str(v) for v in values[:4]) + "}" if values else ""
            parts.append(f"{t}.{c} {vals}".strip())
        lines.append(f"- Dimensions (low-card, sliceable): {'; '.join(parts)}")
    if joins:
        rendered = "; ".join(
            f"{ta}.{ca} ↔ {tb}.{cb}" for ta, ca, tb, cb in joins[:_MAX_SIGNALS_PER_KIND]
        )
        lines.append(f"- Join keys across tables: {rendered}")
    lines.append(
        "Judge each idea's FIT against these: a story that trends a measure over a "
        "time column, sliced by a dimension (and for multi-table, joined on a key), "
        "is a GREAT fit; one whose core entity/measure is ABSENT here leans on "
        "synthetic data (POSSIBLE)."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------


def render_scans_for_prompt(scans: list[TableScan]) -> str:
    """Render scanned tables as a compact prompt block: schema + per-column
    profile (distinct, null%, range, quartiles, top values) + sample rows."""
    blocks: list[str] = []
    for s in scans:
        if s.error and not s.columns:
            blocks.append(f"TABLE {s.full_name}\n  (could not read: {s.error})")
            continue
        lines = [f"TABLE {s.full_name}"]
        if s.row_count is not None:
            lines.append(f"  approx rows: {s.row_count:,}")
        lines.append("  columns (name type — profile):")
        for c in s.columns:
            lines.append(f"    - {c.name} ({c.type_text}){_render_col_profile(c)}")
        if s.sample_rows:
            lines.append(f"  sample rows (first {len(s.sample_rows)}):")
            for row in s.sample_rows:
                cells = ", ".join(f"{k}={_truncate(v)}" for k, v in row.items())
                lines.append(f"    {{{cells}}}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _render_col_profile(c: ColumnStat) -> str:
    """One-line profile suffix for a column (only the parts we actually have)."""
    parts: list[str] = []
    if c.distinct is not None:
        parts.append(f"{c.distinct:,} distinct")
    if c.null_frac is not None and c.null_frac > 0:
        parts.append(f"{c.null_frac * 100:.0f}% null")
    if c.min_val is not None or c.max_val is not None:
        parts.append(f"range {c.min_val}…{c.max_val}")
    if c.mean_val is not None:
        moments = f"mean {c.mean_val}"
        if c.stddev_val is not None:
            moments += f" ±{c.stddev_val}"
        parts.append(moments)
    if c.median_val is not None:
        parts.append(f"quartiles {c.q1_val}/{c.median_val}/{c.q3_val}")
    if c.top_values:
        top = ", ".join(f"{v}×{n}" for v, n in c.top_values)
        parts.append(f"top: {top}")
    return "  — " + "; ".join(parts) if parts else ""


def _to_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (ValueError, TypeError):
        return None


def _clean(value: Any) -> str | None:
    """Normalize a stringified aggregate value; None stays None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _truncate(value: Any, limit: int = 80) -> str:
    text = "NULL" if value is None else str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"
