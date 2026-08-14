const assert = require('node:assert/strict');
const fixtures = require('./fixtures/apple-health-workouts.json');
const { _test } = require('../src/routes/import');
const {
  classifyProviderCoverage,
  healthMetricFreshness,
  modalityEligibility,
  valueStateForEmptyCoverage,
} = require('../src/lib/healthCoverage');

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

  const coverageCases = [
    { status: 'complete', expectedQuality: 'COMPLETE', expectedValue: 'VALID_ZERO' },
    { status: 'partial', expectedQuality: 'PARTIAL', expectedValue: 'UNKNOWN' },
    { status: 'failed', expectedQuality: 'FAILED_SYNC', expectedValue: 'UNKNOWN' },
  ];
  for (const fixture of coverageCases) {
    const classified = classifyProviderCoverage({
      source_system: 'apple_health',
      status: fixture.status,
      coverage_start_local: '2026-08-03',
      coverage_end_local: '2026-08-09',
      expected_start_local: '2026-08-03',
      expected_end_local: '2026-08-09',
      modalities: ['running'],
    });
    assert.equal(classified.quality_state, fixture.expectedQuality);
    assert.equal(valueStateForEmptyCoverage([classified]), fixture.expectedValue);
  }

  const eligibility = modalityEligibility([
    classifyProviderCoverage({
      source_system: 'garmin',
      status: 'complete',
      modalities: ['running'],
      coverage_start_local: '2026-08-03',
      coverage_end_local: '2026-08-09',
    }),
    classifyProviderCoverage({ source_system: 'forge', status: 'failed', modalities: ['strength'] }),
  ]);
  assert.equal(eligibility.running.eligible, true);
  assert.equal(eligibility.running.value_state, 'VALID_ZERO');
  assert.equal(eligibility.strength.eligible, false);
  assert.equal(eligibility.strength.quality_state, 'FAILED_SYNC');
  assert.equal(eligibility.lower_body_muscular.eligible, false);
  assert.deepEqual(
    healthMetricFreshness('sleep_duration', '2026-08-13T00:00:00.000Z', '2026-08-14T12:00:00.000Z'),
    { freshness_class: 'FRESH', usable: true },
    'sleep remains fresh through exactly 36 hours'
  );
  assert.deepEqual(
    healthMetricFreshness('sleep_duration', '2026-08-12T23:59:59.999Z', '2026-08-14T12:00:00.000Z'),
    { freshness_class: 'STALE', usable: false },
    'sleep becomes stale immediately after 36 hours'
  );
  assert.equal(
    healthMetricFreshness('hrv', '2026-08-13T12:00:00.000Z', '2026-08-14T12:00:00.000Z', { baselineDays: 13 }).usable,
    false,
    'HRV requires at least 14 valid baseline days even while fresh'
  );
  assert.equal(
    healthMetricFreshness('hrv', '2026-08-12T12:00:00.000Z', '2026-08-14T12:00:00.000Z', { baselineDays: 14 }).usable,
    true,
    'HRV remains usable through exactly 48 hours with a valid baseline'
  );

  console.log('HEALTH FIXTURE MATRIX SMOKE OK (48)');
}

if (require.main === module) runHealthFixtureMatrixSmoke();

module.exports = { runHealthFixtureMatrixSmoke };
