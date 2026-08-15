const { RACE_PLAN_POLICY_V1, canonicalHash, canonicalStringify } = require('./racePlanPolicy');
const {
  ARTIFACT_KINDS,
  FEATURE_MODES,
  PLANNING_POLICY_VERSION,
  assertPipelineArtifact,
  assertPipelineLinks,
  findNonJsonValues,
  findRedactionViolations,
  normalizeReasonCode,
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

function normalizeHash(value, { requirePrefix = false } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) return null;
  if (requirePrefix && !normalized.startsWith(HASH_PREFIX)) return null;
  return normalized;
}

function hashIdentity(value) {
  const normalized = normalizeHash(value);
  return normalized ? normalized.replace(/^sha256:/, '') : null;
}

function normalizePlanningTimezone(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch (_error) {
    return null;
  }
}

function goalFingerprintRows(decision = {}) {
  return (Array.isArray(decision.active_goals) ? decision.active_goals : []).map((goal) => ({
    goal_id: String(goal.goal_id || ''),
    race_id: goal.race_id === null || goal.race_id === undefined ? null : String(goal.race_id),
    revision: Math.max(1, Number(goal.source_revision || 1)),
    event_local_date: goal.event_local_date || null,
    event_state: goal.event_state || 'UNKNOWN',
    priority: goal.priority || 'UNSPECIFIED',
  }));
}

function buildGoalBackwardFingerprintBindings(decision = {}, { decisionArtifact = null } = {}) {
  const goals = goalFingerprintRows(decision);
  const goalFingerprint = prefixedHash(goals);
  const constraintFingerprint = normalizeHash(decision.constraint_fingerprint)
    || prefixedHash({
      athlete_id: decision.athlete_id || null,
      plan_id: decision.plan_id || null,
      lock_revision: Math.max(0, Number(decision.lock_revision || 0)),
      edit_revision: Math.max(0, Number(decision.edit_revision || 0)),
      athlete_locks: decision.athlete_locks || [],
      manual_edits: decision.manual_edits || [],
    });
  const evidenceFingerprint = prefixedHash({
    evidence_snapshot_id: decision.evidence_snapshot_id || null,
    evidence_used: decision.evidence_used || [],
    stale_evidence: decision.stale_evidence || [],
    conflicting_evidence: decision.conflicting_evidence || [],
    athlete_state_revision: Math.max(1, Number(decision.athlete_state_revision || 1)),
    safety_state: decision.safety_state || {},
  });
  const policyFingerprint = prefixedHash({
    policy_versions: decision.policy_versions || {},
    event_policy_id: decision.event_policy_id || null,
    goal_fingerprint: goalFingerprint,
  });
  return Object.freeze({
    decision_hash: normalizeHash(decision.decision_hash),
    decision_artifact: decisionArtifact ? Object.freeze({
      artifact_id: boundedIdentifier(String(decisionArtifact.id || decisionArtifact.artifact_id || '')),
      revision: positiveRevision(Number(decisionArtifact.revision)),
      content_hash: normalizeHash(decisionArtifact.content_hash, { requirePrefix: true }),
    }) : null,
    planning_timezone: normalizePlanningTimezone(decision.timezone) || 'UTC',
    evidence_fingerprint: evidenceFingerprint,
    constraint_fingerprint: constraintFingerprint,
    goal_fingerprint: goalFingerprint,
    policy_fingerprint: policyFingerprint,
  });
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

function buildGoalBackwardShadowBindings({
  decision,
  decisionArtifact = null,
  selectedCandidate = null,
  currentCandidateHash,
} = {}) {
  const goalRevisions = Object.fromEntries((decision?.active_goals || []).map((goal) => [
    String(goal.goal_id),
    Math.max(1, Number(goal.source_revision || 1)),
  ]));
  const materialChange = selectedCandidate?.material_change || { required: false, reason_codes: [] };
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
    materialChange: {
      ...cloneJson(materialChange),
      apply_bindings: buildGoalBackwardFingerprintBindings(decision, { decisionArtifact }),
    },
  });
}

