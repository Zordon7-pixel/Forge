const router = require('express').Router();
const { dbGet, dbAll, dbRun, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { generateRaceAdjustment } = require('../services/ai');
const { buildHealthSignals, buildReadinessBand, readinessTrendFromHistory } = require('../lib/healthSignals');
const { applyOverride } = require('../lib/checkinOverride');
const planSchema = require('../lib/planSchema');
const concurrentPlan = require('../lib/concurrentPlan');
const adaptationEngine = require('../lib/adaptationEngine');
const dailyExecution = require('../lib/dailyExecution');
const { getHrProfile } = require('../lib/hrZones');
const { completedWeeklyMileageHistory } = require('../lib/runHistory');
const { decideWeeklyRamp } = require('../lib/weeklyRampEngine');
const { annotatePlanEffort } = require('../lib/planEffort');
const { summarizeRecentRunLoad } = require('../lib/recentRunLoad');
const { repairPlanPrescriptions } = require('../lib/prescriptionIntegrity');
const { summarizeRecentExercises } = require('../lib/strengthPrescription');
const { runActivitySql } = require('../lib/runActivity');
const { allocatePlanSessionRunEvidence, findPlanSessionRunEvidence } = require('../lib/plannedRunMatch');
const hybridReconciliation = require('../lib/hybridReconciliation');
const { dateInTimezone, isIanaTimezone } = require('../lib/challengeRules');
const { resolveRunSchedule } = require('../lib/runSchedule');
const { buildBodyweightAlternative } = require('../lib/travelTraining');
const { planningInputUnchanged } = require('../lib/planningRevision');

// Strength sessions are already equipment-filtered by concurrentPlan's
// buildStrengthExercises/exerciseCatalog path. strengthAdjunct is the standalone
// form of those rules and must not be applied again to served sessions.

const ADAPTATION_POLICY_VERSION = 'training-gap-v1';

function getDayShort() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function normalizeTodayEntry(planJson) {
  if (!planJson?.weeks?.length) return null;
  const today = getDayShort();
  for (const week of planJson.weeks) {
    const days = planSchema.getDayEntries(week);
    const hit = days.find(d => d?.day === today);
    // Session-aware (H1): a schema-v2 day is flattened to the legacy single-day
    // shape; legacy days pass through unchanged (byte-identical).
    if (hit) return planSchema.flattenDayForConsumer(hit);
  }
  return null;
}

function getMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function getPlanStartMonday(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayISO(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizePlanningDate(value, { defaultToToday = false } = {}) {
  const serverDate = getTodayISO();
  const requested = String(value || '').trim();
  if (!requested) return defaultToToday ? serverDate : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  const offsetDays = daysBetween(requested, serverDate);
  return offsetDays !== null && Math.abs(offsetDays) <= 1 ? requested : null;
}

function getPlanningDateFromRequest(req) {
  return normalizePlanningDate(req.query?.date, { defaultToToday: true });
}

function parsePlan(plan) {
  try {
    let parsed;
    if (plan?.plan_data) {
      parsed = typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
    } else {
      parsed = typeof plan?.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan?.plan_json;
    }
    return repairPlanPrescriptions(parsed);
  } catch (err) {
    console.error('[plans/parsePlan] invalid plan JSON:', err.message);
    return null;
  }
}

function parseJsonValue(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[plans/parseJsonValue] invalid JSON:', err.message);
    return fallback;
  }
}

function planAnchorPayload(planJson) {
  if (!planJson || typeof planJson !== 'object') return {};
  const anchorState = ['anchored', 'needs_benchmark'].includes(String(planJson.anchorState || ''))
    ? planJson.anchorState
    : null;
  const anchoredBy = planJson.anchoredBy && typeof planJson.anchoredBy === 'object'
    ? planJson.anchoredBy
    : null;
  return {
    ...(anchorState ? { anchorState } : {}),
    ...(anchoredBy ? { anchoredBy } : {}),
  };
}

function validAnchorState(value) {
  const state = String(value || '');
  return ['anchored', 'needs_benchmark'].includes(state) ? state : null;
}

function durationIsEstimatedFromAnchorState(anchorState) {
  return anchorState !== 'anchored';
}

function runShowsDuration(session = {}) {
  if (planSchema.kindFromSession(session) !== 'run') return false;
  return Number(
    session.duration_min
    ?? session.durationMinutes
    ?? session.duration_minutes
    ?? session.minutes
    ?? session.time_minutes
    ?? 0
  ) > 0;
}

function withDurationEstimatePlanPayload(planJson) {
  if (!planJson || typeof planJson !== 'object') return planJson;
  const planAnchorState = validAnchorState(planJson.anchorState);
  if (!planAnchorState || !Array.isArray(planJson.weeks)) return planJson;

  let weeksChanged = false;
  const weeks = planJson.weeks.map((week) => {
    if (!week || typeof week !== 'object') return week;
    const entriesKey = Array.isArray(week.days) ? 'days' : Array.isArray(week.sessions) ? 'sessions' : null;
    if (!entriesKey) return week;

    let entriesChanged = false;
    const entries = week[entriesKey].map((day) => {
      if (!day || typeof day !== 'object') return day;
      const anchorState = validAnchorState(day.anchorState) || planAnchorState;
      const durationIsEstimated = durationIsEstimatedFromAnchorState(anchorState);

      if (Array.isArray(day.sessions)) {
        let dayFlag = null;
        let sessionsChanged = false;
        const sessions = day.sessions.map((session) => {
          if (!runShowsDuration(session)) return session;
          dayFlag = durationIsEstimated;
          if (session.durationIsEstimated === durationIsEstimated) return session;
          sessionsChanged = true;
          return { ...session, durationIsEstimated };
        });
        if (dayFlag === null) return day;
        if (!sessionsChanged && day.durationIsEstimated === dayFlag) return day;
        entriesChanged = true;
        return { ...day, sessions: sessionsChanged ? sessions : day.sessions, durationIsEstimated: dayFlag };
      }

      if (!runShowsDuration(day)) return day;
      if (day.durationIsEstimated === durationIsEstimated) return day;
      entriesChanged = true;
      return { ...day, durationIsEstimated };
    });

    if (!entriesChanged) return week;
    weeksChanged = true;
    return { ...week, [entriesKey]: entries };
  });

  return weeksChanged ? { ...planJson, weeks } : planJson;
}

function withDurationEstimateExecutionPayload(execution, planJson) {
  if (!execution || typeof execution !== 'object') return execution;
  const anchorState = validAnchorState(execution.anchorState) || validAnchorState(planJson?.anchorState);
  if (!anchorState) return execution;
  const durationIsEstimated = durationIsEstimatedFromAnchorState(anchorState);
  let changed = false;

  const annotate = (session) => {
    if (!runShowsDuration(session)) return session;
    if (session.durationIsEstimated === durationIsEstimated) return session;
    changed = true;
    return { ...session, durationIsEstimated };
  };

  const sessions = Array.isArray(execution.sessions)
    ? execution.sessions.map(annotate)
    : execution.sessions;
  const run = execution.run ? annotate(execution.run) : execution.run;
  if (!changed) return execution;
  return { ...execution, sessions, run };
}

function withDurationEstimateDayPayload(day, planJson) {
  if (!day || typeof day !== 'object') return day;
  const anchorState = validAnchorState(day.anchorState) || validAnchorState(planJson?.anchorState);
  if (!anchorState) return day;
  const durationIsEstimated = durationIsEstimatedFromAnchorState(anchorState);
  let changed = false;

  const annotate = (session) => {
    if (!runShowsDuration(session)) return session;
    if (session.durationIsEstimated === durationIsEstimated) return session;
    changed = true;
    return { ...session, durationIsEstimated };
  };

  const sessions = Array.isArray(day.sessions) ? day.sessions.map(annotate) : day.sessions;
  const topLevel = runShowsDuration(day) && day.durationIsEstimated !== durationIsEstimated
    ? { durationIsEstimated }
    : null;
  if (topLevel) changed = true;
  if (!changed) return day;
  return { ...day, ...(Array.isArray(day.sessions) ? { sessions } : {}), ...(topLevel || {}) };
}

function datedRunSessionsExist(planJson) {
  if (!Array.isArray(planJson?.weeks)) return false;
  return planJson.weeks.some((week) => planSchema.getDayEntries(week).some((day) => (
    /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || ''))
    && planSchema.daySessions(day).some((session) => planSchema.kindFromSession(session) === 'run')
  )));
}

function annotateSessionsForDate(sessions, date, hrProfile) {
  if (!hrProfile || !Array.isArray(sessions)) return sessions;
  const contextDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;
  const prepared = sessions.map((session) => {
    if (!session || typeof session !== 'object' || !contextDate) return { session, injectedDate: false, priorDate: undefined, hadDate: false };
    const hasOwnDate = Object.prototype.hasOwnProperty.call(session, 'date');
    const hasSessionDate = /^\d{4}-\d{2}-\d{2}$/.test(String(
      session.date || session.scheduled_date || session.scheduledDate || ''
    ));
    return hasSessionDate
      ? { session, injectedDate: false, priorDate: session.date, hadDate: hasOwnDate }
      : { session: { ...session, date: contextDate }, injectedDate: true, priorDate: session.date, hadDate: hasOwnDate };
  });
  const annotated = annotatePlanEffort(prepared.map((item) => item.session), hrProfile);
  return annotated.map((session, index) => {
    const context = prepared[index];
    if (!context.injectedDate || !session || typeof session !== 'object') return session;
    const restored = { ...session };
    if (context.hadDate) restored.date = context.priorDate;
    else delete restored.date;
    return restored;
  });
}

function withPlanEffortDayPayload(day, hrProfile) {
  if (!hrProfile || !day || typeof day !== 'object') return day;
  if (Array.isArray(day.sessions)) {
    return { ...day, sessions: annotateSessionsForDate(day.sessions, day.date, hrProfile) };
  }
  return annotateSessionsForDate([day], day.date, hrProfile)[0];
}

function withPlanEffortPayload(planJson, hrProfile) {
  if (!hrProfile || !datedRunSessionsExist(planJson)) return planJson;
  const weeks = planJson.weeks.map((week) => {
    const days = planSchema.getDayEntries(week).map((day) => withPlanEffortDayPayload(day, hrProfile));
    return planSchema.setDayEntries(week, days);
  });
  return { ...planJson, weeks };
}

function plannedWeekMiles(week) {
  const explicit = Number(week?.totalMiles ?? week?.total_miles ?? week?.targetMiles ?? week?.target_miles);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (!week || typeof week !== 'object') return null;
  let total = 0;
  let foundRun = false;
  for (const day of planSchema.getDayEntries(week)) {
    for (const session of planSchema.daySessions(day)) {
      if (planSchema.kindFromSession(session) !== 'run') continue;
      const miles = Number(session.distance_miles ?? session.distanceMiles ?? session.distance);
      if (!Number.isFinite(miles) || miles < 0) continue;
      total += miles;
      foundRun = true;
    }
  }
  return foundRun ? Math.round(total * 100) / 100 : null;
}

function nextWeekRampCandidate(planJson, currentWeek) {
  if (!Array.isArray(planJson?.weeks)) return null;
  const current = Number(currentWeek);
  const nextWeekIndex = Number.isInteger(current) && current >= 1 ? current : 1;
  const week = planJson.weeks[nextWeekIndex];
  const plannedNextWeekMiles = plannedWeekMiles(week);
  return week && plannedNextWeekMiles !== null
    ? { nextWeekIndex, plannedNextWeekMiles }
    : null;
}

function withRampDecisionPayload(planJson, nextWeekIndex, rampDecision) {
  const week = planJson?.weeks?.[nextWeekIndex];
  if (!week || !rampDecision) return planJson;
  const weeks = [...planJson.weeks];
  weeks[nextWeekIndex] = {
    ...week,
    rampDecision: {
      decision: rampDecision.decision,
      targetMiles: rampDecision.targetMiles,
      reason: rampDecision.reason,
      acwr: rampDecision.acwr,
      drivers: rampDecision.drivers,
    },
  };
  return { ...planJson, weeks };
}

async function buildAdaptivePlanView(userId, planJson, currentWeek) {
  if (!planJson || typeof planJson !== 'object') return planJson;
  const effortNeeded = datedRunSessionsExist(planJson);
  const rampCandidate = nextWeekRampCandidate(planJson, currentWeek);
  if (!effortNeeded && !rampCandidate) return planJson;

  const todayISO = getTodayISO();
  const currentWeekStart = getMonday(new Date(`${todayISO}T12:00:00`));
  const historyStart = adaptationEngine.addDays(currentWeekStart, -28);
  const [hrProfile, rampInputs] = await Promise.all([
    effortNeeded ? getHrProfile(userId, dbGet) : Promise.resolve(null),
    rampCandidate ? Promise.all([
      dbAll(
        `SELECT date, distance_miles, type, watch_activity_type, watch_normalized_type
         FROM runs
         WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}
         ORDER BY date ASC`,
        [userId, historyStart, currentWeekStart]
      ).catch((err) => {
        console.error('[plans/adaptive-view] weekly mileage lookup failed:', err.message);
        return [];
      }),
      dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
        console.error('[plans/adaptive-view] health sync lookup failed:', err.message);
        return null;
      }),
      dbAll(
        `SELECT score_date, score, band
         FROM readiness_scores
         WHERE user_id=? AND score_date<=?
         ORDER BY score_date DESC
         LIMIT 14`,
        [userId, todayISO]
      ).catch((err) => {
        console.error('[plans/adaptive-view] readiness history lookup failed:', err.message);
        return [];
      }),
    ]) : Promise.resolve(null),
  ]);

  let servedPlan = withPlanEffortPayload(planJson, hrProfile);
  if (!rampCandidate || !rampInputs) return servedPlan;
  const [recentRuns, healthRow, readinessRows] = rampInputs;
  const weeklyMileageHistory = completedWeeklyMileageHistory(recentRuns, { asOfDate: todayISO, weeks: 4 });
  if (weeklyMileageHistory.length < 4) return servedPlan;

  const healthSignals = buildHealthSignals(healthRow || {}, { now: new Date(`${todayISO}T12:00:00`) });
  if (!healthSignals.available || !Number.isFinite(Number(healthSignals.readinessScore))) return servedPlan;
  const readinessBand = buildReadinessBand(healthSignals.readinessScore);
  const readinessTrend = readinessTrendFromHistory([
    ...(Array.isArray(readinessRows) ? readinessRows : []),
    { score_date: todayISO, score: healthSignals.readinessScore, band: readinessBand.band },
  ]);
  if (!readinessTrend) return servedPlan;

  const rampDecision = decideWeeklyRamp({
    weeklyMileageHistory,
    plannedNextWeekMiles: rampCandidate.plannedNextWeekMiles,
    readinessTrend,
  });
  servedPlan = withRampDecisionPayload(servedPlan, rampCandidate.nextWeekIndex, rampDecision);
  return servedPlan;
}

function withPlanAnchorPayload(value, planJson) {
  if (!value || typeof value !== 'object') return value;
  const payload = planAnchorPayload(planJson);
  return Object.keys(payload).length ? { ...value, ...payload } : value;
}

function planVersionFor(active, parsedPlan) {
  const progress = parseJsonValue(active?.row?.progress_json, {});
  const reconciliationState = Object.fromEntries(
    Object.entries(progress?.hybridSessionReconciliations || {})
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      adaptationPolicyVersion: ADAPTATION_POLICY_VERSION,
      source: active?.source || null,
      planId: active?.row?.id || null,
      userPlanId: active?.row?.user_plan_id || null,
      plan: parsedPlan || null,
      reconciliationState,
    }))
    .digest('hex')
    .slice(0, 32);
}

function daysBetween(leftISO, rightISO) {
  const left = adaptationEngine.parseISODate(leftISO);
  const right = adaptationEngine.parseISODate(rightISO);
  if (!left || !right) return null;
  return Math.round((left.getTime() - right.getTime()) / 86400000);
}

