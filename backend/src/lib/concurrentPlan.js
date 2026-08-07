// Forged Hybrid H3 concurrent scheduling engine.
// Pure and deterministic: no DB, network, framework, or wall-clock dependency.

const planSchema = require('./planSchema');
const raceCourse = require('./raceCourse');
const strengthPrescription = require('./strengthPrescription');
const trainingEvidence = require('./trainingEvidence');
const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const { isRunActivity } = require('./runActivity');
const { resolveRunSchedule } = require('./runSchedule');

const DAY_ORDER = planSchema.DAY_ORDER;
const VALID_MODES = planSchema.VALID_MODES;
const HARD_RUN_PATTERN = /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|benchmark|time-trial|zone 3|zone 4|zone 5)/i;
const PERFORMANCE_RECENCY_DAYS = 365;
const STANDARD_PERFORMANCE_DISTANCES = Object.freeze([
  { key: 'mile', label: '1 Mile', miles: 1 },
  { key: '5k', label: '5K', miles: 3.107 },
  { key: '10k', label: '10K', miles: 6.214 },
  { key: '15k', label: '15K', miles: 9.321 },
  { key: '10_mile', label: '10 Mile', miles: 10 },
  { key: 'half_marathon', label: 'Half Marathon', miles: 13.109 },
  { key: 'marathon', label: 'Marathon', miles: 26.219 },
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function resolvedGoalTime(target = {}, existingGoal = {}, history = {}) {
  const requestedSeconds = Number(target.goalTimeSeconds ?? target.goal_time_seconds);
  if (Number.isFinite(requestedSeconds) && requestedSeconds > 0) {
    return { seconds: Math.round(requestedSeconds), source: 'user_defined', improvementPercent: null };
  }
  if (String(target.goalType || target.goal_type || '').toLowerCase() === 'completion') return null;
  const existingSeconds = Number(existingGoal.goalTimeSeconds ?? existingGoal.goal_time_seconds);
  if (Number.isFinite(existingSeconds) && existingSeconds > 0) {
    return {
      seconds: Math.round(existingSeconds),
      source: existingGoal.goalTimeSource || existingGoal.goal_time_source || 'existing_plan',
      improvementPercent: Number(existingGoal.improvementTargetPercent || 0) || null,
    };
  }
  const anchor = history.performanceProfile?.targetAnchor || null;
  const benchmarkSeconds = Number(anchor?.equivalentTimeSeconds || 0);
  if (!(benchmarkSeconds > 0)) return null;
  const improvementPercent = anchor.kind === 'observed_distance_band' ? 2 : 1;
  return {
    seconds: Math.round(benchmarkSeconds * (1 - (improvementPercent / 100))),
    source: 'performance_anchor',
    improvementPercent,
  };
}

function goalTimeSecondsFor(target = {}, existingGoal = {}, history = {}) {
  return resolvedGoalTime(target, existingGoal, history)?.seconds || null;
}

function goalPaceSecondsPerMile(target = {}, existingGoal = {}, history = {}) {
  const seconds = goalTimeSecondsFor(target, existingGoal, history);
  const distance = Number(target.distanceMiles ?? target.distance_miles ?? existingGoal.distanceMiles ?? existingGoal.distance_miles);
  if (!seconds || !Number.isFinite(distance) || distance <= 0) return null;
  const pace = seconds / distance;
  return pace >= 180 && pace <= 1800 ? Math.round(pace) : null;
}

function formatPaceLabel(secondsPerMile) {
  const total = Math.round(Number(secondsPerMile));
  if (!Number.isFinite(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`;
}

function performanceSource(row = {}) {
  const source = String(row.health_source || row.watch_mode || 'forged_hybrid').trim().toLowerCase();
  let metrics = row.workout_metrics_json;
  if (typeof metrics === 'string' && metrics.trim()) {
    try {
      metrics = JSON.parse(metrics);
    } catch (err) {
      console.error('[concurrentPlan] workout metrics parse failed:', err.message);
      metrics = null;
    }
  }
  if (source === 'apple_health' && metrics?.route_enriched_from_strava === 1) return 'apple_health+strava';
  if (source.includes('strava')) return 'strava';
  if (source.includes('apple')) return 'apple_health';
  return source || 'forged_hybrid';
}

function normalizePerformanceRun(row = {}, todayISO) {
  if (!isRunActivity(row)) return null;
  const date = String(row.date || '').slice(0, 10);
  const miles = Number(row.distance_miles || 0);
  const durationSeconds = Number(row.duration_seconds || 0);
  const paceSecondsPerMile = durationSeconds / miles;
  if (!parseISODate(date) || date > todayISO) return null;
  if (!Number.isFinite(miles) || miles < 0.5 || miles > 100) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 180 || durationSeconds > 172800) return null;
  if (!Number.isFinite(paceSecondsPerMile) || paceSecondsPerMile < 180 || paceSecondsPerMile > 1800) return null;
  return {
    id: row.id || null,
    date,
    miles,
    durationSeconds: Math.round(durationSeconds),
    paceSecondsPerMile,
    paceLabel: formatPaceLabel(paceSecondsPerMile),
    source: performanceSource(row),
  };
}

function equivalentTimeSeconds(run, targetMiles) {
  const sourceMiles = Number(run?.miles || 0);
  const sourceSeconds = Number(run?.durationSeconds || 0);
  const target = Number(targetMiles || 0);
  if (!(sourceMiles > 0) || !(sourceSeconds > 0) || !(target > 0)) return null;
  return Math.round(sourceSeconds * ((target / sourceMiles) ** 1.06));
}

function performanceAnchor(run, targetMiles, kind) {
  if (!run) return null;
  const equivalentSeconds = equivalentTimeSeconds(run, targetMiles);
  if (!equivalentSeconds) return null;
  return {
    kind,
    runId: run.id,
    date: run.date,
    source: run.source,
    observedDistanceMiles: round(run.miles, 3),
    observedDurationSeconds: run.durationSeconds,
    observedPaceSecondsPerMile: Math.round(run.paceSecondsPerMile),
    observedPaceLabel: run.paceLabel,
    targetDistanceMiles: round(targetMiles, 3),
    equivalentTimeSeconds: equivalentSeconds,
    equivalentPaceSecondsPerMile: Math.round(equivalentSeconds / targetMiles),
    equivalentPaceLabel: formatPaceLabel(equivalentSeconds / targetMiles),
  };
}

function anchoredByFromHistory(history = {}) {
  const anchor = history.performanceProfile?.targetAnchor || null;
  const equivalentTimeSeconds = Number(anchor?.equivalentTimeSeconds || 0);
  if (!(equivalentTimeSeconds > 0)) return null;
  return {
    runDate: anchor.date || null,
    equivalentTimeSeconds: Math.round(equivalentTimeSeconds),
    kind: anchor.kind || null,
    source: 'performance_anchor',
  };
}

function planAnchorMetadata(history = {}) {
  const anchoredBy = anchoredByFromHistory(history);
  return anchoredBy
    ? { anchorState: 'anchored', anchoredBy }
    : { anchorState: 'needs_benchmark' };
}

function durationIsEstimatedFromAnchorState(anchorState) {
  return anchorState !== 'anchored';
}

function bestDistanceRecord(runs, distance) {
  const candidates = runs.filter((run) => Math.abs(run.miles - distance.miles) / distance.miles <= 0.05);
  if (!candidates.length) return null;
  const best = candidates.slice().sort((left, right) => {
    const timeDelta = (left.paceSecondsPerMile * distance.miles) - (right.paceSecondsPerMile * distance.miles);
    return timeDelta || String(right.date).localeCompare(String(left.date));
  })[0];
  return {
    key: distance.key,
    label: distance.label,
    distanceMiles: distance.miles,
    ...performanceAnchor(best, distance.miles, 'observed_distance_band'),
  };
}

function chooseTargetAnchor(runs, targetDistanceMiles) {
  const target = Number(targetDistanceMiles || 0);
  if (!(target > 0)) return null;
  const exact = runs.filter((run) => Math.abs(run.miles - target) / target <= 0.05);
  const pool = exact.length
    ? exact
    : runs.filter((run) => run.miles >= 1 && run.miles / target >= 0.3 && run.miles / target <= 1.5);
  if (!pool.length) return null;
  const best = pool.slice().sort((left, right) => (
    equivalentTimeSeconds(left, target) - equivalentTimeSeconds(right, target)
    || String(right.date).localeCompare(String(left.date))
  ))[0];
  return performanceAnchor(best, target, exact.length ? 'observed_distance_band' : 'cross_distance_estimate');
}

function buildRunPerformanceProfile(rows = [], options = {}) {
  const todayISO = parseISODate(options.todayISO) ? options.todayISO : toISODate(new Date());
  const targetDistanceMiles = Number(options.targetDistanceMiles || 0);
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizePerformanceRun(row, todayISO))
    .filter(Boolean);
  const recent = normalized.filter((run) => {
    const ageDays = dateDistanceDays(todayISO, run.date);
    return ageDays !== null && ageDays >= 0 && ageDays <= PERFORMANCE_RECENCY_DAYS;
  });
  const records = STANDARD_PERFORMANCE_DISTANCES
    .map((distance) => bestDistanceRecord(normalized, distance))
    .filter(Boolean);
  const targetAnchor = chooseTargetAnchor(recent, targetDistanceMiles);
  const historicalTargetAnchor = targetAnchor ? null : chooseTargetAnchor(normalized, targetDistanceMiles);
  return {
    sampleCount: normalized.length,
    recentSampleCount: recent.length,
    sources: [...new Set(normalized.map((run) => run.source))].sort(),
    records,
    targetAnchor,
    historicalTargetAnchor,
    recencyDays: PERFORMANCE_RECENCY_DAYS,
  };
}

function buildGoalPaceContext(target = {}, history = {}, existingGoal = {}) {
  const targetPace = goalPaceSecondsPerMile(target, existingGoal, history);
  if (!targetPace) return null;
  const performanceProfile = history.performanceProfile || null;
  const anchor = performanceProfile?.targetAnchor || null;
  const recentRun = history.acuteRunLoad?.protectiveRun || history.acuteRunLoad?.latestRun || null;
  const anchorPace = Number(anchor?.equivalentPaceSecondsPerMile || 0);
  const recentPace = Number(recentRun?.paceSecondsPerMile || 0);
  const benchmarkPace = Number.isFinite(anchorPace) && anchorPace > 0 ? anchorPace : recentPace;
  let status = 'benchmark_needed';
  if (Number.isFinite(benchmarkPace) && benchmarkPace > 0) {
    if (targetPace <= benchmarkPace * 0.88) status = 'stretch';
    else if (targetPace < benchmarkPace * 0.97) status = 'build';
    else status = 'supported';
  }
  const benchmarkDescription = anchor
    ? (anchor.kind === 'observed_distance_band' ? 'best observed effort near this race distance' : 'cross-distance performance estimate')
    : 'latest logged run pace';
  const notes = {
    benchmark_needed: performanceProfile?.historicalTargetAnchor
      ? 'Only an older performance anchor is available. Use a controlled current benchmark before treating this target as proven.'
      : 'No recent run can confirm this target yet. Use the first controlled benchmark and live adaptations before treating it as proven.',
    stretch: `This is a stretch target relative to your ${benchmarkDescription}. Progressive race-specific work and a controlled benchmark should confirm it.`,
    build: `The target is faster than your ${benchmarkDescription} and needs progressive race-specific work.`,
    supported: `The target is compatible with your ${benchmarkDescription}, while execution and recovery still control progression.`,
  };
  return {
    status,
    targetPaceSecondsPerMile: targetPace,
    targetPaceLabel: formatPaceLabel(targetPace),
    benchmarkKind: anchor?.kind || (recentRun ? 'latest_run_fallback' : null),
    benchmarkPaceSecondsPerMile: Number.isFinite(benchmarkPace) && benchmarkPace > 0 ? Math.round(benchmarkPace) : null,
    benchmarkPaceLabel: formatPaceLabel(benchmarkPace),
    performanceAnchor: anchor,
    performanceSources: performanceProfile?.sources || [],
    recentRunPaceSecondsPerMile: Number.isFinite(recentPace) && recentPace > 0 ? Math.round(recentPace) : null,
    recentRunPaceLabel: formatPaceLabel(recentPace),
    recentRunDate: recentRun?.date || null,
    note: notes[status],
  };
}

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  if (Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day) return null;
  return date;
}

function isValidISODate(value) {
  return Boolean(parseISODate(value));
}

function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(iso, amount) {
  const date = parseISODate(iso);
  if (!date) return null;
  return toISODate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12));
}

function dateDistanceDays(laterValue, earlierValue) {
  const later = parseISODate(laterValue);
  const earlier = parseISODate(earlierValue);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function estimateWeeklyMileageBaseline(rows = [], options = {}) {
  const planningDateISO = parseISODate(options.planningDateISO) ? options.planningDateISO : toISODate(new Date());
  const profileWeeklyMiles = Math.max(0, Number(options.profileWeeklyMiles || 0));
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: String(row?.date || '').slice(0, 10),
      miles: Math.max(0, Number(row?.distance_miles || 0)),
      durationSeconds: Math.max(0, Number(row?.duration_seconds || 0)),
    }))
    .filter((row) => (
      parseISODate(row.date)
      && row.date <= planningDateISO
      && (row.miles >= 0.5 || row.durationSeconds >= 600)
    ));

  function weeklyAverage(windowDays) {
    const cutoff = addDays(planningDateISO, -(windowDays - 1));
    const included = normalized.filter((row) => row.date >= cutoff);
    if (!included.length) return 0;
    const earliest = included.reduce((value, row) => (row.date < value ? row.date : value), included[0].date);
    const observedDays = clamp((dateDistanceDays(planningDateISO, earliest) || 0) + 1, 7, windowDays);
    return included.reduce((sum, row) => sum + row.miles, 0) / (observedDays / 7);
  }

  const longTermWeeklyMiles = weeklyAverage(56);
  const recent28WeeklyMiles = weeklyAverage(28);
  const recent14WeeklyMiles = weeklyAverage(14);
  const boundedProfileMiles = longTermWeeklyMiles > 0 && profileWeeklyMiles > 0
    ? clamp(profileWeeklyMiles, longTermWeeklyMiles * 0.75, longTermWeeklyMiles * 1.25)
    : profileWeeklyMiles;
  const dataAnchor = Math.max(longTermWeeklyMiles, boundedProfileMiles) || recent28WeeklyMiles || recent14WeeklyMiles;
  let weeklyMiles = dataAnchor || profileWeeklyMiles;
  if (dataAnchor > 0) {
    const recentHigh = Math.max(recent28WeeklyMiles, recent14WeeklyMiles);
    const upperBound = Math.max(dataAnchor * 1.25, dataAnchor + 2);
    weeklyMiles = Math.min(Math.max(dataAnchor, recentHigh), upperBound);
  }

  return {
    weeklyMiles: round(weeklyMiles),
    longTermWeeklyMiles: round(longTermWeeklyMiles),
    recent28WeeklyMiles: round(recent28WeeklyMiles),
    recent14WeeklyMiles: round(recent14WeeklyMiles),
    meaningfulRunCount: normalized.length,
    method: normalized.length ? 'bounded_recent_history' : 'profile_fallback',
  };
}

function mondayFor(value) {
  const date = parseISODate(value) || new Date();
  const offset = (date.getDay() + 6) % 7;
  return toISODate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset, 12));
}

function racePlanWindow(raceDateValue, planningDateValue) {
  const raceDate = parseISODate(raceDateValue);
  const planningDate = parseISODate(planningDateValue);
  if (!raceDate || !planningDate || raceDate < planningDate) return null;
  const currentMonday = mondayFor(planningDateValue);
  const raceWeekMonday = mondayFor(raceDateValue);
  let startDate = currentMonday;
  const rawWeeks = Math.floor((parseISODate(raceWeekMonday) - parseISODate(startDate)) / (7 * 86400000)) + 1;
  const weeks = clamp(rawWeeks, 1, 20);
  if (rawWeeks > 20) startDate = addDays(raceWeekMonday, -(weeks - 1) * 7);
  return { startDate, weeks, startsLater: startDate > currentMonday };
}

function normalizeWeekdays(values, fallback) {
  const source = Array.isArray(values) ? values : [];
  const normalized = source
    .map((value) => DAY_ORDER.find((day) => day.toLowerCase() === String(value || '').slice(0, 3).toLowerCase()))
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  return unique.length ? DAY_ORDER.filter((day) => unique.includes(day)) : fallback.slice();
}

function resolvePlanMode(profile = {}, target = {}) {
  const explicit = String(target.planMode || target.plan_mode || '').toLowerCase();
  if (VALID_MODES.has(explicit)) return explicit;
  if (target.liftingEnabled === false || Number(target.liftDaysPerWeek) === 0) return planSchema.PLAN_MODES.RUN_ONLY;
  const strengthGoal = String(target.strengthGoal || target.strength_goal || '').toLowerCase();
  if (strengthGoal === 'build' || strengthGoal === 'size') return planSchema.PLAN_MODES.HYBRID_BUILD;
  if (target.liftingEnabled === true || Number(target.liftDaysPerWeek || profile.lift_days_per_week) > 0) {
    return planSchema.PLAN_MODES.HYBRID_MAINTAIN;
  }
  return planSchema.PLAN_MODES.RUN_ONLY;
}

function phaseForWeek(weekNumber, weekCount, hasRace) {
  if (hasRace && weekNumber === weekCount) return 'race';
  if (hasRace && weekNumber === weekCount - 1) return 'taper';
  if (weekNumber === weekCount || (hasRace && weekNumber === weekCount - 2)) return 'peak';
  if (weekNumber % 4 === 0) return 'deload';
  const baseWeeks = Math.max(2, Math.floor((weekCount - (hasRace ? 3 : 1)) * 0.4));
  return weekNumber <= baseWeeks ? 'base' : 'build';
}

function normalizedRaceTargets(target = {}) {
  const supplied = Array.isArray(target.raceTargets) ? target.raceTargets : [];
  const source = supplied.length ? supplied : (parseISODate(target.raceDate) ? [target] : []);
  if (supplied.length > 2) throw new RangeError('A plan can protect no more than two race goals');
  if (supplied.some((race) => !race || !parseISODate(race.raceDate))) {
    throw new TypeError('Every protected race goal must include a valid raceDate');
  }
  const normalized = source
    .map((race) => ({ ...race }))
    .sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)));
  if (new Set(normalized.map((race) => race.raceDate)).size !== normalized.length) {
    throw new RangeError('Protected race goals must use different dates');
  }
  if (normalized.length === 2) {
    const gapDays = Math.round((parseISODate(normalized[1].raceDate) - parseISODate(normalized[0].raceDate)) / 86400000);
    if (gapDays < 21) throw new RangeError('Two PR race goals must be at least 21 days apart');
  }
  return normalized;
}

function raceTargetForDate(dateISO, raceTargets = []) {
  return raceTargets.find((race) => race.raceDate === dateISO) || null;
}

function activeRaceTargetForWeek(weekStart, raceTargets = [], fallback = {}) {
  const weekEnd = addDays(weekStart, 6);
  return raceTargets.find((race) => race.raceDate >= weekStart && race.raceDate <= weekEnd)
    || raceTargets.find((race) => race.raceDate > weekEnd)
    || raceTargets[raceTargets.length - 1]
    || fallback;
}

function phasesForRaceTargets(startDate, weekCount, raceTargets = []) {
  if (raceTargets.length <= 1) {
    return Array.from({ length: weekCount }, (_, index) => phaseForWeek(index + 1, weekCount, raceTargets.length === 1));
  }
  const raceWeekIndexes = raceTargets.map((race) => (
    Math.floor((parseISODate(mondayFor(race.raceDate)) - parseISODate(startDate)) / (7 * 86400000))
  ));
  return Array.from({ length: weekCount }, (_, index) => {
    if (raceWeekIndexes.includes(index)) return 'race';
    if (raceWeekIndexes.some((raceIndex) => index === raceIndex - 1)) return 'taper';
    if (raceWeekIndexes.slice(0, -1).some((raceIndex) => index === raceIndex + 1)) return 'deload';
    if (raceWeekIndexes.some((raceIndex) => index === raceIndex - 2)) return 'peak';
    return phaseForWeek(index + 1, weekCount, true);
  });
}

function distanceCategory(distanceMiles) {
  const distance = Number(distanceMiles || 0);
  if (distance >= 20) return 'marathon';
  if (distance >= 11) return 'half';
  if (distance >= 5.5) return '10k';
  return '5k';
}

function maxLongRun(distanceMiles) {
  const category = distanceCategory(distanceMiles);
  if (category === 'marathon') return 20;
  if (category === 'half') return 12;
  if (category === '10k') return 10;
  return 6;
}

function buildMileageTargets(weekCount, baseline, hasRace, recovery, history, target = {}) {
  const targets = [];
  // Recovery and check-in state change the next 48-72 hours through
  // applyAcuteRunProtection. They must not silently shrink an entire block.
  let lastBuild = Math.max(4, Number(baseline || 0));
  let priorBuild = lastBuild;
  const goalType = String(target.goalType || target.goal_type || '').toLowerCase();
  const growthRate = hasRace && (goalType === 'pr' || Number(target.goalTimeSeconds || target.goal_time_seconds) > 0) ? 1.08 : 1.06;
  for (let weekNumber = 1; weekNumber <= weekCount; weekNumber += 1) {
    const phase = target.weekPhases?.[weekNumber - 1] || phaseForWeek(weekNumber, weekCount, hasRace);
    let mileageTarget;
    if (phase === 'deload') {
      mileageTarget = priorBuild * 0.8;
    } else if (phase === 'taper') {
      mileageTarget = priorBuild * 0.65;
    } else if (phase === 'race') {
      mileageTarget = priorBuild * 0.45;
    } else if (weekNumber === 1) {
      mileageTarget = lastBuild;
      priorBuild = mileageTarget;
    } else {
      mileageTarget = priorBuild * (phase === 'peak' ? 1.04 : growthRate);
      priorBuild = mileageTarget;
    }
    lastBuild = mileageTarget;
    targets.push(round(mileageTarget));
  }
  return targets;
}

function selectRunDays(availableDays, count) {
  const parsedCount = Number(count);
  const wanted = clamp(Number.isFinite(parsedCount) ? Math.round(parsedCount) : 3, 0, 6);
  const preferred = ['Tue', 'Thu', 'Sat', 'Sun', 'Wed', 'Mon', 'Fri'];
  const ordered = [
    ...preferred.filter((day) => availableDays.includes(day)),
    ...availableDays.filter((day) => !preferred.includes(day)),
  ];
  return DAY_ORDER.filter((day) => ordered.slice(0, Math.min(wanted, availableDays.length)).includes(day));
}

function currentWeekRunSchedule({ weekStart, todayISO, currentWeekLoad, runSchedule, raceDay = null }) {
  const weekEnd = addDays(weekStart, 6);
  if (!currentWeekLoad
    || currentWeekLoad.startDate !== weekStart
    || !parseISODate(todayISO)
    || todayISO < weekStart
    || todayISO > weekEnd) {
    return null;
  }

  const completedRunDates = new Set(
    (Array.isArray(currentWeekLoad.runDates) ? currentWeekLoad.runDates : [])
      .map((date) => String(date || '').slice(0, 10))
      .filter((date) => parseISODate(date) && date >= weekStart && date <= todayISO)
  );
  const reportedCompletedRuns = Math.max(0, Math.floor(Number(currentWeekLoad.runCount) || 0));
  const completedMeaningfulRuns = Math.max(reportedCompletedRuns, completedRunDates.size);
  const completedRunsAppliedToQuota = Math.min(completedMeaningfulRuns, runSchedule.runDaysPerWeek);
  const remainingRunQuota = Math.max(0, runSchedule.runDaysPerWeek - completedRunsAppliedToQuota);
  const eligibleSelectedDays = runSchedule.trainingDays.filter((day) => {
    const date = addDays(weekStart, DAY_ORDER.indexOf(day));
    return date >= todayISO && !completedRunDates.has(date);
  });
  const raceDate = raceDay ? addDays(weekStart, DAY_ORDER.indexOf(raceDay)) : null;
  const scheduleRace = Boolean(
    raceDay
    && raceDate >= todayISO
    && !completedRunDates.has(raceDate)
  );
  const selectedQuota = Math.max(0, remainingRunQuota - Number(scheduleRace));
  const selectedRunDays = selectRunDays(
    eligibleSelectedDays.filter((day) => day !== raceDay),
    selectedQuota
  );
  const runDays = DAY_ORDER.filter((day) => selectedRunDays.includes(day) || (scheduleRace && day === raceDay));

  return {
    completedRunDates,
    completedMeaningfulRuns,
    completedRunsAppliedToQuota,
    remainingRunQuota,
    eligibleSelectedDays,
    runDays,
  };
}

function partialCurrentWeekConstraint(quota, requestedRunDaysPerWeek, scheduledRunCount = quota?.runDays?.length || 0) {
  if (!quota || scheduledRunCount >= requestedRunDaysPerWeek) return null;
  return {
    status: 'partial_current_week',
    requestedRunDaysPerWeek,
    completedMeaningfulRuns: quota.completedMeaningfulRuns,
    completedRunsAppliedToQuota: quota.completedRunsAppliedToQuota,
    remainingRunQuota: quota.remainingRunQuota,
    scheduledRunCount,
    totalRunsTowardTarget: quota.completedRunsAppliedToQuota + scheduledRunCount,
    protectedRaceBeyondQuota: quota.remainingRunQuota === 0 && scheduledRunCount > 0,
    explanation: quota.remainingRunQuota === 0 && scheduledRunCount > 0
      ? `The normal weekly run quota is complete, but the protected race remains on its exact date. The full ${requestedRunDaysPerWeek}-day selected frequency starts next week.`
      : `This current week is partial: completed runs and remaining selected weekdays set the sessions shown. The full ${requestedRunDaysPerWeek}-day selected frequency starts next week.`,
  };
}

function runTypeFor(day, runDays, phase, options = {}) {
  const position = runDays.indexOf(day);
  if (position === 0 && runDays.length === 1 && phase === 'taper' && options.hasTimedGoal) return 'sharpen';
  if (position === runDays.length - 1) return 'long';
  if (position === 0 && (runDays.length >= 3 || (options.hasTimedGoal && runDays.length >= 2))) {
    if (phase === 'base') return options.weekNumber % 2 === 0 ? 'quality' : 'hills';
    if (phase === 'taper') return 'sharpen';
    if (options.hasTimedGoal && (phase === 'peak' || (phase === 'build' && options.weekNumber % 2 === 0))) return 'race_pace';
    return 'quality';
  }
  return position === 1 && runDays.length >= 4 ? 'steady' : 'easy';
}

function timedTaperMinimumDistance(type) {
  if (type === 'sharpen' || type === 'steady' || type === 'long') return 1.5;
  return 1;
}

function selectTimedTaperRunDays(runDays, totalMiles, options = {}) {
  if (!Array.isArray(runDays) || runDays.length <= 1) return runDays;
  const availableMiles = round(Math.max(0, Number(totalMiles || 0)));

  for (let count = runDays.length; count >= 1; count -= 1) {
    let candidate;
    if (count === 1) {
      candidate = [runDays[0]];
    } else if (count === 2) {
      candidate = [runDays[0], runDays[runDays.length - 1]];
    } else {
      const middle = selectRunDays(runDays.slice(1, -1), count - 2);
      const selected = new Set([runDays[0], ...middle, runDays[runDays.length - 1]]);
      candidate = DAY_ORDER.filter((day) => selected.has(day));
    }
    const requiredMiles = round(candidate.reduce((sum, day) => (
      sum + timedTaperMinimumDistance(runTypeFor(day, candidate, 'taper', {
        ...options,
        hasTimedGoal: true,
      }))
    ), 0));
    if (availableMiles + 0.05 >= requiredMiles) return candidate;
  }

  return runDays;
}

function preserveTimedTaperDistance(distances, minimumDistances = []) {
  if (!Array.isArray(distances) || !distances.length || minimumDistances.length !== distances.length) return distances;
  const totalUnits = Math.round(distances.reduce((sum, distance) => sum + Number(distance || 0), 0) * 10);
  const floorUnits = minimumDistances.map((distance) => Math.round(Number(distance || 0) * 10));
  const floorTotalUnits = floorUnits.reduce((sum, distance) => sum + distance, 0);
  if (totalUnits < floorTotalUnits) return distances;

  const currentUnits = distances.map((distance) => Math.round(Number(distance || 0) * 10));
  if (currentUnits.every((distance, index) => distance >= floorUnits[index])) return distances;

  const extraUnits = totalUnits - floorTotalUnits;
  const weights = currentUnits.map((distance, index) => Math.max(0, distance - floorUnits[index]));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = floorUnits.slice();
  if (extraUnits > 0 && weightTotal > 0) {
    const exactExtras = weights.map((weight) => extraUnits * weight / weightTotal);
    const assignedExtras = exactExtras.map(Math.floor);
    let unassigned = extraUnits - assignedExtras.reduce((sum, units) => sum + units, 0);
    const byRemainder = exactExtras
      .map((value, index) => ({ index, remainder: value - assignedExtras[index] }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of byRemainder) {
      if (unassigned <= 0) break;
      assignedExtras[index] += 1;
      unassigned -= 1;
    }
    assignedExtras.forEach((units, index) => { allocations[index] += units; });
  } else if (extraUnits > 0) {
    allocations[allocations.length - 1] += extraUnits;
  }
  return allocations.map((units) => units / 10);
}

function allocateRunDistances(totalMiles, runDays, phase, raceDistance, raceDay, options = {}) {
  if (!runDays.length) return [];
  if (raceDay) {
    const easyDays = Math.max(0, runDays.length - 1);
    const easyTotal = Math.max(0, totalMiles - raceDistance);
    return runDays.map((day) => (day === raceDay ? Number(raceDistance) : round(easyTotal / Math.max(1, easyDays))));
  }
  if (runDays.length === 1) return [round(Math.max(0.1, Math.min(maxLongRun(raceDistance), totalMiles)))];
  if (options.longRunCompleted) {
    const totalUnits = Math.max(runDays.length, Math.round(Number(totalMiles || 0) * 10));
    const baseUnits = Math.floor(totalUnits / runDays.length);
    let remainder = totalUnits - (baseUnits * runDays.length);
    const equalDistances = runDays.map(() => {
      const units = baseUnits + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      return units / 10;
    });
    return phase === 'taper' && options.preserveTimedTaperSharpening
      ? preserveTimedTaperDistance(equalDistances, options.minimumDistances)
      : equalDistances;
  }
  const longShare = phase === 'taper' ? 0.3 : phase === 'base' ? 0.42 : 0.45;
  const qualityShare = runDays.length >= 3 ? 0.22 : 0;
  const recentLongMiles = Number(options.recentLongMiles || 0);
  const recentLongFloor = options.weekNumber <= 3 && ['base', 'build'].includes(phase) && recentLongMiles > 0
    ? recentLongMiles * (0.75 + (options.weekNumber * 0.05))
    : 0;
  const longDistance = Math.min(
    maxLongRun(raceDistance),
    totalMiles * 0.55,
    Math.max(totalMiles * longShare, recentLongFloor)
  );
  const qualityDistance = totalMiles * qualityShare;
  const remainingSlots = Math.max(1, runDays.length - (qualityShare ? 2 : 1));
  const easyDistance = Math.max(0.1, (totalMiles - longDistance - qualityDistance) / remainingSlots);
  const raw = runDays.map((day, index) => {
    if (index === runDays.length - 1) return round(longDistance);
    if (index === 0 && qualityShare) return round(qualityDistance);
    return round(easyDistance);
  });
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  const scale = rawTotal > 0 && totalMiles > 0 ? totalMiles / rawTotal : 1;
  const scaled = raw.map((value) => round(Math.max(0.1, value * scale)));
  return phase === 'taper' && options.preserveTimedTaperSharpening
    ? preserveTimedTaperDistance(scaled, options.minimumDistances)
    : scaled;
}

function durationForRun(type, distance, phase, history = {}) {
  const recentPace = Number(history.acuteRunLoad?.latestRun?.paceSecondsPerMile || 0);
  const basePaceSeconds = clamp(recentPace || 720, 360, 1200);
  const effortFactor = type === 'recovery' ? 1.15 : ['easy', 'long'].includes(type) ? 1.08 : type === 'steady' ? 1 : 0.92;
  const estimatedMinutes = Number(distance || 0) * basePaceSeconds * effortFactor / 60;
  if (type === 'long') return Math.round(clamp(estimatedMinutes, 30, phase === 'taper' ? 75 : 105));
  if (type === 'quality' || type === 'race_pace') return Math.round(clamp(estimatedMinutes, 48, 65));
  if (type === 'hills') return Math.round(clamp(estimatedMinutes, 42, 65));
  if (type === 'sharpen') return Math.round(clamp(estimatedMinutes, 35, 48));
  if (type === 'steady') return Math.round(clamp(estimatedMinutes, 25, 60));
  if (type === 'recovery') return Math.round(clamp(estimatedMinutes, 15, 35));
  return Math.round(clamp(estimatedMinutes, 15, 50));
}

function durationForWorkout(workoutId, fallbackMinutes, options = {}) {
  if (workoutId === 'race_pace_intervals') {
    const progress = Number(options.weekNumber || 1) / Math.max(1, Number(options.weekCount || 1));
    const workMinutes = progress >= 0.75 ? 10 : progress >= 0.55 ? 8 : 6;
    // Warm-up + four strides + three work intervals + two between-rep recoveries + cooldown.
    return Math.ceil(15 + (4 * 20 / 60) + (3 * workMinutes) + (2 * 3) + 10);
  }
  const durations = {
    strides: 35,
    short_hill_sprints: 40,
    aerobic_hill_repeats: 45,
    uphill_threshold_repeats: 52,
    fartlek: 42,
    short_intervals: 45,
    long_intervals: 52,
    tempo_threshold: 55,
    progression_run: 45,
    sharpening_strides: 35,
  };
  return durations[workoutId] || fallbackMinutes;
}

function runPrescription(type, phase, hilly, options = {}) {
  const goalPaceLabel = options.goalPaceLabel || null;
  if (type === 'race_pace' && goalPaceLabel) {
    const progress = Number(options.weekNumber || 1) / Math.max(1, Number(options.weekCount || 1));
    const work = progress >= 0.75
      ? ['3 x 10 min at goal pace', '3 min easy jog between repetitions']
      : progress >= 0.55
        ? ['3 x 8 min at goal pace', '3 min easy jog between repetitions']
        : ['3 x 6 min at goal pace', '3 min easy jog between repetitions'];
    return {
      title: 'Goal-pace intervals',
      target_zone: 'Race-specific effort',
      pace_target: `${goalPaceLabel} during work intervals`,
      intensity: 'Controlled goal pace',
      warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
      steps: [...work, ...(options.goalPaceStatus === 'stretch' ? ['Stop the work block if goal pace becomes a sprint or form deteriorates'] : [])],
      cooldown: ['10 min easy running'],
      progression: 'Complete every repetition evenly before extending the total time at goal pace.',
      description: 'Practice the exact race target in controlled segments without turning the full run into a time trial.',
    };
  }
  if (type === 'long') {
    return {
      title: hilly ? 'Course-specific long run' : 'Long aerobic run',
      target_zone: 'Zone 2',
      pace_target: 'Conversational effort',
      intensity: 'Easy aerobic',
      warmup: ['10 min very easy running', 'Dynamic ankle and hip mobility'],
      steps: hilly ? ['Settle into Zone 2', 'Run rolling terrain without forcing climbs', 'Finish the final 10 min controlled'] : ['Settle into Zone 2', 'Hold even effort through the middle', 'Finish smooth without racing'],
      cooldown: ['5-10 min easy walk or jog'],
      progression: 'Add distance only when the prior long run was completed without lingering pain or fatigue.',
      description: hilly ? 'Build durable aerobic strength for a rolling course.' : 'Build endurance while preserving the rest of the training week.',
    };
  }
  if (type === 'quality' || type === 'hills' || type === 'sharpen') {
    const sharpen = type === 'sharpen';
    const hillSession = type === 'hills' || (hilly && !(sharpen && goalPaceLabel));
    return {
      title: hillSession ? (phase === 'taper' ? 'Hill strides' : 'Controlled hill repeats') : (phase === 'taper' ? 'Race-pace sharpening' : 'Threshold intervals'),
      target_zone: sharpen && goalPaceLabel ? 'Race-specific effort' : phase === 'base' ? 'Zone 3' : 'Zone 3-4',
      pace_target: hillSession ? 'Controlled uphill effort' : sharpen && goalPaceLabel ? `${goalPaceLabel} during work intervals` : 'Current threshold effort',
      intensity: phase === 'taper' ? 'Short and controlled' : 'Hard but repeatable',
      warmup: sharpen ? ['10 min easy running', '4 x 20 sec relaxed strides'] : ['12 min easy running', '4 x 20 sec relaxed strides'],
      steps: sharpen
        ? [`6 x 60 sec at ${goalPaceLabel || 'goal race effort'}`, '90 sec easy jog between repetitions']
        : hillSession
          ? ['6-8 x 60 sec uphill', '90 sec easy jog down between repetitions']
          : ['4 x 5 min controlled hard', '2 min easy jog between repetitions'],
      cooldown: [sharpen ? '8 min easy running' : '10 min easy running'],
      progression: 'Add one repeat only after completing every repetition at even effort.',
      description: hilly ? 'Develop course-specific climbing strength without sprinting.' : (hillSession ? 'Build general climbing strength and durability without sprinting.' : 'Raise sustainable speed without turning the session into a race.'),
    };
  }
  if (type === 'steady') {
    return {
      title: 'Steady aerobic run', target_zone: 'Zone 2-3', pace_target: 'Comfortably steady', intensity: 'Moderate',
      warmup: ['8 min easy running'], steps: ['Run the middle continuously at steady effort'], cooldown: ['5 min easy running'],
      progression: 'Extend the steady segment by five minutes before increasing pace.', description: 'Bridge easy volume and race-specific work.',
    };
  }
  return {
    title: 'Easy aerobic run', target_zone: 'Zone 2', pace_target: 'Conversational effort', intensity: 'Easy',
    warmup: ['5-10 min relaxed running'], steps: ['Hold a pace that allows full sentences'], cooldown: ['Walk 3-5 min'],
    progression: 'Keep the effort easy; consistency matters more than pace.', description: 'Build aerobic volume while staying fresh for quality and strength work.',
  };
}

function buildRunSession({ weekNumber, weekCount, day, type, workoutId, distance, phase, hilly, raceName, history, goalPaceContext, durationIsEstimated = true }) {
  const goalPace = goalPaceContext?.targetPaceSecondsPerMile || null;
  const goalPaceLabel = goalPaceContext?.targetPaceLabel || null;
  if (type === 'race') {
    return {
      id: `h3-w${weekNumber}-${day.toLowerCase()}-run`, kind: 'run', type: 'race', workout_type: 'run',
      workout_id: 'race', workout_family: 'race',
      prescription_basis: 'distance',
      title: raceName || 'Race day', distance_miles: Number(distance), target_zone: 'Race effort', pace_target: goalPaceLabel || 'Goal race effort', intensity: 'Race',
      warmup: ['10-15 min easy', '4 x 20 sec relaxed strides'], steps: ['Start controlled', 'Settle into goal effort', 'Race by effort over late hills'],
      cooldown: ['Walk until breathing settles'], progression: 'Execute the prepared race plan.', description: 'Race-day execution.',
      evidence_refs: trainingEvidence.runEvidenceRefs('race'),
      ...(goalPace ? { goal_pace_seconds_per_mile: goalPace, goal_pace_label: goalPaceLabel } : {}),
    };
  }
  const estimatedDistance = round(Math.max(0.1, distance));
  const taxonomyWorkout = runWorkoutTaxonomy.workoutForId(workoutId);
  const effectiveType = taxonomyWorkout?.type || type;
  const usesGoalPace = goalPace && ['race_pace_intervals', 'sharpening_strides'].includes(workoutId);
  const canonicalPrescription = runWorkoutTaxonomy.prescriptionFor(workoutId, {
    phase,
    weekNumber,
    weekCount,
    goalPaceLabel,
  });
  const fallbackDuration = durationForRun(effectiveType, estimatedDistance, phase, history);
  return {
    id: `h3-w${weekNumber}-${day.toLowerCase()}-run`, kind: 'run', type: effectiveType, workout_type: 'run',
    workout_id: workoutId || runWorkoutTaxonomy.workoutIdForSession(effectiveType),
    workout_family: taxonomyWorkout?.family || effectiveType,
    prescription_basis: 'time',
    duration_min: durationForWorkout(workoutId, fallbackDuration, { weekNumber, weekCount }),
    durationIsEstimated: Boolean(durationIsEstimated),
    distance_miles: estimatedDistance,
    distance_is_estimate: true,
    evidence_refs: trainingEvidence.runEvidenceRefs(workoutId || effectiveType),
    ...(usesGoalPace ? { goal_pace_seconds_per_mile: goalPace, goal_pace_label: goalPaceLabel } : {}),
    ...(canonicalPrescription || runPrescription(effectiveType, phase, hilly, {
      weekNumber,
      weekCount,
      goalPaceLabel,
      goalPaceStatus: goalPaceContext?.status,
    })),
  };
}

function buildBenchmarkRunSession(session = {}) {
  const totalDistanceMiles = round(Math.max(1, Number(session.distance_miles || 0) || 1));
  const next = {
    ...session,
    type: 'benchmark',
    workout_type: 'run',
    workout_id: 'benchmark_mile',
    workout_family: 'benchmark',
    title: 'Benchmark run',
    prescription_basis: 'distance',
    distance_miles: totalDistanceMiles,
    distance_is_estimate: false,
    benchmark: true,
    benchmark_distance_miles: 1,
    anchorState: 'needs_benchmark',
    target_zone: 'Moderate time-trial effort',
    pace_target: 'Strong, even 1-mile effort by feel',
    intensity: 'Benchmark',
    warmup: ['10 min easy running', '4 x 20 sec relaxed strides'],
    quality_prescription: {
      repetitions: 1,
      work: '1 mile at a strong, controlled effort',
      recovery: { type: 'easy cooldown', duration: '10 min' },
      target: 'Even pacing; finish knowing one more repetition was possible',
    },
    steps: ['Run 1 mile at a strong but controlled effort', 'Start slightly conservative, then hold even effort', 'Record the finish time for target calibration'],
    cooldown: ['10 min easy running', 'Walk 3-5 min until breathing settles'],
    progression: 'Use the result to calibrate plan targets before adding goal-pace work.',
    description: 'Calibrate training targets with a controlled 1-mile benchmark instead of guessing from a default pace.',
    purpose: 'Establish a measured performance anchor before prescribing exact pace targets.',
    evidence_refs: trainingEvidence.runEvidenceRefs('quality'),
  };
  delete next.duration_min;
  delete next.durationIsEstimated;
  delete next.goal_pace_seconds_per_mile;
  delete next.goal_pace_label;
  return next;
}

function buildLiftSession({ weekNumber, day, focus, mode, phase, context = {} }) {
  const build = mode === planSchema.PLAN_MODES.HYBRID_BUILD;
  const main = strengthPrescription.buildStrengthExercises({
    weekNumber,
    focus,
    mode,
    phase,
    equipment: context.target?.equipment,
    history: context.history,
    recovery: context.recovery,
  });
  return {
    id: `h3-w${weekNumber}-${day.toLowerCase()}-lift`, kind: 'lift', type: 'strength', workout_type: 'strength',
    title: `${build ? planSchema.STRENGTH_BUILD_TITLE : planSchema.STRENGTH_MAINTAIN_TITLE} - ${focus}`,
    focus,
    warmup: focus === 'Lower body' ? ['5 min easy cardio', 'Bodyweight squat x 10', 'Two progressive warm-up sets'] : ['Band pull-apart x 20', 'Scapular push-up x 10', 'Two progressive warm-up sets'],
    main,
    prescriptionBasis: strengthPrescription.prescriptionBasis({
      phase,
      mode,
      recovery: context.recovery,
      checkin: context.checkin,
    }, main),
    recovery: ['Leave at least one full day before repeating the same focus', 'Prioritize protein, carbohydrate, and sleep'],
    progression: phase === 'taper' || phase === 'race' ? 'Reduce volume and preserve movement quality.' : build ? 'Progress load or reps weekly while keeping one to two reps in reserve.' : 'Hold strength with repeatable submaximal work.',
    description: build ? 'Build strength and size alongside the running block.' : 'Maintain strength and size while run volume develops.',
    evidence_refs: trainingEvidence.strengthEvidenceRefs(),
  };
}

function dateInRange(date, start, end) {
  return Boolean(parseISODate(date) && parseISODate(start) && parseISODate(end) && date >= start && date <= end);
}

function recoveryRunAfterRecentLoad(session, latestRun) {
  const distance = Number(session.distance_miles || 0);
  const duration = Math.round(clamp(Number(session.duration_min || 25) * 0.65, 20, 35));
  return {
    ...session,
    type: 'recovery',
    workout_type: 'recovery',
    workout_id: 'recovery_run',
    workout_family: 'recovery',
    title: 'Recovery run',
    prescription_basis: 'time',
    duration_min: duration,
    distance_miles: round(Math.max(0.5, Math.min(3, distance * 0.65))),
    distance_is_estimate: true,
    target_zone: 'Zone 1-2',
    pace_target: 'Fully conversational; walking is allowed',
    intensity: 'Recovery',
    warmup: ['5 min easy walking'],
    steps: ['Keep breathing relaxed', 'Stop if soreness changes your stride'],
    cooldown: ['5 min easy walking', 'Hydrate and refuel'],
    progression: 'Keep the full session within the prescribed time today.',
    description: `Reduced because a ${round(latestRun.distanceMiles, 1)} mi recent run already created meaningful lower-body load.`,
    evidence_refs: trainingEvidence.runEvidenceRefs('recovery'),
    acuteLoadAdjusted: true,
  };
}

function replaceLiftFocus(session, { weekNumber, day, focus, mode, phase, context }) {
  return {
    ...buildLiftSession({ weekNumber, day, focus, mode, phase, context }),
    id: session.id,
    acuteLoadAdjusted: true,
  };
}

function acuteLoadMetadata(history = {}) {
  const load = history.acuteRunLoad;
  if (!load?.available || !load.latestRun) return null;
  const protectiveRun = load.protectiveRun || null;
  return {
    latestRun: {
      date: load.latestRun.date,
      distanceMiles: load.latestRun.distanceMiles,
      durationMinutes: load.latestRun.durationMinutes,
      paceLabel: load.latestRun.paceLabel,
      avgHeartRate: load.latestRun.avgHeartRate,
      perceivedEffort: load.latestRun.perceivedEffort,
      postRunPain: load.latestRun.postRunPain,
      postRunEnergy: load.latestRun.postRunEnergy,
      isLong: Boolean(load.latestRun.isLong),
      isHard: Boolean(load.latestRun.isHard),
    },
    protectiveRun: protectiveRun ? {
      date: protectiveRun.date,
      distanceMiles: protectiveRun.distanceMiles,
      durationMinutes: protectiveRun.durationMinutes,
      paceLabel: protectiveRun.paceLabel,
      avgHeartRate: protectiveRun.avgHeartRate,
      perceivedEffort: protectiveRun.perceivedEffort,
      postRunPain: protectiveRun.postRunPain,
      postRunEnergy: protectiveRun.postRunEnergy,
      isLong: Boolean(protectiveRun.isLong),
      isHard: Boolean(protectiveRun.isHard),
    } : null,
    sevenDayMiles: load.sevenDayMiles,
    loadRatio: load.loadRatio,
    currentWeek: load.currentWeek || null,
    protection: load.protection || { active: false },
  };
}

function applyAcuteRunProtection(plan, context = {}) {
  const load = context.history?.acuteRunLoad;
  if (!load?.protection?.active || !load.latestRun) return plan;
  const next = JSON.parse(JSON.stringify(plan));
  const protection = load.protection;
  const anchorRun = load.protectiveRun || load.latestRun;
  const anchorDate = protection.anchorDate || anchorRun.date;
  const availableDays = new Set(normalizeWeekdays(
    context.target?.trainingDays,
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  ));
  let changed = false;

  for (const week of next.weeks || []) {
    const days = Array.isArray(week.days) ? week.days : [];
    let weekChanged = false;

    for (const day of days) {
      const sessions = Array.isArray(day.sessions) ? day.sessions : [];
      const rebuilt = [];
      for (const session of sessions) {
        if (session.kind !== 'run' || String(session.type || '').toLowerCase() === 'race') {
          rebuilt.push(session);
          continue;
        }
        if (protection.noAdditionalRunOnDate && day.date === protection.noAdditionalRunOnDate) {
          changed = true;
          weekChanged = true;
          day.status = 'adjusted';
          day.whyToday = `Your ${round(load.latestRun.distanceMiles, 1)} mi run is already logged for today, so Forged Hybrid did not schedule a second run.`;
          continue;
        }
        if (protection.postRunSevere && dateInRange(day.date, anchorDate, protection.hardRunsThrough)) {
          changed = true;
          weekChanged = true;
          day.status = 'adjusted';
          day.whyToday = `Running is held through ${protection.hardRunsThrough} after severe post-run pain was reported on ${anchorDate}.`;
          continue;
        }
        if (isDemandingRun(session) && dateInRange(day.date, anchorDate, protection.hardRunsThrough)) {
          rebuilt.push(recoveryRunAfterRecentLoad(session, anchorRun));
          changed = true;
          weekChanged = true;
          day.status = 'adjusted';
          day.whyToday = `Adjusted after your ${round(anchorRun.distanceMiles, 1)} mi run on ${anchorDate}: hard running is protected through ${protection.hardRunsThrough}.`;
          continue;
        }
        rebuilt.push(session);
      }
      day.sessions = rebuilt;
    }

    const hardIndexes = new Set();
    days.forEach((day, index) => {
      if ((day.sessions || []).some((session) => isHardRun(session))) hardIndexes.add(index);
    });
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const day = days[dayIndex];
      const lowerIndex = (day.sessions || []).findIndex((session) => session.kind === 'lift' && /lower/i.test(String(session.focus || '')));
      if (lowerIndex < 0 || !dateInRange(day.date, anchorDate, protection.lowerBodyThrough)) continue;
      const laterUpperDayIndex = days.findIndex((candidate, candidateIndex) => (
        candidateIndex > dayIndex
        && candidate.date > protection.lowerBodyThrough
        && [...hardIndexes].every((hardIndex) => Math.abs(hardIndex - candidateIndex) > 1)
        && (candidate.sessions || []).some((session) => session.kind === 'lift' && /upper/i.test(String(session.focus || '')))
      ));
      const originalLower = day.sessions[lowerIndex];
      day.status = 'adjusted';
      if (laterUpperDayIndex >= 0) {
        day.sessions[lowerIndex] = replaceLiftFocus(originalLower, {
          weekNumber: week.week,
          day: day.day,
          focus: 'Upper body',
          mode: next.planMode,
          phase: week.phase,
          context,
        });
        day.whyToday = `Lower-body strength was moved outside the recovery window from your ${round(anchorRun.distanceMiles, 1)} mi run.`;
        const laterDay = days[laterUpperDayIndex];
        const upperIndex = laterDay.sessions.findIndex((session) => session.kind === 'lift' && /upper/i.test(String(session.focus || '')));
        laterDay.sessions[upperIndex] = replaceLiftFocus(laterDay.sessions[upperIndex], {
          weekNumber: week.week,
          day: laterDay.day,
          focus: 'Lower body',
          mode: next.planMode,
          phase: week.phase,
          context,
        });
        laterDay.status = 'adjusted';
        laterDay.whyToday = `Lower-body strength moved here to protect recovery after your ${round(anchorRun.distanceMiles, 1)} mi run.`;
      } else {
        const relocationDayIndex = days.findIndex((candidate, candidateIndex) => (
          candidateIndex > dayIndex
          && candidate.date > protection.lowerBodyThrough
          && availableDays.has(candidate.day)
          && (candidate.sessions || []).length < 2
          && !(candidate.sessions || []).some((session) => session.kind === 'lift')
          && [...hardIndexes].every((hardIndex) => Math.abs(hardIndex - candidateIndex) > 1)
        ));
        if (relocationDayIndex >= 0) {
          const relocationDay = days[relocationDayIndex];
          day.sessions.splice(lowerIndex, 1);
          relocationDay.sessions.push({
            ...originalLower,
            description: `${originalLower.description || 'Lower-body strength.'} Moved outside the recent-run recovery window.`,
            acuteLoadAdjusted: true,
          });
          day.whyToday = `Lower-body strength moved to ${relocationDay.day} to protect recovery after your ${round(anchorRun.distanceMiles, 1)} mi run.`;
          relocationDay.status = 'adjusted';
          relocationDay.whyToday = `Lower-body strength moved here to preserve the weekly strength floor outside the recent-run recovery window.`;
        } else {
          day.sessions[lowerIndex] = replaceLiftFocus(originalLower, {
            weekNumber: week.week,
            day: day.day,
            focus: 'Upper body',
            mode: next.planMode,
            phase: week.phase,
            context,
          });
          day.whyToday = `No safe lower-body slot remains this week after your ${round(anchorRun.distanceMiles, 1)} mi run, so this session changed to optional upper-body work.`;
        }
      }
      changed = true;
      weekChanged = true;
    }

    for (const day of days) {
      if (!dateInRange(day.date, anchorDate, protection.upperBodyOptionalThrough)) continue;
      const upper = (day.sessions || []).find((session) => session.kind === 'lift' && /upper/i.test(String(session.focus || '')));
      if (!upper) continue;
      upper.description = `${upper.description} Optional after the recent run: keep this submaximal and skip it if whole-body fatigue or soreness is elevated.`;
      upper.acuteLoadAdjusted = true;
      day.status = 'adjusted';
      day.whyToday = day.whyToday || `Upper-body strength is optional while you recover from the ${round(anchorRun.distanceMiles, 1)} mi run; lower-body loading stays protected.`;
      changed = true;
      weekChanged = true;
    }

    for (const day of days) {
      const kinds = new Set((day.sessions || []).map((session) => session.kind));
      if (kinds.has('run') && kinds.has('lift')) {
        day.orderGuidance = day.orderGuidance || 'Run first; lift at least 6 hours later.';
      } else {
        delete day.orderGuidance;
      }
    }

    week.totalMiles = round(days
      .flatMap((day) => day.sessions || [])
      .filter((session) => session.kind === 'run')
      .reduce((sum, session) => sum + Number(session.distance_miles || 0), 0));
    if (week.currentWeekConstraint) {
      const scheduledRunCount = days
        .flatMap((day) => day.sessions || [])
        .filter((session) => session.kind === 'run').length;
      week.currentWeekConstraint.scheduledRunCount = scheduledRunCount;
      week.currentWeekConstraint.totalRunsTowardTarget = week.currentWeekConstraint.completedRunsAppliedToQuota + scheduledRunCount;
    }
    if (weekChanged) week.acuteLoadAdjusted = true;
  }

  if (changed) next.acuteLoadAdjustment = acuteLoadMetadata(context.history);
  return next;
}

function isHardRun(session) {
  return session?.kind === 'run' && HARD_RUN_PATTERN.test([session.title, session.type, session.intensity, session.target_zone].filter(Boolean).join(' '));
}

function isDemandingRun(session) {
  return isHardRun(session) || (session?.kind === 'run' && /(steady|moderate|progression|zone 2-3)/i.test(
    [session.title, session.type, session.intensity, session.target_zone].filter(Boolean).join(' ')
  ));
}

function chooseLiftDays(availableDays, runByDay, count) {
  const hardIndexes = new Set();
  for (const [day, session] of runByDay.entries()) {
    if (isHardRun(session)) hardIndexes.add(DAY_ORDER.indexOf(day));
  }
  const lowerCandidates = availableDays.filter((day) => {
    const index = DAY_ORDER.indexOf(day);
    return [...hardIndexes].every((hardIndex) => Math.abs(hardIndex - index) > 1);
  });
  const preferred = ['Mon', 'Wed', 'Fri', 'Thu', 'Tue', 'Sat', 'Sun'].filter((day) => availableDays.includes(day));
  const occupied = preferred.filter((day) => runByDay.has(day));
  const open = preferred.filter((day) => !runByDay.has(day));
  const lowerDay = lowerCandidates.find((day) => occupied.includes(day)) || lowerCandidates[0] || null;
  const ordered = [lowerDay, ...occupied, ...open].filter((day, index, values) => day && values.indexOf(day) === index);
  const selected = ordered.slice(0, Math.min(count, availableDays.length));
  return selected.map((day, index) => ({ day, focus: day === lowerDay || (!lowerDay && index === 0 && hardIndexes.size === 0) ? 'Lower body' : 'Upper body' }));
}

function summarizeInputs(profile = {}, history = {}, recovery = {}, checkin = null) {
  const adherence = Number(history.adherenceRate);
  const acute = acuteLoadMetadata(history);
  const healthMetrics = recovery.metrics || {};
  const healthFreshness = healthMetrics.freshness || {};
  const metric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;
  return {
    weeklyMileageBaseline: round(Number(history.weeklyMileageBaseline ?? profile.weekly_miles_current) || 0),
    mileageBaseline: history.mileageBaseline || null,
    recentRunCount: clamp(Math.round(Number(history.recentRunCount || 0)), 0, 100),
    recentLiftCount: clamp(Math.round(Number(history.recentLiftCount || 0)), 0, 100),
    missedWorkouts: clamp(Math.round(Number(history.missedWorkouts || 0)), 0, 100),
    adherenceBand: Number.isFinite(adherence) ? (adherence >= 0.85 ? 'high' : adherence >= 0.65 ? 'moderate' : 'low') : 'unknown',
    recoveryState: String(recovery.state || recovery.recoveryState || 'unknown').slice(0, 20),
    appleHealth: (recovery.dataAvailable || recovery.available) ? {
      readinessScore: metric(recovery.readinessScore),
      sleepHoursLastNight: healthFreshness.sleep === false ? null : metric(healthMetrics.sleepHoursLastNight),
      sleepHours7dBaseline: metric(healthMetrics.sleepHours7dBaseline),
      hrvMs: healthFreshness.hrv === false ? null : metric(healthMetrics.hrvMs),
      hrvMsBaseline: metric(healthMetrics.hrvMsBaseline),
      restingHeartRate: healthFreshness.restingHeartRate === false ? null : metric(healthMetrics.restingHeartRate),
      restingHeartRateBaseline: metric(healthMetrics.restingHeartRateBaseline),
      activeMinutesThisWeek: healthFreshness.activity === false ? null : metric(healthMetrics.activeMinutesThisWeek),
      exerciseMinutesThisWeek: healthFreshness.exerciseMinutes === false ? null : metric(healthMetrics.exerciseMinutesThisWeek),
      workoutCountThisWeek: healthFreshness.activity === false ? null : metric(healthMetrics.workoutCountThisWeek),
      vo2Max: healthFreshness.vo2Max === false ? null : metric(healthMetrics.vo2Max),
      heartRateRecoveryOneMinute: healthFreshness.heartRateRecovery === false ? null : metric(healthMetrics.heartRateRecoveryOneMinute),
      respiratoryRate: healthFreshness.respiratoryRate === false ? null : metric(healthMetrics.respiratoryRate),
      runningPowerWatts: healthFreshness.runningDynamics === false ? null : metric(healthMetrics.runningPowerWatts),
      runningSpeedMps: healthFreshness.runningDynamics === false ? null : metric(healthMetrics.runningSpeedMps),
      runningStrideLengthM: healthFreshness.runningDynamics === false ? null : metric(healthMetrics.runningStrideLengthM),
      runningVerticalOscillationCm: healthFreshness.runningDynamics === false ? null : metric(healthMetrics.runningVerticalOscillationCm),
      runningGroundContactTimeMs: healthFreshness.runningDynamics === false ? null : metric(healthMetrics.runningGroundContactTimeMs),
      freshness: healthFreshness,
      usedFor: ['recovery baseline', 'training-load context', 'cardio and running-form trends'],
      syncedAt: recovery.syncedAt || null,
    } : null,
    checkin: checkin ? {
      date: checkin.date || null,
      feeling: checkin.feeling || null,
      legs: checkin.legs || null,
      drive: checkin.drive || null,
      sleepHours: checkin.sleepHours ?? null,
      lifeFlags: Array.isArray(checkin.lifeFlags) ? checkin.lifeFlags.slice(0, 6) : [],
    } : null,
    recentRun: acute?.latestRun || null,
    recentLoadAnchor: acute?.protectiveRun || null,
    currentWeekRunLoad: acute?.currentWeek || null,
    sevenDayRunMiles: acute?.sevenDayMiles ?? 0,
    recentRunLoadRatio: acute?.loadRatio ?? null,
  };
}

function hasPersistentQualityProtection(context = {}) {
  const profile = context.profile || {};
  const safety = context.safety || {};
  return Boolean(
    safety.activeInjury
    || safety.comebackMode
    || safety.injuryNotesPresent
    || profile.comeback_mode
    || String(profile.injury_notes || '').trim()
  );
}

function hasCurrentWeekRecoveryProtection(context = {}) {
  return ['low', 'recovery'].includes(String(context.recovery?.state || context.recovery?.recoveryState || '').toLowerCase());
}

function hasPlanWideQualityProtection(context = {}) {
  const history = context.history || {};
  const baseline = Number(history.weeklyMileageBaseline ?? context.profile?.weekly_miles_current) || 0;
  const meaningfulRunCount = Number(history.mileageBaseline?.meaningfulRunCount ?? history.recentRunCount ?? 0);
  return hasPersistentQualityProtection(context) || baseline < 5 || meaningfulRunCount < 3;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// H7: evaluate whether a target's structured course facts may be trusted for
// training logic. Returns the full evaluation (trusted flag, honest state, and
// only-when-trusted facts). Untrusted/stale/unknown data yields distance-only.
function trustedCourseFacts(target = {}) {
  return raceCourse.evaluateCourseTrust({
    envelope: target.course_profile_json ?? target.courseProfile,
    looseFacts: {
      elevationGainFt: target.elevation_gain_ft ?? target.elevationGainFt,
      maxAltitudeFt: target.max_altitude_ft ?? target.maxAltitudeFt,
      terrain: target.terrain ?? target.courseTerrain,
      source: target.source ?? target.courseSource,
      url: target.url ?? target.courseUrl,
    },
    raceDate: target.raceDate || target.race_date || null,
    provenance: target.provenance || target.courseProvenance,
    nowISO: target.nowISO || target.todayISO || null,
  });
}

function buildGoalCourse(target = {}) {
  const source = target.source || target.courseSource || null;
  const url = target.url || target.courseUrl || null;
  const evaluation = trustedCourseFacts(target);
  // Distance-only fallback: never surface untrusted/stale course facts to the
  // plan. Preserve the legacy null contract when there is no course data at all.
  if (!evaluation.trusted) {
    if (!source && !url) return null;
    const course = { state: evaluation.state, provenance: evaluation.provenance };
    if (source) course.source = source;
    if (url) course.url = url;
    return course;
  }
  const course = {
    state: evaluation.state,
    provenance: evaluation.provenance,
    elevationGainFt: numberOrNull(evaluation.facts.elevationGainFt),
    maxAltitudeFt: numberOrNull(evaluation.facts.maxAltitudeFt),
    terrain: evaluation.facts.terrain || null,
    source,
    url,
  };
  for (const key of Object.keys(course)) {
    if (course[key] === null || course[key] === undefined || course[key] === '') delete course[key];
  }
  return course;
}

function goalMetadata(target = {}, existingGoal = {}, history = {}) {
  const raceDate = parseISODate(target.raceDate) ? target.raceDate : existingGoal.date || null;
  const raceDistance = Number(target.distanceMiles ?? existingGoal.distanceMiles ?? 6.2) || 6.2;
  const resolvedTime = resolvedGoalTime(target, existingGoal, history);
  const goalTimeSeconds = resolvedTime?.seconds || null;
  const goalPace = goalPaceSecondsPerMile({ ...target, distanceMiles: raceDistance }, existingGoal, history);
  const raceTarget = target.raceTarget && typeof target.raceTarget === 'object'
    ? { ...target.raceTarget }
    : existingGoal.raceTarget || null;
  return Object.assign({}, existingGoal, {
    kind: raceDate ? 'race' : (existingGoal.kind || 'training_block'),
    raceId: target.raceId || existingGoal.raceId || null,
    name: target.raceName || target.goalName || existingGoal.name || `${raceDistance}-mile training block`,
    date: raceDate,
    distanceMiles: raceDistance,
    goalType: target.goalType || existingGoal.goalType || (goalTimeSeconds ? 'pr' : 'completion'),
    goalTimeSeconds,
    goalTimeSource: resolvedTime?.source || null,
    improvementTargetPercent: resolvedTime?.improvementPercent || null,
    goalPaceSecondsPerMile: goalPace,
    goalPaceLabel: formatPaceLabel(goalPace),
    paceContext: buildGoalPaceContext({ ...target, distanceMiles: raceDistance, goalTimeSeconds }, history, existingGoal),
    course: buildGoalCourse(target),
    raceTarget,
  });
}

function goalsMetadata(target = {}, existingGoals = [], history = {}) {
  const raceTargets = normalizedRaceTargets(target);
  return raceTargets.map((raceTarget, index) => ({
    ...goalMetadata({ ...target, ...raceTarget }, existingGoals[index] || {}, history),
    priority: 'A',
    sequence: index + 1,
    role: index === raceTargets.length - 1 ? 'final_peak' : 'first_peak',
  }));
}

function buildConcurrentPlan(context = {}) {
  const profile = context.profile || {};
  const target = context.target || {};
  const history = context.history || {};
  const recovery = context.recovery || {};
  const mode = resolvePlanMode(profile, target);
  const raceTargets = normalizedRaceTargets(target);
  const finalRaceTarget = raceTargets[raceTargets.length - 1] || target;
  const raceDate = parseISODate(finalRaceTarget.raceDate) ? finalRaceTarget.raceDate : null;
  const weekCount = clamp(Math.round(Number(target.weeks) || 8), raceDate ? 1 : 4, 20);
  const startDate = mondayFor(target.startDate || context.todayISO || toISODate(new Date()));
  const raceDistance = clamp(Number(finalRaceTarget.distanceMiles || profile.goal_race_distance || 6.2) || 6.2, 1, 100);
  const runSchedule = resolveRunSchedule(profile, target);
  if (!runSchedule.valid) throw new Error(runSchedule.error);
  const availableDays = runSchedule.trainingDays;
  const runDays = selectRunDays(availableDays, runSchedule.runDaysPerWeek);
  const requestedLiftDays = mode === planSchema.PLAN_MODES.RUN_ONLY ? 0 : clamp(Math.max(
    mode === planSchema.PLAN_MODES.HYBRID_BUILD ? 3 : 1,
    Math.round(Number(target.liftDaysPerWeek || profile.lift_days_per_week) || (mode === planSchema.PLAN_MODES.HYBRID_BUILD ? 3 : 2)),
  ), 1, 4);
  const liftDaysPerWeek = Math.min(requestedLiftDays, availableDays.length);
  const strengthPolicy = mode === planSchema.PLAN_MODES.RUN_ONLY
    ? { enabled: false }
    : planSchema.normalizeStrengthPolicy({
      goal: mode === planSchema.PLAN_MODES.HYBRID_BUILD ? 'build' : 'maintain',
      sessionsPerWeek: liftDaysPerWeek,
      minimumSessionsPerWeek: Math.min(liftDaysPerWeek, mode === planSchema.PLAN_MODES.HYBRID_BUILD ? 3 : 2),
      equipment: Array.isArray(target.equipment) ? target.equipment : ['barbell', 'dumbbell', 'rack', 'bench'],
      preferredDays: availableDays,
    }, mode);
  const baseline = Number(history.weeklyMileageBaseline ?? profile.weekly_miles_current) || Math.max(6, raceDistance);
  const weekPhases = phasesForRaceTargets(startDate, weekCount, raceTargets);
  const mileageTargets = buildMileageTargets(weekCount, baseline, Boolean(raceDate), recovery, history, { ...target, weekPhases });
  const anchorMetadata = planAnchorMetadata(history);
  const persistentQualityProtection = hasPersistentQualityProtection(context);
  const currentWeekRecoveryProtection = hasCurrentWeekRecoveryProtection(context);
  let benchmarkPrescribed = false;

  const weeks = [];
  for (let weekNumber = 1; weekNumber <= weekCount; weekNumber += 1) {
    const weekStart = addDays(startDate, (weekNumber - 1) * 7);
    const phase = weekPhases[weekNumber - 1];
    const weekRaceTarget = raceTargets.find((race) => race.raceDate >= weekStart && race.raceDate <= addDays(weekStart, 6)) || null;
    const activeRaceTarget = activeRaceTargetForWeek(weekStart, raceTargets, finalRaceTarget);
    const activeTarget = { ...target, ...activeRaceTarget };
    const activeRaceDistance = clamp(Number(activeRaceTarget.distanceMiles || raceDistance) || raceDistance, 1, 100);
    const raceDay = weekRaceTarget && DAY_ORDER.find((day, index) => addDays(weekStart, index) === weekRaceTarget.raceDate);
    const trustedCourse = trustedCourseFacts(activeTarget);
    const trustedElevationGainFt = trustedCourse.trusted ? Number(trustedCourse.facts.elevationGainFt || 0) : 0;
    const hilly = trustedElevationGainFt / Math.max(1, activeRaceDistance) >= 30;
    const goalPaceContext = buildGoalPaceContext({ ...activeTarget, distanceMiles: activeRaceDistance }, history);
    let weekRunDays = raceDay && !runDays.includes(raceDay) ? [...runDays.slice(0, Math.max(1, runDays.length - 1)), raceDay] : runDays.slice();
    const currentWeekLoad = history.acuteRunLoad?.currentWeek;
    const currentWeekQuota = weekNumber === 1 ? currentWeekRunSchedule({
      weekStart,
      todayISO: context.todayISO,
      currentWeekLoad,
      runSchedule,
      raceDay,
    }) : null;
    const isCurrentWeek = Boolean(currentWeekQuota);
    const isPlanningCurrentWeek = weekNumber === 1
      && parseISODate(context.todayISO)
      && context.todayISO >= weekStart
      && context.todayISO <= addDays(weekStart, 6);
    if (currentWeekQuota) weekRunDays = currentWeekQuota.runDays;
    let scheduledMileageTarget = mileageTargets[weekNumber - 1];
    if (isCurrentWeek) scheduledMileageTarget = Math.max(0, scheduledMileageTarget - Number(currentWeekLoad.miles || 0));
    const priorScheduledMiles = Number(weeks[weeks.length - 1]?.totalMiles || 0);
    if (phase === 'deload' && priorScheduledMiles > 0) scheduledMileageTarget = Math.min(scheduledMileageTarget, priorScheduledMiles * 0.8);
    if (phase === 'taper' && priorScheduledMiles > 0) scheduledMileageTarget = Math.min(scheduledMileageTarget, priorScheduledMiles * 0.65);
    if (phase === 'taper' && goalPaceContext && !raceDay) {
      weekRunDays = selectTimedTaperRunDays(weekRunDays, scheduledMileageTarget, {
        weekNumber,
        weekCount,
      });
    }
    const minimumDistances = weekRunDays.map((day) => timedTaperMinimumDistance(runTypeFor(day, weekRunDays, phase, {
      weekNumber,
      weekCount,
      hasTimedGoal: Boolean(goalPaceContext),
    })));
    const distances = allocateRunDistances(scheduledMileageTarget, weekRunDays, phase, activeRaceDistance, raceDay, {
      weekNumber,
      recentLongMiles: (history.acuteRunLoad?.protectiveRun || history.acuteRunLoad?.latestRun)?.isLong
        ? (history.acuteRunLoad.protectiveRun || history.acuteRunLoad.latestRun).distanceMiles
        : 0,
      longRunCompleted: Boolean(isCurrentWeek && currentWeekLoad.longRunCompleted),
      preserveTimedTaperSharpening: Boolean(goalPaceContext),
      minimumDistances,
    });
    const runByDay = new Map();
    weekRunDays.forEach((day, index) => {
      const scheduledType = runTypeFor(day, weekRunDays, phase, {
        weekNumber,
        weekCount,
        hasTimedGoal: Boolean(goalPaceContext),
      });
      const longAlreadyCompleted = isCurrentWeek && currentWeekLoad.longRunCompleted && scheduledType === 'long';
      const type = day === raceDay ? 'race' : (longAlreadyCompleted ? 'easy' : scheduledType);
      const qualityCandidate = ['quality', 'hills', 'race_pace', 'sharpen', 'steady'].includes(type);
      const protectQualityThisWeek = persistentQualityProtection || (isPlanningCurrentWeek && currentWeekRecoveryProtection);
      const conservativeQuality = qualityCandidate
        && (protectQualityThisWeek || Number(distances[index] || 0) < 1.5);
      const workoutId = runWorkoutTaxonomy.workoutIdForSession(type, {
        phase,
        weekNumber,
        weekCount,
        hilly,
        hasTimedGoal: Boolean(goalPaceContext),
        weeklyMiles: baseline,
        meaningfulRunCount: Number(history.mileageBaseline?.meaningfulRunCount ?? history.recentRunCount ?? 0),
        conservative: conservativeQuality,
      });
      let runSession = buildRunSession({
        weekNumber,
        weekCount,
        day,
        type,
        workoutId,
        distance: distances[index],
        phase,
        hilly,
        raceName: activeRaceTarget.raceName,
        history,
        goalPaceContext,
        durationIsEstimated: durationIsEstimatedFromAnchorState(anchorMetadata.anchorState),
      });
      if (anchorMetadata.anchorState === 'needs_benchmark'
        && !benchmarkPrescribed
        && type !== 'race'
        && !protectQualityThisWeek) {
        runSession = buildBenchmarkRunSession(runSession);
        benchmarkPrescribed = true;
      }
      runByDay.set(day, runSession);
    });

    const effectiveLiftCount = mode === planSchema.PLAN_MODES.RUN_ONLY ? 0 : phase === 'race' ? Math.min(1, liftDaysPerWeek) : liftDaysPerWeek;
    const liftAvailableDays = isCurrentWeek
      ? availableDays.filter((day) => addDays(weekStart, DAY_ORDER.indexOf(day)) >= context.todayISO)
      : availableDays;
    const liftAssignments = chooseLiftDays(liftAvailableDays, runByDay, Math.min(effectiveLiftCount, liftAvailableDays.length));
    const liftByDay = new Map(liftAssignments.map(({ day, focus }) => [day, buildLiftSession({ weekNumber, day, focus, mode, phase, context })]));
    const days = DAY_ORDER.map((day, index) => {
      const sessions = [runByDay.get(day), liftByDay.get(day)].filter(Boolean);
      const result = { date: addDays(weekStart, index), day, sessions, status: 'planned', anchorState: anchorMetadata.anchorState };
      if (anchorMetadata.anchoredBy) result.anchoredBy = anchorMetadata.anchoredBy;
      const runDurationSession = sessions.find((session) => session.kind === 'run' && Number(session.duration_min || 0) > 0);
      if (runDurationSession && typeof runDurationSession.durationIsEstimated === 'boolean') {
        result.durationIsEstimated = runDurationSession.durationIsEstimated;
      }
      if (sessions.some((session) => session.kind === 'run') && sessions.some((session) => session.kind === 'lift')) {
        result.orderGuidance = 'Run first; lift at least 6 hours later.';
      }
      return result;
    });
    const totalMiles = round(days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run').reduce((sum, session) => sum + Number(session.distance_miles || 0), 0));
    const currentWeekConstraint = partialCurrentWeekConstraint(
      currentWeekQuota,
      runSchedule.runDaysPerWeek,
      weekRunDays.length
    );
    weeks.push({
      week: weekNumber,
      phase,
      startDate: weekStart,
      totalMiles,
      completedRunsAtGeneration: currentWeekQuota?.completedMeaningfulRuns || 0,
      completedMilesAtGeneration: isCurrentWeek ? round(Number(currentWeekLoad.miles || 0)) : 0,
      ...(currentWeekConstraint ? { currentWeekConstraint } : {}),
      days,
    });
  }

  const goals = goalsMetadata(target, [], history);
  const finalGoal = goals[goals.length - 1]
    || goalMetadata(target, { kind: raceDate ? 'race' : 'training_block' }, history);
  const plan = {
    schemaVersion: planSchema.SCHEMA_VERSION,
    planMode: mode,
    goal: finalGoal,
    ...(goals.length ? { goals } : {}),
    strengthPolicy,
    anchorState: anchorMetadata.anchorState,
    ...(anchorMetadata.anchoredBy ? { anchoredBy: anchorMetadata.anchoredBy } : {}),
    generationSource: 'evidence_engine',
    generationValidationErrors: [],
    trainingEvidence: trainingEvidence.planEvidence(mode),
    methodologyNote: 'Research and athlete practice set the training principles; your history, recovery, availability, and race set the dosage. Elite volume is never copied.',
    inputSummary: summarizeInputs(profile, history, recovery, context.checkin),
    schedulePreferences: {
      runDaysPerWeek: runSchedule.runDaysPerWeek,
      trainingDays: runSchedule.trainingDays,
      runDaysSource: target.runDaysSource || runSchedule.runDaysSource,
      trainingDaysSource: target.trainingDaysSource || runSchedule.trainingDaysSource,
    },
    weeks,
  };
  return applyAcuteRunProtection(plan, context);
}

function validateLift(session, path, errors) {
  const required = ['focus', 'warmup', 'recovery', 'progression'];
  for (const field of required) {
    if (!session[field] || (Array.isArray(session[field]) && session[field].length === 0)) errors.push(`${path}.${field} is required`);
  }
  const exercises = Array.isArray(session.main) ? session.main : Array.isArray(session.exercises) ? session.exercises : [];
  if (exercises.length < 2) errors.push(`${path}.main requires at least two exercises`);
  exercises.forEach((exercise, index) => {
    for (const field of ['name', 'sets', 'reps', 'rest', 'load', 'cue', 'progression']) {
      if (exercise?.[field] === undefined || exercise?.[field] === null || exercise?.[field] === '') errors.push(`${path}.main[${index}].${field} is required`);
    }
    if (!exercise?.rpe && !exercise?.rir) errors.push(`${path}.main[${index}] requires rpe or rir`);
    const sets = Number(exercise?.sets);
    if (!Number.isInteger(sets) || sets < 1 || sets > 6) errors.push(`${path}.main[${index}].sets must be a whole number from 1 to 6`);
    if (String(exercise?.rest || '').length > 30) errors.push(`${path}.main[${index}].rest is too long`);
  });
}

function sameStructuredValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRun(session, path, errors, options = {}) {
  for (const field of ['title', 'distance_miles', 'pace_target', 'target_zone', 'intensity', 'warmup', 'steps', 'cooldown', 'progression', 'description']) {
    const value = session[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) errors.push(`${path}.${field} is required`);
  }
  if (!(Number(session.distance_miles) > 0)) errors.push(`${path}.distance_miles must be positive`);
  if (String(session.prescription_basis || '').toLowerCase() === 'time' && !(Number(session.duration_min) > 0)) {
    errors.push(`${path}.duration_min must be positive for a time-based session`);
  }
  if (!Array.isArray(session.evidence_refs) || session.evidence_refs.length === 0) errors.push(`${path}.evidence_refs is required`);
  const workoutId = String(session.workout_id || '');
  const taxonomyWorkout = runWorkoutTaxonomy.workoutForId(workoutId);
  if (!workoutId) errors.push(`${path}.workout_id is required`);
  if (!taxonomyWorkout) errors.push(`${path}.workout_id is not canonical`);
  if (taxonomyWorkout && session.workout_family !== taxonomyWorkout.family) errors.push(`${path}.workout_family must match ${taxonomyWorkout.family}`);
  if (taxonomyWorkout && session.type !== taxonomyWorkout.type) errors.push(`${path}.type must match ${taxonomyWorkout.type}`);
  const canonicalPrescription = taxonomyWorkout && runWorkoutTaxonomy.prescriptionFor(workoutId, {
    phase: options.phase,
    weekNumber: options.weekNumber,
    weekCount: options.weekCount,
    goalPaceLabel: session.goal_pace_label || null,
  });
  if (canonicalPrescription) {
    for (const field of [
      'title', 'target_zone', 'pace_target', 'intensity', 'warmup', 'quality_prescription',
      'steps', 'cooldown', 'progression', 'description', 'purpose', 'prescription_basis',
      'workout_id', 'workout_family', 'phase',
    ]) {
      if (!sameStructuredValue(session[field], canonicalPrescription[field])) {
        errors.push(`${path}.${field} must match the canonical ${workoutId} prescription`);
      }
    }
  }
  if (taxonomyWorkout?.quality && workoutId !== 'race') {
    const quality = session.quality_prescription;
    if (!quality || typeof quality !== 'object') errors.push(`${path}.quality_prescription is required`);
    if (!(Number(quality?.repetitions) > 0)) errors.push(`${path}.quality_prescription.repetitions must be positive`);
    for (const field of ['work', 'target']) {
      if (!String(quality?.[field] || '').trim()) errors.push(`${path}.quality_prescription.${field} is required`);
    }
    for (const field of ['type', 'duration']) {
      if (!String(quality?.recovery?.[field] || '').trim()) errors.push(`${path}.quality_prescription.recovery.${field} is required`);
    }
    if (!String(session.purpose || '').trim()) errors.push(`${path}.purpose is required for quality work`);
  }
}

function isStructuredTargetPaceSession(session = {}) {
  return ['race_pace', 'sharpen'].includes(String(session.type || '').toLowerCase())
    && ['warmup', 'steps', 'cooldown'].every((field) => Array.isArray(session[field]) && session[field].length > 0);
}

function validateConcurrentPlan(candidate, context = {}) {
  const errors = [];
  const target = context.target || {};
  const raceTargets = normalizedRaceTargets(target);
  const finalRaceTarget = raceTargets[raceTargets.length - 1] || target;
  const runSchedule = resolveRunSchedule(context.profile || {}, target);
  if (!runSchedule.valid) return { valid: false, errors: [runSchedule.error] };
  const allowedRunDays = new Set(runSchedule.trainingDays);
  const expectedMode = resolvePlanMode(context.profile || {}, target);
  const hasRace = Boolean(parseISODate(finalRaceTarget.raceDate));
  const expectedGoalTimeSeconds = goalTimeSecondsFor(finalRaceTarget, {}, context.history || {});
  const expectedGoalPace = goalPaceSecondsPerMile(finalRaceTarget, {}, context.history || {});
  const expectedWeeks = clamp(Math.round(Number(target.weeks) || 8), hasRace ? 1 : 4, 20);
  const expectedStartDate = mondayFor(target.startDate || context.todayISO);
  const expectedWeekPhases = phasesForRaceTargets(expectedStartDate, expectedWeeks, raceTargets);
  const currentWeekLoad = context.history?.acuteRunLoad?.currentWeek;
  const acuteLoad = context.history?.acuteRunLoad;
  const acuteProtection = acuteLoad?.protection?.active ? acuteLoad.protection : null;
  const planWideQualityProtection = hasPlanWideQualityProtection(context);
  const latestRunDate = acuteProtection?.anchorDate || acuteLoad?.protectiveRun?.date || acuteLoad?.latestRun?.date || null;
  if (!candidate || typeof candidate !== 'object') return { valid: false, errors: ['candidate is missing'] };
  if (Number(candidate.schemaVersion) !== planSchema.SCHEMA_VERSION) errors.push(`schemaVersion must be ${planSchema.SCHEMA_VERSION}`);
  if (candidate.planMode !== expectedMode) errors.push(`planMode must be ${expectedMode}`);
  if (Number(candidate.schedulePreferences?.runDaysPerWeek) !== runSchedule.runDaysPerWeek) {
    errors.push(`schedulePreferences.runDaysPerWeek must be ${runSchedule.runDaysPerWeek}`);
  }
  if (JSON.stringify(candidate.schedulePreferences?.trainingDays || []) !== JSON.stringify(runSchedule.trainingDays)) {
    errors.push('schedulePreferences.trainingDays must preserve the selected weekdays');
  }
  if (!candidate.goal || Number(candidate.goal.distanceMiles) !== Number(finalRaceTarget.distanceMiles || candidate.goal?.distanceMiles)) errors.push('goal distance is missing or changed');
  if (finalRaceTarget.raceDate && candidate.goal?.date !== finalRaceTarget.raceDate) errors.push('race date was not preserved');
  if (expectedGoalTimeSeconds && Number(candidate.goal?.goalTimeSeconds) !== expectedGoalTimeSeconds) errors.push('goal time was not preserved');
  if (expectedGoalPace && Number(candidate.goal?.goalPaceSecondsPerMile) !== expectedGoalPace) errors.push('goal pace was not derived from target time and distance');
  const expectedGoals = goalsMetadata(target, [], context.history || {});
  const expectedFinalGoal = expectedGoals[expectedGoals.length - 1]
    || goalMetadata(target, {}, context.history || {});
  if (candidate.goal?.name !== expectedFinalGoal.name) errors.push('goal name is missing or changed');
  if (JSON.stringify(candidate.goal?.course ?? null) !== JSON.stringify(expectedFinalGoal.course ?? null)) errors.push('goal course metadata is missing or changed');
  if (JSON.stringify(candidate.goal?.raceTarget ?? null) !== JSON.stringify(expectedFinalGoal.raceTarget ?? null)) errors.push('goal race target snapshot is missing or changed');
  if (expectedGoals.length) {
    if (!Array.isArray(candidate.goals) || candidate.goals.length !== expectedGoals.length) {
      errors.push(`goals must preserve exactly ${expectedGoals.length} race targets`);
    } else {
      expectedGoals.forEach((goal, index) => {
        const actual = candidate.goals[index] || {};
        if (actual.raceId !== goal.raceId || actual.date !== goal.date || Number(actual.distanceMiles) !== Number(goal.distanceMiles)) {
          errors.push(`goals[${index}] must preserve race identity, date, and distance`);
        }
        if (goal.goalTimeSeconds && Number(actual.goalTimeSeconds) !== Number(goal.goalTimeSeconds)) errors.push(`goals[${index}] must preserve goal time`);
        if (goal.goalPaceSecondsPerMile && Number(actual.goalPaceSecondsPerMile) !== Number(goal.goalPaceSecondsPerMile)) errors.push(`goals[${index}] must preserve goal pace`);
        if (actual.priority !== 'A' || Number(actual.sequence) !== index + 1 || actual.role !== goal.role) errors.push(`goals[${index}] must preserve A-race ordering`);
        if (actual.name !== goal.name) errors.push(`goals[${index}] must preserve race name`);
        if (JSON.stringify(actual.course ?? null) !== JSON.stringify(goal.course ?? null)) errors.push(`goals[${index}] must preserve course metadata`);
        if (JSON.stringify(actual.raceTarget ?? null) !== JSON.stringify(goal.raceTarget ?? null)) errors.push(`goals[${index}] must preserve the race target snapshot`);
      });
    }
  }
  if (!Array.isArray(candidate.weeks) || candidate.weeks.length !== expectedWeeks) errors.push(`weeks must contain exactly ${expectedWeeks} entries`);

  const ids = new Set();
  const weekMiles = [];
  const phases = new Set();
  const exactRaceSessionDates = new Set();
  let raceSpecificSessionFound = false;
  const targetPaceRaceIds = new Set();
  const weeks = Array.isArray(candidate.weeks) ? candidate.weeks : [];
  weeks.forEach((week, weekIndex) => {
    const path = `weeks[${weekIndex}]`;
    if (Number(week.week) !== weekIndex + 1) errors.push(`${path}.week must be ${weekIndex + 1}`);
    if (!parseISODate(week.startDate)) errors.push(`${path}.startDate must be YYYY-MM-DD`);
    if (weekIndex === 0 && week.startDate !== expectedStartDate) errors.push(`${path}.startDate must be ${expectedStartDate}`);
    if (weekIndex > 0 && week.startDate !== addDays(weeks[weekIndex - 1]?.startDate, 7)) errors.push(`${path}.startDate must follow the prior week`);
    if (!['base', 'build', 'deload', 'peak', 'taper', 'race'].includes(week.phase)) errors.push(`${path}.phase is invalid`);
    else {
      phases.add(week.phase);
      if (week.phase !== expectedWeekPhases[weekIndex]) errors.push(`${path}.phase must be ${expectedWeekPhases[weekIndex]}`);
    }
    if (!Array.isArray(week.days) || week.days.length !== 7) {
      errors.push(`${path}.days must contain seven dated days`);
      return;
    }
    const weekRaceTarget = raceTargets.find((race) => race.raceDate >= week.startDate && race.raceDate <= addDays(week.startDate, 6)) || null;
    const raceDay = weekRaceTarget && DAY_ORDER.find((day, dayIndex) => addDays(week.startDate, dayIndex) === weekRaceTarget.raceDate);
    const currentWeekQuota = weekIndex === 0 ? currentWeekRunSchedule({
      weekStart: week.startDate,
      todayISO: context.todayISO,
      currentWeekLoad,
      runSchedule,
      raceDay,
    }) : null;
    let restDays = 0;
    let lifts = 0;
    let runs = 0;
    let miles = 0;
    const hardRunIndexes = new Set();
    const lowerLiftIndexes = new Set();
    week.days.forEach((day, dayIndex) => {
      const dayPath = `${path}.days[${dayIndex}]`;
      if (day.day !== DAY_ORDER[dayIndex]) errors.push(`${dayPath}.day must be ${DAY_ORDER[dayIndex]}`);
      const expectedDate = parseISODate(week.startDate) ? addDays(week.startDate, dayIndex) : null;
      if (day.date !== expectedDate) errors.push(`${dayPath}.date must be ${expectedDate}`);
      if (!Array.isArray(day.sessions) || day.sessions.length > 2) errors.push(`${dayPath}.sessions must contain zero to two sessions`);
      const sessions = Array.isArray(day.sessions) ? day.sessions : [];
      if (currentWeekQuota && day.date < context.todayISO && sessions.length > 0) {
        errors.push(`${dayPath} cannot schedule sessions before the current planning date`);
      }
      if (sessions.length === 0) restDays += 1;
      const kinds = new Set();
      sessions.forEach((session, sessionIndex) => {
        const sessionPath = `${dayPath}.sessions[${sessionIndex}]`;
        if (!session?.id || ids.has(String(session.id))) errors.push(`${sessionPath}.id must be present and globally unique`);
        else ids.add(String(session.id));
        const kind = planSchema.kindFromSession(session);
        if (kinds.has(kind)) errors.push(`${dayPath} cannot contain duplicate ${kind} sessions`);
        kinds.add(kind);
        if (kind === 'run') {
          runs += 1;
          validateRun(session, sessionPath, errors, {
            phase: week.phase,
            weekNumber: week.week,
            weekCount: weeks.length,
          });
          if (currentWeekQuota
            && (day.date < context.todayISO || currentWeekQuota.completedRunDates.has(day.date))) {
            errors.push(`${sessionPath} is scheduled in the past or on an already completed date`);
          }
          if (String(session.type || '').toLowerCase() !== 'race' && !allowedRunDays.has(day.day)) {
            errors.push(`${sessionPath} is scheduled outside the selected trainingDays`);
          }
          miles += Number(session.distance_miles || 0);
          if (isHardRun(session)) hardRunIndexes.add(dayIndex);
          if (acuteProtection && String(session.type || '').toLowerCase() !== 'race') {
            if (acuteProtection.noAdditionalRunOnDate && day.date === acuteProtection.noAdditionalRunOnDate) {
              errors.push(`${sessionPath} duplicates a run already logged on ${day.date}`);
            } else if (acuteProtection.postRunSevere && dateInRange(day.date, latestRunDate, acuteProtection.hardRunsThrough)) {
              errors.push(`${sessionPath} conflicts with severe-pain run protection through ${acuteProtection.hardRunsThrough}`);
            } else if (isDemandingRun(session) && dateInRange(day.date, latestRunDate, acuteProtection.hardRunsThrough)) {
              errors.push(`${sessionPath} conflicts with recent-run hard-session protection through ${acuteProtection.hardRunsThrough}`);
            }
          }
          if (/(hill|course-specific)/i.test([session.title, session.type, session.description].filter(Boolean).join(' '))) raceSpecificSessionFound = true;
          if (isStructuredTargetPaceSession(session)) {
            for (const race of raceTargets) {
              const racePace = goalPaceSecondsPerMile(race, {}, context.history || {});
              if (day.date < race.raceDate && racePace && Math.abs(Number(session.goal_pace_seconds_per_mile || 0) - racePace) <= 1) {
                targetPaceRaceIds.add(race.raceId || race.raceDate);
              }
            }
          }
          if (String(session.type || '').toLowerCase() === 'race') {
            const matchingRace = raceTargetForDate(day.date, raceTargets);
            const exactDistance = matchingRace && Math.abs(Number(session.distance_miles) - Number(matchingRace.distanceMiles)) < 0.01;
            if (matchingRace && exactDistance) exactRaceSessionDates.add(day.date);
            else errors.push(`${sessionPath} race session must preserve the target date and distance`);
            if (matchingRace?.raceName && session.title !== matchingRace.raceName) errors.push(`${sessionPath} race session must preserve the target name`);
            const matchingGoalPace = matchingRace ? goalPaceSecondsPerMile(matchingRace, {}, context.history || {}) : null;
            if (matchingGoalPace) {
              const expectedPaceLabel = formatPaceLabel(matchingGoalPace);
              const paceMatches = Math.abs(Number(session.goal_pace_seconds_per_mile || 0) - matchingGoalPace) <= 1;
              const labelMatches = session.goal_pace_label === expectedPaceLabel
                && String(session.pace_target || '').includes(expectedPaceLabel);
              if (!paceMatches || !labelMatches) errors.push(`${sessionPath} race session must preserve the exact goal pace`);
            }
          }
        } else if (kind === 'lift') {
          lifts += 1;
          validateLift(session, sessionPath, errors);
          if (/lower/i.test(String(session.focus || ''))) lowerLiftIndexes.add(dayIndex);
          if (acuteProtection && /lower/i.test(String(session.focus || '')) && dateInRange(day.date, latestRunDate, acuteProtection.lowerBodyThrough)) {
            errors.push(`${sessionPath} conflicts with recent-run lower-body protection through ${acuteProtection.lowerBodyThrough}`);
          }
        } else {
          errors.push(`${sessionPath}.kind must be run or lift`);
        }
      });
      if (kinds.has('run') && kinds.has('lift') && !String(day.orderGuidance || '').trim()) errors.push(`${dayPath}.orderGuidance is required for same-day run and lift`);
    });
    if (restDays < 1) errors.push(`${path} must contain at least one full rest day`);
    const maximumRuns = currentWeekQuota?.runDays.length ?? runSchedule.runDaysPerWeek;
    if (currentWeekQuota && runs > maximumRuns) {
      errors.push(`${path} exceeds the current-week remaining quota of ${maximumRuns} scheduled runs`);
    } else if (!['taper', 'race'].includes(week.phase)
      && !week.acuteLoadAdjusted
      && runs !== maximumRuns) {
      errors.push(currentWeekQuota
        ? `${path} must contain ${maximumRuns} scheduled runs after current-week quota and eligible-day constraints`
        : `${path} must contain exactly ${runSchedule.runDaysPerWeek} weekly runs`);
    }
    if (currentWeekQuota && runs < runSchedule.runDaysPerWeek) {
      const constraint = week.currentWeekConstraint;
      if (constraint?.status !== 'partial_current_week') errors.push(`${path}.currentWeekConstraint must mark the partial current week`);
      if (Number(constraint?.requestedRunDaysPerWeek) !== runSchedule.runDaysPerWeek) errors.push(`${path}.currentWeekConstraint requested frequency is inaccurate`);
      if (Number(constraint?.completedMeaningfulRuns) !== currentWeekQuota.completedMeaningfulRuns) errors.push(`${path}.currentWeekConstraint completed run count is inaccurate`);
      if (Number(constraint?.completedRunsAppliedToQuota) !== currentWeekQuota.completedRunsAppliedToQuota) errors.push(`${path}.currentWeekConstraint quota credit is inaccurate`);
      if (Number(constraint?.remainingRunQuota) !== currentWeekQuota.remainingRunQuota) errors.push(`${path}.currentWeekConstraint remaining quota is inaccurate`);
      if (Number(constraint?.scheduledRunCount) !== runs) errors.push(`${path}.currentWeekConstraint scheduled run count is inaccurate`);
      const expectedTotal = currentWeekQuota.completedRunsAppliedToQuota + runs;
      if (Number(constraint?.totalRunsTowardTarget) !== expectedTotal) errors.push(`${path}.currentWeekConstraint total run count is inaccurate`);
      if (Boolean(constraint?.protectedRaceBeyondQuota) !== Boolean(currentWeekQuota.remainingRunQuota === 0 && runs > 0)) {
        errors.push(`${path}.currentWeekConstraint protected-race flag is inaccurate`);
      }
      if (!String(constraint?.explanation || '').includes(`full ${runSchedule.runDaysPerWeek}-day selected frequency starts next week`)) {
        errors.push(`${path}.currentWeekConstraint explanation is missing`);
      }
    }
    if (expectedMode === planSchema.PLAN_MODES.RUN_ONLY && lifts > 0) errors.push(`${path} run_only plans cannot contain lifts`);
    if (expectedMode !== planSchema.PLAN_MODES.RUN_ONLY && week.phase !== 'race') {
      const configuredFloor = Number(candidate.strengthPolicy?.minimumSessionsPerWeek || 0);
      const remainingLiftCapacity = currentWeekQuota
        ? runSchedule.trainingDays.filter((day) => (
          addDays(week.startDate, DAY_ORDER.indexOf(day)) >= context.todayISO
        )).length
        : configuredFloor;
      const floor = Math.min(configuredFloor, remainingLiftCapacity);
      if (lifts < floor) errors.push(`${path} has ${lifts} lifts below strength floor ${floor}`);
    }
    for (const lowerIndex of lowerLiftIndexes) {
      for (const hardIndex of hardRunIndexes) {
        if (Math.abs(lowerIndex - hardIndex) <= 1) errors.push(`${path} lower-body strength conflicts with hard/long run at day indexes ${lowerIndex}/${hardIndex}`);
      }
    }
    const roundedMiles = round(miles);
    const completedMilesAtGeneration = Math.max(0, Number(week.completedMilesAtGeneration || 0));
    weekMiles.push(round(roundedMiles + completedMilesAtGeneration));
    if (Math.abs(Number(week.totalMiles) - roundedMiles) > 0.2) errors.push(`${path}.totalMiles must equal scheduled run mileage`);
  });

  if (expectedMode === planSchema.PLAN_MODES.RUN_ONLY) {
    if (candidate.strengthPolicy?.enabled) errors.push('run_only strengthPolicy must be disabled');
  } else if (!candidate.strengthPolicy?.enabled) {
    errors.push('hybrid strengthPolicy must be enabled');
  }
  for (let index = 1; index < weeks.length; index += 1) {
    const phase = weeks[index]?.phase;
    const previousPhase = weeks[index - 1]?.phase;
    const previousWeekIsPartial = index === 1
      && weeks[0]?.currentWeekConstraint?.status === 'partial_current_week';
    if (!previousWeekIsPartial && !weeks[index - 1]?.acuteLoadAdjusted && !['deload', 'taper', 'race'].includes(phase) && previousPhase !== 'deload' && weekMiles[index] > weekMiles[index - 1] * 1.11 + 0.2) {
      errors.push(`weeks[${index}].totalMiles increases more than 10%`);
    }
    if (!previousWeekIsPartial && phase === 'deload' && weekMiles[index] >= weekMiles[index - 1] * 0.9) errors.push(`weeks[${index}] deload must reduce mileage by at least 10%`);
    if (!previousWeekIsPartial && phase === 'taper' && weekMiles[index] >= weekMiles[index - 1] * 0.8) errors.push(`weeks[${index}] taper must reduce mileage by at least 20%`);
  }
  if (raceTargets.length && weeks.length) {
    if (weeks[weeks.length - 1]?.phase !== 'race') errors.push('final week must be race phase');
    if (weeks.length > 1 && weeks[weeks.length - 2]?.phase !== 'taper') errors.push('week before race must be taper phase');
    raceTargets.forEach((race, raceIndex) => {
      const raceWeekIndex = weeks.findIndex((week) => race.raceDate >= week.startDate && race.raceDate <= addDays(week.startDate, 6));
      if (raceWeekIndex < 0 || weeks[raceWeekIndex]?.phase !== 'race') errors.push(`race target ${race.raceDate} must have a race-phase week`);
      if (raceWeekIndex > 0 && weeks[raceWeekIndex - 1]?.phase !== 'taper') errors.push(`week before race target ${race.raceDate} must be taper phase`);
      if (raceIndex < raceTargets.length - 1 && raceWeekIndex >= 0 && raceWeekIndex + 1 < weeks.length && weeks[raceWeekIndex + 1]?.phase !== 'deload') {
        errors.push(`week after race target ${race.raceDate} must be deload phase`);
      }
      if (!exactRaceSessionDates.has(race.raceDate)) {
        errors.push(`plan must include the exact race session on ${race.raceDate}`);
      }
    });
  }
  const plannedRunFrequency = runSchedule.runDaysPerWeek;
  raceTargets.forEach((race) => {
    const racePace = goalPaceSecondsPerMile(race, {}, context.history || {});
    const weeksToRace = Math.floor((parseISODate(race.raceDate) - parseISODate(expectedStartDate)) / (7 * 86400000)) + 1;
    if (!planWideQualityProtection
      && racePace
      && weeksToRace >= 2
      && plannedRunFrequency >= 2
      && !targetPaceRaceIds.has(race.raceId || race.raceDate)) {
      errors.push(`timed race plan must include a structured target-pace session before ${race.raceDate}`);
    }
  });
  if (expectedWeeks >= 8 && !phases.has('deload')) errors.push('plan must include a deload phase');
  // H7: only trusted, current course facts may require a hill session, and AI
  // candidates may not fabricate course facts absent from trusted structured data.
  const candidateGoals = Array.isArray(candidate.goals) && candidate.goals.length ? candidate.goals : [candidate.goal];
  const courseTargets = raceTargets.length ? raceTargets : [finalRaceTarget];
  courseTargets.forEach((courseTarget, index) => {
    const trustedCourse = trustedCourseFacts(courseTarget);
    const trustedElevationGainFt = trustedCourse.trusted ? Number(trustedCourse.facts.elevationGainFt || 0) : 0;
    const elevationPerMile = trustedElevationGainFt / Math.max(1, Number(courseTarget.distanceMiles || 0));
    if (!planWideQualityProtection && elevationPerMile >= 30 && expectedWeeks > 1 && !raceSpecificSessionFound) {
      errors.push('hilly race plan must include a hill or course-specific session');
    }
    const candidateCourse = candidateGoals[index] && typeof candidateGoals[index].course === 'object' ? candidateGoals[index].course : null;
    const expectedCourse = buildGoalCourse(courseTarget);
    if (JSON.stringify(candidateCourse) !== JSON.stringify(expectedCourse)) {
      errors.push(`race target ${courseTarget.raceDate || index + 1} course metadata must be preserved exactly`);
    }
    if (!candidateCourse) return;
    const claimedElevation = numberOrNull(candidateCourse.elevationGainFt);
    const claimedAltitude = numberOrNull(candidateCourse.maxAltitudeFt);
    const claimedTerrain = candidateCourse.terrain || null;
    if (!trustedCourse.trusted) {
      if (claimedElevation !== null || claimedAltitude !== null || claimedTerrain) {
        errors.push('candidate course facts are not supported by trusted structured data');
      }
    } else {
      if (claimedElevation !== null && Number(trustedCourse.facts.elevationGainFt) !== claimedElevation) errors.push('candidate elevation gain does not match trusted course data');
      if (claimedAltitude !== null && Number(trustedCourse.facts.maxAltitudeFt) !== claimedAltitude) errors.push('candidate altitude does not match trusted course data');
      if (claimedTerrain && String(trustedCourse.facts.terrain || '') !== String(claimedTerrain)) errors.push('candidate terrain does not match trusted course data');
    }
  });
  return { valid: errors.length === 0, errors };
}

function applyTrainingEvidence(plan, mode) {
  if (!plan || typeof plan !== 'object') return plan;
  const next = JSON.parse(JSON.stringify(plan));
  next.trainingEvidence = trainingEvidence.planEvidence(mode || next.planMode);
  next.methodologyNote = next.methodologyNote
    || 'Research and athlete practice set the training principles; your history, recovery, availability, and race set the dosage. Elite volume is never copied.';
  for (const week of next.weeks || []) {
    for (const day of week.days || []) {
      for (const session of day.sessions || []) {
        const kind = planSchema.kindFromSession(session);
        if (kind === 'run' && (!Array.isArray(session.evidence_refs) || session.evidence_refs.length === 0)) {
          session.evidence_refs = trainingEvidence.runEvidenceRefs(session.type);
        }
        if (kind === 'lift' && (!Array.isArray(session.evidence_refs) || session.evidence_refs.length === 0)) {
          session.evidence_refs = trainingEvidence.strengthEvidenceRefs();
        }
      }
    }
  }
  return next;
}

function selectPlanCandidate(candidate, context = {}) {
  const preparedWithEvidence = applyTrainingEvidence(
    strengthPrescription.applyStrengthPrescriptionData(candidate, context),
    resolvePlanMode(context.profile || {}, context.target || {})
  );
  const normalizedGoals = goalsMetadata(
    context.target || {},
    Array.isArray(preparedWithEvidence?.goals) ? preparedWithEvidence.goals : [],
    context.history || {}
  );
  const normalizedGoal = normalizedGoals[normalizedGoals.length - 1]
    || goalMetadata(context.target || {}, preparedWithEvidence?.goal || {}, context.history || {});
  const preparedCandidate = preparedWithEvidence && typeof preparedWithEvidence === 'object'
    ? {
      ...preparedWithEvidence,
      goal: normalizedGoal,
      ...(normalizedGoals.length ? { goals: normalizedGoals } : {}),
    }
    : preparedWithEvidence;
  const validation = validateConcurrentPlan(preparedCandidate, context);
  if (validation.valid) {
    return {
      plan: {
        ...preparedCandidate,
        goal: normalizedGoal,
        ...(normalizedGoals.length ? { goals: normalizedGoals } : {}),
        generationSource: 'ai_validated',
        generationValidationErrors: [],
        inputSummary: summarizeInputs(context.profile || {}, context.history || {}, context.recovery || {}, context.checkin || null),
        ...(context.history?.acuteRunLoad?.protection?.active ? { acuteLoadAdjustment: acuteLoadMetadata(context.history) } : {}),
      },
      source: 'ai_validated',
      validationErrors: [],
    };
  }
  const fallback = buildConcurrentPlan(context);
  fallback.generationSource = 'deterministic_fallback';
  fallback.generationValidationErrors = validation.errors.slice(0, 25);
  const fallbackValidation = validateConcurrentPlan(fallback, context);
  if (!fallbackValidation.valid) throw new Error(`Deterministic concurrent plan failed validation: ${fallbackValidation.errors.join('; ')}`);
  return { plan: fallback, source: 'deterministic_fallback', validationErrors: validation.errors };
}

module.exports = {
  addDays,
  isValidISODate,
  mondayFor,
  racePlanWindow,
  resolvePlanMode,
  phaseForWeek,
  estimateWeeklyMileageBaseline,
  buildMileageTargets,
  buildConcurrentPlan,
  applyAcuteRunProtection,
  validateConcurrentPlan,
  selectPlanCandidate,
  buildGoalCourse,
  trustedCourseFacts,
  goalMetadata,
  goalsMetadata,
  normalizedRaceTargets,
  phasesForRaceTargets,
  goalTimeSecondsFor,
  resolvedGoalTime,
  goalPaceSecondsPerMile,
  formatPaceLabel,
  buildGoalPaceContext,
  buildRunPerformanceProfile,
  equivalentTimeSeconds,
  STANDARD_PERFORMANCE_DISTANCES,
  isHardRun,
};
