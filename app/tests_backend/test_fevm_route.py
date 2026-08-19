"""Tests for the /api/me/fevm/workspaces route handler.

The handler is thin — it gates on config, resolves the OBO token + app host,
builds the httpx transport, and maps FevmMcpError to a non-fatal error field.
We call the handler function directly with fakes (matching the repo's
dependency-injection test style; there is no TestClient harness) and stub the
transport factory + lister so no network is touched.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from demo_prompt_generator.backend.fevm import routes as route  # noqa: E402
from demo_prompt_generator.backend.fevm import mcp as _fevm_mcp  # noqa: E402


class _Headers:
    """Minimal DatabricksAppsHeaders stand-in: token is a SecretStr-like."""
    def __init__(self, token=None, email="joe.miao@databricks.com"):
        self.token = SimpleNamespace(get_secret_value=lambda: token) if token else None
        self.user_email = email


def _config(enabled=True, name="fevm_mcp"):
    return SimpleNamespace(
        fevm_integration_enabled=enabled,
        fevm_connection_name=name,
        default_target_workspace_host="https://fevm-sb-shared-remote-target-ws.cloud.databricks.com",
    )


# --- gating -----------------------------------------------------------------

def test_disabled_when_integration_off():
    resp = route.list_fevm_workspaces(headers=_Headers(token="t"), config=_config(enabled=False))
    assert resp.enabled is False
    assert resp.workspaces == []


def test_disabled_local_mode_no_token(monkeypatch):
    # request_user_pat returns None when headers.token is None (local dev).
    resp = route.list_fevm_workspaces(headers=_Headers(token=None), config=_config())
    assert resp.enabled is False
    assert "OBO" in (resp.error or "")


# --- happy path -------------------------------------------------------------

def test_lists_workspaces(monkeypatch):
    sentinel_transport = object()
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: sentinel_transport)
    monkeypatch.setattr(
        _fevm_mcp, "list_target_workspaces",
        lambda *, transport: (
            [{"name": "solution-builder", "host": "https://fevm-solution-builder.cloud.databricks.com",
              "region": "us-east-2", "state": "Active", "template": "AWS Stable Serverless"}]
            if transport is sentinel_transport else []
        ),
    )
    # resolve_host reads DATABRICKS_HOST; force it via monkeypatch on the route module.
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")

    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.enabled is True
    assert resp.error is None
    assert len(resp.workspaces) == 1
    assert resp.workspaces[0].name == "solution-builder"
    assert resp.workspaces[0].host == "https://fevm-solution-builder.cloud.databricks.com"


# --- auth-consent / MCP failure is non-fatal --------------------------------

def test_mcp_consent_error_returns_connect_url(monkeypatch):
    # A "please login first" failure → needs_consent + connect_url, NOT a raw error.
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")

    def _boom(*, transport):
        raise _fevm_mcp.FevmMcpError(
            "Please login first…",
            needs_consent=True,
            connect_url="https://app-ws.cloud.databricks.com/explore/connections/fevm_mcp?o=1",
        )
    monkeypatch.setattr(_fevm_mcp, "list_target_workspaces", _boom)

    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.enabled is True
    assert resp.needs_consent is True
    assert resp.connect_url.endswith("/explore/connections/fevm_mcp?o=1")
    assert resp.error is None


def test_mcp_consent_error_builds_connect_url_when_missing(monkeypatch):
    # 401 case: needs_consent True but no URL in the error → route constructs one.
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")

    def _boom(*, transport):
        raise _fevm_mcp.FevmMcpError("UNAUTHENTICATED: missing", needs_consent=True)
    monkeypatch.setattr(_fevm_mcp, "list_target_workspaces", _boom)

    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.needs_consent is True
    # Fallback lands on the connection's overview tab (where the Log in button is).
    assert resp.connect_url == (
        "https://app-ws.cloud.databricks.com/explore/connections/fevm_mcp?activeTab=overview"
    )


def test_mcp_non_consent_error_returns_error(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")

    def _boom(*, transport):
        raise _fevm_mcp.FevmMcpError("some other failure")
    monkeypatch.setattr(_fevm_mcp, "list_target_workspaces", _boom)

    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.needs_consent is False
    assert "some other failure" in (resp.error or "")


def test_unresolved_host_disables(monkeypatch):
    monkeypatch.setattr(route, "resolve_host", lambda headers: None)
    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.enabled is False
    assert resp.error is not None


# --- provisioning routes ----------------------------------------------------

import pytest as _pytest
from fastapi import HTTPException as _HTTPException
from demo_prompt_generator.backend.fevm.models import FevmProvisionRequest


def test_provision_disabled_raises(monkeypatch):
    with _pytest.raises(_HTTPException) as exc:
        route.provision_fevm_workspace(
            body=FevmProvisionRequest(resource_name="x", region="us-east-2"),
            headers=_Headers(token="t"), config=_config(enabled=False),
        )
    assert exc.value.status_code == 400


def test_provision_happy_path(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: sentinel)
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    monkeypatch.setattr(
        _fevm_mcp, "provision_target_workspace",
        lambda *, transport, resource_name, region, intent: {
            "success": True, "resource_id": "rid-123", "message": "submitted",
        },
    )
    resp = route.provision_fevm_workspace(
        body=FevmProvisionRequest(resource_name="my-ws", region="us-east-2"),
        headers=_Headers(token="tok"), config=_config(),
    )
    assert resp.success is True
    assert resp.resource_id == "rid-123"


def test_provision_bad_region_400(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _raise(*, transport, resource_name, region, intent):
        raise ValueError("Region 'us-west-1' is not provisionable.")
    monkeypatch.setattr(_fevm_mcp, "provision_target_workspace", _raise)
    with _pytest.raises(_HTTPException) as exc:
        route.provision_fevm_workspace(
            body=FevmProvisionRequest(resource_name="x", region="us-west-1"),
            headers=_Headers(token="tok"), config=_config(),
        )
    assert exc.value.status_code == 400


def test_provision_gateway_500_reports_inconclusive_not_failed(monkeypatch):
    # #59: a gateway 500 / timeout on the provision call is INCONCLUSIVE — FEVM
    # may already have ACCEPTED the create (the workspace shows up provisioning),
    # since provisioning is async and the sync MCP round-trip just timed out.
    # The route must NOT report a hard "Provision failed."; it flags
    # submitted_maybe so the UI says "may have been submitted — check your
    # workspaces" instead of scaring the user off a successful op.
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _boom(*, transport, resource_name, region, intent):
        raise _fevm_mcp.FevmMcpError(
            "HTTP 500 from .../mcp/external/fevm_mcp: {\"error_code\":\"INTERNAL_ERROR\"}",
            transient=True,
        )
    monkeypatch.setattr(_fevm_mcp, "provision_target_workspace", _boom)

    resp = route.provision_fevm_workspace(
        body=FevmProvisionRequest(resource_name="my-ws", region="us-east-2"),
        headers=_Headers(token="tok"), config=_config(),
    )
    assert resp.success is False
    assert resp.submitted_maybe is True
    # Message should point the user at their workspace list, not claim failure.
    assert "may have been submitted" in (resp.message or "").lower() \
        or "check your" in (resp.message or "").lower()


def test_provision_definitive_error_is_failure(monkeypatch):
    # A NON-transient MCP error (e.g. a real tool-level rejection) stays a
    # definitive failure — submitted_maybe must be False.
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _boom(*, transport, resource_name, region, intent):
        raise _fevm_mcp.FevmMcpError("tool rejected: name already exists")
    monkeypatch.setattr(_fevm_mcp, "provision_target_workspace", _boom)

    resp = route.provision_fevm_workspace(
        body=FevmProvisionRequest(resource_name="dup", region="us-east-2"),
        headers=_Headers(token="tok"), config=_config(),
    )
    assert resp.success is False
    assert resp.submitted_maybe is False
    assert "already exists" in (resp.error or "")


def test_provision_status_active_returns_host(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    monkeypatch.setattr(
        _fevm_mcp, "get_target_deployment",
        lambda *, transport, resource_id: {
            "resource_id": resource_id, "state": "Active", "region": "us-east-2",
            "workspace_url": "https://fevm-my-ws.cloud.databricks.com",
        },
    )
    resp = route.get_fevm_provision_status(
        resource_id="rid-123", headers=_Headers(token="tok"), config=_config(),
    )
    assert resp.state == "Active"
    assert resp.host == "https://fevm-my-ws.cloud.databricks.com"


def test_provision_status_still_provisioning_no_host(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    monkeypatch.setattr(
        _fevm_mcp, "get_target_deployment",
        lambda *, transport, resource_id: {
            "resource_id": resource_id, "state": "Provisioning", "region": "us-east-2",
            "workspace_url": None,
        },
    )
    resp = route.get_fevm_provision_status(
        resource_id="rid-123", headers=_Headers(token="tok"), config=_config(),
    )
    assert resp.state == "Provisioning"
    assert resp.host is None


# --- authorize-deployer route -----------------------------------------------

from demo_prompt_generator.backend.fevm.models import FevmAuthorizeDeployerRequest


def _config_sp(enabled=True, name="fevm_mcp"):
    from types import SimpleNamespace
    return SimpleNamespace(
        fevm_integration_enabled=enabled,
        fevm_connection_name=name,
        deployer_sp_client_id="11111111-1111-4111-8111-111111111111",
    )


def test_authorize_deployer_derives_name_from_host(monkeypatch):
    captured = {}
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _auth(*, transport, resource_id, deployer_sp_client_id):
        captured["resource_id"] = resource_id
        captured["sp"] = deployer_sp_client_id
        return {"success": True, "transaction_id": "tx1", "github_run_url": "https://gh/run/1"}
    monkeypatch.setattr(_fevm_mcp, "authorize_deployer_admin", _auth)

    resp = route.authorize_fevm_deployer(
        body=FevmAuthorizeDeployerRequest(host="https://fevm-my-ws.cloud.databricks.com"),
        headers=_Headers(token="tok"), config=_config_sp(),
    )
    assert resp.success is True
    assert resp.available is True
    assert captured["resource_id"] == "my-ws"   # derived from host
    assert captured["sp"] == "11111111-1111-4111-8111-111111111111"


def test_authorize_deployer_tool_unavailable_sets_available_false(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _boom(*, transport, resource_id, deployer_sp_client_id):
        raise _fevm_mcp.FevmMcpError("Unknown tool: add_workspace_admin")
    monkeypatch.setattr(_fevm_mcp, "authorize_deployer_admin", _boom)

    resp = route.authorize_fevm_deployer(
        body=FevmAuthorizeDeployerRequest(resource_id="rid-1"),
        headers=_Headers(token="tok"), config=_config_sp(),
    )
    assert resp.success is False
    assert resp.available is False


def test_authorize_deployer_needs_identifier(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    with _pytest.raises(_HTTPException) as exc:
        route.authorize_fevm_deployer(
            body=FevmAuthorizeDeployerRequest(),  # no id, no host
            headers=_Headers(token="tok"), config=_config_sp(),
        )
    assert exc.value.status_code == 400


def test_authorize_deployer_surfaces_grant_failure_reason(monkeypatch):
    # The Model-3 silent-swallow fix: when the tool RAN but the grant FAILED
    # (e.g. workspace not Active / caller not a live admin), the parser returns
    # success:false WITH a message. The route must PROPAGATE that reason into
    # `error` (not drop it → blank 200 → UI polls forever). `available` stays
    # True (the tool exists; it's the grant that was refused).
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _auth(*, transport, resource_id, deployer_sp_client_id):
        return {
            "success": False,
            "transaction_id": "tx-adm-002",
            "github_run_url": None,
            "message": "Workspace is not Active yet; try again once provisioning completes.",
        }
    monkeypatch.setattr(_fevm_mcp, "authorize_deployer_admin", _auth)

    resp = route.authorize_fevm_deployer(
        body=FevmAuthorizeDeployerRequest(resource_id="rid-1"),
        headers=_Headers(token="tok"), config=_config_sp(),
    )
    assert resp.success is False
    assert resp.available is True  # tool exists; grant was refused, not missing
    assert "not Active" in (resp.error or "")


def test_authorize_deployer_success_carries_run_url(monkeypatch):
    # On dispatch, the route should surface the GHA run URL + transaction id so
    # the grant is observable (was logged as nothing before).
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    def _auth(*, transport, resource_id, deployer_sp_client_id):
        return {"success": True, "transaction_id": "tx9",
                "github_run_url": "https://github.com/x/runs/9", "message": None}
    monkeypatch.setattr(_fevm_mcp, "authorize_deployer_admin", _auth)

    resp = route.authorize_fevm_deployer(
        body=FevmAuthorizeDeployerRequest(resource_id="rid-1"),
        headers=_Headers(token="tok"), config=_config_sp(),
    )
    assert resp.success is True
    assert resp.github_run_url == "https://github.com/x/runs/9"
    assert resp.transaction_id == "tx9"


# --- shared default host in the picker --------------------------------------

def test_default_host_returned_and_deduped(monkeypatch):
    monkeypatch.setattr(_fevm_mcp, "make_http_transport", lambda **kw: object())
    monkeypatch.setattr(route, "resolve_host", lambda headers: "https://app-ws.cloud.databricks.com")
    monkeypatch.setattr(
        _fevm_mcp, "list_target_workspaces",
        lambda *, transport: [
            # The shared default is ALSO in the user's own list (they own it).
            {"name": "sb-shared-remote-target-ws",
             "host": "https://fevm-sb-shared-remote-target-ws.cloud.databricks.com",
             "region": "us-east-2", "state": "Active", "template": "AWS Stable Serverless"},
            {"name": "solution-builder",
             "host": "https://fevm-solution-builder.cloud.databricks.com",
             "region": "us-east-2", "state": "Active", "template": "AWS Stable Serverless"},
        ],
    )
    resp = route.list_fevm_workspaces(headers=_Headers(token="tok"), config=_config())
    assert resp.default_host == "https://fevm-sb-shared-remote-target-ws.cloud.databricks.com"
    names = [w.name for w in resp.workspaces]
    # Shared default is deduped OUT of the own-list (surfaced separately as first).
    assert "sb-shared-remote-target-ws" not in names
    assert "solution-builder" in names


def test_default_host_present_even_when_disabled():
    resp = route.list_fevm_workspaces(headers=_Headers(token="t"), config=_config(enabled=False))
    assert resp.enabled is False
    assert resp.default_host == "https://fevm-sb-shared-remote-target-ws.cloud.databricks.com"
