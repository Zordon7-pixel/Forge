const assert = require('node:assert/strict');
const { annotatePlanEffort } = require('../src/lib/planEffort');

const sessions = [
  {
    id: 'run-1',
    date: '2026-08-03',
    kind: 'run',
    type: 'easy',
    target_zone: 'Zone 2',
    intensity: 'Easy',
  },
  {
    id: 'lift-1',
    date: '2026-08-03',
    kind: 'lift',
    type: 'strength',
    title: 'Lower body',
  },
];
const profile = { max_hr: 190, resting_hr: 50, lthr: null, zone_model: 'hrr' };

const calibrated = annotatePlanEffort(sessions, profile);
assert.deepEqual(calibrated[0].targetBpmRange, { minBpm: 134, maxBpm: 148 });
assert.equal(calibrated[0].targetZone, 'Zone 2');
assert.equal(calibrated[0].effortLabel, 'Easy');
assert.deepEqual(calibrated[1], sessions[1]);
assert.deepEqual(sessions[0], {
  id: 'run-1',
  date: '2026-08-03',
  kind: 'run',
  type: 'easy',
  target_zone: 'Zone 2',
  intensity: 'Easy',
});

const noProfile = annotatePlanEffort(sessions, null);
assert.deepEqual(noProfile, sessions);
assert.notStrictEqual(noProfile[0], sessions[0]);
assert.equal(Object.hasOwn(noProfile[0], 'targetBpmRange'), false);
assert.deepEqual(annotatePlanEffort(sessions, {}), sessions);

console.log('planEffort smoke passed');
