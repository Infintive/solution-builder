import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import {
  subscriberPosition,
  openAtrisk,
  retentionRecommendations,
  offers,
} from './schema.js';
import type { OfferOption } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — Streamline Telco Care Desk.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the four READ-ONLY Gold/raw mirrors:
 *   - subscriber_position       (current at-risk subscribers with geo + risk)
 *   - open_atrisk               (at-risk subscribers + candidate offers)
 *   - retention_recommendations (the ML model's ranked offers)
 *   - offers                    (retention offer catalog)
 *
 * `care_actions` is the app's own WRITABLE table — never synced, starts empty.
 *
 * The retention_recommendations table is BUILT BY THE TRAINEE (the ML step of
 * the workshop). So its query is fault-tolerant: if the table doesn't exist
 * yet, we log + leave the mirror empty rather than failing boot.
 *
 * Idempotent in the "only-if-destination-empty" sense — if the position
 * mirror has rows, we skip. Pass `{ forceIfAnyEmpty: true }` to re-sync
 * on demand (used by the "Reset demo" button).
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    /** gold_subscriber_position — one row per subscriber with current risk + geo. */
    subscriberPosition: string;
    /** gold_open_atrisk — at-risk subscribers + candidate offers. */
    openAtrisk: string;
    /** gold_retention_recommendations — the ML model's ranked offers.
     *  Built by the trainee; sync tolerates it not existing yet. */
    retentionRecommendations?: string;
    /** raw_offers — retention offer catalog. */
    offers: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.subscriber_position`,
  );
  const n = (exists.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (n > 0 && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (parallel)…');
  const t0 = Date.now();

  const fq = (name: 'subscriberPosition' | 'openAtrisk' | 'retentionRecommendations' | 'offers') =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  const hasRetentionTable = Boolean(cfg.tables.retentionRecommendations);

  // Fire the queries in parallel (the slow part). The retention-recommendations
  // query is BEST-EFFORT (the trainee may not have built that Gold table yet),
  // so run it defensively and swallow a TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [positionRows, atriskRows, offersRows, retentionRows] = await Promise.all([
    execSql<{
      subscriber_id: string;
      plan_type: string | null;
      tenure_months: number | null;
      monthly_arpu_usd: number | null;
      service_node_id: string | null;
      home_metro: string | null;
      sub_lat: number | null;
      sub_lng: number | null;
      service_summary: string | null;
      churn_risk_score: number | null;
      churn_reason: string | null;
      open_ticket_count: number | null;
      has_open_outage: boolean | null;
      has_open_billing: boolean | null;
      churn_signal_score: number | null;
      clv_at_risk_usd: number | null;
      risk_band: string | null;
    }>(
      warehouseId,
      `SELECT subscriber_id, plan_type, tenure_months, monthly_arpu_usd,
              service_node_id, home_metro, sub_lat, sub_lng, service_summary,
              churn_risk_score, churn_reason, open_ticket_count, has_open_outage,
              has_open_billing, churn_signal_score, clv_at_risk_usd, risk_band
       FROM ${fq('subscriberPosition')}`,
    ),
    execSql<{
      subscriber_id: string;
      plan_type: string | null;
      tenure_months: number | null;
      monthly_arpu_usd: number | null;
      home_metro: string | null;
      sub_lat: number | null;
      sub_lng: number | null;
      churn_risk_score: number | null;
      churn_reason: string | null;
      has_open_outage: boolean | null;
      has_open_billing: boolean | null;
      clv_at_risk_usd: number | null;
      candidate_offer_id: string | null;
    }>(
      warehouseId,
      `SELECT subscriber_id, plan_type, tenure_months, monthly_arpu_usd,
              home_metro, sub_lat, sub_lng, churn_risk_score, churn_reason,
              has_open_outage, has_open_billing, clv_at_risk_usd, candidate_offer_id
       FROM ${fq('openAtrisk')}`,
    ),
    execSql<{
      offer_id: string;
      offer_name: string | null;
      offer_type: string | null;
      value_usd: number | null;
      segment: string | null;
      description: string | null;
      is_active: boolean | null;
    }>(
      warehouseId,
      `SELECT offer_id, offer_name, offer_type, value_usd, segment,
              description, is_active
       FROM ${fq('offers')}`,
    ),
    hasRetentionTable
      ? execSql<{
          subscriber_id: string;
          recommended_offer: string | null;
          predicted_retained_clv_usd: number | null;
          predicted_net_value_usd: number | null;
          offer_ranking: string | null;
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT subscriber_id, recommended_offer,
                  predicted_retained_clv_usd, predicted_net_value_usd,
                  to_json(offer_ranking) AS offer_ranking, scored_at
           FROM ${fq('retentionRecommendations')}`,
        ).catch((e) => {
          // The trainee builds this table in the ML step — until then it
          // won't exist. Degrade gracefully so the app still boots + the
          // Care Desk layer works; the agent's rank_offers tool is the
          // trainee's Build-2 task anyway.
          console.warn(
            `[sync] retention_recommendations not available yet (this is the trainee's ML step) — leaving that mirror empty: ${(e as Error).message}`,
          );
          return [] as never[];
        })
      : Promise.resolve([] as never[]),
  ]);
  console.log(
    `[sync]   queries done (${((Date.now() - t0) / 1000).toFixed(1)}s) — inserting…`,
  );

  if (positionRows.length) {
    await chunkInsert(positionRows, 2_000, (chunk) =>
      db
        .insert(subscriberPosition)
        .values(
          chunk.map((r) => ({
            id: r.subscriber_id,
            subscriberId: r.subscriber_id,
            planType: r.plan_type,
            tenureMonths: r.tenure_months === null ? null : Number(r.tenure_months),
            monthlyArpuUsd:
              r.monthly_arpu_usd === null ? null : Number(r.monthly_arpu_usd),
            serviceNodeId: r.service_node_id,
            homeMetro: r.home_metro,
            subLat: r.sub_lat === null ? null : Number(r.sub_lat),
            subLng: r.sub_lng === null ? null : Number(r.sub_lng),
            serviceSummary: r.service_summary,
            churnRiskScore:
              r.churn_risk_score === null ? null : Number(r.churn_risk_score),
            churnReason: r.churn_reason,
            openTicketCount:
              r.open_ticket_count === null ? null : Number(r.open_ticket_count),
            hasOpenOutage: r.has_open_outage,
            hasOpenBilling: r.has_open_billing,
            churnSignalScore:
              r.churn_signal_score === null ? null : Number(r.churn_signal_score),
            clvAtRiskUsd:
              r.clv_at_risk_usd === null ? null : Number(r.clv_at_risk_usd),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            riskBand: (r.risk_band === 'critical' ||
            r.risk_band === 'elevated' ||
            r.risk_band === 'watch'
              ? r.risk_band
              : 'healthy') as 'critical' | 'elevated' | 'watch' | 'healthy',
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   subscriber positions: ${positionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (atriskRows.length) {
    await chunkInsert(atriskRows, 5_000, (chunk) =>
      db
        .insert(openAtrisk)
        .values(
          chunk.map((r) => ({
            id: `${r.subscriber_id}:${r.candidate_offer_id ?? 'unknown'}`,
            subscriberId: r.subscriber_id,
            planType: r.plan_type,
            tenureMonths: r.tenure_months === null ? null : Number(r.tenure_months),
            monthlyArpuUsd:
              r.monthly_arpu_usd === null ? null : Number(r.monthly_arpu_usd),
            homeMetro: r.home_metro,
            subLat: r.sub_lat === null ? null : Number(r.sub_lat),
            subLng: r.sub_lng === null ? null : Number(r.sub_lng),
            churnRiskScore:
              r.churn_risk_score === null ? null : Number(r.churn_risk_score),
            churnReason: r.churn_reason,
            hasOpenOutage: r.has_open_outage,
            hasOpenBilling: r.has_open_billing,
            clvAtRiskUsd:
              r.clv_at_risk_usd === null ? null : Number(r.clv_at_risk_usd),
            candidateOfferId: r.candidate_offer_id,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   at-risk subscribers: ${atriskRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (offersRows.length) {
    await chunkInsert(offersRows, 5_000, (chunk) =>
      db
        .insert(offers)
        .values(
          chunk.map((r) => ({
            id: r.offer_id,
            offerId: r.offer_id,
            offerName: r.offer_name,
            offerType: r.offer_type,
            valueUsd: r.value_usd === null ? null : Number(r.value_usd),
            segment: r.segment,
            description: r.description,
            isActive: r.is_active,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   offers: ${offersRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (retentionRows.length) {
    await chunkInsert(retentionRows, 5_000, (chunk) =>
      db
        .insert(retentionRecommendations)
        .values(
          chunk.map((r) => ({
            id: r.subscriber_id,
            subscriberId: r.subscriber_id,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            recommendedOffer: (r.recommended_offer === 'bill_credit' ||
            r.recommended_offer === 'plan_upgrade_discount' ||
            r.recommended_offer === 'device_upgrade'
              ? r.recommended_offer
              : null) as
              | 'bill_credit'
              | 'plan_upgrade_discount'
              | 'device_upgrade'
              | null,
            predictedRetainedClvUsd:
              r.predicted_retained_clv_usd === null
                ? null
                : Number(r.predicted_retained_clv_usd),
            predictedNetValueUsd:
              r.predicted_net_value_usd === null
                ? null
                : Number(r.predicted_net_value_usd),
            offerRanking: parseOfferRanking(r.offer_ranking),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   retention recommendations: ${retentionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

/** `offer_ranking` comes back as a JSON string (we `to_json(...)` it in SQL
 *  because the SQL Statements API serializes complex types as strings).
 *  Parse defensively — a malformed ranking just becomes []. */
function parseOfferRanking(raw: string | null): OfferOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OfferOption[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reset: truncate the app's writable table + chat state, then re-sync the
 * read-only mirrors. All agent writes are wiped — subscribers return to
 * at-risk state, CLV at-risk returns to full. Intentional: between
 * presentations the care queue should look untouched.
 */
export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.care_actions RESTART IDENTITY CASCADE`);
    // Read-only mirrors — re-pulled by syncFromDelta after this.
    await tx.execute(
      sql`TRUNCATE TABLE app.retention_recommendations RESTART IDENTITY CASCADE`,
    );
    await tx.execute(sql`TRUNCATE TABLE app.open_atrisk RESTART IDENTITY CASCADE`);
    await tx.execute(
      sql`TRUNCATE TABLE app.subscriber_position RESTART IDENTITY CASCADE`,
    );
  });
}

async function execSql<T>(
  warehouseId: string,
  statement: string,
): Promise<T[]> {
  const { client } = getExecutionContext();
  type StmtResp = {
    statement_id: string;
    status: { state: string; error?: { message: string } };
    manifest?: {
      schema: { columns: Array<{ name: string }> };
      chunks?: Array<{ chunk_index: number; row_count: number }>;
    };
    result?: {
      chunk_index: number;
      row_count: number;
      data_array?: Array<Array<unknown>>;
      next_chunk_index?: number;
    };
  };

  const initial = (await client.apiClient.request({
    method: 'POST',
    path: '/api/2.0/sql/statements',
    payload: {
      statement,
      warehouse_id: warehouseId,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    },
    headers: new Headers(),
    raw: false,
    query: {},
  })) as StmtResp;

  // Cap total polling at 10 minutes. The warehouse can take a couple of
  // minutes to spin from idle + scan, but a state stuck in RUNNING beyond
  // 10 min is broken — fail loud instead of silently blocking boot forever.
  const POLL_DEADLINE_MS = 10 * 60 * 1000;
  const startedAt = Date.now();

  let cur = initial;
  while (
    cur.status.state !== 'SUCCEEDED' &&
    cur.status.state !== 'FAILED' &&
    cur.status.state !== 'CANCELED'
  ) {
    if (Date.now() - startedAt > POLL_DEADLINE_MS) {
      throw new Error(
        `[sync] SQL still ${cur.status.state} after 10 minutes — aborting (statement_id=${cur.statement_id})`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
    cur = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp;
  }
  if (cur.status.state !== 'SUCCEEDED') {
    throw new Error(
      `[sync] SQL failed: ${cur.status.error?.message ?? cur.status.state}`,
    );
  }

  const cols = cur.manifest?.schema.columns.map((c) => c.name) ?? [];
  const rows: T[] = [];
  let chunk = cur.result;
  while (chunk) {
    for (const row of chunk.data_array ?? []) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      rows.push(obj as T);
    }
    if (chunk.next_chunk_index === undefined || chunk.next_chunk_index === null) break;
    chunk = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}/result/chunks/${chunk.next_chunk_index}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp['result'];
  }
  return rows;
}

async function chunkInsert<T>(
  rows: T[],
  size: number,
  fn: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}
