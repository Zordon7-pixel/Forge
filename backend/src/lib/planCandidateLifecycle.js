const { RACE_PLAN_POLICY_V1, canonicalHash, canonicalStringify } = require('./racePlanPolicy');
const {
  ARTIFACT_KINDS,
  FEATURE_MODES,
  PLANNING_POLICY_VERSION,
  assertPipelineArtifact,
  assertPipelineLinks,
  findNonJsonValues,
  findRedactionViolations,
} = require('./goalBackwardContracts');

const HASH_PREFIX = 'sha256:';

// Keep this legacy snapshot allowlist stable: v2.4 artifacts use the stricter
// contract redaction validator without changing mode-off candidate bytes.
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

const ALLOWED_LIFE_FLAGS = new Set([
  'all_good',
  'injured',
  'long_shift',
  'not_well',
  'sick',
  'sore',
  'stressed',
  'traveling',
]);
const GOAL_BACKWARD_FEATURE_MODES = new Set(FEATURE_MODES);
const HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const MAX_BINDING_JSON_BYTES = 16 * 1024;
const ADDITIONAL_PII_KEYS = new Set([
  'account_number',
  'bank_account',
  'bank_account_number',
  'billing_address',
  'card_number',
  'credit_card',
  'credit_card_number',
  'driver_license',
  'drivers_license',
  'emergency_contact',
  'financial_account',
  'government_id',
  'home_address',
  'iban',
  'insurance_id',
  'mailing_address',
  'medical_record_number',
  'national_id',
  'passport',
  'passport_number',
  'residential_address',
  'routing_number',
  'social_security',
  'social_security_number',
  'ssn',
  'street_address',
  'swift',
  'tax_id',
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedArtifactKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function findAdditionalPiiViolations(value, path = 'payload_json', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findAdditionalPiiViolations(entry, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (ADDITIONAL_PII_KEYS.has(normalizedArtifactKey(key))) found.push(childPath);
    findAdditionalPiiViolations(nested, childPath, found);
  }
  return found;
}

function findArtifactRedactionViolations(value, path = 'payload_json') {
  return [...new Set([
    ...findRedactionViolations(value, path),
    ...findAdditionalPiiViolations(value, path),
  ])].sort();
}

function assertArtifactPayloadRedacted(payload, path = 'payload_json') {
  const violations = findArtifactRedactionViolations(payload, path);
  if (violations.length) {
    const error = new Error('Pipeline artifact contains a prohibited secret or PII key');
    error.code = 'INVALID_PIPELINE_ARTIFACT';
    error.status = 422;
    error.details = [{ code: 'ARTIFACT_REDACTION_REQUIRED', path: violations[0], paths: violations }];
    throw error;
  }
  return payload;
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

function normalizeCheckin(checkin) {
  if (!checkin || typeof checkin !== 'object' || Array.isArray(checkin)) return null;
  const finiteNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(checkin.date || '')) ? checkin.date : null,
    drive: finiteNumber(checkin.drive),
    feeling: finiteNumber(checkin.feeling),
    legs: finiteNumber(checkin.legs),
    lifeFlags: [...new Set((Array.isArray(checkin.lifeFlags) ? checkin.lifeFlags : [])
      .map((flag) => String(flag || '').trim().toLowerCase())
      .filter((flag) => ALLOWED_LIFE_FLAGS.has(flag)))].sort(),
    sleepHours: finiteNumber(checkin.sleepHours),
    timeAvailable: finiteNumber(checkin.timeAvailable),
  };
}

function normalizeContext(context = {}) {
  return redactSnapshotValue({
    checkin: normalizeCheckin(context.checkin),
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

function buildPipelineArtifact({
  id = null,
  userId,
  kind,
  decisionId = null,
  parentArtifactId = null,
  planGenerationCandidateId = null,
  schemaVersion = 1,
  policyVersion = PLANNING_POLICY_VERSION,
  revision = 1,
  payload,
  createdAt = new Date().toISOString(),
} = {}) {
  const payloadJson = cloneJson(payload || {});
  assertArtifactPayloadRedacted(payloadJson);
  const contentHash = prefixedHash(payloadJson);
  const artifactIdentityHash = canonicalHash({
    user_id: userId,
    artifact_kind: kind,
    decision_id: decisionId,
    revision,
    content_hash: contentHash,
  });
  const artifact = {
    id: id || `artifact-${String(kind || 'unknown')}-${artifactIdentityHash.slice(0, 24)}`,
    user_id: String(userId || ''),
    artifact_kind: kind,
    decision_id: decisionId,
    parent_artifact_id: parentArtifactId,
    plan_generation_candidate_id: planGenerationCandidateId,
    schema_version: schemaVersion,
    policy_version: policyVersion,
    revision,
    content_hash: contentHash,
    payload_json: payloadJson,
    created_at: new Date(createdAt).toISOString(),
  };
  return assertPipelineArtifact(artifact);
}

async function persistPipelineArtifacts({ tx, artifacts, requireCompleteLinks = false } = {}) {
  if (!tx || typeof tx.run !== 'function') throw new Error('persistPipelineArtifacts requires a transaction');
  const rows = Array.isArray(artifacts) ? artifacts : Object.values(artifacts || {});
  if (!rows.length) return { inserted: 0, artifact_ids: [] };
  if (requireCompleteLinks) assertPipelineLinks(rows);
  else rows.forEach((artifact) => {
    assertArtifactPayloadRedacted(artifact.payload_json);
    assertPipelineArtifact(artifact);
  });
  if (requireCompleteLinks) rows.forEach((artifact) => assertArtifactPayloadRedacted(artifact.payload_json));
  let inserted = 0;
  for (const artifact of rows) {
    const result = await tx.run(
      `INSERT INTO planning_pipeline_artifacts (
         id, user_id, artifact_kind, decision_id, parent_artifact_id,
         plan_generation_candidate_id, schema_version, policy_version,
         revision, content_hash, payload_json, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
      [
        artifact.id,
        artifact.user_id,
        artifact.artifact_kind,
        artifact.decision_id,
        artifact.parent_artifact_id,
        artifact.plan_generation_candidate_id,
        String(artifact.schema_version),
        String(artifact.policy_version),
        artifact.revision,
        artifact.content_hash,
        JSON.stringify(artifact.payload_json),
        artifact.created_at,
      ]
    );
    inserted += Number(result?.changes || 0);
  }
  return { inserted, artifact_ids: rows.map((artifact) => artifact.id) };
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

function bindingValue(input, camelKey, snakeKey) {
  return input[camelKey] ?? input[snakeKey];
}

function positiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function nonNegativeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedIdentifier(value) {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  return value.length >= 1 && value.length <= 200 ? value : null;
}

function normalizeGoalRevisions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) return null;
    const goalId = boundedIdentifier(key);
    const revision = positiveRevision(value[key]);
    if (!goalId || revision === null) return null;
    normalized[goalId] = revision;
  }
  if (jsonBytes(normalized) > MAX_BINDING_JSON_BYTES) return null;
  return normalized;
}

function normalizeMaterialChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (findNonJsonValues(value, 'material_change_json').length) return null;
  if (findRedactionViolations(value, 'material_change_json').length) return null;
  try {
    if (jsonBytes(value) > MAX_BINDING_JSON_BYTES) return null;
    return cloneJson(value);
  } catch (_error) {
    return null;
  }
}

function buildGoalBackwardCandidateBindings(input = {}) {
  const errors = [];
  const decisionId = boundedIdentifier(bindingValue(input, 'decisionId', 'decision_id'));
  if (!decisionId) errors.push({ code: 'DECISION_ID_INVALID', path: 'decision_id' });

  const revisions = {};
  for (const [camelKey, snakeKey, minimum] of [
    ['candidateRevision', 'candidate_revision', 1],
    ['athleteStateRevision', 'athlete_state_revision', 1],
    ['lockRevision', 'lock_revision', 0],
    ['editRevision', 'edit_revision', 0],
    ['surfaceRevision', 'surface_revision', 1],
    ['exportRevision', 'export_revision', 1],
  ]) {
    const value = bindingValue(input, camelKey, snakeKey);
    revisions[snakeKey] = minimum === 0 ? nonNegativeRevision(value) : positiveRevision(value);
    if (revisions[snakeKey] === null) errors.push({ code: 'REVISION_INVALID', path: snakeKey });
  }

  const safetyStateHash = String(bindingValue(input, 'safetyStateHash', 'safety_state_hash') || '');
  if (!HASH_PATTERN.test(safetyStateHash)) errors.push({ code: 'HASH_INVALID', path: 'safety_state_hash' });
  const selectedCandidateHash = String(bindingValue(input, 'selectedCandidateHash', 'selected_candidate_hash') || '');
  if (!HASH_PATTERN.test(selectedCandidateHash)) errors.push({ code: 'HASH_INVALID', path: 'selected_candidate_hash' });

  const goalRevisions = normalizeGoalRevisions(bindingValue(input, 'goalRevisions', 'goal_revisions_json'));
  if (!goalRevisions) errors.push({ code: 'GOAL_REVISIONS_INVALID', path: 'goal_revisions_json' });
  const materialChange = normalizeMaterialChange(bindingValue(input, 'materialChange', 'material_change_json'));
  if (!materialChange) errors.push({ code: 'MATERIAL_CHANGE_INVALID', path: 'material_change_json' });

  const featureMode = bindingValue(input, 'featureMode', 'feature_mode');
  if (!GOAL_BACKWARD_FEATURE_MODES.has(featureMode)) errors.push({ code: 'FEATURE_MODE_INVALID', path: 'feature_mode' });

  if (errors.length) {
    const error = new Error(`Goal-backward candidate bindings failed validation: ${errors[0].code}`);
    error.code = 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INVALID';
    error.status = 422;
    error.details = errors;
    throw error;
  }

  return {
    decision_id: decisionId,
    candidate_revision: revisions.candidate_revision,
    athlete_state_revision: revisions.athlete_state_revision,
    safety_state_hash: safetyStateHash,
    goal_revisions_json: goalRevisions,
    lock_revision: revisions.lock_revision,
    edit_revision: revisions.edit_revision,
    surface_revision: revisions.surface_revision,
    export_revision: revisions.export_revision,
    feature_mode: featureMode,
    selected_candidate_hash: selectedCandidateHash,
    material_change_json: materialChange,
  };
}

const GOAL_BACKWARD_BINDING_COLUMNS = Object.freeze([
  'decision_id',
  'candidate_revision',
  'athlete_state_revision',
  'safety_state_hash',
  'goal_revisions_json',
  'lock_revision',
  'edit_revision',
  'surface_revision',
  'export_revision',
  'feature_mode',
  'selected_candidate_hash',
  'material_change_json',
]);

function goalBackwardBindingSignalPresent(row = {}) {
  return GOAL_BACKWARD_BINDING_COLUMNS.some((column) => row[column] !== null && row[column] !== undefined);
}

function storedBindingJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function validateStoredGoalBackwardCandidateBindings(row = {}, { allowedModes = ['shadow'] } = {}) {
  if (!goalBackwardBindingSignalPresent(row)) return { present: false, bindings: null };
  let bindings;
  try {
    bindings = buildGoalBackwardCandidateBindings({
      ...row,
      goal_revisions_json: storedBindingJson(row.goal_revisions_json),
      material_change_json: storedBindingJson(row.material_change_json),
    });
  } catch (cause) {
    const error = new Error('Stored v2.4 candidate bindings are incomplete');
    error.code = 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INCOMPLETE';
    error.status = 409;
    error.details = cause?.details || null;
    throw error;
  }
  if (!allowedModes.includes(bindings.feature_mode)) {
    const error = new Error('This v2.4 mode is not operationally available');
    error.code = 'GOAL_BACKWARD_MODE_UNAVAILABLE';
    error.status = 409;
    error.details = { feature_mode: bindings.feature_mode };
    throw error;
  }
  return { present: true, bindings };
}

function buildGoalBackwardShadowBindings({ decision, selectedCandidate = null, currentCandidateHash } = {}) {
  const goalRevisions = Object.fromEntries((decision?.active_goals || []).map((goal) => [
    String(goal.goal_id),
    Math.max(1, Number(goal.source_revision || 1)),
  ]));
  return buildGoalBackwardCandidateBindings({
    decisionId: decision?.decision_id,
    candidateRevision: 1,
    athleteStateRevision: Math.max(1, Number(decision?.athlete_state_revision || 1)),
    safetyStateHash: prefixedHash(decision?.safety_state || {}),
    goalRevisions,
    lockRevision: Math.max(0, Number(decision?.lock_revision || 0)),
    editRevision: Math.max(0, Number(decision?.edit_revision || 0)),
    surfaceRevision: 1,
    exportRevision: 1,
    featureMode: 'shadow',
    selectedCandidateHash: selectedCandidate?.candidate_hash || currentCandidateHash,
    materialChange: selectedCandidate?.material_change || { required: false, reason_codes: [] },
  });
}

function buildGoalBackwardDecisionArtifacts({
  userId,
  planGenerationCandidateId,
  currentCandidateHash,
  decision,
  athleteState = {},
  candidates = [],
  createdAt = new Date().toISOString(),
} = {}) {
  if (!decision?.decision_id || !planGenerationCandidateId) {
    throw new Error('decision and plan-generation candidate links are required');
  }
  const selected = candidates.find((candidate) => candidate.candidate_skeleton_id === decision.selected_candidate_id) || null;
  const planGenerationCandidateRef = prefixedHash(planGenerationCandidateId);
  const candidateSummaries = candidates.map((candidate) => ({
    candidate_id: candidate.candidate_skeleton_id,
    candidate_hash: candidate.candidate_hash,
    valid: candidate.validation?.valid === true,
    reason_codes: candidate.validation?.reason_codes || [],
    ranking_tuple: candidate.ranking_tuple || null,
  }));
  const payloads = {
    evidence_snapshot: {
      evidence_snapshot_id: decision.evidence_snapshot_id || null,
      planning_date_local: decision.planning_date_local,
      source: 'REDACTED_SHADOW_INPUT',
    },
    athlete_state: {
      athlete_state_revision: Math.max(1, Number(decision.athlete_state_revision || athleteState.athlete_state_revision || 1)),
      recovery_state: decision.recovery_state || athleteState.recovery_state || 'UNKNOWN',
      safety_state_hash: prefixedHash(decision.safety_state || { action: athleteState.safety_action || 'NORMAL' }),
    },
    planning_decision: {
      decision_id: decision.decision_id,
      decision_hash: decision.decision_hash,
      planning_date_local: decision.planning_date_local,
      phase: decision.phase,
      candidate_ids: decision.candidate_ids || [],
      selected_candidate_id: decision.selected_candidate_id || null,
      selected_candidate_hash: decision.selected_candidate_hash || null,
      selected_candidate_ranking_tuple: decision.selected_candidate_ranking_tuple || null,
      rejected_candidates: decision.rejected_candidates || [],
      candidate_enumeration: decision.candidate_enumeration || {},
    },
    candidate_week: {
      plan_generation_candidate_ref: planGenerationCandidateRef,
      current_candidate_hash: currentCandidateHash,
      authoritative_engine: 'current',
      candidates: candidateSummaries,
    },
    validator_result: {
      plan_generation_candidate_ref: planGenerationCandidateRef,
      results: decision.validator_results || [],
    },
    canonical_session_set: {
      plan_generation_candidate_ref: planGenerationCandidateRef,
      canonical_sessions_materialized: false,
      selected_candidate_id: selected?.candidate_skeleton_id || null,
      selected_candidate_hash: selected?.candidate_hash || null,
    },
    surface_manifest: {
      plan_generation_candidate_ref: planGenerationCandidateRef,
      feature_mode: 'shadow',
      authoritative_engine: 'current',
      current_candidate_hash: currentCandidateHash,
      v24_surface_enabled: false,
    },
  };
  let parentArtifactId = null;
  const artifacts = ARTIFACT_KINDS.map((kind, index) => {
    const artifact = buildPipelineArtifact({
      userId,
      kind,
      decisionId: decision.decision_id,
      parentArtifactId,
      planGenerationCandidateId: index >= 3 ? planGenerationCandidateId : null,
      payload: payloads[kind],
      createdAt,
    });
    parentArtifactId = artifact.id;
    return artifact;
  });
  return assertPipelineLinks(artifacts);
}

async function persistGoalBackwardDecisionArtifacts(input = {}) {
  const artifacts = input.artifacts || buildGoalBackwardDecisionArtifacts(input);
  return persistPipelineArtifacts({ tx: input.tx, artifacts, requireCompleteLinks: true });
}

function validateGoalBackwardCandidateBundle({ artifacts = null, bindings, ...candidateBundle }) {
  const normalized = {
    ...validateCandidateBundle(candidateBundle),
    bindings: buildGoalBackwardCandidateBindings(bindings),
  };
  if (artifacts !== null) {
    const rows = Array.isArray(artifacts) ? artifacts : Object.values(artifacts || {});
    rows.forEach((artifact) => assertArtifactPayloadRedacted(artifact.payload_json));
    normalized.artifacts = assertPipelineLinks(artifacts);
  }
  return normalized;
}

function buildGoalBackwardCandidateBundle(input) {
  return validateGoalBackwardCandidateBundle(input);
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
  ALLOWED_LIFE_FLAGS,
  HASH_PREFIX,
  assertBoundedJson,
  assertPersistablePlan,
  buildPipelineArtifact,
  buildGoalBackwardDecisionArtifacts,
  buildGoalBackwardShadowBindings,
  buildPlanningSnapshot,
  buildGoalBackwardCandidateBundle,
  buildGoalBackwardCandidateBindings,
  findArtifactRedactionViolations,
  jsonBytes,
  normalizeContext,
  normalizeCheckin,
  parseJson,
  prefixedHash,
  persistPipelineArtifacts,
  persistGoalBackwardDecisionArtifacts,
  redactSnapshotValue,
  validateCandidateBundle,
  validateGoalBackwardCandidateBundle,
  validateStoredGoalBackwardCandidateBindings,
  validatePlanStructure,
};
