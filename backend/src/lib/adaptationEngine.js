// Forged Hybrid H4 transparent adaptation engine.
// Pure and deterministic: no DB, network, framework, or wall-clock dependency.

const planSchema = require('./planSchema');
const checkinOverride = require('./checkinOverride');

const HARD_RUN_PATTERN = /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|zone 3|zone 4|zone 5|z3|z4|z5)/i;
const HEALTH_STALE = new Set(['stale', 'suspect', 'missing', 'no_data', 'unknown']);

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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function compareISO(a, b) {
  const left = parseISODate(a);
  const right = parseISODate(b);
  if (!left || !right) return 0;
  return left.getTime() - right.getTime();
}

function isWithin(date, start, end) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    && compareISO(date, start) >= 0
    && compareISO(date, end) <= 0;
}

function normalizeLifeFlags(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function hasCheckinSignal(checkin = {}) {
  if (!checkin || typeof checkin !== 'object') return false;
  return ['legs', 'drive', 'feeling', 'sleep_hours', 'time_available'].some((key) => (
    checkin[key] !== undefined && checkin[key] !== null && checkin[key] !== ''
  )) || normalizeLifeFlags(checkin.life_flags).length > 0;
}

function isHardRun(session = {}) {
  if (planSchema.kindFromSession(session) !== 'run') return false;
  return HARD_RUN_PATTERN.test([
    session.title,
    session.type,
    session.workout_type,
    session.intensity,
    session.target_zone,
    session.description,
  ].filter(Boolean).join(' '));
}

function sessionSummary(session = {}) {
  const kind = planSchema.kindFromSession(session);
  if (kind === 'lift') return session.title || session.focus || 'Strength session';
  if (kind === 'rest') return 'Rest';
  const miles = Number(session.distance_miles ?? session.distance ?? session.miles);
  const duration = Number(session.duration_min ?? session.duration_minutes ?? session.minutes ?? session.time_minutes);
  const bits = [session.title || session.type || 'Run'];
  if (Number.isFinite(miles) && miles > 0) bits.push(`${Math.round(miles * 10) / 10} mi`);
  else if (Number.isFinite(duration) && duration > 0) bits.push(`${Math.round(duration)} min`);
  if (session.intensity) bits.push(session.intensity);
  return bits.filter(Boolean).join(' - ');
}

function sessionIdFor(day, session, sessionIndex, dayIndex) {
  return planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex);
}

function iterateDays(plan, visitor) {
  const weeks = Array.isArray(plan && plan.weeks) ? plan.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    for (let dayIndex = 0; dayIndex < entries.length; dayIndex += 1) {
      visitor({
        week,
        weekIndex,
        day: entries[dayIndex],
        dayIndex,
        entries,
        entriesKey: planSchema.dayEntriesKey(week),
      });
    }
  }
}

function allDatedSessions(plan, start, end) {
  const result = [];
  iterateDays(plan, ({ weekIndex, day, dayIndex }) => {
    if (!isWithin(day && day.date, start, end)) return;
    const sessions = planSchema.daySessions(day);
    sessions.forEach((session, sessionIndex) => {
      result.push({
        weekIndex,
        dayIndex,
        date: day.date,
        day,
        session,
        sessionIndex,
        sessionId: sessionIdFor(day, session, sessionIndex, dayIndex),
        kind: planSchema.kindFromSession(session),
      });
    });
  });
  return result;
}

function metricValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw.value ?? raw.score ?? raw.readinessScore ?? null;
  }
  return raw;
}

function metricFreshness(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.suspect === true) return 'suspect';
    const freshness = String(raw.freshness || '').toLowerCase();
    if (freshness) return freshness;
    if (raw.fresh === true) return 'fresh';
  }
  return 'unknown';
}

function metricAsOf(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.asOf || raw.as_of || null : null;
}

function isUsableHealthMetric(raw) {
  const value = metricValue(raw);
  const freshness = metricFreshness(raw);
  if (value === null || value === undefined || value === '') return false;
  if (HEALTH_STALE.has(freshness)) return false;
  return freshness === 'fresh';
}

function freshnessLabel(raw) {
  const freshness = metricFreshness(raw);
  const asOf = metricAsOf(raw);
  return asOf ? `${freshness} as of ${String(asOf).slice(0, 10)}` : freshness;
}

