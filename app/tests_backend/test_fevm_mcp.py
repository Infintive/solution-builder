"""Tests for the FEVM MCP client (list target workspaces as the signed-in user).

Solution Builder calls the mcp-fevm server through a Unity Catalog HTTP
connection on the app's OWN workspace host, authenticated with the user's OBO
token. The managed-MCP URL for an external connection is:

    POST {app_host}/api/2.0/mcp/external/{connection_name}

with JSON-RPC streamable-http: initialize -> notifications/initialized ->
tools/call. Tool results come back as MARKDOWN text (not JSON), so we parse the
`list_deployments` table into structured rows and derive each workspace's host
from the FEVM naming convention `fevm-<resource_name>.cloud.databricks.com`
(verified against live workspaces).

The transport is dependency-injected so these tests need no network. Fixtures
under fixtures/fevm/ are REAL captured mcp-fevm output.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from demo_prompt_generator.backend.fevm import mcp as fm  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "fevm"


def _fixture(name: str) -> str:
    return (FIX / name).read_text()


# --- markdown parsing -------------------------------------------------------

def test_parse_deployments_returns_all_rows():
    rows = fm.parse_deployments_markdown(_fixture("list_deployments.md"))
    # The golden fixture has 8 rows.
    assert len(rows) == 8
    first = rows[0]
    assert first["name"] == "solution-builder-automation"
    assert first["state"] == "Active"
    assert first["cloud"] == "aws"
    assert first["region"] == "us-east-2"
    assert first["template"] == "AWS Stable Serverless"  # trailing space stripped


def test_parse_deployments_empty_message():
    assert fm.parse_deployments_markdown("No deployments found.") == []


def test_parse_deployments_ignores_non_table_prose():
    md = "## Deployments (0 active, 0 total)\n\nsome preamble\n"
    assert fm.parse_deployments_markdown(md) == []


# --- host derivation --------------------------------------------------------

def test_derive_host_follows_fevm_convention():
    assert (
        fm.derive_workspace_host("solution-builder-automation")
        == "https://fevm-solution-builder-automation.cloud.databricks.com"
    )
    assert (
        fm.derive_workspace_host("solution-builder")
        == "https://fevm-solution-builder.cloud.databricks.com"
    )


# --- selectable-workspace filtering (aws/stable, real workspaces only) ------

def test_selectable_workspaces_filters_to_aws_stable_active():
    rows = fm.parse_deployments_markdown(_fixture("list_deployments.md"))
    ws = fm.selectable_workspaces(rows)
    names = [w["name"] for w in ws]
    # Only aws + Active + an actual "AWS Stable" workspace template.
    assert "solution-builder-automation" in names
    assert "sb-shared-remote-target-ws" in names
    assert "solution-builder" in names
    # Standalone Catalog is not a workspace -> excluded.
    assert "solution_builder_monitoring" not in names
    # Deletion_Failed states -> excluded.
    assert "jmiao-pocs" not in names
    assert "cross-cloud-lakebase-poc4" not in names
    assert len(ws) == 3


def test_selectable_workspaces_attaches_derived_host():
    rows = fm.parse_deployments_markdown(_fixture("list_deployments.md"))
    ws = fm.selectable_workspaces(rows)
    by_name = {w["name"]: w for w in ws}
    assert (
        by_name["solution-builder-automation"]["host"]
        == "https://fevm-solution-builder-automation.cloud.databricks.com"
    )


# --- call_fevm_tool orchestration (fake transport, no network) --------------

class _FakeTransport:
    """Records the JSON-RPC handshake and returns canned responses.

    Mirrors the real streamable-http contract: initialize returns a session id
    that must be echoed on subsequent calls; tools/call returns markdown text
    inside result.content[].text.
    """

    def __init__(self, tool_text: str):
        self.tool_text = tool_text
        self.calls: list[dict] = []
        self.session_id = "sess-123"

    def post(self, payload: dict, session_id: str | None):
        self.calls.append({"method": payload.get("method"), "session_id": session_id})
        method = payload.get("method")
        if method == "initialize":
            return self.session_id, {
                "jsonrpc": "2.0", "id": payload.get("id"),
                "result": {"serverInfo": {"name": "MCP FEVM", "version": "3.2.0"}},
            }
        if method == "notifications/initialized":
            return self.session_id, {}
        if method == "tools/call":
            return self.session_id, {
                "jsonrpc": "2.0", "id": payload.get("id"),
                "result": {"content": [{"type": "text", "text": self.tool_text}]},
            }
        raise AssertionError(f"unexpected method {method}")


def test_call_fevm_tool_runs_full_handshake_and_returns_markdown():
    transport = _FakeTransport(tool_text=_fixture("list_deployments.md"))
    out = fm.call_fevm_tool(
        tool="list_deployments", arguments={}, transport=transport,
    )
    assert out.startswith("## Deployments")
    # handshake order: initialize -> notifications/initialized -> tools/call
    assert [c["method"] for c in transport.calls] == [
        "initialize", "notifications/initialized", "tools/call",
    ]
    # session id from initialize is echoed on the later calls
    assert transport.calls[1]["session_id"] == "sess-123"
    assert transport.calls[2]["session_id"] == "sess-123"


def test_call_fevm_tool_raises_on_unauthenticated_error():
    class _Unauth:
        def post(self, payload, session_id):
            if payload.get("method") == "initialize":
                return None, {
                    "jsonrpc": "2.0", "id": 1,
                    "error": {"code": -32600, "message":
                              '{"error_code":"UNAUTHENTICATED","message":"Please login first"}'},
                }
            raise AssertionError("should not proceed past a failed initialize")

    with pytest.raises(fm.FevmMcpError) as exc:
        fm.call_fevm_tool(tool="list_deployments", arguments={}, transport=_Unauth())
    assert "login" in str(exc.value).lower() or "unauthenticated" in str(exc.value).lower()


def test_call_fevm_tool_raises_on_tool_error():
    class _ToolErr:
        sid = "s1"
        def post(self, payload, session_id):
            m = payload.get("method")
            if m == "initialize":
                return self.sid, {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {}}}
            if m == "notifications/initialized":
                return self.sid, {}
            return self.sid, {
                "jsonrpc": "2.0", "id": 2,
                "error": {"code": -32000, "message": "boom"},
            }

    with pytest.raises(fm.FevmMcpError):
        fm.call_fevm_tool(tool="list_deployments", arguments={}, transport=_ToolErr())


# --- high-level convenience: list_target_workspaces -------------------------

def test_list_target_workspaces_end_to_end_with_fake_transport():
    transport = _FakeTransport(tool_text=_fixture("list_deployments.md"))
    ws = fm.list_target_workspaces(transport=transport)
    names = [w["name"] for w in ws]
    assert names == [
        "solution-builder-automation",
        "sb-shared-remote-target-ws",
        "solution-builder",
    ]
    assert all(w["host"].startswith("https://fevm-") for w in ws)


# --- provisioning (Phase 2) -------------------------------------------------

def test_provision_regions_default_and_exclusions():
    regions = fm.provisionable_regions()
    assert regions[0] == "us-east-2", "us-east-2 must be the default (first)"
    assert "us-west-1" not in regions, "us-west-1 excluded (no Lakebase)"
    assert "us-east-1" not in regions, "us-east-1 excluded (at capacity)"


def test_parse_created_deployment_extracts_resource_id():
    got = fm.parse_created_deployment(_fixture("create_deployment.md"))
    assert got["resource_id"] == "01f18abc000011112222333344445555"
    assert got.get("success") is True


def test_parse_deployment_detail_provisioning_has_no_host():
    d = fm.parse_deployment_detail(_fixture("get_deployment_provisioning.md"))
    assert d["state"] == "Provisioning"
    assert d.get("workspace_url") in (None, "")


def test_parse_deployment_detail_active_has_host():
    d = fm.parse_deployment_detail(_fixture("get_deployment_active.md"))
    assert d["state"] == "Active"
    assert d["workspace_url"] == "https://fevm-my-new-demo-ws.cloud.databricks.com"
    assert d["resource_id"] == "01f18abc000011112222333344445555"


def test_provision_rejects_disallowed_region():
    import pytest as _pytest
    with _pytest.raises(ValueError):
        fm.provision_target_workspace(
            transport=_FakeTransport(""), resource_name="x", region="us-west-1"
        )


class _ProvisionTransport:
    """Fake: initialize handshake, then create_deployment returns the created
    fixture. Records the create args so we can assert the fixed params."""
    def __init__(self, created_md):
        self.created_md = created_md
        self.create_args = None
        self.sid = "s-prov"
    def post(self, payload, session_id):
        m = payload.get("method")
        if m == "initialize":
            return self.sid, {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {}}}
        if m == "notifications/initialized":
            return self.sid, {}
        if m == "tools/call":
            params = payload.get("params", {})
            assert params["name"] == "create_deployment"
            self.create_args = params["arguments"]
            return self.sid, {"jsonrpc": "2.0", "id": 2,
                              "result": {"content": [{"type": "text", "text": self.created_md}]}}
        raise AssertionError(m)


def test_provision_sends_fixed_aws_stable_serverless_params():
    t = _ProvisionTransport(_fixture("create_deployment.md"))
    out = fm.provision_target_workspace(
        transport=t, resource_name="my-new-demo-ws", region="us-east-2",
        intent="Customer Demo/Testing",
    )
    # Fixed params for SB's single supported account.
    assert t.create_args["template_id"] == "aws_stable_serverless"
    assert t.create_args["cloud_provider"] == "aws"
    assert t.create_args["environment"] == "stable"
    assert t.create_args["region"] == "us-east-2"
    assert t.create_args["resource_name"] == "my-new-demo-ws"
    assert t.create_args["intent"] == "Customer Demo/Testing"
    # Returns the parsed resource_id for polling.
    assert out["resource_id"] == "01f18abc000011112222333344445555"


# --- header-driven parsing + Resource ID column (FEVM PR #936) --------------

def test_parse_deployments_new_format_captures_resource_id():
    rows = fm.parse_deployments_markdown(_fixture("list_deployments_with_id.md"))
    assert len(rows) == 3
    first = rows[0]
    assert first["name"] == "solution-builder-automation"
    assert first["resource_id"] == "019fa000-1111-2222-3333-444455556666"
    assert first["state"] == "Active"
    assert first["region"] == "us-east-2"


def test_parse_deployments_old_format_has_no_resource_id():
    # Pre-#936 output (7 cols, no Resource ID) must still parse.
    rows = fm.parse_deployments_markdown(_fixture("list_deployments.md"))
    assert len(rows) == 8
    assert rows[0]["name"] == "solution-builder-automation"
    assert rows[0].get("resource_id") in (None, "")


def test_selectable_workspaces_carries_resource_id_when_present():
    rows = fm.parse_deployments_markdown(_fixture("list_deployments_with_id.md"))
    ws = fm.selectable_workspaces(rows)
    by_name = {w["name"]: w for w in ws}
    assert by_name["test-mcp-from-sb"]["resource_id"] == "019faf0e-d240-784b-a7c0-732e7b759f72"
    # Standalone Catalog still excluded even with the id column.
    assert "solution_builder_monitoring" not in by_name


# --- add_workspace_admin (auto-authorize deployer SP) -----------------------

def test_parse_workspace_admin_result_dispatched():
    got = fm.parse_workspace_admin_result(_fixture("add_workspace_admin.md"))
    assert got["success"] is True
    assert got["transaction_id"] == "tx-adm-001"
    assert "github.com" in (got.get("github_run_url") or "")


def test_authorize_deployer_sends_service_principal_args():
    class _T:
        sid = "s"
        def __init__(self): self.args = None
        def post(self, payload, session_id):
            m = payload.get("method")
            if m == "initialize": return self.sid, {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{}}}
            if m == "notifications/initialized": return self.sid, {}
            self.args = payload["params"]["arguments"]
            return self.sid, {"jsonrpc":"2.0","id":2,
                              "result":{"content":[{"type":"text","text":_fixture("add_workspace_admin.md")}]}}
    t = _T()
    out = fm.authorize_deployer_admin(
        transport=t, resource_id="019faf0e-d240-784b-a7c0-732e7b759f72",
        deployer_sp_client_id="11111111-1111-4111-8111-111111111111",
    )
    assert t.args["principal"] == "11111111-1111-4111-8111-111111111111"
    assert t.args["principal_type"] == "service_principal"
    assert t.args["resource_id"] == "019faf0e-d240-784b-a7c0-732e7b759f72"
    assert out["success"] is True


def test_authorize_deployer_tool_not_found_raises_fevmerror():
    # Before PR #936 merges/deploys the tool doesn't exist → JSON-RPC error.
    class _T:
        sid = "s"
        def post(self, payload, session_id):
            m = payload.get("method")
            if m == "initialize": return self.sid, {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{}}}
            if m == "notifications/initialized": return self.sid, {}
            return self.sid, {"jsonrpc":"2.0","id":2,
                              "error":{"code":-32601,"message":"Unknown tool: add_workspace_admin"}}
    with pytest.raises(fm.FevmMcpError):
        fm.authorize_deployer_admin(
            transport=_T(), resource_id="rid", deployer_sp_client_id="sp",
        )


# --- add_workspace_admin FAILURE parsing (Model-3 silent-swallow fix) --------
#
# The bug: a failed add_workspace_admin comes back not as a JSON-RPC error but as
# tool CONTENT — either `## Workspace Admin Failed` (REST returned success:false)
# or `**Error:** ...` (the REST call threw, e.g. workspace not Active / caller not
# a live admin). The old parser only checked the `## Workspace Admin Dispatched`
# prefix and returned success:false with NO message, so the route surfaced a
# blank 200 and the UI polled for 10 min on a grant that never dispatched.
# parse_workspace_admin_result must now extract the failure REASON.

def test_parse_workspace_admin_failed_extracts_message():
    got = fm.parse_workspace_admin_result(_fixture("add_workspace_admin_failed.md"))
    assert got["success"] is False
    assert "not Active" in (got.get("message") or "")
    assert got["transaction_id"] == "tx-adm-002"


def test_parse_workspace_admin_error_response_extracts_detail():
    # The REST call threw → `_error_response` markdown with a JSON detail.
    got = fm.parse_workspace_admin_result(_fixture("add_workspace_admin_error.md"))
    assert got["success"] is False
    assert got.get("message") == "Caller is not a workspace admin on this deployment."


def test_parse_workspace_admin_error_plain_text():
    got = fm.parse_workspace_admin_result(
        "**Error:** Cannot connect to FEVM API. Is the server running?"
    )
    assert got["success"] is False
    assert "Cannot connect" in (got.get("message") or "")


def test_parse_workspace_admin_dispatched_has_no_error_message():
    # Regression: the success path must NOT invent an error message.
    got = fm.parse_workspace_admin_result(_fixture("add_workspace_admin.md"))
    assert got["success"] is True
    assert not got.get("message")  # None or empty on success


def test_authorize_deployer_admin_surfaces_failure_message():
    # End-to-end through the client: a Failed markdown must carry the reason out
    # so the route can return it (not a blank success:false).
    class _T:
        sid = "s"
        def post(self, payload, session_id):
            m = payload.get("method")
            if m == "initialize":
                return self.sid, {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {}}}
            if m == "notifications/initialized":
                return self.sid, {}
            return self.sid, {"jsonrpc": "2.0", "id": 2, "result": {"content": [
                {"type": "text", "text": _fixture("add_workspace_admin_failed.md")}]}}
    out = fm.authorize_deployer_admin(
        transport=_T(), resource_id="rid", deployer_sp_client_id="sp",
    )
    assert out["success"] is False
    assert "not Active" in (out.get("message") or "")


# --- region list correctness + failure-reason parsing (eu-west-1 bug) --------

def test_provision_regions_match_fevm_allowed_minus_excluded():
    regions = fm.provisionable_regions()
    # FEVM's allowed set for aws_stable_serverless/stable, MINUS us-west-1 + us-east-1.
    assert set(regions) == {"us-east-2", "us-west-2", "eu-central-1", "ap-northeast-1"}
    # eu-west-1 / ap-southeast-1 were WRONG (FEVM rejects them) — must be gone.
    assert "eu-west-1" not in regions
    assert "ap-southeast-1" not in regions
    assert regions[0] == "us-east-2"


def test_parse_created_deployment_surfaces_failure_reason():
    got = fm.parse_created_deployment(_fixture("create_deployment_failed.md"))
    assert got["success"] is False
    assert got["resource_id"] is None
    assert "not allowed" in got["message"]
    assert "eu-west-1" in got["message"]


# --- consent detection (first-time UC-connection auth) ----------------------

def test_consent_from_message_extracts_url():
    msg = ('{"error_code":"UNAUTHENTICATED","message":"Credential for user identity(\'71117187309262\') '
           'is not found for the connection \'fevm_mcp\'. Please login first to the connection by '
           'visiting https://fevm-solution-builder.cloud.databricks.com/explore/connections/fevm_mcp?o=7474653032716490"}')
    needs, url = fm._consent_from_message(msg)
    assert needs is True
    assert url == "https://fevm-solution-builder.cloud.databricks.com/explore/connections/fevm_mcp?o=7474653032716490"


def test_consent_from_message_ignores_other_errors():
    needs, url = fm._consent_from_message("Invalid scope, required scopes: unity-catalog")
    assert needs is False
    assert url is None


def test_consent_from_message_treats_invalid_grant_as_needs_consent():
    """An EXPIRED / revoked per-user credential surfaces as an OAuth
    `invalid_grant` token-exchange failure (NOT the 'please login first' string).
    It must ALSO route to the Connect prompt — re-login fixes it exactly like a
    first-time connect. No URL is present in this error, so connect_url is None
    (the route builds a fallback from the app host)."""
    msg = ('{"error_code":"BAD_REQUEST","message":"Failed request to https://mcp-fevm-x/mcp. '
           'Error: The OAuth token exchange failed with HTTP status code 400 Bad Request. '
           'The returned server response or exception message is: Map(error -> invalid_grant, '
           'request_id -> b85..."}')
    needs, url = fm._consent_from_message(msg)
    assert needs is True, "expired credential (invalid_grant) must prompt reconnect"
    assert url is None  # this error carries no connection URL


def test_consent_from_message_treats_token_exchange_failure_as_needs_consent():
    """Any 'OAuth token exchange failed' phrasing is a credential problem the
    user fixes by re-logging into the connection → reconnect prompt."""
    needs, _ = fm._consent_from_message(
        "The OAuth token exchange failed with HTTP status code 400 Bad Request."
    )
    assert needs is True


def test_consent_from_message_catches_expired_and_credential_variants():
    """Other UC phrasings for the same "user must (re)connect" situation must
    ALSO route to the Connect prompt — otherwise a user sees raw error text.
    Covers: access-token expired, refresh-token expired, and the per-user
    'credential ... not found for the connection' shape (no 'login first')."""
    for msg in [
        "The access token has expired.",
        '{"error":"token expired"}',
        "OAuth access token expired; re-authenticate.",
        "Credential for user identity('123') is not found for the connection 'fevm_mcp'.",
    ]:
        needs, _ = fm._consent_from_message(msg)
        assert needs is True, f"should prompt reconnect for: {msg}"


def test_call_fevm_tool_unauth_raises_with_consent():
    class _Unauth:
        def post(self, payload, session_id):
            if payload.get("method") == "initialize":
                return None, {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":
                    '{"error_code":"UNAUTHENTICATED","message":"Please login first by visiting https://x/explore/connections/fevm_mcp?o=1"}'}}
            raise AssertionError("should stop at initialize")
    with pytest.raises(fm.FevmMcpError) as exc:
        fm.call_fevm_tool(tool="list_deployments", arguments={}, transport=_Unauth())
    assert exc.value.needs_consent is True
    assert "explore/connections/fevm_mcp" in (exc.value.connect_url or "")
