const assert = require('node:assert/strict');
const c = require('../src/lib/canonicalWorkout');
const intent = require('../src/lib/workoutSemantics');
const { canonicalRunDose } = require('../src/lib/runningDoseAccounting');
const { buildAdaptiveWorkoutMaterial } = require('../src/lib/adaptiveCoachingWorkouts');
const clone = x => JSON.parse(JSON.stringify(x));
const provenance = units => [{ source_evidence_ids: ['server-source'], derived_athlete_state_field: 'synthetic-prescription',
  policy_id: 'synthetic-prescription-v1', policy_version: 1, confidence: 'HIGH', derived_at: '2026-09-23T12:00:00Z', decision_id: 'decision', canonical_units: units }];
const leaf = (id, family, seconds, role = 'WORK', cadence = false) => ({ step_id: id, type: 'run', order: 1,
  workout_family: family, step_role: role, target: { duration_s: seconds, rpe_range: { minimum: 3, maximum: 4 },
    ...(cadence ? { cadence_range_spm: { minimum: 170, maximum: 180 } } : {}) },
  provenance: provenance(['s', 'rpe', ...(cadence ? ['spm'] : [])]) });
const raw = (family, steps) => ({ session_id: 'session', session_revision: 1, plan_id: 'plan', plan_revision: 1,
  decision_id: 'decision', objective_ids: ['weekly-objective'], goal_ids: [], phase: 'FOUNDATION', role: 'SUPPORTING',
  workout_family: family, title: 'Opaque', purpose_reason_codes: [], scheduled_local_date: '2026-09-24', timezone: 'UTC',
  steps, success_criteria: [], adjustment_criteria: [], stop_criteria: [] });
function declared(s, accessories = []) { return c.buildCanonicalSession({ ...s, workout_semantics: intent.buildWorkoutSemantics(s, accessories) }); }
const main = leaf('main', 'easy_run', 3000);
const old = c.buildCanonicalSession(raw('easy_run', [main]));
assert.equal(c.buildCanonicalSession(old).content_hash, old.content_hash);
assert.equal(old.workout_semantics, undefined);
const annotated = declared(old);
assert.notEqual(annotated.content_hash, old.content_hash);
assert.deepEqual(annotated.steps, old.steps); assert.deepEqual(annotated.derived_totals, old.derived_totals);
assert.deepEqual(annotated.stress_vector, old.stress_vector);
assert.equal(c.canonicalWorkoutHash({ ...annotated, title: 'Intervals and race' }), annotated.content_hash);
const cadence = leaf('cadence', 'easy_run', 20, 'ACCESSORY', true);
const easyRaw = raw('easy_run', [main, { step_id: 'repeat', type: 'repeat', order: 2, repeat_count: 6,
  target: {}, provenance: [], children: [cadence] }]);
const accessories = [{ kind: 'CADENCE_TECHNIQUE', step_ids: ['cadence'], source_ref: 'server-source' }];
const easy = declared(easyRaw, accessories);
assert.equal(easy.workout_semantics.primary_purpose, 'easy_run');
assert.equal(easy.derived_totals.duration_s, 3120); assert.equal(easy.derived_totals.work_duration_s, 3120);
assert.equal(canonicalRunDose(easy, { allowEffortOnly: true }), null, 'source-bound easy topology protection is unchanged');
const race = declared(raw('race_rhythm_run', [{ step_id: 'race-repeat', type: 'repeat', order: 1, repeat_count: 3,
  target: {}, provenance: [], children: [{ ...leaf('race-work', 'race_rhythm_run', 600), type: 'interval' }] }]));
