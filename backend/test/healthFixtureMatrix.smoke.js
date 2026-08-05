const assert = require('node:assert/strict');
const fixtures = require('./fixtures/apple-health-workouts.json');
const { _test } = require('../src/routes/import');

function runHealthFixtureMatrixSmoke() {
  const native = _test.normalizeRow(fixtures.nativeSerializedOutdoorRun);
  assert.equal(native.section, 'run');
  assert.equal(native.runType, 'easy');
  assert.equal(native.sourceWorkoutId, fixtures.nativeSerializedOutdoorRun.id);
  assert.equal(native.date, fixtures.nativeSerializedOutdoorRun.date);
  assert.equal(native.distanceMiles, 3.107);
  assert.equal(native.avgHeartRate, 148);
  assert.equal(native.maxHeartRate, 169);
  assert.equal(native.workoutMetrics.hr_sample_coverage_pct, 100);
  assert.equal(native.workoutMetrics.route_status, 'missing');

  const outdoor = _test.normalizeRow(fixtures.completeOutdoorRun);
  assert.equal(outdoor.section, 'run');
  assert.equal(outdoor.runType, 'easy');
  assert.equal(outdoor.distanceMiles, 3.107);
  assert.equal(outdoor.workoutMetrics.distance_source, 'apple_health');
  assert.equal(outdoor.workoutMetrics.route_status, 'complete');
  assert.equal(outdoor.workoutMetrics.route_point_count, 3);
  assert.equal(outdoor.workoutMetrics.hr_sample_coverage_pct, 100);
  assert.equal(outdoor.routeCoords[0].alt, 22);

  const treadmill = _test.normalizeRow(fixtures.treadmillRun);
  assert.equal(treadmill.section, 'run');
  assert.equal(treadmill.runType, 'treadmill');
  assert.equal(treadmill.workoutMetrics.route_status, 'missing');

  const walk = _test.normalizeRow(fixtures.walk);
  assert.equal(walk.section, 'activity');
  assert.equal(walk.runType, 'walk');

  const strength = _test.normalizeRow(fixtures.strength);
  assert.equal(strength.section, 'lift');
  assert.equal(strength.liftCategory, 'strength');

  const partial = _test.normalizeRow(fixtures.partialHeartRateRun);
  assert.equal(partial.section, 'run');
  assert.equal(partial.workoutMetrics.hr_sample_coverage_pct, 27.5);
  assert.equal(Object.values(partial.zoneSeconds).reduce((sum, seconds) => sum + seconds, 0), 660);

  const watchCopy = _test.normalizeRow(fixtures.watchCopyOfForgedRun);
  const matched = _test.chooseForgedRunMatch([fixtures.forgedCandidate], watchCopy);
  assert.equal(matched?.id, fixtures.forgedCandidate.id, 'watch summary matches the phone-recorded route');

  const distantCopy = { ...watchCopy, startDate: '2026-08-05T11:00:00.000Z' };
  assert.equal(_test.chooseForgedRunMatch([fixtures.forgedCandidate], distantCopy), null, 'unrelated run is not merged');

  assert.throws(
    () => _test.normalizeRow({ ...fixtures.completeOutdoorRun, distanceMeters: 5000, distanceMiles: 4 }),
    /Conflicting distance evidence/,
    'conflicting source units are rejected instead of guessed'
  );

  console.log('HEALTH FIXTURE MATRIX SMOKE OK (29)');
}

if (require.main === module) runHealthFixtureMatrixSmoke();

module.exports = { runHealthFixtureMatrixSmoke };
