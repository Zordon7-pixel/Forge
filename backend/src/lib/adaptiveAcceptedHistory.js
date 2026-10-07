// Shared accepted identity authentication. Historical evidence grants no active authority.
const { ownDataJsonSnapshot, ownMaterializedProgramSnapshot } = require('./goalBackwardRecoveryMaterial');
const { isCanonicalHash, prefixedHash } = require('./planCandidateLifecycle');
const { validateCanonicalSessionSet } = require('./canonicalWorkout');
const { canonicalPrescriptionHash } = require('./goalBackwardValidators');
const { canonicalStringify, canonicalHash, addDays: addPolicyDays } = require('./racePlanPolicy');
const planSchema = require('./planSchema');
const CANONICAL_SESSION_SET_PAYLOAD_KEYS = Object.freeze([
  'canonical_workout_schema_version', 'canonical_sessions_materialized',
  'plan_id', 'plan_revision', 'decision_id', 'decision_hash', 'candidate_id',
  'candidate_skeleton_hash', 'candidate_hash', 'material_change_baseline_binding_hash',
  'sessions', 'session_content_hashes', 'derived_totals', 'content_hash',
]);
const CANONICAL_SESSION_SET_ARTIFACT_KEYS = new Set([
  'plan_generation_candidate_ref', ...CANONICAL_SESSION_SET_PAYLOAD_KEYS,
  'selected_candidate_id', 'selected_candidate_hash',
]);
const ACTIVE_CANONICAL_CARRY_SOURCE_KEYS = Object.freeze([
  'artifact_id', 'artifact_user_id', 'artifact_kind', 'artifact_decision_id',
  'artifact_candidate_id', 'artifact_schema_version', 'artifact_policy_version',
  'artifact_revision', 'artifact_content_hash', 'artifact_payload_json',
  'candidate_id', 'candidate_decision_id', 'candidate_selected_hash',
  'candidate_material_change_json', 'candidate_applied_user_plan_id', 'candidate_status',
  'assignment_id', 'assignment_user_id', 'assignment_plan_id',
  'assignment_plan_revision', 'assignment_status',
]);
const ACTIVE_CANONICAL_CARRY_JSON_KEYS = new Set([
  'artifact_payload_json', 'candidate_material_change_json',
]);

function exactHashIdentity(value) {
  return isCanonicalHash(value) ? value.replace(/^sha256:/, '') : null;
}

function storedOwnJsonSnapshot(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return ownDataJsonSnapshot(parsed) || ownMaterializedProgramSnapshot(parsed);
  } catch (_error) {
    return null;
  }
}

function ownStoredCanonicalCarrySource(value) {
  try {
    const snapshot = ownDataJsonSnapshot(value, { maximumDepth: 64, maximumNodes: 50000 })
      || ownMaterializedProgramSnapshot(value);
    if (!snapshot || Array.isArray(snapshot)) return null;
    const keys = Object.keys(snapshot);
    if (keys.length !== ACTIVE_CANONICAL_CARRY_SOURCE_KEYS.length
      || keys.some((key) => !ACTIVE_CANONICAL_CARRY_SOURCE_KEYS.includes(key))) return null;
    const source = Object.create(null);
    for (const key of ACTIVE_CANONICAL_CARRY_SOURCE_KEYS) {
      if (!Object.hasOwn(snapshot, key)) return null;
      const field = snapshot[key];
      if (ACTIVE_CANONICAL_CARRY_JSON_KEYS.has(key)) {
        const json = storedOwnJsonSnapshot(field);
        if (!json || Array.isArray(json)) return null;
        source[key] = json;
        continue;
      }
      if (field !== null && !['string', 'number', 'boolean'].includes(typeof field)) return null;
      source[key] = field;
    }
    return Object.freeze(source);
  } catch (_error) {
    return null;
  }
}

function invalidGoalExpansionCarrySource(reason) {
  const error = new Error(`Active canonical goal-expansion source is invalid: ${reason}`);
  error.code = 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID';
  throw error;
}

