"""Tests for USER-level cross-workspace deploy target resolution (v1).

The deploy target is a per-USER account setting (set once on the home page),
NOT per-project. The deploy path resolves the effective target for the acting
user via `resolve_user_target(...)`:

  1. the user's saved UserSettings.target_workspace_host, else
  2. the server default (config.default_target_workspace_host), else
  3. None (→ classic same-workspace OBO).

Pure resolution logic — the DB lookup is injected so no database is needed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from demo_prompt_generator.backend.remote_deploy import user_target as ut  # noqa: E402


class _Cfg:
    # cross_workspace_deploy_enabled defaults True here: these tests exercise the
    # resolution logic, which only runs when the feature is ON. The OFF case is
    # covered explicitly by the "flag off" tests below.
    def __init__(self, default="", cross_workspace_deploy_enabled=True,
                 databricks_host="https://app-own-ws.example.com"):
        self.default_target_workspace_host = default
        self.cross_workspace_deploy_enabled = cross_workspace_deploy_enabled
        # The app's OWN workspace host — where a legacy project's pre-Model-3
        # resources physically live (they were built via OBO on this workspace).
        self.databricks_host = databricks_host


def test_user_setting_wins_over_default():
    got = ut.resolve_user_target(
        user_target="https://ws-user.example.com",
        config=_Cfg(default="https://ws-default.example.com"),
    )
    assert got == "https://ws-user.example.com"


def test_falls_back_to_server_default_when_user_unset():
    got = ut.resolve_user_target(
        user_target=None,
        config=_Cfg(default="https://ws-default.example.com"),
    )
    assert got == "https://ws-default.example.com"


def test_empty_user_target_is_treated_as_unset():
    got = ut.resolve_user_target(
        user_target="   ",
        config=_Cfg(default="https://ws-default.example.com"),
    )
    assert got == "https://ws-default.example.com"


def test_none_everywhere_resolves_to_none():
    assert ut.resolve_user_target(user_target=None, config=_Cfg(default="")) is None
    assert ut.resolve_user_target(user_target="", config=_Cfg(default="")) is None


def test_result_is_normalized_https():
    got = ut.resolve_user_target(user_target="ws-user.example.com/", config=_Cfg())
    assert got == "https://ws-user.example.com"
    got2 = ut.resolve_user_target(user_target=None, config=_Cfg(default="ws-default.example.com"))
    assert got2 == "https://ws-default.example.com"


# --- Per-project pinning (v2): a project's target is FROZEN at first deploy ---

class _Proj:
    """Minimal stand-in for a Project row."""
    def __init__(self, target_workspace_host=None):
        self.target_workspace_host = target_workspace_host


class _FakeSession:
    """Fake session: no UserSettings row (deployed mode) → get_user_target None,
    so resolve_project_target's fallback uses the config default. Tracks commits."""
    def __init__(self):
        self.committed = 0
        self.added = []
    def get(self, model, key):
        return None  # no UserSettings row
    def add(self, obj):
        self.added.append(obj)
    def commit(self):
        self.committed += 1


def test_pinned_project_target_wins_over_live_user_setting():
    """The invariant: once a project is pinned, its target is authoritative even
    if the user's current account setting points elsewhere."""
    proj = _Proj(target_workspace_host="https://ws-pinned.example.com")
    # config default (the live fallback) points at a DIFFERENT workspace
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-changed-later.example.com"),
    )
    assert got == "https://ws-pinned.example.com", "pinned target must win"


def test_unpinned_project_falls_back_to_live_target():
    """First deploy / brand-NEW project (unpinned, no built resources yet) →
    resolve from the live setting so the user's picker choice takes effect."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-default.example.com"),
    )
    assert got == "https://ws-default.example.com"


# --- Legacy-project hijack guard (v3) ------------------------------------------
# A project that ALREADY has built resources but no pinned target is a LEGACY
# (pre-Model-3) project: its resources were provisioned via OBO on the app's OWN
# workspace. On its first Model-3 build we must NOT fall back to the user's live
# remote-target selection (that would pin the wrong workspace and the resource
# tiles / iterate would fail to reach the resources, which live on the app's
# own host). Instead it resolves to the app-own workspace where its resources
# actually are. New (empty) projects are unaffected.

def test_legacy_project_with_resources_resolves_to_app_own_host_not_user_target():
    """The hijack fix: an unpinned project that HAS built resources resolves to
    the app's own workspace host — NOT the user's live remote-target setting."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-remote-picked.example.com",
                    databricks_host="https://app-own-ws.example.com"),
        has_built_resources=True,
    )
    assert got == "https://app-own-ws.example.com", (
        "legacy project must resolve to app-own host, not the user's remote pick"
    )


