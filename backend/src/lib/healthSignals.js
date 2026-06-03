function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function hasHealthData(row = {}) {
  return [
    'sleep_hours_last_night',
    'hrv_ms',
    'resting_heart_rate',
    'active_minutes_this_week',
    'workout_count_this_week',
    'total_miles_this_week',
    'last_workout_duration_seconds',
  ].some((key) => row?.[key] !== null && row?.[key] !== undefined);
}

function buildReadinessBand(score) {
  const value = Number(score);
  if (value >= 70) return { band: 'GREEN', verdict: 'READY' };
  if (value >= 45) return { band: 'AMBER', verdict: 'EASY' };
  return { band: 'RED', verdict: 'REST' };
}

function computeAcuteChronicRatio(row = {}) {
  const acuteLoad = toNumber(row.acute_load_7d ?? row.total_miles_7d ?? row.total_miles_this_week);
  const chronicLoad = toNumber(row.chronic_load_28d ?? row.total_miles_28d);
  if (acuteLoad === null || chronicLoad === null || acuteLoad <= 0 || chronicLoad <= 0) return null;
  return round(acuteLoad / (chronicLoad / 4), 2);
}

function buildHealthSignals(row = {}) {
  if (!hasHealthData(row)) {
    return {
      available: false,
      scoreDelta: 0,
      readinessScore: null,
      recoveryState: 'unknown',
      flags: [],
      summary: 'Apple Health has not synced enough recovery data yet.',
    };
  }

  const sleep = toNumber(row.sleep_hours_last_night);
  const hrv = toNumber(row.hrv_ms);
  const restingHr = toNumber(row.resting_heart_rate);
  const activeMinutes = toNumber(row.active_minutes_this_week);
  const workoutCount = toNumber(row.workout_count_this_week);
  const miles = toNumber(row.total_miles_this_week);
  const lastWorkoutSeconds = toNumber(row.last_workout_duration_seconds);
  const lastWorkoutType = row.last_workout_type || null;
  const acuteChronicRatio = computeAcuteChronicRatio(row);

  let scoreDelta = 0;
  const flags = [];
  const positives = [];

  if (sleep !== null) {
    if (sleep < 5.5) {
      scoreDelta -= 20;
      flags.push({ key: 'low_sleep', severity: 'high', label: `${round(sleep)}h sleep`, reason: 'Sleep was very low last night.' });
    } else if (sleep < 6.5) {
      scoreDelta -= 10;
      flags.push({ key: 'short_sleep', severity: 'medium', label: `${round(sleep)}h sleep`, reason: 'Sleep is below the recovery target.' });
    } else if (sleep >= 7.5) {
      scoreDelta += 8;
      positives.push({ key: 'good_sleep', label: `${round(sleep)}h sleep`, reason: 'Sleep supports normal training.' });
    }
  }

  if (hrv !== null) {
    if (hrv < 35) {
      scoreDelta -= 14;
      flags.push({ key: 'low_hrv', severity: 'high', label: `${hrv} ms HRV`, reason: 'HRV is low, which can indicate recovery stress.' });
    } else if (hrv < 45) {
      scoreDelta -= 8;
      flags.push({ key: 'suppressed_hrv', severity: 'medium', label: `${hrv} ms HRV`, reason: 'HRV is slightly suppressed.' });
    } else if (hrv >= 65) {
      scoreDelta += 5;
      positives.push({ key: 'strong_hrv', label: `${hrv} ms HRV`, reason: 'HRV is supportive.' });
    }
  }

  if (restingHr !== null) {
    if (restingHr >= 85) {
      scoreDelta -= 14;
      flags.push({ key: 'high_rhr', severity: 'high', label: `${restingHr} bpm resting HR`, reason: 'Resting heart rate is elevated.' });
    } else if (restingHr >= 75) {
      scoreDelta -= 7;
      flags.push({ key: 'elevated_rhr', severity: 'medium', label: `${restingHr} bpm resting HR`, reason: 'Resting heart rate is above the preferred range.' });
    } else if (restingHr > 0 && restingHr <= 60) {
      scoreDelta += 4;
      positives.push({ key: 'calm_rhr', label: `${restingHr} bpm resting HR`, reason: 'Resting heart rate looks calm.' });
    }
  }

  if (activeMinutes !== null && activeMinutes >= 420) {
    scoreDelta -= 8;
    flags.push({ key: 'high_active_minutes', severity: 'medium', label: `${activeMinutes} active min this week`, reason: 'Weekly activity load is already high.' });
  }

  if (workoutCount !== null && workoutCount >= 6) {
    scoreDelta -= 8;
    flags.push({ key: 'high_workout_count', severity: 'medium', label: `${workoutCount} workouts this week`, reason: 'Workout frequency is high this week.' });
  }

  if (lastWorkoutSeconds !== null && lastWorkoutSeconds >= 5400) {
    scoreDelta -= 6;
    flags.push({ key: 'long_last_workout', severity: 'medium', label: `${Math.round(lastWorkoutSeconds / 60)} min last workout`, reason: 'The last workout was long enough to affect recovery.' });
  }

  if (acuteChronicRatio !== null && acuteChronicRatio > 1.5) {
    flags.push({ key: 'load_spike', severity: 'low', label: `${acuteChronicRatio}:1 load ratio`, reason: 'Recent run load is spiking above your 28-day baseline.' });
  }

  const highFlags = flags.filter((flag) => flag.severity === 'high').length;
  const cautionFlags = flags.filter((flag) => flag.severity !== 'low').length;
  let recoveryState = 'normal';
  if (highFlags >= 2 || scoreDelta <= -24) recoveryState = 'recovery';
  else if (cautionFlags > 0 || scoreDelta <= -8) recoveryState = 'caution';
  else if (scoreDelta >= 10) recoveryState = 'strong';

  const readinessScore = Math.max(1, Math.min(99, Math.round(70 + scoreDelta)));
  const topReasons = [...flags, ...positives].slice(0, 3).map((item) => item.label);
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
    metrics: {
      sleepHoursLastNight: sleep,
      hrvMs: hrv,
      restingHeartRate: restingHr,
      activeMinutesThisWeek: activeMinutes,
      workoutCountThisWeek: workoutCount,
      totalMilesThisWeek: miles,
      acuteChronicLoadRatio: acuteChronicRatio,
      lastWorkoutType,
      lastWorkoutDurationSeconds: lastWorkoutSeconds,
    },
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
