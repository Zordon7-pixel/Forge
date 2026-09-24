// Preview and ON adaptation. The Phase 1 solver remains the prescription authority.
const { canonicalHash } = require('./racePlanPolicy');
const { buildCanonicalPlanFromSessionSet } = require('./planSchema');
const { validateCanonicalSessionSet } = require('./canonicalWorkout');
const lifecycle = require('./planCandidateLifecycle');
const { assertPipelineLinks } = require('./goalBackwardContracts');
const hash = value => `sha256:${canonicalHash(value)}`;
const fail = (code, generationFailure = null) => { throw Object.assign(new Error(code), { code, generationFailure }); };

// Closed public explanations only: never expose captured evidence or solver payloads.
const GENERATION_FAILURES = Object.freeze({
  SOURCE_UNAVAILABLE: 'Required training data could not be loaded. The planner cannot verify a plan from the available data. Try previewing again.',
  SOURCE_STALE: 'Required training data is out of date. Refresh your training data and preview again.',
  SOURCE_CORRUPT: 'Required training data could not be verified. The planner cannot safely use these records to build a plan.',
  ACCEPTED_SOURCE_UNAVAILABLE: 'The accepted workout source could not be verified. Recorded totals alone cannot replace its canonical workout identity.',
  OCCUPANCY_UNAVAILABLE: 'The planner could not verify existing calendar occupancy. This is a data verification limitation, not a finding that your schedule conflicts.',
  CANDIDATE_WINDOW_STALE: 'This preview was built with an older calendar window. Preview again to include your race. Your active plan was not changed.',
  REQUIRED_EXPOSURE_UNPLACEABLE: 'The current planner could not place its required workouts within the selected dates and recovery rules. This does not establish that every possible schedule is unsafe.',

  CANONICAL_STRENGTH_LINK_ABSENT: 'The planner cannot verify completed strength work linked to an accepted canonical workout. Recorded lifting totals or equipment selection alone do not satisfy this requirement. First-time strength-plan setup is not currently supported on this path.',
  MEASURED_RUN_WORK_SOURCE_ABSENT: 'The current planner needs measured work segments linked to completed key runs before it can prescribe the required race work. Sync those completed workouts and preview again.',
  MEASURED_STATION_SOURCE_ABSENT: 'Measured station work is missing for this HYROX schedule. Sync the required station measurements and preview again.',
  COMPLETE_TIMED_OWNED_HYROX_MATERIAL_ABSENT: 'The planner cannot construct this HYROX event workout from the available event measurements. Review the event details and sync completed event-specific workouts.',
  INJURY_SCOPE: 'The current safety restriction prevents the required training sessions. Review your injury and recovery settings before requesting another training plan.',
  MEANINGFUL_DOSE_REQUIRED: 'The available training dose or session time cannot support all required workouts at their minimum useful duration. Review your session time and recent workout records, or request fewer sessions.',
  OBSERVED_FAMILY_DOSE_UNAVAILABLE: 'Recent completed workouts do not establish the dose for the required race-specific sessions. Sync the relevant completed workouts and preview again.',
  EVENT_EXECUTION_MATERIAL_REQUIRED: 'The planner cannot construct the race workout from the available event and workout evidence. Review the event details and sync recent completed runs.',
  CANDIDATE_SEARCH_NODE_BUDGET_EXHAUSTED: 'The planner reached its schedule search limit. This does not establish that your schedule is unsafe. Try different eligible weekdays and preview again.',
});
function generationFailure(prepared, result) {
  const missing = prepared?.source_support?.limits?.filter(limit => limit.required && limit.status !== 'SUPPORTED') || [];
  const reasons = missing.length ? missing.map(limit => limit.reason_code)
    : (result?.deferred_objectives || []).filter(item => ['PRIMARY_KEY', 'ASSESSMENT'].includes(item.role))
      .flatMap(item => item.reason_codes || []);
  const reason = reasons.find(code => Object.hasOwn(GENERATION_FAILURES, code));
  return reason ? { reason_code: reason, message: GENERATION_FAILURES[reason] } : null;
}
function publicGenerationFailure(error) {
  const code = error?.generationFailure?.reason_code || error?.code;
  return Object.hasOwn(GENERATION_FAILURES, code)
    ? { reason_code: code, message: GENERATION_FAILURES[code] } : null;
}