function firstFreshMetric(healthSignals = {}, keys = []) {
  const metrics = healthSignals.metrics || {};
  for (const key of keys) {
    const metric = metrics[key] ?? healthSignals[key];
    if (isUsableHealthMetric(metric)) return { key, metric, value: Number(metricValue(metric)) };
  }
  return null;
}

function buildHealthEvidence(healthSignals = {}) {
  const evidence = [];
  const drivers = [];
  const addDriver = (signal, metric, detail) => {
    evidence.push({
      signal,
      source: 'apple_health',
      objective: true,
      freshness: freshnessLabel(metric),
      detail,
    });
    drivers.push(signal);
  };

  const readiness = firstFreshMetric(healthSignals, ['readinessScore', 'readiness_score']);
  if (readiness && Number.isFinite(readiness.value) && readiness.value < 70) {
    addDriver(
      'readiness',
      readiness.metric,
      `Objective Apple Health readiness is ${Math.round(readiness.value)}, below the normal training threshold.`
    );
  }

  const sleep = firstFreshMetric(healthSignals, ['sleepHoursLastNight', 'sleep_hours_last_night', 'sleep']);
  if (sleep && Number.isFinite(sleep.value) && sleep.value < 6) {
    addDriver(
      'sleep',
      sleep.metric,
      `Objective Apple Health sleep is ${Math.round(sleep.value * 10) / 10}h, below the recovery target.`
    );
  }

  const hrv = firstFreshMetric(healthSignals, ['hrvMs', 'hrv_ms', 'hrv']);
  if (hrv && Number.isFinite(hrv.value) && hrv.value < 35) {
    addDriver(
      'hrv',
      hrv.metric,
      `Objective Apple Health HRV is ${Math.round(hrv.value)} ms, which indicates recovery stress.`
    );
  }

  const restingHr = firstFreshMetric(healthSignals, ['restingHeartRate', 'resting_heart_rate', 'rhr']);
  if (restingHr && Number.isFinite(restingHr.value) && restingHr.value >= 85) {
    addDriver(
      'resting_hr',
      restingHr.metric,
      `Objective Apple Health resting heart rate is ${Math.round(restingHr.value)} bpm, above the preferred range.`
    );
  }

  const load = firstFreshMetric(healthSignals, ['acuteChronicLoadRatio', 'acute_chronic_load_ratio', 'loadRatio']);
  if (load && Number.isFinite(load.value) && (load.value > 1.4 || load.value < 0.5)) {
    addDriver(
      'load',
      load.metric,
      `Objective Apple Health load ratio is ${Math.round(load.value * 100) / 100}:1, outside the preferred range.`
    );
  }

  const severe = evidence.some((item) => item.signal === 'readiness' && /readiness is ([0-4][0-9])/.test(item.detail))
    || (readiness && readiness.value < 45)
    || (sleep && sleep.value < 5)
    || (hrv && hrv.value < 28);
  const caution = evidence.length > 0;
  return {
    evidence,
    drivers,
    severity: severe ? 'rest' : caution ? 'reduce' : 'none',
  };
}

function buildCheckinEvidence(checkin = {}, todaySessions = []) {
  if (!hasCheckinSignal(checkin)) return { evidence: [], action: 'keep', patch: {}, safety: false, directive: null };
  const action = checkinOverride.deriveAction(checkin);
  const runToday = todaySessions.find((item) => item.kind === 'run');
  const patch = runToday ? checkinOverride.buildPatch(action, runToday.session, checkin) : {};
  const directive = checkinOverride.buildDirective(checkin, action, patch, Boolean(runToday), 0);
  const flags = normalizeLifeFlags(checkin.life_flags);
  const safety = flags.includes('sick') || flags.includes('injured');
  const drivers = Array.isArray(directive.drivers) ? directive.drivers : [];
  const evidence = drivers.length
    ? drivers.map((driver) => ({
      signal: driver.label || 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: `Subjective check-in: ${driver.detail || driver.label || 'daily check-in signal'}`,
    }))
    : [{
      signal: 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: 'Subjective check-in was recorded and does not require a calendar change.',
    }];
  return { evidence, action, patch, safety, directive };
}

