/**
 * FEVM integration — API client (internal; Solution Builder / GTM AI Tooling
 * team managed deployment only). FEVM is not a public product.
 *
 * This is the frontend half of the self-contained FEVM module (the backend half
 * is `backend/fevm/`). Split out of `custom-api.ts` so the whole FEVM feature —
 * types, calls, and UI (see components/fevm/) — lives behind one clear boundary
 * that can be gated off (the `fevm_integration_enabled` flag from /me/settings)
 * or removed for a non-managed build.
 */
import { apiUrl } from "./config";

/** One FEVM workspace the signed-in user owns, offered as a deploy target
 *  (sourced from mcp-fevm via the UC connection, per-user OBO). */
export interface FevmWorkspace {
  name: string;
  host: string;
  region: string;
  state: string;
  template: string;
  /** FEVM deployment UUID (present once list_deployments exposes it, PR #936). */
  resource_id?: string | null;
}

export interface FevmWorkspaces {
  /** False when the FEVM MCP connection isn't configured (fall back to paste-URL). */
  enabled: boolean;
  workspaces: FevmWorkspace[];
  /** Regions a new workspace can be provisioned in (default first). */
  regions: string[];
  /** The shared default target host — shown first in the picker for everyone. */
  default_host?: string | null;
  /** True when the user must complete the one-time UC-connection OAuth consent. */
  needs_consent?: boolean;
  /** Deep link to the connection page where the user clicks Login (one-time). */
  connect_url?: string | null;
  /** Human message when the MCP call fails (e.g. one-time OAuth consent needed). */
  error?: string | null;
}

/** List the user's FEVM workspaces (aws/stable) to offer as deploy targets.
 *  Non-fatal: returns { enabled:false } or { error } instead of throwing so the
 *  picker can degrade to the paste-URL control. */
export async function listMyFevmWorkspaces(): Promise<FevmWorkspaces> {
  const resp = await fetch(apiUrl("/api/me/fevm/workspaces"));
  if (!resp.ok) throw new Error(`Failed to list FEVM workspaces: ${resp.status}`);
  return resp.json();
}

export interface FevmProvisionResult {
  success: boolean;
  resource_id?: string | null;
  message?: string | null;
  /** Deep link to the deployment in FEVM (watch provisioning progress there). */
  deployment_url?: string | null;
  error?: string | null;
  /** True on an INCONCLUSIVE submit (gateway 5xx / timeout): FEVM may have
   *  accepted the create anyway (provisioning is async). Show `message` and
   *  point the user at their workspace list rather than reporting failure. */
  submitted_maybe?: boolean;
}

/** Provision a new AWS Stable Serverless FEVM workspace as the current user.
 *  Returns a resource_id to poll with getFevmProvisionStatus. */
export async function provisionFevmWorkspace(
  resourceName: string,
  region: string,
  intent?: string,
): Promise<FevmProvisionResult> {
  const resp = await fetch(apiUrl("/api/me/fevm/provision"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_name: resourceName, region, intent }),
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      detail = (await resp.json())?.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to provision workspace: ${detail}`);
  }
  return resp.json();
}

export interface FevmDeploymentStatus {
  resource_id: string;
  state?: string | null;
  region?: string | null;
  /** Populated once state === "Active" — the workspace URL to use as target. */
  host?: string | null;
  /** Deep link to the deployment in FEVM. */
  deployment_url?: string | null;
  error?: string | null;
}

export interface FevmAuthorizeDeployerResult {
  success: boolean;
  /** False when the FEVM add_workspace_admin tool isn't deployed yet. */
  available: boolean;
  transaction_id?: string | null;
  github_run_url?: string | null;
  message?: string | null;
  error?: string | null;
}

/** Add the deployer SP as a workspace admin on a target the user owns (removes
 *  the manual step). Async: the caller re-validates until the SP authenticates.
 *  Pass a FEVM deployment resource_id or the workspace host. */
export async function authorizeFevmDeployer(args: {
  resourceId?: string;
  host?: string;
}): Promise<FevmAuthorizeDeployerResult> {
  const resp = await fetch(apiUrl("/api/me/fevm/authorize-deployer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_id: args.resourceId, host: args.host }),
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      detail = (await resp.json())?.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to authorize deployer: ${detail}`);
  }
  return resp.json();
}

/** Poll a provisioning FEVM workspace until state === "Active" (host set). */
export async function getFevmProvisionStatus(
  resourceId: string,
): Promise<FevmDeploymentStatus> {
  const resp = await fetch(
    apiUrl(`/api/me/fevm/provision/${encodeURIComponent(resourceId)}`),
  );
  if (!resp.ok) throw new Error(`Failed to poll provision status: ${resp.status}`);
  return resp.json();
}
