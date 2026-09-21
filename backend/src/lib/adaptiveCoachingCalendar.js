// Bounded forward calendar composition. Observations and athlete state are immutable;
// only policy decisions move through time. Planned sessions constrain later windows.
const { addDays, daysBetween, mondayFor, canonicalHash, eventPolicyForGoal } = require('./racePlanPolicy');
const { buildPipelineArtifact } = require('./planCandidateLifecycle');
const MAX_DAYS = 42;
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function resolveWindow(start, dates = []) {
  if (![start, ...dates].every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d)) throw new Error('Invalid calendar date');
  const end = dates.length ? [...dates].sort().at(-1) : addDays(start, 6);
  const days = daysBetween(start, end) + 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw Object.assign(new Error('RACE_CALENDAR_HORIZON_UNSUPPORTED'), { code: 'RACE_CALENDAR_HORIZON_UNSUPPORTED' });
  return { start_date: start, end_date: end, day_count: days };
}
function project(foundation, window) {
  const state = foundation.athlete_state;
  const gaps = foundation.decision.goal_gap;
  const primary = gaps.find(g => g.goal.planning_eligible && g.goal.event_local_date >= window.start_date) || gaps[0];
  const policy = primary && eventPolicyForGoal(primary.goal);
  const phase = require('./goalBackwardDecisionEngine').selectGoalBackwardPhase({ goal: primary?.goal || {},
    event_policy: policy, planning_date_local: window.start_date, candidate_window_end_local: window.end_date,
    athlete_state: state, goal_gap: primary, phase_authority: 'adaptive-foundation-v1',
    due_exposure_count: policy?.required_exposure_ledger?.EVENT_SPECIFIC_DEVELOPMENT?.length || 0 });
  const progression = require('./adaptiveCoachingProgression').buildFamilyProgression({ athleteState: state,
    completionPairs: state.adaptive_foundation.completion_pairs,
    weeklyMileageHistory: state.adaptive_foundation.weekly_mileage_history,
    readinessTrend: state.adaptive_foundation.readiness_trend, phase: phase.phase });
  const weekly = require('./adaptiveCoachingObjectives').buildWeeklyObjectives({ athleteState: state,
    goalGaps: primary ? [primary, ...gaps.filter(g => g !== primary)] : gaps, phaseDecision: phase, progression });
  weekly.objectives = weekly.objectives.map(o => ({ ...o, objective_id: `${window.start_date}-${o.objective_id}` }));
  delete weekly.weekly_objectives_hash;
  weekly.weekly_objectives_hash = canonicalHash(weekly);
  const content = { ...clone(foundation.decision), phase: phase.phase, phase_reason_codes: phase.reason_codes,
    calendar_window: window, goal_gap: primary ? [primary, ...gaps.filter(g => g !== primary)] : gaps, weekly_objectives: weekly,
    session_selection: require('./adaptiveCoachingObjectives').buildSessionSelectionContracts({ athleteState: state, weeklyObjectives: weekly }) };
  delete content.decision_id; delete content.decision_hash;
  const hash = canonicalHash(content), decision = { ...content, decision_id: `decision-${hash.slice(0, 24)}`, decision_hash: hash };
  return freeze({ ...foundation, decision });
}
function buildProgram({ foundation, availability, calendarWindow, search }) {
  const ownedDates = foundation.decision.goal_gap.filter(g => g.goal.planning_eligible && g.goal.race_id).map(g => g.goal.event_local_date);
  const resolved = resolveWindow(foundation.athlete_state.planning_date_local, [calendarWindow.end_date]);
  if (!ownedDates.includes(calendarWindow.end_date) || canonicalHash(resolved) !== canonicalHash(calendarWindow)) throw new Error('Calendar must end on an owned event date');
  const { normalizeSolverConstraints } = require('./adaptiveCoachingValidation');
  // Validate the complete extended pool before slicing; arbitrary out-of-window
  // availability cannot disappear during weekly composition.
  normalizeSolverConstraints(foundation.athlete_state, availability, calendarWindow);
  const windows = [], planned = [];
  for (let start = calendarWindow.start_date; start <= calendarWindow.end_date;) {
    const sunday = addDays(mondayFor(start), 6);
    const end = sunday < calendarWindow.end_date ? sunday : calendarWindow.end_date;
    const window = { start_date: start, end_date: end, day_count: daysBetween(start, end) + 1 };
    const projected = project(foundation, window);
    const dateOf = w => require('./adaptiveCoachingValidation').localDate(w.start_at, foundation.athlete_state.timezone);
    const inBoundary = s => s.scheduled_local_date >= addDays(start, -6) && s.scheduled_local_date <= addDays(end, 6);
    const pool = { ...availability, run: availability.run.filter(w => dateOf(w) >= start && dateOf(w) <= end),
      lift: availability.lift.filter(w => dateOf(w) >= start && dateOf(w) <= end),
      blocked_dates: (availability.blocked_dates || []).filter(d => d >= start && d <= end),
      occupied_sessions: (availability.occupied_sessions || []).filter(inBoundary),
      planned_sessions: planned.filter(s => s.workout_family !== 'rest' && inBoundary(s)),
      rolling_policy: windows[0]?.result.decision.weekly_objectives };
    const result = require('./adaptiveCoachingSolver').buildAdaptiveCoachingCandidate({ foundation: projected,
      availability: pool, domain: { event_material: require('./adaptiveCoachingDomain').buildOwnedEventMaterial(projected) }, search });
    windows.push({ ...window, result });
    if (!result.applicable) return freeze({ ...result, calendar_window: calendarWindow,
      failed_calendar_window: window, calendar_windows: windows.map(w => ({ start_date: w.start_date, end_date: w.end_date,
        phase: w.result.decision.phase, weekly_objectives: w.result.decision.weekly_objectives })) });
    planned.push(...result.selected_candidate.sessions);
    start = addDays(end, 1);
  }
  const first = windows[0].result;
  const content = { ...clone(first.decision), calendar_window: calendarWindow,
    calendar_windows: windows.map(w => ({ start_date: w.start_date, end_date: w.end_date,
      phase: w.result.decision.phase, phase_reason_codes: w.result.decision.phase_reason_codes,
      weekly_objectives: w.result.decision.weekly_objectives, decision_hash: w.result.decision.decision_hash,
      candidate_hash: w.result.selected_candidate.candidate_hash })) };
  delete content.decision_id; delete content.decision_hash;
  const decisionHash = canonicalHash(content);
  const decision = { ...content, decision_id: `decision-${decisionHash.slice(0, 24)}`, decision_hash: decisionHash };
  const canonical = require('./canonicalWorkout');
  const planId = `candidate-plan-${decisionHash.slice(0, 24)}`;
  const sessions = planned.map(session => {
    const next = clone(session);
    next.plan_id = planId;
    const rebind = v => { if (!v || typeof v !== 'object') return; if (Object.hasOwn(v, 'decision_id')) v.decision_id = decision.decision_id; Object.values(v).forEach(rebind); };
    rebind(next);
    next.content_hash = canonical.canonicalWorkoutHash(next);
    return next;
  });
  const skeletonHash = canonicalHash(content.calendar_windows);
  const set = { ...clone(first.selected_candidate.canonical_session_set), plan_id: planId,
    decision_id: decision.decision_id, decision_hash: decisionHash, candidate_id: `candidate-${skeletonHash.slice(0, 24)}`,
    candidate_skeleton_hash: skeletonHash, sessions,
    session_content_hashes: sessions.map(s => ({ session_id: s.session_id, content_hash: s.content_hash })),
    derived_totals: Object.fromEntries(Object.keys(sessions[0].derived_totals).map(k => [k, sessions.reduce((n, s) => n + Number(s.derived_totals[k] || 0), 0)])) };
  set.content_hash = canonical.canonicalSessionSetHash(set);
  set.candidate_hash = canonicalHash({ candidate_skeleton_hash: skeletonHash, canonical_session_set_hash: set.content_hash });
  if (!canonical.validateCanonicalSessionSet(set).valid) throw new Error('Invalid adaptive calendar composition');
  const validation = { valid: true, violations: [], reason_codes: [], validator_results: windows.flatMap(w =>
    w.result.selected_candidate.validation.validator_results.map(v => ({ ...v, window_start: w.start_date }))) };
  const selected = { ...first.selected_candidate, decision_id: decision.decision_id, decision_hash: decisionHash,
    skeleton_sessions: windows.flatMap(w => w.result.selected_candidate.skeleton_sessions),
    candidate_material: windows.flatMap(w => w.result.selected_candidate.candidate_material), candidate_hash: set.candidate_hash, candidate_skeleton_id: set.candidate_id,
    sessions, canonical_sessions: sessions, canonical_session_set: set, validation,
    canonical_plan: require('./planSchema').buildCanonicalPlanFromSessionSet(set) };
  selected.material_change = require('./goalBackwardValidators').compareMaterialChange({ candidate: { phase: decision.phase, goal_priority: null, safety_scope: decision.safety_state?.scope ?? null,
      executability: sessions.some(s => s.executability !== 'EXECUTABLE') ? 'RESTRICTED' : 'EXECUTABLE',
      plan_revision: set.plan_revision, sessions },
    decision_id: decision.decision_id, candidate_hash: set.candidate_hash, canonical_session_set_hash: set.content_hash, require_canonical_bindings: true });
  const result = { ...first, decision, selected_candidate: selected, calendar_window: calendarWindow,
    deferred_objectives: windows.flatMap(w => w.result.deferred_objectives), rest_days: windows.flatMap(w => w.result.rest_days),
    occupancy: { windows: windows.map(w => ({ start_date: w.start_date, ...w.result.occupancy })) },
    strength_dose_receipt: { windows: windows.map(w => ({ start_date: w.start_date, ...w.result.strength_dose_receipt })) },
    search: { windows: windows.map(w => ({ start_date: w.start_date, ...w.result.search })), optimality_claimed: false },
    status: windows.some(w => w.result.status === 'VALID_WITH_TRADEOFFS') ? 'VALID_WITH_TRADEOFFS' : 'VALID' };
  delete result.artifacts; delete result.result_hash;
  result.result_hash = canonicalHash(result);
  const payloads = [foundation.artifacts[0].payload_json, foundation.athlete_state, decision,
    { status: result.status, applicable: true, candidate_hash: set.candidate_hash, result_hash: result.result_hash,
      calendar_window: calendarWindow, search: result.search }, validation, set];
  const kinds = ['evidence_snapshot', 'athlete_state', 'planning_decision', 'candidate_week', 'validator_result', 'canonical_session_set'];
  const artifacts = [];
  payloads.forEach((payload, i) => artifacts.push(buildPipelineArtifact({ userId: foundation.athlete_state.athlete_id,
    kind: kinds[i], decisionId: decision.decision_id, parentArtifactId: artifacts.at(-1)?.id ?? null,
    payload, createdAt: foundation.artifacts[0].created_at })));
  return freeze({ ...result, artifacts });
}
module.exports = { MAX_DAYS, resolveWindow, project, buildProgram };