function buildGoalBackwardApplyEnvelope(row = {}) {
  const bindings = buildGoalBackwardCandidateBindings({
    ...row,
    goal_revisions_json: storedBindingJson(row.goal_revisions_json),
    material_change_json: storedBindingJson(row.material_change_json),
  });
  const applyBindings = bindings.material_change_json?.apply_bindings;
  if (!applyBindings || typeof applyBindings !== 'object' || Array.isArray(applyBindings)) {
    const error = new Error('Stored v2.4 apply bindings are incomplete');
    error.code = 'GOAL_BACKWARD_APPLY_BINDINGS_INCOMPLETE';
    error.status = 409;
    throw error;
  }
  const decisionHash = normalizeHash(applyBindings.decision_hash);
  const decisionArtifact = applyBindings.decision_artifact;
  const planningTimezone = normalizePlanningTimezone(applyBindings.planning_timezone);
  const evidenceFingerprint = normalizeHash(applyBindings.evidence_fingerprint, { requirePrefix: true });
  const constraintFingerprint = normalizeHash(applyBindings.constraint_fingerprint, { requirePrefix: true });
  const goalFingerprint = normalizeHash(applyBindings.goal_fingerprint, { requirePrefix: true });
  const policyFingerprint = normalizeHash(applyBindings.policy_fingerprint, { requirePrefix: true });
  if (!decisionHash || !decisionArtifact || !boundedIdentifier(String(decisionArtifact.artifact_id || ''))
    || !positiveRevision(Number(decisionArtifact.revision))
    || !normalizeHash(decisionArtifact.content_hash, { requirePrefix: true })
    || !planningTimezone || !evidenceFingerprint || !constraintFingerprint
    || !goalFingerprint || !policyFingerprint) {
    const error = new Error('Stored v2.4 apply fingerprint is incomplete');
    error.code = 'GOAL_BACKWARD_APPLY_BINDINGS_INCOMPLETE';
    error.status = 409;
    throw error;
  }
  if (['preview', 'on'].includes(bindings.feature_mode)
    && hashIdentity(row.candidate_hash) !== hashIdentity(bindings.selected_candidate_hash)) {
    const error = new Error('Stored selected candidate hash does not match the applicable plan');
    error.code = 'SELECTED_CANDIDATE_CHANGED';
    error.status = 409;
    throw error;
  }
  return Object.freeze({
    candidate_id: boundedIdentifier(String(row.id || '')),
    candidate_hash: normalizeHash(row.candidate_hash, { requirePrefix: true }),
    candidate_revision: bindings.candidate_revision,
    decision_id: bindings.decision_id,
    decision_hash: decisionHash,
    decision_artifact: Object.freeze({
      artifact_id: String(decisionArtifact.artifact_id),
      revision: Number(decisionArtifact.revision),
      content_hash: normalizeHash(decisionArtifact.content_hash, { requirePrefix: true }),
    }),
    active_plan: Object.freeze({
      training_plan_id: row.training_plan_id ?? null,
      user_plan_id: row.user_plan_id ?? null,
      plan_revision: row.active_plan_version === null || row.active_plan_version === undefined
        ? null : Number(row.active_plan_version),
    }),
    planning_input_revision: Number(row.planning_input_revision),
    planning_date_local: isIsoDate(row.planning_date_local) ? row.planning_date_local : null,
    planning_timezone: planningTimezone,
    timezone_offset_minutes: Number(row.timezone_offset_minutes),
    goal_revisions: Object.freeze(bindings.goal_revisions_json),
    goal_fingerprint: goalFingerprint,
    athlete_state_revision: bindings.athlete_state_revision,
    safety_state_hash: normalizeHash(bindings.safety_state_hash),
    evidence_fingerprint: evidenceFingerprint,
    constraint_fingerprint: constraintFingerprint,
    policy_fingerprint: policyFingerprint,
    lock_revision: bindings.lock_revision,
    edit_revision: bindings.edit_revision,
    surface_revision: bindings.surface_revision,
    export_revision: bindings.export_revision,
  });
}

