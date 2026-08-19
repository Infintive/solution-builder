"""Add official flag, screenshot, and content_checksum to templates.

Supports seeding `initial_templates/` folders as curated ("official") DB
templates keyed by folder name, upgraded smoothly on restart:
  - official: curated templates (seeded); shown with a featured treatment and
    surfaced on the internal /internal-demos gallery.
  - screenshot: optional hero PNG bytes for the gallery tile + slide-over.
  - content_checksum: hash of the seeded folder's file-set, so the startup
    seeder can skip unchanged templates and diff-update only changed ones.

Revision ID: v13_template_official_screenshot
Revises: v15_ownership_hash
Create Date: 2026-07-21

NOTE: down_revision was rebased from v11_project_mode to v15_ownership_hash
when the cross-workspace-deploy branch (which added v13_target_ws_host →
v14_user_settings → v15_ownership_hash off v11_project_mode) merged with main
(which added these template migrations off the same v11_project_mode). Both
forks branched from v11_project_mode; linearizing the two heads. The
cross-workspace migrations run FIRST because the live remote-deploy instance's
DB has already applied them (v14_user_settings) but not these template migrations.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "v13_template_official_screenshot"
down_revision: Union[str, None] = "v15_ownership_hash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column("official", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("templates", sa.Column("screenshot", sa.LargeBinary(), nullable=True))
    op.add_column("templates", sa.Column("content_checksum", sa.String(64), nullable=True))
    op.create_index("ix_templates_official", "templates", ["official"])


def downgrade() -> None:
    op.drop_index("ix_templates_official", table_name="templates")
    op.drop_column("templates", "content_checksum")
    op.drop_column("templates", "screenshot")
    op.drop_column("templates", "official")
