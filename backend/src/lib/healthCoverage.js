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
  HEALTH_SYNC_SCALAR_FIELDS,
  getHealthCoverage,
};
