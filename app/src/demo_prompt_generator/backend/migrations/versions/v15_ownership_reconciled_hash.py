"""Add projects.ownership_reconciled_hash.

Cross-workspace ownership reconcile (Option A — deployer service principal).
SHA-256 of the resource set the last SP→user ownership-reconcile pass ran
against (keyed to the target user). Nullable — a null means the project has
never been reconciled. Lets the reconcile hash-gate skip re-running when
nothing changed. See remote_deploy/ownership_reconcile.py.

Revision ID: v15_ownership_hash
Revises: v14_user_settings
Create Date: 2026-07-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v15_ownership_hash"
down_revision: Union[str, None] = "v14_user_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("ownership_reconciled_hash", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "ownership_reconciled_hash")
