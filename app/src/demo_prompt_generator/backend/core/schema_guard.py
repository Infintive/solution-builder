"""Boot-time schema-drift safety net.

Defense-in-depth against the failure mode that took prod down after the Model-3
cutover: `alembic_version` claimed `head`, so `alembic upgrade head` was a no-op,
yet three earlier migrations' DDL had never physically applied (the DB had
advanced up one lineage of a since-linearized multi-head chain and skipped the
other). The app booted "successfully" and then 500'd on every query touching the
missing columns/tables.

`detect_schema_drift(engine)` runs AFTER migrations and compares what the ORM
(`SQLModel.metadata`) expects against what's physically in the DB, returning the
tables/columns the DB is MISSING. Boot logs this loudly instead of silently
serving a broken schema, and `heal_schema_drift(engine, drift)` repairs the part
we can do SAFELY: it `create_all`s absent tables (CREATE only, never drop/alter)
and `ALTER TABLE ADD COLUMN`s absent NULLABLE columns (additive — existing rows
get NULL). A missing NOT-NULL column can't be synthesized safely (a populated
table needs a value strategy that lives in the owning migration), so it's
reported for manual DDL. Neither function touches migration state or
`alembic_version`.

Deliberately one-directional: it reports only what the ORM needs and the DB
lacks — never "extra" DB columns. Migrations legitimately create columns the ORM
doesn't model (e.g. the pgvector `embedding` column on `templates`), and those
must not be flagged.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import Engine, MetaData, inspect, text
from sqlalchemy.schema import CreateColumn


@dataclass
class SchemaDrift:
    """What the ORM expects that the live DB is missing.

    `missing_tables`  — tables in the model that don't exist in the DB at all.
    `missing_columns` — (table, column) pairs where the table EXISTS but lacks a
                        column the model declares. A wholly-missing table is
                        reported once in `missing_tables`, NOT expanded into one
                        entry per column here.
    """
    missing_tables: list[str] = field(default_factory=list)
    missing_columns: list[tuple[str, str]] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.missing_tables and not self.missing_columns

    def summary(self) -> str:
        """One-line human-readable summary (empty string when there's no drift)."""
        if self.is_empty():
            return ""
        parts: list[str] = []
        if self.missing_tables:
            parts.append("missing tables: " + ", ".join(sorted(self.missing_tables)))
        if self.missing_columns:
            cols = ", ".join(f"{t}.{c}" for t, c in sorted(self.missing_columns))
            parts.append("missing columns: " + cols)
        return "; ".join(parts)


@dataclass
class HealResult:
    """What `heal_schema_drift` was able to repair, and what it couldn't.

    `created_tables`   — absent tables it CREATEd (via `create_all`).
    `added_columns`    — (table, column) NULLABLE columns it added (additive
                         `ALTER TABLE ADD COLUMN`; existing rows get NULL).
    `unhealed_columns` — (table, column) NOT-NULL columns it refused to add
                         (a populated table needs a value strategy that lives in
                         the owning migration) → operator must apply that DDL.
    `errors`           — per-object failures (one bad ALTER doesn't stop the
                         rest); healing is best-effort and never raises.
    """
    created_tables: list[str] = field(default_factory=list)
    added_columns: list[tuple[str, str]] = field(default_factory=list)
    unhealed_columns: list[tuple[str, str]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def fully_healed(self) -> bool:
        """True when nothing was left for a human (no NOT-NULL gaps, no errors)."""
        return not self.unhealed_columns and not self.errors


def detect_schema_drift(engine: Engine, *, metadata: Optional[MetaData] = None) -> SchemaDrift:
    """Compare `metadata` (default: SQLModel's) against the live DB behind
    `engine` and return the tables/columns the DB is MISSING.

    Only ORM-declared tables are checked. For each: if the table is absent from
    the DB it goes in `missing_tables`; otherwise every ORM column absent from
    the DB goes in `missing_columns`. Extra DB tables/columns are ignored by
    design. Read-only — issues only reflection queries."""
    metadata = _resolve_metadata(metadata)

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    missing_tables: list[str] = []
    missing_columns: list[tuple[str, str]] = []

    for table_name, table in metadata.tables.items():
        if table_name not in existing_tables:
            missing_tables.append(table_name)
            continue
        db_cols = {c["name"] for c in inspector.get_columns(table_name)}
        for col in table.columns:
            if col.name not in db_cols:
                missing_columns.append((table_name, col.name))

    return SchemaDrift(missing_tables=missing_tables, missing_columns=missing_columns)


def heal_schema_drift(
    engine: Engine, drift: SchemaDrift, *, metadata: Optional[MetaData] = None
) -> HealResult:
    """Repair the SAFE part of `drift` and report the rest.

    - **Missing tables** → `create_all` (emits CREATE only for absent tables;
      never drops or alters an existing one).
    - **Missing NULLABLE columns** → additive `ALTER TABLE ADD COLUMN` (existing
      rows get NULL — the same shape as the additive migrations that were skipped
      in the incident, so this would have fully self-healed it).
    - **Missing NOT-NULL columns** → NOT added. A non-empty table can't take a
      NOT-NULL column without a value strategy (default/backfill) that lives in
      the owning migration; adding it blind would fail or wrongly fabricate data.
      Reported in `unhealed_columns` for manual DDL.

    Best-effort and idempotent: each object is repaired independently, a failure
    is captured in `errors` (never raised), and it only ever emits CREATE / ADD
    COLUMN — no drops, no type changes. Returns a `HealResult`."""
    metadata = _resolve_metadata(metadata)
    result = HealResult()

    if drift.missing_tables:
        to_create = [
            metadata.tables[t] for t in drift.missing_tables if t in metadata.tables
        ]
        try:
            metadata.create_all(engine, tables=to_create)
            result.created_tables = [t.name for t in to_create]
        except Exception as e:  # noqa: BLE001 — one bad table shouldn't abort the rest
            result.errors.append(f"create tables {[t.name for t in to_create]}: {e!r}")

    for table_name, col_name in drift.missing_columns:
        table = metadata.tables.get(table_name)
        col = table.columns.get(col_name) if table is not None else None
        if col is None:
            # Drift names a column the ORM doesn't have (shouldn't happen — drift
            # is derived FROM the ORM) — leave it for a human rather than guess.
            result.unhealed_columns.append((table_name, col_name))
            continue
        if not col.nullable:
            # A NOT-NULL add needs the owning migration's default/backfill.
            result.unhealed_columns.append((table_name, col_name))
            continue
        try:
            # Render the column's DDL fragment from the ORM definition (correct
            # type + NULL) and ADD it. Additive: existing rows get NULL.
            col_ddl = CreateColumn(col).compile(engine).string
            with engine.begin() as conn:
                conn.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN {col_ddl}'))
            result.added_columns.append((table_name, col_name))
        except Exception as e:  # noqa: BLE001 — best-effort; report and continue
            result.errors.append(f"add column {table_name}.{col_name}: {e!r}")

    return result


def _resolve_metadata(metadata: Optional[MetaData]) -> MetaData:
    """Return `metadata`, or SQLModel's registry when None.

    Imported lazily: pulling in `models` registers the SQLModel table classes,
    and keeping that out of module import time avoids an import cycle with core
    modules that load very early."""
    if metadata is not None:
        return metadata
    from sqlmodel import SQLModel

    from .. import models  # noqa: F401 — ensure table classes are registered

    return SQLModel.metadata
