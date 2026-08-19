"""Add restore flags to architecture_history.

`is_restore` marks a snapshot created by restoring an earlier version;
`restored_from_id` records which snapshot it was restored from. Both a restore
row and its source row are protected from compaction (never deleted), so a
restore is always undoable. See models.ArchitectureHistory +
services/architecture_history.py.

Revision ID: v18_architecture_history_restore
Revises: v17_architecture_history
Create Date: 2026-07-30
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v18_architecture_history_restore"
down_revision: Union[str, None] = "v17_architecture_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "architecture_history",
        sa.Column("is_restore", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "architecture_history",
        sa.Column("restored_from_id", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("architecture_history", "restored_from_id")
    op.drop_column("architecture_history", "is_restore")
