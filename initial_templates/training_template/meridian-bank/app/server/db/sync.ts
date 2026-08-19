import { sql } from 'drizzle-orm';
import type { AppDb } from './index.js';
import {
  customerPosition,
  openAtrisk,
  nbaRecommendations,
  products,
} from './schema.js';

/**
 * One-shot Delta → Lakebase sync for Meridian Bank.
 *
 * Pulls the at-risk customer position + rankings from Delta via the
 * Databricks SQL Statements API. Idempotent in the "only-if-destination-empty"
 * sense — if `app.customer_position` has rows, we skip. Pass
 * `{ forceIfAnyEmpty: true }` to re-sync on demand (used by the "Reset demo"
 * button).
 *
 * For reset: the caller TRUNCATEs the mirror tables first, then calls this.
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    /** gold_customer_position — synced read-only */
    customerPosition: string;
    /** gold_open_atrisk — synced read-only */
    openAtrisk: string;
    /** gold_nba_recommendations — synced read-only (optionally built by ML model) */
    nbaRecommendations: string;
    /** raw_products — synced read-only, static product catalog */
    products: string;
  };
};

export async function wipeMirroredTables(db: AppDb): Promise<void> {
  console.log('[sync] Truncating mirrored tables...');
  await Promise.all([
    db.execute(sql`TRUNCATE TABLE app.customer_position`).catch(() => null),
    db.execute(sql`TRUNCATE TABLE app.open_atrisk`).catch(() => null),
    db.execute(sql`TRUNCATE TABLE app.nba_recommendations`).catch(() => null),
    db.execute(sql`TRUNCATE TABLE app.products`).catch(() => null),
    db.execute(sql`TRUNCATE TABLE app.rm_actions`).catch(() => null),
  ]);
  console.log('[sync] Truncate done');
}

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.customer_position`,
  );
  const n = (exists.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (n > 0 && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (Meridian)…');
  const t0 = Date.now();

  const fq = (name: keyof DataConfig['tables']) =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  // Fire all 4 warehouse queries in parallel, then insert sequentially.
  const [positionRows, atriskRows, recommendationRows, productRows] =
    await Promise.all([
      execSql<any>(
        warehouseId,
        `SELECT * FROM ${fq('customerPosition')} LIMIT 1000`,
      ),
      execSql<any>(warehouseId, `SELECT * FROM ${fq('openAtrisk')} LIMIT 500`),
      execSql<any>(
        warehouseId,
        `SELECT * FROM ${fq('nbaRecommendations')} LIMIT 500`,
      ).catch(() => ({ rows: [] })), // tolerate missing if ML model not built
      execSql<any>(warehouseId, `SELECT * FROM ${fq('products')} LIMIT 5000`),
    ]);

  // Insert customer positions
  if (positionRows.rows.length > 0) {
    await chunkedInsert(db, customerPosition, positionRows.rows, 2000);
    console.log(
      `[sync] Inserted ${positionRows.rows.length} rows into app.customer_position`,
    );
  }

  // Insert open atrisk
  if (atriskRows.rows.length > 0) {
    await chunkedInsert(db, openAtrisk, atriskRows.rows, 2000);
    console.log(
      `[sync] Inserted ${atriskRows.rows.length} rows into app.open_atrisk`,
    );
  }

  // Insert NBA recommendations (optional — tolerate empty)
  if (recommendationRows.rows.length > 0) {
    await chunkedInsert(db, nbaRecommendations, recommendationRows.rows, 2000);
    console.log(
      `[sync] Inserted ${recommendationRows.rows.length} rows into app.nba_recommendations`,
    );
  } else {
    console.log(
      '[sync] No NBA recommendations (model may not be built yet — OK)',
    );
  }

  // Insert products
  if (productRows.rows.length > 0) {
    await chunkedInsert(db, products, productRows.rows, 2000);
    console.log(
      `[sync] Inserted ${productRows.rows.length} rows into app.products`,
    );
  }

  console.log(`[sync] Done in ${Date.now() - t0}ms`);
}

/** Execute a SQL query via the Databricks SQL Statements API.
 *  TODO: Trainee implements this using the WorkspaceClient's SQL API.
 */
async function execSql<T>(
  _warehouseId: string,
  _query: string,
): Promise<{ rows: T[] }> {
  // Stub for trainer — return empty result
  // Use ctx.client.sql.executeStatement(...) or similar from the SDK
  console.log('[sync] SQL query execution stubbed — trainer implements');
  return { rows: [] };
}

/** Insert rows in chunks, skipping on conflict. */
async function chunkedInsert<T extends Record<string, any>>(
  db: AppDb,
  table: any,
  rows: T[],
  chunkSize: number,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      await db
        .insert(table)
        .values(chunk)
        .onConflictDoNothing()
        .execute();
    } catch (e) {
      console.warn(
        `[sync] Chunk insertion failed (may be duplicate keys):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}
