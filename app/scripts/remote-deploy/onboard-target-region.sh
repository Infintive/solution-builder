#!/usr/bin/env bash
# =============================================================================
# onboard-target-region.sh — one-time per regional metastore setup so the
# Solution Builder cross-workspace app (deployer SP) can build a full demo into
# ANY workspace in that region. Run it once per target regional metastore.
#
# STORAGE MODEL:
#   The shared `solution_builder` catalog MUST sit on **account Default Storage**
#   (the Databricks-managed `dbstorage-*` bucket), NOT on a per-workspace
#   external (`*-ext-*`) bucket. Two reasons:
#     • Default Storage is metastore-wide + its managed location is OPEN, so
#       every workspace on the metastore can write to the catalog.
#     • It is NOT tied to any workspace's lifecycle — if a target workspace is
#       deleted, the catalog + its data survive. A per-workspace external bucket
#       is ISOLATED to (and torn down with) its workspace, which would orphan a
#       shared catalog.
#
# WHAT THIS DOES (idempotent, self-diagnosing, read-mostly):
#   1. Resolves the metastore for the target workspace + its region.
#   2. Ensures the catalog exists on Default Storage (pure CLI — see note below).
#   3. Ensures the catalog is `isolation_mode = OPEN` (metastore-wide).
#   4. Transfers catalog ownership to the deployer SP (least privilege: the SP
#      owns exactly ONE catalog per metastore — no metastore-wide grants).
#   5. Grants `account users` USE CATALOG + CREATE SCHEMA so any user's per-demo
#      schema lands cleanly.
#   6. Smoke-tests that the catalog is writable.
#
# CLI CREATE WORKS — NO UI NEEDED (in most regions): a plain `CREATE CATALOG`
#   via the Statements API self-materializes account Default Storage, including
#   in regions that had never been exercised. If CREATE ever fails with
#   "Metastore storage root URL does not exist", create the catalog once via
#   Catalog Explorer > Create catalog > Storage="Default storage", then re-run
#   this for OPEN + owner + grants. It deliberately does NOT fall back to a
#   workspace-isolated `*-ext-*` bucket.
#
# WHICH HOST: any workspace attached to the target region's metastore that your
#   --profile identity can administer. (Its URL host is the `deployment_name`,
#   dbc-XXXX.cloud.databricks.com — not the friendly workspace name.)
#
# WHO RUNS IT: a **metastore admin** identity (via an account-scoped profile),
#   who must be a member/admin of the workspace passed as --host. The deployer
#   SP does NOT have CREATE CATALOG ON METASTORE and intentionally never will —
#   catalog creation is the one human-admin step; everything after is the SP's.
#
# USAGE:
#   ./onboard-target-region.sh \
#       --host   https://<region-automation-ws>.cloud.databricks.com \
#       --profile <metastore-admin-profile> \
#       --sp     <deployer-sp-client-id> \
#       [--warehouse <sql_warehouse_id>] \
#       [--catalog solution_builder] \        # override name if already taken
#       [--dry-run]
#
# Re-running is safe: an existing catalog is detected and only missing pieces
# (isolation mode, owner, grants) are reconciled.
# =============================================================================
set -euo pipefail

CATALOG="solution_builder"
PROFILE=""
HOST=""
SP=""
WAREHOUSE=""
DRY_RUN=0

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*"; }
step() { echo ""; echo "== $* =="; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)      HOST="$2"; shift 2;;
    --profile)   PROFILE="$2"; shift 2;;
    --sp)        SP="$2"; shift 2;;
    --warehouse) WAREHOUSE="$2"; shift 2;;
    --catalog)   CATALOG="$2"; shift 2;;
    --dry-run)   DRY_RUN=1; shift;;
    *) die "unknown arg: $1";;
  esac
done

[[ -n "$HOST"    ]] || die "--host is required (any workspace in the target region)"
[[ -n "$PROFILE" ]] || die "--profile is required (a metastore-admin identity)"
[[ -n "$SP"      ]] || die "--sp is required (deployer SP client/application id)"

export DATABRICKS_HOST="$HOST"

# --- run a SQL statement via the Statement Execution API, print state -------
# Usage: run_sql "<sql>"  -> echoes "SUCCEEDED" / "FAILED: <msg>", returns
# nonzero on FAILED. Captures the error message in LAST_ERR for branching.
LAST_ERR=""
run_sql () {
  local sql="$1"
  if [[ "$DRY_RUN" == "1" ]]; then echo "DRY-RUN would execute: $sql"; return 0; fi
  local resp
  resp=$(databricks api post /api/2.0/sql/statements -p "$PROFILE" --json \
    "$(python3 -c 'import json,sys; print(json.dumps({"warehouse_id":sys.argv[1],"statement":sys.argv[2],"wait_timeout":"50s"}))' "$WAREHOUSE" "$sql")" 2>&1)
  local parsed
  parsed=$(python3 - "$resp" <<'PY'
import json,sys
raw=sys.argv[1]
try:
    d=json.loads(raw); st=d.get("status",{})
    state=st.get("state","?"); err=(st.get("error",{}) or {}).get("message","")
    print(state+"\t"+err)
except Exception:
    print("PARSE_ERROR\t"+raw[:300])
PY
)
  local state="${parsed%%$'\t'*}"
  LAST_ERR="${parsed#*$'\t'}"
  if [[ "$state" == "SUCCEEDED" ]]; then echo "SUCCEEDED"; return 0
  else echo "FAILED: $LAST_ERR"; return 1; fi
}

# --- 0. identity + region --------------------------------------------------
step "0. Resolve identity, workspace, metastore"
WHOAMI=$(databricks current-user me -p "$PROFILE" -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("userName","?"))' || echo "?")
info "acting as: $WHOAMI"
info "workspace: $HOST"