function authenticateIdentity({ userId, activeAppliedPlan, activeSource }) {
  const plan = ownDataJsonSnapshot(activeAppliedPlan) || ownMaterializedProgramSnapshot(activeAppliedPlan);
  const source = ownStoredCanonicalCarrySource(activeSource);
  if (!plan || !source) invalidGoalExpansionCarrySource('OWN_DATA_SNAPSHOT_INVALID');
  const payload = storedOwnJsonSnapshot(source.artifact_payload_json);
  const materialChange = storedOwnJsonSnapshot(source.candidate_material_change_json);
  if (!payload || !materialChange) invalidGoalExpansionCarrySource('ARTIFACT_PAYLOAD_INVALID');
  const payloadKeys = Object.keys(payload);
  const versionedKeys = Object.hasOwn(payload, 'program_storage_version')
    ? ['prescribed_dose_versions', 'program_contract', 'program_storage_version']
    : Object.hasOwn(payload, 'prescribed_dose_versions') ? ['prescribed_dose_versions'] : [];
  const allowedKeys = new Set([...CANONICAL_SESSION_SET_ARTIFACT_KEYS, ...versionedKeys]);
  if (Object.hasOwn(payload, 'program_storage_version')
    && payload.program_storage_version !== require('./goalBackwardContracts').PROGRAM_ARTIFACT_STORAGE_VERSION
    || payloadKeys.length !== allowedKeys.size
    || payloadKeys.some((key) => !allowedKeys.has(key))) {
    invalidGoalExpansionCarrySource('ARTIFACT_SCHEMA_INVALID');
  }
  const sessionSet = Object.fromEntries([...CANONICAL_SESSION_SET_PAYLOAD_KEYS, ...versionedKeys].map((key) => [key, payload[key]]));
  const validation = validateCanonicalSessionSet(sessionSet);
  const artifactHash = exactHashIdentity(source.artifact_content_hash);
  const selectedHash = exactHashIdentity(source.candidate_selected_hash);
  const payloadSelectedHash = exactHashIdentity(payload.selected_candidate_hash);
  const planSelectedHash = exactHashIdentity(plan.selected_candidate_hash);
  const planSessionSetHash = exactHashIdentity(plan.canonical_session_set_hash);
  const expectedPrescriptionHash = exactHashIdentity(materialChange.candidate_prescription_hash);
  const actualPrescriptionHash = exactHashIdentity(canonicalPrescriptionHash(plan));
  const assignmentPlanRevision = source.assignment_plan_revision;
  const identityChecks = [
    ['SESSION_SET_INVALID', validation.valid],
    ['OWNER_ID_INVALID', typeof userId === 'string' && Boolean(userId)],
    ['ARTIFACT_OWNER_MISMATCH', source.artifact_user_id === userId],
    ['ARTIFACT_KIND_MISMATCH', source.artifact_kind === 'canonical_session_set'],
    ['ARTIFACT_ID_INVALID', typeof source.artifact_id === 'string' && Boolean(source.artifact_id)],
    ['ARTIFACT_SCHEMA_MISMATCH', source.artifact_schema_version === '1'],
    ['ARTIFACT_POLICY_INVALID', typeof source.artifact_policy_version === 'string'
      && Boolean(source.artifact_policy_version)],
    ['ARTIFACT_REVISION_INVALID', Number.isSafeInteger(source.artifact_revision)
      && source.artifact_revision >= 1],
    ['CANDIDATE_STATUS_MISMATCH', source.candidate_status === 'applied'],
    ['ASSIGNMENT_ID_MISMATCH', source.assignment_id === source.candidate_applied_user_plan_id],
    ['ASSIGNMENT_OWNER_MISMATCH', source.assignment_user_id === userId],
    ['ASSIGNMENT_REVISION_INVALID', Number.isSafeInteger(assignmentPlanRevision)
      && assignmentPlanRevision >= 1],
    ['ARTIFACT_CANDIDATE_MISMATCH', source.artifact_candidate_id === source.candidate_id],
    ['ARTIFACT_DECISION_MISMATCH', source.artifact_decision_id === source.candidate_decision_id
      && source.artifact_decision_id === sessionSet.decision_id],
    ['PAYLOAD_CANDIDATE_MISMATCH', exactHashIdentity(payload.plan_generation_candidate_ref)
      === exactHashIdentity(prefixedHash(source.candidate_id))
      && payload.selected_candidate_id === sessionSet.candidate_id],
    ['ARTIFACT_CONTENT_HASH_MISMATCH', artifactHash === exactHashIdentity(prefixedHash(payload))],
    ['CANDIDATE_HASH_MISSING', Boolean(selectedHash)],
    ['CANDIDATE_HASH_MISMATCH', selectedHash === payloadSelectedHash
      && selectedHash === exactHashIdentity(sessionSet.candidate_hash)
      && selectedHash === planSelectedHash],
    ['SESSION_SET_HASH_MISMATCH', planSessionSetHash === exactHashIdentity(sessionSet.content_hash)],
    ['PLAN_SCHEMA_MISMATCH', plan.canonical_workout_schema_version === 1],
    ['PLAN_IDENTITY_MISMATCH', plan.plan_id === sessionSet.plan_id
      && plan.plan_revision === sessionSet.plan_revision
      && plan.plan_revision === assignmentPlanRevision],
    ['PLAN_DECISION_MISMATCH', plan.decision_id === sessionSet.decision_id
      && exactHashIdentity(plan.decision_hash) === exactHashIdentity(sessionSet.decision_hash)],
    ['PLAN_CANDIDATE_MISMATCH', plan.selected_candidate_id === sessionSet.candidate_id],
    ['PRESCRIPTION_HASH_MISMATCH', Boolean(expectedPrescriptionHash)
      && expectedPrescriptionHash === actualPrescriptionHash],
  ];
  const failedIdentityCheck = identityChecks.find(([, valid]) => !valid)?.[0];
  if (failedIdentityCheck) invalidGoalExpansionCarrySource(failedIdentityCheck);
  const reconstructed = planSchema.buildCanonicalPlanFromSessionSet(sessionSet);
  if (plan.engineVersion === 'adaptive-joint-solver-v1' && reconstructed) {
    reconstructed.weeks = reconstructed.weeks.map(week => ({ ...week,
      phase: plan.weeks.find(item => item.week === week.week)?.phase,
      purpose: plan.purpose, weekly_objectives: plan.calendar_windows?.find(window => window.start_date >= week.startDate
        && window.start_date <= addPolicyDays(week.startDate, 6))?.weekly_objectives || plan.weekly_objectives }));
  }
  const materializedProgram = sessionSet.program_storage_version
    && require('./planCandidateLifecycle').validatedCompleteProgramPlan(plan);
  const sourceSessions = new Map(sessionSet.sessions.map(session => [session.session_id, session]));
  const decoratedSources = new Map(planSchema.withRemovalSessionIdentities(reconstructed).weeks
    .flatMap(week => week.days.flatMap(day => day.sessions.map(session => [session.session_id, session.removal_session_id]))));
  const programSessionsMatch = materializedProgram && plan.weeks.every(week => week.days.every(day => day.sessions.every(session => {
    const { removal_session_id, ...prescription } = session;
    return (!removal_session_id || removal_session_id === decoratedSources.get(session.session_id))
      && canonicalStringify(prescription) === canonicalStringify(sourceSessions.get(session.session_id));
  })));
  if (!reconstructed || (materializedProgram ? !programSessionsMatch
    : canonicalStringify(plan.weeks) !== canonicalStringify(reconstructed.weeks))) {
    invalidGoalExpansionCarrySource('PLAN_SESSION_BYTES_MISMATCH');
  }
  return { plan, sessionSet };
}


