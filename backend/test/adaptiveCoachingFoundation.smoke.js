const assert = require('node:assert/strict');
const { buildEvidenceSnapshot, buildAthleteState } = require('../src/lib/goalBackwardEvidence');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildFamilyProgression } = require('../src/lib/adaptiveCoachingProgression');
const { buildSessionSelectionContracts } = require('../src/lib/adaptiveCoachingObjectives');
const { selectGoalBackwardPhase } = require('../src/lib/goalBackwardDecisionEngine');
const { canonicalHash, eventPolicyFor } = require('../src/lib/racePlanPolicy');
const { normalizeReasonCode, GOAL_GAP_STATUSES, validatePipelineArtifact } = require('../src/lib/goalBackwardContracts');
const date = '2026-09-14';
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok - ${name}`); }
function fixture({ established = false, feeling = 4, runs = 5, lifts = 2, kind = 'ROAD_SHORT', eventDate = '2026-11-15', timed = false } = {}) {
  const snapshot = buildEvidenceSnapshot({ athleteId: 'synthetic-foundation', timezone: 'UTC', planningInstant: `${date}T12:00:00Z`,
    checkIns: feeling === null ? [] : [{ id: 'readiness', date, feeling }],
    runs: established ? [0, 1, 2, 3].map(i => ({ id: `actual-${i}`, user_id: 'synthetic-foundation',
      date: `2026-09-${String(13 - i * 3).padStart(2, '0')}`, distance_miles: 12, duration_seconds: 6000, type: 'easy' })) : [] });
  const weeks = established ? ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map(week => ({
    week_id: week, distance_m: 30000, duration_s: 10800, forge_native_coverage: true,
  })) : [];
  const goal = { goal_id: 'goal', athlete_id: snapshot.athlete_id, event_kind: kind,
    distance_miles: kind === 'MARATHON' ? 26.21875 : 6.2137119224,
    event_local_date: eventDate, event_state: 'SCHEDULED', ...(timed ? { target_time_s: 2400 } : {}) };
  return { snapshot, context: { target: { runDaysPerWeek: runs, liftDaysPerWeek: lifts,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] } },
    stateOptions: { trainingAgeClass: established ? 'ESTABLISHED' : 'BEGINNER', weeks }, goals: [goal] };
}
function build(options) { return buildAdaptiveCoachingFoundation(fixture(options)); }

test('stable state, revision, decision and all artifact hashes across clock/replay', () => {
  const input = fixture();
  const first = buildAdaptiveCoachingFoundation(input);
  const originalNow = Date.now;
  Date.now = () => { throw new Error('Wall clock forbidden'); };
  try {
    const again = buildAdaptiveCoachingFoundation({ ...input, stateOptions: { ...input.stateOptions, previousState: first.athlete_state } });
    assert.deepEqual(first, again);
  } finally { Date.now = originalNow; }
  for (const artifact of first.artifacts) {
    assert.equal(validatePipelineArtifact(artifact).valid, true);
    assert.equal(artifact.content_hash, `sha256:${canonicalHash(artifact.payload_json)}`);
  }
  assert.deepEqual(first.artifacts.map(a => a.artifact_kind), ['evidence_snapshot', 'athlete_state', 'planning_decision']);
  assert.equal(first.artifacts[2].parent_artifact_id, first.athlete_state.athlete_state_id);
  const changed = buildAdaptiveCoachingFoundation({ ...input, context: { target: { runDaysPerWeek: 2, liftDaysPerWeek: 0 } },
    stateOptions: { ...input.stateOptions, previousState: first.athlete_state } });
  assert.equal(changed.athlete_state.athlete_state_revision, 2);
  assert.notEqual(changed.athlete_state.athlete_state_hash, first.athlete_state.athlete_state_hash);
});
test('unknown evidence stays unknown; requested pace is demand only', () => {
  const r = build({ timed: true, feeling: null });
  assert.equal(r.athlete_state.recent_normal_running.median_distance_m, null);
  assert.equal(r.athlete_state.recovery_state, 'UNKNOWN');
  const gap = r.decision.goal_gap[0];
  assert.equal(gap.demonstrated_fitness.projected_duration_s, null);
  assert.ok(Math.abs(gap.derived_target_pace_s_per_km - 240) < 0.001);
  assert.equal(gap.feasibility_status, 'NOT_CURRENTLY_SUPPORTED');
  assert.equal(gap.training_pace_authority, false);
  assert.ok(r.decision.weekly_objectives.progression.every(p => p.action !== 'ADVANCE'));
});
test('state-led foundation, readiness and true race-week exception; legacy phase unchanged', () => {
  const sparse = build({ kind: 'MARATHON', eventDate: '2026-09-24' });
  assert.equal(sparse.decision.phase, 'FOUNDATION');
  assert.equal(selectGoalBackwardPhase({ goal: sparse.decision.goal_gap[0].goal,
    event_policy: eventPolicyFor('road_marathon_v1'), planning_date_local: date,
    athlete_state: sparse.athlete_state }).phase, 'TAPER_RACE_WEEK');
  assert.equal(build({ eventDate: '2026-09-19' }).decision.phase, 'TAPER_RACE_WEEK');
  assert.equal(build({ established: true }).decision.phase, 'DEVELOPMENT');
  assert.equal(build({ established: true, feeling: 1 }).decision.phase, 'FOUNDATION');
  assert.equal(build({ established: true }).athlete_state.consistent_weeks, 4);
});
test('weekly objectives precede placement and every selection traces to one', () => {
  const r = build({ established: true });
  assert.deepEqual(r.decision.pipeline_stages, ['athlete_state', 'goal_gap', 'phase', 'weekly_objectives', 'session_selection']);
  const ids = new Set(r.decision.weekly_objectives.objectives.map(o => o.objective_id));
  for (const c of r.decision.session_selection.contracts) {
    assert.ok(c.objective_ids.length && c.objective_ids.every(id => ids.has(id)));
    assert.ok(c.progression_family && c.stress_vector.length === 8 && c.priority_rank > 0);
    assert.equal(c.scheduled_local_date, undefined);
  }
  assert.throws(() => buildSessionSelectionContracts({ athleteState: r.athlete_state }), /precede/);
});
test('frequency is a ceiling, keys outrank support, stress and meaningful dose bind', () => {
  const r = build({ established: true, runs: 6, lifts: 5 });
  assert.ok(r.decision.session_selection.used_capacity.run < 6);
  assert.ok(r.decision.session_selection.used_capacity.lift < 5);
  const sparse = build({ established: true, runs: 1 });
  assert.equal(sparse.decision.session_selection.used_capacity.run, 1);
  assert.equal(sparse.decision.session_selection.contracts[0].role, 'PRIMARY_KEY');
  assert.ok(sparse.decision.session_selection.deferred_objectives.length);
  r.decision.session_selection.unstacked_stress_vector.forEach((v, i) => assert.ok(v <= r.decision.weekly_objectives.weekly_stress_budget[i]));
  const input = fixture(); input.context.target.maxSessionMinutes = 5;
  assert.equal(buildAdaptiveCoachingFoundation(input).decision.session_selection.used_capacity.run, 0);
});
function pair(id, outcome = {}) {
  return { prescribed_session: { session_id: id, workout_family: 'easy_run', distance_m: 5000 },
    observation: { linked_session_id: id, evidence_id: id, quality_state: 'COMPLETE',
      observed_at: id === 'one' ? '2026-09-07T12:00:00Z' : '2026-09-10T12:00:00Z',
      completed: true, observed_distance_m: 5000, ...outcome } };
}
test('planned versus actual progression advances only from repeated linked complete evidence', () => {
  const state = build({ established: true }).athlete_state;
  const progress = (pairs, extra = {}) => buildFamilyProgression({ athleteState: state, completionPairs: pairs,
    weeklyMileageHistory: [20, 20, 20, 20], readinessTrend: 'stable', phase: 'DEVELOPMENT', ...extra }).find(p => p.family === 'aerobic_volume');
  assert.equal(progress([]).action, 'HOLD');
  assert.equal(progress([pair('one')]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two')]).action, 'ADVANCE');
  assert.equal(progress([pair('one'), pair('one')]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two', { evidence_id: 'one' })]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two'), pair('latest', { quality_state: 'PARTIAL', observed_at: '2026-09-13T12:00:00Z' })]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two', { quality_state: 'PARTIAL' })]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two', { completed: false })]).action, 'HOLD');
  assert.equal(progress([pair('one'), pair('two', { excessive_strain: true })]).action, 'REGRESS');
  assert.equal(progress([pair('one'), pair('two')], { athleteState: { ...state, safety_action: 'FULL_REST' } }).action, 'OMIT');
  assert.equal(progress([pair('one'), pair('two')], { phase: 'TAPER_RACE_WEEK' }).action, 'HOLD');
  assert.equal(progress([pair('one', { observed_distance_m: null }), pair('two', { observed_distance_m: null })]).action, 'HOLD');
});
test('sport/event classes produce bounded foundation outputs and registered reasons', () => {
  const classes = [
    { runs: 2, lifts: 0 }, { established: true, runs: 3 }, { established: true, runs: 6, lifts: 4 },
    { established: true, feeling: 2 }, { established: true, kind: 'MARATHON', timed: true },
    { established: true, eventDate: '2026-09-19' }, { established: true, kind: 'HYROX_SINGLES' },
    { established: true, kind: 'HYROX_DOUBLES', timed: true },
  ];
  for (const options of classes) {
    const r = build(options);
    assert.ok(GOAL_GAP_STATUSES.includes(r.decision.goal_gap[0].feasibility_status));
    const reasons = r.decision.weekly_objectives.objectives.flatMap(o => o.reason_codes)
      .concat(r.decision.goal_gap.flatMap(g => g.reason_codes), r.decision.weekly_objectives.progression.flatMap(p => p.reason_codes));
    reasons.forEach(code => assert.ok(normalizeReasonCode(code), code));
  }
  const road = build({ established: true }), hyrox = build({ established: true, kind: 'HYROX_SINGLES' });
  assert.notDeepEqual(road.decision.weekly_objectives.objectives.map(o => o.requirement_id), hyrox.decision.weekly_objectives.objectives.map(o => o.requirement_id));
});
test('legacy state shape unchanged, capacities validated and foreign evidence rejected', () => {
  const input = fixture();
  assert.equal(buildAthleteState({ snapshot: input.snapshot }).adaptive_foundation, undefined);
  input.context.target.runDaysPerWeek = -1;
  assert.throws(() => buildAdaptiveCoachingFoundation(input), /capacity/);
  assert.throws(() => buildAdaptiveCoachingFoundation({ ...fixture(), completionPairs: [pair('foreign')] }), /outside snapshot/);
});

test('demonstrated fitness uses canonical observed numbers, unsupported pace cannot authorize specificity', () => {
  const input = fixture({ established: true });
  input.goals[0] = { ...input.goals[0], distance_miles: 12, target_time_s: 6500 };
  input.stateOptions.performanceAnchors = [{ evidence_id: 'actual-0', goal_id: 'goal',
    specificity: 'SAME_DISTANCE', observation_kind: 'RACE', verified: true,
    distance_m: 10000, duration_s: 1000 }];
  input.feasibilityByGoal = { goal: { workload_path_passes: true, mandatory_exposures_complete: true } };
  input.phaseEvidence = { development_gate_complete: true };
  const supported = buildAdaptiveCoachingFoundation(input);
  assert.equal(supported.decision.goal_gap[0].demonstrated_fitness.projected_duration_s, 6000);
  assert.equal(supported.decision.goal_gap[0].feasibility_status, 'SUPPORTED');
  assert.equal(supported.decision.phase, 'EVENT_SPECIFIC_DEVELOPMENT');
  input.goals[0].target_time_s = 5000;
  const unsupported = buildAdaptiveCoachingFoundation(input);
  assert.equal(unsupported.decision.goal_gap[0].feasibility_status, 'NOT_CURRENTLY_SUPPORTED');
  assert.equal(unsupported.decision.goal_gap[0].gap_seconds, 1000);
  assert.equal(unsupported.decision.phase, 'DEVELOPMENT');
});
test('completion evidence changes the next objectives and revision, with no calendar advancement', () => {
  const input = fixture({ established: true });
  const pairs = ['actual-2', 'actual-1'].map(id => {
    const a = input.snapshot.canonical_activities.find(a => a.evidence_ids.includes(id));
    return { prescribed_session: { session_id: id, workout_family: 'easy_run', distance_m: a.distance_m },
      observation: { evidence_id: id, linked_session_id: id, observed_at: a.observed_at,
        completed: true, quality_state: 'COMPLETE', observed_distance_m: a.distance_m } };
  });
  const before = buildAdaptiveCoachingFoundation(input);
  const after = buildAdaptiveCoachingFoundation({ ...input, completionPairs: pairs,
    weeklyMileageHistory: [20, 20, 20, 20], readinessTrend: 'stable',
    stateOptions: { ...input.stateOptions, previousState: before.athlete_state } });
  const family = r => r.decision.weekly_objectives.progression.find(p => p.family === 'aerobic_volume');
  assert.equal(family(before).action, 'HOLD');
  assert.equal(family(after).action, 'ADVANCE');
  assert.equal(after.athlete_state.athlete_state_revision, 2);
  assert.notEqual(before.decision.weekly_objectives.weekly_objectives_hash, after.decision.weekly_objectives.weekly_objectives_hash);
});
test('dual-goal ownership and event lifecycle remain policy-driven', () => {
  const input = fixture({ established: true });
  input.goals[0].priority = 'A';
  input.goals.push({ ...input.goals[0], goal_id: 'second', event_local_date: '2026-12-20', priority: 'B' },
    { ...input.goals[0], goal_id: 'foreign', athlete_id: 'someone-else', priority: 'A' });
  assert.deepEqual(buildAdaptiveCoachingFoundation(input).decision.goal_gap.map(g => g.goal_id), ['goal', 'second']);
  input.goals = [{ ...input.goals[0], event_state: 'COMPLETED' }];
  assert.equal(buildAdaptiveCoachingFoundation(input).decision.phase, 'POST_RACE_TRANSITION');
});
test('current context safety tightens state even without a duplicated report', () => {
  const input = fixture({ established: true });
  input.context.safety = { activeInjury: true };
  const r = buildAdaptiveCoachingFoundation(input);
  assert.equal(r.decision.phase, 'FOUNDATION');
  assert.equal(r.athlete_state.consistent_weeks, 0);
  assert.equal(r.decision.session_selection.contracts.length, 0);
});
console.log(`Adaptive coaching foundation: ${count} tests passed.`);