function buildCompletionEvidence(completion = {}) {
  if (!completion || typeof completion !== 'object') return { evidence: [], driver: false };
  const adherence = Number(completion.adherenceRate ?? completion.adherence_rate);
  const missed = Number(completion.missedWorkouts ?? completion.missed_workouts ?? completion.missedCount ?? 0);
  const missedRuns = Number(completion.missedRuns ?? completion.missedRunCount ?? 0);
  const missedLifts = Number(completion.missedLifts ?? completion.missedLiftCount ?? 0);
  const daysInactive = Number(completion.daysInactive ?? completion.days_inactive);
  const gapPromptEnabled = completion.gapPromptEnabled !== false;
  const isPlanStartWindow = completion.isPlanStartWindow === true;
  const trainingGap = gapPromptEnabled
    && Number.isFinite(daysInactive)
    && daysInactive >= (missed >= 1 ? 3 : 4)
    && (missed >= 1 || isPlanStartWindow);
  const driver = trainingGap || (Number.isFinite(adherence) && adherence < 0.65) || missed >= 2 || missedRuns >= 2;
  if (!driver) return { evidence: [], driver: false };
  const details = [];
  if (Number.isFinite(adherence)) details.push(`${Math.round(adherence * 100)}% recent adherence`);
  if (missedRuns || missedLifts || missed) details.push(`${missedRuns || 0} missed runs, ${missedLifts || 0} missed lifts`);
  if (trainingGap) details.unshift(`${Math.round(daysInactive)} days since the last logged run or lift`);
  return {
    driver: true,
    trainingGap,
    daysInactive: trainingGap ? Math.round(daysInactive) : null,
    evidence: [{
      signal: trainingGap ? 'training_gap' : 'adherence',
      source: 'completion',
      objective: true,
      freshness: completion.freshness || 'recent',
      daysInactive: trainingGap ? Math.round(daysInactive) : null,
      missedWorkouts: Math.max(0, missed || 0),
      detail: trainingGap
        ? `Forged Hybrid has not seen a logged run or lift for ${Math.round(daysInactive)} days${missed > 0 ? ` and found ${missed} missed scheduled session${missed === 1 ? '' : 's'}` : ' as the dated plan begins'}. The next demanding run is reviewed before any change is made.`
        : `Logged completion history shows ${details.join('; ') || 'recent missed sessions'}, so the next hard run is reduced instead of forcing a catch-up.`
    }],
  };
}

function isDemandingRun(session) {
  return isHardRun(session) || (planSchema.kindFromSession(session) === 'run' && /(steady|moderate|progression|zone 2-3)/i.test(
    [session.title, session.type, session.intensity, session.target_zone].filter(Boolean).join(' ')
  ));
}

function buildRecentRunEvidence(recentRunLoad = {}) {
  const latest = recentRunLoad?.protectiveRun || recentRunLoad?.latestRun;
  const protection = recentRunLoad?.protection;
  if (!latest || !protection?.active) return { evidence: [], driver: false, latest: null, protection: null };
  const details = [
    `${Number(latest.distanceMiles || 0).toFixed(1)} mi`,
    latest.paceLabel || null,
    latest.durationMinutes ? `${Math.round(Number(latest.durationMinutes))} min` : null,
    latest.avgHeartRate ? `avg HR ${Math.round(Number(latest.avgHeartRate))}` : null,
  ].filter(Boolean).join(', ');
  const evidence = [{
    signal: 'recent run load',
    source: 'recent_run',
    objective: true,
    freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
    detail: `Logged run: ${details}. Duplicate running, hard sessions, and lower-body loading are protected during the next 24-72 hours.`,
  }];
  if (latest.postRunCaution) {
    const checkinDetails = [
      latest.postRunPain && latest.postRunPain !== 'none' ? `${latest.postRunPain} pain` : null,
      latest.postRunEnergy === 'low' ? 'low energy' : null,
    ].filter(Boolean).join(' and ');
    evidence.push({
      signal: 'post-run check-in',
      source: 'post_run_checkin',
      objective: false,
      freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
      detail: `The athlete reported ${checkinDetails}; the next run and lower-body load stay conservative.`,
    });
  }
  return {
    driver: true,
    latest,
    protection,
    evidence,
  };
}

