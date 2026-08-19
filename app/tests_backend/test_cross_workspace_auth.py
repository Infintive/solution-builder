"""Unit tests for the Option-A cross-workspace deploy auth path.

Covers the two additive pieces in core/auth.py:
  - write_project_sp_auth_file: writes an OAuth-M2M .databrickscfg (client_id/
    client_secret + target host) — the deployer-SP variant.
  - subprocess_auth_env(target_deploy=True): points at that file with
    auth_type=oauth-m2m and does NOT scrub client creds; target_deploy=False
    (default) must be byte-for-byte the original OBO behavior.

Run: app/.venv/bin/python -m pytest tests_backend/test_cross_workspace_auth.py
(from the app/ dir, with src on the path — see the sys.path shim below).
"""
import os
import sys
import stat
from pathlib import Path

# Make `demo_prompt_generator` importable without installing the package.
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from demo_prompt_generator.backend.core import auth  # noqa: E402
# The deployer-SP writer moved to the remote_deploy module (the OBO writer +
# dispatcher stay in core.auth). target_deploy_active is re-exported from
# core.auth (delegating wrapper) so `auth.target_deploy_active` below still works.
from demo_prompt_generator.backend.remote_deploy import auth as rd_auth  # noqa: E402


def _read_cfg(project_dir: Path) -> str:
    return (project_dir / auth.AUTH_FILE_NAME).read_text()


def test_sp_auth_file_writes_oauth_m2m_stanza(tmp_path):
    p = rd_auth.write_project_sp_auth_file(
        tmp_path,
        host="https://fevm-target.cloud.databricks.com",
        client_id="cid-123",
        client_secret="sekret-xyz",
    )
    assert p == tmp_path / auth.AUTH_FILE_NAME
    cfg = _read_cfg(tmp_path)
    assert f"[{auth.AUTH_FILE_PROFILE}]" in cfg
    assert "host          = https://fevm-target.cloud.databricks.com" in cfg
    assert "client_id     = cid-123" in cfg
    assert "client_secret = sekret-xyz" in cfg
    # It must NOT be the PAT stanza.
    assert "token =" not in cfg


def test_sp_auth_file_is_0600(tmp_path):
    p = rd_auth.write_project_sp_auth_file(
        tmp_path, host="https://h", client_id="c", client_secret="s"
    )
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_subprocess_env_target_deploy_uses_oauth_m2m_and_does_not_scrub(tmp_path):
    # Write the SP cfg first so the env builder can read the target host back.
    rd_auth.write_project_sp_auth_file(
        tmp_path,
        host="https://fevm-target.cloud.databricks.com",
        client_id="cid-123",
        client_secret="sekret-xyz",
    )
    env = auth.subprocess_auth_env(tmp_path, mode="deployed", target_deploy=True)
    assert env["DATABRICKS_CONFIG_FILE"] == str(tmp_path / auth.AUTH_FILE_NAME)
    assert env["DATABRICKS_CONFIG_PROFILE"] == auth.AUTH_FILE_PROFILE
    assert env["DATABRICKS_AUTH_TYPE"] == "oauth-m2m"


def test_subprocess_env_target_deploy_injects_sp_creds_and_target_host(tmp_path):
    """THE cross-workspace bug: the Apps runtime sets DATABRICKS_HOST AND
    DATABRICKS_CLIENT_ID/SECRET (the APP's own SP) in the parent env, and those
    inherited env vars win over the DATABRICKS_CONFIG_FILE. Without overriding
    them, the subprocess authenticates as the APP SP against the HOST workspace
    — exactly why demo resources landed in the host, owned by the app SP.
    The target_deploy env MUST inject the deployer SP's host + client_id/secret
    as explicit env vars, and blank any inherited PAT."""
    rd_auth.write_project_sp_auth_file(
        tmp_path,
        host="https://fevm-target.cloud.databricks.com",
        client_id="deployer-cid",
        client_secret="deployer-secret",
    )
    env = auth.subprocess_auth_env(tmp_path, mode="deployed", target_deploy=True)
    assert env["DATABRICKS_HOST"] == "https://fevm-target.cloud.databricks.com"
    assert env["DATABRICKS_CLIENT_ID"] == "deployer-cid"
    assert env["DATABRICKS_CLIENT_SECRET"] == "deployer-secret"
    assert env["DATABRICKS_AUTH_TYPE"] == "oauth-m2m"
    # A stray inherited PAT must not shadow the SP's oauth-m2m.
    assert env["DATABRICKS_TOKEN"] == ""


def test_subprocess_env_target_deploy_fails_closed_without_creds(tmp_path):
    """If the SP cfg is missing/unreadable, do NOT fall through to the app SP /
    host workspace — return only the config-file pointer (no host/creds env)."""
    env = auth.subprocess_auth_env(tmp_path, mode="deployed", target_deploy=True)
    assert "DATABRICKS_HOST" not in env
    assert "DATABRICKS_CLIENT_ID" not in env


