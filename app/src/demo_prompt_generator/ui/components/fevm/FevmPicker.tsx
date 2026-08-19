/**
 * FEVM workspace picker — internal (Solution Builder / GTM AI Tooling team
 * managed deployment only). FEVM is not a public product.
 *
 * The Tier-3 discovery/provisioning UI that sits ON TOP OF the generic Tier-2
 * deploy-target control (see components/remote-deploy/DeployTargetControl). It
 * renders when the server reports `fevm_integration_enabled` (the parent gates
 * on that) and the FEVM connection lists workspaces. All FEVM API calls live
 * here (lib/fevm-api), so removing this directory leaves the generic paste-URL
 * target control fully intact.
 *
 * It owns only FEVM-specific state (workspace list, per-user Connect consent,
 * provision-new). Target SELECTION + Save live in the parent — the picker calls
 * back via `onSelectTarget` / `onSelectDefault`; the parent runs the shared
 * validate→grant→stage→save flow (identical to the paste-URL path).
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles } from "lucide-react";
import {
  listMyFevmWorkspaces,
  provisionFevmWorkspace,
  getFevmProvisionStatus,
  type FevmWorkspaces,
} from "@/lib/fevm-api";

/** "https://foo.cloud.databricks.com" → "foo" for compact labels. */
function shortHostName(host: string): string {
  return host
    .replace(/^https?:\/\//, "")
    .replace(/\.cloud\.databricks\.com\/?$/, "")
    .replace(/\/$/, "");
}

/** Auto-generate a workspace name FEVM accepts: "sb-" + 6 lowercase alphanums. */
function genWorkspaceName(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `sb-${s}`;
}

export interface FevmPickerProps {
  /** Currently-persisted target host (null = shared default). Drives the
   *  dropdown's selected value together with `stagedHost`. */
  savedHost: string | null;
  /** The staged (not-yet-saved) selection, if any: host or null(=default). */
  stagedHost: string | null | undefined;
  /** Whether a staging selection exists (controls dropdown value binding). */
  hasStaged: boolean;
  /** True while the parent is validating/granting a staged selection. */
  busy: boolean;
  /** Parent picks the shared default (host: null). */
  onSelectDefault: () => void;
  /** Parent runs validate→grant→stage for a chosen workspace host. */
  onSelectTarget: (host: string, resourceId?: string) => void | Promise<void>;
  /** Save button (right of the dropdown) — commits the staged choice or closes. */
  onSave: () => void;
  /** Disable Save (nothing staged-ready, or a save in flight). */
  saveDisabled: boolean;
  saving: boolean;
  /** Reports the fetched FEVM state up so the parent can decide picker-vs-paste
   *  (enabled) and skip the paste-URL verdict UI when the picker is active. */
  onStateChange?: (state: FevmWorkspaces | null) => void;
}

/**
 * Returns the picker UI, or null when FEVM lists nothing usable (not enabled /
 * still loading with no data) so the parent can fall back to paste-URL. The
 * parent should mount this only when `settings.fevm_integration_enabled`.
 */
export function FevmPicker(props: FevmPickerProps) {
  const {
    savedHost,
    stagedHost,
    hasStaged,
    busy,
    onSelectDefault,
    onSelectTarget,
    onSave,
    saveDisabled,
    saving,
    onStateChange,
  } = props;

  const [fevm, setFevm] = useState<FevmWorkspaces | null>(null);
  const fevmWorkspaces = fevm?.workspaces ?? null;
  const [fevmLoading, setFevmLoading] = useState(false);
  const [fevmConnecting, setFevmConnecting] = useState(false);

  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provisionName, setProvisionName] = useState("");
  const [provisionRegion, setProvisionRegion] = useState("");
  const [provisionState, setProvisionState] = useState<{
    // "submitted_maybe" = the sync provision call was inconclusive (gateway
    // 5xx / timeout) but FEVM may have accepted it — an informative notice, NOT
    // a failure, so it renders distinctly from "error" (see below).
    phase: "idle" | "submitting" | "polling" | "done" | "error" | "submitted_maybe";
    message?: string;
    deploymentUrl?: string | null;
  }>({ phase: "idle" });

  const refreshFevm = useCallback(async (): Promise<FevmWorkspaces> => {
    setFevmLoading(true);
    try {
      const r = await listMyFevmWorkspaces();
      setFevm(r);
      onStateChange?.(r);
      if (r.regions?.length) setProvisionRegion((cur) => cur || r.regions[0]);
      return r;
    } catch (e) {
      const err: FevmWorkspaces = {
        enabled: true,
        workspaces: [],
        regions: [],
        error: String((e as Error)?.message ?? e),
      };
      setFevm(err);
      onStateChange?.(err);
      return err;
    } finally {
      setFevmLoading(false);
    }
  }, [onStateChange]);

  // Fetch the user's workspaces on mount (the parent mounts us only when the
  // editor opens, so this is lazy — not on page load).
  useEffect(() => {
    void refreshFevm();
  }, [refreshFevm]);

  // Connect flow: open the connection's login page in a POPUP (kept in front of
  // the app, not a lost background tab), then poll every 3s until the per-user
  // OAuth consent lands (needs_consent flips false) → the picker renders itself.
  // NOTE: true one-click-from-app is not possible — the UC per-user login must be
  // initiated from the workspace origin (it holds the PKCE verifier that the
  // /login/oauth/http.html callback needs; a cross-origin app can't seed it), and
  // there's no API to store the per-user connection credential. So the supported
  // ceiling is: pop the connection page, user clicks its Log in, we auto-detect.
  const startFevmConnect = useCallback(() => {
    if (fevm?.connect_url) {
      const w = 900;
      const h = 720;
      const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
      const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
      const popup = window.open(
        fevm.connect_url,
        "fevm-connect",
        `popup=yes,width=${w},height=${h},left=${left},top=${top},noopener`,
      );
      // Popup blocked → fall back to a new tab so the flow still works.
      if (!popup) window.open(fevm.connect_url, "_blank", "noopener");
    }
    setFevmConnecting(true);
  }, [fevm]);

  useEffect(() => {
    if (!fevmConnecting) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const r = await refreshFevm();
      if (cancelled) return;
      if (r.enabled && !r.needs_consent) setFevmConnecting(false);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fevmConnecting, refreshFevm]);

  const provisionWorkspace = useCallback(async () => {
    const name = provisionName.trim();
    if (!name || !provisionRegion) return;
    setProvisionState({ phase: "submitting" });
    try {
      const res = await provisionFevmWorkspace(name, provisionRegion);
      // Inconclusive submit (gateway 5xx / timeout): FEVM may have accepted the
      // create even though the sync call didn't confirm. Don't report failure —
      // tell the user to check, and refresh the list so a landed workspace shows.
      if (res.submitted_maybe) {
        setProvisionState({
          phase: "submitted_maybe",
          message:
            res.message ||
            "Your workspace may have been submitted — check your FEVM workspaces in a minute.",
        });
        void refreshFevm();
        return;
      }
      if (!res.success || !res.resource_id) {
        setProvisionState({ phase: "error", message: res.error || "Provision failed." });
        return;
      }
      const rid = res.resource_id;
      const deploymentUrl = res.deployment_url ?? null;
      setProvisionState({
        phase: "polling",
        message: "Provisioning… this can take a few minutes.",
        deploymentUrl,
      });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        let status;
        try {
          status = await getFevmProvisionStatus(rid);
        } catch {
          continue;
        }
        if (status.host) {
          setProvisionState({ phase: "done", message: "Workspace ready.", deploymentUrl });
          setProvisionOpen(false);
          void refreshFevm();
          await onSelectTarget(status.host, rid);
          return;
        }
        setProvisionState({
          phase: "polling",
          message: `Provisioning… (${status.state ?? "pending"})`,
          deploymentUrl,
        });
      }
      setProvisionState({
        phase: "error",
        message: "Still provisioning after 10 min — check FEVM, then paste the URL.",
        deploymentUrl,
      });
    } catch (e) {
      setProvisionState({ phase: "error", message: String((e as Error)?.message ?? e) });
    }
  }, [provisionName, provisionRegion, refreshFevm, onSelectTarget]);

  // First-time OR expired per-user connection auth → one clear reconnect step.
  if (fevm?.needs_consent && fevm.connect_url) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          To deploy to your own workspaces, connect your Databricks account once. It stays
          connected for up to 90 days.
        </p>
        {fevmConnecting ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Waiting for you to finish in the popup — click the blue{" "}
            <span className="font-medium text-foreground">Log in</span> button and approve.
            This updates automatically when you're done.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            A Databricks window will open — click its blue{" "}
            <span className="font-medium text-foreground">Log in</span> button and approve
            access. You don't need to come back and click anything; we detect it for you.
          </p>
        )}
        <Button type="button" size="sm" onClick={startFevmConnect} disabled={fevmConnecting}>
          {fevmConnecting ? "Waiting for login…" : "Connect your Databricks account ↗"}
        </Button>
      </div>
    );
  }

  // Connection on, listing failed for a non-consent reason — surface WHY.
  if (fevm?.error) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {`Couldn't list your FEVM workspaces: ${fevm.error}`}
      </p>
    );
  }

  const dropdownValue = hasStaged
    ? stagedHost === null
      ? "__default__"
      : (stagedHost as string)
    : !savedHost
      ? "__default__"
      : savedHost;

  return (
    <div className="space-y-1">
      {/* Dropdown + inline Save, hidden while the provision row is open. */}
      {!provisionOpen && (
        <div className="flex items-center gap-2">
          <Select
            value={dropdownValue}
            disabled={fevmLoading}
            onValueChange={(val) => {
              if (val === "__provision__") {
                setProvisionName(genWorkspaceName());
                setProvisionOpen(true);
                setProvisionState({ phase: "idle" });
                return;
              }
              if (val === "__default__") {
                onSelectDefault();
                return;
              }
              const ws = fevmWorkspaces?.find((w) => w.host === val);
              void onSelectTarget(val, ws?.resource_id ?? undefined);
            }}
          >
            <SelectTrigger className="h-8 text-xs flex-1">
              <SelectValue
                placeholder={
                  fevmLoading ? "Loading your workspaces…" : "Choose your target workspace…"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {fevm?.default_host && (
                <SelectItem value="__default__">
                  {shortHostName(fevm.default_host)} · shared default
                </SelectItem>
              )}
              {(fevmWorkspaces ?? []).map((w) => (
                <SelectItem key={w.host} value={w.host}>
                  {w.name} · {w.region}
                </SelectItem>
              ))}
              {fevm?.enabled && fevm.regions.length > 0 && (
                <SelectItem value="__provision__">+ Provision a new workspace…</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" onClick={onSave} disabled={saveDisabled}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}

      {/* Provision form. */}
      {provisionOpen && fevm?.enabled && fevm.regions.length > 0 && (() => {
        const inFlight =
          provisionState.phase === "submitting" || provisionState.phase === "polling";
        return (
          <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
            {inFlight ? (
              <div className="flex items-center gap-2 py-1">
                <Sparkles className="size-4 shrink-0 animate-bounce text-primary" />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-foreground">
                    Conjuring your workspace <span className="font-mono">{provisionName}</span>…
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {provisionState.message || "This can take a few minutes — hang tight."}
                  </p>
                  {provisionState.deploymentUrl && (
                    <a
                      href={provisionState.deploymentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-primary underline underline-offset-2 hover:no-underline"
                    >
                      View progress in FEVM ↗
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 flex-1 items-center rounded-md border border-input bg-muted/40 px-2.5 font-mono text-xs text-foreground">
                    {provisionName}
                  </span>
                  <Select value={provisionRegion} onValueChange={setProvisionRegion}>
                    <SelectTrigger className="h-8 w-40 text-xs">
                      <SelectValue placeholder="region" />
                    </SelectTrigger>
                    <SelectContent>
                      {fevm.regions.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void provisionWorkspace()}
                    disabled={!provisionName.trim() || !provisionRegion}
                  >
                    Provision
                  </Button>
                </div>
                {provisionState.phase === "error" && provisionState.message && (
                  <p className="text-[11px] text-red-600 dark:text-red-400">
                    {provisionState.message}
                  </p>
                )}
                {/* Inconclusive submit — amber "check on it", not a red failure.
                    Terminal (no active poll), so no spinner. */}
                {provisionState.phase === "submitted_maybe" && provisionState.message && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {provisionState.message}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    Creates an AWS Stable Serverless workspace (30-day TTL).
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setProvisionOpen(false);
                      setProvisionState({ phase: "idle" });
                    }}
                    className="text-[11px] text-muted-foreground underline underline-offset-2 hover:no-underline"
                  >
                    cancel
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })()}
      {/* busy spinner line is rendered by the parent (shared with paste-URL). */}
      {busy ? null : null}
    </div>
  );
}