function freshnessForAsOf(asOf, planningDateISO, valuePresent, suspect = false) {
  if (suspect) return 'suspect';
  if (!valuePresent) return 'no_data';
  const asOfDate = String(asOf || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return 'unknown';
  const diff = daysBetween(planningDateISO, asOfDate);
  return diff !== null && diff >= -1 && diff <= 2 ? 'fresh' : 'stale';
}

function adaptationMetric(value, source, asOf, planningDateISO, suspect = false) {
  const valuePresent = value !== null && value !== undefined && value !== '';
  return {
    value: valuePresent ? value : null,
    source: source || 'apple_health',
    asOf: asOf || null,
    freshness: freshnessForAsOf(asOf, planningDateISO, valuePresent, suspect),
    suspect: Boolean(suspect),
  };
}

function buildAdaptationHealthSignals(healthRow, planningDateISO) {
  const row = healthRow || {};
  const derived = buildHealthSignals(row);
  const asOf = row.synced_at || row.updated_at || null;
  const rawSleep = row.sleep_hours_last_night === null || row.sleep_hours_last_night === undefined
    ? null
    : Number(row.sleep_hours_last_night);
  const suspectSleep = Number.isFinite(rawSleep) && rawSleep > 12;
  const source = row.health_source || 'apple_health';
  return {
    recoveryState: derived.recoveryState,
    shouldReduceIntensity: Boolean(derived.shouldReduceIntensity),
    shouldRest: Boolean(derived.shouldRest),
    metrics: {
      readinessScore: adaptationMetric(derived.readinessScore, source, asOf, planningDateISO, false),
      sleepHoursLastNight: adaptationMetric(
        suspectSleep ? rawSleep : derived.metrics?.sleepHoursLastNight,
        source,
        derived.metrics?.sleepEndAt || asOf,
        planningDateISO,
        suspectSleep
      ),
      hrvMs: adaptationMetric(derived.metrics?.hrvMs, source, derived.metrics?.hrvRecordedAt || asOf, planningDateISO, false),
      restingHeartRate: adaptationMetric(derived.metrics?.restingHeartRate, source, derived.metrics?.restingHeartRateRecordedAt || asOf, planningDateISO, false),
      acuteChronicLoadRatio: adaptationMetric(derived.metrics?.acuteChronicLoadRatio, source, asOf, planningDateISO, false),
    },
  };
}

function plannedSessionsBetween(plan, startISO, endISO) {
  const rows = [];
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  for (const week of weeks) {
    const days = planSchema.getDayEntries(week);
    days.forEach((day, dayIndex) => {
      const date = day?.date;
      if (!date || date < startISO || date > endISO) return;
      planSchema.daySessions(day).forEach((session, sessionIndex) => {
        const kind = planSchema.kindFromSession(session);
        if (kind !== 'run' && kind !== 'lift') return;
        rows.push({
          sessionId: planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex),
          date,
          kind,
        });
      });
    });
  }
  return rows;
}

async function buildCompletionSummaryForAdaptation(userId, plan, active, planningDateISO) {
  const since = adaptationEngine.addDays(planningDateISO, -7);
  const planned = plannedSessionsBetween(plan, since, adaptationEngine.addDays(planningDateISO, -1));
  const progress = parseJsonValue(active?.row?.progress_json, {});
  const completedIds = new Set((Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds : []).map(String));
  const reconciliations = progress?.hybridSessionReconciliations && typeof progress.hybridSessionReconciliations === 'object'
    ? progress.hybridSessionReconciliations
    : {};
  const [runs, lifts, workouts, lastRun, lastLift, lastWorkout] = await Promise.all([
    dbAll(`SELECT id, date FROM runs WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}`, [userId, since, planningDateISO]),
    dbAll('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<=?', [userId, since, planningDateISO]),
    dbAll(
      'SELECT id, started_at FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<=? AND ended_at IS NOT NULL',
      [userId, `${since}T00:00:00`, `${planningDateISO}T23:59:59`]
    ),
    dbGet(`SELECT MAX(date) AS last_date FROM runs WHERE user_id=? AND date<=? AND ${runActivitySql()}`, [userId, planningDateISO]),
    dbGet('SELECT MAX(date) AS last_date FROM lifts WHERE user_id=? AND date<=?', [userId, planningDateISO]),
    dbGet(
      'SELECT MAX(substr(started_at, 1, 10)) AS last_date FROM workout_sessions WHERE user_id=? AND started_at<=? AND ended_at IS NOT NULL',
      [userId, `${planningDateISO}T23:59:59`]
    ),
  ]);

  const runDates = (runs || []).map((row) => String(row.date || '').slice(0, 10)).filter(Boolean);
  const liftDates = [
    ...(lifts || []).map((row) => String(row.date || '').slice(0, 10)),
    ...(workouts || []).map((row) => String(row.started_at || '').slice(0, 10)),
  ].filter(Boolean);
  const completionAllocation = hybridReconciliation.allocateSessionEvidence({
    sessions: planned,
    completedSessionIds: Array.from(completedIds),
    reconciliations,
    evidence: [
      ...runDates.map((date) => ({ date, kind: 'run' })),
      ...liftDates.map((date) => ({ date, kind: 'lift' })),
    ],
    maxDayDistance: 1,
  });

  let completed = 0;
  let excused = 0;
  let missedRuns = 0;
  let missedLifts = 0;
  for (const item of planned) {
    const evidenceKey = hybridReconciliation.sessionEvidenceKey(item);
    if (completionAllocation.completedKeys.has(evidenceKey)) completed += 1;
    else {
      const reconciliation = item.kind === 'lift'
        ? reconciliations[hybridReconciliation.reconciliationKey(item.date, item.sessionId)]
        : null;
      if (reconciliation && ['life_event', 'skipped'].includes(reconciliation.response)) {
        excused += 1;
        continue;
      }
      if (item.kind === 'run') missedRuns += 1;
      else missedLifts += 1;
    }
  }

  const lastRunDate = String(lastRun?.last_date || '').slice(0, 10);
  const normalizedLastRunDate = /^\d{4}-\d{2}-\d{2}$/.test(lastRunDate) && lastRunDate <= planningDateISO
    ? lastRunDate
    : null;
  const lastActivityDate = [normalizedLastRunDate, lastLift?.last_date, lastWorkout?.last_date]
    .map((value) => String(value || '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= planningDateISO)
    .sort()
    .pop() || null;
  const daysInactive = lastActivityDate === null
    ? null
    : Math.max(0, daysBetween(planningDateISO, lastActivityDate));
  const daysSinceRun = normalizedLastRunDate === null
    ? null
    : Math.max(0, daysBetween(planningDateISO, normalizedLastRunDate));
  const planStartDate = (Array.isArray(plan?.weeks) ? plan.weeks : [])
    .flatMap((week) => planSchema.getDayEntries(week))
    .map((day) => String(day?.date || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()[0] || null;

  return {
    planned: planned.length,
    completed,
    excused,
    missedRuns,
    missedLifts,
    missedWorkouts: missedRuns + missedLifts,
    adherenceRate: planned.length > excused ? completed / (planned.length - excused) : null,
    freshness: `${since} to ${planningDateISO}`,
    lastRunDate: normalizedLastRunDate,
    daysSinceRun,
    lastActivityDate,
    lastTrainingDate: lastActivityDate,
    daysInactive,
    daysSinceAnyTraining: daysInactive,
    weeklyMileageBaseline: Math.max(0, Number(plan?.inputSummary?.weeklyMileageBaseline || 0)),
    planStartDate,
    isPlanStartWindow: Boolean(planStartDate && planningDateISO <= planStartDate),
  };
}

async function buildAdaptationInputs(userId, plan, active, planningDateISO, options = {}) {
  const recentRunSince = adaptationEngine.addDays(planningDateISO, -34);
  const focusRunId = options.focusRunId ? String(options.focusRunId).trim() : '';
  const recentRunWindow = focusRunId
    ? '((date>=? AND date<=?) OR id=?)'
    : '(date>=? AND date<=?)';
  const recentRunParams = focusRunId
    ? [userId, recentRunSince, planningDateISO, focusRunId]
    : [userId, recentRunSince, planningDateISO];
  const [healthRow, checkin, injuries, completion, recentRuns, profile] = await Promise.all([
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/adaptation] health sync lookup failed:', err.message);
      return null;
    }),
    dbGet(
      'SELECT feeling, legs, drive, sleep_hours, time_available, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [userId, planningDateISO]
    ),
    dbAll(
      'SELECT id, date, body_part, pain_level, notes FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 3',
      [userId]
    ),
    buildCompletionSummaryForAdaptation(userId, plan, active, planningDateISO).catch((err) => {
      console.error('[plans/adaptation] completion summary failed:', err.message);
      return {};
    }),
    dbAll(
      `SELECT id, date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode, notes,
              type, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE user_id=? AND ${recentRunWindow} AND ${runActivitySql()}
       ORDER BY date ASC, created_at ASC`,
      recentRunParams
    ).catch((err) => {
      console.error('[plans/adaptation] recent run lookup failed:', err.message);
      return [];
    }),
    dbGet('SELECT schedule_type, missed_workout_pref FROM users WHERE id=?', [userId]).catch((err) => {
      console.error('[plans/adaptation] preference lookup failed:', err.message);
      return null;
    }),
  ]);
  const openInjuries = (Array.isArray(injuries) ? injuries : []).map((injury) => ({
    id: injury.id,
    date: injury.date,
    bodyPart: injury.body_part,
    body_part: injury.body_part,
    painLevel: injury.pain_level,
    pain_level: injury.pain_level,
    severity: injury.pain_level,
    notes: injury.notes,
    active: true,
  }));
  const activeInjury = openInjuries.length ? openInjuries[0] : null;
  const healthSignals = buildAdaptationHealthSignals(healthRow, planningDateISO);
  const scheduleType = String(profile?.schedule_type || 'adaptive').toLowerCase();
  const missedWorkoutPref = String(profile?.missed_workout_pref || 'adjust_week').toLowerCase();
  return {
    healthSignals,
    checkin: checkin || null,
    completion: {
      ...(completion || {}),
      gapPromptEnabled: ['adaptive', 'flexible'].includes(scheduleType) && missedWorkoutPref !== 'skip',
    },
    recentRunLoad: summarizeRecentRunLoad(recentRuns, {
      todayISO: planningDateISO,
      weeklyBaseline: Number(plan?.inputSummary?.weeklyMileageBaseline || 0),
      recoveryState: healthSignals.recoveryState,
      focusRunId: focusRunId || null,
    }),
    injuryState: activeInjury ? {
      active: true,
      bodyPart: activeInjury.bodyPart,
      body_part: activeInjury.body_part,
      painLevel: activeInjury.painLevel,
      pain_level: activeInjury.pain_level,
      severity: activeInjury.severity,
      notes: activeInjury.notes,
      openInjuries,
      reason: [activeInjury.bodyPart, activeInjury.notes].filter(Boolean).join(': ') || 'active injury log',
      freshness: activeInjury.date || 'current',
    } : { active: false, openInjuries: [] },
  };
}

function encodeProposalReason(proposal) {
  return JSON.stringify({
    headline: proposal.headline,
    reason: proposal.reason,
  });
}

function decodeProposalReason(raw) {
  if (!raw) return { headline: null, reason: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed.headline || parsed.reason)) {
      return { headline: parsed.headline || null, reason: parsed.reason || '' };
    }
  } catch (err) {
    console.error('[plans/adaptation] legacy reason parse skipped:', err.message);
  }
  return { headline: null, reason: String(raw) };
}

function proposalFromRow(row) {
  if (!row) return null;
  const changes = parseJsonValue(row.changes_json, []);
  const evidence = parseJsonValue(row.evidence_json, []);
  const meta = decodeProposalReason(row.reason);
  return {
    id: row.id,
    status: Array.isArray(changes) && changes.length ? 'proposal' : 'keep',
    decisionStatus: row.status,
    planningDate: row.planning_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    safetyException: Number(row.safety_exception || 0) === 1,
    evidence: Array.isArray(evidence) ? evidence : [],
    changes: Array.isArray(changes) ? changes : [],
    headline: meta.headline || (Array.isArray(changes) && changes.length ? 'Calendar adjustment pending' : 'Keep the calendar as planned'),
    choices: ['accept', 'keep_original'],
    reason: meta.reason,
    planVersion: row.plan_version || null,
    planId: row.plan_id || null,
    userPlanId: row.user_plan_id || null,
    triggerRunId: row.trigger_run_id || null,
    episodeKey: row.episode_key || null,
  };
}

async function findPendingAdaptation(userId, planningDateISO, planVersion, tx = null) {
  const get = tx?.get || dbGet;
  return get(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND planning_date=? AND plan_version=? AND status='pending' AND trigger_run_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, planningDateISO, planVersion]
  );
}

async function findLatestAdaptation(userId, planningDateISO, planVersion) {
  return dbGet(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND planning_date=? AND plan_version=? AND trigger_run_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, planningDateISO, planVersion]
  );
}

async function hasDecidedCompletionAdaptation(userId, planningDateISO) {
  const rows = await dbAll(
    `SELECT evidence_json
     FROM plan_adjustment_proposals
     WHERE user_id=? AND planning_date=? AND status IN ('accepted','kept') AND trigger_run_id IS NULL
     ORDER BY decided_at DESC, created_at DESC
     LIMIT 20`,
    [userId, planningDateISO]
  );
  return rows.some((row) => {
    const evidence = parseJsonValue(row.evidence_json, []);
    return Array.isArray(evidence) && evidence.some((item) => item?.source === 'completion');
  });
}

async function findRunGapEpisode(userId, episodeKey, tx = null) {
  if (!episodeKey) return null;
  const get = tx?.get || dbGet;
  return get(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND episode_key=? AND trigger_run_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, episodeKey]
  );
}

function runGapEpisodeKey(evidence) {
  const item = (Array.isArray(evidence) ? evidence : []).find((entry) => (
    entry?.signal === 'run_gap' && typeof entry?.episodeKey === 'string'
  ));
  return item?.episodeKey || null;
}

async function persistAdaptationProposal(userId, active, planVersion, originalPlan, proposal) {
  const episodeKey = runGapEpisodeKey(proposal.evidence);
  const existing = episodeKey
    ? await findRunGapEpisode(userId, episodeKey)
    : await findPendingAdaptation(userId, proposal.planningDate, planVersion);
  if (existing) return proposalFromRow(existing);
  const id = uuidv4();
  const inserted = await dbRun(
    `INSERT INTO plan_adjustment_proposals (
      id, user_id, episode_key, user_plan_id, plan_id, plan_version, window_start, window_end,
      planning_date, status, safety_exception, original_json, proposed_json,
      changes_json, evidence_json, reason
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`,
    [
      id,
      userId,
      episodeKey,
      active?.row?.user_plan_id || null,
      active?.row?.id || null,
      planVersion,
      proposal.windowStart,
      proposal.windowEnd,
      proposal.planningDate,
      'pending',
      proposal.safetyException ? 1 : 0,
      JSON.stringify(originalPlan || null),
      JSON.stringify(proposal.proposedPlan || originalPlan || null),
      JSON.stringify(proposal.changes || []),
      JSON.stringify(proposal.evidence || []),
      encodeProposalReason(proposal),
    ]
  );
  if (inserted.changes === 0) {
    const concurrent = episodeKey
      ? await findRunGapEpisode(userId, episodeKey)
      : await findPendingAdaptation(userId, proposal.planningDate, planVersion);
    if (!concurrent) throw new Error('Pending adaptation proposal conflict could not be resolved');
    return proposalFromRow(concurrent);
  }
  return Object.assign({}, proposal, {
    id,
    decisionStatus: 'pending',
    planVersion,
    planId: active?.row?.id || null,
    userPlanId: active?.row?.user_plan_id || null,
  });
}

async function findRunAdaptation(userId, runId, tx = null) {
  const get = tx?.get || dbGet;
  return get(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND trigger_run_id=?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, runId]
  );
}

