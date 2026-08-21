const {
  buildBenchmarkRunSession,
  buildConcurrentPlan,
  qualitySafetyForWeek,
  rebuildCanonicalRunSession,
  validateConcurrentPlan,
} = require('./concurrentPlan');
const {
  RACE_PLAN_POLICY_V1,
  addDays,
  canonicalHash,
  canonicalStringify,
  daysBetween,
  eventPolicyFor,
  firstFullMonday,
  longRunIdentityFloor,
  mondayFor,
  raceCategory,
} = require('./racePlanPolicy');
const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const {
  aggregateWeeklyStress,
  calculateFatigueCeilings,
  evaluateStressBudget,
  resolveStressVector,
  validateRollingHardDays,
} = require('./goalBackwardLoad');
const { finalizeGoalBackwardCandidateDecision } = require('./goalBackwardDecisionEngine');
const {
  buildPlanningModel,
  evaluatePlanFeasibility,
  ordinaryEasyMedians,
  paceFeasibility,
} = require('./planFeasibility');
const {
  compareMaterialChange,
  validateGoalBackwardCandidate,
  validateInterference,
  validatePresentationFloor,
} = require('./goalBackwardValidators');
const {
  canonicalRoadContributorFamily,
  materializeCanonicalSessionSet,
} = require('./canonicalWorkout');
const { buildCanonicalPlanFromSessionSet } = require('./planSchema');
const {
  buildCrossModalDoseLedger,
  buildDevelopmentRoleBinding,
} = require('./goalBackwardRecoveryMaterial');

const MAX_GOAL_BACKWARD_CANDIDATES = 64;
const MAX_GOAL_BACKWARD_SEARCH_FRONTIER = 256;
const MAX_GOAL_BACKWARD_SEARCH_NODES = 65536;
const MAX_GOAL_BACKWARD_ROLE_COUNT = 14;
const MAX_GOAL_BACKWARD_AVAILABLE_DATES = 14;
const MAX_GOAL_BACKWARD_FAMILIES_PER_ROLE = 8;
const MAX_GOAL_BACKWARD_PLACEMENT_CHOICES_PER_ROLE = 32;
const ROLE_RANK = Object.freeze({ PRIMARY_KEY: 0, ASSESSMENT: 1, SUPPORTING: 2, RECOVERY: 3, REST: 4 });
const RUNNING_GOAL_BACKWARD_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
  'assessment', 'race',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
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

function runEntriesForWeek(week) {
  return (week.days || []).flatMap((day) => (day.sessions || []).map((session, sessionIndex) => ({
    week,
    day,
    session,
    sessionIndex,
  }))).filter(({ session }) => session.kind === 'run');
}

function allRunEntries(plan) {
  return (plan.weeks || []).flatMap(runEntriesForWeek);
}

function setEntrySession(entry, session) {
  entry.day.sessions[entry.sessionIndex] = session;
  entry.session = session;
  const timedRun = entry.day.sessions.find((candidate) => candidate.kind === 'run' && Number(candidate.duration_min) > 0);
  if (timedRun) entry.day.durationIsEstimated = Boolean(timedRun.durationIsEstimated);
}

function rebuildEntry(entry, plan, context, options = {}) {
  const source = options.sourceSession || entry.session;
  const rebuilt = rebuildCanonicalRunSession({
    session: source,
    weekNumber: entry.week.week,
    weekCount: plan.weeks.length,
    day: entry.day.day,
    type: options.type || source.type || 'easy',
    workoutId: options.workoutId || null,
    distance: Number(options.distance ?? source.distance_miles ?? 1),
    phase: entry.week.phase,
    context,
    reasonCodes: options.reasonCodes || [],
  });
  setEntrySession(entry, rebuilt);
  return rebuilt;
}

function isOrdinaryWeek(week) {
  return !week.bridgeWeek && !['taper', 'race', 'deload'].includes(String(week.phase || '').toLowerCase());
}

function applyPlanningCurve(plan, context, planningModel) {
  const targets = new Map(planningModel.weekTargets.map((target) => [target.startDate, target]));
  for (const week of plan.weeks || []) {
    if (!isOrdinaryWeek(week)) continue;
    const target = targets.get(week.startDate);
    if (!target) continue;
    const entries = runEntriesForWeek(week).filter(({ session }) => session.type !== 'race');
    if (!entries.length) continue;

    let longEntry = entries.find(({ session }) => isLongSession(session));
    if (target.targetLongMiles == null) {
      if (longEntry) {
        rebuildEntry(longEntry, plan, context, {
          type: 'easy',
          workoutId: 'easy_aerobic',
          reasonCodes: ['NO_LONG_RUN_ANCHOR'],
        });
      }
      longEntry = null;
    } else {
      longEntry ||= [...entries].reverse().find(({ session }) => !runWorkoutTaxonomy.isQualityWorkout(session.workout_id));
      if (longEntry) {
        const requirements = semanticLongRequirements(plan, week, context, ordinaryEasyMedians(context.history || {}));
        const safeLong = Number(target.safeLongMiles);
        if (safeLong + RACE_PLAN_POLICY_V1.epsilonMiles >= requirements.distanceMiles) {
          rebuildEntry(longEntry, plan, context, {
            type: 'long',
            workoutId: 'long_aerobic',
            distance: Math.min(safeLong, Math.max(Number(target.targetLongMiles), requirements.distanceMiles)),
            reasonCodes: ['RACE_DEMAND_CURVE'],
          });
        } else {
          rebuildEntry(longEntry, plan, context, {
            type: 'easy',
            workoutId: 'easy_aerobic',
            reasonCodes: ['NO_LONG_RUN_ANCHOR', 'LONG_SEMANTIC_MINIMUM'],
          });
          longEntry = null;
        }
      }
    }

    if (target.targetWeeklyMiles == null) {
      week.totalMiles = totalRunMiles(week);
      continue;
    }
    const activeEntries = runEntriesForWeek(week).filter(({ session }) => session.type !== 'race');
    const fixedLongMiles = longEntry ? Number(longEntry.session.distance_miles || 0) : 0;
    const donors = activeEntries.filter((entry) => !longEntry
      || entry.day !== longEntry.day
      || entry.sessionIndex !== longEntry.sessionIndex);
    const donorFloor = donors.length;
    const available = Math.max(donorFloor, Number(target.targetWeeklyMiles) - fixedLongMiles);
    const sourceTotal = donors.reduce((sum, entry) => sum + Math.max(1, Number(entry.session.distance_miles || 0)), 0) || donors.length;
    let assigned = 0;
    donors.forEach((entry, index) => {
      const isLast = index === donors.length - 1;
      const sourceMiles = Math.max(1, Number(entry.session.distance_miles || 0));
      const distance = isLast
        ? Math.max(1, round(available - assigned, 1))
        : Math.max(1, round(available * sourceMiles / sourceTotal, 1));
      assigned += distance;
      rebuildEntry(entry, plan, context, {
        type: entry.session.type,
        workoutId: entry.session.workout_id,
        distance,
        reasonCodes: ['RACE_DEMAND_CURVE'],
      });
    });
    week.totalMiles = totalRunMiles(week);
    week.policyTarget = target;
  }
}

function goalForWeek(planningModel, week) {
  return planningModel.goals.find((goal) => goal.date >= week.startDate)
    || planningModel.goals[planningModel.goals.length - 1]
    || null;
}

function desiredQualityWorkout(calendar, weekStart, goal) {
  const index = calendar.eligibleFullWeekStarts.indexOf(weekStart);
  const count = calendar.eligibleFullWeekStarts.length;
  if (index < 0) return null;
  const racePaceWeeks = RACE_PLAN_POLICY_V1.qualityExposure[raceCategory(goal?.distanceMiles)]?.racePace || 1;
  if (index >= count - racePaceWeeks) return 'race_pace_intervals';
  if (index === 0) return 'aerobic_hill_repeats';
  if (index === 1) return 'tempo_threshold';
  if (index === 2) return 'short_intervals';
  return index % 2 === 0 ? 'tempo_threshold' : 'fartlek';
}

function selectQualityEntry(plan, entries) {
  const protectedDemandingDates = allRunEntries(plan)
    .filter(({ session }) => session.type === 'race' || isLongSession(session))
    .map(({ day }) => day.date);
  return [...entries].sort((left, right) => {
    const minimumGap = (entry) => Math.min(
      ...protectedDemandingDates.map((date) => Math.abs(daysBetween(date, entry.day.date))),
      Number.POSITIVE_INFINITY
    );
    const gapDifference = minimumGap(right) - minimumGap(left);
    return gapDifference || left.day.date.localeCompare(right.day.date);
  })[0];
}

