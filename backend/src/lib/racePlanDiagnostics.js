const planSchema = require('./planSchema');
const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const { RACE_PLAN_POLICY_V1, canonicalHash } = require('./racePlanPolicy');
const {
  assertBoundedJson,
  buildGoalBackwardApplyEnvelope,
  findArtifactRedactionViolations,
  redactSnapshotValue,
} = require('./planCandidateLifecycle');
const {
  ARTIFACT_KINDS,
  PLANNING_POLICY_VERSION,
  validatePipelineArtifact,
  validatePipelineLinks,
} = require('./goalBackwardContracts');
const {
  assertGoalBackwardReleaseTelemetry,
  evaluateGoalBackwardReleaseAlerts,
} = require('./betaPlanRollout');

const MAX_TEXT_LENGTH = 80;
const C4_ENGINE_VERSION = 'goal-backward-coaching-v2.4';
const C4_STAGE_DEFINITIONS = Object.freeze([
  ['evidence_identity', 'C4_EVIDENCE_IDENTITY_MISSING'],
  ['athlete_state', 'C4_ATHLETE_STATE_MISSING'],
  ['goal_set', 'C4_GOAL_SET_MISSING'],
  ['recent_normal_safety_state', 'C4_RECENT_NORMAL_SAFETY_STATE_MISSING'],
  ['phase_decision', 'C4_PHASE_DECISION_MISSING'],
  ['planning_decision', 'C4_PLANNING_DECISION_MISSING'],
  ['candidate_set', 'C4_CANDIDATE_SET_MISSING'],
  ['validator_receipts', 'C4_VALIDATOR_RECEIPTS_MISSING'],
  ['canonical_sessions', 'C4_CANONICAL_SESSIONS_MISSING'],
  ['plan_revision', 'C4_PLAN_REVISION_MISSING'],
  ['surface_identity', 'C4_SURFACE_IDENTITY_MISSING'],
]);
const HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/i;
const RELEASE_REVISION_PATTERN = /^[a-f0-9]{7,64}$/i;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedText(value, maximum = MAX_TEXT_LENGTH) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maximum) : null;
}

function planWeeks(plan = {}) {
  return Array.isArray(plan.weeks) ? plan.weeks : [];
}

function weekDays(week = {}) {
  return planSchema.getDayEntries(week);
}

function sessionRole(session = {}) {
  return boundedText(session.workout_id || session.workoutId || session.type || session.workout_type || session.kind, 48);
}

function isLongRun(session = {}) {
  return String(session.kind || '').toLowerCase() === 'run'
    && (String(session.type || '').toLowerCase() === 'long'
      || String(session.workout_id || '') === 'long_aerobic');
}

function isDemandingRun(session = {}) {
  if (String(session.kind || '').toLowerCase() !== 'run') return false;
  return isLongRun(session)
    || String(session.type || '').toLowerCase() === 'race'
    || runWorkoutTaxonomy.isQualityWorkout(session.workout_id);
}

function isLowerBodyStrength(session = {}) {
  if (String(session.kind || '').toLowerCase() !== 'lift') return false;
  const focus = `${session.focus || ''} ${session.title || ''}`.toLowerCase();
  return /(lower|leg|glute|hamstring|quad|calf|posterior)/.test(focus);
}

function dosageTrace(session = {}) {
  const dosage = {};
  const numericFields = [
    ['distance_miles', session.distance_miles],
    ['duration_minutes', session.duration_min ?? session.duration_minutes],
    ['sets', session.sets],
    ['reps', session.reps],
    ['rest_seconds', session.rest_seconds],
    ['interval_seconds', session.interval_seconds],
    ['recovery_seconds', session.recovery_seconds],
  ];
  for (const [key, value] of numericFields) {
    const normalized = finite(value);
    if (normalized !== null && normalized >= 0) dosage[key] = normalized;
  }
  const targetZone = boundedText(session.target_zone || session.targetZone, 24);
  if (targetZone) dosage.target_zone = targetZone;
  const pace = boundedText(session.pace_target || session.goal_pace_label, 32);
  if (pace) dosage.pace = pace;
  return dosage;
}

function sessionTrace(day, session) {
  const reasonCodes = [session.downgrade_reason, ...(Array.isArray(session.reason_codes) ? session.reason_codes : [])]
    .map((value) => boundedText(value, 64))
    .filter(Boolean)
    .slice(0, 8);
  return {
    date: boundedText(day.date, 10),
    kind: boundedText(session.kind, 12),
    role: sessionRole(session),
    dosage: dosageTrace(session),
    downgrade_reason_codes: [...new Set(reasonCodes)],
  };
}