async function persistRunAdaptation(userId, run, active, planVersion, originalPlan, proposal) {
  const existing = await findRunAdaptation(userId, run.id);
  const hasChanges = Array.isArray(proposal.changes) && proposal.changes.length > 0;
  const nextStatus = hasChanges ? 'pending' : 'reviewed';
  if (existing) {
    if (existing.status === 'accepted' || existing.status === 'kept') return proposalFromRow(existing);
    const updated = await dbRun(
      `UPDATE plan_adjustment_proposals
       SET user_plan_id=?, plan_id=?, plan_version=?, window_start=?, window_end=?,
           planning_date=?, status=?, safety_exception=?, original_json=?, proposed_json=?,
           changes_json=?, evidence_json=?, reason=?, decided_at=NULL
       WHERE id=? AND user_id=? AND trigger_run_id=? AND status IN ('pending','reviewed')`,
      [
        active?.row?.user_plan_id || null,
        active?.row?.id || null,
        planVersion,
        proposal.windowStart,
        proposal.windowEnd,
        proposal.planningDate,
        nextStatus,
        proposal.safetyException ? 1 : 0,
        JSON.stringify(originalPlan || null),
        JSON.stringify(proposal.proposedPlan || originalPlan || null),
        JSON.stringify(proposal.changes || []),
        JSON.stringify(proposal.evidence || []),
        encodeProposalReason(proposal),
        existing.id,
        userId,
        run.id,
      ]
    );
    if (updated.changes === 0) {
      const concurrentlyDecided = await findRunAdaptation(userId, run.id);
      if (!concurrentlyDecided) throw new Error('Run adaptation review update could not be resolved');
      return proposalFromRow(concurrentlyDecided);
    }
    const refreshed = await findRunAdaptation(userId, run.id);
    if (!refreshed) throw new Error('Run adaptation review could not be refreshed');
    return proposalFromRow(refreshed);
  }
  const id = uuidv4();
  await dbRun(
    `INSERT INTO plan_adjustment_proposals (
      id, user_id, trigger_run_id, user_plan_id, plan_id, plan_version,
      window_start, window_end, planning_date, status, safety_exception,
      original_json, proposed_json, changes_json, evidence_json, reason
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`,
    [
      id,
      userId,
      run.id,
      active?.row?.user_plan_id || null,
      active?.row?.id || null,
      planVersion,
      proposal.windowStart,
      proposal.windowEnd,
      proposal.planningDate,
      nextStatus,
      proposal.safetyException ? 1 : 0,
      JSON.stringify(originalPlan || null),
      JSON.stringify(proposal.proposedPlan || originalPlan || null),
      JSON.stringify(proposal.changes || []),
      JSON.stringify(proposal.evidence || []),
      encodeProposalReason(proposal),
    ]
  );
  const stored = await findRunAdaptation(userId, run.id);
  if (!stored) throw new Error('Run adaptation review could not be persisted');
  return proposalFromRow(stored);
}

function raceTargetSnapshot(race = {}) {
  return {
    raceId: race.id || null,
    name: race.race_name || null,
    date: race.race_date || null,
    distanceMiles: Number(race.distance_miles || 0) || null,
    location: race.location || null,
    goalTimeSeconds: race.goal_time_seconds ?? null,
  };
}

function completeRaceTargetSnapshot(snapshot, raceId) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return String(snapshot.raceId || snapshot.race_id || '') === String(raceId || '')
    && ['name', 'date', 'distanceMiles', 'location', 'goalTimeSeconds']
      .every((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
}

function goalRaceId(goal = {}) {
  const target = goal.raceTarget || goal.race_target || {};
  return String(goal.raceId || goal.race_id || target.raceId || target.race_id || '').trim();
}

function courseTargetFromRace(race = {}) {
  return {
    raceId: race.id || null,
    raceTarget: raceTargetSnapshot(race),
    elevation_gain_ft: race.elevation_gain_ft,
    max_altitude_ft: race.max_altitude_ft,
    terrain: race.terrain || null,
    course_profile_json: race.course_profile_json || null,
    source: race.source || null,
    url: race.url || null,
    courseProvenance: race.source || race.url ? 'curated' : 'unknown',
  };
}

const CLIENT_COURSE_KEYS = [
  'elevation_gain_ft', 'elevationGainFt', 'max_altitude_ft', 'maxAltitudeFt',
  'terrain', 'courseTerrain', 'course_profile_json', 'courseProfile',
  'source', 'courseSource', 'url', 'courseUrl', 'provenance', 'courseProvenance',
  'raceTarget', 'race_target', 'nowISO', 'todayISO',
];

// Course facts may only enter plan generation from an owned race row. A generic
// client target can choose distance/date/preferences, but cannot self-assert a
// trusted course envelope or manipulate freshness evaluation.
function stripClientCourseFacts(target = {}) {
  const safe = { ...target };
  for (const key of CLIENT_COURSE_KEYS) delete safe[key];
  delete safe.raceTargets;
  delete safe.race_targets;
  return safe;
}

const DETERMINISTIC_PLAN_CONFLICT = /(current-week|scheduled runs?|weekly runs?|selected trainingDays|full rest day|strength floor|lower-body strength conflicts|target-pace session|taper must reduce|deload must reduce)/i;

function sendPlanScheduleConflict(res, validation) {
  if (!validation?.errors?.some((error) => DETERMINISTIC_PLAN_CONFLICT.test(String(error)))) return false;
  res.status(422).json({ code: 'PLAN_SCHEDULE_CONFLICT', error: 'This race timing and training schedule cannot be rebuilt safely. Adjust the race goals, selected days, or weekly frequency and try again.' });
  return true;
}

function mapType(day = {}) {
  const t = String(day.workout_type || day.type || '').toLowerCase();
  if (t.includes('rest')) return 'rest';
  if (t.includes('strength') || t.includes('lift') || t.includes('cross')) return 'lift';
  return 'run';
}

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const idx = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (idx === undefined) return null;
  const d = new Date(`${weekStart}T12:00:00`);
  d.setDate(d.getDate() + idx);
  return d.toISOString().slice(0, 10);
}

function activeWeekStart(parsed, activeRow, weekIndex, fallbackWeekStart) {
  const week = parsed?.weeks?.[weekIndex] || {};
  const direct = [week.startDate, week.week_start]
    .map((value) => String(value || '').slice(0, 10))
    .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (direct) return direct;

  const firstWeekStart = String(parsed?.weeks?.[0]?.startDate || parsed?.weeks?.[0]?.week_start || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(firstWeekStart)) {
    return hybridReconciliation.addDays(firstWeekStart, weekIndex * 7);
  }

  const assignedStart = String(activeRow?.week_start || activeRow?.started_at || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(assignedStart)) {
    return hybridReconciliation.addDays(assignedStart, weekIndex * 7);
  }
  return fallbackWeekStart;
}

function withCanonicalWeekDates(week, weekStart) {
  const entries = planSchema.getDayEntries(week).map((entry) => {
    const explicitDate = String(entry?.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) return entry;
    const derivedDate = dayToDate(weekStart, entry?.day);
    return derivedDate ? { ...entry, date: derivedDate } : entry;
  });
  return planSchema.setDayEntries(week, entries);
}

async function getActivePlanForUser(userId, tx = null) {
  const get = tx?.get || dbGet;
  const assigned = await get(`
    SELECT up.id as user_plan_id, up.current_week, up.started_at, up.status, up.progress_json,
           tp.*
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC
    LIMIT 1
  `, [userId]);
  if (assigned) return { source: 'assigned', row: assigned };

  const legacy = await get('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  if (legacy) return { source: 'legacy', row: legacy };
  return null;
}

// Lock the owner-scoped assignment before reading its current plan pointer.
// This keeps copy-on-write and whole-plan JSON mutation inside one serializable
// read/validate/write sequence for a given athlete.
async function getActivePlanForMutation(userId, tx) {
  const assignment = await tx.get(`
    SELECT up.id AS user_plan_id, up.plan_id, up.current_week, up.started_at,
           up.status, up.progress_json
    FROM user_plans up
    WHERE up.user_id=? AND up.status='active'
    ORDER BY up.created_at DESC
    LIMIT 1
    FOR UPDATE OF up
  `, [userId]);
  if (assignment) {
    const plan = await tx.get(`
      SELECT tp.*
      FROM training_plans tp
      JOIN user_plans owner_up ON owner_up.plan_id=tp.id
      WHERE tp.id=? AND owner_up.id=? AND owner_up.user_id=?
      FOR UPDATE OF tp
    `, [assignment.plan_id, assignment.user_plan_id, userId]);
    if (!plan) return null;
    return { source: 'assigned', row: { ...plan, ...assignment, id: plan.id } };
  }

  const legacy = await tx.get(`
    SELECT * FROM training_plans
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `, [userId]);
  return legacy ? { source: 'legacy', row: legacy } : null;
}

async function ensureWritablePlan(active, userId, tx) {
  if (active.source === 'assigned' && !active.row.user_id) {
    const cloneId = uuidv4();
    const cloneResult = await tx.run(
      `INSERT INTO training_plans (
        id, user_id, week_start, plan_json, name, type, weeks, description, plan_data
      )
      SELECT ?, ?, week_start, plan_json, name, type, weeks, description, plan_data
      FROM training_plans WHERE id=?`,
      [cloneId, userId, active.row.id]
    );
    if (cloneResult.changes === 0) throw new Error('Active plan clone failed');
    const repointResult = await tx.run(
      'UPDATE user_plans SET plan_id=? WHERE id=? AND user_id=?',
      [cloneId, active.row.user_plan_id, userId]
    );
    if (repointResult.changes === 0) throw new Error('Active plan repoint failed');
    active.row.id = cloneId;
    active.row.user_id = userId;
  }
  return active.row.id;
}

async function updateActivePlanData(active, userId, planJson, tx) {
  const planId = await ensureWritablePlan(active, userId, tx);
  const serialized = JSON.stringify(planJson);
  const result = active.source === 'assigned'
    ? await tx.run('UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?', [serialized, planId, userId])
    : await tx.run('UPDATE training_plans SET plan_json=? WHERE id=? AND user_id=?', [serialized, planId, userId]);
  if (result.changes === 0) throw new Error('Active plan update failed');
  return planId;
}

function defaultWeeksForDistance(distanceMiles) {
  const distance = Number(distanceMiles || 0);
  if (distance >= 20) return 16;
  if (distance >= 11) return 12;
  if (distance >= 5.5) return 10;
  return 8;
}

async function buildConcurrentContext(userId, profile, target) {
  const planningDateISO = /^\d{4}-\d{2}-\d{2}$/.test(String(target.todayISO || '')) ? target.todayISO : getTodayISO();
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - 55);
  const sinceDate = start.toISOString().slice(0, 10);
  const [runs, performanceRuns, lifts, recentExercises, healthRow, activeInjury, dailyCheckin] = await Promise.all([
    dbAll(
      `SELECT date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode, notes,
              type, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}
       ORDER BY date ASC, created_at ASC`,
      [userId, sinceDate, planningDateISO]
    ),
    dbAll(
      `SELECT id, date, distance_miles, duration_seconds, health_source, watch_mode,
              workout_metrics_json, type, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE user_id=? AND date<=? AND distance_miles>0 AND duration_seconds>0 AND ${runActivitySql()}
       ORDER BY date DESC, created_at DESC
       LIMIT 5000`,
      [userId, planningDateISO]
    ),
    dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND started_at>=? AND ended_at IS NOT NULL ORDER BY started_at ASC', [userId, `${sinceDate}T00:00:00`]),
    dbAll(
      `SELECT exercise_name, session_id, reps, weight_lbs, logged_at
       FROM workout_sets
       WHERE user_id=? AND logged_at>=?
       ORDER BY logged_at DESC
       LIMIT 200`,
      [userId, `${sinceDate}T00:00:00`]
    ).catch((err) => {
      console.error('[plans/generate] recent exercise lookup failed:', err.message);
      return [];
    }),
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/generate] health sync lookup failed:', err.message);
      return null;
    }),
    dbGet('SELECT id FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 1', [userId]).catch((err) => {
      console.error('[plans/generate] injury lookup failed:', err.message);
      return null;
    }),
    dbGet(
      'SELECT feeling, legs, drive, sleep_hours, time_available, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [userId, planningDateISO]
    ).catch((err) => {
      console.error('[plans/generate] daily check-in lookup failed:', err.message);
      return null;
    }),
  ]);
  const activityDates = [
    ...(runs || []).map((run) => String(run.date || '').slice(0, 10)),
    ...(lifts || []).map((lift) => String(lift.started_at || '').slice(0, 10)),
  ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const weeksObserved = activityDates.length
    ? clamp(Math.ceil((Date.now() - new Date(`${activityDates[0]}T12:00:00`).getTime()) / (7 * 86400000)) || 1, 1, 8)
    : 0;
  const expectedPerWeek = clampInt(
    target.runDaysPerWeek,
    1,
    6,
    clampInt(profile.run_days_per_week, 1, 6, 3)
  ) + clampInt(
    target.liftDaysPerWeek,
    0,
    4,
    clampInt(profile.lift_days_per_week, 0, 4, 0)
  );
  const expectedSessions = weeksObserved * expectedPerWeek;
  const completedSessions = (runs || []).length + (lifts || []).length;
  const healthSignals = buildHealthSignals(healthRow || {});
  const healthMetrics = healthSignals.metrics || {};
  const healthFreshness = healthMetrics.freshness || {};
  const hasMetric = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const hasTrainingRelevantHealthData = Boolean(healthSignals.available
    || (healthFreshness.activity !== false && [healthMetrics.activeMinutesThisWeek, healthMetrics.workoutCountThisWeek].some(hasMetric))
    || (healthFreshness.exerciseMinutes !== false && hasMetric(healthMetrics.exerciseMinutesThisWeek))
    || (healthFreshness.vo2Max !== false && hasMetric(healthMetrics.vo2Max))
    || (healthFreshness.heartRateRecovery !== false && hasMetric(healthMetrics.heartRateRecoveryOneMinute))
    || (healthFreshness.respiratoryRate !== false && hasMetric(healthMetrics.respiratoryRate))
    || (healthFreshness.runningDynamics !== false && [healthMetrics.runningPowerWatts, healthMetrics.runningSpeedMps, healthMetrics.runningStrideLengthM, healthMetrics.runningVerticalOscillationCm, healthMetrics.runningGroundContactTimeMs].some(hasMetric)));
  let recoveryState = healthSignals.available ? healthSignals.recoveryState : 'unknown';
  const checkinFlags = parseLifeFlags(dailyCheckin?.life_flags);
  const checkinFeeling = Number(dailyCheckin?.feeling || 0);
  const checkinSleep = dailyCheckin?.sleep_hours === null || dailyCheckin?.sleep_hours === undefined
    ? null
    : Number(dailyCheckin.sleep_hours);
  const severeCheckin = checkinFeeling === 1
    || (Number.isFinite(checkinSleep) && checkinSleep < 4.5)
    || checkinFlags.some((flag) => ['sick', 'not_well', 'injured'].includes(flag));
  const cautionCheckin = checkinFeeling === 2
    || Number(dailyCheckin?.legs || 0) === 1
    || Number(dailyCheckin?.drive || 0) === 1
    || (Number.isFinite(checkinSleep) && checkinSleep < 6)
    || checkinFlags.includes('stressed');
  if (severeCheckin) recoveryState = 'low';
  else if (cautionCheckin && !['low', 'recovery'].includes(recoveryState)) recoveryState = 'caution';
  if (activeInjury || profile.comeback_mode || String(profile.injury_notes || '').trim()) recoveryState = 'low';
  const mileageBaseline = concurrentPlan.estimateWeeklyMileageBaseline(runs, {
    planningDateISO,
    profileWeeklyMiles: profile.weekly_miles_current,
  });
  const weeklyMileageBaseline = mileageBaseline.weeklyMiles;
  const acuteRunLoad = summarizeRecentRunLoad(runs, {
    todayISO: planningDateISO,
    weeklyBaseline: weeklyMileageBaseline,
    recoveryState,
  });
  const performanceProfile = concurrentPlan.buildRunPerformanceProfile(performanceRuns, {
    todayISO: planningDateISO,
    targetDistanceMiles: target.distanceMiles,
  });
  return {
    profile,
    target,
    todayISO: planningDateISO,
    safety: {
      activeInjury: Boolean(activeInjury),
      comebackMode: Boolean(profile.comeback_mode),
      injuryNotesPresent: Boolean(String(profile.injury_notes || '').trim()),
    },
    history: {
      weeklyMileageBaseline,
      mileageBaseline,
      recentRunCount: (runs || []).length,
      recentLiftCount: (lifts || []).length,
      acuteRunLoad,
      performanceProfile,
      recentExercises: summarizeRecentExercises(recentExercises || []),
      adherenceRate: expectedSessions ? clamp(completedSessions / expectedSessions, 0, 1) : null,
      missedWorkouts: expectedSessions ? Math.max(0, expectedSessions - completedSessions) : 0,
    },
    recovery: {
      state: recoveryState,
      available: Boolean(healthSignals.available),
      dataAvailable: hasTrainingRelevantHealthData,
      readinessScore: healthSignals.readinessScore ?? null,
      syncedAt: healthRow?.synced_at || null,
      metrics: healthSignals.metrics || {},
    },
    checkin: dailyCheckin ? {
      date: dailyCheckin.checkin_date,
      feeling: Number(dailyCheckin.feeling || 0) || null,
      legs: Number(dailyCheckin.legs || 0) || null,
      drive: Number(dailyCheckin.drive || 0) || null,
      sleepHours: Number.isFinite(checkinSleep) ? checkinSleep : null,
      timeAvailable: Number(dailyCheckin.time_available || 0) || null,
      lifeFlags: checkinFlags,
    } : null,
  };
}

