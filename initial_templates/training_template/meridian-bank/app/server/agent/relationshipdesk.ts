/**
 * The action-taking agent — this is the DEMO'S DEFINING PIECE.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API (`setOpenAIAPI('responses')` lets us stream reasoning
 * summaries alongside final text). Tools capture `db` + `userEmail` via
 * closure so every action is attributed to the viewing user.
 *
 * WHY THIS FILE IS LOAD-BEARING FOR THE TEMPLATE STORY:
 *   The whole pitch is "AI that not only tells you what's wrong, but can
 *   act on it end-to-end, with the human in the loop." That translates to:
 *     1. An investigation tool that delegates to the Databricks
 *        Multi-Agent Supervisor (`ask_data` → MAS) for open-ended "why"
 *        questions backed by SQL + KA retrieval.
 *     2. Lookup tools that read the local Lakebase mirror (fast OLTP).
 *     3. A *write* tool that mutates state in one transaction.
 *   The agent instructions below are phased deliberately: Mode A for pure
 *   investigation; Mode B for write-intent with a mandatory confirmation
 *   step before anything destructive runs.
 *
 * REPURPOSING: to build a different use case:
 *   - Replace `makeTools(ctx)` with your own tools (Zod-schema'd).
 *   - Rewrite `buildAgent()`'s `instructions` string for your domain.
 *   - Keep `configureAgentsSdk()` as-is — it handles the Databricks
 *     Responses API wiring, the `Connection: close` workaround for stale
 *     sockets, and the 64-char `input[*].id` strip (see comments below).
 *   - The data-backend tool (`ask_mas` here) is registered via the
 *     reusable factories in `agent/tools/{mas,genie}.ts`. Pick the one
 *     that matches your demo:
 *       • MAS only      → use `askMasTool(ctx, ctx.masEndpointName)`
 *       • Genie only    → use `askGenieTool(ctx, ctx.genieSpaceId)`
 *                          (and rename the AgentContext field accordingly)
 *       • Both          → register both factories with distinct names,
 *                          and tell the model in instructions when to
 *                          prefer each.
 *
 * Name: the file is called `relationshipdesk` because this use case is
 * relationship banking and customer retention at Meridian Bank. Rename to
 * match your own agent (e.g. `claimsops`, `billingops`, `supporttriage`)
 * and update the import in `chat-stream/agent-stream.ts`.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// Data-backend tool factories. The template demo uses MAS, but if your
// demo has only a Genie space, swap `askMasTool` → `askGenieTool` and
// update the AgentContext field below (masEndpointName → genieSpaceId).
// If your demo has BOTH, register both tools and tell the model in the
// agent instructions when to prefer each.
import { askMasTool } from './tools/mas.js';
export type { ToolProgressEvent } from './tools/types.js';

/** Captured detail of the last failing call to the model serving endpoint.
 * The OpenAI SDK strips the response body before throwing, so we stash it
 * here from the fetch shim and let the outer catch block read it to build a
 * useful error message for the user. */
export type ModelErrorDetail = {
  status: number;
  url: string;
  bodyText: string;
  /** Parsed `error_code` if the body was Databricks-style JSON. */
  code?: string;
  /** Parsed `message` if the body was Databricks-style JSON. */
  message?: string;
};

export type AgentContext = {
  db: AppDb;
  userEmail: string;
  req: Request;
  /** MAS serving-endpoint name the `ask_data` tool talks to. Set in
   * `config/app.json` as `masEndpointName`. The template demo uses MAS;
   * if your demo uses Genie instead, replace this field with
   * `genieSpaceId: string` and swap `askMasTool` → `askGenieTool` in
   * makeTools below. See server/agent/tools/{mas,genie}.ts. */
  masEndpointName: string;
  databricksHost: string;
  model: string;
  /** Called by long-running tools to surface progress to the UI. */
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  /** Mutated by the OpenAI fetch shim on any non-2xx so the outer catch
   * block can surface Databricks' actual error_code/message instead of the
   * SDK's stripped "400 status code (no body)". */
  modelError?: { current: ModelErrorDetail | null };
};


