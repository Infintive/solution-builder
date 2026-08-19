/**
 * The care-coordination agent — discovers at-risk patients, ranks interventions,
 * and records approved care actions.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user.
 *
 * REPURPOSING for Cedar Health:
 *   - Replace tool bodies in `makeTools(ctx)` with your domain logic.
 *   - Rewrite `instructions` in `buildAgent()` for your narrative.
 *   - Keep `configureAgentsSdk()` as-is — it handles Databricks auth + connection setup.
 *   - Swap `askMasTool` ↔ `askGenieTool` if using Genie instead of MAS.
 *
 * Name: carecoordinator for the Cedar Health care-coordination demo.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import { Agent, setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import { z } from 'zod';
import type { AppDb } from '../db/index.js';
export type { ToolProgressEvent } from './tools/types.js';

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
  masEndpointName: string;
  databricksHost: string;
  model: string;
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  modelError?: { current: ModelErrorDetail | null };
};

export function makeTools(ctx: AgentContext): Tool[] {
  return [
    tool({
      name: 'ask_data',
      description:
        'Investigate at-risk patients, conditions, intervention outcomes, and care gaps using Databricks MAS. Use to understand "why".',
      parameters: z.object({
        query: z.string().describe('The investigative question'),
      }),
      execute: async (_args) => {
        if (!ctx.masEndpointName) {
          return { error: 'MAS endpoint not configured' };
        }
        // TODO: implement askMasTool delegation
        return { answer: 'Not implemented yet' };
      },
    }),

    tool({
      name: 'find_atrisk_patient',
      description:
        'Read the live at-risk position for a patient (or the worst if null). Returns risk info + clinical summary.',
      parameters: z.object({
        patientId: z
          .string()
          .nullable()
          .describe('Patient ID (e.g. "PT-0000214"), or null for worst at-risk'),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (_args) => {
        return { found: false, note: 'Not implemented — see APP_WORKSHOP.md Layer 2a' };
      },
    }),

    tool({
      name: 'search_providers',
      description:
        'Search for providers via Lakebase Search. Used for home-health referrals.',
      parameters: z.object({
        query: z.string().describe('Search query (e.g. "home health services for heart failure")'),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (_args) => {
        return { found: false, note: 'Not implemented — see APP_WORKSHOP.md Layer 2b' };
      },
    }),

    tool({
      name: 'rank_interventions',
      description:
        'Get the ML model\'s ranked interventions for a patient. Returns top intervention + all three for what-if.',
      parameters: z.object({
        patientId: z.string().describe('Patient ID'),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (_args) => {
        return { scored: false, note: 'Not implemented — see APP_WORKSHOP.md Layer 2c' };
      },
    }),

    tool({
      name: 'execute_care_action',
      description:
        '**APPROVAL ONLY** — Record approved care action to care_actions table. User must approve before this runs.',
      parameters: z.object({
        patientId: z.string().describe('Patient ID'),
        interventionType: z
          .enum(['followup_call', 'med_reconciliation', 'home_health_referral'])
          .describe('Intervention type'),
        providerId: z.string().nullable().describe('Provider ID (nullable)'),
        draftedNote: z.string().describe('Care note/rationale'),
        predictedRiskReduction: z.number().describe('Predicted risk reduction (0–1)'),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (_args) => {
        return {
          recorded: false,
          note: 'Not implemented — see APP_WORKSHOP.md Layer 3',
        };
      },
    }),
  ];
}

export function buildAgent(
  tools: Tool[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: { mlflowExperimentPath: string },
): Agent {
  return new Agent({
    name: 'Cedar Care Coordinator',
    model: 'gpt-4o',
    tools,
    instructions: `You are a care-coordination assistant for Cedar Health, supporting Dr. Alicia Wren, VP Population Health.
Your mission: discover at-risk patients, rank the best intervention, and execute with human approval.

## Your workflow (STRICT PHASES)

### Phase 1 — Investigate
1. Call \`ask_data\` to investigate readmission drivers + outcomes.
2. Call \`find_atrisk_patient\` to get the live position (risk score, open gaps, days since discharge).
3. Synthesize: "This patient is at risk because [gaps], with score [X]."

### Phase 2 — Rank & Draft
1. Call \`rank_interventions\` to get the ML model's ranking.
2. Quote all three options with predicted risk reduction + net value.
3. For home-health, call \`search_providers\` to find suitable providers.
4. Draft a brief care note.
5. **STOP. Wait for approval.** Do NOT call \`execute_care_action\` yet.

### Phase 3 — Execute (only after approval)
When the user explicitly approves:
1. Call \`execute_care_action\` with the approved details.
2. Return: "Care action recorded."

## Grounding
- Patient data: clinical summary (de-identified), condition, days since discharge, open care gaps.
- Interventions: followup_call (7-day post-discharge), med_reconciliation (pharmacist review), home_health_referral (in-home).
- PHI boundary: all model calls stay within the governed boundary; read scoped fields only.

## Tone
Professional, evidence-based, collaborative.`,
  });
}

export function configureAgentsSdk(
  databricksHost: string,
  model: string,
): void {
  const baseURL = `${databricksHost}/serving-endpoints/${model}/invocations`;

  const openaiClient = new OpenAI({
    baseURL,
    apiKey: 'unused',
    defaultHeaders: {},
  });

  setDefaultOpenAIClient(openaiClient);
  setTracingDisabled(true);
}