function goalBackwardApplyEnvelopeFromRequest(body = {}, candidateId = null) {
  const activePlan = body.active_plan && typeof body.active_plan === 'object' ? body.active_plan : {};
  return {
    candidate_id: candidateId || body.candidate_id,
    candidate_hash: body.candidate_hash,
    candidate_revision: body.candidate_revision,
    decision_id: body.decision_id,
    decision_hash: body.decision_hash,
    decision_artifact: body.decision_artifact,
    active_plan: {
      training_plan_id: activePlan.training_plan_id ?? body.active_training_plan_id ?? null,
      user_plan_id: activePlan.user_plan_id ?? body.active_user_plan_id ?? null,
      plan_revision: activePlan.plan_revision ?? body.active_plan_revision ?? null,
    },
    planning_input_revision: body.planning_input_revision,
    planning_date_local: body.planning_date_local,
    planning_timezone: body.planning_timezone,
    timezone_offset_minutes: body.timezone_offset_minutes,
    goal_revisions: body.goal_revisions ?? body.goal_revisions_json,
    goal_fingerprint: body.goal_fingerprint,
    athlete_state_revision: body.athlete_state_revision,
    safety_state_hash: body.safety_state_hash,
    evidence_fingerprint: body.evidence_fingerprint,
    constraint_fingerprint: body.constraint_fingerprint,
    policy_fingerprint: body.policy_fingerprint,
    lock_revision: body.lock_revision,
    edit_revision: body.edit_revision,
    surface_revision: body.surface_revision,
    export_revision: body.export_revision,
  };
}

function sameCanonicalValue(left, right) {
  try {
    return canonicalStringify(left) === canonicalStringify(right);
  } catch (_error) {
    return false;
  }
}

function validateGoalBackwardApplyEnvelope(expected = {}, actual = {}) {
  const checks = [
    ['candidate_id', 'CANDIDATE_BINDING_CHANGED'],
    ['candidate_hash', 'CANDIDATE_HASH_MISMATCH'],
    ['candidate_revision', 'CANDIDATE_REVISION_CHANGED'],
    ['decision_id', 'DECISION_BINDING_CHANGED'],
    ['decision_hash', 'DECISION_BINDING_CHANGED'],
    ['decision_artifact', 'DECISION_ARTIFACT_CHANGED'],
    ['active_plan', 'ACTIVE_PLAN_REVISION_CHANGED'],
    ['planning_input_revision', 'PLANNING_INPUT_REVISION_CHANGED'],
    ['planning_date_local', 'PLANNING_CLOCK_CHANGED'],
    ['planning_timezone', 'PLANNING_CLOCK_CHANGED'],
    ['timezone_offset_minutes', 'PLANNING_CLOCK_CHANGED'],
    ['goal_revisions', 'RACE_REVISION_CHANGED'],
    ['goal_fingerprint', 'RACE_REVISION_CHANGED'],
    ['athlete_state_revision', 'ATHLETE_STATE_REVISION_CHANGED'],
    ['safety_state_hash', 'SAFETY_STATE_CHANGED'],
    ['evidence_fingerprint', 'EVIDENCE_REVISION_CHANGED'],
    ['constraint_fingerprint', 'CONSTRAINT_REVISION_CHANGED'],
    ['policy_fingerprint', 'POLICY_VERSION_CHANGED'],
    ['lock_revision', 'LOCK_REVISION_CHANGED'],
    ['edit_revision', 'EDIT_REVISION_CHANGED'],
    ['surface_revision', 'SURFACE_REVISION_CHANGED'],
    ['export_revision', 'EXPORT_REVISION_CHANGED'],
  ];
  for (const [key, code] of checks) {
    if (!sameCanonicalValue(expected[key], actual[key])) return { valid: false, code };
  }
  return { valid: true, code: null };
}

