// A read projection, not a planner, coaching decision or shoe matcher.
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { validatePipelineLinks } = require('./goalBackwardContracts');
const { validateCanonicalSessionSet, canonicalWorkoutHash } = require('./canonicalWorkout');
const { buildDecisionArtifactDiagnosticBundle } = require('./racePlanDiagnostics');
const { surfaceManifestAppliedPlanDiagnostic } = require('./acceptedSurfaceDiagnostic');
const { activityAssessment, runCompletionEvidence } = require('./activityReconciliation');
const VERSION = 'coaching-context-v1';
const LIMITS = Object.freeze({ artifacts: 32, sessions: 280, runs: 512, corrections: 1000,
  lifts: 256, context: 64, payloadBytes: 4 * 1024 * 1024, responseBytes: 256 * 1024 });
const missing = reason => ({ status: 'MISSING', value: null, reason_codes: [reason] });
const text = v => typeof v === 'string' && v.length <= 512 ? v : null;
const scalar = v => typeof v === 'number' ? Number.isFinite(v) ? v : null
  : typeof v === 'boolean' ? v : text(v);
const list = v => {
  if (!Array.isArray(v)) return [];
  if (v.length > 64) fail('CONTEXT_BOUNDS');
  return v.map(scalar);
};
// Nested data is only emitted through explicit field schemas. Unknown extension
// fields (including provider payloads/PII/prompt text) are not serialized.
function project(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(schema).map(([key, type]) => [key,
    type === true ? scalar(value[key]) : type === 'list' ? list(value[key])
      : Array.isArray(type) ? (Array.isArray(value[key]) ? (value[key].length > 64 ? fail('CONTEXT_BOUNDS') : value[key].map(v => project(v, type[0]))) : [])
        : project(value[key], type)]));
}
const fields = words => Object.fromEntries(words.split(' ').map(k => [k, true]));
const present = (value, schema) => Object.fromEntries(Object.entries(project(value, schema) || {})
  .filter(([key]) => Object.hasOwn(value, key)));
