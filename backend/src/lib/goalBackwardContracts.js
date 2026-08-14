const EVIDENCE_SCHEMA_VERSION = 1;
const ATHLETE_STATE_SCHEMA_VERSION = 1;
const PLANNING_POLICY_VERSION = 'goal-backward-planning-policy-v1';
const EVENT_POLICY_REGISTRY_VERSION = 1;
const STRESS_TAXONOMY_VERSION = 1;
const TARGET_POLICY_VERSION = 1;
const TARGET_CONVERSION_REGISTRY_VERSION = 1;
const PLANNING_DECISION_SCHEMA_VERSION = 1;
const CANONICAL_WORKOUT_SCHEMA_VERSION = 1;
const HYROX_RULESET_ID = 'hyrox-global';
const HYROX_RULESET_VERSION = '2026-2027';

const CONTRACT_VERSIONS = Object.freeze({
  evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
  athlete_state_schema_version: ATHLETE_STATE_SCHEMA_VERSION,
  planning_policy_version: PLANNING_POLICY_VERSION,
  event_policy_registry_version: EVENT_POLICY_REGISTRY_VERSION,
  stress_taxonomy_version: STRESS_TAXONOMY_VERSION,
  target_policy_version: TARGET_POLICY_VERSION,
  target_conversion_registry_version: TARGET_CONVERSION_REGISTRY_VERSION,
  planning_decision_schema_version: PLANNING_DECISION_SCHEMA_VERSION,
  canonical_workout_schema_version: CANONICAL_WORKOUT_SCHEMA_VERSION,
  hyrox_ruleset_id: HYROX_RULESET_ID,
  hyrox_ruleset_version: HYROX_RULESET_VERSION,
});

const closed = (values) => Object.freeze([...values]);

