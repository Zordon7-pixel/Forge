const assert = require('node:assert/strict');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { buildCanonicalSession, canonicalWorkoutHash } = require('../src/lib/canonicalWorkout');
const { resolveSessionStress } = require('../src/lib/goalBackwardLoad');
const running = require('../src/lib/runningDoseAccounting');
const authority = require('../src/lib/activityAdaptationAuthority');
const distribution = require('../src/lib/distributedStrength');
const strength = require('../src/lib/strengthDoseAccounting');
const context = { version: authority.VERSION, owner_id: 'synthetic-owner', assignment_id: 'synthetic-assignment',
  parent_plan_id: 'synthetic-plan', parent_plan_revision: 1, parent_canonical_set_hash: canonicalHash('owned-parent'),
  planning_input_revision: 4, activity_fingerprint: canonicalHash('saved-activity'), evidence_ids: ['saved-run-1'],
  safety_state_hash: canonicalHash('saved-safety'), observed_at: '2026-09-10T16:00:00Z', planning_date: '2026-09-10',
  timezone: 'America/New_York', window_start: '2026-09-10', window_end: '2026-09-12', expires_at: '2026-09-13T04:00:00Z',
  reason_code: 'RECENT_RUN_PROTECTION', affected_session_ids: ['protected-run', 'lift-0', 'lift-1'],
  parent_goals_hash: canonicalHash(['unchanged-race']), parent_horizon: { start_date: '2026-09-07', end_date: '2026-10-11' },
  missed_outcome_fingerprint: canonicalHash({}), observation_hash: canonicalHash('synthetic-observation'),
  recent_run_load_hash: canonicalHash('synthetic-protection') };
const provenance = units => [{ source_evidence_ids: ['synthetic-original'], derived_athlete_state_field: 'known_prescription',
  policy_id: 'target-policy-v1', policy_version: 1, confidence: 'HIGH', derived_at: context.observed_at,
  decision_id: 'synthetic-decision', canonical_units: units }];
function base(id, family, steps) {
  return { session_id: id, session_revision: 1, plan_id: context.parent_plan_id, plan_revision: 1,
    decision_id: 'synthetic-decision', goal_ids: ['unchanged-race'], phase: 'FOUNDATION', role: 'SUPPORTING',
    workout_family: family, title: 'Synthetic original', scheduled_local_date: '2026-09-11', timezone: context.timezone,
    purpose_reason_codes: ['FOUNDATION_ENTRY'], supports_requirement_id: 'unchanged-purpose', steps,
    success_criteria: ['Complete prescribed work'], adjustment_criteria: ['Reduce for symptoms'], stop_criteria: ['Stop for pain'] };
}
function originalRun(knownDistance = true) {
  return buildCanonicalSession(base('protected-run', 'long_aerobic', [{ step_id: 'protected-run-work', order: 1,
    type: 'run', step_role: 'WORK', workout_family: 'long_aerobic',
    target: { duration_s: 3600, ...(knownDistance ? { distance_m: 6000 } : {}), rpe_range: { minimum: 3, maximum: 4 } },
    provenance: provenance(knownDistance ? ['s', 'm', 'rpe'] : ['s', 'rpe']) }]));
}
function recovery(original, seconds = 1200, meters) {
  if (arguments.length < 3) meters = 2000;
  const registry = authority.buildRecoveryRegistry(original, context);
  const child = { ...structuredClone(original), session_revision: 2, plan_revision: 2, workout_family: 'recovery_run',
    steps: [{ step_id: `${original.session_id}-recovery`, type: 'run', step_role: 'WORK', workout_family: 'recovery_run', order: 1,
      target: { duration_s: seconds, ...(meters === undefined ? {} : { distance_m: meters }), rpe_range: { minimum: 2, maximum: 4 } },
      provenance: provenance(meters === undefined ? ['s', 'rpe'] : ['s', 'm', 'rpe']) }] };
  delete child.content_hash;
  return running.bindRunningDosePool([child], authority.recoverySource(registry))[0];
}
const original = originalRun();
for (const key of Object.keys(context)) {
  const missing = structuredClone(context); delete missing[key];
  assert.equal(authority.validateContext(missing), false, `Missing authority field ${key} fails closed`);
}
for (const patch of [{ extra_field: true }, { reason_code: 'MISSED_MEANS_INJURED' },
  { observed_at: 'invalid' }, { timezone: 'Not/A_Zone' }, { planning_date: '2026-09-11' },
  { expires_at: context.observed_at }, { affected_session_ids: ['protected-run','protected-run'] }]) {
  assert.equal(authority.validateContext({ ...context, ...patch }), false);
}
for (const patch of [{ owner_id: '' }, { parent_plan_id: 'other' }, { parent_plan_revision: 2 },
  { window_start: '2026-09-12' }, { window_end: '2026-09-10' }, { affected_session_ids: ['other'] }]) {
  assert.throws(() => authority.buildRecoveryRegistry(original, { ...context, ...patch }), /ORIGINAL_INVALID/);
}
const child = recovery(original);
assert.equal(resolveSessionStress(child).valid, true, 'Known-distance protected work has a useful canonical recovery successor');
assert.ok(resolveSessionStress(child).vector.every((value, index) => value <= resolveSessionStress(original).vector[index]));
assert.equal(require('../src/lib/prescriptionIntegrity').validateCanonicalPresentationFloor(child,
  { training_age_class: 'ESTABLISHED' }).valid, true);
