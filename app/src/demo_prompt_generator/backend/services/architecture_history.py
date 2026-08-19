"""Architecture-history snapshots.

Every change to a project's `architecture.md` — whether saved via the API route
or detected on disk by the file watcher — records a versioned snapshot here. The
full file is stored zstd-compressed (reusing file_sync.compress_content, the same
scheme project_files / thinking use).

TIERED RETENTION (fine-recent, coarse-old):
  * DEBOUNCE (1 min): a burst of small edits collapses into ONE entry. On each
    change we look at the project's newest snapshot; if it is younger than 1
    minute we UPSERT it (overwrite content + bump `created_at`), else INSERT a
    new row. So the last few minutes keep ~1-minute granularity.
  * COMPACTION (>10 min old → 5-min buckets): entries that have aged past a
    10-minute recent window are down-sampled to one per fixed wall-clock 5-min
    bucket (keep the NEWEST in each bucket, delete the rest). So old history
    reads as one snapshot per 5 minutes while recent edits stay fine-grained.

The compaction runs on every INSERT and is metadata-only (never loads the big
content blobs) + idempotent (wall-clock buckets → re-running finds one per bucket
and deletes nothing). `record_architecture_history` is the SINGLE home both
callers use (the save route + the watcher) so behavior is consistent regardless
of how the change arrived.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, delete, select

from ..models import ArchitectureHistory, utc_now
from .file_sync import compress_content, decompress_content

logger = logging.getLogger(__name__)

# A change within this window of the latest snapshot upserts it instead of
# inserting a new row (keeps the history from flooding on rapid edits).
DEBOUNCE_WINDOW = timedelta(minutes=1)
# Entries newer than this are left at 1-min granularity; older ones get compacted.
RECENT_WINDOW = timedelta(minutes=10)
# Old entries are down-sampled to one per this fixed wall-clock bucket.
COMPACT_BUCKET_SECONDS = 5 * 60
# Compaction only ever needs to re-examine the SLAB that just aged past
# RECENT_WINDOW since the previous insert — anything older was already collapsed
# to one-per-bucket on a prior run (idempotent, fixed buckets). Scanning
# [now-RECENT_WINDOW-SLAB, now-RECENT_WINDOW] bounds the query so it never selects
# the whole (potentially large) history. Sized generously so even a long idle gap
# between inserts is fully covered.
COMPACT_LOOKBACK = timedelta(hours=1)


def _aware(dt: datetime) -> datetime:
    """Normalize a possibly-naive DB timestamp to UTC-aware for comparison."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _decompress(blob: bytes) -> str:
    """Decompress a stored snapshot back to text (empty on failure/empty blob)."""
    if not blob:
        return ""
    try:
        return decompress_content(blob).decode("utf-8")
    except Exception:
        return ""


def _compact_old_entries(session: Session, project_id: str, now: datetime) -> None:
    """Down-sample entries older than RECENT_WINDOW to one per 5-min wall-clock bucket.

    METADATA-ONLY + BOUNDED: selects just (id, created_at, is_restore,
    restored_from_id) — never the content blob — over only the
    [now-RECENT_WINDOW-COMPACT_LOOKBACK, now-RECENT_WINDOW] slab, so it never
    scans the whole history. Keeps the NEWEST entry in each 5-min bucket, deletes
    the rest in one statement. Idempotent (fixed buckets → nothing left to delete
    on a re-run). No commit here — the caller commits.

    RESTORE PROTECTION: a restore row (is_restore) and the row it was restored
    from (restored_from_id) are NEVER deleted — so a restore is always undoable
    and nothing around a restore point is lost, regardless of buckets.
    """
    cutoff = now - RECENT_WINDOW
    floor = cutoff - COMPACT_LOOKBACK  # don't re-scan the already-compacted far tail
    rows = session.exec(
        select(
            ArchitectureHistory.id,
            ArchitectureHistory.created_at,
            ArchitectureHistory.is_restore,
            ArchitectureHistory.restored_from_id,
        )
        .where(ArchitectureHistory.project_id == project_id)
        .where(ArchitectureHistory.created_at < cutoff)
        .where(ArchitectureHistory.created_at >= floor)
        .order_by(ArchitectureHistory.created_at.asc())
    ).all()
    if len(rows) < 2:
        return

    # Protected ids: every restore row, and every row a restore points back to.
    # These are pinned regardless of bucket so a restore stays undoable forever.
    protected: set[int] = set()
    for hid, _created, is_restore, restored_from in rows:
        if is_restore:
            protected.add(hid)
            if restored_from is not None:
                protected.add(restored_from)

    # Group NON-protected rows by fixed wall-clock 5-min bucket; keep the newest
    # id in each bucket, drop the rest. Protected rows are never candidates.
    keep_by_bucket: dict[int, tuple[int, datetime]] = {}
    for hid, created, is_restore, _restored_from in rows:
        if hid in protected:
            continue
        bucket = int(_aware(created).timestamp()) // COMPACT_BUCKET_SECONDS
        cur = keep_by_bucket.get(bucket)
        if cur is None or _aware(created) > _aware(cur[1]):
            keep_by_bucket[bucket] = (hid, created)

    keep_ids = {hid for hid, _ in keep_by_bucket.values()} | protected
    drop_ids = [hid for hid, _c, _r, _rf in rows if hid not in keep_ids]
    if drop_ids:
        session.exec(delete(ArchitectureHistory).where(ArchitectureHistory.id.in_(drop_ids)))


