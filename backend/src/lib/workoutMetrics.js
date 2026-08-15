const WORKOUT_METRIC_SPECS = {
  running_power_watts: { min: 0, max: 2000 },
  running_power_min_watts: { min: 0, max: 2000 },
  running_power_max_watts: { min: 0, max: 2000 },
  running_speed_mps: { min: 0, max: 15 },
  running_speed_min_mps: { min: 0, max: 15 },
  running_speed_max_mps: { min: 0, max: 15 },
  running_stride_length_m: { min: 0.2, max: 3 },
  running_stride_length_min_m: { min: 0.2, max: 3 },
  running_stride_length_max_m: { min: 0.2, max: 3 },
  running_vertical_oscillation_cm: { min: 0, max: 30 },
  running_vertical_oscillation_min_cm: { min: 0, max: 30 },
  running_vertical_oscillation_max_cm: { min: 0, max: 30 },
  running_ground_contact_time_ms: { min: 50, max: 1000 },
  running_ground_contact_time_min_ms: { min: 50, max: 1000 },
  running_ground_contact_time_max_ms: { min: 50, max: 1000 },
  running_cadence_spm: { min: 0, max: 300 },
  running_cadence_min_spm: { min: 0, max: 300 },
  running_cadence_max_spm: { min: 0, max: 300 },
  running_vertical_ratio_pct: { min: 0, max: 30 },
  ground_contact_balance_left_pct: { min: 0, max: 100 },
  ground_contact_balance_right_pct: { min: 0, max: 100 },
  respiratory_rate_avg: { min: 5, max: 80 },
  respiratory_rate_max: { min: 5, max: 100 },
  performance_condition: { min: -30, max: 30 },
  run_time_seconds: { integer: true, min: 0, max: 172800 },
  walk_time_seconds: { integer: true, min: 0, max: 172800 },
  idle_time_seconds: { integer: true, min: 0, max: 172800 },
  hr_sample_coverage_pct: { min: 0, max: 100 },
  post_workout_heart_rate_drop_bpm: { integer: true, min: 0, max: 220 },
  elevation_derived_from_route: { integer: true, min: 0, max: 1 },
  workout_effort_user_rated: { integer: true, min: 0, max: 1 },
  route_enriched_from_strava: { integer: true, min: 0, max: 1 },
  elevation_enriched_from_strava: { integer: true, min: 0, max: 1 },
};

const FIELD_ALIASES = {
  running_power_watts: ['running_power_watts', 'runningPowerWatts', 'avgPower', 'averagePower', 'Avg Power', 'Average Power'],
  running_speed_mps: ['running_speed_mps', 'runningSpeedMps'],
  running_stride_length_m: ['running_stride_length_m', 'runningStrideLengthM', 'strideLengthM', 'Avg Stride Length'],
  running_vertical_oscillation_cm: ['running_vertical_oscillation_cm', 'runningVerticalOscillationCm', 'verticalOscillationCm', 'Avg Vertical Oscillation'],
  running_ground_contact_time_ms: ['running_ground_contact_time_ms', 'runningGroundContactTimeMs', 'groundContactTimeMs', 'Avg Ground Contact Time'],
  running_vertical_ratio_pct: ['running_vertical_ratio_pct', 'runningVerticalRatioPct', 'verticalRatioPct', 'Avg Vertical Ratio'],
  ground_contact_balance_left_pct: ['ground_contact_balance_left_pct', 'groundContactBalanceLeftPct', 'leftGroundContactBalancePct'],
  ground_contact_balance_right_pct: ['ground_contact_balance_right_pct', 'groundContactBalanceRightPct', 'rightGroundContactBalancePct'],
  respiratory_rate_avg: ['respiratory_rate_avg', 'respiratoryRateAvg', 'avgRespirationRate', 'Average Respiration Rate'],
  respiratory_rate_max: ['respiratory_rate_max', 'respiratoryRateMax', 'maxRespirationRate', 'Max Respiration Rate'],
  performance_condition: ['performance_condition', 'performanceCondition', 'Performance Condition'],
  run_time_seconds: ['run_time_seconds', 'runTimeSeconds'],
  walk_time_seconds: ['walk_time_seconds', 'walkTimeSeconds'],
  idle_time_seconds: ['idle_time_seconds', 'idleTimeSeconds'],
  hr_sample_coverage_pct: ['hr_sample_coverage_pct', 'hrSampleCoveragePct'],
  elevation_derived_from_route: ['elevation_derived_from_route', 'elevationDerivedFromRoute'],
  workout_effort_user_rated: ['workout_effort_user_rated', 'workoutEffortUserRated'],
  route_enriched_from_strava: ['route_enriched_from_strava', 'routeEnrichedFromStrava'],
  elevation_enriched_from_strava: ['elevation_enriched_from_strava', 'elevationEnrichedFromStrava'],
};

function firstPresent(source, aliases) {
  for (const key of aliases) {
    if (source[key] !== null && source[key] !== undefined && source[key] !== '') return source[key];
  }
  return null;
}

function normalizeWorkoutMetrics(raw = {}) {
  const nested = raw.workoutMetrics || raw.workout_metrics || raw.metrics || {};
  const source = { ...raw, ...(nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {}) };
  const metrics = {};
  const droppedFields = [];

  for (const [field, spec] of Object.entries(WORKOUT_METRIC_SPECS)) {
    const value = firstPresent(source, FIELD_ALIASES[field] || [field]);
    if (value === null) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < spec.min || parsed > spec.max || (spec.integer && !Number.isInteger(parsed))) {
      droppedFields.push(field);
      continue;
    }
    metrics[field] = parsed;
  }

  const metricSource = String(source.metric_source || source.metricSource || source.source || '').trim().slice(0, 40);
  if (metricSource) metrics.metric_source = metricSource;
  return { metrics, droppedFields };
}

function parseWorkoutMetrics(raw) {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[workoutMetrics] JSON parse failed:', err.message);
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return normalizeWorkoutMetrics(parsed).metrics;
}

module.exports = { WORKOUT_METRIC_SPECS, normalizeWorkoutMetrics, parseWorkoutMetrics };