function authenticateActive(input) {
  const { plan, sessionSet } = authenticateIdentity(input);
  const source = input.activeSource, active = input.state?.activePlan;
  if (source.assignment_status !== 'active' || source.assignment_id !== active?.userPlanId
    || source.assignment_plan_id !== active?.trainingPlanId || plan.plan_revision !== active?.planVersion) {
    invalidGoalExpansionCarrySource('ACTIVE_ASSIGNMENT_MISMATCH');
  }
  return { plan, sessionSet };
}
function authenticateHistorical({ userId, row }) {
  if (row.candidate_user_id !== userId || row.storage_user_id !== userId
    || row.storage_id !== row.assignment_plan_id
    || !['active', 'superseded'].includes(row.assignment_status)) {
    invalidGoalExpansionCarrySource('HISTORICAL_ASSIGNMENT_MISMATCH');
  }
  const source = Object.fromEntries(ACTIVE_CANONICAL_CARRY_SOURCE_KEYS.map(key => [key, row[key]]));
  const plan = storedOwnJsonSnapshot(row.storage_plan_data ?? row.storage_plan_json);
  const authenticated = authenticateIdentity({ userId, activeAppliedPlan: plan, activeSource: source });
  for (const stored of [row.storage_plan_json, row.candidate_plan_json]) {
    if (stored !== null) authenticateIdentity({ userId, activeAppliedPlan: storedOwnJsonSnapshot(stored), activeSource: source });
  }
  return authenticated;
}

