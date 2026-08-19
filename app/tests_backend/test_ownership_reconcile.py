"""Unit tests for the cross-workspace ownership-reconcile classifier + hash gate.

The classifier is the crux: it must be LOSSLESS where the UI's LLM extractor is
lossy. In particular it must attribute EVERY instance of a type — the real
"Quota Miss Recovery" demo built TWO Genie spaces (genie_space_id +
pipeline_health_genie_space_id) and TWO jobs (ingest_job_id + recovery_job_id),
which the singular-per-type canonical dict would collapse/drop. These tests pin
that behavior against the real manifest shapes found in the repo.

Pure functions only (classify / reconcile_hash / parse_manifest) — no network,
no WorkspaceClient. Executor dispatch is covered by mechanism-selection asserts.

Run: app/.venv/bin/python -m pytest tests_backend/test_ownership_reconcile.py
"""
import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from demo_prompt_generator.backend.remote_deploy import ownership_reconcile as recon  # noqa: E402


def _by_type(actions):
    """{rtype: [values]} for the actions that DO work (not skip/note)."""
    out: dict[str, list[str]] = {}
    for a in actions:
        if a.mechanism in (recon.MECH_SKIP, recon.MECH_NOTE):
            continue
        out.setdefault(a.rtype, []).append(a.value)
    return out


# --- THE headline case: multiple of one type must all survive ---------------

def test_two_genie_spaces_both_classified():
    """The real Quota demo: two distinct genie-space keys → TWO genie actions.
    The LLM extractor keeps only one; the reconcile must keep both."""
    created = {
        "genie_space_id": "01f186e303761105beee2025e45dd7e3",
        "pipeline_health_genie_space_id": "01f186e309a81814be725ceb2901cae8",
    }
    acts = recon.classify(created)
    genie = _by_type(acts).get("genie-space", [])
    assert sorted(genie) == sorted([
        "01f186e303761105beee2025e45dd7e3",
        "01f186e309a81814be725ceb2901cae8",
    ]), "both genie spaces must be attributed, not just the first"
    assert all(a.mechanism == recon.MECH_GENIE for a in acts if a.rtype == "genie-space")


def test_two_jobs_both_classified():
    """Two *_job_id keys → two IS_OWNER job transfers. Jobs aren't even in the
    LLM extractor's CANONICAL_KEYS, so this is pure additive coverage."""
    created = {
        "ingest_job_id": "355103545763424",
        "recovery_job_id": "116891369788871",
    }
    acts = recon.classify(created)
    jobs = _by_type(acts).get("job", [])
    assert sorted(jobs) == sorted(["355103545763424", "116891369788871"])
    assert all(a.mechanism == recon.MECH_JOB for a in acts if a.rtype == "job")


def test_full_quota_demo_manifest():
    """End-to-end on the exact created_resources from the screenshot."""
    created = {
        "workspace_folder": "/Workspace/Users/11111111-.../northwind_quota_demo",
        "catalog": "solution_builder",
        "schema": "demo_quota_miss_recovery_demo",
        "warehouse_id": "351bb3ec09965be1",
        "pipeline_id": "0d55c138-0843-4d5e-b0ab-9397a22f237d",
        "genie_space_id": "01f186e303761105beee2025e45dd7e3",
        "pipeline_health_genie_space_id": "01f186e309a81814be725ceb2901cae8",
        "dashboard_id": "01f186e39388199ca5762c506bd3a5ec",
        "knowledge_assistant_id": "b80c159b-a0da-4b5d-a234-e0a3d414aa13",
        "ingest_job_id": "355103545763424",
        "recovery_job_id": "116891369788871",
    }
    t = _by_type(recon.classify(created))
    assert len(t["genie-space"]) == 2
    assert len(t["job"]) == 2
    assert len(t["pipeline"]) == 1
    assert len(t["dashboard"]) == 1
    assert len(t["knowledge-assistant"]) == 1
    # catalog + warehouse must NOT be transferred
    assert "catalog" not in t and "warehouse" not in t
    # workspace_folder is note-only
    assert "workspace-path" not in t


