import {
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  pgSchema,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Lakebase schema, under `app.*` — Brightwave Campaign Desk.
 *
 * Three groups (this is the Build-1 answer key: synced READ-ONLY mirrors +
 * ONE writable operational table):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Synced mirror   (campaign_position, open_underperformers,
 *                      action_recommendations, creatives) — READ-ONLY copies
 *                      of the Gold/raw Delta tables that `db/sync.ts` pulls
 *                      at boot. In production these are Lakebase Synced Tables
 *                      (the manual sync is the demo stand-in). The app SELECTs
 *                      from them for sub-ms per-campaign reads; never writes.
 *   3. Write-surface   `campaign_actions_app` — the ONLY table the app writes. A
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved actions here. Append-only
 *                      `audit_trail` JSONB makes each action row a standalone
 *                      timeline the drawer Activity tab renders.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the app do real
 * transactional writes while the analytics layer still queries Delta.
 */
export const appSchema = pgSchema('app');

// ============================================================================
// Chat state
// ============================================================================

export const conversations = appSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userEmail: text('user_email').notNull(),
    title: text('title').notNull(),
    // 'default' for regular chats, 'demo_dock' for the floating dock's
    // persistent conversation (one per user).
    kind: text('kind', { enum: ['default', 'demo_dock'] })
      .notNull()
      .default('default'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userEmail, t.updatedAt),
    index('conversations_kind_idx').on(t.userEmail, t.kind),
  ],
);

export const messages = appSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull(),
    traceId: text('trace_id'),
    // Captured reasoning steps (tool calls, outputs, intermediate messages)
    // for assistant messages. Shape matches client's ThinkingEvent union.
    thinking: jsonb('thinking').$type<ThinkingEntry[]>().notNull().default([]),
    // If the agent run failed, the error message is persisted here so a
    // page reload still shows what went wrong (instead of an empty bubble).
    error: text('error'),
    // True when the turn was stopped by the user (Stop button or page
    // navigation away from an in-flight stream). The assistant's partial
    // streamed content is still kept in `content` for context; the UI
    // renders a "Canceled by the user" banner below it.
    canceled: boolean('canceled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Unique on (conversation_id, position) so the `SELECT MAX + 1` race in
    // appendMessage surfaces as a constraint error (caller retries) instead
    // of silently inserting two messages at the same position — which
    // would break the on-reload ordering. Doubles as the lookup index.
    uniqueIndex('messages_convo_pos_uq').on(t.conversationId, t.position),
  ],
);

export const feedback = appSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    value: text('value', { enum: ['up', 'down'] }).notNull(),
    rationale: text('rationale'),
    traceId: text('trace_id'),
    mlflowAssessmentId: text('mlflow_assessment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feedback_message_idx').on(t.messageId)],
);

// ============================================================================
// Synced read-only mirrors (from Delta — Brightwave Gold tables)
//
// These mirror `gold_campaign_position`, `gold_open_underperformers`,
// `gold_action_recommendations`, and `raw_creatives`. In Build-1 terms they're
// UC synced tables — read-only from the app. `db/sync.ts` pulls them at boot;
// the app SELECTs from them and never writes them.
// ============================================================================

// `gold_campaign_position` — one row per campaign. The Campaign Desk reads
// this for live position + performance band data.
export const campaignPosition = appSchema.table(
  'campaign_position',
  {
    id: text('id').primaryKey(), // campaign_id
    campaignId: text('campaign_id').notNull(),
    campaignName: text('campaign_name'),
    channel: text('channel'),
    category: text('category'),
    targetSegment: text('target_segment'),
    creativeId: text('creative_id'),
    campaignSummary: text('campaign_summary'),
    status: text('status'),
    roas: doublePrecision('roas'),
    spendToDateUsd: doublePrecision('spend_to_date_usd'),
    attributedRevenueUsd: doublePrecision('attributed_revenue_usd'),
    perfSignal: text('perf_signal'),
    recoverableSpendUsd: doublePrecision('recoverable_spend_usd'),
    // winner / underperformer / steady / paused
    perfBand: text('perf_band', {
      enum: ['winner', 'underperformer', 'steady', 'paused'],
    }),
  },
  (t) => [
    index('campaign_position_band_idx').on(t.perfBand),
    index('campaign_position_id_idx').on(t.campaignId),
  ],
);

