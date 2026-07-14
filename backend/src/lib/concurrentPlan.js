// Forged Hybrid H3 concurrent scheduling engine.
// Pure and deterministic: no DB, network, framework, or wall-clock dependency.

const planSchema = require('./planSchema');
const raceCourse = require('./raceCourse');
const strengthPrescription = require('./strengthPrescription');

const DAY_ORDER = planSchema.DAY_ORDER;
const VALID_MODES = planSchema.VALID_MODES;
const HARD_RUN_PATTERN = /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|zone 3|zone 4|zone 5)/i;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const planningDay = DAY_ORDER[(planningDate.getDay() + 6) % 7];
  const upcomingMonday = planningDay === 'Mon' ? currentMonday : addDays(currentMonday, 7);
  const raceWeekMonday = mondayFor(raceDateValue);
  let startDate = raceDate < parseISODate(upcomingMonday) ? currentMonday : upcomingMonday;
  const rawWeeks = Math.floor((parseISODate(raceWeekMonday) - parseISODate(startDate)) / (7 * 86400000)) + 1;
  const weeks = clamp(rawWeeks, 1, 20);
  if (rawWeeks > 20) startDate = addDays(raceWeekMonday, -(weeks - 1) * 7);
  return { startDate, weeks, startsLater: startDate > upcomingMonday };
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

function recoveryMultiplier(recovery = {}, history = {}) {
  const state = String(recovery.state || recovery.recoveryState || '').toLowerCase();
  let multiplier = state === 'low' || state === 'recovery' || state === 'caution' ? 0.85 : state === 'high' || state === 'strong' ? 1.03 : 1;
  const adherence = Number(history.adherenceRate);
  if (Number.isFinite(adherence) && adherence < 0.65) multiplier *= 0.9;
  if (Number(history.missedWorkouts || 0) >= 3) multiplier *= 0.92;
  return clamp(multiplier, 0.7, 1.05);
}

function buildMileageTargets(weekCount, baseline, hasRace, recovery, history) {
  const targets = [];
  let lastBuild = Math.max(4, Number(baseline || 0)) * recoveryMultiplier(recovery, history);
  let priorBuild = lastBuild;
  for (let weekNumber = 1; weekNumber <= weekCount; weekNumber += 1) {
    const phase = phaseForWeek(weekNumber, weekCount, hasRace);
    let target;
    if (phase === 'deload') {
      target = priorBuild * 0.8;
    } else if (phase === 'taper') {
      target = priorBuild * 0.65;
    } else if (phase === 'race') {
      target = priorBuild * 0.45;
    } else if (weekNumber === 1) {
      target = lastBuild;
      priorBuild = target;
    } else {
      target = priorBuild * (phase === 'peak' ? 1.04 : 1.07);
      priorBuild = target;
    }
    lastBuild = target;
    targets.push(round(target));
  }
  return targets;
}

function selectRunDays(availableDays, count) {
  const wanted = clamp(Math.round(Number(count) || 3), 2, 6);
  const preferred = ['Tue', 'Thu', 'Sat', 'Sun', 'Wed', 'Mon', 'Fri'];
  const ordered = [
    ...preferred.filter((day) => availableDays.includes(day)),
    ...availableDays.filter((day) => !preferred.includes(day)),
  ];
  return DAY_ORDER.filter((day) => ordered.slice(0, Math.min(wanted, availableDays.length)).includes(day));
}

function runTypeFor(day, runDays, phase) {
  const position = runDays.indexOf(day);
  if (position === runDays.length - 1) return 'long';
  if (position === 0 && runDays.length >= 3) {
    if (phase === 'base') return 'hills';
    if (phase === 'taper') return 'sharpen';
    return 'quality';
  }
  return position === 1 && runDays.length >= 4 ? 'steady' : 'easy';
}

