const assert = require('node:assert/strict');
const { buildRunPerformanceProfile } = require('../src/lib/concurrentPlan');

const TODAY = '2026-09-08';

function run(id, date, miles, paceSecondsPerMile) {
  return {
    id,
    date,
    distance_miles: miles,
    duration_seconds: Math.round(miles * paceSecondsPerMile),
    health_source: 'strava',
    type: 'run',
  };
}

const weighted = buildRunPerformanceProfile([
  run('older-fast', '2026-05-11', 10, 480),
  run('recent-slower', '2026-09-01', 10, 570),
], { todayISO: TODAY, targetDistanceMiles: 10 });
assert.equal(
  weighted.targetAnchor?.runId,
  'recent-slower',
  'freshness weighting must keep a substantially older fast effort from controlling current doability',
);

const nineMonthHistory = buildRunPerformanceProfile([
  run('nine-month-pr', '2025-12-08', 10, 450),
  run('recent-current', '2026-09-01', 10, 570),
], { todayISO: TODAY, targetDistanceMiles: 10 });
assert.equal(nineMonthHistory.targetAnchor?.runId, 'recent-current');
assert.equal(nineMonthHistory.historicalTargetAnchor?.runId, 'nine-month-pr');
assert.equal(nineMonthHistory.records.find((record) => record.key === '10_mile')?.runId, 'nine-month-pr');

const boundary = buildRunPerformanceProfile([
  run('day-180', '2026-03-12', 10, 540),
  run('day-181', '2026-03-11', 10, 480),
], { todayISO: TODAY, targetDistanceMiles: 10 });
assert.equal(boundary.targetAnchor?.runId, 'day-180', 'the documented 180-day boundary remains eligible');
assert.equal(boundary.historicalTargetAnchor?.runId, 'day-181', 'day 181 remains historical context only');

const supportedCrossDistance = buildRunPerformanceProfile([
  run('recent-10k', '2026-09-02', 6.214, 510),
], { todayISO: TODAY, targetDistanceMiles: 10 });
assert.equal(supportedCrossDistance.targetAnchor?.runId, 'recent-10k');
assert.equal(supportedCrossDistance.targetAnchor?.kind, 'cross_distance_estimate');

const fresherCrossDistance = buildRunPerformanceProfile([
  run('older-exact', '2026-05-11', 10, 480),
  run('recent-cross', '2026-09-01', 6.214, 510),
], { todayISO: TODAY, targetDistanceMiles: 10 });
assert.equal(
  fresherCrossDistance.targetAnchor?.runId,
  'recent-cross',
  'recent cross-distance evidence can outrank an older exact-distance effort for current doability',
);
assert.equal(fresherCrossDistance.targetAnchor?.kind, 'cross_distance_estimate');
assert.equal(
  fresherCrossDistance.records.find((record) => record.key === '10_mile')?.runId,
  'older-exact',
  'the older exact-distance effort remains historical record truth without regaining fitness authority',
);

console.log('CONCURRENT PLAN ANCHOR TEST OK (13 checks)');
