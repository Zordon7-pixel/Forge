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
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  planSessionIdFromState,
  currentWeekFromState,
} from './dailyExecutionCore';

export {
  localDateISO,
  normalizeExecution,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  planSessionIdFromState,
  currentWeekFromState,
};

// Fetch + normalize today's execution for a phone-local date.
export async function fetchDailyExecution(dateISO = localDateISO()) {
  const res = await api.get(`/plans/today?date=${encodeURIComponent(dateISO)}`);
  return normalizeExecution(res && res.data);
}

// Mark a plan session complete ONLY after a successful run/lift save.
// Idempotent server-side (Set-based) and req.user.id-scoped, so a repeat call
// or an unknown id can never corrupt another user's plan.
export async function markSessionComplete(sessionId, currentWeek) {
  if (!sessionId) return null;
  const res = await api.put('/plans/my/progress', completionBody(sessionId, currentWeek));
  return res && res.data;
}

// Offline path: queue the completion PUT. Callers MUST enqueue the run save
// first so completion is ordered AFTER the queued run request.
export async function queueSessionComplete(sessionId, currentWeek) {
  if (!sessionId) return;
  await queueRequest('/api/plans/my/progress', 'PUT', completionBody(sessionId, currentWeek));
}

export default {
  localDateISO,
  normalizeExecution,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  planSessionIdFromState,
  currentWeekFromState,
  fetchDailyExecution,
  markSessionComplete,
  queueSessionComplete,
};
