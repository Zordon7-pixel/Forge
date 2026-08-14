const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const { getGoalBackwardV24Mode } = require('./betaPlanRollout');
const { buildGoalBackwardWorkloadEvidence } = require('./goalBackwardLoad');
const {
  RACE_PLAN_POLICY_V1,
  addDays,
  daysBetween,
  firstFullMonday,
  mondayFor,
  peakLongRunDemand,
  raceCategory,
  requiredPeakWeeklyMiles,
  taperWeeksForDistance,
} = require('./racePlanPolicy');

const STANDARD_DISTANCES = [1, 3.107, 6.214, 10, 13.109, 26.219];
const STATUS_WEIGHT = Object.freeze({ not_applicable: 0, supported: 1, stretch: 2, unsafe: 3 });

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function worstStatus(...statuses) {
  return statuses.reduce((worst, status) => (
    (STATUS_WEIGHT[status] || 0) > (STATUS_WEIGHT[worst] || 0) ? status : worst
  ), 'not_applicable');
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function recentRunRows(history = {}) {
  return [history.recentRuns, history.meaningfulRuns, history.runs]
    .find(Array.isArray) || [];
}

function normalizedRun(row = {}) {
  const distanceMiles = Number(row.distanceMiles ?? row.distance_miles ?? row.distance ?? 0);
  const durationMinutes = Number(row.durationMinutes ?? row.duration_min ?? (
    Number(row.duration_seconds || 0) / 60
  ));
  const type = String(row.workout_id || row.type || row.intensity || '').toLowerCase();
  const suppliedEffort = Number(row.perceived_effort || row.rpe || 0);
  const trustedIntensity = row.intensityTrusted === true
    || row.intensity_trusted === true
    || row.classificationTrusted === true
    || row.linkedCanonicalSession === true
    || (suppliedEffort > 0 && suppliedEffort <= 4)
    || ['easy', 'recovery', 'easy_aerobic', 'recovery_run', 'long', 'long_aerobic'].includes(type);
  return {
    date: String(row.date || row.start_date || row.workout_date || '').slice(0, 10),
    distanceMiles,
    durationMinutes,
    type,
    trustedIntensity,
    race: type === 'race' || row.isRace === true,
  };
}

function ordinaryEasyMedians(history = {}) {
  const rows = recentRunRows(history).map(normalizedRun).filter((run) => (
    run.trustedIntensity
    && ['easy', 'recovery', 'easy_aerobic', 'recovery_run'].includes(run.type)
    && run.distanceMiles >= 0.5
    && run.durationMinutes >= 10
  ));
  if (rows.length < 2) return { miles: null, minutes: null, count: rows.length };
  return {
    miles: median(rows.map((run) => run.distanceMiles)),
    minutes: median(rows.map((run) => run.durationMinutes)),
    count: rows.length,
  };
}

function baselineEvidence(context = {}) {
  const history = context.history || {};
  const rows = recentRunRows(history).map(normalizedRun).filter((run) => (
    /^\d{4}-\d{2}-\d{2}$/.test(run.date) && run.distanceMiles >= 0.5
  ));
  if (rows.length) {
    const planningDate = context.todayISO;
    const currentMonday = mondayFor(planningDate);
    const totals = [];
    for (let offset = 1; offset <= RACE_PLAN_POLICY_V1.baseline.completeWeeks; offset += 1) {
      const start = addDays(currentMonday, -7 * offset);
      const end = addDays(start, 6);
      const weekRows = rows.filter((run) => run.date >= start && run.date <= end);
      const miles = weekRows.reduce((sum, run) => sum + run.distanceMiles, 0);
      const minutes = weekRows.reduce((sum, run) => sum + run.durationMinutes, 0);
      if (weekRows.length >= RACE_PLAN_POLICY_V1.baseline.trustedWeekMinimumRuns
        && (miles >= RACE_PLAN_POLICY_V1.baseline.trustedWeekMinimumMiles
          || minutes >= RACE_PLAN_POLICY_V1.baseline.trustedWeekMinimumMinutes)) {
        totals.push(miles);
      }
    }
    if (totals.length >= 2) return { value: median(totals), confidence: 'trusted', trustedWeeks: totals.length, source: 'recorded_complete_weeks' };
    if (totals.length === 1) return { value: totals[0], confidence: 'low_confidence', trustedWeeks: 1, source: 'recorded_complete_week' };
  }
  const summarized = finitePositive(history.weeklyMileageBaseline);
  const method = String(history.mileageBaseline?.method || '');
  const count = Number(history.mileageBaseline?.meaningfulRunCount ?? history.recentRunCount ?? 0);
  if (summarized !== null && method === 'bounded_recent_history' && count >= 4) {
    return { value: summarized, confidence: 'trusted', trustedWeeks: null, source: 'bounded_recorded_history' };
  }
  const selfReported = finitePositive(context.profile?.weekly_miles_current) ?? summarized;
  if (selfReported !== null) return { value: selfReported, confidence: 'self_reported', trustedWeeks: 0, source: 'profile' };
  return { value: null, confidence: 'unknown', trustedWeeks: 0, source: null };
}

function enduranceEvidence(context = {}) {
  const rows = recentRunRows(context.history || {}).map(normalizedRun).filter((run) => (
    !run.race && run.trustedIntensity && run.distanceMiles >= 0.5 && run.durationMinutes >= 10
  ));
  const longest = rows.sort((left, right) => right.distanceMiles - left.distanceMiles).slice(0, 2);
  if (longest.length >= 2) {
    return { value: median(longest.map((run) => run.distanceMiles)), confidence: 'trusted', source: 'recorded_endurance_runs' };
  }
  if (longest.length === 1) return { value: longest[0].distanceMiles, confidence: 'low_confidence', source: 'recorded_endurance_run' };
  const acute = context.history?.acuteRunLoad?.protectiveRun || context.history?.acuteRunLoad?.latestRun;
  if (acute?.isLong && Number(acute.distanceMiles || 0) > 0) {
    return { value: Number(acute.distanceMiles), confidence: 'low_confidence', source: 'acute_recorded_long_run' };
  }
  const ordinary = ordinaryEasyMedians(context.history || {});
  if (ordinary.miles != null) return { value: ordinary.miles, confidence: 'ordinary_easy_seed', source: 'recorded_easy_runs' };
  return { value: null, confidence: 'unknown', source: null };
}

function goalsFrom(plan = {}, context = {}) {
  const source = Array.isArray(plan.goals) && plan.goals.length ? plan.goals : [plan.goal].filter(Boolean);
  return source.map((goal, index) => ({
    raceId: goal.raceId || goal.race_id || goal.date || `race-${index + 1}`,
    name: goal.name || goal.raceName || `Race ${index + 1}`,
    date: goal.date || goal.raceDate,
    distanceMiles: Number(goal.distanceMiles || goal.distance_miles || 0),
    goalTimeSeconds: Number(goal.goalTimeSeconds || goal.goal_time_seconds || 0) || null,
    goalType: String(goal.goalType || goal.goal_type || (goal.goalTimeSeconds ? 'pr' : 'completion')).toLowerCase(),
    sequence: Number(goal.sequence || index + 1),
    sourceGoal: goal,
  })).filter((goal) => goal.date && goal.distanceMiles > 0);
}

function weekIntersects(startDate, fromDate, throughDate) {
  return startDate <= throughDate && addDays(startDate, 6) >= fromDate;
}

function calendarForGoal(goal, goals, plan) {
  const planningDate = plan.planningClock?.planningDateLocal;
  const trustedDates = plan.bridgeWeek ? [planningDate] : [];
  const firstMonday = plan.bridgeWeek?.firstFullWeekStart || firstFullMonday(planningDate, trustedDates);
  const raceWeekMonday = mondayFor(goal.date);
  const taperWeeks = taperWeeksForDistance(goal.distanceMiles);
  const taperStartMonday = addDays(raceWeekMonday, -7 * (taperWeeks - 1));
  const latestPeakMonday = addDays(taperStartMonday, -7);
  const priorGoals = goals.filter((candidate) => candidate.date < goal.date);
  const eligibleFullWeekStarts = [];
  for (let weekStart = firstMonday; weekStart && weekStart <= latestPeakMonday; weekStart = addDays(weekStart, 7)) {
    const planWeek = (plan.weeks || []).find((week) => week.startDate === weekStart);
    const excludedPhase = planWeek && (planWeek.bridgeWeek || ['taper', 'race', 'deload'].includes(planWeek.phase));
    const postRaceRecovery = priorGoals.some((prior) => weekIntersects(
      weekStart,
      addDays(prior.date, 1),
      addDays(prior.date, RACE_PLAN_POLICY_V1.calendar.postA1RecoveryDays)
    ));
    if (!excludedPhase && !postRaceRecovery) eligibleFullWeekStarts.push(weekStart);
  }
  return {
    firstFullMonday: firstMonday,
    raceWeekMonday,
    taperWeeks,
    taperStartMonday,
    latestPeakMonday,
    eligibleFullWeekStarts,
    fullTrainingWeeks: eligibleFullWeekStarts.length,
  };
}

function previousLongMinimum(nextValue) {
  if (!(nextValue > 0)) return 0;
  let low = 0;
  let high = nextValue;
  for (let index = 0; index < 40; index += 1) {
    const value = (low + high) / 2;
    const reachable = value + Math.max(
      RACE_PLAN_POLICY_V1.progression.minimumLongRunGrowthMiles,
      value * RACE_PLAN_POLICY_V1.progression.maximumLongRunGrowth
    );
    if (reachable >= nextValue) high = value;
    else low = value;
  }
  return high;
}

function backwardCurve(weekStarts, peakValue, kind) {
  const values = new Map();
  let required = Number(peakValue || 0);
  for (let index = weekStarts.length - 1; index >= 0; index -= 1) {
    values.set(weekStarts[index], required);
    required = kind === 'weekly'
      ? required / (1 + RACE_PLAN_POLICY_V1.progression.maximumWeeklyGrowth)
      : previousLongMinimum(required);
  }
  return values;
}

function safeForwardCurve(plan, baseline, endurance) {
  const firstFull = plan.bridgeWeek?.firstFullWeekStart || plan.weeks?.[0]?.startDate;
  const weeks = (plan.weeks || []).filter((week) => (
    week.startDate >= firstFull
    && !week.bridgeWeek
    && !['taper', 'race', 'deload'].includes(week.phase)
  ));
  const result = new Map();
  let weekly = baseline.value;
  let long = endurance.value;
  for (const week of weeks) {
    weekly = weekly == null ? null : weekly * (1 + RACE_PLAN_POLICY_V1.progression.maximumWeeklyGrowth);
    long = long == null ? null : long + Math.max(
      RACE_PLAN_POLICY_V1.progression.minimumLongRunGrowthMiles,
      long * RACE_PLAN_POLICY_V1.progression.maximumLongRunGrowth
    );
    result.set(week.startDate, {
      safeWeeklyMiles: weekly,
      safeLongMiles: long,
    });
  }
  return result;
}

function buildPlanningModel(plan, context = {}) {
  const goals = goalsFrom(plan, context);
  const baseline = baselineEvidence(context);
  const endurance = enduranceEvidence(context);
  const calendars = goals.map((goal) => ({ goal, calendar: calendarForGoal(goal, goals, plan) }));
  const backwardWeekly = new Map();
  const backwardLong = new Map();
  for (const { goal, calendar } of calendars) {
    const weekly = backwardCurve(
      calendar.eligibleFullWeekStarts,
      requiredPeakWeeklyMiles(goal.distanceMiles, goal.goalType),
      'weekly'
    );
    const long = backwardCurve(
      calendar.eligibleFullWeekStarts,
      peakLongRunDemand(goal.distanceMiles, goal.goalType),
      'long'
    );
    for (const [date, value] of weekly) backwardWeekly.set(date, Math.max(backwardWeekly.get(date) || 0, value));
    for (const [date, value] of long) backwardLong.set(date, Math.max(backwardLong.get(date) || 0, value));
  }
  const safe = safeForwardCurve(plan, baseline, endurance);
  const weekTargets = (plan.weeks || []).map((week) => {
    const safeValues = safe.get(week.startDate) || {};
    const goalMinimumWeeklyMiles = backwardWeekly.get(week.startDate) || null;
    const goalMinimumLongMiles = backwardLong.get(week.startDate) || null;
    const targetWeeklyMiles = safeValues.safeWeeklyMiles == null ? null : Math.min(
      safeValues.safeWeeklyMiles,
      Math.max(Number(baseline.value || 0), Number(goalMinimumWeeklyMiles || 0))
    );
    const targetLongMiles = safeValues.safeLongMiles == null ? null : Math.min(
      safeValues.safeLongMiles,
      Math.max(Number(endurance.value || 0), Number(goalMinimumLongMiles || 0))
    );
    return {
      week: week.week,
      startDate: week.startDate,
      phase: week.phase,
      safeWeeklyMiles: safeValues.safeWeeklyMiles == null ? null : round(safeValues.safeWeeklyMiles, 2),
      safeLongMiles: safeValues.safeLongMiles == null ? null : round(safeValues.safeLongMiles, 2),
      goalMinimumWeeklyMiles: goalMinimumWeeklyMiles == null ? null : round(goalMinimumWeeklyMiles, 2),
      goalMinimumLongMiles: goalMinimumLongMiles == null ? null : round(goalMinimumLongMiles, 2),
      targetWeeklyMiles: targetWeeklyMiles == null ? null : round(targetWeeklyMiles, 1),
      targetLongMiles: targetLongMiles == null ? null : round(targetLongMiles, 1),
    };
  });
  return { goals, baseline, endurance, calendars, weekTargets };
}

function anchorClass(anchor, goal) {
  if (!anchor) return null;
  if (String(anchor.kind || '').toLowerCase() === 'benchmark' || String(anchor.workout_id || '') === 'benchmark_mile') return 'benchmark';
  const sourceDistance = Number(anchor.distanceMiles || anchor.distance_miles || 0);
  if (!(sourceDistance > 0)) return 'broad_estimate';
  if (Math.abs(sourceDistance - goal.distanceMiles) / goal.distanceMiles <= 0.03) return 'same_distance';
  const sourceIsStandard = STANDARD_DISTANCES.some((distance) => Math.abs(distance - sourceDistance) <= 0.06);
  const targetIsStandard = STANDARD_DISTANCES.some((distance) => Math.abs(distance - goal.distanceMiles) <= 0.06);
  const ratio = goal.distanceMiles / sourceDistance;
  if (sourceIsStandard && targetIsStandard && ratio >= 0.5 && ratio <= 2) return 'nearby_standard';
  return 'broad_estimate';
}

function paceFeasibility(goal, calendar, context) {
  if (goal.goalType !== 'pr' || !goal.goalTimeSeconds) {
    return { status: 'not_applicable', reasons: [] };
  }
  const anchor = context.history?.performanceProfile?.targetAnchor || null;
  const classification = anchorClass(anchor, goal);
  const freshness = { same_distance: 180, nearby_standard: 120, benchmark: 42, broad_estimate: 28 }[classification];
  const ageDays = anchor?.date ? daysBetween(anchor.date, context.todayISO) : null;
  const reasons = [];
  if (!anchor || !classification || ageDays == null) {
    return { status: calendar.fullTrainingWeeks > 0 ? 'stretch' : 'unsafe', anchorClass: null, reasons: ['NO_PERFORMANCE_ANCHOR'] };
  }
  if (ageDays < 0 || ageDays > freshness) {
    return { status: 'unsafe', anchorClass: classification, anchorAgeDays: ageDays, reasons: ['ANCHOR_EXPIRED'] };
  }
  const anchorSeconds = Number(anchor.equivalentTimeSeconds || anchor.equivalent_time_seconds || 0);
  if (!(anchorSeconds > 0)) return { status: 'stretch', anchorClass: classification, reasons: ['BROAD_EQUIVALENCY_ONLY'] };
  const improvement = Math.max(0, (anchorSeconds - goal.goalTimeSeconds) / anchorSeconds);
  const supportedLimit = Math.min(
    RACE_PLAN_POLICY_V1.paceFeasibility.supportedMaximum,
    RACE_PLAN_POLICY_V1.paceFeasibility.supportedPerFullWeek * calendar.fullTrainingWeeks
  );
  const stretchLimit = Math.min(
    RACE_PLAN_POLICY_V1.paceFeasibility.stretchMaximum,
    RACE_PLAN_POLICY_V1.paceFeasibility.stretchPerFullWeek * calendar.fullTrainingWeeks
  );
  if (classification === 'broad_estimate') reasons.push('BROAD_EQUIVALENCY_ONLY');
  else if (classification === 'nearby_standard') reasons.push('PACE_EQUIVALENCY_USED');
  const status = improvement <= supportedLimit && classification !== 'broad_estimate'
    ? 'supported'
    : improvement <= stretchLimit ? 'stretch' : 'unsafe';
  return {
    status,
    anchorClass: classification,
    anchorAgeDays: ageDays,
    requiredImprovement: round(improvement, 4),
    supportedLimit: round(supportedLimit, 4),
    stretchLimit: round(stretchLimit, 4),
    reasons,
  };
}

function sessionsBefore(plan, throughDate) {
  return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    day.date <= throughDate ? (day.sessions || []).map((session) => ({ week, day, session })) : []
  )));
}

