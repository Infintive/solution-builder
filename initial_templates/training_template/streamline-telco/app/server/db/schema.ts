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
 * Lakebase schema, under `app.*` — Streamline Telco Care Desk.
 *
 * Three groups (this is the Build-1 answer key: synced READ-ONLY mirrors +
 * ONE writable operational table):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Synced mirror   (subscriber_position, open_atrisk,
 *                      retention_recommendations, offers) — READ-ONLY copies
 *                      of the Gold/raw Delta tables that `db/sync.ts` pulls
 *                      at boot. In production these are Lakebase Synced Tables
 *                      (the manual sync is the demo stand-in). The app SELECTs
 *                      from them for sub-ms per-subscriber reads; never writes.
 *   3. Write-surface   `care_actions` — the ONLY table the app writes. A
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved care actions / offer
 *                      recommendations here. Append-only `audit_trail` JSONB
 *                      makes each action row a standalone timeline.
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
// Synced read-only mirrors (from Delta — Streamline Telco Gold tables)
//
// These mirror `gold_subscriber_position`, `gold_open_atrisk`,
// `gold_retention_recommendations`, and `raw_offers`. In Build-1 terms they're
// UC synced tables — read-only from the app. `db/sync.ts` pulls them at boot;
// the app SELECTs from them and never writes them.
// ============================================================================

// `gold_subscriber_position` — one row per subscriber. The Care Desk queue +
// map read this (filtered to at-risk subscribers). Includes current risk
// score, churn reason, ticket counts, and service history.
export const subscriberPosition = appSchema.table(
  'subscriber_position',
  {
    id: text('id').primaryKey(), // subscriber_id
    subscriberId: text('subscriber_id').notNull(),
    planType: text('plan_type'),
    tenureMonths: integer('tenure_months'),
    monthlyArpuUsd: doublePrecision('monthly_arpu_usd'),
    serviceNodeId: text('service_node_id'),
    homeMetro: text('home_metro'),
    // Coordinates — drive the Care Desk map. DOUBLE PRECISION.
    subLat: doublePrecision('sub_lat'),
    subLng: doublePrecision('sub_lng'),
    // Searchable service history (text indexed by Lakebase Search).
    serviceSummary: text('service_summary'),
    churnRiskScore: doublePrecision('churn_risk_score'),
    // service / price / device
    churnReason: text('churn_reason'),
    openTicketCount: integer('open_ticket_count'),
    hasOpenOutage: boolean('has_open_outage'),
    hasOpenBilling: boolean('has_open_billing'),
    churnSignalScore: doublePrecision('churn_signal_score'),
    clvAtRiskUsd: doublePrecision('clv_at_risk_usd'),
    // critical / elevated / watch / healthy
    riskBand: text('risk_band', {
      enum: ['critical', 'elevated', 'watch', 'healthy'],
    })
      .notNull()
      .default('healthy'),
  },
  (t) => [
    index('position_subscriber_idx').on(t.subscriberId),
    index('position_risk_band_idx').on(t.riskBand),
    index('position_node_idx').on(t.serviceNodeId),
  ],
);

// `gold_open_atrisk` — at-risk subscribers + candidate offers.
export const openAtrisk = appSchema.table(
  'open_atrisk',
  {
    id: text('id').primaryKey(), // ${subscriber_id}:${offer_id}
    subscriberId: text('subscriber_id').notNull(),
    planType: text('plan_type'),
    tenureMonths: integer('tenure_months'),
    monthlyArpuUsd: doublePrecision('monthly_arpu_usd'),
    homeMetro: text('home_metro'),
    subLat: doublePrecision('sub_lat'),
    subLng: doublePrecision('sub_lng'),
    churnRiskScore: doublePrecision('churn_risk_score'),
    churnReason: text('churn_reason'),
    hasOpenOutage: boolean('has_open_outage'),
    hasOpenBilling: boolean('has_open_billing'),
    clvAtRiskUsd: doublePrecision('clv_at_risk_usd'),
    candidateOfferId: text('candidate_offer_id'),
  },
  (t) => [index('atrisk_subscriber_idx').on(t.subscriberId)],
);

// Read-only mirror of the ML model's batch recommendations table
// (`{catalog}.{schema}.gold_retention_recommendations`, written by the
// notebook in spec `03-ml-churn.md`). The app never calls the model
// directly — the agent's `rank_offers` tool reads from this table to
// recommend the best retention move. Refreshed by sync.ts on first boot +
// on "Reset demo".
//
// NOTE: the trainee BUILDS this table (it's the ML step of the workshop),
// so sync.ts tolerates it not existing yet — the mirror is simply empty
// until they produce it.
export const retentionRecommendations = appSchema.table(
  'retention_recommendations',
  {
    id: text('id').primaryKey(), // subscriber_id
    subscriberId: text('subscriber_id').notNull(),
    recommendedOffer: text('recommended_offer', {
      enum: ['bill_credit', 'plan_upgrade_discount', 'device_upgrade'],
    }),
    predictedRetainedClvUsd: doublePrecision('predicted_retained_clv_usd'),
    predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
    // All three options with predicted retained $ + net $ + cost.
    offerRanking: jsonb('offer_ranking').$type<OfferOption[]>().notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('recommendations_subscriber_idx').on(t.subscriberId)],
);

// `raw_offers` — retention offer catalog (bill_credit, plan_upgrade_discount, device_upgrade).
// Searchable `description` is indexed by Lakebase Search for the `search_history` tool.
export const offers = appSchema.table(
  'offers',
  {
    id: text('id').primaryKey(), // offer_id
    offerId: text('offer_id').notNull(),
    offerName: text('offer_name'),
    // bill_credit / plan_upgrade_discount / device_upgrade
    offerType: text('offer_type'),
    valueUsd: doublePrecision('value_usd'),
    segment: text('segment'),
    // Searchable description (indexed by Lakebase Search).
    description: text('description'),
    isActive: boolean('is_active'),
  },
  (t) => [index('offers_type_idx').on(t.offerType)],
);

// ============================================================================
// Writable operational table (the app writes here — Build-1 writable table)
//
// `care_actions` is the ONLY table the app writes. An approved care action
// (offer recommendation + drafted summary) inserts a row here. The
// Care Desk queue derives a subscriber's live state by LEFT JOIN-ing
// `subscriber_position` → its latest `care_actions` row (so "offer applied"
// status comes from the writable table, and the read-only synced position
// is never mutated). The append-only `audit_trail` makes each row a
// standalone timeline for the drawer Activity tab.
// ============================================================================

export const careActions = appSchema.table(
  'care_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriberId: text('subscriber_id').notNull(),
    offerType: text('offer_type', {
      enum: ['bill_credit', 'plan_upgrade_discount', 'device_upgrade'],
    }).notNull(),
    offerId: text('offer_id'),
    // The retention offer summary the agent drafted.
    draftedSummary: text('drafted_summary'),
    predictedRetainedClvUsd: doublePrecision('predicted_retained_clv_usd'),
    status: text('status', {
      enum: ['proposed', 'approved', 'executed', 'declined'],
    })
      .notNull()
      .default('approved'),
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
    index('care_actions_subscriber_idx').on(t.subscriberId),
    index('care_actions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ML model's ranked offer list (on
 *  `retention_recommendations.offer_ranking`). */
export type OfferOption = {
  offerType: 'bill_credit' | 'plan_upgrade_discount' | 'device_upgrade';
  costUsd: number;
  predictedRetainedClvUsd: number;
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
    | 'note';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