def test_resolve_and_pin_freezes_legacy_project_to_app_host():
    """resolve_and_pin: a legacy (built, unpinned) project resolves to the app-own
    host AND gets pinned there, so every later call (tiles, .databrickscfg,
    deploy) returns the SAME host even if the user's live setting changes."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    cfg = _Cfg(default="https://ws-remote.example.com",
               databricks_host="https://app-own-ws.example.com")
    got = ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess, config=cfg,
        has_built_resources=True, can_pin=True,
    )
    assert got == "https://app-own-ws.example.com"
    assert proj.target_workspace_host == "https://app-own-ws.example.com", "must PIN"
    assert sess.committed == 1
    # a later call with a DIFFERENT live setting must still return the pinned host
    got2 = ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess,
        config=_Cfg(default="https://ws-CHANGED.example.com",
                    databricks_host="https://app-own-ws.example.com"),
        has_built_resources=True, can_pin=True,
    )
    assert got2 == "https://app-own-ws.example.com", "pinned target must persist"


def test_resolve_and_pin_new_project_pins_the_users_pick():
    """A brand-new (empty) project pins the user's live remote pick on first call —
    that becomes its immutable target for the rest of its lifecycle."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    cfg = _Cfg(default="https://ws-remote.example.com",
               databricks_host="https://app-own-ws.example.com")
    got = ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess, config=cfg,
        has_built_resources=False, can_pin=True,
    )
    assert got == "https://ws-remote.example.com"
    assert proj.target_workspace_host == "https://ws-remote.example.com", "pins the pick"


def test_resolve_and_pin_does_not_pin_when_cannot_pin():
    """A viewer / non-driver (can_pin=False) resolves the same host but must NOT
    write a pin (it's not their project to freeze)."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    cfg = _Cfg(default="https://ws-remote.example.com",
               databricks_host="https://app-own-ws.example.com")
    got = ut.resolve_and_pin_project_target(
        project=proj, user_email="viewer@x.com", session=sess, config=cfg,
        has_built_resources=True, can_pin=False,
    )
    assert got == "https://app-own-ws.example.com", "still resolves correctly"
    assert proj.target_workspace_host is None, "must NOT pin when can_pin=False"
    assert sess.committed == 0


def test_lifecycle_empty_draft_not_pinned_on_open_then_frozen_at_build():
    """End-to-end lifecycle invariant (the reported bug):
      1. empty draft opened by driver → resolves to the live pick but is NOT
         pinned (read paths pass can_pin only when the project has built
         resources), so the user can still change the target;
      2. build starts → deploy path pins (can_pin=True) whatever the pick is now;
      3. later the user changes their live setting → the project keeps its
         pinned target in every path (tiles + .databrickscfg + redeploy)."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    live_A = _Cfg(default="https://ws-A.example.com", databricks_host="https://app-own.example.com")

    # 1. open an EMPTY draft as driver — read paths gate can_pin on has_built,
    #    so an empty project is NOT pinned here.
    got_open = ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess, config=live_A,
        has_built_resources=False, can_pin=False,  # empty ⇒ callers pass can_pin=False
    )
    assert got_open == "https://ws-A.example.com"
    assert proj.target_workspace_host is None, "empty draft must stay unpinned"

    # 2. build starts (deploy path always can_pin=True) → freeze the current pick.
    ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess, config=live_A,
        has_built_resources=False, can_pin=True,
    )
    assert proj.target_workspace_host == "https://ws-A.example.com", "pinned at build"

    # 3. user later switches their live target to ws-B — project stays on ws-A
    #    in EVERY path (built project now; read paths would try to pin, but it's
    #    already frozen → immutable).
    live_B = _Cfg(default="https://ws-B.example.com", databricks_host="https://app-own.example.com")
    for can_pin in (True, False):  # deploy path and read path
        got = ut.resolve_and_pin_project_target(
            project=proj, user_email="u@x.com", session=sess, config=live_B,
            has_built_resources=True, can_pin=can_pin,
        )
        assert got == "https://ws-A.example.com", "pinned target persists across a live-setting change"


