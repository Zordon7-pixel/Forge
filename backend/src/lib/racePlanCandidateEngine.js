const {
  buildConcurrentPlan,
  rebuildCanonicalRunSession,
  validateConcurrentPlan,
} = require('./concurrentPlan');
const {
  RACE_PLAN_POLICY_V1,
  addDays,
  firstFullMonday,
  longRunIdentityFloor,
  mondayFor,
} = require('./racePlanPolicy');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function recentRunRows(history = {}) {
  return [history.recentRuns, history.meaningfulRuns, history.runs]
    .find(Array.isArray) || [];
}

function trustedActivityDates(context = {}, planningDateLocal) {
  const monday = mondayFor(planningDateLocal);
  const dates = new Set();
  const add = (value) => {
    const date = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= monday && date <= planningDateLocal) dates.add(date);
  };
  for (const date of context.history?.acuteRunLoad?.currentWeek?.runDates || []) add(date);
  for (const row of recentRunRows(context.history)) add(row.date || row.start_date || row.workout_date);
  return [...dates].sort();
}

function ordinaryEasyMedians(history = {}) {
  const rows = recentRunRows(history).filter((row) => {
    const type = String(row.type || row.workout_id || row.intensity || '').toLowerCase();
    const trusted = row.intensityTrusted === true
      || row.intensity_trusted === true
      || row.classificationTrusted === true
      || ['easy', 'recovery', 'easy_aerobic', 'recovery_run'].includes(type);
    const distance = Number(row.distanceMiles ?? row.distance_miles ?? row.distance ?? 0);
    const duration = Number(row.durationMinutes ?? row.duration_min ?? (
      Number(row.duration_seconds || 0) / 60
    ));
    return trusted
      && ['easy', 'recovery', 'easy_aerobic', 'recovery_run'].includes(type)
      && distance >= 0.5
      && duration >= 10;
  });
  return {
    miles: median(rows.map((row) => Number(row.distanceMiles ?? row.distance_miles ?? row.distance))),
    minutes: median(rows.map((row) => Number(row.durationMinutes ?? row.duration_min ?? (
      Number(row.duration_seconds || 0) / 60
    )))),
  };
}

function activeGoalForWeek(plan, week) {
  const goals = Array.isArray(plan.goals) && plan.goals.length ? plan.goals : [plan.goal].filter(Boolean);
  const weekEnd = addDays(week.startDate, 6);
  return goals.find((goal) => goal.date >= week.startDate && goal.date <= weekEnd)
    || goals.find((goal) => goal.date >= week.startDate)
    || goals[goals.length - 1]
    || {};
}

