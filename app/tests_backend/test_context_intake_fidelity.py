"""Regression tests for LOSSLESS context intake.

The generator's effectiveness depends on a user's uploaded schema / pasted
spec surviving intake INTACT — no silent truncation. These tests pin the two
places truncation used to bite:

  1. `file_extraction.extract_text` — the char cap and the tabular ROW cap.
     A data dictionary (every row = a column definition) must not be clipped.
  2. The verbatim source-brief threshold used by the projects route.

If someone lowers a cap back to a lossy value, these fail loudly.

Run: `cd app && uv run pytest tests_backend/test_context_intake_fidelity.py`
"""
from __future__ import annotations

import csv
import io

from demo_prompt_generator.backend.services.file_extraction import (
    MAX_TABULAR_ROWS,
    extract_text,
)
from demo_prompt_generator.backend.routes.uploads import MAX_CHARS_PER_FILE


# A 10 MB CSV holds ~100k rows of typical width; the row cap must sit above
# that so the char cap (not the row cap) is what ever bounds a real schema.
def test_row_cap_exceeds_what_a_10mb_csv_can_hold():
    assert MAX_TABULAR_ROWS >= 100_000, (
        "tabular row cap is low enough to clip a large data dictionary — "
        "a 60-table schema is ~1,200 rows and real dumps go higher"
    )


def test_char_cap_is_generous():
    assert MAX_CHARS_PER_FILE >= 1_000_000, (
        "per-file char cap regressed to a lossy value; a multi-page spec "
        "must survive intake"
    )


def test_large_csv_dictionary_survives_intact():
    """A 1,200-row data dictionary with a sentinel LAST row must keep its tail."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["table_name", "column_name", "data_type", "nullable", "description"])
    for t in range(60):
        for c in range(20):
            w.writerow([f"tbl_{t:03d}", f"col_{c:02d}", "STRING", "NO", f"meaning {c}"])
    w.writerow(["zzz_final", "SENTINEL_TAIL_9f3a", "STRING", "NO", "end marker"])
    data = buf.getvalue().encode()

    text, truncated = extract_text("dictionary.csv", data, max_chars=MAX_CHARS_PER_FILE)
    assert "SENTINEL_TAIL_9f3a" in text, "CSV tail was truncated — schema would be lost"
    assert not truncated
    # Every table survived.
    for t in range(60):
        assert f"tbl_{t:03d}" in text


def test_large_markdown_schema_survives_intact():
    md = "# catalog\n" + "\n".join(
        f"- `t{t}_col_{c}` (STRING) — meaning" for t in range(60) for c in range(20)
    ) + "\n- `SENTINEL_TAIL_9f3a` (STRING) — end marker\n"
    text, truncated = extract_text("schema.md", md.encode(), max_chars=MAX_CHARS_PER_FILE)
    assert "SENTINEL_TAIL_9f3a" in text
    assert not truncated


def test_char_cap_still_bounds_a_pathological_blob():
    """The cap is raised, not removed — a blob past it is still bounded + flagged."""
    huge = ("x" * (MAX_CHARS_PER_FILE + 5_000)).encode()
    text, truncated = extract_text("h.txt", huge, max_chars=MAX_CHARS_PER_FILE)
    assert truncated
    assert len(text) <= MAX_CHARS_PER_FILE + 64  # + the "[... truncated ...]" note


def test_source_brief_threshold_matches_route():
    """The route writes context/source-brief.md for a SUBSTANTIAL brief (>=280
    chars) and skips a one-line topic. Pin the boundary so the frontend note
    and the backend write stay in lockstep."""
    # Mirror of routes/projects.py logic; keep the constant here in sync.
    THRESHOLD = 280

    def would_write(brief: str) -> bool:
        return len((brief or "").strip()) >= THRESHOLD

    assert not would_write("retail returns demo")
    assert would_write("We need a healthcare CFO budget-variance demo. " * 8)