def test_resolve_and_pin_flag_off_returns_none_no_pin():
    """Feature off → None, and never pins."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    got = ut.resolve_and_pin_project_target(
        project=proj, user_email="u@x.com", session=sess,
        config=_Cfg(default="https://ws.example.com", cross_workspace_deploy_enabled=False),
        has_built_resources=True, can_pin=True,
    )
    assert got is None
    assert proj.target_workspace_host is None
    assert sess.committed == 0


def test_new_empty_project_still_uses_live_target_even_with_guard_param():
    """A brand-new project (no built resources) keeps the current behavior: the
    user's live remote target wins, so target selection works for new builds."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-remote-picked.example.com",
                    databricks_host="https://app-own-ws.example.com"),
        has_built_resources=False,
    )
    assert got == "https://ws-remote-picked.example.com"


def test_legacy_guard_defaults_off_for_backward_compat():
    """has_built_resources defaults to False so existing callers are unchanged."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-default.example.com"),
    )
    assert got == "https://ws-default.example.com"


def test_pinned_project_ignores_legacy_guard():
    """An already-pinned project is authoritative regardless of has_built_resources
    — the guard only affects the UNPINNED fallback path."""
    proj = _Proj(target_workspace_host="https://ws-pinned.example.com")
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-default.example.com",
                    databricks_host="https://app-own-ws.example.com"),
        has_built_resources=True,
    )
    assert got == "https://ws-pinned.example.com"


def test_legacy_guard_still_gated_by_feature_flag():
    """Flag OFF ⇒ None even for a legacy built project (the source gate wins)."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-default.example.com",
                    databricks_host="https://app-own-ws.example.com",
                    cross_workspace_deploy_enabled=False),
        has_built_resources=True,
    )
    assert got is None


# --- has_built_resources detector (DB-only, no LLM extraction) -----------------
# A cheap check the call sites use to feed the legacy guard: does the project's
# resources.json carry any REAL created resource (not just placeholders/empties)?

class _FileSync:
    """Fake file_sync.get_file_content: serves canned resources.json bytes."""
    def __init__(self, by_path):
        self._by = by_path
    def get_file_content(self, project_id, path, session=None):
        v = self._by.get(path)
        return v.encode("utf-8") if isinstance(v, str) else v