function assignQualityProgression(plan, context, planningModel) {
  for (const week of plan.weeks || []) {
    if (!isOrdinaryWeek(week)) continue;
    if (qualitySafetyForWeek(context, { weekNumber: week.week, weekStart: week.startDate }).active) continue;
    const goal = goalForWeek(planningModel, week);
    const goalCalendar = planningModel.calendars.find((entry) => entry.goal.raceId === goal?.raceId);
    const workoutId = goalCalendar ? desiredQualityWorkout(goalCalendar.calendar, week.startDate, goal) : null;
    if (!workoutId) continue;
    const entries = runEntriesForWeek(week).filter(({ session }) => session.type !== 'race' && !isLongSession(session));
    if (!entries.length) continue;
    const qualityEntry = selectQualityEntry(plan, entries);
    const taxonomy = runWorkoutTaxonomy.workoutForId(workoutId);
    const paceSeconds = workoutId === 'race_pace_intervals' && goal?.goalTimeSeconds
      ? Math.round(goal.goalTimeSeconds / goal.distanceMiles)
      : null;
    const paceLabel = paceSeconds
      ? `${Math.floor(paceSeconds / 60)}:${String(paceSeconds % 60).padStart(2, '0')}/mi`
      : null;
    rebuildEntry(qualityEntry, plan, context, {
      sourceSession: {
        ...qualityEntry.session,
        ...(paceSeconds ? {
          goal_pace_seconds_per_mile: paceSeconds,
          goal_pace_label: paceLabel,
          goal_pace_status: goal?.paceContext?.status || null,
        } : {}),
      },
      type: taxonomy.type,
      workoutId,
      distance: qualityEntry.session.distance_miles,
      reasonCodes: ['QUALITY_PROGRESSION'],
    });
    for (const entry of entries) {
      if (entry === qualityEntry || !runWorkoutTaxonomy.isQualityWorkout(entry.session.workout_id)) continue;
      rebuildEntry(entry, plan, context, {
        type: 'easy',
        workoutId: 'easy_aerobic',
        distance: entry.session.distance_miles,
        reasonCodes: ['QUALITY_PROGRESSION'],
      });
    }
  }
}

function distributeWeekMiles(plan, context, week, targetMiles) {
  const entries = runEntriesForWeek(week).filter(({ session }) => session.type !== 'race');
  if (!entries.length || !(targetMiles > 0)) return;
  const sourceTotal = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.session.distance_miles || 0)), 0);
  let assigned = 0;
  entries.forEach((entry, index) => {
    const distance = index === entries.length - 1
      ? Math.max(1, round(targetMiles - assigned, 1))
      : Math.max(1, round(targetMiles * Math.max(1, Number(entry.session.distance_miles || 0)) / sourceTotal, 1));
    assigned += distance;
    rebuildEntry(entry, plan, context, {
      type: entry.session.type,
      workoutId: entry.session.workout_id,
      distance,
      reasonCodes: ['EXCLUDED_WEEK_NORMALIZATION'],
    });
  });
  week.totalMiles = totalRunMiles(week);
}

function normalizeExcludedWeeks(plan, context) {
  let priorOrdinaryMiles = null;
  let priorWeekMiles = null;
  for (const week of plan.weeks || []) {
    if (isOrdinaryWeek(week)) {
      priorOrdinaryMiles = Number(week.totalMiles || totalRunMiles(week));
      priorWeekMiles = priorOrdinaryMiles;
      continue;
    }
    if (week.bridgeWeek || week.phase === 'race') {
      priorWeekMiles = Number(week.totalMiles || totalRunMiles(week));
      continue;
    }
    const entries = runEntriesForWeek(week).filter(({ session }) => session.type !== 'race');
    if (week.phase === 'deload') {
      entries.forEach((entry) => {
        if (isLongSession(entry.session) || runWorkoutTaxonomy.isQualityWorkout(entry.session.workout_id)) {
          rebuildEntry(entry, plan, context, {
            type: 'recovery',
            workoutId: 'recovery_run',
            distance: entry.session.distance_miles,
            reasonCodes: ['DELOAD_VOLUME_REDUCTION'],
          });
        }
      });
    } else if (week.phase === 'taper') {
      let sharpeningKept = false;
      entries.forEach((entry) => {
        if (!sharpeningKept && entry.session.workout_id === 'sharpening_strides') {
          sharpeningKept = true;
          return;
        }
        if (isLongSession(entry.session) || runWorkoutTaxonomy.isQualityWorkout(entry.session.workout_id)) {
          rebuildEntry(entry, plan, context, {
            type: 'easy',
            workoutId: 'easy_aerobic',
            distance: entry.session.distance_miles,
            reasonCodes: ['TAPER_VOLUME_REDUCTION'],
          });
        }
      });
    }
    if (priorOrdinaryMiles != null) {
      const factor = week.phase === 'taper' ? 0.72 : 0.82;
      const comparisonMiles = Math.min(priorOrdinaryMiles, priorWeekMiles || priorOrdinaryMiles);
      distributeWeekMiles(plan, context, week, Math.max(entries.length, round(comparisonMiles * factor, 1)));
    }
    priorWeekMiles = Number(week.totalMiles || totalRunMiles(week));
  }
}

