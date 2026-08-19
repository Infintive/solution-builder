"""Tests for the cross-workspace target probe (v1).

Before a project deploys to a pasted workspace URL, the app validates it as
the deployer SP, in three tiers — ALL detectable with the SP's own creds
(no account-admin):

  1. REACHABLE — the SP can authenticate to the workspace. Because the SP is
     an account SP, this succeeds ONLY for workspaces in its own account
     (FEVM AWS Stable), which is exactly the account where Cross-Workspace
     Network Policy is enabled. Out-of-account → token/OIDC failure → we
     reject with "only FEVM AWS Stable is supported".
  2. ADMIN — the SP is in the workspace's `admins` group. Required because a
     full `bundle deploy` sets run_as/ownership to the user, which a non-admin
     SP cannot do (verified: 403 "Non-admins can set run_as to themselves
     only"). Not admin → prompt the user to bless the SP via the workspace UI.
  3. CATALOG — the target's region maps to a provisioned catalog.

The probe takes an injected `scim_me` callable so these tests need no network.
It returns a structured verdict the UI renders.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from demo_prompt_generator.backend.remote_deploy import probe as tp  # noqa: E402


# --- fakes -----------------------------------------------------------------

def _scim_reachable_admin(host):
    # SP authenticated AND in the admins group
    return {"id": "78390121415249", "groups": [{"display": "users"}, {"display": "admins"}]}


def _scim_reachable_user_only(host):
    # SP authenticated but only account-users USER (not admin)
    return {"id": "78390121415249", "groups": [{"display": "account users"}, {"display": "users"}]}


def _scim_unreachable(host):
    # cross-account: token can't be minted / 401
    raise tp.TargetUnreachable("token exchange failed for host")


def _region_of(host):
    # crude stub — map hosts used in tests to regions
    return {
        "https://ws-use1.example.com": "us-east-1",
        "https://ws-use2.example.com": "us-east-2",
        "https://ws-apsouth.example.com": "ap-south-1",
    }.get(host)


# --- tier 1: reachability -----------------------------------------------------
# The SP cannot distinguish "out of account" from "in account but SP not added
# yet" — both surface as an OIDC `invalid_client` token failure. The far more
# common (and fixable) cause is that the account-level SP simply hasn't been
# added to the workspace. So an unreachable target is treated as needs-blessing:
# prompt the user to add the SP as a workspace admin, then re-check.

def test_unreachable_target_prompts_to_add_the_sp():
    v = tp.probe_target(
        "https://outside.example.com",
        scim_me=_scim_unreachable,
        region_of=_region_of,
    )
    assert v.reachable is False
    assert v.is_admin is False
    assert v.status == "needs_admin"          # fixable path, NOT a dead end
    assert v.can_deploy is False
    # message must tell the user to add the SP (and note the out-of-account caveat)
    assert "admin" in v.message.lower()
    assert "FEVM AWS Stable" in v.message


# --- tier 2: admin ---------------------------------------------------------

def test_reachable_but_not_admin_prompts_to_bless():
    v = tp.probe_target(
        "https://ws-use1.example.com",
        scim_me=_scim_reachable_user_only,
        region_of=_region_of,
    )
    assert v.reachable is True
    assert v.is_admin is False
    assert v.status == "needs_admin"
    assert v.can_deploy is False
    # still resolves the region/catalog so the UI can show the full picture
    assert v.region == "us-east-1"
    assert v.catalog == "solution_builder"


def test_reachable_admin_supported_region_is_deployable():
    v = tp.probe_target(
        "https://ws-use1.example.com",
        scim_me=_scim_reachable_admin,
        region_of=_region_of,
    )
    assert v.reachable is True
    assert v.is_admin is True
    assert v.region == "us-east-1"
    assert v.catalog == "solution_builder"
    assert v.status == "ready"
    assert v.can_deploy is True


def test_us_east_2_admin_uses_default_catalog_without_overrides():
    # With no catalog overrides passed, even us-east-2 resolves to the generic
    # default. (Region-specific renames come from config overrides, tested in
    # test_target_region.py — not baked into the probe.)
    v = tp.probe_target(
        "https://ws-use2.example.com",
        scim_me=_scim_reachable_admin,
        region_of=_region_of,
    )
    assert v.status == "ready"
    assert v.catalog == "solution_builder"


# --- tier 3: catalog availability ------------------------------------------

def test_admin_but_unonboarded_region_is_rejected():
    v = tp.probe_target(
        "https://ws-apsouth.example.com",
        scim_me=_scim_reachable_admin,
        region_of=_region_of,
    )
    assert v.reachable is True
    assert v.is_admin is True
    assert v.region == "ap-south-1"
    assert v.catalog is None
    assert v.status == "region_unsupported"
    assert v.can_deploy is False


def test_admin_but_region_undeterminable_is_rejected():
    v = tp.probe_target(
        "https://ws-unknownregion.example.com",
        scim_me=_scim_reachable_admin,
        region_of=lambda host: None,
    )
    assert v.reachable is True
    assert v.status in ("region_unknown", "region_unsupported")
    assert v.can_deploy is False


# --- host normalization ----------------------------------------------------

def test_probe_normalizes_bare_host():
    seen = {}
    def scim(host):
        seen["host"] = host
        return {"groups": [{"display": "admins"}]}
    tp.probe_target(
        "ws-use1.example.com/",
        scim_me=scim,
        region_of=lambda h: "us-east-1",
    )
    assert seen["host"] == "https://ws-use1.example.com"
