const { addDays, summarizeRecentRunLoad } = require('./recentRunLoad');

const WINDOW_DAYS = 28;
const BASELINE_DAYS = 28;
const RUN_WEIGHT = 0.42;
const LIFT_WEIGHT = 0.42;
const CONSISTENCY_WEIGHT = 0.16;
const ZERO_MODALITY_CAP = 60;
const LOW_MODALITY_CAP_RANGE = 40;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function clampScore(value) {
  return Math.round(clamp(value, 0, 100));
}

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function rowDate(row) {
  const raw = String(row?.date || row?.started_at || row?.created_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function rowsBetween(rows, startISO, endISO) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const date = rowDate(row);
    return date && date >= startISO && date <= endISO;
  });
}

function positiveNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
}

function distinctDateCount(rows) {
  return new Set(rows.map(rowDate).filter(Boolean)).size;
}

function scoreAgainstBaseline(current, baseline) {
  if (current <= 0) return 0;
  const target = baseline > 0 ? baseline : current;
  return clampScore((current / target) * 100);
}

function runMiles(rows) {
  return rows.reduce((sum, row) => sum + positiveNumber(row.distance_miles, 500), 0);
}

function runQualityLoad(rows) {
  return rows.reduce((sum, row) => {
    const miles = positiveNumber(row.distance_miles, 500);
    const effort = clamp(Number(row.perceived_effort ?? row.effective_effort ?? row.effort ?? 5), 1, 10);
    return sum + miles * (1 + Math.max(0, effort - 5) * 0.05);
  }, 0);
}

function liftTonnage(rows) {
  return rows.reduce((sum, row) => {
    const sets = positiveNumber(row.sets, 100);
    const reps = positiveNumber(row.reps, 500);
    const weight = positiveNumber(row.weight_lbs, 5000);
    return sum + sets * reps * weight;
  }, 0);
}

function consistencyScore(planCompletion, activityCount) {
  const planned = Number(planCompletion?.planned || 0);
  const completed = Number(planCompletion?.completed || 0);
  const rate = Number(planCompletion?.adherenceRate ?? planCompletion?.adherence_rate);
  if (planned > 0) {
    if (Number.isFinite(rate)) return clampScore(rate * 100);
    return clampScore((completed / planned) * 100);
  }
  return activityCount > 0 ? 100 : 0;
}

function driverLines({ run, lift, consistency }) {
  const drivers = [];
  if (run === 0 && lift === 0) {
    drivers.push('Log a run and a lift to start the score.');
  } else if (run === 0) {
    drivers.push('Run is missing, so the hybrid cap is active.');
  } else if (lift === 0) {
    drivers.push('Lift is missing, so the hybrid cap is active.');
  } else if (run + 15 < lift) {
    drivers.push('Run is the limiter for this hybrid window.');
  } else if (lift + 15 < run) {
    drivers.push('Lift is the limiter for this hybrid window.');
  } else {
    drivers.push('Run and lift balance is driving the score.');
  }

  if (consistency < 70) {
    drivers.push('Plan completion is holding the score back.');
  } else if (drivers.length < 2 && consistency >= 90) {
    drivers.push('Consistency is supporting the score.');
  }

  return drivers.slice(0, 2);
}

function computeHybridScore({ userId, runs, lifts, planCompletion, now } = {}) {
  void userId;
  const todayISO = toISODate(now);
  const currentStart = addDays(todayISO, -(WINDOW_DAYS - 1));
  const baselineEnd = addDays(currentStart, -1);
  const baselineStart = addDays(baselineEnd, -(BASELINE_DAYS - 1));

  const currentRuns = rowsBetween(runs, currentStart, todayISO);
  const baselineRuns = rowsBetween(runs, baselineStart, baselineEnd);
  const currentLifts = rowsBetween(lifts, currentStart, todayISO);
  const baselineLifts = rowsBetween(lifts, baselineStart, baselineEnd);

  const currentRunMiles = runMiles(currentRuns);
  const baselineRunMiles = runMiles(baselineRuns);
  const weeklyRunBaseline = baselineRunMiles > 0
    ? baselineRunMiles / (BASELINE_DAYS / 7)
    : currentRunMiles / (WINDOW_DAYS / 7);
  const recentRunLoad = summarizeRecentRunLoad(runs, {
    todayISO,
    weeklyBaseline: weeklyRunBaseline,
  });
  const runLoadScore = recentRunLoad.loadRatio !== null && recentRunLoad.loadRatio !== undefined
    ? clampScore(Number(recentRunLoad.loadRatio) * 100)
    : scoreAgainstBaseline(currentRunMiles, baselineRunMiles);
  const runVolumeScore = scoreAgainstBaseline(currentRunMiles, baselineRunMiles);
  const runQualityScore = scoreAgainstBaseline(runQualityLoad(currentRuns), runQualityLoad(baselineRuns));
  const run = clampScore(runLoadScore * 0.5 + runVolumeScore * 0.3 + runQualityScore * 0.2);

  const currentLiftTonnage = liftTonnage(currentLifts);
  const baselineLiftTonnage = liftTonnage(baselineLifts);
  const currentLiftSessions = distinctDateCount(currentLifts);
  const baselineLiftSessions = distinctDateCount(baselineLifts);
  const liftTonnageScore = scoreAgainstBaseline(currentLiftTonnage, baselineLiftTonnage);
  const liftSessionScore = scoreAgainstBaseline(currentLiftSessions, baselineLiftSessions);
  const lift = clampScore(liftTonnageScore * 0.65 + liftSessionScore * 0.35);

  const consistency = consistencyScore(planCompletion, currentRuns.length + currentLiftSessions);

  /*
   * Deterministic Hybrid Score formula:
   * - Window: latest 28 days through `now`; baseline: the prior 28 days.
   * - Run component: 50% recentRunLoad.loadRatio, 30% 28-day miles vs baseline,
   *   20% effort-weighted miles vs baseline. RPE above 5 adds 5% per point.
   * - Lift component: 65% tonnage vs baseline, 35% distinct lift days vs baseline.
   * - Consistency: completed / planned sessions; no active plan is neutral only
   *   when the athlete logged activity in the window.
   * - Total blend: run 42%, lift 42%, consistency 16%.
   * - Hybrid lock: total is capped at 60 + 0.4 * min(run, lift). If either
   *   modality is 0, the blend itself tops out at 58 with perfect consistency.
   */
  const blended = run * RUN_WEIGHT + lift * LIFT_WEIGHT + consistency * CONSISTENCY_WEIGHT;
  const modalityCap = ZERO_MODALITY_CAP + LOW_MODALITY_CAP_RANGE * (Math.min(run, lift) / 100);
  const score = run === 0 && lift === 0 ? 0 : clampScore(Math.min(blended, modalityCap));

  return {
    score,
    components: { run, lift, consistency },
    drivers: driverLines({ run, lift, consistency }),
  };
}

module.exports = {
  computeHybridScore,
};
