import type { AppDb } from '../index.js';
import type {
  CustomerPositionRow,
  OpenAtriskRow,
  NbaRecommendationRow,
  ProductRow,
  RmActionRow,
  RmAuditEntry,
  ActionType,
  ActivityEvent,
} from '../../../client/src/shared/types.js';

/**
 * Queries for the Meridian Bank Relationship Desk app.
 * Stubs for the trainer — implement by reading from Lakebase tables.
 */

export async function listAtRiskCustomers(
  _db: AppDb,
): Promise<CustomerPositionRow[]> {
  throw new Error(
    'Not implemented — read from app.customer_position filtered to riskBand IN (critical, elevated, watch)',
  );
}

export async function getCustomerPosition(
  _db: AppDb,
  _customerId: string,
): Promise<CustomerPositionRow | null> {
  throw new Error(
    'Not implemented — read from app.customer_position WHERE customer_id = ?',
  );
}

export async function getOpenAtrisk(
  _db: AppDb,
  _customerId: string,
): Promise<OpenAtriskRow | null> {
  throw new Error(
    'Not implemented — read from app.open_atrisk WHERE customer_id = ?',
  );
}

export async function getNbaRecommendation(
  _db: AppDb,
  _customerId: string,
): Promise<NbaRecommendationRow | null> {
  throw new Error(
    'Not implemented — read from app.nba_recommendations WHERE customer_id = ?',
  );
}

export async function searchProducts(
  _db: AppDb,
  _query: string,
): Promise<ProductRow[]> {
  throw new Error(
    'Not implemented — search app.products using Lakebase Search hybrid text/vector over (product_name, description)',
  );
}

export async function createRmAction(
  _db: AppDb,
  _action: {
    customerId: string;
    actionType: ActionType;
    offeredProductId?: string;
    rateApy?: number;
    draftedNote?: string;
    predictedRetainedUsd?: number;
    approvedBy?: string;
  },
): Promise<RmActionRow> {
  throw new Error(
    'Not implemented — INSERT INTO app.rm_actions (...) VALUES (...)',
  );
}

export async function getRmAction(
  _db: AppDb,
  _actionId: string,
): Promise<RmActionRow | null> {
  throw new Error(
    'Not implemented — read from app.rm_actions WHERE id = ?',
  );
}

export async function listRmActions(
  _db: AppDb,
  _customerId: string,
): Promise<RmActionRow[]> {
  throw new Error(
    'Not implemented — read from app.rm_actions WHERE customer_id = ? ORDER BY created_at DESC',
  );
}

export async function updateRmActionStatus(
  _db: AppDb,
  _actionId: string,
  _status: 'proposed' | 'approved' | 'executed' | 'overridden',
  _auditEntry: RmAuditEntry,
): Promise<void> {
  throw new Error(
    'Not implemented — UPDATE app.rm_actions SET status = ?, audit_trail = array_append(audit_trail, ...) WHERE id = ?',
  );
}

export async function getRiskMetrics(_db: AppDb) {
  throw new Error(
    'Not implemented — aggregate SUM(balance_at_risk_usd), SUM(revenue_at_risk_usd), COUNT(*) WHERE risk_band IN (critical, elevated, watch)',
  );
}

export async function recentActivity(_db: AppDb, _limit: number): Promise<ActivityEvent[]> {
  throw new Error(
    'Not implemented — read from app.rm_actions with audit trail merged, ORDER BY created_at DESC LIMIT ?',
  );
}
