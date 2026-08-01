const assert = require('node:assert/strict');
const { decideWeeklyRamp } = require('../src/lib/weeklyRampEngine');

const deload = decideWeeklyRamp({
  weeklyMileageHistory: [10, 10, 10, 30],
  plannedNextWeekMiles: 32,
  readinessTrend: 'improving',
});
assert.equal(deload.decision, 'DELOAD');
assert.equal(deload.targetMiles, 27);
assert.equal(deload.acwr, 2);
assert.deepEqual(deload.drivers, ['acwr']);

const redTrendDeload = decideWeeklyRamp({
  weeklyMileageHistory: [20, 20, 20, 20],
  plannedNextWeekMiles: 22,
  readinessTrend: 'red-trend',
});
assert.equal(redTrendDeload.decision, 'DELOAD');
assert.equal(redTrendDeload.targetMiles, 18);
assert.deepEqual(redTrendDeload.drivers, ['readiness']);

const hold = decideWeeklyRamp({
  weeklyMileageHistory: [10, 10, 10, 15],
  plannedNextWeekMiles: 18,
  readinessTrend: 'stable',
});
assert.equal(hold.decision, 'HOLD');
assert.equal(hold.targetMiles, 15);
assert.ok(hold.acwr >= 1.3 && hold.acwr <= 1.5);

const readinessHold = decideWeeklyRamp({
  weeklyMileageHistory: [20, 20, 20, 20],
  plannedNextWeekMiles: 22,
  readinessTrend: 'declining',
});
assert.equal(readinessHold.decision, 'HOLD');
assert.equal(readinessHold.targetMiles, 20);

const advance = decideWeeklyRamp({
  weeklyMileageHistory: [20, 20, 20, 20],
  plannedNextWeekMiles: 21,
  readinessTrend: 'improving',
});
assert.equal(advance.decision, 'ADVANCE');
assert.equal(advance.targetMiles, 21);

const passthrough = decideWeeklyRamp({
  weeklyMileageHistory: [12, 14, 15],
  plannedNextWeekMiles: '18.0',
  readinessTrend: 'stable',
});
assert.equal(passthrough.decision, 'PASSTHROUGH');
assert.strictEqual(passthrough.targetMiles, '18.0');
assert.equal(passthrough.acwr, null);

const capped = decideWeeklyRamp({
  weeklyMileageHistory: [20, 20, 20, 20],
  plannedNextWeekMiles: 30,
  readinessTrend: 'stable',
});
assert.equal(capped.decision, 'ADVANCE');
assert.equal(capped.targetMiles, 22);

const emptyHistory = decideWeeklyRamp({
  weeklyMileageHistory: [],
  plannedNextWeekMiles: 24,
  readinessTrend: 'improving',
});
assert.deepEqual(emptyHistory, {
  decision: 'PASSTHROUGH',
  targetMiles: 24,
  acwr: null,
  reason: ['Insufficient 28-day mileage history.'],
  drivers: [],
});

console.log('weeklyRampEngine smoke passed');