function summarizeWeek(week, weekIndex) {
  const sessions = weekDays(week).flatMap((day) => planSchema.daySessions(day).map((session) => ({ day, session })));
  const runs = sessions.filter(({ session }) => session.kind === 'run');
  const longRuns = runs.filter(({ session }) => isLongRun(session));
  const quality = runs.filter(({ session }) => runWorkoutTaxonomy.isQualityWorkout(session.workout_id));
  const strengthConflicts = weekDays(week).filter((day) => {
    const daySessions = planSchema.daySessions(day);
    return daySessions.some(isDemandingRun) && daySessions.some(isLowerBodyStrength);
  }).map((day) => boundedText(day.date, 10)).filter(Boolean);
  return {
    week: Number(week.week || weekIndex + 1),
    start_date: boundedText(week.startDate || week.start_date, 10),
    phase: boundedText(week.phase, 24),
    purpose: boundedText(week.purpose || week.weekPurpose, 80),
    weekly_miles: Number(runs.reduce((sum, { session }) => sum + (finite(session.distance_miles) || 0), 0).toFixed(2)),
    long_run_miles: longRuns.length
      ? Math.max(...longRuns.map(({ session }) => finite(session.distance_miles) || 0))
      : null,
    long_run_minutes: longRuns.length
      ? Math.max(...longRuns.map(({ session }) => finite(session.duration_min) || 0))
      : null,
    quality_roles: quality.map(({ session }) => sessionRole(session)).filter(Boolean),
    strength_sessions: sessions.filter(({ session }) => session.kind === 'lift').length,
    strength_conflict_dates: strengthConflicts,
  };
}

function summarizePlan(plan = {}) {
  const weeks = planWeeks(plan).map(summarizeWeek);
  const sessions = planWeeks(plan).flatMap((week) => weekDays(week).flatMap((day) => (
    planSchema.daySessions(day).map((session) => sessionTrace(day, session))
  )));
  const qualityDistribution = {};
  for (const session of sessions) {
    if (!session.role || !runWorkoutTaxonomy.isQualityWorkout(session.role)) continue;
    qualityDistribution[session.role] = (qualityDistribution[session.role] || 0) + 1;
  }
  return {
    feasibility: boundedText(plan.overall_feasibility, 24),
    reason_codes: [...new Set((Array.isArray(plan.reasons) ? plan.reasons : [])
      .map((value) => boundedText(value, 64)).filter(Boolean))],
    weekly_curve: weeks,
    quality_distribution: qualityDistribution,
    strength_conflicts: weeks.flatMap((week) => week.strength_conflict_dates),
    sessions,
  };
}

function inputSources(snapshot = {}) {
  const context = snapshot.context || {};
  const history = context.history || {};
  const recovery = context.recovery || {};
  return {
    planning_date_local: boundedText(snapshot.planning_date_local, 10),
    checkin_date: boundedText(context.checkin?.date, 10),
    health_synced_at: boundedText(recovery.syncedAt, 40),
    latest_run_date: boundedText(history.acuteRunLoad?.latestRun?.date, 10),
    performance_anchor_date: boundedText(history.performanceProfile?.targetAnchor?.date, 10),
    recent_run_count: finite(history.recentRunCount),
    recent_lift_count: finite(history.recentLiftCount),
    weekly_baseline_source: boundedText(history.mileageBaseline?.source, 40),
  };
}

function safetyConstraints(snapshot = {}) {
  const context = snapshot.context || {};
  return {
    active_injury: Boolean(context.safety?.activeInjury),
    comeback_mode: Boolean(context.safety?.comebackMode),
    injury_notes_present: Boolean(context.safety?.injuryNotesPresent),
    recovery_state: boundedText(context.recovery?.state, 24),
    recovery_data_available: Boolean(context.recovery?.dataAvailable),
  };
}

function comparison(activeSummary, candidateSummary) {
  const activeByStart = new Map(activeSummary.weekly_curve.map((week) => [week.start_date || String(week.week), week]));
  return {
    weekly_curve: candidateSummary.weekly_curve.map((week) => {
      const prior = activeByStart.get(week.start_date || String(week.week));
      return {
        week: week.week,
        start_date: week.start_date,
        active_miles: prior?.weekly_miles ?? null,
        candidate_miles: week.weekly_miles,
        delta_miles: prior ? Number((week.weekly_miles - prior.weekly_miles).toFixed(2)) : null,
        active_long_run_miles: prior?.long_run_miles ?? null,
        candidate_long_run_miles: week.long_run_miles,
      };
    }),
    active_quality_distribution: activeSummary.quality_distribution,
    candidate_quality_distribution: candidateSummary.quality_distribution,
    active_strength_conflicts: activeSummary.strength_conflicts,
    candidate_strength_conflicts: candidateSummary.strength_conflicts,
    active_feasibility: activeSummary.feasibility,
    candidate_feasibility: candidateSummary.feasibility,
  };
}

