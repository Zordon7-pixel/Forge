// Forged Hybrid H5 — shared daily-execution service (frontend).
//
// ONE normalization + service layer for Home, Run, Lift, and Plan so the four
// surfaces stop shipping four divergent parsers of GET /plans/today. Pure
// helpers live in dailyExecutionCore.js (unit-tested framework-free); this file
// re-exports them and adds the thin axios/offline-queue wrappers.
//
// Backend contract (GET /plans/today?date=YYYY-MM-DD):
//   { today: <legacy day|null>, execution: { hasPlan, hasDay, isRest, mode,
//     phase, week, goal, orderGuidance, status, date, day, sessions[], run,
//     lift } }
// where each session carries its stable `id`, full prescription fields, a
// `completed` flag, and (for runs) an `hrZone` band or null.

import api from './api';
import { queueRequest } from './offlineQueue';
import {
  localDateISO,
  normalizeExecution,
  isRestExecutionAuthority,
  executionHasSession,
  executionAllowsSession,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState as coreRunRouteState,
  unplannedRunRouteState,
  makeupRunRouteState,
  planSessionIdFromState as corePlanSessionIdFromState,
  currentWeekFromState,
  isRetryableCompletionFailure,
} from './dailyExecutionCore';
import {
  workoutStartAccessFromState,
  workoutStartDecision,
  workoutStartErrorMessage,
} from './todayPlanAccess';

const verifiedStartAccessBySession = new Map();

export {
  localDateISO,
  normalizeExecution,
  isRestExecutionAuthority,
  executionHasSession,
  executionAllowsSession,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  unplannedRunRouteState,
  makeupRunRouteState,
  currentWeekFromState,
  isRetryableCompletionFailure,
};

export {
  canonicalWorkoutStartAccess,
  workoutStartAccessFromState,
  workoutStartDecision,
  workoutStartErrorMessage,
  WORKOUT_START_ACCESS_SCHEMA,
} from './todayPlanAccess';

function rememberWorkoutStartAccess(access) {
  const id = access?.session?.session_id;
  if (id) verifiedStartAccessBySession.set(String(id), access);
  return access || null;
}

function startAccessError(decision) {
  const error = new Error(workoutStartErrorMessage(decision?.reasonCode));
  error.code = decision?.reasonCode || 'WORKOUT_START_ACCESS_UNAVAILABLE';
  error.response = { status: 409, data: { code: error.code, error: error.message } };
  return error;
}

// The canonical run handoff is always derived from the same accepted manifest
// as Today/Train. Legacy handoffs remain byte-compatible and receive no v2.4
// access field.
export function runRouteState(execution) {
  const state = coreRunRouteState(execution);
  if (!state) return null;
  const decision = workoutStartDecision({
    execution,
    sessionId: state.planSessionId,
    activity: { kind: 'run' },
  });
  if (!decision.allowed) return null;
  if (!decision.access) return state;
  rememberWorkoutStartAccess(decision.access);
  return { ...state, workoutStartAccess: decision.access };
}

export function liftRouteState(execution) {
  const lift = scheduledLiftFromExecution(execution);
  if (!lift) return null;
  const id = lift.session_id ?? lift.id;
  const decision = workoutStartDecision({
    execution,
    sessionId: id,
    activity: { kind: 'lift', workoutFamily: lift.workout_family },
  });
  if (!decision.allowed) return null;
  if (decision.access) rememberWorkoutStartAccess(decision.access);
  return {
    planSessionId: id == null ? null : String(id),
    currentWeek: execution?.week ?? null,
    scheduledLift: lift,
    ...(decision.access ? { workoutStartAccess: decision.access } : {}),
  };
}

// Warmup and ActiveRun already call this shared reader. Remembering the bound
// access here lets their existing completion call include the exact manifest
// even though those pages do not need a second parser.
export function planSessionIdFromState(state) {
  const id = corePlanSessionIdFromState(state);
  const access = workoutStartAccessFromState(state);
  if (id && access?.session?.session_id === id) rememberWorkoutStartAccess(access);
  return id;
}