function buildInjuryEvidence(injuryState = {}) {
  const active = Boolean(injuryState && (injuryState.active || injuryState.hasActiveInjury || injuryState.sick));
  if (!active) return { evidence: [], safety: false, reason: null };
  const label = injuryState.sick ? 'sick' : 'active injury';
  const bodyPart = injuryState.bodyPart || injuryState.body_part || injuryState.area || '';
  const reason = injuryState.reason || injuryState.notes || `${label}${bodyPart ? ` (${bodyPart})` : ''}`;
  return {
    safety: true,
    reason,
    evidence: [{
      signal: label,
      source: 'injury',
      objective: false,
      freshness: injuryState.freshness || 'current',
      detail: `User-logged ${label}: ${String(reason).slice(0, 180)}.`
    }],
  };
}

function patchRunForRecovery(session, severity, label) {
  const multiplier = severity === 'rest' ? 0.5 : 0.7;
  const next = Object.assign({}, session, {
    type: 'recovery',
    workout_type: 'recovery',
    title: severity === 'rest' ? 'Recovery run' : 'Easy aerobic run',
    intensity: severity === 'rest' ? 'Recovery' : 'Easy',
    target_zone: 'Zone 1-2',
    pace_target: 'Conversational effort',
    description: label,
    warmup: ['5-10 min easy walking or jogging'],
    steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
    cooldown: ['5 min easy walking', 'Hydrate and refuel'],
    progression: 'Do not add pace, repeats, or distance today.',
  });
  const miles = Number(session.distance_miles);
  if (Number.isFinite(miles) && miles > 0) next.distance_miles = Math.max(0.5, Math.round(miles * multiplier * 10) / 10);
  const duration = Number(session.duration_min);
  if (Number.isFinite(duration) && duration > 0) next.duration_min = Math.max(10, Math.round(duration * multiplier));
  return next;
}

function safetyRestSession(session, reason) {
  return {
    id: session.id,
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Safety hold',
    intensity: 'Rest',
    target_zone: null,
    distance_miles: 0,
    description: `Safety hold: ${reason}`,
    steps: [],
  };
}

function replaceLowerBodyAfterRun(session, latestRun) {
  return {
    ...session,
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: 'Optional upper-body strength',
    focus: 'Upper body',
    warmup: ['Band pull-apart x 20', 'Scapular push-up x 10', 'Two progressive warm-up sets'],
    main: [
      { name: 'Dumbbell bench press', sets: 3, reps: '6-8', rest: '2 min', load: 'Submaximal', rpe: '6-7', cue: 'Keep the shoulder blades set on the bench.', progression: 'Hold load today; do not chase fatigue.' },
      { name: 'One-arm dumbbell row', sets: 3, reps: '8 each side', rest: '90 sec', load: 'Moderate', rpe: '6-7', cue: 'Drive the elbow toward the hip without twisting.', progression: 'Stop with at least three reps in reserve.' },
      { name: 'Pull-up or lat pulldown', sets: 2, reps: '6-10', rest: '90 sec', load: 'Easy-moderate', rir: '3', cue: 'Pull the elbows down without shrugging.', progression: 'Skip the final set if whole-body fatigue is elevated.' },
    ],
    recovery: ['Skip this optional session if soreness changes normal movement', 'Prioritize carbohydrate, protein, hydration, and sleep'],
    progression: 'Resume normal strength progression after lower-body recovery is normal.',
    description: `Lower-body loading is deferred after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi recent run.`,
    acuteLoadAdjusted: true,
  };
}

function markUpperBodyOptionalAfterRun(session, latestRun) {
  const currentTitle = String(session.title || 'Upper-body strength').replace(/^Optional\s+/i, '');
  return {
    ...session,
    title: `Optional ${currentTitle}`,
    description: `${session.description || 'Upper-body strength.'} Keep this submaximal and skip it if whole-body fatigue or soreness is elevated after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi run.`,
    acuteLoadAdjusted: true,
  };
}

function addChange(changeMap, item, after, summary) {
  const key = `${item.date}:${item.sessionId}`;
  if (deepEqual(item.session, after)) return;
  changeMap.set(key, {
    date: item.date,
    sessionId: item.sessionId,
    kind: planSchema.kindFromSession(item.session),
    before: clone(item.session),
    after: clone(after),
    summary,
  });
}