async function persistConcurrentPlan(userId, plan, meta = {}) {
  const planId = uuidv4();
  const userPlanId = uuidv4();
  const weekStart = plan.weeks?.[0]?.startDate || getMonday();
  const serialized = JSON.stringify(plan);
  await withPlanningInputMutation(userId, async (tx) => {
    const schedule = plan.schedulePreferences || {};
    if (schedule.runDaysSource === 'target' && schedule.trainingDaysSource === 'target') {
      const preferenceResult = await tx.run(
        'UPDATE users SET run_days_per_week=?, preferred_workout_days=? WHERE id=?',
        [schedule.runDaysPerWeek, JSON.stringify(schedule.trainingDays || []), userId]
      );
      if (preferenceResult.changes === 0) throw new Error('Plan preferences update failed');
    }
    await tx.run("UPDATE user_plans SET status='inactive' WHERE user_id=? AND status='active'", [userId]);
    await tx.run(
      `INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [planId, userId, weekStart, serialized, meta.name, meta.type, plan.weeks.length, meta.description, serialized]
    );
    await tx.run(
      `INSERT INTO user_plans (
         id, user_id, plan_id, started_at, current_week, status, progress_json,
         plan_version, lineage_id, effective_from
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        userPlanId,
        userId,
        planId,
        weekStart,
        1,
        'active',
        JSON.stringify({ completedSessionIds: [] }),
        1,
        userPlanId,
        weekStart,
      ]
    );
  });
  return { planId, userPlanId, weekStart };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), min, max);
}

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getPlanTargetOptions(target = null) {
  const dayByKey = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const trainingDays = Array.isArray(target?.trainingDays)
    ? [...new Set(target.trainingDays
      .map((day) => dayByKey[String(day || '').trim().slice(0, 3).toLowerCase()])
      .filter(Boolean))]
    : [];
  const courseTrust = concurrentPlan.trustedCourseFacts(target || {});
  const elevationGainFt = courseTrust.trusted ? parsePositiveNumber(courseTrust.facts.elevationGainFt) : null;
  const distanceMiles = parsePositiveNumber(target?.distanceMiles ?? target?.distance_miles);
  const maxAltitudeFt = courseTrust.trusted ? parsePositiveNumber(courseTrust.facts.maxAltitudeFt) : null;
  const courseHilly = elevationGainFt
    ? (distanceMiles ? (elevationGainFt / distanceMiles) >= 30 : elevationGainFt >= 800)
    : false;
  return {
    liftingEnabled: target?.liftingEnabled === false ? false : true,
    trainingDays,
    courseHilly,
    courseHighAltitude: maxAltitudeFt ? maxAltitudeFt >= 5000 : false,
    courseTerrain: courseTrust.trusted ? (courseTrust.facts.terrain || null) : null,
  };
}

function defaultPrefillFromProfile(profile = {}) {
  const schedule = resolveRunSchedule(profile);
  const liftDaysPerWeek = clampInt(profile.lift_days_per_week, 0, 7, 2);
  return {
    inferredTrainingDays: schedule.trainingDaysSource === 'profile' ? schedule.trainingDays : [],
    runDaysPerWeek: schedule.runDaysPerWeek,
    liftDaysPerWeek,
    liftingEnabled: liftDaysPerWeek > 0,
  };
}

function weekdayFromDateString(dateString) {
  const datePart = String(dateString || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const date = new Date(`${datePart}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

function parseLifeFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[plans/parseLifeFlags] invalid JSON:', err.message);
    return [];
  }
}

function normalizeGoalType(goalType = '') {
  const g = String(goalType || '').toLowerCase();
  if (g.includes('5k')) return '5k';
  if (g.includes('10k')) return '10k';
  if (g.includes('half')) return 'half';
  if (g.includes('marathon')) return 'marathon';
  if (g.includes('run_longer')) return '10k';
  if (g.includes('get_faster')) return '5k';
  return 'fitness';
}

function getBaseDistances(goalType) {
  switch (normalizeGoalType(goalType)) {
    case '5k': return [2.0, 2.5, 3.0, 1.5, 2.2];
    case '10k': return [3.0, 3.8, 5.0, 2.2, 3.1];
    case 'half': return [4.0, 5.0, 7.5, 3.0, 4.5];
    case 'marathon': return [5.0, 6.0, 10.0, 3.5, 5.5];
    default: return [2.2, 2.8, 4.0, 1.8, 2.5];
  }
}

function getIntensityMultiplier(intensity) {
  if (intensity === 'recovery') return 0.6;
  if (intensity === 'reduced') return 0.85;
  if (intensity === 'increased') return 1.1;
  return 1;
}

function runDetailsForTemplate(title = '', intensity = 'normal') {
  const label = String(title || '').toLowerCase();
  if (label.includes('quality')) {
    return {
      pace_target: intensity === 'reduced' ? '10:00-10:45/mi' : '9:15-10:00/mi',
      target_zone: 'Zone 3',
      intensity: 'Comfortably hard',
      progression: 'Start easy, settle into steady work, and finish controlled.',
      description: 'Progression run — do not sprint the finish.',
      steps: ['10 min easy warm-up', 'Steady middle miles', '5 min controlled finish', '5 min easy cool-down'],
    };
  }
  if (label.includes('long')) {
    return {
      pace_target: '10:30-11:45/mi',
      target_zone: 'Zone 2',
      intensity: 'Easy aerobic',
      progression: 'Keep it conversational so the distance builds endurance without draining the week.',
      description: 'Long aerobic run — steady breathing, no pace chasing.',
      steps: ['First mile relaxed', 'Hold even effort through the middle', 'Last mile smooth and easy'],
    };
  }
  if (label.includes('recovery')) {
    return {
      pace_target: '11:00-12:30/mi',
      target_zone: 'Zone 1-2',
      intensity: 'Recovery',
      progression: 'Run slower than normal and stop if soreness changes your stride.',
      description: 'Recovery run — the win is finishing fresher than you started.',
      steps: ['5 min very easy', 'Hold relaxed effort', 'Walk 2-3 min if breathing climbs'],
    };
  }
  return {
    pace_target: intensity === 'increased' ? '9:45-10:45/mi' : '10:15-11:15/mi',
    target_zone: 'Zone 2',
    intensity: 'Conversational aerobic',
    progression: 'Easy aerobic run — build consistency without forcing speed.',
    description: 'Easy run — conversational pace from start to finish.',
    steps: ['5-10 min relaxed warm-up', 'Hold steady conversational pace', 'Cool down easy'],
  };
}

function generateSessions(intensity, user = {}) {
  const runDays = clamp(Number(user.run_days_per_week || 3), 2, 6);
  const liftDays = clamp(Number(user.lift_days_per_week || 2), 0, 4);
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const preferredRunDays = parsePreferredDays(user.preferred_run_days);
  const fallbackRunDayOrder = [1, 3, 5, 6, 2, 0, 4];
  const runDayOrder = [
    ...preferredRunDays,
    ...fallbackRunDayOrder.filter((idx) => !preferredRunDays.includes(idx)),
  ];
  const liftDayOrder = [0, 2, 4, 6, 1, 3, 5];

  const sessions = dayLabels.map((day) => ({
    id: `adaptive-${day.toLowerCase()}`,
    day,
    type: 'rest',
    title: 'Recovery / Rest',
    distance_miles: 0,
  }));

  const selectedRunDays = runDayOrder.slice(0, runDays);
  const selectedLiftDays = [];
  for (const idx of liftDayOrder) {
    if (selectedLiftDays.length >= liftDays) break;
    if (selectedRunDays.includes(idx)) continue;
    selectedLiftDays.push(idx);
  }

  const runTemplates = [
    { title: 'Easy run', type: 'run' },
    { title: 'Quality run', type: 'run' },
    { title: 'Long run', type: 'run' },
    { title: 'Recovery run', type: 'run' },
    { title: 'Steady run', type: 'run' },
    { title: 'Easy run', type: 'run' },
  ];
  const baseDistances = getBaseDistances(user.goal_type);
  const intensityFactor = getIntensityMultiplier(intensity);

  for (let i = 0; i < selectedRunDays.length; i += 1) {
    const dayIdx = selectedRunDays[i];
    const template = runTemplates[i] || runTemplates[runTemplates.length - 1];
    const base = baseDistances[Math.min(i, baseDistances.length - 1)];
    const details = runDetailsForTemplate(template.title, intensity);
    sessions[dayIdx] = {
      id: `adaptive-run-${dayLabels[dayIdx].toLowerCase()}`,
      day: dayLabels[dayIdx],
      type: template.type,
      title: template.title,
      distance_miles: Math.max(1, Math.round(base * intensityFactor * 10) / 10),
      ...details,
    };
  }

  for (const dayIdx of selectedLiftDays) {
    sessions[dayIdx] = {
      id: `adaptive-lift-${dayLabels[dayIdx].toLowerCase()}`,
      day: dayLabels[dayIdx],
      type: 'strength',
      // H1: neutral strength framing (no "injury-prevention-only" wording).
      title: planSchema.STRENGTH_MAINTAIN_TITLE,
      distance_miles: 0,
    };
  }

  return sessions;
}

function parsePreferredDays(raw) {
  const dayIndex = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [...new Set(values
    .map((day) => dayIndex[String(day || '').slice(0, 3).toLowerCase()])
    .filter((idx) => idx !== undefined))];
}

function normalizeAdaptivePreferences(input = {}) {
  const runDays = Number(input.run_days_per_week);
  const preferred = parsePreferredDays(input.preferred_run_days);
  return {
    run_days_per_week: Number.isFinite(runDays) ? clamp(runDays, 2, 6) : null,
    preferred_run_days: preferred.length ? preferred.map((idx) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx]) : null,
  };
}

function getAdaptiveWeek(user, recentRuns, recentLifts, checkins, activeInjuries, healthRow = null) {
  const avgFeeling = checkins.length
    ? checkins.reduce((s, c) => s + Number(c.feeling || 3), 0) / checkins.length
    : 3;
  const avgSleep = checkins.length
    ? checkins.reduce((s, c) => s + Number(c.sleep_hours || 7), 0) / checkins.length
    : 7;
  const hasInjury = activeInjuries.length > 0;
  const recentVolume = recentRuns.length;

  let intensity = 'normal';
  if (avgFeeling < 2.5 || avgSleep < 6) intensity = 'reduced';
  if (avgFeeling >= 4 && avgSleep >= 7.5 && recentVolume < 3) intensity = 'increased';
  if (hasInjury) intensity = 'recovery';

  const healthSignals = buildHealthSignals(healthRow || {});
  if (!hasInjury && healthSignals.available) {
    if (healthSignals.shouldRest) intensity = 'recovery';
    else if (healthSignals.shouldReduceIntensity && intensity !== 'recovery') intensity = 'reduced';
    else if (healthSignals.recoveryState === 'strong' && intensity === 'normal' && recentVolume < 3) intensity = 'increased';
  }

  const lowSleepNights = checkins.filter((c) => Number(c.sleep_hours || 7) < 6).length;
  const lowFeelingDays = checkins.filter((c) => Number(c.feeling || 3) <= 2).length;
  const lifeFlags = checkins.flatMap((c) => parseLifeFlags(c.life_flags));
  const uniqueFlags = [...new Set(lifeFlags)];
  const flagsLabel = uniqueFlags.slice(0, 2).join(', ');

  let reason = 'Balanced check-ins and load support a normal week.';
  let recommendation = 'Keep consistency and execute this week as planned.';
  if (intensity === 'recovery') {
    reason = `Active injury logged — shifting to recovery week with lighter work.`;
    recommendation = 'Protect recovery and avoid intensity until pain settles.';
    if (!hasInjury && healthSignals.shouldRest) {
      reason = `${healthSignals.summary} Shifting this week to recovery even without an injury log.`;
      recommendation = 'Prioritize mobility, easy aerobic work, and one fewer hard session.';
    }
  } else if (intensity === 'reduced') {
    reason = `${lowSleepNights || lowFeelingDays} recovery signal(s) detected${flagsLabel ? ` (${flagsLabel})` : ''} — lighter week recommended.`;
    recommendation = "You've had low readiness markers, so this week reduces stress.";
    if (healthSignals.shouldReduceIntensity) {
      reason = `${healthSignals.summary} Lighter week recommended.`;
      recommendation = "Apple Health is showing recovery stress, so this week backs off intensity.";
    }
  } else if (intensity === 'increased') {
    reason = "You've been sleeping well and feeling great with room to build load.";
    recommendation = "You're ready for a controlled mileage bump this week.";
    if (healthSignals.recoveryState === 'strong') {
      reason = `${healthSignals.summary} You have room for a controlled mileage bump.`;
    }
  }

  return {
    intensity,
    recommendation,
    sessions: generateSessions(intensity, user),
    reason,
    stats: {
      avgFeeling: Math.round(avgFeeling * 10) / 10,
      avgSleep: Math.round(avgSleep * 10) / 10,
      recentRuns: recentRuns.length,
      recentLifts: recentLifts.length,
      activeInjuries: activeInjuries.length,
      health: healthSignals,
    },
    healthSignals,
  };
}

async function buildAdaptiveRecommendation(userId, preferences = {}) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const startDate = start.toISOString().slice(0, 10);

  const [user, checkins, activeInjuries, recentRuns, recentLifts, healthRow] = await Promise.all([
    dbGet('SELECT id, goal_type, goal_race_date, run_days_per_week, lift_days_per_week FROM users WHERE id=?', [userId]),
    dbAll(
      'SELECT feeling, sleep_hours, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date >= ? ORDER BY checkin_date DESC LIMIT 7',
      [userId, startDate]
    ),
    dbAll('SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC', [userId]),
    dbAll(`SELECT id, date FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date DESC`, [userId, startDate]),
    dbAll(
      "SELECT id, started_at, ended_at FROM workout_sessions WHERE user_id=? AND started_at >= ? AND ended_at IS NOT NULL ORDER BY started_at DESC",
      [userId, `${startDate}T00:00:00`]
    ),
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/adaptive] health sync lookup failed:', err.message);
      return null;
    }),
  ]);

  if (!user) return null;
  const normalizedPreferences = normalizeAdaptivePreferences(preferences);
  return getAdaptiveWeek({
    ...user,
    run_days_per_week: normalizedPreferences.run_days_per_week || user.run_days_per_week,
    preferred_run_days: normalizedPreferences.preferred_run_days,
  }, recentRuns || [], recentLifts || [], checkins || [], activeInjuries || [], healthRow);
}

router.get('/', auth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT id, name, type, weeks, description, plan_data, created_at
      FROM training_plans
      WHERE user_id IS NULL AND plan_data IS NOT NULL
      ORDER BY created_at ASC
    `);
    const plans = rows.map((row) => ({ ...row, plan_data: parsePlan(row) || { weeks: [] } }));
    res.json({ plans });
  } catch (err) {
    console.error('[plans/list] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

router.get('/adaptive/recommend', auth, async (req, res) => {
  try {
    const adaptive = await buildAdaptiveRecommendation(req.user.id, req.query || {});
    if (!adaptive) return res.status(404).json({ error: 'User not found' });
    res.json(adaptive);
  } catch (err) {
    console.error('[plans/adaptive/recommend] failed:', err.message);
    res.status(500).json({ error: 'Failed to build adaptive recommendation' });
  }
});

function publicProposal(proposal) {
  if (!proposal) return null;
  const { proposedPlan, plan, ...rest } = proposal;
  return rest;
}

function completedSessionIdsFromProgress(progress) {
  return Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds.map(String) : [];
}

async function hybridCompletionEvidence(userId, startISO, endISO, timezone, db = null) {
  const all = db?.all || dbAll;
  const workoutQueryStart = hybridReconciliation.addDays(startISO, -1);
  const workoutQueryEnd = hybridReconciliation.addDays(endISO, 1);
  const [runs, lifts, workouts] = await Promise.all([
    all(`SELECT id, date FROM runs WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}`, [userId, startISO, endISO]),
    all('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<=?', [userId, startISO, endISO]),
    all(
      'SELECT id, started_at FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<=? AND ended_at IS NOT NULL',
      [userId, `${workoutQueryStart}T00:00:00Z`, `${workoutQueryEnd}T23:59:59Z`]
    ),
  ]);
  return {
    runDates: (runs || []).map((row) => String(row.date || '').slice(0, 10)).filter(Boolean),
    liftDates: [
      ...(lifts || []).map((row) => String(row.date || '').slice(0, 10)),
      ...(workouts || []).map((row) => dateInTimezone(row.started_at, timezone)),
    ].filter((date) => date && date >= startISO && date <= endISO),
  };
}

router.get('/reconciliation/current', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    const localHour = Number(req.query?.hour ?? new Date().getHours());
    const timezone = String(req.query?.timezone || 'UTC').trim();
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });
    if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) {
      return res.status(400).json({ error: 'hour must be a whole number from 0 through 23' });
    }
    if (!isIanaTimezone(timezone)) return res.status(400).json({ error: 'timezone must be a valid IANA timezone' });

    const active = await getActivePlanForUser(req.user.id);
    if (!active || !active.row?.user_plan_id) {
      return res.json({ reconciliation: null, reason: 'No assigned hybrid plan is active.' });
    }
    const parsed = parsePlan(active.row);
    if (!parsed || !planSchema.isSchemaV2(parsed)) {
      return res.json({ reconciliation: null, reason: 'Hybrid reconciliation requires a dated plan.' });
    }

    const progress = parseJsonValue(active.row.progress_json, {});
    const startISO = hybridReconciliation.addDays(planningDateISO, -hybridReconciliation.LOOKBACK_DAYS);
    const evidence = await hybridCompletionEvidence(req.user.id, startISO, planningDateISO, timezone);
    const reconciliation = hybridReconciliation.buildCurrentPrompt({
      plan: parsed,
      planningDateISO,
      localHour,
      completedSessionIds: completedSessionIdsFromProgress(progress),
      reconciliations: progress.hybridSessionReconciliations,
      runDates: evidence.runDates,
      liftDates: evidence.liftDates,
    });

    res.json({
      reconciliation: reconciliation ? {
        ...reconciliation,
        choices: ['completed_untracked', 'later', 'life_event', 'skipped'],
      } : null,
    });
  } catch (err) {
    console.error('[plans/reconciliation/current] failed:', err.message);
    res.status(500).json({ error: 'Failed to check the hybrid session' });
  }
});

