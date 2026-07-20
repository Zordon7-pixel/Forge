const assert = require('node:assert/strict');
const { computeBadges, buildYouVsLastMonth } = require('../src/lib/badges');

const NOW = new Date('2026-07-20T12:00:00Z');

function run(date, miles = 3) {
  return {
    date,
    distance_miles: miles,
    duration_seconds: miles * 600,
    type: 'easy',
  };
}

function lift(date, sets = 3, reps = 5, weight = 100) {
  return {
    date,
    exercise_name: 'Back Squat',
    sets,
    reps,
    weight_lbs: weight,
  };
}

function badgeById(rows, id) {
  return rows.find((badge) => badge.id === id);
}

const runOnlyBadges = computeBadges({
  now: NOW,
  runs: [run('2026-07-06'), run('2026-07-13')],
  lifts: [],
  prs: [],
  hybridScore: { score: 58 },
});
assert.equal(
  badgeById(runOnlyBadges, 'hybrid_week_2').earned,
  false,
  'run-only training must not unlock the hybrid-week badge'
);

const liftOnlyBadges = computeBadges({
  now: NOW,
  runs: [],
  lifts: [lift('2026-07-06'), lift('2026-07-13')],
  prs: [],
  hybridScore: { score: 58 },
});
assert.equal(
  badgeById(liftOnlyBadges, 'hybrid_week_2').earned,
  false,
  'lift-only training must not unlock the hybrid-week badge'
);

const splitWeeksBadges = computeBadges({
  now: NOW,
  runs: [run('2026-07-06'), run('2026-07-13')],
  lifts: [lift('2026-07-22'), lift('2026-07-29')],
  prs: [],
  hybridScore: { score: 58 },
});
assert.equal(
  badgeById(splitWeeksBadges, 'hybrid_week_2').earned,
  false,
  'runs and lifts in separate weeks must not count as two hybrid weeks'
);

const hybridBadges = computeBadges({
  now: NOW,
  runs: [run('2026-07-06'), run('2026-07-13')],
  lifts: [lift('2026-07-08'), lift('2026-07-15')],
  prs: [],
  hybridScore: { score: 72 },
});
const hybridWeekBadge = badgeById(hybridBadges, 'hybrid_week_2');
assert.equal(hybridWeekBadge.earned, true, 'two weeks with both run and lift should unlock the hybrid-week badge');
assert.equal(hybridWeekBadge.earnedAt, '2026-07-15');

const comparison = buildYouVsLastMonth({
  now: NOW,
  currentHybridScore: 72,
  priorHybridScore: 61,
  runs: [
    run('2026-05-27', 2),
    run('2026-06-05', 3),
    run('2026-06-24', 4),
    run('2026-07-10', 6),
  ],
  lifts: [
    lift('2026-05-28', 3, 5, 100),
    lift('2026-06-12', 2, 5, 80),
    lift('2026-06-25', 4, 5, 100),
    lift('2026-07-11', 3, 10, 70),
  ],
});

assert.deepEqual(comparison.currentWindow, { start: '2026-06-23', end: '2026-07-20' });
assert.deepEqual(comparison.priorWindow, { start: '2026-05-26', end: '2026-06-22' });
assert.equal(comparison.mileage.current, 10);
assert.equal(comparison.mileage.prior, 5);
assert.equal(comparison.mileage.delta, 5);
assert.equal(comparison.mileage.percentDelta, 100);
assert.equal(comparison.liftTonnage.current, 4100);
assert.equal(comparison.liftTonnage.prior, 2300);
assert.equal(comparison.liftTonnage.delta, 1800);
assert.equal(comparison.liftSessions.current, 2);
assert.equal(comparison.liftSessions.prior, 2);
assert.equal(comparison.liftSessions.delta, 0);
assert.equal(comparison.consistency.current, 50);
assert.equal(comparison.consistency.prior, 25);
assert.equal(comparison.consistency.delta, 25);
assert.equal(comparison.hybridScore.current, 72);
assert.equal(comparison.hybridScore.prior, 61);
assert.equal(comparison.hybridScore.delta, 11);

console.log('engagementPhase3 smoke passed');
