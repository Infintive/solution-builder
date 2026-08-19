"""Regression tests for the grounded-flow capability signals.

`derive_capability_signals` turns a set of scanned tables into the deterministic
signals the grounded story flow uses to RATE each idea's fit (a measure to
aggregate, a time column to trend, a dimension to slice, a key to join). It's
pure over already-scanned columns — these tests pin its classification so a
refactor can't silently drop a signal.

Run: `cd app && uv run pytest tests_backend/test_capability_signals.py`
"""
from __future__ import annotations

from demo_prompt_generator.backend.services.table_stats import (
    ColumnStat,
    TableScan,
    _looks_like_id,
    derive_capability_signals,
    render_capability_signals,
)


def _orders() -> TableScan:
    return TableScan(
        full_name="main.retail.orders",
        row_count=1000,
        columns=[
            ColumnStat(name="order_id", type_text="bigint", distinct=1000),
            ColumnStat(name="customer_id", type_text="bigint", distinct=400),
            ColumnStat(name="order_date", type_text="date"),
            ColumnStat(name="amount", type_text="double", distinct=900),
            ColumnStat(
                name="region",
                type_text="string",
                distinct=4,
                top_values=[("West", 300), ("East", 250), ("South", 240), ("North", 210)],
            ),
        ],
    )


def _customers() -> TableScan:
    return TableScan(
        full_name="main.retail.customers",
        row_count=400,
        columns=[
            ColumnStat(name="customer_id", type_text="bigint", distinct=400),
            ColumnStat(name="signup_ts", type_text="timestamp"),
            ColumnStat(name="lifetime_value", type_text="decimal(10,2)", distinct=380),
        ],
    )


def test_looks_like_id():
    assert _looks_like_id("customer_id")
    assert _looks_like_id("order_no")
    assert _looks_like_id("sku_code")
    assert _looks_like_id("id")
    # A plain measure/dimension name is NOT an identifier.
    assert not _looks_like_id("amount")
    assert not _looks_like_id("region")


def test_signals_classify_measures_time_dims():
    sig = derive_capability_signals([_orders()])

    # Time columns: the date column.
    assert ("main.retail.orders", "order_date") in sig["time_columns"]

    # Measures: `amount` is numeric and not id-ish; the *_id columns are demoted.
    measures = sig["measures"]
    assert ("main.retail.orders", "amount") in measures
    assert ("main.retail.orders", "order_id") not in measures
    assert ("main.retail.orders", "customer_id") not in measures

    # Dimensions: low-card categorical `region`, carrying its top values.
    dims = {(t, c): vals for t, c, vals in sig["dimensions"]}
    assert ("main.retail.orders", "region") in dims
    assert "West" in dims[("main.retail.orders", "region")]


def test_join_key_detected_across_tables():
    sig = derive_capability_signals([_orders(), _customers()])
    joins = sig["join_keys"]
    # customer_id is id-ish and shared by both tables → one join-key link.
    assert any(
        {ta, tb} == {"main.retail.orders", "main.retail.customers"}
        and ca == "customer_id"
        and cb == "customer_id"
        for ta, ca, tb, cb in joins
    ), joins


def test_render_is_empty_when_no_signals():
    # A table of only free-text high-card strings yields nothing useful.
    barren = TableScan(
        full_name="main.x.notes",
        columns=[ColumnStat(name="note", type_text="string", distinct=99999)],
    )
    assert render_capability_signals([barren]) == ""


def test_render_mentions_real_columns():
    text = render_capability_signals([_orders(), _customers()])
    assert "main.retail.orders.amount" in text
    assert "main.retail.orders.order_date" in text
    assert "customer_id" in text  # the join key