router.post('/reconciliation/respond', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const sessionDate = String(body.session_date || '').slice(0, 10);
    const liftSessionId = String(body.lift_session_id || '').trim();
    const response = String(body.response || '').trim();
    const timezone = String(body.timezone || 'UTC').trim();
    const planningDateISO = getPlanningDateFromRequest({ query: { date: body.current_date } });
    const age = hybridReconciliation.daysBetween(planningDateISO, sessionDate);
    if (!planningDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || age === null || age < 0 || age > hybridReconciliation.LOOKBACK_DAYS) {
      return res.status(400).json({ error: 'Invalid hybrid session date' });
    }
    if (!liftSessionId || liftSessionId.length > 128) return res.status(400).json({ error: 'Invalid lift session' });
    if (!hybridReconciliation.VALID_RESPONSES.has(response)) return res.status(400).json({ error: 'Invalid reconciliation choice' });
    if (!isIanaTimezone(timezone)) return res.status(400).json({ error: 'Invalid timezone' });

    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const row = await tx.get(`
        SELECT up.id AS user_plan_id, up.progress_json, up.current_week, up.started_at, up.status,
               tp.*
        FROM user_plans up
        JOIN training_plans tp ON tp.id = up.plan_id
        WHERE up.user_id=? AND up.status='active'
        ORDER BY up.created_at DESC
        LIMIT 1
        FOR UPDATE OF up
      `, [req.user.id]);
      if (!row) return planningInputUnchanged({ notFound: true });

      const active = { source: 'assigned', row };
      const parsed = parsePlan(row);
      if (!parsed || !planSchema.isSchemaV2(parsed)) {
        return planningInputUnchanged({ conflict: 'Hybrid reconciliation requires a dated plan.' });
      }
      const progress = parseJsonValue(row.progress_json, {});
      const records = progress.hybridSessionReconciliations && typeof progress.hybridSessionReconciliations === 'object'
        ? { ...progress.hybridSessionReconciliations }
        : {};
      const key = hybridReconciliation.reconciliationKey(sessionDate, liftSessionId);
      const existing = records[key];
      if (existing && existing.response === response && (existing.response !== 'later' || existing.respondedDate === planningDateISO)) {
        return planningInputUnchanged({
          ok: true,
          idempotent: true,
          message: existing.message || 'That hybrid session is already reconciled.',
          adjustment: existing.adjustment || null,
          pattern: hybridReconciliation.patternSummary(records, planningDateISO),
        });
      }
      if (existing && existing.response !== 'later' && existing.response !== response) {
        return planningInputUnchanged({ conflict: 'That hybrid session has already been reconciled.' });
      }

      const candidates = hybridReconciliation.hybridCandidates(parsed, sessionDate, planningDateISO);
      const candidate = candidates.find((item) => item.liftSessionId === liftSessionId) || null;
      if (!candidate) {
        return planningInputUnchanged({ conflict: 'The planned hybrid session changed. Refresh Today and try again.' });
      }
      const completed = new Set(completedSessionIdsFromProgress(progress));
      const evidence = await hybridCompletionEvidence(req.user.id, sessionDate, planningDateISO, timezone, tx);
      const liftAllocation = hybridReconciliation.allocateSessionEvidence({
        sessions: candidates.map((item) => ({
          key: item.key,
          date: item.date,
          sessionId: item.liftSessionId,
          kind: 'lift',
        })),
        completedSessionIds: Array.from(completed),
        reconciliations: records,
        evidence: evidence.liftDates.map((date) => ({ date, kind: 'lift' })),
        allowNextDayForLater: true,
      });
      const runDetected = candidate.runSessionIds.some((id) => completed.has(id)) || evidence.runDates.includes(sessionDate);
      const liftDetected = liftAllocation.completedKeys.has(candidate.key);
      if (!runDetected) {
        return planningInputUnchanged({ conflict: 'The paired run is not recorded yet. Sync again before reconciling this session.' });
      }
      if (liftDetected) return planningInputUnchanged({ alreadyComplete: true });

      let adjustment = null;
      let message = '';
      if (response === 'completed_untracked') {
        completed.add(liftSessionId);
        message = 'Strength session marked complete without inventing workout metrics.';
      } else if (response === 'later') {
        message = 'Got it. We will check again tomorrow only if the strength session is still missing.';
      } else {
        const moved = hybridReconciliation.moveLiftToNextAvailableRestDay(parsed, candidate, planningDateISO);
        if (moved.adjusted) {
          await updateActivePlanData(active, req.user.id, moved.plan, tx);
          adjustment = { adjusted: true, movedFrom: moved.movedFrom, movedTo: moved.movedTo };
          message = `Strength moved from ${moved.movedFrom} to ${moved.movedTo}. This is a schedule signal, not a failure.`;
        } else {
          adjustment = { adjusted: false, reason: moved.reason };
          message = 'Noted. No make-up session was forced into the week, so recovery space stays protected.';
        }
      }

      records[key] = {
        sessionDate,
        runSessionIds: candidate.runSessionIds,
        liftSessionId,
        response,
        respondedAt: new Date().toISOString(),
        respondedDate: planningDateISO,
        adjustment,
        message,
      };
      const update = await tx.run(
        'UPDATE user_plans SET progress_json=? WHERE id=? AND user_id=?',
        [JSON.stringify({
          ...progress,
          completedSessionIds: Array.from(completed),
          hybridSessionReconciliations: records,
        }), row.user_plan_id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Hybrid reconciliation progress update failed');

      return {
        ok: true,
        message,
        adjustment,
        pattern: hybridReconciliation.patternSummary(records, planningDateISO),
      };
    });

    if (result.notFound) return res.status(404).json({ error: 'No active plan is assigned.' });
    if (result.conflict) return res.status(409).json({ error: result.conflict });
    if (result.alreadyComplete) return res.json({ ok: true, message: 'The strength session is already recorded.', alreadyComplete: true });
    res.json(result);
  } catch (err) {
    console.error('[plans/reconciliation/respond] failed:', err.message);
    res.status(500).json({ error: 'Failed to reconcile the hybrid session' });
  }
});

router.get('/adaptation/current', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ proposal: null, reason: 'No active plan is assigned yet.' });
    const parsed = parsePlan(active.row);
    if (!parsed || !planSchema.isSchemaV2(parsed)) {
      return res.json({ proposal: null, reason: 'Transparent adaptation is available for schema-v2 dated calendars only.' });
    }

    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });
    const planVersion = planVersionFor(active, parsed);
    const existing = await findLatestAdaptation(req.user.id, planningDateISO, planVersion);
    if (existing) {
      const existingProposal = proposalFromRow(existing);
      if (existing.status !== 'pending' || existingProposal.changes.length === 0) {
        return res.json({ proposal: null, reason: 'Today\'s calendar check is complete.' });
      }
      return res.json({ proposal: publicProposal(existingProposal) });
    }

    const inputs = await buildAdaptationInputs(req.user.id, parsed, active, planningDateISO);
    const runGapEpisodeKey = inputs.completion?.lastRunDate
      ? `run-gap:${inputs.completion.lastRunDate}`
      : null;
    inputs.completion = { ...(inputs.completion || {}), runGapEpisodeKey };
    const [completionDecisionExists, runGapEpisode] = await Promise.all([
      hasDecidedCompletionAdaptation(req.user.id, planningDateISO),
      findRunGapEpisode(req.user.id, runGapEpisodeKey),
    ]);
    if (runGapEpisode?.status === 'pending') {
      const pendingProposal = proposalFromRow(runGapEpisode);
      if (pendingProposal.changes.length > 0) {
        return res.json({ proposal: publicProposal(pendingProposal) });
      }
    }
    if (completionDecisionExists || runGapEpisode) {
      inputs.completion = {
        ...(inputs.completion || {}),
        adaptationEnabled: false,
        gapPromptEnabled: false,
      };
    }
    const proposal = adaptationEngine.buildAdaptationProposal({
      plan: parsed,
      planningDateISO,
      planVersion,
      healthSignals: inputs.healthSignals,
      checkin: inputs.checkin,
      completion: inputs.completion,
      recentRunLoad: inputs.recentRunLoad,
      injuryState: inputs.injuryState,
    });
    if (proposal.status !== 'proposal' || !Array.isArray(proposal.changes) || proposal.changes.length === 0) {
      return res.json({ proposal: null, reason: proposal.reason });
    }
    const persisted = await persistAdaptationProposal(req.user.id, active, planVersion, parsed, proposal);
    res.json({ proposal: publicProposal(persisted) });
  } catch (err) {
    console.error('[plans/adaptation/current] failed:', err.message);
    res.status(500).json({ error: 'Failed to compute transparent adaptation' });
  }
});

router.get('/adaptation/run/:runId', auth, async (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId || runId.length > 128) return res.status(400).json({ error: 'runId is invalid' });
    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });

    const run = await dbGet(
      `SELECT id, date, type, distance_miles, duration_seconds, perceived_effort,
              avg_heart_rate, pain_level, post_energy, pace_avg, health_source,
              created_at, heart_rate_zones, workout_metrics_json, watch_mode,
              notes, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE id=? AND user_id=? AND ${runActivitySql()}`,
      [runId, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const existing = await findRunAdaptation(req.user.id, run.id);
    if (existing && (existing.status === 'accepted' || existing.status === 'kept')) {
      return res.json({ impact: publicProposal(proposalFromRow(existing)) });
    }

    const active = await getActivePlanForUser(req.user.id);
    if (!active) {
      return res.json({
        impact: {
          status: 'keep',
          decisionStatus: 'reviewed',
          triggerRunId: run.id,
          planningDate: planningDateISO,
          changes: [],
          evidence: [{ source: 'run', runId: run.id, date: run.date }],
          headline: 'Run reviewed',
          reason: 'This run is saved, but there is no active plan to adjust.',
        },
      });
    }
    const parsed = parsePlan(active.row);
    if (!parsed || !planSchema.isSchemaV2(parsed)) {
      return res.json({
        impact: {
          status: 'keep',
          decisionStatus: 'reviewed',
          triggerRunId: run.id,
          planningDate: planningDateISO,
          changes: [],
          evidence: [{ source: 'run', runId: run.id, date: run.date }],
          headline: 'Run reviewed',
          reason: 'This run is saved. Plan impact is available for dated calendars.',
        },
      });
    }

    const planVersion = planVersionFor(active, parsed);
    const inputs = await buildAdaptationInputs(req.user.id, parsed, active, planningDateISO, { focusRunId: run.id });
    const proposal = adaptationEngine.buildAdaptationProposal({
      plan: parsed,
      planningDateISO,
      planVersion,
      healthSignals: { available: false },
      checkin: null,
      completion: {},
      recentRunLoad: inputs.recentRunLoad,
      injuryState: { active: false, openInjuries: [] },
    });
    const runDistance = Number(run.distance_miles || 0);
    const runDurationMinutes = Math.round(Number(run.duration_seconds || 0) / 60);
    proposal.evidence = [{
      signal: 'viewed run',
      source: 'run',
      runId: run.id,
      date: run.date,
      objective: true,
      freshness: run.date === planningDateISO ? 'today' : run.date,
      detail: [
        runDistance > 0 ? `${runDistance.toFixed(2)} mi` : null,
        runDurationMinutes > 0 ? `${runDurationMinutes} min` : null,
        Number(run.avg_heart_rate || 0) > 0 ? `avg HR ${Math.round(Number(run.avg_heart_rate))}` : null,
      ].filter(Boolean).join(', ') || 'Saved run',
    }, ...(Array.isArray(proposal.evidence) ? proposal.evidence : [])];
    const runAgeDays = daysBetween(planningDateISO, run.date);
    if (runAgeDays !== null && runAgeDays > 34) {
      proposal.changes = [];
      proposal.proposedPlan = parsed;
      proposal.safetyException = false;
      proposal.headline = 'Historical run reviewed';
      proposal.reason = 'This run remains part of your training history, but it is too old to change the current 72-hour plan.';
    } else if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
      proposal.headline = 'Plan stays as written';
      proposal.reason = 'This run is included in your training load and does not require changing the next 72 hours.';
    }
    const persisted = await persistRunAdaptation(req.user.id, run, active, planVersion, parsed, proposal);
    res.json({ impact: publicProposal(persisted) });
  } catch (err) {
    console.error('[plans/adaptation/run] failed:', err.message);
    res.status(500).json({ error: 'Failed to compute this run\'s plan impact' });
  }
});

router.post('/adaptation/:proposalId/accept', auth, async (req, res) => {
  try {
    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const row = await tx.get('SELECT * FROM plan_adjustment_proposals WHERE id=? AND user_id=? FOR UPDATE', [req.params.proposalId, req.user.id]);
      if (!row) return planningInputUnchanged({ notFound: true });
      if (row.trigger_run_id) {
        const ownedRun = await tx.get(`SELECT id FROM runs WHERE id=? AND user_id=? AND ${runActivitySql()}`, [row.trigger_run_id, req.user.id]);
        if (!ownedRun) return planningInputUnchanged({ notFound: true });
      }
      if (row.status === 'accepted') {
        return planningInputUnchanged({ ok: true, status: 'accepted', proposal: proposalFromRow(row), idempotent: true });
      }
      if (row.status !== 'pending') {
        return planningInputUnchanged({ conflict: true, reason: 'Proposal is no longer pending.' });
      }

      const active = await getActivePlanForMutation(req.user.id, tx);
      if (!active) return planningInputUnchanged({ conflict: true, reason: 'No active plan is assigned.' });
      const parsed = parsePlan(active.row);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        return planningInputUnchanged({ conflict: true, reason: 'The active plan changed after this proposal was computed.' });
      }

      const proposedPlan = parseJsonValue(row.proposed_json, null);
      if (!proposedPlan || typeof proposedPlan !== 'object') throw new Error('Stored proposed plan JSON is invalid');
      await updateActivePlanData(active, req.user.id, proposedPlan, tx);
      const update = await tx.run(
        "UPDATE plan_adjustment_proposals SET status='accepted', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
        [row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Proposal accept status update failed');
      return { ok: true, status: 'accepted', proposal: proposalFromRow({ ...row, status: 'accepted' }) };
    });

    if (result.notFound) return res.status(404).json({ error: 'Proposal not found' });
    if (result.conflict) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, status: 'accepted', proposal: publicProposal(result.proposal), idempotent: Boolean(result.idempotent) });
  } catch (err) {
    console.error('[plans/adaptation/accept] failed:', err.message);
    res.status(500).json({ error: 'Failed to accept transparent adaptation' });
  }
});

