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
// Delta mirror (Cedar Health domain)
// ============================================================================

// Read-only mirror of gold_patient_panel: the coordinator's patient queue,
// with current readmission risk + care gaps + geo.
export const patientPosition = appSchema.table('patient_position', {
  patientId: text('patient_id').primaryKey(),
  primaryCondition: text('primary_condition'),
  ageBand: text('age_band'),
  payer: text('payer'),
  homeMetro: text('home_metro'),
  patientLat: doublePrecision('patient_lat'),
  patientLng: doublePrecision('patient_lng'),
  clinicalSummary: text('clinical_summary'),
  daysSinceDischarge: integer('days_since_discharge'),
  readmissionRiskScore: doublePrecision('readmission_risk_score'),
  openGapCount: integer('open_gap_count'),
  hasOpenFollowup: boolean('has_open_followup'),
  hasOpenMedRecon: boolean('has_open_med_recon'),
  riskSignalScore: doublePrecision('risk_signal_score'),
  severityWeight: doublePrecision('severity_weight'),
  readmissionExposureUsd: doublePrecision('readmission_exposure_usd'),
  riskBand: text('risk_band', {
    enum: ['critical', 'elevated', 'watch', 'stable'],
  }),
});

// Read-only mirror of gold_open_atrisk: at-risk patients with intervention
// candidates + capacity context.
export const openAtrisk = appSchema.table('open_atrisk', {
  patientId: text('patient_id').primaryKey(),
  readmissionRiskScore: doublePrecision('readmission_risk_score'),
  readmissionExposureUsd: doublePrecision('readmission_exposure_usd'),
  daysSinceDischarge: integer('days_since_discharge'),
  hasOpenFollowup: boolean('has_open_followup'),
  hasOpenMedRecon: boolean('has_open_med_recon'),
  severityWeight: doublePrecision('severity_weight'),
  capacityHeadroomHours: doublePrecision('capacity_headroom_hours'),
  candidateProviderId: text('candidate_provider_id'),
});

// Read-only mirror of gold_intervention_recommendations: the ranked actions
// for an at-risk patient, including predicted risk reduction.
export const interventionRecommendations = appSchema.table(
  'intervention_recommendations',
  {
    patientId: text('patient_id').primaryKey(),
    recommendedIntervention: text('recommended_intervention', {
      enum: ['followup_call', 'med_reconciliation', 'home_health_referral'],
    }),
    recommendedProviderId: text('recommended_provider_id'),
    predictedRiskReduction: doublePrecision('predicted_risk_reduction'),
    predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
    // JSONB array of all three ranked options for what-if display
    interventionRanking: jsonb('intervention_ranking')
      .$type<InterventionOption[]>()
      .notNull()
      .default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('intervention_recommendations_idx').on(t.patientId)],
);

// Read-only mirror of raw_providers: the referral directory for home-health
// + other interventions. Indexed in Lakebase Search (description field).
export const providers = appSchema.table('providers', {
  providerId: text('provider_id').primaryKey(),
  providerName: text('provider_name'),
  specialty: text('specialty'),
  programType: text('program_type', {
    enum: ['home_health', 'pcp', 'cardiology', 'pulmonology'],
  }),
  description: text('description'),
  acceptingReferrals: boolean('accepting_referrals'),
});

// WRITABLE: the coordinator's care actions (approved by the app user).
export const careActions = appSchema.table(
  'care_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: text('patient_id').notNull(),
    interventionType: text('intervention_type', {
      enum: ['followup_call', 'med_reconciliation', 'home_health_referral'],
    }).notNull(),
    providerId: text('provider_id'),
    draftedNote: text('drafted_note'),
    predictedRiskReduction: doublePrecision('predicted_risk_reduction'),
    status: text('status', {
      enum: ['pending', 'approved', 'completed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    approvedBy: text('approved_by'),
    // Append-only audit trail. Each entry:
    //   { at, by, action, notes?, tool? }
    auditTrail: jsonb('audit_trail')
      .$type<AuditEntry[]>()
      .notNull()
      .default([]),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('care_actions_patient_idx').on(t.patientId),
    index('care_actions_status_idx').on(t.status, t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

export type InterventionOption = {
  intervention: 'followup_call' | 'med_reconciliation' | 'home_health_referral';
  units?: number;
  predictedRiskReduction: number;
  predictedNetValueUsd: number;
  providerId?: string;
};

export type AuditEntry = {
  at: string;
  by: string;
  action: 'approved' | 'assigned' | 'completed' | 'cancelled' | 'note';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
