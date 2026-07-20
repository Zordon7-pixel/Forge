const { isRunActivity } = require('./runActivity');
const { parseWorkoutMetrics } = require('./workoutMetrics');

const ZONE_KEYS = ['z1', 'z2', 'z3', 'z4', 'z5'];
const ZONE_EFFORT_WEIGHTS = [1, 2, 4, 6, 8];
const MIN_HR_COVERAGE_PCT = 70;
const MIN_HR_SECONDS = 300;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseZoneSeconds(raw) {
  let parsed = raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[runEffort] heart-rate zones parse failed:', err.message);
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return ZONE_KEYS.map((key) => {
    const value = Number(parsed[key] ?? parsed[key.toUpperCase()] ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
}

function calculateEffortFromZones({ zoneSeconds, durationSeconds, coveragePct } = {}) {
  const zones = Array.isArray(zoneSeconds) ? zoneSeconds : parseZoneSeconds(zoneSeconds);
  const duration = Number(durationSeconds);
  if (!zones || zones.length !== 5 || !Number.isFinite(duration) || duration <= 0) return null;

  const coveredSeconds = zones.reduce((sum, seconds) => sum + Number(seconds || 0), 0);
  const suppliedCoverage = Number(coveragePct);
  const timelineCoverage = clamp((coveredSeconds / duration) * 100, 0, 100);
  const resolvedCoverage = Number.isFinite(suppliedCoverage)
    ? Math.min(clamp(suppliedCoverage, 0, 100), timelineCoverage)
    : timelineCoverage;
  if (coveredSeconds < MIN_HR_SECONDS || resolvedCoverage < MIN_HR_COVERAGE_PCT) return null;

  const weightedIntensity = zones.reduce((sum, seconds, index) => (
    sum + (Number(seconds || 0) * ZONE_EFFORT_WEIGHTS[index])
  ), 0) / coveredSeconds;
  const durationMinutes = duration / 60;
  const durationBonus = durationMinutes >= 120 ? 1.5
    : durationMinutes >= 75 ? 1
      : durationMinutes >= 45 ? 0.5
        : durationMinutes >= 25 ? 0.25
          : 0;
  const highZoneShare = (Number(zones[3] || 0) + Number(zones[4] || 0)) / coveredSeconds;
  const highZoneBonus = highZoneShare >= 0.5 ? 1 : highZoneShare >= 0.2 ? 0.5 : 0;
  const score = Math.round(clamp(weightedIntensity + durationBonus + highZoneBonus, 1, 10));
  const zoneLoad = zones.reduce((sum, seconds, index) => sum + ((Number(seconds || 0) / 60) * (index + 1)), 0);

  return {
    score,
    coveragePct: Math.round(resolvedCoverage * 10) / 10,
    zoneLoad: Math.round(zoneLoad * 10) / 10,
    method: 'hr_zones_duration_v1',
  };
}

function hasTrustedPerceivedEffort(row = {}) {
  const score = Number(row.perceived_effort);
  if (!Number.isFinite(score) || score < 1 || score > 10) return false;
  const workoutMetrics = parseWorkoutMetrics(row.workout_metrics_json || row.workoutMetrics || {});
  const importedLegacyEffort = String(row.watch_mode || '').toLowerCase() === 'import'
    && String(row.notes || '') === 'Imported workout';
  return !importedLegacyEffort
    || workoutMetrics.workout_effort_user_rated === 1
    || Boolean(row.pain_level)
    || Boolean(row.post_energy);
}

function resolveRunEffort(row = {}) {
  if (!isRunActivity(row)) return { score: null, source: 'unavailable' };
  if (hasTrustedPerceivedEffort(row)) {
    return { score: Math.round(Number(row.perceived_effort)), source: 'user_rated' };
  }

  const workoutMetrics = parseWorkoutMetrics(row.workout_metrics_json || row.workoutMetrics || {});
  const calculated = calculateEffortFromZones({
    zoneSeconds: row.heart_rate_zones || row.zoneSeconds,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    coveragePct: workoutMetrics.hr_sample_coverage_pct,
  });
  return calculated
    ? { ...calculated, source: 'calculated_hr_zones' }
    : { score: null, source: 'unavailable' };
}

function withCalculatedEffort(row = {}) {
  const effort = resolveRunEffort(row);
  const calculated = effort.source === 'calculated_hr_zones';
  return {
    ...row,
    calculated_effort: calculated ? effort.score : null,
    calculated_effort_coverage_pct: calculated ? effort.coveragePct : null,
    calculated_effort_load: calculated ? effort.zoneLoad : null,
    calculated_effort_method: calculated ? effort.method : null,
    effective_effort: effort.score,
    effort_source: effort.source,
  };
}

module.exports = {
  MIN_HR_COVERAGE_PCT,
  MIN_HR_SECONDS,
  calculateEffortFromZones,
  hasTrustedPerceivedEffort,
  resolveRunEffort,
  withCalculatedEffort,
};
