const planSchema = require('./planSchema');
const { DAY_ORDER, normalizeTrainingDays } = require('./runSchedule');
const { RACE_PLAN_POLICY_V1, addDays, canonicalHash } = require('./racePlanPolicy');

const MAX_PROTECTED_RACES = 2;
const MIN_RACE_GAP_DAYS = 21;
const MAX_PLAN_WINDOW_DAYS = 139;
const FORBIDDEN_BACKUP_KEYS = /(email|phone|password|token|secret|health|heart.?rate|gps|route|coordinate|latitude|longitude)/i;

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function parseStoredPlan(row = {}) {
  return parseJson(row.plan_data, null) || parseJson(row.plan_json, null) || {};
}

function isoDayDistance(later, earlier) {
  const end = Date.parse(`${String(later || '').slice(0, 10)}T12:00:00.000Z`);
  const start = Date.parse(`${String(earlier || '').slice(0, 10)}T12:00:00.000Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.round((end - start) / 86400000);
}

function planGoalRaceIds(plan = {}) {
  const goals = Array.isArray(plan.goals) ? plan.goals : plan.goal ? [plan.goal] : [];
  return [...new Set(goals.map((goal) => (
    goal?.raceId || goal?.race_id || goal?.raceTarget?.raceId || goal?.race_target?.race_id
  )).map((value) => String(value || '').trim()).filter(Boolean))];
}

function compatibleRacePair(first, second) {
  const gap = isoDayDistance(second?.race_date, first?.race_date);
  return gap !== null && gap >= MIN_RACE_GAP_DAYS && gap <= MAX_PLAN_WINDOW_DAYS;
}

function selectProtectedRaces(races = [], activePlan = {}, planningDateLocal) {
  const eligible = races
    .filter((race) => String(race?.status || '') === 'upcoming')
    .filter((race) => String(race?.race_date || '').slice(0, 10) >= planningDateLocal)
    .sort((left, right) => String(left.race_date).localeCompare(String(right.race_date)));
  const byId = new Map(eligible.map((race) => [String(race.id), race]));
  const goalIds = planGoalRaceIds(activePlan);
  if (goalIds.length < 1 || goalIds.length > MAX_PROTECTED_RACES) return [];
  const selected = goalIds.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length !== goalIds.length) return [];
  const orderedSelected = [...new Map(selected.map((race) => [String(race.id), race])).values()]
    .sort((left, right) => String(left.race_date).localeCompare(String(right.race_date)));

  if (orderedSelected.length === 2 && !compatibleRacePair(orderedSelected[0], orderedSelected[1])) return [];
  return orderedSelected;
}

function integer(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function normalizeRolloutTrainingDays(raw) {
  const parsed = parseJson(raw, raw);
  if (!Array.isArray(parsed)) return normalizeTrainingDays(parsed);
  return normalizeTrainingDays(parsed.map((value) => {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 7
      ? DAY_ORDER[numeric - 1]
      : value;
  }));
}

function ownValue(object, camelKey, snakeKey) {
  if (object && Object.prototype.hasOwnProperty.call(object, camelKey)) return object[camelKey];
  if (object && Object.prototype.hasOwnProperty.call(object, snakeKey)) return object[snakeKey];
  return undefined;
}

function authoritativePlanTarget(activePlan = {}) {
  const schedule = activePlan.schedulePreferences || activePlan.schedule_preferences || {};
  const rawTrainingDays = ownValue(schedule, 'trainingDays', 'training_days');
  const rawRunDays = ownValue(schedule, 'runDaysPerWeek', 'run_days_per_week');
  if (!Array.isArray(rawTrainingDays) || rawTrainingDays.length < 1) {
    return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }
  const trainingDays = normalizeRolloutTrainingDays(rawTrainingDays);
  if (trainingDays.length !== new Set(rawTrainingDays.map((day) => String(day))).size) {
    return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }
  const runDaysPerWeek = integer(rawRunDays, 1, 6);
  if (!runDaysPerWeek || runDaysPerWeek > trainingDays.length) {
    return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }
  const strength = activePlan.strengthPolicy || activePlan.strength_policy || {};
  const rawMode = String(activePlan.planMode || activePlan.plan_mode || '').trim();
  if (!Object.values(planSchema.PLAN_MODES).includes(rawMode)) {
    return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }
  const liftingEnabled = rawMode !== planSchema.PLAN_MODES.RUN_ONLY;
  let liftDaysPerWeek = 0;
  if (liftingEnabled) {
    if (strength.enabled !== true) return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
    liftDaysPerWeek = integer(ownValue(strength, 'sessionsPerWeek', 'sessions_per_week'), 1, 4);
    if (!liftDaysPerWeek) return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }

  return { valid: true, target: {
    trainingDays,
    runDaysPerWeek,
    planMode: rawMode,
    liftingEnabled,
    liftDaysPerWeek,
    strengthGoal: String(strength.goal || (rawMode === planSchema.PLAN_MODES.HYBRID_BUILD ? 'build' : 'maintain')),
    equipment: Array.isArray(strength.equipment) ? strength.equipment.slice(0, 20) : [],
  } };
}

function preservedPlanTarget(activePlan = {}) {
  const result = authoritativePlanTarget(activePlan);
  if (!result.valid) {
    const error = new Error('Active plan does not contain an authoritative schedule.');
    error.code = result.reason;
    throw error;
  }
  return result.target;
}

function isCurrentRolloutPlan(activePlan = {}, raceIds = []) {
  const activeRaceIds = planGoalRaceIds(activePlan).sort();
  const protectedRaceIds = [...new Set(raceIds.map((id) => String(id || '').trim()).filter(Boolean))].sort();
  return activePlan.engineVersion === RACE_PLAN_POLICY_V1.engineVersion
    && activePlan.policyVersion === RACE_PLAN_POLICY_V1.version
    && activePlan.invariantVersion === RACE_PLAN_POLICY_V1.invariantVersion
    && activeRaceIds.length === protectedRaceIds.length
    && activeRaceIds.every((id, index) => id === protectedRaceIds[index]);
}

function localDateForOffset(now, timezoneOffsetMinutes) {
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset) || offset < -840 || offset > 840) {
    throw new Error('timezone offset must be between -840 and 840 minutes');
  }
  return new Date(new Date(now).getTime() - offset * 60000).toISOString().slice(0, 10);
}

function assertApplyAuthorized({ apply, confirmation, betaAccessEnabled }) {
  if (!apply) return;
  if (!betaAccessEnabled) throw new Error('FORGE_BETA_ACCESS must be enabled before applying beta plan upgrades');
  if (confirmation !== RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation) {
    throw new Error(`Apply requires --confirm=${RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation}`);
  }
}

function targetRef(userId) {
  return `sha256:${canonicalHash(String(userId || ''))}`;
}

function redactedBackupEntry({ userId, active, activePlan, candidate, raceIds, planningDateLocal }) {
  return {
    target_ref: targetRef(userId),
    planning_date_local: planningDateLocal,
    protected_race_refs: raceIds.map((id) => `sha256:${canonicalHash(String(id))}`),
    prior_assignment: {
      user_plan_id: active?.row?.user_plan_id || null,
      training_plan_id: active?.row?.id || null,
      plan_version: Number(active?.row?.plan_version || 0) || null,
      lineage_id: active?.row?.lineage_id || active?.row?.user_plan_id || null,
      effective_from: active?.row?.effective_from || active?.row?.started_at || null,
      plan_hash: `sha256:${canonicalHash(activePlan || {})}`,
    },
    candidate: {
      hash: candidate?.candidateHash || null,
      engine_version: RACE_PLAN_POLICY_V1.engineVersion,
      expected_effective_from: addDays(planningDateLocal, 1),
    },
  };
}

function assertRedactedBackup(value, path = 'backup') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRedactedBackup(entry, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_BACKUP_KEYS.test(key)) throw new Error(`Forbidden backup field: ${path}.${key}`);
    assertRedactedBackup(nested, `${path}.${key}`);
  }
  return value;
}

function buildBackupManifest({ entries, createdAt = new Date().toISOString(), mode = 'apply' }) {
  return assertRedactedBackup({
    schema_version: 1,
    created_at: createdAt,
    mode,
    engine_version: RACE_PLAN_POLICY_V1.engineVersion,
    policy_version: RACE_PLAN_POLICY_V1.version,
    entries,
  });
}

module.exports = {
  MAX_PROTECTED_RACES,
  authoritativePlanTarget,
  assertApplyAuthorized,
  assertRedactedBackup,
  buildBackupManifest,
  localDateForOffset,
  isCurrentRolloutPlan,
  normalizeRolloutTrainingDays,
  parseStoredPlan,
  planGoalRaceIds,
  preservedPlanTarget,
  redactedBackupEntry,
  selectProtectedRaces,
  targetRef,
};