const TRUTH_CLASSES = closed(['OBSERVED', 'DERIVED', 'PRESCRIBED', 'EXPLANATION']);
const EVIDENCE_QUALITY_STATES = closed(['COMPLETE', 'PARTIAL', 'FAILED_SYNC', 'CONFLICT', 'CORRUPTED']);
const EVIDENCE_VALUE_STATES = closed(['KNOWN', 'VALID_ZERO', 'UNKNOWN', 'MISSING', 'STALE']);
const EVIDENCE_FRESHNESS_CLASSES = closed(['FRESH', 'STALE', 'EXPIRED', 'TIMELESS']);
const EVIDENCE_SOURCE_SYSTEMS = closed(['forge', 'fit', 'garmin', 'apple_health', 'health_connect', 'manual', 'import']);
const CANONICAL_UNITS = closed(['m', 's', 'bpm', 'kg', 'count', 'ordinal', null]);
const CONFIDENCE_CLASSES = closed(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT']);
const TRAINING_AGE_CLASSES = closed(['BEGINNER', 'DEVELOPING', 'ESTABLISHED', 'ADVANCED', 'UNKNOWN']);
const CONSISTENCY_STATES = closed(['CONSISTENT', 'INTERRUPTED', 'RETURNING', 'SPARSE_DATA', 'UNKNOWN']);
const RECENT_NORMAL_STATUSES = closed(['ESTABLISHED', 'PROVISIONAL', 'INSUFFICIENT', 'TRAINING_GAP']);
const RECOVERY_STATES = closed(['READY', 'NORMAL', 'CAUTION', 'RECOVERY', 'UNKNOWN']);
const SAFETY_ACTIONS = closed([
  'NORMAL',
  'MONITOR',
  'MODIFY_IMPACT',
  'NO_RUNNING',
  'NO_LOWER_BODY',
  'NO_HIGH_INTENSITY',
  'MODIFIED_SESSION_ONLY',
  'FULL_REST',
  'PROFESSIONAL_ASSESSMENT_RECOMMENDED',
]);
const EVENT_STATES = closed(['SCHEDULED', 'COMPLETED', 'DNS', 'CANCELLED', 'POSTPONED', 'UNKNOWN']);
const GOAL_PRIORITIES = closed(['A', 'B', 'C', 'UNSPECIFIED']);
const GOAL_TYPES = closed(['completion', 'performance', 'PR', 'experience']);
const FEASIBILITY_STATUSES = closed(['supported', 'unvalidated', 'at_risk', 'not_currently_supported']);
const PLANNING_PHASES = closed([
  'FOUNDATION',
  'DEVELOPMENT',
  'EVENT_SPECIFIC_DEVELOPMENT',
  'SHARPENING',
  'TAPER_RACE_WEEK',
  'POST_RACE_TRANSITION',
]);
const ARTIFACT_KINDS = closed([
  'evidence_snapshot',
  'athlete_state',
  'planning_decision',
  'candidate_week',
  'validator_result',
  'canonical_session_set',
  'surface_manifest',
]);
const FEATURE_MODES = closed(['off', 'shadow', 'preview', 'on']);
const CONSTRAINT_KINDS = closed(['day_lock', 'session_lock', 'manual_edit']);
const CANONICAL_SESSION_ROLES = closed(['PRIMARY_KEY', 'SUPPORTING', 'RECOVERY', 'REST', 'ASSESSMENT']);
const CANONICAL_WORKOUT_FAMILIES = closed([
  'rest',
  'mobility',
  'manual_recovery',
  'recovery_run',
  'easy_run',
  'long_aerobic',
  'steady_run',
  'threshold_run',
  'interval_run',
  'race_rhythm_run',
  'strength_lower',
  'strength_upper',
  'strength_full_body',
  'hyrox_station_skill',
  'hyrox_station_strength',
  'hyrox_compromised',
  'hyrox_partial_simulation',
  'hyrox_full_simulation',
  'race',
  'assessment',
]);
const CANONICAL_STEP_TYPES = closed([
  'warmup',
  'run',
  'interval',
  'repeat',
  'recovery',
  'station',
  'strength_exercise',
  'transition',
  'cooldown',
  'mobility',
  'manual_instruction',
]);
const CANONICAL_WORKOUT_UNITS = closed([
  'm', 's', 's/km', 'bpm', 'rpe', 'spm', 'kg', 'count', 'rir', 'ordinal',
]);
const CANONICAL_TARGET_FIELDS = closed([
  'distance_m',
  'duration_s',
  'pace_range_s_per_km',
  'reference_pace_range_s_per_km',
  'heart_rate_range_bpm',
  'rpe_range',
  'cadence_range_spm',
  'load_kg',
  'repetitions',
  'sets',
  'rest_s',
  'rir',
  'stop_ceiling',
]);
const CANONICAL_EXPORT_CAPABILITIES = closed([
  'FULLY_STRUCTURED',
  'PARTIALLY_STRUCTURED',
  'MANUAL_COMPONENTS_REQUIRED',
  'NOT_EXPORTABLE',
]);

const CLOSED_UNIONS = Object.freeze({
  truth_classes: TRUTH_CLASSES,
  evidence_quality_states: EVIDENCE_QUALITY_STATES,
  evidence_value_states: EVIDENCE_VALUE_STATES,
  evidence_freshness_classes: EVIDENCE_FRESHNESS_CLASSES,
  evidence_source_systems: EVIDENCE_SOURCE_SYSTEMS,
  canonical_units: CANONICAL_UNITS,
  confidence_classes: CONFIDENCE_CLASSES,
  training_age_classes: TRAINING_AGE_CLASSES,
  consistency_states: CONSISTENCY_STATES,
  recent_normal_statuses: RECENT_NORMAL_STATUSES,
  recovery_states: RECOVERY_STATES,
  safety_actions: SAFETY_ACTIONS,
  event_states: EVENT_STATES,
  goal_priorities: GOAL_PRIORITIES,
  goal_types: GOAL_TYPES,
  feasibility_statuses: FEASIBILITY_STATUSES,
  planning_phases: PLANNING_PHASES,
  artifact_kinds: ARTIFACT_KINDS,
  feature_modes: FEATURE_MODES,
  constraint_kinds: CONSTRAINT_KINDS,
  canonical_session_roles: CANONICAL_SESSION_ROLES,
  canonical_workout_families: CANONICAL_WORKOUT_FAMILIES,
  canonical_step_types: CANONICAL_STEP_TYPES,
  canonical_workout_units: CANONICAL_WORKOUT_UNITS,
  canonical_target_fields: CANONICAL_TARGET_FIELDS,
  canonical_export_capabilities: CANONICAL_EXPORT_CAPABILITIES,
});

const REQUIRED_REASON_CODES = closed([
  'EVIDENCE_UNKNOWN',
  'EVIDENCE_MISSING',
  'FAILED_SYNC',
  'PARTIAL_SYNC',
  'EVIDENCE_CONFLICT_UNRESOLVED',
  'MANUAL_CORRECTION_APPLIED',
  'VALID_ZERO_CONFIRMED',
  'EVIDENCE_STALE',
  'RECENT_LOAD_MAINTAIN',
  'TAPER_VOLUME_REDUCTION',
  'RECOVERY_VOLUME_REDUCTION',
  'TRAINING_GAP_REBUILD',
  'SCHEDULE_CONSTRAINT',
  'CROSS_MODAL_FATIGUE_LIMIT',
  'PHASE_SPECIFIC_OVERLOAD',
  'RECENT_NORMAL_INSUFFICIENT',
  'HARD_DAY_STACK_TO_PROTECT_RECOVERY',
  'FOUNDATION_ENTRY',
  'DEVELOPMENT_ENTRY',
  'EVENT_SPECIFIC_ENTRY',
  'SHARPENING_ENTRY',
  'TAPER_ENTRY',
  'POST_RACE_TRANSITION',
  'REQUIRED_EXPOSURE_UNPLACEABLE',
  'PREMATURE_TAPER_PREVENTED',
  'LATE_BUILD_PREVENTED',
  'KEY_SESSION_COMPLETED_ON_TARGET',
  'EXCESSIVE_STRAIN',
  'MISSED_SESSION_SKIP',
  'MISSED_SESSION_RESCHEDULE',
  'NO_WORKOUT_DEBT',
  'ADAPTATION_REJECTED',
  'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED',
  'PAIN_MONITOR',
  'MODIFY_IMPACT',
  'NO_RUNNING',
  'NO_LOWER_BODY',
  'NO_HIGH_INTENSITY',
  'FULL_REST',
  'ILLNESS_RECOVERY',
  'PROFESSIONAL_ASSESSMENT_RECOMMENDED',
  'ILLNESS_STATUS_NEEDS_UPDATE',
  'INJURY_SCOPE',
  'BELOW_PRESENTATION_FLOOR_EXCEPTION',
  'PACE_EVIDENCE_STALE',
  'PACE_EVIDENCE_MISSING',
  'HR_RPE_FALLBACK',
  'ASSESSMENT_REQUIRED',
  'STATION_BENCHMARK_MISSING',
  'TRANSITION_BENCHMARK_MISSING',
  'DIVISION_UNKNOWN',
  'RULESET_UNSUPPORTED',
  'TEAM_INDIVIDUAL_BURDEN_UNKNOWN',
  'ENVIRONMENT_EFFORT_OVERRIDE',
  'UNKNOWN_INVENTORY',
  'PARTIAL_SHOE_MILEAGE',
  'MATERIAL_CHANGE_REVIEW_REQUIRED',
  'ATHLETE_LOCK_CONFLICT',
  'ATHLETE_EDIT_PRESERVED',
  'STALE_PLAN_REVISION',
  'STALE_ATHLETE_STATE',
  'RACE_REVISION_CHANGED',
  'DUPLICATE_APPLY_IDEMPOTENT',
  'DERIVED_TOTAL_MISMATCH',
  'SESSION_ROLE_UNJUSTIFIED',
  'WORKOUT_FAMILY_UNRESOLVED',
  'EXPORT_CAPABILITY_PARTIAL',
  'EXPORT_MANUAL_COMPONENT_REQUIRED',
  'SURFACE_REVISION_MISMATCH',
]);

const REASON_CODE_FAMILIES = Object.freeze({
  evidence: closed(REQUIRED_REASON_CODES.slice(0, 8)),
  load: closed(REQUIRED_REASON_CODES.slice(8, 17)),
  phase: closed(REQUIRED_REASON_CODES.slice(17, 26)),
  adaptation: closed(REQUIRED_REASON_CODES.slice(26, 33)),
  safety: closed(REQUIRED_REASON_CODES.slice(33, 44)),
  target_uncertainty: closed(REQUIRED_REASON_CODES.slice(44, 56)),
  mutation_constraint: closed(REQUIRED_REASON_CODES.slice(56, 66)),
  surface_export: closed(REQUIRED_REASON_CODES.slice(66)),
});
const REASON_CODE_MIGRATION_ALIASES = Object.freeze({ NO_IMPACT: 'MODIFY_IMPACT' });
const REQUIRED_REASON_CODE_SET = new Set(REQUIRED_REASON_CODES);

function normalizeReasonCode(value, { allowMigrationAlias = false } = {}) {
  const code = String(value || '');
  if (REQUIRED_REASON_CODE_SET.has(code)) return code;
  if (allowMigrationAlias && Object.hasOwn(REASON_CODE_MIGRATION_ALIASES, code)) {
    return REASON_CODE_MIGRATION_ALIASES[code];
  }
  return null;
}

const REDACTION_KEYS = closed([
  'access_token',
  'address',
  'api_key',
  'auth_token',
  'authorization',
  'athlete_name',
  'cookie',
  'cookies',
  'coordinates',
  'date_of_birth',
  'dob',
  'email',
  'first_name',
  'full_name',
  'geometry',
  'gps',
  'gps_coordinates',
  'ip_address',
  'latitude',
  'longitude',
  'last_name',
  'password',
  'password_hash',
  'phone',
  'phone_number',
  'polyline',
  'provider_payload',
  'raw_payload',
  'refresh_token',
  'route',
  'route_coordinates',
  'route_points',
  'secret',
  'session_token',
  'token',
]);

const MAX_PIPELINE_ARTIFACT_BYTES = 256 * 1024;
const MAX_ARTIFACT_ID_LENGTH = 200;
const HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const ARTIFACT_KIND_SET = new Set(ARTIFACT_KINDS);
const REDACTION_KEY_SET = new Set(REDACTION_KEYS);

function normalizedKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isRedactionKey(key) {
  const normalized = normalizedKey(key);
  if (normalized === 'provider_payload_hash') return false;
  if (REDACTION_KEY_SET.has(normalized)) return true;
  return /(?:^|_)(?:password|secret|token|email|phone|latitude|longitude)(?:_|$)/.test(normalized)
    || normalized.includes('provider_payload')
    || normalized.includes('raw_payload')
    || normalized.includes('route_coordinate');
}

function findRedactionViolations(value, path = 'payload_json', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findRedactionViolations(entry, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isRedactionKey(key)) found.push(childPath);
    findRedactionViolations(nested, childPath, found);
  }
  return found;
}

