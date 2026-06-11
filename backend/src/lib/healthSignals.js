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
    'subjective_sleep_hours',
    'subjective_feeling',
    'life_flags',
    'run_zone_drift_count',
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

  const subjectiveSleep = toNumber(row.subjective_sleep_hours);
  const sleep = subjectiveSleep !== null ? subjectiveSleep : toNumber(row.sleep_hours_last_night);
  const hrv = toNumber(row.hrv_ms);
  const restingHr = toNumber(row.resting_heart_rate);
  const activeMinutes = toNumber(row.active_minutes_this_week);
  const workoutCount = toNumber(row.workout_count_this_week);
  const miles = toNumber(row.total_miles_this_week);
  const lastWorkoutSeconds = toNumber(row.last_workout_duration_seconds);
  const lastWorkoutType = row.last_workout_type || null;
  const acuteChronicRatio = computeAcuteChronicRatio(row);
  const subjectiveFeeling = toNumber(row.subjective_feeling);
  const runZoneDriftCount = toNumber(row.run_zone_drift_count);
  const lifeFlags = Array.isArray(row.life_flags)
    ? row.life_flags
    : (() => {
      try {
        const parsed = typeof row.life_flags === 'string' ? JSON.parse(row.life_flags) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

  let scoreDelta = 0;
  const flags = [];
  const positives = [];

  if (sleep !== null) {
    const sleepKeyPrefix = subjectiveSleep !== null ? 'checkin_' : '';
    const sleepSource = subjectiveSleep !== null ? 'Check-in sleep' : 'Sleep';
    if (sleep < 5.5) {
      scoreDelta -= 20;
      flags.push({ key: `${sleepKeyPrefix}low_sleep`, severity: 'high', label: `${round(sleep)}h sleep`, reason: `${sleepSource} was very low last night.` });
    } else if (sleep < 6.5) {
      scoreDelta -= 10;
      flags.push({ key: `${sleepKeyPrefix}short_sleep`, severity: 'medium', label: `${round(sleep)}h sleep`, reason: `${sleepSource} is below the recovery target.` });
    } else if (sleep >= 7.5) {
      scoreDelta += 8;
      positives.push({ key: `${sleepKeyPrefix}good_sleep`, label: `${round(sleep)}h sleep`, reason: `${sleepSource} supports normal training.` });
    }
  }

  if (subjectiveFeeling !== null) {
    if (subjectiveFeeling <= 1) {
      scoreDelta -= 14;
      flags.push({ key: 'low_feeling', severity: 'high', label: 'Exhausted check-in', reason: 'Today\'s check-in reports very low readiness.' });
    } else if (subjectiveFeeling === 2) {
      scoreDelta -= 8;
      flags.push({ key: 'tired_feeling', severity: 'medium', label: 'Tired check-in', reason: 'Today\'s check-in reports low energy.' });
    } else if (subjectiveFeeling >= 5) {
      scoreDelta += 5;
      positives.push({ key: 'strong_feeling', label: 'Great check-in', reason: 'Today\'s check-in supports normal training.' });
    }
  }

  if (lifeFlags.includes('sick') || lifeFlags.includes('injured')) {
    scoreDelta -= 16;
    flags.push({ key: 'health_life_flag', severity: 'high', label: 'Sick or injured', reason: 'Today\'s check-in includes a health limitation.' });
  }
  if (lifeFlags.includes('sore')) {
    scoreDelta -= 8;
    flags.push({ key: 'sore_life_flag', severity: 'medium', label: 'Sore', reason: 'Soreness can reduce readiness for intensity.' });
  }
  if (lifeFlags.includes('stressed') || lifeFlags.includes('traveling') || lifeFlags.includes('long_shift')) {
    scoreDelta -= 5;
    flags.push({ key: 'life_stress_flag', severity: 'medium', label: 'Life stress', reason: 'Today\'s check-in includes extra non-training stress.' });
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
    const loadSpikeDelta = acuteChronicRatio > 1.8 ? -10 : -6;
    scoreDelta += loadSpikeDelta;
    flags.push({ key: 'load_spike', severity: acuteChronicRatio > 1.8 ? 'medium' : 'low', label: `${acuteChronicRatio}:1 load ratio`, reason: 'Recent run load is spiking above your 28-day baseline.' });
  }

  if (runZoneDriftCount !== null && runZoneDriftCount >= 3) {
    const driftDelta = runZoneDriftCount >= 5 ? -10 : -6;
    scoreDelta += driftDelta;
    flags.push({
      key: 'zone_drift',
      severity: runZoneDriftCount >= 5 ? 'medium' : 'low',
      label: `${runZoneDriftCount} Z3+ recent runs`,
      reason: 'Recent aerobic/base runs are drifting into Z3 or higher.',
    });
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
      sleepSource: subjectiveSleep !== null ? 'daily_checkin' : 'health_sync',
      hrvMs: hrv,
      restingHeartRate: restingHr,
      activeMinutesThisWeek: activeMinutes,
      workoutCountThisWeek: workoutCount,
      totalMilesThisWeek: miles,
      acuteChronicLoadRatio: acuteChronicRatio,
      subjectiveFeeling,
      lifeFlags,
      runZoneDriftCount,
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