function buildPlanDiagnosticBundle({ targetUserId, candidate }) {
  const diagnostics = candidate?.diagnostics || {};
  const activeSummary = summarizePlan(diagnostics.active_plan_data || {});
  const candidateSummary = summarizePlan(candidate?.plan || {});
  const bundle = {
    schema_version: 1,
    engine_mode: RACE_PLAN_POLICY_V1.rollout.engineMode,
    engine_version: boundedText(diagnostics.trace?.engine_version || candidate?.plan?.engineVersion, 64),
    target_ref: `sha256:${canonicalHash(String(targetUserId || ''))}`,
    active_plan: {
      training_plan_id: diagnostics.active_plan?.trainingPlanId || null,
      user_plan_id: diagnostics.active_plan?.userPlanId || null,
      plan_version: diagnostics.active_plan?.planVersion ?? null,
      summary: activeSummary,
    },
    candidate: {
      id: candidate?.id || null,
      hash: candidate?.candidateHash || null,
      feasibility: candidateSummary.feasibility,
      reason_codes: candidateSummary.reason_codes,
      validation: diagnostics.trace?.validation || null,
      summary: candidateSummary,
    },
    input_sources: inputSources(diagnostics.snapshot || {}),
    active_safety_constraints: safetyConstraints(diagnostics.snapshot || {}),
    comparison: comparison(activeSummary, candidateSummary),
  };
  const redacted = redactSnapshotValue(bundle);
  assertBoundedJson(redacted, RACE_PLAN_POLICY_V1.diagnostics.maximumResponseBytes, 'plan diagnostic response');
  return redacted;
}

function parseArtifactPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function pseudonymizeArtifactPayload(value, targetUserId, targetRef) {
  if (Array.isArray(value)) {
    return value.map((entry) => pseudonymizeArtifactPayload(entry, targetUserId, targetRef));
  }
  if (!value || typeof value !== 'object') return value === targetUserId ? targetRef : value;
  return Object.keys(value).sort().reduce((result, key) => {
    const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const nested = value[key];
    if (['athlete_id', 'user_id', 'owner_id', 'attributed_by_user_id'].includes(normalized)) {
      result[key] = nested == null ? null : targetRef;
    } else {
      result[key] = pseudonymizeArtifactPayload(nested, targetUserId, targetRef);
    }
    return result;
  }, {});
}

function diagnosticArtifactError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  if (details) error.details = details;
  return error;
}

function nonEmptyText(value, maximum = 200) {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= maximum;
}

function positiveRevision(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 1;
}

function hashIdentity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return HASH_PATTERN.test(normalized) ? normalized.replace(/^sha256:/, '') : null;
}

function sameHash(left, right) {
  const leftIdentity = hashIdentity(left);
  return leftIdentity !== null && leftIdentity === hashIdentity(right);
}

function sameCanonicalValue(left, right) {
  try {
    return canonicalHash(left) === canonicalHash(right);
  } catch (_error) {
    return false;
  }
}

function releaseRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  return RELEASE_REVISION_PATTERN.test(revision) ? revision : null;
}

function validGenerationTimestamp(value) {
  const timestamp = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    && Number.isFinite(Date.parse(timestamp));
}

function goalRevisionMap(goalSet) {
  if (!goalSet || !Array.isArray(goalSet.goals) || !goalSet.goals.length) return null;
  const revisions = {};
  for (const goal of goalSet.goals) {
    if (!nonEmptyText(goal?.goal_id) || !positiveRevision(goal?.source_revision)) return null;
    revisions[goal.goal_id] = Number(goal.source_revision);
  }
  return Object.fromEntries(Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right)));
}