def test_has_built_resources_true_when_created_resources_present():
    fs = _FileSync({"resources.json":
        '{"created_resources": {"etl_job_id": "482910371056"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is True


def test_has_built_resources_false_when_created_resources_empty():
    fs = _FileSync({"resources.json": '{"created_resources": {}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is False


def test_has_built_resources_false_when_only_placeholders():
    fs = _FileSync({"resources.json":
        '{"created_resources": {"job_id": "<your-job-id>", "schema": "<schema>"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is False


def test_has_built_resources_false_when_no_resources_json():
    assert ut.project_has_built_resources(_FileSync({}), "p1", session=None) is False


def test_has_built_resources_checks_legacy_paths():
    fs = _FileSync({"specifications/resources.json":
        '{"created_resources": {"dashboard_id": "01f0aa11"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is True


def test_has_built_resources_tolerates_bad_json():
    assert ut.project_has_built_resources(
        _FileSync({"resources.json": "{not valid"}), "p1", session=None) is False


def test_has_built_resources_false_for_skip_only_manifest():
    """catalog + warehouse are MECH_SKIP in the reconciler (not owned resources),
    so a manifest with ONLY those must NOT count as 'built' — otherwise a project
    that got a catalog/warehouse stamped but deployed nothing would be treated as
    legacy and pinned, overriding the user's target pick. Detector must agree with
    the reconciler's material set (which is empty here)."""
    fs = _FileSync({"resources.json":
        '{"created_resources": {"catalog": "solution_builder", "warehouse_id": "abc123"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is False


def test_has_built_resources_false_for_note_only_manifest():
    """workspace_folder is MECH_NOTE (record-only) — not a built resource."""
    fs = _FileSync({"resources.json":
        '{"created_resources": {"workspace_folder": "/Workspace/Users/x/demo"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is False


def test_has_built_resources_true_when_real_resource_alongside_skips():
    """A real resource (job) alongside catalog/warehouse still counts as built."""
    fs = _FileSync({"resources.json":
        '{"created_resources": {"catalog": "c", "warehouse_id": "w", "etl_job_id": "482910371056"}}'})
    assert ut.project_has_built_resources(fs, "p1", session=None) is True


# --- guard degrades safely when the app's own host is unknown ------------------

def test_legacy_guard_returns_none_when_app_host_missing():
    """If config.databricks_host is empty (host not injected), the guard can't
    resolve the app-own host → returns None (safe degrade to OBO/same-workspace),
    never crashes."""
    proj = _Proj(target_workspace_host=None)
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-remote.example.com", databricks_host=""),
        has_built_resources=True,
    )
    assert got is None


def test_pinned_target_is_normalized():
    proj = _Proj(target_workspace_host="ws-pinned.example.com/")
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(), config=_Cfg())
    assert got == "https://ws-pinned.example.com"


def test_pin_project_target_freezes_and_is_immutable():
    """pin writes the host on first deploy; a second pin (even to a new host) is
    a no-op — the first target is immutable."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    ut.pin_project_target(sess, proj, "ws-first.example.com")
    assert proj.target_workspace_host == "https://ws-first.example.com"
    assert sess.committed == 1
    # attempt to re-pin to a different host → ignored
    ut.pin_project_target(sess, proj, "https://ws-second.example.com")
    assert proj.target_workspace_host == "https://ws-first.example.com", "pin is immutable"
    assert sess.committed == 1, "no second commit — re-pin is a no-op"


def test_pin_project_target_noop_when_no_target():
    """Same-workspace / unset target → nothing to pin, no commit."""
    proj = _Proj(target_workspace_host=None)
    sess = _FakeSession()
    ut.pin_project_target(sess, proj, None)
    assert proj.target_workspace_host is None
    assert sess.committed == 0


def test_pin_project_target_noop_when_project_none():
    sess = _FakeSession()
    ut.pin_project_target(sess, None, "ws.example.com")  # must not raise
    assert sess.committed == 0


# --- Feature-gate: flag OFF ⇒ NO target ever resolves (the single source of ---
# --- truth for "OSS install has cross-workspace deploy off"). This is enforced
# --- at the RESOLVE source so a stranded/pinned host can never be acted on, and
# --- so no future consumer can bypass the gate by forgetting to re-check it.

def test_resolve_user_target_returns_none_when_flag_off():
    """Even with a user setting AND a server default, the flag being off means
    nothing resolves → classic same-workspace OBO."""
    got = ut.resolve_user_target(
        user_target="https://ws-user.example.com",
        config=_Cfg(default="https://ws-default.example.com",
                    cross_workspace_deploy_enabled=False),
    )
    assert got is None, "flag off must suppress even an explicit user target"


def test_resolve_project_target_returns_none_when_flag_off_even_if_pinned():
    """A project pinned while the feature was on must NOT resolve its target once
    the feature is off — the gate lives at the source, not the call sites."""
    proj = _Proj(target_workspace_host="https://ws-pinned.example.com")
    got = ut.resolve_project_target(
        project=proj, user_email="u@x.com", session=_FakeSession(),
        config=_Cfg(default="https://ws-default.example.com",
                    cross_workspace_deploy_enabled=False),
    )
    assert got is None, "flag off must suppress even a pinned project target"


def test_resolve_missing_flag_attr_treated_as_off():
    """A config object with no cross_workspace_deploy_enabled attribute (defensive)
    is treated as OFF, never as ON."""
    class _BareCfg:
        default_target_workspace_host = "https://ws-default.example.com"
    assert ut.resolve_user_target(user_target="https://ws-user.example.com",
                                  config=_BareCfg()) is None
