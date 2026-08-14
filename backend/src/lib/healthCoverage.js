const { dbGet } = require('../db');

const HEALTH_SYNC_SCALAR_FIELDS = [
  'steps_today',
  'calories_today',
  'avg_heart_rate_last_run',
  'total_miles_this_week',
  'resting_heart_rate',
  'hrv_ms',
  'sleep_hours_last_night',
  'active_minutes_this_week',
  'workout_count_this_week',
  'last_workout_type',
  'last_workout_duration_seconds',
  'last_workout_calories',
];

const CORE_COVERAGE_FIELDS = [
  'resting_heart_rate',
  'hrv_ms',
  'sleep_hours_last_night',
];

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const HEALTH_FRESHNESS_WINDOWS_MS = Object.freeze({
  sleep_duration: 36 * 60 * 60 * 1000,
  sleep_quality: 36 * 60 * 60 * 1000,
  hrv: 48 * 60 * 60 * 1000,
  resting_heart_rate: 48 * 60 * 60 * 1000,
});

const MODALITY_ALIASES = Object.freeze({
  aerobic: ['running', 'cardio'],
  running_impact: ['running'],
  lower_body_muscular: ['strength', 'hybrid'],
  upper_body_muscular: ['strength', 'hybrid'],
  grip: ['strength', 'hybrid'],
  neuromuscular: ['running', 'strength', 'hybrid'],
  metabolic: ['running', 'cardio', 'strength', 'hybrid'],
  event_specific_fatigue: ['hybrid'],
});

function parseTrainingMetrics(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function buildFieldCoverage(row) {
  return HEALTH_SYNC_SCALAR_FIELDS.reduce((coverage, field) => {
    const value = row && isPresent(row[field]) ? row[field] : null;
    coverage[field] = { present: value !== null, value };
    return coverage;
  }, {});
}

function isStale(syncedAt) {
  if (!syncedAt) return true;
  const syncedMs = Date.parse(syncedAt);
  if (!Number.isFinite(syncedMs)) return true;
  return Date.now() - syncedMs > STALE_AFTER_MS;
}

function normalizedLocalDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function normalizedQualityState(value) {
  const state = String(value || '').trim().toUpperCase();
  if (['COMPLETE', 'PARTIAL', 'FAILED_SYNC', 'CONFLICT', 'CORRUPTED'].includes(state)) return state;
  if (state === 'FAILED' || state === 'ERROR') return 'FAILED_SYNC';
  return null;
}

function classifyProviderCoverage(input = {}) {
  const sourceSystem = String(input.source_system || input.sourceSystem || 'unknown').trim().toLowerCase().slice(0, 40) || 'unknown';
  const rawModalities = input.modalities || input.modality || [];
  const modalities = [...new Set((Array.isArray(rawModalities) ? rawModalities : [rawModalities])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))].sort();
  const coverageStart = normalizedLocalDate(input.coverage_start_local || input.coverageStartLocal);
  const coverageEnd = normalizedLocalDate(input.coverage_end_local || input.coverageEndLocal);
  const expectedStart = normalizedLocalDate(input.expected_start_local || input.expectedStartLocal);
  const expectedEnd = normalizedLocalDate(input.expected_end_local || input.expectedEndLocal);
  const rawStatus = String(input.status || '').trim().toLowerCase();
  let qualityState = normalizedQualityState(input.quality_state || input.qualityState);
  if (!qualityState) {
    if (input.failed === true || input.success === false || ['failed', 'error', 'timeout'].includes(rawStatus)) {
      qualityState = 'FAILED_SYNC';
    } else if (input.partial === true || rawStatus === 'partial') {
      qualityState = 'PARTIAL';
    } else if (['complete', 'completed', 'success', 'succeeded'].includes(rawStatus) || input.success === true) {
      qualityState = 'COMPLETE';
    } else {
      qualityState = 'PARTIAL';
    }
  }
  const intervalIncomplete = !coverageStart
    || !coverageEnd
    || coverageEnd < coverageStart
    || (expectedStart && coverageStart > expectedStart)
    || (expectedEnd && coverageEnd < expectedEnd);
  if (qualityState === 'COMPLETE' && intervalIncomplete) qualityState = 'PARTIAL';
  const reasonCodes = [];
  if (qualityState === 'FAILED_SYNC') reasonCodes.push('FAILED_SYNC');
  if (qualityState === 'PARTIAL') reasonCodes.push('PARTIAL_SYNC');
  if (qualityState === 'CONFLICT') reasonCodes.push('EVIDENCE_CONFLICT_UNRESOLVED');
  return Object.freeze({
    source_system: sourceSystem,
    modalities: Object.freeze(modalities),
    coverage_start_local: coverageStart,
    coverage_end_local: coverageEnd,
    expected_start_local: expectedStart,
    expected_end_local: expectedEnd,
    quality_state: qualityState,
    complete: qualityState === 'COMPLETE' && !intervalIncomplete,
    reason_codes: Object.freeze(reasonCodes),
  });
}

function valueStateForEmptyCoverage(rows = []) {
  const coverage = (Array.isArray(rows) ? rows : []).map(classifyProviderCoverage);
  if (!coverage.length) return 'UNKNOWN';
  return coverage.every((row) => row.quality_state === 'COMPLETE' && row.complete === true) ? 'VALID_ZERO' : 'UNKNOWN';
}

function worstCoverageQuality(rows) {
  const states = new Set(rows.map((row) => row.quality_state));
  for (const state of ['CORRUPTED', 'CONFLICT', 'FAILED_SYNC', 'PARTIAL']) {
    if (states.has(state)) return state;
  }
  return states.has('COMPLETE') ? 'COMPLETE' : 'PARTIAL';
}