router.post('/adaptation/:proposalId/keep', auth, async (req, res) => {
  try {
    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const row = await tx.get('SELECT * FROM plan_adjustment_proposals WHERE id=? AND user_id=? FOR UPDATE', [req.params.proposalId, req.user.id]);
      if (!row) return planningInputUnchanged({ notFound: true });
      if (row.trigger_run_id) {
        const ownedRun = await tx.get(`SELECT id FROM runs WHERE id=? AND user_id=? AND ${runActivitySql()}`, [row.trigger_run_id, req.user.id]);
        if (!ownedRun) return planningInputUnchanged({ notFound: true });
      }
      if (row.status === 'kept') {
        return planningInputUnchanged({ ok: true, status: 'kept', proposal: proposalFromRow(row), idempotent: true });
      }
      if (row.status !== 'pending') {
        return planningInputUnchanged({ conflict: true, reason: 'Proposal is no longer pending.' });
      }
      const active = await getActivePlanForMutation(req.user.id, tx);
      if (!active) return planningInputUnchanged({ conflict: true, reason: 'No active plan is assigned.' });
      const parsed = parsePlan(active.row);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        return planningInputUnchanged({ conflict: true, reason: 'The active plan changed after this proposal was computed.' });
      }
      const update = await tx.run(
        "UPDATE plan_adjustment_proposals SET status='kept', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
        [row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Proposal keep status update failed');
      return { ok: true, status: 'kept', proposal: proposalFromRow({ ...row, status: 'kept' }) };
    });

    if (result.notFound) return res.status(404).json({ error: 'Proposal not found' });
    if (result.conflict) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, status: 'kept', proposal: publicProposal(result.proposal), idempotent: Boolean(result.idempotent) });
  } catch (err) {
    console.error('[plans/adaptation/keep] failed:', err.message);
    res.status(500).json({ error: 'Failed to keep original plan' });
  }
});

router.get('/prefill', auth, async (req, res) => {
  let fallback = defaultPrefillFromProfile();
  try {
    const profile = await dbGet('SELECT run_days_per_week, lift_days_per_week, preferred_workout_days FROM users WHERE id=?', [req.user.id]);
    fallback = defaultPrefillFromProfile(profile || {});

    const since = new Date();
    since.setDate(since.getDate() - 56);
    const sinceDate = since.toISOString().slice(0, 10);
    const rows = await dbAll(
      `SELECT date FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date ASC`,
      [req.user.id, sinceDate]
    );
    const inferredTrainingDays = [...new Set((rows || [])
      .map((row) => weekdayFromDateString(row.date))
      .filter(Boolean))];

    res.json({
      ...fallback,
      inferredTrainingDays: fallback.inferredTrainingDays.length
        ? fallback.inferredTrainingDays
        : inferredTrainingDays,
    });
  } catch (err) {
    console.error('[plans/prefill] failed soft:', err.message);
    res.json(fallback);
  }
});

router.post('/adaptive/accept', auth, async (req, res) => {
  try {
    const adaptive = await buildAdaptiveRecommendation(req.user.id, req.body || {});
    if (!adaptive) return res.status(404).json({ error: 'User not found' });

    const weekStart = getMonday();
    const planId = uuidv4();
    const userPlanId = uuidv4();
    const planData = { weeks: [{ week: 1, sessions: adaptive.sessions }] };
    const intensityLabel = adaptive.intensity.charAt(0).toUpperCase() + adaptive.intensity.slice(1);
    const planName = `Adaptive Week - ${weekStart}`;

    await withPlanningInputMutation(req.user.id, async (tx) => {
      await tx.run("UPDATE user_plans SET status = 'inactive' WHERE user_id = ? AND status = 'active'", [req.user.id]);
      await tx.run(
        `INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          req.user.id,
          weekStart,
          JSON.stringify(planData),
          planName,
          'Adaptive',
          1,
          `${intensityLabel} intensity recommendation for this week.`,
          JSON.stringify(planData),
        ]
      );
      await tx.run(
        `INSERT INTO user_plans (
           id, user_id, plan_id, started_at, current_week, status, progress_json,
           plan_version, lineage_id, effective_from
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          userPlanId,
          req.user.id,
          planId,
          weekStart,
          1,
          'active',
          JSON.stringify({ completedSessionIds: [] }),
          1,
          userPlanId,
          weekStart,
        ]
      );
    });

    res.status(201).json({ ok: true, user_plan_id: userPlanId, plan_id: planId, ...adaptive });
  } catch (err) {
    console.error('[plans/adaptive/accept] failed:', err.message);
    res.status(500).json({ error: 'Failed to accept adaptive plan' });
  }
});