const reasons = { reason_codes: 'list', evidence_ids: 'list' };
const range = { minimum: true, maximum: true };
const targetFields = fields('distance_m duration_s load_kg repetitions sets rest_s rir');
const targetRanges = ['pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm'];
function target(value) {
  if (!value) return null;
  const out = present(value, targetFields);
  if (Object.hasOwn(value, 'stop_ceiling')) out.stop_ceiling = value.stop_ceiling === null ? null
    : present(value.stop_ceiling, fields('heart_rate_bpm rpe duration_s pace_s_per_km maximum_heart_rate_bpm maximum_rpe maximum_duration_s maximum_pace_s_per_km'));
  for (const key of targetRanges) if (Object.hasOwn(value, key)) out[key] = value[key] === null ? null : present(value[key], range);
  return out;
}
function step(value, depth = 0) {
  if (depth > 8) throw Error('CONTEXT_BOUNDS');
  return { ...present(value, fields('step_id type order repeat_count workout_family step_role capability station_id exercise_id')),
    target: target(value.target), provenance: (value.provenance || []).map(p => present(p, {
      ...fields('policy_id policy_version ruleset_id ruleset_version derived_athlete_state_field confidence derived_at decision_id derivation'),
      source_evidence_ids: 'list', canonical_units: 'list' })),
    ...(Array.isArray(value.children) ? { children: value.children.map(s => step(s, depth + 1)) } : {}) };
}
const totalsSchema = fields('distance_m duration_s work_distance_m work_duration_s repetitions sets station_distance_m');
function prescription(s) {
  return { ...project(s, { ...fields('canonical_workout_schema_version stress_taxonomy_version session_id session_revision content_hash plan_id plan_revision decision_id kind workout_family role phase scheduled_local_date scheduled_start_at timezone progression_family executability'),
    goal_ids: 'list', objective_ids: 'list', purpose_reason_codes: 'list', safety_scope: 'list' }),
    truth_class: 'PRESCRIBED', steps: s.steps.map(v => step(v)), derived_totals: project(s.derived_totals, totalsSchema),
    capability: project(s.capability, { classification: true, manual_step_ids: 'list', unsupported_step_ids: 'list' }),
    stress_vector: Array.isArray(s.stress_vector) ? list(s.stress_vector) : null,
    primary_physiological_stimulus: missing('STRUCTURED_STIMULUS_NOT_IMPLEMENTED'),
    dominant_purpose: missing('DOMINANT_PURPOSE_CONTRACT_NOT_IMPLEMENTED'),
    surface: missing('CANONICAL_SURFACE_CONTRACT_NOT_IMPLEMENTED'),
    fallback_rules: missing('STRUCTURED_MODIFICATION_RULES_NOT_IMPLEMENTED'),
    intensity_authority: { status: 'STEP_TARGET_PROVENANCE', reason_codes: ['NO_TITLE_DERIVED_AUTHORITY'] },
  };
}
function json(value, maximum = LIMITS.payloadBytes) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(raw) > maximum) throw Error('CONTEXT_BOUNDS');
  return JSON.parse(raw);
}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const n = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? value : null;
}
function instant(value) {
  if (value instanceof Date) value = value.toISOString();
  // PostgreSQL's explicit-zone text parser retains the space and may use +00.
  // Normalize syntax only; never assign a timezone to a naive timestamp.
  if (typeof value === 'string') value = value.replace(/^(\d{4}-\d\d-\d\d) /, '$1T').replace(/([+-]\d\d)$/, '$1:00');
  return typeof value === 'string' && dateOnly(value.slice(0, 10)) && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function metric(value, unit) {
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return { state: value == null ? 'UNKNOWN' : valid ? value === 0 ? 'VALID_ZERO' : 'KNOWN' : 'INVALID',
    value: valid ? value : null, unit, truth_class: 'OBSERVED' };
}
function fail(code) { const e = Error(code); e.code = code; throw e; }
function accepted({ ownerId, active, candidate, artifacts, sessionId, effectiveAssignmentRead = null }) {
  if (!active) fail('NO_ACCEPTED_PLAN');
  if (active.user_id !== ownerId || active.training_owner_id !== ownerId || candidate?.user_id !== ownerId) fail('ACCEPTED_CHAIN_UNAVAILABLE');
  const plan = json(active.plan_data || active.plan_json);
  if (plan?.canonical_workout_schema_version !== 1) fail('LEGACY_PLAN_NOT_CANONICAL');
  if (artifacts.length > LIMITS.artifacts) fail('CONTEXT_BOUNDS');
  const normalized = artifacts.map(row => {
    const payload = json(row.payload_json), at = instant(row.created_at);
    const releaseAt = payload?.release_identity?.generation_timestamp;
    return { ...row, revision: Number(row.revision), payload_json: payload,
      created_at: at && row.artifact_kind === 'evidence_snapshot' && instant(releaseAt) === at ? releaseAt : at };
  });
  if (!validatePipelineLinks(normalized).valid) fail('ACCEPTED_CHAIN_UNAVAILABLE');
  const diagnostic = buildDecisionArtifactDiagnosticBundle({ targetUserId: ownerId, decisionId: candidate.decision_id,
    artifactRows: normalized, candidateRow: candidate, includePayloads: false });
  const permittedLegacy = ['C4_DEPLOYMENT_REVISION_MISSING', 'C4_SOURCE_REVISION_MISSING'];
  if (!diagnostic.canonical_binding?.verified || diagnostic.reason_codes.some(code => !permittedLegacy.includes(code))) fail('ACCEPTED_CHAIN_UNAVAILABLE');
  const byKind = Object.fromEntries(normalized.map(a => [a.artifact_kind, a]));
  const set = byKind.canonical_session_set.payload_json, manifest = byKind.surface_manifest.payload_json;
  const { plan_generation_candidate_ref, selected_candidate_id, selected_candidate_hash, ...canonicalSet } = set;
  if (set.sessions?.length > LIMITS.sessions || !validateCanonicalSessionSet(canonicalSet).valid) fail('CANONICAL_SET_INVALID');
  if (surfaceManifestAppliedPlanDiagnostic(manifest, candidate, active, set, undefined,
    { effectiveAssignmentRead }).status_code !== 'ACCEPTED') fail('ACCEPTED_CHAIN_STALE');
  // Metadata agreement alone must not authorize a tampered embedded plan.
  const planSessions = (plan.weeks || []).flatMap(w => (w.days || []).flatMap(d => d.sessions || []));
  if (planSessions.length !== set.sessions.length || set.sessions.some(s => {
    const entries = planSessions.filter(p => p.session_id === s.session_id);
    return entries.length !== 1 || canonicalWorkoutHash(entries[0]) !== s.content_hash;
  })) fail('ACCEPTED_CHAIN_STALE');
  const session = set.sessions.find(s => s.session_id === sessionId);
  if (!session) fail('SESSION_UNAVAILABLE');
  return { plan, set, manifest, session, byKind, artifacts: normalized, effectiveAssignmentRead };
}
const outcomeSchema = { ...fields('outcome dose_outcome scorable observed_at linked_session_id observed_to_prescribed_ratio measured_receipt_id measured_receipt_revision'), source_evidence_ids: 'list', reason_codes: 'list' };
const progressionSchema = { ...fields('family action allowed_variable current_level current_level_basis next_level_ceiling max_change_fraction previous_success'),
  workout_families: 'list', reason_codes: 'list', previous_successful_exposure: outcomeSchema, observed_outcomes: [outcomeSchema] };
const objectiveSchema = { ...fields('objective_id requirement_id role priority_score'), goal_ids: 'list', candidate_families: 'list', ...reasons };
const goalSchema = { ...fields('goal_id source_revision event_revision event_kind event_local_date event_state priority goal_type target_time_s distance_miles'), ...reasons };
const gapSchema = { ...fields('goal_id goal_gap_hash days_remaining weeks_remaining derived_target_pace_s_per_km gap_seconds confidence feasibility_status training_pace_authority'),
  goal: goalSchema, target_demand: fields('distance_m duration_s'), demonstrated_fitness: fields('projected_duration_s pace_s_per_km'), ...reasons };
function compose({ ownerId, chain, candidate, profile, runs = [], corrections = [], lifts = [], shoes = [], shoeReadStatus = 'AVAILABLE', measuredReceipts = null, asOf }) {
  const { session, set, byKind } = chain;
  if (runs.length > LIMITS.runs || corrections.length > LIMITS.corrections || lifts.length > LIMITS.lifts) fail('CONTEXT_BOUNDS');
  if ([...runs, ...corrections, ...lifts, ...shoes, ...(measuredReceipts?.rows || [])].some(r => r.user_id !== ownerId)) fail('CONTEXT_OWNER_MISMATCH');
  const timezone = session.timezone;
  const observationDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(asOf));
  const state = byKind.athlete_state.payload_json, decision = byKind.planning_decision.payload_json;
  const weekly = decision.weekly_objectives;
  const evidenceTime = instant(byKind.evidence_snapshot.created_at);
  const assessment = activityAssessment({ athleteId: ownerId, runs, corrections, planningDateLocal: observationDate,
    timezone, observationInstant: asOf });
  let completed = runCompletionEvidence([session], assessment, [], { planId: set.plan_id, acceptedPlan: chain.plan })[0];
  const qualifiedActivityId = completed?.activityId;
  const measured = require('./activityMeasuredReceipt');
  const snapshot = require('./goalBackwardEvidence').buildEvidenceSnapshot({ athleteId: ownerId, runs, corrections, timezone, planningInstant: asOf });
  const pairs = measured.pairs(measuredReceipts, set, snapshot);
  const measuredPair = pairs.find(p => p.prescribed_session.session_id === session.session_id);
  const hasMeasured = Boolean(measuredReceipts?.rows?.length || measuredReceipts?.unavailable);
  if (hasMeasured) {
    // A partial/corrected/stale receipt supersedes aggregate fallback. No old
    // successful aggregate is resurrected when the measured chain is unusable.
    completed = { attempted: Boolean(measuredPair), source: 'MEASURED_RECEIPT', outcome: null,
      reason: measuredPair ? 'MEASURED_COMPLETION_NOT_INTERVAL_SUCCESS' : 'MEASURED_RECEIPT_UNAVAILABLE_OR_STALE' };
  }
  const actualSources = measuredPair?.observation && session.kind === 'run'
    ? runs.filter(r => measuredPair.observation.source_evidence_ids.includes(r.id))
    : qualifiedActivityId ? assessment.sources.get(qualifiedActivityId) || [] : [];
  const canonicalActual = assessment.canonicalRuns.find(r => r.id === qualifiedActivityId
    || measuredPair && r.evidence_ids.includes(measuredPair.observation.evidence_id));
  const actualRuns = actualSources.map(r => ({ activity_id: r.id, local_date: dateOnly(r.date),
    start_at: instant(r.health_start_at), end_at: instant(r.health_end_at), source: text(r.health_source) || 'UNSPECIFIED_RECORDED_SOURCE',
    duration_s: metric(r.duration_seconds, 's'), distance_m: metric(r.distance_miles == null ? null : r.distance_miles * 1609.344, 'm'),
    average_heart_rate: metric(r.avg_heart_rate, 'bpm'), max_heart_rate: metric(r.max_heart_rate, 'bpm'), cadence: metric(r.cadence_spm, 'spm'),
    average_pace: { ...metric(typeof r.duration_seconds === 'number' && r.duration_seconds > 0
      && typeof r.distance_miles === 'number' && r.distance_miles > 0 ? r.duration_seconds / (r.distance_miles * 1.609344) : null, 's/km'),
      truth_class: 'DERIVED', basis: 'RECORDED_WHOLE_RUN_TOTALS_NOT_INTERVAL_TARGET_EVIDENCE' },
    actual_shoe_id: shoes.some(s => s.id === r.shoe_id) ? r.shoe_id : null,
    provider_confidence: 'UNKNOWN', metric_authority: 'RAW_RECORDED_SOURCE', interval_evidence: missing('INTERVAL_COMPARISON_NOT_IMPLEMENTED') }));
  const shoeIds = [...new Set(actualRuns.map(r => r.actual_shoe_id).filter(Boolean))];
  const actualShoe = shoeIds.length === 1 && actualRuns.every(r => r.actual_shoe_id === shoeIds[0])
    ? project(shoes.find(s => s.id === shoeIds[0]), fields('id brand model nickname is_retired')) : null;
  const anchorInstant = instant(session.scheduled_start_at), anchorDate = session.scheduled_local_date;
  const bounds = { start_date_local: addDays(anchorDate, -3), end_date_local: addDays(anchorDate, 3),
    anchor_at: anchorInstant, exact_72_hour_window: Boolean(anchorInstant), date_only_boundary_uncertain: true };
  const context = [];
  function addContext(row, at, localDate) {
    const stamp = instant(at);
    if (anchorInstant && stamp) {
      const delta = Date.parse(stamp) - Date.parse(anchorInstant);
      if (Math.abs(delta) > 72 * 3600000) return;
      context.push({ ...row, at: stamp, local_date: localDate, temporal_precision: 'INSTANT', relation: delta < 0 ? 'PRIOR' : delta > 0 ? 'UPCOMING' : 'SAME_INSTANT' });
    } else if (localDate >= bounds.start_date_local && localDate <= bounds.end_date_local) {
      context.push({ ...row, at: stamp, local_date: localDate, temporal_precision: 'LOCAL_DATE_WINDOW', relation: 'BOUNDARY_UNCERTAIN' });
    }
  }
  for (const s of set.sessions.filter(s => s.session_id !== session.session_id)) addContext({ truth_class: 'PRESCRIBED',
    session_id: s.session_id, workout_family: s.workout_family, role: s.role, kind: s.kind,
    stress_vector: Array.isArray(s.stress_vector) ? list(s.stress_vector) : null }, s.scheduled_start_at, s.scheduled_local_date);
  for (const r of assessment.canonicalRuns) {
    const source = assessment.sources.get(r.id) || [];
    const instants = [...new Set(source.map(s => instant(s.health_start_at)).filter(Boolean))];
    addContext({ truth_class: 'OBSERVED', activity_id: r.id, kind: 'run',
      duration_s: metric(r.duration_seconds, 's'), distance_m: metric(r.distance_miles == null ? null : r.distance_miles * 1609.344, 'm'),
      stress_vector: null }, instants.length === 1 ? instants[0] : null, r.date);
  }
  for (const l of lifts) addContext({ truth_class: 'OBSERVED', activity_id: l.id, kind: 'lift',
    duration_s: metric(l.total_seconds, 's'), workout_family: null, stress_vector: null,
    strength_distribution: missing('ACTUAL_STRENGTH_DISTRIBUTION_UNAVAILABLE') }, l.started_at,
    instant(l.started_at) ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(l.started_at)) : null);
  context.sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)) || String(a.at).localeCompare(String(b.at))
    || String(a.session_id || a.activity_id).localeCompare(String(b.session_id || b.activity_id)));
  const content = {
    schema_version: VERSION, composition_version: VERSION, status: 'PARTIAL', executable_authority: false,
    accepted_identity: project(chain.manifest.identity, { ...fields('plan_id plan_revision decision_id decision_hash candidate_id candidate_revision candidate_hash canonical_session_set_hash athlete_state_revision safety_state_hash') }),
    ...(chain.effectiveAssignmentRead ? { effective_assignment_read: {
      version: chain.effectiveAssignmentRead.version, local_date: chain.effectiveAssignmentRead.local_date,
      timezone: chain.effectiveAssignmentRead.timezone,
      selected_assignment_status: 'SUPERSEDED', reason_codes: ['ACCEPTED_PREDECESSOR_CURRENTLY_EFFECTIVE'],
      path_hash: canonicalHash(chain.effectiveAssignmentRead), depth: chain.effectiveAssignmentRead.path.length,
    } } : {}),
    artifact_receipts: chain.artifacts.map(a => project(a, fields('id artifact_kind revision content_hash schema_version policy_version created_at'))).sort((a, b) => a.artifact_kind.localeCompare(b.artifact_kind)),
    time: { timezone, observation_date_local: observationDate, planning_date_local: dateOnly(decision.planning_date_local), evidence_as_of: evidenceTime },
    athlete: { status: 'PARTIAL', truth_class: 'INFERENCE_AT_PLANNING_TIME',
      state: project(state, { ...fields('athlete_state_id athlete_state_revision athlete_state_hash planning_date_local timezone training_age_class consistency_state recovery_state safety_action confidence'),
        safety_scope: 'list', reason_codes: 'list', recovery_evidence_ids: 'list',
        recent_normal_running: { ...fields('status median_distance_m median_duration_s confidence'), ...reasons } }),
      freshness: Number(profile.planning_input_revision) === Number(candidate.planning_input_revision) ? 'PLANNING_TIME_ONLY' : 'INPUT_REVISION_CHANGED',
      planning_input_revision: candidate.planning_input_revision, current_input_revision: profile.planning_input_revision,
      live_state: missing('LIVE_STATE_NOT_RECOMPUTED'), training_ranges: missing('TRAINING_RANGES_NOT_COMPOSED'),
      recovery_pattern: missing('ATHLETE_RECOVERY_PATTERN_NOT_IMPLEMENTED') },
    goal: { goal_set: project(decision.goal_set, { primary_goal_id: true, goals: [goalSchema] }),
      goal_gaps: Array.isArray(decision.goal_gap) ? decision.goal_gap.map(g => project(g, gapSchema)) : [],
      phase: text(decision.phase) || text(decision.phase_decision?.phase), reason_codes: list(decision.phase_reason_codes || decision.phase_decision?.reason_codes) },
    week: { status: weekly ? 'PARTIAL' : 'MISSING', weekly_objectives: project(weekly, { ...fields('version weekly_objectives_hash phase week_intent'),
      objectives: [objectiveSchema], reason_codes: 'list', weekly_stress_budget: 'list' }),
      scheduled_sessions: set.sessions.filter(s => s.scheduled_local_date >= addDays(anchorDate, -((new Date(`${anchorDate}T12:00:00Z`).getUTCDay() + 6) % 7))
        && s.scheduled_local_date <= addDays(anchorDate, 6 - ((new Date(`${anchorDate}T12:00:00Z`).getUTCDay() + 6) % 7)))
        .map(s => project(s, fields('session_id scheduled_local_date scheduled_start_at workout_family role phase'))) },
    session: prescription(session),
    actual: { status: actualRuns.length || measuredPair ? 'PARTIAL' : 'UNKNOWN', truth_class: 'OBSERVED',
      link_source: completed?.source || 'no_qualified_link', completion: { ...project(completed, fields('attempted outcome reason')),
        truth_class: 'DERIVED', status: completed?.outcome ? 'AGGREGATE_DOSE_ONLY' : 'UNKNOWN',
        completed: completed?.outcome ? completed.completed : null },
      observations: actualRuns.sort((a, b) => a.activity_id.localeCompare(b.activity_id)),
      measured_receipt: measuredPair ? { status: 'VALIDATED', ...project(measuredPair.observation, fields('measured_receipt_id measured_receipt_revision quality_state completed observed_duration_s observed_distance_m observed_work_duration_s')),
        authority: 'RECORDED_COMPLETENESS_AND_DOSE_NOT_INTENSITY_SUCCESS',
        observed_at: session.kind === 'lift' ? instant(measuredPair.observation.observed_at) : null,
        run_date_only_noon_is_not_observed_timestamp: session.kind === 'run' } : missing(hasMeasured ? 'MEASURED_RECEIPT_UNAVAILABLE_OR_STALE' : 'MEASURED_RECEIPT_NOT_RECORDED'),
      correction_provenance: { effective_authority: 'RECONCILED_TOTALS',
        source_evidence_ids: [...(canonicalActual?.evidence_ids || [])].sort(),
        effective_correction_evidence_ids: [...(snapshot.canonical_activities.find(a => a.canonical_activity_id === canonicalActual?.id)?.correction_evidence_ids || [])].sort(),
        corrections: corrections.filter(c => canonicalActual?.evidence_ids.includes(c.raw_evidence_ref))
          .map(c => project({ ...c, corrected_canonical_value_json: json(c.corrected_canonical_value_json, 32768) }, { ...fields('id raw_evidence_ref revision canonical_unit reason_code content_hash supersedes_correction_id created_at'),
            corrected_canonical_value_json: fields('field value') })).sort((a, b) => a.raw_evidence_ref.localeCompare(b.raw_evidence_ref) || a.revision - b.revision),
        raw_observations_preserved_not_effective_when_corrected: true },
      reconciled_totals: canonicalActual ? { duration_s: metric(canonicalActual.duration_seconds, 's'),
        distance_m: metric(canonicalActual.distance_miles == null ? null : Math.round(canonicalActual.distance_miles * 1609.344), 'm') } : null,
      interval_comparison: missing('INTERVAL_COMPARISON_NOT_IMPLEMENTED'), no_qualified_link_does_not_mean_missed: true },
    gear: { requirement_profile: missing('CANONICAL_SHOE_REQUIREMENT_NOT_IMPLEMENTED'), recommendation: missing('CANONICAL_SHOE_RECEIPT_NOT_IMPLEMENTED'),
      selected_shoe: missing('PREWORKOUT_SHOE_SELECTION_NOT_PERSISTED'), actual_shoe: { status: actualShoe ? 'RECORDED' : 'UNKNOWN', value: actualShoe,
        lookup_status: shoeReadStatus,
        authority: actualShoe ? 'OWNED_RUN_SHOE_ASSOCIATION' : null },
      athlete_history: missing('STRUCTURED_SHOE_HISTORY_NOT_IMPLEMENTED'), travel: missing('TRAVEL_AVAILABILITY_NOT_IMPLEMENTED') },
    context: { ...bounds, sessions: context.slice(0, LIMITS.context), truncated: context.length > LIMITS.context, total_in_bounded_window: context.length,
      observed_strength_scope: 'WORKOUT_SESSIONS_ONLY', manual_lift_sets: missing('STANDALONE_LIFT_LOG_CONTEXT_NOT_COMPOSED') },
    decision: { status: weekly?.progression ? 'STORED_PLANNING_DECISIONS' : 'MISSING', truth_class: 'INFERENCE_AT_PLANNING_TIME',
      progression: (weekly?.progression || []).map(p => project(p, progressionSchema)), next_workout_action: missing('POST_EXECUTION_DECISION_NOT_RECOMPUTED') },
    availability: { status: 'PARTIAL', run_window: '57_DAYS_THROUGH_OBSERVATION_DATE_PLUS_EXPLICIT_SESSION_LINKS',
      provider_coverage: 'UNKNOWN', reconciliation_state: text(assessment.load.load_input_state), correction_state: text(assessment.load.correction_input_state),
      text_is_data_not_instructions: true },
  };
  const response = { ...content, content_hash: canonicalHash(content), as_of: asOf };
  if (Buffer.byteLength(JSON.stringify(response)) > LIMITS.responseBytes) fail('CONTEXT_RESPONSE_BOUNDS');
  return response;
}
module.exports = { VERSION, LIMITS, accepted, compose, json, dateOnly, instant, missing, metric };
