/**
 * Deploy-target control (Tier-2 "scale" feature) — the account-level
 * cross-workspace deploy target the user sets once; it applies to every
 * solution they build.
 *
 * PORTABLE + SELF-CONTAINED by design. It loads its own settings, owns the
 * shared validate → grant → stage → save flow, and renders:
 *   • collapsed: a muted one-liner ("Deploying to …") + Edit/Open, OR
 *   • open: the editor — the FEVM picker (Tier 3, when `fevm_integration_enabled`)
 *     hosted via <FevmPicker>, else a paste-a-URL fallback + validation verdict.
 *
 * The parent decides WHERE to mount it (inline under the composer today; a
 * redesign can drop it into an "advanced options" popup) — this component makes
 * no assumption about its container. When the whole feature is off
 * (`cross_workspace_deploy_enabled` false, e.g. a generic Tier-1 build) it
 * renders nothing.
 *
 * Removing the components/fevm/ directory degrades this cleanly to the
 * paste-URL control (the FevmPicker import is the only FEVM dependency).
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Pointer, Pencil, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getMySettings,
  updateMySettings,
  validateMyTarget,
  type UserSettings,
  type TargetValidation,
} from "@/lib/custom-api";
import { authorizeFevmDeployer, type FevmWorkspaces } from "@/lib/fevm-api";
import { FevmPicker } from "@/components/fevm/FevmPicker";

function shortHostName(host: string): string {
  return host
    .replace(/^https?:\/\//, "")
    .replace(/\.cloud\.databricks\.com\/?$/, "")
    .replace(/\/$/, "");
}

export function DeployTargetControl() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [targetEditorOpen, setTargetEditorOpen] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [savingTarget, setSavingTarget] = useState(false);
  const [validatingTarget, setValidatingTarget] = useState(false);
  const [targetValidation, setTargetValidation] = useState<TargetValidation | null>(null);
  const [targetSelectMsg, setTargetSelectMsg] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ host: string | null; ready: boolean } | null>(null);
  // FEVM enablement, reported up by the picker (drives picker-vs-paste + whether
  // to show the paste-URL verdict block).
  const [fevmState, setFevmState] = useState<FevmWorkspaces | null>(null);

  useEffect(() => {
    getMySettings()
      .then(setSettings)
      .catch(() => {
        /* Non-fatal — the control just doesn't render its current value. */
      });
  }, []);

  const openTargetEditor = useCallback(() => {
    setTargetInput(
      settings?.target_workspace_host ?? settings?.effective_target_workspace_host ?? "",
    );
    setTargetValidation(null);
    setTargetEditorOpen(true);
  }, [settings]);

  const selectDefaultTarget = useCallback(() => {
    setTargetInput("");
    setTargetValidation(null);
    setStaged({ host: null, ready: true });
    setTargetSelectMsg("Shared default — click Save to apply.");
  }, []);

  // Select a workspace: CHECK ACCESS → grant if needed (FEVM add_workspace_admin)
  // → STAGE (Save commits). Selecting never auto-persists.
  const selectTarget = useCallback(
    async (host: string, resourceId?: string) => {
      setTargetInput(host);
      setTargetValidation(null);
      setStaged({ host, ready: false });
      setValidatingTarget(true);
      setTargetSelectMsg("Checking workspace admin access…");
      const ready = () => {
        setValidatingTarget(false);
        setStaged({ host, ready: true });
        setTargetSelectMsg("✓ Solution Builder has access — click Save to apply.");
      };
      try {
        let verdict = await validateMyTarget(host);
        setValidatingTarget(false);
        if (verdict.can_deploy) {
          ready();
          return;
        }
        if (verdict.status === "needs_admin") {
          setTargetSelectMsg("No access yet — granting workspace admin…");
          let auth;
          try {
            auth = await authorizeFevmDeployer({ host, resourceId });
          } catch (e) {
            setTargetValidation(verdict);
            setStaged(null);
            setTargetSelectMsg(`Couldn't grant access: ${String((e as Error)?.message ?? e)}`);
            return;
          }
          if (!auth.available) {
            setTargetValidation(verdict);
            setStaged(null);
            setTargetSelectMsg("Access grant is temporarily unavailable — try again shortly.");
            return;
          }
          // The tool exists (available) but the grant itself was REFUSED (e.g.
          // the workspace isn't Active yet, or you're not a live workspace
          // admin on it). Surface the reason and STOP — don't enter the poll
          // loop on a grant that never dispatched (that's what made a refused
          // grant look like a 10-minute silent hang).
          if (!auth.success) {
            setValidatingTarget(false);
            setTargetValidation(verdict);
            setStaged(null);
            setTargetSelectMsg(
              auth.error
                ? `Couldn't grant workspace admin: ${auth.error}`
                : "Couldn't grant workspace admin — try again shortly.",
            );
            return;
          }
          setValidatingTarget(true);
          const POLL_MS = 5_000;
          const MAX_TRIES = 120; // 10 min
          for (let i = 0; i < MAX_TRIES; i++) {
            setTargetSelectMsg(
              "Granting workspace admin access… almost there (this updates " +
                "automatically — no need to reselect).",
            );
            await new Promise((r) => setTimeout(r, POLL_MS));
            try {
              verdict = await validateMyTarget(host);
            } catch {
              continue;
            }
            if (verdict.can_deploy) {
              ready();
              return;
            }
          }
          setValidatingTarget(false);
          setTargetValidation(verdict);
          setStaged(null);
          setTargetSelectMsg(
            "Access grant is taking longer than usual — the workflow may still be " +
              "running. Re-select the workspace in a minute to check again.",
          );
          return;
        }
        setTargetValidation(verdict);
        setStaged(null);
        setTargetSelectMsg(
          verdict.message || "This workspace can't be used as a deploy target.",
        );
      } catch (e) {
        setValidatingTarget(false);
        setStaged(null);
        setTargetSelectMsg(`Access check failed: ${String((e as Error)?.message ?? e)}`);
      }
    },
    [],
  );

  const saveStagedTarget = useCallback(async () => {
    if (!staged?.ready) return;
    setSavingTarget(true);
    try {
      const updated = await updateMySettings(staged.host);
      setSettings(updated);
      setStaged(null);
      setTargetSelectMsg(null);
      setTargetValidation(null);
      setTargetEditorOpen(false);
    } catch (e) {
      setTargetSelectMsg(`Save failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setSavingTarget(false);
    }
  }, [staged]);

  // Paste-URL Save (fallback path when FEVM picker is off): validate then persist.
  const saveTarget = useCallback(async () => {
    const host = targetInput.trim();
    if (!host) {
      setSavingTarget(true);
      try {
        const updated = await updateMySettings(null);
        setSettings(updated);
        setTargetEditorOpen(false);
        setTargetValidation(null);
      } catch (e) {
        console.error("Failed to clear deploy target", e);
      } finally {
        setSavingTarget(false);
      }
      return;
    }
    setValidatingTarget(true);
    setTargetValidation(null);
    try {
      const verdict = await validateMyTarget(host);
      setValidatingTarget(false);
      setTargetValidation(verdict);
      if (!verdict.can_deploy) return; // keep editor open so the user can fix it
      setSavingTarget(true);
      const updated = await updateMySettings(host);
      setSettings(updated);
      setTargetEditorOpen(false);
      setTargetValidation(null);
    } catch (e) {
      setValidatingTarget(false);
      console.error("Failed to save deploy target", e);
    } finally {
      setSavingTarget(false);
    }
  }, [targetInput]);

  // Whole feature off (generic Tier-1 build / no deployer SP) → render nothing.
  if (settings && settings.cross_workspace_deploy_enabled === false) return null;

  const fevmEnabled = !!settings?.fevm_integration_enabled && !!fevmState?.enabled;

  return (
    <>
      {/* Collapsed one-liner. */}
      {!targetEditorOpen &&
        (() => {
          const openHost =
            settings?.target_workspace_host ||
            settings?.effective_target_workspace_host ||
            null;
          const onCustomWorkspace =
            !!settings?.target_workspace_host &&
            settings.target_workspace_host !== settings.default_target_workspace_host;
          return (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Pointer className="size-3 shrink-0" />
              <span>
                {onCustomWorkspace ? (
                  <>
                    Deploying to your workspace{" "}
                    <span className="font-medium text-foreground">
                      {shortHostName(settings!.target_workspace_host!)}
                    </span>
                  </>
                ) : (
                  "Deploying to the shared default workspace"
                )}
              </span>
              <button
                type="button"
                onClick={openTargetEditor}
                title="Change target workspace"
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
              >
                <Pencil className="size-3" />
                Edit
              </button>
              {openHost && (
                <a
                  href={openHost}
                  target="_blank"
                  rel="noreferrer"
                  title="Open workspace home"
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
                >
                  <ExternalLink className="size-3" />
                  Open
                </a>
              )}
            </div>
          );
        })()}

      {/* Expanded editor. */}
      {targetEditorOpen && (
        <div className="text-xs text-muted-foreground">
          <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-3">
            {settings?.fevm_integration_enabled ? (
              <FevmPicker
                savedHost={settings?.target_workspace_host ?? null}
                stagedHost={staged?.host}
                hasStaged={!!staged}
                busy={validatingTarget}
                onSelectDefault={selectDefaultTarget}
                onSelectTarget={selectTarget}
                onSave={() => {
                  if (staged) {
                    void saveStagedTarget();
                  } else {
                    setTargetEditorOpen(false);
                    setTargetSelectMsg(null);
                  }
                }}
                saveDisabled={(staged && !staged.ready) || savingTarget || false}
                saving={savingTarget}
                onStateChange={setFevmState}
              />
            ) : (
              /* Paste a workspace URL + Save. */
              <div className="flex items-center gap-2">
                <Input
                  value={targetInput}
                  onChange={(e) => {
                    setTargetInput(e.target.value);
                    setTargetValidation(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveTarget();
                  }}
                  placeholder="https://your-workspace.cloud.databricks.com (blank = shared default)"
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void saveTarget()}
                  disabled={savingTarget}
                >
                  {validatingTarget ? "Checking…" : savingTarget ? "Saving…" : "Save"}
                </Button>
              </div>
            )}

            {/* Access-check / grant progress line (shared: picker + paste). */}
            {targetSelectMsg && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                {validatingTarget && <Loader2 className="size-3 animate-spin" />}
                {targetSelectMsg}
              </p>
            )}

            {/* Validation verdict — only in the paste-URL flow (FEVM off). */}
            {!fevmEnabled && targetValidation && (
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-xs space-y-1",
                  targetValidation.can_deploy
                    ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
                    : targetValidation.status === "needs_admin"
                      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
                )}
              >
                <div className="font-medium">
                  {targetValidation.can_deploy
                    ? `✓ Ready — deploys into ${targetValidation.catalog} (${targetValidation.region})`
                    : targetValidation.status === "needs_admin"
                      ? "⚠ Deployer SP needs workspace-admin access"
                      : "✗ Can't deploy here"}
                </div>
                <div>{targetValidation.message}</div>
                {targetValidation.status === "needs_admin" && (
                  <div className="space-y-1.5 pt-0.5">
                    {targetValidation.admin_settings_url && (
                      <a
                        href={targetValidation.admin_settings_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block font-medium underline underline-offset-2 hover:no-underline"
                      >
                        Open this workspace's Service Principals settings ↗
                      </a>
                    )}
                    {targetValidation.deployer_sp_application_id && (
                      <div className="flex items-center gap-1.5">
                        <span className="opacity-80">Add this service principal:</span>
                        <code className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono text-[11px]">
                          {targetValidation.deployer_sp_application_id}
                        </code>
                        <button
                          type="button"
                          onClick={() =>
                            navigator.clipboard?.writeText(
                              targetValidation.deployer_sp_application_id || "",
                            )
                          }
                          className="underline underline-offset-2 hover:no-underline"
                          title="Copy application ID"
                        >
                          copy
                        </button>
                        <span className="opacity-70">
                          ({targetValidation.deployer_sp_name}) — grant it the Admin role,
                          then re-select the workspace.
                        </span>
                      </div>
                    )}
                    <div className="opacity-70">
                      Note: you must already be a workspace admin on this workspace to add
                      the service principal.
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Applies to every solution you build.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