function findNonJsonValues(value, path = 'payload_json', found = [], ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return found;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) found.push(path);
    return found;
  }
  if (typeof value !== 'object') {
    found.push(path);
    return found;
  }
  if (ancestors.has(value)) {
    found.push(path);
    return found;
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      found.push(path);
      return found;
    }
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findNonJsonValues(entry, `${path}[${index}]`, found, ancestors));
  } else {
    for (const [key, nested] of Object.entries(value)) {
      findNonJsonValues(nested, `${path}.${key}`, found, ancestors);
    }
  }
  ancestors.delete(value);
  return found;
}

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch (_error) {
    return null;
  }
}

function nonEmptyBoundedString(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ARTIFACT_ID_LENGTH
    && value.trim() === value;
}

function nullableBoundedString(value) {
  return value == null || nonEmptyBoundedString(value);
}

function validVersion(value) {
  if (Number.isSafeInteger(value)) return value >= 1;
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value;
}

function validatePipelineArtifact(artifact, { maximumPayloadBytes = MAX_PIPELINE_ARTIFACT_BYTES } = {}) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { valid: false, errors: [{ code: 'ARTIFACT_NOT_OBJECT', path: 'artifact' }], bytes: null };
  }
  if (!nonEmptyBoundedString(artifact.id)) errors.push({ code: 'ARTIFACT_ID_INVALID', path: 'id' });
  if (!nonEmptyBoundedString(artifact.user_id)) errors.push({ code: 'ARTIFACT_USER_INVALID', path: 'user_id' });
  if (!ARTIFACT_KIND_SET.has(artifact.artifact_kind)) {
    errors.push({ code: 'ARTIFACT_KIND_INVALID', path: 'artifact_kind' });
  }
  for (const key of ['decision_id', 'parent_artifact_id', 'plan_generation_candidate_id']) {
    if (!nullableBoundedString(artifact[key])) errors.push({ code: 'ARTIFACT_LINK_INVALID', path: key });
  }
  if (!validVersion(artifact.schema_version)) {
    errors.push({ code: 'ARTIFACT_SCHEMA_VERSION_INVALID', path: 'schema_version' });
  }
  if (!validVersion(artifact.policy_version)) {
    errors.push({ code: 'ARTIFACT_POLICY_VERSION_INVALID', path: 'policy_version' });
  }
  if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 1) {
    errors.push({ code: 'ARTIFACT_REVISION_INVALID', path: 'revision' });
  }
  if (!HASH_PATTERN.test(String(artifact.content_hash || ''))) {
    errors.push({ code: 'ARTIFACT_HASH_INVALID', path: 'content_hash' });
  }
  if (!artifact.payload_json || typeof artifact.payload_json !== 'object' || Array.isArray(artifact.payload_json)) {
    errors.push({ code: 'ARTIFACT_PAYLOAD_INVALID', path: 'payload_json' });
  }
  const nonJsonValues = findNonJsonValues(artifact.payload_json);
  if (nonJsonValues.length) {
    errors.push({ code: 'ARTIFACT_PAYLOAD_NOT_CANONICAL_JSON', path: nonJsonValues[0], paths: nonJsonValues });
  }
  const bytes = jsonBytes(artifact.payload_json);
  if (bytes === null && !errors.some((error) => error.code === 'ARTIFACT_PAYLOAD_INVALID')) {
    errors.push({ code: 'ARTIFACT_PAYLOAD_INVALID', path: 'payload_json' });
  }
  const boundedMaximum = Number.isSafeInteger(maximumPayloadBytes) && maximumPayloadBytes >= 1
    ? maximumPayloadBytes
    : MAX_PIPELINE_ARTIFACT_BYTES;
  if (bytes !== null && bytes > boundedMaximum) {
    errors.push({
      code: 'ARTIFACT_PAYLOAD_TOO_LARGE',
      path: 'payload_json',
      bytes,
      maximum_bytes: boundedMaximum,
    });
  }
  if (bytes !== null) {
    const violations = findRedactionViolations(artifact.payload_json);
    if (violations.length) {
      errors.push({ code: 'ARTIFACT_REDACTION_REQUIRED', path: violations[0], paths: violations });
    }
  }
  const createdAtRaw = String(artifact.created_at || '');
  const createdAt = Date.parse(createdAtRaw);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!Number.isFinite(createdAt) || !rfc3339.test(createdAtRaw)) {
    errors.push({ code: 'ARTIFACT_CREATED_AT_INVALID', path: 'created_at' });
  }
  return { valid: errors.length === 0, errors, bytes };
}