function buildCandidateRejectionRecord(input = {}) {
  const userId = boundedIdentifier(String(input.userId ?? input.user_id ?? ''));
  const candidateHash = normalizeHash(input.candidateHash ?? input.candidate_hash);
  const decisionId = boundedIdentifier(String(input.decisionId ?? input.decision_id ?? ''));
  const decisionHash = normalizeHash(input.decisionHash ?? input.decision_hash);
  const evidenceFingerprint = normalizeHash(input.evidenceFingerprint ?? input.evidence_fingerprint, { requirePrefix: true });
  const constraintFingerprint = normalizeHash(input.constraintFingerprint ?? input.constraint_fingerprint, { requirePrefix: true });
  const policyFingerprint = normalizeHash(input.policyFingerprint ?? input.policy_fingerprint, { requirePrefix: true });
  const suppliedReason = input.reasonCode ?? input.reason_code ?? null;
  const reasonCode = suppliedReason === null || suppliedReason === '' ? null : normalizeReasonCode(suppliedReason);
  const createdAt = new Date(input.createdAt ?? input.created_at ?? new Date().toISOString());
  if (!userId || !candidateHash || !decisionId || !decisionHash || !evidenceFingerprint
    || !constraintFingerprint || !policyFingerprint || (suppliedReason && !reasonCode)
    || Number.isNaN(createdAt.getTime())) {
    const error = new Error('Candidate rejection fingerprint is invalid');
    error.code = 'CANDIDATE_REJECTION_INVALID';
    error.status = 422;
    throw error;
  }
  const identity = canonicalHash({
    user_id: userId,
    candidate_hash: candidateHash,
    evidence_fingerprint: evidenceFingerprint,
    constraint_fingerprint: constraintFingerprint,
    policy_fingerprint: policyFingerprint,
  });
  return Object.freeze({
    id: input.id || `candidate-rejection-${identity.slice(0, 24)}`,
    user_id: userId,
    candidate_hash: candidateHash,
    decision_id: decisionId,
    decision_hash: decisionHash,
    reason_code: reasonCode,
    evidence_fingerprint: evidenceFingerprint,
    constraint_fingerprint: constraintFingerprint,
    policy_fingerprint: policyFingerprint,
    created_at: createdAt.toISOString(),
  });
}

function candidateRejectionMatches(rejection = {}, current = {}) {
  return hashIdentity(rejection.candidate_hash) === hashIdentity(current.candidate_hash)
    && rejection.evidence_fingerprint === current.evidence_fingerprint
    && rejection.constraint_fingerprint === current.constraint_fingerprint
    && rejection.policy_fingerprint === current.policy_fingerprint;
}

async function persistCandidateRejection({ tx, rejection } = {}) {
  if (!tx || typeof tx.run !== 'function') throw new Error('persistCandidateRejection requires a transaction');
  const row = buildCandidateRejectionRecord(rejection);
  const result = await tx.run(
    `INSERT INTO plan_candidate_rejections (
       id, user_id, candidate_hash, decision_id, decision_hash, reason_code,
       evidence_fingerprint, constraint_fingerprint, policy_fingerprint, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, candidate_hash, evidence_fingerprint, constraint_fingerprint, policy_fingerprint)
     DO NOTHING`,
    [
      row.id, row.user_id, row.candidate_hash, row.decision_id, row.decision_hash, row.reason_code,
      row.evidence_fingerprint, row.constraint_fingerprint, row.policy_fingerprint, row.created_at,
    ],
  );
  return { inserted: Number(result?.changes || 0) > 0, rejection: row };
}

async function loadCandidateRejectionsForFingerprint({ tx, userId, fingerprint } = {}) {
  if (!tx || typeof tx.all !== 'function') throw new Error('Candidate rejection lookup requires a transaction');
  const ownerId = boundedIdentifier(String(userId || ''));
  const evidenceFingerprint = normalizeHash(fingerprint?.evidence_fingerprint, { requirePrefix: true });
  const constraintFingerprint = normalizeHash(fingerprint?.constraint_fingerprint, { requirePrefix: true });
  const policyFingerprint = normalizeHash(fingerprint?.policy_fingerprint, { requirePrefix: true });
  if (!ownerId || !evidenceFingerprint || !constraintFingerprint || !policyFingerprint) {
    throw new Error('Candidate rejection lookup fingerprint is invalid');
  }
  return tx.all(
    `SELECT * FROM plan_candidate_rejections
     WHERE user_id=? AND evidence_fingerprint=? AND constraint_fingerprint=? AND policy_fingerprint=?
     ORDER BY created_at ASC, id ASC`,
    [ownerId, evidenceFingerprint, constraintFingerprint, policyFingerprint],
  );
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

function planningConstraintPayload(row = {}) {
  const raw = row.attributed_payload_json ?? row.attributedPayload ?? row.payload ?? {};
  const payload = typeof raw === 'string' ? parseJson(raw, null) : raw;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || findNonJsonValues(payload, 'attributed_payload_json').length
    || findRedactionViolations(payload, 'attributed_payload_json').length
    || jsonBytes(payload) > MAX_BINDING_JSON_BYTES) {
    const error = new Error('Planning constraint payload is invalid');
    error.code = 'PLANNING_CONSTRAINT_INVALID';
    error.status = 422;
    throw error;
  }
  return cloneJson(payload);
}