function placeRequiredBenchmark(plan, context, planningModel) {
  const needsBenchmark = planningModel.calendars.some(({ goal, calendar }) => (
    goal.goalType === 'pr'
    && goal.goalTimeSeconds
    && ['stretch', 'unsafe'].includes(paceFeasibility(goal, calendar, context).status)
    && calendar.fullTrainingWeeks > 0
  ));
  if (!needsBenchmark) return;
  const firstEligibleStart = planningModel.calendars
    .flatMap(({ calendar }) => calendar.eligibleFullWeekStarts)
    .sort()[0];
  const week = (plan.weeks || []).find((candidate) => candidate.startDate === firstEligibleStart);
  if (!week) return;
  if (qualitySafetyForWeek(context, { weekNumber: week.week, weekStart: week.startDate }).active) return;
  const entry = runEntriesForWeek(week).find(({ session }) => (
    session.type !== 'race' && !isLongSession(session) && runWorkoutTaxonomy.isQualityWorkout(session.workout_id)
  ));
  if (!entry) return;
  setEntrySession(entry, buildBenchmarkRunSession({
    ...entry.session,
    reason_codes: [...new Set([...(entry.session.reason_codes || []), 'NO_PERFORMANCE_ANCHOR'])],
  }));
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

function isDemanding(entry) {
  const workout = runWorkoutTaxonomy.workoutForId(entry.session.workout_id);
  return entry.session.type === 'race'
    || (isLongSession(entry.session) && entry.session.workout_id === 'long_aerobic')
    || Boolean(workout?.quality);
}

function demandingConflict(entries) {
  const sorted = entries.filter(isDemanding).sort((left, right) => left.day.date.localeCompare(right.day.date));
  for (let index = 1; index < sorted.length; index += 1) {
    if (daysBetween(sorted[index - 1].day.date, sorted[index].day.date)
      <= RACE_PLAN_POLICY_V1.demandingSessions.minimumInterveningCalendarDates) {
      return [sorted[index - 1], sorted[index]];
    }
  }
  for (let index = 0; index + RACE_PLAN_POLICY_V1.demandingSessions.maximumInRollingSevenDays < sorted.length; index += 1) {
    const end = sorted[index + RACE_PLAN_POLICY_V1.demandingSessions.maximumInRollingSevenDays];
    if (daysBetween(sorted[index].day.date, end.day.date) <= 6) {
      return sorted.slice(index, index + RACE_PLAN_POLICY_V1.demandingSessions.maximumInRollingSevenDays + 1);
    }
  }
  return null;
}

function canPlaceDemanding(date, fixedEntries) {
  const candidateDates = [...fixedEntries].filter(isDemanding).map((entry) => entry.day.date).sort();
  if (candidateDates.some((other) => Math.abs(daysBetween(other, date))
    <= RACE_PLAN_POLICY_V1.demandingSessions.minimumInterveningCalendarDates)) return false;
  const dates = [...candidateDates, date].sort();
  for (let index = 0; index + RACE_PLAN_POLICY_V1.demandingSessions.maximumInRollingSevenDays < dates.length; index += 1) {
    if (daysBetween(dates[index], dates[index + RACE_PLAN_POLICY_V1.demandingSessions.maximumInRollingSevenDays]) <= 6) return false;
  }
  return true;
}

function moveQualityEntry(plan, context, sourceEntry) {
  const allEntries = allRunEntries(plan);
  const isSource = (entry) => entry.day === sourceEntry.day && entry.sessionIndex === sourceEntry.sessionIndex;
  const fixed = allEntries.filter((entry) => !isSource(entry));
  const candidates = runEntriesForWeek(sourceEntry.week)
    .filter((entry) => !isSource(entry)
      && entry.session.type !== 'race'
      && !isLongSession(entry.session)
      && !runWorkoutTaxonomy.isQualityWorkout(entry.session.workout_id))
    .filter((entry) => canPlaceDemanding(entry.day.date, fixed))
    .sort((left, right) => Math.abs(daysBetween(left.day.date, sourceEntry.day.date))
      - Math.abs(daysBetween(right.day.date, sourceEntry.day.date)));
  const targetEntry = candidates[0];
  if (!targetEntry) return false;
  const sourceSession = sourceEntry.session;
  const targetSession = targetEntry.session;
  rebuildEntry(sourceEntry, plan, context, {
    type: 'easy',
    workoutId: 'easy_aerobic',
    distance: sourceSession.distance_miles,
    reasonCodes: ['DEMANDING_SESSION_SPACING'],
  });
  rebuildEntry(targetEntry, plan, context, {
    sourceSession: { ...sourceSession, id: targetSession.id },
    type: sourceSession.type,
    workoutId: sourceSession.workout_id,
    distance: targetSession.distance_miles,
    reasonCodes: ['DEMANDING_SESSION_SPACING'],
  });
  return true;
}

function downgradeDemandingEntry(plan, context, entry) {
  rebuildEntry(entry, plan, context, {
    type: 'easy',
    workoutId: 'easy_aerobic',
    distance: entry.session.distance_miles,
    reasonCodes: ['DEMANDING_SESSION_SPACING', 'QUALITY_EXPOSURE_MISSING'],
  });
}

function enforceDemandingSpacing(plan, context) {
  let attempts = 0;
  let conflict = demandingConflict(allRunEntries(plan));
  while (conflict && attempts < 40) {
    attempts += 1;
    const movable = conflict.find((entry) => (
      entry.session.type !== 'race'
      && !isLongSession(entry.session)
      && runWorkoutTaxonomy.isQualityWorkout(entry.session.workout_id)
    ));
    if (movable && moveQualityEntry(plan, context, movable)) {
      conflict = demandingConflict(allRunEntries(plan));
      continue;
    }
    const downgrade = movable || conflict.find((entry) => entry.session.type !== 'race');
    if (!downgrade) break;
    downgradeDemandingEntry(plan, context, downgrade);
    conflict = demandingConflict(allRunEntries(plan));
  }
  for (const week of plan.weeks || []) week.totalMiles = totalRunMiles(week);
  return conflict == null;
}

function syncOrderGuidance(day) {
  const kinds = new Set((day.sessions || []).map((session) => session.kind));
  if (kinds.has('run') && kinds.has('lift')) {
    day.orderGuidance ||= 'Run first; lift at least 6 hours later.';
  } else {
    delete day.orderGuidance;
  }
}

function reconcileLowerBodyStrength(plan) {
  const allowedDays = new Set(plan.schedulePreferences?.trainingDays || []);
  for (const week of plan.weeks || []) {
    const earliestTargetDate = week.bridgeWeek && plan.planningClock
      ? plan.planningClock.planningDateLocal
      : null;
    const hardIndexes = new Set();
    for (const [dayIndex, day] of (week.days || []).entries()) {
      if ((day.sessions || []).some((session) => session.kind === 'run' && isDemanding({ session }))) {
        hardIndexes.add(dayIndex);
      }
    }
    for (const [sourceIndex, sourceDay] of (week.days || []).entries()) {
      const lowerIndex = (sourceDay.sessions || []).findIndex((session) => (
        session.kind === 'strength' || session.kind === 'lift'
      ) && /lower/i.test(String(session.focus || '')));
      if (lowerIndex < 0 || [...hardIndexes].every((hardIndex) => Math.abs(hardIndex - sourceIndex) > 1)) continue;
      const targetIndex = (week.days || []).findIndex((day, dayIndex) => (
        dayIndex !== sourceIndex
        && allowedDays.has(day.day)
        && (!earliestTargetDate || day.date >= earliestTargetDate)
        && [...hardIndexes].every((hardIndex) => Math.abs(hardIndex - dayIndex) > 1)
        && !(day.sessions || []).some((session) => (
          session.kind === 'strength' || session.kind === 'lift'
        ) && /lower/i.test(String(session.focus || '')))
        && ((day.sessions || []).some((session) => (
          session.kind === 'strength' || session.kind === 'lift'
        ) && /upper/i.test(String(session.focus || ''))) || (day.sessions || []).length < 2)
      ));
      if (targetIndex < 0) continue;
      const targetDay = week.days[targetIndex];
      const upperIndex = (targetDay.sessions || []).findIndex((session) => (
        session.kind === 'strength' || session.kind === 'lift'
      ) && /upper/i.test(String(session.focus || '')));
      const lowerSession = sourceDay.sessions[lowerIndex];
      if (upperIndex >= 0) {
        const upperSession = targetDay.sessions[upperIndex];
        sourceDay.sessions[lowerIndex] = upperSession;
        targetDay.sessions[upperIndex] = lowerSession;
      } else {
        sourceDay.sessions.splice(lowerIndex, 1);
        targetDay.sessions.push(lowerSession);
      }
      sourceDay.status = 'adjusted';
      targetDay.status = 'adjusted';
      sourceDay.whyToday = 'Lower-body strength moved away from the week\'s demanding run.';
      targetDay.whyToday = 'Lower-body strength is placed here to preserve recovery around quality and long running.';
      syncOrderGuidance(sourceDay);
      syncOrderGuidance(targetDay);
    }
  }
}

function peakLongRun(plan) {
  const entries = allRunEntries(plan).filter(({ session }) => (
    session.workout_id === 'long_aerobic' && session.type === 'long'
  ));
  const peak = entries.sort((left, right) => Number(right.session.distance_miles || 0)
    - Number(left.session.distance_miles || 0))[0];
  return peak ? {
    distance_miles: Number(peak.session.distance_miles),
    week: peak.week.week,
    date: peak.day.date,
  } : null;
}

function annotateCandidate(plan, feasibility, planningModel) {
  for (const week of plan.weeks || []) {
    const entries = runEntriesForWeek(week);
    const quality = entries.find(({ session }) => runWorkoutTaxonomy.isQualityWorkout(session.workout_id));
    const long = entries.find(({ session }) => session.workout_id === 'long_aerobic' && session.type === 'long');
    const strengthCount = (week.days || []).flatMap((day) => day.sessions || [])
      .filter((session) => session.kind === 'strength').length;
    week.purpose = week.bridgeWeek
      ? 'Preserve completed work and bridge safely into the first full training week.'
      : week.phase === 'race' ? 'Arrive fresh and execute the race plan.'
        : week.phase === 'taper' ? 'Reduce fatigue while retaining race rhythm.'
          : week.phase === 'deload' ? 'Absorb training before the next build.'
            : week.phase === 'peak' ? 'Reach the block\'s highest race-specific demand.'
              : week.phase === 'build' ? 'Build endurance and sustainable speed toward race demand.'
                : 'Establish repeatable aerobic volume and durable mechanics.';
    week.keyQualitySession = quality ? {
      date: quality.day.date,
      workout_id: quality.session.workout_id,
      title: quality.session.title,
      purpose: quality.session.purpose || quality.session.description,
    } : null;
    week.longRunTarget = long ? {
      date: long.day.date,
      distance_miles: Number(long.session.distance_miles),
      duration_min: Number(long.session.duration_min),
    } : null;
    week.strengthIntent = strengthCount
      ? `${strengthCount} scheduled strength session${strengthCount === 1 ? '' : 's'} preserve the selected strength floor.`
      : 'No strength session is required in this run-only week.';
  }
  plan.overall_feasibility = feasibility.status;
  plan.goal_feasibilities = feasibility.goals.map((goal) => ({
    race_id: goal.raceId,
    race_name: goal.name,
    feasibility: goal.status,
    goal: {
      date: goal.date,
      distance_miles: goal.distanceMiles,
      goal_type: goal.goalType,
    },
    full_training_weeks: goal.fullTrainingWeeks,
    checkpoint: goal.checkpoint,
    reasons: goal.reasons,
    pace: goal.pace,
    workload: goal.workload,
    quality: goal.quality,
  }));
  plan.weekly_curve = feasibility.weekTargets;
  plan.peak_long_run = peakLongRun(plan);
  plan.anchor = contextAnchor(planningModel);
  plan.checkpoint = feasibility.goals.find((goal) => goal.checkpoint)?.checkpoint || null;
  plan.reasons = [...new Set(feasibility.goals.flatMap((goal) => goal.reasons))];
  plan.choices = ['train_for_target', 'adjust_goal', 'completion_first'];
  plan.whyThisPlan = {
    summary: feasibility.status === 'supported'
      ? 'Recorded training and the available calendar support this block.'
      : feasibility.status === 'stretch'
        ? 'This block needs a successful checkpoint before the goal can be treated as supported.'
        : 'The current evidence or calendar cannot safely support the requested target yet.',
    baseline: feasibility.baseline,
    endurance: feasibility.endurance,
    reason_codes: plan.reasons,
  };
}

function contextAnchor(planningModel) {
  return {
    weekly_baseline: planningModel.baseline,
    recent_endurance: planningModel.endurance,
  };
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
  const spacing = demandingConflict(allRunEntries(plan));
  if (spacing) {
    errors.push({
      code: 'DEMANDING_SESSION_SPACING',
      path: spacing.map((entry) => entry.day.date).join(','),
    });
  }
  return errors;
}

function buildRacePlanCandidate(context = {}, options = {}) {
  const planningDateLocal = validLocalDate(
    options.planningDateLocal
      || context.planning_date_local
      || context.planningDateLocal
      || context.todayISO
      || ''
  );
  if (!planningDateLocal || !mondayFor(planningDateLocal)) {
    throw new Error('planningDateLocal must be a real YYYY-MM-DD date');
  }
  const normalizedContext = clone({ ...context, todayISO: planningDateLocal });
  const plan = buildConcurrentPlan(normalizedContext);
  const activityDates = trustedActivityDates(normalizedContext, planningDateLocal);
  const bridgeIndex = correctBridgeWeek(plan, normalizedContext, planningDateLocal, activityDates);
  const firstFullWeekStart = firstFullMonday(planningDateLocal, activityDates);
  const firstFullWeek = (plan.weeks || []).find((week) => week.startDate === firstFullWeekStart);
  if (firstFullWeek) firstFullWeek.fullWeekFloorRestored = true;
  plan.policyVersion = RACE_PLAN_POLICY_V1.version;
  plan.engineVersion = RACE_PLAN_POLICY_V1.engineVersion;
  plan.invariantVersion = RACE_PLAN_POLICY_V1.invariantVersion;
  plan.planningClock = {
    planningDateLocal,
    timezoneOffsetMinutes: Number(options.timezoneOffsetMinutes ?? context.timezone_offset_minutes ?? 0),
  };
  plan.bridgeWeek = bridgeIndex == null ? null : {
    weekIndex: bridgeIndex,
    startDate: plan.weeks[bridgeIndex].startDate,
    firstFullWeekStart,
  };
  const planningModel = buildPlanningModel(plan, normalizedContext);
  applyPlanningCurve(plan, normalizedContext, planningModel);
  assignQualityProgression(plan, normalizedContext, planningModel);
  placeRequiredBenchmark(plan, normalizedContext, planningModel);
  normalizeExcludedWeeks(plan, normalizedContext);
  correctLongRunSemantics(plan, normalizedContext);
  enforceDemandingSpacing(plan, normalizedContext);
  reconcileLowerBodyStrength(plan);
  const feasibility = evaluatePlanFeasibility(plan, normalizedContext, planningModel);
  annotateCandidate(plan, feasibility, planningModel);
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

const LEGACY_TO_GOAL_BACKWARD_FAMILY = Object.freeze({
  easy: 'easy_run',
  recovery: 'recovery_run',
  long: 'long_aerobic',
  threshold: 'threshold_run',
  intervals: 'interval_run',
  race_pace: 'race_rhythm_run',
  progression: 'steady_run',
  benchmark: 'assessment',
  race: 'race',
  speed: 'interval_run',
  hills: 'threshold_run',
  sharpening: 'race_rhythm_run',
});

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

function legacyCandidateMaterialEntries(source) {
  if (Array.isArray(source)) return source;
  if (source?.plan) return legacyCandidateMaterialEntries(source.plan);
  if (Array.isArray(source?.sessions)) return source.sessions;
  return (source?.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ ...session, date: session.date || day.date }))
  )));
}

