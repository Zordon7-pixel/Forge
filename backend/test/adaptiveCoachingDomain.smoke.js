const assert = require('node:assert/strict');
const { fixture, windows, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildCanonicalSession, materializeCanonicalSession, validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { buildAdaptiveWorkoutMaterial } = require('../src/lib/adaptiveCoachingWorkouts');
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function test(name, fn) { if (require.main !== module) return; fn(); console.log(`ok - ${name}`); checks++; }
function valid(result) {
  assert.ok(result.selected_candidate, JSON.stringify({ deferred: result.deferred_objectives, tested: result.search.tested_candidates, rejects: result.search.rejection_counts }));
  assert.equal(result.selected_candidate.validation.valid, true);
  assert.equal(validateCanonicalSessionSet(result.selected_candidate.canonical_session_set).valid, true);
  assert.ok(result.rest_days.every(d => d.reason_codes.length));
  return result.selected_candidate.sessions;
}
function establishDimensions(input) {
  input.stateOptions.weeks.forEach(w => { w.modality_eligibility = Object.fromEntries(Object.keys(w.stress_dimensions).map(k => [k, { eligible: true }])); });
  return input;
}
function roadInput(date = '2026-09-19') {
  const input = establishDimensions(withObservedWork(fixture(4, 1, 300), { quality: true }));
  input.goals = [{ goal_id: 'road-domain', race_id: 'owned-event', athlete_id: input.snapshot.athlete_id,
    event_kind: 'ROAD_SHORT', distance_miles: 5000 / 1609.344, event_local_date: date,
    event_state: 'SCHEDULED', event_revision: 2, source_revision: 3 }];
  return input;
}
function raceMaterial(foundation) {
  const goal = foundation.decision.goal_gap[0].goal;
  const entry = { selection_id: 'supplied-road-event', workout_family: 'race', objective_ids: ['source-event'],
    progression_family: null, duration_s: 2100, distance_m: 5000, quality_work_s: null,
    event_identity: Object.fromEntries(['athlete_id','race_id','goal_id','event_local_date','event_kind','event_revision','source_revision'].map(k => [k, goal[k]])),
    dose_basis: { policy_id: 'adaptive-observed-dose-v1', authority: 'OWNED_EVENT_PRESCRIPTION', source_evidence_ids: [] },
    reason_codes: ['WEEKLY_OBJECTIVE_REQUIRED'] };
  const material = buildAdaptiveWorkoutMaterial(entry, foundation.decision, '2026-09-14T00:00:00Z');
  for (const step of material.source_session.adaptive_prescription.steps) {
    if (step.step_role === 'WORK') step.target.distance_m = 5000;
    else delete step.target.distance_m;
  }
  return materializeCanonicalSession({ decision: { ...foundation.decision, active_goals: [goal] },
    source: material.source_session, skeleton: { session_id: entry.selection_id, workout_family: 'race', role: 'PRIMARY_KEY', scheduled_local_date: goal.event_local_date },
    planning_instant: '2026-09-14T00:00:00Z', timezone: 'UTC' });
}
test('owned road event executes on exact date through solver and all validators', () => {
  const foundation = buildAdaptiveCoachingFoundation(roadInput());
  const material = raceMaterial(foundation);
  const input = { foundation, availability: windows(), domain: { event_material: [material] } };
  const r = buildAdaptiveCoachingCandidate(input);
  const sessions = valid(r);
  assert.equal(r.event_execution_deferred, false);
  assert.equal(r.applicable, true);
  const event = sessions.find(s => s.workout_family === 'race');
  assert.equal(event.scheduled_local_date, '2026-09-19');
  assert.equal(event.derived_totals.distance_m, 5000);
  assert.equal(event.event_identity.event_revision, 2);
  assert.equal(r.result_hash, buildAdaptiveCoachingCandidate(input).result_hash);
  const blocked = buildAdaptiveCoachingCandidate({ ...input, availability: { ...windows(), blocked_dates: ['2026-09-19'] } });
  assert.equal(blocked.selected_candidate, null);
  assert.equal(blocked.applicable, false);
  for (const change of [s => s.event_identity.athlete_id = 'foreign', s => s.event_identity.event_revision++,
    s => s.event_identity.event_local_date = '2026-09-18', s => s.scheduled_local_date = '2026-09-18']) {
    const bad = clone(material); change(bad);
    assert.throws(() => buildAdaptiveCoachingCandidate({ ...input, domain: { event_material: [buildCanonicalSession(bad)] } }), /Event material/);
  }
});
test('strength reduction is tried within the same observed pool and receipts reconcile', () => {
  const foundationInput = withObservedWork(fixture(2, 1, 180), { strengthSets: 6 });
  const availability = windows();
  availability.lift = [{ start_at: '2026-09-16T17:00:00Z', end_at: '2026-09-16T17:45:00Z' }];
  const result = buildAdaptiveCoachingCandidate({ foundationInput, availability });
  const sessions = valid(result), lift = sessions.find(s => s.kind === 'lift');
  assert.ok(lift, 'A meaningful reduced strength exposure should fit the short window');
  assert.ok(lift.derived_totals.sets < 24);
  assert.equal(result.strength_dose_receipt.selected_sets, 24);
  assert.equal(result.strength_dose_receipt.prescribed_sets + result.strength_dose_receipt.withheld_sets, 24);
  assert.equal(result.strength_dose_receipt.reductions.length, 1);
});
test('observed repeat topology and recovery persist without promotion of planned pace or load', () => {
  const input = withObservedWork(fixture(4, 0, 300), { quality: true });
  input.goals = roadInput('2026-11-15').goals;
  const pair = input.completionPairs[0], prior = clone(pair.prescribed_session);
  const interval = prior.steps.find(s => s.type === 'interval'), recovery = prior.steps.find(s => s.type === 'recovery');
  interval.target.duration_s = 300; recovery.target.duration_s = 60;
  interval.order = 1; recovery.order = 2;
  prior.steps = [prior.steps[0], { step_id: 'observed-repeat', type: 'repeat', order: 2, repeat_count: 4,
    target: {}, provenance: [], children: [interval, recovery] }, { ...prior.steps.at(-1), order: 3 }];
  pair.prescribed_session = buildCanonicalSession(prior);
  pair.observation.observed_duration_s = pair.prescribed_session.derived_totals.duration_s;
  pair.observation.observed_distance_m = pair.prescribed_session.derived_totals.distance_m;
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  const quality = valid(r).find(s => s.workout_family === 'threshold_run');
  assert.equal(quality.steps[1].type, 'repeat');
  assert.equal(quality.steps[1].repeat_count, 4);
  assert.equal(quality.steps[1].children[1].target.duration_s, 60);
  assert.ok(!quality.steps[1].children[0].target.pace_range_s_per_km);
});
function hybridInput() {
  const input = establishDimensions(withObservedWork(fixture(4, 2, 300), { quality: true }));
  input.goals = [{ goal_id: 'hybrid-event', athlete_id: input.snapshot.athlete_id, event_kind: 'HYROX_SINGLES',
    event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
  const decision = { decision_id: 'observed-hyrox', decision_hash: 'b'.repeat(64), phase: 'DEVELOPMENT', active_goals: input.goals };
  let prior = materializeCanonicalSession({ decision, source: { id: 'observed-station', duration_s: 1800,
    station_sequence: [{ id: 'ski_erg', distance_m: 600 }, { id: 'row', distance_m: 600 }] },
    skeleton: { session_id: 'observed-station', workout_family: 'hyrox_station_skill', role: 'PRIMARY_KEY', scheduled_local_date: '2026-09-10' },
    planning_instant: '2026-09-10T00:00:00Z', timezone: 'UTC' });
  const bookend = (id, order) => ({ step_id: id, type: 'mobility', order, target: { duration_s: 300, rpe_range: { minimum: 1, maximum: 2 } },
    provenance: [{ ...prior.steps[0].provenance[0], canonical_units: ['s', 'rpe'] }] });
  prior = buildCanonicalSession({ ...prior, steps: [bookend('station-warmup', 1), ...prior.steps.map(s => ({ ...s, order: s.order + 1 })), bookend('station-cooldown', prior.steps.length + 2)] });
  input.completionPairs.push({ prescribed_session: prior, observation: { linked_session_id: prior.session_id,
    evidence_id: 'observed-lift', observed_at: '2026-09-10T12:00:00Z', quality_state: 'COMPLETE', completed: true,
    target_met: true, observed_duration_s: prior.derived_totals.duration_s,
    observed_station_doses: prior.steps.filter(s => s.type === 'station').map(s => ({ step_id: s.step_id,
      athlete_id: input.snapshot.athlete_id, quality_state: 'COMPLETE', ...s.target })) } });
  return input;
}
test('HYROX individual station observations produce real canonical schedule; team-only evidence does not', () => {
  const input = hybridInput();
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  const sessions = valid(r);
  assert.equal(r.applicable, true);
  const station = sessions.find(s => s.workout_family === 'hyrox_station_skill');
  assert.ok(station);
  assert.equal(station.dose_basis.authority, 'OBSERVED_INDIVIDUAL_HYROX_DOSE');
  assert.deepEqual(station.steps.filter(s => s.type === 'station').map(s => s.target.distance_m), [600, 600]);
  const missing = clone(input); delete missing.completionPairs.at(-1).observation.observed_station_doses;
  const failed = buildAdaptiveCoachingCandidate({ foundationInput: missing, availability: windows() });
  assert.equal(failed.selected_candidate, null);
  assert.equal(failed.applicable, false);
});
test('all eight structural classes traverse state, objectives, solver and canonical validators', () => {
  const sparse = fixture(2, 0, 60); sparse.stateOptions.trainingAgeClass = 'BEGINNER'; sparse.stateOptions.weeks = [];
  const returning = fixture(3, 1, 100); returning.stateOptions.trainingAgeClass = 'RETURNING'; returning.stateOptions.weeks = [];
  const developing = establishDimensions(withObservedWork(fixture(3, 2, 240), { quality: true }));
  developing.stateOptions.trainingAgeClass = 'DEVELOPING';
  const established = establishDimensions(withObservedWork(fixture(6, 4, 360), { strengthSets: 6 }));
  const timed = establishDimensions(withObservedWork(fixture(5, 1, 240), { quality: true }));
  timed.goals = [{ ...roadInput('2026-11-15').goals[0], event_kind: 'ROAD_ENDURANCE', distance_miles: 13.1094, target_time_s: 6000 }];
  const short = roadInput();
  const dual = roadInput('2026-11-15'); dual.goals.push({ ...dual.goals[0], goal_id: 'second-goal', race_id: 'second-event', event_local_date: '2026-12-15', target_time_s: 1500 });
  const classes = [['sparse beginner road', sparse], ['developing hybrid', developing], ['established high-frequency hybrid', established],
    ['returning interrupted', returning], ['timed endurance', timed], ['short runway race', short], ['dual goal', dual], ['HYROX', hybridInput()]];
  for (const [name, input] of classes) {
    const foundation = buildAdaptiveCoachingFoundation(input);
    const r = buildAdaptiveCoachingCandidate({ foundation, availability: windows(),
      ...(name === 'short runway race' ? { domain: { event_material: [raceMaterial(foundation)] } } : {}) });
    const sessions = valid(r);
    assert.equal(r.applicable, true, name);
    assert.ok(r.decision.pipeline_stages.includes('joint_constraint_solver'));
    assert.ok(sessions.every(s => s.objective_ids.length));
    if (name.startsWith('sparse') || name.startsWith('returning')) {
      const run = sessions.find(s => s.kind === 'run');
      assert.equal(run.dose_basis.authority, 'OBSERVED_RECENT_SINGLE_EXPOSURE_CAP');
      assert.equal(run.dose_basis.observed_weekly_duration_s, null);
    }
    console.log(JSON.stringify({ structural_class: name, phase: r.decision.phase,
      families: sessions.filter(s => s.workout_family !== 'rest').map(s => s.workout_family), applicable: r.applicable }));
  }
});
test('measured comparable work segments resolve pace; planned or conflicted segments cannot', () => {
  const input = withObservedWork(fixture(4, 0, 300), { quality: true });
  input.goals = roadInput('2026-11-15').goals;
  const template = clone(input.completionPairs[0]);
  input.completionPairs = [input.completionPairs[1], ...[0, 1, 2].map(i => {
    const p = clone(template), id = `measured-quality-${i}`;
    p.prescribed_session = buildCanonicalSession({ ...p.prescribed_session, session_id: id });
    p.observation = { ...p.observation, linked_session_id: id,
      evidence_id: input.snapshot.canonical_activities[i].evidence_ids[0], observed_at: `2026-09-${String(12 - i * 3).padStart(2, '0')}T12:00:00Z`,
      surface_class: 'road', work_segments: [{ quality_state: 'COMPLETE', step_role: 'WORK', observed_duration_s: 600, observed_distance_m: 2000 }] };
    return p;
  })];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  const quality = valid(r).find(s => s.workout_family === 'threshold_run');
  assert.deepEqual(quality.steps.find(s => s.step_role === 'WORK').target.pace_range_s_per_km, { minimum: 300, maximum: 300 });
  assert.ok(!quality.steps.find(s => s.step_role === 'WORK').target.heart_rate_range_bpm);
  const missingWork = clone(input); missingWork.completionPairs.forEach(p => { delete p.observation.observed_work_duration_s; });
  assert.equal(buildAdaptiveCoachingCandidate({ foundationInput: missingWork, availability: windows() }).selected_candidate, null);
  for (const mode of ['planned', 'conflict']) {
    const bad = clone(input);
    for (const p of bad.completionPairs.filter(p => p.observation.work_segments)) {
      if (mode === 'planned') p.observation.work_segments = [{ duration_s: 600, distance_m: 2000 }];
      else p.observation.conflict = true;
    }
    const fallback = valid(buildAdaptiveCoachingCandidate({ foundationInput: bad, availability: windows() }));
    const work = fallback.find(s => s.workout_family === 'threshold_run').steps.find(s => s.step_role === 'WORK');
    assert.equal(work.target.pace_range_s_per_km, undefined);
  }
});
test('verified canonical HYROX cluster preserves official graph and fails outside event window', () => {
  const input = hybridInput();
  input.context.target.runDaysPerWeek = 6;
  input.goals[0].event_local_date = '2026-10-10';
  input.phaseEvidence = { development_gate_complete: true, safe_useful_peak_fits: true };
  input.stateOptions.performanceAnchors = [0, 1].map(i => ({ evidence_id: input.snapshot.canonical_activities[i].evidence_ids[0],
    goal_id: 'hybrid-event', specificity: 'EVENT_SPECIFIC', verified: true, observed_local_date: input.snapshot.canonical_activities[i].local_activity_date }));
  input.feasibilityByGoal = { 'hybrid-event': { workload_path_passes: true, mandatory_exposures_complete: true } };
  // Supported completion goal plus fresh same-purpose evidence permits specificity.
  const { buildCanonicalHyroxEventState, buildPartialRaceOrderCluster } = require('../src/lib/canonicalWorkout');
  const eventState = buildCanonicalHyroxEventState({ athlete_id: input.snapshot.athlete_id,
    format: 'singles', event_format: 'individual_open', registered_division: 'men',
    ruleset_id: 'hyrox-global', ruleset_version: '2026-2027' });
  let prior = buildPartialRaceOrderCluster({ session_id: 'observed-cluster', hyrox_event_state: eventState,
    scheduled_local_date: '2026-09-01', planning_instant: '2026-09-01T00:00:00Z', timezone: 'UTC',
    pair_count: 3, run_distance_m: 750, main_work_duration_s: 1800, station_dose_fraction: 0.5,
    warmup_running_m: 300, cooldown_running_m: 300, training_age_class: 'ESTABLISHED' });
  prior = buildCanonicalSession({ ...prior, steps: prior.steps.map(s => s.step_role === 'WORK' ? s : { ...s,
    target: { ...s.target, duration_s: 300 }, provenance: s.provenance.map(p => ({ ...p, canonical_units: [...new Set([...p.canonical_units, 's'])] })) }) });
  input.completionPairs.push({ prescribed_session: prior, observation: { linked_session_id: prior.session_id,
    observed_running_distance_m: 2850, evidence_id: input.snapshot.canonical_activities[3].evidence_ids[0], observed_at: '2026-09-01T12:00:00Z',
    quality_state: 'COMPLETE', completed: true, target_met: true, observed_duration_s: prior.derived_totals.duration_s,
    observed_station_doses: prior.steps.filter(s => s.type === 'station').map(s => ({ step_id: s.step_id,
      athlete_id: input.snapshot.athlete_id, quality_state: 'COMPLETE', ...s.target })) } });
  const foundation = buildAdaptiveCoachingFoundation(input);
  const { observedHybridEntry } = require('../src/lib/adaptiveCoachingDomain');
  // The phase engine may still defer specificity without a supported goal gap.
  // Exercise cluster material only via an actual objective produced by a supported phase.
  console.log(JSON.stringify({ cluster_phase: foundation.decision.phase, feasibility: foundation.decision.goal_gap[0].feasibility_status }));
  const objective = foundation.decision.weekly_objectives.objectives.find(o => o.candidate_families.includes('hyrox_partial_simulation'));
  if (!objective) throw new Error('Fixture must establish a real cluster objective');
  assert.ok(observedHybridEntry(objective, input.completionPairs, foundation.athlete_state));
  const availability = windows(); availability.lift.push(...availability.run);
  const result = buildAdaptiveCoachingCandidate({ foundation, availability });
  const cluster = valid(result).find(s => s.workout_family === 'hyrox_partial_simulation');
  assert.ok(cluster);
  assert.equal(cluster.partial_race_order_cluster.completion.status, 'PLANNED');
  assert.deepEqual(cluster.partial_race_order_cluster.station_ids, prior.partial_race_order_cluster.station_ids);
  assert.equal(cluster.derived_totals.duration_s, prior.derived_totals.duration_s);
  assert.ok(cluster.scheduled_local_date >= '2026-09-15');
  const tooSoon = clone(input); tooSoon.completionPairs.at(-1).observation.observed_at = '2026-09-10T12:00:00Z';
  assert.equal(buildAdaptiveCoachingCandidate({ foundationInput: tooSoon, availability }).selected_candidate, null);
  const outside = clone(input); outside.goals[0].event_local_date = '2026-11-15';
  const failed = buildAdaptiveCoachingCandidate({ foundationInput: outside, availability });
  assert.equal(failed.selected_candidate, null);
  assert.equal(failed.applicable, false);
  const wrongFormat = clone(input); wrongFormat.goals[0].event_kind = 'HYROX_DOUBLES';
  assert.equal(buildAdaptiveCoachingCandidate({ foundationInput: wrongFormat, availability }).selected_candidate, null);
});
if (require.main === module) console.log(`${checks} adaptive domain assertion groups passed`);
module.exports = { roadInput, raceMaterial, hybridInput, establishDimensions };