function c4StageChecks(byKind) {
  const evidence = byKind.get('evidence_snapshot')?.payload_json;
  const athlete = byKind.get('athlete_state')?.payload_json;
  const planning = byKind.get('planning_decision')?.payload_json;
  const candidate = byKind.get('candidate_week')?.payload_json;
  const validator = byKind.get('validator_result')?.payload_json;
  const canonical = byKind.get('canonical_session_set')?.payload_json;
  const surface = byKind.get('surface_manifest')?.payload_json;
  const safetyState = athlete?.safety_state;
  const stageComplete = {
    evidence_identity: Boolean(evidence && nonEmptyText(evidence.evidence_snapshot_id)),
    athlete_state: Boolean(athlete && positiveRevision(athlete.athlete_state_revision)),
    goal_set: Boolean(goalRevisionMap(planning?.goal_set)),
    recent_normal_safety_state: Boolean(
      athlete?.recent_normal_running
      && nonEmptyText(athlete.recent_normal_running.status, 64)
      && safetyState && nonEmptyText(safetyState.action, 64)
      && sameHash(athlete.safety_state_hash, `sha256:${canonicalHash(safetyState)}`)
    ),
    phase_decision: Boolean(
      planning?.phase_decision
      && nonEmptyText(planning.phase_decision.phase, 64)
      && Array.isArray(planning.phase_decision.reason_codes)
    ),
    planning_decision: Boolean(
      planning && nonEmptyText(planning.decision_id)
      && hashIdentity(planning.decision_hash)
      && nonEmptyText(planning.planning_date_local, 10)
      && Array.isArray(planning.candidate_ids) && planning.candidate_ids.length
      && nonEmptyText(planning.selected_candidate_id)
      && hashIdentity(planning.selected_candidate_hash)
    ),
    candidate_set: Boolean(candidate && Array.isArray(candidate.candidates) && candidate.candidates.length),
    validator_receipts: Boolean(validator && Array.isArray(validator.results) && validator.results.length),
    canonical_sessions: Boolean(
      canonical?.canonical_sessions_materialized === true
      && Array.isArray(canonical.sessions) && canonical.sessions.length
      && hashIdentity(canonical.content_hash)
    ),
    plan_revision: Boolean(canonical && nonEmptyText(canonical.plan_id) && positiveRevision(canonical.plan_revision)),
    surface_identity: Boolean(
      surface?.schema_version === 'goal_backward_surface_manifest_v1'
      && surface.status === 'accepted'
      && surface.v24_surface_enabled === true
      && ['preview', 'on'].includes(surface.feature_mode)
      && surface.identity && typeof surface.identity === 'object' && !Array.isArray(surface.identity)
      && Array.isArray(surface.sessions) && surface.sessions.length
    ),
  };
  return C4_STAGE_DEFINITIONS.map(([stage, reasonCode]) => ({
    stage,
    complete: stageComplete[stage] === true,
    ...(!stageComplete[stage] ? { reason_code: reasonCode } : {}),
  }));
}

function pipelineReasonCodes(normalizedArtifacts) {
  const validation = validatePipelineLinks(normalizedArtifacts);
  if (validation.valid) return [];
  const mapped = [];
  for (const error of validation.errors) {
    if (error.code === 'PIPELINE_PARENT_MISMATCH' || error.code === 'PIPELINE_ROOT_PARENT_INVALID') {
      mapped.push('C4_PIPELINE_PARENT_MISMATCH');
    } else if (error.code === 'PIPELINE_OWNER_MISMATCH') {
      mapped.push('C4_PIPELINE_OWNER_MISMATCH');
    } else if (error.code === 'PIPELINE_DECISION_MISMATCH' || error.code === 'PIPELINE_DECISION_LINK_REQUIRED') {
      mapped.push('C4_PIPELINE_DECISION_MISMATCH');
    } else if (error.code === 'PIPELINE_CANDIDATE_MISMATCH' || error.code === 'PIPELINE_CANDIDATE_LINK_REQUIRED') {
      mapped.push('C4_PIPELINE_CANDIDATE_MISMATCH');
    } else if (error.code === 'PIPELINE_ARTIFACT_KIND_DUPLICATE' || error.code === 'PIPELINE_ARTIFACT_ID_DUPLICATE') {
      mapped.push('C4_PIPELINE_STAGE_DUPLICATE');
    } else if (!['PIPELINE_ARTIFACT_MISSING'].includes(error.code)) {
      mapped.push('C4_PIPELINE_INVALID');
    }
  }
  return [...new Set(mapped)];
}