# --- value-shape collisions must be disambiguated by key, not shape ---------

def test_genie_vs_dashboard_same_shape_different_suffix():
    """genie_space_id and dashboard_id are both 32-hex — only the suffix tells
    them apart. Each must land on its own mechanism."""
    created = {
        "genie_space_id": "01f165c3f19e0000000000000000aaaa",
        "dashboard_id": "01f165c28bfd0000000000000000bbbb",
    }
    acts = {a.rtype: a.mechanism for a in recon.classify(created)}
    assert acts["genie-space"] == recon.MECH_GENIE
    assert acts["dashboard"] == recon.MECH_DASHBOARD


def test_four_uuid_types_disambiguated_by_suffix():
    """pipeline / KA / MAS / lakebase all share the UUID shape."""
    created = {
        "pipeline_id": "0d55c138-0843-4d5e-b0ab-9397a22f237d",
        "knowledge_assistant_id": "b80c159b-a0da-4b5d-a234-e0a3d414aa13",
        "multi_agent_supervisor_id": "aaaa1111-a0da-4b5d-a234-e0a3d414aa13",
        "lakebase_project_id": "bbbb2222-a0da-4b5d-a234-e0a3d414aa13",
    }
    t = {a.rtype: a.mechanism for a in recon.classify(created)}
    assert t["pipeline"] == recon.MECH_PIPELINE
    assert t["knowledge-assistant"] == recon.MECH_KA_SHARE
    assert t["multi-agent-supervisor"] == recon.MECH_MAS_SHARE
    # lakebase project_id (no slug) is a child → skip
    assert "database-project" not in t


def test_standalone_serving_endpoint_and_vector_index():
    """Capabilities main added: ml-training-serving (serving_endpoint_name → a
    standalone serving endpoint, CAN_MANAGE) and vector-search
    (vector_index_full_name → a dotted UC object, ALTER OWNER)."""
    created = {
        "serving_endpoint_name": "my-model-endpoint",
        "vector_index_full_name": "cat.sch.my_index",
    }
    t = {a.rtype: a.mechanism for a in recon.classify(created)}
    assert t["serving-endpoint"] == recon.MECH_ENDPOINT
    assert t["uc-object"] == recon.MECH_UC_OWNER


def test_dotted_uc_model_vs_metric_view():
    created = {
        "ml_model_name": "cat.sch.customer_premium_classifier",
        "metric_view_name": "cat.sch.mv_returns",
    }
    t = {a.rtype: a.mechanism for a in recon.classify(created)}
    assert t["uc-model"] == recon.MECH_UC_MODEL
    assert t["uc-metric-view"] == recon.MECH_UC_METRIC


# --- KA/MAS produce BOTH an object share AND an endpoint CAN_MANAGE ----------

def test_ka_yields_object_share_and_endpoint_can_manage():
    created = {
        "knowledge_assistant_id": "b80c159b-a0da-4b5d-a234-e0a3d414aa13",
        "knowledge_assistant_endpoint": "ka-a700b36c-endpoint",
    }
    acts = recon.classify(created)
    mechs = {a.rtype: a.mechanism for a in acts}
    assert mechs["knowledge-assistant"] == recon.MECH_KA_SHARE
    assert mechs["serving-endpoint"] == recon.MECH_ENDPOINT
    assert len([a for a in acts if a.mechanism not in (recon.MECH_SKIP, recon.MECH_NOTE)]) == 2


def test_mas_yields_object_share_and_endpoint():
    created = {
        "multi_agent_supervisor_id": "aaaa1111-a0da-4b5d-a234-e0a3d414aa13",
        "multi_agent_supervisor_endpoint": "mas-73efcd8f-endpoint",
    }
    mechs = {a.rtype: a.mechanism for a in recon.classify(created)}
    assert mechs["multi-agent-supervisor"] == recon.MECH_MAS_SHARE
    assert mechs["serving-endpoint"] == recon.MECH_ENDPOINT


