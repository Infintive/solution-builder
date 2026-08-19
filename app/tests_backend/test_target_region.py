"""Tests for cross-workspace target → region → catalog resolution.

A user points a project at a target workspace (by URL). The catalog the demo
deploys into is NOT the app's own `DEFAULT_CATALOG` — it's the generic
`solution_builder` catalog onboarded in that target's regional metastore.

A deployment MAY override the catalog name for specific regions (e.g. when the
default name is already taken in a region) by passing an `overrides` map — this
comes from config, set per-deployment, NOT hardcoded here. Three regions have no
catalog provisioned yet and must be rejected, not silently mis-deployed.

These are pure-function tests — no network, no Databricks.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from demo_prompt_generator.backend.remote_deploy import region as tr  # noqa: E402


# --- region → catalog ------------------------------------------------------

def test_all_supported_regions_resolve_to_solution_builder_by_default():
    # With no overrides, EVERY supported region (incl. us-east-2) resolves to
    # the generic default — no region-specific catalog name is baked into code.
    for region in (
        "us-east-1", "us-east-2", "us-west-1", "us-west-2",
        "eu-central-1", "eu-west-1", "eu-west-2",
        "ap-northeast-1", "ap-southeast-1",
    ):
        assert tr.resolve_catalog_for_region(region) == "solution_builder", region


def test_region_override_is_applied_when_provided():
    # A per-deployment override map (from config) can rename the catalog for a
    # region whose default name is taken. The override value is deployment data,
    # never committed to the repo.
    overrides = {"us-east-2": "some_override_catalog"}
    assert tr.resolve_catalog_for_region("us-east-2", overrides=overrides) == "some_override_catalog"
    # other regions unaffected by the override
    assert tr.resolve_catalog_for_region("us-west-2", overrides=overrides) == "solution_builder"


def test_override_for_unonboarded_region_still_rejected():
    # An override can't resurrect a region with no provisioned catalog.
    assert tr.resolve_catalog_for_region("ap-south-1", overrides={"ap-south-1": "x"}) is None


def test_unonboarded_regions_resolve_to_none():
    # No automation workspace / no catalog provisioned yet — must be rejected.
    for region in ("ap-south-1", "ap-southeast-2", "sa-east-1"):
        assert tr.resolve_catalog_for_region(region) is None, region


def test_unknown_region_resolves_to_none():
    assert tr.resolve_catalog_for_region("mars-central-1") is None
    assert tr.resolve_catalog_for_region("") is None
    assert tr.resolve_catalog_for_region(None) is None


def test_region_is_supported_predicate():
    assert tr.region_is_supported("us-east-1") is True
    assert tr.region_is_supported("us-east-2") is True
    assert tr.region_is_supported("ap-south-1") is False
    assert tr.region_is_supported("nonsense") is False


def test_supported_regions_listing_is_nonempty_and_excludes_gaps():
    supported = set(tr.supported_regions())
    assert "us-east-1" in supported
    assert "us-east-2" in supported
    # the three known gaps must not be advertised as supported
    assert supported.isdisjoint({"ap-south-1", "ap-southeast-2", "sa-east-1"})
