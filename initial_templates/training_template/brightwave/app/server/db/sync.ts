import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import {
  campaignPosition,
  openUnderperformers,
  actionRecommendations,
  creatives,
} from './schema.js';
import type { ActionOption } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — Brightwave Campaign Desk.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the four READ-ONLY Gold/raw mirrors:
 *   - campaign_position         (current campaign position + performance band)
 *   - open_underperformers      (underperforming campaigns + matching winners)
 *   - action_recommendations    (the ML model's ranked actions)
 *   - creatives                 (campaign creative catalog)
 *
 * `campaign_actions_app` is the app's own WRITABLE table — never synced, starts empty.
 *
 * The action_recommendations table is BUILT BY THE TRAINEE (the ML step of
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
    /** gold_campaign_position — one row per campaign with current position + perf band. */
    campaignPosition: string;
    /** gold_open_underperformers — underperforming campaigns + matching winners. */
    openUnderperformers: string;
    /** gold_action_recommendations — the ML model's ranked actions.
     *  Built by the trainee; sync tolerates it not existing yet. */
    actionRecommendations?: string;
    /** raw_creatives — campaign creative catalog. */
    creatives: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.campaign_position`,
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

  const fq = (name: 'campaignPosition' | 'openUnderperformers' | 'actionRecommendations' | 'creatives') =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  const hasActionTable = Boolean(cfg.tables.actionRecommendations);

  // Fire the queries in parallel (the slow part). The action-recommendations
  // query is BEST-EFFORT (the trainee may not have built that Gold table yet),
  // so run it defensively and swallow a TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [positionRows, underperformRows, creativesRows, actionRows] = await Promise.all([
    execSql<{
      campaign_id: string;
      campaign_name: string | null;
      channel: string | null;
      category: string | null;
      target_segment: string | null;
      creative_id: string | null;
      campaign_summary: string | null;
      status: string | null;
      roas: number | null;
      spend_to_date_usd: number | null;
      attributed_revenue_usd: number | null;
      perf_signal: string | null;
      recoverable_spend_usd: number | null;
      perf_band: string | null;
    }>(
      warehouseId,
      `SELECT campaign_id, campaign_name, channel, category, target_segment,
              creative_id, campaign_summary, status, roas, spend_to_date_usd,
              attributed_revenue_usd, perf_signal, recoverable_spend_usd, perf_band
       FROM ${fq('campaignPosition')}`,
    ),
    execSql<{
      campaign_id: string;
      channel: string | null;
      category: string | null;
      target_segment: string | null;
      roas: number | null;
      recoverable_spend_usd: number | null;
      spend_to_date_usd: number | null;
      has_matching_winner: boolean | null;
      matching_winner_campaign_id: string | null;
      matching_winner_roas: number | null;
      reallocate_target_campaign_id: string | null;
    }>(
      warehouseId,
      `SELECT campaign_id, channel, category, target_segment, roas,
              recoverable_spend_usd, spend_to_date_usd, has_matching_winner,
              matching_winner_campaign_id, matching_winner_roas, reallocate_target_campaign_id
       FROM ${fq('openUnderperformers')}`,
    ),
    execSql<{
      creative_id: string;
      creative_name: string | null;
      creative_type: string | null;
      angle: string | null;
      description: string | null;
      is_active: boolean | null;
    }>(
      warehouseId,
      `SELECT creative_id, creative_name, creative_type, angle, description, is_active
       FROM ${fq('creatives')}`,
    ),
    hasActionTable
      ? execSql<{
          campaign_id: string;
          recommended_action: string | null;
          predicted_roas_lift: number | null;
          predicted_net_value_usd: number | null;
          action_ranking: string | null;
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT campaign_id, recommended_action,
                  predicted_roas_lift, predicted_net_value_usd,
                  to_json(action_ranking) AS action_ranking, scored_at
           FROM ${fq('actionRecommendations')}`,
        ).catch((e) => {
          // The trainee builds this table in the ML step — until then it
          // won't exist. Degrade gracefully so the app still boots + the
          // Campaign Desk layer works; the agent's rank_actions tool is the
          // trainee's Build-2 task anyway.
          console.warn(
            `[sync] action_recommendations not available yet (this is the trainee's ML step) — leaving that mirror empty: ${(e as Error).message}`,
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
        .insert(campaignPosition)
        .values(
          chunk.map((r) => ({
            id: r.campaign_id,
            campaignId: r.campaign_id,
            campaignName: r.campaign_name,
            channel: r.channel,
            category: r.category,
            targetSegment: r.target_segment,
            creativeId: r.creative_id,
            campaignSummary: r.campaign_summary,
            status: r.status,
            roas: r.roas === null ? null : Number(r.roas),
            spendToDateUsd: r.spend_to_date_usd === null ? null : Number(r.spend_to_date_usd),
            attributedRevenueUsd:
              r.attributed_revenue_usd === null ? null : Number(r.attributed_revenue_usd),
            perfSignal: r.perf_signal,
            recoverableSpendUsd:
              r.recoverable_spend_usd === null ? null : Number(r.recoverable_spend_usd),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            perfBand: (r.perf_band === 'winner' ||
            r.perf_band === 'underperformer' ||
            r.perf_band === 'steady' ||
            r.perf_band === 'paused'
              ? r.perf_band
              : 'steady') as 'winner' | 'underperformer' | 'steady' | 'paused',
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   campaign positions: ${positionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (underperformRows.length) {
    await chunkInsert(underperformRows, 5_000, (chunk) =>
      db
        .insert(openUnderperformers)
        .values(
          chunk.map((r) => ({
            id: r.campaign_id,
            campaignId: r.campaign_id,
            channel: r.channel,
            category: r.category,
            targetSegment: r.target_segment,
            roas: r.roas === null ? null : Number(r.roas),
            recoverableSpendUsd:
              r.recoverable_spend_usd === null ? null : Number(r.recoverable_spend_usd),
            spendToDateUsd: r.spend_to_date_usd === null ? null : Number(r.spend_to_date_usd),
            hasMatchingWinner: r.has_matching_winner,
            matchingWinnerCampaignId: r.matching_winner_campaign_id,
            matchingWinnerRoas:
              r.matching_winner_roas === null ? null : Number(r.matching_winner_roas),
            reallocateTargetCampaignId: r.reallocate_target_campaign_id,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   underperformers: ${underperformRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (creativesRows.length) {
    await chunkInsert(creativesRows, 5_000, (chunk) =>
      db
        .insert(creatives)
        .values(
          chunk.map((r) => ({
            id: r.creative_id,
            creativeId: r.creative_id,
            creativeName: r.creative_name,
            creativeType: r.creative_type,
            angle: r.angle,
            description: r.description,
            isActive: r.is_active,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   creatives: ${creativesRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (actionRows.length) {
    await chunkInsert(actionRows, 5_000, (chunk) =>
      db
        .insert(actionRecommendations)
        .values(
          chunk.map((r) => ({
            id: r.campaign_id,
            campaignId: r.campaign_id,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            recommendedAction: (r.recommended_action === 'replicate_winner' ||
            r.recommended_action === 'reallocate_budget' ||
            r.recommended_action === 'pause'
              ? r.recommended_action
              : null) as
              | 'replicate_winner'
              | 'reallocate_budget'
              | 'pause'
              | null,
            predictedRoasLift:
              r.predicted_roas_lift === null ? null : Number(r.predicted_roas_lift),
            predictedNetValueUsd:
              r.predicted_net_value_usd === null ? null : Number(r.predicted_net_value_usd),
            actionRanking: parseActionRanking(r.action_ranking),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   action recommendations: ${actionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

/** `action_ranking` comes back as a JSON string (we `to_json(...)` it in SQL
 *  because the SQL Statements API serializes complex types as strings).
 *  Parse defensively — a malformed ranking just becomes []. */
function parseActionRanking(raw: string | null): ActionOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ActionOption[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reset: truncate the app's writable table + chat state, then re-sync the
 * read-only mirrors. All agent writes are wiped — campaigns return to their
 * original performance band state. Intentional: between presentations the
 * campaign desk should look untouched.
 */
export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.campaign_actions_app RESTART IDENTITY CASCADE`);
    // Read-only mirrors — re-pulled by syncFromDelta after this.
    await tx.execute(
      sql`TRUNCATE TABLE app.action_recommendations RESTART IDENTITY CASCADE`,
    );
    await tx.execute(
      sql`TRUNCATE TABLE app.open_underperformers RESTART IDENTITY CASCADE`,
    );
    await tx.execute(sql`TRUNCATE TABLE app.campaign_position RESTART IDENTITY CASCADE`);
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
