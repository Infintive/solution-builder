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
 * Lakebase schema, under `app.*`.
 *
 * Template shape — three groups:
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Delta mirror    (customers, orders, returns) — REPLACE for your
 *                      use case. These are the OLTP-friendly copies of
 *                      lakehouse Delta tables that `db/sync.ts` pulls at
 *                      boot. Rename + reshape for your domain.
 *   3. Write-surface   Domain-specific JSONB on the operations row. Here,
 *                      `returns.emails` + `returns.ai_audit_trail` are
 *                      append-only logs the agent writes through. This
 *                      denormalized shape (vs. side tables) makes it easy
 *                      to render a full "what happened to this record"
 *                      timeline without joins. Mirror this pattern on
 *                      whatever your primary operations entity is.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the agent do real
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
// Delta mirror (Meridian — synced read-only)
// ============================================================================

// Synced read-only: customer position + risk bands
export const customerPosition = appSchema.table('customer_position', {
  customerId: text('customer_id').primaryKey(),
  tier: text('tier', {
    enum: ['mass', 'mass_affluent', 'affluent', 'private'],
  }).notNull(),
  tenureYears: integer('tenure_years'),
  homeMetro: text('home_metro'),
  // Map-drive coords (for the scatter / geo visualization)
  customerLat: doublePrecision('customer_lat'),
  customerLng: doublePrecision('customer_lng'),
  profileSummary: text('profile_summary'),
  attritionRiskScore: doublePrecision('attrition_risk_score'),
  balanceOutflow30dUsd: doublePrecision('balance_outflow_30d_usd'),
  churnSignalScore: doublePrecision('churn_signal_score'),
  totalBalanceUsd: doublePrecision('total_balance_usd'),
  depositBalanceUsd: doublePrecision('deposit_balance_usd'),
  affectedDepositBalanceUsd: doublePrecision('affected_deposit_balance_usd'),
  minDaysToMaturity: integer('min_days_to_maturity'),
  productCount: integer('product_count'),
  balanceAtRiskUsd: doublePrecision('balance_at_risk_usd'),
  revenueAtRiskUsd: doublePrecision('revenue_at_risk_usd'),
  riskBand: text('risk_band', {
    enum: ['critical', 'elevated', 'watch', 'healthy'],
  }).notNull(),
});

// Synced read-only: open at-risk details
export const openAtrisk = appSchema.table('open_atrisk', {
  customerId: text('customer_id').primaryKey(),
  attritionRiskScore: doublePrecision('attrition_risk_score'),
  balanceAtRiskUsd: doublePrecision('balance_at_risk_usd'),
  revenueAtRiskUsd: doublePrecision('revenue_at_risk_usd'),
  atriskProductId: text('atrisk_product_id'),
  atriskBalanceUsd: doublePrecision('atrisk_balance_usd'),
  daysToMaturity: integer('days_to_maturity'),
  currentRateApy: doublePrecision('current_rate_apy'),
  candidateCrossSellProductId: text('candidate_cross_sell_product_id'),
});

// Synced read-only: NBA recommendations (from the SDP pipeline heuristic or ML model)
export const nbaRecommendations = appSchema.table('nba_recommendations', {
  customerId: text('customer_id').primaryKey(),
  recommendedAction: text('recommended_action', {
    enum: ['retention_offer', 'cross_sell', 'rm_outreach'],
  }).notNull(),
  recommendedOfferProductId: text('recommended_offer_product_id'),
  recommendedRateApy: doublePrecision('recommended_rate_apy'),
  predictedRetainedUsd: doublePrecision('predicted_retained_usd'),
  predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
  // JSONB array of all three options with predicted retained $ + net $ + cost
  actionRanking: jsonb('action_ranking')
    .$type<ActionRankingEntry[]>()
    .notNull()
    .default([]),
  scoredAt: timestamp('scored_at', { withTimezone: true }),
});

// Synced read-only: product catalog
export const products = appSchema.table('products', {
  productId: text('product_id').primaryKey(),
  productName: text('product_name').notNull(),
  productType: text('product_type'),
  segment: text('segment'),
  rateApy: doublePrecision('rate_apy'),
  minBalanceUsd: doublePrecision('min_balance_usd'),
  description: text('description'),
  isActive: boolean('is_active'),
});

// ============================================================================
// Writable operational table (Meridian)
// ============================================================================

// The only writable table — app records approved actions here
export const rmActions = appSchema.table('rm_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: text('customer_id').notNull(),
  actionType: text('action_type', {
    enum: ['retention_offer', 'cross_sell', 'rm_outreach'],
  }).notNull(),
  offeredProductId: text('offered_product_id'),
  rateApy: doublePrecision('rate_apy'),
  draftedNote: text('drafted_note'),
  predictedRetainedUsd: doublePrecision('predicted_retained_usd'),
  status: text('status', {
    enum: ['proposed', 'approved', 'executed', 'overridden'],
  })
    .notNull()
    .default('proposed'),
  approvedBy: text('approved_by'),
  // Append-only audit trail: { at, by, action, notes? }
  auditTrail: jsonb('audit_trail')
    .$type<RmAuditEntry[]>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

export type ActionRankingEntry = {
  actionType: 'retention_offer' | 'cross_sell' | 'rm_outreach';
  predictedRetainedUsd?: number;
  predictedNetValueUsd?: number;
  costUsd?: number;
  offeredProductId?: string;
  rateApy?: number;
};

export type RmAuditEntry = {
  at: string;
  by: string;
  action: string;
  notes?: string;
};

// ============================================================================
// JSONB entry shapes
// ============================================================================

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
