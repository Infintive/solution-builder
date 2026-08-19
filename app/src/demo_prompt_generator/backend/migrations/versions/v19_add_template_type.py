"""Add templates.template_type.

Classifies a template: SOLUTION (default — full deployable demo), WORKSHOP,
GENIE_WORKSHOP, or ARCHITECTURE. Read from the seed manifest.json
(`template_type`); user-published templates default to SOLUTION (or derive from
the source project's `mode`). Drives the gallery type tag + the ?type= filter.
`server_default='SOLUTION'` backfills every existing row. Indexed like `official`
for the list filter. See models.TemplateType.

Revision ID: v19_add_template_type
Revises: v18_architecture_history_restore
Create Date: 2026-08-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v19_add_template_type"
down_revision: Union[str, None] = "v18_architecture_history_restore"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column(
            "template_type",
            sa.String(length=20),
            nullable=False,
            server_default="SOLUTION",
        ),
    )
    op.create_index("ix_templates_template_type", "templates", ["template_type"])


def downgrade() -> None:
    op.drop_index("ix_templates_template_type", table_name="templates")
    op.drop_column("templates", "template_type")
