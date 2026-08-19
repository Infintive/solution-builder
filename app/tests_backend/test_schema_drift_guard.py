"""Tests for the boot-time schema-drift safety net.

Context (the incident this guards against): prod's `alembic_version` said `head`
(v18) while three earlier migrations' DDL (v13 target_workspace_host, v14
user_settings, v15 ownership_reconciled_hash) had never physically applied —
the DB had advanced up one lineage of a since-linearized multi-head chain and
skipped the other. `alembic upgrade head` was a no-op (already at head), so the
app booted and then 500'd on every query that touched the missing columns.

`detect_schema_drift(engine)` is the defense-in-depth: AFTER migrations run, it
compares what the ORM (SQLModel.metadata) expects against what's physically in
the DB and returns the missing tables/columns — so boot can log loudly (and/or
self-heal) instead of silently serving a broken schema.

Pure + DB-only (no network, no Alembic) — exercised here against in-memory
SQLite with hand-built metadata so the diff logic is verified in isolation.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402
from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, inspect, text  # noqa: E402

from demo_prompt_generator.backend.core.schema_guard import (  # noqa: E402
    HealResult,
    SchemaDrift,
    detect_schema_drift,
    heal_schema_drift,
)


def _engine_with(metadata: MetaData):
    """Create an in-memory SQLite DB and physically create `metadata`'s tables."""
    eng = create_engine("sqlite:///:memory:")
    metadata.create_all(eng)
    return eng


def _model_metadata(*, with_target_host: bool, with_user_settings: bool) -> MetaData:
    """Build an ORM-side metadata mirroring a slice of the real schema. The two
    flags toggle exactly the kind of thing the incident left missing (a column
    on an existing table, and a whole table)."""
    md = MetaData()
    proj_cols = [
        Column("id", String, primary_key=True),
        Column("name", String),
    ]
    if with_target_host:
        proj_cols.append(Column("target_workspace_host", String, nullable=True))
    Table("projects", md, *proj_cols)
    if with_user_settings:
        Table(
            "user_settings", md,
            Column("email", String, primary_key=True),
            Column("target_workspace_host", String, nullable=True),
        )
    return md


# ---------------------------------------------------------------------------
# Happy path: DB matches the model → no drift.
# ---------------------------------------------------------------------------

def test_no_drift_when_db_matches_model():
    md = _model_metadata(with_target_host=True, with_user_settings=True)
    eng = _engine_with(md)
    drift = detect_schema_drift(eng, metadata=md)
    assert drift.is_empty()
    assert drift.missing_tables == []
    assert drift.missing_columns == []


# ---------------------------------------------------------------------------
# The incident, reproduced: model expects a column the DB lacks.
# ---------------------------------------------------------------------------

def test_detects_missing_column():
    # DB built WITHOUT target_workspace_host (mimics v13 never applying)...
    db_md = _model_metadata(with_target_host=False, with_user_settings=True)
    eng = _engine_with(db_md)
    # ...but the ORM EXPECTS it.
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    drift = detect_schema_drift(eng, metadata=model_md)
    assert not drift.is_empty()
    assert ("projects", "target_workspace_host") in drift.missing_columns
    assert drift.missing_tables == []


def test_detects_missing_table():
    # DB built WITHOUT user_settings (mimics v14 never applying)...
    db_md = _model_metadata(with_target_host=True, with_user_settings=False)
    eng = _engine_with(db_md)
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    drift = detect_schema_drift(eng, metadata=model_md)
    assert not drift.is_empty()
    assert "user_settings" in drift.missing_tables
    # A missing table is reported as a table, NOT as N missing columns (avoid
    # double-reporting every column of an absent table).
    assert all(t != "user_settings" for t, _ in drift.missing_columns)


def test_detects_both_missing_table_and_column():
    db_md = _model_metadata(with_target_host=False, with_user_settings=False)
    eng = _engine_with(db_md)
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    drift = detect_schema_drift(eng, metadata=model_md)
    assert "user_settings" in drift.missing_tables
    assert ("projects", "target_workspace_host") in drift.missing_columns


# ---------------------------------------------------------------------------
# Extra DB columns (created by migration, not in the ORM — e.g. the pgvector
# `embedding` column) must NOT be flagged. The guard only cares about things the
# ORM needs that the DB lacks, never the reverse.
# ---------------------------------------------------------------------------

def test_extra_db_column_not_flagged():
    # DB has an extra column the model doesn't know about.
    db_md = MetaData()
    Table(
        "projects", db_md,
        Column("id", String, primary_key=True),
        Column("name", String),
        Column("embedding", Integer),  # migration-only, not in ORM
    )
    eng = _engine_with(db_md)

    model_md = MetaData()
    Table(
        "projects", model_md,
        Column("id", String, primary_key=True),
        Column("name", String),
    )
    drift = detect_schema_drift(eng, metadata=model_md)
    assert drift.is_empty()


# ---------------------------------------------------------------------------
# SchemaDrift helpers.
# ---------------------------------------------------------------------------

def test_schema_drift_summary_is_human_readable():
    drift = SchemaDrift(
        missing_tables=["user_settings"],
        missing_columns=[("projects", "target_workspace_host")],
    )
    summary = drift.summary()
    assert "user_settings" in summary
    assert "projects.target_workspace_host" in summary
    assert not drift.is_empty()


