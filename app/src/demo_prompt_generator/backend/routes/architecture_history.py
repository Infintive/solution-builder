"""Architecture-history endpoints — the arch-tab History panel.

`GET /projects/{id}/architecture-history`          → list snapshots (newest first)
`GET /projects/{id}/architecture-history/{hid}/content` → one snapshot's markdown
`POST /projects/{id}/architecture-history/{hid}/restore` → restore a snapshot

Snapshots are written by services/architecture_history.record_architecture_history
(from the save route + the file watcher). Read access mirrors the other project
routes via _get_project_access.
"""
import os

from fastapi import HTTPException
from sqlmodel import delete, select

from ..core import Dependencies, create_router
from ..models import (
    ArchitectureHistory,
    ArchitectureHistoryContentOut,
    ArchitectureHistoryOut,
)
from ..services.architecture_history import (
    get_architecture_history_content,
    list_architecture_history,
    record_restore,
)
from ..services.skills_manager import get_project_directory
from .projects import _get_project_access, _get_user_email, _require_write_access

router = create_router()


@router.get(
    "/projects/{project_id}/architecture-history",
    response_model=list[ArchitectureHistoryOut],
    operation_id="listArchitectureHistory",
)
def list_history(
    project_id: str,
    session: Dependencies.Session,
    headers: Dependencies.Headers,
    config: Dependencies.Config,
    limit: int = 50,
):
    """Architecture-history snapshots for a project, newest first (metadata only)."""
    user_email = _get_user_email(headers)
    _get_project_access(session, project_id, user_email, config.template_admin_emails)
    rows = list_architecture_history(session, project_id, limit=limit)
    # r.id is the DB-assigned PK — never None for a persisted row.
    return [
        ArchitectureHistoryOut(id=r.id, created_at=r.created_at, is_restore=r.is_restore)
        for r in rows if r.id is not None
    ]


@router.get(
    "/projects/{project_id}/architecture-history/{history_id}/content",
    response_model=ArchitectureHistoryContentOut,
    operation_id="getArchitectureHistoryContent",
)
def get_history_content(
    project_id: str,
    history_id: int,
    session: Dependencies.Session,
    headers: Dependencies.Headers,
    config: Dependencies.Config,
):
    """The decompressed `architecture.md` for one snapshot (for preview/restore)."""
    user_email = _get_user_email(headers)
    _get_project_access(session, project_id, user_email, config.template_admin_emails)
    result = get_architecture_history_content(session, project_id, history_id)
    if result is None:
        raise HTTPException(status_code=404, detail="History snapshot not found")
    created_at, content = result
    return ArchitectureHistoryContentOut(id=history_id, created_at=created_at, content=content)


@router.post(
    "/projects/{project_id}/architecture-history/{history_id}/restore",
    response_model=ArchitectureHistoryContentOut,
    operation_id="restoreArchitectureHistory",
)
def restore_history(
    project_id: str,
    history_id: int,
    session: Dependencies.Session,
    headers: Dependencies.Headers,
    config: Dependencies.Config,
):
    """Restore a snapshot: write its content to `architecture.md`, and record a
    NEW protected restore entry (never compacted away, alongside its source — so
    the restore is always undoable). Returns the restored content so the client
    re-seeds the canvas. Requires write access.
    """
    user_email = _get_user_email(headers)
    _require_write_access(session, project_id, user_email, config.template_admin_emails)

    result = get_architecture_history_content(session, project_id, history_id)
    if result is None:
        raise HTTPException(status_code=404, detail="History snapshot not found")
    _created_at, content = result

    # Record the protected restore entry FIRST (flagged is_restore), so it's the
    # newest row. Then write to disk: the file-watcher's record_architecture_history
    # sees latest already == this content → no-op (won't insert a plain row that
    # shadows the flagged one). Ordering matters — writing disk first would let the
    # watcher insert the plain entry before ours lands.
    record_restore(session, project_id, content, restored_from_id=history_id)
    new_row_id = session.exec(  # the row we just created (for compensation on write failure)
        select(ArchitectureHistory.id)
        .where(ArchitectureHistory.project_id == project_id)
        .order_by(ArchitectureHistory.created_at.desc())
    ).first()

    # Write the restored content to disk ATOMICALLY (temp + os.replace), so a
    # partial/failed write never leaves architecture.md half-written. On failure,
    # COMPENSATE: delete the restore row we just committed, so DB and disk stay
    # consistent (no flagged row for content that isn't on disk).
    disk_path = get_project_directory(project_id) / "architecture.md"
    try:
        disk_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = disk_path.with_suffix(disk_path.suffix + ".restore.tmp")
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, disk_path)
    except OSError as e:
        if new_row_id is not None:
            try:
                session.exec(delete(ArchitectureHistory).where(ArchitectureHistory.id == new_row_id))
                session.commit()
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Restore write failed: {e}")

    # Tell the collab room this content is the room's known hash, so the resulting
    # file-watcher event is recognized as our own save (not an agent takeover).
    try:
        from ..services.collab import get_collab_hub
        get_collab_hub().note_saved(project_id, content)
    except Exception:
        pass

    # created_at of the NEW restore entry isn't strictly needed by the client
    # (it re-seeds from content + refreshes the list); return the source id/ts.
    return ArchitectureHistoryContentOut(id=history_id, created_at=_created_at, content=content)
