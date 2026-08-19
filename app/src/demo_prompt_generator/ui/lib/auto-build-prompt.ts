export const AUTO_BUILD_KICKOFF = `Auto-build mode. Follow DEMO_SKILL stages 0→3 end-to-end without pausing at the gates. Stage 4 (DAB) only if the user later asks for it.

Choose sensible defaults instead of asking. Batch independent reads and independent writes in the same turn. Don't narrate — let the tool calls speak. Surface a message only on a hard error you can't recover from, or as the final summary with workspace links.

Write specifications directly — don't think too long about them. Spec files are working drafts that get refined during build, not finished essays. Skip the deliberation, write the file, move on. The build stage will surface anything that doesn't work.`;

/** Appended to the initial prompt(s) we send the agent on project creation and
 *  architecture-first build. The Solution Builder app resolves the brand itself
 *  (via its brand API) and writes brand/brand.json — so the agent must NOT waste
 *  turns web-searching for it. It just reads the file if/when it's there. */
export const BRAND_NOTE = `Note: don't search the web for the company's brand — we resolve it for you and populate \`brand/brand.json\` (palette, logo, site). If it's there, read it to personalize the demo; if not, don't fetch it.`;

/** Sent to the agent (once per project) when the frontend detects that
 *  architecture.md is in the OLD, pre-flat-file format. Asks the agent to
 *  migrate it to the current schema, grounded in the project's README story. */
export const ARCHITECTURE_MIGRATION_PROMPT = `This project uses an old version of the architecture. Read architecture.md, and the databricks-architecture skill, and update the architecture to the new format, making sure it reflect the story in the readme.`;

import type { ArchitectureIssue } from "./platform-architecture";

/** Turn validateArchitecture() issues into a chat message for the agent. Groups
 *  by tab, lists each issue with its element + field + message, and tells the
 *  agent to fix architecture.md. Returns null when there are no issues (so the
 *  caller can skip sending). The message is deliberately concrete — the agent
 *  gets the exact ids/fields to fix, not a vague "something's wrong". */
export function buildArchitectureFixPrompt(issues: ArchitectureIssue[]): string | null {
  if (!issues.length) return null;
  const byTab = new Map<string, ArchitectureIssue[]>();
  for (const i of issues) {
    const arr = byTab.get(i.tab) ?? [];
    arr.push(i);
    byTab.set(i.tab, arr);
  }
  const sections = [...byTab.entries()].map(([tab, list]) => {
    const lines = list.map((i) => {
      const where = i.nodeId ? `node \`${i.nodeId}\`` : i.edgeId ? `edge \`${i.edgeId}\`` : "";
      const field = i.field ? ` (\`${i.field}\`)` : "";
      return `  - ${where}${field}: ${i.message}`;
    });
    return `Tab "${tab}":\n${lines.join("\n")}`;
  });
  return `The architecture diagram (architecture.md) has ${issues.length} validation ${issues.length === 1 ? "issue" : "issues"} that make it render incorrectly. These are broken references — ids, edges, or handles pointing at things that don't exist on the tab (a common cause: a node was renamed but a \`wraps\`/edge/relational reference still uses the old id).

${sections.join("\n\n")}

Read architecture.md and the databricks-architecture skill, then fix each issue in place — correct the referenced id to the intended existing node, remove the reference if the target is genuinely gone, or add the missing node if it should be there. Preserve the diagram's intent and layout; only fix the broken references. Re-check that every \`wraps\`/edge/relational reference resolves to a real node afterward.`;
}