function qualityExposure(plan, goal, calendar) {
  if (goal.goalType !== 'pr') return { status: 'supported', counts: {}, required: {}, ratio: 1, reasons: [] };
  const counts = { hillsOrStrides: 0, thresholdOrIntervals: 0, racePace: 0 };
  for (const { session } of sessionsBefore(plan, calendar.latestPeakMonday ? addDays(calendar.latestPeakMonday, 6) : goal.date)) {
    const id = String(session.workout_id || '');
    const family = runWorkoutTaxonomy.workoutForId(id)?.family;
    if (['hills', 'speed'].includes(family)) counts.hillsOrStrides += 1;
    else if (['threshold', 'intervals'].includes(family)) counts.thresholdOrIntervals += 1;
    else if (family === 'race_pace' && Math.abs(Number(session.goal_pace_seconds_per_mile || 0) - goal.goalTimeSeconds / goal.distanceMiles) <= 1) counts.racePace += 1;
  }
  const required = RACE_PLAN_POLICY_V1.qualityExposure[raceCategory(goal.distanceMiles)];
  const ratios = Object.keys(required).map((key) => Math.min(1, counts[key] / required[key]));
  const ratio = ratios.length ? Math.min(...ratios) : 1;
  return {
    status: ratio >= 1 ? 'supported' : ratio >= RACE_PLAN_POLICY_V1.progression.stretchDemandFloor ? 'stretch' : 'unsafe',
    counts,
    required,
    ratio: round(ratio, 3),
    reasons: ratio >= 1 ? [] : ['QUALITY_EXPOSURE_MISSING'],
  };
}

