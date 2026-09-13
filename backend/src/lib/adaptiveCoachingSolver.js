// Pure internal seam. No mode switch, routes, DB, surface acceptance, or clock.
const { buildAdaptiveCoachingFoundation } = require('./adaptiveCoachingFoundation');
const { buildAdaptiveSessionSelection, isStrength } = require('./adaptiveCoachingSelection');
const { buildAdaptiveWorkoutMaterial } = require('./adaptiveCoachingWorkouts');
const { materializeGoalBackwardCandidate } = require('./racePlanCandidateEngine');
const { materializeCanonicalSession } = require('./canonicalWorkout');
const { selectRunningDoseSource, attachRunningDose, VERSION } = require('./runningDoseAccounting');
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { calendarOccupancy } = require('./calendarOccupancy');
const { buildPipelineArtifact } = require('./planCandidateLifecycle');
const { normalizeSolverConstraints, validateAdaptivePlacement, validateAdaptiveCandidate, weekday,
  demanding, lowerBody } = require('./adaptiveCoachingValidation');
const LIMITS = Object.freeze({ frontier: 64, nodes: 8192, candidates: 32, sessions: 14 });
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function restReasons(date, sessions, constraints, state, selection) {
  if (['FULL_REST', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED', 'MODIFIED_SESSION_ONLY'].includes(state.safety_action)) return ['INJURY_SCOPE'];
  if (constraints.blocked_dates.includes(date)) return ['REST_DATE_BLOCKED'];
  if (![...constraints.run, ...constraints.lift].some(w => w.date === date)) return ['REST_MODALITY_UNAVAILABLE'];
  const tomorrow = sessions.filter(s => s.scheduled_local_date === addDays(date, 1));
  const yesterday = sessions.filter(s => s.scheduled_local_date === addDays(date, -1));
  if (tomorrow.some(demanding)) return ['REST_PROTECT_NEXT_KEY'];
  if (yesterday.some(s => demanding(s) || lowerBody(s))) return ['REST_AFTER_DEMANDING_WORK'];
  if (selection.weekly_objectives.phase === 'POST_RACE_TRANSITION') return ['POST_RACE_TRANSITION'];
  if (selection.weekly_objectives.phase === 'TAPER_RACE_WEEK') return ['TAPER_VOLUME_REDUCTION'];
  const active = sessions.filter(s => s.workout_family !== 'rest' && s.scheduled_local_date >= constraints.start_date && s.scheduled_local_date <= constraints.end_date);
  if (active.length >= 6 || active.length < selection.entries.length) return ['REST_REQUIRED_RECOVERY_WINDOW'];
  return ['REST_MEANINGFUL_DOSE_EXHAUSTED'];
}
function buildAdaptiveCoachingCandidate({ foundation, foundationInput, availability, domain = {}, search = {} } = {}) {
  if (foundation && foundationInput) throw new Error('Supply foundation or foundationInput, not both');
  const f = foundation || buildAdaptiveCoachingFoundation(foundationInput);
  if (!f?.athlete_state?.adaptive_foundation || f.decision?.athlete_state_hash !== f.athlete_state.athlete_state_hash
    || f.artifacts?.length !== 3 || !Object.isFrozen(f)) throw new Error('Use buildAdaptiveCoachingFoundation output');
  const state = f.athlete_state, selection = buildAdaptiveSessionSelection(f, domain);
  const constraints = { ...normalizeSolverConstraints(state, availability), planning_instant: f.artifacts[0].created_at };
  if (selection.entries.length > LIMITS.sessions) throw new Error('Adaptive selection exceeds bounded session limit');
  const maxNodes = search.max_nodes ?? LIMITS.nodes;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > LIMITS.nodes || Object.keys(search).some(k => k !== 'max_nodes')) throw new Error('Invalid bounded search options');
  const content = { ...clone(f.decision), version: 'adaptive-joint-solver-v1',
    foundation_decision_hash: f.decision.decision_hash,
    weekly_objectives: selection.weekly_objectives, session_selection: selection,
    constraints_hash: canonicalHash(constraints), search_limits: { ...LIMITS, nodes: maxNodes },
    active_goals: f.decision.goal_gap.map(g => g.goal),
    safety_state: { action: state.safety_action, scope: state.safety_scope || [] },
    training_age_class: state.training_age_class, timezone: state.timezone,
    pipeline_stages: [...f.decision.pipeline_stages, 'joint_constraint_solver', 'canonical_workouts'] };
  delete content.decision_id; delete content.decision_hash;
  const decisionHash = canonicalHash(content);
  const decision = { ...content, decision_id: `decision-${decisionHash.slice(0, 24)}`, decision_hash: decisionHash };
  const instant = f.artifacts[0].created_at;
  const variants = selection.entries.map(e => [e, ...(e.dose_variants || [])]);
  const materialVariants = variants.map(list => list.map((e, i) => {
    const m = buildAdaptiveWorkoutMaterial(e, decision, instant);
    return { ...m, material_id: `${e.selection_id}-dose-${i}` };
  }));
  const material = materialVariants.flat();
  const source = { authority: 'COMPATIBLE_SERVER_HISTORY', policy_version: VERSION,
    evidence_snapshot_hash: f.artifacts[0].content_hash, allow_effort_only: true,
    adaptive_dose_policy_hash: canonicalHash(selection.weekly_objectives.dose_policy) };
  const skeletonFor = (entry, date, start) => ({ session_id: entry.selection_id, skeleton_session_id: entry.selection_id,
    requirement_id: entry.requirement_id, role: entry.role, workout_family: entry.workout_family,
    candidate_material_id: entry.selection_id, scheduled_local_date: date, scheduled_start_at: start,
    ...(entry.role === 'SUPPORTING' ? { supports_requirement_id: entry.objective_ids[0] } : {}) });
  const prototypes = selection.entries.map((entry, i) => materializeCanonicalSession({ decision,
    skeleton: skeletonFor(entry, constraints.start_date), source: materialVariants[i][0].source_session,
    planning_instant: instant, timezone: state.timezone }));
  // Independent selected-dose denominator exists before any placement search.
  const runningSource = selectRunningDoseSource(prototypes, source);
  const choices = selection.entries.map((entry, i) => {
    const resources = require('./adaptiveCoachingObjectives').capacitiesFor(entry.workout_family);
    const windows = resources.length === 2 ? constraints.run.flatMap(a => constraints.lift.filter(b => a.date === b.date).flatMap(b => {
      const start = a.start_at > b.start_at ? a.start_at : b.start_at;
      const end = a.end_at < b.end_at ? a.end_at : b.end_at;
      return start < end ? [{ date: a.date, start_at: start, end_at: end }] : [];
    })) : constraints[resources[0] || 'run'];
    const pins = constraints.locks.filter(l => l.active !== false && (
      l.requirement_id === entry.requirement_id || l.session_id === entry.selection_id
      || l.workout_family === entry.workout_family && (!l.role || l.role === entry.role)));
    return variants[i].flatMap((variant, variantIndex) => windows.filter(w => !constraints.blocked_dates.includes(w.date)
      && (!entry.fixed_date || w.date === entry.fixed_date)
      && (!entry.earliest_date || w.date >= entry.earliest_date)
      && pins.every(l => !(l.scheduled_local_date || l.local_date || l.date)
        || (l.scheduled_local_date || l.local_date || l.date) === w.date)).map(w => {
      const skeleton = { ...skeletonFor(entry, w.date, w.start_at), candidate_material_id: materialVariants[i][variantIndex].material_id };
      const session = attachRunningDose(materializeCanonicalSession({ decision, skeleton,
        source: materialVariants[i][variantIndex].source_session, planning_instant: instant, timezone: state.timezone }), runningSource);
      return { skeleton, session, variant_index: variantIndex };
    })).filter(c => validateAdaptivePlacement([c.session], constraints, state, selection.weekly_objectives).valid);
  });
  let frontier = [{ placed: [], mask: [] }], nodes = 0, truncated = false;
  const rejectionCounts = {};
  const compare = (a, b) => {
    for (let i = 0; i < Math.max(a.mask.length, b.mask.length); i++) if (a.mask[i] !== b.mask[i]) return (b.mask[i] || 0) - (a.mask[i] || 0);
    const reductionA = a.placed.reduce((n, p) => n + p.variant_index, 0);
    const reductionB = b.placed.reduce((n, p) => n + p.variant_index, 0);
    if (reductionA !== reductionB) return reductionA - reductionB;
    // Spread demanding work; use stable chronological tie-breaks only after safety.
    const occupiedA = new Set(a.placed.map(p => p.session.scheduled_local_date)).size;
    const occupiedB = new Set(b.placed.map(p => p.session.scheduled_local_date)).size;
    return occupiedB - occupiedA || canonicalHash(a.placed.map(p => p.skeleton)).localeCompare(canonicalHash(b.placed.map(p => p.skeleton)));
  };
  for (let index = 0; index < selection.entries.length; index++) {
    const next = [];
    for (const branch of frontier) {
      // Omissions are candidate alternatives, never calendar repairs. Lexicographic
      // objective priority preserves primary/long before every supporting session.
      next.push({ placed: branch.placed, mask: [...branch.mask, 0] });
      for (const choice of choices[index]) {
        if (nodes >= maxNodes) { truncated = true; break; }
        nodes++;
        const placed = [...branch.placed, choice];
        const result = validateAdaptivePlacement(placed.map(p => p.session), constraints, state, selection.weekly_objectives);
        if (result.valid) next.push({ placed, mask: [...branch.mask, 1] });
        else for (const v of result.violations) rejectionCounts[v.code] = (rejectionCounts[v.code] || 0) + 1;
      }
    }
    if (next.length > LIMITS.frontier) truncated = true;
    frontier = next.sort(compare).slice(0, LIMITS.frontier);
  }
  const tested = [], restReceipt = [];
  let candidate = null, selectedBranch = null;
  for (const branch of frontier.sort(compare).slice(0, LIMITS.candidates)) {
    const placed = branch.placed.map(p => p.skeleton), all = [...constraints.occupied_sessions, ...branch.placed.map(p => p.session)];
    const restMaterial = [], rests = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(constraints.start_date, i);
      if (all.some(s => s.scheduled_local_date === date && s.workout_family !== 'rest')) continue;
      const id = `adaptive-rest-${date}`;
      const reasons = restReasons(date, all, constraints, state, selection);
      rests.push({ session_id: id, requirement_id: 'protect_recovery', role: 'REST', workout_family: 'rest',
        candidate_material_id: id, scheduled_local_date: date });
      restMaterial.push({ material_id: id, source_session: { id, title: 'Rest', reason_codes: reasons,
        adaptive_prescription: { version: 'adaptive-prescription-v1', steps: [],
          objective_ids: selection.weekly_objectives.objectives.filter(o => o.role === 'REST').map(o => o.objective_id),
          progression_family: null, dose_basis: { policy_id: 'adaptive-observed-dose-v1', authority: 'REQUIRED_RECOVERY', source_evidence_ids: [] } } } });
    }
    const skeletonContent = { decision_id: decision.decision_id, decision_hash: decision.decision_hash,
      phase: decision.phase, sessions: [...placed, ...rests], candidate_material: [...material, ...restMaterial] };
    const hash = canonicalHash(skeletonContent);
    const skeleton = { ...skeletonContent, candidate_hash: hash, candidate_skeleton_id: `candidate-${hash.slice(0, 24)}` };
    const full = materializeGoalBackwardCandidate(skeleton, { decision, planning_instant: instant,
      timezone: state.timezone, running_dose_source: runningSource,
      validation_options: { training_age_class: state.training_age_class } });
    const validation = validateAdaptiveCandidate(full, constraints, state, selection);
    tested.push({ candidate_hash: full.candidate_hash, valid: validation.valid, reason_codes: validation.reason_codes });
    if (validation.valid) {
      candidate = { ...full, validation }; selectedBranch = branch;
      restReceipt.push(...full.sessions.filter(s => s.workout_family === 'rest').map(s => ({ date: s.scheduled_local_date,
        session_id: s.session_id, reason_codes: s.purpose_reason_codes.filter(c => !f.decision.phase_reason_codes.includes(c)) })));
      break;
    }
  }
  const omitted = selection.entries.filter((_, i) => !selectedBranch?.mask[i]).map(e => ({
    objective_id: e.objective_ids[0], selection_id: e.selection_id, role: e.role,
    reason_codes: [truncated && nodes >= maxNodes ? 'CANDIDATE_SEARCH_NODE_BUDGET_EXHAUSTED' : 'REQUIRED_EXPOSURE_UNPLACEABLE'] }));
  const deferred = [...selection.deferred_objectives, ...omitted];
  const missedPrimary = deferred.some(d => d.role === 'PRIMARY_KEY' || d.role === 'ASSESSMENT');
  const eventInWindow = decision.goal_gap.some(g => g.goal.planning_eligible && g.goal.event_local_date >= constraints.start_date
    && g.goal.event_local_date <= constraints.end_date && !candidate?.sessions.some(s => s.workout_family === 'race'
      && s.event_identity?.goal_id === g.goal_id && s.scheduled_local_date === g.goal.event_local_date));
  const status = !candidate ? (truncated ? 'DEFERRED' : 'INFEASIBLE') : missedPrimary || eventInWindow ? 'DEFERRED' : deferred.length ? 'VALID_WITH_TRADEOFFS' : 'VALID';
  const resultContent = { status, applicable: Boolean(candidate) && !missedPrimary && !eventInWindow,
    decision, selected_candidate: candidate, deferred_objectives: deferred,
    rest_days: restReceipt,
    strength_dose_receipt: {
      pool_authority: selection.weekly_objectives.dose_policy.strength.basis,
      pool_sets: selection.weekly_objectives.dose_policy.strength.exercises.reduce((n, e) => n + e.sets, 0),
      unpartitioned_sets: selection.weekly_objectives.dose_policy.strength.exercises.reduce((n, e) => n + e.sets, 0)
        - selection.entries.flatMap(e => e.exercises || []).reduce((n, e) => n + e.sets, 0),
      selected_sets: selection.entries.flatMap(e => e.exercises || []).reduce((n, e) => n + e.sets, 0),
      prescribed_sets: candidate?.sessions.filter(s => isStrength(s.workout_family)).reduce((n, s) => n + s.derived_totals.sets, 0) ?? 0,
      withheld_sets: selection.entries.flatMap(e => e.exercises || []).reduce((n, e) => n + e.sets, 0)
        - (candidate?.sessions.filter(s => isStrength(s.workout_family)).reduce((n, s) => n + s.derived_totals.sets, 0) ?? 0),
      reductions: candidate?.sessions.filter(s => s.dose_basis?.variant).map(s => ({ session_id: s.session_id, ...s.dose_basis })) || [],
    }, event_execution_deferred: eventInWindow,
    occupancy: calendarOccupancy({ runCount: selection.entries.filter(e => !isStrength(e.workout_family)).length,
      liftCount: selection.entries.filter(e => isStrength(e.workout_family)).length,
      runEligibleWeekdays: constraints.run.map(w => weekday(w.date)), liftEligibleWeekdays: constraints.lift.map(w => weekday(w.date)), timezone: state.timezone }),
    search: { ...LIMITS, node_limit: maxNodes, expanded_nodes: nodes, truncated, tested_candidates: tested,
      rejection_counts: rejectionCounts, optimality_claimed: false },
    accepted_surface_manifest: null };
  const resultHash = canonicalHash(resultContent);
  // Six truthful existing stages. Surface acceptance belongs to lifecycle/apply.
  const artifactPayloads = [f.artifacts[0].payload_json, state, decision,
    { status, applicable: resultContent.applicable, candidate_hash: candidate?.candidate_hash ?? null,
      result_hash: resultHash, deferred_objectives: deferred, search: resultContent.search },
    candidate?.validation ?? { valid: false, reason_codes: ['REQUIRED_EXPOSURE_UNPLACEABLE'] },
    candidate?.canonical_session_set];
  const kinds = ['evidence_snapshot', 'athlete_state', 'planning_decision', 'candidate_week', 'validator_result', 'canonical_session_set'];
  const artifacts = [];
  for (let i = 0; i < artifactPayloads.length; i++) {
    if (!artifactPayloads[i]) break;
    const artifact = buildPipelineArtifact({ userId: state.athlete_id, kind: kinds[i], decisionId: decision.decision_id,
      parentArtifactId: artifacts.at(-1)?.artifact_id ?? null, payload: artifactPayloads[i], createdAt: instant });
    artifacts.push(artifact);
  }
  return freeze({ ...resultContent, result_hash: resultHash, artifacts });
}
module.exports = { LIMITS, buildAdaptiveCoachingCandidate };
