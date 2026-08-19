"""Cross-workspace ("scale") deploy module — Tier 2.

The generic, FEVM-independent capability that lets ONE shared Solution Builder
app deploy generated demos into OTHER remote workspaces (chosen by pasting a
workspace URL), as a dedicated deployer service principal, with ownership handed
back to the user afterward. Ships to the public OSS build.

Self-contained + optional, on two axes:
  • Runtime-gated by `config.cross_workspace_deploy_enabled` (True only when the
    deployer-SP creds are set). Off → the app is single-workspace; nothing here
    is reached.
  • Physically removable: every generic caller (routes/me, projects, agent,
    project_files) and core.auth's dispatcher import this package under
    try/except, so deleting the `remote_deploy/` directory leaves the app booting
    cleanly as a plain single-workspace (Tier 1) generator.

Layering: `core` → `remote_deploy` → `fevm`. The FEVM module (Tier 3) is the
discovery/provisioning skin BUILT ON TOP of this — it imports the probe/pinning
primitives here. So `fevm/` may be removed alone, but removing `remote_deploy/`
implies removing `fevm/` too (Tier 3 can't exist without Tier 2).

Modules:
  region.py              — region → catalog resolution (config-driven overrides)
  probe.py               — validate a target workspace as the deployer SP
  user_target.py         — per-user setting + per-project target pinning
  ownership_reconcile.py — hand SP-created resources' ownership back to the user
  auth.py                — the deployer-SP .databrickscfg writer + gate predicate
"""