function normalizedConstraintDate(row = {}, payload = {}) {
  const value = row.date_local ?? row.local_date ?? row.scheduled_local_date
    ?? payload.date_local ?? payload.local_date ?? payload.scheduled_local_date ?? payload.date;
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).slice(0, 10);
  if (!isIsoDate(normalized)) {
    const error = new Error('Planning constraint local date is invalid');
    error.code = 'PLANNING_CONSTRAINT_INVALID';
    error.status = 422;
    throw error;
  }
  return normalized;
}

function normalizePlanningConstraints(rows = [], { athleteId, planId = null } = {}) {
  const ownerId = String(athleteId || '').trim();
  if (!ownerId) {
    const error = new Error('Planning constraints require an athlete owner');
    error.code = 'PLANNING_CONSTRAINT_OWNER_REQUIRED';
    error.status = 422;
    throw error;
  }
  const normalizedPlanId = planId === null || planId === undefined ? null : String(planId);
  const latestByScope = new Map();
  let lockRevision = 0;
  let editRevision = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = String(row?.user_id ?? row?.athlete_id ?? row?.userId ?? '').trim();
    if (userId !== ownerId) {
      const error = new Error('Planning constraint is not athlete-owned');
      error.code = 'PLANNING_CONSTRAINT_OWNER_MISMATCH';
      error.status = 403;
      throw error;
    }
    const kind = String(row.constraint_kind ?? row.constraintKind ?? row.kind ?? '').toLowerCase();
    if (!['day_lock', 'session_lock', 'manual_edit'].includes(kind)) {
      const error = new Error('Planning constraint kind is invalid');
      error.code = 'PLANNING_CONSTRAINT_INVALID';
      error.status = 422;
      throw error;
    }
    const rowPlanId = row.plan_id ?? row.planId ?? null;
    if (normalizedPlanId && rowPlanId && String(rowPlanId) !== normalizedPlanId) continue;
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      const error = new Error('Planning constraint revision is invalid');
      error.code = 'PLANNING_CONSTRAINT_INVALID';
      error.status = 422;
      throw error;
    }
    const attributedBy = String(row.attributed_by_user_id ?? row.attributedByUserId ?? '').trim();
    if (attributedBy !== ownerId) {
      const error = new Error('Planning constraint attribution is not athlete-owned');
      error.code = 'PLANNING_CONSTRAINT_ATTRIBUTION_MISMATCH';
      error.status = 403;
      throw error;
    }
    const payload = planningConstraintPayload(row);
    const sessionId = String(row.session_id ?? row.sessionId ?? payload.session_id ?? payload.sessionId ?? '').trim() || null;
    const dateLocal = normalizedConstraintDate(row, payload);
    if (!rowPlanId && !sessionId && !dateLocal) {
      const error = new Error('Planning constraint scope is required');
      error.code = 'PLANNING_CONSTRAINT_INVALID';
      error.status = 422;
      throw error;
    }
    if (kind === 'day_lock' && !dateLocal) {
      const error = new Error('Day lock requires a local date');
      error.code = 'PLANNING_CONSTRAINT_INVALID';
      error.status = 422;
      throw error;
    }
    if (['session_lock', 'manual_edit'].includes(kind) && !sessionId) {
      const error = new Error('Session constraint requires a session identity');
      error.code = 'PLANNING_CONSTRAINT_INVALID';
      error.status = 422;
      throw error;
    }
    if (kind === 'manual_edit') editRevision = Math.max(editRevision, revision);
    else lockRevision = Math.max(lockRevision, revision);
    const scopeKey = [kind, rowPlanId || '', sessionId || '', dateLocal || ''].join(':');
    const previous = latestByScope.get(scopeKey);
    if (previous && previous.revision === revision && String(previous.id) !== String(row.id)) {
      const error = new Error('Planning constraint revision is ambiguous');
      error.code = 'PLANNING_CONSTRAINT_REVISION_CONFLICT';
      error.status = 409;
      throw error;
    }
    if (!previous || revision > previous.revision) {
      latestByScope.set(scopeKey, {
        ...payload,
        id: String(row.id || '').trim() || null,
        constraint_id: String(row.id || '').trim() || null,
        constraint_kind: kind,
        user_id: ownerId,
        owner: 'athlete',
        plan_id: rowPlanId === null || rowPlanId === undefined ? null : String(rowPlanId),
        session_id: sessionId,
        date_local: dateLocal,
        scheduled_local_date: dateLocal,
        revision,
        active: row.active !== false && row.active !== 0 && row.active !== 'false',
        supersedes_constraint_id: row.supersedes_constraint_id ?? row.supersedesConstraintId ?? null,
        attributed_by_user_id: ownerId,
        effective_at: row.effective_at ?? row.effectiveAt ?? null,
        created_at: row.created_at ?? row.createdAt ?? null,
        attribution: {
          actor_type: 'athlete',
          owner: 'athlete',
          attributed_by_user_id: ownerId,
        },
      });
    }
  }
  const authoritative = [...latestByScope.values()]
    .filter((constraint) => constraint.active)
    .sort((left, right) => (
      left.constraint_kind.localeCompare(right.constraint_kind)
      || String(left.date_local || '').localeCompare(String(right.date_local || ''))
      || String(left.session_id || '').localeCompare(String(right.session_id || ''))
      || left.revision - right.revision
    ));
  const locks = authoritative.filter((constraint) => constraint.constraint_kind !== 'manual_edit');
  const manualEdits = authoritative.filter((constraint) => constraint.constraint_kind === 'manual_edit');
  const fingerprint = prefixedHash({
    athlete_id: ownerId,
    plan_id: normalizedPlanId,
    lock_revision: lockRevision,
    edit_revision: editRevision,
    constraints: authoritative,
  });
  return Object.freeze({
    athlete_id: ownerId,
    plan_id: normalizedPlanId,
    locks: Object.freeze(locks.map(Object.freeze)),
    manual_edits: Object.freeze(manualEdits.map(Object.freeze)),
    lock_revision: lockRevision,
    edit_revision: editRevision,
    constraint_fingerprint: fingerprint,
  });
}

module.exports = {
  ALLOWED_LIFE_FLAGS,
  HASH_PREFIX,
  assertBoundedJson,
  assertPersistablePlan,
  buildCandidateRejectionRecord,
  buildPipelineArtifact,
  buildGoalBackwardApplyEnvelope,
  buildGoalBackwardDecisionArtifacts,
  buildGoalBackwardFingerprintBindings,
  buildGoalBackwardShadowBindings,
  buildPlanningSnapshot,
  buildGoalBackwardCandidateBundle,
  buildGoalBackwardCandidateBindings,
  candidateRejectionMatches,
  findArtifactRedactionViolations,
  goalBackwardApplyEnvelopeFromRequest,
  jsonBytes,
  loadCandidateRejectionsForFingerprint,
  normalizeContext,
  normalizeCheckin,
  normalizePlanningConstraints,
  parseJson,
  prefixedHash,
  persistCandidateRejection,
  persistPipelineArtifacts,
  persistGoalBackwardDecisionArtifacts,
  redactSnapshotValue,
  validateCandidateBundle,
  validateGoalBackwardCandidateBundle,
  validateGoalBackwardApplyEnvelope,
  validateStoredGoalBackwardCandidateBindings,
  validatePlanStructure,
};
