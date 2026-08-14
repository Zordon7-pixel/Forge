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
  daysBetween,
  firstFullMonday,
  longRunIdentityFloor,
  mondayFor,
  raceCategory,
} = require('./racePlanPolicy');
const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const { resolveStressVector } = require('./goalBackwardLoad');
const {
  buildPlanningModel,
  evaluatePlanFeasibility,
  ordinaryEasyMedians,
  paceFeasibility,
} = require('./planFeasibility');
const {
  compareMaterialChange,
  validateGoalBackwardCandidate,
} = require('./goalBackwardValidators');

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
  return LEGACY_TO_GOAL_BACKWARD_FAMILY[taxonomy?.family] || null;
}

function roadCandidateMaterial(source) {
  return legacyCandidateMaterialEntries(source).map((session, index) => ({
    material_id: String(session.session_id ?? session.id ?? `road-material-${index + 1}`),
    source_workout_id: session.workout_id ?? null,
    workout_family: legacyGoalBackwardFamily(session),
    legacy_scheduled_local_date: String(
      session.scheduled_local_date ?? session.date ?? ''
    ).slice(0, 10) || null,
    source_kind: session.kind ?? 'run',
    source_title: session.title ?? null,
  }));
}

function placementFor(placements, requirementId) {
  const placement = placements?.[requirementId];
  if (typeof placement === 'string') return { scheduled_local_date: placement.slice(0, 10), scheduled_start_at: null };
  if (!placement || typeof placement !== 'object') return { scheduled_local_date: null, scheduled_start_at: null };
  return {
    scheduled_local_date: String(placement.scheduled_local_date ?? placement.date ?? '').slice(0, 10) || null,
    scheduled_start_at: placement.scheduled_start_at ?? null,
  };
}

function buildGoalBackwardCandidateSkeleton(input = {}) {
  const decision = input.decision;
  if (!decision || !decision.decision_id || !Array.isArray(decision.role_multiset)) {
    throw new Error('an immutable PlanningDecision with a role multiset is required');
  }
  const materials = roadCandidateMaterial(input.legacy_road_candidate_material || []);
  const usedMaterialIds = new Set();
  const sessions = decision.role_multiset.map((role, index) => {
    const material = materials.find((entry) => (
      !usedMaterialIds.has(entry.material_id) && (role.any_of || []).includes(entry.workout_family)
    ));
    if (material) usedMaterialIds.add(material.material_id);
    const placement = placementFor(input.placements, role.requirement_id);
    return {
      skeleton_session_id: String(material?.material_id || `skeleton-${role.requirement_id}-${index + 1}`),
      session_id: String(material?.material_id || `skeleton-${role.requirement_id}-${index + 1}`),
      requirement_id: role.requirement_id,
      role: role.role,
      workout_family: material?.workout_family || role.any_of?.[0] || null,
      candidate_families: [...(role.any_of || [])],
      scheduled_local_date: placement.scheduled_local_date,
      scheduled_start_at: placement.scheduled_start_at,
      supports_requirement_id: role.supports_requirement_id || null,
      candidate_material_id: material?.material_id || null,
      material_source: material ? 'CURRENT_ROAD_SESSION_CONSTRUCTOR_OUTPUT' : 'EVENT_POLICY_ROLE',
    };
  });
  const materialChange = compareMaterialChange({
    active_applied_plan: input.active_applied_plan ?? null,
    candidate: { phase: decision.phase, sessions },
  });
  const validation = input.validate === true || sessions.some((session) => session.scheduled_local_date)
    ? validateGoalBackwardCandidate({ sessions }, {
      ...input.validation_options,
      training_age_class: input.validation_options?.training_age_class ?? input.training_age_class ?? decision.training_age_class,
      consistency_state: input.validation_options?.consistency_state ?? decision.consistency_state,
      recovery_state: input.validation_options?.recovery_state ?? decision.recovery_state,
      safety_action: input.validation_options?.safety_action ?? decision.safety_state?.action,
      locks: input.validation_options?.locks ?? decision.athlete_locks,
      manual_edits: input.validation_options?.manual_edits ?? decision.manual_edits,
      required_exposure_ledger: decision.due_exposure_ledger,
      unplaceable_requirement_ids: decision.due_exposure_ledger?.unplaceable_requirement_ids,
    })
    : null;
  const content = {
    decision_id: decision.decision_id,
    decision_hash: decision.decision_hash,
    phase: decision.phase,
    primary_goal_id: decision.primary_goal_id,
    role_multiset: clone(decision.role_multiset),
    candidate_material: materials,
    sessions,
    material_change: materialChange,
    validation,
    canonical_sessions_materialized: false,
    persisted: false,
  };
  const candidateHash = canonicalHash(content);
  return immutable({
    candidate_skeleton_id: input.candidate_skeleton_id || `candidate-skeleton-${candidateHash.slice(0, 24)}`,
    ...content,
    candidate_hash: candidateHash,
  });
}

module.exports = {
  applyPlanningCurve,
  buildGoalBackwardCandidateSkeleton,
  buildRacePlanCandidate,
  enforceDemandingSpacing,
  ordinaryEasyMedians,
  semanticCandidateErrors,
  trustedActivityDates,
};
