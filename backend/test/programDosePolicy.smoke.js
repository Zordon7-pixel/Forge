const assert = require('node:assert/strict');
const { buildCanonicalSession, canonicalWorkoutHash } = require('../src/lib/canonicalWorkout');
const { resolveSessionStress, aggregateWeeklyStress } = require('../src/lib/goalBackwardLoad');
const strength = require('../src/lib/strengthDoseAccounting');
const running = require('../src/lib/runningDoseAccounting');
const { buildDistributionReceipts, validateDistributionReceipt, validateDistributedSession } = require('../src/lib/distributedStrength');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const provenance = units => [{ source_evidence_ids: ['synthetic-prescription'], derived_athlete_state_field: 'known_prescription',
  policy_id: 'target-policy-v1', policy_version: 1, confidence: 'HIGH', derived_at: '2026-09-07T00:00:00Z',
  decision_id: 'test-decision', canonical_units: units }];
function base(id, family, steps) {
  return { session_id: id, session_revision: 1, plan_id: 'test-plan', plan_revision: 1, decision_id: 'test-decision',
    goal_ids: ['test-goal'], phase: 'FOUNDATION', role: 'SUPPORTING', workout_family: family, title: 'Synthetic prescription',
    purpose_reason_codes: ['FOUNDATION_ENTRY'], scheduled_local_date: '2026-09-08', timezone: 'UTC', steps,
    supports_requirement_id: 'test-running-purpose', success_criteria: ['Complete work'], adjustment_criteria: ['Reduce with symptoms'], stop_criteria: ['Stop for pain'] };
}
const exercises = [
  { name: 'Dumbbell bench press', sets: 3, reps: '6', rest: '90 sec', rpe: '7–8' },
  { name: 'One-arm dumbbell row', sets: 3, reps: '8 each side', rest: '90 sec', rpe: '7–8' },
  { name: 'Standing dumbbell overhead press', sets: 2, reps: '6', rest: '90 sec', rpe: '7–8' },
];
function lift(id, main, receipt) {
  const steps = main.map((exercise, index) => {
    const canonical = strength.canonicalStrengthExercise(exercise);
    return { step_id: `${id}-${index}`, type: 'strength_exercise', step_role: 'WORK', order: index + 1,
      exercise_id: canonical.exercise_id, target: canonical.target, provenance: provenance(['count','s','rpe']) };
  });
  return buildCanonicalSession({ ...base(id, 'strength_upper', steps), strength_dose_accounting_version: strength.VERSION,
    ...(receipt ? { strength_distribution: receipt, source_session_id: id } : {}) });
}
const full = lift('full', exercises);
assert.deepEqual(resolveSessionStress(full).vector, [1,0,0,3,2,2,1,0]);
const children = exercises.map((exercise, index) => ({ id: `child-${index}`, main: [exercise] }));
const receipts = buildDistributionReceipts(exercises, children, { weekStart: '2026-09-07', focus: 'Upper body' });
const partition = children.map((child, index) => lift(child.id, child.main, receipts[index]));
assert.ok(partition.every(child => validateDistributedSession(child, partition)));
const sums = partition.reduce((sum, child) => sum.map((value, index) => value + resolveSessionStress(child).vector[index]), Array(8).fill(0));
assert.deepEqual(sums, resolveSessionStress(full).vector, 'Volume-equated upper partitions conserve family reference dose');
const forged = structuredClone(receipts[0]); forged.original_exercises[0].target.sets = 30;
forged.source_template_content_hash = canonicalHash({ id: forged.source_template_id, version: 1, focus: forged.focus, exercises: forged.original_exercises });
assert.equal(validateDistributionReceipt(forged), false);
const heavier = structuredClone(full); heavier.steps.forEach(step => { step.target.sets *= 2 });
delete heavier.content_hash; delete heavier.canonical_workout_schema_version;
const heavy = buildCanonicalSession(heavier);
assert.ok(resolveSessionStress(heavy).vector.every((value, i) => value >= resolveSessionStress(full).vector[i]));
for (const mutate of [s => { s.steps[0].target.repetitions *= 2; },
  s => { s.steps[0].target.rpe_range.maximum = 9; }, s => { s.steps[0].target.load_kg = 40; },
  s => { s.steps[0].target.rest_s *= 2; }]) {
  const changed = structuredClone(full); mutate(changed); changed.content_hash = canonicalWorkoutHash(changed);
  const resolved = resolveSessionStress(changed);
  assert.ok(resolved.valid && resolved.vector.every((value, i) => value >= resolveSessionStress(full).vector[i]),
    'Additional repetitions, effort, load or duration cannot lower any authoritative strength dimension');
}
for (const mutate of [session => { delete session.strength_dose_accounting_version }, session => { delete session.steps[0].target.repetitions }, session => { session.steps[0].exercise_id = 'unknown' }, session => { session.steps[0].target.load_kg = -1 }]) {
  const invalid = structuredClone(heavy); mutate(invalid); invalid.content_hash = canonicalWorkoutHash(invalid);
  assert.equal(resolveSessionStress(invalid).valid, false);
}
const adapted = structuredClone(full); adapted.main = [{ sets: 0 }]; adapted.exercises = []; adapted.title = 'rehab';
adapted.content_hash = canonicalWorkoutHash(adapted);
assert.deepEqual(resolveSessionStress(adapted).vector, resolveSessionStress(full).vector, 'Display labels/adapters cannot discount actual dose');
function easy(id, seconds, meters) {
  const source = base(id, 'easy_run', [{ step_id: id, type: 'run', step_role: 'WORK', workout_family: 'easy_run', order: 1,
    target: { duration_s: seconds, distance_m: meters, rpe_range: { minimum: 2, maximum: 4 } }, provenance: provenance(['m','s','rpe']) }]);
  return buildCanonicalSession(running.attachRunningDose(source, { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' }));
}
const small = easy('easy-1', 1500, 2000), larger = easy('easy-2', 1800, 2400);
const { buildSafetyExecutability, validateInterference } = require('../src/lib/goalBackwardValidators');
for (const action of ['FULL_REST', 'NO_RUNNING', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED']) {
  const protectedSessions = buildSafetyExecutability({ sessions: [small, full] }, { safety_action: action });
  assert.equal(protectedSessions.sessions[0].executable, false, 'V2 accounting never overrides injury/acute/clinical safety action');
  assert.equal(protectedSessions.sessions[1].executable, action === 'NO_RUNNING', 'Only the affected modality is blocked');
}
const lowerSteps = [
  { name: 'Goblet squat', sets: 4, reps: '6', rest: '90 sec', rpe: '7–8' },
  { name: 'Dumbbell Romanian deadlift', sets: 4, reps: '6', rest: '90 sec', rpe: '7–8' },
].map((exercise, index) => { const { exercise_id, target } = strength.canonicalStrengthExercise(exercise);
  return { step_id: `lower-${index}`, type: 'strength_exercise', step_role: 'WORK', order: index + 1,
    exercise_id, target, provenance: provenance(['count','s','rpe']) }; });
const lower = buildCanonicalSession({ ...base('lower-full', 'strength_lower', lowerSteps), strength_dose_accounting_version: strength.VERSION });
const quality = { session_id: 'protected-quality', workout_family: 'threshold_run', scheduled_local_date: lower.scheduled_local_date };
assert.equal(validateInterference([quality, lower], { training_age_class: 'ESTABLISHED' }).valid, false,
  'Full-reference canonical lower remains incompatible with same-day protected quality despite base-dose conservation');
for (let index = 0; index < 4; index += 1) {
  const token = easy(`eleven-minute-${index}`, 660, Math.round(0.8 * 1609.344));
  assert.equal(require('../src/lib/prescriptionIntegrity').validateCanonicalPresentationFloor(token,
    { training_age_class: 'BEGINNER' }).valid, false, 'V2 dose compatibility cannot authorize an eleven-minute filler run');
}
assert.ok(resolveSessionStress(larger).vector.every((value, i) => value >= resolveSessionStress(small).vector[i]));
for (const [seconds, meters] of [[1800,2000],[1500,4000]]) {
  assert.ok(resolveSessionStress(easy('monotonic-run', seconds, meters)).vector
    .every((value, i) => value >= resolveSessionStress(small).vector[i]), 'Increasing only duration or only distance cannot lower running dose');
}
for (const effort of [3,4]) {
  const raw = structuredClone(small); delete raw.content_hash;
  raw.steps[0].target.rpe_range.maximum = effort;
  const session = running.bindRunningDosePool([raw], { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' })[0];
  assert.deepEqual(resolveSessionStress(session).vector, resolveSessionStress(small).vector,
    'Permitted low-effort variation never discounts the same work');
}
for (const zone of [0,3,'2','invalid',null]) {
  const raw = structuredClone(small); raw.steps[0].target.hr_zone = zone;
  assert.throws(() => running.bindRunningDosePool([raw], { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' }),
    /Complete canonical running dose/, 'Unknown or demanding HR-zone metadata cannot authorize discounted easy work');
}
for (const target of [{ heart_rate_range_bpm: { minimum: 150, maximum: 180 } },
  { pace_range_s_per_km: { minimum: 180, maximum: 240 } }, { hr_zone: 2 }]) {
  const raw = structuredClone(small); Object.assign(raw.steps[0].target, target);
  assert.throws(() => running.bindRunningDosePool([raw], { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' }),
    /Complete canonical running dose|Canonical workout failed validation/,
    'Unqualified HR/pace/zone targets cannot borrow low-RPE accounting authority');
}
const badRun = structuredClone(small); badRun.steps[0].target.rpe_range.maximum = 8; badRun.content_hash = canonicalWorkoutHash(badRun);
assert.equal(resolveSessionStress(badRun).valid, false, 'Easy label cannot discount demanding effort');
assert.deepEqual(aggregateWeeklyStress([small]).weekly_dimension_sum, resolveSessionStress(small).vector);
function pool(count, family = 'easy_run') {
  const sessions = Array.from({ length: count }, (_, index) => {
    const raw = structuredClone(easy(`pool-${count}-${index}`, 10500 / count, 14000 / count));
    delete raw.content_hash; delete raw.running_dose; delete raw.running_dose_accounting_version;
    raw.workout_family = family; raw.steps[0].workout_family = family;
    return buildCanonicalSession(raw);
  });
  return running.bindRunningDosePool(sessions, { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' });
}
const vectors = count => pool(count).reduce((sum, session) => sum.map((value, dimension) => value + resolveSessionStress(session).vector[dimension]), Array(8).fill(0));
for (const count of [4, 7]) assert.ok(vectors(count).every((value, dimension) => Math.abs(value - vectors(1)[dimension]) < 1e-9), 'Frequency does not multiply equivalent weekly running dose');
const fragmentedRaw = [easy('duration-heavy', 9000, 1000), easy('distance-heavy', 1500, 13000)];
const fragmented = running.bindRunningDosePool(fragmentedRaw, { policy_version: running.VERSION, authority: 'CONSERVATIVE_TEMPLATE' });
const fragmentSum = fragmented.reduce((sum, session) => sum.map((value, index) => value + resolveSessionStress(session).vector[index]), Array(8).fill(0));
assert.ok(fragmentSum.every((value, index) => Math.abs(value - vectors(1)[index]) < 1e-9),
  'Opposite duration/distance ratios still conserve the weekly pool; per-child maxima must not inflate it');
assert.ok(9000 / running.REFERENCE.duration_s + 13000 / running.REFERENCE.distance_m
  > Math.max(10500 / running.REFERENCE.duration_s, 14000 / running.REFERENCE.distance_m),
  'Fixture distinguishes the old independently maximized fragment accounting');
const recoveries = pool(7, 'recovery_run');
// Review B4: all earlier multi-child cases were duration-dominant. Preserve
// one independent source while a changed sibling crosses the old dominance
// boundary, in both allocation orders. Do not hide prefix-rounding drift.
const sourceRuns = [easy('fixed-a', 1500, 4000), easy('fixed-b', 1500, 4000)];
const fixedSource = running.selectRunningDoseSource(sourceRuns, { policy_version: running.VERSION,
  authority: 'CONSERVATIVE_TEMPLATE' });
for (const reverse of [false, true]) {
  const ordered = reverse ? [...sourceRuns].reverse() : sourceRuns;
  const original = running.bindRunningDosePool(ordered, fixedSource);
  const originalA = resolveSessionStress(original.find(s => s.session_id === 'fixed-a')).vector;
  for (const seconds of [1800, 2000, 3000, 6000]) {
    const changed = structuredClone(ordered);
    changed.find(s => s.session_id === 'fixed-b').steps[0].target.duration_s = seconds;
    const rebound = running.bindRunningDosePool(changed, fixedSource);
    assert.deepEqual(resolveSessionStress(rebound.find(s => s.session_id === 'fixed-a')).vector, originalA,
      'An unchanged child is exactly invariant under sibling changes and allocation order');
    const b = resolveSessionStress(rebound.find(s => s.session_id === 'fixed-b'));
    assert.ok(b.valid && b.vector.every((v,i) => v >= originalA[i]));
    const total = rebound.reduce((sum,s) => sum + resolveSessionStress(s).vector[0], 0);
    assert.ok(Math.abs(total - 2 * fixedSource.normalization.exposure_per_second * (1500 + seconds)) < 1e-12);
  }
}
for (const change of [sessions => { sessions[0].steps[0].target.distance_m += 100; sessions[1].steps[0].target.distance_m -= 100; },
  sessions => { sessions[0].steps[0].target.duration_s -= 100; sessions[1].steps[0].target.duration_s += 100; },
  sessions => { delete sessions[0].steps[0].target.distance_m; }]) {
  const changed = structuredClone(sourceRuns); change(changed);
  try {
    const bound = running.bindRunningDosePool(changed, fixedSource);
    assert.equal(running.validateRunningDosePools(bound), false, 'Faster/longer work cannot hide behind compensating sibling reductions');
  } catch (error) { assert.match(error.message, /Complete canonical running dose|Canonical workout failed validation/); }
}
const tamperedSource = structuredClone(fixedSource);
tamperedSource.normalization.exposure_per_second /= 2;
tamperedSource.normalization_hash = canonicalHash(tamperedSource.normalization);
assert.throws(() => running.bindRunningDosePool(sourceRuns, tamperedSource), /Canonical workout failed validation/);
const timedRecovery = structuredClone(sourceRuns[0]);
delete timedRecovery.steps[0].target.distance_m;
timedRecovery.workout_family = 'recovery_run'; timedRecovery.steps[0].workout_family = 'recovery_run';
const timedSource = running.selectRunningDoseSource([timedRecovery], { policy_version: running.VERSION,
  authority: 'COMPATIBLE_SERVER_HISTORY', evidence_snapshot_hash: 'known-observed-pace-source', allow_effort_only: true });
const timed = running.bindRunningDosePool([timedRecovery], timedSource)[0];
assert.ok(resolveSessionStress(timed).valid, 'Known historical pace does not require invented distance on a timed recovery prescription');
assert.equal(timed.steps[0].target.distance_m, undefined);
assert.equal(timed.running_dose.actual_dose.distance_basis, 'DURATION_ONLY_NO_DISTANCE_PRESCRIPTION');
assert.deepEqual(recoveries.map(session => resolveSessionStress(session).vector), pool(7).map(session => resolveSessionStress(session).vector), 'Recovery title/family cannot discount identical easy work');
assert.ok(running.validateRunningDosePools(recoveries));
assert.equal(running.validateRunningDosePools(recoveries.slice(1)), false, 'Missing partition member fails closed');
assert.equal(running.validateRunningDosePools([...recoveries, recoveries[0]]), false, 'Duplicated partition member fails closed');
for (const mutate of [s => { delete s.running_dose_accounting_version; }, s => { delete s.steps[0].target.duration_s; },
  s => { delete s.steps[0].target.distance_m; }, s => { delete s.steps[0].target.rpe_range; },
  s => { s.steps[0].provenance = []; }, s => { delete s.running_dose.source_hash; },
  s => { s.running_dose.source.authority = 'COMPATIBLE_SERVER_HISTORY';
    s.running_dose.source_hash = canonicalHash(s.running_dose.source); },
  s => { s.running_dose.partition_index = -1; }, s => { s.running_dose.pool.allocations[1].dose.duration_s = -1500;
    s.running_dose.pool_hash = canonicalHash(s.running_dose.pool); }]) {
  const changed = structuredClone(recoveries[0]); mutate(changed); changed.content_hash = canonicalWorkoutHash(changed);
  assert.equal(resolveSessionStress(changed).valid, false, 'Malformed canonical allocation cannot lower load');
}
console.log('PROGRAM DOSE POLICY UNIT CHECKS OK: canonical strength partition, full reference, monotonicity, downgrade/tamper and easy actual-dose consumers');