function legacyGoalBackwardFamily(session = {}) {
  if (session.workout_family && resolveStressVector(session.workout_family)) return session.workout_family;
  const taxonomy = runWorkoutTaxonomy.workoutForId(session.workout_id);
  const aliases = {
    easy_run: 'easy_run',
    long_run: 'long_aerobic',
    hyrox_skill: 'hyrox_station_skill',
    hyrox_compromised: 'hyrox_compromised',
    hyrox_partial_simulation: 'hyrox_partial_simulation',
    hyrox_full_simulation: 'hyrox_full_simulation',
  };
  for (const value of [taxonomy?.family, session.workout_family, session.sessionType, session.session_type, session.type]) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) continue;
    if (resolveStressVector(normalized)) return normalized;
    if (aliases[normalized]) return aliases[normalized];
    if (LEGACY_TO_GOAL_BACKWARD_FAMILY[normalized]) return LEGACY_TO_GOAL_BACKWARD_FAMILY[normalized];
  }
  return null;
}

function finiteCandidateMaterialNumber(...values) {
  const value = values.find((candidate) => candidate !== null && candidate !== undefined);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recentNormalRunningMinutesPerWeek(options = {}) {
  const direct = finiteCandidateMaterialNumber(options.recent_normal_running_minutes_per_week);
  if (direct !== null && direct >= 0) return direct;
  const medianDurationSeconds = finiteCandidateMaterialNumber(
    options.recent_normal_running?.median_duration_s,
  );
  return medianDurationSeconds !== null && medianDurationSeconds >= 0
    ? medianDurationSeconds / 60 : null;
}

function executableFoundationRecoveryDurationMinutes(sourceDuration, options = {}) {
  const duration = finiteCandidateMaterialNumber(sourceDuration);
  if (duration === null || duration < 0) return duration;
  return [...new Set([duration, 15, 20])]
    .filter((candidate) => candidate >= duration)
    .sort((left, right) => left - right)
    .find((candidate) => validatePresentationFloor([{
      workout_family: 'recovery_run',
      duration_min: candidate,
    }], options).valid) ?? duration;
}

function preferredMaterialFamilyForFloor(session, decision, options = {}) {
  const sourceFamily = session.material_source === 'CURRENT_HYBRID_RUNNING_COMPONENT'
    ? 'easy_run' : session.material_source_workout_family;
  if (decision.phase !== 'FOUNDATION' || sourceFamily !== 'easy_run') return sourceFamily;
  const easyFloor = validatePresentationFloor([
    { ...session, workout_family: 'easy_run' },
  ], options);
  const recoveryFloor = validatePresentationFloor([{
    ...session,
    workout_family: 'recovery_run',
    duration_min: executableFoundationRecoveryDurationMinutes(session.duration_min, options),
  }], options);
  return !easyFloor.valid && recoveryFloor.valid ? 'recovery_run' : sourceFamily;
}

function roadCandidateMaterial(source) {
  return legacyCandidateMaterialEntries(source).map((session, index) => {
    const durationMin = finiteCandidateMaterialNumber(session.duration_min, session.durationMin);
    const sourceFamily = legacyGoalBackwardFamily(session);
    const hybridRunningSource = ['hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation']
      .includes(sourceFamily)
      || (sourceFamily === 'race'
        && String(session?.kind || '').toLowerCase() === 'hyrox'
        && session?.includesRun === true);
    const declaresHybridRunningDistance = hybridRunningSource
      && session.running_distance_m !== null && session.running_distance_m !== undefined;
    const distanceM = declaresHybridRunningDistance
      ? finiteCandidateMaterialNumber(session.running_distance_m)
      : finiteCandidateMaterialNumber(session.distance_m, session.distanceMeters);
    const distanceMiles = finiteCandidateMaterialNumber(session.distance_miles, session.distanceMiles);
    const qualityWorkDurationMin = finiteCandidateMaterialNumber(
      session.quality_work_duration_min, session.qualityWorkDurationMin,
    );
    const mainWorkDurationMin = finiteCandidateMaterialNumber(
      session.main_work_duration_min, session.mainWorkDurationMin,
    );
    const runStationPairCount = finiteCandidateMaterialNumber(
      session.run_station_pair_count, session.runStationPairCount,
    );
    return {
      material_id: String(session.session_id ?? session.id ?? `road-material-${index + 1}`),
      source_workout_id: session.workout_id ?? null,
      workout_family: sourceFamily,
      legacy_scheduled_local_date: validLocalDate(
        session.scheduled_local_date ?? session.date
      ),
      source_kind: session.kind ?? 'run',
      source_title: session.title ?? null,
      duration_min: durationMin,
      distance_m: distanceM,
      distance_miles: distanceMiles,
      quality_work_duration_min: qualityWorkDurationMin,
      main_work_duration_min: mainWorkDurationMin,
      run_station_pair_count: runStationPairCount,
      source_session: {
        ...clone(session),
        duration_min: durationMin,
        distance_m: distanceM,
        distance_miles: distanceMiles,
        quality_work_duration_min: qualityWorkDurationMin,
        main_work_duration_min: mainWorkDurationMin,
        run_station_pair_count: runStationPairCount,
      },
    };
  });
}

function projectableHybridRunningMaterial(material) {
  if (['hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation']
    .includes(material?.workout_family)) return true;
  const source = material?.source_session;
  return material?.workout_family === 'race'
    && String(source?.kind || '').toLowerCase() === 'hyrox'
    && source?.includesRun === true;
}

function canonicalRoadCandidateMaterial(source, hybridProjectionPaceSecondsPerMile = null) {
  const materials = roadCandidateMaterial(source);
  const hybridProjectionPace = finiteCandidateMaterialNumber(hybridProjectionPaceSecondsPerMile);
  const hybridProjectionPaceAvailable = hybridProjectionPace >= 180 && hybridProjectionPace <= 2400;
  if (!hybridProjectionPaceAvailable) return materials;
  for (const material of materials) {
    const candidateSource = material.source_session || {};
    const durationMin = finiteCandidateMaterialNumber(material.duration_min);
    const displayedMiles = finiteCandidateMaterialNumber(material.distance_miles);
    if (String(candidateSource.prescription_basis || '').toLowerCase() !== 'time'
      || candidateSource.distance_is_estimate !== true || !(durationMin > 0) || !(displayedMiles > 0)) continue;
    const conservativePaceSecondsPerMile = hybridProjectionPace * 1.1;
    const timeBoundMiles = (durationMin * 60) / conservativePaceSecondsPerMile;
    const prescribedDistanceM = Math.floor(Math.min(displayedMiles, timeBoundMiles) * 1609.344);
    if (prescribedDistanceM <= 0) continue;
    material.distance_m = prescribedDistanceM;
    material.source_session = {
      ...candidateSource,
      canonical_prescribed_distance_m: prescribedDistanceM,
      canonical_distance_derivation: 'observed_pace_conservative_110_percent_v1',
    };
  }
  return materials;
}

function placementFor(placements, requirementId) {
  const placement = placements?.[requirementId];
  if (typeof placement === 'string') return { scheduled_local_date: validLocalDate(placement), scheduled_start_at: null, workout_family: null };
  if (!placement || typeof placement !== 'object') return { scheduled_local_date: null, scheduled_start_at: null, workout_family: null };
  return {
    scheduled_local_date: validLocalDate(placement.scheduled_local_date ?? placement.date),
    scheduled_start_at: placement.scheduled_start_at ?? null,
    workout_family: placement.workout_family ?? placement.workoutFamily ?? null,
  };
}

function goalBackwardSkeletonIdentity(input = {}) {
  const decision = input.decision;
  if (!decision || !decision.decision_id || !Array.isArray(decision.role_multiset)) {
    throw new Error('an immutable PlanningDecision with a role multiset is required');
  }
  const hybridProjectionPace = finiteCandidateMaterialNumber(input.hybrid_running_projection_pace_s_per_mile);
  const materials = canonicalRoadCandidateMaterial(
    input.legacy_road_candidate_material || [],
    hybridProjectionPace,
  );
  const usedMaterialIds = new Set();
  const hybridProjectionPaceAvailable = hybridProjectionPace >= 180 && hybridProjectionPace <= 2400;
  const assignedMaterials = decision.role_multiset.map((role) => {
    const boundMaterialId = typeof role.candidate_material_id === 'string'
      ? role.candidate_material_id.trim() : '';
    const material = materials.find((entry) => (
      !usedMaterialIds.has(entry.material_id)
        && (!boundMaterialId || entry.material_id === boundMaterialId)
        && (role.any_of || []).includes(entry.workout_family)
    ));
    if (material) usedMaterialIds.add(material.material_id);
    return material || null;
  });
  const materialRunningMeters = (material) => {
    const direct = material?.distance_m;
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
    if (projectableHybridRunningMaterial(material)) return 0;
    const miles = material?.distance_miles;
    return typeof miles === 'number' && Number.isFinite(miles) && miles > 0
      ? miles * 1609.344 : 0;
  };
  const exactRunningMeters = assignedMaterials.reduce((sum, material) => (
    sum + (material && RUNNING_GOAL_BACKWARD_FAMILIES.has(material.workout_family)
      ? materialRunningMeters(material) : 0)
  ), 0);
  const projectionRoleIndex = decision.role_multiset.findIndex((role, index) => (
    !assignedMaterials[index]
      && String(role.role || '').toUpperCase() === 'SUPPORTING'
      && (role.any_of || []).includes('easy_run')
  ));
  const requiredRunningMeters = Number(decision.minimum_weekly_demand?.running_m);
  if (projectionRoleIndex >= 0 && hybridProjectionPaceAvailable
    && Number.isSafeInteger(requiredRunningMeters) && exactRunningMeters < requiredRunningMeters) {
    const projectable = materials.filter((entry) => (
      !usedMaterialIds.has(entry.material_id)
        && projectableHybridRunningMaterial(entry)
        && materialRunningMeters(entry) > 0
    )).sort((left, right) => (
      materialRunningMeters(right) - materialRunningMeters(left)
        || left.material_id.localeCompare(right.material_id)
    ));
    const selected = [];
    let projectedRunningMeters = 0;
    for (const material of projectable) {
      if (exactRunningMeters + projectedRunningMeters >= requiredRunningMeters) break;
      selected.push(material);
      projectedRunningMeters += materialRunningMeters(material);
    }
    const projectionDistanceMiles = projectedRunningMeters / 1609.344;
    const projectionDurationMin = projectedRunningMeters > 0
      ? Math.max(1, Math.ceil((projectionDistanceMiles * hybridProjectionPace) / 60)) : 0;
    const presentationFloorMin = ['BEGINNER', 'RETURNING'].includes(String(
      decision.training_age_class || ''
    ).toUpperCase()) ? 20 : 25;
    if (selected.length && projectionDurationMin >= presentationFloorMin) {
      const projectionSourceMaterialIds = selected.map((material) => material.material_id).sort();
      const projectedMaterial = {
        material_id: `projected-hybrid-running-${canonicalHash({
          projectionSourceMaterialIds,
          projectedRunningMeters,
          hybridProjectionPace,
        }).slice(0, 24)}`,
        source_workout_id: null,
        workout_family: 'hyrox_compromised',
        legacy_scheduled_local_date: null,
        source_kind: 'run',
        source_title: 'Easy aerobic run',
        duration_min: projectionDurationMin,
        distance_m: Math.round(projectedRunningMeters),
        distance_miles: round(projectionDistanceMiles, 6),
        quality_work_duration_min: null,
        main_work_duration_min: null,
        run_station_pair_count: null,
        projection_source_material_ids: projectionSourceMaterialIds,
        source_session: {
          id: `projected-hybrid-running-${canonicalHash(projectionSourceMaterialIds).slice(0, 24)}`,
          kind: 'run',
          sessionType: 'easy',
          type: 'easy',
          workout_family: 'easy_run',
          title: 'Easy aerobic run',
          purpose: 'Preserve recorded running components without adding unmaterialized station load.',
          duration_min: projectionDurationMin,
          distance_m: Math.round(projectedRunningMeters),
          distance_miles: round(projectionDistanceMiles, 6),
          projection_pace_s_per_mile: hybridProjectionPace,
          projection_source_workout_family: 'hyrox_compromised',
          projection_source_material_ids: projectionSourceMaterialIds,
        },
      };
      materials.push(projectedMaterial);
      assignedMaterials[projectionRoleIndex] = projectedMaterial;
      selected.forEach((material) => usedMaterialIds.add(material.material_id));
    }
  }
  const sessions = decision.role_multiset.map((role, index) => {
    const material = assignedMaterials[index];
    const projectedRunningMaterial = material?.projection_source_material_ids?.length ? material : null;
    const placement = placementFor(input.placements, role.requirement_id);
    const workoutFamily = placement.workout_family || material?.workout_family || role.any_of?.[0] || null;
    const durationMin = decision.phase === 'FOUNDATION' && workoutFamily === 'recovery_run'
      ? executableFoundationRecoveryDurationMinutes(
        material?.duration_min,
        input.presentation_floor_options,
      )
      : material?.duration_min ?? null;
    return {
      skeleton_session_id: String(material?.material_id || `skeleton-${role.requirement_id}-${index + 1}`),
      session_id: String(material?.material_id || `skeleton-${role.requirement_id}-${index + 1}`),
      requirement_id: role.requirement_id,
      role: role.role,
      workout_family: workoutFamily,
      ...(workoutFamily === 'assessment'
        ? { contributing_work_families: [canonicalRoadContributorFamily(workoutFamily)] } : {}),
      candidate_families: [...(role.any_of || [])],
      scheduled_local_date: placement.scheduled_local_date,
      scheduled_start_at: placement.scheduled_start_at,
      supports_requirement_id: role.supports_requirement_id || null,
      candidate_material_id: material?.material_id || null,
      material_source: projectedRunningMaterial
        ? 'CURRENT_HYBRID_RUNNING_COMPONENT'
        : material ? 'CURRENT_ROAD_SESSION_CONSTRUCTOR_OUTPUT' : 'EVENT_POLICY_ROLE',
      material_source_workout_family: material?.workout_family || null,
      projection_source_material_ids: projectedRunningMaterial?.projection_source_material_ids || [],
      duration_min: durationMin,
      distance_m: material?.distance_m ?? null,
      distance_miles: material?.distance_miles ?? null,
      quality_work_duration_min: material?.quality_work_duration_min ?? null,
      main_work_duration_min: material?.main_work_duration_min ?? null,
      run_station_pair_count: material?.run_station_pair_count ?? null,
    };
  });
  const materialChange = compareMaterialChange({
    active_applied_plan: input.active_applied_plan ?? null,
    candidate: {
      phase: decision.phase,
      goal_priority: decision.active_goals?.find((goal) => goal.goal_id === decision.primary_goal_id)?.priority ?? null,
      safety_scope: decision.safety_state?.scope ?? null,
      plan_revision: Math.max(1, Number(decision.plan_revision || 0) + 1),
      sessions,
    },
    decisive_evidence_ids: (decision.evidence_used || []).map((entry) => (
      typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id
    )).filter(Boolean),
  });
  return {
    decision_id: decision.decision_id,
    decision_hash: decision.decision_hash,
    phase: decision.phase,
    primary_goal_id: decision.primary_goal_id,
    role_multiset: clone(decision.role_multiset),
    candidate_material: materials,
    sessions,
    material_change: materialChange,
    canonical_sessions_materialized: false,
  };
}

function buildGoalBackwardCandidateSkeleton(input = {}) {
  const decision = input.decision;
  const identityContent = goalBackwardSkeletonIdentity(input);
  const sessions = identityContent.sessions;
  const validation = input.validate !== false && (input.validate === true || sessions.some((session) => session.scheduled_local_date))
    ? validateGoalBackwardCandidate({ sessions }, {
      ...input.validation_options,
      training_age_class: input.validation_options?.training_age_class ?? input.training_age_class ?? decision.training_age_class,
      consistency_state: input.validation_options?.consistency_state ?? decision.consistency_state,
      recovery_state: input.validation_options?.recovery_state ?? decision.recovery_state,
      safety_action: input.validation_options?.safety_action ?? decision.safety_state?.action,
      safety_scope: input.validation_options?.safety_scope ?? decision.safety_state?.scope,
      locks: input.validation_options?.locks ?? decision.athlete_locks,
      manual_edits: input.validation_options?.manual_edits ?? decision.manual_edits,
      required_exposure_ledger: decision.due_exposure_ledger,
      unplaceable_requirement_ids: decision.due_exposure_ledger?.unplaceable_requirement_ids,
    })
    : null;
  const candidateHash = canonicalHash(identityContent);
  return immutable({
    candidate_skeleton_id: input.candidate_skeleton_id || `candidate-skeleton-${candidateHash.slice(0, 24)}`,
    ...identityContent,
    validation,
    persisted: false,
    candidate_hash: candidateHash,
  });
}

function validLocalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function fixedPlacementForRole(role, input = {}) {
  const constraints = [...(input.locks || input.decision?.athlete_locks || []), ...(input.manual_edits || input.decision?.manual_edits || [])];
  const matched = constraints.filter((constraint) => {
    const requirementId = constraint.requirement_id ?? constraint.requirementId;
    if (requirementId != null) return String(requirementId) === String(role.requirement_id);
    const constraintRole = String(constraint.role || '').toUpperCase();
    const family = constraint.workout_family ?? constraint.workoutFamily;
    if (!constraintRole && !family) return false;
    if (constraintRole && constraintRole !== String(role.role || '').toUpperCase()) return false;
    return !family || (role.any_of || []).includes(family);
  });
  return {
    dates: [...new Set(matched.map((constraint) => validLocalDate(
      constraint.scheduled_local_date ?? constraint.local_date ?? constraint.date
    )).filter(Boolean))].sort(),
    families: [...new Set(matched.map((constraint) => constraint.workout_family ?? constraint.workoutFamily).filter(Boolean))].sort(),
  };
}

function rolePlacementChoices(role, input, availableDates, preferredMaterialFamily = null) {
  const fixed = fixedPlacementForRole(role, input);
  const dates = fixed.dates.length ? fixed.dates.filter((date) => availableDates.includes(date)) : availableDates;
  const allowedFamilies = [...new Set((role.any_of || []).map(String).filter(Boolean))].sort();
  const families = fixed.families.length
    ? allowedFamilies.filter((family) => fixed.families.includes(family))
    : allowedFamilies;
  const allChoices = dates.flatMap((date) => families.map((family) => ({
    scheduled_local_date: date,
    workout_family: family,
    material_family_match: !preferredMaterialFamily || family === preferredMaterialFamily,
  })));
  const boundedChoices = allChoices.slice(0, MAX_GOAL_BACKWARD_PLACEMENT_CHOICES_PER_ROLE);
  Object.defineProperty(boundedChoices, 'search_truncated', {
    enumerable: false,
    value: allChoices.length > boundedChoices.length,
  });
  return boundedChoices;
}

function partialPlacementComparator(left, right) {
  const materialMismatchCount = (placements) => placements.filter((placement) => (
    placement.material_family_match === false
  )).length;
  const collisionCount = (placements) => {
    const counts = placements.reduce((result, placement) => {
      const date = placement.scheduled_local_date;
      result[date] = (result[date] || 0) + 1;
      return result;
    }, {});
    return Object.values(counts).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  };
  return materialMismatchCount(left) - materialMismatchCount(right)
    || collisionCount(left) - collisionCount(right)
    || canonicalStringify(left).localeCompare(canonicalStringify(right));
}

function boundedPlacementSpace(placementSets) {
  return placementSets.reduce((total, choices) => {
    if (!total || !choices.length) return 0;
    if (total > Math.floor(Number.MAX_SAFE_INTEGER / choices.length)) return Number.MAX_SAFE_INTEGER;
    return total * choices.length;
  }, 1);
}

function orderedSessionTuple(candidate) {
  return (candidate.sessions || []).map((session) => ([
    session.scheduled_local_date,
    ROLE_RANK[String(session.role || '').toUpperCase()] ?? 99,
    session.workout_family,
    session.session_id,
  ])).sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

function preliminaryCandidateComparator(left, right) {
  return left.preliminary_presentation_floor_violation_count
      - right.preliminary_presentation_floor_violation_count
    || left.preliminary_material_mismatch_count - right.preliminary_material_mismatch_count
    || left.preliminary_spacing_violation_count - right.preliminary_spacing_violation_count
    || canonicalStringify(left.preliminary_ordering_tuple).localeCompare(canonicalStringify(right.preliminary_ordering_tuple))
    || left.canonical_placement.localeCompare(right.canonical_placement);
}

function stressTargetVector(input = {}) {
  if (Array.isArray(input.selected_weekly_stress_targets)) return input.selected_weekly_stress_targets.map(Number);
  const source = input.selected_weekly_stress_targets || {};
  const dimensions = ['aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular', 'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue'];
  return dimensions.map((dimension) => Number(source[dimension] || 0));
}

function runningDistanceMeters(session = {}) {
  if (!RUNNING_GOAL_BACKWARD_FAMILIES.has(session.workout_family)) return 0;
  const direct = Number(session.running_distance_m ?? session.distance_m ?? session.distanceMeters);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const miles = Number(session.distance_miles ?? session.distanceMiles);
  return Number.isFinite(miles) && miles >= 0 ? miles * 1609.344 : 0;
}

function preferredDayMatchCount(sessions, input = {}) {
  const preferredDates = new Set((input.preferred_local_dates || []).map(validLocalDate).filter(Boolean));
  const preferredWeekdays = new Set((input.preferred_weekdays || []).map((value) => String(value).slice(0, 3).toLowerCase()));
  return sessions.filter((session) => {
    const date = validLocalDate(session.scheduled_local_date);
    if (preferredDates.has(date)) return true;
    if (!date || !preferredWeekdays.size) return false;
    const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00.000Z`).getUTCDay()];
    return preferredWeekdays.has(weekday);
  }).length;
}

function candidateRankingTuple(candidate, input = {}) {
  const duePrimary = new Set((input.decision?.role_multiset || [])
    .filter((role) => String(role.role).toUpperCase() === 'PRIMARY_KEY')
    .map((role) => String(role.requirement_id)));
  const satisfied = new Set((candidate.sessions || [])
    .filter((session) => duePrimary.has(String(session.requirement_id)))
    .map((session) => String(session.requirement_id)));
  const weekly = aggregateWeeklyStress(candidate.sessions || []);
  const target = stressTargetVector(input);
  const actual = weekly.valid ? weekly.weekly_dimension_sum : Array(8).fill(0);
  const runningVolume = (candidate.sessions || []).reduce((sum, session) => sum + runningDistanceMeters(session), 0);
  const selectedRunningVolume = Number(input.selected_running_volume_m || 0);
  return {
    due_primary_exposures_satisfied: satisfied.size,
    material_change_count: candidate.material_change?.changes?.length || 0,
    stress_target_absolute_deviation: actual.reduce((sum, value, index) => sum + Math.abs(value - (target[index] || 0)), 0),
    running_volume_absolute_deviation_m: Math.abs(runningVolume - selectedRunningVolume),
    preferred_day_matches: preferredDayMatchCount(candidate.sessions || [], input),
    ordered_session_tuple: orderedSessionTuple(candidate),
  };
}

function candidateWorkloadEvidence(sessions, input = {}) {
  if (input.validation_options?.workload_evidence) return input.validation_options.workload_evidence;
  const aggregate = aggregateWeeklyStress(sessions);
  const eventPolicy = eventPolicyFor(input.decision?.event_policy_id);
  const ceilings = input.fatigue_ceilings || calculateFatigueCeilings(input.modality_history || {}, {
    training_age_class: input.validation_options?.training_age_class ?? input.decision?.training_age_class,
    event_policy: eventPolicy,
    phase: input.decision?.phase,
    mandatory_hyrox_cluster: input.mandatory_hyrox_cluster === true,
    recovery_state: input.validation_options?.recovery_state ?? input.decision?.recovery_state,
    safety_restriction: !['NORMAL', 'MONITOR'].includes(String(
      input.validation_options?.safety_action ?? input.decision?.safety_state?.action ?? 'NORMAL'
    ).toUpperCase()),
    previous_two_weeks_passed: input.previous_two_weeks_passed === true,
  });
  const budget = evaluateStressBudget(aggregate, ceilings);
  const rolling = validateRollingHardDays(sessions, {
    ...input.validation_options,
    spacing_valid: validateInterference(sessions, input.validation_options).valid,
  });
  const doseLedger = buildCrossModalDoseLedger({
    weekly_dimension_sum: aggregate.weekly_dimension_sum,
    dimensions: ceilings.dimensions,
    decisive_evidence_ids: input.validation_options?.cross_modal_evidence_ids
      ?? input.cross_modal_evidence_ids
      ?? [],
  });
  return {
    valid: aggregate.valid && budget.valid && rolling.valid,
    violations: [
      ...(aggregate.violations || []),
      ...(budget.violations || []),
      ...(rolling.violations || []),
    ],
    reason_codes: [...new Set([
      ...(aggregate.reason_codes || []),
      ...(budget.reason_codes || []),
      ...(rolling.reason_codes || []),
    ])],
    dimension_ledger: doseLedger,
  };
}

function compareGoalBackwardCandidateRankings(left, right) {
  const a = left.ranking_tuple;
  const b = right.ranking_tuple;
  return b.due_primary_exposures_satisfied - a.due_primary_exposures_satisfied
    || a.material_change_count - b.material_change_count
    || a.stress_target_absolute_deviation - b.stress_target_absolute_deviation
    || a.running_volume_absolute_deviation_m - b.running_volume_absolute_deviation_m
    || b.preferred_day_matches - a.preferred_day_matches
    || canonicalStringify(a.ordered_session_tuple).localeCompare(canonicalStringify(b.ordered_session_tuple))
    || left.candidate_hash.localeCompare(right.candidate_hash);
}

function materializeGoalBackwardCandidate(candidate, input = {}) {
  const sessionSet = materializeCanonicalSessionSet({
    candidate,
    decision: input.decision,
    active_applied_plan: input.active_applied_plan,
    plan_id: input.candidate_plan_id,
    plan_revision: input.candidate_plan_revision,
    session_revision: input.session_revision,
    timezone: input.timezone,
    planning_instant: input.planning_instant,
    target_context: input.target_context,
    training_age_class: input.validation_options?.training_age_class ?? input.decision?.training_age_class,
    recent_normal_running_minutes_per_week: input.validation_options?.recent_normal_running_minutes_per_week,
    median_ordinary_easy_duration_min: input.validation_options?.median_ordinary_easy_duration_min,
  });
  const decisiveEvidenceIds = (input.decision?.evidence_used || []).map((entry) => (
    typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id
  )).filter(Boolean);
  const materialChange = compareMaterialChange({
    active_applied_plan: input.active_applied_plan ?? null,
    candidate: {
      phase: input.decision?.phase,
      goal_priority: input.decision?.active_goals?.find((goal) => (
        goal.goal_id === input.decision?.primary_goal_id
      ))?.priority ?? null,
      safety_scope: input.decision?.safety_state?.scope ?? null,
      executability: sessionSet.sessions.some((session) => session.executability !== 'EXECUTABLE')
        ? 'RESTRICTED' : 'EXECUTABLE',
      plan_revision: sessionSet.plan_revision,
      sessions: sessionSet.sessions,
    },
    decisive_evidence_ids: decisiveEvidenceIds,
    decision_id: sessionSet.decision_id,
    candidate_hash: sessionSet.candidate_hash,
    canonical_session_set_hash: sessionSet.content_hash,
    require_canonical_bindings: true,
  });
  return {
    ...candidate,
    skeleton_sessions: candidate.sessions,
    sessions: sessionSet.sessions,
    canonical_sessions: sessionSet.sessions,
    canonical_session_set: sessionSet,
    canonical_plan: buildCanonicalPlanFromSessionSet(sessionSet),
    canonical_sessions_materialized: true,
    candidate_hash: sessionSet.candidate_hash,
    material_change: materialChange,
  };
}

function enumerateGoalBackwardCandidates(input = {}) {
  const decision = input.decision;
  if (!decision?.decision_id || !decision?.decision_hash || !Array.isArray(decision.role_multiset)) {
    throw new Error('an immutable PlanningDecision with a role multiset is required');
  }
  const requestedAvailableDates = [...new Set(
    (input.available_local_dates || []).map(validLocalDate).filter(Boolean)
  )].sort();
  const availableDates = requestedAvailableDates.slice(0, MAX_GOAL_BACKWARD_AVAILABLE_DATES);
  const requestedMaximumSessionCount = Number.isSafeInteger(input.maximum_session_count)
    ? Math.max(0, input.maximum_session_count)
    : decision.role_multiset.length;
  const maximumSessionCount = Math.min(requestedMaximumSessionCount, MAX_GOAL_BACKWARD_ROLE_COUNT);
  const roles = decision.role_multiset.slice(0, maximumSessionCount);
  const roleCapacityExceeded = roles.length > availableDates.length;
  const inputBounded = requestedAvailableDates.length > MAX_GOAL_BACKWARD_AVAILABLE_DATES
    || requestedMaximumSessionCount > MAX_GOAL_BACKWARD_ROLE_COUNT
    || roles.some((role) => new Set((role.any_of || []).map(String).filter(Boolean)).size
      > MAX_GOAL_BACKWARD_FAMILIES_PER_ROLE);
  const presentationFloorPaceSecondsPerMile = input.hybrid_running_projection_pace_s_per_mile
    ?? input.validation_options?.presentation_floor_pace_s_per_mile
    ?? input.validation_options?.presentationFloorPaceSecondsPerMile;
  const recentNormalRunningMinutes = recentNormalRunningMinutesPerWeek(input.validation_options);
  const presentationFloorOptions = {
    ...input.validation_options,
    training_age_class: input.validation_options?.training_age_class
      ?? decision.training_age_class,
    ...(recentNormalRunningMinutes !== null ? {
      recent_normal_running_minutes_per_week: recentNormalRunningMinutes,
    } : {}),
    presentation_floor_pace_s_per_mile: presentationFloorPaceSecondsPerMile,
  };
  const materialIdentity = !inputBounded && !roleCapacityExceeded
    ? goalBackwardSkeletonIdentity({
      decision,
      placements: {},
      legacy_road_candidate_material: input.legacy_road_candidate_material,
      active_applied_plan: input.active_applied_plan,
      hybrid_running_projection_pace_s_per_mile: input.hybrid_running_projection_pace_s_per_mile,
      presentation_floor_options: presentationFloorOptions,
    }) : { sessions: [] };
  const preferredMaterialFamilyByRequirement = new Map(materialIdentity.sessions.map((session) => [
    String(session.requirement_id),
    preferredMaterialFamilyForFloor(session, decision, presentationFloorOptions),
  ]));
  const placementSets = roles.map((role) => rolePlacementChoices(
    role,
    input,
    availableDates,
    preferredMaterialFamilyByRequirement.get(String(role.requirement_id)) || null,
  ));
  const placementChoicesTruncated = placementSets.some((choices) => choices.search_truncated === true);
  const preliminary = [];
  const seen = new Set();
  let expandedNodeCount = 0;
  let frontierTrimmed = false;
  let nodeLimitReached = false;
  let frontier = [[]];
  if (!inputBounded && !roleCapacityExceeded && roles.length
    && placementSets.every((choices) => choices.length)) {
    for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
      const role = roles[roleIndex];
      const next = [];
      outer: for (const placements of frontier) {
        for (const choice of placementSets[roleIndex]) {
          if (expandedNodeCount >= MAX_GOAL_BACKWARD_SEARCH_NODES) {
            nodeLimitReached = true;
            break outer;
          }
          expandedNodeCount += 1;
          next.push([...placements, { requirement_id: role.requirement_id, ...choice }]);
        }
      }
      next.sort(partialPlacementComparator);
      if (next.length > MAX_GOAL_BACKWARD_SEARCH_FRONTIER) frontierTrimmed = true;
      frontier = next.slice(0, MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
      if (!frontier.length || nodeLimitReached) break;
    }
  } else {
    frontier = [];
  }
  if (frontier.length && frontier[0].length === roles.length) {
    for (const placements of frontier) {
      const placementMap = Object.fromEntries(placements.map((placement) => [placement.requirement_id, placement]));
      const identity = goalBackwardSkeletonIdentity({
        decision,
        placements: placementMap,
        legacy_road_candidate_material: input.legacy_road_candidate_material,
        active_applied_plan: input.active_applied_plan,
        hybrid_running_projection_pace_s_per_mile: input.hybrid_running_projection_pace_s_per_mile,
        presentation_floor_options: presentationFloorOptions,
      });
      const sessions = identity.sessions;
      const canonicalPlacement = canonicalStringify(identity);
      if (seen.has(canonicalPlacement)) return;
      seen.add(canonicalPlacement);
      const interference = validateInterference(sessions, input.validation_options);
      const presentationFloor = validatePresentationFloor(sessions, presentationFloorOptions);
      preliminary.push({
        ...identity,
        canonical_placement: canonicalPlacement,
        preliminary_presentation_floor_violation_count:
          presentationFloor?.violations?.length || 0,
        preliminary_material_mismatch_count: sessions.filter((session) => (
          session.material_source === 'CURRENT_ROAD_SESSION_CONSTRUCTOR_OUTPUT'
            && session.material_source_workout_family
            && session.material_source_workout_family !== session.workout_family
        )).length,
        preliminary_spacing_violation_count: interference?.violations?.length || 0,
        preliminary_ordering_tuple: orderedSessionTuple({ sessions }),
      });
    }
  }
  const retained = preliminary.sort(preliminaryCandidateComparator).slice(0, MAX_GOAL_BACKWARD_CANDIDATES).map((candidate) => {
    const candidateHash = canonicalHash(Object.fromEntries(Object.entries(candidate).filter(([key]) => ![
      'canonical_placement', 'preliminary_material_mismatch_count',
      'preliminary_presentation_floor_violation_count',
      'preliminary_spacing_violation_count', 'preliminary_ordering_tuple',
    ].includes(key))));
    let withCanonical = {
      ...candidate,
      candidate_skeleton_id: `candidate-skeleton-${candidateHash.slice(0, 24)}`,
      candidate_hash: candidateHash,
      persisted: false,
    };
    let materializationError = null;
    if (input.materialize_canonical !== false) {
      try {
        withCanonical = materializeGoalBackwardCandidate(withCanonical, {
          ...input,
          validation_options: presentationFloorOptions,
        });
      } catch (error) {
        materializationError = error;
      }
    }
    const workloadEvidence = candidateWorkloadEvidence(withCanonical.sessions, input);
    const materialDose = input.material_dose_enforced === true ? {
      recent_normal_running: input.validation_options?.recent_normal_running ?? {
        status: decision.recent_normal_running_range_m?.median == null ? 'INSUFFICIENT' : 'PROVISIONAL',
        median_distance_m: decision.recent_normal_running_range_m?.median ?? null,
        confidence: decision.recent_normal_running_range_m?.median == null ? 'INSUFFICIENT' : 'LOW',
      },
      observed_lower_bound_running_m: input.validation_options?.observed_lower_bound_running_m ?? null,
      observed_lower_bound_evidence_ids: input.validation_options?.observed_lower_bound_evidence_ids ?? [],
      completed_running_credit: input.validation_options?.completed_running_credit ?? null,
      active_applied_plan: input.active_applied_plan ?? null,
      phase: decision.phase,
      training_age_class: input.validation_options?.training_age_class ?? decision.training_age_class,
      consistency_state: input.validation_options?.consistency_state ?? decision.consistency_state,
      planning_date_local: decision.planning_date_local,
      candidate_window_end_local: availableDates[availableDates.length - 1] ?? decision.planning_date_local,
      decisive_evidence_ids: (decision.evidence_used || []).map((entry) => (
        typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id
      )).filter(Boolean),
      reduction_scope: input.validation_options?.material_reduction_scope ?? null,
      cross_modal_ledger: workloadEvidence.dimension_ledger,
      cross_modal_reduction_evidence: input.validation_options?.cross_modal_reduction_evidence ?? null,
    } : null;
    const validation = validateGoalBackwardCandidate(withCanonical, {
      ...presentationFloorOptions,
      workload_evidence: workloadEvidence,
      safety_scope: input.validation_options?.safety_scope ?? decision.safety_state?.scope,
      material_dose: materialDose,
      development_role_requirements: decision.development_role_requirements || [],
      development_role_conflicts: decision.development_role_conflicts || [],
      development_role_binding: buildDevelopmentRoleBinding(decision),
      planning_date_local: decision.planning_date_local,
      candidate_window_end_local: availableDates[availableDates.length - 1] ?? decision.planning_date_local,
      allowed_requirement_ids: roles.map((role) => String(role.requirement_id)),
      enforce_due_role_scope: true,
      maximum_session_count: maximumSessionCount,
      locks: input.validation_options?.locks ?? input.locks ?? decision.athlete_locks,
      manual_edits: input.validation_options?.manual_edits ?? input.manual_edits ?? decision.manual_edits,
      required_exposure_ledger: decision.due_exposure_ledger,
      unplaceable_requirement_ids: decision.due_exposure_ledger?.unplaceable_requirement_ids,
    });
    const finalValidation = materializationError ? immutable({
      ...validation,
      valid: false,
      validator_results: validation.validator_results.map((result) => (
        result.validator === 'canonical_session_set' ? {
          validator: 'canonical_session_set',
          valid: false,
          violations: [{
            code: materializationError.code || 'CANONICAL_SESSION_SET_INVALID',
            reason: materializationError.message,
            details: materializationError.details || null,
          }],
          reason_codes: ['CANONICAL_SESSION_SET_INVALID'],
        } : result
      )),
      violations: [...validation.violations, {
        code: materializationError.code || 'CANONICAL_SESSION_SET_INVALID',
        reason: materializationError.message,
        details: materializationError.details || null,
      }],
      reason_codes: [...new Set([...validation.reason_codes, 'CANONICAL_SESSION_SET_INVALID'])],
    }) : validation;
    const withValidation = {
      ...withCanonical,
      validation: finalValidation,
    };
    delete withValidation.canonical_placement;
    delete withValidation.preliminary_material_mismatch_count;
    delete withValidation.preliminary_presentation_floor_violation_count;
    delete withValidation.preliminary_spacing_violation_count;
    delete withValidation.preliminary_ordering_tuple;
    return immutable({ ...withValidation, ranking_tuple: candidateRankingTuple(withValidation, input) });
  });
  const accepted = retained.filter((candidate) => candidate.validation.valid).sort(compareGoalBackwardCandidateRankings);
  const selectedCandidate = accepted[0] || null;
  const searchWasTruncated = inputBounded || roleCapacityExceeded || placementChoicesTruncated
    || frontierTrimmed || nodeLimitReached;
  const truncationReason = nodeLimitReached
    ? 'CANDIDATE_SEARCH_NODE_BUDGET_EXHAUSTED'
    : inputBounded ? 'CANDIDATE_SEARCH_INPUT_LIMIT_EXCEEDED'
      : roleCapacityExceeded ? 'CANDIDATE_ROLE_COUNT_EXCEEDS_AVAILABLE_DAYS'
        : placementChoicesTruncated ? 'CANDIDATE_PLACEMENT_CHOICES_TRUNCATED_32'
          : frontierTrimmed ? `CANDIDATE_SEARCH_FRONTIER_TRUNCATED_${MAX_GOAL_BACKWARD_SEARCH_FRONTIER}`
          : preliminary.length > MAX_GOAL_BACKWARD_CANDIDATES
            ? 'CANDIDATE_ENUMERATION_TRUNCATED_64' : null;
  const searchDiagnostics = immutable({
    search_complete: !searchWasTruncated,
    expanded_node_count: expandedNodeCount,
    generated_leaf_count: preliminary.length,
    retained_candidate_count: retained.length,
    role_count: roles.length,
    available_day_count: availableDates.length,
    placement_space_upper_bound: boundedPlacementSpace(placementSets),
    placement_choices_truncated: placementChoicesTruncated,
    frontier_limit: MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
    node_limit: MAX_GOAL_BACKWARD_SEARCH_NODES,
    truncation_reason: truncationReason,
  });
  const finalized = finalizeGoalBackwardCandidateDecision(decision, {
    candidates: retained,
    selectedCandidate,
    totalUniqueCandidateCount: preliminary.length,
    truncationReason,
  });
  const finalizedDecision = immutable({
    ...clone(finalized),
    candidate_enumeration: {
      ...clone(finalized.candidate_enumeration),
      search_complete: searchDiagnostics.search_complete,
      expanded_node_count: searchDiagnostics.expanded_node_count,
      generated_leaf_count: searchDiagnostics.generated_leaf_count,
      placement_space_upper_bound: searchDiagnostics.placement_space_upper_bound,
      frontier_limit: searchDiagnostics.frontier_limit,
      node_limit: searchDiagnostics.node_limit,
    },
  });
  return immutable({
    decision: finalizedDecision,
    candidates: retained,
    selected_candidate: selectedCandidate,
    rejected_candidates: finalizedDecision.rejected_candidates,
    total_unique_candidate_count: preliminary.length,
    truncation_reason: truncationReason,
    search_diagnostics: searchDiagnostics,
  });
}

module.exports = {
  MAX_GOAL_BACKWARD_CANDIDATES,
  MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
  MAX_GOAL_BACKWARD_SEARCH_NODES,
  applyPlanningCurve,
  buildGoalBackwardCandidateSkeleton,
  canonicalRoadCandidateMaterial,
  materializeGoalBackwardCandidate,
  buildRacePlanCandidate,
  candidateRankingTuple,
  compareGoalBackwardCandidateRankings,
  enumerateGoalBackwardCandidates,
  enforceDemandingSpacing,
  legacyGoalBackwardFamily,
  ordinaryEasyMedians,
  semanticCandidateErrors,
  trustedActivityDates,
};
