const { hydrateHealthRow } = require('./healthSyncMetrics');

const HOUR_MS = 60 * 60 * 1000;

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isSuspectSyncedSleep(row = {}) {
  const syncedSleep = toNumber(row.sleep_hours_last_night);
  return syncedSleep !== null && syncedSleep > 12;
}

function hoursSince(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return (Date.now() - timestamp) / HOUR_MS;
}

function metricIsFresh(row, timestampField, maxHours) {
  const age = hoursSince(row[timestampField] || row.synced_at);
  return age === null || (age >= -0.25 && age <= maxHours);
}

function metricFreshness(row = {}) {
  return {
    activity: metricIsFresh(row, 'synced_at', 48),
    sleep: metricIsFresh(row, 'sleep_end_at', 36),
    restingHeartRate: metricIsFresh(row, 'resting_heart_rate_recorded_at', 48),
    hrv: metricIsFresh(row, 'hrv_recorded_at', 48),
    respiratoryRate: metricIsFresh(row, 'respiratory_rate_recorded_at', 48),
    vo2Max: metricIsFresh(row, 'vo2_max_recorded_at', 90 * 24),
    walkingHeartRate: metricIsFresh(row, 'walking_heart_rate_recorded_at', 30 * 24),
    heartRateRecovery: metricIsFresh(row, 'heart_rate_recovery_recorded_at', 30 * 24),
    runningDynamics: metricIsFresh(row, 'running_dynamics_recorded_at', 30 * 24),
  };
}

function hasHealthData(rawRow = {}) {
  const row = hydrateHealthRow(rawRow);
  const freshness = metricFreshness(row);
  const syncedSleep = toNumber(row?.sleep_hours_last_night);
  const hasValidSyncedSleep = syncedSleep !== null && syncedSleep > 0 && !isSuspectSyncedSleep(row);
  return (hasValidSyncedSleep && freshness.sleep)
    || (toNumber(row?.hrv_ms) !== null && freshness.hrv)
    || (toNumber(row?.resting_heart_rate) !== null && freshness.restingHeartRate)
    || computeAcuteChronicRatio(row) !== null;
}

function buildReadinessBand(score) {
  const value = Number(score);
  if (value >= 70) return { band: 'GREEN', verdict: 'READY' };
  if (value >= 45) return { band: 'AMBER', verdict: 'EASY' };
  return { band: 'RED', verdict: 'REST' };
}

function computeAcuteChronicRatio(rawRow = {}) {
  const row = hydrateHealthRow(rawRow);
  const acuteLoad = toNumber(row.acute_load_7d ?? row.total_miles_7d ?? row.total_miles_this_week);
  const chronicLoad = toNumber(row.chronic_load_28d ?? row.total_miles_28d);
  if (acuteLoad === null || chronicLoad === null || acuteLoad <= 0 || chronicLoad <= 0) return null;
  return round(acuteLoad / (chronicLoad / 4), 2);
}

const READINESS_WEIGHTS = {
  sleep: 0.30,
  restingHr: 0.25,
  hrv: 0.25,
  load: 0.20,
};

function interpolate(value, lowValue, highValue, lowScore, highScore) {
  if (value <= lowValue) return lowScore;
  if (value >= highValue) return highScore;
  return lowScore + ((value - lowValue) / (highValue - lowValue)) * (highScore - lowScore);
}

function severityForScore(score) {
  if (score < 45) return 'high';
  if (score < 70) return 'medium';
  return 'low';
}

function sleepBaseline(row = {}) {
  return toNumber(row.sleep_hours_7d_baseline ?? row.sleep_baseline_7d ?? row.avg_sleep_hours_7d);
}

function rhrBaseline(row = {}) {
  return toNumber(row.resting_heart_rate_baseline ?? row.resting_hr_baseline ?? row.avg_resting_heart_rate_7d);
}

function hrvBaseline(row = {}) {
  return toNumber(row.hrv_ms_baseline ?? row.hrv_baseline_ms ?? row.avg_hrv_ms_7d);
}