router.post('/assign/:planId', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE id = ? AND user_id IS NULL', [req.params.planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const id = uuidv4();
    await withPlanningInputMutation(req.user.id, async (tx) => {
      await tx.run("UPDATE user_plans SET status = 'inactive' WHERE user_id = ? AND status = 'active'", [req.user.id]);
      await tx.run(
        `INSERT INTO user_plans (
           id, user_id, plan_id, started_at, current_week, status, progress_json,
           plan_version, lineage_id, effective_from
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          req.user.id,
          plan.id,
          new Date().toISOString().slice(0, 10),
          1,
          'active',
          JSON.stringify({ completedSessionIds: [] }),
          1,
          id,
          new Date().toISOString().slice(0, 10),
        ]
      );
    });
    res.status(201).json({ ok: true, assignment_id: id });
  } catch (err) {
    console.error('[plans/assign] failed:', err.message);
    res.status(500).json({ error: 'Failed to assign plan' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const row = await dbGet(`
      SELECT up.*, tp.name, tp.type, tp.weeks, tp.description, tp.plan_data
      FROM user_plans up
      JOIN training_plans tp ON tp.id = up.plan_id
      WHERE up.user_id = ? AND up.status = 'active'
      ORDER BY up.created_at DESC
      LIMIT 1
    `, [req.user.id]);

    if (!row) {
      const legacy = await dbGet(
        'SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [req.user.id]
      );
      if (!legacy) return res.json({ plan: null });
      const servedLegacyPlan = await buildAdaptivePlanView(req.user.id, parsePlan(legacy) || { weeks: [] }, 1);
      const legacyPlan = withDurationEstimatePlanPayload(servedLegacyPlan);
      const anchorPayload = planAnchorPayload(legacyPlan);
      return res.json({
        source: 'legacy',
        plan: {
          id: legacy.id,
          name: legacy.name,
          type: legacy.type,
          weeks: Number(legacy.weeks || legacyPlan.weeks?.length || 1),
          description: legacy.description,
          ...anchorPayload,
          plan_data: legacyPlan,
        },
        user_plan: null,
      });
    }
    let progress = {};
    try {
      progress = JSON.parse(row.progress_json || '{}');
    } catch (err) {
      console.error('[plans/my] invalid progress JSON:', err.message);
    }
    const servedPlan = await buildAdaptivePlanView(req.user.id, parsePlan(row) || { weeks: [] }, Number(row.current_week || 1));
    const parsedPlan = withDurationEstimatePlanPayload(servedPlan);
    const anchorPayload = planAnchorPayload(parsedPlan);
    res.json({
      plan: {
        id: row.plan_id,
        name: row.name,
        type: row.type,
        weeks: row.weeks,
        description: row.description,
        ...anchorPayload,
        plan_data: parsedPlan,
      },
      user_plan: {
        id: row.id,
        started_at: row.started_at,
        current_week: Number(row.current_week || 1),
        status: row.status,
        progress,
      },
    });
  } catch (err) {
    console.error('[plans/my] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch user plan' });
  }
});

router.put('/my/race-link', auth, async (req, res) => {
  try {
    const raceId = String(req.body?.race_id || '').trim();
    if (!raceId || raceId.length > 128) return res.status(400).json({ error: 'race_id is required' });

    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]);
      if (!race) return planningInputUnchanged({ status: 404, error: 'Race not found' });
      const active = await getActivePlanForMutation(req.user.id, tx);
      if (!active) return planningInputUnchanged({ status: 404, error: 'Active plan not found' });
      const parsed = parsePlan(active.row);
      if (!parsed) return planningInputUnchanged({ status: 409, error: 'Active plan could not be read' });

      const normalizeName = (value) => String(value || '').trim().toLowerCase();
      const sameIdentity = (goal = {}) => {
        const goalName = goal.name || parsed.raceName || parsed.race_name;
        const goalDate = goal.date || goal.raceDate || parsed.raceDate || parsed.race_date;
        const goalDistance = Number(goal.distanceMiles || goal.distance_miles || parsed.distanceMiles || parsed.distance_miles || 0);
        return normalizeName(goalName) === normalizeName(race.race_name)
          && String(goalDate || '') === String(race.race_date || '')
          && (!goalDistance || Math.abs(goalDistance - Number(race.distance_miles || 0)) < 0.01);
      };
      const storedGoals = Array.isArray(parsed.goals) && parsed.goals.length
        ? parsed.goals
        : [parsed.goal || {}];
      let matchIndex = storedGoals.findIndex((goal) => goalRaceId(goal) === raceId);
      if (matchIndex < 0 && storedGoals.length === 1 && !goalRaceId(storedGoals[0]) && sameIdentity(storedGoals[0])) {
        matchIndex = 0;
      }
      if (matchIndex < 0) {
        return planningInputUnchanged({ status: 409, error: 'Race is not linked to the active plan' });
      }

      const snapshot = raceTargetSnapshot(race);
      const nextGoals = storedGoals.map((goal, index) => {
        if (index !== matchIndex) return goal;
        const existingTarget = goal.raceTarget || goal.race_target || null;
        return {
          ...goal,
          raceId: race.id,
          raceTarget: completeRaceTargetSnapshot(existingTarget, raceId) ? existingTarget : snapshot,
        };
      });
      const finalStoredGoal = parsed.goal || {};
      const finalMatches = goalRaceId(finalStoredGoal) === raceId
        || (storedGoals.length === 1 && matchIndex === 0 && sameIdentity(finalStoredGoal));
      const finalTarget = finalStoredGoal.raceTarget || finalStoredGoal.race_target || null;
      const nextGoal = finalMatches
        ? {
          ...finalStoredGoal,
          raceId: race.id,
          raceTarget: completeRaceTargetSnapshot(finalTarget, raceId) ? finalTarget : snapshot,
        }
        : finalStoredGoal;
      const nextPlan = {
        ...parsed,
        goal: nextGoal,
        ...(Array.isArray(parsed.goals) && parsed.goals.length ? { goals: nextGoals } : {}),
      };
      await updateActivePlanData(active, req.user.id, nextPlan, tx);
      return { status: 200, planData: nextPlan };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, plan_data: result.planData });
  } catch (err) {
    console.error('[plans/my/race-link] failed:', err.message);
    res.status(500).json({ error: 'Could not link this race to the active plan' });
  }
});

router.put('/my/progress', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const hasCurrentWeek = Object.prototype.hasOwnProperty.call(body, 'current_week');
    const completedId = body.completed_session_id === null || body.completed_session_id === undefined
      ? null
      : String(body.completed_session_id).trim();
    const unsetId = body.unset_session_id === null || body.unset_session_id === undefined
      ? null
      : String(body.unset_session_id).trim();
    if (completedId && unsetId) return res.status(400).json({ error: 'Choose one session progress action' });
    if ((completedId && completedId.length > 128) || (unsetId && unsetId.length > 128)) {
      return res.status(400).json({ error: 'Invalid plan session' });
    }

    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const findAssigned = () => tx.get(`
        SELECT up.id, up.progress_json, up.current_week,
               tp.weeks, tp.plan_data, tp.plan_json
        FROM user_plans up
        JOIN training_plans tp ON tp.id = up.plan_id
        WHERE up.user_id = ? AND up.status = 'active'
        ORDER BY up.created_at DESC
        LIMIT 1
        FOR UPDATE OF up
      `, [req.user.id]);
      let row = await findAssigned();
      let legacyPlanId = null;
      if (!row) {
        const legacy = await tx.get(`
          SELECT tp.id AS legacy_plan_id, tp.week_start,
                 tp.weeks, tp.plan_data, tp.plan_json
          FROM training_plans tp
          WHERE tp.user_id = ?
          ORDER BY tp.created_at DESC
          LIMIT 1
          FOR UPDATE OF tp
        `, [req.user.id]);
        if (!legacy) return planningInputUnchanged({ notFound: true });

        // The legacy-row lock serializes first completion. Recheck so a
        // concurrent request can reuse the assignment created while waiting.
        row = await findAssigned();
        if (!row) {
          legacyPlanId = legacy.legacy_plan_id;
          row = {
            ...legacy,
            id: uuidv4(),
            current_week: 1,
            progress_json: JSON.stringify({ completedSessionIds: [] }),
          };
        }
      }

      const parsed = parsePlan(row);
      const sessionIds = dailyExecution.collectSessionIds(parsed);
      const requestedId = completedId || unsetId;
      if (requestedId && !sessionIds.has(requestedId)) return planningInputUnchanged({ invalidSession: true });

      const rawWeekCount = Number(parsed?.weeks?.length || row.weeks || 1);
      const maxWeek = Number.isInteger(rawWeekCount) && rawWeekCount >= 1 ? rawWeekCount : 1;
      let nextWeek = Number(row.current_week || 1);
      if (hasCurrentWeek) {
        const requestedWeek = Number(body.current_week);
        if (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > maxWeek) {
          return planningInputUnchanged({ invalidWeek: true });
        }
        nextWeek = requestedWeek;
      }

      let progress = {};
      try {
        progress = typeof row.progress_json === 'string'
          ? JSON.parse(row.progress_json || '{}')
          : (row.progress_json || {});
      } catch (err) {
        console.error('[plans/my/progress] invalid progress JSON:', err.message);
        progress = {};
      }
      const completed = new Set(Array.isArray(progress.completedSessionIds) ? progress.completedSessionIds.map(String) : []);
      if (completedId) completed.add(completedId);
      if (unsetId) completed.delete(unsetId);

      const previousCompleted = new Set(Array.isArray(progress.completedSessionIds)
        ? progress.completedSessionIds.map(String)
        : []);
      const progressChanged = previousCompleted.size !== completed.size
        || Array.from(previousCompleted).some((id) => !completed.has(id));
      const weekChanged = nextWeek !== Number(row.current_week || 1);
      if (!legacyPlanId && !progressChanged && !weekChanged) {
        return planningInputUnchanged({
          ok: true,
          current_week: nextWeek,
          completedSessionIds: Array.from(completed),
          idempotent: true,
        });
      }

      if (legacyPlanId) {
        const insert = await tx.run(
          `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
           VALUES (?,?,?,?,?,?,?)`,
          [row.id, req.user.id, legacyPlanId, row.week_start || getTodayISO(), 1, 'active', JSON.stringify({ completedSessionIds: [] })]
        );
        if (insert.changes === 0) throw new Error('Legacy plan assignment migration failed');
      }

      const update = await tx.run(
        'UPDATE user_plans SET current_week = ?, progress_json = ? WHERE id = ? AND user_id = ?',
        [nextWeek, JSON.stringify({ ...progress, completedSessionIds: Array.from(completed) }), row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Active plan progress update failed');
      return { ok: true, current_week: nextWeek, completedSessionIds: Array.from(completed) };
    });

    if (result.notFound) return res.status(404).json({ error: 'No assigned plan' });
    if (result.invalidSession) return res.status(400).json({ error: 'Invalid plan session' });
    if (result.invalidWeek) return res.status(400).json({ error: 'Invalid plan week' });
    res.json(result);
  } catch (err) {
    console.error('[plans/my/progress] failed:', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.post('/today/bodyweight-alternative', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const dateISO = normalizePlanningDate(body.date);
    if (!dateISO) {
      return res.status(400).json({ error: 'date must be the phone-local date in YYYY-MM-DD format' });
    }
    if (typeof body.session_id !== 'string') {
      return res.status(400).json({ error: 'session_id must be a non-empty string' });
    }
    const sessionId = body.session_id.trim();
    if (!sessionId || sessionId.length > 128) {
      return res.status(400).json({ error: 'session_id must be a non-empty string of at most 128 characters' });
    }

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.status(404).json({ error: 'Active plan not found' });
    const parsed = parsePlan(active.row);
    if (!parsed) return res.status(409).json({ error: 'Active plan could not be read' });

    const weekdayShort = dailyExecution.weekdayShortForDate(dateISO);
    const selection = dailyExecution.selectDayForDate(parsed, dateISO, weekdayShort);
    if (!selection || String(selection.entry?.date || '') !== dateISO) {
      return res.status(404).json({ error: 'Scheduled lift session not found for this date' });
    }

    const entry = selection.entry;
    const storedSessions = Array.isArray(entry.sessions)
      ? entry.sessions
      : planSchema.isRestEntry(entry) ? [] : [entry];
    let exactSession = null;
    let exactKind = null;
    for (let index = 0; index < storedSessions.length; index += 1) {
      const stored = storedSessions[index];
      const stableId = planSchema.sessionIdentifier(entry, stored, index, selection.dayIndex);
      if (stableId !== sessionId) continue;
      exactKind = planSchema.kindFromSession(stored);
      exactSession = { ...planSchema.normalizeSession(stored, stableId), id: stableId };
      break;
    }
    if (!exactSession) {
      return res.status(404).json({ error: 'Scheduled lift session not found for this date' });
    }
    if (exactKind !== 'lift') {
      return res.status(409).json({ error: 'The requested plan session is not a lift' });
    }

    const progress = parseJsonValue(active.row.progress_json, {});
    const completedIds = new Set(completedSessionIdsFromProgress(progress).map(String));
    const storedStatus = String(
      storedSessions.find((stored, index) => (
        planSchema.sessionIdentifier(entry, stored, index, selection.dayIndex) === sessionId
      ))?.status || ''
    ).toLowerCase();
    if (
      completedIds.has(sessionId)
      || storedSessions.some((stored, index) => (
        planSchema.sessionIdentifier(entry, stored, index, selection.dayIndex) === sessionId
        && stored?.completed === true
      ))
      || storedStatus === 'completed'
      || String(entry.status || '').toLowerCase() === 'completed'
    ) {
      return res.status(409).json({ error: 'This lift session is already completed' });
    }

    const alternative = buildBodyweightAlternative({
      session: exactSession,
      sessionId,
      date: dateISO,
      week: selection.week?.week ?? selection.weekIndex + 1,
      phase: selection.week?.phase || null,
    });
    if (!alternative) {
      return res.status(409).json({ error: 'This lift could not be translated safely for no-equipment training' });
    }
    return res.json({ alternative });
  } catch (err) {
    console.error('[plans/today/bodyweight-alternative] failed:', err.message);
    return res.status(500).json({ error: 'Could not build the no-equipment alternative' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    // H5: accept a phone-local date (+/-1 day safety, same rule as H4).
    const dateISO = getPlanningDateFromRequest(req);
    if (dateISO === null) return res.status(400).json({ error: 'Invalid date' });

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ today: null, execution: { hasPlan: false, hasDay: false, date: dateISO } });
    const parsed = withDurationEstimatePlanPayload(parsePlan(active.row));
    const anchorPayload = planAnchorPayload(parsed);

    // H5: select the EXACT dated schema-v2 day (legacy plans fall back to a
    // weekday match among undated days only). Replaces the old first-weekday
    // scan that could return week 1's Tuesday regardless of the current week.
    const weekdayShort = dailyExecution.weekdayShortForDate(dateISO);
    const selection = dailyExecution.selectDayForDate(parsed, dateISO, weekdayShort);
    const selectedEntry = selection ? selection.entry : null;
    const selectedWeek = selection ? selection.week : null;
    const selectedDayIndex = selection ? selection.dayIndex : null;

    const override = await dbGet(
      'SELECT patch_json FROM checkin_overrides WHERE user_id=? AND date=?',
      [req.user.id, dateISO]
    );
    let patch = null;
    if (override?.patch_json) {
      try {
        patch = typeof override.patch_json === 'string' ? JSON.parse(override.patch_json) : override.patch_json;
      } catch (err) {
        console.error('[plans] Failed to parse check-in override patch:', err);
      }
    }

    // Legacy `today` shape is preserved for existing consumers.
    const baseDay = selectedEntry ? planSchema.flattenDayForConsumer(selectedEntry) : null;
    const legacyToday = baseDay
      ? withDurationEstimateDayPayload(withPlanAnchorPayload(patch ? applyOverride(baseDay, patch) : baseDay, parsed), parsed)
      : null;

    // Completion state + calibrated HR profile for the canonical execution object.
    const [progressRow, hrProfile] = await Promise.all([
      dbGet(
        "SELECT progress_json FROM user_plans WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",
        [req.user.id]
      ),
      getHrProfile(req.user.id, dbGet),
    ]);
    let completedSessionIds = [];
    if (progressRow?.progress_json) {
      try {
        const p = JSON.parse(progressRow.progress_json);
        if (Array.isArray(p.completedSessionIds)) completedSessionIds = p.completedSessionIds;
      } catch (err) {
        console.error('[plans/today] invalid progress JSON:', err.message);
      }
    }

    const overriddenEntry = (patch && selectedEntry)
      ? planSchema.applyOverrideToDay(selectedEntry, patch)
      : selectedEntry;
    const effortEntry = withPlanEffortDayPayload(overriddenEntry, hrProfile);
    const effortToday = withPlanEffortDayPayload(legacyToday, hrProfile);
    const execution = dailyExecution.buildDailyExecution({
      plan: parsed,
      dateISO,
      weekdayShort,
      selectedEntry: effortEntry,
      selectedWeek,
      selectedDayIndex,
      completedSessionIds,
      hrProfile,
    });

    res.json({
      today: effortToday,
      execution: withPlanAnchorPayload(withDurationEstimateExecutionPayload(execution, parsed), parsed),
      ...anchorPayload,
    });
  } catch (err) {
    console.error('[plans] GET today failed:', err);
    res.status(500).json({ error: 'Failed to fetch today' });
  }
});

router.get('/current', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ plan: null });
    const servedPlan = await buildAdaptivePlanView(
      req.user.id,
      parsePlan(active.row) || { weeks: [] },
      Number(active.row.current_week || 1)
    );
    const parsed = withDurationEstimatePlanPayload(servedPlan);
    const anchorPayload = planAnchorPayload(parsed);
    res.json({
      plan: {
        ...active.row,
        ...anchorPayload,
        plan_json: parsed,
        plan_data: parsed,
        current_week: Number(active.row.current_week || 1),
      },
    });
  } catch (err) {
    console.error('[plans/current] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch current plan' });
  }
});

router.get('/compliance', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });
    const weekStart = getMonday(new Date(`${planningDateISO}T12:00:00`));
    const weekEndDate = new Date(`${weekStart}T12:00:00`);
    weekEndDate.setDate(weekEndDate.getDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ week: weekStart, planned: 0, completed: 0, score: 0, missed: [], streak: { current: 0, best: 0 } });

    const parsed = parsePlan(active.row) || { weeks: [] };
    const currentWeek = Number(active.row.current_week || 1);
    const weekIndex = Math.max(0, currentWeek - 1);
    const weekBucket = parsed?.weeks?.[weekIndex] || parsed?.weeks?.[0] || {};
    const selectedWeekStart = activeWeekStart(parsed, active.row, weekIndex, weekStart);
    const days = planSchema.getDayEntries(withCanonicalWeekDates(weekBucket, selectedWeekStart));
    // Session-aware (H1): each day expands to one planned row per run/lift
    // session. Legacy / run-only days collapse to exactly one row, matching the
    // previous mapType behaviour.
    const plannedSessions = days
      .flatMap((d, idx) => planSchema.plannedSessionsForDay(
        d, idx, d.date
      ))
      .filter((d) => d.type !== 'rest' && d.date && d.date >= weekStart && d.date < weekEnd);

    const runSessionIds = [...new Set(plannedSessions
      .filter((session) => session.type === 'run')
      .map((session) => String(session.sessionId || '').trim())
      .filter(Boolean))];
    const linkedRunClause = runSessionIds.length
      ? ` OR plan_session_id IN (${runSessionIds.map(() => '?').join(', ')})`
      : '';
    const [runs, lifts] = await Promise.all([
      dbAll(`SELECT id, date, distance_miles, plan_session_id, planned_session_json
        FROM runs
        WHERE user_id=? AND ((date>=? AND date<?)${linkedRunClause}) AND ${runActivitySql()}`,
      [req.user.id, weekStart, weekEnd, ...runSessionIds]),
      dbAll('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<?', [req.user.id, weekStart, weekEnd])
    ]);

    const progress = parseJsonValue(active.row.progress_json, {});
    const completedSessionIds = new Set(completedSessionIdsFromProgress(progress));
    const runEvidenceBySession = new Map(allocatePlanSessionRunEvidence(
      plannedSessions.filter((session) => session.type === 'run'),
      runs,
      { completedSessionIds }
    ).map(({ session, evidence }) => [session, evidence]));
    const usedLiftIds = new Set();

    const statusItems = plannedSessions.map((s) => {
      const completedFromProgress = completedSessionIds.has(String(s.sessionId));
      if (completedFromProgress) return { ...s, completed: true };
      const target = new Date(`${s.date}T12:00:00`).getTime();
      let hit = null;
      if (s.type === 'run') {
        hit = runEvidenceBySession.get(s) || null;
      } else {
        for (const item of lifts) {
          if (usedLiftIds.has(item.id)) continue;
          const t = new Date(`${item.date}T12:00:00`).getTime();
          if (Math.abs(t - target) <= 24 * 60 * 60 * 1000) {
            hit = item;
            usedLiftIds.add(item.id);
            break;
          }
        }
      }
      return { ...s, completed: !!hit };
    });

    const completed = statusItems.filter((s) => s.completed).length;
    const planned = statusItems.length;
    const score = planned > 0 ? Math.round((completed / planned) * 100) : 0;

    let current = 0, best = 0;
    for (const item of statusItems) {
      if (item.completed) { current += 1; best = Math.max(best, current); }
      else { current = 0; }
    }

    const today = planningDateISO;
    const missed = statusItems
      .filter((s) => !s.completed && s.date < today)
      .map((s) => ({
        sessionId: s.sessionId,
        day: s.day,
        date: s.date,
        type: s.type,
        distance: s.distance,
        raw: s.raw,
      }));

    const week = (() => {
      const d = new Date(`${weekStart}T12:00:00`);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / 86400000) + yearStart.getUTCDay() + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    })();

    res.json({ week, planned, completed, score, missed, streak: { current, best }, sessions: statusItems });
  } catch (err) {
    console.error('[plans/compliance] failed:', err.message);
    res.status(500).json({ error: 'Compliance fetch failed' });
  }
});

router.post('/reschedule-missed', auth, async (req, res) => {
  try {
    const { sessionId, targetDate } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const planningDateISO = getPlanningDateFromRequest({ query: { date: targetDate } });
    if (!targetDate || !planningDateISO) {
      return res.status(400).json({ error: 'targetDate must be the phone local date in YYYY-MM-DD format' });
    }

    const mutation = await withPlanningInputMutation(req.user.id, async (tx) => {
      const active = await getActivePlanForMutation(req.user.id, tx);
      if (!active) return planningInputUnchanged({ status: 404, error: 'No plan found' });

      const parsed = parsePlan(active.row);
      const weekIndex = Math.max(0, Number(active.row.current_week || 1) - 1);
      const rawWeek = parsed?.weeks?.[weekIndex];
      if (!planSchema.getDayEntries(rawWeek).length) {
        return planningInputUnchanged({ status: 400, error: 'Invalid plan format' });
      }
      const fallbackWeekStart = getMonday(new Date(`${planningDateISO}T12:00:00`));
      const selectedWeekStart = activeWeekStart(parsed, active.row, weekIndex, fallbackWeekStart);
      const week = withCanonicalWeekDates(rawWeek, selectedWeekStart);
      const requestedSession = planSchema.getDayEntries(week)
        .flatMap((day, index) => planSchema.plannedSessionsForDay(day, index, day.date))
        .find((session) => String(session.sessionId) === String(sessionId));

      if (!requestedSession) return planningInputUnchanged({ status: 404, error: 'Session not found in plan' });
      if (requestedSession.type !== 'run') {
        return planningInputUnchanged({ status: 409, error: 'Only a missed run can be moved onto today.' });
      }
      if (!requestedSession.date || requestedSession.date >= planningDateISO) {
        return planningInputUnchanged({ status: 409, error: 'Only a run missed before today can be moved.' });
      }

      const progress = parseJsonValue(active.row.progress_json, {});
      const completedIds = new Set(completedSessionIdsFromProgress(progress));
      if (completedIds.has(String(requestedSession.sessionId))) {
        return planningInputUnchanged({ status: 409, error: 'That run is already complete. Refresh your calendar.' });
      }
      const recordedRuns = await tx.all(`
        SELECT id, date, plan_session_id, planned_session_json FROM runs
        WHERE user_id=? AND (plan_session_id=? OR date=?) AND ${runActivitySql()}
      `, [req.user.id, String(requestedSession.sessionId), requestedSession.date]);
      const recordedRun = findPlanSessionRunEvidence(recordedRuns, {
        sessionId: requestedSession.sessionId,
        date: requestedSession.date,
        dateToleranceDays: 0,
      });
      if (recordedRun) {
        return planningInputUnchanged({ status: 409, error: 'That run is already recorded. Sync and refresh your calendar.' });
      }

      const result = planSchema.rescheduleSessionInWeek(week, sessionId, { targetDate: planningDateISO });
      if (result.error === 'not_found') {
        return planningInputUnchanged({ status: 404, error: 'Session not found in plan' });
      }
      if (result.error === 'no_target') {
        return planningInputUnchanged({ status: 409, error: 'Today is not an available recovery day in this training week.' });
      }
      parsed.weeks[weekIndex] = result.week;
      await updateActivePlanData(active, req.user.id, parsed, tx);
      return {
        ok: true,
        movedFrom: result.movedFrom,
        movedTo: result.movedTo,
        movedFromDate: result.movedFromDate,
        movedToDate: result.movedToDate,
        plan: parsed,
        aiSuggestion: 'Week rebalanced after missed session. Keep next run easy and preserve long run.',
      };
    });

    if (mutation.error) return res.status(mutation.status || 409).json({ error: mutation.error });
    res.json(mutation);
  } catch (err) {
    console.error('[plans/reschedule-missed] failed:', err.message);
    res.status(500).json({ error: 'Reschedule failed' });
  }
});

router.post('/race-adjust', auth, async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) return res.status(400).json({ error: 'raceId required' });

    const [race, plan, profile] = await Promise.all([
      dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]),
      getActivePlanForUser(req.user.id),
      dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    ]);

    if (!race) return res.status(404).json({ error: 'Race not found' });
    if (!plan) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(plan.row) || { weeks: [] };
    const adjusted = await generateRaceAdjustment({ profile, race, currentPlan: parsed });
    if (!Array.isArray(adjusted?.weeks) || adjusted.weeks.length === 0) {
      return res.status(503).json({ error: 'Race adjustment is temporarily unavailable. Your current plan was not changed.' });
    }
    const nextPlan = adjusted;
    await withPlanningInputMutation(req.user.id, async (tx) => {
      const active = await getActivePlanForMutation(req.user.id, tx);
      if (!active) return planningInputUnchanged(false);
      await updateActivePlanData(active, req.user.id, nextPlan, tx);
      return true;
    });
    res.json({ ok: true, plan: nextPlan });
  } catch (err) {
    console.error('[plans/race-adjust] failed:', err.message);
    res.status(500).json({ error: 'Race adjust failed' });
  }
});

const HYBRID_SESSION_TEMPLATES = [
  { title: 'Weighted Circuit', description: 'Alternating loaded carries and fast cardio intervals.' },
  { title: 'Kettlebell Cardio', description: 'Kettlebell swings with short aerobic repeats.' },
  { title: 'Rucking', description: 'Brisk weighted walk focused on steady effort.' },
  { title: 'Sled Push Intervals', description: 'Short sled pushes with controlled recovery.' },
];

function isRestDay(day = {}) {
  const type = String(day.type || day.workout_type || '').toLowerCase();
  return day.rest === true || type.includes('rest');
}

function isHybridSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('weighted circuit')
    || text.includes('kettlebell cardio')
    || text.includes('ruck')
    || text.includes('sled push')
    || text.includes('hybrid');
}

function createHybridSession(dayLabel, index) {
  const template = HYBRID_SESSION_TEMPLATES[index % HYBRID_SESSION_TEMPLATES.length];
  return {
    day: dayLabel,
    type: 'cross_train',
    workout_type: 'hybrid',
    title: template.title,
    distance_miles: 2,
    duration_min: 30,
    description: template.description,
    rest: false,
  };
}

function createEasySession(dayLabel) {
  return {
    day: dayLabel,
    type: 'easy',
    workout_type: 'run',
    title: 'Easy aerobic run',
    distance_miles: 2,
    duration_min: 25,
    description: 'Easy effort run to support consistent weekly frequency.',
    rest: false,
  };
}

function isLongRunSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('long');
}

function isRunningSession(day = {}) {
  if (isRestDay(day) || isHybridSession(day)) return false;
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  if (text.includes('strength') || text.includes('lift') || text.includes('cross')) return false;
  return true;
}

function isHillSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('hill') || text.includes('uphill') || text.includes('climb');
}

function getHillSessionPrescription(week = {}) {
  const theme = String(week.theme || '').toLowerCase();
  const weekNumber = Number(week.week) || 1;
  if (theme.includes('taper') || theme.includes('race')) {
    return {
      title: 'Hill Strides',
      description: 'Easy run with 6 x 20s uphill strides at controlled fast effort; walk/jog back recovery.',
      structure: {
        warmup: '10-15 min easy',
        repeats: '6 x 20s uphill controlled fast',
        recovery: 'Walk/jog downhill between reps',
        cooldown: 'Easy running to finish',
      },
    };
  }
  if (theme.includes('build') || weekNumber >= 5) {
    return {
      title: 'Hill Repeats',
      description: 'Structured hill workout: 8 x 60s uphill hard with jog-down recovery; stay tall and powerful.',
      structure: {
        warmup: '10-15 min easy plus drills',
        repeats: '8 x 60s uphill hard',
        recovery: 'Jog downhill easy between reps',
        cooldown: '10 min easy',
      },
    };
  }
  return {
    title: 'Hill Repeats',
    description: 'Structured hill workout: 6 x 60s uphill hard with jog-down recovery; keep effort strong but controlled.',
    structure: {
      warmup: '10-15 min easy',
      repeats: '6 x 60s uphill hard',
      recovery: 'Jog downhill easy between reps',
      cooldown: '10 min easy',
    },
  };
}

function convertToHillSession(day = {}, week = {}) {
  const prescription = getHillSessionPrescription(week);
  return {
    ...day,
    type: 'hill',
    workout_type: 'run',
    title: prescription.title,
    description: prescription.description,
    structure: prescription.structure,
    rest: false,
  };
}

function enforceHillSessionForWeek(week = {}, days = []) {
  if (days.some((day) => !isRestDay(day) && isHillSession(day))) return days;
  const candidateIndex = days.findIndex((day) => isRunningSession(day) && !isLongRunSession(day));
  if (candidateIndex < 0) return days;
  const nextDays = [...days];
  nextDays[candidateIndex] = convertToHillSession(nextDays[candidateIndex], week);
  return nextDays;
}

function enforceWeekSessionRules(week = {}, options = {}) {
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const allowedTrainingDays = Array.isArray(options.trainingDays) && options.trainingDays.length
    ? new Set(options.trainingDays)
    : null;
  // Session-aware (H1): schema-v2 days are flattened to the legacy single-day
  // shape before the single-session enforcement logic runs. Legacy days pass
  // through unchanged (identity), so existing plans stay byte-identical.
  const sourceDays = planSchema.getDayEntries(week).map((day) => {
    if (options.liftingEnabled === false && Array.isArray(day?.sessions)) {
      const runSessions = planSchema.daySessions(day).filter((session) => session.kind !== 'lift');
      return planSchema.flattenDayForConsumer(planSchema.toCanonicalDay(day, runSessions));
    }
    return planSchema.flattenDayForConsumer(day);
  });
  const dayByKey = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const sourceByDay = new Map(sourceDays
    .map((day) => [dayByKey[String(day?.day || '').trim().slice(0, 3).toLowerCase()], day])
    .filter(([day]) => day));
  const days = dayOrder.map((label, idx) => {
    const existing = allowedTrainingDays ? (sourceByDay.get(label) || {}) : (sourceDays[idx] || {});
    return { ...existing, day: label };
  });

  if (allowedTrainingDays) {
    for (let i = 0; i < days.length; i += 1) {
      if (allowedTrainingDays.has(days[i].day) || isRestDay(days[i])) continue;
      days[i] = { day: days[i].day, type: 'rest', workout_type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
    }
    for (let i = 0; i < days.length; i += 1) {
      const hasType = String(days[i].type || days[i].workout_type || '').trim().length > 0;
      if (allowedTrainingDays.has(days[i].day) && !isRestDay(days[i]) && !hasType) {
        days[i] = createEasySession(days[i].day);
      }
    }
  }

  const nonRestIndexes = [];
  for (let i = 0; i < days.length; i += 1) {
    if (!isRestDay(days[i])) nonRestIndexes.push(i);
  }

  while (nonRestIndexes.length < 6) {
    const restIndex = days.findIndex((d) => isRestDay(d) && (!allowedTrainingDays || allowedTrainingDays.has(d.day)));
    if (restIndex < 0) break;
    days[restIndex] = createEasySession(days[restIndex].day || dayOrder[restIndex]);
    nonRestIndexes.push(restIndex);
  }

  if (options.liftingEnabled === false) {
    const runOnlyDays = days.map((day) => {
      const type = String(day.type || day.workout_type || '').toLowerCase();
      if (type.includes('strength') || type.includes('lift') || type.includes('cross') || isHybridSession(day)) {
        return createEasySession(day.day);
      }
      return day;
    });
    return {
      ...week,
      days: options.courseHilly ? enforceHillSessionForWeek(week, runOnlyDays) : runOnlyDays,
    };
  }

  let hybridIndexes = nonRestIndexes.filter((idx) => isHybridSession(days[idx]));
  if (hybridIndexes.length < 1) {
    const targetIndex = nonRestIndexes[Math.max(0, nonRestIndexes.length - 1)];
    days[targetIndex] = createHybridSession(days[targetIndex].day || dayOrder[targetIndex], 0);
    hybridIndexes = nonRestIndexes.filter((idx) => isHybridSession(days[idx]));
  }
  if (hybridIndexes.length < 2 && nonRestIndexes.length >= 6) {
    const targetIndex = nonRestIndexes.find((idx) => idx !== hybridIndexes[0]);
    if (targetIndex !== undefined) {
      days[targetIndex] = createHybridSession(days[targetIndex].day || dayOrder[targetIndex], 1);
    }
  }

  const finalNonRest = days.filter((d) => !isRestDay(d)).length;
  if (finalNonRest === 7) {
    const sundayIndex = dayOrder.indexOf('Sun');
    days[sundayIndex] = { day: 'Sun', type: 'rest', workout_type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
  }

  return { ...week, days: options.courseHilly ? enforceHillSessionForWeek(week, days) : days };
}

function enforcePlanSessionRules(planData = {}, options = {}) {
  const weeks = Array.isArray(planData.weeks) ? planData.weeks.map((week) => enforceWeekSessionRules(week, options)) : [];
  return { ...planData, weeks };
}

router.post('/generate', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    if (Array.isArray(req.body?.target?.raceTargets) || Array.isArray(req.body?.target?.race_targets)) {
      return res.status(400).json({ error: 'Use the owned-race planner to build a two-race plan' });
    }
    const requested = stripClientCourseFacts(req.body?.target || {});
    const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
    if (!runSchedule.valid) return res.status(400).json({ error: runSchedule.error });
    const distanceMiles = clamp(parsePositiveNumber(requested.distanceMiles ?? requested.distance_miles) || 6.2, 1, 100);
    const requestedRaceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requested.raceDate || ''))
      && !Number.isNaN(new Date(`${requested.raceDate}T12:00:00`).getTime())
      ? requested.raceDate
      : null;
    const raceWindow = requestedRaceDate ? concurrentPlan.racePlanWindow(requestedRaceDate, getTodayISO()) : null;
    if (requestedRaceDate && !raceWindow) return res.status(400).json({ error: 'Race date must be today or later' });
    const startDate = raceWindow?.startDate || getPlanStartMonday();
    const target = {
      ...requested,
      trainingDays: runSchedule.trainingDays,
      runDaysPerWeek: runSchedule.runDaysPerWeek,
      runDaysSource: runSchedule.runDaysSource,
      trainingDaysSource: runSchedule.trainingDaysSource,
      distanceMiles,
      raceDate: requestedRaceDate,
      weeks: raceWindow?.weeks || clampInt(requested.weeks, 4, 20, defaultWeeksForDistance(distanceMiles)),
      startDate,
      planMode: concurrentPlan.resolvePlanMode(profile, requested),
      todayISO: getTodayISO(),
      nowISO: `${getTodayISO()}T12:00:00.000Z`,
    };
    const context = await buildConcurrentContext(req.user.id, profile, target);
    const evidencePlan = concurrentPlan.buildConcurrentPlan(context);
    const validation = concurrentPlan.validateConcurrentPlan(evidencePlan, context);
    if (!validation.valid) {
      if (sendPlanScheduleConflict(res, validation)) return;
      throw new Error(`Evidence plan failed validation: ${validation.errors.join('; ')}`);
    }
    const selected = { plan: evidencePlan, source: 'evidence_engine' };
    const name = selected.plan.goal?.name || 'Forged Hybrid training block';
    const persisted = await persistConcurrentPlan(req.user.id, selected.plan, {
      name,
      type: selected.plan.planMode,
      description: `${selected.plan.weeks.length}-week evidence-backed concurrent plan generated from profile and recent training history.`,
    });
    res.status(201).json({
      plan: { id: persisted.planId, user_id: req.user.id, week_start: persisted.weekStart, ...planAnchorPayload(selected.plan), plan_json: selected.plan, plan_data: selected.plan },
      user_plan_id: persisted.userPlanId,
      generation_source: selected.source,
    });
  } catch (err) { console.error('generate failed:', err.message); res.status(500).json({ error: 'Plan generation failed' }); }
});

router.post('/generate-for-races', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const rawRaceIds = req.body?.race_ids;
    if (!Array.isArray(rawRaceIds) || rawRaceIds.length < 1 || rawRaceIds.length > 2) {
      return res.status(400).json({ error: 'Choose one or two races' });
    }
    if (rawRaceIds.some((id) => typeof id !== 'string' || !id.trim() || id.trim().length > 128)) {
      return res.status(400).json({ error: 'Each race ID must be a non-empty string' });
    }
    const submittedRaceIds = rawRaceIds.map((id) => id.trim());
    const raceIds = [...new Set(submittedRaceIds)];
    if (raceIds.length !== submittedRaceIds.length) {
      return res.status(400).json({ error: 'Choose each race only once' });
    }
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const races = await Promise.all(raceIds.map((raceId) => (
      dbGet('SELECT * FROM race_events WHERE id = ? AND user_id = ?', [raceId, req.user.id])
    )));
    if (races.some((race) => !race)) return res.status(404).json({ error: 'Race not found' });
    if (races.some((race) => !concurrentPlan.isValidISODate(race.race_date))) {
      return res.status(400).json({ error: 'Race dates must use valid YYYY-MM-DD calendar dates' });
    }
    const orderedRaces = races.slice().sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)));
    if (new Set(orderedRaces.map((race) => race.race_date)).size !== orderedRaces.length) {
      return res.status(400).json({ error: 'Race dates must be different' });
    }
    if (orderedRaces.length === 2) {
      const firstDate = new Date(`${orderedRaces[0].race_date}T12:00:00Z`);
      const secondDate = new Date(`${orderedRaces[1].race_date}T12:00:00Z`);
      const gapDays = Math.round((secondDate.getTime() - firstDate.getTime()) / 86400000);
      if (gapDays < 21) {
        return res.status(400).json({ error: 'Two PR races must be at least 21 days apart for recovery and tapering' });
      }
    }
    if (orderedRaces.some((race) => !concurrentPlan.racePlanWindow(race.race_date, getTodayISO()))) {
      return res.status(400).json({ error: 'Race dates must be today or later' });
    }
    const finalRace = orderedRaces[orderedRaces.length - 1];
    const raceWindow = concurrentPlan.racePlanWindow(finalRace.race_date, getTodayISO());
    const requested = stripClientCourseFacts(req.body?.target || {});
    const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
    if (!runSchedule.valid) return res.status(400).json({ error: runSchedule.error });
    const raceTargets = orderedRaces.map((race) => ({
      raceDate: race.race_date,
      raceName: race.race_name,
      distanceMiles: clamp(Number(race.distance_miles) || 6.2, 1, 100),
      goalTimeSeconds: race.goal_time_seconds ?? null,
      goalType: Number(race.goal_time_seconds || 0) > 0 ? 'pr' : 'completion',
      ...courseTargetFromRace(race),
    }));
    const finalTarget = raceTargets[raceTargets.length - 1];
    const target = {
      ...requested,
      ...finalTarget,
      raceTargets,
      trainingDays: runSchedule.trainingDays,
      runDaysPerWeek: runSchedule.runDaysPerWeek,
      runDaysSource: runSchedule.runDaysSource,
      trainingDaysSource: runSchedule.trainingDaysSource,
      weeks: raceWindow.weeks,
      startDate: raceWindow.startDate,
      todayISO: getTodayISO(),
      nowISO: `${getTodayISO()}T12:00:00.000Z`,
    };
    target.planMode = concurrentPlan.resolvePlanMode(profile, target);
    const context = await buildConcurrentContext(req.user.id, profile, target);
    const evidencePlan = concurrentPlan.buildConcurrentPlan(context);
    const validation = concurrentPlan.validateConcurrentPlan(evidencePlan, context);
    if (!validation.valid) {
      if (sendPlanScheduleConflict(res, validation)) return;
      throw new Error(`Evidence multi-race plan failed validation: ${validation.errors.join('; ')}`);
    }
    const persisted = await persistConcurrentPlan(req.user.id, evidencePlan, {
      name: orderedRaces.map((race) => race.race_name).join(' + '),
      type: evidencePlan.planMode,
      description: `${raceWindow.weeks}-week plan with ${orderedRaces.length} protected PR race goal${orderedRaces.length === 1 ? '' : 's'}.`,
    });
    return res.status(201).json({
      plan: { id: persisted.planId, user_id: req.user.id, week_start: persisted.weekStart, ...planAnchorPayload(evidencePlan), plan_json: evidencePlan, plan_data: evidencePlan },
      user_plan_id: persisted.userPlanId,
      generation_source: 'evidence_engine',
      weeks: raceWindow.weeks,
      races: orderedRaces.map((race) => ({ id: race.id, name: race.race_name, date: race.race_date })),
    });
  } catch (err) {
    console.error('[plans/generate-for-races] failed:', err.message);
    return res.status(500).json({ error: 'Multi-race plan generation failed' });
  }
});

router.post('/generate-for-race/:raceId', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const race = await dbGet('SELECT * FROM race_events WHERE id = ? AND user_id = ?', [req.params.raceId, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });
    // Cover every dated week through race day from the next plan Monday.
    const raceWindow = concurrentPlan.racePlanWindow(race.race_date, getTodayISO());
    if (!raceWindow) return res.status(400).json({ error: 'Race date must be today or later' });
    const { startDate, weeks } = raceWindow;
    const requested = stripClientCourseFacts(req.body?.target || {});
    const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
    if (!runSchedule.valid) return res.status(400).json({ error: runSchedule.error });
    const target = {
      ...requested,
      trainingDays: runSchedule.trainingDays,
      runDaysPerWeek: runSchedule.runDaysPerWeek,
      runDaysSource: runSchedule.runDaysSource,
      trainingDaysSource: runSchedule.trainingDaysSource,
      raceDate: race.race_date,
      raceName: race.race_name,
      distanceMiles: clamp(Number(race.distance_miles) || 6.2, 1, 100),
      goalTimeSeconds: race.goal_time_seconds ?? null,
      weeks,
      startDate,
      ...courseTargetFromRace(race),
      todayISO: getTodayISO(),
      nowISO: `${getTodayISO()}T12:00:00.000Z`,
    };
    target.planMode = concurrentPlan.resolvePlanMode(profile, target);
    const context = await buildConcurrentContext(req.user.id, profile, target);
    const evidencePlan = concurrentPlan.buildConcurrentPlan(context);
    const validation = concurrentPlan.validateConcurrentPlan(evidencePlan, context);
    if (!validation.valid) {
      if (sendPlanScheduleConflict(res, validation)) return;
      throw new Error(`Evidence race plan failed validation: ${validation.errors.join('; ')}`);
    }
    const selected = { plan: evidencePlan, source: 'evidence_engine' };
    const persisted = await persistConcurrentPlan(req.user.id, selected.plan, {
      name: race.race_name,
      type: selected.plan.planMode,
      description: `${weeks}-week course-aware plan for ${race.race_name}.`,
    });
    res.status(201).json({
      plan: { id: persisted.planId, user_id: req.user.id, week_start: persisted.weekStart, ...planAnchorPayload(selected.plan), plan_json: selected.plan, plan_data: selected.plan },
      user_plan_id: persisted.userPlanId,
      generation_source: selected.source,
      weeks,
      race: { id: race.id, name: race.race_name, date: race.race_date },
    });
  } catch (err) { console.error('generate-for-race failed:', err.message); res.status(500).json({ error: 'Race plan generation failed' }); }
});

module.exports = router;