assert.equal(race.workout_semantics.primary_purpose, 'race_rhythm_run'); assert.equal(race.derived_totals.work_duration_s, 1800);
for (const mutate of [s => s.workout_semantics.primary_purpose = 'interval_run',
  s => s.workout_semantics.primary_step_ids.push('main'), s => s.workout_semantics.primary_step_ids[0] = 'missing',
  s => s.workout_semantics.primary_step_ids[0] = 'repeat', s => s.workout_semantics.primary_step_ids[0] = 'cadence',
  s => s.workout_semantics.accessories[0].source_ref = 'fake', s => s.workout_semantics.accessories[0].step_ids.push('cadence'),
  s => s.workout_semantics.source.authority = 'CLIENT_CONFIRMED', s => s.workout_semantics.source.objective_ids = ['fake'],
  s => s.workout_semantics.source.source_evidence_ids = ['fake'], s => s.steps[0].target.duration_s++,
  s => s.workout_semantics.accessories[0].kind = 'INTERVAL', s => s.steps[0].step_role = 'GOBBLEDYGOOK']) {
  const invalid = clone(easy); mutate(invalid); assert.throws(() => c.buildCanonicalSession(invalid), /Canonical workout failed/);
}
for (const badRole of [null, '', [], {}, true, 'GOBBLEDYGOOK', 'WARMUP']) {
  assert.throws(() => c.buildCanonicalSession(raw('easy_run', [{ ...main, step_role: badRole }])), /Canonical workout failed/);
}
assert.throws(() => c.buildCanonicalSession(easyRaw), /Canonical workout failed/, 'ACCESSORY without explicit declaration fails');
assert.throws(() => declared(raw('long_aerobic', [leaf('long', 'long_aerobic', 3000),
  { ...leaf('race', 'race_rhythm_run', 1800), order: 2 }])), /SEMANTICS|Canonical/);
const hiddenHard = clone(easyRaw); hiddenHard.steps[1].children[0].workout_family = 'interval_run';
assert.throws(() => declared(hiddenHard, accessories), /SEMANTICS|Canonical/, 'accessory cannot hide conflicting quality family');
const entry = { selection_id: 'new-session', workout_family: 'easy_run', objective_ids: ['new-objective'],
  progression_family: 'easy_aerobic', duration_s: 3120, distance_m: null, quality_work_s: null,
  canonical_steps: easy.steps, workout_semantics: easy.workout_semantics,
  source_intent_binding: { decision_id: easy.decision_id, objective_ids: easy.objective_ids },
  dose_basis: { source_evidence_ids: ['server-source'], policy_id: 'synthetic', authority: 'SERVER' }, reason_codes: [] };
const material = buildAdaptiveWorkoutMaterial(entry, { decision_id: 'new-decision' }, '2026-09-23T13:00:00Z');
for (const mutate of [e => e.workout_semantics.source.prescribed_steps_hash = 'forged',
  e => e.workout_semantics.source.decision_id = 'foreign', e => e.workout_semantics.source.objective_ids = ['foreign'],
  e => delete e.source_intent_binding, e => e.workout_semantics.primary_step_ids = ['cadence']]) {
  const forged = clone(entry); mutate(forged);
  assert.throws(() => buildAdaptiveWorkoutMaterial(forged, { decision_id: 'new-decision' }, '2026-09-23T13:00:00Z'),
    e => e.code === 'CANONICAL_INTENT_UNAVAILABLE', 'copy cannot launder a forged source declaration');
}
const rebound = c.materializeCanonicalSession({ source: material.source_session,
  decision: { decision_id: 'new-decision', phase: 'FOUNDATION', active_goals: [] },
  skeleton: { session_id: entry.selection_id, workout_family: 'easy_run', role: 'SUPPORTING', scheduled_local_date: '2026-09-24' },
  planning_instant: '2026-09-23T13:00:00Z', timezone: 'UTC' });
assert.deepEqual(rebound.steps[1].children[0].target, cadence.target);
assert.equal(rebound.steps[1].children[0].step_role, 'ACCESSORY');
assert.deepEqual(rebound.workout_semantics.accessories[0].step_ids, ['new-session-2-1']);
assert.deepEqual(rebound.workout_semantics.primary_step_ids, ['new-session-1']);
assert.deepEqual(rebound.derived_totals, easy.derived_totals); assert.deepEqual(rebound.stress_vector, easy.stress_vector);
assert.deepEqual(rebound.steps[1].children[0].provenance[0].source_evidence_ids, ['server-source']);
const rejected = { ...entry, canonical_steps: undefined, completed_prescription_structure: easy.steps, structure_work_scale: 2 };
assert.throws(() => buildAdaptiveWorkoutMaterial(rejected, { decision_id: 'new' }, '2026-09-23T13:00:00Z'),
  e => e.code === 'STRUCTURED_ACCESSORY_RECONSTRUCTION_UNSUPPORTED');
