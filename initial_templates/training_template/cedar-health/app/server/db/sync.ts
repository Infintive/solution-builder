import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import {
  patientPosition,
  openAtrisk,
  interventionRecommendations,
  providers,
} from './schema.js';

/**
 * One-shot Delta → Lakebase sync.
 *
 * Pulls the read-only mirrors for the Cedar Health demo:
 * - gold_patient_panel (the patient queue with risk + gaps + geo)
 * - gold_open_atrisk (at-risk patients with intervention candidates)
 * - gold_intervention_recommendations (ranked actions per patient)
 * - raw_providers (referral directory for home-health + interventions)
 *
 * Idempotent in the "only-if-destination-empty" sense — if `app.patient_position`
 * has rows, we skip. Pass `{ forceIfAnyEmpty: true }` to re-sync on demand.
 *
 * For reset: the caller TRUNCATEs the mirror tables first, then calls this.
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    patientPanel: string;
    openAtrisk: string;
    interventionRecommendations: string;
    providers: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.patient_position`
  );
  const n = (exists.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (n > 0 && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (Cedar Health)…');
  const t0 = Date.now();

  const fq = (name: keyof DataConfig['tables']) =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  // Fire all 4 warehouse queries in parallel.
  const [patientRows, atriskRows, recommendationRows, providerRows] =
    await Promise.all([
      execSql<{
        patient_id: string;
        primary_condition: string | null;
        age_band: string | null;
        payer: string | null;
        home_metro: string | null;
        patient_lat: number | null;
        patient_lng: number | null;
        clinical_summary: string | null;
        days_since_discharge: number | null;
        readmission_risk_score: number | null;
        open_gap_count: number | null;
        has_open_followup: boolean | null;
        has_open_med_recon: boolean | null;
        risk_signal_score: number | null;
        severity_weight: number | null;
        readmission_exposure_usd: number | null;
        risk_band: string | null;
      }>(
        warehouseId,
        `SELECT patient_id, primary_condition, age_band, payer,
                home_metro, patient_lat, patient_lng, clinical_summary,
                days_since_discharge, readmission_risk_score, open_gap_count,
                has_open_followup, has_open_med_recon, risk_signal_score,
                severity_weight, readmission_exposure_usd, risk_band
         FROM ${fq('patientPanel')}`,
      ),
      execSql<{
        patient_id: string;
        readmission_risk_score: number | null;
        readmission_exposure_usd: number | null;
        days_since_discharge: number | null;
        has_open_followup: boolean | null;
        has_open_med_recon: boolean | null;
        severity_weight: number | null;
        capacity_headroom_hours: number | null;
        candidate_provider_id: string | null;
      }>(
        warehouseId,
        `SELECT patient_id, readmission_risk_score, readmission_exposure_usd,
                days_since_discharge, has_open_followup, has_open_med_recon,
                severity_weight, capacity_headroom_hours, candidate_provider_id
         FROM ${fq('openAtrisk')}`,
      ),
      execSql<{
        patient_id: string;
        recommended_intervention: string;
        recommended_provider_id: string | null;
        predicted_risk_reduction: number | null;
        predicted_net_value_usd: number | null;
        intervention_ranking: string; // JSONB as string
        scored_at: string | null;
      }>(
        warehouseId,
        `SELECT patient_id, recommended_intervention, recommended_provider_id,
                predicted_risk_reduction, predicted_net_value_usd,
                intervention_ranking, scored_at
         FROM ${fq('interventionRecommendations')}`,
      ),
      execSql<{
        provider_id: string;
        provider_name: string;
        specialty: string | null;
        program_type: string;
        description: string | null;
        accepting_referrals: boolean | null;
      }>(
        warehouseId,
        `SELECT provider_id, provider_name, specialty, program_type,
                description, accepting_referrals
         FROM ${fq('providers')}`,
      ),
    ]);

  console.log(
    `[sync]   queries done (${((Date.now() - t0) / 1000).toFixed(1)}s) — inserting…`
  );

  // Insert patient_position
  if (patientRows.length) {
    await chunkInsert(patientRows, 2_000, (chunk) =>
      db.insert(patientPosition).values(
        chunk.map((r) => ({
          patientId: r.patient_id,
          primaryCondition: r.primary_condition,
          ageBand: r.age_band,
          payer: r.payer,
          homeMetro: r.home_metro,
          patientLat: r.patient_lat === null ? null : Number(r.patient_lat),
          patientLng: r.patient_lng === null ? null : Number(r.patient_lng),
          clinicalSummary: r.clinical_summary,
          daysSinceDischarge:
            r.days_since_discharge === null ? null : Number(r.days_since_discharge),
          readmissionRiskScore:
            r.readmission_risk_score === null
              ? null
              : Number(r.readmission_risk_score),
          openGapCount:
            r.open_gap_count === null ? null : Number(r.open_gap_count),
          hasOpenFollowup: r.has_open_followup,
          hasOpenMedRecon: r.has_open_med_recon,
          riskSignalScore:
            r.risk_signal_score === null ? null : Number(r.risk_signal_score),
          severityWeight:
            r.severity_weight === null ? null : Number(r.severity_weight),
          readmissionExposureUsd:
            r.readmission_exposure_usd === null
              ? null
              : Number(r.readmission_exposure_usd),
          riskBand: (r.risk_band === 'critical' ||
          r.risk_band === 'elevated' ||
          r.risk_band === 'watch' ||
          r.risk_band === 'stable'
            ? r.risk_band
            : 'stable') as 'critical' | 'elevated' | 'watch' | 'stable',
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   patient_position: ${patientRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );

  // Insert open_atrisk
  if (atriskRows.length) {
    await chunkInsert(atriskRows, 2_000, (chunk) =>
      db.insert(openAtrisk).values(
        chunk.map((r) => ({
          patientId: r.patient_id,
          readmissionRiskScore:
            r.readmission_risk_score === null
              ? null
              : Number(r.readmission_risk_score),
          readmissionExposureUsd:
            r.readmission_exposure_usd === null
              ? null
              : Number(r.readmission_exposure_usd),
          daysSinceDischarge:
            r.days_since_discharge === null ? null : Number(r.days_since_discharge),
          hasOpenFollowup: r.has_open_followup,
          hasOpenMedRecon: r.has_open_med_recon,
          severityWeight:
            r.severity_weight === null ? null : Number(r.severity_weight),
          capacityHeadroomHours:
            r.capacity_headroom_hours === null
              ? null
              : Number(r.capacity_headroom_hours),
          candidateProviderId: r.candidate_provider_id,
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   open_atrisk: ${atriskRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );

  // Insert intervention_recommendations
  if (recommendationRows.length) {
    await chunkInsert(recommendationRows, 2_000, (chunk) =>
      db.insert(interventionRecommendations).values(
        chunk.map((r) => ({
          patientId: r.patient_id,
          recommendedIntervention: (r.recommended_intervention ===
          'followup_call' ||
          r.recommended_intervention === 'med_reconciliation' ||
          r.recommended_intervention === 'home_health_referral'
            ? r.recommended_intervention
            : 'followup_call') as
            | 'followup_call'
            | 'med_reconciliation'
            | 'home_health_referral',
          recommendedProviderId: r.recommended_provider_id,
          predictedRiskReduction:
            r.predicted_risk_reduction === null
              ? null
              : Number(r.predicted_risk_reduction),
          predictedNetValueUsd:
            r.predicted_net_value_usd === null
              ? null
              : Number(r.predicted_net_value_usd),
          interventionRanking: r.intervention_ranking
            ? JSON.parse(r.intervention_ranking)
            : [],
          scoredAt: r.scored_at ? new Date(r.scored_at) : null,
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   intervention_recommendations: ${recommendationRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );

  // Insert providers
  if (providerRows.length) {
    await chunkInsert(providerRows, 2_000, (chunk) =>
      db.insert(providers).values(
        chunk.map((r) => ({
          providerId: r.provider_id,
          providerName: r.provider_name,
          specialty: r.specialty,
          programType: (r.program_type === 'home_health' ||
          r.program_type === 'pcp' ||
          r.program_type === 'cardiology' ||
          r.program_type === 'pulmonology'
            ? r.program_type
            : 'pcp') as 'home_health' | 'pcp' | 'cardiology' | 'pulmonology',
          description: r.description,
          acceptingReferrals: r.accepting_referrals,
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   providers: ${providerRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(
      sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`
    );
    await tx.execute(
      sql`TRUNCATE TABLE app.care_actions RESTART IDENTITY CASCADE`
    );
    await tx.execute(
      sql`TRUNCATE TABLE app.patient_position RESTART IDENTITY CASCADE`
    );
    await tx.execute(sql`TRUNCATE TABLE app.open_atrisk RESTART IDENTITY CASCADE`);
    await tx.execute(
      sql`TRUNCATE TABLE app.intervention_recommendations RESTART IDENTITY CASCADE`
    );
    await tx.execute(sql`TRUNCATE TABLE app.providers RESTART IDENTITY CASCADE`);
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
        `[sync] SQL still ${cur.status.state} after 10 minutes — aborting (statement_id=${cur.statement_id})`
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
      `[sync] SQL failed: ${cur.status.error?.message ?? cur.status.state}`
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
    if (chunk.next_chunk_index === undefined || chunk.next_chunk_index === null)
      break;
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
