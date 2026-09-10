const assert = require('node:assert/strict');
const { resolveRunSchedule, resolveLiftSchedule, DAY_ORDER } = require('../src/lib/runSchedule');
for (let count = 1; count <= 7; count += 1) {
  const result = resolveRunSchedule({}, { runDaysPerWeek: count, runEligibleWeekdays: DAY_ORDER });
  assert.equal(result.valid, true);
  assert.equal(result.runDaysPerWeek, count);
}
for (let count = 0; count <= 7; count += 1) {
  const result = resolveLiftSchedule({}, { liftDaysPerWeek: count, liftEligibleWeekdays: count ? DAY_ORDER : [] });
  assert.equal(result.valid, true);
  assert.equal(result.liftDaysPerWeek, count);
}
for (const malformed of [null, '', '4', true, false, [], {}, 1.5, -1, 8]) {
  assert.equal(resolveRunSchedule({}, { runDaysPerWeek: malformed, trainingDays: DAY_ORDER }).valid, false);
  assert.equal(resolveLiftSchedule({}, { liftDaysPerWeek: malformed, liftEligibleWeekdays: DAY_ORDER }).valid, false);
}
assert.equal(resolveRunSchedule({ run_days_per_week: 4, preferred_workout_days: '["Tue","Thu"]' }).valid, false,
  'Stored frequency conflicts cannot silently become two runs');
const legacyConflict = resolveRunSchedule({ run_days_per_week: 7, preferred_workout_days: JSON.stringify(DAY_ORDER.slice(0, 6)) });
assert.equal(legacyConflict.code, 'RUN_FREQUENCY_EXCEEDS_TRAINING_DAYS');
assert.match(legacyConflict.error, /cannot exceed the number of selected trainingDays/);
const corrected = resolveRunSchedule({ run_days_per_week: 7, preferred_workout_days: JSON.stringify(DAY_ORDER.slice(0, 6)) },
  { runDaysPerWeek: 7, runEligibleWeekdays: DAY_ORDER });
assert.equal(corrected.valid, true, 'Explicitly correcting contradictory weekdays does not require deleting account or plan');
assert.equal(resolveLiftSchedule({}, { liftDaysPerWeek: 1, liftEligibleWeekdays: [] }).valid, false);
const separate = { runDaysPerWeek: 4, liftDaysPerWeek: 4, trainingDays: ['Mon','Tue','Thu','Sat'], liftEligibleWeekdays: ['Mon','Wed','Fri','Sun'] };
assert.deepEqual(resolveRunSchedule({}, separate).trainingDays, separate.trainingDays);
assert.deepEqual(resolveLiftSchedule({}, separate).liftEligibleWeekdays, separate.liftEligibleWeekdays);
console.log('PROGRAM INPUT AUTHORITY OK: road 1–7 runs, 0–7 lifts, malformed values and distinct modality weekdays');
