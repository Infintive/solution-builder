/**
 * ProjectsWorkSection — the unified "Your work" area on the home page.
 *
 * Replaces four separately-stacked home-page sections (Recent Projects,
 * Shared with Me, Invitations, and the loading/empty state) with ONE calm,
 * tabbed surface: Recent | Shared | Invites (the last carries a count badge
 * so pending action is visible without opening the tab).
 *
 * Pure presentation — all data + handlers are owned by the home page and
 * passed in, so existing wiring (star toggle, open, clone, invite response)
 * is preserved verbatim. Renders nothing when there's genuinely nothing to
 * show (brand-new user with no work), keeping the landing clean.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ProjectTile } from "@/components/project/project-tile";
import type { ProjectListItem, ProjectShareOut } from "@/lib/custom-api";

/** "alice.smith@databricks.com" → "alice.smith". Keeps invite rows compact. */
function formatEmailShort(email: string): string {
  return email.split("@")[0] ?? email;
}

interface ProjectsWorkSectionProps {
  projects: ProjectListItem[];
  sharedProjects: ProjectListItem[];
  invitations: ProjectShareOut[];
  isLoadingProjects: boolean;
  projectsError: string | null;
  onOpenProject: (projectId: string) => void;
  onToggleStar: (e: React.MouseEvent, project: ProjectListItem) => void;
  onCloneShared: (projectId: string) => void;
  cloningId: string | null;
  /** Performs the accept/decline API call, then updates parent state. Awaited
   *  so the row can show a spinner while the request is in flight. */
  onInvitationRespond: (projectId: string, accepted: boolean) => Promise<void>;
  className?: string;
}

type WorkTab = "recent" | "shared" | "invites";

export function ProjectsWorkSection({
  projects,
  sharedProjects,
  invitations,
  isLoadingProjects,
  projectsError,
  onOpenProject,
  onToggleStar,
  onCloneShared,
  cloningId,
  onInvitationRespond,
  className,
}: ProjectsWorkSectionProps) {
  // Default to the tab with content: invites (action needed) → recent → shared.
  const defaultTab: WorkTab =
    invitations.length > 0 ? "invites" : sharedProjects.length > 0 && projects.length === 0 ? "shared" : "recent";
  const [tab, setTab] = useState<WorkTab>(defaultTab);
  const [respondingId, setRespondingId] = useState<string | null>(null);

  // Starred projects float to the top of the recent list (stable otherwise).
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(b.is_starred) - Number(a.is_starred)),
    [projects],
  );

  const nothingToShow =
    !isLoadingProjects &&
    !projectsError &&
    projects.length === 0 &&
    sharedProjects.length === 0 &&
    invitations.length === 0;

  // Brand-new user with nothing anywhere — a single quiet line, no tabs.
  if (nothingToShow) {
    return (
      <section className={className}>
        <p className="text-center text-sm text-muted-foreground">
          No projects yet — describe a use case above to create your first.
        </p>
      </section>
    );
  }

  const handleRespond = async (projectId: string, accept: boolean) => {
    setRespondingId(projectId);
    try {
      await onInvitationRespond(projectId, accept);
    } catch (err) {
      console.error("Failed to respond to invitation:", err);
    } finally {
      setRespondingId(null);
    }
  };

  return (
    <section className={className}>
      <Tabs value={tab} onValueChange={(v) => setTab(v as WorkTab)}>
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Your work</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick up where you left off
            </p>
          </div>
          <TabsList>
            <TabsTrigger value="recent">Recent</TabsTrigger>
            <TabsTrigger value="shared">Shared</TabsTrigger>
            <TabsTrigger value="invites" className="gap-1.5">
              Invites
              {invitations.length > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {invitations.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* RECENT */}
        <TabsContent value="recent" className="mt-0">
          {isLoadingProjects ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading projects…</p>
            </div>
          ) : projectsError ? (
            <div className="space-y-1 py-8 text-center">
              <p className="text-sm text-destructive">Failed to load projects</p>
              <p className="text-xs text-muted-foreground">{projectsError}</p>
            </div>
          ) : projects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No projects yet — describe a use case above to create your first.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {sortedProjects.slice(0, 3).map((project) => (
                  <ProjectTile
                    key={project.id}
                    project={project}
                    onClick={() => onOpenProject(project.id)}
                    onToggleStar={(e) => onToggleStar(e, project)}
                    showCustomer={false}
                  />
                ))}
              </div>
              {projects.length > 3 && (
                <div className="mt-3 flex justify-end">
                  <Link
                    to="/projects"
                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                  >
                    View all ({projects.length})
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* SHARED */}
        <TabsContent value="shared" className="mt-0">
          {sharedProjects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing shared with you yet.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {sharedProjects.slice(0, 3).map((project) => (
                  <ProjectTile
                    key={project.id}
                    project={project}
                    onClick={() => onOpenProject(project.id)}
                    onClone={() => onCloneShared(project.id)}
                    cloning={cloningId === project.id}
                    showOwner
                    showCustomer={false}
                  />
                ))}
              </div>
              {sharedProjects.length > 3 && (
                <div className="mt-3 flex justify-end">
                  <Link
                    to="/projects"
                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                  >
                    View all ({sharedProjects.length})
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* INVITES */}
        <TabsContent value="invites" className="mt-0">
          {invitations.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No pending invitations.
            </p>
          ) : (
            <div className="space-y-2">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {inv.project_name || "A project"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatEmailShort(inv.owner_email)} shared this with you as{" "}
                      <span className="font-medium">
                        {inv.role === "editor" ? "an editor" : "a viewer"}
                      </span>
                      {inv.message ? ` — “${inv.message}”` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={respondingId === inv.project_id}
                      onClick={() => handleRespond(inv.project_id, false)}
                    >
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      disabled={respondingId === inv.project_id}
                      onClick={() => handleRespond(inv.project_id, true)}
                    >
                      {respondingId === inv.project_id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <>
                          <Check className="mr-1 h-3.5 w-3.5" /> Accept
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

export default ProjectsWorkSection;
