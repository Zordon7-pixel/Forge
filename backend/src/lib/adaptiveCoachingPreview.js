// Preview adaptation only. The Phase 1 solver remains the prescription authority.
const { canonicalHash } = require('./racePlanPolicy');
const { buildCanonicalPlanFromSessionSet } = require('./planSchema');
const { validateCanonicalSessionSet } = require('./canonicalWorkout');
const lifecycle = require('./planCandidateLifecycle');
const { assertPipelineLinks } = require('./goalBackwardContracts');
const hash = value => `sha256:${canonicalHash(value)}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function build({ prepared, result, planMode }) {
  const selected = result?.selected_candidate;
  const set = selected?.canonical_session_set;
  if (!prepared?.foundation) fail('EVIDENCE_MISSING');
  if (!prepared.source_support || prepared.source_support.source_limited || prepared.source_support.limits?.some(limit =>
    limit.required && limit.status !== 'SUPPORTED')) fail('EVIDENCE_MISSING');
  if (result?.applicable !== true || !['VALID', 'VALID_WITH_TRADEOFFS'].includes(result.status)
    || !selected?.validation?.valid || !selected.canonical_sessions_materialized
    || !set || !validateCanonicalSessionSet(set).valid
    || set.candidate_hash !== selected.candidate_hash || set.decision_hash !== result.decision.decision_hash
    || canonicalHash(set.sessions) !== canonicalHash(selected.sessions)) fail('CANDIDATE_NOT_SELECTED');
  const plan = buildCanonicalPlanFromSessionSet(set);
  const decision = result.decision;
  // A valid schedule does not establish the athlete's race target. Keep the
  // goal-gap evidence status independent of solver validity and use UI labels.
  const goalStatuses = (decision.goal_gap || []).map(gap => gap.legacy_feasibility?.status);
  const feasibility = goalStatuses.includes('at_risk') ? 'at_risk'
    : !goalStatuses.length || goalStatuses.some(status => status !== 'supported') ? 'unvalidated'
      : result.status === 'VALID' ? 'supported' : 'at_risk';
  const reasons = [...new Set([...decision.phase_reason_codes,
    ...(decision.goal_gap || []).flatMap(gap => gap.reason_codes || []),
    ...selected.sessions.flatMap(session => session.purpose_reason_codes || [])])];
  return {
    candidateHash: `sha256:${selected.candidate_hash.replace(/^sha256:/, '')}`,
    plan: { ...plan, planMode: planMode || (selected.sessions.some(session => session.kind === 'lift') ? 'hybrid_maintain' : 'run_only'),
      engineVersion: 'adaptive-joint-solver-v1', goal_backward_engine_version: 'adaptive-joint-solver-v1',
      goal_backward_policy_versions: decision.policy_versions,
      purpose: 'Adaptive coaching preview', overall_feasibility: feasibility, reasons,
      goal_gap: decision.goal_gap, weekly_objectives: decision.weekly_objectives,
      weeks: plan.weeks.map(week => ({ ...week, phase: decision.phase,
        purpose: 'Adaptive coaching preview', weekly_objectives: decision.weekly_objectives })),
    },
    decision: { ...decision, ...prepared.binding,
      evidence_used: [{ evidence_id: prepared.observed_binding, purpose: 'CAPTURED_OBSERVATION_BINDING' }] },
    selected,
    observedBinding: prepared.observed_binding,
  };
}

function artifacts({ userId, candidateId, prepared, result, preview, buildSurface }) {
  if (result.artifacts.length !== 6) fail('CANDIDATE_NOT_SELECTED');
  const rows = [];
  for (const source of result.artifacts) {
    const payload = { ...source.payload_json, plan_generation_candidate_ref: hash(candidateId) };
    if (source.artifact_kind === 'candidate_week') Object.assign(payload, {
      authoritative_engine: 'adaptive-joint-solver-v1', feature_mode: 'preview',
      observed_binding: prepared.observed_binding, source_support: prepared.source_support,
      rest_days: result.rest_days, strength_dose_receipt: result.strength_dose_receipt,
    });
    rows.push(lifecycle.buildPipelineArtifact({ userId, kind: source.artifact_kind,
      decisionId: result.decision.decision_id, parentArtifactId: rows.at(-1)?.id || null,
      planGenerationCandidateId: candidateId, payload, createdAt: source.created_at }));
  }
  const bindings = { ...lifecycle.buildGoalBackwardShadowBindings({ decision: preview.decision,
    decisionArtifact: rows[2], selectedCandidate: preview.selected, currentCandidateHash: preview.candidateHash }),
    feature_mode: 'preview', selected_candidate_hash: preview.candidateHash };
  const surface = buildSurface({ featureMode: 'preview', decision: result.decision,
    selectedCandidate: preview.selected, canonicalSessionSet: preview.selected.canonical_session_set,
    plan: preview.plan, planGenerationCandidateRef: hash(candidateId),
    currentCandidateHash: preview.candidateHash, goalRevisions: bindings.goal_revisions_json,
    athleteStateRevision: bindings.athlete_state_revision, safetyStateHash: bindings.safety_state_hash });
  if (!surface) fail('CANDIDATE_NOT_SELECTED');
  // Review does not grant accepted-session/export authority. Canonical sessions
  // retain their exact identity; the envelope closes execution at the surface.
  Object.assign(surface, { status: 'preview', authoritative_engine: 'adaptive-joint-solver-v1',
    surface_capability: 'PREVIEW_ONLY', apply_disabled: true });
  rows.push(lifecycle.buildPipelineArtifact({ userId, kind: 'surface_manifest',
    decisionId: result.decision.decision_id, parentArtifactId: rows.at(-1).id,
    planGenerationCandidateId: candidateId, payload: surface, createdAt: result.artifacts[0].created_at }));
  return { artifacts: assertPipelineLinks(rows), bindings, surface };
}

async function persist({ tx, row, bundle }) {
  const rejections = await lifecycle.loadCandidateRejectionsForFingerprint({ tx, userId: row.user_id,
    fingerprint: bundle.bindings.material_change_json.apply_bindings });
  if (rejections.some(rejection => lifecycle.candidateRejectionMatches(rejection, {
    candidate_hash: row.candidate_hash, ...bundle.bindings.material_change_json.apply_bindings,
  }))) fail('IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
  const fields = ['id', 'user_id', 'status', 'training_plan_id', 'user_plan_id', 'active_plan_version',
    'planning_input_revision', 'planning_date_local', 'timezone_offset_minutes', 'input_hash', 'candidate_hash',
    'engine_version', 'policy_version', 'invariant_version', 'planning_snapshot_json', 'candidate_plan_json',
    'generation_trace_json', 'expires_at', 'decision_id', 'candidate_revision', 'athlete_state_revision',
    'safety_state_hash', 'goal_revisions_json', 'lock_revision', 'edit_revision', 'surface_revision',
    'export_revision', 'feature_mode', 'selected_candidate_hash', 'material_change_json'];
  const stored = { ...row, ...bundle.bindings };
  const values = fields.map(field => field.endsWith('_json') ? JSON.stringify(stored[field]) : stored[field] ?? null);
  await tx.run(`INSERT INTO plan_generation_candidates (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, values);
  await lifecycle.persistPipelineArtifacts({ tx, artifacts: bundle.artifacts, requireCompleteLinks: true });
  const read = await tx.get('SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=?', [row.id, row.user_id]);
  lifecycle.validateStoredGoalBackwardCandidateBindings(read, { allowedModes: ['preview'] });
  if (!read || fields.some((field, index) => field.endsWith('_json')
    ? hash(typeof read[field] === 'string' ? JSON.parse(read[field]) : read[field]) !== hash(stored[field])
    : (read[field] instanceof Date ? read[field].toISOString() : read[field]) !== values[index])) fail('READBACK_INVALID');
  const readArtifacts = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=? AND user_id=?', [row.id, row.user_id]);
  if (readArtifacts.length !== 7) fail('READBACK_INVALID');
  const ordered = bundle.artifacts.map(expected => {
    const actual = readArtifacts.find(item => item.id === expected.id);
    if (!actual) fail('READBACK_INVALID');
    const payload = typeof actual.payload_json === 'string' ? JSON.parse(actual.payload_json) : actual.payload_json;
    if (hash(payload) !== expected.content_hash || actual.content_hash !== expected.content_hash
      || actual.plan_generation_candidate_id !== row.id || actual.user_id !== row.user_id) fail('READBACK_INVALID');
    return { ...actual, created_at: actual.created_at instanceof Date ? actual.created_at.toISOString() : actual.created_at, payload_json: payload };
  });
  assertPipelineLinks(ordered);
}
module.exports = { build, artifacts, persist };
