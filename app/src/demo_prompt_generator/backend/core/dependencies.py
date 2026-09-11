from __future__ import annotations

from typing import TypeAlias
from ._defaults import ConfigDependency, ClientDependency, UserWorkspaceClientDependency
from ._headers import HeadersDependency
from .lakebase import LakebaseDependency


class Dependencies:
    """FastAPI dependency injection shorthand for route handler parameters."""

    Client: TypeAlias = ClientDependency
    """Databricks WorkspaceClient using app-level service principal credentials.
    Recommended usage: `ws: Dependencies.Client`"""

    UserClient: TypeAlias = UserWorkspaceClientDependency
    """WorkspaceClient authenticated on behalf of the current user via OBO token.
    Requires the X-Forwarded-Access-Token header.
    Recommended usage: `user_ws: Dependencies.UserClient`

    NOTE: On Databricks Apps, OBO tokens only carry whatever is declared in
    the app resource's `user_api_scopes` (databricks.yml) — plus the
    auto-added `iam.*` defaults. As of this writing that's the `catalog.*`
    family + `sql` + `genie` + `workspace.workspace` (see the comment above
    `user_api_scopes` in databricks.yml for the full story and what's still
    missing, e.g. no documented Jobs API scope). A call that needs a scope
    not in that list 403s with `Invalid scope, required scopes: <name>` from
    the downstream API — `routes/resources.py` has a worked example
    (`_EffectivePermissionsUnavailable`) of failing open on that specific
    error instead of mistaking it for a real per-item permission denial. LLM/
    embeddings calls always use `Dependencies.Client` (service principal),
    never OBO — those aren't gated by user_api_scopes at all."""

    Config: TypeAlias = ConfigDependency
    """Application configuration loaded from environment variables.
    Recommended usage: `config: Dependencies.Config`"""

    Headers: TypeAlias = HeadersDependency
    """Databricks Apps HTTP headers for the current request.
    Recommended usage: `headers: Dependencies.Headers`"""
    Session: TypeAlias = LakebaseDependency
    """Lakebase session dependency.
    Recommended usage: `session: Dependencies.Session`"""