function paceAnchorSeconds(context = {}) {
  const candidates = [
    context.history?.acuteRunLoad?.latestRun?.paceSecondsPerMile,
    context.history?.performanceProfile?.targetAnchor?.equivalentPaceSecondsPerMile,
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return Math.min(1200, Math.max(360, candidates[0] || 720));
}

function expectedLongMinutes(distanceMiles, context) {
  const easyPaceSeconds = paceAnchorSeconds(context) * 1.08;
  return Math.min(
    RACE_PLAN_POLICY_V1.longRun.maximumDurationMinutes,
    Math.round(Number(distanceMiles || 0) * easyPaceSeconds / 60)
  );
}

function semanticLongRequirements(plan, week, context, medians) {
  const goal = activeGoalForWeek(plan, week);
  const raceDistance = Number(goal.distanceMiles || context.target?.distanceMiles || 0);
  const policyPhase = week.bridgeWeek ? 'bridge' : week.phase;
  const phaseFraction = RACE_PLAN_POLICY_V1.longRun.phaseFraction[policyPhase]
    ?? RACE_PLAN_POLICY_V1.longRun.phaseFraction.base;
  const distances = [
    longRunIdentityFloor(raceDistance),
    raceDistance * phaseFraction,
    medians.miles == null ? null : medians.miles * RACE_PLAN_POLICY_V1.longRun.ordinaryEasyDistanceMultiplier,
  ].filter(Number.isFinite);
  const durations = [
    RACE_PLAN_POLICY_V1.longRun.minimumDurationMinutes,
    medians.minutes == null ? null : medians.minutes * RACE_PLAN_POLICY_V1.longRun.ordinaryEasyDurationMultiplier,
  ].filter(Number.isFinite);
  return {
    distanceMiles: Math.max(...distances),
    durationMinutes: Math.max(...durations),
  };
}

function isLongSession(session = {}) {
  return String(session.type || '').toLowerCase() === 'long'
    || String(session.workout_id || '') === 'long_aerobic';
}

function reconcileLongSession(session, context) {
  const duration = expectedLongMinutes(session.distance_miles, context);
  return {
    ...session,
    duration_min: duration,
    durationIsEstimated: true,
    pace_anchor_seconds_per_mile: paceAnchorSeconds(context),
    dosage_reconciled: true,
  };
}

function totalRunMiles(week) {
  return round((week.days || []).flatMap((day) => day.sessions || [])
    .filter((session) => session.kind === 'run')
    .reduce((sum, session) => sum + Number(session.distance_miles || 0), 0));
}

function bridgeWeekIndex(plan, planningDateLocal) {
  return (plan.weeks || []).findIndex((week) => (
    planningDateLocal >= week.startDate && planningDateLocal <= addDays(week.startDate, 6)
  ));
}

function correctBridgeWeek(plan, context, planningDateLocal, activityDates) {
  const monday = mondayFor(planningDateLocal);
  const bridge = planningDateLocal > monday || activityDates.length > 0;
  if (!bridge) return null;
  const index = bridgeWeekIndex(plan, planningDateLocal);
  if (index < 0) return null;
  const week = plan.weeks[index];
  week.bridgeWeek = true;
  week.weekLabel = 'Bridge Week';
  week.excludedFromProgression = true;
  week.reason_codes = [...new Set([...(week.reason_codes || []), 'BRIDGE_WEEK'])];
  week.days = week.days.map((day) => {
    if (day.date < planningDateLocal) {
      return { ...day, sessions: [] };
    }
    if (activityDates.includes(day.date)) {
      return {
        ...day,
        sessions: (day.sessions || []).filter((session) => session.kind !== 'run'),
      };
    }
    return day;
  });
  const scheduledRuns = week.days.flatMap((day) => day.sessions || []).filter((session) => session.kind === 'run').length;
  week.currentWeekConstraint = {
    ...(week.currentWeekConstraint || {}),
    status: 'partial_current_week',
    bridgeWeek: true,
    requestedRunDaysPerWeek: Number(plan.schedulePreferences?.runDaysPerWeek || 0),
    scheduledRunCount: scheduledRuns,
    explanation: `Bridge Week preserves recorded work and schedules only legal remaining sessions. The full ${Number(plan.schedulePreferences?.runDaysPerWeek || 0)}-day selected frequency starts next week (${firstFullMonday(planningDateLocal, activityDates)}).`,
  };
  week.totalMiles = totalRunMiles(week);
  return index;
}

function correctLongRunSemantics(plan, context) {
  const medians = ordinaryEasyMedians(context.history || {});
  for (const week of plan.weeks || []) {
    const requirements = semanticLongRequirements(plan, week, context, medians);
    for (const day of week.days || []) {
      day.sessions = (day.sessions || []).map((session) => {
        if (!isLongSession(session) || String(session.type || '').toLowerCase() === 'race') return session;
        const reconciled = reconcileLongSession(session, context);
        const distancePasses = Number(reconciled.distance_miles || 0) + RACE_PLAN_POLICY_V1.epsilonMiles >= requirements.distanceMiles;
        const durationPasses = Number(reconciled.duration_min || 0) >= requirements.durationMinutes;
        if (distancePasses && durationPasses) {
          return {
            ...reconciled,
            semantic_minimum: {
              distance_miles: round(requirements.distanceMiles, 2),
              duration_min: Math.ceil(requirements.durationMinutes),
            },
          };
        }
        const rebuilt = rebuildCanonicalRunSession({
          session,
          weekNumber: week.week,
          weekCount: plan.weeks.length,
          day: day.day,
          type: 'easy',
          distance: session.distance_miles,
          phase: week.phase,
          context,
          reasonCodes: ['LONG_SEMANTIC_MINIMUM'],
        });
        const duration = Math.max(1, Math.round(Number(rebuilt.distance_miles || 0) * paceAnchorSeconds(context) * 1.08 / 60));
        return {
          ...rebuilt,
          duration_min: duration,
          durationIsEstimated: true,
          pace_anchor_seconds_per_mile: paceAnchorSeconds(context),
          dosage_reconciled: true,
          semantic_downgrade: {
            from_workout_id: session.workout_id,
            required_distance_miles: round(requirements.distanceMiles, 2),
            required_duration_min: Math.ceil(requirements.durationMinutes),
          },
        };
      });
      const timedRun = day.sessions.find((session) => session.kind === 'run' && Number(session.duration_min) > 0);
      if (timedRun) day.durationIsEstimated = Boolean(timedRun.durationIsEstimated);
    }
    week.totalMiles = totalRunMiles(week);
  }
}

function semanticCandidateErrors(plan, context, planningDateLocal) {
  const errors = [];
  const medians = ordinaryEasyMedians(context.history || {});
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    const requirements = semanticLongRequirements(plan, week, context, medians);
    for (const [dayIndex, day] of (week.days || []).entries()) {
      if (week.bridgeWeek && day.date < planningDateLocal && (day.sessions || []).length) {
        errors.push({ code: 'BRIDGE_WEEK_ELAPSED_SESSION', path: `weeks[${weekIndex}].days[${dayIndex}]` });
      }
      for (const [sessionIndex, session] of (day.sessions || []).entries()) {
        if (!isLongSession(session) || String(session.type || '').toLowerCase() === 'race') continue;
        const path = `weeks[${weekIndex}].days[${dayIndex}].sessions[${sessionIndex}]`;
        if (Number(session.distance_miles || 0) + RACE_PLAN_POLICY_V1.epsilonMiles < requirements.distanceMiles
          || Number(session.duration_min || 0) < requirements.durationMinutes) {
          errors.push({ code: 'LONG_SEMANTIC_MINIMUM', path });
        }
        const expected = expectedLongMinutes(session.distance_miles, context);
        if (Math.abs(expected - Number(session.duration_min || 0)) > 1) {
          errors.push({ code: 'TIME_DISTANCE_MISMATCH', path });
        }
      }
    }
  }
  return errors;
}

