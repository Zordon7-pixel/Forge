const planSchema = require('./planSchema');
const { DAY_ORDER, normalizeTrainingDays, DEFAULT_TRAINING_DAYS } = require('./runSchedule');
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
  const selected = planGoalRaceIds(activePlan).map((id) => byId.get(id)).filter(Boolean);
  const orderedSelected = [...new Map(selected.map((race) => [String(race.id), race])).values()]
    .sort((left, right) => String(left.race_date).localeCompare(String(right.race_date)));

  let protectedRaces = [];
  for (const race of orderedSelected) {
    if (protectedRaces.length === 0 || compatibleRacePair(protectedRaces[0], race)) protectedRaces.push(race);
    if (protectedRaces.length === MAX_PROTECTED_RACES) break;
  }
  if (protectedRaces.length === 0 && eligible[0]) protectedRaces.push(eligible[0]);
  if (protectedRaces.length === 1) {
    const second = eligible.find((race) => (
      String(race.id) !== String(protectedRaces[0].id) && compatibleRacePair(protectedRaces[0], race)
    ));
    if (second) protectedRaces.push(second);
  }
  return protectedRaces.slice(0, MAX_PROTECTED_RACES);
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
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

function preservedPlanTarget(activePlan = {}, profile = {}) {
  const schedule = activePlan.schedulePreferences || activePlan.schedule_preferences || {};
  const planTrainingDays = normalizeRolloutTrainingDays(schedule.trainingDays || schedule.training_days);
  const profileTrainingDays = normalizeRolloutTrainingDays(profile.preferred_workout_days);
  const trainingDays = planTrainingDays.length ? planTrainingDays : profileTrainingDays;
  const availableDays = trainingDays.length ? trainingDays : DEFAULT_TRAINING_DAYS.slice();
  const requestedRuns = integer(
    schedule.runDaysPerWeek ?? schedule.run_days_per_week ?? profile.run_days_per_week,
    Math.min(3, availableDays.length),
    1,
    6
  );
  const runDaysPerWeek = Math.min(requestedRuns, availableDays.length);
  const strength = activePlan.strengthPolicy || activePlan.strength_policy || {};
  const rawMode = String(activePlan.planMode || activePlan.plan_mode || '').trim();
  const profileLiftDays = integer(profile.lift_days_per_week, 0, 0, 4);
  const mode = Object.values(planSchema.PLAN_MODES).includes(rawMode)
    ? rawMode
    : profileLiftDays > 0
      ? planSchema.PLAN_MODES.HYBRID_MAINTAIN
      : planSchema.PLAN_MODES.RUN_ONLY;
  const liftingEnabled = mode !== planSchema.PLAN_MODES.RUN_ONLY && strength.enabled !== false;
  const liftDaysPerWeek = liftingEnabled
    ? integer(strength.sessionsPerWeek ?? strength.sessions_per_week ?? profileLiftDays, Math.max(1, profileLiftDays), 1, 4)
    : 0;

  return {
    trainingDays: availableDays,
    runDaysPerWeek,
    planMode: mode,
    liftingEnabled,
    liftDaysPerWeek,
    strengthGoal: String(strength.goal || (mode === planSchema.PLAN_MODES.HYBRID_BUILD ? 'build' : 'maintain')),
    equipment: Array.isArray(strength.equipment) ? strength.equipment.slice(0, 20) : [],
  };
}

function isCurrentRolloutPlan(activePlan = {}, raceIds = []) {
  const activeRaceIds = planGoalRaceIds(activePlan).sort();
  const protectedRaceIds = [...new Set(raceIds.map((id) => String(id || '').trim()).filter(Boolean))].sort();
  return activePlan.engineVersion === RACE_PLAN_POLICY_V1.engineVersion
    && activePlan.policyVersion === RACE_PLAN_POLICY_V1.version
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