function scoreSleep(sleep, baseline) {
  let score;
  if (sleep < 5.5) score = interpolate(sleep, 0, 5.5, 15, 30);
  else if (sleep < 6.5) score = interpolate(sleep, 5.5, 6.5, 50, 65);
  else if (sleep < 7) score = interpolate(sleep, 6.5, 7, 65, 75);
  else score = interpolate(sleep, 7, 8.5, 85, 100);

  if (baseline !== null && baseline > 0) {
    const baselineAdjustment = clamp((sleep - baseline) * 12, -20, 10);
    score += baselineAdjustment;
    if (sleep >= baseline && sleep >= 7) score = Math.max(score, 85);
  }

  return clamp(score, 0, 100);
}

function scoreRestingHr(restingHr, baseline) {
  if (baseline !== null && baseline > 0) {
    const delta = restingHr - baseline;
    if (delta <= 0) return clamp(interpolate(delta, -10, 0, 100, 88), 0, 100);
    if (delta <= 5) return interpolate(delta, 0, 5, 88, 70);
    if (delta <= 10) return interpolate(delta, 5, 10, 70, 45);
    if (delta <= 15) return interpolate(delta, 10, 15, 45, 25);
    return 20;
  }

  if (restingHr <= 60) return 90;
  if (restingHr < 75) return interpolate(restingHr, 60, 75, 88, 72);
  if (restingHr < 85) return interpolate(restingHr, 75, 85, 60, 35);
  return 25;
}

function scoreHrv(hrv, baseline) {
  if (baseline !== null && baseline > 0) {
    const pct = (hrv - baseline) / baseline;
    if (pct >= 0) return clamp(interpolate(pct, 0, 0.2, 88, 100), 0, 100);
    if (pct >= -0.1) return interpolate(pct, -0.1, 0, 70, 88);
    if (pct >= -0.2) return interpolate(pct, -0.2, -0.1, 45, 70);
    if (pct >= -0.35) return interpolate(pct, -0.35, -0.2, 25, 45);
    return 20;
  }

  if (hrv >= 65) return 90;
  if (hrv >= 45) return interpolate(hrv, 45, 65, 70, 90);
  if (hrv >= 35) return interpolate(hrv, 35, 45, 45, 70);
  return 28;
}

function scoreAcuteChronicLoad(ratio) {
  if (ratio >= 0.8 && ratio <= 1.3) return 90;
  if (ratio > 1.3 && ratio <= 1.5) return interpolate(ratio, 1.3, 1.5, 80, 60);
  if (ratio > 1.5 && ratio <= 1.8) return interpolate(ratio, 1.5, 1.8, 45, 25);
  if (ratio > 1.8) return 20;
  if (ratio >= 0.5 && ratio < 0.8) return interpolate(ratio, 0.5, 0.8, 55, 80);
  return 30;
}

function driverForSubScore(signal) {
  const roundedScore = Math.round(signal.score);
  if (signal.key === 'sleep') {
    if (roundedScore < 45) return 'Sleep was very low last night.';
    if (roundedScore < 70) return 'Sleep is below the recovery target.';
    return 'Sleep supports normal training.';
  }
  if (signal.key === 'restingHr') {
    if (roundedScore < 45) return 'Resting heart rate is elevated.';
    if (roundedScore < 70) return signal.hasBaseline
      ? 'Resting heart rate is above baseline.'
      : 'Resting heart rate is above the preferred range.';
    return 'Resting heart rate looks calm.';
  }
  if (signal.key === 'hrv') {
    if (roundedScore < 45) return signal.hasBaseline
      ? 'HRV is trending below baseline.'
      : 'HRV is low, which can indicate recovery stress.';
    if (roundedScore < 70) return 'HRV is slightly suppressed.';
    return 'HRV supports recovery.';
  }
  if (roundedScore < 45) return 'Recent run load is outside the healthy acute:chronic range.';
  if (roundedScore < 70) return 'Recent run load is drifting from the 28-day baseline.';
  return 'Recent run load is in a healthy range.';
}

