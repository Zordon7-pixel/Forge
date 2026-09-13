// Internal domain acceptance plus existing accepted-canonical FIT contract.
// These synthetic domain inputs are NOT route-provider coverage attestations.
// Route/SQL acceptance lives in adaptiveCoachingShadow.smoke.js.
const assert = require('node:assert/strict');
const { fixture, windows, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { roadInput, hybridInput, establishDimensions } = require('./adaptiveCoachingDomain.smoke');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { buildOwnedEventMaterial, ownedEventEntries } = require('../src/lib/adaptiveCoachingDomain');
const { buildCanonicalSession, validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const clone = v => JSON.parse(JSON.stringify(v));
function solve(input, availability = windows(), events = false) {
  const foundation = buildAdaptiveCoachingFoundation(input);
  const result = buildAdaptiveCoachingCandidate({ foundation, availability,
    ...(events ? { domain: { event_material: buildOwnedEventMaterial(foundation) } } : {}) });
  assert.ok(result.selected_candidate, JSON.stringify(result.search.tested_candidates));
  assert.equal(result.selected_candidate.validation.valid, true);
  assert.equal(validateCanonicalSessionSet(result.selected_candidate.canonical_session_set).valid, true);
  assert.equal(result.accepted_surface_manifest, null, 'internal SHADOW never accepts an export manifest');
  return result;
}
const active = result => result.selected_candidate.sessions.filter(s => s.workout_family !== 'rest');
function check(id, fn) { fn(); console.log(`ok - acceptance ${id}`); }
const ordinary = solve(fixture(4, 1, 240));
check('A E F G K: capacity, objective order, trace, rest, determinism', () => {
  const stages = ordinary.decision.pipeline_stages;
  assert.ok(stages.indexOf('weekly_objectives') < stages.indexOf('joint_constraint_solver'));
  assert.ok(active(ordinary).filter(s => s.kind === 'run').length <= 4);
  const ids = new Set(ordinary.decision.weekly_objectives.objectives.map(o => o.objective_id));
  assert.ok(ordinary.selected_candidate.sessions.every(s => s.objective_ids.length && s.objective_ids.every(id => ids.has(id))));
  assert.ok(ordinary.rest_days.length && ordinary.rest_days.every(r => r.reason_codes.length));
  assert.equal(ordinary.decision.decision_hash, solve(fixture(4, 1, 240)).decision.decision_hash);
  const low = solve(fixture(6, 0, 60));
  assert.ok(active(low).filter(s => s.kind === 'run').length < 6, 'six opportunities do not manufacture six doses');
});
check('B C H: key placement is lock/physiology-led', () => {
  const input = roadInput('2026-11-15'); input.context.target.liftDaysPerWeek = 0;
  const result = solve(input, { ...windows(), locks: [
    { constraint_kind: 'day_lock', workout_family: 'threshold_run', scheduled_local_date: '2026-09-18' },
    { constraint_kind: 'day_lock', workout_family: 'long_aerobic', scheduled_local_date: '2026-09-15' },
  ] });
  const sessions = active(result);
  assert.equal(sessions.find(s => s.workout_family === 'threshold_run').scheduled_local_date, '2026-09-18');
  assert.equal(sessions.find(s => s.workout_family === 'long_aerobic').scheduled_local_date, '2026-09-15');
  assert.ok(sessions.some(s => s.kind === 'run' && s.scheduled_local_date > '2026-09-15'));
  assert.ok(result.selected_candidate.validation.validator_results.find(v => v.validator === 'adaptive_actual_placement').interference.valid);
});
check('D J: same calendar, different state; target demand has no pace authority', () => {
  const ready = roadInput('2026-11-15'), sparse = clone(ready);
  sparse.stateOptions.weeks = []; sparse.stateOptions.trainingAgeClass = 'BEGINNER'; sparse.completionPairs = [];
  const a = buildAdaptiveCoachingFoundation(ready), b = buildAdaptiveCoachingFoundation(sparse);
  assert.notEqual(a.decision.phase, b.decision.phase);
  assert.equal(b.decision.phase, 'FOUNDATION');
  ready.goals[0].target_time_s = 1000;
  const result = solve(ready), gap = result.decision.goal_gap[0];
  assert.ok(Math.abs(gap.derived_target_pace_s_per_km - 200) < 0.00001);
  assert.equal(gap.training_pace_authority, false);
  assert.ok(active(result).flatMap(s => s.steps).every(s => !s.target?.pace_range_s_per_km));
});
check('I: supporting strength reduction preserves selected running work', () => {
  const input = withObservedWork(fixture(3, 1, 180), { strengthSets: 6, quality: true });
  input.goals = roadInput('2026-11-15').goals;
  const availability = windows();
  availability.lift = [{ start_at: '2026-09-16T17:00:00Z', end_at: '2026-09-16T17:45:00Z' }];
  const result = solve(input, availability);
  assert.equal(active(result).filter(s => s.kind === 'run').length, 3);
  assert.equal(active(result).filter(s => ['threshold_run', 'long_aerobic'].includes(s.workout_family) && s.role === 'PRIMARY_KEY').length, 2);
  assert.ok(result.strength_dose_receipt.withheld_sets > 0, 'supporting strength is reduced or omitted while both primary road keys remain');
  assert.ok(result.strength_dose_receipt.prescribed_sets < result.strength_dose_receipt.selected_sets);
});
check('L: measured outcomes change family action without calendar advancement', () => {
  const input = withObservedWork(fixture(4, 0, 240), { quality: true });
  input.goals = roadInput('2026-11-15').goals;
  const second = clone(input.completionPairs[0]);
  second.prescribed_session = buildCanonicalSession({ ...second.prescribed_session, session_id: 'second-observed-quality' });
  second.observation = { ...second.observation, linked_session_id: 'second-observed-quality',
    evidence_id: input.snapshot.canonical_activities[2].evidence_ids[0], observed_at: '2026-09-13T12:00:00Z' };
  input.completionPairs.push(second);
  const good = buildAdaptiveCoachingFoundation(input);
  const changed = clone(input);
  for (const p of changed.completionPairs.filter(p => p.prescribed_session.workout_family === 'threshold_run')) {
    p.observation.completed = false; p.observation.target_met = false;
    p.observation.observed_duration_s = 600; p.observation.observed_distance_m = 1000;
  }
  const bad = buildAdaptiveCoachingFoundation(changed);
  const action = f => f.decision.weekly_objectives.progression.find(p => p.family === 'threshold').action;
  assert.equal(action(good), 'ADVANCE'); assert.equal(action(bad), 'REGRESS');
  assert.equal(good.athlete_state.planning_date_local, bad.athlete_state.planning_date_local);
  assert.notEqual(good.decision.decision_hash, bad.decision.decision_hash);
});
check('M: taper lowers stress and dose while retaining an intensity touch', () => {
  const input = roadInput('2026-11-15');
  const normal = solve(input);
  input.goals[0].event_local_date = '2026-09-19';
  const taper = solve(input, windows(), true);
  assert.equal(taper.decision.phase, 'TAPER_RACE_WEEK');
  assert.ok(active(taper).filter(s => s.kind === 'run').length >= 2);
  assert.ok(active(taper).some(s => s.workout_family === 'threshold_run'));
  assert.ok(taper.decision.weekly_objectives.weekly_stress_budget.reduce((a,b) => a+b,0)
    < normal.decision.weekly_objectives.weekly_stress_budget.reduce((a,b) => a+b,0));
  assert.ok(active(taper).reduce((n,s) => n+s.derived_totals.duration_s,0)
    < active(normal).reduce((n,s) => n+s.derived_totals.duration_s,0));
  assert.equal(taper.event_execution_deferred, false);
  const event = active(taper).find(s => s.workout_family === 'race');
  assert.equal(event.event_identity.race_id, input.goals[0].race_id);
  assert.equal(event.derived_totals.work_distance_m, 5000);
});
check('O P: meaningful 2–6 running and 0–5 strength structures', () => {
  const counts = [], strengths = [];
  for (let n = 2; n <= 6; n++) {
    const r = solve(fixture(n, 0, 300)); const runs = active(r).filter(s => s.kind === 'run');
    counts.push(runs.length); assert.ok(runs.every(s => s.derived_totals.duration_s >= 1500));
  }
  for (let n = 0; n <= 5; n++) {
    const r = solve(withObservedWork(fixture(2, n, 180), { strengthSets: 6 }));
    const lifts = active(r).filter(s => s.kind === 'lift'); strengths.push(lifts.length);
    assert.ok(lifts.every(s => s.steps.filter(t => t.type === 'strength_exercise').length >= 2));
  }
  assert.deepEqual(counts, [2,3,4,5,6]); assert.deepEqual(strengths, [0,1,2,3,4,5]);
});
check('P source boundary: completion duration cannot invent observed sets', () => {
  const input = withObservedWork(fixture(2,5,180), { strengthSets: 6 });
  input.snapshot = require('../src/lib/goalBackwardEvidence').buildEvidenceSnapshot({
    athleteId: input.snapshot.athlete_id, timezone: 'UTC', planningInstant: '2026-09-14T00:00:00Z',
    runs: input.snapshot.canonical_activities.map(a => ({ id: a.evidence_ids[0], date: a.local_activity_date,
      distance_miles: a.distance_m / 1609.344, duration_seconds: a.duration_s })),
    lifts: [{ id: 'observed-lift', date: '2026-09-10', workout_duration_seconds: 3600 }],
    checkIns: [{ id: 'ready', date: '2026-09-14', feeling: 4 }] });
  const r = solve(input);
  assert.equal(r.strength_dose_receipt.pool_authority, 'EXISTING_MINIMUM_MAINTENANCE_POLICY');
  assert.equal(r.strength_dose_receipt.pool_sets, 4);
  assert.ok(active(r).filter(s => s.kind === 'lift').length <= 1);
  assert.equal(r.decision.weekly_objectives.dose_policy.strength.individual_exercise_completion_verified, false);
});
check('event material retains explicit priority without borrowing goal pace', () => {
  const input = roadInput();
  input.goals[0].priority = 'B';
  input.goals.push({ ...input.goals[0], goal_id: 'priority-a', race_id: 'priority-a-event', priority: 'A', event_local_date: '2026-09-20' });
  const f = buildAdaptiveCoachingFoundation(input);
  const entries = ownedEventEntries(f, buildOwnedEventMaterial(f));
  assert.equal(entries.length, 2);
  assert.ok(entries.find(e => e.event_identity.goal_id === 'priority-a').priority_score
    > entries.find(e => e.event_identity.goal_id === input.goals[0].goal_id).priority_score);
});
check('eight classes: nontrivial internal schedule summaries and distinct constraints', () => {
  const sparse = fixture(2,0,60); sparse.stateOptions.trainingAgeClass = 'BEGINNER'; sparse.stateOptions.weeks = [];
  sparse.goals = [{ ...roadInput('2026-10-01').goals[0], target_time_s: 1000 }];
  const returning = fixture(3,1,120); returning.stateOptions.trainingAgeClass = 'RETURNING'; returning.stateOptions.weeks = [];
  returning.context.safety = { comebackMode: true };
  const developing = establishDimensions(withObservedWork(fixture(3,2,180), { quality: true }));
  developing.goals = roadInput('2026-11-15').goals;
  developing.context.target.liftDaysPerWeek = 2; developing.stateOptions.trainingAgeClass = 'DEVELOPING';
  const high = establishDimensions(withObservedWork(fixture(6,4,360), { strengthSets: 6 }));
  const timed = roadInput('2026-11-15'); timed.context.target.runDaysPerWeek = 5;
  timed.goals[0] = { ...timed.goals[0], event_kind: 'ROAD_ENDURANCE', distance_miles: 13.1094, target_time_s: 6000 };
  const dual = roadInput('2026-11-15'); dual.goals.push({ ...dual.goals[0], goal_id: 'second-goal', race_id: 'second-event', event_local_date: '2026-12-15', priority: 'B' });
  const classes = [['sparse beginner road', sparse], ['developing hybrid', developing], ['established high-frequency hybrid', high],
    ['returning interrupted', returning], ['timed endurance', timed], ['short runway A-race', roadInput()], ['dual goal', dual], ['HYROX', hybridInput()]];
  const signatures = new Set();
  for (const [name,input] of classes) {
    const r = solve(input, windows(), true), sessions = active(r);
    assert.ok(sessions.length >= 1 && sessions.every(s => s.derived_totals.duration_s > 0), name);
    assert.equal(r.applicable, true, name);
    const summary = { structural_class: name, phase: r.decision.phase, safety_action: r.decision.safety_state.action, capacities: r.decision.weekly_objectives.capacities,
      owned_goals: r.decision.goal_gap.map(g => ({ kind: g.goal.event_kind, date: g.goal.event_local_date, priority: g.goal.priority })),
      sessions: sessions.map(s => ({ date: s.scheduled_local_date, family: s.workout_family, role: s.role,
        duration_s: s.derived_totals.duration_s, sets: s.derived_totals.sets })), rest: r.rest_days,
      mandatory_objectives: r.decision.weekly_objectives.objectives.filter(o => o.role === 'PRIMARY_KEY').length,
      decision_hash: r.decision.decision_hash };
    signatures.add(canonicalHash({ phase: summary.phase,
      families: summary.sessions.map(s => [s.family,s.duration_s,s.sets]) }));
    console.log(JSON.stringify(summary));
  }
  assert.equal(signatures.size, 8);
});
async function acceptedFitContract() {
  // A separate synthetic PRE-EXISTING accepted canonical contract, never a
  // manifest created for an adaptive SHADOW candidate or a mode activation.
  const { buildFitWorkoutRepresentation } = await import('../../frontend/src/services/fit/encodeWorkoutFit.js');
  const seed = require('../src/lib/canonicalWorkout').materializeCanonicalSession({
    decision: { decision_id: 'accepted-contract-decision', decision_hash: 'd'.repeat(64), phase: 'FOUNDATION', active_goals: [] },
    source: { id: 'accepted-contract-run', duration_s: 1800, distance_m: 5000 },
    skeleton: { session_id: 'accepted-contract-run', workout_family: 'easy_run', role: 'SUPPORTING', scheduled_local_date: '2026-09-01' },
    planning_instant: '2026-09-01T00:00:00Z', timezone: 'UTC' });
  const session = buildCanonicalSession({ ...seed, steps: seed.steps.map(s => ({ ...s,
    target: { distance_m: 5000 }, provenance: s.provenance.map(p => ({ ...p, canonical_units: ['m'] })) })) });
  const manifest = { schema_version: 'goal_backward_surface_manifest_v1', surface_revision: 1,
    feature_mode: 'on', v24_surface_enabled: true, status: 'accepted',
    identity: { decision_id: session.decision_id, decision_hash: 'd'.repeat(64),
      candidate_id: 'existing-contract', candidate_revision: 1, candidate_hash: 'b'.repeat(64),
      plan_id: session.plan_id, plan_revision: session.plan_revision,
      canonical_session_set_hash: 'c'.repeat(64),
      athlete_state_revision: 1, safety_state_hash: `sha256:${'a'.repeat(64)}`, goal_revisions: {} },
    purpose: 'Accepted contract fixture', feasibility: { status: 'supported', reason_codes: [] },
    safety: { action: 'NORMAL', scope: [], reason_codes: [] }, weeks: [], sessions: [session] };
  const before = canonicalHash(session);
  const fit = buildFitWorkoutRepresentation({ surfaceManifest: manifest, sessionId: session.session_id, exportRevision: 1 });
  assert.deepEqual(fit.canonical_steps, session.steps);
  assert.deepEqual(fit.target_provenance, session.target_provenance);
  assert.deepEqual(fit.capability, session.capability);
  assert.equal(canonicalHash(session), before);
  assert.throws(() => buildFitWorkoutRepresentation({ surfaceManifest: { ...manifest, status: 'shadow' }, sessionId: session.session_id, exportRevision: 1 }));
  console.log('ok - acceptance N: existing accepted canonical FIT intent equality; SHADOW rejected');
}
acceptedFitContract().catch(error => { console.error(error); process.exitCode = 1; });
