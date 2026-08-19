/**
 * Types that cross the client/server boundary. Keep in sync with
 * server/db/queries/segments.ts + server/db/queries/chat.ts.
 *
 * The app is small enough that hand-copying these is simpler than a
 * shared package. If this file grows past ~200 lines, consider a
 * proper shared lib.
 *
 * ─────────────────────────────────────────────────────────────────────
 * REPURPOSING THE TEMPLATE (single most important file to update)
 * ─────────────────────────────────────────────────────────────────────
 * This is the canonical schema for the *domain* — every page, fetch
 * helper, badge, and SQL projection uses what's defined here. When you
 * swap the data model:
 *
 *   1. Replace the entity types below (`SegmentRow`, `FeatureDecisionRow`,
 *      `ExperimentRow`, etc.) with the shape your demo cares about.
 *   2. Update the matching SQL/Drizzle queries in
 *      `server/db/queries/segments.ts` so `/api/...` endpoints return
 *      rows that match the new types. Rename the queries file too.
 *   3. Update the fetch helpers in `client/src/lib/segments.ts` (rename
 *      to match your domain — e.g. `lib/turbines.ts`).
 *   4. The string-enum types (`ConvBand`, `FeatureDecisionStatus`, action types,
 *      platform names, region names) drive badges in `shared/badges.tsx` — keep
 *      those two files aligned. Adding a new enum value means adding a
 *      matching color mapping in `badges.tsx`.
 *   5. The agent's tool argument schemas in
 *      `server/agent/growthdesk.ts` reference these types implicitly
 *      (the Zod schemas mirror field names).
 *      Update tool descriptions + Zod shapes when you swap entities.
 *
 * Search the codebase for each type name below to find all references
 * before renaming. There is no compile-time guarantee that SQL projects
 * the right columns — type-checking helps the client side, but the
 * server queries are stringly-typed against the warehouse.
 * ───────────────────────────────────────────────────────────────────── */

export type ConvBand = 'sliding' | 'watch' | 'healthy';
export type FeatureDecisionStatus = 'proposed' | 'approved' | 'shipped' | 'overridden';
export type ActionType = 'ship_proven_variant' | 'rollout_existing_flag' | 'ship_alt_variant';

export type SegmentRow = {
  id: string;
  segmentId: string;
  cohort: string | null;
  platform: string | null;
  region: string | null;
  mau: number | null;
  segmentSummary: string | null;
  conversionRate: number | null;
  conversionRate3wAgo: number | null;
  conversionDrop: number | null;
  sessions: number | null;
  slideSignalScore: number | null;
  conversionAtRiskUsd: number | null;
  convBand: ConvBand;
};

export type ExperimentRow = {
  id: string;
  experimentId: string;
  experimentName: string | null;
  variant: string | null;
  featureArea: string | null;
  testedCohort: string | null;
  testedPlatform: string | null;
  won: boolean | null;
  observedLift: number | null;
  description: string | null;
  isActive: boolean | null;
};

