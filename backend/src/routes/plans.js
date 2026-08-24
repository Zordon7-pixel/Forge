const router = require('express').Router();
const { dbGet, dbAll, dbRun, withPlanningInputMutation, withUserMutation } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { buildHealthSignals, buildReadinessBand, readinessTrendFromHistory } = require('../lib/healthSignals');
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
const { localDateForOffset } = require('../lib/requestPlanningDate');
const {
  buildRacePlanCandidate,
  canonicalRoadCandidateMaterial,
  enumerateGoalBackwardCandidates,
  legacyGoalBackwardFamily,
  semanticCandidateErrors,
} = require('../lib/racePlanCandidateEngine');
const {
  buildGoalBackwardPlanningDecision,
  suppressRejectedGoalBackwardCandidates,
} = require('../lib/goalBackwardDecisionEngine');
const { assertPipelineLinks, REQUIRED_REASON_CODES } = require('../lib/goalBackwardContracts');
const { canonicalizeRunLoadInput } = require('../lib/goalBackwardEvidence');
const {
  deriveMaterialReductionScope,
  deriveScopedRecoveryState,
  minimumRunningDoseWithoutMaterialReduction,
  normalizeCrossModalReductionEvidence,
  ownDataJsonSnapshot,
  ownDataRaceRemovalImpact,
  runningDistanceObservation,
} = require('../lib/goalBackwardRecoveryMaterial');
const {
  buildGoalBackwardReleaseTelemetry,
  emitGoalBackwardReleaseTelemetry,
  resolveOperationalGoalBackwardV24Mode,
  snapshotGoalBackwardV24Authority,
  targetRef: goalBackwardTargetRef,
} = require('../lib/betaPlanRollout');
const { requestImagesForWorkoutItems } = require('../lib/exerciseImageRequests');
const hyroxPlan = require('../lib/hyroxPlan');
const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  RACE_PLAN_POLICY_V1,
  acceptPlanningClock,
  addDays: addPolicyDays,
  canonicalStringify,
  eventPolicyForGoal,
} = require('../lib/racePlanPolicy');
const { validateCanonicalSessionSet } = require('../lib/canonicalWorkout');
const { canonicalPrescriptionHash } = require('../lib/goalBackwardValidators');
const { buildDecisionArtifactDiagnosticBundle } = require('../lib/racePlanDiagnostics');
const {
  assertPersistablePlan,
  buildCandidateRejectionRecord,
  buildGoalBackwardApplyEnvelope,
  buildPipelineArtifact,
  buildGoalBackwardDecisionArtifacts,
  buildGoalBackwardFingerprintBindings,
  buildGoalBackwardShadowBindings,
  buildPlanningSnapshot,
  candidateRejectionMatches,
  goalBackwardApplyEnvelopeFromRequest,
  isCanonicalHash,
  loadCandidateRejectionsForFingerprint,
  normalizePlanningConstraints,
  parseJson: parseCandidateJson,
  persistCandidateRejection,
  persistGoalBackwardDecisionArtifacts,
  prefixedHash,
  validateCandidateBundle,
  validateGoalBackwardApplyEnvelope,
  validateStoredGoalBackwardCandidateBindings,
} = require('../lib/planCandidateLifecycle');
const {
  resolveActivePlanForDate,
  resolveAssignedPlanForDate,
  shouldFollowSupersededAssignment,
} = require('../lib/planAssignmentLifecycle');

// Strength sessions are already equipment-filtered by concurrentPlan's
// buildStrengthExercises/exerciseCatalog path. strengthAdjunct is the standalone
// form of those rules and must not be applied again to served sessions.

const ADAPTATION_POLICY_VERSION = 'training-gap-v1';
const REQUIRED_RELEASE_TELEMETRY_REASON_CODES = new Set(REQUIRED_REASON_CODES);
const RELEASE_OUTCOME_REASON_CODES = new Set([
  'CANDIDATE_STALE', 'CANDIDATE_HASH_MISMATCH', 'CANDIDATE_DETERMINISM_MISMATCH',
  'CANDIDATE_REVISION_CHANGED', 'DECISION_BINDING_CHANGED', 'DECISION_ARTIFACT_CHANGED',
  'ACTIVE_PLAN_REVISION_CHANGED', 'PLANNING_INPUT_REVISION_CHANGED', 'PLANNING_CLOCK_CHANGED',
  'RACE_REVISION_CHANGED', 'ATHLETE_STATE_REVISION_CHANGED', 'SAFETY_STATE_CHANGED',
  'EVIDENCE_REVISION_CHANGED', 'CONSTRAINT_REVISION_CHANGED', 'POLICY_VERSION_CHANGED',
  'LOCK_REVISION_CHANGED', 'EDIT_REVISION_CHANGED', 'SURFACE_REVISION_CHANGED',
  'EXPORT_REVISION_CHANGED', 'SELECTED_CANDIDATE_CHANGED', 'GOAL_BACKWARD_MODE_UNAVAILABLE',
  'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED',
]);

class PlanCandidateError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function candidateError(status, code, message, details = null) {
  return new PlanCandidateError(status, code, message, details);
}

function sendCandidateError(res, err, context) {
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error(`[plans/${context}] failed:`, err.message);
  else console.error(`[plans/${context}] rejected (${err.code || status}):`, err.message);
  return res.status(status).json({
    error: status >= 500 ? 'Unable to process this plan request.' : (err.message || 'Plan request failed'),
    code: status >= 500 ? 'PLAN_REQUEST_FAILED' : (err.code || 'PLAN_REQUEST_FAILED'),
    ...(status < 500 && err.details ? { details: err.details } : {}),
  });
}

function resolvePlanGoalBackwardV24Mode(userId, dependencies = {}, options = {}) {
  const injected = snapshotGoalBackwardV24Authority(dependencies);
  const internal = snapshotGoalBackwardV24Authority(options);
  if (!injected || !internal) return 'off';
  const authority = Object.create(null);
  Object.defineProperty(authority, 'userId', { enumerable: true, value: userId });
  for (const field of ['audience', 'cohortRefs', 'alertEntries']) {
    if (Object.hasOwn(injected, field)) {
      Object.defineProperty(authority, field, { enumerable: true, value: injected[field] });
    }
  }
  if (Object.hasOwn(internal, 'allowSyntheticShadow')) {
    Object.defineProperty(authority, 'allowSyntheticShadow', {
      enumerable: true,
      value: internal.allowSyntheticShadow,
    });
  }
  if (Object.hasOwn(injected, 'mode') && typeof injected.mode !== 'string') return 'off';
  return resolveOperationalGoalBackwardV24Mode(
    Object.hasOwn(injected, 'mode') ? injected.mode : undefined,
    authority,
  );
}

function getDayShort() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function uniqueLiftExerciseItems(sessions) {
  const seen = new Set();
  const items = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.kind !== 'lift') continue;
    for (const item of [...(Array.isArray(session.exercises) ? session.exercises : []), ...(Array.isArray(session.main) ? session.main : [])]) {
      const name = typeof item === 'string' ? item : item?.name || item?.exercise || item?.exercise_name;
      const key = String(name || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items.slice(0, 80);
}

function plannedLiftExerciseItems(plan) {
  const sessions = [];
  for (const week of Array.isArray(plan?.weeks) ? plan.weeks : []) {
    for (const day of planSchema.getDayEntries(week)) {
      sessions.push(...planSchema.daySessions(day));
    }
  }
  return uniqueLiftExerciseItems(sessions);
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

function getPlanningDateInputFromRequest(req) {
  const headerDate = typeof req.get === 'function'
    ? req.get('x-forged-local-date')
    : req.headers?.['x-forged-local-date'];
  return req.query?.date || req.body?.planning_date_local || headerDate;
}

function getPlanningDateFromRequest(req) {
  return normalizePlanningDate(
    getPlanningDateInputFromRequest(req),
    { defaultToToday: true }
  );
}

function getTimezoneOffsetFromRequest(req) {
  const bodyValue = req.body?.timezone_offset_minutes;
  if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') return bodyValue;
  const headerValue = typeof req.get === 'function'
    ? req.get('x-forged-timezone-offset-minutes')
    : req.headers?.['x-forged-timezone-offset-minutes'];
  return headerValue === undefined || headerValue === null || headerValue === '' ? undefined : headerValue;
}

function withRequestPlanningClock(req, body = {}, overrides = {}) {
  const request = { ...(body || {}), ...overrides };
  return {
    ...request,
    planning_date_local: request.planning_date_local || getPlanningDateInputFromRequest(req) || getTodayISO(),
    timezone_offset_minutes: request.timezone_offset_minutes ?? getTimezoneOffsetFromRequest(req),
  };
}

function parsePlan(plan) {
  try {
    let parsed;
    if (plan?.plan_data) {
      parsed = typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
    } else {
      parsed = typeof plan?.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan?.plan_json;
    }
    return Number(parsed?.canonical_workout_schema_version) === 1
      ? parsed
      : repairPlanPrescriptions(parsed);
  } catch (err) {
    console.error('[plans/parsePlan] invalid plan JSON:', err.message);
    return null;
  }
}

function persistedPlanPayload(planRow) {
  let raw;
  try {
    if (planRow?.plan_data !== null && planRow?.plan_data !== undefined) {
      raw = typeof planRow.plan_data === 'string'
        ? JSON.parse(planRow.plan_data) : planRow.plan_data;
    } else {
      raw = typeof planRow?.plan_json === 'string'
        ? JSON.parse(planRow.plan_json) : planRow?.plan_json;
    }
  } catch (_error) {
    raw = null;
  }
  return raw;
}

function strictRemovalPlanSnapshot(planRow, planningDateLocal, raceId) {
  const raw = persistedPlanPayload(planRow);
  const impact = ownDataRaceRemovalImpact(raw, raceId);
  if (!impact) {
    throw goalBackwardGenerationFailed('REQUIRED_RUNNING_DOSE_INVALID');
  }
  if (!impact.linked) {
    return Object.freeze({ plan: null, impact, running_observation: null });
  }
  const plan = ownDataJsonSnapshot(raw);
  const normalizedImpact = plan ? ownDataRaceRemovalImpact(plan, raceId) : null;
  if (!plan || !normalizedImpact
    || normalizedImpact.linked !== impact.linked
    || JSON.stringify(normalizedImpact.remainingRaceIds) !== JSON.stringify(impact.remainingRaceIds)) {
    throw goalBackwardGenerationFailed('REQUIRED_RUNNING_DOSE_INVALID');
  }
  const observation = runningDistanceObservation(plan, {
    start: planningDateLocal,
    end: addPolicyDays(planningDateLocal, 6),
  });
  if (observation.state !== 'KNOWN') {
    throw goalBackwardGenerationFailed('REQUIRED_RUNNING_DOSE_INVALID');
  }
  return Object.freeze({
    plan,
    impact,
    running_observation: Object.freeze({ ...observation }),
  });
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
  const progress = parseJsonValue(active?.row?.progress_json, {});
  const visiblePlan = planWithoutRemovedSessions(plan, progress, active?.row);
  const planned = plannedSessionsBetween(visiblePlan, since, adaptationEngine.addDays(planningDateISO, -1));
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
    weeklyMileageBaseline: nullableNonNegativeNumber(plan?.inputSummary?.weeklyMileageBaseline, 300),
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
      weeklyBaseline: nullableNonNegativeNumber(plan?.inputSummary?.weeklyMileageBaseline, 300),
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
    revision: proposalDecisionRevision(row),
  };
}

function proposalDecisionRevision(row) {
  if (!row) return null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      id: row.id || null,
      planVersion: row.plan_version || null,
      planningDate: row.planning_date || null,
      windowStart: row.window_start || null,
      windowEnd: row.window_end || null,
      safetyException: Number(row.safety_exception || 0) === 1,
      proposedPlan: parseJsonValue(row.proposed_json, null),
      changes: parseJsonValue(row.changes_json, []),
      evidence: parseJsonValue(row.evidence_json, []),
      reason: decodeProposalReason(row.reason),
    }))
    .digest('hex')
    .slice(0, 32);
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

function adaptationEpisodeDisposition(row, planVersion) {
  if (!row) return 'none';
  if (row.status === 'accepted' || row.status === 'kept') return 'decided';
  if (row.status === 'pending' && String(row.plan_version || '') === String(planVersion || '')) {
    return 'reuse';
  }
  return 'refresh';
}