const durationOriginal = originalRun(false);
const durationChild = recovery(durationOriginal, 1200, undefined);
assert.equal(resolveSessionStress(durationChild).valid, true, 'Duration-only original stays duration-only, without invented distance');
assert.equal(durationChild.steps[0].target.distance_m, undefined);
const lowEffort = structuredClone(original);
lowEffort.steps[0].target.rpe_range = { minimum: 2, maximum: 3 };
const lowOriginal = buildCanonicalSession(lowEffort);
assert.throws(() => recovery(lowOriginal), /Canonical workout failed validation/,
  'An original RPE2–3 cannot be raised to RPE2–4 by a recovery label');
const supportedLow = require('../src/lib/activityCanonicalSuccessor').reductionRecovery(lowOriginal, context,
  { duration_s: 1200, training_age_class: 'ESTABLISHED' });
assert.deepEqual(supportedLow.steps[0].target.rpe_range, { minimum: 2, maximum: 3 });
const heartRateOriginal = structuredClone(lowOriginal);
heartRateOriginal.steps[0].target.heart_rate_range_bpm = { minimum: 110, maximum: 130 };
heartRateOriginal.steps[0].provenance = provenance(['s', 'm', 'rpe', 'bpm']);
const heartRateRecovery = require('../src/lib/activityCanonicalSuccessor').reductionRecovery(
  buildCanonicalSession(heartRateOriginal), context, { duration_s: 1200, training_age_class: 'ESTABLISHED' });
assert.equal(heartRateRecovery.workout_family, 'rest',
  'Existing running-dose authority does not support numeric-HR recovery; do not silently discard its original bound');
assert.throws(() => recovery(buildCanonicalSession(heartRateOriginal)), /Canonical workout failed validation/,
  'An RPE-only child cannot discard a known canonical HR bound');
const rhythm = structuredClone(original); rhythm.workout_family = 'race_rhythm_run'; rhythm.steps[0].workout_family = 'race_rhythm_run';
assert.equal(authority.validateRecoveryRegistry(authority.buildRecoveryRegistry(buildCanonicalSession(rhythm), context)), true,
  'The real closed canonical race-rhythm family has reduction authority');
assert.throws(() => authority.buildRecoveryRegistry({ ...original, workout_family: 'race' }, context), /ORIGINAL_INVALID/,
  'An exact owned race is not an ordinary recoverable training prescription');
for (const [seconds, meters] of [[3601, 6000], [1200, 6001], [1200, 2001]]) {
  assert.throws(() => recovery(original, seconds, meters), /Canonical workout failed validation/,
    'Original duration, distance and speed are independent per-prescription caps');
}
assert.throws(() => recovery(durationOriginal, 1200, 1000), /Canonical workout failed validation/);
for (const mutate of [
  value => { value.steps[0].target.rpe_range.maximum = 5; },
  value => { value.steps[0].target.pace_range_s_per_km = { minimum: 300, maximum: 350 }; },
  value => { value.running_dose.source.normalization.exposure_per_second *= 0.5; },
  value => { value.running_dose.source.activity_recovery_registry.coefficient *= 0.5; },
  value => { value.running_dose.source.activity_recovery_registry.original.session_id = 'different-original'; },
  value => { value.scheduled_local_date = '2026-09-12'; },
  value => { value.plan_id = 'different-plan'; },
  value => { value.goal_ids = []; },
]) {
  const altered = structuredClone(child); mutate(altered); altered.content_hash = canonicalWorkoutHash(altered);
  assert.equal(resolveSessionStress(altered).valid, false, 'Tampering does not gain recovery authority');
}
const token = recovery(original, 660, 1100);
assert.equal(require('../src/lib/prescriptionIntegrity').validateCanonicalPresentationFloor(token,
  { training_age_class: 'BEGINNER' }).valid, false, 'Accounting cannot authorize an eleven-minute filler');
const uncertain = structuredClone(original); delete uncertain.steps[0].target.duration_s;
assert.throws(() => authority.buildRecoveryRegistry(buildCanonicalSession(uncertain), context), /UNKNOWN/);

