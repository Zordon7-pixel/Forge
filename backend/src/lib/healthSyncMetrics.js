const TRAINING_METRIC_SPECS = {
  sleep_core_hours: { min: 0, max: 16 },
  sleep_deep_hours: { min: 0, max: 16 },
  sleep_rem_hours: { min: 0, max: 16 },
  sleep_awake_hours: { min: 0, max: 16 },
  sleep_hours_7d_baseline: { min: 0, max: 16 },
  resting_heart_rate_baseline: { integer: true, min: 30, max: 240 },
  hrv_ms_baseline: { integer: true, min: 1, max: 500 },
  vo2_max: { min: 5, max: 100 },
  walking_heart_rate_average: { integer: true, min: 30, max: 220 },
  heart_rate_recovery_one_minute: { integer: true, min: 0, max: 120 },
  respiratory_rate: { min: 5, max: 60 },
  exercise_minutes_this_week: { integer: true, min: 0, max: 10080 },
  running_power_watts: { integer: true, min: 0, max: 2000 },
  running_speed_mps: { min: 0, max: 15 },
  running_stride_length_m: { min: 0.2, max: 3 },
  running_vertical_oscillation_cm: { min: 0, max: 30 },
  running_ground_contact_time_ms: { min: 50, max: 1000 },
};

const TRAINING_TIMESTAMP_FIELDS = [
  'sleep_end_at',
  'resting_heart_rate_recorded_at',
  'hrv_recorded_at',
  'vo2_max_recorded_at',
  'walking_heart_rate_recorded_at',
  'heart_rate_recovery_recorded_at',
  'respiratory_rate_recorded_at',
  'running_dynamics_recorded_at',
];

function coerceMetric(value, options = {}) {
  const { label, integer = false, min = 0, max = Number.POSITIVE_INFINITY, dropAboveMax = false } = options;

  if (value === null || value === undefined || value === '') {
    return { value: null };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a number` };
  }
  if (integer && !Number.isInteger(parsed)) {
    return { error: `${label} must be a whole number` };
  }
  if (dropAboveMax && parsed > max) {
    console.warn(`[health] dropping implausible ${label}: ${parsed}`);
    return { value: null, dropped: true, field: label };
  }
  if (parsed < min || parsed > max) {
    return { error: `${label} must be between ${min} and ${max}` };
  }

  return { value: parsed };
}

function coerceTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string' || value.length > 80) return { error: `${label} must be an ISO timestamp` };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { error: `${label} must be an ISO timestamp` };
  if (timestamp > Date.now() + 10 * 60 * 1000) return { error: `${label} cannot be in the future` };
  return { value: new Date(timestamp).toISOString() };
}

function normalizeTrainingMetrics(body = {}) {
  const metrics = {};
  if (Number(body.metrics_schema_version) === 2) metrics.metrics_schema_version = 2;
  for (const [field, spec] of Object.entries(TRAINING_METRIC_SPECS)) {
    const result = coerceMetric(body[field], { label: field, ...spec });
    if (result.error) return { error: result.error };
    if (result.value !== null) metrics[field] = result.value;
  }

  for (const field of TRAINING_TIMESTAMP_FIELDS) {
    const result = coerceTimestamp(body[field], field);
    if (result.error) return { error: result.error };
    if (result.value !== null) metrics[field] = result.value;
  }

  return { metrics };
}

function parseTrainingMetrics(raw) {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[health] training metrics JSON parse failed:', err.message);
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const safe = {};
  for (const field of Object.keys(TRAINING_METRIC_SPECS)) {
    if (parsed[field] !== null && parsed[field] !== undefined) safe[field] = parsed[field];
  }
  for (const field of TRAINING_TIMESTAMP_FIELDS) {
    if (typeof parsed[field] === 'string') safe[field] = parsed[field];
  }
  if (Number(parsed.metrics_schema_version) === 2) safe.metrics_schema_version = 2;
  return safe;
}

function hydrateHealthRow(row = {}) {
  return { ...row, ...parseTrainingMetrics(row.training_metrics_json) };
}

module.exports = {
  TRAINING_METRIC_SPECS,
  TRAINING_TIMESTAMP_FIELDS,
  coerceMetric,
  hydrateHealthRow,
  normalizeTrainingMetrics,
  parseTrainingMetrics,
};