function buildRacePlanCandidate(context = {}, options = {}) {
  const planningDateLocal = String(
    options.planningDateLocal
      || context.planning_date_local
      || context.planningDateLocal
      || context.todayISO
      || ''
  ).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planningDateLocal) || !mondayFor(planningDateLocal)) {
    throw new Error('planningDateLocal must be a real YYYY-MM-DD date');
  }
  const normalizedContext = clone({ ...context, todayISO: planningDateLocal });
  const plan = buildConcurrentPlan(normalizedContext);
  const activityDates = trustedActivityDates(normalizedContext, planningDateLocal);
  const bridgeIndex = correctBridgeWeek(plan, normalizedContext, planningDateLocal, activityDates);
  correctLongRunSemantics(plan, normalizedContext);
  const firstFullWeekStart = firstFullMonday(planningDateLocal, activityDates);
  const firstFullWeek = (plan.weeks || []).find((week) => week.startDate === firstFullWeekStart);
  if (firstFullWeek) firstFullWeek.fullWeekFloorRestored = true;
  plan.policyVersion = RACE_PLAN_POLICY_V1.version;
  plan.engineVersion = RACE_PLAN_POLICY_V1.engineVersion;
  plan.planningClock = {
    planningDateLocal,
    timezoneOffsetMinutes: Number(options.timezoneOffsetMinutes ?? context.timezone_offset_minutes ?? 0),
  };
  plan.bridgeWeek = bridgeIndex == null ? null : {
    weekIndex: bridgeIndex,
    startDate: plan.weeks[bridgeIndex].startDate,
    firstFullWeekStart,
  };
  const semanticErrors = semanticCandidateErrors(plan, normalizedContext, planningDateLocal);
  const legacyValidation = context.history?.acuteRunLoad?.currentWeek
    ? validateConcurrentPlan(plan, normalizedContext)
    : { valid: true, errors: [] };
  const errors = [
    ...semanticErrors,
    ...legacyValidation.errors.map((message) => ({ code: 'LEGACY_VALIDATION', message })),
  ];
  return {
    plan,
    validation: { valid: errors.length === 0, errors },
  };
}

module.exports = {
  buildRacePlanCandidate,
  ordinaryEasyMedians,
  semanticCandidateErrors,
  trustedActivityDates,
};