# --- nested app object, lakebase trio, non-resource junk ---------------------

def test_nested_app_object_expands_to_app_name():
    created = {"app": {"name": "my-app", "id": "app-1", "deployment_note": "ok", "url": "https://x"}}
    acts = recon.classify(created)
    apps = [a for a in acts if a.rtype == "app"]
    assert len(apps) == 1
    assert apps[0].value == "my-app"
    assert apps[0].mechanism == recon.MECH_APP


def test_lakebase_trio_only_slug_transfers():
    created = {
        "lakebase_project_id": "bbbb2222-a0da-4b5d-a234-e0a3d414aa13",
        "lakebase_project_slug": "dbdemos-asset-generator",
        "lakebase_database": "dbgen_luxebeauty_demo",
    }
    t = _by_type(recon.classify(created))
    assert t.get("database-project") == ["dbdemos-asset-generator"]
    # id + database are children → not their own transfers
    assert "database-project-child" not in t


def test_non_resource_junk_ignored():
    created = {
        "bad_lot_id": "LOT-2026-0430",
        "app": {"name": "a", "id": "b", "deployment_note": "note", "url": "http://x"},
        "some_url": "https://example.com",
    }
    t = _by_type(recon.classify(created))
    # only the app is a real resource
    assert set(t.keys()) == {"app"}


# --- placeholders (reference/template manifests) must not be transferred -----

def test_placeholder_values_not_classified():
    created = {
        "warehouse_id": "<your-warehouse-id>",
        "pipeline_id": "<your-pipeline-uuid>",
        "genie_space_id": "<built-live-in-the-workshop>",
        "dashboard_id": "<your-dashboard-uuid>",
    }
    work = [a for a in recon.classify(created)
            if a.mechanism not in (recon.MECH_SKIP, recon.MECH_NOTE)]
    assert work == [], "placeholder tokens must never be re-homed"


# --- schema is ordered LAST, children before it ------------------------------

def test_schema_ordered_after_children():
    created = {
        "schema": "demo_x",
        "ml_model_name": "cat.demo_x.churn_model",
        "metric_view_name": "cat.demo_x.mv_returns",
    }
    acts = sorted(recon.classify(created), key=lambda a: a.order)
    orders = [(a.rtype, a.order) for a in acts]
    schema_order = next(o for r, o in orders if r == "schema")
    child_orders = [o for r, o in orders if r in ("uc-model", "uc-metric-view")]
    assert all(c < schema_order for c in child_orders), "children must precede schema"


# --- hash gate ---------------------------------------------------------------

def test_hash_stable_across_whitespace_and_key_order():
    a = '{"created_resources": {"genie_space_id": "01f1", "pipeline_id": "aaaa1111-a0da-4b5d-a234-e0a3d414aa13"}}'
    b = '{\n  "created_resources": {\n    "pipeline_id": "aaaa1111-a0da-4b5d-a234-e0a3d414aa13",\n    "genie_space_id": "01f1"\n  }\n}'
    ma, mb = recon.parse_manifest(a), recon.parse_manifest(b)
    assert recon.reconcile_hash(ma, "u@co") == recon.reconcile_hash(mb, "u@co")


def test_hash_changes_when_resource_added():
    base = recon.parse_manifest('{"created_resources": {"genie_space_id": "01f186e303761105beee2025e45dd7e3"}}')
    more = recon.parse_manifest('{"created_resources": {"genie_space_id": "01f186e303761105beee2025e45dd7e3", "recovery_job_id": "116891369788871"}}')
    assert recon.reconcile_hash(base, "u@co") != recon.reconcile_hash(more, "u@co")


