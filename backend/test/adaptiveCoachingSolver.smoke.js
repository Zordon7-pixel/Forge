const assert = require('node:assert/strict');
const { buildEvidenceSnapshot } = require('../src/lib/goalBackwardEvidence');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { validatePipelineArtifact } = require('../src/lib/goalBackwardContracts');
const { addDays } = require('../src/lib/racePlanPolicy');
const DATE = '2026-09-14';
function fixture(runs = 4, lifts = 2, minutes = 240, athleteId = 'solver-fixture') {
  const snapshot = buildEvidenceSnapshot({ athleteId, timezone: 'UTC', planningInstant: `${DATE}T00:00:00Z`,
    checkIns: [{ id: 'ready', date: DATE, feeling: 4 }],
    lifts: [{ id: 'observed-lift', date: '2026-09-10', workout_duration_seconds: 3600, sets: 24, reps: 144 }],
    runs: Array.from({ length: 8 }, (_, i) => ({ id: `history-${i}`, user_id: athleteId,
      date: addDays(DATE, -1 - i * 3), distance_miles: minutes * 140 / 2 / 1609.344,
      duration_seconds: minutes * 30, type: 'easy' })) });
  const weeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map(week => ({
    week_id: week, distance_m: minutes * 140, duration_s: minutes * 60, forge_native_coverage: true,
    stress_dimensions: Object.fromEntries(require('../src/lib/racePlanPolicy').STRESS_TAXONOMY_V1.dimensions.map(k => [k, 20])) }));
  return { snapshot, context: { target: { runDaysPerWeek: runs, liftDaysPerWeek: lifts,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } },
    stateOptions: { trainingAgeClass: 'ESTABLISHED', weeks } };
}
function windows() {
  return { run: Array.from({ length: 7 }, (_, i) => ({ start_at: `${addDays(DATE, i)}T06:00:00Z`, end_at: `${addDays(DATE, i)}T09:00:00Z` })),
    lift: Array.from({ length: 7 }, (_, i) => ({ start_at: `${addDays(DATE, i)}T17:00:00Z`, end_at: `${addDays(DATE, i)}T20:00:00Z` })) };
}
let checks = 0;
function test(name, fn) { if (require.main !== module) return; fn(); checks++; console.log(`ok - ${name}`); }
test('complete canonical candidate is validator-backed and deterministic', () => {
  const input = { foundationInput: fixture(), availability: windows() };
  const r = buildAdaptiveCoachingCandidate(input);
  if (!r.selected_candidate) console.log(JSON.stringify(r.search.tested_candidates));
  assert.ok(r.selected_candidate);
  assert.equal(r.selected_candidate.validation.valid, true);
  assert.equal(validateCanonicalSessionSet(r.selected_candidate.canonical_session_set).valid, true);
  assert.equal(r.selected_candidate.canonical_plan.schemaVersion, 2);
  assert.equal(r.result_hash, buildAdaptiveCoachingCandidate(input).result_hash);
  assert.equal(r.accepted_surface_manifest, null);
  assert.equal(r.artifacts.length, 6);
  r.artifacts.forEach(a => assert.equal(validatePipelineArtifact(a).valid, true));
});