// ────────────────────────────────────────────────────────────────────────────
// Adding / editing tools — read this before touching `parameters: z.object(...)`.
//
// The Agents SDK ships every tool's zod schema to the Responses API with
// `strict: true`. Strict mode requires every property to appear in `required`.
// If you write `.optional()` on a field, zod-to-json-schema drops it from
// `required`, OpenAI rejects the schema with a 400, and Databricks' proxy
// masks the 400 as a bare 502 INTERNAL_ERROR — you get no clue what's wrong.
//
//   ❌  reason: z.string().optional()                 // breaks with strict:true
//   ✅  reason: z.string().nullable()                 // field required, value may be null
//   ✅  reason: z.string().nullable().describe('…')
//
// Other gotchas for new tools:
//   • Every `z.object({...})` field needs a `.describe('…')` — the model uses
//     it to decide when/how to call the tool. Missing descriptions = bad calls.
//   • Keep property names snake_case. OpenAI's tool calls sometimes normalize
//     casing and mixing conventions causes subtle argument-parsing bugs.
//   • Don't use `z.union([...])` at the top level of parameters — Responses
//     API strict mode requires a single object schema.
//   • `tool` here is the `loggedTool` wrapper from ./tools/logged-tool.ts: it
//     logs thrown errors via console.error (caught by lib/logger.ts) BEFORE
//     returning the SDK's recovery hint to the model. Don't import the raw
//     `tool` from '@openai/agents' directly — you'll silently lose the logs.
// ────────────────────────────────────────────────────────────────────────────
function makeTools(ctx: AgentContext) {
  const findAtriskCustomer = tool({
    name: 'find_atrisk_customer',
    description:
      'Identify an at-risk customer from Lakebase app.customer_position. Pass a customer_id to fetch that customer; pass null to find the worst open at-risk (highest attrition_risk_score). Returns {customer_id, tier, attrition_risk_score, balance_at_risk_usd, revenue_at_risk_usd, days_to_maturity, maturing_deposit_balance_usd, current_rate_apy, home_metro, total_balance_usd}. Use this to begin the discovery phase.',
    parameters: z.object({
      customer_id: z.string().nullable().describe('Customer ID to lookup. If null, returns the worst open at-risk by attrition_risk_score.'),
    }),
    execute: async ({ customer_id }) =>
      mlflow.withSpan(
        async () => {
          throw new Error(
            'Not implemented — this is a training stub. Implement this tool by reading from app.customer_position and app.open_atrisk. See APP_WORKSHOP.md for guidance.',
          );
        },
        {
          name: 'find_atrisk_customer',
          spanType: mlflow.SpanType.TOOL,
          inputs: { customer_id },
        },
      ),
  });

  const rankNextBestActions = tool({
    name: 'rank_next_best_actions',
    description:
      'Retrieve ranked next best actions for a customer from Lakebase app.nba_recommendations. The recommender model scores each action (e.g., "offer certificate_of_deposit at 5.25%", "upgrade_checking_account_features", "introduce_investment_product") by predicted_retained_usd and predicted_net_value_usd. Returns {recommended_action, predicted_retained_usd, predicted_net_value_usd, action_ranking: [...]}, sorted by value impact. Use this in the recommendation phase.',
    parameters: z.object({
      customer_id: z.string().describe('Customer ID to fetch ranked recommendations for.'),
    }),
    execute: async ({ customer_id }) =>
      mlflow.withSpan(
        async () => {
          throw new Error(
            'Not implemented — this is a training stub. Implement this tool by querying app.nba_recommendations. See APP_WORKSHOP.md for guidance.',
          );
        },
        {
          name: 'rank_next_best_actions',
          spanType: mlflow.SpanType.TOOL,
          inputs: { customer_id },
        },
      ),
  });

  const searchProducts = tool({
    name: 'search_products',
    description:
      'Search Lakebase app.products by query string (searches product_name and description). Returns {product_id, product_name, segment, rate_apy, min_balance_usd}[]. Use this to find products to offer the customer.',
    parameters: z.object({
      query: z.string().describe('Search query — e.g., "high yield savings", "money market" or "certificate of deposit 5%".'),
    }),
    execute: async ({ query }) =>
      mlflow.withSpan(
        async () => {
          throw new Error(
            'Not implemented — this is a training stub. Implement this tool by searching app.products on product_name + description. See APP_WORKSHOP.md for guidance.',
          );
        },
        {
          name: 'search_products',
          spanType: mlflow.SpanType.TOOL,
          inputs: { query },
        },
      ),
  });

  const executeNbaAction = tool({
    name: 'execute_nba_action',
    description:
      "WRITE TOOL: record a relationship manager action in Lakebase app.rm_actions. Captures the customer_id, action_type (retention_offer / cross_sell / rm_outreach), offered_product_id (if applicable), rate_apy (if a rate offer), and drafted_note (the RM's outreach message). All recorded on behalf of userEmail for audit. Returns {action_id, created_at, recorded_by}. Use ONLY after the user has approved the action.",
    parameters: z.object({
      customer_id: z.string().describe('Customer ID.'),
      action_type: z.string().describe('Type of action — e.g., "offer_product", "increase_rate", "upsell_service", "extend_terms".'),
      offered_product_id: z.string().nullable().describe('Product ID if offering a specific product; else null.'),
      rate_apy: z.number().nullable().describe('APY if the action involves a rate offer; else null.'),
      drafted_note: z.string().describe('The RM outreach message or note captured for the customer record.'),
    }),
    execute: async (args) =>
      mlflow.withSpan(
        async () => {
          throw new Error(
            'Not implemented — this is a training stub. Implement this tool by writing to app.rm_actions. See APP_WORKSHOP.md for guidance.',
          );
        },
        {
          name: 'execute_nba_action',
          spanType: mlflow.SpanType.TOOL,
          inputs: {
            customer_id: args.customer_id,
            action_type: args.action_type,
            recorded_by: ctx.userEmail,
          },
        },
      ),
  });

  // The data-backend tool. The template demo uses a MAS endpoint;
  // swap to `askGenieTool(ctx, ctx.genieSpaceId)` if your demo only has
  // a Genie space (and update AgentContext + config/app.json to match).
  // For a demo with both, register both tools — the model picks based
  // on the descriptions in tools/{mas,genie}.ts.
  // Skip registration entirely if no endpoint is configured — otherwise
  // the tool fires `POST /serving-endpoints//invocations` (note the
  // double slash) and returns a confusing 404 to the model. Boot-time
  // warning in server.ts already tells the operator to fix the config.
  // Typed as Tool[] so the heterogeneous tools (different param schemas) and
  // the optional data-backend tool can coexist — otherwise TS infers a narrow
  // union from the literal array and rejects the push below.
  const tools: Tool[] = [findAtriskCustomer, rankNextBestActions, searchProducts, executeNbaAction];
  if (ctx.masEndpointName) {
    tools.push(askMasTool(ctx, ctx.masEndpointName));
  }
  return tools;
}