function releaseIdentityEvaluation({ byKind, candidateRow, reasonCodes }) {
  const evidenceArtifact = byKind.get('evidence_snapshot');
  const evidence = evidenceArtifact?.payload_json || {};
  const release = evidence.release_identity && typeof evidence.release_identity === 'object'
    && !Array.isArray(evidence.release_identity) ? evidence.release_identity : {};
  const sourceRevision = releaseRevision(release.source_revision);
  const deploymentRevision = releaseRevision(release.deployment_revision);
  const policyVersion = nonEmptyText(release.policy_version, 128) ? release.policy_version : null;
  const engineVersion = nonEmptyText(release.engine_version, 128) ? release.engine_version : null;
  const featureMode = ['off', 'shadow', 'preview', 'on'].includes(release.feature_mode)
    ? release.feature_mode : null;
  const generationTimestamp = validGenerationTimestamp(release.generation_timestamp)
    ? release.generation_timestamp : null;
  if (!policyVersion) reasonCodes.push('C4_POLICY_VERSION_MISSING');
  if (!engineVersion) reasonCodes.push('C4_ENGINE_VERSION_MISSING');
  if (!featureMode) reasonCodes.push('C4_FEATURE_MODE_MISSING');
  if (!generationTimestamp) reasonCodes.push('C4_GENERATION_TIMESTAMP_MISSING');
  if (!sourceRevision) reasonCodes.push('C4_SOURCE_REVISION_MISSING');
  if (!deploymentRevision) reasonCodes.push('C4_DEPLOYMENT_REVISION_MISSING');
  if (sourceRevision && deploymentRevision && sourceRevision !== deploymentRevision) {
    reasonCodes.push('C4_RELEASE_REVISION_MISMATCH');
  }
  const artifactPoliciesMatch = policyVersion && normalizedPolicies(byKind).every((value) => value === policyVersion);
  const candidateIdentityMatches = !candidateRow || (
    candidateRow.policy_version === policyVersion
    && candidateRow.engine_version === engineVersion
    && candidateRow.feature_mode === featureMode
  );
  const candidatePayload = byKind.get('candidate_week')?.payload_json;
  const surfacePayload = byKind.get('surface_manifest')?.payload_json;
  const artifactIdentityMatches = artifactPoliciesMatch
    && policyVersion === PLANNING_POLICY_VERSION
    && engineVersion === C4_ENGINE_VERSION
    && candidatePayload?.authoritative_engine === engineVersion
    && surfacePayload?.feature_mode === featureMode
    && releaseRevision(evidence.source_revision) === sourceRevision
    && releaseRevision(evidence.deployment_revision) === deploymentRevision
    && generationTimestamp === evidenceArtifact?.created_at;
  if (policyVersion && engineVersion && featureMode && generationTimestamp
    && (!candidateIdentityMatches || !artifactIdentityMatches)) {
    reasonCodes.push('C4_RELEASE_IDENTITY_MISMATCH');
  }
  return {
    policy_version: policyVersion,
    engine_version: engineVersion,
    feature_mode: featureMode,
    generation_timestamp: generationTimestamp,
    source_revision: sourceRevision,
    deployment_revision: deploymentRevision,
    revisions_match: Boolean(sourceRevision && deploymentRevision && sourceRevision === deploymentRevision),
  };
}

function normalizedPolicies(byKind) {
  return ARTIFACT_KINDS.map((kind) => byKind.get(kind)?.policy_version).filter((value) => value !== undefined);
}