function withObservedWork(input, { strengthSets = 0, quality = false } = {}) {
  const { buildAdaptiveWorkoutMaterial } = require('../src/lib/adaptiveCoachingWorkouts');
  const { materializeCanonicalSession } = require('../src/lib/canonicalWorkout');
  const { buildStrengthExercises } = require('../src/lib/strengthPrescription');
  const decision = { decision_id: 'observed-decision', decision_hash: 'a'.repeat(64), phase: 'DEVELOPMENT', active_goals: [] };
  const definitions = quality ? [{ family: 'threshold_run', seconds: 2400, quality: 1200 },
    { family: 'long_aerobic', seconds: 4200, quality: null }] : [];
  if (strengthSets) definitions.push({ family: 'strength_full_body', sets: strengthSets });
  input.completionPairs = definitions.map((d, i) => {
    const evidenceId = d.sets ? 'observed-lift' : input.snapshot.canonical_activities[i].evidence_ids[0];
    const id = `completed-${i}`, date = addDays(DATE, -2 - i);
    const exercises = d.sets ? ['Upper body', 'Lower body'].flatMap(focus => buildStrengthExercises({ focus,
      equipment: ['dumbbells', 'bench'], mode: 'hybrid_build' }).slice(0, 2)).map(e => ({ ...e, sets: d.sets })) : undefined;
    const entry = { selection_id: id, workout_family: d.family, objective_ids: ['old-objective'],
      progression_family: require('../src/lib/adaptiveCoachingProgression').progressionFamilyFor(d.family),
      duration_s: d.seconds, distance_m: d.seconds ? Math.floor(d.seconds * 2.3) : null, quality_work_s: d.quality,
      exercises, reason_codes: ['WEEKLY_OBJECTIVE_REQUIRED'], dose_basis: { policy_id: 'adaptive-observed-dose-v1',
        authority: 'OBSERVED_COMPLETED_WEEK_STRENGTH', source_evidence_ids: [evidenceId] } };
    const material = buildAdaptiveWorkoutMaterial(entry, decision, `${date}T00:00:00Z`);
    const prescribed = materializeCanonicalSession({ decision, source: material.source_session,
      skeleton: { session_id: id, role: 'PRIMARY_KEY', workout_family: d.family, scheduled_local_date: date },
      planning_instant: `${date}T00:00:00Z`, timezone: 'UTC' });
    return { prescribed_session: prescribed, observation: { linked_session_id: id, evidence_id: evidenceId,
      observed_at: `${date}T12:00:00Z`, quality_state: 'COMPLETE', completed: true, target_met: true,
      observed_duration_s: prescribed.derived_totals.duration_s, observed_work_duration_s: prescribed.derived_totals.work_duration_s, observed_distance_m: prescribed.derived_totals.distance_m } };
  });
  return input;
}
test('2–6 run capacities partition observed dose into meaningful structures', () => {
  const counts = [];
  for (let n = 2; n <= 6; n++) {
    const r = buildAdaptiveCoachingCandidate({ foundationInput: fixture(n, 0, 300), availability: windows() });
    assert.ok(r.selected_candidate, JSON.stringify(r.search.tested_candidates));
    const runs = r.selected_candidate.sessions.filter(s => s.kind === 'run');
    counts.push(runs.length);
    assert.ok(runs.every(s => s.derived_totals.duration_s >= 1500));
    assert.ok(runs.reduce((v, s) => v + s.derived_totals.duration_s, 0) <= 18000);
    assert.ok(r.rest_days.length >= 1);
  }
  assert.deepEqual(counts, [2, 3, 4, 5, 6]);
});
test('0–5 strength capacity partitions a fixed observed objective without calendar templates', () => {
  const counts = [], totals = [];
  for (let n = 0; n <= 5; n++) {
    const input = withObservedWork(fixture(2, n, 180), { strengthSets: 6 });
    const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
    assert.ok(r.selected_candidate, JSON.stringify(r.search.tested_candidates));
    const lifts = r.selected_candidate.sessions.filter(s => s.kind === 'lift');
    counts.push(lifts.length);
    totals.push(lifts.reduce((v, s) => v + s.derived_totals.sets, 0));
    lifts.forEach(s => assert.ok(s.steps.filter(s => s.type === 'strength_exercise').every(s => s.target.sets >= 2)));
  }
  assert.deepEqual(counts, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(totals, [0, 24, 24, 24, 24, 24]);
});
test('complete road keys come from observations and satisfy real validators', () => {
  const input = withObservedWork(fixture(4, 2, 300), { quality: true });
  input.goals = [{ goal_id: 'road', athlete_id: input.snapshot.athlete_id, event_kind: 'ROAD_SHORT',
    distance_miles: 6.2137119224, event_local_date: '2026-11-15', event_state: 'SCHEDULED', target_time_s: 2100 }];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  assert.ok(r.selected_candidate, JSON.stringify(r.search.tested_candidates));
  const sessions = r.selected_candidate.sessions;
  assert.ok(sessions.some(s => s.workout_family === 'threshold_run'));
  assert.ok(sessions.some(s => s.workout_family === 'long_aerobic'));
  assert.equal(r.selected_candidate.validation.valid, true);
  for (const s of sessions) {
    assert.ok(s.objective_ids.length);
    if (s.kind === 'run') {
      assert.ok(s.steps.some(s => s.type === 'warmup'));
      assert.ok(s.steps.some(s => s.type === 'cooldown'));
      assert.ok(s.steps.every(s => !s.target.pace_range_s_per_km && !s.target.heart_rate_range_bpm));
    }
  }
  const { resolveSessionStress } = require('../src/lib/goalBackwardLoad');
  assert.equal(resolveSessionStress(sessions.find(s => s.workout_family === 'threshold_run')).dose_resolution_state, 'ADAPTIVE_OBSERVED_FAMILY_DOSE');
});
test('unobserved required quality fails closed rather than claiming a valid summary', () => {
  const input = fixture(4, 1, 240);
  input.goals = [{ goal_id: 'road', athlete_id: input.snapshot.athlete_id, event_kind: 'ROAD_SHORT',
    distance_miles: 6.2137119224, event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  assert.equal(r.applicable, false);
  assert.equal(r.selected_candidate, null);
  assert.ok(r.search.tested_candidates.every(c => !c.valid));
  assert.ok(r.deferred_objectives.some(d => d.reason_codes.includes('OBSERVED_FAMILY_DOSE_UNAVAILABLE')));
});
test('modality windows, occupied dates, locks, and precise recovery hours constrain schedules', () => {
  const { validateAdaptivePlacement, normalizeSolverConstraints } = require('../src/lib/adaptiveCoachingValidation');
  const { buildAdaptiveSessionSelection } = require('../src/lib/adaptiveCoachingSelection');
  const foundation = buildAdaptiveCoachingFoundation(withObservedWork(fixture(3, 1, 240), { quality: true }));
  const availability = windows(); availability.blocked_dates = [DATE];
  availability.lift = availability.lift.filter(w => w.start_at.startsWith(addDays(DATE, 3)));
  const r = buildAdaptiveCoachingCandidate({ foundation, availability });
  assert.ok(r.selected_candidate);
  assert.ok(r.selected_candidate.sessions.filter(s => s.kind !== 'rest' && s.workout_family !== 'rest').every(s => s.scheduled_local_date !== DATE));
  const constraints = normalizeSolverConstraints(foundation.athlete_state, availability);
  const selection = buildAdaptiveSessionSelection(foundation);
  const run = r.selected_candidate.sessions.find(s => s.kind === 'run');
  const lift = r.selected_candidate.sessions.find(s => s.kind === 'lift');
  assert.ok(lift);
  const colliding = { ...lift, scheduled_local_date: run.scheduled_local_date, scheduled_start_at: run.scheduled_start_at };
  const result = validateAdaptivePlacement([run, colliding], constraints, foundation.athlete_state, selection.weekly_objectives);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(v => v.code === 'ADAPTIVE_RECOVERY_HOURS'));
  const locked = buildAdaptiveCoachingCandidate({ foundation, availability: { ...availability,
    locks: [{ constraint_kind: 'session_lock', session_id: 'absent-locked-session', scheduled_local_date: DATE }] } });
  assert.equal(locked.selected_candidate, null);
  assert.equal(locked.applicable, false);
});
test('missing baseline and exhausted search do not manufacture valid quota work', () => {
  const input = fixture(6, 0, 0);
  input.stateOptions.weeks = [];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows(), search: { max_nodes: 1 } });
  assert.equal(r.selected_candidate, null);
  assert.equal(r.applicable, false);
  assert.ok(r.deferred_objectives.length);
  const bounded = buildAdaptiveCoachingCandidate({ foundationInput: fixture(), availability: windows(), search: { max_nodes: 1 } });
  assert.ok(bounded.search.expanded_nodes <= 1);
  assert.equal(bounded.search.truncated, true);
  assert.equal(bounded.search.optimality_claimed, false);
});