export async function configureAgentsSdk(ctx: AgentContext): Promise<void> {
  // Build a fresh auth header each configure; OpenAI SDK holds the key at
  // client construction time, so we reconfigure per request to pick up a
  // fresh bearer. (setDefaultOpenAIClient is idempotent.)
  const headers = await authHeaders(ctx.req);
  const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  // NOTE: we used to wrap with mlflow-openai's `tracedOpenAI()`, but its
  // wrapper `await`s the response to snapshot outputs — which breaks
  // streaming responses. Skip it; we still get agent-level spans via the
  // root `relationshipdesk.turn` and per-tool `withSpan` wrappers.
  //
  // Use a custom fetch that forces a fresh TCP connection per call and
  // disables keep-alive. Without this, after a long-running tool call
  // (ask_data → MAS takes ~90s), the second Responses API call reuses a
  // stale socket that the Databricks gateway has half-closed, which
  // surfaces as a bare 502 (no headers/body) ~3s into the call. Also bump
  // maxRetries since 502s are transient gateway failures.
  // ──────────────────────────────────────────────────────────────────
  // 64-char input[*].id workaround for Databricks' Responses API
  // ──────────────────────────────────────────────────────────────────
  //
  // Problem:
  //   On the synthesis turn (after a tool output is fed back), the agent
  //   run fails with `502 status code (no body)` after ~3s. The failure
  //   is deterministic, not transient — retries don't help.
  //
  // Root cause:
  //   The @openai/agents SDK assigns long IDs (e.g. `fc_013bda62…` ~190
  //   chars) to `reasoning` and `function_call` items in the conversation
  //   history. On round 2, the SDK echoes those items back in `input[]`.
  //   Databricks' Responses API enforces a 64-char max on `input[*].id`
  //   and returns `400 Invalid 'input[N].id': string too long`. The
  //   streaming gateway then masks that 400 as a bare 502. (Reproduced
  //   by flipping `stream: true` → `stream: false` in `scripts/repro-502.ts`:
  //   the 502 becomes a clean 400 with the real message.)
  //
  // Fix:
  //   Intercept outgoing request bodies and delete any `input[i].id`
  //   longer than 64 chars. Databricks treats missing ids as freshly
  //   generated, so this is safe — the conversation continuity is
  //   carried by `call_id` (short) for function calls, not `id`.
  //
  // Remove this wrapper once Databricks lifts the 64-char limit.
  // ──────────────────────────────────────────────────────────────────
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
          // Responses-API: strip long opaque ids the SDK echoes back.
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input) {
              const id = item.id;
              if (typeof id === 'string' && id.length > 64) {
                delete item.id;
              }
            }
          }
          // Chat-completions: Anthropic-via-Bedrock rejects unknown keys
          // on assistant message content parts. The SDK adds
          // `annotations: []` to text parts when replaying assistant
          // history (turn 2+ of an agent loop). Strip them.
          //   400: "messages.N.content.0.text.annotations: Extra inputs are not permitted"
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
      // Always log the URL + status so failures show up in server logs.
      // The OpenAI SDK rethrows non-2xx as `APIError(... no body)` because
      // it consumes the body for retry decisions before we see it. Tee a
      // clone of the body on error so we can log Databricks' actual reason.
      const url =
        typeof input === 'string'
          ? input
          : (input as URL | Request).toString?.() ?? String(input);
      // Log every outgoing request — URL + payload preview. Without this
      // a "200 OK but empty stream" looks indistinguishable from "we never
      // called the model at all" in the logs. DEBUG-level (silent by
      // default) — set LOG_LEVEL=debug to see per-request payloads.
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
  // Use the Responses API (the SDK's default — we leave setOpenAIAPI alone).
  // This template ships with `databricks-gpt-5-4` as the baseline agent model
  // because it supports both the Responses API passthrough AND the SDK-native
  // `response.reasoning_summary_text.*` event stream (which the UI subscribes to
  // for the live "thinking" panel). A newer GPT endpoint with `/responses`
  // enabled works too — the requirement is the Responses API, not this version.
  //
  // Why not Claude (Sonnet 4.6 etc)? Databricks gates the Responses API
  // route per-model: Anthropic models on FMAPI return 400 BAD_REQUEST on
  // `/serving-endpoints/responses`. They DO work on `chat-completions`, but
  // the OpenAI Agents SDK doesn't surface Anthropic's thinking blocks as
  // typed events on that route, so the live reasoning UI goes silent.
  // Wiring it up (fetch-shim injection of extra_body.thinking + parse the
  // chunk stream → emit synthetic reasoning_summary_text events) is doable
  // but ~60-100 lines we haven't written. For now: GPT-5-4 only.
  setTracingDisabled(true); // disable OpenAI's tracing backend; we use MLflow
}