function assertPipelineArtifact(artifact, options) {
  const result = validatePipelineArtifact(artifact, options);
  if (!result.valid) {
    const error = new Error(`Pipeline artifact failed validation: ${result.errors[0].code}`);
    error.code = 'INVALID_PIPELINE_ARTIFACT';
    error.status = 422;
    error.details = result.errors;
    throw error;
  }
  return artifact;
}

function artifactsAsArray(artifacts) {
  if (Array.isArray(artifacts)) return artifacts;
  if (!artifacts || typeof artifacts !== 'object') return [];
  return ARTIFACT_KINDS.map((kind) => artifacts[kind]).filter(Boolean);
}

function validatePipelineLinks(input) {
  const artifacts = artifactsAsArray(input);
  const errors = [];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(input)) {
      if (!ARTIFACT_KIND_SET.has(key)) {
        errors.push({ code: 'PIPELINE_ARTIFACT_KIND_INVALID', path: key });
      }
    }
  }
  const byKind = new Map();
  const byId = new Map();
  for (const [index, artifact] of artifacts.entries()) {
    const validation = validatePipelineArtifact(artifact);
    if (!validation.valid) {
      errors.push({ code: 'PIPELINE_ARTIFACT_INVALID', path: `[${index}]`, details: validation.errors });
      continue;
    }
    if (byKind.has(artifact.artifact_kind)) {
      errors.push({ code: 'PIPELINE_ARTIFACT_KIND_DUPLICATE', path: `[${index}].artifact_kind` });
    }
    if (byId.has(artifact.id)) errors.push({ code: 'PIPELINE_ARTIFACT_ID_DUPLICATE', path: `[${index}].id` });
    byKind.set(artifact.artifact_kind, artifact);
    byId.set(artifact.id, artifact);
  }
  for (const kind of ARTIFACT_KINDS) {
    if (!byKind.has(kind)) errors.push({ code: 'PIPELINE_ARTIFACT_MISSING', path: kind });
  }
  if (errors.length) return { valid: false, errors };

  const ordered = ARTIFACT_KINDS.map((kind) => byKind.get(kind));
  const expectedUserId = ordered[0].user_id;
  const expectedDecisionId = ordered[0].decision_id;
  if (!expectedDecisionId) errors.push({ code: 'PIPELINE_DECISION_LINK_REQUIRED', path: 'evidence_snapshot.decision_id' });
  for (const artifact of ordered) {
    if (artifact.user_id !== expectedUserId) {
      errors.push({ code: 'PIPELINE_OWNER_MISMATCH', path: `${artifact.artifact_kind}.user_id` });
    }
    if (artifact.decision_id !== expectedDecisionId) {
      errors.push({ code: 'PIPELINE_DECISION_MISMATCH', path: `${artifact.artifact_kind}.decision_id` });
    }
  }
  if (ordered[0].parent_artifact_id != null) {
    errors.push({ code: 'PIPELINE_ROOT_PARENT_INVALID', path: 'evidence_snapshot.parent_artifact_id' });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].parent_artifact_id !== ordered[index - 1].id) {
      errors.push({ code: 'PIPELINE_PARENT_MISMATCH', path: `${ordered[index].artifact_kind}.parent_artifact_id` });
    }
  }
  const candidateArtifacts = ordered.slice(3);
  const candidateId = candidateArtifacts[0].plan_generation_candidate_id;
  if (!candidateId) errors.push({ code: 'PIPELINE_CANDIDATE_LINK_REQUIRED', path: 'candidate_week.plan_generation_candidate_id' });
  for (const artifact of candidateArtifacts) {
    if (artifact.plan_generation_candidate_id !== candidateId) {
      errors.push({ code: 'PIPELINE_CANDIDATE_MISMATCH', path: `${artifact.artifact_kind}.plan_generation_candidate_id` });
    }
  }
  return { valid: errors.length === 0, errors };
}

