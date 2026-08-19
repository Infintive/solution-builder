"""Deployer-SP auth seam for cross-workspace ("scale") deploy.

This is the ONLY auth code specific to remote-workspace deploy. It lives in the
`remote_deploy/` package (not `core/auth.py`) so the entire scale feature is one
self-contained, removable module: a generic Tier-1 install can physically
exclude `remote_deploy/` and `core/auth.py`'s dispatcher degrades to classic
same-workspace OBO (it imports these under try/except).

Depends on `core.auth` for the shared file name/profile constants so the SP
writer and the OBO writer produce the SAME `.databrickscfg` profile — the
dependency direction is remote_deploy → core (correct; core never imports back).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..core.auth import AUTH_FILE_NAME, AUTH_FILE_PROFILE


def write_project_sp_auth_file(
    project_dir: Path,
    *,
    host: str,
    client_id: str,
    client_secret: str,
) -> Path:
    """Atomically rewrite <project_dir>/.databrickscfg for OAuth-M2M against a
    TARGET workspace (deployer service principal).

    The cross-workspace-deploy variant of `core.auth.write_project_auth_file`.
    Where the OBO writer stamps the user's PAT for the app's OWN workspace, this
    stamps the deployer SP's OAuth-M2M creds pointed at an arbitrary TARGET
    workspace host. The agent's `databricks` CLI then deploys INTO that target
    as the SP; resource ownership is transferred to the user afterward.

    Same atomicity contract as write_project_auth_file: same-dir tempfile,
    mode 0600, os.replace().
    """
    project_dir.mkdir(parents=True, exist_ok=True)
    target = project_dir / AUTH_FILE_NAME
    content = (
        f"[{AUTH_FILE_PROFILE}]\n"
        f"host          = {host}\n"
        f"client_id     = {client_id}\n"
        f"client_secret = {client_secret}\n"
    )

    fd, tmp_path = tempfile.mkstemp(
        dir=str(project_dir),
        prefix=".databrickscfg.",
        suffix=".tmp",
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp_path, target)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return target


def target_deploy_active(config, target_workspace_host: str | None) -> bool:
    """Single source of truth: is THIS project deploying cross-workspace?

    True iff the deployer SP is configured AND the project has a target
    workspace host. When False, every path falls back to the classic
    same-workspace OBO behavior — nothing changes. Keeping this one predicate
    means the refresher, the route write sites, and the agent env builder all
    agree on which auth mode a project is in.
    """
    return bool(
        getattr(config, "cross_workspace_deploy_enabled", False)
        and target_workspace_host
    )
