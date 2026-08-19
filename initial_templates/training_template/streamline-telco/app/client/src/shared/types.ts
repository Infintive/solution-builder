/**
 * Types that cross the client/server boundary. Keep in sync with
 * server/db/queries/subscribers.ts + server/db/queries/chat.ts.
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
 *   1. Replace the entity types below (`SubscriberRow`, `CareActionRow`,
 *      `OfferRow`, etc.) with the shape your demo cares about.
 *   2. Update the matching SQL/Drizzle queries in
 *      `server/db/queries/subscribers.ts` so `/api/...` endpoints return
 *      rows that match the new types. Rename the queries file too.
 *   3. Update the fetch helpers in `client/src/lib/subscribers.ts` (rename
 *      to match your domain — e.g. `lib/turbines.ts`).
 *   4. The string-enum types (`CareActionStatus`, `RiskBand`, etc.)
 *      drive badges in `shared/badges.tsx` — keep those two files aligned.
 *      Adding a new enum value means adding a matching color mapping
 *      in `badges.tsx`.
 *   5. The agent's tool argument schemas in `server/agent/caredesk.ts`
 *      reference these types implicitly (the Zod schemas mirror field names).
 *      Update tool descriptions + Zod shapes when you swap entities.
 *
 * Search the codebase for each type name below to find all references
 * before renaming. There is no compile-time guarantee that SQL projects
 * the right columns — type-checking helps the client side, but the
 * server queries are stringly-typed against the warehouse.
 * ───────────────────────────────────────────────────────────────────── */

export type RiskBand = 'critical' | 'elevated' | 'watch' | 'healthy';
export type ChurnReason = 'service' | 'price' | 'device';
export type OfferType = 'bill_credit' | 'plan_upgrade_discount' | 'device_upgrade';
export type CareActionStatus = 'proposed' | 'approved' | 'executed' | 'declined';

export type SubscriberRow = {
  id: string;
  subscriberId: string;
  planType: string | null;
  tenureMonths: number | null;
  monthlyArpuUsd: number | null;
  serviceNodeId: string | null;
  homeMetro: string | null;
  subLat: number | null;
  subLng: number | null;
  /** Searchable service history (text indexed by Lakebase Search). */
  serviceSummary: string | null;
  churnRiskScore: number | null;
  churnReason: ChurnReason | null;
  openTicketCount: number | null;
  hasOpenOutage: boolean | null;
  hasOpenBilling: boolean | null;
  churnSignalScore: number | null;
  clvAtRiskUsd: number | null;
  riskBand: RiskBand;
};

export type OfferRow = {
  id: string;
  offerId: string;
  offerName: string | null;
  offerType: OfferType | null;
  valueUsd: number | null;
  segment: string | null;
  description: string | null;
  isActive: boolean | null;
};

export type AuditEntry = {
  at: string;
  by: string;
  // Streamline actions + the legacy template actions ('rejected'/'escalated'/
  // 'email_sent') the unchanged operations/ views still switch on. Trainees
  // narrow this to their real action set when they rebuild the views.
  action: 'proposed' | 'approved' | 'executed' | 'declined' | 'note' | 'rejected' | 'escalated' | 'email_sent';
  notes?: string;
  tool?: string;
};

export type CareActionRow = {
  id: string;
  subscriberId: string;
  offerType: OfferType;
  offerId: string | null;
  draftedSummary: string | null;
  predictedRetainedClvUsd: number | null;
  status: CareActionStatus;
  approvedBy: string | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  decidedAt: string | null;
};

export type CareActionDetail = {
  action_id: string;
  subscriber_id: string;
  offer_type: OfferType;
  offer_id: string | null;
  drafted_summary: string | null;
  predicted_retained_clv_usd: number | null;
  status: CareActionStatus;
  approved_by: string | null;
  audit_trail: AuditEntry[];
  created_at: string;
  decided_at: string | null;
};

export type SubscriberSummary = {
  total_at_risk: number;
  total_critical: number;
  total_elevated: number;
  total_clv_at_risk_usd: number;
  avg_churn_risk_score: number;
};


// ── Legacy template types (LuxeBeauty returns) — kept so the unchanged
// client operations/ views still compile. Trainees rebuild those views for
// the Streamline Care Desk (subscriber queue + retention drawer); until then
// these keep tsc green. Safe to delete once the views are rekeyed.
export type ReturnStatus = 'pending' | 'approved' | 'rejected' | 'escalated';
export type Decision = 'approved' | 'rejected' | 'escalated';

export type ReturnRow = {
  id: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  loyaltyTier: string | null;
  /** Premium tier from the ML model's predictions mirror. `null` when
   * no prediction exists (or when the demo doesn't have an ML model). */
  finalTier: 'premium' | 'standard' | null;
  /** Original CS hand-tag (pass-through). `null` = "never reviewed by
   * CS"; combined with `finalTier='premium'` this means the model
   * surfaced a hidden premium — the demo's load-bearing story beat. */
  premiumStatusLabeled: 'premium' | 'not_premium' | null;
  /** Raw model output, 0.0–1.0. `null` when no prediction exists. */
  premiumProb: number | null;
  /** Per-return anger score from `ai_classify(return_reason_text)` in SDP.
   * 0=benign, 0.5=neutral, 1=angry. Drives the Operations queue's
   * default sort so the most upset customers float to the top. */
  angerScore: number | null;
  sku: string | null;
  productName: string | null;
  category: string | null;
  lot: string | null;
  returnReason: string | null;
  returnValueUsd: string;
  status: ReturnStatus;
  /** Percent-off coupon the agent's bulk tool applied to this row,
   * picked by tier (20 for 'premium', 5 for 'standard'). `null` until
   * the bulk tool has run. */
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

/** Per-city aggregation for the Operations bubble map. One row per
 *  (city, country) with averaged customer_lat / customer_lng. The map
 *  plots a circle at (lat, lng), sized by `total`, colored by the
 *  premium share. */
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

export type ActivityEvent =
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