function candidateAndCanonicalEvaluation({ byKind, candidateRow, scopedTargetId, scopedDecisionId, reasonCodes }) {
  const athlete = byKind.get('athlete_state')?.payload_json || {};
  const planningArtifact = byKind.get('planning_decision');
  const planning = planningArtifact?.payload_json || {};
  const candidateArtifact = byKind.get('candidate_week');
  const candidateSet = candidateArtifact?.payload_json?.candidates || [];
  const validatorResults = byKind.get('validator_result')?.payload_json?.results || [];
  const canonical = byKind.get('canonical_session_set')?.payload_json || {};
  const surface = byKind.get('surface_manifest')?.payload_json || {};
  const surfaceIdentity = surface.identity || {};
  const selectedId = nonEmptyText(planning.selected_candidate_id) ? planning.selected_candidate_id : null;
  const selectedHash = hashIdentity(planning.selected_candidate_hash);
  const memberById = selectedId ? candidateSet.find((entry) => entry?.candidate_id === selectedId) : null;
  const selectedMember = memberById && selectedHash && sameHash(memberById.candidate_hash, selectedHash)
    ? memberById : null;
  if (selectedId && !memberById) reasonCodes.push('C4_SELECTED_CANDIDATE_NOT_IN_SET');
  else if (memberById && (!selectedHash || !sameHash(memberById.candidate_hash, selectedHash))) {
    reasonCodes.push('C4_SELECTED_CANDIDATE_HASH_MISMATCH');
  }
  if (selectedMember && (!Array.isArray(planning.candidate_ids) || !planning.candidate_ids.includes(selectedId))) {
    reasonCodes.push('C4_SELECTED_CANDIDATE_NOT_IN_SET');
  }
  const validatorReceipt = selectedMember ? validatorResults.find((entry) => (
    entry?.candidate_id === selectedId && sameHash(entry.candidate_hash, selectedHash)
  )) : null;
  if (selectedMember && (!validatorReceipt || validatorReceipt.valid !== true
    || !Array.isArray(validatorReceipt.validators_executed) || !validatorReceipt.validators_executed.length)) {
    reasonCodes.push('C4_VALIDATOR_RECEIPT_MISMATCH');
  }
  const canonicalMatches = selectedMember
    && canonical.selected_candidate_id === selectedId
    && canonical.candidate_id === selectedId
    && sameHash(canonical.selected_candidate_hash, selectedHash)
    && sameHash(canonical.candidate_hash, selectedHash)
    && canonical.decision_id === scopedDecisionId
    && sameHash(canonical.decision_hash, planning.decision_hash);
  if (selectedMember && !canonicalMatches) reasonCodes.push('C4_CANONICAL_PLAN_BINDING_MISMATCH');

  const goalRevisions = goalRevisionMap(planning.goal_set);
  const surfaceMatches = canonicalMatches
    && surfaceIdentity.decision_id === scopedDecisionId
    && sameHash(surfaceIdentity.decision_hash, planning.decision_hash)
    && surfaceIdentity.candidate_id === selectedId
    && sameHash(surfaceIdentity.candidate_hash, selectedHash)
    && surfaceIdentity.plan_id === canonical.plan_id
    && Number(surfaceIdentity.plan_revision) === Number(canonical.plan_revision)
    && sameHash(surfaceIdentity.canonical_session_set_hash, canonical.content_hash)
    && Number(surfaceIdentity.athlete_state_revision) === Number(athlete.athlete_state_revision)
    && sameHash(surfaceIdentity.safety_state_hash, athlete.safety_state_hash)
    && sameCanonicalValue(surfaceIdentity.goal_revisions, goalRevisions)
    && sameCanonicalValue(surface.sessions, canonical.sessions)
    && (!candidateRow || (
      Number(surfaceIdentity.candidate_revision) === Number(candidateRow.candidate_revision)
      && Number(surface.surface_revision) === Number(candidateRow.surface_revision)
    ));
  if (surface.identity && !surfaceMatches) reasonCodes.push('C4_SURFACE_IDENTITY_STALE');

  let applyEnvelope = null;
  if (!candidateRow) {
    reasonCodes.push('C4_CANONICAL_BINDING_MISSING');
  } else if (candidateRow.user_id !== scopedTargetId || candidateRow.decision_id !== scopedDecisionId) {
    reasonCodes.push('C4_CANONICAL_BINDING_SCOPE_MISMATCH');
  } else {
    try {
      applyEnvelope = buildGoalBackwardApplyEnvelope(candidateRow);
    } catch (_error) {
      reasonCodes.push('C4_CANONICAL_BINDING_MALFORMED');
    }
  }
  const expectedCandidateRowId = candidateArtifact?.plan_generation_candidate_id || null;
  const applyMatches = applyEnvelope
    && applyEnvelope.candidate_id === expectedCandidateRowId
    && sameHash(applyEnvelope.candidate_hash, selectedHash)
    && applyEnvelope.decision_id === scopedDecisionId
    && sameHash(applyEnvelope.decision_hash, planning.decision_hash)
    && applyEnvelope.decision_artifact.artifact_id === planningArtifact?.id
    && Number(applyEnvelope.decision_artifact.revision) === Number(planningArtifact?.revision)
    && sameHash(applyEnvelope.decision_artifact.content_hash, planningArtifact?.content_hash)
    && (Number(applyEnvelope.active_plan.plan_revision) === Number(planning.plan_revision)
      || (applyEnvelope.active_plan.plan_revision === null && Number(planning.plan_revision) === 0))
    && Number(applyEnvelope.athlete_state_revision) === Number(athlete.athlete_state_revision)
    && sameHash(applyEnvelope.safety_state_hash, athlete.safety_state_hash)
    && sameCanonicalValue(applyEnvelope.goal_revisions, goalRevisions)
    && Number(applyEnvelope.candidate_revision) === Number(surfaceIdentity.candidate_revision)
    && Number(applyEnvelope.surface_revision) === Number(surface.surface_revision);
  if (applyEnvelope && !applyMatches) reasonCodes.push('C4_CANONICAL_BINDING_MISMATCH');
  const bindingFailureCodes = new Set([
    'C4_SELECTED_CANDIDATE_NOT_IN_SET',
    'C4_SELECTED_CANDIDATE_HASH_MISMATCH',
    'C4_VALIDATOR_RECEIPT_MISMATCH',
    'C4_CANONICAL_PLAN_BINDING_MISMATCH',
    'C4_SURFACE_IDENTITY_STALE',
    'C4_CANONICAL_BINDING_MISSING',
    'C4_CANONICAL_BINDING_SCOPE_MISMATCH',
    'C4_CANONICAL_BINDING_MALFORMED',
    'C4_CANONICAL_BINDING_MISMATCH',
  ]);
  return {
    verified: Boolean(selectedMember && validatorReceipt?.valid === true && canonicalMatches && surfaceMatches
      && applyMatches && !reasonCodes.some((code) => bindingFailureCodes.has(code))),
    selected_candidate_id: selectedId,
    selected_candidate_hash: selectedHash ? `sha256:${selectedHash}` : null,
    plan_id: nonEmptyText(canonical.plan_id) ? canonical.plan_id : null,
    plan_revision: positiveRevision(canonical.plan_revision) ? Number(canonical.plan_revision) : null,
    canonical_session_set_hash: hashIdentity(canonical.content_hash)
      ? `sha256:${hashIdentity(canonical.content_hash)}` : null,
  };
}