function buildMetricSnapshot(row, freshness, overrides = {}) {
  return {
    sleepHoursLastNight: toNumber(row.sleep_hours_last_night),
    sleepSource: toNumber(row.sleep_hours_last_night) !== null ? 'health_sync' : null,
    sleepHours7dBaseline: sleepBaseline(row),
    sleepCoreHours: toNumber(row.sleep_core_hours),
    sleepDeepHours: toNumber(row.sleep_deep_hours),
    sleepRemHours: toNumber(row.sleep_rem_hours),
    sleepAwakeHours: toNumber(row.sleep_awake_hours),
    sleepEndAt: row.sleep_end_at || null,
    hrvMs: toNumber(row.hrv_ms),
    hrvMsBaseline: hrvBaseline(row),
    hrvRecordedAt: row.hrv_recorded_at || null,
    restingHeartRate: toNumber(row.resting_heart_rate),
    restingHeartRateBaseline: rhrBaseline(row),
    restingHeartRateRecordedAt: row.resting_heart_rate_recorded_at || null,
    activeMinutesThisWeek: toNumber(row.active_minutes_this_week),
    exerciseMinutesThisWeek: toNumber(row.exercise_minutes_this_week),
    workoutCountThisWeek: toNumber(row.workout_count_this_week),
    totalMilesThisWeek: toNumber(row.total_miles_this_week),
    acuteChronicLoadRatio: computeAcuteChronicRatio(row),
    runZoneDriftCount: toNumber(row.run_zone_drift_count),
    lastWorkoutType: row.last_workout_type || null,
    lastWorkoutDurationSeconds: toNumber(row.last_workout_duration_seconds),
    vo2Max: toNumber(row.vo2_max),
    vo2MaxRecordedAt: row.vo2_max_recorded_at || null,
    walkingHeartRateAverage: toNumber(row.walking_heart_rate_average),
    walkingHeartRateRecordedAt: row.walking_heart_rate_recorded_at || null,
    heartRateRecoveryOneMinute: toNumber(row.heart_rate_recovery_one_minute),
    heartRateRecoveryRecordedAt: row.heart_rate_recovery_recorded_at || null,
    respiratoryRate: toNumber(row.respiratory_rate),
    respiratoryRateRecordedAt: row.respiratory_rate_recorded_at || null,
    runningPowerWatts: toNumber(row.running_power_watts),
    runningSpeedMps: toNumber(row.running_speed_mps),
    runningStrideLengthM: toNumber(row.running_stride_length_m),
    runningVerticalOscillationCm: toNumber(row.running_vertical_oscillation_cm),
    runningGroundContactTimeMs: toNumber(row.running_ground_contact_time_ms),
    runningDynamicsRecordedAt: row.running_dynamics_recorded_at || null,
    freshness,
    syncedAt: row.synced_at || null,
    ...overrides,
  };
}

