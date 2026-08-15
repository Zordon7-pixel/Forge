const { canonicalHash, canonicalStringify } = require('./racePlanPolicy');
const { normalizeReasonCode } = require('./goalBackwardContracts');

const COMPLETION_OUTCOME_SET = new Set([
  'UNDER_TARGET',
  'ON_TARGET',
  'ABOVE_TARGET',
  'EXCESSIVE_STRAIN',
  'INCOMPLETE',
  'PAIN_LIMITED',
  'UNSCORABLE_PARTIAL_SYNC',
]);

function normalizePlanningUserId(userId) {
  const normalized = String(userId || '').trim();
  if (!normalized) {
    const err = new Error('Planning mutation requires an owner');
    err.code = 'PLANNING_OWNER_REQUIRED';
    throw err;
  }
  return normalized;
}

const PLANNING_INPUT_UNCHANGED = Symbol('planning-input-unchanged');

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((nested) => deepFreeze(nested, seen));
  return Object.freeze(value);
}

function prefixedHash(value) {
  return `sha256:${canonicalHash(value)}`;
}

function positiveRevision(value, fallback = 1) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : fallback;
}

function validIsoInstant(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('A valid adaptation revision instant is required');
  return parsed.toISOString();
}

function boundedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined).map(String)
    .map((value) => value.trim()).filter((value) => value && value.length <= 200))].sort();
}

function buildCompletionOutcomeEvidence(outcome, { athleteId, createdAt } = {}) {
  const canonicalOutcome = String(outcome?.outcome || '');
  if (!COMPLETION_OUTCOME_SET.has(canonicalOutcome)) throw new Error('A canonical completion outcome is required');
  const sourceEvidenceIds = boundedStrings(outcome.source_evidence_ids || outcome.sourceEvidenceIds);
  if (!sourceEvidenceIds.length) throw new Error('Completion outcome evidence must cite an observed evidence ID');
  const reasonCodes = boundedStrings(outcome.reason_codes);
  if (reasonCodes.some((reasonCode) => normalizeReasonCode(reasonCode) !== reasonCode)) {
    throw new Error('Completion outcome evidence contains an unknown reason code');
  }
  const linkedSessionId = String(outcome.linked_session_id ?? outcome.session_id ?? '').trim() || null;
  const observedAt = outcome.observed_at ? validIsoInstant(outcome.observed_at) : createdAt;
  const payload = {
    athlete_id: athleteId,
    revision: 1,
    evidence_type: 'completion_outcome',
    truth_class: 'DERIVED',
    policy_version: 'goal-backward-planning-policy-v1',
    value: {
      outcome: canonicalOutcome,
      scorable: outcome.scorable === true,
      designated_assessment: outcome.designated_assessment === true,
      observed_to_prescribed_ratio: Number.isFinite(Number(outcome.observed_to_prescribed_ratio))
        ? Number(outcome.observed_to_prescribed_ratio) : null,
    },
    canonical_unit: 'ordinal',
    source_system: 'forge',
    source_record_id: null,
    observed_at: observedAt,
    recorded_at: createdAt,
    received_at: createdAt,
    derivation_timestamp: createdAt,
    quality_state: outcome.scorable === true ? 'COMPLETE' : 'PARTIAL',
    value_state: 'KNOWN',
    freshness_class: 'FRESH',
    supersedes_evidence_id: null,
    linked_session_id: linkedSessionId,
    source_evidence_ids: sourceEvidenceIds,
    reason_codes: reasonCodes,
    provenance: {
      derivation: 'goal_backward_completion_outcome_v1',
      observation_immutable: true,
    },
  };
  const contentHash = prefixedHash(payload);
  return deepFreeze({
    evidence_id: `completion-outcome-${contentHash.slice(-24)}`,
    ...payload,
    canonical_hash: contentHash,
  });
}

