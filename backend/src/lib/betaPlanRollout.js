const planSchema = require('./planSchema');
const { types: { isProxy } } = require('node:util');
const { DAY_ORDER, normalizeTrainingDays } = require('./runSchedule');
const { RACE_PLAN_POLICY_V1, addDays, canonicalHash } = require('./racePlanPolicy');
const { localDateForOffset } = require('./requestPlanningDate');
const {
  CONTRACT_VERSIONS,
  FEATURE_MODES,
  REQUIRED_REASON_CODES,
} = require('./goalBackwardContracts');

const MAX_PROTECTED_RACES = 2;
const MIN_RACE_GAP_DAYS = 21;
const MAX_PLAN_WINDOW_DAYS = 139;
const FORBIDDEN_BACKUP_KEYS = /(email|phone|password|token|secret|health|heart.?rate|gps|route|coordinate|latitude|longitude)/i;
const GOAL_BACKWARD_V24_MODE_SET = new Set(FEATURE_MODES);
const GOAL_BACKWARD_V24_AUDIENCES = Object.freeze(['cohort', 'all']);
const GOAL_BACKWARD_V24_AUDIENCE_SET = new Set(GOAL_BACKWARD_V24_AUDIENCES);
const GOAL_BACKWARD_V24_AUTHORITY_FIELDS = Object.freeze([
  'mode',
  'userId',
  'cohortRefs',
  'allowSyntheticShadow',
  'audience',
  'alertEntries',
]);
const GOAL_BACKWARD_TARGET_REF_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PRODUCTION_ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOAL_BACKWARD_RELEASE_TELEMETRY_SCHEMA = 'goal_backward_release_telemetry_v1';
const GOAL_BACKWARD_RELEASE_EVENT_TYPES = new Set([
  'mode_resolution',
  'candidate_comparison',
  'candidate_outcome',
  'surface_capability',
  'rollback',
  'cleanup',
]);
const GOAL_BACKWARD_RELEASE_OUTCOMES = new Set([
  'control_selected',
  'candidate_selected',
  'candidate_rejected',
  'previewed',
  'preview_apply_blocked',
  'applied',
  'apply_rejected',
  'stale_rejected',
  'revision_mismatch',
  'surface_accepted',
  'surface_blocked',
  'rollback_restored',
  'cleanup_verified',
  'dry_run',
]);
const GOAL_BACKWARD_SURFACE_CAPABILITIES = new Set([
  'NOT_EXPOSED',
  'PREVIEW_ONLY',
  'EXECUTABLE',
  'BLOCKED',
]);
const RELEASE_REASON_CODES = new Set([
  ...REQUIRED_REASON_CODES,
  'PASS',
  'UNCLASSIFIED',
  'CANDIDATE_APPLIED',
  'CANDIDATE_REJECTED',
  'CANDIDATE_NOT_SELECTED',
  'CANDIDATE_STALE',
  'CANDIDATE_HASH_MISMATCH',
  'CANDIDATE_DETERMINISM_MISMATCH',
  'CANDIDATE_REVISION_CHANGED',
  'DECISION_BINDING_CHANGED',
  'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
  'PLAN_VALIDATION_FAILED',
  'DECISION_ARTIFACT_CHANGED',
  'ACTIVE_PLAN_REVISION_CHANGED',
  'PLANNING_INPUT_REVISION_CHANGED',
  'PLANNING_CLOCK_CHANGED',
  'RACE_REVISION_CHANGED',
  'ATHLETE_STATE_REVISION_CHANGED',
  'SAFETY_STATE_CHANGED',
  'EVIDENCE_REVISION_CHANGED',
  'CONSTRAINT_REVISION_CHANGED',
  'POLICY_VERSION_CHANGED',
  'LOCK_REVISION_CHANGED',
  'EDIT_REVISION_CHANGED',
  'SURFACE_REVISION_CHANGED',
  'EXPORT_REVISION_CHANGED',
  'SELECTED_CANDIDATE_CHANGED',
  'GOAL_BACKWARD_MODE_UNAVAILABLE',
  'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED',
  'SURFACE_REVISION_MISMATCH',
  'SURFACE_EXECUTABILITY_MISMATCH',
  'HARD_VALIDATOR_BYPASS',
  'MUTATION_AFTER_STALE_FAILURE',
  'REVISION_MISMATCH',
  'UNKNOWN_TO_ZERO',
  'TELEMETRY_REDACTION_VIOLATION',
  'DUPLICATE_ASSIGNMENT',
]);
const ZERO_TOLERANCE_RELEASE_REASONS = new Set([
  'HARD_VALIDATOR_BYPASS',
  'MUTATION_AFTER_STALE_FAILURE',
  'REVISION_MISMATCH',
  'UNKNOWN_TO_ZERO',
  'TELEMETRY_REDACTION_VIOLATION',
  'SURFACE_EXECUTABILITY_MISMATCH',
  'DUPLICATE_ASSIGNMENT',
]);
const RELEASE_TELEMETRY_BUFFER_LIMIT = 256;
const RELEASE_TELEMETRY_REASON_COUNT_LIMIT = 64;
const GOAL_BACKWARD_RELEASE_TELEMETRY_KEYS = Object.freeze([
  'schema_version',
  'target_ref',
  'event_type',
  'mode',
  'policy_versions',
  'outcome',
  'candidate_selected',
  'reason_counts',
  'surface_capability',
  'revision_mismatch',
]);
const GOAL_BACKWARD_RELEASE_POLICY_VERSION_KEYS = Object.freeze(Object.keys(CONTRACT_VERSIONS));
const releaseTelemetryBuffer = [];