function modalityCoverage(rows, modality) {
  const capable = rows.filter((row) => row.modalities.includes(modality));
  if (!capable.length) {
    return Object.freeze({
      eligible: false,
      quality_state: 'PARTIAL',
      value_state: 'UNKNOWN',
      source_systems: Object.freeze([]),
      reason_codes: Object.freeze(['EVIDENCE_UNKNOWN']),
    });
  }
  const qualityState = worstCoverageQuality(capable);
  const eligible = qualityState === 'COMPLETE' && capable.every((row) => row.complete);
  return Object.freeze({
    eligible,
    quality_state: qualityState,
    value_state: eligible ? 'VALID_ZERO' : 'UNKNOWN',
    source_systems: Object.freeze(capable.map((row) => row.source_system).sort()),
    reason_codes: Object.freeze([...new Set(capable.flatMap((row) => row.reason_codes))].sort()),
  });
}

function combinedDimensionCoverage(modalities, eligibleModalities) {
  const capable = modalities.filter((modality) => eligibleModalities[modality]?.source_systems.length);
  if (!capable.length) return modalityCoverage([], 'unconfigured');
  const results = capable.map((modality) => eligibleModalities[modality]);
  const qualityState = worstCoverageQuality(results);
  const eligible = results.every((result) => result.eligible);
  return Object.freeze({
    eligible,
    quality_state: qualityState,
    value_state: eligible ? 'VALID_ZERO' : 'UNKNOWN',
    source_systems: Object.freeze([...new Set(results.flatMap((result) => result.source_systems))].sort()),
    reason_codes: Object.freeze([...new Set(results.flatMap((result) => result.reason_codes))].sort()),
  });
}

function modalityEligibility(rows = []) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).map(classifyProviderCoverage);
  const configuredModalities = [...new Set(normalizedRows.flatMap((row) => row.modalities))].sort();
  const result = {};
  for (const modality of configuredModalities) result[modality] = modalityCoverage(normalizedRows, modality);
  for (const [dimension, modalities] of Object.entries(MODALITY_ALIASES)) {
    result[dimension] = combinedDimensionCoverage(modalities, result);
  }
  return Object.freeze(result);
}

function healthMetricFreshness(metric, observedAt, planningInstant = new Date(), { baselineDays = 0 } = {}) {
  const key = String(metric || '').trim().toLowerCase();
  const windowMs = HEALTH_FRESHNESS_WINDOWS_MS[key];
  const observedMs = Date.parse(observedAt);
  const planningMs = new Date(planningInstant).getTime();
  const requiresBaseline = key === 'hrv' || key === 'resting_heart_rate';
  if (!windowMs || !Number.isFinite(observedMs) || !Number.isFinite(planningMs) || observedMs > planningMs) {
    return { freshness_class: 'EXPIRED', usable: false };
  }
  if (requiresBaseline && Number(baselineDays) < 14) {
    return { freshness_class: planningMs - observedMs <= windowMs ? 'FRESH' : 'STALE', usable: false };
  }
  const fresh = planningMs - observedMs <= windowMs;
  return { freshness_class: fresh ? 'FRESH' : 'STALE', usable: fresh };
}

function classifyCoverage({ hasHealthSync, fields, trainingMetricKeys, hasCheckIns }) {
  if (!hasHealthSync) return hasCheckIns ? 'check_in_only' : 'limited';

  const corePresentCount = CORE_COVERAGE_FIELDS.filter((field) => fields[field]?.present).length;
  if (corePresentCount === CORE_COVERAGE_FIELDS.length) return 'full';

  const anyScalarPresent = Object.values(fields).some((field) => field.present);
  if (corePresentCount > 0 || anyScalarPresent || trainingMetricKeys.length > 0) return 'partial';

  return 'limited';
}

async function getHealthCoverage(userId) {
  const scopedUserId = String(userId || '').trim();
  if (!scopedUserId) throw new Error('getHealthCoverage requires userId');

  const [row, checkInRow] = await Promise.all([
    dbGet(
      `SELECT
        steps_today,
        calories_today,
        avg_heart_rate_last_run,
        total_miles_this_week,
        resting_heart_rate,
        hrv_ms,
        sleep_hours_last_night,
        active_minutes_this_week,
        workout_count_this_week,
        last_workout_type,
        last_workout_duration_seconds,
        last_workout_calories,
        training_metrics_json,
        synced_at
      FROM health_sync
      WHERE user_id=?`,
      [scopedUserId]
    ),
    dbGet('SELECT 1 AS present FROM daily_checkins WHERE user_id=? LIMIT 1', [scopedUserId]),
  ]);

  const fields = buildFieldCoverage(row);
  const trainingMetricKeys = Object.entries(parseTrainingMetrics(row?.training_metrics_json))
    .filter(([, value]) => isPresent(value))
    .map(([key]) => key)
    .sort();
  const hasHealthSync = Boolean(row);
  const hasCheckIns = Boolean(checkInRow);

  return {
    classification: classifyCoverage({ hasHealthSync, fields, trainingMetricKeys, hasCheckIns }),
    fields,
    training_metric_keys: trainingMetricKeys,
    synced_at: row?.synced_at || null,
    stale: isStale(row?.synced_at),
    has_health_sync: hasHealthSync,
    has_check_ins: hasCheckIns,
  };
}

module.exports = {
  HEALTH_FRESHNESS_WINDOWS_MS,
  HEALTH_SYNC_SCALAR_FIELDS,
  classifyProviderCoverage,
  getHealthCoverage,
  healthMetricFreshness,
  modalityEligibility,
  valueStateForEmptyCoverage,
};
