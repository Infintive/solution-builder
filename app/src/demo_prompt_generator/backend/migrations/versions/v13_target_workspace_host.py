"""Add projects.target_workspace_host.

The TARGET FEVM workspace a project's Databricks resources deploy INTO
(cross-workspace deploy, Option A — deployer service principal). An https
workspace URL, e.g. https://fevm-....cloud.databricks.com. Nullable — a null
means deploy to the app's OWN host workspace via the classic OBO path
(unchanged behavior). See core/auth.py write_project_sp_auth_file + AUTH.md.

Revision ID: v13_target_ws_host
Revises: v11_project_mode
Create Date: 2026-07-17
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v13_target_ws_host"
down_revision: Union[str, None] = "v11_project_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("target_workspace_host", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "target_workspace_host")