function build({ prepared, result, planMode, featureMode = 'preview' }) {
  if (!['preview', 'on'].includes(featureMode)) fail('INVALID_FEATURE_MODE');
  const purpose = featureMode === 'on' ? 'Adaptive coaching plan' : 'Adaptive coaching preview';
  const selected = result?.selected_candidate;
  const set = selected?.canonical_session_set;
  if (!prepared?.foundation) fail('EVIDENCE_MISSING');
  if (!prepared.source_support || prepared.source_support.source_limited || prepared.source_support.limits?.some(limit =>
    limit.required && limit.status !== 'SUPPORTED')) fail('EVIDENCE_MISSING', generationFailure(prepared, result));
  if (result?.applicable !== true || !['VALID', 'VALID_WITH_TRADEOFFS'].includes(result.status)
    || !selected?.validation?.valid || !selected.canonical_sessions_materialized
    || !set || !validateCanonicalSessionSet(set).valid
    || set.candidate_hash !== selected.candidate_hash || set.decision_hash !== result.decision.decision_hash
    || canonicalHash(set.sessions) !== canonicalHash(selected.sessions)) fail('CANDIDATE_NOT_SELECTED', generationFailure(prepared, result));
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
      purpose, overall_feasibility: feasibility, reasons,
      goal_gap: decision.goal_gap, weekly_objectives: decision.weekly_objectives,
      ...(decision.calendar_window ? { candidate_window_start_local: decision.calendar_window.start_date,
        candidate_window_end_local: decision.calendar_window.end_date,
        ...(decision.calendar_windows ? { calendar_windows: decision.calendar_windows } : {}) } : {}),
      weeks: plan.weeks.map(week => {
        const window = decision.calendar_windows?.find(w => w.start_date >= week.startDate && w.start_date <= require('./racePlanPolicy').addDays(week.startDate, 6));
        return { ...week, phase: window?.phase || decision.phase,
          purpose, weekly_objectives: window?.weekly_objectives || decision.weekly_objectives };
      }),
    },
    decision: { ...decision, ...prepared.binding,
      evidence_used: [{ evidence_id: prepared.observed_binding, purpose: 'CAPTURED_OBSERVATION_BINDING' }] },
    selected,
    observedBinding: prepared.observed_binding,
  };
}

function artifacts({ userId, candidateId, prepared, result, preview, buildSurface, featureMode = 'preview' }) {
  if (!['preview', 'on'].includes(featureMode)) fail('INVALID_FEATURE_MODE');
  if (result.artifacts.length !== 6) fail('CANDIDATE_NOT_SELECTED');
  const rows = [];
  for (const source of result.artifacts) {
    const payload = { ...source.payload_json, plan_generation_candidate_ref: hash(candidateId) };
    if (featureMode === 'on' && source.artifact_kind === 'canonical_session_set') Object.assign(payload, {
      selected_candidate_id: preview.selected.canonical_session_set.candidate_id,
      selected_candidate_hash: preview.selected.candidate_hash,
    });
    if (source.artifact_kind === 'candidate_week') Object.assign(payload, {
      authoritative_engine: 'adaptive-joint-solver-v1', feature_mode: featureMode,
      observed_binding: prepared.observed_binding, source_support: prepared.source_support,
      rest_days: result.rest_days, strength_dose_receipt: result.strength_dose_receipt,
    });
    rows.push(lifecycle.buildPipelineArtifact({ userId, kind: source.artifact_kind,
      decisionId: result.decision.decision_id, parentArtifactId: rows.at(-1)?.id || null,
      planGenerationCandidateId: candidateId, payload, createdAt: source.created_at }));
  }
  const bindings = { ...lifecycle.buildGoalBackwardShadowBindings({ decision: preview.decision,
    decisionArtifact: rows[2], selectedCandidate: preview.selected, currentCandidateHash: preview.candidateHash }),
    feature_mode: featureMode, selected_candidate_hash: preview.candidateHash };
  if (featureMode === 'on') bindings.material_change_json.candidate_prescription_hash
    = require('./goalBackwardValidators').canonicalPrescriptionHash(preview.plan);
  const surface = buildSurface({ featureMode, decision: result.decision,
    selectedCandidate: preview.selected, canonicalSessionSet: preview.selected.canonical_session_set,
    plan: preview.plan, planGenerationCandidateRef: hash(candidateId),
    currentCandidateHash: preview.candidateHash, goalRevisions: bindings.goal_revisions_json,
    athleteStateRevision: bindings.athlete_state_revision, safetyStateHash: bindings.safety_state_hash });
  if (!surface) fail('CANDIDATE_NOT_SELECTED');
  // Review does not grant accepted-session/export authority. Canonical sessions
  // retain their exact identity; the envelope closes execution at the surface.
  Object.assign(surface, { status: 'preview', authoritative_engine: 'adaptive-joint-solver-v1',
    surface_capability: featureMode === 'on' ? 'EXECUTABLE' : 'PREVIEW_ONLY', apply_disabled: featureMode !== 'on' });
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
  lifecycle.validateStoredGoalBackwardCandidateBindings(read, { allowedModes: ['preview', 'on'] });
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
module.exports = { publicGenerationFailure, build, artifacts, persist };
