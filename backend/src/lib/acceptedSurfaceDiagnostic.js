// Read-only accepted-surface predicates shared by plan surfaces and coaching reads.
// The plan route injects its legacy parse helper; readers default to canonical JSON only.
const { canonicalHash } = require('./racePlanPolicy');
const prefixedHash = value => `sha256:${canonicalHash(value)}`;
const exactPositivePlanRevision = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
function parseJsonValue(raw, fallback) { try { return typeof raw === 'string' ? JSON.parse(raw) : raw ?? fallback; } catch { return fallback; } }
function parseCanonicalPlan(row) { return parseJsonValue(row?.plan_data || row?.plan_json, null); }

const EFFECTIVE_READ_VERSION = 'effective-assignment-read-v1';
const MAX_ASSIGNMENT_READ_DEPTH = 16;
function strictDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}
function effectiveReadDate(row) {
  // An invalid explicit effective date cannot fall back to another field.
  if (row?.effective_from != null) return strictDate(row.effective_from);
  const started = row?.started_at;
  if (strictDate(started)) return started;
  // Legacy started_at may be a timestamp. Its persisted date is the lifecycle
  // fallback, not an inferred instant or a conversion of naive time to UTC.
  return typeof started === 'string' && /^\d{4}-\d\d-\d\d[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?$/.test(started)
    ? strictDate(started.slice(0, 10)) : null;
}
const assignmentReadFields = ['user_plan_id', 'user_id', 'training_owner_id', 'plan_id', 'status', 'plan_version',
  'lineage_id', 'supersedes_user_plan_id', 'effective_from', 'started_at'];
function assignmentReadIdentity(row) {
  return Object.fromEntries(assignmentReadFields.map(key => [key, row?.[key] ?? null]));
}
// This is an internal read proof, never client authority. Validate the entire
// owner-bound path again at acceptance, not merely a caller-provided boolean.
function validEffectiveAssignmentRead(binding, row, ownerId) {
  const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  if (!identity(ownerId) || binding?.version !== EFFECTIVE_READ_VERSION || !strictDate(binding.local_date)
    || !Array.isArray(binding.path) || binding.path.length < 2 || binding.path.length > MAX_ASSIGNMENT_READ_DEPTH) return false;
  if (typeof binding.timezone !== 'string' || binding.timezone.length > 128) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: binding.timezone }); } catch { return false; }
  const ids = new Set(), plans = new Set(), path = binding.path;
  const lineage = path[0]?.lineage_id;
  if (!identity(lineage)) return false;
  for (let i = 0; i < path.length; i++) {
    const current = path[i], date = effectiveReadDate(current), next = path[i + 1];
    if (!current || !identity(current.user_plan_id) || !identity(current.plan_id) || current.user_id !== ownerId || current.training_owner_id !== ownerId
      || ids.has(current.user_plan_id) || plans.has(current.plan_id) || current.lineage_id !== lineage
      || current.status !== (i === 0 ? 'active' : 'superseded') || !date
      || exactPositivePlanRevision(current.plan_version) === null) return false;
    ids.add(current.user_plan_id); plans.add(current.plan_id);
    if (next && (date <= binding.local_date || current.supersedes_user_plan_id !== next.user_plan_id
      || !effectiveReadDate(next) || date <= effectiveReadDate(next) || current.plan_version <= next.plan_version)) return false;
    if (!next && (date > binding.local_date || ids.has(current.supersedes_user_plan_id))) return false;
  }
  return canonicalHash(assignmentReadIdentity(row)) === canonicalHash(assignmentReadIdentity(path.at(-1)));
}