function evaluateC4ProductionCompleteness({ normalizedArtifacts, candidateRow, scopedTargetId, scopedDecisionId }) {
  const byKind = new Map(normalizedArtifacts.map((artifact) => [artifact.artifact_kind, artifact]));
  const stages = c4StageChecks(byKind);
  const reasonCodes = stages.filter((stage) => !stage.complete).map((stage) => stage.reason_code);
  reasonCodes.push(...pipelineReasonCodes(normalizedArtifacts));
  const releaseIdentity = releaseIdentityEvaluation({ byKind, candidateRow, reasonCodes });
  const canonicalBinding = candidateAndCanonicalEvaluation({
    byKind,
    candidateRow,
    scopedTargetId,
    scopedDecisionId,
    reasonCodes,
  });
  const stableReasonCodes = [...new Set(reasonCodes)];
  return {
    production_complete: stableReasonCodes.length === 0,
    reason_codes: stableReasonCodes,
    stages,
    release_identity: releaseIdentity,
    canonical_binding: canonicalBinding,
  };
}

function buildDecisionArtifactDiagnosticBundle({ targetUserId, decisionId, artifactRows = [], candidateRow = null }) {
  const scopedTargetId = String(targetUserId || '').trim();
  const scopedDecisionId = String(decisionId || '').trim();
  if (!scopedTargetId || !scopedDecisionId || scopedDecisionId.length > 200) {
    throw diagnosticArtifactError('A bounded owner and decision ID are required.', 'DIAGNOSTIC_ARTIFACT_SCOPE_INVALID');
  }
  if (!Array.isArray(artifactRows) || artifactRows.length > 32) {
    throw diagnosticArtifactError('Diagnostic artifact results must be bounded to 32 rows.', 'DIAGNOSTIC_ARTIFACT_LIMIT_EXCEEDED');
  }
  const targetRef = `sha256:${canonicalHash(scopedTargetId)}`;
  const normalizedArtifacts = [];
  const artifacts = artifactRows.map((row, index) => {
    const payload = parseArtifactPayload(row?.payload_json);
    if (!payload) {
      throw diagnosticArtifactError('Stored artifact payload is invalid.', 'DIAGNOSTIC_ARTIFACT_INVALID', { index });
    }
    const violations = findArtifactRedactionViolations(payload, `artifacts[${index}].payload_json`);
    if (violations.length) {
      throw diagnosticArtifactError(
        'Stored artifact contains a prohibited secret or PII key.',
        'DIAGNOSTIC_ARTIFACT_REDACTION_REQUIRED',
        { paths: violations }
      );
    }
    const normalized = {
      id: row.id,
      user_id: row.user_id,
      artifact_kind: row.artifact_kind,
      decision_id: row.decision_id,
      parent_artifact_id: row.parent_artifact_id ?? null,
      plan_generation_candidate_id: row.plan_generation_candidate_id ?? null,
      schema_version: row.schema_version,
      policy_version: row.policy_version,
      revision: Number(row.revision),
      content_hash: row.content_hash,
      payload_json: payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
    const validation = validatePipelineArtifact(normalized);
    if (!validation.valid || normalized.user_id !== scopedTargetId || normalized.decision_id !== scopedDecisionId) {
      throw diagnosticArtifactError(
        'Stored artifact failed scope or contract validation.',
        'DIAGNOSTIC_ARTIFACT_INVALID',
        { index, validation: validation.errors }
      );
    }
    const expectedContentHash = `sha256:${canonicalHash(payload)}`;
    const normalizedContentHash = String(normalized.content_hash || '').startsWith('sha256:')
      ? String(normalized.content_hash)
      : `sha256:${normalized.content_hash}`;
    if (normalizedContentHash !== expectedContentHash) {
      throw diagnosticArtifactError(
        'Stored artifact payload does not match its content hash.',
        'DIAGNOSTIC_ARTIFACT_HASH_MISMATCH',
        { index, artifact_id: normalized.id }
      );
    }
    normalizedArtifacts.push(normalized);
    const diagnosticPayload = pseudonymizeArtifactPayload(payload, scopedTargetId, targetRef);
    return {
      id: normalized.id,
      artifact_kind: normalized.artifact_kind,
      decision_id: normalized.decision_id,
      parent_artifact_id: normalized.parent_artifact_id,
      plan_generation_candidate_id: normalized.plan_generation_candidate_id,
      schema_version: normalized.schema_version,
      policy_version: normalized.policy_version,
      revision: normalized.revision,
      content_hash: normalized.content_hash,
      diagnostic_payload_hash: `sha256:${canonicalHash(diagnosticPayload)}`,
      payload_json: diagnosticPayload,
      created_at: normalized.created_at,
    };
  });
  const c4 = evaluateC4ProductionCompleteness({
    normalizedArtifacts,
    candidateRow,
    scopedTargetId,
    scopedDecisionId,
  });
  const bundle = {
    schema_version: 1,
    target_ref: targetRef,
    decision_id: scopedDecisionId,
    artifact_count: artifacts.length,
    ...c4,
    artifacts,
  };
  assertBoundedJson(bundle, RACE_PLAN_POLICY_V1.diagnostics.maximumResponseBytes, 'decision artifact diagnostic response');
  return bundle;
}

function incrementCount(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildGoalBackwardReleaseDiagnosticBundle({ telemetry = [] } = {}) {
  if (!Array.isArray(telemetry) || telemetry.length > 256) {
    throw diagnosticArtifactError(
      'Goal-backward release telemetry must be bounded to 256 records.',
      'DIAGNOSTIC_RELEASE_TELEMETRY_LIMIT_EXCEEDED',
    );
  }
  let records;
  try {
    records = telemetry.map((record) => assertGoalBackwardReleaseTelemetry(record));
  } catch (_error) {
    throw diagnosticArtifactError(
      'A goal-backward release telemetry record failed validation.',
      'DIAGNOSTIC_RELEASE_TELEMETRY_INVALID',
    );
  }
  const modeCounts = {};
  const outcomeCounts = {};
  const surfaceCapabilityCounts = {};
  const reasonCounts = {};
  for (const record of records) {
    incrementCount(modeCounts, record.mode);
    incrementCount(outcomeCounts, record.outcome);
    incrementCount(surfaceCapabilityCounts, record.surface_capability);
    for (const [code, counts] of Object.entries(record.reason_counts)) {
      if (!reasonCounts[code]) reasonCounts[code] = { pass: 0, fail: 0 };
      reasonCounts[code].pass += counts.pass;
      reasonCounts[code].fail += counts.fail;
    }
  }
  const bundle = {
    schema_version: 'goal_backward_release_diagnostic_v1',
    telemetry_schema_version: 'goal_backward_release_telemetry_v1',
    record_count: records.length,
    policy_versions: records[0]?.policy_versions || {},
    mode_counts: sortedCounts(modeCounts),
    outcome_counts: sortedCounts(outcomeCounts),
    reason_counts: sortedCounts(reasonCounts),
    candidate_selection: {
      selected: records.filter((record) => record.candidate_selected).length,
      not_selected: records.filter((record) => !record.candidate_selected).length,
    },
    surface_capability_counts: sortedCounts(surfaceCapabilityCounts),
    revision_mismatch_count: records.filter((record) => record.revision_mismatch).length,
    alerts: evaluateGoalBackwardReleaseAlerts(records),
  };
  assertBoundedJson(bundle, 64 * 1024, 'goal-backward release diagnostic response');
  return bundle;
}

module.exports = {
  buildDecisionArtifactDiagnosticBundle,
  buildGoalBackwardReleaseDiagnosticBundle,
  buildPlanDiagnosticBundle,
  dosageTrace,
  inputSources,
  safetyConstraints,
  summarizePlan,
};