function workloadFeasibility(plan, goal, calendar, model, context) {
  const eligible = new Set(calendar.eligibleFullWeekStarts);
  const weeks = (plan.weeks || []).filter((week) => eligible.has(week.startDate));
  const peakWeeklyMiles = Math.max(0, ...weeks.map((week) => Number(week.totalMiles || 0)));
  const peakLongRunMiles = Math.max(0, ...weeks.flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).filter((session) => session.type === 'long' && session.workout_id === 'long_aerobic')
      .map((session) => Number(session.distance_miles || 0))
  ))));
  const requiredWeeklyMiles = requiredPeakWeeklyMiles(goal.distanceMiles, goal.goalType);
  const requiredLongMiles = peakLongRunDemand(goal.distanceMiles, goal.goalType);
  const weeklyRatio = requiredWeeklyMiles > 0 ? peakWeeklyMiles / requiredWeeklyMiles : 1;
  const longRatio = requiredLongMiles > 0 ? peakLongRunMiles / requiredLongMiles : 1;
  const ratio = Math.min(weeklyRatio, longRatio);
  const evidenceCap = model.baseline.confidence === 'trusted' && model.endurance.confidence === 'trusted'
    ? 'supported' : 'stretch';
  let status = ratio >= 1 ? evidenceCap
    : ratio >= RACE_PLAN_POLICY_V1.progression.stretchDemandFloor ? 'stretch' : 'unsafe';
  if (contextSafetyBlocked(context)) status = 'unsafe';
  return {
    status,
    peakWeeklyMiles: round(peakWeeklyMiles),
    peakLongRunMiles: round(peakLongRunMiles),
    requiredWeeklyMiles,
    requiredLongMiles,
    weeklyRatio: round(weeklyRatio, 3),
    longRatio: round(longRatio, 3),
    reasons: status === 'unsafe' ? ['PEAK_DEMAND_UNREACHABLE'] : [],
  };
}