// Fetch + normalize today's execution for a phone-local date.
export async function fetchDailyExecution(dateISO = localDateISO()) {
  const res = await api.get(`/plans/today?date=${encodeURIComponent(dateISO)}`);
  return normalizeExecution(res && res.data);
}

// Refresh, locally fail closed, then ask the server to verify the exact same
// manifest/revision/safety envelope immediately before a canonical start.
// Legacy starts skip the new endpoint so flag-off behavior is unchanged.
export async function authorizeWorkoutStart({
  sessionId = null,
  activity = {},
  expectedAccess,
  dateISO = localDateISO(),
  failClosed = false,
} = {}) {
  let execution;
  try {
    execution = await fetchDailyExecution(dateISO);
  } catch (error) {
    if (!expectedAccess && !failClosed) {
      return { allowed: true, reasonCode: null, access: null, session: null, legacy: true, unverifiedLegacy: true };
    }
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_UNAVAILABLE', access: null, session: null };
  }
  const local = workoutStartDecision({
    execution,
    sessionId,
    activity,
    expectedAccess,
    requireBoundAccess: Boolean(expectedAccess),
  });
  if (!local.allowed || local.legacy) return { ...local, execution };
  try {
    const response = await api.post('/plans/today/start-access', {
      planning_date_local: dateISO,
      session_id: sessionId,
      activity,
      workout_start_access: local.access,
    });
    const server = response?.data || {};
    if (server.allowed !== true) {
      return {
        allowed: false,
        reasonCode: server.reasonCode || server.code || 'WORKOUT_START_ACCESS_BLOCKED',
        access: server.access || local.access,
        session: local.session,
        execution,
      };
    }
    const access = server.access || local.access;
    rememberWorkoutStartAccess(access);
    return { ...local, access, execution, serverVerified: true };
  } catch (error) {
    return {
      allowed: false,
      reasonCode: error?.response?.data?.code || 'WORKOUT_START_ACCESS_UNAVAILABLE',
      access: local.access,
      session: local.session,
      execution,
    };
  }
}

function completionBodyWithStartAccess(sessionId, currentWeek, access) {
  return {
    ...completionBody(sessionId, currentWeek),
    ...(access ? { workout_start_access: access } : {}),
  };
}

// Mark a plan session complete ONLY after a successful run/lift save.
// Idempotent server-side (Set-based) and req.user.id-scoped, so a repeat call
// or an unknown id can never corrupt another user's plan.
export async function markSessionComplete(sessionId, currentWeek, workoutStartAccess = null) {
  if (!sessionId) return null;
  let access = workoutStartAccess || verifiedStartAccessBySession.get(String(sessionId)) || null;
  if (!access) {
    const decision = await authorizeWorkoutStart({ sessionId, activity: {} });
    if (!decision.allowed) throw startAccessError(decision);
    access = decision.access;
  }
  const res = await api.put('/plans/my/progress', completionBodyWithStartAccess(sessionId, currentWeek, access));
  return res && res.data;
}

// Offline path: queue the completion PUT. Callers MUST enqueue the run save
// first so completion is ordered AFTER the queued run request.
export async function queueSessionComplete(sessionId, currentWeek, workoutStartAccess = null) {
  if (!sessionId) return;
  const access = workoutStartAccess || verifiedStartAccessBySession.get(String(sessionId)) || null;
  await queueRequest('/api/plans/my/progress', 'PUT', completionBodyWithStartAccess(sessionId, currentWeek, access));
}

export default {
  localDateISO,
  normalizeExecution,
  isRestExecutionAuthority,
  executionHasSession,
  executionAllowsSession,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  liftRouteState,
  unplannedRunRouteState,
  makeupRunRouteState,
  planSessionIdFromState,
  currentWeekFromState,
  isRetryableCompletionFailure,
  fetchDailyExecution,
  authorizeWorkoutStart,
  markSessionComplete,
  queueSessionComplete,
};