function allocateRunDistances(totalMiles, runDays, phase, raceDistance, raceDay) {
  if (raceDay) {
    const easyDays = Math.max(0, runDays.length - 1);
    const easyTotal = Math.max(0, totalMiles - raceDistance);
    return runDays.map((day) => (day === raceDay ? Number(raceDistance) : round(easyTotal / Math.max(1, easyDays))));
  }
  if (runDays.length === 1) return [round(Math.min(maxLongRun(raceDistance), totalMiles))];
  const longShare = phase === 'taper' ? 0.3 : 0.38;
  const qualityShare = runDays.length >= 3 ? 0.24 : 0;
  const longDistance = Math.min(maxLongRun(raceDistance), totalMiles * longShare);
  const qualityDistance = totalMiles * qualityShare;
  const remainingSlots = Math.max(1, runDays.length - (qualityShare ? 2 : 1));
  const easyDistance = Math.max(1, (totalMiles - longDistance - qualityDistance) / remainingSlots);
  return runDays.map((day, index) => {
    if (index === runDays.length - 1) return round(longDistance);
    if (index === 0 && qualityShare) return round(qualityDistance);
    return round(easyDistance);
  });
}

function runPrescription(type, phase, hilly) {
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
    const hillSession = hilly || type === 'hills';
    return {
      title: hillSession ? (phase === 'taper' ? 'Hill strides' : 'Controlled hill repeats') : (phase === 'taper' ? 'Race-pace sharpening' : 'Threshold intervals'),
      target_zone: phase === 'base' ? 'Zone 3' : 'Zone 3-4',
      pace_target: hillSession ? 'Controlled uphill effort' : 'Current threshold effort',
      intensity: phase === 'taper' ? 'Short and controlled' : 'Hard but repeatable',
      warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
      steps: hillSession ? ['6-8 x 60 sec uphill', 'Jog down fully between repetitions'] : ['4 x 5 min controlled hard', '2 min easy jog between repetitions'],
      cooldown: ['10 min easy running'],
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

function buildRunSession({ weekNumber, day, type, distance, phase, hilly, raceName }) {
  if (type === 'race') {
    return {
      id: `h3-w${weekNumber}-${day.toLowerCase()}-run`, kind: 'run', type: 'race', workout_type: 'run',
      title: raceName || 'Race day', distance_miles: Number(distance), target_zone: 'Race effort', pace_target: 'Goal race effort', intensity: 'Race',
      warmup: ['10-15 min easy', '4 x 20 sec relaxed strides'], steps: ['Start controlled', 'Settle into goal effort', 'Race by effort over late hills'],
      cooldown: ['Walk until breathing settles'], progression: 'Execute the prepared race plan.', description: 'Race-day execution.',
    };
  }
  return {
    id: `h3-w${weekNumber}-${day.toLowerCase()}-run`, kind: 'run', type, workout_type: 'run',
    distance_miles: round(Math.max(1, distance)), ...runPrescription(type, phase, hilly),
  };
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
  };
}

function dateInRange(date, start, end) {
  return Boolean(parseISODate(date) && parseISODate(start) && parseISODate(end) && date >= start && date <= end);
}

function recoveryRunAfterRecentLoad(session, latestRun) {
  const distance = Number(session.distance_miles || 0);
  return {
    ...session,
    type: 'recovery',
    workout_type: 'recovery',
    title: 'Recovery run',
    distance_miles: round(Math.max(0.5, Math.min(2, distance * 0.5))),
    target_zone: 'Zone 1-2',
    pace_target: 'Fully conversational; walking is allowed',
    intensity: 'Recovery',
    warmup: ['5 min easy walking'],
    steps: ['Keep breathing relaxed', 'Stop if soreness changes your stride'],
    cooldown: ['5 min easy walking', 'Hydrate and refuel'],
    progression: 'Do not add distance today.',
    description: `Reduced because a ${round(latestRun.distanceMiles, 1)} mi recent run already created meaningful lower-body load.`,
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
  return {
    latestRun: {
      date: load.latestRun.date,
      distanceMiles: load.latestRun.distanceMiles,
      durationMinutes: load.latestRun.durationMinutes,
      paceLabel: load.latestRun.paceLabel,
      avgHeartRate: load.latestRun.avgHeartRate,
      perceivedEffort: load.latestRun.perceivedEffort,
      isLong: Boolean(load.latestRun.isLong),
      isHard: Boolean(load.latestRun.isHard),
    },
    sevenDayMiles: load.sevenDayMiles,
    loadRatio: load.loadRatio,
    protection: load.protection || { active: false },
  };
}

function applyAcuteRunProtection(plan, context = {}) {
  const load = context.history?.acuteRunLoad;
  if (!load?.protection?.active || !load.latestRun) return plan;
  const next = JSON.parse(JSON.stringify(plan));
  const protection = load.protection;
  const latestDate = load.latestRun.date;
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
        if (isDemandingRun(session) && dateInRange(day.date, latestDate, protection.hardRunsThrough)) {
          rebuilt.push(recoveryRunAfterRecentLoad(session, load.latestRun));
          changed = true;
          weekChanged = true;
          day.status = 'adjusted';
          day.whyToday = `Adjusted after your ${round(load.latestRun.distanceMiles, 1)} mi run on ${latestDate}: hard running is protected through ${protection.hardRunsThrough}.`;
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
      if (lowerIndex < 0 || !dateInRange(day.date, latestDate, protection.lowerBodyThrough)) continue;
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
        day.whyToday = `Lower-body strength was moved outside the recovery window from your ${round(load.latestRun.distanceMiles, 1)} mi run.`;
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
        laterDay.whyToday = `Lower-body strength moved here to protect recovery after your ${round(load.latestRun.distanceMiles, 1)} mi run.`;
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
          day.whyToday = `Lower-body strength moved to ${relocationDay.day} to protect recovery after your ${round(load.latestRun.distanceMiles, 1)} mi run.`;
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
          day.whyToday = `No safe lower-body slot remains this week after your ${round(load.latestRun.distanceMiles, 1)} mi run, so this session changed to optional upper-body work.`;
        }
      }
      changed = true;
      weekChanged = true;
    }

    for (const day of days) {
      if (!dateInRange(day.date, latestDate, protection.upperBodyOptionalThrough)) continue;
      const upper = (day.sessions || []).find((session) => session.kind === 'lift' && /upper/i.test(String(session.focus || '')));
      if (!upper) continue;
      upper.description = `${upper.description} Optional after the recent run: keep this submaximal and skip it if whole-body fatigue or soreness is elevated.`;
      upper.acuteLoadAdjusted = true;
      day.status = 'adjusted';
      day.whyToday = day.whyToday || `Upper-body strength is optional while you recover from the ${round(load.latestRun.distanceMiles, 1)} mi run; lower-body loading stays protected.`;
      changed = true;
      weekChanged = true;
    }

    week.totalMiles = round(days
      .flatMap((day) => day.sessions || [])
      .filter((session) => session.kind === 'run')
      .reduce((sum, session) => sum + Number(session.distance_miles || 0), 0));
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
    sevenDayRunMiles: acute?.sevenDayMiles ?? 0,
    recentRunLoadRatio: acute?.loadRatio ?? null,
  };
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