// `gold_open_underperformers` — underperformers + candidate winners.
export const openUnderperformers = appSchema.table(
  'open_underperformers',
  {
    id: text('id').primaryKey(), // campaign_id
    campaignId: text('campaign_id').notNull(),
    channel: text('channel'),
    category: text('category'),
    targetSegment: text('target_segment'),
    roas: doublePrecision('roas'),
    recoverableSpendUsd: doublePrecision('recoverable_spend_usd'),
    spendToDateUsd: doublePrecision('spend_to_date_usd'),
    hasMatchingWinner: boolean('has_matching_winner'),
    matchingWinnerCampaignId: text('matching_winner_campaign_id'),
    matchingWinnerRoas: doublePrecision('matching_winner_roas'),
    reallocateTargetCampaignId: text('reallocate_target_campaign_id'),
  },
  (t) => [index('open_underperformers_campaign_idx').on(t.campaignId)],
);

// Read-only mirror of the ML model's batch recommendations table
// (`{catalog}.{schema}.gold_action_recommendations`, written by the
// notebook in spec `03-ml-roas.md`). The app never calls the model
// directly — the agent's `rank_actions` tool reads from this table to
// recommend the best action. Refreshed by sync.ts on first boot +
// on "Reset demo".
//
// NOTE: the trainee BUILDS this table (it's the ML step of the workshop),
// so sync.ts tolerates it not existing yet — the mirror is simply empty
// until they produce it.
export const actionRecommendations = appSchema.table(
  'action_recommendations',
  {
    id: text('id').primaryKey(), // campaign_id
    campaignId: text('campaign_id').notNull(),
    recommendedAction: text('recommended_action', {
      enum: ['replicate_winner', 'reallocate_budget', 'pause'],
    }),
    predictedRoasLift: doublePrecision('predicted_roas_lift'),
    predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
    // All three options with predicted ROAS lift + net value.
    actionRanking: jsonb('action_ranking').$type<ActionOption[]>().notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('recommendations_campaign_idx').on(t.campaignId)],
);

// `raw_creatives` — campaign creative catalog (name + description).
// Searchable `description` is indexed by Lakebase Search for the `search_creatives` tool.
export const creatives = appSchema.table(
  'creatives',
  {
    id: text('id').primaryKey(), // creative_id
    creativeId: text('creative_id').notNull(),
    creativeName: text('creative_name'),
    creativeType: text('creative_type'),
    angle: text('angle'),
    // Searchable description (indexed by Lakebase Search).
    description: text('description'),
    isActive: boolean('is_active'),
  },
  (t) => [index('creatives_type_idx').on(t.creativeType)],
);

// ============================================================================
// Writable operational table (the app writes here — Build-1 writable table)
//
// `campaign_actions_app` is the ONLY table the app writes. An approved campaign
// action (action + drafted brief) inserts/updates a row here. The Campaign Desk
// derives a campaign's live state by LEFT JOIN-ing `campaign_position` → its
// latest `campaign_actions_app` row (so "action taken" status comes from the
// writable table, and the read-only synced position is never mutated). The
// append-only `audit_trail` makes each row a standalone timeline for the drawer
// Activity tab.
// ============================================================================

export const campaignActions = appSchema.table(
  'campaign_actions_app',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: text('campaign_id').notNull(),
    // replicate_winner / reallocate_budget / pause
    actionType: text('action_type', {
      enum: ['replicate_winner', 'reallocate_budget', 'pause'],
    }).notNull(),
    // The winner replicated or the reallocation target (nullable — for pause).
    targetCampaignId: text('target_campaign_id'),
    // The campaign brief the agent drafted.
    draftedBrief: text('drafted_brief'),
    predictedRoasLift: doublePrecision('predicted_roas_lift'),
    // proposed / approved / executed / overridden
    status: text('status', {
      enum: ['proposed', 'approved', 'executed', 'overridden'],
    })
      .notNull()
      .default('proposed'),
    // OBO-stamped viewing user's email.
    approvedBy: text('approved_by'),
    // Append-only audit trail. Each entry: { at, by, action, notes?, tool? }
    auditTrail: jsonb('audit_trail').$type<AuditEntry[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('campaign_actions_campaign_idx').on(t.campaignId),
    index('campaign_actions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ML model's ranked action list (on
 *  `action_recommendations.action_ranking`). */
export type ActionOption = {
  actionType: 'replicate_winner' | 'reallocate_budget' | 'pause';
  predictedRoasLift: number;
  predictedNetValueUsd: number;
};

export type AuditEntry = {
  at: string;
  by: string;
  action:
    | 'proposed'
    | 'approved'
    | 'executed'
    | 'declined'
    | 'note'
    | 'rejected'
    | 'escalated'
    | 'email_sent';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