def test_hash_changes_when_user_changes():
    m = recon.parse_manifest('{"created_resources": {"genie_space_id": "01f186e303761105beee2025e45dd7e3"}}')
    assert recon.reconcile_hash(m, "a@co") != recon.reconcile_hash(m, "b@co")


def test_hash_ignores_skip_and_note_keys():
    """Adding/removing a catalog or warehouse (skip) or folder (note) must not
    change the hash — they do no work, so they don't warrant a re-run."""
    m1 = recon.parse_manifest('{"created_resources": {"genie_space_id": "01f1"}}')
    m2 = recon.parse_manifest('{"created_resources": {"genie_space_id": "01f1", "catalog": "solution_builder", "warehouse_id": "351bb3ec09965be1", "workspace_folder": "/Workspace/x"}}')
    assert recon.reconcile_hash(m1, "u@co") == recon.reconcile_hash(m2, "u@co")


# --- parse robustness --------------------------------------------------------

def test_parse_manifest_handles_bad_json():
    assert recon.parse_manifest("") is None
    assert recon.parse_manifest("not json {{{") is None
    assert recon.parse_manifest("[]") is None  # not a dict
    assert recon.parse_manifest('{"created_resources": {}}') == {"created_resources": {}}


def test_created_resources_flat_fallback():
    """A flat manifest (no created_resources wrapper) still classifies."""
    m = recon.parse_manifest('{"genie_space_id": "01f186e303761105beee2025e45dd7e3", "capabilities": {"buildable": ["genie"]}}')
    created = recon._created_resources(m)
    assert "genie_space_id" in created
    assert "capabilities" not in created  # envelope stripped


def test_empty_created_resources_yields_no_work():
    m = recon.parse_manifest('{"capabilities": {"buildable": []}, "created_resources": {}}')
    acts = recon.classify(recon._created_resources(m))
    assert [a for a in acts if a.mechanism not in (recon.MECH_SKIP, recon.MECH_NOTE)] == []


# --- view owner-transfer fallback (the live bug: ALTER VIEW OWNER denied) -----

def _act(value, rtype, mech):
    return recon.OwnershipAction("<live>", value, rtype, mech)


def test_uc_object_kw_maps_types():
    assert recon._uc_object_kw(_act("c.s.t", "uc-table", recon.MECH_UC_OWNER)) == "TABLE"
    assert recon._uc_object_kw(_act("c.s.v", "uc-view", recon.MECH_UC_OWNER)) == "VIEW"
    assert recon._uc_object_kw(_act("c.s.mv", "uc-materialized_view", recon.MECH_UC_OWNER)) == "MATERIALIZED VIEW"
    assert recon._uc_object_kw(_act("c.s.vol", "uc-volume", recon.MECH_UC_OWNER)) == "VOLUME"
    assert recon._uc_object_kw(_act("c.s.fn", "uc-function", recon.MECH_UC_OWNER)) == "FUNCTION"
    # metric view → VIEW keyword regardless of rtype
    assert recon._uc_object_kw(_act("c.s.m", "uc-metric-view", recon.MECH_UC_METRIC)) == "VIEW"


def test_alter_owner_sql_uses_object_keyword():
    stmt = recon._alter_owner_sql(_act("cat.sch.holdings_asof", "uc-view", recon.MECH_UC_OWNER), "u@co")
    assert stmt == "ALTER VIEW `cat`.`sch`.`holdings_asof` OWNER TO `u@co`"
    # non-3-part → None (schema handled separately)
    assert recon._alter_owner_sql(_act("just_schema", "schema", recon.MECH_UC_SCHEMA), "u@co") is None


def test_alter_target_fqn_backtick_quotes():
    assert recon._alter_target_fqn(_act("c.s.t", "uc-table", recon.MECH_UC_OWNER)) == "`c`.`s`.`t`"
    assert recon._alter_target_fqn(_act("bad.two", "x", recon.MECH_UC_OWNER)) is None


