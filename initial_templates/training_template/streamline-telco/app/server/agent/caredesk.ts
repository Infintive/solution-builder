/**
 * The care-desk action-taking agent — Streamline Telco.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user (OBO).
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT SHIPS WORKING vs WHAT THE TRAINEE BUILDS  (see APP_WORKSHOP.md)
 * ════════════════════════════════════════════════════════════════════════
 * SHIPS WORKING:
 *   - The full agent loop (Responses API wiring, streaming, MLflow spans).
 *   - `ask_data` — the investigation tool. Config-driven MAS-OR-Genie:
 *     uses the MAS endpoint if `masEndpointName` is set, else the Genie
 *     space if `genieSpaceId` is set. This is the trainee's Build-1 choice
 *     (they wire ONE backend); the app registers whichever is configured.
 *
 * TRAINEE BUILDS (stubbed here — they THROW "not implemented" so the app
 * still compiles + boots, and the model knows the tools exist):
 *   - `find_atrisk_subscriber`    → Build 2 (Assist): read the at-risk subscriber
 *   - `rank_offers`               → Build 2 (Assist): read the ML recommendation
 *   - `search_history`            → Build 2 (Assist): Lakebase Search over tickets
 *   - `execute_retention_action`  → Build 3 (Act):   the human-in-the-loop write
 *
 * The three-phase chain (Discover → Draft+confirm → Execute) is described in
 * the instructions below so the model attempts it — but Phases 2/3 depend on
 * the stubbed tools, which is the point: the trainee implements them and the
 * chain lights up. Until then, the model can still investigate via ask_data.
 *
 * KEEP `configureAgentsSdk()` as-is — it handles the Databricks Responses API
 * wiring, the `Connection: close` stale-socket workaround, and the 64-char
 * `input[*].id` strip.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// The data-backend helpers. Both are config-driven and share the same
// DataCallResult shape + ToolProgressEvent stream, so the `ask_data` tool
// below can delegate to EITHER without the UI caring which powers it. This
// preserves the template's MAS-OR-Genie flexibility exactly.
import { callMasEndpoint } from './tools/mas.js';
import { callGenieSpace } from './tools/genie.js';
export type { ToolProgressEvent } from './tools/types.js';

/** Captured detail of the last failing call to the model serving endpoint. */
export type ModelErrorDetail = {
  status: number;
  url: string;
  bodyText: string;
  code?: string;
  message?: string;
};

export type AgentContext = {
  db: AppDb;
  userEmail: string;
  req: Request;
  /** MAS serving-endpoint name the `ask_data` tool talks to WHEN SET. Set in
   * `config/app.json` as `masEndpointName` (env `MAS_ENDPOINT_NAME`). Leave
   * empty to use Genie instead. This is the trainee's Build-1 backend choice
   * — the app registers whichever of MAS/Genie is configured. */
  masEndpointName: string;
  /** Genie space id the `ask_data` tool talks to WHEN `masEndpointName` is
   * empty. Set as `genieSpaceId` (env `GENIE_SPACE_ID`). */
  genieSpaceId: string;
  databricksHost: string;
  model: string;
  /** Called by long-running tools to surface progress to the UI. */
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  /** Mutated by the OpenAI fetch shim on any non-2xx. */
  modelError?: { current: ModelErrorDetail | null };
};