def test_read_sp_creds_from_cfg(tmp_path):
    rd_auth.write_project_sp_auth_file(
        tmp_path, host="https://h.cloud.databricks.com", client_id="c1", client_secret="s1"
    )
    host, cid, secret = auth._read_sp_creds_from_cfg(tmp_path / auth.AUTH_FILE_NAME)
    assert (host, cid, secret) == ("https://h.cloud.databricks.com", "c1", "s1")
    assert auth._read_sp_creds_from_cfg(tmp_path / "nonexistent") == (None, None, None)


def test_subprocess_env_default_is_unchanged_obo_behavior(tmp_path):
    """Regression guard: with target_deploy omitted, the deployed-mode env is
    byte-for-byte the original OBO contract (pat + scrubbed client creds)."""
    env = auth.subprocess_auth_env(tmp_path, mode="deployed")
    assert env == {
        "DATABRICKS_CONFIG_FILE": str(tmp_path / auth.AUTH_FILE_NAME),
        "DATABRICKS_CONFIG_PROFILE": auth.AUTH_FILE_PROFILE,
        "DATABRICKS_AUTH_TYPE": "pat",
        "DATABRICKS_CLIENT_ID": "",
        "DATABRICKS_CLIENT_SECRET": "",
    }


class _FakeConfig:
    """Minimal stand-in for AppConfig for the central-decider tests."""
    def __init__(self, client_id="", client_secret=""):
        self.deployer_sp_client_id = client_id
        self.deployer_sp_client_secret = client_secret

    @property
    def cross_workspace_deploy_enabled(self):
        return bool(self.deployer_sp_client_id and self.deployer_sp_client_secret)


def test_target_deploy_active_predicate():
    sp = _FakeConfig("cid", "sec")
    nosp = _FakeConfig()
    assert auth.target_deploy_active(sp, "https://target") is True
    assert auth.target_deploy_active(sp, None) is False          # no target
    assert auth.target_deploy_active(nosp, "https://target") is False  # no SP
    assert auth.target_deploy_active(nosp, None) is False


def test_central_writer_picks_sp_target_when_enabled(tmp_path):
    sp = _FakeConfig("cid", "sec")
    label = auth.write_project_databrickscfg(
        tmp_path,
        config=sp,
        target_workspace_host="fevm-target.cloud.databricks.com",  # no scheme → normalized
        user_pat="dapiPAT",
        user_host="https://host",
    )
    assert label == "sp-target"
    cfg = _read_cfg(tmp_path)
    assert "client_id     = cid" in cfg
    assert "host          = https://fevm-target.cloud.databricks.com" in cfg  # normalized scheme
    assert "dapiPAT" not in cfg  # the user's PAT must NOT be written in SP mode


def test_central_writer_falls_back_to_obo_when_no_target(tmp_path):
    sp = _FakeConfig("cid", "sec")
    label = auth.write_project_databrickscfg(
        tmp_path, config=sp, target_workspace_host=None,
        user_pat="dapiPAT", user_host="https://host",
    )
    assert label == "obo"
    cfg = _read_cfg(tmp_path)
    assert "token = dapiPAT" in cfg and "client_id" not in cfg


def test_central_writer_obo_when_sp_not_configured(tmp_path):
    """Even WITH a target set, no SP configured → classic OBO (safe default)."""
    nosp = _FakeConfig()
    label = auth.write_project_databrickscfg(
        tmp_path, config=nosp, target_workspace_host="https://target",
        user_pat="dapiPAT", user_host="https://host",
    )
    assert label == "obo"
    assert "token = dapiPAT" in _read_cfg(tmp_path)


def test_central_writer_returns_none_when_nothing_to_write(tmp_path):
    nosp = _FakeConfig()
    label = auth.write_project_databrickscfg(
        tmp_path, config=nosp, target_workspace_host=None,
        user_pat=None, user_host=None,
    )
    assert label is None
    assert not (tmp_path / auth.AUTH_FILE_NAME).exists()


def test_obo_and_sp_writers_produce_distinct_stanzas(tmp_path):
    """The two writers must never be confused: PAT vs OAuth-M2M."""
    obo_dir = tmp_path / "obo"
    sp_dir = tmp_path / "sp"
    obo_dir.mkdir(); sp_dir.mkdir()
    auth.write_project_auth_file(obo_dir, "https://host", "dapiTOKEN")
    rd_auth.write_project_sp_auth_file(
        sp_dir, host="https://host", client_id="c", client_secret="s"
    )
    obo = _read_cfg(obo_dir)
    sp = _read_cfg(sp_dir)
    assert "token = dapiTOKEN" in obo and "client_id" not in obo
    assert "client_id     = c" in sp and "token =" not in sp