function buildCompletionOutcomeRevisions({
  evidenceSnapshot,
  athleteState,
  outcomes = [],
  createdAt = new Date().toISOString(),
} = {}) {
  if (!evidenceSnapshot?.evidence_snapshot_id || !athleteState?.athlete_state_id) {
    throw new Error('EvidenceSnapshot and AthleteState are required for a completion revision');
  }
  const athleteId = normalizePlanningUserId(evidenceSnapshot.athlete_id);
  if (String(athleteState.athlete_id || '') !== athleteId
    || String(athleteState.evidence_snapshot_id || '') !== String(evidenceSnapshot.evidence_snapshot_id)) {
    throw new Error('Completion revision owner or evidence/state link does not match');
  }
  const createdAtIso = validIsoInstant(createdAt);
  const normalizedOutcomes = Array.isArray(outcomes) ? outcomes : [];
  if (!normalizedOutcomes.length) throw new Error('At least one completion outcome is required');
  const outcomeEvidence = normalizedOutcomes.map((outcome) => buildCompletionOutcomeEvidence(outcome, {
    athleteId,
    createdAt: createdAtIso,
  }));

  const previousEvidence = cloneJson(evidenceSnapshot.evidence || []);
  const evidenceRevision = positiveRevision(evidenceSnapshot.evidence_snapshot_revision, 1) + 1;
  const evidenceContent = {
    ...cloneJson(evidenceSnapshot),
    evidence_snapshot_id: undefined,
    canonical_hash: undefined,
    evidence_snapshot_revision: evidenceRevision,
    supersedes_evidence_snapshot_id: evidenceSnapshot.evidence_snapshot_id,
    created_at: createdAtIso,
    evidence: [...previousEvidence, ...cloneJson(outcomeEvidence)],
    included_evidence_ids: boundedStrings([
      ...(evidenceSnapshot.included_evidence_ids || previousEvidence.map((entry) => entry.evidence_id)),
      ...outcomeEvidence.map((entry) => entry.evidence_id),
    ]),
    reason_codes: boundedStrings([
      ...(evidenceSnapshot.reason_codes || []),
      ...outcomeEvidence.flatMap((entry) => entry.reason_codes || []),
      ...(outcomeEvidence.some((entry) => entry.value.outcome === 'UNSCORABLE_PARTIAL_SYNC'
        && !(entry.reason_codes || []).includes('FAILED_SYNC')) ? ['PARTIAL_SYNC'] : []),
    ]),
  };
  delete evidenceContent.evidence_snapshot_id;
  delete evidenceContent.canonical_hash;
  const evidenceHash = prefixedHash(evidenceContent);
  const nextEvidenceSnapshot = {
    evidence_snapshot_id: `evidence-snapshot-${evidenceHash.slice(-24)}`,
    ...evidenceContent,
    canonical_hash: evidenceHash,
  };

  const stateRevision = positiveRevision(athleteState.athlete_state_revision, 1) + 1;
  const stateContent = {
    ...cloneJson(athleteState),
    athlete_state_id: undefined,
    athlete_state_hash: undefined,
    state_content_hash: undefined,
    athlete_state_revision: stateRevision,
    supersedes_athlete_state_id: athleteState.athlete_state_id,
    evidence_snapshot_id: nextEvidenceSnapshot.evidence_snapshot_id,
    completion_outcomes: [
      ...(athleteState.completion_outcomes || []),
      ...outcomeEvidence.map((entry) => ({
        evidence_id: entry.evidence_id,
        linked_session_id: entry.linked_session_id,
        outcome: entry.value.outcome,
        scorable: entry.value.scorable,
        designated_assessment: entry.value.designated_assessment,
      })),
    ],
    reason_codes: boundedStrings([
      ...(athleteState.reason_codes || []),
      ...outcomeEvidence.flatMap((entry) => entry.reason_codes || []),
      ...(outcomeEvidence.some((entry) => entry.value.outcome === 'UNSCORABLE_PARTIAL_SYNC'
        && !(entry.reason_codes || []).includes('FAILED_SYNC')) ? ['PARTIAL_SYNC'] : []),
    ]),
  };
  delete stateContent.athlete_state_id;
  delete stateContent.athlete_state_hash;
  delete stateContent.state_content_hash;
  const stateContentHash = prefixedHash(stateContent);
  const withContentHash = { ...stateContent, state_content_hash: stateContentHash };
  const stateHash = prefixedHash(withContentHash);
  const nextAthleteState = {
    athlete_state_id: `athlete-state-${stateHash.slice(-24)}`,
    ...withContentHash,
    athlete_state_hash: stateHash,
  };

  // Canonical serialization also rejects accidental undefined/non-JSON values before
  // these append-only revisions are handed to persistence/artifact builders.
  canonicalStringify(nextEvidenceSnapshot);
  canonicalStringify(nextAthleteState);
  return deepFreeze({
    evidence_snapshot: nextEvidenceSnapshot,
    athlete_state: nextAthleteState,
    outcome_evidence: outcomeEvidence,
  });
}