function getGoalBackwardV24Mode(value = process.env.FORGE_GOAL_BACKWARD_V24_MODE) {
  const configured = typeof value === 'string' ? value : '';
  return GOAL_BACKWARD_V24_MODE_SET.has(configured) ? configured : 'off';
}

function getGoalBackwardV24Audience(value = process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE) {
  const configured = typeof value === 'string' ? value : '';
  return GOAL_BACKWARD_V24_AUDIENCE_SET.has(configured) ? configured : 'cohort';
}

function snapshotExactPlainOwnDataRecord(value, exactKeys) {
  try {
    if (!value || value === Object.prototype || typeof value !== 'object'
      || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== exactKeys.length
      || ownKeys.some((key) => typeof key !== 'string' || !exactKeys.includes(key))) return null;
    const snapshot = Object.create(null);
    for (const key of exactKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch (_error) {
    return null;
  }
}

function snapshotGoalBackwardReleasePolicyVersions(value) {
  const record = snapshotExactPlainOwnDataRecord(
    value,
    GOAL_BACKWARD_RELEASE_POLICY_VERSION_KEYS,
  );
  if (!record) return null;
  const snapshot = {};
  for (const key of GOAL_BACKWARD_RELEASE_POLICY_VERSION_KEYS) {
    if (record[key] !== CONTRACT_VERSIONS[key]) return null;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: record[key],
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotGoalBackwardReleaseReasonCounts(value) {
  try {
    if (!value || value === Object.prototype || typeof value !== 'object'
      || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > RELEASE_TELEMETRY_REASON_COUNT_LIMIT
      || ownKeys.some((key) => typeof key !== 'string' || !RELEASE_REASON_CODES.has(key))) return null;
    const normalized = {};
    for (const code of [...ownKeys].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, code);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const counts = snapshotExactPlainOwnDataRecord(descriptor.value, ['pass', 'fail']);
      if (!counts || !Number.isSafeInteger(counts.pass) || counts.pass < 0
        || !Number.isSafeInteger(counts.fail) || counts.fail < 0) return null;
      const normalizedCounts = {};
      Object.defineProperties(normalizedCounts, {
        pass: { enumerable: true, value: counts.pass },
        fail: { enumerable: true, value: counts.fail },
      });
      Object.defineProperty(normalized, code, {
        configurable: false,
        enumerable: true,
        value: Object.freeze(normalizedCounts),
        writable: false,
      });
    }
    return Object.freeze(normalized);
  } catch (_error) {
    return null;
  }
}

function snapshotGoalBackwardReleaseTelemetryRecord(value) {
  const record = snapshotExactPlainOwnDataRecord(value, GOAL_BACKWARD_RELEASE_TELEMETRY_KEYS);
  if (!record) return null;
  const policyVersions = snapshotGoalBackwardReleasePolicyVersions(record.policy_versions);
  const reasonCounts = snapshotGoalBackwardReleaseReasonCounts(record.reason_counts);
  if (!policyVersions || !reasonCounts
    || record.schema_version !== GOAL_BACKWARD_RELEASE_TELEMETRY_SCHEMA
    || typeof record.target_ref !== 'string'
    || !GOAL_BACKWARD_TARGET_REF_PATTERN.test(record.target_ref)
    || typeof record.event_type !== 'string'
    || !GOAL_BACKWARD_RELEASE_EVENT_TYPES.has(record.event_type)
    || typeof record.mode !== 'string'
    || !GOAL_BACKWARD_V24_MODE_SET.has(record.mode)
    || typeof record.outcome !== 'string'
    || !GOAL_BACKWARD_RELEASE_OUTCOMES.has(record.outcome)
    || typeof record.candidate_selected !== 'boolean'
    || typeof record.surface_capability !== 'string'
    || !GOAL_BACKWARD_SURFACE_CAPABILITIES.has(record.surface_capability)
    || typeof record.revision_mismatch !== 'boolean') return null;
  const snapshot = {};
  const normalizedValues = {
    schema_version: record.schema_version,
    target_ref: record.target_ref,
    event_type: record.event_type,
    mode: record.mode,
    policy_versions: policyVersions,
    outcome: record.outcome,
    candidate_selected: record.candidate_selected,
    reason_counts: reasonCounts,
    surface_capability: record.surface_capability,
    revision_mismatch: record.revision_mismatch,
  };
  for (const key of GOAL_BACKWARD_RELEASE_TELEMETRY_KEYS) {
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: normalizedValues[key],
      writable: false,
    });
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 8192) return null;
  return Object.freeze(snapshot);
}

function snapshotGoalBackwardReleaseAlertEntries(value) {
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Object.hasOwn(lengthDescriptor || {}, 'value') || !Number.isSafeInteger(length)
      || length < 0 || length > RELEASE_TELEMETRY_BUFFER_LIMIT) return null;
    const expectedKeys = new Set(['length']);
    for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.size
      || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) return null;
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const event = snapshotGoalBackwardReleaseTelemetryRecord(descriptor.value);
      if (!event) return null;
      Object.defineProperty(snapshot, String(index), {
        configurable: false,
        enumerable: true,
        value: event,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch (_error) {
    return null;
  }
}

function snapshotGoalBackwardV24Authority(value) {
  try {
    if (!value || value === Object.prototype || typeof value !== 'object'
      || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = Object.create(null);
    for (const field of GOAL_BACKWARD_V24_AUTHORITY_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      const fieldValue = field === 'alertEntries'
        ? snapshotGoalBackwardReleaseAlertEntries(descriptor.value)
        : descriptor.value;
      if (field === 'alertEntries' && !fieldValue) return null;
      Object.defineProperty(snapshot, field, {
        configurable: false,
        enumerable: true,
        value: fieldValue,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch (_error) {
    return null;
  }
}

function parseGoalBackwardCohortRefs(
  value = process.env.FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS,
) {
  let values;
  if (value === undefined) {
    values = [];
  } else if (typeof value === 'string') {
    values = value.split(',');
  } else if (value && typeof value === 'object' && !isProxy(value) && Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('Goal-backward cohorts accept only bounded pseudonymous sha256 refs');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Goal-backward cohorts accept only bounded pseudonymous sha256 refs');
    }
    values = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw new Error('Goal-backward cohorts accept only bounded pseudonymous sha256 refs');
      }
      values.push(descriptor.value);
    }
  } else {
    throw new Error('Goal-backward cohorts accept only bounded pseudonymous sha256 refs');
  }
  const refs = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
  if (refs.length > 64 || refs.some((entry) => !GOAL_BACKWARD_TARGET_REF_PATTERN.test(entry))) {
    throw new Error('Goal-backward cohorts accept only bounded pseudonymous sha256 refs');
  }
  return refs;
}

function releaseAlertEntries(authority) {
  // The in-process buffer is diagnostic evidence, not a deployment authority.
  // Letting one request mutate later requests made release mode depend on which
  // Node process handled an account. Rollback remains fail-closed only when a
  // server-owned alert snapshot is supplied explicitly.
  return Object.hasOwn(authority, 'alertEntries') ? authority.alertEntries : [];
}

function resolveOperationalGoalBackwardV24Mode(value, options = {}) {
  const usesEnvironmentMode = value === undefined;
  const configured = getGoalBackwardV24Mode(
    usesEnvironmentMode ? process.env.FORGE_GOAL_BACKWARD_V24_MODE : value,
  );
  if (configured === 'off') return 'off';
  const authority = snapshotGoalBackwardV24Authority(options);
  if (!authority || !Object.hasOwn(authority, 'userId') || typeof authority.userId !== 'string') {
    return 'off';
  }
  const userId = authority.userId.trim();
  if (!userId) return 'off';
  const hasInjectedAudience = Object.hasOwn(authority, 'audience');
  const audience = hasInjectedAudience
    ? getGoalBackwardV24Audience(authority.audience === undefined ? null : authority.audience)
    : usesEnvironmentMode ? getGoalBackwardV24Audience() : 'cohort';
  let audienceAuthorized = false;
  if (audience === 'all') {
    audienceAuthorized = PRODUCTION_ACCOUNT_ID_PATTERN.test(userId);
  } else {
    let cohortRefs;
    try {
      if (Object.hasOwn(authority, 'cohortRefs')) {
        if (authority.cohortRefs === undefined) return 'off';
        cohortRefs = parseGoalBackwardCohortRefs(authority.cohortRefs);
      } else {
        cohortRefs = usesEnvironmentMode ? parseGoalBackwardCohortRefs() : [];
      }
    } catch (_error) {
      return 'off';
    }
    const cohortAuthorized = cohortRefs.includes(targetRef(userId));
    const syntheticShadowCompatibility = configured === 'shadow'
      && Object.hasOwn(authority, 'allowSyntheticShadow')
      && authority.allowSyntheticShadow === true
      && /(?:^|[/\\])[^/\\]+\.smoke\.js$/.test(String(process.argv[1] || ''))
      && !PRODUCTION_ACCOUNT_ID_PATTERN.test(userId);
    audienceAuthorized = cohortAuthorized || syntheticShadowCompatibility;
  }
  if (!audienceAuthorized) return 'off';
  const alerts = evaluateGoalBackwardReleaseAlerts(releaseAlertEntries(authority));
  return alerts.rollback_required ? 'off' : configured;
}

function stableTelemetryReasonCode(value) {
  const code = String(value || '').trim();
  if (!RELEASE_REASON_CODES.has(code)) {
    throw new Error('Release telemetry requires a stable reason code');
  }
  return code;
}

function releaseReasonCounts(passReasonCodes = [], failReasonCodes = []) {
  if (!Array.isArray(passReasonCodes) || !Array.isArray(failReasonCodes)
    || passReasonCodes.length > 32 || failReasonCodes.length > 32) {
    throw new Error('Release telemetry reason counts must be bounded');
  }
  const counts = {};
  for (const [kind, values] of [['pass', passReasonCodes], ['fail', failReasonCodes]]) {
    for (const raw of values) {
      const code = stableTelemetryReasonCode(raw);
      if (!counts[code]) counts[code] = { pass: 0, fail: 0 };
      counts[code][kind] += 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildGoalBackwardReleaseTelemetry(input = {}) {
  const allowedInputKeys = new Set([
    'targetRef', 'eventType', 'mode', 'outcome', 'candidateSelected',
    'passReasonCodes', 'failReasonCodes', 'surfaceCapability', 'revisionMismatch',
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedInputKeys.has(key));
  if (unknownKeys.length) throw new Error('Release events accept only bounded telemetry fields');
  const targetRefValue = String(input.targetRef || '');
  const eventType = String(input.eventType || '');
  const mode = getGoalBackwardV24Mode(input.mode);
  const outcome = String(input.outcome || '');
  const surfaceCapability = String(input.surfaceCapability || 'NOT_EXPOSED');
  if (!GOAL_BACKWARD_TARGET_REF_PATTERN.test(targetRefValue)) throw new Error('Release telemetry target ref is invalid');
  if (!GOAL_BACKWARD_RELEASE_EVENT_TYPES.has(eventType)) throw new Error('Release telemetry event type is invalid');
  if (!GOAL_BACKWARD_RELEASE_OUTCOMES.has(outcome)) throw new Error('Release telemetry outcome is invalid');
  if (!GOAL_BACKWARD_SURFACE_CAPABILITIES.has(surfaceCapability)) {
    throw new Error('Release telemetry surface capability is invalid');
  }
  if (input.candidateSelected !== undefined && typeof input.candidateSelected !== 'boolean') {
    throw new Error('Release telemetry candidate selection must be boolean');
  }
  return Object.freeze({
    schema_version: GOAL_BACKWARD_RELEASE_TELEMETRY_SCHEMA,
    target_ref: targetRefValue,
    event_type: eventType,
    mode,
    policy_versions: Object.freeze({ ...CONTRACT_VERSIONS }),
    outcome,
    candidate_selected: input.candidateSelected === true,
    reason_counts: Object.freeze(releaseReasonCounts(input.passReasonCodes, input.failReasonCodes)),
    surface_capability: surfaceCapability,
    revision_mismatch: input.revisionMismatch === true,
  });
}

function assertGoalBackwardReleaseTelemetry(event = {}) {
  const snapshot = snapshotGoalBackwardReleaseTelemetryRecord(event);
  if (!snapshot) throw new Error('Invalid goal-backward release telemetry record');
  return snapshot;
}

function emitGoalBackwardReleaseTelemetry(input, { sink = null } = {}) {
  const event = input?.schema_version === GOAL_BACKWARD_RELEASE_TELEMETRY_SCHEMA
    ? assertGoalBackwardReleaseTelemetry(input)
    : buildGoalBackwardReleaseTelemetry(input);
  releaseTelemetryBuffer.push(event);
  if (releaseTelemetryBuffer.length > RELEASE_TELEMETRY_BUFFER_LIMIT) releaseTelemetryBuffer.shift();
  const emit = typeof sink === 'function'
    ? sink
    : (value) => console.info(JSON.stringify({ event_name: 'goal_backward_v24_release', ...value }));
  emit(event);
  return event;
}

function goalBackwardReleaseTelemetrySnapshot() {
  return releaseTelemetryBuffer.slice();
}

function clearGoalBackwardReleaseTelemetry() {
  releaseTelemetryBuffer.length = 0;
}

function evaluateGoalBackwardReleaseAlerts(entries = []) {
  const breached = new Set();
  const snapshot = snapshotGoalBackwardReleaseAlertEntries(entries);
  if (!snapshot) breached.add('TELEMETRY_REDACTION_VIOLATION');
  for (const normalized of snapshot || []) {
    if (normalized.revision_mismatch) breached.add('REVISION_MISMATCH');
    for (const [code, counts] of Object.entries(normalized.reason_counts)) {
      if (ZERO_TOLERANCE_RELEASE_REASONS.has(code) && counts.fail > 0) breached.add(code);
    }
  }
  const breachedThresholds = [...breached].sort();
  return Object.freeze({
    threshold_policy: 'goal_backward_release_zero_tolerance_v1',
    breached_thresholds: breachedThresholds,
    rollback_required: breachedThresholds.length > 0,
  });
}

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

function authoritativePlanTarget(activePlan = {}, profile = {}) {
  const rawTrainingDays = parseJson(profile.preferred_workout_days, profile.preferred_workout_days);
  const rawRunDays = profile.run_days_per_week;
  const rawLiftDays = profile.lift_days_per_week;
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
    liftDaysPerWeek = integer(rawLiftDays, 1, 4);
    if (!liftDaysPerWeek) return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
    if (!Array.isArray(strength.equipment)) return { valid: false, reason: 'MISSING_SCHEDULE_AUTHORITY' };
  }

  return { valid: true, profileSchedule: { trainingDays, runDaysPerWeek, liftDaysPerWeek }, target: {
    planMode: rawMode,
    liftingEnabled,
    strengthGoal: String(strength.goal || (rawMode === planSchema.PLAN_MODES.HYBRID_BUILD ? 'build' : 'maintain')),
    equipment: liftingEnabled ? strength.equipment.slice(0, 20) : [],
  } };
}

function preservedPlanTarget(activePlan = {}, profile = {}) {
  const result = authoritativePlanTarget(activePlan, profile);
  if (!result.valid) {
    const error = new Error('The active plan or current profile does not contain authoritative rollout inputs.');
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

function buildBackupManifest({ entries, createdAt = new Date().toISOString(), mode = 'apply', releaseIdentity = null }) {
  return assertRedactedBackup({
    schema_version: 2,
    created_at: createdAt,
    mode,
    engine_version: RACE_PLAN_POLICY_V1.engineVersion,
    policy_version: RACE_PLAN_POLICY_V1.version,
    release_identity: releaseIdentity,
    rollback_ready: true,
    entries,
  });
}

module.exports = {
  GOAL_BACKWARD_V24_AUDIENCES,
  GOAL_BACKWARD_V24_MODES: FEATURE_MODES,
  MAX_PROTECTED_RACES,
  authoritativePlanTarget,
  assertApplyAuthorized,
  assertRedactedBackup,
  buildBackupManifest,
  buildGoalBackwardReleaseTelemetry,
  clearGoalBackwardReleaseTelemetry,
  emitGoalBackwardReleaseTelemetry,
  evaluateGoalBackwardReleaseAlerts,
  getGoalBackwardV24Audience,
  getGoalBackwardV24Mode,
  goalBackwardReleaseTelemetrySnapshot,
  assertGoalBackwardReleaseTelemetry,
  parseGoalBackwardCohortRefs,
  resolveGoalBackwardV24Mode: getGoalBackwardV24Mode,
  localDateForOffset,
  isCurrentRolloutPlan,
  normalizeRolloutTrainingDays,
  parseStoredPlan,
  planGoalRaceIds,
  preservedPlanTarget,
  redactedBackupEntry,
  resolveOperationalGoalBackwardV24Mode,
  selectProtectedRaces,
  snapshotGoalBackwardV24Authority,
  targetRef,
};