export type AuditEntry = {
  at: string;
  by: string;
  // Nimbus actions + the legacy template actions ('declined'/'rejected'/
  // 'escalated'/'email_sent') the unchanged operations/ views still switch on.
  // Trainees narrow this to their real action set when they rebuild the views.
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

export type FeatureDecisionRow = {
  id: string;
  segmentId: string;
  actionType: ActionType;
  targetExperimentId: string | null;
  flagKey: string | null;
  variant: string | null;
  rolloutPct: number | null;
  draftedNote: string | null;
  predictedConversionLift: number | null;
  status: FeatureDecisionStatus;
  approvedBy: string | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  decidedAt: string | null;
};

export type FeatureDecisionDetail = {
  decision_id: string;
  segment_id: string;
  action_type: ActionType;
  target_experiment_id: string | null;
  flag_key: string | null;
  variant: string | null;
  rollout_pct: number | null;
  drafted_note: string | null;
  predicted_conversion_lift: number | null;
  status: FeatureDecisionStatus;
  approved_by: string | null;
  audit_trail: AuditEntry[];
  created_at: string;
  decided_at: string | null;
};

export type SegmentSummary = {
  total_sliding: number;
  total_conversion_at_risk_usd: number;
  avg_conversion_rate: number;
};

// Nimbus domain activity (compatible with legacy audit events)
export type FeatureActivityEvent = {
  kind: 'audit';
  return_id: string; // Alias for segment_id — used by legacy views
  segment_id?: string;
  at: string;
  by: string;
  action: string;
  notes: string | null;
  tool: string | null;
};

// ═════════════════════════════════════════════════════════════════════
// Legacy template types — DO NOT REMOVE (unchanged views/ still reference these)
// ═════════════════════════════════════════════════════════════════════
// The unchanged operations/ and activity views compile against these.
// Keep the full set even if you don't use them — removing causes
// the views to 404 at build time. The trainee's rebuild can narrow it.
// ═════════════════════════════════════════════════════════════════════

export type ReturnStatus = 'pending' | 'approved' | 'rejected' | 'escalated';

export type ReturnRow = {
  id: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  loyaltyTier: string | null;
  finalTier: 'premium' | 'standard' | null;
  premiumStatusLabeled: 'premium' | 'not_premium' | null;
  premiumProb: number | null;
  angerScore: number | null;
  sku: string | null;
  productName: string | null;
  category: string | null;
  lot: string | null;
  returnReason: string | null;
  returnValueUsd: string;
  status: ReturnStatus;
  couponPctApplied: number | null;
  region: string | null;
  returnDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailEntry = {
  at: string;
  direction: 'outgoing' | 'incoming';
  from?: string;
  to?: string;
  subject: string;
  body: string;
};

export type ReturnDetail = {
  return_id: string;
  order_id: string | null;
  lot_id: string | null;
  facility: string | null;
  product_id: string | null;
  product_name: string | null;
  category: string | null;
  return_reason: string | null;
  return_reason_text: string | null;
  anger_score: number | null;
  refund_amount_usd: string;
  status: ReturnStatus;
  coupon_pct_applied: number | null;
  region: string | null;
  return_date: string | null;
  order_date: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  loyalty_tier: string | null;
  customer_region: string | null;
  customer_country: string | null;
  registration_date: string | null;
  order_total_usd: string | null;
  final_tier: 'premium' | 'standard' | null;
  premium_status_labeled: 'premium' | 'not_premium' | null;
  premium_prob: number | null;
  predicted_at: string | null;
  emails: EmailEntry[];
  ai_audit_trail: AuditEntry[];
};

export type ReturnsSummary = {
  status: ReturnStatus;
  n: number;
  total_usd: string;
};

export type CityBucket = {
  city: string;
  country: string;
  lat: number;
  lng: number;
  total: number;
  premium: number;
  refund_usd: number;
};

export type FacilityRow = {
  facility: string;
  return_count: number;
  pending_count: number;
  total_refund_usd: string;
};

export type FacilityLotRow = {
  lot_id: string;
  return_count: number;
  pending_count: number;
  total_refund_usd: string;
  product_count: number;
  product_names: string | null;
};

export type CustomerOrder = {
  order_id: string;
  order_date: string | null;
  total_usd: string;
  status: string | null;
  item_count: number;
};

// Legacy activity event types (for unchanged views to compile)
export type ActivityEventLegacy =
  | {
      kind: 'email';
      return_id: string;
      at: string;
      direction: 'outgoing' | 'incoming';
      from: string | null;
      to: string | null;
      subject: string;
      body: string;
    }
  | {
      kind: 'audit';
      return_id: string;
      at: string;
      by: string;
      action: string;
      notes: string | null;
      tool: string | null;
    };

export type ActivityEvent = FeatureActivityEvent | ActivityEventLegacy;
export type Decision = 'approved' | 'rejected' | 'escalated';