function buildHealthSignals(rawRow = {}) {
  const row = hydrateHealthRow(rawRow);
  const freshness = metricFreshness(row);
  if (!hasHealthData(row)) {
    return {
      available: false,
      scoreDelta: 0,
      readinessScore: null,
      recoveryState: 'unknown',
      flags: [],
      summary: 'Apple Health has not synced enough recovery data yet.',
      metrics: buildMetricSnapshot(row, freshness),
    };
  }

  const syncedSleep = toNumber(row.sleep_hours_last_night);
  const sleep = syncedSleep !== null && syncedSleep > 0 && !isSuspectSyncedSleep(row) && freshness.sleep ? syncedSleep : null;
  const syncedSleepSuspect = syncedSleep !== null && isSuspectSyncedSleep(row);
  const rawHrv = toNumber(row.hrv_ms);
  const rawRestingHr = toNumber(row.resting_heart_rate);
  const hrv = freshness.hrv ? rawHrv : null;
  const restingHr = freshness.restingHeartRate ? rawRestingHr : null;
  const acuteChronicRatio = computeAcuteChronicRatio(row);
  const sleepBase = sleepBaseline(row);
  const restingHrBase = rhrBaseline(row);
  const hrvBase = hrvBaseline(row);
  const flags = [];
  const positives = [];
  const subScores = [];

  if (syncedSleep !== null && !syncedSleepSuspect && !freshness.sleep) {
    flags.push({ key: 'sleep_stale', severity: 'low', label: 'Sleep needs a refresh', reason: 'The latest sleep sample is too old to adjust today\'s training.' });
  }
  if (rawHrv !== null && !freshness.hrv) {
    flags.push({ key: 'hrv_stale', severity: 'low', label: 'HRV needs a refresh', reason: 'The latest HRV sample is too old to adjust today\'s training.' });
  }
  if (rawRestingHr !== null && !freshness.restingHeartRate) {
    flags.push({ key: 'resting_hr_stale', severity: 'low', label: 'Resting HR needs a refresh', reason: 'The latest resting heart-rate sample is too old to adjust today\'s training.' });
  }

  if (syncedSleepSuspect) {
    flags.push({
      key: 'sleep_data_suspect',
      severity: 'low',
      label: `${round(syncedSleep)}h synced sleep`,
      reason: 'Synced sleep looks like a double-counted or overlapping HealthKit reading, so it was ignored for readiness scoring.',
    });
  } else if (sleep !== null) {
    subScores.push({
      key: 'sleep',
      weight: READINESS_WEIGHTS.sleep,
      score: scoreSleep(sleep, sleepBase),
      label: `${round(sleep)}h sleep`,
      hasBaseline: sleepBase !== null,
    });
  }

  if (hrv !== null) {
    subScores.push({
      key: 'hrv',
      weight: READINESS_WEIGHTS.hrv,
      score: scoreHrv(hrv, hrvBase),
      label: `${hrv} ms HRV`,
      hasBaseline: hrvBase !== null,
    });
  }

  if (restingHr !== null) {
    subScores.push({
      key: 'restingHr',
      weight: READINESS_WEIGHTS.restingHr,
      score: scoreRestingHr(restingHr, restingHrBase),
      label: `${restingHr} bpm resting HR`,
      hasBaseline: restingHrBase !== null,
    });
  }

  if (acuteChronicRatio !== null) {
    subScores.push({
      key: 'load',
      weight: READINESS_WEIGHTS.load,
      score: scoreAcuteChronicLoad(acuteChronicRatio),
      label: `${acuteChronicRatio}:1 load ratio`,
      hasBaseline: true,
    });
  }

  const weightTotal = subScores.reduce((total, signal) => total + signal.weight, 0);
  const readinessScore = weightTotal > 0
    ? clamp(Math.round(subScores.reduce((total, signal) => total + signal.score * (signal.weight / weightTotal), 0)), 0, 100)
    : null;
  const scoreDelta = readinessScore === null ? 0 : readinessScore - 70;

  subScores
    .map((signal) => ({
      ...signal,
      severity: severityForScore(signal.score),
      reason: driverForSubScore(signal),
      impact: Math.abs(signal.score - readinessScore),
    }))
    .sort((a, b) => {
      const severityDiff = (b.severity === 'high' ? 3 : b.severity === 'medium' ? 2 : 1)
        - (a.severity === 'high' ? 3 : a.severity === 'medium' ? 2 : 1);
      if (severityDiff !== 0) return severityDiff;
      return b.impact - a.impact;
    })
    .forEach((signal) => {
      const item = {
        key: signal.key,
        severity: signal.severity,
        label: signal.label,
        reason: signal.reason,
      };
      flags.push(item);
      if (signal.score >= 70) positives.push(item);
    });

  let recoveryState = 'normal';
  if (readinessScore < 45) recoveryState = 'recovery';
  else if (readinessScore < 70) recoveryState = 'caution';
  else if (readinessScore >= 85) recoveryState = 'strong';

  const topReasons = flags.slice(0, 3).map((item) => item.label);
  const summary = topReasons.length
    ? `Apple Health: ${topReasons.join(', ')}.`
    : 'Apple Health data supports a normal training day.';

  return {
    available: true,
    scoreDelta,
    readinessScore,
    recoveryState,
    shouldReduceIntensity: recoveryState === 'caution' || recoveryState === 'recovery',
    shouldRest: recoveryState === 'recovery',
    flags,
    positives,
    summary,
    metrics: buildMetricSnapshot(row, freshness, {
      sleepHoursLastNight: sleep,
      sleepSource: sleep !== null ? 'health_sync' : null,
      hrvMs: hrv,
      restingHeartRate: restingHr,
    }),
  };
}

function applyHealthDelta(baseScore, signals) {
  const initial = Number.isFinite(Number(baseScore)) ? Number(baseScore) : 70;
  if (!signals?.available) return Math.max(1, Math.min(99, Math.round(initial)));
  return Math.max(1, Math.min(99, Math.round(initial + signals.scoreDelta)));
}

module.exports = {
  buildHealthSignals,
  buildReadinessBand,
  computeAcuteChronicRatio,
  applyHealthDelta,
};
