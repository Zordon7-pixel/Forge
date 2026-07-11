const assert = require('node:assert/strict');
const { buildPatch, estimateWorkoutMinutes } = require('../src/lib/checkinOverride');

const longRun = { distance_miles: 8, pace_target: '10:00/mi' };
assert.equal(estimateWorkoutMinutes(longRun), 80);
assert.equal(buildPatch('shorten', longRun, { time_available: 45 }).distance_miles, 4.5);

const timedRun = { distance_miles: 6, duration_minutes: 60 };
const timedPatch = buildPatch('shorten', timedRun, { time_available: 30 });
assert.equal(timedPatch.duration_minutes, 30);
assert.equal(timedPatch.distance_miles, 3);

console.log('Check-in time cap smoke passed');