function assertPipelineLinks(artifacts) {
  const result = validatePipelineLinks(artifacts);
  if (!result.valid) {
    const error = new Error(`Pipeline links failed validation: ${result.errors[0].code}`);
    error.code = 'INVALID_PIPELINE_LINKS';
    error.status = 422;
    error.details = result.errors;
    throw error;
  }
  return artifacts;
}

module.exports = {
  ARTIFACT_KINDS,
  ATHLETE_STATE_SCHEMA_VERSION,
  CANONICAL_UNITS,
  CANONICAL_EXPORT_CAPABILITIES,
  CANONICAL_SESSION_ROLES,
  CANONICAL_STEP_TYPES,
  CANONICAL_TARGET_FIELDS,
  CANONICAL_WORKOUT_FAMILIES,
  CANONICAL_WORKOUT_UNITS,
  CANONICAL_WORKOUT_SCHEMA_VERSION,
  CLOSED_UNIONS,
  CONFIDENCE_CLASSES,
  CONSISTENCY_STATES,
  CONSTRAINT_KINDS,
  CONTRACT_VERSIONS,
  EVENT_POLICY_REGISTRY_VERSION,
  EVENT_STATES,
  EVIDENCE_FRESHNESS_CLASSES,
  EVIDENCE_QUALITY_STATES,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SOURCE_SYSTEMS,
  EVIDENCE_VALUE_STATES,
  FEASIBILITY_STATUSES,
  FEATURE_MODES,
  GOAL_PRIORITIES,
  GOAL_TYPES,
  HYROX_RULESET_ID,
  HYROX_RULESET_VERSION,
  MAX_PIPELINE_ARTIFACT_BYTES,
  PLANNING_DECISION_SCHEMA_VERSION,
  PLANNING_PHASES,
  PLANNING_POLICY_VERSION,
  RECENT_NORMAL_STATUSES,
  RECOVERY_STATES,
  REDACTION_KEYS,
  REASON_CODE_FAMILIES,
  REASON_CODE_MIGRATION_ALIASES,
  REQUIRED_REASON_CODES,
  SAFETY_ACTIONS,
  STRESS_TAXONOMY_VERSION,
  TARGET_CONVERSION_REGISTRY_VERSION,
  TARGET_POLICY_VERSION,
  TRAINING_AGE_CLASSES,
  TRUTH_CLASSES,
  assertPipelineArtifact,
  assertPipelineLinks,
  findRedactionViolations,
  findNonJsonValues,
  isRedactionKey,
  normalizeReasonCode,
  validatePipelineArtifact,
  validatePipelineLinks,
  VERSION_CONSTANTS: CONTRACT_VERSIONS,
  PIPELINE_ARTIFACT_KINDS: ARTIFACT_KINDS,
  REASON_CODES: REQUIRED_REASON_CODES,
};
