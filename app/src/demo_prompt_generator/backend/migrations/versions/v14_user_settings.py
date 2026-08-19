"""Add user_settings table (per-user cross-workspace deploy target).

The deploy target is a per-USER account setting applied to all of a user's
projects, not per-project. Deployed mode never persists a `users` row (identity
comes from the x-forwarded-email header), so this table is the durable per-user
store, keyed + upserted by email.

Revision ID: v14_user_settings
Revises: v13_target_ws_host
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "v14_user_settings"
down_revision: Union[str, None] = "v13_target_ws_host"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_settings",
        sa.Column("email", sa.String(255), primary_key=True),
        sa.Column("target_workspace_host", sa.String(255), nullable=True),
        sa.Column("target_catalog", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_user_settings_email", "user_settings", ["email"])


def downgrade() -> None:
    op.drop_index("ix_user_settings_email", table_name="user_settings")
    op.drop_table("user_settings")
