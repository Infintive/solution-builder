/**
 * Care coordination query helpers for Cedar Health demo.
 * Used by the carecoordinator agent tools.
 *
 * TODO (Layer 2 + Layer 3 in APP_WORKSHOP.md):
 * - findAtriskPatient: reads patient_position + open_atrisk
 * - searchProviders: Lakebase Search over providers.description
 * - rankInterventions: reads intervention_recommendations
 * - recordCareAction: transactional write to care_actions
 */
import type { AppDb } from '../index.js';

export type AtriskPatient = {
  patientId: string;
  primaryCondition: string | null;
  readmissionRiskScore: number | null;
  daysSinceDischarge: number | null;
  openGapCount: number | null;
  hasOpenFollowup: boolean | null;
  hasOpenMedRecon: boolean | null;
  readmissionExposureUsd: number | null;
  clinicalSummary: string | null;
};

export type InterventionRanking = {
  patientId: string;
  recommendedIntervention: 'followup_call' | 'med_reconciliation' | 'home_health_referral';
  recommendedProviderId: string | null;
  predictedRiskReduction: number | null;
  predictedNetValueUsd: number | null;
  interventionRanking: Array<{
    intervention: string;
    predictedRiskReduction: number;
    predictedNetValueUsd: number;
  }>;
};

export type ProviderResult = {
  providerId: string;
  providerName: string;
  specialty: string | null;
  programType: string;
  acceptingReferrals: boolean | null;
};

/**
 * TODO: Layer 2a in APP_WORKSHOP.md
 * Find the live at-risk position for a patient, or the worst open at-risk.
 * Returns: patient risk info + clinical summary for context.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function findAtriskPatient(
  _db: AppDb,
  _patientId: string | null,
): Promise<AtriskPatient | null> {
  // Stub for now
  return null;
}

/**
 * TODO: Layer 2b in APP_WORKSHOP.md
 * Search providers via Lakebase Search on description field.
 * Used for home-health referral interventions.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function searchProviders(
  _db: AppDb,
  _query: string,
): Promise<ProviderResult[]> {
  // Stub for now
  return [];
}

/**
 * TODO: Layer 2c in APP_WORKSHOP.md
 * Read the ML model's ranked interventions for a patient.
 * Returns the recommendation + all three ranked options for what-if.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function rankInterventions(
  _db: AppDb,
  _patientId: string,
): Promise<InterventionRanking | null> {
  // Stub for now
  return null;
}

/**
 * TODO: Layer 3 in APP_WORKSHOP.md
 * Record an approved care action to the care_actions table.
 * Wraps in db.transaction for atomicity.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function recordCareAction(
  _db: AppDb,
  _args: {
    patientId: string;
    interventionType: 'followup_call' | 'med_reconciliation' | 'home_health_referral';
    providerId: string | null;
    draftedNote: string;
    predictedRiskReduction: number;
    userEmail: string;
  },
): Promise<{ actionId: string }> {
  // Stub for now
  return { actionId: '' };
}
