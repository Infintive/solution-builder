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
 * Lakebase schema, under `app.*` — Nimbus Growth Desk.
 *
 * Three groups (this is the Build-1 answer key: synced READ-ONLY mirrors +
 * ONE writable operational table):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Synced mirror   (segment_position, open_sliding,
 *                      action_recommendations, experiments) — READ-ONLY copies
 *                      of the Gold/raw Delta tables that `db/sync.ts` pulls
 *                      at boot. In production these are Lakebase Synced Tables
 *                      (the manual sync is the demo stand-in). The app SELECTs
 *                      from them for sub-ms per-segment reads; never writes.
 *   3. Write-surface   `feature_decisions_app` — the ONLY table the app writes. A
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved decisions here. Append-only
 *                      `audit_trail` JSONB makes each decision row a standalone
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
// Synced read-only mirrors (from Delta — Nimbus Gold tables)
//
// These mirror `gold_segment_position`, `gold_open_sliding`,
// `gold_action_recommendations`, and `raw_experiments`. In Build-1 terms they're
// UC synced tables — read-only from the app. `db/sync.ts` pulls them at boot;
// the app SELECTs from them and never writes them.
// ============================================================================

// `gold_segment_position` — one row per segment. The Growth Desk reads
// this for live position + performance band data.
export const segmentPosition = appSchema.table(
  'segment_position',
  {
    id: text('id').primaryKey(), // segment_id
    segmentId: text('segment_id').notNull(),
    cohort: text('cohort'),
    platform: text('platform'),
    region: text('region'),
    mau: integer('mau'),
    segmentSummary: text('segment_summary'),
    conversionRate: doublePrecision('conversion_rate'),
    conversionRate3wAgo: doublePrecision('conversion_rate_3w_ago'),
    conversionDrop: doublePrecision('conversion_drop'),
    sessions: integer('sessions'),
    slideSignalScore: doublePrecision('slide_signal_score'),
    conversionAtRiskUsd: doublePrecision('conversion_at_risk_usd'),
    // sliding / watch / healthy
    convBand: text('conv_band', {
      enum: ['sliding', 'watch', 'healthy'],
    }),
  },
  (t) => [
    index('segment_position_band_idx').on(t.convBand),
    index('segment_position_id_idx').on(t.segmentId),
  ],
);

// `gold_open_sliding` — sliding segments + candidate experiments.
export const openSliding = appSchema.table(
  'open_sliding',
  {
    id: text('id').primaryKey(), // segment_id
    segmentId: text('segment_id').notNull(),
    cohort: text('cohort'),
    platform: text('platform'),
    mau: integer('mau'),
    conversionRate: doublePrecision('conversion_rate'),
    conversionDrop: doublePrecision('conversion_drop'),
    conversionAtRiskUsd: doublePrecision('conversion_at_risk_usd'),
    hasMatchingExperiment: boolean('has_matching_experiment'),
    matchingExperimentId: text('matching_experiment_id'),
    matchingExperimentLift: doublePrecision('matching_experiment_lift'),
    neighborFlagKey: text('neighbor_flag_key'),
  },
  (t) => [index('open_sliding_segment_idx').on(t.segmentId)],
);

// Read-only mirror of the ML model's batch recommendations table
// (`{catalog}.{schema}.gold_action_recommendations`, written by the
// notebook in spec `03-ml-conversion.md`). The app never calls the model
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
    id: text('id').primaryKey(), // segment_id
    segmentId: text('segment_id').notNull(),
    recommendedAction: text('recommended_action', {
      enum: ['ship_proven_variant', 'rollout_existing_flag', 'ship_alt_variant'],
    }),
    predictedConversionLift: doublePrecision('predicted_conversion_lift'),
    predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
    // All three options with predicted conversion lift + net value.
    actionRanking: jsonb('action_ranking').$type<ActionOption[]>().notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('recommendations_segment_idx').on(t.segmentId)],
);

// `raw_experiments` — experiment catalog (name + description).
// Searchable `description` is indexed by Lakebase Search for the `search_experiments` tool.
export const experiments = appSchema.table(
  'experiments',
  {
    id: text('id').primaryKey(), // experiment_id
    experimentId: text('experiment_id').notNull(),
    experimentName: text('experiment_name'),
    variant: text('variant'),
    featureArea: text('feature_area'),
    testedCohort: text('tested_cohort'),
    testedPlatform: text('tested_platform'),
    won: boolean('won'),
    observedLift: doublePrecision('observed_lift'),
    // Searchable description (indexed by Lakebase Search).
    description: text('description'),
    isActive: boolean('is_active'),
  },
  (t) => [index('experiments_name_idx').on(t.experimentName)],
);

// ============================================================================
// Writable operational table (the app writes here — Build-1 writable table)
//
// `feature_decisions_app` is the ONLY table the app writes. An approved feature
// decision (action + drafted note) inserts/updates a row here. The Growth Desk
// derives a segment's live state by LEFT JOIN-ing `segment_position` → its
// latest `feature_decisions_app` row (so "shipping" status comes from the
// writable table, and the read-only synced position is never mutated). The
// append-only `audit_trail` makes each row a standalone timeline for the drawer
// Activity tab.
// ============================================================================

export const featureDecisions = appSchema.table(
  'feature_decisions_app',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    segmentId: text('segment_id').notNull(),
    // ship_proven_variant / rollout_existing_flag / ship_alt_variant
    actionType: text('action_type', {
      enum: ['ship_proven_variant', 'rollout_existing_flag', 'ship_alt_variant'],
    }).notNull(),
    // The experiment matched or the alternative to ship (nullable — for rollout).
    targetExperimentId: text('target_experiment_id'),
    // The flag the agent decided to ship/rollout.
    flagKey: text('flag_key'),
    // The variant of the flag (e.g., 'v2', 'control').
    variant: text('variant'),
    // Rollout percentage (0–100, optional).
    rolloutPct: integer('rollout_pct'),
    // The rollout note the agent drafted.
    draftedNote: text('drafted_note'),
    predictedConversionLift: doublePrecision('predicted_conversion_lift'),
    // proposed / approved / shipped / overridden
    status: text('status', {
      enum: ['proposed', 'approved', 'shipped', 'overridden'],
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
    index('feature_decisions_segment_idx').on(t.segmentId),
    index('feature_decisions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ML model's ranked action list (on
 *  `action_recommendations.action_ranking`). */
export type ActionOption = {
  actionType: 'ship_proven_variant' | 'rollout_existing_flag' | 'ship_alt_variant';
  predictedConversionLift: number;
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
