// Internal SHADOW orchestration. No route/execution/acceptance or clock authority.
const { buildAdaptiveCoachingFoundation } = require('./adaptiveCoachingFoundation');
const { buildAdaptiveCoachingCandidate } = require('./adaptiveCoachingSolver');
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { runCompletionEvidence } = require('./activityReconciliation');
const { buildPipelineArtifact, persistPipelineArtifacts, buildGoalBackwardShadowBindings,
  loadCandidateRejectionsForFingerprint, candidateRejectionMatches, normalizePlanningConstraints } = require('./planCandidateLifecycle');
const { validatePipelineArtifact } = require('./goalBackwardContracts');
const { compare } = require('./adaptiveShadowComparison');
const { localDate, weekday } = require('./adaptiveCoachingValidation');
const KINDS = ['evidence_snapshot', 'athlete_state', 'planning_decision', 'candidate_week', 'validator_result', 'canonical_session_set'];
const REASONS = new Set(['COMPUTED', 'CANDIDATE_DEFERRED', 'SOURCE_UNAVAILABLE', 'SOURCE_CORRUPT',
  'SOURCE_STALE', 'SNAPSHOT_DATE_MISMATCH', 'ACCEPTED_SOURCE_UNAVAILABLE', 'OCCUPANCY_UNAVAILABLE', 'STALE_INPUT',
  'REJECTED_CANDIDATE', 'DIAGNOSTIC_SINK_FAILED', 'PERSISTENCE_FAILED', 'READBACK_INVALID', 'COMPUTATION_FAILED']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => `sha256:${canonicalHash(value)}`;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function reason(error) { return REASONS.has(error?.code) ? error.code
  : error?.code === 'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED' ? 'REJECTED_CANDIDATE'
  : error?.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' ? 'ACCEPTED_SOURCE_UNAVAILABLE' : 'COMPUTATION_FAILED'; }
const diagnostics = [];
function diagnose(sink, code) {
  const payload = Object.freeze({ schema_version: 'adaptive_shadow_diagnostic_v1', mode: 'shadow',
    reason_code: REASONS.has(code) ? code : 'COMPUTATION_FAILED', surface_capability: 'NOT_EXPOSED' });
  diagnostics.push(payload);
  if (diagnostics.length > 64) diagnostics.shift();
  // An observer cannot turn optional shadow diagnostics into a route failure.
  if (typeof sink === 'function') { try { sink(payload); } catch { diagnose(null, 'DIAGNOSTIC_SINK_FAILED'); } }
  return payload;
}
function observedBinding(state, source) {
  return hash({ input_hash: state.inputHash, revision: state.planningInputRevision,
    constraints: state.planningConstraints, active: state.active, canonical: state.activeCanonicalCarryForwardSource,
    snapshot: source?.snapshot?.canonical_hash ?? null, source_failed: source?.sourceFailed ?? true,
    links: (source?.rawRuns || []).map(r => [r.id, r.plan_session_id ?? null, r.planned_session_json ?? null]) });
}
function sameObserved(prepared, state, source) { return prepared.observed_binding === observedBinding(state, source); }
function midnight(date, timezone) {
  let instant = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const correction = Date.parse(`${date}T00:00:00Z`) - local;
    instant += correction;
    if (!correction) break;
  }
  if (localDate(instant, timezone) !== date) fail('OCCUPANCY_UNAVAILABLE');
  return instant;
}
function completionPairs(source, accepted, state, userId) {
  if (!accepted) return [];
  const raw = new Map(source.rawRuns.map(r => [String(r.id), r]));
  const activities = source.snapshot.canonical_activities;
  const sources = new Map(activities.map(a => [a.canonical_activity_id, a.evidence_ids.map(id => raw.get(id)).filter(Boolean)]));
  const canonicalRuns = activities.map(a => ({ id: a.canonical_activity_id,
    date: a.local_activity_date || localDate(a.observed_at, source.snapshot.timezone),
    distance_miles: a.distance_m === null ? null : a.distance_m / 1609.344, duration_seconds: a.duration_s,
    explicitly_unlinked: sources.get(a.canonical_activity_id).some(r => require('./plannedRunMatch').isExplicitlyUnlinkedRun(r.planned_session_json)) }));
  const sessions = accepted.sessions.filter(s => s.kind === 'run' && s.scheduled_local_date < source.snapshot.planning_date_local);
  // Empty completedIds: a progress checkbox cannot authenticate interval work or actual dose.
  const receipts = runCompletionEvidence(sessions, { athleteId: userId, canonicalRuns, sources }, [],
    { planId: accepted.plan_id });
  return receipts.filter(r => r.attempted && !r.reason).map(r => {
    const activity = activities.find(a => a.canonical_activity_id === r.activityId);
    return { prescribed_session: sessions.find(s => s.session_id === r.sessionId), observation: {
      athlete_id: userId, linked_session_id: r.sessionId, evidence_id: activity.evidence_ids[0],
      source_evidence_ids: activity.evidence_ids, observed_at: activity.observed_at,
      quality_state: activity.quality_state, completed: r.completed && !r.reason,
      observed_duration_s: activity.duration_s, observed_distance_m: activity.distance_m,
      // Whole-activity totals cannot establish work-segment or strength-set execution.
      observed_work_duration_s: null,
    } };
  });
}
function prepare({ userId, state, source, accepted, acceptedReason = null, goals, trainingAgeClass }) {
  if (!source?.snapshot || source.sourceFailed) fail('SOURCE_UNAVAILABLE');
  const snapshot = source.snapshot;
  if (source.load.load_input_state === 'STALE') fail('SOURCE_STALE');
  if (source.load.load_input_state === 'FAILED') fail('SOURCE_UNAVAILABLE');
  if (snapshot.athlete_id !== userId || snapshot.unresolved_conflicts.length
    || snapshot.evidence.some(e => e.quality_state === 'CORRUPTED')) fail('SOURCE_CORRUPT');
  if (snapshot.planning_date_local !== state.snapshot.planning_date_local && snapshot.planning_date_local !== state.context.todayISO) fail('SNAPSHOT_DATE_MISMATCH');
  let blockedReason = acceptedReason || (state.active && !accepted ? 'ACCEPTED_SOURCE_UNAVAILABLE' : null);
  const constraints = state.planningConstraints;
  const availableDays = [...new Set([...(state.target.trainingDays || []), ...(state.target.liftEligibleWeekdays || [])])];
  const foundation = buildAdaptiveCoachingFoundation({ snapshot, context: state.context, goals,
    races: state.races.map(r => ({ race_id: String(r.id), athlete_id: userId })),
    completionPairs: completionPairs(source, accepted, state, userId),
    stateOptions: { trainingAgeClass, availableDays,
      timeConstraints: Object.fromEntries(snapshot.evidence.filter(e => e.evidence_type === 'subjective_readiness'
        && e.quality_state === 'COMPLETE' && e.freshness_class === 'FRESH'
        && Number.isFinite(e.value?.time_available_minutes) && e.value.time_available_minutes >= 0
        && e.value.time_available_minutes <= 1440).map(e => [e.value.local_date, { available_minutes: e.value.time_available_minutes }])),
      locks: constraints.locks, manualEdits: constraints.manual_edits,
      // Only existing fully covered observed weeks; no profile or planned mileage as actual.
      weeks: source.load.recent_normal_weeks.map(w => ({ week_id: w.week_start_local,
        distance_m: w.distance_m, duration_s: w.duration_s, coverage: snapshot.provider_coverage_intervals,
        partial_days: !w.eligible })) } });
  const start = snapshot.planning_date_local, end = addDays(start, 6);
  const occupied = (accepted?.sessions || []).filter(s => s.workout_family !== 'rest'
    && s.scheduled_local_date >= addDays(start, -6) && s.scheduled_local_date <= addDays(end, 6));
  if (occupied.length > 28 || occupied.some(s => !s.scheduled_start_at || !(s.derived_totals?.duration_s > 0))) blockedReason = 'OCCUPANCY_UNAVAILABLE';
  const availability = { run: [], lift: [], occupied_sessions: occupied };
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i), a = midnight(date, snapshot.timezone), b = midnight(addDays(date, 1), snapshot.timezone);
    // Date preferences are all-day capacity. Midnight is a deterministic internal
    // placement choice, not an athlete-authored appointment. DST-long dates defer.
    if (b - a > 86400000) fail('OCCUPANCY_UNAVAILABLE');
    for (const modality of ['run', 'lift']) {
      const days = modality === 'run' ? state.target.trainingDays : state.target.liftEligibleWeekdays;
      if ((days || []).includes(weekday(date)) && a >= Date.parse(snapshot.created_at)) {
        availability[modality].push({ start_at: new Date(a).toISOString(), end_at: new Date(b).toISOString() });
      }
    }
  }
  return freeze({ foundation, availability, blockedReason, observed_binding: observedBinding(state, source),
    binding: { input_hash: state.inputHash, planning_input_revision: state.planningInputRevision,
      lock_revision: constraints.lock_revision, edit_revision: constraints.edit_revision,
      constraint_fingerprint: constraints.constraint_fingerprint },
    window_policy: 'date-capacity-midnight-v1' });
}
function compute(prepared) { if (prepared.blockedReason) fail(prepared.blockedReason); return buildAdaptiveCoachingCandidate({ foundation: prepared.foundation, availability: prepared.availability }); }
function artifactsFor({ userId, candidateId, currentCandidateHash, prepared, result, comparison }) {
  const artifacts = [];
  for (const input of result.artifacts) {
    const payload = input.artifact_kind === 'candidate_week' ? { ...input.payload_json,
      shadow_relation: { version: 'adaptive-shadow-relation-v1', ...prepared.binding,
        observed_binding: prepared.observed_binding, legacy_candidate_hash: currentCandidateHash,
        athlete_state_hash: prepared.foundation.athlete_state.athlete_state_hash,
        evidence_snapshot_hash: prepared.foundation.artifacts[0].content_hash, window_policy: prepared.window_policy },
      comparison, rest_days: result.rest_days, strength_dose_receipt: result.strength_dose_receipt,
      event_execution_deferred: result.event_execution_deferred } : input.payload_json;
    artifacts.push(buildPipelineArtifact({ id: `adaptive-${canonicalHash({ userId, candidateId, kind: input.artifact_kind }).slice(0, 32)}`,
      userId, kind: input.artifact_kind, decisionId: result.decision.decision_id,
      parentArtifactId: artifacts.at(-1)?.id ?? null, planGenerationCandidateId: candidateId,
      payload: { ...payload, plan_generation_candidate_ref: hash(candidateId) }, createdAt: input.created_at }));
  }
  return artifacts;
}
async function readback({ tx, userId, candidateId, binding }) {
  const row = await tx.get(`SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=?`, [candidateId, userId]);
  if (!row || row.status !== 'preview' || row.feature_mode !== 'shadow' || row.input_hash !== binding.input_hash
    || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()
    || Number(row.planning_input_revision) !== binding.planning_input_revision
    || Number(row.lock_revision) !== binding.lock_revision || Number(row.edit_revision) !== binding.edit_revision) fail('READBACK_INVALID');
  const profile = await tx.get('SELECT planning_input_revision FROM users WHERE id=?', [userId]);
  const constraints = normalizePlanningConstraints(await tx.all(`SELECT * FROM planning_constraints
    WHERE user_id=? AND (plan_id IS NULL OR plan_id=?) ORDER BY revision ASC, created_at ASC, id ASC`,
    [userId, row.training_plan_id]), { athleteId: userId, planId: row.training_plan_id });
  if (Number(profile?.planning_input_revision) !== binding.planning_input_revision
    || constraints.lock_revision !== binding.lock_revision || constraints.edit_revision !== binding.edit_revision
    || constraints.constraint_fingerprint !== binding.constraint_fingerprint) fail('STALE_INPUT');
  const rows = await tx.all(`SELECT * FROM planning_pipeline_artifacts WHERE user_id=? AND plan_generation_candidate_id=? AND decision_id=? LIMIT 7`,
    [userId, candidateId, row.decision_id]);
  const artifacts = KINDS.map(kind => rows.find(a => a.artifact_kind === kind)).filter(Boolean).map(a => ({ ...a,
    payload_json: typeof a.payload_json === 'string' ? JSON.parse(a.payload_json) : a.payload_json }));
  if (![5, 6].includes(artifacts.length) || rows.length !== artifacts.length) fail('READBACK_INVALID');
  artifacts.forEach((a, i) => {
    if (a.user_id !== userId || a.plan_generation_candidate_id !== candidateId || a.decision_id !== row.decision_id
      || a.artifact_kind !== KINDS[i] || a.parent_artifact_id !== (artifacts[i - 1]?.id ?? null)
      || a.content_hash !== hash(a.payload_json) || !validatePipelineArtifact(a).valid) fail('READBACK_INVALID');
  });
  const relation = artifacts[3].payload_json.shadow_relation;
  if (relation.legacy_candidate_hash !== row.candidate_hash || Object.entries(binding).some(([k, v]) => relation[k] !== v)
    || relation.athlete_state_hash !== artifacts[1].payload_json.athlete_state_hash
    || relation.evidence_snapshot_hash !== hash(Object.fromEntries(Object.entries(artifacts[0].payload_json)
      .filter(([key]) => key !== 'plan_generation_candidate_ref')))
    || artifacts[2].payload_json.athlete_state_hash !== relation.athlete_state_hash) fail('READBACK_INVALID');
  const snapshot = artifacts[0].payload_json, state = artifacts[1].payload_json, decision = artifacts[2].payload_json;
  const candidate = artifacts[3].payload_json, validator = artifacts[4].payload_json;
  const decisionContent = Object.fromEntries(Object.entries(decision).filter(([key]) =>
    !['decision_id', 'decision_hash', 'plan_generation_candidate_ref'].includes(key)));
  if (snapshot.athlete_id !== userId || state.athlete_id !== userId || decision.athlete_id !== userId
    || state.evidence_snapshot_id !== snapshot.evidence_snapshot_id
    || decision.decision_hash !== canonicalHash(decisionContent)
    || (candidate.candidate_hash !== null && String(row.selected_candidate_hash).replace(/^sha256:/, '') !== candidate.candidate_hash)) fail('READBACK_INVALID');
  if (artifacts.length === 6) {
    const set = require('./activityCanonicalSuccessor').canonicalSetPayload(artifacts[5].payload_json);
    if (!require('./canonicalWorkout').validateCanonicalSessionSet(set).valid || validator.valid !== true
      || set.candidate_hash !== candidate.candidate_hash || set.decision_hash !== decision.decision_hash) fail('READBACK_INVALID');
  } else if (candidate.candidate_hash !== null || validator.valid !== false) fail('READBACK_INVALID');
  return { row, artifacts, relation };
}
async function persist(input) {
  const { tx, userId, candidateId, currentCandidateHash, prepared, result } = input;
  const artifacts = artifactsFor(input);
  const bindings = buildGoalBackwardShadowBindings({ decision: { ...result.decision,
    ...prepared.binding, evidence_used: [{ evidence_id: prepared.observed_binding, purpose: 'CAPTURED_OBSERVATION_BINDING' }] },
    decisionArtifact: artifacts[2], selectedCandidate: result.selected_candidate, currentCandidateHash });
  const rejections = await loadCandidateRejectionsForFingerprint({ tx, userId, fingerprint: bindings.material_change_json.apply_bindings });
  if (rejections.some(r => candidateRejectionMatches(r, { candidate_hash: currentCandidateHash,
    ...bindings.material_change_json.apply_bindings }))) fail('IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
  if (result.selected_candidate && rejections.some(r => candidateRejectionMatches(r, { candidate_hash: result.selected_candidate.candidate_hash,
    ...bindings.material_change_json.apply_bindings }))) fail('REJECTED_CANDIDATE');
  const updated = await tx.run(`UPDATE plan_generation_candidates SET decision_id=?, candidate_revision=?, athlete_state_revision=?,
    safety_state_hash=?, goal_revisions_json=?, lock_revision=?, edit_revision=?, surface_revision=?, export_revision=?,
    feature_mode=?, selected_candidate_hash=?, material_change_json=? WHERE id=? AND user_id=? AND input_hash=? AND planning_input_revision=? AND status='preview'`,
    [bindings.decision_id, bindings.candidate_revision, bindings.athlete_state_revision, bindings.safety_state_hash,
      JSON.stringify(bindings.goal_revisions_json), bindings.lock_revision, bindings.edit_revision, bindings.surface_revision,
      bindings.export_revision, 'shadow', bindings.selected_candidate_hash, JSON.stringify(bindings.material_change_json),
      candidateId, userId, prepared.binding.input_hash, prepared.binding.planning_input_revision]);
  if (Number(updated.changes) !== 1) fail('STALE_INPUT');
  await persistPipelineArtifacts({ tx, artifacts });
  await readback({ tx, userId, candidateId, binding: prepared.binding });
}
module.exports = { prepare, compute, compare, persist, readback, sameObserved, freeze, reason, diagnose, diagnosticSnapshot: () => [...diagnostics] };
