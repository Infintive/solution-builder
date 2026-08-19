import { sql } from 'drizzle-orm';
import type { AppDb } from './index.js';
import {
  segmentPosition,
  openSliding,
  actionRecommendations,
  experiments,
} from './schema.js';
import type { ActionOption } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — Nimbus Growth Desk.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the four READ-ONLY Gold/raw mirrors:
 *   - segment_position          (current segment position + conversion band)
 *   - open_sliding              (sliding segments + matching experiments)
 *   - action_recommendations    (the ML model's ranked actions)
 *   - experiments               (experiment catalog)
 *
 * `feature_decisions_app` is the app's own WRITABLE table — never synced, starts empty.
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
    /** gold_segment_position — one row per segment with current position + conv band. */
    segmentPosition: string;
    /** gold_open_sliding — sliding segments + matching experiments. */
    openSliding: string;
    /** gold_action_recommendations — the ML model's ranked actions.
     *  Built by the trainee; sync tolerates it not existing yet. */
    actionRecommendations?: string;
    /** raw_experiments — experiment catalog. */
    experiments: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.segment_position`,
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

  const fq = (name: 'segmentPosition' | 'openSliding' | 'actionRecommendations' | 'experiments') =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  const hasActionTable = Boolean(cfg.tables.actionRecommendations);

  // Fire the queries in parallel (the slow part). The action-recommendations
  // query is BEST-EFFORT (the trainee may not have built that Gold table yet),
  // so run it defensively and swallow a TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [positionRows, slidingRows, experimentsRows, actionRows] = await Promise.all([
    execSql<{
      segment_id: string;
      cohort: string | null;
      platform: string | null;
      region: string | null;
      mau: number | null;
      segment_summary: string | null;
      conversion_rate: number | null;
      conversion_rate_3w_ago: number | null;
      conversion_drop: number | null;
      sessions: number | null;
      slide_signal_score: number | null;
      conversion_at_risk_usd: number | null;
      conv_band: string | null;
    }>(
      warehouseId,
      `SELECT segment_id, cohort, platform, region, mau, segment_summary,
              conversion_rate, conversion_rate_3w_ago, conversion_drop, sessions,
              slide_signal_score, conversion_at_risk_usd, conv_band
       FROM ${fq('segmentPosition')}`,
    ),
    execSql<{
      segment_id: string;
      cohort: string | null;
      platform: string | null;
      mau: number | null;
      conversion_rate: number | null;
      conversion_drop: number | null;
      conversion_at_risk_usd: number | null;
      has_matching_experiment: boolean | null;
      matching_experiment_id: string | null;
      matching_experiment_lift: number | null;
      neighbor_flag_key: string | null;
    }>(
      warehouseId,
      `SELECT segment_id, cohort, platform, mau, conversion_rate,
              conversion_drop, conversion_at_risk_usd, has_matching_experiment,
              matching_experiment_id, matching_experiment_lift, neighbor_flag_key
       FROM ${fq('openSliding')}`,
    ),
    execSql<{
      experiment_id: string;
      experiment_name: string | null;
      variant: string | null;
      feature_area: string | null;
      tested_cohort: string | null;
      tested_platform: string | null;
      won: boolean | null;
      observed_lift: number | null;
      description: string | null;
      is_active: boolean | null;
    }>(
      warehouseId,
      `SELECT experiment_id, experiment_name, variant, feature_area, tested_cohort,
              tested_platform, won, observed_lift, description, is_active
       FROM ${fq('experiments')}`,
    ),
    hasActionTable
      ? execSql<{
          segment_id: string;
          recommended_action: string | null;
          predicted_conversion_lift: number | null;
          predicted_net_value_usd: number | null;
          action_ranking: string | null;
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT segment_id, recommended_action,
                  predicted_conversion_lift, predicted_net_value_usd,
                  to_json(action_ranking) AS action_ranking, scored_at
           FROM ${fq('actionRecommendations')}`,
        ).catch((e) => {
          // The trainee builds this table in the ML step — until then it
          // won't exist. Degrade gracefully so the app still boots + the
          // Growth Desk layer works; the agent's rank_actions tool is the
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
    await chunkInsert(positionRows, 2_000, async (chunk) =>
      void (await db
        .insert(segmentPosition)
        .values(
          chunk.map((r) => ({
            id: r.segment_id,
            segmentId: r.segment_id,
            cohort: r.cohort,
            platform: r.platform,
            region: r.region,
            mau: r.mau === null ? null : Number(r.mau),
            segmentSummary: r.segment_summary,
            conversionRate: r.conversion_rate === null ? null : Number(r.conversion_rate),
            conversionRate3wAgo:
              r.conversion_rate_3w_ago === null ? null : Number(r.conversion_rate_3w_ago),
            conversionDrop: r.conversion_drop === null ? null : Number(r.conversion_drop),
            sessions: r.sessions === null ? null : Number(r.sessions),
            slideSignalScore: r.slide_signal_score === null ? null : Number(r.slide_signal_score),
            conversionAtRiskUsd:
              r.conversion_at_risk_usd === null ? null : Number(r.conversion_at_risk_usd),
            convBand: (r.conv_band === 'sliding' ||
            r.conv_band === 'watch' ||
            r.conv_band === 'healthy'
              ? r.conv_band
              : null) as 'sliding' | 'watch' | 'healthy' | null,
          })),
        )
        .onConflictDoNothing()),
    );
  }
  console.log(
    `[sync]   segment positions: ${positionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (slidingRows.length) {
    await chunkInsert(slidingRows, 5_000, async (chunk) =>
      void (await db
        .insert(openSliding)
        .values(
          chunk.map((r) => ({
            id: r.segment_id,
            segmentId: r.segment_id,
            cohort: r.cohort,
            platform: r.platform,
            mau: r.mau === null ? null : Number(r.mau),
            conversionRate: r.conversion_rate === null ? null : Number(r.conversion_rate),
            conversionDrop: r.conversion_drop === null ? null : Number(r.conversion_drop),
            conversionAtRiskUsd:
              r.conversion_at_risk_usd === null ? null : Number(r.conversion_at_risk_usd),
            hasMatchingExperiment: r.has_matching_experiment,
            matchingExperimentId: r.matching_experiment_id,
            matchingExperimentLift:
              r.matching_experiment_lift === null ? null : Number(r.matching_experiment_lift),
            neighborFlagKey: r.neighbor_flag_key,
          })),
        )
        .onConflictDoNothing()),
    );
  }
  console.log(
    `[sync]   sliding segments: ${slidingRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (experimentsRows.length) {
    await chunkInsert(experimentsRows, 5_000, async (chunk) =>
      void (await db
        .insert(experiments)
        .values(
          chunk.map((r) => ({
            id: r.experiment_id,
            experimentId: r.experiment_id,
            experimentName: r.experiment_name,
            variant: r.variant,
            featureArea: r.feature_area,
            testedCohort: r.tested_cohort,
            testedPlatform: r.tested_platform,
            won: r.won,
            observedLift: r.observed_lift === null ? null : Number(r.observed_lift),
            description: r.description,
            isActive: r.is_active,
          })),
        )
        .onConflictDoNothing()),
    );
  }
  console.log(
    `[sync]   experiments: ${experimentsRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (actionRows.length) {
    await chunkInsert(actionRows, 5_000, async (chunk) =>
      void (await db
        .insert(actionRecommendations)
        .values(
          chunk.map((r) => ({
            id: r.segment_id,
            segmentId: r.segment_id,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            recommendedAction: (r.recommended_action === 'ship_proven_variant' ||
            r.recommended_action === 'rollout_existing_flag' ||
            r.recommended_action === 'ship_alt_variant'
              ? r.recommended_action
              : null) as
              | 'ship_proven_variant'
              | 'rollout_existing_flag'
              | 'ship_alt_variant'
              | null,
            predictedConversionLift:
              r.predicted_conversion_lift === null ? null : Number(r.predicted_conversion_lift),
            predictedNetValueUsd:
              r.predicted_net_value_usd === null ? null : Number(r.predicted_net_value_usd),
            actionRanking: parseActionRanking(r.action_ranking),
          })),
        )
        .onConflictDoNothing()),
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

export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable decision table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.feature_decisions_app RESTART IDENTITY CASCADE`);
    // Read-only mirrors — re-pulled by syncFromDelta after this.
    await tx.execute(
      sql`TRUNCATE TABLE app.action_recommendations RESTART IDENTITY CASCADE`,
    );
    await tx.execute(
      sql`TRUNCATE TABLE app.open_sliding RESTART IDENTITY CASCADE`,
    );
    await tx.execute(sql`TRUNCATE TABLE app.segment_position RESTART IDENTITY CASCADE`);
  });
}

// ───────────────────────────────────────────────────────────────────────
// Utility: Databricks SQL Statements API + chunked inserts
// ───────────────────────────────────────────────────────────────────────

async function execSql<T>(warehouseId: string, statement: string): Promise<T[]> {
  const host = process.env.DATABRICKS_HOST || 'api.databricks.com';
  const token = process.env.DATABRICKS_TOKEN || '';
  const resp = await fetch(
    `https://${host}/api/2.0/sql/statements`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        statement,
        warehouse_id: warehouseId,
      }),
    },
  );

  if (!resp.ok) {
    throw new Error(
      `SQL execution failed: ${resp.status} ${await resp.text()}`,
    );
  }

  interface StmtResult {
    result: {
      data_array: unknown[][];
      column_count: number;
      columns?: { name: string; type_text: string }[];
    };
  }
  const result = (await resp.json()) as StmtResult;
  if (!result.result?.data_array) {
    return [];
  }

  const cols = result.result.columns?.map((c) => c.name) ?? [];
  return result.result.data_array.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}

async function chunkInsert<T>(
  items: T[],
  chunkSize: number,
  insert: (chunk: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    await insert(items.slice(i, i + chunkSize));
  }
}