def test_empty_drift_summary():
    drift = SchemaDrift(missing_tables=[], missing_columns=[])
    assert drift.is_empty()
    assert drift.summary() == ""


# ---------------------------------------------------------------------------
# heal_schema_drift — the self-heal path. The incident's three missing objects
# were ALL additive (a whole table + two nullable columns), so healing them is
# exactly what should have happened automatically. These lock that in.
# ---------------------------------------------------------------------------

def _cols(engine, table: str) -> set[str]:
    return {c["name"] for c in inspect(engine).get_columns(table)}


def test_heal_creates_missing_table():
    # DB lacks user_settings; ORM expects it.
    db_md = _model_metadata(with_target_host=True, with_user_settings=False)
    eng = _engine_with(db_md)
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    drift = detect_schema_drift(eng, metadata=model_md)
    result = heal_schema_drift(eng, drift, metadata=model_md)

    assert "user_settings" in result.created_tables
    assert result.fully_healed()
    # And re-detecting now finds no drift — the table physically exists.
    assert detect_schema_drift(eng, metadata=model_md).is_empty()
    assert "user_settings" in inspect(eng).get_table_names()


def test_heal_adds_missing_nullable_column():
    # DB's projects lacks target_workspace_host (nullable in the model).
    db_md = _model_metadata(with_target_host=False, with_user_settings=True)
    eng = _engine_with(db_md)
    # Seed a row so we prove the additive ADD COLUMN leaves it intact (NULL).
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO projects (id, name) VALUES ('p1', 'demo')"))
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    drift = detect_schema_drift(eng, metadata=model_md)
    result = heal_schema_drift(eng, drift, metadata=model_md)

    assert ("projects", "target_workspace_host") in result.added_columns
    assert result.unhealed_columns == []
    assert result.fully_healed()
    assert "target_workspace_host" in _cols(eng, "projects")
    # Pre-existing row survived; the new column is NULL for it.
    with eng.connect() as conn:
        row = conn.execute(
            text("SELECT name, target_workspace_host FROM projects WHERE id='p1'")
        ).one()
    assert row[0] == "demo"
    assert row[1] is None
    # Drift is gone.
    assert detect_schema_drift(eng, metadata=model_md).is_empty()


def test_heal_refuses_notnull_column_and_reports_it():
    # DB's projects lacks a column the model declares NOT NULL — can't be added
    # blind to a (possibly populated) table, so it must be reported, not added.
    db_md = MetaData()
    Table("projects", db_md, Column("id", String, primary_key=True))
    eng = _engine_with(db_md)

    model_md = MetaData()
    Table(
        "projects", model_md,
        Column("id", String, primary_key=True),
        Column("region", String, nullable=False),  # NOT NULL — unhealable
    )
    drift = detect_schema_drift(eng, metadata=model_md)
    result = heal_schema_drift(eng, drift, metadata=model_md)

    assert ("projects", "region") in result.unhealed_columns
    assert ("projects", "region") not in result.added_columns
    assert not result.fully_healed()  # a human still has to act
    # It was NOT added to the DB.
    assert "region" not in _cols(eng, "projects")


def test_heal_mixed_table_and_columns():
    # Missing table + a nullable column + a NOT-NULL column, all at once.
    db_md = MetaData()
    Table("projects", db_md, Column("id", String, primary_key=True))
    eng = _engine_with(db_md)

    model_md = MetaData()
    Table(
        "projects", model_md,
        Column("id", String, primary_key=True),
        Column("target_workspace_host", String, nullable=True),   # healable
        Column("region", String, nullable=False),                 # unhealable
    )
    Table(
        "user_settings", model_md,
        Column("email", String, primary_key=True),
    )
    drift = detect_schema_drift(eng, metadata=model_md)
    result = heal_schema_drift(eng, drift, metadata=model_md)

    assert result.created_tables == ["user_settings"]
    assert ("projects", "target_workspace_host") in result.added_columns
    assert ("projects", "region") in result.unhealed_columns
    assert not result.fully_healed()
    # After healing, only the NOT-NULL column remains as drift.
    remaining = detect_schema_drift(eng, metadata=model_md)
    assert remaining.missing_tables == []
    assert remaining.missing_columns == [("projects", "region")]


def test_heal_is_idempotent():
    db_md = _model_metadata(with_target_host=False, with_user_settings=False)
    eng = _engine_with(db_md)
    model_md = _model_metadata(with_target_host=True, with_user_settings=True)

    first = heal_schema_drift(eng, detect_schema_drift(eng, metadata=model_md), metadata=model_md)
    assert first.fully_healed()
    # A second pass sees no drift → nothing to do, still no errors.
    second = heal_schema_drift(eng, detect_schema_drift(eng, metadata=model_md), metadata=model_md)
    assert second.created_tables == []
    assert second.added_columns == []
    assert second.fully_healed()


def test_heal_no_drift_is_noop():
    md = _model_metadata(with_target_host=True, with_user_settings=True)
    eng = _engine_with(md)
    result = heal_schema_drift(eng, detect_schema_drift(eng, metadata=md), metadata=md)
    assert result == HealResult()
    assert result.fully_healed()
