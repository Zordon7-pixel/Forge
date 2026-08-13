const { dbGet } = require('../db');
const planSchema = require('./planSchema');
const { resolveActivePlanForDate } = require('./planAssignmentLifecycle');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_NO_PLAN_MATCH = 'explicit_none';

function parsePlannedRunValue(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePlanRow(row) {
  const raw = row?.plan_data ?? row?.plan_json;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.error('[planned-run-match] invalid plan JSON:', err.message);
    return null;
  }
}

function boundedText(value, maxLength = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function boundedPositive(value, max) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : null;
}

function boundedList(value, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedText(typeof item === 'string' ? item : item?.label || item?.description, 200))
    .filter(Boolean)
    .slice(0, maxItems);
}

function plannedRunSnapshot(session, date, planId = null) {
  const distanceMiles = boundedPositive(session.distance_miles ?? session.distanceMiles ?? session.distance ?? session.miles, 500);
  const durationMinutes = boundedPositive(session.duration_min ?? session.durationMinutes ?? session.duration_minutes ?? session.minutes, 1440);
  const sessionId = boundedText(session.id, 120);
  return {
    schemaVersion: 1,
    matchSource: 'scheduled_date',
    planId: boundedText(planId, 120),
    sessionId,
    date,
    title: boundedText(session.title || session.name, 120),
    type: boundedText(session.type, 40),
    workoutType: boundedText(session.workout_type ?? session.workoutType, 40),
    distanceMiles,
    durationMinutes,
    paceTarget: boundedText(session.pace_target ?? session.paceTarget, 120),
    targetZone: boundedText(session.target_zone ?? session.targetZone, 40),
    intensity: boundedText(session.intensity, 80),
    warmup: boundedList(session.warmup, 10),
    steps: boundedList(session.steps?.length ? session.steps : session.structure, 20),
    cooldown: boundedList(session.cooldown, 10),
  };
}

function matchPlannedRunInPlan(plan, date, planId = null) {
  if (!plan || !ISO_DATE.test(String(date || ''))) return null;
  const matches = [];
  for (const week of Array.isArray(plan.weeks) ? plan.weeks : []) {
    for (const day of planSchema.getDayEntries(week)) {
      if (String(day?.date || '').slice(0, 10) !== date) continue;
      const runSessions = planSchema.daySessions(day).filter((session) => planSchema.kindFromSession(session) === 'run');
      for (const session of runSessions) matches.push(session);
    }
  }
  if (matches.length !== 1) return null;
  return plannedRunSnapshot(matches[0], date, planId);
}

function hasMeaningfulPlannedRun(value) {
  const parsed = parsePlannedRunValue(value);
  if (!parsed) return false;
  return [
    parsed.sessionId,
    parsed.title,
    parsed.type,
    parsed.workoutType,
    parsed.distanceMiles,
    parsed.durationMinutes,
    parsed.paceTarget,
    parsed.targetZone,
  ].some((item) => item !== undefined && item !== null && item !== '');
}

function explicitNoPlanMatchSnapshot() {
  return { schemaVersion: 1, planMatchMode: EXPLICIT_NO_PLAN_MATCH };
}

function isExplicitlyUnlinkedRun(value) {
  const parsed = parsePlannedRunValue(value);
  return parsed?.planMatchMode === EXPLICIT_NO_PLAN_MATCH
    || parsed?.plan_match_mode === EXPLICIT_NO_PLAN_MATCH;
}

function dateDistanceDays(first, second) {
  if (!ISO_DATE.test(String(first || '')) || !ISO_DATE.test(String(second || ''))) return null;
  const firstTime = new Date(`${first}T12:00:00Z`).getTime();
  const secondTime = new Date(`${second}T12:00:00Z`).getTime();
  return Math.round(Math.abs(firstTime - secondTime) / 86400000);
}

function findPlanSessionRunEvidence(runs, {
  sessionId,
  date,
  usedIds = new Set(),
  allowDateFallback = true,
  dateToleranceDays = 1,
} = {}) {
  const candidates = Array.isArray(runs)
    ? runs.filter((run) => run?.id && !usedIds.has(run.id))
    : [];
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (normalizedSessionId) {
    const exact = candidates.find((run) => String(run.plan_session_id ?? '').trim() === normalizedSessionId);
    if (exact) return exact;
  }
  if (!allowDateFallback) return null;
  return candidates.find((run) => {
    if (String(run.plan_session_id ?? '').trim()) return false;
    if (isExplicitlyUnlinkedRun(run.planned_session_json)) return false;
    const distance = dateDistanceDays(String(run.date || '').slice(0, 10), date);
    return distance !== null && distance <= dateToleranceDays;
  }) || null;
}

function allocatePlanSessionRunEvidence(sessions, runs, {
  completedSessionIds = [],
  dateToleranceDays = 1,
} = {}) {
  const completed = new Set(Array.from(completedSessionIds || [], String));
  const allocations = (Array.isArray(sessions) ? sessions : []).map((session) => ({ session, evidence: null }));
  const pending = allocations.filter(({ session }) => !completed.has(String(session?.sessionId)));
  const usedIds = new Set();
  const allocatePass = (options) => {
    for (const allocation of pending) {
      if (allocation.evidence) continue;
      const evidence = findPlanSessionRunEvidence(runs, {
        sessionId: allocation.session?.sessionId,
        date: allocation.session?.date,
        usedIds,
        ...options,
      });
      if (!evidence) continue;
      allocation.evidence = evidence;
      usedIds.add(evidence.id);
    }
  };

  allocatePass({ allowDateFallback: false });
  allocatePass({ dateToleranceDays: 0 });
  if (dateToleranceDays > 0) allocatePass({ dateToleranceDays });
  return allocations;
}

async function findPlannedRunForDate(userId, date, { get = dbGet } = {}) {
  if (!userId || !ISO_DATE.test(String(date || ''))) return null;
  const active = await resolveActivePlanForDate(userId, get, { planningDateLocal: date });
  if (!active) return null;
  const storedPlan = parsePlanRow(active.row);
  const visiblePlan = storedPlan ? planSchema.visiblePlanForAssignment(storedPlan, active.row) : null;
  return visiblePlan
    ? matchPlannedRunInPlan(visiblePlan, date, active.row.id || active.row.plan_id)
    : null;
}

module.exports = {
  allocatePlanSessionRunEvidence,
  explicitNoPlanMatchSnapshot,
  findPlannedRunForDate,
  findPlanSessionRunEvidence,
  hasMeaningfulPlannedRun,
  isExplicitlyUnlinkedRun,
  matchPlannedRunInPlan,
  plannedRunSnapshot,
};