function planningInputUnchanged(value) {
  return { marker: PLANNING_INPUT_UNCHANGED, value };
}

function nonNegativeRevision(value, fallback = 0) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : fallback;
}

function advancePlanningMutationRevisions(current = {}, mutation = {}) {
  const eventChanged = mutation.event === true;
  const safetyChanged = mutation.safety === true;
  const constraintKind = mutation.constraint === 'lock' || mutation.constraint === 'edit'
    ? mutation.constraint : null;
  const planningChanged = eventChanged || safetyChanged || constraintKind !== null;
  return Object.freeze({
    planning_input_revision: nonNegativeRevision(current.planning_input_revision) + (planningChanged ? 1 : 0),
    goal_revision: positiveRevision(current.goal_revision, 1) + (eventChanged ? 1 : 0),
    athlete_state_revision: positiveRevision(current.athlete_state_revision, 1)
      + (safetyChanged || constraintKind !== null ? 1 : 0),
    lock_revision: nonNegativeRevision(current.lock_revision) + (constraintKind === 'lock' ? 1 : 0),
    edit_revision: nonNegativeRevision(current.edit_revision) + (constraintKind === 'edit' ? 1 : 0),
  });
}

async function incrementPlanningInputRevision(tx, userId) {
  if (!tx || typeof tx.get !== 'function') {
    throw new TypeError('Planning revision increment requires a transaction');
  }
  const normalizedUserId = normalizePlanningUserId(userId);
  const row = await tx.get(
    `UPDATE users
     SET planning_input_revision = planning_input_revision + 1
     WHERE id = ?
     RETURNING planning_input_revision`,
    [normalizedUserId]
  );
  if (!row) {
    const err = new Error('Planning owner no longer exists');
    err.code = 'AUTH_ACCOUNT_DELETED';
    throw err;
  }
  return Number(row.planning_input_revision);
}

function createPlanningInputMutationRunner(withUserMutation) {
  if (typeof withUserMutation !== 'function') {
    throw new TypeError('Planning mutation runner requires withUserMutation');
  }

  return async function withPlanningInputMutation(userId, mutation) {
    if (typeof mutation !== 'function') throw new TypeError('Planning mutation callback is required');
    const normalizedUserId = normalizePlanningUserId(userId);
    return withUserMutation(normalizedUserId, async (tx) => {
      const result = await mutation(tx);
      if (result?.marker === PLANNING_INPUT_UNCHANGED) return result.value;
      await incrementPlanningInputRevision(tx, normalizedUserId);
      return result;
    });
  };
}

module.exports = {
  advancePlanningMutationRevisions,
  buildCompletionOutcomeEvidence,
  buildCompletionOutcomeRevisions,
  createPlanningInputMutationRunner,
  incrementPlanningInputRevision,
  normalizePlanningUserId,
  planningInputUnchanged,
};