function applyChangesToClone(plan, changes) {
  const next = clone(plan);
  const byDate = new Map();
  for (const change of changes || []) {
    if (!change || !change.date || !change.sessionId) continue;
    const list = byDate.get(change.date) || [];
    list.push(change);
    byDate.set(change.date, list);
  }

  const weeks = Array.isArray(next.weeks) ? next.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    const key = planSchema.dayEntriesKey(week);
    let touched = false;
    const nextEntries = entries.map((day, dayIndex) => {
      const dayChanges = byDate.get(day && day.date);
      if (!dayChanges || !dayChanges.length) return day;
      touched = true;
      const changeBySessionId = new Map(dayChanges.map((change) => [String(change.sessionId), change]));

      if (Array.isArray(day && day.sessions)) {
        const rebuilt = [];
        day.sessions.forEach((session, sessionIndex) => {
          const id = sessionIdFor(day, session, sessionIndex, dayIndex);
          const change = changeBySessionId.get(String(id));
          if (!change) {
            rebuilt.push(session);
            return;
          }
          const afterKind = planSchema.kindFromSession(change.after);
          if (afterKind === 'rest' || change.after?.removeSession === true) return;
          rebuilt.push(Object.assign({}, change.after, { id: change.after.id || session.id || id }));
        });
        const framed = planSchema.toCanonicalDay(day, rebuilt, true);
        framed.sessions = rebuilt.map((session, sessionIndex) => (
          Object.assign({}, session, { id: session.id || `${day.date || day.day || 'day'}-${sessionIndex}` })
        ));
        return framed;
      }

      const legacyId = sessionIdFor(day, day, 0, dayIndex);
      const change = changeBySessionId.get(String(legacyId));
      if (!change) return day;
      return planSchema.applyOverrideToDay(day, change.after || {});
    });
    if (touched) weeks[weekIndex] = Object.assign({}, week, { [key]: nextEntries });
  }
  return next;
}

function invariantSignature(plan) {
  const goal = plan && plan.goal ? plan.goal : {};
  return {
    schemaVersion: plan && plan.schemaVersion,
    planMode: plan && plan.planMode,
    strengthPolicy: plan && plan.strengthPolicy,
    goal: {
      kind: goal.kind,
      raceId: goal.raceId,
      name: goal.name,
      date: goal.date,
      distanceMiles: goal.distanceMiles,
      goalType: goal.goalType,
      course: goal.course === undefined ? null : goal.course,
    },
    phases: (Array.isArray(plan && plan.weeks) ? plan.weeks : []).map((week) => ({
      week: week && week.week,
      phase: week && week.phase,
    })),
  };
}

function outsideWindowDaysEqual(original, candidate, start, end, safetyException) {
  if (safetyException) return true;
  const snapshot = (plan) => {
    const days = [];
    iterateDays(plan, ({ weekIndex, dayIndex, day }) => {
      if (!day || !day.date || isWithin(day.date, start, end)) return;
      days.push({ weekIndex, dayIndex, day });
    });
    return days;
  };
  return deepEqual(snapshot(original), snapshot(candidate));
}

function strengthFloorPreserved(plan) {
  if (!planSchema.isHybridMode(plan && plan.planMode)) return true;
  const floor = Number(plan && plan.strengthPolicy && plan.strengthPolicy.minimumSessionsPerWeek);
  if (!Number.isFinite(floor) || floor <= 0) return true;
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  return weeks.every((week) => {
    if (week && week.phase === 'race') return true;
    const liftCount = planSchema.getDayEntries(week)
      .flatMap((day) => planSchema.daySessions(day))
      .filter((session) => planSchema.kindFromSession(session) === 'lift')
      .length;
    return liftCount >= floor;
  });
}

function keepProposal(input, planningDate, windowStart, windowEnd, evidence, headline, reason) {
  return {
    status: 'keep',
    planningDate,
    windowStart,
    windowEnd,
    safetyException: false,
    evidence: evidence || [],
    changes: [],
    headline,
    choices: ['accept', 'keep_original'],
    reason,
    planVersion: input && input.planVersion ? input.planVersion : null,
    proposedPlan: clone(input && input.plan),
  };
}