function contextSafetyBlocked(context = {}) {
  return Boolean(context.safety?.activeInjury || context.safety?.comebackMode);
}

function spacingConflict(goals) {
  if (goals.length < 2) return false;
  return goals.some((goal, index) => index > 0 && daysBetween(goals[index - 1].date, goal.date) < 14);
}

function checkpointFor(plan, calendar, needsPace, needsWorkload) {
  const eligible = new Set(calendar.eligibleFullWeekStarts);
  const entries = (plan.weeks || []).filter((week) => eligible.has(week.startDate))
    .flatMap((week) => (week.days || []).flatMap((day) => (
      (day.sessions || []).map((session) => ({ week, day, session }))
    )));
  const checkpoint = needsPace
    ? entries.find(({ session }) => session.workout_id === 'benchmark_mile')
    : needsWorkload ? entries.find(({ session }) => session.workout_id === 'long_aerobic') : null;
  return checkpoint ? {
    date: checkpoint.day.date,
    sessionId: checkpoint.session.id,
    kind: needsPace ? 'benchmark' : 'long_run_completion',
  } : null;
}

function evaluatePlanFeasibility(plan, context = {}, planningModel = null) {
  const model = planningModel || buildPlanningModel(plan, context);
  const conflict = spacingConflict(model.goals);
  const goalFeasibilities = model.calendars.map(({ goal, calendar }) => {
    const pace = paceFeasibility(goal, calendar, context);
    const workload = workloadFeasibility(plan, goal, calendar, model, context);
    const quality = qualityExposure(plan, goal, calendar);
    let overall = worstStatus(pace.status, workload.status, quality.status, conflict ? 'stretch' : 'supported');
    const checkpoint = overall === 'stretch'
      ? checkpointFor(plan, calendar, pace.status === 'stretch', workload.status === 'stretch')
      : null;
    const reasons = [...new Set([
      ...pace.reasons,
      ...workload.reasons,
      ...quality.reasons,
      ...(conflict ? ['RACE_SPACING_CONFLICT'] : []),
    ])];
    if (overall === 'stretch' && !checkpoint) {
      overall = 'unsafe';
      reasons.push('CHECKPOINT_UNPLACEABLE');
    }
    return {
      raceId: goal.raceId,
      name: goal.name,
      date: goal.date,
      distanceMiles: goal.distanceMiles,
      goalType: goal.goalType,
      fullTrainingWeeks: calendar.fullTrainingWeeks,
      calendar,
      pace,
      workload,
      quality,
      checkpoint,
      status: overall,
      reasons: [...new Set(reasons)],
    };
  });
  const legacyResult = {
    policyVersion: RACE_PLAN_POLICY_V1.version,
    baseline: model.baseline,
    endurance: model.endurance,
    status: goalFeasibilities.reduce((status, goal) => worstStatus(status, goal.status), 'not_applicable'),
    goals: goalFeasibilities,
    weekTargets: model.weekTargets,
  };
  const goalBackwardMode = getGoalBackwardV24Mode();
  if (goalBackwardMode === 'off'
    || !context.goalBackwardWorkloadInput
    || typeof context.goalBackwardWorkloadInput !== 'object'
    || Array.isArray(context.goalBackwardWorkloadInput)) {
    return legacyResult;
  }
  return {
    ...legacyResult,
    goalBackwardWorkload: buildGoalBackwardWorkloadEvidence(context.goalBackwardWorkloadInput),
  };
}

module.exports = {
  baselineEvidence,
  buildPlanningModel,
  calendarForGoal,
  enduranceEvidence,
  evaluatePlanFeasibility,
  goalsFrom,
  ordinaryEasyMedians,
  paceFeasibility,
  worstStatus,
};
