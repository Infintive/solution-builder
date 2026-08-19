"""Add architecture_history table.

Versioned snapshots of a project's `architecture.md`. Every change (via the
save route or the file watcher) records a zstd-compressed snapshot of the full
file, debounced 5 min (newest snapshot < 5 min old is upserted, else a new row
is inserted). Powers the arch-tab History panel. See models.ArchitectureHistory
+ services/architecture_history.py.

Revision ID: v17_architecture_history
Revises: v16_ownership_granted_hash
Create Date: 2026-07-30

Re-parented onto v16_ownership_granted_hash when the cross-workspace-deploy
branch merged main: both this and v16_ownership_granted_hash were authored off
v16_project_link_access, which would leave two Alembic heads. Chaining this
after ours keeps a single linear head.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v17_architecture_history"
down_revision: Union[str, None] = "v16_ownership_granted_hash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "architecture_history",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.String(length=50), nullable=False),
        sa.Column("content_compressed", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_architecture_history_project_created",
        "architecture_history",
        ["project_id", "created_at"],
    )
    op.create_index(
        "ix_architecture_history_project_id",
        "architecture_history",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_architecture_history_project_id", table_name="architecture_history")
    op.drop_index("ix_architecture_history_project_created", table_name="architecture_history")
    op.drop_table("architecture_history")
