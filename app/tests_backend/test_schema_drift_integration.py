"""Live integration test for the schema-drift self-heal against REAL Postgres.

The unit tests in `test_schema_drift_guard.py` verify the diff/heal LOGIC on
in-memory SQLite. They can't verify the one thing that actually differs in prod:
that `heal_schema_drift`'s DDL (`create_all` + `ALTER TABLE ADD COLUMN`, rendered
from the ORM column via the bound engine's dialect) compiles and executes on real
**Lakebase Postgres** — types, NULL handling, and the additive-column-keeps-rows
behavior are all dialect-specific.

This test does that against a live Lakebase branch, but is **opt-in and skipped by
default** so the normal `pytest tests_backend/` run stays network-free:

    LAKEBASE_DATABASE_PATH=projects/solution-builder-3r8axn/branches/staging/databases/databricks_solution_builder \
    DATABRICKS_CONFIG_PROFILE=fevm-solution-builder \
    SCHEMAGUARD_IT=1 \
    uv run python -m pytest tests_backend/test_schema_drift_integration.py -v

Safety (verified against the STAGING branch — never `production`):
- Operates ONLY on uniquely-named temp tables (`_schemaguard_it_<uuid>`) it
  creates and owns. It never references projects/user_settings/templates or any
  real table, and issues no DELETE/DROP against anything it didn't create.
- Drops its temp tables in a fixture teardown (even on assertion failure).
- Never calls `initialize_models`, `RESET_DB`, `drop_all`, or any migration.
- Requires the caller to point `LAKEBASE_DATABASE_PATH` at the intended branch —
  the test refuses to run against a path whose branch segment is `production`.
"""
import os
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sqlalchemy import Column, Integer, MetaData, String, Table, inspect, text  # noqa: E402

from demo_prompt_generator.backend.core.schema_guard import (  # noqa: E402
    detect_schema_drift,
    heal_schema_drift,
)

_LAKEBASE_PATH = os.environ.get("LAKEBASE_DATABASE_PATH", "")

pytestmark = pytest.mark.skipif(
    os.environ.get("SCHEMAGUARD_IT") != "1" or not _LAKEBASE_PATH,
    reason="live Lakebase integration test — set SCHEMAGUARD_IT=1 + "
    "LAKEBASE_DATABASE_PATH (+ DATABRICKS_CONFIG_PROFILE) to run",
)


def _guard_not_production() -> None:
    """Refuse to run against the production branch — belt-and-suspenders on top
    of the temp-table-only design."""
    parts = _LAKEBASE_PATH.strip("/").split("/")
    branch = parts[3] if len(parts) >= 4 else ""
    if branch == "production":
        pytest.fail(
            "test_schema_drift_integration must NOT target the production branch "
            f"(LAKEBASE_DATABASE_PATH branch segment is {branch!r})."
        )


@pytest.fixture
def live_engine():
    """A real Lakebase engine built exactly as the app builds it (OAuth via the
    SDK), yielded to the test. No pooling concerns — one short-lived engine."""
    _guard_not_production()
    from databricks.sdk import WorkspaceClient

    from demo_prompt_generator.backend.core.lakebase import create_db_engine

    ws = WorkspaceClient()  # picks up DATABRICKS_CONFIG_PROFILE from env
    engine = create_db_engine(ws)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def temp_tables(live_engine):
    """Provide two unique temp-table names and guarantee their teardown (DROP)
    regardless of test outcome. Nothing else on the branch is touched."""
    base = f"_schemaguard_it_{uuid.uuid4().hex[:12]}"
    names = (base, f"{base}_child")
    try:
        yield names
    finally:
        for t in reversed(names):  # child first (FK-safe), though there are none
            try:
                with live_engine.begin() as c:
                    c.execute(text(f'DROP TABLE IF EXISTS "{t}" CASCADE'))
            except Exception:  # noqa: BLE001 — teardown is best-effort
                pass


def test_heal_runs_on_real_lakebase_postgres(live_engine, temp_tables):
    """The additive heal (create table + add nullable column) executes on real
    Postgres; a NOT-NULL column is refused; a pre-existing row survives as NULL."""
    tbl, child = temp_tables

    # DB starts with just the base table (mimics a table whose additive migration
    # was skipped — the incident shape).
    db_md = MetaData()
    Table(tbl, db_md, Column("id", String, primary_key=True), Column("name", String))
    db_md.create_all(live_engine)

    # Seed a row so we can prove the additive ADD COLUMN leaves it intact (NULL).
    with live_engine.begin() as c:
        c.execute(text(f'INSERT INTO "{tbl}" (id, name) VALUES (\'r1\', \'demo\')'))

    # ORM expects a nullable col + a NOT-NULL col + a whole extra table.
    model_md = MetaData()
    Table(
        tbl, model_md,
        Column("id", String, primary_key=True),
        Column("name", String),
        Column("target_workspace_host", String, nullable=True),   # healable
        Column("must_backfill", String, nullable=False),          # unhealable
    )
    Table(child, model_md, Column("id", Integer, primary_key=True))

    drift = detect_schema_drift(live_engine, metadata=model_md)
    assert child in drift.missing_tables
    assert (tbl, "target_workspace_host") in drift.missing_columns
    assert (tbl, "must_backfill") in drift.missing_columns

    result = heal_schema_drift(live_engine, drift, metadata=model_md)
    # The additive parts applied on real Postgres...
    assert child in result.created_tables
    assert (tbl, "target_workspace_host") in result.added_columns
    # ...the NOT-NULL column was refused (needs the owning migration's backfill)...
    assert (tbl, "must_backfill") in result.unhealed_columns
    # ...and no DDL errored.
    assert result.errors == []

    # Physically confirm on the DB: nullable col exists, NOT-NULL col does not.
    cols = {c["name"] for c in inspect(live_engine).get_columns(tbl)}
    assert "target_workspace_host" in cols
    assert "must_backfill" not in cols

    # The pre-existing row survived; the new column is NULL for it.
    with live_engine.connect() as c:
        row = c.execute(
            text(f'SELECT name, target_workspace_host FROM "{tbl}" WHERE id=\'r1\'')
        ).one()
    assert row[0] == "demo"
    assert row[1] is None

    # Re-detect: the additive drift is gone; only the NOT-NULL column remains.
    remaining = detect_schema_drift(live_engine, metadata=model_md)
    assert remaining.missing_tables == []
    assert remaining.missing_columns == [(tbl, "must_backfill")]