test('taper reduces observed volume and lower fatigue while retaining warranted intensity', () => {
  const input = withObservedWork(fixture(4, 2, 300), { quality: true, strengthSets: 6 });
  input.goals = [{ goal_id: 'race', athlete_id: input.snapshot.athlete_id, event_kind: 'ROAD_SHORT',
    distance_miles: 6.2137119224, event_local_date: '2026-09-19', event_state: 'SCHEDULED' }];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  assert.equal(r.decision.phase, 'TAPER_RACE_WEEK');
  assert.ok(r.selected_candidate, JSON.stringify(r.search.tested_candidates));
  const runs = r.selected_candidate.sessions.filter(s => s.kind === 'run');
  assert.ok(runs.length >= 2);
  assert.ok(runs.some(s => s.workout_family === 'threshold_run'));
  assert.ok(runs.reduce((n, s) => n + s.derived_totals.duration_s, 0) <= 9000);
  assert.ok(r.selected_candidate.sessions.filter(s => s.kind === 'lift').every(s => s.workout_family === 'strength_upper'));
  assert.equal(r.event_execution_deferred, true);
  assert.equal(r.applicable, false); // race material is an explicit continuation gate
});
test('lock-aware search has no first-quality or last-long weekday template', () => {
  const input = withObservedWork(fixture(4, 0, 300), { quality: true });
  input.goals = [{ goal_id: 'road', athlete_id: input.snapshot.athlete_id, event_kind: 'ROAD_SHORT',
    distance_miles: 6.2137119224, event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
  const r = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: { ...windows(), locks: [
    { constraint_kind: 'day_lock', workout_family: 'threshold_run', scheduled_local_date: '2026-09-18' },
    { constraint_kind: 'day_lock', workout_family: 'long_aerobic', scheduled_local_date: '2026-09-15' },
  ] } });
  assert.ok(r.selected_candidate, JSON.stringify(r.search.tested_candidates));
  assert.equal(r.selected_candidate.sessions.find(s => s.workout_family === 'threshold_run').scheduled_local_date, '2026-09-18');
  assert.equal(r.selected_candidate.sessions.find(s => s.workout_family === 'long_aerobic').scheduled_local_date, '2026-09-15');
  assert.ok(r.selected_candidate.sessions.some(s => s.kind === 'run' && s.scheduled_local_date > '2026-09-15'));
  assert.ok(r.rest_days.every(d => d.reason_codes.length));
});