async function persistAdaptationProposal(userId, active, planVersion, originalPlan, proposal) {
  const episodeKey = runGapEpisodeKey(proposal.evidence);
  const existing = episodeKey
    ? await findRunGapEpisode(userId, episodeKey)
    : await findPendingAdaptation(userId, proposal.planningDate, planVersion);
  const existingDisposition = adaptationEpisodeDisposition(existing, planVersion);
  if (existingDisposition === 'reuse' || existingDisposition === 'decided') {
    return proposalFromRow(existing);
  }
  if (existing && episodeKey) {
    const refreshedId = uuidv4();
    const updated = await dbRun(
      `UPDATE plan_adjustment_proposals
       SET id=?, user_plan_id=?, plan_id=?, plan_version=?, window_start=?, window_end=?,
           planning_date=?, status='pending', safety_exception=?, original_json=?, proposed_json=?,
           changes_json=?, evidence_json=?, reason=?, decided_at=NULL, created_at=CURRENT_TIMESTAMP
       WHERE id=? AND user_id=? AND episode_key=? AND trigger_run_id IS NULL
         AND status NOT IN ('accepted','kept')`,
      [
        refreshedId,
        active?.row?.user_plan_id || null,
        active?.row?.id || null,
        planVersion,
        proposal.windowStart,
        proposal.windowEnd,
        proposal.planningDate,
        proposal.safetyException ? 1 : 0,
        JSON.stringify(originalPlan || null),
        JSON.stringify(proposal.proposedPlan || originalPlan || null),
        JSON.stringify(proposal.changes || []),
        JSON.stringify(proposal.evidence || []),
        encodeProposalReason(proposal),
        existing.id,
        userId,
        episodeKey,
      ]
    );
    if (updated.changes === 0) {
      const concurrent = await findRunGapEpisode(userId, episodeKey);
      if (!concurrent) throw new Error('Run-gap adaptation refresh conflict could not be resolved');
      return proposalFromRow(concurrent);
    }
    const refreshed = await findRunGapEpisode(userId, episodeKey);
    if (!refreshed || String(refreshed.id) !== String(refreshedId)) {
      throw new Error('Run-gap adaptation refresh identity could not be confirmed');
    }
    return proposalFromRow(refreshed);
  }
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
  const stored = episodeKey
    ? await findRunGapEpisode(userId, episodeKey)
    : await findPendingAdaptation(userId, proposal.planningDate, planVersion);
  if (!stored || String(stored.id) !== String(id)) {
    throw new Error('Pending adaptation proposal identity could not be confirmed');
  }
  return proposalFromRow(stored);
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

async function getAssignedPlanForUser(userId, tx = null, options = {}) {
  const get = tx?.get || dbGet;
  const assigned = await resolveAssignedPlanForDate(userId, get, {
    ...options,
    planningDateLocal: options.planningDateLocal || getTodayISO(),
  });
  return assigned ? { source: 'assigned', row: assigned } : null;
}

async function getPlanClearMarker(userId, tx = null, { lock = false } = {}) {
  const get = tx?.get || dbGet;
  return get(`
    SELECT id, plan_id, plan_version, lineage_id, supersedes_user_plan_id, effective_from
    FROM user_plans
    WHERE user_id=? AND status='cleared'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    ${lock ? 'FOR UPDATE' : ''}
  `, [userId]);
}

async function getActivePlanForUser(userId, tx = null, options = {}) {
  const get = tx?.get || dbGet;
  return resolveActivePlanForDate(userId, get, {
    ...options,
    planningDateLocal: options.planningDateLocal || getTodayISO(),
  });
}

// Lock the owner-scoped assignment before reading its current plan pointer.
// This keeps copy-on-write and whole-plan JSON mutation inside one serializable
// read/validate/write sequence for a given athlete.
async function getAssignedPlanForMutation(userId, tx, options = {}) {
  const planningDateLocal = options.planningDateLocal || getTodayISO();
  let assignment = await tx.get(`
    SELECT up.id AS user_plan_id, up.plan_id, up.current_week, up.started_at,
           up.status, up.progress_json, up.plan_version, up.lineage_id,
           up.supersedes_user_plan_id, up.effective_from
    FROM user_plans up
    WHERE up.user_id=? AND up.status='active'
    ORDER BY up.created_at DESC, up.id DESC
    LIMIT 1
    FOR UPDATE OF up
  `, [userId]);
  const visited = new Set();
  while (shouldFollowSupersededAssignment(assignment, planningDateLocal, options)) {
    const predecessorId = String(assignment.supersedes_user_plan_id);
    if (visited.has(predecessorId)) throw new Error('Plan assignment lineage contains a cycle');
    visited.add(predecessorId);
    const predecessor = await tx.get(`
      SELECT up.id AS user_plan_id, up.plan_id, up.current_week, up.started_at,
             up.status, up.progress_json, up.plan_version, up.lineage_id,
             up.supersedes_user_plan_id, up.effective_from
      FROM user_plans up
      WHERE up.id=? AND up.user_id=?
      FOR UPDATE OF up
    `, [predecessorId, userId]);
    if (!predecessor) throw new Error('Plan assignment predecessor is unavailable');
    assignment = predecessor;
  }
  if (assignment) {
    const plan = await tx.get(`
      SELECT tp.*
      FROM training_plans tp
      JOIN user_plans owner_up ON owner_up.plan_id=tp.id
      WHERE tp.id=? AND owner_up.id=? AND owner_up.user_id=?
      FOR UPDATE OF tp
    `, [assignment.plan_id, assignment.user_plan_id, userId]);
    if (!plan) return null;
    const active = { source: 'assigned', row: { ...plan, ...assignment, id: plan.id } };
    return options.normalizePersistedIdentities === false
      ? active
      : normalizeActivePlanIdentitiesForMutation(active, userId, tx);
  }

  return null;
}

async function getActivePlanForMutation(userId, tx, options = {}) {
  const assignment = await getAssignedPlanForMutation(userId, tx, options);
  if (assignment) return assignment;
  if (await getPlanClearMarker(userId, tx, { lock: true })) return null;

  const legacy = await tx.get(`
    SELECT * FROM training_plans
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `, [userId]);
  if (!legacy) return null;
  const active = { source: 'legacy', row: legacy };
  return options.normalizePersistedIdentities === false
    ? active
    : normalizeActivePlanIdentitiesForMutation(active, userId, tx);
}

async function clearActivePlanForUser(userId, tx, options = {}) {
  const planningDateLocal = options.planningDateLocal || getTodayISO();
  const active = await getActivePlanForMutation(userId, tx, {
    includeFuture: true,
    planningDateLocal,
    normalizePersistedIdentities: false,
  });
  if (!active) return Object.freeze({ cleared: false, markerId: null });

  const preservedPlanId = String(active.row.plan_id || active.row.id || '').trim();
  if (!preservedPlanId) throw new Error('Active plan clear marker requires a preserved training plan');
  const supersedesUserPlanId = String(active.row.user_plan_id || '').trim() || null;
  const markerId = uuidv4();
  const priorVersion = Number(active.row.plan_version);
  const planVersion = Number.isSafeInteger(priorVersion) && priorVersion >= 1 ? priorVersion + 1 : 1;
  const lineageId = String(active.row.lineage_id || '').trim() || markerId;

  const superseded = await tx.run(
    "UPDATE user_plans SET status='superseded' WHERE user_id=? AND status='active'",
    [userId],
  );
  if (supersedesUserPlanId && superseded.changes < 1) {
    throw new Error('Active plan supersede failed');
  }
  const marker = await tx.run(
    `INSERT INTO user_plans (
       id, user_id, plan_id, started_at, current_week, status, progress_json,
       plan_version, lineage_id, supersedes_user_plan_id, effective_from
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      markerId,
      userId,
      preservedPlanId,
      planningDateLocal,
      Number(active.row.current_week || 1),
      'cleared',
      JSON.stringify({ completedSessionIds: [] }),
      planVersion,
      lineageId,
      supersedesUserPlanId,
      planningDateLocal,
    ],
  );
  if (marker.changes < 1) throw new Error('Active plan clear marker failed');
  return Object.freeze({ cleared: true, markerId });
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
    active.row.plan_id = cloneId;
    active.row.user_id = userId;
  }
  return active.row.id;
}

async function normalizeActivePlanIdentitiesForMutation(active, userId, tx) {
  const parsed = parsePlan(active?.row);
  if (!parsed) return active;
  const normalized = planSchema.normalizePersistedPlanIdentities(parsed, active.row);
  if (!normalized.changed) return active;

  const validatedPlan = assertPersistablePlan(normalized.plan);
  const planId = await ensureWritablePlan(active, userId, tx);
  const serialized = JSON.stringify(validatedPlan);
  const writesPlanData = active.source === 'assigned' || active.row.plan_data != null;
  const planResult = writesPlanData
    ? await tx.run('UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?', [serialized, planId, userId])
    : await tx.run('UPDATE training_plans SET plan_json=? WHERE id=? AND user_id=?', [serialized, planId, userId]);
  if (planResult.changes === 0) throw new Error('Historical plan identity backfill failed');

  if (active.source === 'assigned') {
    const progressJson = JSON.stringify(normalized.progress);
    const assignmentResult = await tx.run(
      'UPDATE user_plans SET progress_json=?, plan_version=plan_version+1 WHERE id=? AND user_id=?',
      [progressJson, active.row.user_plan_id, userId]
    );
    if (assignmentResult.changes === 0) throw new Error('Historical plan assignment backfill failed');
    active.row.progress_json = progressJson;
    active.row.plan_version = Number(active.row.plan_version || 1) + 1;
  }
  if (writesPlanData) active.row.plan_data = validatedPlan;
  else active.row.plan_json = validatedPlan;
  return active;
}

async function updateActivePlanData(active, userId, planJson, tx) {
  const normalized = planSchema.normalizePersistedPlanIdentities(planJson, active.row);
  const validatedPlan = assertPersistablePlan(normalized.plan);
  const planId = await ensureWritablePlan(active, userId, tx);
  const serialized = JSON.stringify(validatedPlan);
  const writesPlanData = active.source === 'assigned' || active.row.plan_data != null;
  const result = writesPlanData
    ? await tx.run('UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?', [serialized, planId, userId])
    : await tx.run('UPDATE training_plans SET plan_json=? WHERE id=? AND user_id=?', [serialized, planId, userId]);
  if (result.changes === 0) throw new Error('Active plan update failed');
  if (active.source === 'assigned') {
    if (normalized.progressChanged) {
      const progressResult = await tx.run(
        'UPDATE user_plans SET progress_json=? WHERE id=? AND user_id=?',
        [JSON.stringify(normalized.progress), active.row.user_plan_id, userId]
      );
      if (progressResult.changes === 0) throw new Error('Active plan progress remap failed');
      active.row.progress_json = JSON.stringify(normalized.progress);
    }
    const versionResult = await tx.run(
      'UPDATE user_plans SET plan_version=plan_version+1 WHERE id=? AND user_id=?',
      [active.row.user_plan_id, userId]
    );
    if (versionResult.changes === 0) throw new Error('Active plan version update failed');
    active.row.plan_version = Number(active.row.plan_version || 1) + 1;
  }
  if (writesPlanData) active.row.plan_data = validatedPlan;
  else active.row.plan_json = validatedPlan;
  return planId;
}

function defaultWeeksForDistance(distanceMiles) {
  const distance = Number(distanceMiles || 0);
  if (distance >= 20) return 16;
  if (distance >= 11) return 12;
  if (distance >= 5.5) return 10;
  return 8;
}

function completedStrengthExposures(workouts = [], legacyLifts = []) {
  const exposures = (Array.isArray(workouts) ? workouts : []).map((workout) => {
    const date = String(workout?.started_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const minutes = Number(workout?.total_seconds || 0) / 60;
    return {
      date,
      identity: `workout:${workout.id || workout.started_at}`,
      loadPoints: clamp(Number.isFinite(minutes) && minutes > 0 ? minutes : 35, 10, 180),
      sourceKinds: ['workout_sessions'],
      workoutSessionRows: 1,
      legacyLiftRows: 0,
    };
  }).filter(Boolean);
  const exposuresByDate = new Map();
  for (const exposure of exposures) {
    if (!exposuresByDate.has(exposure.date)) exposuresByDate.set(exposure.date, []);
    exposuresByDate.get(exposure.date).push(exposure);
  }
  const liftRowsByDate = new Map();
  for (const lift of Array.isArray(legacyLifts) ? legacyLifts : []) {
    const date = String(lift?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const minutes = Number(lift?.workout_duration_seconds || 0) / 60;
    const rows = liftRowsByDate.get(date) || [];
    rows.push({
      loadPoints: clamp(Number.isFinite(minutes) && minutes > 0 ? minutes : 35, 10, 180),
    });
    liftRowsByDate.set(date, rows);
  }
  for (const [date, rows] of liftRowsByDate.entries()) {
    const sameDateWorkouts = exposuresByDate.get(date) || [];
    const groupedLoad = Math.max(...rows.map((row) => row.loadPoints));
    if (sameDateWorkouts.length) {
      const exposure = sameDateWorkouts[0];
      exposure.loadPoints = Math.max(exposure.loadPoints, groupedLoad);
      exposure.sourceKinds.push('lifts');
      exposure.legacyLiftRows += rows.length;
      continue;
    }
    const exposure = {
      date,
      identity: `lift-date:${date}`,
      loadPoints: groupedLoad,
      sourceKinds: ['lifts'],
      workoutSessionRows: 0,
      legacyLiftRows: rows.length,
    };
    exposures.push(exposure);
    exposuresByDate.set(date, [exposure]);
  }
  return exposures.sort((left, right) => (
    left.date.localeCompare(right.date) || left.identity.localeCompare(right.identity)
  ));
}

function summarizeStrengthExposures(exposures, startDate, endDate) {
  const selected = (Array.isArray(exposures) ? exposures : []).filter((exposure) => (
    exposure.date >= startDate && exposure.date <= endDate
  ));
  return {
    startDate,
    count: selected.length,
    dates: [...new Set(selected.map((exposure) => exposure.date))].sort(),
    loadPoints: Math.round(selected.reduce((sum, exposure) => sum + exposure.loadPoints, 0)),
    provenance: {
      dedupePolicy: 'workout_session_else_calendar_date',
      workoutSessionRows: selected.reduce((sum, exposure) => sum + exposure.workoutSessionRows, 0),
      legacyLiftRows: selected.reduce((sum, exposure) => sum + exposure.legacyLiftRows, 0),
      completedStrengthExposures: selected.length,
      sources: [...new Set(selected.flatMap((exposure) => exposure.sourceKinds))].sort(),
    },
  };
}

function nullableNonNegativeNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function observedMileageLowerBound(rows, runLoadInput, planningDateISO) {
  const window28 = (Array.isArray(runLoadInput?.windows) ? runLoadInput.windows : [])
    .find((window) => Number(window?.days) === 28);
  const recordedDistanceM = nullableNonNegativeNumber(window28?.distance_m, 1_000_000_000);
  let observedMiles = recordedDistanceM === null ? null : recordedDistanceM / 1609.344;
  if (observedMiles === null && /^\d{4}-\d{2}-\d{2}$/.test(String(planningDateISO || ''))) {
    const cutoff = addPolicyDays(planningDateISO, -27);
    const usable = (Array.isArray(rows) ? rows : []).filter((row) => {
      const date = String(row?.date || '').slice(0, 10);
      return date >= cutoff && date <= planningDateISO;
    });
    const knownDistances = usable.map((row) => nullableNonNegativeNumber(row?.distance_miles, 500))
      .filter((distance) => distance !== null);
    if (knownDistances.length) {
      observedMiles = knownDistances.reduce((sum, distance) => sum + distance, 0);
    }
  }
  if (observedMiles === null) {
    return { observedWindowDays: 28, observedWindowMiles: null, observedLowerBoundWeeklyMiles: null };
  }
  const roundedMiles = Math.round(observedMiles * 10) / 10;
  return {
    observedWindowDays: 28,
    observedWindowMiles: roundedMiles,
    observedLowerBoundWeeklyMiles: Math.round((observedMiles / 4) * 10) / 10,
  };
}

function confidenceAwareMileageBaseline(rows, runLoadInput, options = {}) {
  const loadInputState = String(runLoadInput?.load_input_state || 'UNKNOWN').toUpperCase();
  const evidenceConfidence = String(runLoadInput?.load_input_confidence || 'INSUFFICIENT').toUpperCase();
  const estimateOptions = {
    planningDateISO: options.planningDateISO,
    profileWeeklyMiles: options.profileWeeklyMiles,
  };
  const observed = concurrentPlan.estimateWeeklyMileageBaseline(rows, estimateOptions);
  const observedHistoryOnly = concurrentPlan.estimateWeeklyMileageBaseline(rows, {
    ...estimateOptions,
    profileWeeklyMiles: null,
  });
  const lowerBound = observedMileageLowerBound(rows, runLoadInput, options.planningDateISO);
  if (loadInputState === 'VALID_ZERO') {
    return {
      ...observed,
      weeklyMiles: 0,
      longTermWeeklyMiles: 0,
      recent28WeeklyMiles: 0,
      recent14WeeklyMiles: 0,
      meaningfulRunCount: 0,
      method: 'complete_valid_zero',
      progressionEligible: true,
      evidenceConfidence,
      loadInputState,
      ...lowerBound,
    };
  }
  if (loadInputState === 'COMPLETE') {
    return {
      ...observed,
      progressionEligible: true,
      evidenceConfidence,
      loadInputState,
      ...lowerBound,
    };
  }
  const profileBound = nullableNonNegativeNumber(options.profileWeeklyMiles, 300);
  const observedBound = nullableNonNegativeNumber(observedHistoryOnly.weeklyMiles, 300) || 0;
  const weeklyMiles = profileBound === null
    ? null
    : observedBound > 0 ? Math.min(profileBound, observedBound) : profileBound;
  const observedAbovePrescriptionBound = weeklyMiles !== null && observedBound > weeklyMiles + 0.5;
  return {
    ...observed,
    weeklyMiles,
    method: profileBound === null
      ? 'observed_lower_bound_incomplete_evidence'
      : 'profile_bounded_uncertain_evidence',
    progressionEligible: false,
    evidenceConfidence,
    loadInputState,
    profileBoundWeeklyMiles: profileBound,
    observedBoundWeeklyMiles: observedBound,
    ...lowerBound,
    observedAbovePrescriptionBound,
    reasonCodes: observedAbovePrescriptionBound
      ? ['UNCERTAIN_LOAD_ABOVE_PRESCRIPTION_BOUND'] : ['EVIDENCE_UNKNOWN'],
  };
}

async function buildConcurrentContext(userId, profile, target, tx = null) {
  const all = tx?.all || dbAll;
  const get = tx?.get || dbGet;
  const planningDateISO = /^\d{4}-\d{2}-\d{2}$/.test(String(target.todayISO || '')) ? target.todayISO : getTodayISO();
  const sinceDate = addPolicyDays(planningDateISO, -55);
  const planningWeekStartDate = concurrentPlan.racePlanWindow(planningDateISO, planningDateISO)?.startDate || planningDateISO;
  const runHistoryStartDate = addPolicyDays(planningWeekStartDate, -56);
  const [runs, performanceRuns, workouts, legacyLifts, recentExercises, healthRow, activeInjury, dailyCheckin, evidenceCorrections] = await Promise.all([
    all(
      `SELECT id, date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode, notes,
              type, watch_activity_type, watch_normalized_type,
              health_source_workout_id, health_start_at
       FROM runs
       WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}
       ORDER BY date ASC, created_at ASC`,
      [userId, runHistoryStartDate, planningDateISO]
    ),
    all(
      `SELECT id, date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode,
              type, watch_activity_type, watch_normalized_type,
              health_source_workout_id, health_start_at
       FROM runs
       WHERE user_id=? AND date<=? AND distance_miles>0 AND duration_seconds>0 AND ${runActivitySql()}
       ORDER BY date DESC, created_at DESC
       LIMIT 5000`,
      [userId, planningDateISO]
    ),
    all(
      `SELECT id, started_at, ended_at, total_seconds
       FROM workout_sessions
       WHERE user_id=? AND started_at>=? AND started_at<=? AND ended_at IS NOT NULL
       ORDER BY started_at ASC`,
      [userId, `${sinceDate}T00:00:00`, `${planningDateISO}T23:59:59`]
    ),
    all(
      `SELECT id, date, workout_duration_seconds
       FROM lifts
       WHERE user_id=? AND date>=? AND date<=?
       ORDER BY date ASC, created_at ASC`,
      [userId, sinceDate, planningDateISO]
    ),
    all(
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
    get('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/generate] health sync lookup failed:', err.message);
      return null;
    }),
    get('SELECT id FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 1', [userId]).catch((err) => {
      console.error('[plans/generate] injury lookup failed:', err.message);
      return null;
    }),
    get(
      'SELECT feeling, legs, drive, sleep_hours, time_available, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [userId, planningDateISO]
    ).catch((err) => {
      console.error('[plans/generate] daily check-in lookup failed:', err.message);
      return null;
    }),
    all(
      `SELECT id, user_id, raw_evidence_kind, raw_evidence_ref, revision,
              corrected_canonical_value_json, canonical_unit, reason_code, reason,
              attributed_by_user_id, attribution_json, supersedes_correction_id, created_at
       FROM planning_evidence_corrections
       WHERE user_id=? AND raw_evidence_kind='run'
       ORDER BY raw_evidence_ref ASC, revision ASC, id ASC
       LIMIT 1001`,
      [userId]
    ).catch((err) => {
      console.error('[plans/generate] evidence correction lookup failed:', err.message);
      return [];
    }),
  ]);
  const rawRuns = Array.isArray(runs) ? runs : [];
  const sensorSources = [...new Set(rawRuns.map((run) => String(run.health_source || '').trim().toLowerCase())
    .filter((source) => ['apple_health', 'healthkit', 'health_connect', 'garmin', 'garmin_csv', 'fit'].includes(source)))].sort();
  const planningProviderCoverage = healthRow ? sensorSources.map((source) => ({
    source_system: source,
    modalities: ['running'],
    // health_sync currently attests freshness, not a complete activity interval.
    // Preserve that uncertainty until the provider supplies a coverage receipt.
    status: 'unknown',
    synced_at: healthRow?.synced_at || null,
  })) : [];
  const correctionRows = Array.isArray(evidenceCorrections) ? evidenceCorrections : [];
  const correctionsComplete = correctionRows.length <= 1000;
  const canonicalCorrections = correctionsComplete ? correctionRows : [];
  const loadInputOptions = {
    athleteId: userId,
    planningInstant: `${planningDateISO}T23:59:59.999Z`,
    planningDateLocal: planningDateISO,
    timezone: isIanaTimezone(profile.timezone) ? profile.timezone : 'UTC',
    providerCoverage: planningProviderCoverage,
    corrections: canonicalCorrections,
    correctionsComplete,
    correctionInputCount: correctionRows.length,
  };
  const runLoadInput = canonicalizeRunLoadInput({ ...loadInputOptions, runs: rawRuns });
  const planningRuns = runLoadInput.canonical_run_rows;
  const performanceLoadInput = canonicalizeRunLoadInput({
    ...loadInputOptions,
    runs: Array.isArray(performanceRuns) ? performanceRuns : [],
  });
  const canonicalPerformanceRuns = performanceLoadInput.canonical_run_rows;
  const strengthExposures = completedStrengthExposures(workouts, legacyLifts);
  const activityDates = [
    ...planningRuns.map((run) => String(run.date || '').slice(0, 10)),
    ...strengthExposures.map((exposure) => exposure.date),
  ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const weeksObserved = activityDates.length
    ? clamp(Math.ceil(((daysBetween(planningDateISO, activityDates[0]) || 0) + 1) / 7) || 1, 1, 8)
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
  const currentWeekStart = concurrentPlan.racePlanWindow(planningDateISO, planningDateISO)?.startDate;
  const currentWeekStrength = summarizeStrengthExposures(
    strengthExposures,
    currentWeekStart,
    planningDateISO,
  );
  const completeRunCoverage = ['COMPLETE', 'VALID_ZERO'].includes(runLoadInput.load_input_state);
  const completedSessions = planningRuns.length + strengthExposures.length;
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
  const mileageBaseline = confidenceAwareMileageBaseline(planningRuns, runLoadInput, {
    planningDateISO,
    profileWeeklyMiles: profile.weekly_miles_current,
  });
  const weeklyMileageBaseline = mileageBaseline.weeklyMiles;
  const acuteRunLoad = {
    ...summarizeRecentRunLoad(planningRuns, {
    todayISO: planningDateISO,
    weeklyBaseline: weeklyMileageBaseline,
    recoveryState,
    coverageComplete: completeRunCoverage,
    }),
    evidenceUse: completeRunCoverage ? 'PRESCRIPTION_AND_SAFETY' : 'SAFETY_ONLY',
  };
  const performanceProfile = concurrentPlan.buildRunPerformanceProfile(canonicalPerformanceRuns, {
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
      recentRunCount: planningRuns.length,
      runLoadInput: {
        load_input_state: runLoadInput.load_input_state,
        coverage_state: runLoadInput.coverage_state,
        measurement_state: runLoadInput.measurement_state,
        load_input_confidence: runLoadInput.load_input_confidence,
        correction_input_state: runLoadInput.correction_input_state,
        correction_receipt_hash: runLoadInput.correction_receipt_hash,
        recent_normal_confidence: runLoadInput.recent_normal_confidence,
        recent_normal_eligible_week_count: runLoadInput.recent_normal_eligible_week_count,
        recent_normal_weeks: runLoadInput.recent_normal_weeks,
        recent_normal: runLoadInput.recent_normal,
        raw_row_count: runLoadInput.raw_row_count,
        canonical_activity_count: runLoadInput.canonical_activity_count,
        duplicate_activity_count: runLoadInput.duplicate_activity_count,
        windows: runLoadInput.windows,
        identity_decision_receipt: runLoadInput.identity_decision_receipt,
        unresolved_conflicts: runLoadInput.unresolved_conflicts,
        reason_codes: runLoadInput.reason_codes,
        load_input_hash: runLoadInput.load_input_hash,
      },
      // The current schema has no immutable owner/revision/hash-bound
      // 8-dimension measurement plus measured running ceiling receipt.
      // Keep material reduction fail-closed until that server-owned evidence
      // contract is persisted and assembled here.
      crossModalReductionEvidence: null,
      crossModalReductionEvidenceState: {
        available: false,
        reason_code: 'CROSS_MODAL_EVIDENCE_RECEIPT_MISSING',
        required_contract: 'PERSISTED_CROSS_MODAL_REDUCTION_EVIDENCE_V1',
      },
      recentLiftCount: strengthExposures.length,
      acuteRunLoad,
      currentWeekStrength,
      performanceProfile,
      recentExercises: summarizeRecentExercises(recentExercises || []),
      adherenceRate: completeRunCoverage && expectedSessions ? clamp(completedSessions / expectedSessions, 0, 1) : null,
      missedWorkouts: completeRunCoverage && expectedSessions ? Math.max(0, expectedSessions - completedSessions) : null,
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

function acceptedPlanningClock(body = {}) {
  const clock = acceptPlanningClock({
    planning_date_local: body.planning_date_local || getTodayISO(),
    timezone_offset_minutes: body.timezone_offset_minutes,
  }, getTodayISO());
  if (!clock.valid) {
    throw candidateError(400, clock.reason, 'Use the current phone date and a valid timezone offset.');
  }
  return clock;
}

function normalizeCandidateRequest(body = {}) {
  const rawRaceIds = Array.isArray(body.race_ids)
    ? body.race_ids
    : body.race_id ? [body.race_id] : [];
  if (rawRaceIds.length > 2) throw candidateError(400, 'TOO_MANY_RACES', 'Choose one or two races.');
  if (rawRaceIds.some((id) => typeof id !== 'string')) {
    throw candidateError(400, 'INVALID_RACE_ID', 'Each race ID must be a non-empty string.');
  }
  const raceIds = rawRaceIds.map((id) => String(id || '').trim());
  if (raceIds.some((id) => !id || id.length > 128)) {
    throw candidateError(400, 'INVALID_RACE_ID', 'Each race ID must be a non-empty string.');
  }
  if (new Set(raceIds).size !== raceIds.length) {
    throw candidateError(400, 'DUPLICATE_RACE_ID', 'Choose each race only once.');
  }
  const operation = body.operation === 'remove_race' ? 'remove_race' : 'plan_preview';
  const removeRaceId = operation === 'remove_race' ? String(body.remove_race_id || '').trim() : null;
  if (operation === 'remove_race' && (!removeRaceId || removeRaceId.length > 128)) {
    throw candidateError(400, 'INVALID_RACE_ID', 'The race to remove is invalid.');
  }
  if (operation === 'remove_race' && raceIds.includes(removeRaceId)) {
    throw candidateError(400, 'REMOVAL_RACE_RETAINED', 'The removal candidate cannot retain the selected race.');
  }
  return {
    race_ids: raceIds,
    target: stripClientCourseFacts(body.target || {}),
    operation,
    remove_race_id: removeRaceId,
  };
}

function positivePlanRevision(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : 1;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return 1;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : 1;
}

function exactPositivePlanRevision(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value : null;
}

function activeCandidateMetadata(active) {
  if (!active) return null;
  return {
    planVersion: active.source === 'assigned' ? positivePlanRevision(active.row.plan_version) : null,
    trainingPlanId: active.row.id || null,
    userPlanId: active.row.user_plan_id || null,
  };
}

async function ownedRacesForCandidate(userId, raceIds, tx) {
  const races = [];
  for (const raceId of raceIds) {
    const race = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, userId]);
    if (!race) throw candidateError(404, 'RACE_NOT_FOUND', 'Race not found.');
    if (!concurrentPlan.isValidISODate(race.race_date)) {
      throw candidateError(400, 'INVALID_RACE_DATE', 'Race dates must use valid YYYY-MM-DD calendar dates.');
    }
    races.push(race);
  }
  const ordered = races.sort((left, right) => String(left.race_date).localeCompare(String(right.race_date)));
  if (new Set(ordered.map((race) => race.race_date)).size !== ordered.length) {
    throw candidateError(400, 'DUPLICATE_RACE_DATE', 'Race dates must be different.');
  }
  if (ordered.length === 2) {
    const gapDays = daysBetween(ordered[1].race_date, ordered[0].race_date);
    if (gapDays < 21) {
      throw candidateError(400, 'RACE_SPACING_CONFLICT', 'Two PR races must be at least 21 days apart.');
    }
  }
  return ordered;
}

function storedEventConfig(race = {}) {
  if (!race.event_config_json) return {};
  if (typeof race.event_config_json === 'object') return race.event_config_json;
  try {
    const parsed = JSON.parse(race.event_config_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw candidateError(409, 'EVENT_CONFIG_CORRUPT', 'Stored event equipment data is invalid.');
  }
}

function targetFromOwnedRaces(profile, races, requested, planningDateLocal) {
  const hyroxRace = races.find((race) => String(race.event_kind || 'run_race') === 'hyrox');
  if (hyroxRace) {
    if (races[0].id !== hyroxRace.id || races.some((race, index) => index > 0 && String(race.event_kind || 'run_race') !== 'run_race')) {
      throw candidateError(400, 'INVALID_HYROX_GOAL_ORDER', 'HYROX must be the near-term goal followed by at most one running race.');
    }
    const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
    if (!runSchedule.valid) throw candidateError(400, 'INVALID_RUN_SCHEDULE', runSchedule.error);
    if (![3, 4].includes(runSchedule.runDaysPerWeek)) {
      throw candidateError(400, 'INVALID_HYROX_RUN_FREQUENCY', 'HYROX plans require three or four run days per week.');
    }
    const localDate = hyroxRace.event_local_date || hyroxRace.race_date;
    const daysToEvent = daysBetween(localDate, planningDateLocal);
    if (!Number.isInteger(daysToEvent) || daysToEvent < 0) {
      throw candidateError(400, 'RACE_DATE_PASSED', 'HYROX event date must be today or later.');
    }
    const config = storedEventConfig(hyroxRace);
    const hyroxGoalTimeSeconds = parsePositiveNumber(hyroxRace.goal_time_seconds)
      ? Math.round(Number(hyroxRace.goal_time_seconds))
      : null;
    const storedHyroxPerformanceBudget = config.hyroxPerformanceBudget
      && typeof config.hyroxPerformanceBudget === 'object'
      ? config.hyroxPerformanceBudget
      : {};
    const storedHyroxEventState = {
      ...((config.hyroxEventState && typeof config.hyroxEventState === 'object') ? config.hyroxEventState : {}),
      ...((config.hyrox_event_state && typeof config.hyrox_event_state === 'object') ? config.hyrox_event_state : {}),
      ...(config.planned_station_split ? { planned_station_split: config.planned_station_split } : {}),
      ...(config.actual_station_split ? { actual_station_split: config.actual_station_split } : {}),
      ...(config.partner_id !== undefined ? { partner_id: config.partner_id } : {}),
      ...(config.partner_placeholder !== undefined ? { partner_placeholder: config.partner_placeholder } : {}),
    };
    const planWindow = hyroxPlan.planWeekWindow(planningDateLocal, localDate);
    const secondaryRace = races[1] || null;
    const secondaryDistanceMiles = secondaryRace
      ? clamp(Number(secondaryRace.distance_miles) || 10, 1, 100)
      : null;
    const secondaryGoalTimeSeconds = secondaryRace && parsePositiveNumber(secondaryRace.goal_time_seconds)
      ? Math.round(Number(secondaryRace.goal_time_seconds))
      : null;
    const secondaryGoalPaceSecondsPerMile = secondaryRace
      ? concurrentPlan.goalPaceSecondsPerMile({
        distanceMiles: secondaryDistanceMiles,
        goalTimeSeconds: secondaryGoalTimeSeconds,
        goalType: secondaryGoalTimeSeconds ? 'pr' : 'completion',
      })
      : null;
    const secondary = secondaryRace ? {
      kind: 'run_race',
      raceId: secondaryRace.id,
      name: secondaryRace.race_name,
      eventLocalDate: secondaryRace.event_local_date || secondaryRace.race_date,
      eventTimezone: secondaryRace.event_timezone || hyroxRace.event_timezone,
      distanceMiles: secondaryDistanceMiles,
      goalTimeSeconds: secondaryGoalTimeSeconds,
      goalType: secondaryGoalTimeSeconds ? 'pr' : 'completion',
      goalPaceSecondsPerMile: secondaryGoalPaceSecondsPerMile,
      goalPaceLabel: concurrentPlan.formatPaceLabel(secondaryGoalPaceSecondsPerMile),
    } : null;
    const target = {
      ...requested,
      planMode: 'hyrox_build',
      distanceMiles: Number(hyroxRace.distance_miles),
      raceDate: localDate,
      raceId: hyroxRace.id,
      raceName: hyroxRace.race_name,
      goalTimeSeconds: hyroxGoalTimeSeconds,
      goalType: hyroxGoalTimeSeconds ? 'performance' : 'completion',
      runDaysPerWeek: runSchedule.runDaysPerWeek,
      trainingDays: runSchedule.trainingDays,
      runDaysSource: runSchedule.runDaysSource,
      trainingDaysSource: runSchedule.trainingDaysSource,
      weeks: planWindow.weeks,
      startDate: planWindow.startDate,
      todayISO: planningDateLocal,
      nowISO: `${planningDateLocal}T12:00:00.000Z`,
      hyroxEvent: {
        raceId: hyroxRace.id,
        name: hyroxRace.race_name,
        location: hyroxRace.location || null,
        eventLocalDate: localDate,
        eventTimezone: hyroxRace.event_timezone,
        format: hyroxRace.event_format,
        category: hyroxRace.event_category,
        goalTimeSeconds: hyroxGoalTimeSeconds,
        rulesVersion: hyroxRace.rules_version,
        runningPriority: config.runningPriority || 'maintain',
        ...(Object.keys(storedHyroxEventState).length ? { hyroxEventState: storedHyroxEventState } : {}),
        hyroxPerformanceBudget: {
          ...storedHyroxPerformanceBudget,
          ...(hyroxGoalTimeSeconds ? { target_total_time_s: hyroxGoalTimeSeconds } : {}),
        },
      },
      hyroxEquipment: Array.isArray(config.equipment) ? config.equipment : [],
      secondaryRace: secondary,
    };
    return { target, raceWindow: { weeks: target.weeks, startDate: target.startDate } };
  }
  const finalRace = races[races.length - 1];
  const raceWindow = concurrentPlan.racePlanWindow(finalRace.race_date, planningDateLocal);
  if (!raceWindow) throw candidateError(400, 'RACE_DATE_PASSED', 'Race dates must be today or later.');
  if (races[0].race_date < raceWindow.startDate) {
    throw candidateError(
      400,
      'PROTECTED_RACE_OUTSIDE_PLAN_WINDOW',
      'The first protected race falls outside this plan window. Create a separate earlier block.'
    );
  }
  const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
  if (!runSchedule.valid) throw candidateError(400, 'INVALID_RUN_SCHEDULE', runSchedule.error);
  const raceTargets = races.map((race) => ({
    raceDate: race.race_date,
    raceId: race.id,
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
    todayISO: planningDateLocal,
    nowISO: `${planningDateLocal}T12:00:00.000Z`,
  };
  target.planMode = concurrentPlan.resolvePlanMode(profile, target);
  return { target, raceWindow };
}

function targetWithoutOwnedRace(profile, requested, planningDateLocal) {
  if (Array.isArray(requested.raceTargets) || Array.isArray(requested.race_targets)) {
    throw candidateError(400, 'OWNED_RACES_REQUIRED', 'Use owned race IDs to build a multi-race plan.');
  }
  const runSchedule = resolveRunSchedule(profile, requested, { requireCompleteSelection: true });
  if (!runSchedule.valid) throw candidateError(400, 'INVALID_RUN_SCHEDULE', runSchedule.error);
  if (requested.hyroxEvent && ![3, 4].includes(runSchedule.runDaysPerWeek)) {
    throw candidateError(400, 'INVALID_HYROX_RUN_FREQUENCY', 'HYROX plans require three or four run days per week.');
  }
  const distanceMiles = clamp(parsePositiveNumber(requested.distanceMiles ?? requested.distance_miles) || 6.2, 1, 100);
  const requestedRaceDate = concurrentPlan.isValidISODate(requested.raceDate) ? requested.raceDate : null;
  const raceWindow = requestedRaceDate
    ? concurrentPlan.racePlanWindow(requestedRaceDate, planningDateLocal)
    : null;
  if (requestedRaceDate && !raceWindow) {
    throw candidateError(400, 'RACE_DATE_PASSED', 'Race date must be today or later.');
  }
  const target = {
    ...requested,
    trainingDays: runSchedule.trainingDays,
    runDaysPerWeek: runSchedule.runDaysPerWeek,
    runDaysSource: runSchedule.runDaysSource,
    trainingDaysSource: runSchedule.trainingDaysSource,
    distanceMiles,
    raceDate: requestedRaceDate,
    weeks: raceWindow?.weeks || clampInt(requested.weeks, 4, 20, defaultWeeksForDistance(distanceMiles)),
    startDate: raceWindow?.startDate || planningDateLocal,
    planMode: requested.hyroxEvent ? 'hyrox_build' : concurrentPlan.resolvePlanMode(profile, requested),
    todayISO: planningDateLocal,
    nowISO: `${planningDateLocal}T12:00:00.000Z`,
  };
  return { target, raceWindow };
}

async function loadGoalBackwardPlanningConstraints(tx, userId, planId = null) {
  if (!tx || typeof tx.all !== 'function') {
    return normalizePlanningConstraints([], { athleteId: userId, planId });
  }
  const rows = await tx.all(
    `SELECT * FROM planning_constraints
     WHERE user_id=? AND (plan_id IS NULL OR plan_id=?)
     ORDER BY revision ASC, created_at ASC, id ASC`,
    [userId, planId],
  );
  return normalizePlanningConstraints(rows || [], { athleteId: userId, planId });
}

async function loadActiveCanonicalCarryForwardSource(tx, userId, active) {
  const appliedUserPlanId = active?.row?.user_plan_id;
  if (!appliedUserPlanId || !tx || typeof tx.get !== 'function') return null;
  return tx.get(
    `SELECT canonical.id AS artifact_id,
            canonical.user_id AS artifact_user_id,
            canonical.artifact_kind,
            canonical.decision_id AS artifact_decision_id,
            canonical.plan_generation_candidate_id AS artifact_candidate_id,
            canonical.schema_version AS artifact_schema_version,
            canonical.policy_version AS artifact_policy_version,
            canonical.revision AS artifact_revision,
            canonical.content_hash AS artifact_content_hash,
            canonical.payload_json AS artifact_payload_json,
            candidate.id AS candidate_id,
            candidate.decision_id AS candidate_decision_id,
            candidate.selected_candidate_hash AS candidate_selected_hash,
            candidate.material_change_json AS candidate_material_change_json,
            candidate.applied_user_plan_id AS candidate_applied_user_plan_id,
            candidate.status AS candidate_status,
            assignment.id AS assignment_id,
            assignment.user_id AS assignment_user_id,
            assignment.plan_id AS assignment_plan_id,
            assignment.plan_version AS assignment_plan_revision,
            assignment.status AS assignment_status
     FROM plan_generation_candidates candidate
     JOIN planning_pipeline_artifacts canonical
       ON canonical.user_id=candidate.user_id
      AND canonical.plan_generation_candidate_id=candidate.id
      AND canonical.artifact_kind='canonical_session_set'
     JOIN user_plans assignment
       ON assignment.id=candidate.applied_user_plan_id
      AND assignment.user_id=candidate.user_id
     WHERE candidate.user_id=? AND candidate.applied_user_plan_id=?
       AND candidate.status='applied' AND assignment.status='active'
     ORDER BY candidate.applied_at DESC, canonical.revision DESC, canonical.created_at DESC
     LIMIT 1`,
    [userId, appliedUserPlanId],
  );
}

async function loadCandidateInputState(userId, request, clock, tx) {
  const profile = await tx.get('SELECT * FROM users WHERE id=?', [userId]);
  if (!profile) throw candidateError(404, 'USER_NOT_FOUND', 'User not found.');
  let removalRace = null;
  if (request.operation === 'remove_race') {
    removalRace = await tx.get(
      'SELECT * FROM race_events WHERE id=? AND user_id=?',
      [request.remove_race_id, userId],
    );
    if (!removalRace) throw candidateError(404, 'RACE_NOT_FOUND', 'Race not found.');
  }
  const races = await ownedRacesForCandidate(userId, request.race_ids, tx);
  const resolved = races.length
    ? targetFromOwnedRaces(profile, races, request.target, clock.planningDateLocal)
    : targetWithoutOwnedRace(profile, request.target, clock.planningDateLocal);
  const context = await buildConcurrentContext(userId, profile, resolved.target, tx);
  const active = await getActivePlanForUser(userId, tx, {
    includeFuture: true,
    planningDateLocal: clock.planningDateLocal,
  });
  const activeCanonicalCarryForwardSource = active
    ? await loadActiveCanonicalCarryForwardSource(tx, userId, active) : null;
  let removalPlanSnapshot = null;
  let removalImpact = null;
  if (request.operation === 'remove_race') {
    const removalSnapshot = active
      ? strictRemovalPlanSnapshot(active.row, clock.planningDateLocal, request.remove_race_id) : null;
    removalPlanSnapshot = removalSnapshot?.plan || null;
    removalImpact = removalSnapshot?.impact || null;
    const expected = removalImpact?.remainingRaceIds || [];
    const requested = request.race_ids.slice().sort();
    if (!removalImpact?.linked || JSON.stringify(expected.slice().sort()) !== JSON.stringify(requested)) {
      throw candidateError(409, 'REMOVAL_IMPACT_CHANGED', 'The active-plan race goals changed. Preview removal again.');
    }
  }
  const activePlan = activeCandidateMetadata(active);
  const planningConstraints = await loadGoalBackwardPlanningConstraints(
    tx,
    userId,
    activePlan?.trainingPlanId || null,
  );
  const snapshot = buildPlanningSnapshot({
    activePlan,
    context,
    planningDateLocal: clock.planningDateLocal,
    planningInputRevision: profile.planning_input_revision,
    request,
    timezoneOffsetMinutes: clock.timezoneOffsetMinutes,
  });
  const names = races.map((race) => race.race_name);
  return {
    active,
    activeCanonicalCarryForwardSource,
    activePlan,
    context,
    inputHash: prefixedHash(snapshot),
    meta: {
      description: races.length
        ? `${resolved.target.weeks}-week plan with ${races.length} protected race goal${races.length === 1 ? '' : 's'}.`
        : `${resolved.target.weeks}-week evidence-backed concurrent plan.`,
      name: names.length ? names.join(' + ') : resolved.target.raceName || 'Forged Hybrid training block',
      type: resolved.target.planMode,
    },
    planningInputRevision: Number(profile.planning_input_revision || 0),
    planningConstraints,
    races,
    removalImpact,
    removalPlanSnapshot,
    removalRace,
    request,
    snapshot,
    target: resolved.target,
  };
}

function buildCandidateTrace(state, built) {
  return {
    engine_version: built.plan.engineVersion || RACE_PLAN_POLICY_V1.engineVersion,
    feasibility: built.plan.overall_feasibility || null,
    goal_feasibilities: built.plan.goal_feasibilities || [],
    invariant_version: built.plan.invariantVersion || RACE_PLAN_POLICY_V1.invariantVersion,
    planning_date_local: state.snapshot.planning_date_local,
    policy_version: built.plan.policyVersion || RACE_PLAN_POLICY_V1.version,
    reason_codes: built.plan.reasons || [],
    validation: built.validation,
  };
}

function hyroxRecentRunLoadView(acuteRunLoad = {}) {
  const currentWeek = acuteRunLoad?.currentWeek;
  if (!currentWeek || currentWeek.miles !== null) return acuteRunLoad;
  // The legacy HYROX engine needs a finite arithmetic credit. Give it only
  // the explicitly known lower bound, never a fabricated complete total.
  const lowerBound = nullableNonNegativeNumber(currentWeek.knownDistanceLowerBoundMiles, 500) ?? 0;
  return {
    ...acuteRunLoad,
    currentWeek: {
      ...currentWeek,
      miles: lowerBound,
    },
  };
}

function restoreHyroxIncompleteDistanceTruth(plan, acuteRunLoad = {}) {
  const currentWeek = acuteRunLoad?.currentWeek;
  if (!plan || !currentWeek || currentWeek.miles !== null) return plan;
  const distanceTruth = {
    distanceState: currentWeek.distanceState || 'INCOMPLETE',
    knownDistanceLowerBoundMiles: nullableNonNegativeNumber(
      currentWeek.knownDistanceLowerBoundMiles,
      500,
    ),
    unknownDistanceRunCount: Math.max(0, Number(currentWeek.unknownDistanceRunCount || 0)),
  };
  if (plan.inputSummary?.currentWeekRunLoad) {
    plan.inputSummary.currentWeekRunLoad.miles = null;
    Object.assign(plan.inputSummary.currentWeekRunLoad, distanceTruth);
  }
  for (const week of plan.weeks || []) {
    if (!week.currentWeekConstraint) continue;
    week.currentWeekConstraint.completedRunMiles = null;
    week.currentWeekConstraint.completedKnownDistanceLowerBoundMiles = distanceTruth.knownDistanceLowerBoundMiles;
    week.currentWeekConstraint.completedRunDistanceState = distanceTruth.distanceState;
    week.currentWeekConstraint.unknownDistanceRunCount = distanceTruth.unknownDistanceRunCount;
  }
  return plan;
}

function buildDeterministicCandidate(context, options) {
  if (!context?.target?.hyroxEvent) return buildRacePlanCandidate(context, options);
  try {
    const plan = restoreHyroxIncompleteDistanceTruth(hyroxPlan.generateHyroxPlan({
      athlete: {
        ...context.profile,
        runDaysPerWeek: context.target.runDaysPerWeek,
        readiness: context.recovery?.state,
      },
      currentLoad: {
        weeklyMiles: context.history?.weeklyMileageBaseline
          ?? context.history?.mileageBaseline?.observedLowerBoundWeeklyMiles
          ?? null,
        readiness: context.recovery?.state,
        recentRunLoad: hyroxRecentRunLoadView(context.history?.acuteRunLoad),
        currentWeekStrength: context.history?.currentWeekStrength,
      },
      planningLocalDate: options.planningDateLocal,
      event: context.target.hyroxEvent,
      equipment: context.target.hyroxEquipment,
      availableDays: context.target.trainingDays,
      secondaryRace: context.target.secondaryRace,
    }), context.history?.acuteRunLoad);
    return { plan, validation: hyroxPlan.validateHyroxPlan(plan) };
  } catch (err) {
    const knownErrors = {
      hyrox_run_days_must_be_3_or_4: ['INVALID_HYROX_RUN_FREQUENCY', 'HYROX plans require three or four run days per week.'],
      insufficient_available_days: ['INVALID_RUN_SCHEDULE', 'Select at least as many training weekdays as run days.'],
      no_available_training_days: ['INVALID_RUN_SCHEDULE', 'Select at least one available training weekday.'],
      invalid_planning_local_date: ['INVALID_PLANNING_DATE', 'Choose a valid local planning date.'],
      invalid_local_date: ['INVALID_RACE_DATE', 'Choose a valid HYROX event date.'],
      invalid_instant: ['INVALID_PLANNING_TIME', 'Refresh the plan preview and try again.'],
      invalid_event_timezone: ['INVALID_EVENT_TIMEZONE', 'Choose a valid IANA time zone for the HYROX event.'],
      invalid_event_local_date: ['INVALID_RACE_DATE', 'Choose a valid HYROX event date.'],
      invalid_days_to_event: ['RACE_DATE_PASSED', 'HYROX event date must be today or later.'],
      invalid_secondary_race_date: ['INVALID_RACE_DATE', 'Choose a valid date for the secondary race.'],
      secondary_race_requires_dated_hyrox: ['SECONDARY_RACE_REQUIRES_DATE', 'Add a HYROX event date before protecting a secondary race.'],
      secondary_race_spacing: ['RACE_SPACING_CONFLICT', 'The secondary race must be at least 21 days after HYROX.'],
    };
    const mapped = knownErrors[err?.message];
    if (mapped) throw candidateError(400, mapped[0], mapped[1]);
    if (String(err?.message || '').startsWith('hyrox_standard_')) {
      throw candidateError(400, 'UNSUPPORTED_HYROX_DIVISION', 'Choose a supported HYROX format, category, and rules version.');
    }
    if (String(err?.message || '').startsWith('hyrox_plan_invariant:')) {
      throw candidateError(
        422,
        'PLAN_VALIDATION_FAILED',
        'The requested plan did not pass safety validation.',
        err.validation?.errors || null,
      );
    }
    throw err;
  }
}

function publicCandidatePayload(candidate) {
  const plan = candidate.plan;
  return {
    candidate: {
      candidate_hash: candidate.candidateHash,
      effective_from: candidate.effectiveFrom,
      expires_at: candidate.expiresAt,
      id: candidate.id,
      planning_date_local: candidate.planningDateLocal,
      plan_data: plan,
      status: 'preview',
    },
    candidate_hash: candidate.candidateHash,
    candidate_id: candidate.id,
    effective_from: candidate.effectiveFrom,
    generation_source: 'race_plan_candidate_engine',
    replaces_active_plan: Boolean(candidate.replacesActivePlan),
    plan: {
      id: candidate.id,
      ...planAnchorPayload(plan),
      plan_data: plan,
      plan_json: plan,
      preview: true,
    },
    requires_apply: true,
    ...(candidate.applyBindings ? { apply_bindings: candidate.applyBindings } : {}),
    ...(candidate.surfaceManifest ? { surface_manifest: candidate.surfaceManifest } : {}),
  };
}

function candidateEffectiveFrom(active, planningDateLocal, { immediate = false } = {}) {
  return active?.source === 'assigned' && !immediate
    ? addPolicyDays(planningDateLocal, 1)
    : planningDateLocal;
}

async function pruneExpiredPlanCandidates(tx, userId, {
  excludeCandidateId = null,
  now = new Date(),
} = {}) {
  const cutoff = new Date(
    new Date(now).getTime() - (RACE_PLAN_POLICY_V1.candidate.ttlHours * 60 * 60 * 1000)
  ).toISOString();
  const exclusion = excludeCandidateId ? ' AND id<>?' : '';
  const params = [userId, cutoff];
  if (excludeCandidateId) params.push(excludeCandidateId);
  return tx.run(
    `DELETE FROM plan_generation_candidates WHERE user_id=? AND expires_at<?${exclusion}`,
    params
  );
}

function goalBackwardAvailableLocalDates(state, planningDateLocal) {
  const preferred = new Set((state?.target?.trainingDays || [])
    .map((day) => String(day || '').slice(0, 3).toLowerCase()));
  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dates = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addPolicyDays(planningDateLocal, index);
    const weekday = weekdays[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
    if (!preferred.size || preferred.has(weekday)) dates.push(date);
  }
  return dates;
}

function goalBackwardCompletedRunningCredit(context, planningDateLocal, evidenceSnapshotId) {
  const currentWeek = context?.history?.acuteRunLoad?.currentWeek;
  const expectedWeekStart = concurrentPlan.racePlanWindow(
    planningDateLocal,
    planningDateLocal,
  )?.startDate;
  const distanceState = String(currentWeek?.distanceState || '').toUpperCase();
  const lowerBoundMiles = currentWeek?.knownDistanceLowerBoundMiles;
  const runCount = currentWeek?.runCount;
  const runDates = Array.isArray(currentWeek?.runDates)
    ? [...new Set(currentWeek.runDates)].sort() : [];
  const knownMiles = currentWeek?.miles;
  const completeDistanceMatches = distanceState === 'KNOWN'
    && typeof knownMiles === 'number'
    && Number.isFinite(knownMiles)
    && Math.abs(knownMiles - lowerBoundMiles) < 0.000001;
  const incompleteDistanceIsLowerBound = distanceState === 'INCOMPLETE'
    && knownMiles === null;
  if (!expectedWeekStart || currentWeek?.startDate !== expectedWeekStart
    || !['KNOWN', 'INCOMPLETE'].includes(distanceState)
    || (!completeDistanceMatches && !incompleteDistanceIsLowerBound)
    || typeof lowerBoundMiles !== 'number' || !Number.isFinite(lowerBoundMiles)
    || lowerBoundMiles <= 0 || lowerBoundMiles > 500
    || !Number.isSafeInteger(runCount) || runCount < 1 || runCount < runDates.length
    || !runDates.length || runDates.some((date) => (
      !concurrentPlan.isValidISODate(date)
      || date < expectedWeekStart
      || date > planningDateLocal
    ))) return null;
  const completedRunningM = Math.floor(lowerBoundMiles * 1609.344);
  if (!Number.isSafeInteger(completedRunningM) || completedRunningM < 1) return null;
  return Object.freeze({
    schema_version: 1,
    source: 'CANONICAL_CURRENT_WEEK_LOWER_BOUND',
    planning_week_start_local: expectedWeekStart,
    through_local_date: runDates[runDates.length - 1],
    completed_running_m: completedRunningM,
    evidence_ids: Object.freeze([
      evidenceSnapshotId,
      context?.history?.runLoadInput?.load_input_hash,
    ].filter((value) => typeof value === 'string' && value.length > 0)),
  });
}

function goalBackwardTrainingAge(context = {}) {
  const explicit = String(context.profile?.training_age_class || '').toUpperCase();
  if (['BEGINNER', 'DEVELOPING', 'ESTABLISHED', 'ADVANCED'].includes(explicit)) return explicit;
  const count = Number(context.history?.recentRunCount || 0);
  return count >= 24 ? 'ESTABLISHED' : count >= 8 ? 'DEVELOPING' : 'BEGINNER';
}

function goalBackwardRecoveryState(context = {}) {
  const state = String(context.recovery?.state || '').toUpperCase();
  if (['READY', 'NORMAL', 'CAUTION', 'RECOVERY'].includes(state)) return state;
  if (state === 'LOW') return 'RECOVERY';
  return 'NORMAL';
}

function goalBackwardSafetyState(context = {}) {
  return {
    action: context.safety?.activeInjury ? 'MODIFY_IMPACT' : 'NORMAL',
    scope: [],
  };
}

function raceLifecycleForPlanning(race = {}) {
  const config = storedEventConfig(race);
  const lifecycle = config.goal_backward_lifecycle && typeof config.goal_backward_lifecycle === 'object'
    ? config.goal_backward_lifecycle : {};
  const legacyStatus = String(race.status || '').toLowerCase();
  const eventState = String(race.event_state ?? lifecycle.event_state
    ?? (legacyStatus === 'completed' ? 'COMPLETED' : legacyStatus === 'cancelled' ? 'CANCELLED' : 'SCHEDULED'))
    .toUpperCase();
  return {
    event_state: eventState,
    event_revision: Math.max(1, Number(race.event_revision ?? lifecycle.event_revision ?? 1)),
    goal_revision: Math.max(1, Number(race.goal_revision ?? lifecycle.goal_revision ?? race.revision ?? 1)),
    transition_exit_met: race.transition_exit_met === true || lifecycle.transition_exit_met === true,
  };
}

function goalBackwardEventKind(race, state) {
  const targetHyroxRaceId = state?.target?.hyroxEvent?.raceId;
  const isTargetHyrox = targetHyroxRaceId !== null && targetHyroxRaceId !== undefined
    && String(targetHyroxRaceId) === String(race?.id || '');
  if (String(race?.event_kind || '').toLowerCase() === 'hyrox' || isTargetHyrox) {
    const format = String(race?.event_format || state?.target?.hyroxEvent?.format || '').toLowerCase();
    return format.includes('double') ? 'HYROX_DOUBLES' : 'HYROX_SINGLES';
  }
  const distanceMiles = Number(race?.distance_miles || state?.target?.distanceMiles || 0);
  if (distanceMiles > 20) return 'MARATHON';
  return distanceMiles > 6.3 ? 'ROAD_ENDURANCE' : 'ROAD_SHORT';
}

const GOAL_BACKWARD_RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'assessment', 'race',
]);
const GOAL_BACKWARD_PROJECTABLE_RUNNING_FAMILIES = new Set([
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
]);

function goalBackwardCandidateMaterial(plan, availableLocalDates) {
  const available = Array.isArray(availableLocalDates) ? new Set(availableLocalDates) : null;
  return (Array.isArray(plan?.weeks) ? plan.weeks : []).flatMap((week) => (
    (Array.isArray(week?.days) ? week.days : []).flatMap((day) => (
      (!available || available.has(String(day?.date || '')))
        ? (Array.isArray(day.sessions) ? day.sessions : []).map((session) => ({
          ...session,
          date: session.date || day.date,
        }))
        : []
    ))
  ));
}

function goalBackwardMaterialId(session) {
  const value = session?.session_id ?? session?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function goalBackwardRemovalFamily(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const familyFields = [
    session.workout_id,
    session.workout_family,
    session.sessionType,
    session.session_type,
    session.type,
  ];
  if (familyFields.some((value) => value !== null && value !== undefined && typeof value !== 'string')) {
    return null;
  }
  const family = legacyGoalBackwardFamily(session);
  return ['easy_run', 'recovery_run', 'long_aerobic', 'assessment'].includes(family) ? family : null;
}

function goalBackwardRemovalMaterial(plan, availableLocalDates) {
  if (!Array.isArray(availableLocalDates) || !availableLocalDates.length
    || availableLocalDates.some((date) => (
      typeof date !== 'string' || !concurrentPlan.isValidISODate(date)
    ))) return [];
  const available = new Set(availableLocalDates);
  return (Array.isArray(plan?.weeks) ? plan.weeks : []).flatMap((week) => (
    (Array.isArray(week?.days) ? week.days : []).flatMap((day) => {
      const dayDate = typeof day?.date === 'string' && concurrentPlan.isValidISODate(day.date)
        ? day.date : null;
      if (!dayDate || !available.has(dayDate)) return [];
      return (Array.isArray(day.sessions) ? day.sessions : []).flatMap((session) => {
        if (!session || typeof session !== 'object' || Array.isArray(session)) return [];
        const explicitSessionDate = session.scheduled_local_date ?? session.date;
        if (explicitSessionDate !== null && explicitSessionDate !== undefined
          && (typeof explicitSessionDate !== 'string'
            || !concurrentPlan.isValidISODate(explicitSessionDate)
            || explicitSessionDate !== dayDate)) return [];
        return [{ ...session, date: dayDate }];
      });
    })
  ));
}

function goalBackwardRemovalCarryForwardMaterial(state, activeAppliedPlan, availableLocalDates) {
  if (state?.request?.operation !== 'remove_race'
    || activeAppliedPlan?.canonical_workout_schema_version !== 1
    || !isCanonicalHash(activeAppliedPlan?.canonical_session_set_hash)
    || !isCanonicalHash(activeAppliedPlan?.selected_candidate_hash)) return [];
  const retainedGoalIds = new Set((state.races || []).map((race) => `goal-${String(race?.id || '')}`));
  const removedGoalId = `goal-${String(state.request.remove_race_id || '')}`;
  const allowedGoalIds = new Set([...retainedGoalIds, removedGoalId]);
  if (!retainedGoalIds.size || removedGoalId === 'goal-') return [];
  const acceptedMaterialIds = new Set();
  // A successor may retain only canonical, goal-shared aerobic or assessment
  // material. The new canonical session set rebinds it to the retained
  // decision goals; race-specific quality and material owned only by the
  // removed goal never cross.
  return goalBackwardRemovalMaterial(activeAppliedPlan, availableLocalDates).filter((session) => {
    if (!goalBackwardRemovalFamily(session)) return false;
    const id = goalBackwardMaterialId(session);
    const goalIds = session?.goal_ids ?? session?.goalIds;
    if (!id || acceptedMaterialIds.has(id)
      || !Array.isArray(goalIds) || !goalIds.length
      || goalIds.some((goalId) => typeof goalId !== 'string' || !allowedGoalIds.has(goalId))
      || !goalIds.some((goalId) => retainedGoalIds.has(goalId))) return false;
    acceptedMaterialIds.add(id);
    return true;
  });
}

const CANONICAL_SESSION_SET_PAYLOAD_KEYS = Object.freeze([
  'canonical_workout_schema_version', 'canonical_sessions_materialized',
  'plan_id', 'plan_revision', 'decision_id', 'decision_hash', 'candidate_id',
  'candidate_skeleton_hash', 'candidate_hash', 'material_change_baseline_binding_hash',
  'sessions', 'session_content_hashes', 'derived_totals', 'content_hash',
]);
const CANONICAL_SESSION_SET_ARTIFACT_KEYS = new Set([
  'plan_generation_candidate_ref', ...CANONICAL_SESSION_SET_PAYLOAD_KEYS,
  'selected_candidate_id', 'selected_candidate_hash',
]);
const ACTIVE_CANONICAL_CARRY_SOURCE_KEYS = Object.freeze([
  'artifact_id', 'artifact_user_id', 'artifact_kind', 'artifact_decision_id',
  'artifact_candidate_id', 'artifact_schema_version', 'artifact_policy_version',
  'artifact_revision', 'artifact_content_hash', 'artifact_payload_json',
  'candidate_id', 'candidate_decision_id', 'candidate_selected_hash',
  'candidate_material_change_json', 'candidate_applied_user_plan_id', 'candidate_status',
  'assignment_id', 'assignment_user_id', 'assignment_plan_id',
  'assignment_plan_revision', 'assignment_status',
]);
const ACTIVE_CANONICAL_CARRY_JSON_KEYS = new Set([
  'artifact_payload_json', 'candidate_material_change_json',
]);

function exactHashIdentity(value) {
  return isCanonicalHash(value) ? value.replace(/^sha256:/, '') : null;
}

function storedOwnJsonSnapshot(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return ownDataJsonSnapshot(parsed);
  } catch (_error) {
    return null;
  }
}

function ownStoredCanonicalCarrySource(value) {
  try {
    const snapshot = ownDataJsonSnapshot(value, { maximumDepth: 64, maximumNodes: 50000 });
    if (!snapshot || Array.isArray(snapshot)) return null;
    const keys = Object.keys(snapshot);
    if (keys.length !== ACTIVE_CANONICAL_CARRY_SOURCE_KEYS.length
      || keys.some((key) => !ACTIVE_CANONICAL_CARRY_SOURCE_KEYS.includes(key))) return null;
    const source = Object.create(null);
    for (const key of ACTIVE_CANONICAL_CARRY_SOURCE_KEYS) {
      if (!Object.hasOwn(snapshot, key)) return null;
      const field = snapshot[key];
      if (ACTIVE_CANONICAL_CARRY_JSON_KEYS.has(key)) {
        const json = storedOwnJsonSnapshot(field);
        if (!json || Array.isArray(json)) return null;
        source[key] = json;
        continue;
      }
      if (field !== null && !['string', 'number', 'boolean'].includes(typeof field)) return null;
      source[key] = field;
    }
    return Object.freeze(source);
  } catch (_error) {
    return null;
  }
}

function invalidGoalExpansionCarrySource(reason) {
  const error = new Error(`Active canonical goal-expansion source is invalid: ${reason}`);
  error.code = 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID';
  throw error;
}

function canonicalCarryGoalIds(session) {
  if (!Object.hasOwn(session, 'goal_ids')) return null;
  const aliases = ['goal_ids', 'goalIds'].filter((key) => Object.hasOwn(session, key));
  let normalized = null;
  for (const alias of aliases) {
    const values = session[alias];
    if (!Array.isArray(values) || !values.length
      || values.some((value) => typeof value !== 'string' || !value || value.trim() !== value)
      || new Set(values).size !== values.length) return null;
    const sorted = [...values].sort();
    if (normalized && canonicalStringify(normalized) !== canonicalStringify(sorted)) return null;
    normalized = sorted;
  }
  return normalized;
}

function authenticatedGoalExpansionSessionSet({
  userId,
  state,
  activeAppliedPlan,
  activeSource,
}) {
  const plan = ownDataJsonSnapshot(activeAppliedPlan);
  const source = ownStoredCanonicalCarrySource(activeSource);
  if (!plan || !source) invalidGoalExpansionCarrySource('OWN_DATA_SNAPSHOT_INVALID');
  const payload = storedOwnJsonSnapshot(source.artifact_payload_json);
  const materialChange = storedOwnJsonSnapshot(source.candidate_material_change_json);
  if (!payload || !materialChange) invalidGoalExpansionCarrySource('ARTIFACT_PAYLOAD_INVALID');
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.length !== CANONICAL_SESSION_SET_ARTIFACT_KEYS.size
    || payloadKeys.some((key) => !CANONICAL_SESSION_SET_ARTIFACT_KEYS.has(key))) {
    invalidGoalExpansionCarrySource('ARTIFACT_SCHEMA_INVALID');
  }
  const sessionSet = Object.fromEntries(CANONICAL_SESSION_SET_PAYLOAD_KEYS.map((key) => [key, payload[key]]));
  const validation = validateCanonicalSessionSet(sessionSet);
  const artifactHash = exactHashIdentity(source.artifact_content_hash);
  const selectedHash = exactHashIdentity(source.candidate_selected_hash);
  const payloadSelectedHash = exactHashIdentity(payload.selected_candidate_hash);
  const planSelectedHash = exactHashIdentity(plan.selected_candidate_hash);
  const planSessionSetHash = exactHashIdentity(plan.canonical_session_set_hash);
  const expectedPrescriptionHash = exactHashIdentity(materialChange.candidate_prescription_hash);
  const actualPrescriptionHash = exactHashIdentity(canonicalPrescriptionHash(plan));
  const assignmentPlanRevision = source.assignment_plan_revision;
  const identityChecks = [
    ['SESSION_SET_INVALID', validation.valid],
    ['OWNER_ID_INVALID', typeof userId === 'string' && Boolean(userId)],
    ['ARTIFACT_OWNER_MISMATCH', source.artifact_user_id === userId],
    ['ARTIFACT_KIND_MISMATCH', source.artifact_kind === 'canonical_session_set'],
    ['ARTIFACT_ID_INVALID', typeof source.artifact_id === 'string' && Boolean(source.artifact_id)],
    ['ARTIFACT_SCHEMA_MISMATCH', source.artifact_schema_version === '1'],
    ['ARTIFACT_POLICY_INVALID', typeof source.artifact_policy_version === 'string'
      && Boolean(source.artifact_policy_version)],
    ['ARTIFACT_REVISION_INVALID', Number.isSafeInteger(source.artifact_revision)
      && source.artifact_revision >= 1],
    ['CANDIDATE_STATUS_MISMATCH', source.candidate_status === 'applied'],
    ['ASSIGNMENT_ID_MISMATCH', source.assignment_id === source.candidate_applied_user_plan_id
      && source.assignment_id === state.activePlan?.userPlanId],
    ['ASSIGNMENT_OWNER_MISMATCH', source.assignment_user_id === userId],
    ['ASSIGNMENT_PLAN_MISMATCH', source.assignment_plan_id === state.activePlan?.trainingPlanId],
    ['ASSIGNMENT_STATUS_MISMATCH', source.assignment_status === 'active'],
    ['ASSIGNMENT_REVISION_INVALID', Number.isSafeInteger(assignmentPlanRevision)
      && assignmentPlanRevision >= 1],
    ['ARTIFACT_CANDIDATE_MISMATCH', source.artifact_candidate_id === source.candidate_id],
    ['ARTIFACT_DECISION_MISMATCH', source.artifact_decision_id === source.candidate_decision_id
      && source.artifact_decision_id === sessionSet.decision_id],
    ['PAYLOAD_CANDIDATE_MISMATCH', exactHashIdentity(payload.plan_generation_candidate_ref)
      === exactHashIdentity(prefixedHash(source.candidate_id))
      && payload.selected_candidate_id === sessionSet.candidate_id],
    ['ARTIFACT_CONTENT_HASH_MISMATCH', artifactHash === exactHashIdentity(prefixedHash(payload))],
    ['CANDIDATE_HASH_MISSING', Boolean(selectedHash)],
    ['CANDIDATE_HASH_MISMATCH', selectedHash === payloadSelectedHash
      && selectedHash === exactHashIdentity(sessionSet.candidate_hash)
      && selectedHash === planSelectedHash],
    ['SESSION_SET_HASH_MISMATCH', planSessionSetHash === exactHashIdentity(sessionSet.content_hash)],
    ['PLAN_SCHEMA_MISMATCH', plan.canonical_workout_schema_version === 1],
    ['PLAN_IDENTITY_MISMATCH', plan.plan_id === sessionSet.plan_id
      && plan.plan_revision === sessionSet.plan_revision
      && plan.plan_revision === assignmentPlanRevision
      && plan.plan_revision === state.activePlan?.planVersion],
    ['PLAN_DECISION_MISMATCH', plan.decision_id === sessionSet.decision_id
      && exactHashIdentity(plan.decision_hash) === exactHashIdentity(sessionSet.decision_hash)],
    ['PLAN_CANDIDATE_MISMATCH', plan.selected_candidate_id === sessionSet.candidate_id],
    ['PRESCRIPTION_HASH_MISMATCH', Boolean(expectedPrescriptionHash)
      && expectedPrescriptionHash === actualPrescriptionHash],
  ];
  const failedIdentityCheck = identityChecks.find(([, valid]) => !valid)?.[0];
  if (failedIdentityCheck) invalidGoalExpansionCarrySource(failedIdentityCheck);
  const reconstructed = planSchema.buildCanonicalPlanFromSessionSet(sessionSet);
  if (!reconstructed
    || canonicalStringify(plan.weeks) !== canonicalStringify(reconstructed.weeks)) {
    invalidGoalExpansionCarrySource('PLAN_SESSION_BYTES_MISMATCH');
  }
  return { plan, sessionSet };
}

function goalBackwardGoalExpansionCarryForwardMaterial(
  userId,
  state,
  activeAppliedPlan,
  activeSource,
  availableLocalDates,
) {
  if (state?.request?.operation === 'remove_race' || !activeAppliedPlan) return [];
  const plan = ownDataJsonSnapshot(activeAppliedPlan);
  if (!plan) invalidGoalExpansionCarrySource('PLAN_SNAPSHOT_INVALID');
  const declaresCanonicalSource = [
    plan.canonical_workout_schema_version,
    plan.canonical_session_set_hash,
    plan.selected_candidate_hash,
  ].some((value) => value !== null && value !== undefined);
  if (!declaresCanonicalSource) return [];
  const currentGoalIds = new Set((state.races || []).map((race) => (
    typeof race?.id === 'string' && race.id ? `goal-${race.id}` : null
  )));
  const activeGoals = Array.isArray(plan.goals) ? plan.goals : null;
  if (!currentGoalIds.size || currentGoalIds.has(null) || !activeGoals?.length) {
    invalidGoalExpansionCarrySource('GOAL_SET_INVALID');
  }
  const activeGoalIds = activeGoals.map((goal) => {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return null;
    const hasCamel = Object.hasOwn(goal, 'raceId') && goal.raceId !== null && goal.raceId !== undefined;
    const hasSnake = Object.hasOwn(goal, 'race_id') && goal.race_id !== null && goal.race_id !== undefined;
    if (!hasCamel && !hasSnake) return null;
    if (hasCamel && (typeof goal.raceId !== 'string' || !goal.raceId || goal.raceId.trim() !== goal.raceId)) return null;
    if (hasSnake && (typeof goal.race_id !== 'string' || !goal.race_id || goal.race_id.trim() !== goal.race_id)) return null;
    if (hasCamel && hasSnake && goal.raceId !== goal.race_id) return null;
    return `goal-${hasCamel ? goal.raceId : goal.race_id}`;
  });
  if (activeGoalIds.some((goalId) => goalId === null) || new Set(activeGoalIds).size !== activeGoalIds.length) {
    invalidGoalExpansionCarrySource('ACTIVE_GOAL_BINDING_INVALID');
  }
  const retainedGoalIds = new Set(activeGoalIds.filter((goalId) => currentGoalIds.has(goalId)));
  const addsGoal = [...currentGoalIds].some((goalId) => !activeGoalIds.includes(goalId));
  if (!addsGoal) return [];
  if (!retainedGoalIds.size) invalidGoalExpansionCarrySource('NO_RETAINED_GOAL');
  const { sessionSet } = authenticatedGoalExpansionSessionSet({
    userId,
    state,
    activeAppliedPlan: plan,
    activeSource,
  });
  const available = new Set(Array.isArray(availableLocalDates) ? availableLocalDates : []);
  if (!available.size || [...available].some((date) => !concurrentPlan.isValidISODate(date))) {
    invalidGoalExpansionCarrySource('PLACEMENT_WINDOW_INVALID');
  }
  const acceptedMaterialIds = new Set();
  const material = [];
  for (const session of sessionSet.sessions) {
    if (!available.has(session.scheduled_local_date) || !goalBackwardRemovalFamily(session)) continue;
    const id = goalBackwardMaterialId(session);
    const goalIds = canonicalCarryGoalIds(session);
    if (!id || acceptedMaterialIds.has(id) || !goalIds
      || goalIds.some((goalId) => !activeGoalIds.includes(goalId))) {
      invalidGoalExpansionCarrySource('SESSION_BINDING_INVALID');
    }
    if (goalIds.some((goalId) => !retainedGoalIds.has(goalId))) continue;
    const normalized = { ...session, goal_ids: goalIds, date: session.scheduled_local_date };
    delete normalized.goalIds;
    acceptedMaterialIds.add(id);
    material.push(Object.freeze(normalized));
  }
  return material;
}

function assertedCanonicalRemovalSourceIsValid(state, activeAppliedPlan) {
  if (state?.request?.operation !== 'remove_race' || !activeAppliedPlan) return true;
  const declaresCanonicalSource = [
    activeAppliedPlan.canonical_workout_schema_version,
    activeAppliedPlan.canonical_session_set_hash,
    activeAppliedPlan.selected_candidate_hash,
  ].some((value) => value !== null && value !== undefined);
  if (!declaresCanonicalSource) return true;
  return activeAppliedPlan.canonical_workout_schema_version === 1
    && isCanonicalHash(activeAppliedPlan.canonical_session_set_hash)
    && isCanonicalHash(activeAppliedPlan.selected_candidate_hash);
}

function goalBackwardProjectableRunningMaterial(session, family = legacyGoalBackwardFamily(session)) {
  if (GOAL_BACKWARD_PROJECTABLE_RUNNING_FAMILIES.has(family)) return true;
  return family === 'race'
    && String(session?.kind || '').toLowerCase() === 'hyrox'
    && session?.includesRun === true;
}

function goalBackwardMaterialRunningMeters(session) {
  const projectable = goalBackwardProjectableRunningMaterial(session);
  const direct = projectable
    ? session?.running_distance_m ?? session?.distance_m ?? session?.distanceMeters
    : session?.distance_m ?? session?.distanceMeters;
  if (Number.isFinite(direct) && direct >= 0) return direct;
  if (projectable) return 0;
  const miles = session?.distance_miles ?? session?.distanceMiles;
  return Number.isFinite(miles) && miles >= 0 ? Math.round(miles * 1609.344) : 0;
}

function goalBackwardTopUpFullWeekRunningMaterial(candidateMaterial, requiredRunningM, options = {}) {
  if (options.enabled !== true || !Number.isSafeInteger(requiredRunningM) || requiredRunningM < 1) {
    return candidateMaterial;
  }
  const completedRunningM = Number(options.completedRunningM || 0);
  const plannedRequirementM = Math.max(0, requiredRunningM - (
    Number.isSafeInteger(completedRunningM) && completedRunningM >= 0 ? completedRunningM : 0
  ));
  const source = Array.isArray(candidateMaterial) ? candidateMaterial : [];
  const currentRunningM = source.reduce((sum, session) => (
    sum + goalBackwardMaterialRunningMeters(session)
  ), 0);
  if (currentRunningM >= plannedRequirementM) return source;
  const adjustableIndexes = source.map((session, index) => ({
    family: legacyGoalBackwardFamily(session),
    index,
  })).filter(({ family }) => ['easy_run', 'recovery_run', 'long_aerobic'].includes(family));
  if (!adjustableIndexes.length) return source;
  const result = source.map((session) => ({ ...session }));
  const deficitMiles = (plannedRequirementM - currentRunningM) / 1609.344;
  const weights = adjustableIndexes.map(({ family }) => family === 'long_aerobic' ? 2 : 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let allocatedMiles = 0;
  adjustableIndexes.forEach(({ family, index }, position) => {
    const session = result[index];
    const currentMiles = goalBackwardMaterialRunningMeters(session) / 1609.344;
    const addition = position === adjustableIndexes.length - 1
      ? deficitMiles - allocatedMiles
      : deficitMiles * (weights[position] / totalWeight);
    allocatedMiles += addition;
    const nextMiles = Math.ceil((currentMiles + addition) * 10 - Number.EPSILON) / 10;
    result[index] = {
      ...session,
      distance_miles: nextMiles,
      duration_min: Math.max(
        Number(session.duration_min ?? session.durationMin ?? 0),
        family === 'long_aerobic' ? 30 : 25,
        Math.round(nextMiles * 11),
      ),
    };
    delete result[index].distance_m;
    delete result[index].distanceMeters;
  });
  return result;
}

function goalBackwardSupportRequirement(primaryRoles, family) {
  const exact = primaryRoles.find((role) => (role.any_of || []).includes(family));
  if (exact) return exact.requirement_id;
  const familyGroup = String(family || '').startsWith('hyrox_')
    ? 'hyrox'
    : GOAL_BACKWARD_RUNNING_FAMILIES.has(family) ? 'running' : null;
  if (familyGroup) {
    const related = primaryRoles.find((role) => (role.any_of || []).some((candidateFamily) => (
      familyGroup === 'hyrox'
        ? String(candidateFamily || '').startsWith('hyrox_')
        : GOAL_BACKWARD_RUNNING_FAMILIES.has(candidateFamily)
    )));
    if (related) return related.requirement_id;
  }
  return primaryRoles[0]?.requirement_id || null;
}

const goalBackwardRequiredRunningDoseSnapshots = new WeakSet();

function goalBackwardRequiredRunningDoseSnapshot(
  minimumWeeklyDemandM,
  materialPreservationM,
  removalActivePlanM,
  removalActivePlanState = 'NOT_APPLICABLE',
  removalActivePlanReason = null,
) {
  const snapshot = Object.create(null);
  Object.defineProperties(snapshot, {
    minimum_weekly_demand_m: { value: minimumWeeklyDemandM, enumerable: true },
    material_preservation_m: { value: materialPreservationM, enumerable: true },
    removal_active_plan_m: { value: removalActivePlanM, enumerable: true },
    removal_active_plan_state: { value: removalActivePlanState, enumerable: true },
    removal_active_plan_reason: { value: removalActivePlanReason, enumerable: true },
  });
  Object.freeze(snapshot);
  goalBackwardRequiredRunningDoseSnapshots.add(snapshot);
  return snapshot;
}

function invalidRequiredRunningDoseReceipt(reasonCodes, removalState = 'UNTRUSTED', removalReason = null) {
  const receipt = {
    schema_version: 1,
    valid: false,
    integralization_method: 'CEIL_TO_WHOLE_METER',
    raw_required_running_m: null,
    required_running_m: null,
    source_fields: Object.freeze([]),
    removal_active_plan_state: removalState,
    removal_active_plan_reason: removalReason,
    reason_codes: Object.freeze([...reasonCodes]),
  };
  return Object.freeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
}

function goalBackwardRequiredRunningDoseReceipt(input) {
  let trusted = false;
  try {
    trusted = typeof input === 'object'
      && input !== null
      && goalBackwardRequiredRunningDoseSnapshots.has(input);
  } catch {
    trusted = false;
  }
  if (!trusted) {
    return invalidRequiredRunningDoseReceipt([
      'REQUIRED_RUNNING_DOSE_INVALID',
      'REQUIRED_RUNNING_DOSE_INPUT_UNTRUSTED',
    ]);
  }
  const sources = [
    ['minimum_weekly_demand_m', input.minimum_weekly_demand_m],
    ['material_preservation_m', input.material_preservation_m],
    ['removal_active_plan_m', input.removal_active_plan_m],
  ];
  const provided = sources.filter(([, value]) => value !== null && value !== undefined);
  const sourceFields = provided.map(([field]) => field);
  const invalidSource = provided.some(([, value]) => (
    typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || value > Number.MAX_SAFE_INTEGER
  ));
  const removalState = input.removal_active_plan_state;
  const removalReason = input.removal_active_plan_reason;
  const removalStateValid = ['NOT_APPLICABLE', 'KNOWN', 'UNKNOWN'].includes(removalState);
  const removalContractInvalid = !removalStateValid
    || (removalState === 'KNOWN' && (
      input.removal_active_plan_m === null || input.removal_active_plan_m === undefined
        || removalReason !== null
    ))
    || (removalState === 'NOT_APPLICABLE' && (
      (input.removal_active_plan_m !== null && input.removal_active_plan_m !== undefined)
        || removalReason !== null
    ));
  const removalUnknown = removalState === 'UNKNOWN';
  const invalid = invalidSource || removalContractInvalid || removalUnknown;
  if (invalid) {
    const reasonCodes = ['REQUIRED_RUNNING_DOSE_INVALID'];
    if (removalUnknown) {
      reasonCodes.push(removalReason === 'RUNNING_DISTANCE_MALFORMED'
        ? 'REMOVAL_ACTIVE_PLAN_RUNNING_DISTANCE_MALFORMED'
        : 'REMOVAL_ACTIVE_PLAN_RUNNING_DISTANCE_UNKNOWN');
    } else if (removalContractInvalid) {
      reasonCodes.push('REMOVAL_ACTIVE_PLAN_RUNNING_DISTANCE_CONTRACT_INVALID');
    }
    return invalidRequiredRunningDoseReceipt(reasonCodes, removalState, removalReason);
  }
  const rawRequiredRunningM = Math.max(0, ...provided.map(([, value]) => value));
  const requiredRunningM = rawRequiredRunningM === null ? null : Math.ceil(rawRequiredRunningM);
  const valid = Number.isSafeInteger(requiredRunningM) && requiredRunningM >= 0;
  const reasonCodes = !valid
    ? ['REQUIRED_RUNNING_DOSE_INVALID']
    : requiredRunningM !== rawRequiredRunningM ? ['REQUIRED_RUNNING_DOSE_CEILED'] : [];
  const receipt = {
    schema_version: 1,
    valid,
    integralization_method: 'CEIL_TO_WHOLE_METER',
    raw_required_running_m: valid ? rawRequiredRunningM : null,
    required_running_m: valid ? requiredRunningM : null,
    source_fields: Object.freeze(sourceFields),
    removal_active_plan_state: removalState,
    removal_active_plan_reason: removalReason,
    reason_codes: Object.freeze(reasonCodes),
  };
  return Object.freeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
}

function goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest(...values) {
  return goalBackwardRequiredRunningDoseReceipt(goalBackwardRequiredRunningDoseSnapshot(...values));
}

function goalBackwardSupportingStimuli(candidateMaterial, primaryRoles, minimumRunningM, options = {}) {
  const primary = (Array.isArray(primaryRoles) ? primaryRoles : [])
    .filter((role) => role.role === 'PRIMARY_KEY');
  const usedMaterialIndexes = new Set();
  const requiredRunningM = Number(minimumRunningM);
  const trainingAgeClass = String(options.trainingAgeClass || '').toUpperCase();
  const presentationFloorMin = ['BEGINNER', 'RETURNING'].includes(trainingAgeClass) ? 20 : 25;
  const projectionPace = typeof options.projectionPaceSecondsPerMile === 'number'
    && Number.isFinite(options.projectionPaceSecondsPerMile)
    ? options.projectionPaceSecondsPerMile : null;
  const projectionPaceAvailable = projectionPace >= 180 && projectionPace <= 2400;
  const availableDaysCount = Number(options.availableDaysCount);
  const requestedRunDays = Number(options.requestedRunDays);
  const completedRunCount = Number(options.completedRunCount);
  const primaryRunningCount = primary.filter((role) => (role.any_of || []).some((family) => (
    GOAL_BACKWARD_RUNNING_FAMILIES.has(family)
      || GOAL_BACKWARD_PROJECTABLE_RUNNING_FAMILIES.has(family)
  ))).length;
  const requiredPlannedRunCount = Number.isSafeInteger(requestedRunDays) && requestedRunDays >= 0
    ? Math.max(0, requestedRunDays - (
      Number.isSafeInteger(completedRunCount) && completedRunCount >= 0 ? completedRunCount : 0
    ))
    : null;
  const availableSupportingCapacity = Number.isSafeInteger(availableDaysCount) && availableDaysCount >= 0
    ? Math.max(0, availableDaysCount - primary.length) : 0;
  const frequencySupportingCount = requiredPlannedRunCount !== null
    ? Math.max(0, requiredPlannedRunCount - primaryRunningCount) : 0;
  const maximumSupportingCount = requiredPlannedRunCount !== null
    ? Math.max(frequencySupportingCount, availableSupportingCapacity)
    : availableSupportingCapacity;
  let selectedRunningM = 0;
  let selectedRunningCount = 0;
  const supporting = [];
  for (const role of primary) {
    const materialIndex = candidateMaterial.findIndex((session, index) => (
      !usedMaterialIndexes.has(index) && (role.any_of || []).includes(legacyGoalBackwardFamily(session))
    ));
    if (materialIndex < 0) continue;
    usedMaterialIndexes.add(materialIndex);
    const selectedFamily = legacyGoalBackwardFamily(candidateMaterial[materialIndex]);
    if (GOAL_BACKWARD_RUNNING_FAMILIES.has(selectedFamily)
      || goalBackwardProjectableRunningMaterial(candidateMaterial[materialIndex], selectedFamily)) {
      selectedRunningM += goalBackwardMaterialRunningMeters(candidateMaterial[materialIndex]);
      selectedRunningCount += 1;
    }
  }
  const availableRunningMaterial = candidateMaterial.map((session, index) => {
    const sourceFamily = legacyGoalBackwardFamily(session);
    const hybridRunning = goalBackwardProjectableRunningMaterial(session, sourceFamily);
    const preserveHybridSession = options.preserveHybridSessions === true
      && sourceFamily === 'hyrox_compromised';
    const projectable = hybridRunning && !preserveHybridSession;
    const family = preserveHybridSession
      ? sourceFamily
      : GOAL_BACKWARD_RUNNING_FAMILIES.has(sourceFamily) && !projectable
      ? sourceFamily
      : projectable ? 'easy_run' : null;
    const runningM = goalBackwardMaterialRunningMeters(session);
    const directDuration = Number(session?.duration_min ?? session?.durationMin);
    const durationMin = Number.isFinite(directDuration) && directDuration >= 0
      ? directDuration
      : projectionPaceAvailable && runningM > 0
        ? (runningM / 1609.344) * projectionPace / 60 : null;
    return {
      durationMin,
      family,
      index,
      materialId: goalBackwardMaterialId(session),
      projectable,
      runningM,
      sourceFamily,
    };
  }).filter((entry) => (
    !usedMaterialIndexes.has(entry.index) && entry.family && entry.runningM > 0
  )).sort((left, right) => (
    right.runningM - left.runningM
      || left.family.localeCompare(right.family)
      || left.sourceFamily.localeCompare(right.sourceFamily)
      || left.index - right.index
  ));
  const exactRunningMaterial = availableRunningMaterial.filter((entry) => (
    !entry.projectable
  ));
  const usableExactRunningMaterial = exactRunningMaterial.filter(({ durationMin, family }) => (
    Number.isFinite(durationMin)
      && durationMin >= (family === 'long_aerobic' ? Math.max(30, presentationFloorMin) : presentationFloorMin)
  ));
  const projectableRunningMaterial = availableRunningMaterial.filter((entry) => entry.projectable);
  const projectedRunningM = projectableRunningMaterial.reduce((sum, entry) => sum + entry.runningM, 0);
  const projectedDurationMin = projectedRunningM > 0
    ? Math.ceil(((projectedRunningM / 1609.344) * projectionPace) / 60) : 0;
  const exactCapacityM = usableExactRunningMaterial.slice(0, maximumSupportingCount)
    .reduce((sum, entry) => sum + entry.runningM, 0);
  const projectedCapacityM = projectedRunningM
    + usableExactRunningMaterial.slice(0, Math.max(0, maximumSupportingCount - 1))
      .reduce((sum, entry) => sum + entry.runningM, 0);
  const projectionCanHelp = projectionPaceAvailable && projectableRunningMaterial.length > 0
    && projectedDurationMin >= presentationFloorMin
    && projectedCapacityM > exactCapacityM
    && (selectedRunningM < requiredRunningM
      || (requiredPlannedRunCount !== null && selectedRunningCount < requiredPlannedRunCount));
  const exactSlots = Math.max(0, maximumSupportingCount - (projectionCanHelp ? 1 : 0));
  for (const { family, materialId, runningM } of usableExactRunningMaterial) {
    const needsDose = Number.isSafeInteger(requiredRunningM) && requiredRunningM >= 0
      && selectedRunningM < requiredRunningM;
    const needsFrequency = requiredPlannedRunCount !== null
      && selectedRunningCount < requiredPlannedRunCount;
    if (!Number.isSafeInteger(requiredRunningM) || requiredRunningM < 0
      || (!needsDose && !needsFrequency) || supporting.length >= exactSlots) continue;
    const supportsRequirementId = goalBackwardSupportRequirement(primary, family);
    supporting.push({
      requirement_id: `current-candidate-support-${supporting.length + 1}`,
      any_of: [family],
      role: 'SUPPORTING',
      ...(materialId ? { candidate_material_id: materialId } : {}),
      ...(supportsRequirementId ? { supports_requirement_id: supportsRequirementId } : {}),
    });
    selectedRunningM += runningM;
    selectedRunningCount += 1;
  }
  if (Number.isSafeInteger(requiredRunningM) && requiredRunningM >= 0
    && (selectedRunningM < requiredRunningM
      || (requiredPlannedRunCount !== null && selectedRunningCount < requiredPlannedRunCount))
    && supporting.length < maximumSupportingCount
    && projectionCanHelp) {
    // Projection consumes the selected recorded running component in full;
    // it never manufactures a token-sized remainder to hit the floor.
    if (projectableRunningMaterial.length) {
      const supportsRequirementId = goalBackwardSupportRequirement(primary, 'easy_run');
      const projectionBindingId = projectableRunningMaterial[0].materialId;
      supporting.push({
        requirement_id: `current-candidate-support-${supporting.length + 1}`,
        any_of: ['easy_run'],
        role: 'SUPPORTING',
        ...(projectionBindingId ? { candidate_material_id: projectionBindingId } : {}),
        ...(supportsRequirementId ? { supports_requirement_id: supportsRequirementId } : {}),
      });
    }
  }
  return supporting;
}

function goalBackwardGoalsForState(userId, state) {
  if (!state.races?.length) {
    return [{
      goal_id: `foundation-${prefixedHash(userId).slice(-24)}`,
      athlete_id: userId,
      priority: 'A',
      goal_type: 'completion',
      event_state: 'UNKNOWN',
    }];
  }
  return state.races.map((race, index) => {
    const lifecycle = raceLifecycleForPlanning(race);
    return {
      goal_id: `goal-${String(race.id)}`,
      race_id: String(race.id),
      athlete_id: userId,
      priority: ['A', 'B', 'C'][Math.min(index, 2)],
      goal_type: Number(race.goal_time_seconds || 0) > 0 ? 'performance' : 'completion',
      event_kind: goalBackwardEventKind(race, state),
      event_local_date: race.event_local_date || race.race_date,
      location: race.location || null,
      event_state: lifecycle.event_state,
      event_revision: lifecycle.event_revision,
      transition_exit_met: lifecycle.transition_exit_met,
      source_revision: lifecycle.goal_revision,
      distance_miles: Number(race.distance_miles || 0) || null,
      target_time_s: Number(race.goal_time_seconds || 0) > 0 ? Number(race.goal_time_seconds) : null,
    };
  });
}

function computeGoalBackwardShadowDiagnostics({ userId, state, built, planningDateLocal }, dependencies = {}) {
  const clusterPolicy = built.plan?.hyroxPolicy?.partialRaceOrderCluster || null;
  const selectedClusterWeek = Number.isInteger(clusterPolicy?.selectedWeekIndex)
    ? built.plan?.weeks?.[clusterPolicy.selectedWeekIndex] : null;
  const preferredWeekdays = new Set((state.target?.trainingDays || []).map((value) => String(value).slice(0, 3)));
  const clusterWeekDates = (selectedClusterWeek?.days || [])
    .filter((day) => day.date >= planningDateLocal && (!preferredWeekdays.size || preferredWeekdays.has(day.day)))
    .map((day) => day.date);
  const availableLocalDates = clusterPolicy?.required === true && clusterWeekDates.length
    ? clusterWeekDates
    : goalBackwardAvailableLocalDates(state, planningDateLocal);
  const trainingAgeClass = goalBackwardTrainingAge(state.context);
  const evidenceSnapshotId = `snapshot-${state.inputHash.slice(-24)}`;
  const completedRunningCredit = goalBackwardCompletedRunningCredit(
    state.context,
    planningDateLocal,
    evidenceSnapshotId,
  );
  const scopedRecovery = deriveScopedRecoveryState({
    planning_date_local: planningDateLocal,
    candidate_window_end_local: addPolicyDays(planningDateLocal, 6),
    timezone: state.context?.profile?.timezone || 'UTC',
    evidence_snapshot_id: evidenceSnapshotId,
    context: state.context,
  });
  const recoveryState = scopedRecovery.recovery_state;
  const safetyState = {
    action: scopedRecovery.safety_action,
    scope: scopedRecovery.scopes,
    reason_codes: scopedRecovery.reason_codes,
    receipt_hash: scopedRecovery.receipt_hash,
  };
  const safetyAction = safetyState.action;
  const recentRunCount = Number(state.context?.history?.recentRunCount || 0);
  const weeklyMiles = nullableNonNegativeNumber(state.context?.history?.weeklyMileageBaseline, 300);
  const observedLowerBoundWeeklyMiles = nullableNonNegativeNumber(
    state.context?.history?.mileageBaseline?.observedLowerBoundWeeklyMiles,
    300,
  );
  const runningLoadAnchorMiles = weeklyMiles ?? observedLowerBoundWeeklyMiles;
  const runLoadInput = state.context?.history?.runLoadInput || null;
  const hasCanonicalLoadContract = Boolean(runLoadInput);
  const runLoadComplete = !hasCanonicalLoadContract
    || ['COMPLETE', 'VALID_ZERO'].includes(String(runLoadInput?.load_input_state || '').toUpperCase());
  const canonicalRecentNormal = runLoadInput?.recent_normal || null;
  const recentNormalStatus = !hasCanonicalLoadContract
      ? (runningLoadAnchorMiles > 0 ? (recentRunCount >= 8 ? 'ESTABLISHED' : 'PROVISIONAL') : 'INSUFFICIENT')
    : runLoadComplete
      ? String(canonicalRecentNormal?.status || 'INSUFFICIENT').toUpperCase()
      : runningLoadAnchorMiles > 0 && recentRunCount >= 3 ? 'PROVISIONAL' : 'INSUFFICIENT';
  const consistencyState = recentNormalStatus === 'TRAINING_GAP'
    ? 'RETURNING'
    : runLoadComplete ? (recentRunCount >= 4 ? 'CONSISTENT' : 'SPARSE_DATA') : 'UNKNOWN';
  const goals = goalBackwardGoalsForState(userId, state);
  const primaryEventDate = goals[0]?.event_local_date || null;
  const buildDecision = dependencies.buildDecision || buildGoalBackwardPlanningDecision;
  const enumerateCandidates = dependencies.enumerateCandidates || enumerateGoalBackwardCandidates;
  const decisionInput = {
    athlete_id: userId,
    planning_date_local: planningDateLocal,
    created_at: `${planningDateLocal}T00:00:00.000Z`,
    timezone: state.context?.profile?.timezone || 'UTC',
    plan_id: state.activePlan?.trainingPlanId || null,
    plan_revision: Number(state.activePlan?.planVersion || 0),
    athlete_state: {
      athlete_state_revision: Math.max(1, Number(state.planningInputRevision || 1)),
      evidence_snapshot_id: evidenceSnapshotId,
      training_age_class: trainingAgeClass,
      consistency_state: consistencyState,
      consistent_weeks: runLoadComplete && recentRunCount >= 4 ? 4 : 0,
      recovery_state: recoveryState,
      safety_action: safetyAction,
      safety_scope: safetyState.scope,
      safety_reason_codes: safetyState.reason_codes,
      safety_receipt_hash: safetyState.receipt_hash,
      recent_normal_running: {
        status: recentNormalStatus,
        median_distance_m: recentNormalStatus !== 'INSUFFICIENT'
          ? (runLoadComplete ? canonicalRecentNormal?.median_distance_m : null)
            ?? (runningLoadAnchorMiles === null ? null : Math.round(runningLoadAnchorMiles * 1609.344))
          : null,
        observed_lower_bound_distance_m: observedLowerBoundWeeklyMiles === null
          ? null : Math.round(observedLowerBoundWeeklyMiles * 1609.344),
        confidence: runLoadInput?.recent_normal_confidence || 'INSUFFICIENT',
        load_input_confidence: runLoadInput?.load_input_confidence || 'INSUFFICIENT',
        load_input_state: runLoadInput?.load_input_state || 'UNKNOWN',
        exact_window_totals: runLoadInput?.windows || [],
        identity_decision_receipt: runLoadInput?.identity_decision_receipt || null,
        canonical_recent_normal: runLoadInput?.recent_normal || null,
        unresolved_conflicts: runLoadInput?.unresolved_conflicts || [],
        reason_codes: runLoadInput?.reason_codes || ['EVIDENCE_UNKNOWN'],
      },
      available_days: availableLocalDates,
      locks: state.planningConstraints?.locks || [],
      manual_edits: state.planningConstraints?.manual_edits || [],
      lock_revision: state.planningConstraints?.lock_revision || 0,
      edit_revision: state.planningConstraints?.edit_revision || 0,
      constraint_fingerprint: state.planningConstraints?.constraint_fingerprint || null,
    },
    goals,
    races: state.races.map((race) => ({ race_id: String(race.id), athlete_id: userId })),
    evidence_used: [{ evidence_id: evidenceSnapshotId, purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
    // C1 phase routing still owns this historic gate. C2 supplies the separate
    // fail-closed load state/status above; it must not turn missing coverage
    // into established recent-normal evidence.
    development_gate_complete: recentRunCount >= 4,
    full_pre_taper_weeks: clusterPolicy?.fullPreTaperWeeks,
    mandatory_hyrox_cluster: clusterPolicy?.required === true,
    transition_exit_met: goals[0]?.transition_exit_met === true,
    planning_constraints: state.planningConstraints,
    safety_or_recovery_hold: clusterPolicy?.unplaceableReason === 'SAFETY_RECOVERY_HOLD',
    supporting_stimuli: clusterPolicy?.required === true && clusterWeekDates.length >= 5 ? [
      {
        requirement_id: 'hyrox_cluster_easy_aerobic_1',
        any_of: ['easy_run'],
        role: 'SUPPORTING',
        supports_requirement_id: goals[0]?.event_kind === 'HYROX_DOUBLES'
          ? 'hyrox_team_partial_simulation' : 'hyrox_partial_simulation',
      },
      {
        requirement_id: 'hyrox_cluster_easy_aerobic_2',
        any_of: ['easy_run'],
        role: 'SUPPORTING',
        supports_requirement_id: 'long_aerobic',
      },
    ] : [],
  };
  let decision = buildDecision(decisionInput);
  const stableActivePlan = state.request?.operation === 'remove_race'
    ? state.removalPlanSnapshot
    : (state.active ? parsePlan(state.active.row) : null);
  const activeAppliedPlan = state.active && stableActivePlan ? {
    ...stableActivePlan,
    plan_revision: Math.max(1, Number(state.activePlan?.planVersion || state.active.row?.plan_version || 1)),
  } : null;
  if (!assertedCanonicalRemovalSourceIsValid(state, activeAppliedPlan)) {
    const error = new Error('The active canonical plan cannot authorize removal carry-forward.');
    error.code = 'REMOVAL_CARRY_FORWARD_SOURCE_INVALID';
    throw error;
  }
  const boundedCandidateMaterial = clusterPolicy?.required === true && selectedClusterWeek
    ? goalBackwardCandidateMaterial({ weeks: [selectedClusterWeek] }, availableLocalDates)
    : goalBackwardCandidateMaterial(built.plan, availableLocalDates);
  const completeCandidateMaterial = goalBackwardCandidateMaterial(built.plan, null);
  const planningWeekStartLocal = concurrentPlan.racePlanWindow(
    planningDateLocal,
    planningDateLocal,
  )?.startDate;
  const baseCandidateMaterial = decision.phase === 'DEVELOPMENT'
    && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass)
    && (completedRunningCredit || planningDateLocal !== planningWeekStartLocal)
    ? completeCandidateMaterial
    : boundedCandidateMaterial.length ? boundedCandidateMaterial : completeCandidateMaterial;
  const carriedRemovalMaterial = clusterPolicy?.required === true
    ? [] : goalBackwardRemovalCarryForwardMaterial(state, activeAppliedPlan, availableLocalDates);
  const carriedGoalExpansionMaterial = clusterPolicy?.required === true
    ? [] : goalBackwardGoalExpansionCarryForwardMaterial(
      userId,
      state,
      activeAppliedPlan,
      state.activeCanonicalCarryForwardSource,
      availableLocalDates,
    );
  const carriedLifecycleMaterial = [...carriedRemovalMaterial, ...carriedGoalExpansionMaterial];
  const carriedLifecycleMaterialIds = new Set(carriedLifecycleMaterial.map(goalBackwardMaterialId));
  let candidateMaterial = [
    ...carriedLifecycleMaterial,
    ...baseCandidateMaterial.filter((session) => (
      !carriedLifecycleMaterialIds.has(goalBackwardMaterialId(session))
    )),
  ];
  let requiredRunningDoseReceipt = null;
  if (clusterPolicy?.required !== true) {
    const projectionPaceSecondsPerMile =
      state.context?.history?.acuteRunLoad?.latestRun?.paceSecondsPerMile ?? null;
    const validRecentNormalComparator = ['ESTABLISHED', 'PROVISIONAL', 'TRAINING_GAP']
      .includes(String(decisionInput.athlete_state.recent_normal_running.status || '').toUpperCase())
      && ['HIGH', 'MEDIUM', 'LOW'].includes(String(
        decisionInput.athlete_state.recent_normal_running.confidence || ''
      ).toUpperCase())
      ? decisionInput.athlete_state.recent_normal_running.median_distance_m : null;
    const activeRunningObservation = activeAppliedPlan ? runningDistanceObservation(activeAppliedPlan, {
      start: planningDateLocal,
      end: addPolicyDays(planningDateLocal, 6),
    }) : null;
    const materialPreservationMinimumRunningM = hasCanonicalLoadContract
      ? minimumRunningDoseWithoutMaterialReduction([
        validRecentNormalComparator,
        activeRunningObservation?.state === 'KNOWN' ? activeRunningObservation.distance_m : null,
        observedLowerBoundWeeklyMiles === null
          ? null : Math.round(observedLowerBoundWeeklyMiles * 1609.344),
      ]) : null;
    const activeRemovalSourceRequired = state?.request?.operation === 'remove_race'
      && Boolean(activeAppliedPlan);
    requiredRunningDoseReceipt = goalBackwardRequiredRunningDoseReceipt(
      goalBackwardRequiredRunningDoseSnapshot(
        decision.minimum_weekly_demand?.running_m ?? null,
        materialPreservationMinimumRunningM,
        activeRemovalSourceRequired && activeRunningObservation?.state === 'KNOWN'
          ? activeRunningObservation.distance_m : null,
        activeRemovalSourceRequired
          ? (activeRunningObservation?.state || 'UNKNOWN') : 'NOT_APPLICABLE',
        activeRemovalSourceRequired ? (activeRunningObservation?.reason || null) : null,
      ),
    );
    if (!requiredRunningDoseReceipt.valid) {
      const error = new Error('Required running dose could not be normalized safely.');
      error.code = 'REQUIRED_RUNNING_DOSE_INVALID';
      error.details = requiredRunningDoseReceipt;
      error.required_running_dose_receipt = requiredRunningDoseReceipt;
      throw error;
    }
    const requiredRunningM = requiredRunningDoseReceipt.required_running_m;
    candidateMaterial = goalBackwardTopUpFullWeekRunningMaterial(
      candidateMaterial,
      requiredRunningM,
      {
        enabled: planningDateLocal === planningWeekStartLocal
          && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass)
          && ['NORMAL', 'MONITOR'].includes(safetyAction)
          && String(goals[0]?.event_kind || '').startsWith('HYROX'),
        completedRunningM: completedRunningCredit?.completed_running_m || 0,
      },
    );
    const supportCandidateMaterial = canonicalRoadCandidateMaterial(
      candidateMaterial,
      projectionPaceSecondsPerMile,
    ).map((material) => ({
      ...material.source_session,
      session_id: material.material_id,
      workout_family: material.workout_family,
      duration_min: material.duration_min,
      distance_m: material.distance_m,
      distance_miles: material.distance_miles,
    }));
    const supportingStimuli = goalBackwardSupportingStimuli(
      supportCandidateMaterial,
      decision.role_multiset,
      requiredRunningM,
      {
        availableDaysCount: availableLocalDates.length,
        requestedRunDays: planningDateLocal === planningWeekStartLocal
          && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass)
          ? state.target?.runDaysPerWeek : undefined,
        completedRunCount: planningDateLocal === planningWeekStartLocal
          && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass)
          && completedRunningCredit
          ? state.context?.history?.acuteRunLoad?.currentWeek?.runCount : 0,
        preserveHybridSessions: planningDateLocal === planningWeekStartLocal
          && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass),
        projectionPaceSecondsPerMile,
        trainingAgeClass,
      },
    );
    if (supportingStimuli.length) {
      decision = buildDecision({ ...decisionInput, supporting_stimuli: supportingStimuli });
    }
  }
  const crossModalReductionEvidence = normalizeCrossModalReductionEvidence(
    state.context?.history?.crossModalReductionEvidence,
    {
      athlete_id: userId,
      athlete_state_revision: decisionInput.athlete_state.athlete_state_revision,
      evidence_snapshot_id: evidenceSnapshotId,
    },
  );
  const materialReductionScope = deriveMaterialReductionScope({
    planning_date_local: planningDateLocal,
    candidate_window_end_local: addPolicyDays(planningDateLocal, 6),
    timezone: decision.timezone,
    evidence_snapshot_id: evidenceSnapshotId,
    decision,
    scoped_recovery_state: scopedRecovery,
    recent_normal_running: decisionInput.athlete_state.recent_normal_running,
    load_evidence_ids: [
      runLoadInput?.load_input_hash,
      runLoadInput?.correction_receipt_hash,
      runLoadInput?.identity_decision_receipt?.receipt_hash,
    ].filter(Boolean),
    cross_modal_reduction_evidence: crossModalReductionEvidence,
    measured_running_ceiling_m: crossModalReductionEvidence.valid
      ? crossModalReductionEvidence.measured_running_ceiling_m : null,
  });
  const crossModalFatigueCeilings = crossModalReductionEvidence.valid ? {
    dimensions: Object.fromEntries(crossModalReductionEvidence.dimension_ledger.dimensions.map((entry) => [
      entry.dimension,
      {
        dimension: entry.dimension,
        status: entry.status,
        confidence: entry.confidence,
        normal_ceiling: entry.normal_ceiling,
        authorized_ceiling: entry.authorized_ceiling,
      },
    ])),
    normal_ceiling_vector: crossModalReductionEvidence.dimension_ledger.dimensions
      .map((entry) => entry.normal_ceiling),
    authorized_ceiling_vector: crossModalReductionEvidence.dimension_ledger.dimensions
      .map((entry) => entry.authorized_ceiling),
  } : null;
  const result = enumerateCandidates({
    decision,
    available_local_dates: availableLocalDates,
    maximum_session_count: decision.role_multiset.length,
    maximum_sessions_per_day: planningDateLocal === planningWeekStartLocal
      && ['ESTABLISHED', 'ADVANCED'].includes(trainingAgeClass)
      && state.target?.runDaysPerWeek === availableLocalDates.length
      && decision.role_multiset.some((role) => (
        role.role === 'PRIMARY_KEY'
          && (role.any_of || []).some((family) => String(family).startsWith('hyrox_station_'))
      )) ? 2 : undefined,
    legacy_road_candidate_material: candidateMaterial,
    active_applied_plan: activeAppliedPlan,
    preferred_weekdays: state.target?.trainingDays || [],
    selected_running_volume_m: decision.proposed_running_volume_m,
    // C3 consumes only the canonical C2 load contract. Legacy/synthetic states
    // without that contract retain the pre-C3 path rather than fabricating a
    // complete recent-normal comparator.
    material_dose_enforced: hasCanonicalLoadContract,
    hybrid_running_projection_pace_s_per_mile:
      state.context?.history?.acuteRunLoad?.latestRun?.paceSecondsPerMile ?? null,
    mandatory_hyrox_cluster: decision.mandatory_hyrox_cluster === true,
    previous_two_weeks_passed: state.context?.history?.previousTwoWeeksPassed === true,
    modality_history: state.context?.history?.modalityHistory
      ?? state.context?.history?.modality_history
      ?? state.context?.history?.crossModalRecentNormal
      ?? state.context?.history?.cross_modal_recent_normal
      ?? {},
    ...(crossModalFatigueCeilings ? { fatigue_ceilings: crossModalFatigueCeilings } : {}),
    materialize_canonical: true,
    planning_instant: `${planningDateLocal}T00:00:00.000Z`,
    timezone: state.context?.profile?.timezone || decision.timezone || 'UTC',
    validation_options: {
      available_local_dates: availableLocalDates,
      available_days_count: availableLocalDates.length,
      training_age_class: trainingAgeClass,
      consistency_state: decision.consistency_state,
      recovery_state: recoveryState,
      safety_action: safetyAction,
      event_local_date: primaryEventDate,
      mandatory_hyrox_cluster: decision.mandatory_hyrox_cluster === true,
      minimum_weekly_demand: decision.minimum_weekly_demand,
      recent_normal_running: {
        ...decisionInput.athlete_state.recent_normal_running,
        evidence_ids: [evidenceSnapshotId],
      },
      observed_lower_bound_running_m: observedLowerBoundWeeklyMiles === null
        ? null : Math.round(observedLowerBoundWeeklyMiles * 1609.344),
      observed_lower_bound_evidence_ids: observedLowerBoundWeeklyMiles === null
        ? [] : [evidenceSnapshotId],
      material_reduction_scope: materialReductionScope,
      completed_running_credit: completedRunningCredit,
      cross_modal_reduction_evidence: crossModalReductionEvidence,
      cross_modal_evidence_ids: crossModalReductionEvidence.valid
        ? crossModalReductionEvidence.decisive_evidence_ids : [],
    },
  });
  const inspectedResult = requiredRunningDoseReceipt
    ? { ...result, required_running_dose_receipt: requiredRunningDoseReceipt }
    : result;
  if (typeof dependencies.inspectDecision === 'function') dependencies.inspectDecision(inspectedResult);
  return inspectedResult;
}

function buildGoalBackwardArtifacts(input = {}) {
  const artifacts = buildGoalBackwardDecisionArtifacts(input);
  const selected = (input.candidates || []).find((candidate) => (
    candidate.candidate_skeleton_id === input.decision?.selected_candidate_id
  ));
  const sessionSet = selected?.canonical_session_set;
  if (!selected?.canonical_sessions_materialized || !sessionSet) return artifacts;
  const canonicalIndex = artifacts.findIndex((artifact) => artifact.artifact_kind === 'canonical_session_set');
  const surfaceIndex = artifacts.findIndex((artifact) => artifact.artifact_kind === 'surface_manifest');
  if (canonicalIndex < 1 || surfaceIndex !== canonicalIndex + 1) return artifacts;
  const prior = artifacts[canonicalIndex];
  const canonicalArtifact = buildPipelineArtifact({
    userId: prior.user_id,
    kind: prior.artifact_kind,
    decisionId: prior.decision_id,
    parentArtifactId: artifacts[canonicalIndex - 1].id,
    planGenerationCandidateId: prior.plan_generation_candidate_id,
    schemaVersion: prior.schema_version,
    policyVersion: prior.policy_version,
    revision: prior.revision,
    createdAt: prior.created_at,
    payload: {
      plan_generation_candidate_ref: prior.payload_json.plan_generation_candidate_ref,
      ...sessionSet,
      selected_candidate_id: selected.candidate_skeleton_id,
      selected_candidate_hash: selected.candidate_hash,
    },
  });
  const priorSurface = artifacts[surfaceIndex];
  const surfaceManifest = buildCanonicalSurfaceManifest({
    featureMode: input.featureMode || priorSurface.payload_json.feature_mode || 'shadow',
    surfaceRevision: input.surfaceRevision || priorSurface.revision,
    candidateRevision: input.candidateRevision || 1,
    athleteStateRevision: input.athleteStateRevision || input.decision?.athlete_state_revision || 1,
    safetyStateHash: input.safetyStateHash || prefixedHash(input.decision?.safety_state || {}),
    goalRevisions: input.goalRevisions || Object.fromEntries((input.decision?.active_goals || []).map((goal) => [
      String(goal.goal_id),
      Math.max(1, Number(goal.source_revision || 1)),
    ])),
    decision: input.decision,
    selectedCandidate: selected,
    canonicalSessionSet: sessionSet,
    plan: input.plan,
    planGenerationCandidateRef: priorSurface.payload_json.plan_generation_candidate_ref,
    currentCandidateHash: input.currentCandidateHash,
  });
  const surfaceArtifact = buildPipelineArtifact({
    userId: priorSurface.user_id,
    kind: priorSurface.artifact_kind,
    decisionId: priorSurface.decision_id,
    parentArtifactId: canonicalArtifact.id,
    planGenerationCandidateId: priorSurface.plan_generation_candidate_id,
    schemaVersion: priorSurface.schema_version,
    policyVersion: priorSurface.policy_version,
    revision: priorSurface.revision,
    createdAt: priorSurface.created_at,
    payload: surfaceManifest || priorSurface.payload_json,
  });
  return assertPipelineLinks([
    ...artifacts.slice(0, canonicalIndex),
    canonicalArtifact,
    surfaceArtifact,
  ]);
}

function buildCanonicalSurfaceManifest(input = {}) {
  const featureMode = String(input.featureMode || 'off');
  if (featureMode === 'off') return null;
  if (featureMode === 'shadow') {
    return {
      plan_generation_candidate_ref: input.planGenerationCandidateRef || null,
      feature_mode: 'shadow',
      authoritative_engine: 'current',
      current_candidate_hash: input.currentCandidateHash || null,
      v24_surface_enabled: false,
    };
  }
  if (!['preview', 'on'].includes(featureMode)) return null;
  const sessionSet = input.canonicalSessionSet;
  const decision = input.decision || {};
  const selected = input.selectedCandidate || {};
  const plan = input.plan || {};
  if (!sessionSet || !Array.isArray(sessionSet.sessions) || !sessionSet.sessions.length) return null;
  const purpose = String(
    input.purpose
      || plan.purpose
      || (Array.isArray(plan.weeks) ? plan.weeks.find((week) => String(week?.purpose || '').trim())?.purpose : '')
      || '',
  ).trim();
  const feasibilityStatus = String(input.feasibilityStatus || plan.overall_feasibility || '').trim();
  const feasibilityReasonCodes = Array.isArray(input.feasibilityReasonCodes)
    ? input.feasibilityReasonCodes
    : Array.isArray(plan.reasons) ? plan.reasons : [];
  const safetyState = decision.safety_state && typeof decision.safety_state === 'object'
    ? decision.safety_state : {};
  const weeks = (Array.isArray(plan.weeks) ? plan.weeks : []).map((week, index) => ({
    week: Math.max(1, Number(week?.week || index + 1)),
    start_date: String(week?.startDate || week?.start_date || ''),
    phase: String(week?.phase || ''),
    purpose: String(week?.purpose || week?.weekPurpose || week?.week_purpose || ''),
  }));
  return {
    schema_version: 'goal_backward_surface_manifest_v1',
    surface_revision: Math.max(1, Number(input.surfaceRevision || 1)),
    feature_mode: featureMode,
    v24_surface_enabled: true,
    status: 'accepted',
    identity: {
      decision_id: String(sessionSet.decision_id || decision.decision_id || ''),
      decision_hash: String(sessionSet.decision_hash || decision.decision_hash || ''),
      candidate_id: String(sessionSet.candidate_id || selected.candidate_skeleton_id || ''),
      candidate_revision: Math.max(1, Number(input.candidateRevision || 1)),
      candidate_hash: String(sessionSet.candidate_hash || selected.candidate_hash || ''),
      plan_id: String(sessionSet.plan_id || ''),
      plan_revision: Math.max(1, Number(sessionSet.plan_revision || 1)),
      canonical_session_set_hash: String(sessionSet.content_hash || ''),
      athlete_state_revision: Math.max(1, Number(input.athleteStateRevision || decision.athlete_state_revision || 1)),
      safety_state_hash: String(input.safetyStateHash || prefixedHash(safetyState)),
      goal_revisions: input.goalRevisions && typeof input.goalRevisions === 'object' ? input.goalRevisions : {},
    },
    purpose,
    feasibility: {
      status: feasibilityStatus,
      reason_codes: [...new Set(feasibilityReasonCodes.map(String).filter(Boolean))],
    },
    safety: {
      action: String(safetyState.action || 'NORMAL'),
      scope: Array.isArray(safetyState.scope) ? safetyState.scope : [],
      reason_codes: Array.isArray(safetyState.reason_codes) ? safetyState.reason_codes : [],
    },
    weeks,
    sessions: sessionSet.sessions,
  };
}

function surfaceMismatchManifest(candidate = {}, payload = null) {
  return {
    schema_version: 'goal_backward_surface_manifest_v1',
    surface_revision: Math.max(1, Number(candidate.surface_revision || payload?.surface_revision || 1)),
    feature_mode: String(candidate.feature_mode || payload?.feature_mode || 'on'),
    v24_surface_enabled: true,
    status: 'blocked',
    reason_codes: ['SURFACE_REVISION_MISMATCH'],
    identity: payload?.identity && typeof payload.identity === 'object' ? payload.identity : null,
    sessions: [],
  };
}

function surfaceManifestAppliedPlanDiagnostic(manifest, candidate = {}, activeRow = null, canonicalSessionSet = null) {
  const identity = manifest?.identity;
  const hashIdentity = (value) => String(value || '').replace(/^sha256:/, '');
  const diagnosticHash = (value) => {
    const normalized = hashIdentity(value).toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? `sha256:${normalized}` : null;
  };
  const diagnosticRevision = (value) => {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  };
  const closedStatus = (value, allowed) => {
    const normalized = String(value || '').toLowerCase();
    return allowed.includes(normalized) ? normalized.toUpperCase() : 'UNKNOWN';
  };
  const activePlan = parsePlan(activeRow) || {};
  const candidateGoalRevisions = parseJsonValue(candidate.goal_revisions_json, {});
  const activeWeeks = (Array.isArray(activePlan.weeks) ? activePlan.weeks : []).map((week, index) => ({
    week: Math.max(1, Number(week?.week || index + 1)),
    start_date: String(week?.startDate || week?.start_date || ''),
    phase: String(week?.phase || ''),
    purpose: String(week?.purpose || week?.weekPurpose || week?.week_purpose || ''),
  }));
  const activePurpose = String(
    activePlan.purpose
      || activeWeeks.find((week) => week.purpose)?.purpose
      || '',
  ).trim();
  const identityPresent = Boolean(identity && typeof identity === 'object' && !Array.isArray(identity));
  const canonicalPresent = Boolean(
    canonicalSessionSet && typeof canonicalSessionSet === 'object' && !Array.isArray(canonicalSessionSet)
  );
  const candidateStatus = closedStatus(candidate.status, ['preview', 'applied', 'rejected', 'superseded']);
  const assignmentStatus = closedStatus(activeRow?.status, ['active', 'superseded', 'cleared']);
  const assignmentLinked = Boolean(candidate.applied_user_plan_id && activeRow?.user_plan_id)
    && String(candidate.applied_user_plan_id) === String(activeRow.user_plan_id);
  const appliedPlanLinked = Boolean(candidate.applied_training_plan_id && activeRow?.plan_id)
    && String(candidate.applied_training_plan_id) === String(activeRow.plan_id);
  const predicateEntries = [
    ['SURFACE_ARTIFACT_PRESENT', Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest))],
    ['CANDIDATE_BINDING_PRESENT', Boolean(candidate.id)],
    ['ASSIGNMENT_PRESENT', Boolean(activeRow && typeof activeRow === 'object' && !Array.isArray(activeRow))],
    ['CANDIDATE_STATUS_APPLIED', candidateStatus === 'APPLIED'],
    ['ASSIGNMENT_STATUS_ACTIVE', assignmentStatus === 'ACTIVE'],
    ['ASSIGNMENT_LINK_MATCH', assignmentLinked],
    ['APPLIED_PLAN_LINK_MATCH', appliedPlanLinked],
    ['SURFACE_SCHEMA_MATCH', manifest?.schema_version === 'goal_backward_surface_manifest_v1'],
    ['SURFACE_STATUS_ACCEPTED', manifest?.status === 'accepted'],
    ['SURFACE_ENABLED', manifest?.v24_surface_enabled === true],
    ['SURFACE_MODE_APPLICABLE', ['preview', 'on'].includes(String(manifest?.feature_mode || ''))],
    ['SURFACE_IDENTITY_PRESENT', identityPresent],
    ['SURFACE_SESSIONS_PRESENT', Array.isArray(manifest?.sessions) && manifest.sessions.length > 0],
    ['SURFACE_REVISION_MATCH', Number(manifest?.surface_revision) === Number(candidate.surface_revision)],
    ['CANDIDATE_REVISION_MATCH', Number(identity?.candidate_revision) === Number(candidate.candidate_revision)],
    ['CANDIDATE_DECISION_MATCH', String(identity?.decision_id || '') === String(candidate.decision_id || '')],
    ['CANDIDATE_CONTENT_HASH_MATCH', hashIdentity(identity?.candidate_hash) === hashIdentity(candidate.selected_candidate_hash)],
    ['ATHLETE_STATE_REVISION_MATCH', Number(identity?.athlete_state_revision) === Number(candidate.athlete_state_revision)],
    ['SAFETY_STATE_HASH_MATCH', String(identity?.safety_state_hash || '') === String(candidate.safety_state_hash || '')],
    ['GOAL_BINDING_MATCH', prefixedHash(identity?.goal_revisions || {}) === prefixedHash(candidateGoalRevisions)],
    ['PLAN_ID_MATCH', String(identity?.plan_id || '') === String(activePlan.plan_id || '')],
    ['PLAN_REVISION_MATCH', Number(identity?.plan_revision) === Number(activePlan.plan_revision)],
    ['ASSIGNMENT_REVISION_MATCH', exactPositivePlanRevision(identity?.plan_revision) !== null
      && exactPositivePlanRevision(activeRow?.plan_version) !== null
      && identity.plan_revision === activeRow.plan_version],
    ['PLAN_DECISION_MATCH', String(identity?.decision_id || '') === String(activePlan.decision_id || '')],
    ['PLAN_DECISION_HASH_MATCH', hashIdentity(identity?.decision_hash) === hashIdentity(activePlan.decision_hash)],
    ['PLAN_CANDIDATE_HASH_MATCH', hashIdentity(identity?.candidate_hash) === hashIdentity(activePlan.selected_candidate_hash)],
    ['PLAN_SESSION_SET_HASH_MATCH', hashIdentity(identity?.canonical_session_set_hash) === hashIdentity(activePlan.canonical_session_set_hash)],
    ['PLAN_PURPOSE_MATCH', String(manifest?.purpose || '') === activePurpose],
    ['PLAN_FEASIBILITY_STATUS_MATCH', String(manifest?.feasibility?.status || '') === String(activePlan.overall_feasibility || '')],
    ['PLAN_FEASIBILITY_REASONS_MATCH', prefixedHash(manifest?.feasibility?.reason_codes || []) === prefixedHash(activePlan.reasons || [])],
    ['PLAN_WEEKS_MATCH', prefixedHash(manifest?.weeks || []) === prefixedHash(activeWeeks)],
    ['CANONICAL_SESSION_SET_PRESENT', canonicalPresent],
    ['CANONICAL_PLAN_ID_MATCH', String(canonicalSessionSet?.plan_id || '') === String(identity?.plan_id || '')],
    ['CANONICAL_PLAN_REVISION_MATCH', Number(canonicalSessionSet?.plan_revision) === Number(identity?.plan_revision)],
    ['CANONICAL_DECISION_MATCH', String(canonicalSessionSet?.decision_id || '') === String(identity?.decision_id || '')],
    ['CANONICAL_DECISION_HASH_MATCH', hashIdentity(canonicalSessionSet?.decision_hash) === hashIdentity(identity?.decision_hash)],
    ['CANONICAL_CANDIDATE_MATCH', String(canonicalSessionSet?.candidate_id || canonicalSessionSet?.selected_candidate_id || '') === String(identity?.candidate_id || '')],
    ['CANONICAL_CANDIDATE_HASH_MATCH', hashIdentity(canonicalSessionSet?.candidate_hash || canonicalSessionSet?.selected_candidate_hash) === hashIdentity(identity?.candidate_hash)],
    ['CANONICAL_CONTENT_HASH_MATCH', hashIdentity(canonicalSessionSet?.content_hash) === hashIdentity(identity?.canonical_session_set_hash)],
    ['CANONICAL_SESSIONS_MATCH', JSON.stringify(canonicalSessionSet?.sessions || []) === JSON.stringify(manifest?.sessions)],
  ];
  const predicates = Object.fromEntries(predicateEntries);
  const firstFailed = predicateEntries.find(([, passed]) => !passed)?.[0] || null;
  const accepted = firstFailed === null;
  const predicateGroup = (...codes) => codes.every((code) => predicates[code] === true);
  const manifestStatus = closedStatus(manifest?.status, ['accepted', 'blocked']);
  const featureMode = closedStatus(manifest?.feature_mode, ['preview', 'on', 'shadow', 'off']);
  return {
    schema_version: 'goal_backward_surface_predicate_diagnostic_v1',
    applicable: Number(activePlan.canonical_workout_schema_version) === 1,
    status_code: accepted ? 'ACCEPTED' : 'BLOCKED',
    reason_codes: accepted ? [] : ['SURFACE_REVISION_MISMATCH'],
    first_failed_predicate: firstFailed,
    predicates,
    statuses: {
      manifest: manifestStatus,
      feature_mode: featureMode,
      candidate: candidateStatus,
      assignment: assignmentStatus,
    },
    revisions: {
      surface: {
        manifest: diagnosticRevision(manifest?.surface_revision),
        candidate: diagnosticRevision(candidate.surface_revision),
        matches: predicates.SURFACE_REVISION_MATCH,
      },
      candidate: {
        manifest: diagnosticRevision(identity?.candidate_revision),
        candidate: diagnosticRevision(candidate.candidate_revision),
        matches: predicates.CANDIDATE_REVISION_MATCH,
      },
      plan: {
        manifest: diagnosticRevision(identity?.plan_revision),
        plan: diagnosticRevision(activePlan.plan_revision),
        assignment: diagnosticRevision(activeRow?.plan_version),
        canonical_session_set: diagnosticRevision(canonicalSessionSet?.plan_revision),
        matches: predicateGroup(
          'PLAN_REVISION_MATCH', 'ASSIGNMENT_REVISION_MATCH', 'CANONICAL_PLAN_REVISION_MATCH'
        ),
      },
      athlete_state: {
        manifest: diagnosticRevision(identity?.athlete_state_revision),
        candidate: diagnosticRevision(candidate.athlete_state_revision),
        matches: predicates.ATHLETE_STATE_REVISION_MATCH,
      },
    },
    bindings: {
      artifact: predicateGroup(
        'SURFACE_ARTIFACT_PRESENT', 'SURFACE_SCHEMA_MATCH', 'SURFACE_STATUS_ACCEPTED',
        'SURFACE_ENABLED', 'SURFACE_MODE_APPLICABLE', 'SURFACE_IDENTITY_PRESENT',
        'SURFACE_SESSIONS_PRESENT'
      ),
      surface_revision: predicates.SURFACE_REVISION_MATCH,
      candidate: predicateGroup(
        'CANDIDATE_BINDING_PRESENT', 'CANDIDATE_STATUS_APPLIED',
        'CANDIDATE_REVISION_MATCH', 'CANDIDATE_CONTENT_HASH_MATCH'
      ),
      decision: predicateGroup(
        'CANDIDATE_DECISION_MATCH', 'PLAN_DECISION_MATCH', 'PLAN_DECISION_HASH_MATCH',
        'CANONICAL_DECISION_MATCH', 'CANONICAL_DECISION_HASH_MATCH'
      ),
      plan: predicateGroup(
        'PLAN_ID_MATCH', 'PLAN_REVISION_MATCH', 'PLAN_PURPOSE_MATCH',
        'PLAN_FEASIBILITY_STATUS_MATCH', 'PLAN_FEASIBILITY_REASONS_MATCH', 'PLAN_WEEKS_MATCH'
      ),
      assignment: predicateGroup(
        'ASSIGNMENT_PRESENT', 'ASSIGNMENT_STATUS_ACTIVE', 'ASSIGNMENT_LINK_MATCH',
        'APPLIED_PLAN_LINK_MATCH', 'ASSIGNMENT_REVISION_MATCH'
      ),
      session_set: predicateGroup(
        'CANONICAL_SESSION_SET_PRESENT', 'CANONICAL_PLAN_ID_MATCH',
        'CANONICAL_PLAN_REVISION_MATCH', 'CANONICAL_CANDIDATE_MATCH',
        'CANONICAL_SESSIONS_MATCH'
      ),
      content_hash: predicateGroup(
        'CANDIDATE_CONTENT_HASH_MATCH', 'PLAN_CANDIDATE_HASH_MATCH',
        'PLAN_SESSION_SET_HASH_MATCH', 'CANONICAL_CANDIDATE_HASH_MATCH',
        'CANONICAL_CONTENT_HASH_MATCH'
      ),
      safety: predicates.SAFETY_STATE_HASH_MATCH,
      athlete_state: predicates.ATHLETE_STATE_REVISION_MATCH,
      goal: predicates.GOAL_BINDING_MATCH,
    },
    hashes: {
      candidate: {
        manifest: diagnosticHash(identity?.candidate_hash),
        candidate: diagnosticHash(candidate.selected_candidate_hash),
        plan: diagnosticHash(activePlan.selected_candidate_hash),
        canonical_session_set: diagnosticHash(
          canonicalSessionSet?.candidate_hash || canonicalSessionSet?.selected_candidate_hash
        ),
      },
      decision: {
        manifest: diagnosticHash(identity?.decision_hash),
        plan: diagnosticHash(activePlan.decision_hash),
        canonical_session_set: diagnosticHash(canonicalSessionSet?.decision_hash),
      },
      session_set: {
        manifest: diagnosticHash(identity?.canonical_session_set_hash),
        plan: diagnosticHash(activePlan.canonical_session_set_hash),
        canonical_session_set: diagnosticHash(canonicalSessionSet?.content_hash),
      },
      safety: {
        manifest: diagnosticHash(identity?.safety_state_hash),
        candidate: diagnosticHash(candidate.safety_state_hash),
      },
      goal_binding: {
        manifest: diagnosticHash(prefixedHash(identity?.goal_revisions || {})),
        candidate: diagnosticHash(prefixedHash(candidateGoalRevisions)),
      },
    },
  };
}

function surfaceManifestMatchesAppliedPlan(manifest, candidate, activeRow, canonicalSessionSet = null) {
  return surfaceManifestAppliedPlanDiagnostic(
    manifest,
    candidate,
    activeRow,
    canonicalSessionSet,
  ).status_code === 'ACCEPTED';
}

async function canonicalSurfaceManifestForActive(userId, activeRow, query = dbGet) {
  const appliedUserPlanId = activeRow?.user_plan_id;
  if (!appliedUserPlanId) return null;
  const activePlan = parsePlan(activeRow) || {};
  if (Number(activePlan.canonical_workout_schema_version) !== 1
    || !activePlan.canonical_session_set_hash
    || !activePlan.selected_candidate_hash) return null;
  const candidate = await query(
    `SELECT id, status, decision_id, candidate_revision, athlete_state_revision, safety_state_hash,
            goal_revisions_json, surface_revision, feature_mode, selected_candidate_hash,
            applied_training_plan_id, applied_user_plan_id
     FROM plan_generation_candidates
     WHERE user_id=? AND applied_user_plan_id=? AND status='applied'
       AND feature_mode IN ('preview','on')
     ORDER BY applied_at DESC
     LIMIT 1`,
    [userId, appliedUserPlanId],
  );
  if (!candidate) return surfaceMismatchManifest({ feature_mode: 'on', surface_revision: 1 });
  const artifact = await query(
    `SELECT surface.payload_json, canonical.payload_json AS canonical_payload_json
     FROM planning_pipeline_artifacts surface
     LEFT JOIN planning_pipeline_artifacts canonical
       ON canonical.id=surface.parent_artifact_id
      AND canonical.user_id=surface.user_id
      AND canonical.artifact_kind='canonical_session_set'
     WHERE surface.user_id=? AND surface.plan_generation_candidate_id=?
       AND surface.artifact_kind='surface_manifest'
     ORDER BY surface.revision DESC, surface.created_at DESC
     LIMIT 1`,
    [userId, candidate.id],
  );
  const payload = parseJsonValue(artifact?.payload_json, null);
  const canonicalSessionSet = parseJsonValue(artifact?.canonical_payload_json, null);
  const manifest = surfaceManifestMatchesAppliedPlan(payload, candidate, activeRow, canonicalSessionSet)
    ? payload
    : surfaceMismatchManifest(candidate, payload);
  const releaseMode = resolveOperationalGoalBackwardV24Mode(undefined, { userId });
  if (releaseMode !== 'off') {
    const revisionMismatch = manifest.status !== 'accepted';
    emitPlanReleaseTelemetry({
      userId,
      eventType: 'surface_capability',
      mode: releaseMode,
      outcome: revisionMismatch ? 'revision_mismatch' : 'surface_accepted',
      candidateSelected: true,
      passReasonCodes: revisionMismatch ? [] : ['PASS'],
      failReasonCodes: revisionMismatch ? ['REVISION_MISMATCH'] : [],
      surfaceCapability: revisionMismatch ? 'BLOCKED' : 'EXECUTABLE',
      revisionMismatch,
    });
  }
  return manifest;
}

async function canonicalSurfaceResponseField(userId, activeRow, query = dbGet) {
  const manifest = await canonicalSurfaceManifestForActive(userId, activeRow, query);
  return manifest ? { surface_manifest: manifest } : {};
}

const SURFACE_RECONCILE_REVIEW_MESSAGE = 'This plan needs a reviewed rebuild before workouts can start.';

function surfaceReconcileReviewRequired() {
  const error = new Error(SURFACE_RECONCILE_REVIEW_MESSAGE);
  error.code = 'SURFACE_RECONCILE_REVIEW_REQUIRED';
  error.status = 409;
  return error;
}

function storedSurfaceArtifact(row) {
  try {
    return parseCandidateJson(row?.payload_json, null);
  } catch (_error) {
    throw surfaceReconcileReviewRequired();
  }
}

function completeAppliedSurfaceValidation(userId, candidate, artifacts, activeRow) {
  let artifactDiagnostic;
  try {
    artifactDiagnostic = buildDecisionArtifactDiagnosticBundle({
      targetUserId: userId,
      decisionId: candidate?.decision_id,
      artifactRows: artifacts,
      candidateRow: candidate,
    });
  } catch (_error) {
    throw surfaceReconcileReviewRequired();
  }
  const legacyApplyReceiptGaps = [...(artifactDiagnostic.reason_codes || [])].sort();
  const exactLegacyApplyReceipt = JSON.stringify(legacyApplyReceiptGaps) === JSON.stringify([
    'C4_DEPLOYMENT_REVISION_MISSING',
    'C4_SOURCE_REVISION_MISSING',
  ]);
  if ((artifactDiagnostic.production_complete !== true && !exactLegacyApplyReceipt)
    || artifactDiagnostic.canonical_binding?.verified !== true) {
    throw surfaceReconcileReviewRequired();
  }
  const surfaceRow = artifacts.find((artifact) => artifact.artifact_kind === 'surface_manifest');
  const canonicalRow = artifacts.find((artifact) => (
    artifact.artifact_kind === 'canonical_session_set'
      && artifact.id === surfaceRow?.parent_artifact_id
  ));
  if (!surfaceRow || !canonicalRow) throw surfaceReconcileReviewRequired();
  const manifest = storedSurfaceArtifact(surfaceRow);
  const canonicalSessionSet = storedSurfaceArtifact(canonicalRow);
  const surfaceDiagnostic = surfaceManifestAppliedPlanDiagnostic(
    manifest,
    candidate,
    activeRow,
    canonicalSessionSet,
  );
  return { artifactDiagnostic, canonicalSessionSet, manifest, surfaceDiagnostic };
}

async function reconcileActiveSurfaceForUser(userId) {
  return withUserMutation(userId, async (tx) => {
    // This lock/re-read intentionally happens before parsing plan or progress JSON.
    const active = await getActivePlanForMutation(userId, tx, {
      includeFuture: true,
      normalizePersistedIdentities: false,
    });
    if (!active || active.source !== 'assigned' || !active.row?.user_plan_id) {
      throw surfaceReconcileReviewRequired();
    }
    const candidates = await tx.all(
      `SELECT * FROM plan_generation_candidates
       WHERE user_id=? AND applied_user_plan_id=? AND status='applied'
         AND feature_mode IN ('preview','on')
       ORDER BY applied_at DESC, id DESC
       LIMIT 2
       FOR UPDATE`,
      [userId, active.row.user_plan_id],
    );
    if (candidates.length !== 1) throw surfaceReconcileReviewRequired();
    const candidate = candidates[0];
    const artifacts = await tx.all(
      `SELECT id, user_id, artifact_kind, decision_id, parent_artifact_id,
              plan_generation_candidate_id, schema_version, policy_version,
              revision, content_hash, payload_json, created_at
       FROM planning_pipeline_artifacts
       WHERE user_id=? AND decision_id=?
       ORDER BY created_at ASC, id ASC
       LIMIT 32
       FOR SHARE`,
      [userId, candidate.decision_id],
    );
    const validation = completeAppliedSurfaceValidation(userId, candidate, artifacts, active.row);
    if (validation.surfaceDiagnostic.status_code === 'ACCEPTED') {
      return { ok: true, accepted: true, reconciled: false };
    }

    const failedPredicates = Object.entries(validation.surfaceDiagnostic.predicates)
      .filter(([, passed]) => passed !== true)
      .map(([predicate]) => predicate);
    const requiredBindings = [
      'artifact', 'surface_revision', 'candidate', 'decision', 'plan', 'session_set',
      'content_hash', 'safety', 'athlete_state', 'goal',
    ];
    const authorityRevision = exactPositivePlanRevision(validation.manifest?.identity?.plan_revision);
    const planRevision = exactPositivePlanRevision(parsePlan(active.row)?.plan_revision);
    const canonicalRevision = exactPositivePlanRevision(validation.canonicalSessionSet?.plan_revision);
    const storedAssignmentRevision = exactPositivePlanRevision(active.row.plan_version);
    const exactLegacyZeroSuccessor = authorityRevision === 2
      && planRevision === authorityRevision
      && canonicalRevision === authorityRevision
      && storedAssignmentRevision === 1
      && failedPredicates.length === 1
      && failedPredicates[0] === 'ASSIGNMENT_REVISION_MATCH'
      && requiredBindings.every((binding) => validation.surfaceDiagnostic.bindings[binding] === true)
      && validation.surfaceDiagnostic.statuses.candidate === 'APPLIED'
      && validation.surfaceDiagnostic.statuses.assignment === 'ACTIVE';
    if (!exactLegacyZeroSuccessor) throw surfaceReconcileReviewRequired();

    const predecessorId = String(active.row.supersedes_user_plan_id || '').trim();
    if (!predecessorId) throw surfaceReconcileReviewRequired();
    const predecessor = await tx.get(
      `SELECT up.id, up.user_id, up.plan_id, up.plan_version, up.status,
              up.lineage_id, up.supersedes_user_plan_id, up.effective_from
       FROM user_plans up
       WHERE up.id=? AND up.user_id=?
       FOR UPDATE OF up`,
      [predecessorId, userId],
    );
    if (!predecessor
      || predecessor.status !== 'superseded'
      || predecessor.plan_version !== 0
      || String(predecessor.lineage_id || '') !== String(active.row.lineage_id || '')
      || String(candidate.applied_user_plan_id || '') !== String(active.row.user_plan_id)
      || String(candidate.applied_training_plan_id || '') !== String(active.row.plan_id)) {
      throw surfaceReconcileReviewRequired();
    }

    const update = await tx.run(
      `UPDATE user_plans SET plan_version=?
       WHERE id=? AND user_id=? AND status='active' AND plan_id=? AND plan_version=?`,
      [authorityRevision, active.row.user_plan_id, userId, active.row.plan_id, storedAssignmentRevision],
    );
    if (update.changes !== 1) throw surfaceReconcileReviewRequired();
    active.row.plan_version = authorityRevision;

    const postValidation = completeAppliedSurfaceValidation(userId, candidate, artifacts, active.row);
    const publicManifest = await canonicalSurfaceManifestForActive(
      userId,
      active.row,
      (sql, params) => tx.get(sql, params),
    );
    if (postValidation.surfaceDiagnostic.status_code !== 'ACCEPTED'
      || publicManifest?.status !== 'accepted') {
      throw surfaceReconcileReviewRequired();
    }
    return { ok: true, accepted: true, reconciled: true };
  });
}

const WORKOUT_START_ACCESS_SCHEMA = 'goal_backward_workout_start_access_v1';
const WORKOUT_START_RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
  'interval_run', 'race_rhythm_run', 'race', 'assessment',
]);
const WORKOUT_START_HIGH_INTENSITY_FAMILIES = new Set([
  'threshold_run', 'interval_run', 'race_rhythm_run', 'race',
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
]);

function workoutStartSessionId(session) {
  const value = session?.session_id ?? session?.id;
  return value === null || value === undefined ? '' : String(value);
}

function workoutStartFamily(session, activity = {}) {
  return String(session?.workout_family || activity.workoutFamily || activity.workout_family || '').toLowerCase();
}

function workoutStartKind(session, activity = {}) {
  const explicit = String(activity.kind || session?.kind || '').toLowerCase();
  if (explicit) return explicit;
  const family = workoutStartFamily(session, activity);
  if (family.startsWith('strength_')) return 'lift';
  if (family.startsWith('hyrox_')) return 'hybrid';
  if (WORKOUT_START_RUNNING_FAMILIES.has(family)) return 'run';
  return '';
}

function workoutStartScopes(session, activity = {}) {
  if (session) {
    return new Set((Array.isArray(session.safety_scope) ? session.safety_scope : [])
      .map((value) => String(value || '').toUpperCase()).filter(Boolean));
  }
  return new Set([
    ...(Array.isArray(activity.safetyScope) ? activity.safetyScope : []),
    ...(Array.isArray(activity.safety_scope) ? activity.safety_scope : []),
  ].map((value) => String(value || '').toUpperCase()).filter(Boolean));
}

function workoutStartRpes(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => workoutStartRpes(entry, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    if (String(key).toLowerCase() === 'rpe' && Number.isFinite(Number(entry))) found.push(Number(entry));
    else workoutStartRpes(entry, found);
  }
  return found;
}

function workoutStartHighIntensity(session, activity = {}) {
  const explicit = Number(session
    ? session.intensity_level
    : activity.intensity ?? activity.intensityLevel);
  if (Number.isFinite(explicit)) return explicit >= 3;
  const rpes = workoutStartRpes(session?.steps || activity.steps || []);
  if (rpes.length) return Math.max(...rpes) >= 3;
  const family = workoutStartFamily(session, activity);
  if (WORKOUT_START_HIGH_INTENSITY_FAMILIES.has(family)) return true;
  if (['recovery_run', 'easy_run', 'mobility', 'manual_recovery', 'strength_upper'].includes(family)) return false;
  const label = String(session?.intensity || activity.intensityLabel || '').toLowerCase();
  if (/(hard|high|threshold|interval|race|tempo)/.test(label)) return true;
  if (/(easy|recovery|technique|low)/.test(label)) return false;
  return null;
}

function workoutStartSafetyAction(manifest) {
  const safety = manifest?.safety && typeof manifest.safety === 'object' ? manifest.safety : {};
  const action = String(safety.action || 'FULL_REST').toUpperCase();
  if (action !== 'PROFESSIONAL_ASSESSMENT_RECOMMENDED') return action;
  const scoped = String(safety.enforcement_action || safety.scoped_action || '').toUpperCase();
  return scoped && scoped !== 'PROFESSIONAL_ASSESSMENT_RECOMMENDED' ? scoped : 'FULL_REST';
}

function workoutStartBlockReason(manifest, session, activity = {}) {
  const action = workoutStartSafetyAction(manifest);
  const scopes = workoutStartScopes(session, activity);
  const family = workoutStartFamily(session, activity);
  const kind = workoutStartKind(session, activity);
  if (action === 'FULL_REST') return 'FULL_REST';
  if (action === 'NO_RUNNING' && (
    kind === 'run' || WORKOUT_START_RUNNING_FAMILIES.has(family)
    || scopes.has('RUN') || scopes.has('IMPACT')
  )) return 'NO_RUNNING';
  if (action === 'NO_LOWER_BODY') {
    const knownUpper = family === 'strength_upper';
    const lower = scopes.has('LOWER_BODY') || scopes.has('RUN') || scopes.has('IMPACT')
      || kind === 'run' || ['strength_lower', 'strength_full_body'].includes(family)
      || family.startsWith('hyrox_') || (kind === 'lift' && !knownUpper);
    if (lower) return 'NO_LOWER_BODY';
  }
  if (action === 'NO_HIGH_INTENSITY' && workoutStartHighIntensity(session, activity) !== false) {
    return 'NO_HIGH_INTENSITY';
  }
  if (action === 'MODIFY_IMPACT' && scopes.has('IMPACT') && session?.impact_modified !== true) {
    return 'MODIFY_IMPACT';
  }
  if (action === 'MODIFIED_SESSION_ONLY') {
    const reasons = Array.isArray(session?.purpose_reason_codes) ? session.purpose_reason_codes : [];
    const explicitlyValidated = session?.explicitly_validated_modified_session === true
      || (!session && activity.explicitlyValidatedModifiedSession === true)
      || reasons.some((reason) => [
        'EXPLICITLY_VALIDATED_MODIFIED_SESSION', 'MODIFIED_SESSION_VALIDATED',
      ].includes(String(reason || '').toUpperCase()));
    if (!explicitlyValidated) return 'MODIFIED_SESSION_ONLY';
  }
  return null;
}

function canonicalWorkoutStartAccess(manifest, session = null) {
  const identity = manifest?.identity && typeof manifest.identity === 'object' ? manifest.identity : null;
  if (!identity || manifest?.schema_version !== 'goal_backward_surface_manifest_v1'
    || manifest?.status !== 'accepted' || !manifest?.safety || typeof manifest.safety !== 'object') return null;
  return {
    schema_version: WORKOUT_START_ACCESS_SCHEMA,
    manifest: {
      schema_version: String(manifest.schema_version),
      surface_revision: Number(manifest.surface_revision),
      decision_id: String(identity.decision_id || ''),
      candidate_id: String(identity.candidate_id || ''),
      plan_id: String(identity.plan_id || ''),
      plan_revision: Number(identity.plan_revision),
      canonical_session_set_hash: String(identity.canonical_session_set_hash || ''),
      athlete_state_revision: Number(identity.athlete_state_revision),
      safety_state_hash: String(identity.safety_state_hash || ''),
      safety_action: String(manifest.safety.action || ''),
    },
    session: session ? {
      session_id: workoutStartSessionId(session),
      session_revision: Number(session.session_revision),
      content_hash: String(session.content_hash || ''),
    } : null,
  };
}

function canonicalWorkoutStartDecision({ manifest = null, access = null, sessionId = null, activity = {} } = {}) {
  if (!manifest) {
    return access
      ? { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_STALE', access: null, session: null }
      : { allowed: true, reasonCode: null, access: null, session: null, legacy: true };
  }
  if (manifest.status !== 'accepted') {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_UNAVAILABLE', access: null, session: null };
  }
  const wanted = sessionId === null || sessionId === undefined || sessionId === '' ? '' : String(sessionId);
  const session = wanted
    ? (Array.isArray(manifest.sessions) ? manifest.sessions : [])
      .find((entry) => workoutStartSessionId(entry) === wanted) || null
    : null;
  if (wanted && !session) {
    return { allowed: false, reasonCode: 'CANONICAL_SESSION_MISSING', access: null, session: null };
  }
  const currentAccess = canonicalWorkoutStartAccess(manifest, session);
  if (!currentAccess) {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_UNAVAILABLE', access: null, session };
  }
  if (!access || typeof access !== 'object') {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_MISSING', access: currentAccess, session };
  }
  if (JSON.stringify(access) !== JSON.stringify(currentAccess)) {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_STALE', access: currentAccess, session };
  }
  if (session && session.executability !== 'EXECUTABLE') {
    return {
      allowed: false,
      reasonCode: workoutStartBlockReason(manifest, session, activity) || 'SESSION_NOT_EXECUTABLE',
      access: currentAccess,
      session,
    };
  }
  const reasonCode = workoutStartBlockReason(manifest, session, activity);
  return { allowed: !reasonCode, reasonCode, access: currentAccess, session };
}

async function maybeComputeGoalBackwardShadowDiagnostics({ mode, response, compute }) {
  if (mode !== 'off') await compute();
  return response;
}

function prefixedGoalBackwardCandidateHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return hash.startsWith('sha256:') ? hash : `sha256:${hash}`;
}

function exactGoalBindingId(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function exactAliasedGoalBinding(row, names) {
  let resolved = null;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(row, name)) continue;
    const value = exactGoalBindingId(row[name]);
    if (!value || (resolved !== null && value !== resolved)) return null;
    resolved = value;
  }
  return resolved;
}

function exactOptionalGoalBinding(row, names, expected) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(row, name)
      || row[name] === null || row[name] === undefined) continue;
    if (typeof expected === 'number') {
      if (typeof row[name] !== 'number' || !Number.isSafeInteger(row[name]) || row[name] !== expected) return false;
    } else if (exactGoalBindingId(row[name]) !== expected) return false;
  }
  return true;
}

function applicableGoalBackwardFeasibility(currentPlan, goalBackwardResult) {
  const activeGoals = Array.isArray(goalBackwardResult?.decision?.active_goals)
    ? goalBackwardResult.decision.active_goals : [];
  const decisionFeasibilities = Array.isArray(goalBackwardResult?.decision?.goal_feasibilities)
    ? goalBackwardResult.decision.goal_feasibilities : [];
  const planGoals = Array.isArray(currentPlan?.goals) ? currentPlan.goals : [];
  const planFeasibilities = Array.isArray(currentPlan?.goal_feasibilities)
    ? currentPlan.goal_feasibilities : [];
  const ownedAthleteId = exactGoalBindingId(goalBackwardResult?.decision?.athlete_id);
  const count = activeGoals.length;
  if (!ownedAthleteId || !count || decisionFeasibilities.length !== count
    || planGoals.length !== count || planFeasibilities.length !== count) return null;

  const activeByGoalId = new Map();
  const activeByRaceId = new Map();
  let decisionAthleteId = null;
  for (const goal of activeGoals) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return null;
    const goalId = exactGoalBindingId(goal.goal_id);
    const raceId = exactGoalBindingId(goal.race_id);
    const athleteId = exactGoalBindingId(goal.athlete_id);
    const eventRevision = goal.event_revision;
    const goalRevision = goal.source_revision;
    if (!goalId || !raceId || athleteId !== ownedAthleteId
      || typeof eventRevision !== 'number' || !Number.isSafeInteger(eventRevision) || eventRevision < 1
      || typeof goalRevision !== 'number' || !Number.isSafeInteger(goalRevision) || goalRevision < 1
      || activeByGoalId.has(goalId) || activeByRaceId.has(raceId)) return null;
    if (decisionAthleteId !== null && athleteId !== decisionAthleteId) return null;
    decisionAthleteId = athleteId;
    const binding = { athleteId, eventRevision, goal, goalId, goalRevision, raceId };
    activeByGoalId.set(goalId, binding);
    activeByRaceId.set(raceId, binding);
  }

  const decisionByRaceId = new Map();
  for (const entry of decisionFeasibilities) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const goalId = exactGoalBindingId(entry.goal_id);
    const raceId = exactGoalBindingId(entry.race_id);
    const binding = goalId ? activeByGoalId.get(goalId) : null;
    if (!binding || binding.raceId !== raceId || decisionByRaceId.has(raceId)
      || !['supported', 'unvalidated', 'at_risk'].includes(entry.status)) return null;
    decisionByRaceId.set(raceId, entry);
  }
  if (decisionByRaceId.size !== count) return null;

  const seenPlanGoals = new Set();
  for (const goal of planGoals) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return null;
    const raceId = exactAliasedGoalBinding(goal, ['raceId', 'race_id']);
    const binding = raceId ? activeByRaceId.get(raceId) : null;
    if (!binding || seenPlanGoals.has(raceId)
      || !exactOptionalGoalBinding(goal, ['goal_id', 'goalId'], binding.goalId)
      || !exactOptionalGoalBinding(goal, ['athlete_id', 'athleteId', 'user_id', 'userId'], binding.athleteId)
      || !exactOptionalGoalBinding(goal, ['event_revision', 'eventRevision'], binding.eventRevision)
      || !exactOptionalGoalBinding(
        goal, ['source_revision', 'goal_revision', 'goalRevision'], binding.goalRevision,
      )) return null;
    seenPlanGoals.add(raceId);
  }

  if (currentPlan.goal !== null && currentPlan.goal !== undefined) {
    const goal = currentPlan.goal;
    const raceId = goal && !Array.isArray(goal) && typeof goal === 'object'
      ? exactAliasedGoalBinding(goal, ['raceId', 'race_id']) : null;
    const binding = raceId ? activeByRaceId.get(raceId) : null;
    if (!binding
      || !exactOptionalGoalBinding(goal, ['goal_id', 'goalId'], binding.goalId)
      || !exactOptionalGoalBinding(goal, ['athlete_id', 'athleteId', 'user_id', 'userId'], binding.athleteId)
      || !exactOptionalGoalBinding(goal, ['event_revision', 'eventRevision'], binding.eventRevision)
      || !exactOptionalGoalBinding(
        goal, ['source_revision', 'goal_revision', 'goalRevision'], binding.goalRevision,
      )) return null;
  }

  const seenPlanFeasibilities = new Set();
  const mappedGoalFeasibilities = [];
  for (const entry of planFeasibilities) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const raceId = exactAliasedGoalBinding(entry, ['race_id', 'raceId']);
    const binding = raceId ? activeByRaceId.get(raceId) : null;
    const decisionEntry = raceId ? decisionByRaceId.get(raceId) : null;
    if (!binding || !decisionEntry || seenPlanFeasibilities.has(raceId)
      || !['supported', 'stretch', 'unsafe', 'unvalidated', 'at_risk'].includes(entry.feasibility)
      || !exactOptionalGoalBinding(entry, ['goal_id', 'goalId'], binding.goalId)
      || !exactOptionalGoalBinding(entry, ['athlete_id', 'athleteId', 'user_id', 'userId'], binding.athleteId)
      || !exactOptionalGoalBinding(entry, ['event_revision', 'eventRevision'], binding.eventRevision)
      || !exactOptionalGoalBinding(
        entry, ['source_revision', 'goal_revision', 'goalRevision'], binding.goalRevision,
      )) return null;
    seenPlanFeasibilities.add(raceId);
    mappedGoalFeasibilities.push({
      ...entry,
      legacy_feasibility: entry.feasibility,
      legacy_reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
      feasibility: decisionEntry.status,
      reasons: [...new Set([
        ...(Array.isArray(entry.reasons) ? entry.reasons : []),
        ...(Array.isArray(decisionEntry.reason_codes) ? decisionEntry.reason_codes : []),
      ])],
      next_required_assessment: decisionEntry.next_required_assessment || null,
    });
  }
  if (seenPlanGoals.size !== count || seenPlanFeasibilities.size !== count) return null;
  const statuses = [...decisionByRaceId.values()].map((entry) => entry.status);
  return {
    goalFeasibilities: mappedGoalFeasibilities,
    overallFeasibility: statuses.every((status) => status === 'supported') ? 'supported' : 'stretch',
  };
}

function applicableGoalBackwardPlan(currentPlan, goalBackwardResult) {
  const selected = goalBackwardResult?.selected_candidate;
  const canonicalPlan = selected?.canonical_plan;
  const feasibility = applicableGoalBackwardFeasibility(currentPlan, goalBackwardResult);
  if (!selected?.validation?.valid || !selected?.canonical_sessions_materialized
    || !canonicalPlan || !Array.isArray(canonicalPlan.weeks) || canonicalPlan.weeks.length === 0
    || !feasibility) {
    return null;
  }
  return {
    ...currentPlan,
    ...canonicalPlan,
    schemaVersion: 2,
    engineVersion: currentPlan.engineVersion,
    goal_backward_engine_version: 'goal-backward-coaching-v2.4',
    goal_backward_policy_versions: goalBackwardResult.decision?.policy_versions || {},
    overall_feasibility: feasibility.overallFeasibility,
    goal_feasibilities: feasibility.goalFeasibilities,
    reasons: [...new Set([
      ...(Array.isArray(currentPlan.reasons) ? currentPlan.reasons : []),
      ...(Array.isArray(goalBackwardResult.decision?.reason_codes) ? goalBackwardResult.decision.reason_codes : []),
    ])],
    planningClock: currentPlan.planningClock,
    goals: currentPlan.goals,
    goal: currentPlan.goal,
    strengthPolicy: currentPlan.strengthPolicy,
  };
}

function isRevisionedGoalBackedRequest(userId, state, request = state?.request) {
  const ownerId = String(userId || '').trim();
  const requestedRaceIds = Array.isArray(request?.race_ids)
    ? request.race_ids.map((value) => String(value || '').trim()) : [];
  const races = Array.isArray(state?.races) ? state.races : [];
  const planningInputRevision = Number(state?.planningInputRevision);
  if (!ownerId || requestedRaceIds.length < 1 || requestedRaceIds.length > 2
    || !Number.isSafeInteger(planningInputRevision) || planningInputRevision < 0
    || races.length !== requestedRaceIds.length) return false;
  const requested = [...requestedRaceIds].sort();
  const loaded = races.map((race) => String(race?.id || '')).sort();
  if (requested.some((raceId) => !raceId) || JSON.stringify(requested) !== JSON.stringify(loaded)) return false;
  const goals = goalBackwardGoalsForState(ownerId, state);
  return goals.length === races.length && goals.every((goal) => (
    goal.athlete_id === ownerId
    && requestedRaceIds.includes(String(goal.race_id || ''))
    && Number.isSafeInteger(Number(goal.source_revision))
    && Number(goal.source_revision) >= 1
  ));
}

function goalBackwardGenerationFailed(reasonCode = 'CANDIDATE_NOT_SELECTED') {
  const boundedReasonCode = reasonCode === 'REQUIRED_RUNNING_DOSE_INVALID'
    ? reasonCode : 'CANDIDATE_NOT_SELECTED';
  return candidateError(
    409,
    'GOAL_BACKWARD_GENERATION_FAILED',
    'The goal-backed plan could not be completed. No candidate was saved; review the goal or training inputs and preview again.',
    { reason_code: boundedReasonCode },
  );
}

function emitPlanReleaseTelemetry({
  userId,
  eventType,
  mode,
  outcome,
  candidateSelected = false,
  passReasonCodes = [],
  failReasonCodes = [],
  surfaceCapability = 'NOT_EXPOSED',
  revisionMismatch = false,
  sink = null,
} = {}) {
  try {
    return emitGoalBackwardReleaseTelemetry(buildGoalBackwardReleaseTelemetry({
      targetRef: goalBackwardTargetRef(userId),
      eventType,
      mode,
      outcome,
      candidateSelected,
      passReasonCodes,
      failReasonCodes,
      surfaceCapability,
      revisionMismatch,
    }), { sink });
  } catch (_error) {
    return emitGoalBackwardReleaseTelemetry(buildGoalBackwardReleaseTelemetry({
      targetRef: goalBackwardTargetRef(userId),
      eventType: 'mode_resolution',
      mode: 'off',
      outcome: 'apply_rejected',
      candidateSelected: false,
      failReasonCodes: ['TELEMETRY_REDACTION_VIOLATION'],
      surfaceCapability: 'BLOCKED',
    }), { sink });
  }
}

async function previewPlanForUser(userId, body = {}, { store = true, goalBackwardDependencies = {} } = {}) {
  const clock = acceptedPlanningClock(body);
  const request = normalizeCandidateRequest(body);
  const initial = await withUserMutation(userId, (tx) => loadCandidateInputState(userId, request, clock, tx));
  const built = buildDeterministicCandidate(initial.context, {
    planningDateLocal: clock.planningDateLocal,
    timezoneOffsetMinutes: clock.timezoneOffsetMinutes,
  });
  if (!built.validation.valid) {
    throw candidateError(422, 'PLAN_VALIDATION_FAILED', 'The requested plan did not pass safety validation.', built.validation.errors);
  }
  const trace = buildCandidateTrace(initial, built);
  const normalized = validateCandidateBundle({ plan: built.plan, snapshot: initial.snapshot, trace });
  const legacyCandidateHash = prefixedHash(normalized.plan);
  let candidateHash = legacyCandidateHash;
  let persistedPlan = normalized.plan;
  const candidateId = uuidv4();
  const expiresAt = new Date(Date.now() + (RACE_PLAN_POLICY_V1.candidate.ttlHours * 60 * 60 * 1000)).toISOString();
  const response = {
    candidateHash,
    effectiveFrom: candidateEffectiveFrom(initial.active, clock.planningDateLocal, { immediate: true }),
    expiresAt,
    id: candidateId,
    meta: initial.meta,
    plan: persistedPlan,
    planningDateLocal: clock.planningDateLocal,
    races: initial.races,
    replacesActivePlan: Boolean(initial.active),
  };
  let goalBackwardMode = resolvePlanGoalBackwardV24Mode(userId, goalBackwardDependencies, {
    allowSyntheticShadow: true,
  });
  if (goalBackwardMode !== 'off' && !isRevisionedGoalBackedRequest(userId, initial, request)) {
    emitPlanReleaseTelemetry({
      userId,
      eventType: 'mode_resolution',
      mode: goalBackwardMode,
      outcome: 'candidate_rejected',
      candidateSelected: false,
      failReasonCodes: ['EVIDENCE_MISSING'],
      surfaceCapability: 'BLOCKED',
      sink: goalBackwardDependencies.telemetrySink,
    });
    goalBackwardMode = 'off';
  }
  let goalBackwardShadow = null;
  let goalBackwardFailure = null;
  await maybeComputeGoalBackwardShadowDiagnostics({
    mode: goalBackwardMode,
    response,
    compute: async () => {
      try {
        goalBackwardShadow = computeGoalBackwardShadowDiagnostics({
          userId,
          state: initial,
          built,
          planningDateLocal: clock.planningDateLocal,
        }, goalBackwardDependencies);
      } catch (error) {
        goalBackwardShadow = null;
        goalBackwardFailure = error;
        if (typeof goalBackwardDependencies.inspectFailure === 'function') goalBackwardDependencies.inspectFailure(error);
      }
    },
  });
  if (goalBackwardMode !== 'off' && !goalBackwardShadow) {
    emitPlanReleaseTelemetry({
      userId,
      eventType: 'mode_resolution',
      mode: goalBackwardMode,
      outcome: 'candidate_rejected',
      candidateSelected: false,
      failReasonCodes: ['CANDIDATE_NOT_SELECTED'],
      surfaceCapability: 'BLOCKED',
      sink: goalBackwardDependencies.telemetrySink,
    });
    if (['preview', 'on'].includes(goalBackwardMode)) {
      throw goalBackwardGenerationFailed(goalBackwardFailure?.code);
    }
  }
  if (['preview', 'on'].includes(goalBackwardMode)) {
    const applicablePlan = applicableGoalBackwardPlan(normalized.plan, goalBackwardShadow);
    if (applicablePlan) {
      persistedPlan = assertPersistablePlan(applicablePlan);
      candidateHash = prefixedGoalBackwardCandidateHash(goalBackwardShadow.selected_candidate.candidate_hash);
      response.candidateHash = candidateHash;
      response.plan = persistedPlan;
    } else {
      emitPlanReleaseTelemetry({
        userId,
        eventType: 'mode_resolution',
        mode: goalBackwardMode,
        outcome: 'candidate_rejected',
        candidateSelected: false,
        failReasonCodes: ['CANDIDATE_NOT_SELECTED'],
        surfaceCapability: 'BLOCKED',
        sink: goalBackwardDependencies.telemetrySink,
      });
      throw goalBackwardGenerationFailed();
    }
  }
  if (goalBackwardMode !== 'off') {
    const candidateSelected = Boolean(goalBackwardShadow?.selected_candidate);
    const passReasonCodes = candidateSelected
      ? (goalBackwardShadow.selected_candidate.validation?.reason_codes || []).filter((code) => REQUIRED_RELEASE_TELEMETRY_REASON_CODES.has(code))
      : [];
    const failReasonCodes = goalBackwardShadow
      ? (goalBackwardShadow.rejected_candidates || [])
        .flatMap((candidate) => candidate.reason_codes || [])
        .filter((code) => REQUIRED_RELEASE_TELEMETRY_REASON_CODES.has(code))
        .slice(0, 32)
      : ['CANDIDATE_NOT_SELECTED'];
    emitPlanReleaseTelemetry({
      userId,
      eventType: 'candidate_comparison',
      mode: goalBackwardMode,
      outcome: goalBackwardShadow
        ? (goalBackwardMode === 'shadow' ? 'control_selected' : 'candidate_selected')
        : 'candidate_rejected',
      candidateSelected,
      passReasonCodes,
      failReasonCodes,
      surfaceCapability: goalBackwardMode === 'shadow' ? 'NOT_EXPOSED' : 'PREVIEW_ONLY',
      sink: goalBackwardDependencies.telemetrySink,
    });
  }
  if (!store) {
    return {
      ...response,
      diagnostics: {
        active_plan: initial.activePlan,
        active_plan_data: initial.removalPlanSnapshot
          || (initial.active ? parsePlan(initial.active.row) : null),
        snapshot: normalized.snapshot,
        trace: normalized.trace,
      },
    };
  }

  await withUserMutation(userId, async (tx) => {
    const current = await loadCandidateInputState(userId, request, clock, tx);
    if (current.planningInputRevision !== initial.planningInputRevision || current.inputHash !== initial.inputHash) {
      throw candidateError(409, 'CANDIDATE_STALE', 'Training data changed while the preview was being built. Preview again.');
    }
    await pruneExpiredPlanCandidates(tx, userId);
    const baseValues = [
      candidateId,
      userId,
      'preview',
      initial.activePlan?.trainingPlanId || null,
      initial.activePlan?.userPlanId || null,
      initial.activePlan?.planVersion ?? null,
      initial.planningInputRevision,
      clock.planningDateLocal,
      clock.timezoneOffsetMinutes,
      initial.inputHash,
      candidateHash,
      persistedPlan.goal_backward_engine_version
        || normalized.plan.engineVersion || RACE_PLAN_POLICY_V1.engineVersion,
      persistedPlan.goal_backward_policy_versions?.planning_policy_version
        || normalized.plan.policyVersion || RACE_PLAN_POLICY_V1.version,
      normalized.plan.invariantVersion || RACE_PLAN_POLICY_V1.invariantVersion,
      JSON.stringify(normalized.snapshot),
      JSON.stringify(persistedPlan),
      JSON.stringify(normalized.trace),
      expiresAt,
    ];
    const insertCurrentCandidate = () => tx.run(
      `INSERT INTO plan_generation_candidates (
         id, user_id, status, training_plan_id, user_plan_id, active_plan_version,
         planning_input_revision, planning_date_local, timezone_offset_minutes,
         input_hash, candidate_hash, engine_version, policy_version, invariant_version,
         planning_snapshot_json, candidate_plan_json, generation_trace_json, expires_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      baseValues
    );
    let shadowPersisted = false;
    if (goalBackwardMode !== 'off' && goalBackwardShadow) {
      await tx.run('SAVEPOINT goal_backward_shadow');
      try {
        const bindings = {
          ...buildGoalBackwardShadowBindings({
            decision: goalBackwardShadow.decision,
            selectedCandidate: goalBackwardShadow.selected_candidate,
            currentCandidateHash: candidateHash,
          }),
          feature_mode: goalBackwardMode,
          selected_candidate_hash: goalBackwardMode === 'shadow'
            ? goalBackwardShadow.selected_candidate?.candidate_hash || candidateHash
            : candidateHash,
        };
        const priorRejections = await loadCandidateRejectionsForFingerprint({
          tx,
          userId,
          fingerprint: bindings.material_change_json.apply_bindings,
        });
        if (priorRejections.some((rejection) => candidateRejectionMatches(rejection, {
          candidate_hash: candidateHash,
          ...bindings.material_change_json.apply_bindings,
        }))) {
          throw candidateError(
            409,
            'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED',
            'This unchanged plan candidate was already rejected. Change the goal, evidence, constraints, or policy before previewing again.',
          );
        }
        goalBackwardShadow = suppressRejectedGoalBackwardCandidates(goalBackwardShadow, priorRejections);
        const buildArtifacts = goalBackwardDependencies.buildArtifacts || buildGoalBackwardArtifacts;
        const artifacts = buildArtifacts({
          userId,
          planGenerationCandidateId: candidateId,
          currentCandidateHash: candidateHash,
          decision: goalBackwardShadow.decision,
          candidates: goalBackwardShadow.candidates,
          featureMode: goalBackwardMode,
          plan: persistedPlan,
          engineVersion: 'goal-backward-coaching-v2.4',
          sourceRevision: Object.hasOwn(goalBackwardDependencies, 'sourceRevision')
            ? goalBackwardDependencies.sourceRevision
            : process.env.FORGE_GOAL_BACKWARD_V24_EXPECTED_REVISION || null,
          deploymentRevision: Object.hasOwn(goalBackwardDependencies, 'deploymentRevision')
            ? goalBackwardDependencies.deploymentRevision
            : process.env.RAILWAY_GIT_COMMIT_SHA
              || process.env.FORGE_GOAL_BACKWARD_V24_DEPLOYED_REVISION
              || null,
        });
        const decisionArtifact = artifacts.find((artifact) => artifact.artifact_kind === 'planning_decision');
        const currentBindings = {
          ...buildGoalBackwardShadowBindings({
            decision: goalBackwardShadow.decision,
            decisionArtifact,
            selectedCandidate: goalBackwardShadow.selected_candidate,
            currentCandidateHash: candidateHash,
          }),
          feature_mode: goalBackwardMode,
          selected_candidate_hash: goalBackwardMode === 'shadow'
            ? goalBackwardShadow.selected_candidate?.candidate_hash || candidateHash
            : candidateHash,
        };
        await tx.run(
          `INSERT INTO plan_generation_candidates (
             id, user_id, status, training_plan_id, user_plan_id, active_plan_version,
             planning_input_revision, planning_date_local, timezone_offset_minutes,
             input_hash, candidate_hash, engine_version, policy_version, invariant_version,
             planning_snapshot_json, candidate_plan_json, generation_trace_json, expires_at,
             decision_id, candidate_revision, athlete_state_revision, safety_state_hash,
             goal_revisions_json, lock_revision, edit_revision, surface_revision, export_revision,
             feature_mode, selected_candidate_hash, material_change_json
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            ...baseValues,
            currentBindings.decision_id,
            currentBindings.candidate_revision,
            currentBindings.athlete_state_revision,
            currentBindings.safety_state_hash,
            JSON.stringify(currentBindings.goal_revisions_json),
            currentBindings.lock_revision,
            currentBindings.edit_revision,
            currentBindings.surface_revision,
            currentBindings.export_revision,
            currentBindings.feature_mode,
            currentBindings.selected_candidate_hash,
            JSON.stringify(currentBindings.material_change_json),
          ]
        );
        await persistGoalBackwardDecisionArtifacts({ tx, artifacts });
        if (['preview', 'on'].includes(goalBackwardMode)) {
          response.surfaceManifest = artifacts.find((artifact) => (
            artifact.artifact_kind === 'surface_manifest'
          ))?.payload_json || null;
          response.applyBindings = buildGoalBackwardApplyEnvelope({
            id: candidateId,
            candidate_hash: candidateHash,
            training_plan_id: initial.activePlan?.trainingPlanId || null,
            user_plan_id: initial.activePlan?.userPlanId || null,
            active_plan_version: initial.activePlan?.planVersion ?? null,
            planning_input_revision: initial.planningInputRevision,
            planning_date_local: clock.planningDateLocal,
            timezone_offset_minutes: clock.timezoneOffsetMinutes,
            ...currentBindings,
          });
        }
        await tx.run('RELEASE SAVEPOINT goal_backward_shadow');
        shadowPersisted = true;
      } catch (error) {
        await tx.run('ROLLBACK TO SAVEPOINT goal_backward_shadow');
        await tx.run('RELEASE SAVEPOINT goal_backward_shadow');
        if (error?.code === 'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED') throw error;
        if (typeof goalBackwardDependencies.inspectFailure === 'function') goalBackwardDependencies.inspectFailure(error);
        const applicableModeFailed = ['preview', 'on'].includes(goalBackwardMode);
        emitPlanReleaseTelemetry({
          userId,
          eventType: 'mode_resolution',
          mode: goalBackwardMode,
          outcome: 'candidate_rejected',
          candidateSelected: false,
          failReasonCodes: ['CANDIDATE_NOT_SELECTED'],
          surfaceCapability: 'BLOCKED',
          sink: goalBackwardDependencies.telemetrySink,
        });
        goalBackwardShadow = null;
        if (applicableModeFailed) {
          throw goalBackwardGenerationFailed();
        }
      }
    }
    if (!shadowPersisted) {
      await insertCurrentCandidate();
    }
  });
  return response;
}

function sameCapturedActivePlan(row, active) {
  const meta = activeCandidateMetadata(active);
  return String(row.training_plan_id || '') === String(meta?.trainingPlanId || '')
    && String(row.user_plan_id || '') === String(meta?.userPlanId || '')
    && String(row.active_plan_version ?? '') === String(meta?.planVersion ?? '');
}

function currentGoalBackwardApplyEnvelope(expected, userId, current) {
  const goals = goalBackwardGoalsForState(userId, current);
  const firstGoal = goals[0] || null;
  const transitionExitMet = firstGoal?.transition_exit_met === true;
  const primaryGoal = firstGoal?.event_state === 'COMPLETED' && !transitionExitMet
    ? firstGoal
    : goals.find((goal) => ['SCHEDULED', 'POSTPONED', 'UNKNOWN'].includes(goal.event_state)) || null;
  const currentEventPolicy = primaryGoal ? eventPolicyForGoal(primaryGoal) : null;
  const athleteStateRevision = Math.max(1, Number(current.planningInputRevision || 1));
  const evidenceSnapshotId = `snapshot-${current.inputHash.slice(-24)}`;
  const scopedRecovery = deriveScopedRecoveryState({
    planning_date_local: expected.planning_date_local,
    candidate_window_end_local: addPolicyDays(expected.planning_date_local, 6),
    timezone: current.context?.profile?.timezone || 'UTC',
    evidence_snapshot_id: evidenceSnapshotId,
    context: current.context,
  });
  const safetyState = {
    action: scopedRecovery.safety_action,
    scope: scopedRecovery.scopes,
    reason_codes: scopedRecovery.reason_codes,
    receipt_hash: scopedRecovery.receipt_hash,
  };
  const fingerprints = buildGoalBackwardFingerprintBindings({
    athlete_id: userId,
    plan_id: current.activePlan?.trainingPlanId || null,
    athlete_state_revision: athleteStateRevision,
    evidence_snapshot_id: evidenceSnapshotId,
    evidence_used: [{ evidence_id: evidenceSnapshotId, purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
    safety_state: safetyState,
    active_goals: goals,
    lock_revision: current.planningConstraints?.lock_revision || 0,
    edit_revision: current.planningConstraints?.edit_revision || 0,
    constraint_fingerprint: current.planningConstraints?.constraint_fingerprint || null,
    athlete_locks: current.planningConstraints?.locks || [],
    manual_edits: current.planningConstraints?.manual_edits || [],
    timezone: current.context?.profile?.timezone || 'UTC',
    policy_versions: {
      planning_policy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.planning_policy_version,
      event_policy_registry_version: GOAL_BACKWARD_PLANNING_POLICY_V1.event_policy_registry_version,
      stress_taxonomy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.stress_taxonomy_version,
    },
    event_policy_id: currentEventPolicy?.event_policy_id || null,
  });
  return {
    ...expected,
    active_plan: {
      training_plan_id: current.activePlan?.trainingPlanId || null,
      user_plan_id: current.activePlan?.userPlanId || null,
      plan_revision: current.activePlan?.planVersion ?? null,
    },
    planning_input_revision: Number(current.planningInputRevision),
    planning_timezone: current.context?.profile?.timezone || 'UTC',
    goal_revisions: Object.fromEntries(goals.map((goal) => [
      String(goal.goal_id), Math.max(1, Number(goal.source_revision || 1)),
    ])),
    goal_fingerprint: fingerprints.goal_fingerprint,
    athlete_state_revision: athleteStateRevision,
    safety_state_hash: prefixedHash(safetyState),
    evidence_fingerprint: fingerprints.evidence_fingerprint,
    constraint_fingerprint: fingerprints.constraint_fingerprint,
    policy_fingerprint: fingerprints.policy_fingerprint,
    lock_revision: current.planningConstraints?.lock_revision || 0,
    edit_revision: current.planningConstraints?.edit_revision || 0,
  };
}

function staleApplyResult(code) {
  const messages = {
    RACE_REVISION_CHANGED: 'The goal or race changed after preview. Preview again.',
    SAFETY_STATE_CHANGED: 'Safety guidance changed after preview. Preview again.',
    ATHLETE_STATE_REVISION_CHANGED: 'Athlete state changed after preview. Preview again.',
    ACTIVE_PLAN_REVISION_CHANGED: 'The active plan changed after preview. Preview again.',
    PLANNING_CLOCK_CHANGED: 'The athlete-local planning clock changed. Preview again.',
  };
  return planningInputUnchanged({
    status: 409,
    error: messages[code] || 'Candidate bindings changed after preview. Preview again.',
    code,
  });
}

async function verifyStoredGoalBackwardDecisionHash(tx, userId, row, expected) {
  const artifact = await tx.get(
    `SELECT id, revision, content_hash, payload_json FROM planning_pipeline_artifacts
     WHERE id=? AND user_id=? AND decision_id=? AND artifact_kind='planning_decision'
     LIMIT 1`,
    [expected.decision_artifact.artifact_id, userId, row.decision_id],
  );
  const payload = parseCandidateJson(artifact?.payload_json, null);
  if (!artifact
    || String(artifact.id || '') !== String(expected.decision_artifact.artifact_id)
    || Number(artifact.revision) !== Number(expected.decision_artifact.revision)
    || String(artifact.content_hash || '') !== String(expected.decision_artifact.content_hash)
    || !payload || String(payload.decision_id || '') !== String(expected.decision_id)
    || String(payload.decision_hash || '').replace(/^sha256:/, '')
      !== String(expected.decision_hash || '').replace(/^sha256:/, '')) {
    throw candidateError(409, 'DECISION_ARTIFACT_CHANGED', 'The exact planning decision artifact is missing or changed. Preview again.');
  }
  return true;
}

function replacementLineageForActivePlan(active, fallbackUserPlanId) {
  const supersedesUserPlanId = active?.row?.user_plan_id || null;
  return {
    lineageId: active?.row?.lineage_id || supersedesUserPlanId || fallbackUserPlanId,
    priorVersion: active?.source === 'assigned' ? positivePlanRevision(active.row?.plan_version) : 0,
    supersedesUserPlanId,
  };
}

function candidateFeasibilityCanApply(plan = {}) {
  const feasibility = String(plan.overall_feasibility || '').toLowerCase();
  if (feasibility === 'supported' || feasibility === 'stretch') return true;
  if (feasibility !== 'not_applicable') return false;
  const goals = Array.isArray(plan.goals) ? plan.goals : plan.goal ? [plan.goal] : [];
  return !goals.some((goal) => concurrentPlan.isValidISODate(goal?.date || goal?.raceDate || goal?.race_date));
}

function assertCandidatePlanningDateCurrent(row, now = new Date()) {
  const currentLocalDate = localDateForOffset(now, row.timezone_offset_minutes);
  if (currentLocalDate !== row.planning_date_local) {
    throw candidateError(
      409,
      'CANDIDATE_PLANNING_DATE_CHANGED',
      'Your local date changed. Preview the plan again before applying it.'
    );
  }
  return currentLocalDate;
}

function raceRemovalImpact(plan = {}, raceId) {
  const impact = ownDataRaceRemovalImpact(plan, typeof raceId === 'string' ? raceId : '');
  return impact || Object.freeze({
    rejected: true,
    linked: null,
    remainingRaceIds: Object.freeze([]),
    reason_code: 'RACE_REMOVAL_LINKAGE_INVALID',
  });
}

async function raceRemovalImpactForUser(userId, raceId, tx) {
  const active = await getActivePlanForMutation(userId, tx, {
    includeFuture: true,
    normalizePersistedIdentities: false,
  });
  return active
    ? raceRemovalImpact(persistedPlanPayload(active.row), raceId)
    : Object.freeze({ linked: false, remainingRaceIds: Object.freeze([]) });
}

function raceRemovalCandidateRequest(raceId, remainingRaceIds, body = {}) {
  return {
    planning_date_local: body.planning_date_local,
    timezone_offset_minutes: body.timezone_offset_minutes,
    operation: 'remove_race',
    remove_race_id: String(raceId || ''),
    race_ids: (Array.isArray(remainingRaceIds) ? remainingRaceIds : []).map(String),
  };
}

async function previewRaceRemovalForUser(userId, raceId, body = {}) {
  const state = await withUserMutation(userId, async (tx) => {
    const race = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, userId]);
    if (!race) throw candidateError(404, 'RACE_NOT_FOUND', 'Race not found.');
    const active = await getActivePlanForUser(userId, tx, { includeFuture: true, planningDateLocal: body.planning_date_local });
    const removalSnapshot = active
      ? strictRemovalPlanSnapshot(active.row, body.planning_date_local, raceId) : null;
    const impact = removalSnapshot?.impact || { linked: false, remainingRaceIds: [] };
    return { impact, race };
  });
  if (!state.impact.linked) {
    return {
      requires_apply: false,
      impact: 'direct_remove',
      race: { id: state.race.id, name: state.race.race_name },
    };
  }
  const candidate = await previewPlanForUser(
    userId,
    raceRemovalCandidateRequest(raceId, state.impact.remainingRaceIds, body),
  );
  return {
    ...publicCandidatePayload(candidate),
    impact: 'active_plan_rebuild',
    removal: { race_id: raceId, remaining_race_ids: state.impact.remainingRaceIds },
  };
}

async function deleteOwnedRaceForCandidate(tx, userId, raceId) {
  const race = await tx.get(
    'SELECT id FROM race_events WHERE id=? AND user_id=? FOR UPDATE',
    [raceId, userId],
  );
  if (!race) throw candidateError(404, 'RACE_NOT_FOUND', 'Race not found.');
  const result = await tx.run(
    'DELETE FROM race_events WHERE id=? AND user_id=?',
    [raceId, userId],
  );
  if (result.changes === 0) throw new Error('Owned race deletion failed');
  return true;
}

async function applyPlanCandidate(userId, candidateId, body = {}, constraints = {}) {
  const choice = String(body.choice || '').trim();
  const suppliedHash = String(body.candidate_hash || '').trim();
  const acceptedDate = normalizePlanningDate(body.planning_date_local, { defaultToToday: true });
  if (!acceptedDate) throw candidateError(400, 'INVALID_PLANNING_DATE', 'Use the current phone date.');
  if (choice !== 'train_for_target') {
    throw candidateError(409, 'CANDIDATE_CHOICE_REQUIRES_PREVIEW', 'Preview the revised goal before applying that choice.');
  }
  if (!suppliedHash.startsWith('sha256:')) {
    throw candidateError(400, 'CANDIDATE_HASH_REQUIRED', 'candidate_hash is required.');
  }

  return withPlanningInputMutation(userId, async (tx) => {
    const row = await tx.get(
      'SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=? FOR UPDATE',
      [candidateId, userId]
    );
    if (!row) return planningInputUnchanged({ status: 404, error: 'Candidate not found', code: 'CANDIDATE_NOT_FOUND' });
    let storedGoalBackward = { present: false, bindings: null };
    let expectedApplyEnvelope = null;
    let enforceV24Bindings = false;
    try {
      storedGoalBackward = validateStoredGoalBackwardCandidateBindings(row, { allowedModes: ['shadow', 'preview', 'on'] });
      enforceV24Bindings = storedGoalBackward.present && storedGoalBackward.bindings.feature_mode !== 'shadow';
      if (storedGoalBackward.bindings?.feature_mode === 'preview') {
        return planningInputUnchanged({
          status: 409,
          error: 'This release mode supports preview only. Applying a v2.4 candidate is disabled.',
          code: 'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED',
        });
      }
      if (storedGoalBackward.bindings?.feature_mode === 'on') {
        const runtimeDependencies = constraints.goalBackwardDependencies || {};
        const runtimeMode = resolvePlanGoalBackwardV24Mode(userId, runtimeDependencies);
        if (runtimeMode !== 'on') {
          return planningInputUnchanged({
            status: 409,
            error: 'This v2.4 candidate is not available in the current release mode.',
            code: 'GOAL_BACKWARD_MODE_UNAVAILABLE',
          });
        }
      }
      if (enforceV24Bindings) {
        expectedApplyEnvelope = buildGoalBackwardApplyEnvelope(row);
        await verifyStoredGoalBackwardDecisionHash(tx, userId, row, expectedApplyEnvelope);
        const requestEnvelope = goalBackwardApplyEnvelopeFromRequest(body, candidateId);
        const bindingValidation = validateGoalBackwardApplyEnvelope(expectedApplyEnvelope, requestEnvelope);
        if (!bindingValidation.valid) return staleApplyResult(bindingValidation.code);
      }
    } catch (error) {
      return planningInputUnchanged({
        status: Number(error.status) || 409,
        error: error.message,
        code: error.code || 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INCOMPLETE',
      });
    }
    let constrainedRequest = null;
    if (constraints.requiredOperation || constraints.requiredRaceId) {
      const snapshot = parseCandidateJson(row.planning_snapshot_json, {});
      constrainedRequest = normalizeCandidateRequest(snapshot.request || {});
      if (constraints.requiredOperation && constrainedRequest.operation !== constraints.requiredOperation) {
        return planningInputUnchanged({ status: 409, error: 'Candidate does not match this action.', code: 'CANDIDATE_OPERATION_MISMATCH' });
      }
      if (constraints.requiredRaceId && String(constrainedRequest.remove_race_id || '') !== String(constraints.requiredRaceId)) {
        return planningInputUnchanged({ status: 409, error: 'Candidate does not match this race.', code: 'CANDIDATE_RACE_MISMATCH' });
      }
    }
    if (row.status === 'applied') {
      if (row.applied_choice !== choice || row.candidate_hash !== suppliedHash) {
        return planningInputUnchanged({ status: 409, error: 'Candidate was already applied with different inputs.', code: 'CANDIDATE_REPLAY_CONFLICT' });
      }
      const replay = parseCandidateJson(row.replay_result_json, null);
      if (!replay) return planningInputUnchanged({ status: 409, error: 'Applied candidate replay is unavailable.', code: 'CANDIDATE_REPLAY_UNAVAILABLE' });
      return planningInputUnchanged({ status: 200, replay: true, payload: replay });
    }
    if (row.status !== 'preview') {
      return planningInputUnchanged({ status: 409, error: 'Candidate is no longer available.', code: 'CANDIDATE_UNAVAILABLE' });
    }
    assertCandidatePlanningDateCurrent(row);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return planningInputUnchanged({ status: 409, error: 'Candidate expired. Preview again.', code: 'CANDIDATE_EXPIRED' });
    }
    if (row.planning_date_local !== acceptedDate) {
      return planningInputUnchanged({ status: 409, error: 'The phone date changed. Preview again.', code: 'CANDIDATE_STALE' });
    }
    if (row.candidate_hash !== suppliedHash) {
      return planningInputUnchanged({ status: 409, error: 'Candidate hash does not match.', code: 'CANDIDATE_HASH_MISMATCH' });
    }

    const storedSnapshot = parseCandidateJson(row.planning_snapshot_json, {});
    const storedPlan = parseCandidateJson(row.candidate_plan_json, null);
    const storedFeasibility = String(storedPlan?.overall_feasibility || '').toLowerCase();
    if (storedFeasibility === 'unsafe') {
      return planningInputUnchanged({
        status: 409,
        error: 'This target needs adjustment before it can replace the active plan.',
        code: 'CANDIDATE_UNSAFE',
      });
    }
    if (!candidateFeasibilityCanApply(storedPlan)) {
      return planningInputUnchanged({
        status: 409,
        error: 'Candidate feasibility is unavailable. Preview again.',
        code: 'CANDIDATE_FEASIBILITY_MISSING',
      });
    }
    const request = constrainedRequest || normalizeCandidateRequest(storedSnapshot.request || {});
    const clock = {
      planningDateLocal: row.planning_date_local,
      timezoneOffsetMinutes: Number(row.timezone_offset_minutes),
    };
    const current = await loadCandidateInputState(userId, request, clock, tx);
    if (enforceV24Bindings) {
      const currentEnvelope = currentGoalBackwardApplyEnvelope(expectedApplyEnvelope, userId, current);
      const freshness = validateGoalBackwardApplyEnvelope(expectedApplyEnvelope, currentEnvelope);
      if (!freshness.valid) return staleApplyResult(freshness.code);
    }
    if (current.planningInputRevision !== Number(row.planning_input_revision)
      || current.inputHash !== row.input_hash
      || !sameCapturedActivePlan(row, current.active)) {
      return planningInputUnchanged({ status: 409, error: 'Training inputs changed. Preview again.', code: 'CANDIDATE_STALE' });
    }

    const fresh = buildDeterministicCandidate(current.context, {
      planningDateLocal: clock.planningDateLocal,
      timezoneOffsetMinutes: clock.timezoneOffsetMinutes,
    });
    if (!fresh.validation.valid) {
      return planningInputUnchanged({ status: 409, error: 'Candidate no longer passes validation.', code: 'CANDIDATE_INVALID' });
    }
    const currentSemanticErrors = enforceV24Bindings
      ? []
      : storedPlan?.planMode === 'hyrox_build'
        ? hyroxPlan.validateHyroxPlan(storedPlan).errors
        : semanticCandidateErrors(storedPlan, current.context, clock.planningDateLocal);
    let deterministicMismatch = currentSemanticErrors.length > 0;
    if (enforceV24Bindings) {
      let currentGoalBackward = null;
      try {
        currentGoalBackward = computeGoalBackwardShadowDiagnostics({
          userId,
          state: current,
          built: fresh,
          planningDateLocal: clock.planningDateLocal,
        }, constraints.goalBackwardDependencies || {});
      } catch (_error) {
        deterministicMismatch = true;
      }
      const currentApplicablePlan = applicableGoalBackwardPlan(fresh.plan, currentGoalBackward);
      const currentSelectedHash = prefixedGoalBackwardCandidateHash(
        currentGoalBackward?.selected_candidate?.candidate_hash,
      );
      deterministicMismatch = deterministicMismatch
        || !currentApplicablePlan
        || currentSelectedHash !== row.candidate_hash
        || prefixedHash(currentApplicablePlan) !== prefixedHash(storedPlan);
    } else {
      deterministicMismatch = deterministicMismatch
        || prefixedHash(storedPlan) !== row.candidate_hash
        || prefixedHash(fresh.plan) !== row.candidate_hash;
    }
    if (deterministicMismatch) {
      return planningInputUnchanged({ status: 409, error: 'Candidate could not be reproduced safely.', code: 'CANDIDATE_DETERMINISM_MISMATCH' });
    }
    const validatedPlan = assertPersistablePlan(storedPlan);
    const active = current.active ? await getActivePlanForMutation(userId, tx, {
      includeFuture: true,
      planningDateLocal: clock.planningDateLocal,
      normalizePersistedIdentities: false,
    }) : null;
    if (!sameCapturedActivePlan(row, active)) {
      return planningInputUnchanged({ status: 409, error: 'Active plan changed. Preview again.', code: 'CANDIDATE_STALE' });
    }

    // Recheck at the write boundary so a midnight cutover rolls back this transaction.
    assertCandidatePlanningDateCurrent(row);
    await pruneExpiredPlanCandidates(tx, userId, { excludeCandidateId: row.id });
    const schedule = validatedPlan.schedulePreferences || {};
    if (schedule.runDaysSource === 'target' && schedule.trainingDaysSource === 'target') {
      const preferenceResult = await tx.run(
        'UPDATE users SET run_days_per_week=?, preferred_workout_days=? WHERE id=?',
        [schedule.runDaysPerWeek, JSON.stringify(schedule.trainingDays || []), userId]
      );
      if (preferenceResult.changes === 0) throw new Error('Plan preferences update failed');
    }

    const effectiveFrom = candidateEffectiveFrom(active, row.planning_date_local, { immediate: true });
    const planId = uuidv4();
    const userPlanId = uuidv4();
    const replacementLineage = replacementLineageForActivePlan(active, userPlanId);
    const serialized = JSON.stringify(validatedPlan);
    const weekStart = validatedPlan.weeks?.[0]?.startDate || effectiveFrom;
    if (replacementLineage.supersedesUserPlanId) {
      const supersede = await tx.run(
        "UPDATE user_plans SET status='superseded' WHERE id=? AND user_id=? AND status='active'",
        [replacementLineage.supersedesUserPlanId, userId]
      );
      if (supersede.changes === 0) throw new Error('Active plan supersede failed');
    }
    await tx.run(
      `INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [planId, userId, weekStart, serialized, current.meta.name, current.meta.type, validatedPlan.weeks.length, current.meta.description, serialized]
    );
    await tx.run(
      `INSERT INTO user_plans (
         id, user_id, plan_id, started_at, current_week, status, progress_json,
         plan_version, lineage_id, supersedes_user_plan_id, effective_from
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userPlanId,
        userId,
        planId,
        effectiveFrom,
        1,
        'active',
        JSON.stringify({ completedSessionIds: [] }),
        replacementLineage.priorVersion + 1,
        replacementLineage.lineageId,
        replacementLineage.supersedesUserPlanId,
        effectiveFrom,
      ]
    );
    if (request.operation === 'remove_race') {
      await deleteOwnedRaceForCandidate(tx, userId, request.remove_race_id);
    }
    const payload = {
      candidate_id: row.id,
      candidate_hash: row.candidate_hash,
      effective_from: effectiveFrom,
      ok: true,
      plan_id: planId,
      user_plan_id: userPlanId,
    };
    validateCandidateBundle({
      plan: validatedPlan,
      snapshot: storedSnapshot,
      trace: parseCandidateJson(row.generation_trace_json, {}),
      replay: payload,
    });
    const candidateUpdate = await tx.run(
      `UPDATE plan_generation_candidates
       SET status='applied', applied_choice=?, applied_training_plan_id=?, applied_user_plan_id=?,
           replay_result_json=?, applied_at=CURRENT_TIMESTAMP
       WHERE id=? AND user_id=? AND status='preview'`,
      [choice, planId, userPlanId, JSON.stringify(payload), row.id, userId]
    );
    if (candidateUpdate.changes === 0) throw new Error('Candidate apply status update failed');
    return { status: 200, payload };
  });
}

async function rejectPlanCandidate(userId, candidateId, body = {}) {
  return withUserMutation(userId, async (tx) => {
    const row = await tx.get(
      'SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=? FOR UPDATE',
      [candidateId, userId],
    );
    if (!row) return { status: 404, error: 'Candidate not found', code: 'CANDIDATE_NOT_FOUND' };
    let expected;
    let storedGoalBackward;
    try {
      storedGoalBackward = validateStoredGoalBackwardCandidateBindings(row, { allowedModes: ['shadow', 'preview', 'on'] });
      expected = buildGoalBackwardApplyEnvelope(row);
      await verifyStoredGoalBackwardDecisionHash(tx, userId, row, expected);
    } catch (error) {
      return {
        status: Number(error.status) || 409,
        error: error.message,
        code: error.code || 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INCOMPLETE',
      };
    }
    if (storedGoalBackward.bindings.feature_mode === 'shadow') {
      if (String(body.candidate_hash || '') !== String(expected.candidate_hash || '')) {
        return staleApplyResult('CANDIDATE_HASH_MISMATCH').value;
      }
    } else {
      const requestEnvelope = goalBackwardApplyEnvelopeFromRequest(body, candidateId);
      const bindingValidation = validateGoalBackwardApplyEnvelope(expected, requestEnvelope);
      if (!bindingValidation.valid) {
        const stale = staleApplyResult(bindingValidation.code);
        return stale.value;
      }
    }
    if (row.status === 'applied') {
      return { status: 409, error: 'An applied candidate cannot be rejected.', code: 'CANDIDATE_ALREADY_APPLIED' };
    }
    if (!['preview', 'superseded'].includes(row.status)) {
      return { status: 409, error: 'Candidate is no longer available.', code: 'CANDIDATE_UNAVAILABLE' };
    }
    const rejection = buildCandidateRejectionRecord({
      userId,
      candidateHash: expected.candidate_hash,
      decisionId: expected.decision_id,
      decisionHash: expected.decision_hash,
      reasonCode: body.reason_code || 'ADAPTATION_REJECTED',
      evidenceFingerprint: expected.evidence_fingerprint,
      constraintFingerprint: expected.constraint_fingerprint,
      policyFingerprint: expected.policy_fingerprint,
    });
    const persisted = await persistCandidateRejection({ tx, rejection });
    if (row.status === 'preview') {
      const update = await tx.run(
        `UPDATE plan_generation_candidates
         SET status='superseded'
         WHERE id=? AND user_id=? AND status='preview'`,
        [row.id, userId],
      );
      if (Number(update?.changes || 0) === 0) {
        throw new Error('Candidate rejection status update failed');
      }
    }
    return {
      status: 200,
      replay: !persisted.inserted,
      payload: {
        candidate_id: row.id,
        candidate_hash: row.candidate_hash,
        status: 'rejected',
        applied: false,
        active_plan_unchanged: true,
        reason_code: rejection.reason_code,
      },
    };
  });
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

function proposalDecisionConflict(row, body = {}) {
  const suppliedRevision = String(body?.proposal_revision || '').trim();
  const suppliedPlanVersion = String(body?.proposal_plan_version || '').trim();
  const expectedRevision = String(proposalDecisionRevision(row) || '');
  const expectedPlanVersion = String(row?.plan_version || '');
  if (!suppliedRevision || !suppliedPlanVersion) {
    return {
      code: 'ADAPTATION_DECISION_TOKEN_REQUIRED',
      reason: 'This adjustment needs to be refreshed before Forge can save your choice.',
    };
  }
  if (suppliedRevision !== expectedRevision || suppliedPlanVersion !== expectedPlanVersion) {
    return {
      code: 'ADAPTATION_PROPOSAL_CHANGED',
      reason: 'This adjustment changed after it was displayed. Review the refreshed proposal before choosing.',
    };
  }
  return null;
}

function completedSessionIdsFromProgress(progress) {
  return Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds.map(String) : [];
}

function removedSessionIdsFromProgress(progress) {
  return Array.isArray(progress?.removedSessionIds) ? progress.removedSessionIds.map(String) : [];
}

function assignmentStartForRemovalIdentity(activeRow = {}) {
  return activeRow.week_start || activeRow.effective_from || activeRow.started_at || null;
}

function planWithRemovalSessionIdentities(plan, activeRow) {
  return planSchema.withRemovalSessionIdentities(plan, {
    assignmentStart: assignmentStartForRemovalIdentity(activeRow),
  });
}

function planWithoutRemovedSessions(plan, progress, activeRow) {
  return planSchema.visiblePlanForAssignment(plan, {
    ...activeRow,
    progress_json: progress,
  });
}

function canonicalAdaptationPlan(active) {
  if (!active?.row) return null;
  return planWithoutRemovedSessions(
    parsePlan(active.row),
    parseJsonValue(active.row.progress_json, {}),
    active.row
  );
}

function findPlanSession(plan, activeRow, sessionId) {
  const wanted = String(sessionId || '');
  const identified = planWithRemovalSessionIdentities(plan, activeRow);
  const weeks = Array.isArray(identified?.weeks) ? identified.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex];
    const entries = planSchema.getDayEntries(week);
    for (let dayIndex = 0; dayIndex < entries.length; dayIndex += 1) {
      const day = entries[dayIndex];
      const storedSessions = Array.isArray(day?.sessions) ? day.sessions : [day];
      for (let sessionIndex = 0; sessionIndex < storedSessions.length; sessionIndex += 1) {
        const stored = storedSessions[sessionIndex];
        if (planSchema.kindFromSession(stored) === 'rest') continue;
        const removalId = planSchema.removalSessionIdentifier(day, stored);
        if (!removalId || removalId !== wanted) continue;
        return {
          date: String(day?.date || '').slice(0, 10),
          id: removalId,
          kind: planSchema.kindFromSession(stored),
          progressId: planSchema.sessionIdentifier(day, stored, sessionIndex, dayIndex),
          storedCompleted: planSchema.isStoredSessionCompleted(day, stored),
        };
      }
    }
  }
  return null;
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

    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
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
    const visiblePlan = planWithoutRemovedSessions(parsed, progress, active.row);
    const reconciliation = hybridReconciliation.buildCurrentPrompt({
      plan: visiblePlan,
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
      const active = await getAssignedPlanForMutation(req.user.id, tx, {
        planningDateLocal: planningDateISO,
      });
      if (!active) return planningInputUnchanged({ notFound: true });
      const row = active.row;
      const parsed = parsePlan(row);
      if (!parsed || !planSchema.isSchemaV2(parsed)) {
        return planningInputUnchanged({ conflict: 'Hybrid reconciliation requires a dated plan.' });
      }
      const progress = parseJsonValue(row.progress_json, {});
      const visiblePlan = planWithoutRemovedSessions(parsed, progress, row);
      const candidates = hybridReconciliation.hybridCandidates(visiblePlan, sessionDate, planningDateISO);
      const candidate = candidates.find((item) => item.liftSessionId === liftSessionId) || null;
      if (!candidate) {
        return planningInputUnchanged({ conflict: 'The planned hybrid session changed. Refresh Today and try again.' });
      }
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
      const runDetected = candidate.runSessionIds.some((id) => completed.has(id))
        || candidate.storedCompletedRunSessionIds.length > 0
        || evidence.runDates.includes(sessionDate);
      const liftDetected = candidate.liftStoredCompleted || liftAllocation.completedKeys.has(candidate.key);
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
    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });
    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
    if (!active) return res.json({ proposal: null, reason: 'No active plan is assigned yet.' });
    const parsed = canonicalAdaptationPlan(active);
    if (!parsed || !planSchema.isSchemaV2(parsed)) {
      return res.json({ proposal: null, reason: 'Transparent adaptation is available for schema-v2 dated calendars only.' });
    }

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
    const runGapDisposition = adaptationEpisodeDisposition(runGapEpisode, planVersion);
    if (runGapDisposition === 'reuse') {
      const pendingProposal = proposalFromRow(runGapEpisode);
      if (pendingProposal.changes.length > 0) {
        return res.json({ proposal: publicProposal(pendingProposal) });
      }
    }
    if (completionDecisionExists || runGapDisposition === 'decided') {
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

    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
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
    const parsed = canonicalAdaptationPlan(active);
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
      const decisionConflict = proposalDecisionConflict(row, req.body);
      if (decisionConflict) {
        return planningInputUnchanged({ conflict: true, refreshRequired: true, ...decisionConflict });
      }
      if (row.status === 'accepted') {
        return planningInputUnchanged({ ok: true, status: 'accepted', proposal: proposalFromRow(row), idempotent: true });
      }
      if (row.status !== 'pending') {
        return planningInputUnchanged({ conflict: true, reason: 'Proposal is no longer pending.' });
      }

      const active = await getActivePlanForMutation(req.user.id, tx, {
        planningDateLocal: normalizePlanningDate(row.planning_date, { defaultToToday: true }),
      });
      if (!active) return planningInputUnchanged({ conflict: true, reason: 'No active plan is assigned.' });
      const parsed = canonicalAdaptationPlan(active);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        const update = await tx.run(
          "UPDATE plan_adjustment_proposals SET status='superseded', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
          [row.id, req.user.id]
        );
        if (update.changes === 0) {
          return planningInputUnchanged({ conflict: true, code: 'ADAPTATION_NOT_PENDING', reason: 'Proposal is no longer pending.' });
        }
        return planningInputUnchanged({
          conflict: true,
          code: 'ADAPTATION_STALE',
          refreshRequired: true,
          reason: 'The active plan changed after this proposal was computed.',
        });
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
    if (result.conflict) return res.status(409).json({
      error: result.reason,
      code: result.code || 'ADAPTATION_CONFLICT',
      refresh_required: Boolean(result.refreshRequired),
    });
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
      const decisionConflict = proposalDecisionConflict(row, req.body);
      if (decisionConflict) {
        return planningInputUnchanged({ conflict: true, refreshRequired: true, ...decisionConflict });
      }
      if (row.status === 'kept') {
        return planningInputUnchanged({ ok: true, status: 'kept', proposal: proposalFromRow(row), idempotent: true });
      }
      if (row.status !== 'pending') {
        return planningInputUnchanged({ conflict: true, reason: 'Proposal is no longer pending.' });
      }
      const active = await getActivePlanForMutation(req.user.id, tx, {
        planningDateLocal: normalizePlanningDate(row.planning_date, { defaultToToday: true }),
      });
      if (!active) return planningInputUnchanged({ conflict: true, reason: 'No active plan is assigned.' });
      const parsed = canonicalAdaptationPlan(active);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        const update = await tx.run(
          "UPDATE plan_adjustment_proposals SET status='superseded', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
          [row.id, req.user.id]
        );
        if (update.changes === 0) {
          return planningInputUnchanged({ conflict: true, code: 'ADAPTATION_NOT_PENDING', reason: 'Proposal is no longer pending.' });
        }
        return planningInputUnchanged({
          conflict: true,
          code: 'ADAPTATION_STALE',
          refreshRequired: true,
          reason: 'The active plan changed after this proposal was computed.',
        });
      }
      const update = await tx.run(
        "UPDATE plan_adjustment_proposals SET status='kept', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
        [row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Proposal keep status update failed');
      return { ok: true, status: 'kept', proposal: proposalFromRow({ ...row, status: 'kept' }) };
    });

    if (result.notFound) return res.status(404).json({ error: 'Proposal not found' });
    if (result.conflict) return res.status(409).json({
      error: result.reason,
      code: result.code || 'ADAPTATION_CONFLICT',
      refresh_required: Boolean(result.refreshRequired),
    });
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

router.post('/preview', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const candidate = await previewPlanForUser(req.user.id, withRequestPlanningClock(req, req.body));
    return res.status(201).json(publicCandidatePayload(candidate));
  } catch (err) {
    return sendCandidateError(res, err, 'preview');
  }
});

router.post('/candidates/:candidateId/apply', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const candidateId = String(req.params.candidateId || '').trim();
    if (!candidateId || candidateId.length > 128) {
      throw candidateError(400, 'INVALID_CANDIDATE_ID', 'Candidate ID is required.');
    }
    const result = await applyPlanCandidate(
      req.user.id,
      candidateId,
      withRequestPlanningClock(req, req.body)
    );
    const releaseMode = resolveOperationalGoalBackwardV24Mode(undefined, { userId: req.user.id });
    const releaseCode = RELEASE_OUTCOME_REASON_CODES.has(result.code)
      ? result.code : result.error ? 'UNCLASSIFIED' : 'CANDIDATE_APPLIED';
    const revisionMismatch = /STALE|CHANGED|MISMATCH/.test(releaseCode);
    if (releaseMode !== 'off') emitPlanReleaseTelemetry({
      userId: req.user.id,
      eventType: 'candidate_outcome',
      mode: releaseMode,
      outcome: result.error
        ? (revisionMismatch ? 'stale_rejected' : 'apply_rejected')
        : 'applied',
      candidateSelected: !result.error && releaseMode === 'on',
      passReasonCodes: result.error ? [] : ['CANDIDATE_APPLIED'],
      failReasonCodes: result.error
        ? [...new Set([releaseCode, ...(revisionMismatch ? ['REVISION_MISMATCH'] : [])])]
        : [],
      surfaceCapability: result.error
        ? 'BLOCKED'
        : releaseMode === 'shadow' ? 'NOT_EXPOSED' : 'EXECUTABLE',
      revisionMismatch,
    });
    if (result.error) return res.status(result.status || 409).json({ error: result.error, code: result.code });
    return res.status(result.status || 200).json({ ...result.payload, replay: Boolean(result.replay) });
  } catch (err) {
    return sendCandidateError(res, err, 'candidate-apply');
  }
});

router.post('/candidates/:candidateId/reject', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const candidateId = String(req.params.candidateId || '').trim();
    if (!candidateId || candidateId.length > 128) {
      throw candidateError(400, 'INVALID_CANDIDATE_ID', 'Candidate ID is required.');
    }
    const result = await rejectPlanCandidate(req.user.id, candidateId, req.body || {});
    const releaseMode = resolveOperationalGoalBackwardV24Mode(undefined, { userId: req.user.id });
    if (releaseMode !== 'off') emitPlanReleaseTelemetry({
      userId: req.user.id,
      eventType: 'candidate_outcome',
      mode: releaseMode,
      outcome: result.error ? 'apply_rejected' : 'candidate_rejected',
      candidateSelected: false,
      passReasonCodes: result.error ? [] : ['CANDIDATE_REJECTED'],
      failReasonCodes: result.error ? ['UNCLASSIFIED'] : [],
      surfaceCapability: 'BLOCKED',
    });
    if (result.error) return res.status(result.status || 409).json({ error: result.error, code: result.code });
    return res.status(result.status || 200).json({ ...result.payload, replay: Boolean(result.replay) });
  } catch (err) {
    return sendCandidateError(res, err, 'candidate-reject');
  }
});

router.post('/adaptive/accept', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    const current = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
    const currentPlan = current ? parsePlan(current.row) : null;
    if (planSchema.isSchemaV2(currentPlan)
      && (Array.isArray(currentPlan.goals) || currentPlan.goal?.date || currentPlan.goal?.raceDate)) {
      return res.status(409).json({
        error: 'Preview and apply a new race plan instead of replacing the active plan.',
        code: 'RACE_PLAN_PREVIEW_REQUIRED',
      });
    }
    const adaptive = await buildAdaptiveRecommendation(req.user.id, req.body || {});
    if (!adaptive) return res.status(404).json({ error: 'User not found' });

    const weekStart = getMonday();
    const planId = uuidv4();
    const userPlanId = uuidv4();
    const planData = assertPersistablePlan({ weeks: [{ week: 1, sessions: adaptive.sessions }] });
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

router.post('/my/surface-reconcile', auth, async (req, res) => {
  const bodyKeys = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? Object.keys(req.body) : req.body == null ? [] : ['invalid'];
  const queryKeys = req.query && typeof req.query === 'object' && !Array.isArray(req.query)
    ? Object.keys(req.query) : [];
  if (bodyKeys.length || queryKeys.length) {
    return res.status(400).json({
      ok: false,
      error: 'Plan recovery does not accept plan or account details.',
    });
  }
  try {
    return res.json(await reconcileActiveSurfaceForUser(req.user.id));
  } catch (err) {
    if (err?.code === 'SURFACE_RECONCILE_REVIEW_REQUIRED') {
      return res.status(409).json({ ok: false, error: SURFACE_RECONCILE_REVIEW_MESSAGE });
    }
    console.error('[plans/my/surface-reconcile] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Plan recovery is temporarily unavailable.' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
    if (!active) return res.json({ plan: null });
    if (active.source === 'legacy') {
      const legacy = active.row;
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
    const row = active.row;
    let progress = {};
    try {
      progress = JSON.parse(row.progress_json || '{}');
    } catch (err) {
      console.error('[plans/my] invalid progress JSON:', err.message);
    }
    const servedPlan = await buildAdaptivePlanView(req.user.id, parsePlan(row) || { weeks: [] }, Number(row.current_week || 1));
    const parsedPlan = withDurationEstimatePlanPayload(planWithoutRemovedSessions(servedPlan, progress, row));
    const anchorPayload = planAnchorPayload(parsedPlan);
    const lineageRows = row.lineage_id ? await dbAll(
      `SELECT up.id, up.plan_id, up.status, up.started_at, up.effective_from,
              up.plan_version, up.progress_json, tp.plan_data
       FROM user_plans up
       JOIN training_plans tp ON tp.id=up.plan_id
       WHERE up.user_id=? AND up.lineage_id=? AND up.id<>?
       ORDER BY up.plan_version DESC
       LIMIT 8`,
      [req.user.id, row.lineage_id, row.user_plan_id]
    ) : [];
    const lineageHistory = lineageRows.map((prior) => ({
      effective_from: prior.effective_from || prior.started_at || null,
      id: prior.id,
      plan_data: withDurationEstimatePlanPayload(parsePlan(prior) || { weeks: [] }),
      plan_id: prior.plan_id,
      plan_version: Number(prior.plan_version || 1),
      progress: parseJsonValue(prior.progress_json, {}),
      status: prior.status,
    }));
    const surfaceField = await canonicalSurfaceResponseField(req.user.id, row);
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
        effective_from: row.effective_from || row.started_at,
        id: row.user_plan_id,
        lineage_id: row.lineage_id || row.user_plan_id,
        plan_version: Number(row.plan_version || 1),
        started_at: row.started_at,
        supersedes_user_plan_id: row.supersedes_user_plan_id || null,
        current_week: Number(row.current_week || 1),
        status: row.status,
        progress,
      },
      lineage_history: lineageHistory,
      ...surfaceField,
    });
  } catch (err) {
    console.error('[plans/my] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch user plan' });
  }
});

router.put('/my/race-link', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    const raceId = String(req.body?.race_id || '').trim();
    if (!raceId || raceId.length > 128) return res.status(400).json({ error: 'race_id is required' });

    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const race = await tx.get('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]);
      if (!race) return planningInputUnchanged({ status: 404, error: 'Race not found' });
      const active = await getActivePlanForMutation(req.user.id, tx, { planningDateLocal: planningDateISO });
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
    const planningDateISO = getPlanningDateFromRequest(req);
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
      const findAssigned = async () => {
        const assigned = await getAssignedPlanForMutation(req.user.id, tx, {
          planningDateLocal: planningDateISO,
        });
        return assigned?.row || null;
      };
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

      if (legacyPlanId) {
        const legacyActive = await normalizeActivePlanIdentitiesForMutation({
          source: 'legacy',
          row: { ...row, id: legacyPlanId, user_id: req.user.id },
        }, req.user.id, tx);
        row.plan_data = legacyActive.row.plan_data;
        row.plan_json = legacyActive.row.plan_json;
      }
      const parsed = parsePlan(row);
      const visiblePlan = planWithoutRemovedSessions(parsed, parseJsonValue(row.progress_json, {}), row);
      const sessionIds = dailyExecution.collectSessionIds(visiblePlan);
      const requestedId = completedId || unsetId;
      if (requestedId && !sessionIds.has(requestedId)) return planningInputUnchanged({ invalidSession: true });
      if (completedId && Number(parsed?.canonical_workout_schema_version) === 1) {
        const manifest = await canonicalSurfaceManifestForActive(
          req.user.id,
          row,
          (sql, params) => tx.get(sql, params),
        );
        const startDecision = canonicalWorkoutStartDecision({
          manifest,
          access: body.workout_start_access || null,
          sessionId: completedId,
          activity: {},
        });
        if (!startDecision.allowed) {
          return planningInputUnchanged({
            startAccessError: true,
            status: 409,
            code: startDecision.reasonCode,
          });
        }
      }

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
          `INSERT INTO user_plans (
             id, user_id, plan_id, started_at, current_week, status, progress_json,
             plan_version, lineage_id, effective_from
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            row.id,
            req.user.id,
            legacyPlanId,
            row.week_start || planningDateISO,
            1,
            'active',
            JSON.stringify({ completedSessionIds: [] }),
            1,
            row.id,
            row.week_start || planningDateISO,
          ]
        );
        if (insert.changes === 0) throw new Error('Legacy plan assignment migration failed');
      }

      const assignmentId = row.user_plan_id || row.id;
      const update = await tx.run(
        'UPDATE user_plans SET current_week = ?, progress_json = ? WHERE id = ? AND user_id = ?',
        [nextWeek, JSON.stringify({ ...progress, completedSessionIds: Array.from(completed) }), assignmentId, req.user.id]
      );
      if (update.changes === 0) throw new Error('Active plan progress update failed');
      return { ok: true, current_week: nextWeek, completedSessionIds: Array.from(completed) };
    });

    if (result.notFound) return res.status(404).json({ error: 'No assigned plan' });
    if (result.invalidSession) return res.status(400).json({ error: 'Invalid plan session' });
    if (result.invalidWeek) return res.status(400).json({ error: 'Invalid plan week' });
    if (result.startAccessError) {
      return res.status(result.status || 409).json({
        error: 'The workout safety revision changed. Refresh Today or Train before linking completion.',
        code: result.code || 'WORKOUT_START_ACCESS_UNAVAILABLE',
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[plans/my/progress] failed:', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.delete('/my/sessions/:sessionId', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'Use the current phone date.', code: 'INVALID_PLANNING_DATE' });
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId || sessionId.length > 512 || !sessionId.startsWith('remove:v1:')) {
      return res.status(400).json({ error: 'Invalid plan session.', code: 'INVALID_PLAN_SESSION' });
    }

    const result = await withPlanningInputMutation(req.user.id, async (tx) => {
      const active = await getAssignedPlanForMutation(req.user.id, tx, { planningDateLocal: planningDateISO });
      if (!active) return planningInputUnchanged({ status: 404, error: 'No assigned plan.', code: 'PLAN_NOT_FOUND' });
      const parsed = parsePlan(active.row);
      if (!parsed) return planningInputUnchanged({ status: 409, error: 'Active plan could not be read.', code: 'PLAN_UNREADABLE' });
      const session = findPlanSession(parsed, active.row, sessionId);
      if (!session) return planningInputUnchanged({ status: 404, error: 'Scheduled workout not found.', code: 'PLAN_SESSION_NOT_FOUND' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
        return planningInputUnchanged({ status: 409, error: 'This workout has no reliable scheduled date.', code: 'PLAN_SESSION_DATE_UNKNOWN' });
      }
      if (session.date < planningDateISO) {
        return planningInputUnchanged({ status: 409, error: 'Past workouts stay in training history.', code: 'PLAN_SESSION_IN_PAST' });
      }

      const progress = parseJsonValue(active.row.progress_json, {});
      const completed = new Set(completedSessionIdsFromProgress(progress));
      if (session.storedCompleted || completed.has(session.progressId)) {
        return planningInputUnchanged({ status: 409, error: 'Completed workouts stay in training history.', code: 'PLAN_SESSION_COMPLETED' });
      }
      const removed = new Set(removedSessionIdsFromProgress(progress));
      if (removed.has(sessionId)) {
        return planningInputUnchanged({
          status: 200,
          ok: true,
          idempotent: true,
          removedSessionIds: Array.from(removed),
        });
      }
      removed.add(sessionId);
      const nextProgress = { ...progress, removedSessionIds: Array.from(removed) };
      const update = await tx.run(
        'UPDATE user_plans SET progress_json=? WHERE id=? AND user_id=?',
        [JSON.stringify(nextProgress), active.row.user_plan_id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Plan session removal update failed');
      return {
        status: 200,
        ok: true,
        removed: { id: session.id, date: session.date, kind: session.kind },
        removedSessionIds: Array.from(removed),
      };
    });

    if (result.error) return res.status(result.status || 409).json({ error: result.error, code: result.code });
    return res.status(result.status || 200).json({
      ok: result.ok,
      idempotent: Boolean(result.idempotent),
      removed: result.removed || null,
      removedSessionIds: result.removedSessionIds || [],
    });
  } catch (err) {
    console.error('[plans/my/sessions/delete] failed:', err.message);
    return res.status(500).json({ error: 'Could not remove this scheduled workout.', code: 'PLAN_SESSION_REMOVE_FAILED' });
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

    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: dateISO });
    if (!active) return res.status(404).json({ error: 'Active plan not found' });
    const progress = active.source === 'assigned' ? parseJsonValue(active.row.progress_json, {}) : {};
    const parsed = planWithoutRemovedSessions(parsePlan(active.row), progress, active.row);
    if (!parsed) return res.status(409).json({ error: 'Active plan could not be read' });

    const override = await dbGet(
      'SELECT patch_json FROM checkin_overrides WHERE user_id=? AND date=?',
      [req.user.id, dateISO]
    );
    const patch = dailyExecution.parseCheckinOverridePatch(override?.patch_json);
    const selection = dailyExecution.resolvePlanDayForDate({ plan: parsed, dateISO, patch });
    if (!selection.selectedEntry || String(selection.selectedEntry.date || '') !== dateISO) {
      return res.status(404).json({ error: 'Scheduled lift session not found for this date' });
    }
    if (planSchema.isRestOverridePatch(patch)) {
      return res.status(409).json({
        error: 'Today was changed to recovery by your check-in. Keep the rest day or update your check-in first.',
        code: 'CHECKIN_REST_OVERRIDE',
      });
    }

    const entry = selection.selectedEntry;
    const storedSessions = Array.isArray(entry.sessions)
      ? entry.sessions
      : planSchema.isRestEntry(entry) ? [] : [entry];
    let exactSession = null;
    let exactKind = null;
    for (let index = 0; index < storedSessions.length; index += 1) {
      const stored = storedSessions[index];
      const stableId = planSchema.sessionIdentifier(entry, stored, index, selection.selectedDayIndex);
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
    if (planSchema.kindFromLegacy(exactSession) === 'rest') {
      return res.status(409).json({
        error: 'Recovery guidance cannot be translated into a strength workout.',
        code: 'PLAN_SESSION_IS_REST',
      });
    }

    const completedIds = new Set(completedSessionIdsFromProgress(progress).map(String));
    const storedStatus = String(
      storedSessions.find((stored, index) => (
        planSchema.sessionIdentifier(entry, stored, index, selection.selectedDayIndex) === sessionId
      ))?.status || ''
    ).toLowerCase();
    if (
      completedIds.has(sessionId)
      || storedSessions.some((stored, index) => (
        planSchema.sessionIdentifier(entry, stored, index, selection.selectedDayIndex) === sessionId
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
      week: selection.selectedWeek?.week ?? selection.weekIndex + 1,
      phase: selection.selectedWeek?.phase || null,
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

router.post('/today/start-access', auth, async (req, res) => {
  try {
    const dateISO = getPlanningDateFromRequest(req);
    if (dateISO === null) return res.status(400).json({ error: 'Invalid date', code: 'INVALID_PLANNING_DATE' });
    const sessionId = req.body?.session_id === null || req.body?.session_id === undefined
      ? null : String(req.body.session_id).trim();
    if (sessionId && sessionId.length > 128) {
      return res.status(400).json({ error: 'Invalid plan session', code: 'INVALID_PLAN_SESSION' });
    }
    const activity = req.body?.activity && typeof req.body.activity === 'object'
      && !Array.isArray(req.body.activity) ? req.body.activity : {};
    if (JSON.stringify(activity).length > 4096) {
      return res.status(400).json({ error: 'Invalid workout start context', code: 'INVALID_START_CONTEXT' });
    }
    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: dateISO });
    const manifest = active ? await canonicalSurfaceManifestForActive(req.user.id, active.row) : null;
    const decision = canonicalWorkoutStartDecision({
      manifest,
      access: req.body?.workout_start_access || null,
      sessionId,
      activity,
    });
    if (!decision.allowed) {
      return res.status(409).json({
        allowed: false,
        code: decision.reasonCode,
        reasonCode: decision.reasonCode,
        access: decision.access,
      });
    }
    return res.json({
      allowed: true,
      reasonCode: null,
      access: decision.access,
      legacy: decision.legacy === true,
    });
  } catch (err) {
    console.error('[plans/today/start-access] failed:', err.message);
    return res.status(500).json({
      allowed: false,
      error: 'Could not verify workout safety.',
      code: 'WORKOUT_START_ACCESS_UNAVAILABLE',
    });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    // H5: accept a phone-local date (+/-1 day safety, same rule as H4).
    const dateISO = getPlanningDateFromRequest(req);
    if (dateISO === null) return res.status(400).json({ error: 'Invalid date' });

    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: dateISO });
    if (!active) return res.json({ today: null, execution: { hasPlan: false, hasDay: false, date: dateISO } });
    const planViews = planSchema.planViewsForAssignment(parsePlan(active.row), active.row);
    const progress = active.source === 'assigned' ? planViews.progress : {};
    const parsed = withDurationEstimatePlanPayload(planViews.visiblePlan);
    const anchorPayload = planAnchorPayload(parsed);

    const override = await dbGet(
      'SELECT patch_json FROM checkin_overrides WHERE user_id=? AND date=?',
      [req.user.id, dateISO]
    );
    const patch = dailyExecution.parseCheckinOverridePatch(override?.patch_json);
    const resolvedToday = dailyExecution.resolvePlanDayForDate({ plan: parsed, dateISO, patch });
    const storedToday = dailyExecution.resolvePlanDayForDate({ plan: planViews.storedPlan, dateISO });
    const {
      weekdayShort,
      selectedEntry,
      selectedWeek,
      selectedDayIndex,
    } = resolvedToday;

    // Legacy `today` shape is preserved for existing consumers.
    const overriddenDay = selectedEntry ? planSchema.flattenDayForConsumer(selectedEntry) : null;
    const legacyToday = overriddenDay
      ? withDurationEstimateDayPayload(withPlanAnchorPayload(overriddenDay, parsed), parsed)
      : null;

    // Completion state + calibrated HR profile for the canonical execution object.
    const hrProfile = await getHrProfile(req.user.id, dbGet);
    const completedSessionIds = completedSessionIdsFromProgress(progress);

    const effortEntry = withPlanEffortDayPayload(selectedEntry, hrProfile);
    const effortToday = withPlanEffortDayPayload(legacyToday, hrProfile);
    const restSource = dailyExecution.restSourceForPlanEntries(storedToday.selectedEntry, resolvedToday.baseEntry);
    const execution = dailyExecution.buildDailyExecution({
      plan: parsed,
      dateISO,
      weekdayShort,
      selectedEntry: effortEntry,
      selectedWeek,
      selectedDayIndex,
      completedSessionIds,
      hrProfile,
      restSource,
    });
    const surfaceField = await canonicalSurfaceResponseField(req.user.id, active.row);

    res.json({
      today: effortToday,
      execution: withPlanAnchorPayload(withDurationEstimateExecutionPayload(execution, parsed), parsed),
      ...anchorPayload,
      ...surfaceField,
    });
    void requestImagesForWorkoutItems({
      userId: req.user.id,
      items: uniqueLiftExerciseItems(execution.lift ? [execution.lift] : []),
      source: 'scheduled_plan_today',
      ensureOnly: true,
    }).catch((queueErr) => console.error('[plans/today] exercise image review queue failed:', queueErr.message));
  } catch (err) {
    console.error('[plans] GET today failed:', err);
    res.status(500).json({ error: 'Failed to fetch today' });
  }
});

router.get('/current', auth, async (req, res) => {
  try {
    const planningDateISO = getPlanningDateFromRequest(req);
    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
    if (!active) return res.json({ plan: null });
    const servedPlan = await buildAdaptivePlanView(
      req.user.id,
      parsePlan(active.row) || { weeks: [] },
      Number(active.row.current_week || 1)
    );
    const progress = active.source === 'assigned' ? parseJsonValue(active.row.progress_json, {}) : {};
    const parsed = withDurationEstimatePlanPayload(planWithoutRemovedSessions(servedPlan, progress, active.row));
    const anchorPayload = planAnchorPayload(parsed);
    const surfaceField = await canonicalSurfaceResponseField(req.user.id, active.row);
    res.json({
      plan: {
        ...active.row,
        ...anchorPayload,
        plan_json: parsed,
        plan_data: parsed,
        current_week: Number(active.row.current_week || 1),
      },
      ...surfaceField,
    });
    void requestImagesForWorkoutItems({
      userId: req.user.id,
      items: plannedLiftExerciseItems(parsed),
      source: 'scheduled_plan_current',
      ensureOnly: true,
    }).catch((queueErr) => console.error('[plans/current] exercise image review queue failed:', queueErr.message));
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

    const active = await getActivePlanForUser(req.user.id, null, { planningDateLocal: planningDateISO });
    if (!active) return res.json({ week: weekStart, planned: 0, completed: 0, score: 0, missed: [], streak: { current: 0, best: 0 } });

    const progress = active.source === 'assigned' ? parseJsonValue(active.row.progress_json, {}) : {};
    const parsed = planWithoutRemovedSessions(parsePlan(active.row) || { weeks: [] }, progress, active.row);
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
      const active = await getActivePlanForMutation(req.user.id, tx, { planningDateLocal: planningDateISO });
      if (!active) return planningInputUnchanged({ status: 404, error: 'No plan found' });

      const parsed = parsePlan(active.row);
      const progress = parseJsonValue(active.row.progress_json, {});
      const visiblePlan = planWithoutRemovedSessions(parsed, progress, active.row);
      const weekIndex = Math.max(0, Number(active.row.current_week || 1) - 1);
      const rawWeek = parsed?.weeks?.[weekIndex];
      const visibleRawWeek = visiblePlan?.weeks?.[weekIndex];
      if (!planSchema.getDayEntries(rawWeek).length) {
        return planningInputUnchanged({ status: 400, error: 'Invalid plan format' });
      }
      const fallbackWeekStart = getMonday(new Date(`${planningDateISO}T12:00:00`));
      const selectedWeekStart = activeWeekStart(parsed, active.row, weekIndex, fallbackWeekStart);
      const week = withCanonicalWeekDates(rawWeek, selectedWeekStart);
      const visibleWeek = withCanonicalWeekDates(visibleRawWeek, selectedWeekStart);
      const requestedSession = planSchema.getDayEntries(visibleWeek)
        .flatMap((day, index) => planSchema.plannedSessionsForDay(day, index, day.date))
        .find((session) => String(session.sessionId) === String(sessionId));

      if (!requestedSession) return planningInputUnchanged({ status: 404, error: 'Session not found in plan' });
      if (requestedSession.type !== 'run') {
        return planningInputUnchanged({ status: 409, error: 'Only a missed run can be moved onto today.' });
      }
      if (!requestedSession.date || requestedSession.date >= planningDateISO) {
        return planningInputUnchanged({ status: 409, error: 'Only a run missed before today can be moved.' });
      }

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
        plan: planWithoutRemovedSessions(parsed, progress, active.row),
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

router.post('/race-adjust', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) return res.status(400).json({ error: 'raceId required' });
    const candidate = await previewPlanForUser(req.user.id, withRequestPlanningClock(req, req.body, {
      race_ids: [String(raceId)],
    }));
    return res.status(201).json(publicCandidatePayload(candidate));
  } catch (err) {
    return sendCandidateError(res, err, 'race-adjust');
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
    if (Array.isArray(req.body?.target?.raceTargets) && req.body.target.raceTargets.length > 0) {
      throw candidateError(400, 'RACE_ROUTE_REQUIRED', 'Use the race plan route for race-based plans.');
    }
    const candidate = await previewPlanForUser(
      req.user.id,
      withRequestPlanningClock(req, req.body, { race_ids: [] })
    );
    return res.status(201).json(publicCandidatePayload(candidate));
  } catch (err) {
    return sendCandidateError(res, err, 'generate');
  }
});

router.post('/generate-for-races', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    if (!Array.isArray(req.body?.race_ids) || req.body.race_ids.length < 1) {
      throw candidateError(400, 'RACES_REQUIRED', 'Choose one or two races.');
    }
    const candidate = await previewPlanForUser(req.user.id, withRequestPlanningClock(req, req.body));
    return res.status(201).json({
      ...publicCandidatePayload(candidate),
      races: candidate.races.map((race) => ({ id: race.id, name: race.race_name, date: race.race_date })),
      weeks: candidate.plan.weeks.length,
    });
  } catch (err) {
    return sendCandidateError(res, err, 'generate-for-races');
  }
});

router.post('/generate-for-race/:raceId', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const candidate = await previewPlanForUser(req.user.id, withRequestPlanningClock(req, req.body, {
      race_ids: [String(req.params.raceId || '')],
    }));
    const race = candidate.races[0];
    return res.status(201).json({
      ...publicCandidatePayload(candidate),
      race: race ? { id: race.id, name: race.race_name, date: race.race_date } : null,
      weeks: candidate.plan.weeks.length,
    });
  } catch (err) {
    return sendCandidateError(res, err, 'generate-for-race');
  }
});

