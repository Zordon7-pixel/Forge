const assert = require('node:assert/strict');
const { computeHybridScore } = require('../src/lib/hybridScore');

const NOW = new Date('2026-07-20T12:00:00Z');

function addDays(iso, amount) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function run(date, miles = 4) {
  return {
    date,
    type: 'easy',
    distance_miles: miles,
    duration_seconds: miles * 600,
    perceived_effort: 6,
  };
}

function lift(date, tonnageMultiplier = 1) {
  return {
    date,
    exercise_name: 'Back Squat',
    sets: 4,
    reps: 8,
    weight_lbs: 100 * tonnageMultiplier,
    category: 'strength',
  };
}

function profile({ runDates = [], liftDates = [] }) {
  return computeHybridScore({
    userId: 'test-user',
    now: NOW,
    runs: runDates.map((date) => run(date)),
    lifts: liftDates.map((date) => lift(date)),
    planCompletion: { planned: 4, completed: 4 },
  });
}

const currentRunOnly = ['2026-07-13', '2026-07-15', '2026-07-17', '2026-07-19'];
const baselineRunOnly = currentRunOnly.map((date) => addDays(date, -28));
const currentLiftOnly = ['2026-07-13', '2026-07-15', '2026-07-17', '2026-07-19'];
const baselineLiftOnly = currentLiftOnly.map((date) => addDays(date, -28));
const currentBalancedRuns = ['2026-07-14', '2026-07-18'];
const baselineBalancedRuns = currentBalancedRuns.map((date) => addDays(date, -28));
const currentBalancedLifts = ['2026-07-15', '2026-07-19'];
const baselineBalancedLifts = currentBalancedLifts.map((date) => addDays(date, -28));

const runOnly = profile({ runDates: baselineRunOnly.concat(currentRunOnly) });
const liftOnly = profile({ liftDates: baselineLiftOnly.concat(currentLiftOnly) });
const balanced = profile({
  runDates: baselineBalancedRuns.concat(currentBalancedRuns),
  liftDates: baselineBalancedLifts.concat(currentBalancedLifts),
});

for (const result of [runOnly, liftOnly, balanced]) {
  assert.equal(Number.isInteger(result.score), true);
  assert.ok(result.score >= 0 && result.score <= 100, `score out of range: ${result.score}`);
  for (const value of Object.values(result.components)) {
    assert.equal(Number.isInteger(value), true);
    assert.ok(value >= 0 && value <= 100, `component out of range: ${value}`);
  }
}

assert.ok(runOnly.score < balanced.score, `run-only ${runOnly.score} should be below balanced ${balanced.score}`);
assert.ok(liftOnly.score < balanced.score, `lift-only ${liftOnly.score} should be below balanced ${balanced.score}`);
assert.ok(runOnly.score <= 60, `run-only should be capped at or below 60, got ${runOnly.score}`);
assert.ok(liftOnly.score <= 60, `lift-only should be capped at or below 60, got ${liftOnly.score}`);

console.log('hybridScore smoke passed', { runOnly, liftOnly, balanced });
