"""Add projects.ownership_granted_hash.

Companion to ownership_reconciled_hash for the cross-workspace ownership
reconcile's MID-BUILD grant-only pass (CUJ1). While a build is running the
reconcile grants the user READ access to resources without transferring
ownership (so the SP keeps USE_SCHEMA and the build isn't broken); this column
is the hash gate for that pass, kept separate from the build-complete transfer
gate so the two don't shadow each other. Nullable. See
remote_deploy/ownership_reconcile.py + routes/project_files.py _maybe_reconcile_ownership.

Revision ID: v16_ownership_granted_hash
Revises: v16_project_link_access
Create Date: 2026-07-26

Re-parented onto v16_project_link_access when the branches merged, to keep a
single linear Alembic head (originally authored off v15_template_embedding_vector).
The arch-history chain (v17_architecture_history → v18_architecture_history_restore)
now sits ABOVE this revision — v17.down_revision == v16_ownership_granted_hash — so
the full order is: v15 → v16_project_link_access → v16_ownership_granted_hash →
v17_architecture_history → v18_architecture_history_restore.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "v16_ownership_granted_hash"
down_revision: Union[str, None] = "v16_project_link_access"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent: this column pre-exists in any DB that ran the pre-merge chain
    # (where this migration sat directly on v15_template_embedding_vector, before
    # it was re-parented onto v16_project_link_access). Skip the add there so a
    # replay from an earlier stamp point doesn't fail on "column already exists".
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("projects")}
    if "ownership_granted_hash" not in cols:
        op.add_column(
            "projects",
            sa.Column("ownership_granted_hash", sa.String(64), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("projects", "ownership_granted_hash")