router.clearActivePlanForUser = clearActivePlanForUser;

router._test = {
  adaptationEpisodeDisposition,
  applicableGoalBackwardPlan,
  isRevisionedGoalBackedRequest,
  canonicalAdaptationPlan,
  applyPlanCandidate,
  assertCandidatePlanningDateCurrent,
  buildDeterministicCandidate,
  hyroxRecentRunLoadView,
  restoreHyroxIncompleteDistanceTruth,
  buildConcurrentContext,
  confidenceAwareMileageBaseline,
  goalBackwardSafetyState,
  goalBackwardRemovalCarryForwardMaterial,
  canonicalCarryGoalIds,
  goalBackwardRequiredRunningDoseReceipt,
  goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest,
  goalBackwardTrainingAge,
  buildCanonicalSurfaceManifest,
  buildGoalBackwardArtifacts,
  canonicalWorkoutStartAccess,
  canonicalWorkoutStartDecision,
  canonicalSurfaceManifestForActive,
  candidateFeasibilityCanApply,
  candidateEffectiveFrom,
  computeGoalBackwardShadowDiagnostics,
  emitPlanReleaseTelemetry,
  currentGoalBackwardApplyEnvelope,
  clearActivePlanForUser,
  getActivePlanForMutation,
  getActivePlanForUser,
  normalizeActivePlanIdentitiesForMutation,
  maybeComputeGoalBackwardShadowDiagnostics,
  persistAdaptationProposal,
  planVersionFor,
  proposalDecisionConflict,
  proposalDecisionRevision,
  resolvePlanGoalBackwardV24Mode,
  updateActivePlanData,
  getTimezoneOffsetFromRequest,
  deleteOwnedRaceForCandidate,
  pruneExpiredPlanCandidates,
  previewPlanForUser,
  rejectPlanCandidate,
  previewRaceRemovalForUser,
  positivePlanRevision,
  raceRemovalCandidateRequest,
  raceRemovalImpact,
  raceRemovalImpactForUser,
  replacementLineageForActivePlan,
  surfaceManifestAppliedPlanDiagnostic,
  sendCandidateError,
  verifyStoredGoalBackwardDecisionHash,
  withRequestPlanningClock,
};

module.exports = router;