MS_JSON=$(databricks metastores summary -p "$PROFILE" -o json 2>/dev/null || echo '{}')
MS_NAME=$(echo "$MS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("name","?"))')
MS_REGION=$(echo "$MS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("region","?"))')
info "metastore: $MS_NAME  (region=$MS_REGION)"

# --- warehouse autodiscovery ------------------------------------------------
if [[ -z "$WAREHOUSE" ]]; then
  step "0b. Auto-pick a SQL warehouse"
  WAREHOUSE=$(databricks warehouses list -p "$PROFILE" -o json 2>/dev/null | python3 -c '
import json,sys
whs=json.load(sys.stdin)
run=[w for w in whs if w.get("state")=="RUNNING"]
pick=(run or whs)
print(pick[0]["id"] if pick else "")' || echo "")
  [[ -n "$WAREHOUSE" ]] || die "no SQL warehouse found; pass --warehouse <id>"
  info "using warehouse: $WAREHOUSE"
fi

# --- 1. ensure catalog exists (Default Storage ONLY) -----------------------
step "1. Ensure catalog '$CATALOG' exists on account Default Storage"
if databricks catalogs get "$CATALOG" -p "$PROFILE" -o json >/dev/null 2>&1; then
  # Guard against the workspace-coupled mistake: warn if storage is an *-ext-* bucket.
  SR=$(databricks catalogs get "$CATALOG" -p "$PROFILE" -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("storage_root") or "")')
  info "catalog already exists — storage_root: ${SR:-<default storage>}"
  if [[ "$SR" == *"-ext-"* ]]; then
    echo ""
    echo "  ⚠️  WARNING: this catalog's storage is a workspace-ISOLATED *-ext-* bucket."
    echo "      A shared catalog must live on account Default Storage (dbstorage-prod-*)"
    echo "      so it survives workspace deletion and is writable from all workspaces."
    echo "      Recommend: migrate data out, DROP, and recreate via the UI on Default Storage."
  fi
else
  info "attempting CREATE CATALOG on Default Storage (no explicit location)"
  if run_sql "CREATE CATALOG IF NOT EXISTS $CATALOG"; then
    info "created on account Default Storage."
  else
    if [[ "$LAST_ERR" == *"storage root URL does not exist"* || "$LAST_ERR" == *"Default Storage"* ]]; then
      cat >&2 <<EOF

  ────────────────────────────────────────────────────────────────────────
  CREATE CATALOG could not materialize Default Storage from THIS workspace
  ('$HOST', region '$MS_REGION').

  This can be workspace-specific. Fix, easiest first:
    1. Re-run this script with --host set to a different workspace on the same
       regional metastore (some workspaces can self-materialize Default Storage
       when others can't).
    2. Last resort — create it once via UI: ${HOST}/explore/data >
       "Create catalog" > Name: $CATALOG > Storage: "Default storage" > Create
       (leave owner/grants alone), then re-run this script.
  ────────────────────────────────────────────────────────────────────────
EOF
      exit 2
    fi
    die "catalog creation failed: $LAST_ERR"
  fi
fi

# --- 2. ensure OPEN isolation (metastore-wide) -----------------------------
step "2. Ensure catalog isolation_mode = OPEN (usable from all workspaces)"
ISO=$(databricks catalogs get "$CATALOG" -p "$PROFILE" -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("isolation_mode","OPEN"))')
info "current isolation_mode: $ISO"
if [[ "$ISO" == "ISOLATED" ]]; then
  info "setting to OPEN so every workspace on the metastore can use it"
  run_sql "ALTER CATALOG $CATALOG SET ISOLATION MODE OPEN" || die "could not set OPEN: $LAST_ERR"
fi

# --- 3. ownership → deployer SP (least privilege) --------------------------
step "3. Transfer catalog ownership to deployer SP"
info "owner -> $SP"
run_sql "ALTER CATALOG $CATALOG OWNER TO \`$SP\`" || die "ownership transfer failed: $LAST_ERR"

# --- 4. grants for SB users -------------------------------------------------
step "4. Grant account users USE CATALOG + CREATE SCHEMA"
run_sql "GRANT USE CATALOG ON CATALOG $CATALOG TO \`account users\`"   || die "grant USE CATALOG failed: $LAST_ERR"
run_sql "GRANT CREATE SCHEMA ON CATALOG $CATALOG TO \`account users\`" || die "grant CREATE SCHEMA failed: $LAST_ERR"

# --- 5. smoke test ----------------------------------------------------------
step "5. Smoke test: catalog is writable"
if [[ "$DRY_RUN" == "1" ]]; then
  info "DRY-RUN: skipping write probe"
else
  PROBE="${CATALOG}._onboard_probe_$$"
  if run_sql "CREATE SCHEMA IF NOT EXISTS $PROBE" && run_sql "DROP SCHEMA IF EXISTS $PROBE"; then
    info "catalog is writable ✓"
  else
    info "WARN: schema probe failed: $LAST_ERR"
  fi
fi

step "DONE — region '$MS_REGION' (metastore $MS_NAME) onboarded"
cat <<EOF

  catalog:   $CATALOG
  storage:   account Default Storage (metastore-wide, survives workspace deletion)
  isolation: OPEN
  owner:     deployer SP $SP
  grants:    account users -> USE CATALOG, CREATE SCHEMA
  region:    $MS_REGION

  Solution Builder users can now set any workspace in this region as their
  target and build a full demo. Re-run this script (idempotent) when you
  onboard a new regional metastore or a new target account.
EOF