def test_is_owner_transfer_denied_matches_view_message():
    # the exact live error
    assert recon._is_owner_transfer_denied(
        "PERMISSION_DENIED: Non-admin user can only transfer ownerships for views to groups the owner is a member of."
    ) is True
    # generic permission-denied on an owner op
    assert recon._is_owner_transfer_denied("PERMISSION_DENIED: cannot change OWNER") is True
    # unrelated errors → not a transfer-denial (don't trigger the GRANT fallback)
    assert recon._is_owner_transfer_denied("TABLE_OR_VIEW_NOT_FOUND: ...") is False
    assert recon._is_owner_transfer_denied("") is False
    assert recon._is_owner_transfer_denied(None) is False


# --- CUJ1: grant-only mid-build transform -----------------------------------

def test_as_grant_only_rewrites_transfers_to_grants():
    # UC owner-transfer → GRANT ALL (read) on the object, keeps child order
    t = recon._as_grant_only(_act("c.s.tbl", "uc-table", recon.MECH_UC_OWNER), "s")
    assert t.mechanism == recon.MECH_UC_GRANT and t.order == recon._ORDER_UC_CHILD
    mv = recon._as_grant_only(_act("c.s.m", "uc-metric-view", recon.MECH_UC_METRIC), "s")
    assert mv.mechanism == recon.MECH_UC_GRANT
    # schema transfer → USE SCHEMA grant (NOT ALTER OWNER), earlier order
    sc = recon._as_grant_only(_act("c.s", "schema", recon.MECH_UC_SCHEMA), "s")
    assert sc.mechanism == recon.MECH_SCHEMA_GRANT and sc.order == recon._ORDER_CATALOG_GRANT
    # model → skipped (NOTE) mid-build
    ml = recon._as_grant_only(_act("c.s.mdl", "uc-model", recon.MECH_UC_MODEL), "s")
    assert ml.mechanism == recon.MECH_NOTE


def test_as_grant_only_passes_through_additive_mechanisms():
    # CAN_MANAGE / IS_OWNER / share are already additive — unchanged
    for mech in (recon.MECH_GENIE, recon.MECH_DASHBOARD, recon.MECH_JOB,
                 recon.MECH_PIPELINE, recon.MECH_KA_SHARE, recon.MECH_ENDPOINT):
        a = _act("some-id", "x", mech)
        assert recon._as_grant_only(a, "s").mechanism == mech


def _manifest(created):
    return {"created_resources": created}


def test_grant_only_plan_has_no_alter_owner():
    """A grant-only dry-run must contain ZERO ownership-transfer mechanisms."""
    m = _manifest({
        "catalog": "solution_builder",
        "schema": "demo_x",
        "genie_space_id": "01f186e303761105beee2025e45dd7e3",
        "dashboard_id": "01f186e39388199ca5762c506bd3a5ec",
    })
    res = recon.reconcile_ownership(
        sp_ws=None, warehouse_id=None, user_email="u@co", manifest=m,
        catalog="solution_builder", schema="demo_x",
        grant_only=True, dry_run=True,
    )
    transfer_mechs = {recon.MECH_UC_OWNER, recon.MECH_UC_METRIC, recon.MECH_UC_SCHEMA, recon.MECH_UC_MODEL}
    plan_mechs = {p.split("→")[-1].strip() for p in res.plan}
    assert not (plan_mechs & transfer_mechs), f"grant-only leaked a transfer: {res.plan}"


def test_transfer_mode_without_sp_client_id_skips_writeback():
    """No sp_client_id → no SP write-back actions (logged, not crashed).
    (No warehouse → no live children, so this checks the manifest-only plan.)"""
    m = _manifest({"catalog": "c", "schema": "s", "genie_space_id": "01f1"})
    res = recon.reconcile_ownership(
        sp_ws=None, warehouse_id=None, user_email="u@co", manifest=m,
        catalog="c", schema="s", sp_client_id=None, dry_run=True,
    )
    assert not any("writeback" in p for p in res.plan)