for (const count of [1, 4, 7]) {
  const raw = Array.from({length:count},(_,index)=>buildCanonicalSession(base(`easy-${count}-${index}`, 'easy_run', [{
    step_id:`easy-${count}-${index}-work`, order:1, type:'run', step_role:'WORK', workout_family:'easy_run',
    target:{duration_s:1500,distance_m:2000,rpe_range:{minimum:2,maximum:4}}, provenance:provenance(['s','m','rpe']),
  }])));
  const independentSource = running.selectRunningDoseSource(raw,{policy_version:running.VERSION,authority:'CONSERVATIVE_TEMPLATE'});
  for (const reverse of [false,true]) {
    const pool = running.bindRunningDosePool(reverse ? [...raw].reverse() : raw,independentSource);
    const chosen = pool.find(session=>session.session_id===raw[0].session_id);
    const reductionContext = {...context,affected_session_ids:[chosen.session_id]};
    for (const action of ['rest','recovery']) {
      const reduced = action==='rest'
        ? require('../src/lib/activityCanonicalSuccessor').reductionRest(chosen,reductionContext)
        : require('../src/lib/activityCanonicalSuccessor').reductionRecovery(chosen,reductionContext,
          {duration_s:1200,training_age_class:'BEGINNER'});
      assert.equal(reduced.workout_family,action==='rest'?'rest':'recovery_run');
      const remainder = pool.map(session=>session.session_id===chosen.session_id?reduced:session);
      assert.equal(running.validateRunningDosePools(remainder),true,'Original complete source inventory remains authenticated after withholding');
      for (const session of remainder.filter(session=>session.session_id!==chosen.session_id)) {
        const prior = pool.find(item=>item.session_id===session.session_id);
        assert.deepEqual(session.running_dose,prior.running_dose);
        assert.deepEqual(resolveSessionStress(session).vector,resolveSessionStress(prior).vector,
          'One/four/seven-pool unchanged children retain exact coefficient and vector, regardless of order');
      }
      if(action==='recovery') assert.deepEqual(reduced.running_dose,chosen.running_dose);
    }
  }
}

const main = [{ name: 'Dumbbell bench press', sets: 4, reps: '6', rest: '90 sec', rpe: '7–8' },
  { name: 'One-arm dumbbell row', sets: 4, reps: '8 each side', rest: '90 sec', rpe: '7–8' }];
const children = [0, 1].map(index => ({ id: `lift-${index}`, main: main.map(item => ({ ...item, sets: 2 })) }));
const receipts = distribution.buildDistributionReceipts(main, children, { weekStart: '2026-09-07', focus: 'Upper body' });
const lifts = children.map((item, index) => buildCanonicalSession({ ...base(item.id, 'strength_upper', item.main.map((exercise, i) => {
  const { exercise_id, target } = strength.canonicalStrengthExercise(exercise);
  return { step_id: `${item.id}-${i}`, type: 'strength_exercise', step_role: 'WORK', order: i + 1,
    exercise_id, target, provenance: provenance(['count', 's', 'rpe']) }; })),
  source_session_id: item.id, strength_distribution: receipts[index], strength_dose_accounting_version: strength.VERSION }));
function withhold(original, steps) {
  const input = { ...structuredClone(original), plan_revision: 2, session_revision: 2,
    workout_family: steps.length ? original.workout_family : 'rest', steps,
    strength_withholding: authority.buildWithholdingLedger(original, steps, context) };
  delete input.content_hash; delete input.canonical_workout_schema_version;
  return buildCanonicalSession(input);
}
const partialSteps = structuredClone(lifts[0].steps); partialSteps.forEach(step => { step.target.sets = 1; });
const partial = withhold(lifts[0], partialSteps), rest = withhold(lifts[0], []);
assert.equal(authority.validateWithholdingChild(partial), true);
assert.equal(resolveSessionStress(partial).valid, true);
assert.ok(resolveSessionStress(partial).vector.every((value, index) => value <= resolveSessionStress(lifts[0]).vector[index]));
assert.equal(authority.validateWithholdingChild(rest), true);
assert.equal(distribution.validateDistributedSession(rest, [rest, lifts[1]]), true, 'Withheld allocation remains in the original group ledger');
assert.deepEqual(resolveSessionStress(rest).vector, Array(8).fill(0));
for (const mutate of [
  steps => { steps[0].target.sets = 3; }, steps => { steps[0].target.repetitions += 1; },
  steps => { steps[0].target.rest_s -= 1; }, steps => { steps[0].target.rpe_range.maximum = 9; },
  steps => { steps[0].target.load_kg = 80; }, steps => { steps[0].exercise_id = 'strength-goblet-squat'; },
  steps => { steps.push(structuredClone(steps[0])); },
]) {
  const steps = structuredClone(partialSteps); mutate(steps);
  assert.throws(() => authority.buildWithholdingLedger(lifts[0], steps, context), /ACTIVITY_STRENGTH/);
}
for (const mutate of [
  value => { value.strength_withholding.allocations.pop(); },
  value => { value.strength_withholding.allocations[0].withheld_sets += 1; },
  value => { value.strength_withholding.disposition = 'MOVE_TO_TOMORROW'; },
  value => { value.scheduled_local_date = '2026-09-12'; },
  value => { value.session_id = lifts[1].session_id; },
]) {
  const altered = structuredClone(partial); mutate(altered); altered.content_hash = canonicalWorkoutHash(altered);
  assert.equal(authority.validateWithholdingChild(altered), false);
}
assert.equal(distribution.validateDistributedSession(lifts[0], [lifts[0]]), false, 'Ordinary conservation is unchanged without withholding authority');
console.log('ACTIVITY ADAPTATION AUTHORITY SMOKE OK');