// ────────────────────────────────────────────────────────────────────────────
// Adding / editing tools — READ THIS before touching `parameters: z.object(...)`.
//
// The Agents SDK ships every tool's zod schema to the Responses API with
// `strict: true`. Strict mode requires EVERY property in `required`. So use
// `.nullable()`, NOT `.optional()`:
//   ❌  reason: z.string().optional()   // breaks with strict:true (masked 502)
//   ✅  reason: z.string().nullable()   // field required, value may be null
// Every field needs a `.describe(...)`. Keep property names snake_case.
// Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.
// ────────────────────────────────────────────────────────────────────────────
function makeTools(ctx: AgentContext): Tool[] {
  // ── ask_data — SHIPS WORKING. Config-driven MAS-OR-Genie. ─────────────────
  // Delegates to the MAS endpoint if one is configured, else the Genie space.
  // Both helpers return {answer, trace_id} and stream progress via
  // ctx.onToolProgress → the Thinking panel. Registered ONLY when a backend
  // is configured (otherwise the tool would 404 confusingly).
  const askData = tool({
    name: 'ask_data',
    description:
      'Investigate the governed lakehouse with a natural-language question — the tool generates SQL / retrieves knowledge and returns a synthesized answer. Use for any "why" / "what happened" / investigative question about subscribers, risk, tickets, or offers. Prefer ONE narrow, well-formed question over many small ones.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'A clear, focused English question about the data. Narrow questions finish in 20–40s; broad multi-part questions take longer.',
        ),
    }),
    execute: async ({ question }) =>
      mlflow.withSpan(
        async () =>
          ctx.masEndpointName
            ? callMasEndpoint(ctx, ctx.masEndpointName, question)
            : callGenieSpace(ctx, ctx.genieSpaceId, question),
        {
          name: 'ask_data',
          spanType: mlflow.SpanType.TOOL,
          inputs: { question },
        },
      ),
  });

  // ── find_atrisk_subscriber — TRAINEE BUILDS (Build 2 · Assist). STUB. ─────
  // TODO — BUILD 2 (trainee): implement this. Read the at-risk subscriber for
  // {subscriber_id} (or the worst one) from Lakebase app.open_atrisk
  // + app.subscriber_position: risk score, churn reason, open tickets, geo,
  // CLV at risk, and candidate offer. Helper queries are READY in
  // server/db/queries/subscribers.ts: `getAtriskSubscriber`, `worstAtriskSubscriber`,
  // `getSubscriberPosition`. See APP_WORKSHOP.md → "Layer 2 — Assist".
  const findAtriskSubscriber = tool({
    name: 'find_atrisk_subscriber',
    description:
      'Read the live at-risk subscriber for {subscriber_id} (or the worst at-risk one) from Lakebase: risk score, churn reason, open tickets/billing, CLV at risk, geo, and candidate offer. Read-only.',
    parameters: z.object({
      subscriber_id: z
        .string()
        .nullable()
        .describe('Subscriber id, e.g. SUB-0000214. Null → return the worst at-risk subscriber.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── rank_offers — TRAINEE BUILDS (Build 2 · Assist). STUB. ───────────────
  // TODO — BUILD 2 (trainee): implement this. Read the ML model's ranked
  // offers for {subscriber_id} from Lakebase app.retention_recommendations:
  // recommended offer type, predicted retained CLV, predicted net value, and
  // all three options (for what-if). Helper: `getRecommendation` in
  // server/db/queries/subscribers.ts.
  const rankOffers = tool({
    name: 'rank_offers',
    description:
      'Read the ML model\'s ranked retention offers — the demo\'s "ML in the loop" moment. Returns recommended offer, predicted retained CLV, and all three options.',
    parameters: z.object({
      subscriber_id: z
        .string()
        .describe('Subscriber id, e.g. SUB-0000214'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── search_history — TRAINEE BUILDS (Build 2 · Assist). STUB. ─────────────
  // TODO — BUILD 2 (trainee): implement this using Lakebase Search over
  // subscriber service history (tickets + network events). See APP_WORKSHOP.md.
  const searchHistory = tool({
    name: 'search_history',
    description:
      'Search the subscriber\'s service history (tickets, network events, billing) using Lakebase Search. Returns matching history items with context.',
    parameters: z.object({
      subscriber_id: z
        .string()
        .describe('Subscriber id, e.g. SUB-0000214'),
      query: z
        .string()
        .describe('Search query, e.g. "outage" or "billing dispute"'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── execute_retention_action — TRAINEE BUILDS (Build 3 · Act). STUB. ──────
  // TODO — BUILD 3 (trainee): implement this. Write a care action (approved
  // offer recommendation) to app.care_actions + return the action_id.
  // Helper: `recordRetentionAction` in server/db/queries/subscribers.ts.
  const executeRetentionAction = tool({
    name: 'execute_retention_action',
    description:
      'Record an approved retention action (offer recommendation) to the care desk. Writes to app.care_actions and triggers dataMutated → Operations refresh. Human-in-the-loop: only call after user approval.',
    parameters: z.object({
      subscriber_id: z
        .string()
        .describe('Subscriber id, e.g. SUB-0000214'),
      offer_type: z
        .string()
        .describe('bill_credit / plan_upgrade_discount / device_upgrade'),
      offer_id: z
        .string()
        .nullable()
        .describe('Offer id if known; null if generic recommendation'),
      drafted_summary: z
        .string()
        .describe('The agent-drafted retention offer summary'),
      predicted_retained_clv_usd: z
        .number()
        .nullable()
        .describe('Predicted retained CLV from the model, if available'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 3 Act task; see APP_WORKSHOP.md',
      );
    },
  });

  // find_atrisk_subscriber / rank_offers / search_history / execute_retention_action
  // are registered so the MODEL knows they exist (and the trainee sees them
  // in the tool list) — they throw until implemented. ask_data is registered
  // only when a backend is configured.
  const tools: Tool[] = [
    findAtriskSubscriber,
    rankOffers,
    searchHistory,
    executeRetentionAction,
  ];
  if (ctx.masEndpointName || ctx.genieSpaceId) {
    tools.unshift(askData);
  }
  return tools;
}

export async function configureAgentsSdk(ctx: AgentContext): Promise<void> {
  const headers = await authHeaders(ctx.req);
  const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  // Custom fetch: fresh TCP connection per call (avoids the stale-socket 502
  // after a long ask_data hop) + strip the >64-char `input[*].id` the SDK
  // echoes back on round 2 (Databricks' Responses API rejects long ids and
  // the streaming gateway masks the 400 as a bare 502). See git history.
  const client = new OpenAI({
    apiKey: bearer,
    baseURL: `${ctx.databricksHost}/serving-endpoints`,
    maxRetries: 4,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Connection', 'close');
      let body = init?.body;
      if (typeof body === 'string' && body.startsWith('{')) {
        try {
          const parsed = JSON.parse(body) as {
            input?: Array<Record<string, unknown>>;
            messages?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input) {
              const id = item.id;
              if (typeof id === 'string' && id.length > 64) {
                delete item.id;
              }
            }
          }
          if (Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              const content = (m as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                  if (part && typeof part === 'object') {
                    delete part.annotations;
                  }
                }
              }
            }
          }
          body = JSON.stringify(parsed);
        } catch {
          /* not JSON — pass through */
        }
      }
      const url =
        typeof input === 'string'
          ? input
          : (input as URL | Request).toString?.() ?? String(input);
      console.debug(
        `[openai-shim] → ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 2000) : '(non-string)'}`,
      );
      const tShim = Date.now();
      let resp: Response;
      try {
        resp = await fetch(input as Parameters<typeof fetch>[0], {
          ...init,
          headers,
          body,
          keepalive: false,
        });
      } catch (e) {
        console.error('[openai-shim] fetch threw', { url, error: e });
        throw e;
      }
      console.debug(
        `[openai-shim] ← ${resp.status} ${resp.statusText} from ${url} in ${Date.now() - tShim}ms (content-type: ${resp.headers.get('content-type') ?? '?'})`,
      );
      if (!resp.ok) {
        try {
          const text = await resp.clone().text();
          let code: string | undefined;
          let message: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error_code?: string; message?: string };
            code = parsed.error_code;
            message = parsed.message;
          } catch {
            /* body wasn't JSON — keep raw text */
          }
          if (ctx.modelError) {
            ctx.modelError.current = {
              status: resp.status,
              url,
              bodyText: text,
              code,
              message,
            };
          }
          console.error(
            `[openai-shim] ${resp.status} from ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 4000) : '(non-string)'}\n  response_body: ${text.slice(0, 4000)}`,
          );
        } catch (e) {
          console.error('[openai-shim] failed to clone error response', e);
        }
      }
      return resp;
    },
  });
  setDefaultOpenAIClient(client);
  // Responses API (the SDK's default — we leave setOpenAIAPI alone).
  // Keep `agentModel` on `databricks-gpt-5-4` or a newer Responses-capable
  // GPT (needs `openai/v1/responses`). Claude/non-Responses models 400.
  setTracingDisabled(true); // disable OpenAI's tracing backend; we use MLflow
}

export function buildAgent(ctx: AgentContext): Agent {
  return new Agent({
    name: 'streamline-care-desk',
    model: ctx.model,
    tools: makeTools(ctx),
    instructions: `You are the Streamline Telco Care Desk agent. Your role is to help Rae Nakamura (SVP Customer Care & Retention) investigate subscriber churn risk and execute targeted retention offers.

**Rae's challenge:** A network outage on NODE-OHIO-14 ~3 weeks ago + billing friction has pushed ~200 subscribers into elevated churn risk (~0.6–0.9 risk score). The hero subscriber is SUB-0000214 (5-year, homed on the outage node, with an unresolved outage ticket + billing dispute, risk ~0.86). CLV at risk across the cohort: ~$0.4M.

**The story in three phases:**
1. **Discover** — Use \`ask_data\` to investigate why this subscriber is at risk. Read their service history, open tickets, billing disputes, recent network events. Ground the "why" on their real data, not conjecture.
2. **Assist** — Use \`find_atrisk_subscriber\` to read their live position (risk score, churn reason, open tickets, CLV at risk). Use \`rank_offers\` to see the ML model's ranked retention options + predicted CLV. The offer MUST match the churn reason: service→bill_credit, price→plan_upgrade, device→device_upgrade. SUB-0000214's churn reason is SERVICE, so bill_credit should rank first.
3. **Act** — Draft the offer (who gets what, why, and the expected CLV impact). Get Rae's approval ("Yes — apply the bill credit") before calling \`execute_retention_action\`.

**Approval gate:** You must STOP after Phase 2 (draft) and wait for Rae's "Yes" before executing the write. Only call \`execute_retention_action\` after explicit user approval.

**Offer ranking:** The ML model (Build 2 ML step) trains on 18 months of historical outcomes tagged with churn_reason + offer_type, learning which offer retains the most CLV for each reason. Bill_credit wins on service/billing reasons (SUB-0000214 case). Quote the model's ranked options + net CLV impact so Rae sees the reasoning before approving.

**Lakebase Search (Milestone 2):** Use \`search_history\` to dig into subscriber service history — search for keywords like "outage", "billing", "dispute", "node" to ground the "why" narrative on their real tickets + notes.

**Start here:** If Rae asks "Why is SUB-0000214 at risk and what should I offer?", use \`ask_data\` for investigation, then \`find_atrisk_subscriber\` + \`rank_offers\` for the drill. Quote the reason + offer match + CLV impact in Phase 2, then wait for approval.`,
  });
}