function surfaceManifestAppliedPlanDiagnostic(manifest, candidate = {}, activeRow = null, canonicalSessionSet = null, parsePlan = parseCanonicalPlan, { effectiveAssignmentRead = null } = {}) {
  const identity = manifest?.identity;
  const hashIdentity = (value) => String(value || '').replace(/^sha256:/, '');
  const diagnosticHash = (value) => {
    const normalized = hashIdentity(value).toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? `sha256:${normalized}` : null;
  };
  const diagnosticRevision = (value) => {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  };
  const closedStatus = (value, allowed) => {
    const normalized = String(value || '').toLowerCase();
    return allowed.includes(normalized) ? normalized.toUpperCase() : 'UNKNOWN';
  };
  const activePlan = parsePlan(activeRow) || {};
  const candidateGoalRevisions = parseJsonValue(candidate.goal_revisions_json, {});
  const activeWeeks = (Array.isArray(activePlan.weeks) ? activePlan.weeks : []).map((week, index) => ({
    week: Math.max(1, Number(week?.week || index + 1)),
    start_date: String(week?.startDate || week?.start_date || ''),
    phase: String(week?.phase || ''),
    purpose: String(week?.purpose || week?.weekPurpose || week?.week_purpose || ''),
  }));
  const activePurpose = String(
    activePlan.purpose
      || activeWeeks.find((week) => week.purpose)?.purpose
      || '',
  ).trim();
  const identityPresent = Boolean(identity && typeof identity === 'object' && !Array.isArray(identity));
  const canonicalPresent = Boolean(
    canonicalSessionSet && typeof canonicalSessionSet === 'object' && !Array.isArray(canonicalSessionSet)
  );
  const candidateStatus = closedStatus(candidate.status, ['preview', 'applied', 'rejected', 'superseded']);
  const assignmentStatus = closedStatus(activeRow?.status, ['active', 'superseded', 'cleared']);
  const assignmentPredicate = effectiveAssignmentRead ? 'ASSIGNMENT_EFFECTIVE_READ_BOUND' : 'ASSIGNMENT_STATUS_ACTIVE';
  const assignmentLinked = Boolean(candidate.applied_user_plan_id && activeRow?.user_plan_id)
    && String(candidate.applied_user_plan_id) === String(activeRow.user_plan_id);
  const appliedPlanLinked = Boolean(candidate.applied_training_plan_id && activeRow?.plan_id)
    && String(candidate.applied_training_plan_id) === String(activeRow.plan_id);
  // Legacy one-window manifests were published without this ref. Complete
  // programs were not: their accepted plan/canonical contract requires it,
  // even if a caller strips the marker or ref from the manifest itself.
  const candidateRefRequired = activePlan.programContract?.version === 'complete-road-program-v1'
    || canonicalSessionSet?.program_storage_version === 'materialized-program-storage-v1';
  const candidateRefMatches = value => Boolean(candidate.id)
    && diagnosticHash(value) === diagnosticHash(prefixedHash(candidate.id));
  const activityLineage = canonicalSessionSet?.activity_adaptation;
  const activityRootHash = activityLineage
    ? require('./activityCanonicalSuccessor').rootCandidateHash(
      require('./activityCanonicalSuccessor').canonicalSetPayload(canonicalSessionSet)) : null;
  const predicateEntries = [
    ['SURFACE_ARTIFACT_PRESENT', Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest))],
    ['CANDIDATE_BINDING_PRESENT', Boolean(candidate.id)],
    ['SURFACE_CANDIDATE_REFERENCE_MATCH', !candidateRefRequired && manifest?.plan_generation_candidate_ref == null
      || candidateRefMatches(manifest?.plan_generation_candidate_ref)],
    ['CANONICAL_CANDIDATE_REFERENCE_MATCH', !candidateRefRequired && canonicalSessionSet?.plan_generation_candidate_ref == null
      || candidateRefMatches(canonicalSessionSet?.plan_generation_candidate_ref)],
    ['ASSIGNMENT_PRESENT', Boolean(activeRow && typeof activeRow === 'object' && !Array.isArray(activeRow))],
    ['CANDIDATE_STATUS_APPLIED', candidateStatus === 'APPLIED'],
    [assignmentPredicate, effectiveAssignmentRead
      ? validEffectiveAssignmentRead(effectiveAssignmentRead, activeRow, candidate.user_id) : assignmentStatus === 'ACTIVE'],
    ['ASSIGNMENT_LINK_MATCH', assignmentLinked],
    ['APPLIED_PLAN_LINK_MATCH', appliedPlanLinked],
    ['SURFACE_SCHEMA_MATCH', manifest?.schema_version === 'goal_backward_surface_manifest_v1'],
    ['SURFACE_STATUS_ACCEPTED', manifest?.status === 'accepted'],
    ['SURFACE_ENABLED', manifest?.v24_surface_enabled === true],
    ['SURFACE_MODE_APPLICABLE', ['preview', 'on'].includes(String(manifest?.feature_mode || ''))],
    ['SURFACE_IDENTITY_PRESENT', identityPresent],
    ['SURFACE_SESSIONS_PRESENT', Array.isArray(manifest?.sessions) && manifest.sessions.length > 0],
    ['SURFACE_REVISION_MATCH', Number(manifest?.surface_revision) === Number(candidate.surface_revision)],
    ['CANDIDATE_REVISION_MATCH', Number(identity?.candidate_revision) === Number(candidate.candidate_revision)],
    ['CANDIDATE_DECISION_MATCH', String(identity?.decision_id || '') === String(candidate.decision_id || '')],
    ['CANDIDATE_CONTENT_HASH_MATCH', hashIdentity(activityLineage ? activityRootHash : identity?.candidate_hash) === hashIdentity(candidate.selected_candidate_hash)],
    ['ACTIVITY_OWNER_LINEAGE_MATCH', !activityLineage || Boolean(activityRootHash)
      && activityLineage.context.owner_id === String(candidate.user_id)
      && activityLineage.context.assignment_id === String(activeRow?.user_plan_id)],
    ['ACTIVITY_PROGRAM_RECONCILIATION_MATCH', !activityLineage || require('./activityProgramReconciliation')
      .validateActivityProgramReconciliation(activePlan, require('./activityCanonicalSuccessor').canonicalSetPayload(canonicalSessionSet))],
    ['ATHLETE_STATE_REVISION_MATCH', Number(identity?.athlete_state_revision) === Number(candidate.athlete_state_revision)],
    ['SAFETY_STATE_HASH_MATCH', String(identity?.safety_state_hash || '') === String(candidate.safety_state_hash || '')],
    ['GOAL_BINDING_MATCH', prefixedHash(identity?.goal_revisions || {}) === prefixedHash(candidateGoalRevisions)],
    ['PLAN_ID_MATCH', String(identity?.plan_id || '') === String(activePlan.plan_id || '')],
    ['PLAN_REVISION_MATCH', Number(identity?.plan_revision) === Number(activePlan.plan_revision)],
    ['ASSIGNMENT_REVISION_MATCH', exactPositivePlanRevision(identity?.plan_revision) !== null
      && exactPositivePlanRevision(activeRow?.plan_version) !== null
      && identity.plan_revision === activeRow.plan_version],
    ['PLAN_DECISION_MATCH', String(identity?.decision_id || '') === String(activePlan.decision_id || '')],
    ['PLAN_DECISION_HASH_MATCH', hashIdentity(identity?.decision_hash) === hashIdentity(activePlan.decision_hash)],
    ['PLAN_CANDIDATE_HASH_MATCH', hashIdentity(identity?.candidate_hash) === hashIdentity(activePlan.selected_candidate_hash)],
    ['PLAN_SESSION_SET_HASH_MATCH', hashIdentity(identity?.canonical_session_set_hash) === hashIdentity(activePlan.canonical_session_set_hash)],
    ['PLAN_PURPOSE_MATCH', String(manifest?.purpose || '') === activePurpose],
    ['PLAN_FEASIBILITY_STATUS_MATCH', String(manifest?.feasibility?.status || '') === String(activePlan.overall_feasibility || '')],
    ['PLAN_FEASIBILITY_REASONS_MATCH', prefixedHash(manifest?.feasibility?.reason_codes || []) === prefixedHash(activePlan.reasons || [])],
    ['PLAN_WEEKS_MATCH', prefixedHash(manifest?.weeks || []) === prefixedHash(activeWeeks)],
    ['CANONICAL_SESSION_SET_PRESENT', canonicalPresent],
    ['CANONICAL_PLAN_ID_MATCH', String(canonicalSessionSet?.plan_id || '') === String(identity?.plan_id || '')],
    ['CANONICAL_PLAN_REVISION_MATCH', Number(canonicalSessionSet?.plan_revision) === Number(identity?.plan_revision)],
    ['CANONICAL_DECISION_MATCH', String(canonicalSessionSet?.decision_id || '') === String(identity?.decision_id || '')],
    ['CANONICAL_DECISION_HASH_MATCH', hashIdentity(canonicalSessionSet?.decision_hash) === hashIdentity(identity?.decision_hash)],
    ['CANONICAL_CANDIDATE_MATCH', String(canonicalSessionSet?.candidate_id || canonicalSessionSet?.selected_candidate_id || '') === String(identity?.candidate_id || '')],
    ['CANONICAL_CANDIDATE_HASH_MATCH', hashIdentity(canonicalSessionSet?.candidate_hash || canonicalSessionSet?.selected_candidate_hash) === hashIdentity(identity?.candidate_hash)],
    ['CANONICAL_CONTENT_HASH_MATCH', hashIdentity(canonicalSessionSet?.content_hash) === hashIdentity(identity?.canonical_session_set_hash)],
    ['CANONICAL_SESSIONS_MATCH', JSON.stringify(canonicalSessionSet?.sessions || []) === JSON.stringify(manifest?.sessions)],
  ];
  const predicates = Object.fromEntries(predicateEntries);
  const firstFailed = predicateEntries.find(([, passed]) => !passed)?.[0] || null;
  const accepted = firstFailed === null;
  const predicateGroup = (...codes) => codes.every((code) => predicates[code] === true);
  const manifestStatus = closedStatus(manifest?.status, ['accepted', 'blocked']);
  const featureMode = closedStatus(manifest?.feature_mode, ['preview', 'on', 'shadow', 'off']);
  return {
    schema_version: 'goal_backward_surface_predicate_diagnostic_v1',
    applicable: Number(activePlan.canonical_workout_schema_version) === 1,
    status_code: accepted ? 'ACCEPTED' : 'BLOCKED',
    reason_codes: accepted ? [] : ['SURFACE_REVISION_MISMATCH'],
    first_failed_predicate: firstFailed,
    predicates,
    statuses: {
      manifest: manifestStatus,
      feature_mode: featureMode,
      candidate: candidateStatus,
      assignment: assignmentStatus,
    },
    revisions: {
      surface: {
        manifest: diagnosticRevision(manifest?.surface_revision),
        candidate: diagnosticRevision(candidate.surface_revision),
        matches: predicates.SURFACE_REVISION_MATCH,
      },
      candidate: {
        manifest: diagnosticRevision(identity?.candidate_revision),
        candidate: diagnosticRevision(candidate.candidate_revision),
        matches: predicates.CANDIDATE_REVISION_MATCH,
      },
      plan: {
        manifest: diagnosticRevision(identity?.plan_revision),
        plan: diagnosticRevision(activePlan.plan_revision),
        assignment: diagnosticRevision(activeRow?.plan_version),
        canonical_session_set: diagnosticRevision(canonicalSessionSet?.plan_revision),
        matches: predicateGroup(
          'PLAN_REVISION_MATCH', 'ASSIGNMENT_REVISION_MATCH', 'CANONICAL_PLAN_REVISION_MATCH'
        ),
      },
      athlete_state: {
        manifest: diagnosticRevision(identity?.athlete_state_revision),
        candidate: diagnosticRevision(candidate.athlete_state_revision),
        matches: predicates.ATHLETE_STATE_REVISION_MATCH,
      },
    },
    bindings: {
      artifact: predicateGroup(
        'SURFACE_ARTIFACT_PRESENT', 'SURFACE_SCHEMA_MATCH', 'SURFACE_STATUS_ACCEPTED',
        'SURFACE_ENABLED', 'SURFACE_MODE_APPLICABLE', 'SURFACE_IDENTITY_PRESENT',
        'SURFACE_SESSIONS_PRESENT'
      ),
      surface_revision: predicates.SURFACE_REVISION_MATCH,
      candidate: predicateGroup(
        'CANDIDATE_BINDING_PRESENT', 'CANDIDATE_STATUS_APPLIED',
        'CANDIDATE_REVISION_MATCH', 'CANDIDATE_CONTENT_HASH_MATCH'
      ),
      decision: predicateGroup(
        'CANDIDATE_DECISION_MATCH', 'PLAN_DECISION_MATCH', 'PLAN_DECISION_HASH_MATCH',
        'CANONICAL_DECISION_MATCH', 'CANONICAL_DECISION_HASH_MATCH'
      ),
      plan: predicateGroup(
        'PLAN_ID_MATCH', 'PLAN_REVISION_MATCH', 'PLAN_PURPOSE_MATCH',
        'PLAN_FEASIBILITY_STATUS_MATCH', 'PLAN_FEASIBILITY_REASONS_MATCH', 'PLAN_WEEKS_MATCH'
      ),
      assignment: predicateGroup(
        'ASSIGNMENT_PRESENT', assignmentPredicate, 'ASSIGNMENT_LINK_MATCH',
        'APPLIED_PLAN_LINK_MATCH', 'ASSIGNMENT_REVISION_MATCH'
      ),
      session_set: predicateGroup(
        'CANONICAL_SESSION_SET_PRESENT', 'CANONICAL_PLAN_ID_MATCH',
        'CANONICAL_PLAN_REVISION_MATCH', 'CANONICAL_CANDIDATE_MATCH',
        'CANONICAL_SESSIONS_MATCH'
      ),
      content_hash: predicateGroup(
        'CANDIDATE_CONTENT_HASH_MATCH', 'PLAN_CANDIDATE_HASH_MATCH',
        'PLAN_SESSION_SET_HASH_MATCH', 'CANONICAL_CANDIDATE_HASH_MATCH',
        'CANONICAL_CONTENT_HASH_MATCH'
      ),
      safety: predicates.SAFETY_STATE_HASH_MATCH,
      athlete_state: predicates.ATHLETE_STATE_REVISION_MATCH,
      goal: predicates.GOAL_BINDING_MATCH,
    },
    hashes: {
      candidate: {
        manifest: diagnosticHash(identity?.candidate_hash),
        candidate: diagnosticHash(candidate.selected_candidate_hash),
        plan: diagnosticHash(activePlan.selected_candidate_hash),
        canonical_session_set: diagnosticHash(
          canonicalSessionSet?.candidate_hash || canonicalSessionSet?.selected_candidate_hash
        ),
      },
      decision: {
        manifest: diagnosticHash(identity?.decision_hash),
        plan: diagnosticHash(activePlan.decision_hash),
        canonical_session_set: diagnosticHash(canonicalSessionSet?.decision_hash),
      },
      session_set: {
        manifest: diagnosticHash(identity?.canonical_session_set_hash),
        plan: diagnosticHash(activePlan.canonical_session_set_hash),
        canonical_session_set: diagnosticHash(canonicalSessionSet?.content_hash),
      },
      safety: {
        manifest: diagnosticHash(identity?.safety_state_hash),
        candidate: diagnosticHash(candidate.safety_state_hash),
      },
      goal_binding: {
        manifest: diagnosticHash(prefixedHash(identity?.goal_revisions || {})),
        candidate: diagnosticHash(prefixedHash(candidateGoalRevisions)),
      },
    },
  };
}

module.exports = { surfaceManifestAppliedPlanDiagnostic, effectiveReadDate, assignmentReadIdentity,
  validEffectiveAssignmentRead, EFFECTIVE_READ_VERSION, MAX_ASSIGNMENT_READ_DEPTH };