const undeclaredCadence = clone(rejected);
undeclaredCadence.completed_prescription_structure[1].children[0].step_role = 'WORK';
assert.throws(() => buildAdaptiveWorkoutMaterial(undeclaredCadence, { decision_id: 'new' }, '2026-09-23T13:00:00Z'),
  e => e.code === 'STRUCTURED_ACCESSORY_RECONSTRUCTION_UNSUPPORTED', 'cadence is preserved or deferred, never inferred accessory or silently dropped');
// Test the real selector's bounded deferral, not only the defensive builder.
const { fixture, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const foundationInput = withObservedWork(fixture(4, 0, 300), { quality: true });
foundationInput.goals = [{ goal_id: 'road', athlete_id: foundationInput.snapshot.athlete_id, event_kind: 'ROAD_SHORT',
  distance_miles: 6.2137119224, event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
const pair = foundationInput.completionPairs[0], prior = clone(pair.prescribed_session);
const workSteps = prior.steps.filter(s => s.type === 'interval');
workSteps[1].step_role = 'ACCESSORY';
workSteps[1].target.cadence_range_spm = { minimum: 170, maximum: 180 };
workSteps[1].provenance.push(provenance(['spm'])[0]);
workSteps[1].provenance.at(-1).decision_id = prior.decision_id;
prior.workout_semantics = intent.buildWorkoutSemantics(prior,
  [{ kind: 'CADENCE_TECHNIQUE', step_ids: [workSteps[1].step_id], source_ref: 'server-source' }]);
pair.prescribed_session = c.buildCanonicalSession(prior);
const foundation = require('../src/lib/adaptiveCoachingFoundation').buildAdaptiveCoachingFoundation(foundationInput);
const selection = require('../src/lib/adaptiveCoachingSelection').buildAdaptiveSessionSelection(foundation);
assert.ok(selection.deferred_objectives.some(d => d.reason_codes.includes('STRUCTURED_ACCESSORY_RECONSTRUCTION_UNSUPPORTED')));
assert.equal(selection.entries.some(e => e.completed_prescription_structure?.some(s => s.step_role === 'ACCESSORY')), false);
async function fitInvariant() {
  const { buildFitWorkoutRepresentation } = await import('../../frontend/src/services/fit/encodeWorkoutFit.js');
  const before = c.buildCanonicalSession({ ...old, safety_scope: [], executability: 'EXECUTABLE' });
  const after = declared(before);
  const fit = s => buildFitWorkoutRepresentation({ sessionId: s.session_id, exportRevision: 1, surfaceManifest: {
    schema_version: 'goal_backward_surface_manifest_v1', surface_revision: 1, feature_mode: 'on', v24_surface_enabled: true,
    status: 'accepted', identity: { decision_id: s.decision_id, decision_hash: 'd'.repeat(64), candidate_id: 'candidate',
      candidate_revision: 1, candidate_hash: 'a'.repeat(64), plan_id: s.plan_id, plan_revision: s.plan_revision,
      canonical_session_set_hash: 'b'.repeat(64), athlete_state_revision: 1, safety_state_hash: `sha256:${'e'.repeat(64)}`, goal_revisions: {} },
    safety: { action: 'NORMAL', scope: [], reason_codes: [] }, sessions: [s], weeks: [],
  } });
  const a = fit(before), b = fit(after);
  assert.notEqual(a.identity.content_hash, b.identity.content_hash);
  const { identity: ai, ...instructionsA } = a, { identity: bi, ...instructionsB } = b;
  assert.deepEqual(instructionsA, instructionsB, 'metadata changes identity, not executable FIT steps/targets/capabilities');
  console.log('PASS explicit workout intent: graph/source binding, roles, title independence, repeats, load retention, remapping, no physiology bypass, selector deferral, FIT instruction equality');
}
fitInvariant().catch(e => { console.error(e); process.exitCode = 1; });