const MAX_SETS = 64;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 + 16384;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const JSON_COLUMNS = {
  artifact_payload_json: 'canonical.payload_json',
  candidate_material_change_json: 'candidate.material_change_json',
  candidate_plan_json: 'candidate.candidate_plan_json',
  storage_plan_data: 'storage.plan_data', storage_plan_json: 'storage.plan_json',
};
const payloadLimit = key => key === 'candidate_material_change_json' ? 16384
  : key === 'artifact_payload_json' ? 4 * 1024 * 1024 : MAX_PAYLOAD_BYTES;
const HISTORY_FIELDS = `canonical.id AS artifact_id, canonical.user_id AS artifact_user_id,
  canonical.artifact_kind, canonical.decision_id AS artifact_decision_id,
  canonical.plan_generation_candidate_id AS artifact_candidate_id,
  canonical.schema_version AS artifact_schema_version, canonical.policy_version AS artifact_policy_version,
  canonical.revision AS artifact_revision, canonical.content_hash AS artifact_content_hash,
  candidate.id AS candidate_id, candidate.user_id AS candidate_user_id,
  candidate.decision_id AS candidate_decision_id, candidate.selected_candidate_hash AS candidate_selected_hash,
  candidate.applied_user_plan_id AS candidate_applied_user_plan_id, candidate.status AS candidate_status,
  assignment.id AS assignment_id, assignment.user_id AS assignment_user_id,
  assignment.plan_id AS assignment_plan_id, assignment.plan_version AS assignment_plan_revision,
  assignment.status AS assignment_status, storage.id AS storage_id, storage.user_id AS storage_user_id`.split(',').map(field => {
  const [column, alias] = field.trim().split(/ AS /);
  return { column, alias: alias || column.split('.').at(-1) };
});
// Bound metadata too: corrupted IDs/hashes cannot bypass the payload read cap.
const HISTORY_COLUMNS = HISTORY_FIELDS.map(({ column, alias }) =>
  `CASE WHEN length(CAST(${column} AS TEXT))<=512 THEN ${column} ELSE NULL END AS ${alias}`).join(', ') +
  `, CASE WHEN ${HISTORY_FIELDS.map(({ column }) => `(${column} IS NULL OR length(CAST(${column} AS TEXT))<=512)`).join(' AND ')}
    THEN 0 ELSE 1 END AS metadata_invalid`;
