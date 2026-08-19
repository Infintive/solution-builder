/**
 * The growth-desk action-taking agent — Nimbus.
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
 *   - `find_sliding_segment`     → Build 2 (Assist): read the sliding segment
 *   - `rank_actions`             → Build 2 (Assist): read the ML recommendation
 *   - `search_experiments`       → Build 2 (Assist): Lakebase Search over experiments
 *   - `execute_feature_decision` → Build 3 (Act):   the human-in-the-loop write
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
      'Investigate the governed lakehouse with a natural-language question — the tool generates SQL / retrieves knowledge and returns a synthesized answer. Use for any "why" / "what happened" / investigative question about conversion, segments, sliding cohorts, or experiments. Prefer ONE narrow, well-formed question over many small ones.',
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

  // ── find_sliding_segment — TRAINEE BUILDS (Build 2 · Assist). STUB. ──────
  // TODO — BUILD 2 (trainee): implement this. Read the sliding segment
  // for {segment_id} (or the worst one) from Lakebase app.open_sliding
  // + app.segment_position: conversion, drop, MAU, matching experiment.
  // Helper queries are READY in server/db/queries/segments.ts:
  // `getSlidingSegment`, `worstSlidingSegment`.
  // See APP_WORKSHOP.md → "Layer 2 — Assist".
  const findSlidingSegment = tool({
    name: 'find_sliding_segment',
    description:
      'Read the live sliding segment for {segment_id} (or the worst sliding segment) from Lakebase: conversion, conversion drop, MAU, matching experiment context. Read-only.',
    parameters: z.object({
      segment_id: z
        .string()
        .nullable()
        .describe('Segment id, e.g. SEG-0000214. Null → return the worst sliding segment.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── rank_actions — TRAINEE BUILDS (Build 2 · Assist). STUB. ────────────────
  // TODO — BUILD 2 (trainee): implement this. Read the ML model's ranked
  // actions for {segment_id} from Lakebase app.action_recommendations:
  // recommended action type, predicted conversion lift, predicted net value, and
  // all three options (for what-if). Helper: `getRecommendation` in
  // server/db/queries/segments.ts.
  const rankActions = tool({
    name: 'rank_actions',
    description:
      'Read the ML model\'s ranked feature actions — the demo\'s "ML in the loop" moment. Returns recommended action, predicted conversion lift, and all three options.',
    parameters: z.object({
      segment_id: z
        .string()
        .describe('Segment id, e.g. SEG-0000214'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── search_experiments — TRAINEE BUILDS (Build 2 · Assist). STUB. ──────────
  // TODO — BUILD 2 (trainee): implement this using Lakebase Search over
  // experiment descriptions. See APP_WORKSHOP.md.
  const searchExperiments = tool({
    name: 'search_experiments',
    description:
      'Search the experiment catalog (names + descriptions) using Lakebase Search. Returns matching experiments with context.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search query, e.g. "checkout" or "gen-z" or "android"'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── execute_feature_decision — TRAINEE BUILDS (Build 3 · Act). STUB. ──────
  // TODO — BUILD 3 (trainee): implement this. Write a feature decision (approved
  // action + note) to app.feature_decisions_app + emit dataMutated.
  // Helper: `recordFeatureDecision` in server/db/queries/segments.ts.
  const executeFeatureDecision = tool({
    name: 'execute_feature_decision',
    description:
      'Record an approved feature decision (ship_proven_variant / rollout_existing_flag / ship_alt_variant + drafted note) to the growth desk. Writes to app.feature_decisions_app and triggers dataMutated → Growth Desk refresh. Human-in-the-loop: only call after user approval.',
    parameters: z.object({
      segment_id: z
        .string()
        .describe('Segment id, e.g. SEG-0000214'),
      action_type: z
        .string()
        .describe('ship_proven_variant / rollout_existing_flag / ship_alt_variant'),
      target_experiment_id: z
        .string()
        .nullable()
        .describe('Experiment matched or the alternative; null for rollout'),
      flag_key: z
        .string()
        .describe('The flag key to ship or rollout'),
      variant: z
        .string()
        .describe('The variant of the flag'),
      rollout_pct: z
        .number()
        .nullable()
        .describe('Rollout percentage (0-100); null if not applicable'),
      drafted_note: z
        .string()
        .describe('The agent-drafted rollout note'),
      predicted_conversion_lift: z
        .number()
        .nullable()
        .describe('Predicted conversion lift from the model, if available'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 3 Act task; see APP_WORKSHOP.md',
      );
    },
  });

  // find_sliding_segment / rank_actions / search_experiments / execute_feature_decision
  // are registered so the MODEL knows they exist (and the trainee sees them
  // in the tool list) — they throw until implemented. ask_data is registered
  // only when a backend is configured.
  const tools: Tool[] = [
    findSlidingSegment,
    rankActions,
    searchExperiments,
    executeFeatureDecision,
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
  // Tracing is auto-wired by mlflow-tracing; disable to see raw agent loops.
  setTracingDisabled(false);

  const tools = makeTools(ctx);
  if (tools.length === 0) {
    console.warn('[agent] No tools configured — ask_data backend not set.');
  }

  const agent = new Agent({
    name: 'nimbus-growth-desk',
    model: ctx.model,
    tools,
    instructions: `You are the Nimbus Growth Desk agent. Your role is to help Jordan Cole (VP Growth, Nimbus) identify sliding conversion segments, rank the best feature to ship, and execute decisions that drive growth.`,
  });

  // Agent is ready for use. Caller (chat-stream/agent-stream.ts) wires it
  // into the event stream.
  global.agentInstanceDEV = { agent, tools };
}

// DEV: place for the global agent instance (so tools can debug-log).
// This is NOT a proper DI pattern — it's a workaround for the Agents SDK's
// async agent construction (needs to happen inside configureAgentsSdk before
// the first chat message). In production, return the agent from this module
// and wire it properly.
declare global {
  var agentInstanceDEV: { agent: Agent; tools: Tool[] } | undefined;
}