test('occupied work consumes real weekly dose and unsupported HYROX remains deferred', () => {
  const { validateAdaptivePlacement, normalizeSolverConstraints } = require('../src/lib/adaptiveCoachingValidation');
  const { buildAdaptiveSessionSelection } = require('../src/lib/adaptiveCoachingSelection');
  const foundation = buildAdaptiveCoachingFoundation(fixture(2, 0, 180));
  const r = buildAdaptiveCoachingCandidate({ foundation, availability: windows() });
  const runs = r.selected_candidate.sessions.filter(s => s.kind === 'run');
  const constraints = normalizeSolverConstraints(foundation.athlete_state, { ...windows(), occupied_sessions: [runs[0]] });
  const result = validateAdaptivePlacement(runs, constraints, foundation.athlete_state, buildAdaptiveSessionSelection(foundation).weekly_objectives);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(v => v.code === 'OBSERVED_RUNNING_DOSE_EXCEEDED'));
  const input = fixture(4, 3, 240);
  input.goals = [{ goal_id: 'hyrox', athlete_id: input.snapshot.athlete_id, event_kind: 'HYROX_SINGLES',
    event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
  const h = buildAdaptiveCoachingCandidate({ foundationInput: input, availability: windows() });
  assert.equal(h.applicable, false);
  assert.equal(h.selected_candidate, null);
  assert.ok(h.deferred_objectives.length);
});
if (require.main === module) console.log(`${checks} adaptive solver assertion groups passed`);
module.exports = { fixture, windows, withObservedWork };