// Includes UTF-8 and JSON escaping of every bounded metadata field.
const MAX_METADATA_ROW_BYTES = 96 * 1024;
const HISTORY_FROM = `FROM plan_generation_candidates candidate
  LEFT JOIN planning_pipeline_artifacts canonical ON canonical.user_id=candidate.user_id
    AND canonical.plan_generation_candidate_id=candidate.id AND canonical.artifact_kind='canonical_session_set'
  LEFT JOIN user_plans assignment ON assignment.user_id=candidate.user_id AND assignment.id=candidate.applied_user_plan_id
  LEFT JOIN training_plans storage ON storage.user_id=assignment.user_id AND storage.id=assignment.plan_id
  WHERE candidate.user_id=? AND (candidate.status='applied' OR candidate.applied_user_plan_id IS NOT NULL)
    AND (CAST(canonical.payload_json AS TEXT) LIKE ? ESCAPE '!'
      OR CAST(candidate.candidate_plan_json AS TEXT) LIKE ? ESCAPE '!'
      OR CAST(storage.plan_data AS TEXT) LIKE ? ESCAPE '!'
      OR CAST(storage.plan_json AS TEXT) LIKE ? ESCAPE '!')`;

// Only generation calls this with receipts acquired by activityMeasuredReceipt.load.
// Text token filtering works for SQLite TEXT and PostgreSQL JSONB, including
// malformed SQLite JSON. It is only a lookup; every identity is authenticated below.
async function acquireHistoricalEvidence({ tx, userId, receipts, observationInstant }) {
  const references = new Map();
  for (const { payload } of receipts?.usable || []) {
    const b = payload.binding;
    const key = canonicalStringify([b.plan_id, b.plan_revision]);
    references.set(key, { plan_id: b.plan_id, plan_revision: b.plan_revision });
  }
  const binding = { version: 'adaptive-accepted-history-v1', observation_instant: observationInstant,
    references: [...references.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value), matches: [] };
  const result = { sets: [], binding, sourceFailed: false };
  const overflow = () => { result.sets = []; result.sourceFailed = true; binding.failure = 'SOURCE_OVERFLOW'; return result; };
  if (references.size > MAX_SETS) return overflow();
  let remaining = MAX_READ_BYTES;
  for (const reference of binding.references) {
    const token = `%${JSON.stringify(reference.plan_id).replace(/[!%_]/g, '!$&')}%`;
    const params = [userId, token, token, token, token];
    const lengths = Object.entries(JSON_COLUMNS).map(([key, col]) => `length(CAST(${col} AS TEXT)) AS ${key}_length`).join(', ');
    // Reserve the maximum response before each metadata query, then charge the
    // actual bounded rows. Empty references do not consume the payload budget.
    if (remaining < 65 * MAX_METADATA_ROW_BYTES) return overflow();
    const rows = await tx.all(`SELECT ${HISTORY_COLUMNS}, ${lengths} ${HISTORY_FROM}
      ORDER BY candidate.id, canonical.id LIMIT 65`, params);
    remaining -= Buffer.byteLength(JSON.stringify(rows));
    if (rows.some(row => row.metadata_invalid)) return overflow();
    if (rows.length > 64) return overflow();
    const matches = [], acquiredMatches = [];
    for (const metadata of rows) {
      // Four bytes per Unicode scalar bounds UTF-8 on both engines, before read.
      const cost = Object.keys(JSON_COLUMNS).reduce((n, key) => n + 4 * Number(metadata[`${key}_length`] || 0), 0);
      const acquired = { reference, metadata, row_hash: null, reason: null };
      binding.matches.push(acquired); acquiredMatches.push(acquired);
      if (cost > remaining || Object.keys(JSON_COLUMNS).some(key => metadata[`${key}_length`] > payloadLimit(key))) return overflow();
      if (cost + 2 * MAX_METADATA_ROW_BYTES > remaining) return overflow();
      remaining -= cost + 2 * MAX_METADATA_ROW_BYTES;
      const totalLength = Object.values(JSON_COLUMNS).map(col => `COALESCE(length(CAST(${col} AS TEXT)),0)`).join('+');
      const payloads = Object.entries(JSON_COLUMNS).map(([key, col]) =>
        `CASE WHEN (${totalLength})<=${Math.floor(cost / 4)} AND length(CAST(${col} AS TEXT))<=? THEN ${col} ELSE NULL END AS ${key}`).join(', ');
      const values = await tx.all(`SELECT ${HISTORY_COLUMNS}, ${lengths}, ${payloads} ${HISTORY_FROM}
        AND candidate.id=? AND (canonical.id=? OR (canonical.id IS NULL AND ? IS NULL))
        ORDER BY candidate.id, canonical.id LIMIT 2`,
      [...Object.keys(JSON_COLUMNS).map(key => Math.min(payloadLimit(key), Math.floor(cost / 4))),
        ...params, metadata.candidate_id, metadata.artifact_id, metadata.artifact_id]);
      if (values.length !== 1) { acquired.reason = 'ACQUISITION_CHANGED'; continue; }
      const row = values[0];
      acquired.row_hash = canonicalHash(row);
      if (Object.keys(metadata).some(key => row[key] !== metadata[key])) { acquired.reason = 'ACQUISITION_CHANGED'; continue; }
      try {
        for (const key of Object.keys(JSON_COLUMNS)) {
          if (row[`${key}_length`] !== null && row[key] === null
            || Buffer.byteLength(typeof row[key] === 'string' ? row[key] : JSON.stringify(row[key])) > payloadLimit(key)) {
            invalidGoalExpansionCarrySource('PAYLOAD_SIZE_INVALID');
          }
        }
        const artifact = storedOwnJsonSnapshot(row.artifact_payload_json);
        if (!artifact || Buffer.byteLength(JSON.stringify(artifact)) > (artifact.program_storage_version
          ? 4 * 1024 * 1024 : 256 * 1024)) invalidGoalExpansionCarrySource('ARTIFACT_SIZE_INVALID');
        const { plan, sessionSet } = authenticateHistorical({ userId, row });
        if (sessionSet.plan_id !== reference.plan_id || sessionSet.plan_revision !== reference.plan_revision) {
          acquired.reason = 'NOT_REFERENCED_REVISION'; continue;
        }
        const candidatePlan = storedOwnJsonSnapshot(row.candidate_plan_json);
        if (!candidatePlan || canonicalPrescriptionHash(candidatePlan) !== canonicalPrescriptionHash(plan)) {
          invalidGoalExpansionCarrySource('CANDIDATE_PLAN_MISMATCH');
        }
        acquired.reason = 'AUTHENTICATED';
        matches.push(sessionSet);
      } catch (error) {
        acquired.reason = error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID'
          ? error.message.split(': ').at(-1) : 'AUTHENTICATION_INVALID';
      }
    }
    // No LIMIT 1 authority. A second potential applied source is ambiguous even
    // if one of its payloads fails authentication; corruption cannot pick a winner.
    const relevant = acquiredMatches.filter(row => row.reason !== 'NOT_REFERENCED_REVISION');
    if (relevant.length === 1 && matches.length === 1) result.sets.push(matches[0]);
    else binding.matches.push({ reference, reason: relevant.length > 1 ? 'AMBIGUOUS' : 'UNAVAILABLE' });
  }
  return result;
}
async function loadHistoricalEvidence(input) {
  try { return await acquireHistoricalEvidence(input); }
  catch (_error) {
    console.error('[plans/generate] accepted history lookup failed');
    return { sets: [], sourceFailed: true, binding: { version: 'adaptive-accepted-history-v1', failure: 'SOURCE_UNAVAILABLE' } };
  }
}
module.exports = { authenticateActive, authenticateHistorical, loadHistoricalEvidence,
  invalidGoalExpansionCarrySource, MAX_SETS, MAX_PAYLOAD_BYTES, MAX_READ_BYTES };