function validateCandidateOrKeep(input, proposal, candidate, normalWindowEnd) {
  const plan = input.plan;
  const planningDate = proposal.planningDate;
  if (!deepEqual(invariantSignature(plan), invariantSignature(candidate))) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      normalWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment attempted to change protected race, course, phase, mode, or strength-policy metadata, so it was rejected.'
    );
  }
  if (!outsideWindowDaysEqual(plan, candidate, proposal.windowStart, normalWindowEnd, proposal.safetyException)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      normalWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment changed sessions outside the allowed 72-hour window, so it was rejected.'
    );
  }
  if (!proposal.safetyException && !strengthFloorPreserved(candidate)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      normalWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment would drop lifting below the protected weekly strength floor, so it was rejected.'
    );
  }
  return Object.assign({}, proposal, { proposedPlan: candidate });
}

function buildAdaptationProposal(input = {}) {
  const plan = input.plan;
  const planningDate = input.planningDateISO || input.planningDate;
  const parsedPlanningDate = parseISODate(planningDate);
  if (!planSchema.isSchemaV2(plan) || !parsedPlanningDate) {
    return keepProposal(
      input,
      planningDate || null,
      planningDate || null,
      planningDate || null,
      [],
      'Keep the calendar as planned',
      'This plan is not a dated schema-v2 calendar, so no transparent adaptation was computed.'
    );
  }

  const normalWindowEnd = addDays(planningDate, 3);
  const windowStart = planningDate;
  const todaySessions = allDatedSessions(plan, planningDate, planningDate);
  const injury = buildInjuryEvidence(input.injuryState || input.injury || {});
  const checkin = buildCheckinEvidence(input.checkin || {}, todaySessions);
  const health = buildHealthEvidence(input.healthSignals || {});
  const completion = buildCompletionEvidence(input.completion || input.adherence || {});
  const recentRun = buildRecentRunEvidence(input.recentRunLoad || {});
  let safetyException = false;
  let safetyReason = null;
  let windowEnd = normalWindowEnd;
  const evidence = [
    ...injury.evidence,
    ...checkin.evidence.filter((item) => {
      if (checkin.action === 'keep' && !checkin.safety) return false;
      return true;
    }),
    ...health.evidence,
    ...completion.evidence,
    ...recentRun.evidence,
  ];

  if (injury.safety || checkin.safety) {
    safetyException = true;
    safetyReason = injury.reason || 'sick or injured check-in';
    windowEnd = addDays(planningDate, 6);
  }

  if (input.candidatePlan) {
    const candidateProposal = {
      status: 'proposal',
      planningDate,
      windowStart,
      windowEnd: normalWindowEnd,
      safetyException: false,
      evidence,
      changes: [],
      headline: 'Candidate adjustment rejected if invariants changed',
      choices: ['accept', 'keep_original'],
      reason: 'Candidate plan supplied for validation.',
      planVersion: input.planVersion || null,
    };
    return validateCandidateOrKeep(input, candidateProposal, clone(input.candidatePlan), normalWindowEnd);
  }

  const changes = new Map();
  const sessionsInWindow = allDatedSessions(plan, windowStart, windowEnd);

  if (safetyException) {
    for (const item of sessionsInWindow) {
      if (item.kind !== 'run' && item.kind !== 'lift') continue;
      addChange(
        changes,
        item,
        safetyRestSession(item.session, safetyReason),
        `Safety hold replaces ${sessionSummary(item.session)} because ${safetyReason}.`
      );
    }
  } else {
    const todayRun = todaySessions.find((item) => item.kind === 'run');
    if (todayRun && checkin.action !== 'keep' && Object.keys(checkin.patch || {}).length) {
      const after = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} changes to ${sessionSummary(after)} from today's subjective check-in.`
      );
    } else if (todayRun && checkin.action === 'keep' && Object.keys(checkin.patch || {}).length) {
      const after = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} stays on the calendar but intensity is capped from today's subjective check-in.`
      );
    }

    if (health.severity !== 'none') {
      for (const item of sessionsInWindow) {
        if (item.kind !== 'run' || !isHardRun(item.session)) continue;
        const after = patchRunForRecovery(
          item.session,
          health.severity,
          health.severity === 'rest'
            ? 'Recovery version from fresh objective Apple Health recovery signals.'
            : 'Easier version from fresh objective Apple Health recovery signals.'
        );
        addChange(
          changes,
          item,
          after,
          `${sessionSummary(item.session)} changes to ${sessionSummary(after)} from fresh objective Apple Health recovery data.`
        );
      }
    }

    if (completion.driver) {
      const nextHard = sessionsInWindow.find((item) => (
        item.kind === 'run' && (completion.trainingGap ? isDemandingRun(item.session) : isHardRun(item.session))
      ));
      if (nextHard) {
        const after = patchRunForRecovery(
          nextHard.session,
          'reduce',
          completion.trainingGap
            ? 'Easier re-entry version after a recent training gap.'
            : 'Easier version from recent completion and missed-session history.'
        );
        addChange(
          changes,
          nextHard,
          after,
          `${sessionSummary(nextHard.session)} changes to ${sessionSummary(after)} from ${completion.trainingGap ? 'the recent training gap' : 'recent completion history'}.`
        );
      }
    }

    if (recentRun.driver) {
      for (const item of sessionsInWindow) {
        if (item.kind === 'run' && recentRun.protection.noAdditionalRunOnDate === item.date && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(item.session, 'a run is already logged for today'),
            `${sessionSummary(item.session)} is removed because the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi run is already logged today.`
          );
          continue;
        }
        if (item.kind === 'run' && recentRun.protection.postRunSevere && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(item.session, 'severe pain was reported after the recent run'),
            `${sessionSummary(item.session)} is held because severe post-run pain protects running through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'run' && isDemandingRun(item.session) && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          const after = patchRunForRecovery(
            item.session,
            'reduce',
            `Recovery version after the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi recent run.`
          );
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because hard running is protected through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /lower/i.test(String(item.session.focus || '')) && item.date <= recentRun.protection.lowerBodyThrough) {
          const after = replaceLowerBodyAfterRun(item.session, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to optional upper-body strength because lower-body loading is protected through ${recentRun.protection.lowerBodyThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /upper/i.test(String(item.session.focus || '')) && item.date <= recentRun.protection.upperBodyOptionalThrough) {
          const after = markUpperBodyOptionalAfterRun(item.session, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} remains upper-body only and becomes optional after the recent run.`
          );
        }
      }
    }

  }

  const changeList = Array.from(changes.values()).sort((a, b) => (
    compareISO(a.date, b.date) || String(a.sessionId).localeCompare(String(b.sessionId))
  ));

  if (!changeList.length) {
    return keepProposal(
      input,
      planningDate,
      windowStart,
      normalWindowEnd,
      evidence,
      'Keep the calendar as planned',
      evidence.length
        ? 'Available signals do not warrant changing the dated race calendar.'
        : 'No fresh objective Apple Health driver, recent-run load, subjective check-in driver, completion concern, or active injury was provided.'
    );
  }

  const candidate = applyChangesToClone(plan, changeList);
  const proposal = {
    status: 'proposal',
    planningDate,
    windowStart,
    windowEnd,
    safetyException,
    evidence,
    changes: changeList,
    headline: safetyException
      ? 'Safety hold for the live calendar'
      : completion.trainingGap ? 'Everything okay?' : 'Small transparent calendar adjustment',
    choices: ['accept', 'keep_original'],
    reason: safetyException
      ? `A safety exception is marked because ${safetyReason}; the hold can extend beyond 72 hours.`
      : completion.trainingGap
        ? `We have not seen a logged run or lift in ${completion.daysInactive} days. You can ease the next demanding session or leave the calendar exactly as it is.`
        : 'Only dated sessions inside the next 72 hours are changed from current recovery, recent-run load, check-in, and completion evidence; race target, phases, course facts, and the strength policy stay fixed.',
    planVersion: input.planVersion || null,
  };
  return validateCandidateOrKeep(input, proposal, candidate, normalWindowEnd);
}

function applyProposalToPlan(plan, proposal = {}) {
  if (!proposal || !Array.isArray(proposal.changes) || proposal.changes.length === 0) return clone(plan);
  return applyChangesToClone(plan, proposal.changes);
}

function proposalMatchesPlanVersion(proposal = {}, planVersion) {
  if (!proposal.planVersion) return true;
  return String(proposal.planVersion) === String(planVersion);
}

module.exports = {
  parseISODate,
  toISODate,
  addDays,
  buildAdaptationProposal,
  applyProposalToPlan,
  proposalMatchesPlanVersion,
  isHardRun,
};