def record_architecture_history(session: Session, project_id: str, content: str) -> None:
    """Record a snapshot of `architecture.md` for `project_id`.

    1-min debounce on the newest entry, then compact entries older than 10 min
    down to one per 5-min bucket. Best-effort: callers wrap this in try/except so
    a history failure never blocks the underlying save/sync. No-ops on empty content.
    """
    if not content:
        return
    latest = session.exec(
        select(ArchitectureHistory)
        .where(ArchitectureHistory.project_id == project_id)
        .order_by(ArchitectureHistory.created_at.desc())
    ).first()
    # IDENTICAL-TO-LATEST → unconditional NO-OP (any age). This is the robust,
    # guard-free way restore stays correct: record_restore inserts the flagged row
    # (newest, content X), then its disk write trips the watcher with the SAME X →
    # latest already IS X → no-op → the flagged row is never shadowed by a plain
    # entry (and it fires for however many watcher events the write emits). It also
    # dedupes any redundant save. Compares DECOMPRESSED bytes so it never depends on
    # compression being byte-deterministic.
    if latest is not None and _decompress(latest.content_compressed) == content:
        return
    compressed = compress_content(content.encode("utf-8"))
    now = utc_now()
    if latest is not None and (now - _aware(latest.created_at)) < DEBOUNCE_WINDOW and not latest.is_restore:
        # Within the debounce window (and the newest isn't a protected restore) →
        # collapse this edit into the newest entry instead of inserting a new row.
        latest.content_compressed = compressed
        latest.created_at = now
        session.add(latest)
    else:
        session.add(ArchitectureHistory(project_id=project_id, content_compressed=compressed, created_at=now))
        # A genuinely new entry landed → down-sample anything that just aged out.
        _compact_old_entries(session, project_id, now)
    session.commit()


def record_restore(session: Session, project_id: str, content: str, restored_from_id: int) -> None:
    """Record a RESTORE: always INSERTS a fresh snapshot (never debounce-upserts),
    flagged `is_restore` and pointing at the snapshot it was restored from.

    Both this row and its source are protected from compaction (see
    `_compact_old_entries`), so a restore is always undoable and nothing around a
    restore point is ever lost. Best-effort (caller wraps in try/except).

    The restore row is the newest with content X; the caller then writes X to
    architecture.md, which trips the watcher → record_architecture_history(X).
    That sees latest already == X → no-op, so this flagged row is never shadowed
    (no echo-guard needed; see record_architecture_history's identical-to-latest
    check).
    """
    if not content:
        return
    session.add(
        ArchitectureHistory(
            project_id=project_id,
            content_compressed=compress_content(content.encode("utf-8")),
            created_at=utc_now(),
            is_restore=True,
            restored_from_id=restored_from_id,
        )
    )
    session.commit()


def list_architecture_history(session: Session, project_id: str, limit: int = 50) -> list[ArchitectureHistory]:
    """Snapshots for a project, newest first — METADATA ONLY (no content blob).

    Never loads `content_compressed` (the big blob); the list UI only needs the
    timestamps + restore flag, and content is fetched lazily per entry on restore.
    """
    rows = session.exec(
        select(
            ArchitectureHistory.id,
            ArchitectureHistory.created_at,
            ArchitectureHistory.is_restore,
        )
        .where(ArchitectureHistory.project_id == project_id)
        .order_by(ArchitectureHistory.created_at.desc())
        .limit(limit)
    ).all()
    # Return lightweight ArchitectureHistory instances (content left empty) so the
    # route's Out mapping is unchanged.
    return [
        ArchitectureHistory(
            id=hid, project_id=project_id, content_compressed=b"",
            created_at=created, is_restore=is_restore,
        )
        for hid, created, is_restore in rows
    ]


def get_architecture_history_content(
    session: Session, project_id: str, history_id: int
) -> tuple[datetime, str] | None:
    """(`created_at`, decompressed markdown) for one snapshot, or None if not found."""
    row = session.exec(
        select(ArchitectureHistory)
        .where(ArchitectureHistory.id == history_id)
        .where(ArchitectureHistory.project_id == project_id)
    ).first()
    if row is None:
        return None
    return row.created_at, decompress_content(row.content_compressed).decode("utf-8")