export function buildAgent(ctx: AgentContext): Agent {
  return new Agent({
    name: 'RelationshipDesk',
    model: ctx.model,
    modelSettings: {
      // Enable reasoning summaries so the UI can show live "thinking"
      // (response.reasoning_summary_text.delta events). `effort: 'low'`
      // keeps time-to-first-token snappy for the demo; bump to 'medium'
      // or 'high' if the model needs more deliberation.
      reasoning: { effort: 'low', summary: 'auto' },
      // `store: false` disables the Responses API's server-side
      // conversation state. Databricks' gateway doesn't fully support the
      // state backend; leaving this on causes the second round-trip (after
      // the tool output) to hit a bare 502. Stateless runs work fine.
      store: false,
    },
    instructions: `
You are the AI assistant for Marcus Bell, EVP Consumer & Small Business Banking
at Meridian Bank. Your user is a non-technical executive. Be decisive, concise,
and focus on the three-phase loop: investigate why a customer is at risk, rank
the next best action, draft the outreach, and execute after approval.

════════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════════

ask_data(question) — delegates to the multi-agent supervisor. Use for any
  WHY / WHAT HAPPENED / investigative question about customer data, attrition
  patterns, market trends, deposit maturity schedules, or retention strategies.
  Prefer ONE well-formed question over many small ones.

find_atrisk_customer(customer_id) — identify an at-risk customer from Lakebase
  app.customer_position. Pass a customer_id to fetch that customer's details;
  pass null to find the worst open at-risk by attrition_risk_score. Output:
  {customer_id, tier, attrition_risk_score, balance_at_risk_usd,
  revenue_at_risk_usd, days_to_maturity, maturing_deposit_balance_usd,
  current_rate_apy, home_metro, total_balance_usd}.

rank_next_best_actions(customer_id) — THE RECOMMENDATION TOOL. Retrieve ranked
  actions from the nba_recommender model (app.nba_recommendations) that predict
  the highest retained_usd. Each action is scored on predicted_retained_usd +
  predicted_net_value_usd. Returns {recommended_action, predicted_retained_usd,
  predicted_net_value_usd, action_ranking: [...]}. Call this after you've
  identified the at-risk customer to see what the model recommends (e.g.,
  offer certificate_of_deposit at 5.25%, upgrade checking account, introduce
  investment product).

search_products(query) — search Lakebase app.products by query string (product_name
  + description). Returns {product_id, product_name, segment, rate_apy,
  min_balance_usd}[]. Use this to find specific products to offer the customer
  (e.g., "high yield savings 5%", "money market", "certificate of deposit").

execute_nba_action(customer_id, action_type, offered_product_id, rate_apy,
  drafted_note) — THE WRITE TOOL. Record a relationship manager action in
  Lakebase app.rm_actions: the customer_id, action_type (e.g., "offer_product",
  "increase_rate", "upsell_service"), offered_product_id (if applicable),
  rate_apy (if a rate offer), and the drafted_note (your outreach message).
  Everything is recorded on behalf of your user for audit. Returns
  {action_id, created_at, recorded_by}. **This is how you execute phase 3.**
  Use ONLY after the user has explicitly approved.

THERE ARE NO OTHER TOOLS. There is no send_customer_sms, no
override_maturity_date, no manual tier change. Everything you can do
is in the five tools above.

════════════════════════════════════════════════════════════
OPERATING MODES
════════════════════════════════════════════════════════════

MODE A — INVESTIGATION
If the user asks "why", "what", "who", "when", or anything that requires
reading data or documents → call ask_data EXACTLY ONCE with a SHORT,
targeted question. Then synthesize for the user. Do NOT use the action
tools unless the user explicitly asks you to fix something.

**Critical for latency**: ask_data calls out to a multi-agent supervisor
that spawns sub-agents per sub-question. Broad questions ("analyze churn
risk, maturing deposits, competitive rates, retention offers...") trigger
4+ sub-agent hops and take >90s. Narrow questions finish in 20-40s.

Prefer ONE of these shapes over the broad "tell me everything":
  - "Which customer has the highest attrition risk and the largest
     balance at risk in the next 90 days? Give me the customer_id, tier,
     current rate, and reason for risk."
  - "What is the maturity schedule for our top 50 customers by balance
     in the next Q?"

Avoid: asking for churn analysis + competitive positioning + deposit
schedule + retention levers + product recommendations in a single question.
The supervisor will hop 4 times.

MODE B — ACTION CHAIN (HUMAN-IN-THE-LOOP, RETENTION-FOCUSED)
If the user asks you to HANDLE / FIX / SAVE / RETAIN something, you
run a three-phase chain with a confirmation step in the middle. The
defining move of this chain: **you use the nba_recommender model to rank
the best action per customer**. The model scores each action (offer CD,
upgrade checking, introduce investment) by predicted_retained_usd, and
you draft the outreach accordingly. The RM retains the customer (and
revenue) by executing the model-ranked action.

**The story beat that lands the model**: Meridian's RM team manually
cherry-picks retention offers, often offering a flat rate to all at-risk
customers and missing cross-sell or product-fit opportunities. The
nba_recommender model, trained on 10K historical interventions, scores
each action by predicted_retained_usd for THIS customer's profile. A CD
retention might save $500K for a retiree; an investment intro might
save $2M for a high-net-worth customer; a rate bump saves only $50K for
a mid-tier depositor. By ranking actions, you (and the model's insight)
save the right customer with the right product.

Phase 1 and 2 are "prepare + show the user what will happen". Phase 3
is the write. NEVER run phase 3 (execute_nba_action) until the user has
explicitly approved.

--- Phase 1 · Discover (read-only) ---

  1. If you don't already know the target customer, call ask_data with a
     precise question: "Which customer has the highest attrition risk and
     the largest balance at risk in the next 30 days?". Extract the
     customer_id from the answer. If ask_data cannot produce a clear
     customer_id, ask the user once — do not guess.

  2. Call find_atrisk_customer(<customer_id>). This is THE discovery moment.
     Output: {customer_id, tier, attrition_risk_score, balance_at_risk_usd,
     revenue_at_risk_usd, days_to_maturity, maturing_deposit_balance_usd,
     current_rate_apy, home_metro, total_balance_usd}. Remember these
     details — you quote them in Phase 2.

  3. Call rank_next_best_actions(<customer_id>). Read the top-ranked action
     from the nba_recommender model. This is THE model story: "The
     recommender model suggests [action] to retain \${predicted_retained_usd}
     of balance."

  4. If the top action is an offer_product, call
     search_products(<product_description>) to find the specific product
     ID and current rate. (Optional if you already know the product.)

--- Phase 2 · Draft + ASK FOR CONFIRMATION ---

  5. Reply to the user with:
       - A bold headline: "Customer {customer_id} ({tier}, {home_metro})
         · {balance_at_risk_usd} at risk · matures in {days_to_maturity} days."
       - The attrition risk score, current rate, and total balance context.
       - The nba_recommender's top-ranked action + predicted_retained_usd.
       - A drafted outreach message (email or call summary) that offers
         the recommended action (e.g., "We'd like to offer you a {rate_apy}%
         CD for {product_name}").
       - A single-sentence CTA:
           "Reply **send** to execute this action — or tell me which action
            to try instead."

     STOP HERE. Do not proceed until the user's next message.

--- Phase 3 · Execute the action (on approval) ---

  Triggered only when the user's NEXT message is an approval (any form:
  "send", "go", "ok", "approved", "do it", "yes", "proceed", "looks good").
  Anything that looks like a revision ("try the CD instead", "increase the
  rate", "different product") means → redraft the message with the new
  action and go back to phase 2 step 5 (STOP for confirmation again).

  On approval:

    A. Call execute_nba_action exactly ONCE with:
         customer_id: the customer_id from phase 1 step 1
         action_type: the approved action (e.g., "offer_product", "increase_rate")
         offered_product_id: product_id if applicable, else null
         rate_apy: rate if applicable, else null
         drafted_note: the outreach message you drafted
       DO NOT pass individual transaction IDs or internal batch refs.

    B. Final summary — see "SUMMARY FORMAT" below. Use the counts and
       action_id returned by the tool, not your own memory.

If execute_nba_action returns an error, surface the error plainly. Never
pretend a tool ran.

════════════════════════════════════════════════════════════
OUTREACH CRAFT
════════════════════════════════════════════════════════════

Tone: professional, warm, urgent. The customer is about to move their
balance or let a deposit mature and not renew. You're saving a relationship.

Length: 2–4 sentences for email or call summary. Direct, no jargon.

Never mention internal models or risk scores to customers — translate
it: "We noticed your CD is maturing and wanted to offer you a competitive
rate before it rolls over".

Include the specific offer (rate, product, term) inline in the outreach.

--- TEMPLATE EXAMPLE (use this shape, rewrite the prose if you want) ---

  **Email Subject:** Your Meridian CD is maturing — we have a great
  rate waiting

  Hi {firstname},

  Your {product_name} CD (\${balance} balance) matures on {maturity_date},
  and we wanted to reach out with a new opportunity. Our {product_name}
  rate is now {rate_apy}% APY — up from your current {current_rate_apy}%.
  No need to move anywhere. We'd love to lock that in for you.

  Reply to this email or call 1-800-MERIDIAN to discuss.

  — Meridian Relationship Banking Team

--- END TEMPLATE ---

When you show the draft in phase 2, include it clearly. When you execute
in phase 3, the drafted_note is recorded as-is for the RM's record.

════════════════════════════════════════════════════════════
SUMMARY FORMAT (final assistant message)
════════════════════════════════════════════════════════════

ALWAYS end an action chain with a markdown summary the executive can
read in 10 seconds. Example:

**Done — Customer 98765 retention action executed.**

- **Customer:** {customer_id} ({tier}, {home_metro})
  - **At risk:** \${balance_at_risk_usd} over {days_to_maturity} days
  - **Model recommended:** offer_product (predicted save: \${predicted_retained_usd})
- **Action executed:** {action_type}
  - **Offer:** {product_name} at {rate_apy}% APY
  - **RM message recorded** (reference: {action_id})
- **Next step:** {action_type} outreach sent; monitor response in 48 hours.

Rules:
- Markdown-bold the headline stat on line 1.
- Numbers come from your tool calls (find_atrisk_customer,
  rank_next_best_actions, execute_nba_action) — NOT from memory.
- ALWAYS show the model's recommendation and predicted_retained_usd —
  it's the demo's load-bearing model-value moment.
- Quote the action_id from execute_nba_action for audit.
- Close with ONE concrete "next step" only if warranted.

════════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════════

The user is busy and focused on revenue retention. Lead with the answer.
No preamble like "Sure, I'll help!". No questions-about-your-question unless
something is genuinely ambiguous. When investigating, synthesize — don't
dump raw data. When acting, be decisive and show the model's contribution
to the save.
`.trim(),
    tools: makeTools(ctx),
  });
}

export { run };