function goalMetadata(target = {}, existingGoal = {}) {
  const raceDate = parseISODate(target.raceDate) ? target.raceDate : existingGoal.date || null;
  const raceDistance = Number(target.distanceMiles ?? existingGoal.distanceMiles ?? 6.2) || 6.2;
  return Object.assign({}, existingGoal, {
    kind: raceDate ? 'race' : (existingGoal.kind || 'training_block'),
    raceId: target.raceId || existingGoal.raceId || null,
    name: target.raceName || target.goalName || existingGoal.name || `${raceDistance}-mile training block`,
    date: raceDate,
    distanceMiles: raceDistance,
    goalType: target.goalType || existingGoal.goalType || (target.goalTimeSeconds ? 'pr' : 'completion'),
    goalTimeSeconds: Number(target.goalTimeSeconds ?? existingGoal.goalTimeSeconds) || null,
    course: buildGoalCourse(target),
  });
}

function buildConcurrentPlan(context = {}) {
  const profile = context.profile || {};
  const target = context.target || {};
  const history = context.history || {};
  const recovery = context.recovery || {};
  const mode = resolvePlanMode(profile, target);
  const raceDate = parseISODate(target.raceDate) ? target.raceDate : null;
  const weekCount = clamp(Math.round(Number(target.weeks) || 8), raceDate ? 1 : 4, 20);
  const startDate = mondayFor(target.startDate || context.todayISO || toISODate(new Date()));
  const raceDistance = clamp(Number(target.distanceMiles || profile.goal_race_distance || 6.2) || 6.2, 1, 100);
  const availableDays = normalizeWeekdays(target.trainingDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const runDays = selectRunDays(availableDays, target.runDaysPerWeek || profile.run_days_per_week || 3);
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
  const mileageTargets = buildMileageTargets(weekCount, baseline, Boolean(raceDate), recovery, history);
  // H7: only trusted, current structured course facts may drive hill work.
  const trustedCourse = trustedCourseFacts(target);
  const trustedElevationGainFt = trustedCourse.trusted ? Number(trustedCourse.facts.elevationGainFt || 0) : 0;
  const hilly = trustedElevationGainFt / Math.max(1, raceDistance) >= 30;

  const weeks = [];
  for (let weekNumber = 1; weekNumber <= weekCount; weekNumber += 1) {
    const weekStart = addDays(startDate, (weekNumber - 1) * 7);
    const phase = phaseForWeek(weekNumber, weekCount, Boolean(raceDate));
    const raceDay = raceDate && DAY_ORDER.find((day, index) => addDays(weekStart, index) === raceDate);
    const weekRunDays = raceDay && !runDays.includes(raceDay) ? [...runDays.slice(0, Math.max(1, runDays.length - 1)), raceDay] : runDays.slice();
    let scheduledMileageTarget = mileageTargets[weekNumber - 1];
    const priorScheduledMiles = Number(weeks[weeks.length - 1]?.totalMiles || 0);
    if (phase === 'deload' && priorScheduledMiles > 0) scheduledMileageTarget = Math.min(scheduledMileageTarget, priorScheduledMiles * 0.8);
    if (phase === 'taper' && priorScheduledMiles > 0) scheduledMileageTarget = Math.min(scheduledMileageTarget, priorScheduledMiles * 0.65);
    const distances = allocateRunDistances(scheduledMileageTarget, weekRunDays, phase, raceDistance, raceDay);
    const runByDay = new Map();
    weekRunDays.forEach((day, index) => {
      const type = day === raceDay ? 'race' : runTypeFor(day, weekRunDays, phase);
      runByDay.set(day, buildRunSession({ weekNumber, day, type, distance: distances[index], phase, hilly, raceName: target.raceName }));
    });

    const effectiveLiftCount = mode === planSchema.PLAN_MODES.RUN_ONLY ? 0 : phase === 'race' ? Math.min(1, liftDaysPerWeek) : liftDaysPerWeek;
    const liftAssignments = chooseLiftDays(availableDays, runByDay, effectiveLiftCount);
    const liftByDay = new Map(liftAssignments.map(({ day, focus }) => [day, buildLiftSession({ weekNumber, day, focus, mode, phase, context })]));
    const days = DAY_ORDER.map((day, index) => {
      const sessions = [runByDay.get(day), liftByDay.get(day)].filter(Boolean);
      const result = { date: addDays(weekStart, index), day, sessions, status: 'planned' };
      if (sessions.some((session) => session.kind === 'run') && sessions.some((session) => session.kind === 'lift')) {
        result.orderGuidance = 'Run first; lift at least 6 hours later.';
      }
      return result;
    });
    const totalMiles = round(days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run').reduce((sum, session) => sum + Number(session.distance_miles || 0), 0));
    weeks.push({ week: weekNumber, phase, startDate: weekStart, totalMiles, days });
  }

  const plan = {
    schemaVersion: planSchema.SCHEMA_VERSION,
    planMode: mode,
    goal: goalMetadata(target, { kind: raceDate ? 'race' : 'training_block' }),
    strengthPolicy,
    generationSource: 'deterministic',
    generationValidationErrors: [],
    inputSummary: summarizeInputs(profile, history, recovery, context.checkin),
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

function validateRun(session, path, errors) {
  for (const field of ['title', 'distance_miles', 'pace_target', 'target_zone', 'intensity', 'warmup', 'steps', 'cooldown', 'progression', 'description']) {
    const value = session[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) errors.push(`${path}.${field} is required`);
  }
  if (!(Number(session.distance_miles) > 0)) errors.push(`${path}.distance_miles must be positive`);
}

function validateConcurrentPlan(candidate, context = {}) {
  const errors = [];
  const target = context.target || {};
  const expectedMode = resolvePlanMode(context.profile || {}, target);
  const hasRace = Boolean(parseISODate(target.raceDate));
  const expectedWeeks = clamp(Math.round(Number(target.weeks) || 8), hasRace ? 1 : 4, 20);
  const expectedStartDate = mondayFor(target.startDate || context.todayISO);
  const acuteLoad = context.history?.acuteRunLoad;
  const acuteProtection = acuteLoad?.protection?.active ? acuteLoad.protection : null;
  const latestRunDate = acuteLoad?.latestRun?.date || null;
  if (!candidate || typeof candidate !== 'object') return { valid: false, errors: ['candidate is missing'] };
  if (Number(candidate.schemaVersion) !== planSchema.SCHEMA_VERSION) errors.push(`schemaVersion must be ${planSchema.SCHEMA_VERSION}`);
  if (candidate.planMode !== expectedMode) errors.push(`planMode must be ${expectedMode}`);
  if (!candidate.goal || Number(candidate.goal.distanceMiles) !== Number(target.distanceMiles || candidate.goal?.distanceMiles)) errors.push('goal distance is missing or changed');
  if (target.raceDate && candidate.goal?.date !== target.raceDate) errors.push('race date was not preserved');
  if (!Array.isArray(candidate.weeks) || candidate.weeks.length !== expectedWeeks) errors.push(`weeks must contain exactly ${expectedWeeks} entries`);

  const ids = new Set();
  const weekMiles = [];
  const phases = new Set();
  let exactRaceSessionFound = false;
  let raceSpecificSessionFound = false;
  const weeks = Array.isArray(candidate.weeks) ? candidate.weeks : [];
  weeks.forEach((week, weekIndex) => {
    const path = `weeks[${weekIndex}]`;
    if (Number(week.week) !== weekIndex + 1) errors.push(`${path}.week must be ${weekIndex + 1}`);
    if (!parseISODate(week.startDate)) errors.push(`${path}.startDate must be YYYY-MM-DD`);
    if (weekIndex === 0 && week.startDate !== expectedStartDate) errors.push(`${path}.startDate must be ${expectedStartDate}`);
    if (weekIndex > 0 && week.startDate !== addDays(weeks[weekIndex - 1]?.startDate, 7)) errors.push(`${path}.startDate must follow the prior week`);
    if (!['base', 'build', 'deload', 'peak', 'taper', 'race'].includes(week.phase)) errors.push(`${path}.phase is invalid`);
    else phases.add(week.phase);
    if (!Array.isArray(week.days) || week.days.length !== 7) {
      errors.push(`${path}.days must contain seven dated days`);
      return;
    }
    let restDays = 0;
    let lifts = 0;
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
          validateRun(session, sessionPath, errors);
          miles += Number(session.distance_miles || 0);
          if (isHardRun(session)) hardRunIndexes.add(dayIndex);
          if (acuteProtection && String(session.type || '').toLowerCase() !== 'race') {
            if (acuteProtection.noAdditionalRunOnDate && day.date === acuteProtection.noAdditionalRunOnDate) {
              errors.push(`${sessionPath} duplicates a run already logged on ${day.date}`);
            } else if (isDemandingRun(session) && dateInRange(day.date, latestRunDate, acuteProtection.hardRunsThrough)) {
              errors.push(`${sessionPath} conflicts with recent-run hard-session protection through ${acuteProtection.hardRunsThrough}`);
            }
          }
          if (/(hill|course-specific)/i.test([session.title, session.type, session.description].filter(Boolean).join(' '))) raceSpecificSessionFound = true;
          if (String(session.type || '').toLowerCase() === 'race') {
            const exactDistance = Math.abs(Number(session.distance_miles) - Number(target.distanceMiles)) < 0.01;
            if (day.date === target.raceDate && exactDistance) exactRaceSessionFound = true;
            else errors.push(`${sessionPath} race session must preserve the target date and distance`);
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
    if (expectedMode === planSchema.PLAN_MODES.RUN_ONLY && lifts > 0) errors.push(`${path} run_only plans cannot contain lifts`);
    if (expectedMode !== planSchema.PLAN_MODES.RUN_ONLY && week.phase !== 'race') {
      const floor = Number(candidate.strengthPolicy?.minimumSessionsPerWeek || 0);
      if (lifts < floor) errors.push(`${path} has ${lifts} lifts below strength floor ${floor}`);
    }
    for (const lowerIndex of lowerLiftIndexes) {
      for (const hardIndex of hardRunIndexes) {
        if (Math.abs(lowerIndex - hardIndex) <= 1) errors.push(`${path} lower-body strength conflicts with hard/long run at day indexes ${lowerIndex}/${hardIndex}`);
      }
    }
    const roundedMiles = round(miles);
    weekMiles.push(roundedMiles);
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
    if (!weeks[index - 1]?.acuteLoadAdjusted && !['deload', 'taper', 'race'].includes(phase) && previousPhase !== 'deload' && weekMiles[index] > weekMiles[index - 1] * 1.11 + 0.2) {
      errors.push(`weeks[${index}].totalMiles increases more than 10%`);
    }
    if (phase === 'deload' && weekMiles[index] >= weekMiles[index - 1] * 0.9) errors.push(`weeks[${index}] deload must reduce mileage by at least 10%`);
    if (phase === 'taper' && weekMiles[index] >= weekMiles[index - 1] * 0.8) errors.push(`weeks[${index}] taper must reduce mileage by at least 20%`);
  }
  if (target.raceDate && weeks.length) {
    if (weeks[weeks.length - 1]?.phase !== 'race') errors.push('final week must be race phase');
    if (weeks.length > 1 && weeks[weeks.length - 2]?.phase !== 'taper') errors.push('week before race must be taper phase');
    if (!exactRaceSessionFound) errors.push('plan must include the exact race session on the target date');
    if (weeks.length >= 3 && !phases.has('peak')) errors.push('race plan must include a peak phase');
  }
  if (expectedWeeks >= 8 && !phases.has('deload')) errors.push('plan must include a deload phase');
  // H7: only trusted, current course facts may require a hill session, and AI
  // candidates may not fabricate course facts absent from trusted structured data.
  const trustedCourse = trustedCourseFacts(target);
  const trustedElevationGainFt = trustedCourse.trusted ? Number(trustedCourse.facts.elevationGainFt || 0) : 0;
  const elevationPerMile = trustedElevationGainFt / Math.max(1, Number(target.distanceMiles || 0));
  if (elevationPerMile >= 30 && expectedWeeks > 1 && !raceSpecificSessionFound) errors.push('hilly race plan must include a hill or course-specific session');
  const candidateCourse = candidate && candidate.goal && typeof candidate.goal.course === 'object' ? candidate.goal.course : null;
  if (candidateCourse) {
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
  }
  return { valid: errors.length === 0, errors };
}

function selectPlanCandidate(candidate, context = {}) {
  const preparedCandidate = strengthPrescription.applyStrengthPrescriptionData(candidate, context);
  const validation = validateConcurrentPlan(preparedCandidate, context);
  if (validation.valid) {
    return {
      plan: {
        ...preparedCandidate,
        goal: goalMetadata(context.target || {}, preparedCandidate.goal || {}),
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
  mondayFor,
  racePlanWindow,
  resolvePlanMode,
  phaseForWeek,
  buildMileageTargets,
  buildConcurrentPlan,
  applyAcuteRunProtection,
  validateConcurrentPlan,
  selectPlanCandidate,
  buildGoalCourse,
  trustedCourseFacts,
  goalMetadata,
  isHardRun,
};
