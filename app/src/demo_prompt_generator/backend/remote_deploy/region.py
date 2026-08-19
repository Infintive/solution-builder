"""Cross-workspace target → region → catalog resolution.

When a project targets a remote workspace, the demo's Databricks resources land
in a `solution_builder` catalog that lives in that target's **regional
metastore** — NOT the app's own `DEFAULT_CATALOG`. Each target regional
metastore is onboarded once with an SP-owned, OPEN, Default-Storage
`solution_builder` catalog (see `scripts/remote-deploy/onboard-target-region.sh`).

Two wrinkles this encodes:
  * A deployment MAY need a different catalog name in a specific region — e.g.
    when `solution_builder` is already taken there by another app. That rename
    is **deployment-specific data**, so it comes from config as an `overrides`
    map ({region: catalog_name}), never hardcoded here.
  * Three regions (ap-south-1, ap-southeast-2, sa-east-1) have no onboarded
    catalog yet — they resolve to None so the caller can reject the target
    instead of failing mid-deploy. An override cannot resurrect them.

Pure data + functions — no network, no Databricks client. Onboarding a new
region = add it to SUPPORTED_REGIONS (after running the onboarding script);
any per-region rename lives in the deployment's config overrides.
"""
from __future__ import annotations

from typing import Mapping, Optional

# Default catalog name used in every onboarded region.
_DEFAULT_CATALOG = "solution_builder"

# Regions with a provisioned catalog (verified live 2026-07-22). A region
# NOT in this set has no catalog and must be rejected as a deploy target.
SUPPORTED_REGIONS = frozenset(
    {
        "us-east-1",
        "us-east-2",
        "us-west-1",
        "us-west-2",
        "eu-central-1",
        "eu-west-1",
        "eu-west-2",
        "ap-northeast-1",
        "ap-southeast-1",
    }
)


def resolve_catalog_for_region(
    region: Optional[str],
    *,
    overrides: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    """Return the catalog name a demo should deploy into for `region`, or
    None if the region isn't onboarded (no catalog provisioned).

    `overrides` is an optional {region: catalog_name} map (from config) that
    renames the catalog for specific regions whose default name is taken. An
    override for an un-onboarded region is ignored (still None) — it can't
    resurrect a region with no provisioned catalog.

    None is a deliberate, checkable signal — callers must reject rather than
    fall back to some other catalog and mis-deploy.
    """
    if not region or region not in SUPPORTED_REGIONS:
        return None
    if overrides and region in overrides:
        return overrides[region]
    return _DEFAULT_CATALOG


def region_is_supported(region: Optional[str]) -> bool:
    """True iff `region` has a provisioned cross-workspace catalog."""
    return bool(region) and region in SUPPORTED_REGIONS


def supported_regions() -> list[str]:
    """Sorted list of regions with a provisioned catalog (for UI/diagnostics)."""
    return sorted(SUPPORTED_REGIONS)
