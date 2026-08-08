const { RACE_PLAN_POLICY_V1, canonicalHash, canonicalStringify } = require('./racePlanPolicy');

const HASH_PREFIX = 'sha256:';

const REDACTED_KEYS = new Set([
  'access_token',
  'api_key',
  'auth_token',
  'authorization',
  'email',
  'password',
  'password_hash',
  'phone',
  'phone_number',
  'refresh_token',
  'secret',
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function redactSnapshotValue(value, key = '') {
  if (REDACTED_KEYS.has(String(key).toLowerCase())) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => redactSnapshotValue(item)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, childKey) => {
    const redacted = redactSnapshotValue(value[childKey], childKey);
    if (redacted !== undefined) result[childKey] = redacted;
    return result;
  }, {});
}

function normalizeProfile(profile = {}) {
  const finiteNumber = (value, fallback = null) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  return {
    comeback_mode: Boolean(profile.comeback_mode),
    goal_race_distance: finiteNumber(profile.goal_race_distance),
    injury_notes_present: Boolean(String(profile.injury_notes || '').trim()),
    lift_days_per_week: finiteNumber(profile.lift_days_per_week, 0),
    preferred_workout_days: profile.preferred_workout_days || null,
    run_days_per_week: finiteNumber(profile.run_days_per_week),
    weekly_miles_current: finiteNumber(profile.weekly_miles_current, 0),
  };
}

function normalizeContext(context = {}) {
  return redactSnapshotValue({
    checkin: context.checkin || null,
    history: context.history || {},
    profile: normalizeProfile(context.profile || {}),
    recovery: context.recovery || {},
    safety: context.safety || {},
    target: context.target || {},
    todayISO: context.todayISO || null,
  });
}

function buildPlanningSnapshot({
  activePlan = null,
  context,
  planningDateLocal,
  planningInputRevision,
  request,
  timezoneOffsetMinutes,
}) {
  return {
    active_plan: activePlan ? {
      plan_version: activePlan.planVersion ?? null,
      training_plan_id: activePlan.trainingPlanId || null,
      user_plan_id: activePlan.userPlanId || null,
    } : null,
    context: normalizeContext(context),
    planning_date_local: planningDateLocal,
    planning_input_revision: Number(planningInputRevision),
    request: redactSnapshotValue(request || {}),
    timezone_offset_minutes: Number(timezoneOffsetMinutes),
  };
}

function prefixedHash(value) {
  return `${HASH_PREFIX}${canonicalHash(value)}`;
}

function jsonBytes(value) {
  return Buffer.byteLength(canonicalStringify(value), 'utf8');
}

function assertBoundedJson(value, maximumBytes, label) {
  const bytes = jsonBytes(value);
  if (bytes > maximumBytes) {
    const err = new Error(`${label} exceeds ${maximumBytes} bytes`);
    err.code = 'PLAN_CANDIDATE_TOO_LARGE';
    err.status = 422;
    err.details = { label, bytes, maximumBytes };
    throw err;
  }
  return bytes;
}

function isIsoDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

function validatePlanStructure(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { valid: false, errors: [{ code: 'PLAN_NOT_OBJECT', path: 'plan' }] };
  }
  if (!Array.isArray(plan.weeks) || !plan.weeks.length) {
    errors.push({ code: 'PLAN_WEEKS_REQUIRED', path: 'weeks' });
  }
  const ids = new Set();
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    const days = Array.isArray(week?.days)
      ? week.days
      : Array.isArray(week?.sessions) ? week.sessions : null;
    if (!days) {
      errors.push({ code: 'PLAN_DAYS_REQUIRED', path: `weeks[${weekIndex}]` });
      continue;
    }
    for (const [dayIndex, day] of days.entries()) {
      const dayPath = `weeks[${weekIndex}].days[${dayIndex}]`;
      if (day?.date != null && !isIsoDate(day.date)) {
        errors.push({ code: 'INVALID_DAY_DATE', path: `${dayPath}.date` });
      }
      const sessions = Array.isArray(day?.sessions) ? day.sessions : [day].filter(Boolean);
      for (const [sessionIndex, session] of sessions.entries()) {
        const path = `${dayPath}.sessions[${sessionIndex}]`;
        if (!session || typeof session !== 'object') {
          errors.push({ code: 'INVALID_SESSION', path });
          continue;
        }
        const id = session.id == null ? '' : String(session.id).trim();
        if (Number(plan.schemaVersion) === 2 && !id) errors.push({ code: 'SESSION_ID_REQUIRED', path: `${path}.id` });
        if (id && ids.has(id)) errors.push({ code: 'DUPLICATE_SESSION_ID', path: `${path}.id` });
        if (id) ids.add(id);
        const distance = session.distance_miles;
        const duration = session.duration_min;
        if (distance != null && (!Number.isFinite(Number(distance)) || Number(distance) < 0)) {
          errors.push({ code: 'INVALID_SESSION_DISTANCE', path: `${path}.distance_miles` });
        }
        if (duration != null && (!Number.isFinite(Number(duration)) || Number(duration) < 0)) {
          errors.push({ code: 'INVALID_SESSION_DURATION', path: `${path}.duration_min` });
        }
      }
    }
  }
  try {
    const roundTrip = JSON.parse(JSON.stringify(plan));
    if (canonicalStringify(roundTrip) !== canonicalStringify(plan)) {
      errors.push({ code: 'PLAN_ROUND_TRIP_LOSS', path: 'plan' });
    }
  } catch (err) {
    errors.push({ code: 'PLAN_NOT_SERIALIZABLE', path: 'plan', message: err.message });
  }
  return { valid: errors.length === 0, errors };
}

function assertPersistablePlan(plan) {
  const validation = validatePlanStructure(plan);
  if (!validation.valid) {
    const err = new Error(`Plan failed persistence validation: ${validation.errors[0].code}`);
    err.code = 'PLAN_INVARIANT_FAILED';
    err.status = 422;
    err.details = validation.errors;
    throw err;
  }
  assertBoundedJson(plan, RACE_PLAN_POLICY_V1.candidate.maximumPlanBytes, 'candidate plan');
  return cloneJson(plan);
}

function validateCandidateBundle({ plan, snapshot, trace, replay = null }) {
  const normalizedPlan = assertPersistablePlan(plan);
  const normalizedSnapshot = redactSnapshotValue(snapshot || {});
  const normalizedTrace = redactSnapshotValue(trace || {});
  assertBoundedJson(normalizedSnapshot, RACE_PLAN_POLICY_V1.candidate.maximumInputBytes, 'planning snapshot');
  assertBoundedJson(normalizedTrace, RACE_PLAN_POLICY_V1.candidate.maximumTraceBytes, 'generation trace');
  if (replay !== null) {
    assertBoundedJson(replay, RACE_PLAN_POLICY_V1.candidate.maximumReplayBytes, 'candidate replay');
  }
  return { plan: normalizedPlan, snapshot: normalizedSnapshot, trace: normalizedTrace };
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    const parseError = new Error('Stored candidate JSON is invalid');
    parseError.code = 'PLAN_CANDIDATE_CORRUPT';
    parseError.status = 409;
    throw parseError;
  }
}

module.exports = {
  HASH_PREFIX,
  assertBoundedJson,
  assertPersistablePlan,
  buildPlanningSnapshot,
  jsonBytes,
  normalizeContext,
  parseJson,
  prefixedHash,
  redactSnapshotValue,
  validateCandidateBundle,
  validatePlanStructure,
};
