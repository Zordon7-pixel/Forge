const assert = require('node:assert/strict');
const { normalizeWorkoutMetricStreams: normalize, mergeWorkoutMetricStreams: merge } = require('../src/lib/workoutMetricStreams');
const incoming = value => normalize(value, { inputKind: 'incoming' });
const input = (source, metric = 'running_speed_mps', points = [[0, 0], [10, 3]]) => ({ source, [metric]: points });
async function main() {
  const { parseWorkoutMetricStreams: parse, workoutMetricSourceLabel: label } = await import('../../frontend/src/lib/runRecap.js');
  for (const invalid of [null, undefined, '', ' ', '\t', true, false, [], {}, [0], NaN, Infinity, -Infinity,
    '0x10', '1e1', ' 0', '0 ', 'Infinity', 'NaN', '0'.repeat(33)]) {
    for (const point of [[invalid, 3], [1, invalid], { t: invalid, v: 3 }, { t: 1, v: invalid },
      { t: invalid, time: 1, v: 3 }, { t: 1, v: invalid, value: 3 }]) {
      assert.deepEqual(normalize(input('apple_health', undefined, [point])), {}, `backend ${JSON.stringify(point)}`);
      assert.deepEqual(parse(input('apple_health', undefined, [point])), {}, `frontend ${JSON.stringify(point)}`);
    }
  }
  for (const point of [null, undefined, true, false, 0, '', [], [0], [0, 0, 3], {}]) {
    assert.deepEqual(normalize(input('apple_health', undefined, [point])), {});
    assert.deepEqual(parse(input('apple_health', undefined, [point])), {});
  }
  for (const points of [[[0, 0]], [[-0, -0]], [['-0', '-0']], [{ t: 0, v: 0 }], [['0', '0.0']], [{ time: '0', value: '+0' }]]) {
    const n = normalize(input('apple_health', undefined, points));
    assert.deepEqual(n.running_speed_mps, [{ t: 0, v: 0 }]); assert.deepEqual(parse(n), n);
  }
  assert.deepEqual(normalize(input('apple_health', 'heart_rate_bpm', [[0, 0]])), {});
  assert.deepEqual(normalize(input('apple_health', 'post_workout_heart_rate_bpm', [[301, 140]])), {});
  const legacy = input('apple_health', 'heart_rate_bpm', [[0, 140], [10, 145]]);
  const old = normalize(legacy);
  assert.equal(old.source, 'unknown'); assert.equal(old.metric_sources.heart_rate_bpm.basis, 'LEGACY_GLOBAL_ONLY');
  assert.equal(old.metric_sources.heart_rate_bpm.declared_source, null);
  assert.match(label(parse(old), 'heart_rate_bpm'), /unknown.*unverified/);
  const apple = incoming(legacy), manual = input('manual');
  const mixed = merge(apple, manual);
  assert.equal(mixed.source, 'mixed'); assert.equal(mixed.metric_sources.heart_rate_bpm.declared_source, 'apple_health');
  assert.equal(mixed.metric_sources.running_speed_mps.declared_source, 'manual');
  assert.deepEqual(merge(apple, input('apple_health')).source, 'apple_health');
  assert.equal(merge(old, manual).metric_sources.heart_rate_bpm.basis, 'LEGACY_GLOBAL_ONLY');
  const unknown = merge(mixed, input(undefined));
  assert.equal(unknown.metric_sources.running_speed_mps.declared_source, null, 'new source-less points never inherit prior origin');
  assert.equal(unknown.source, 'mixed');
  assert.equal(merge({}, input(undefined)).source, 'unknown');
  for (const badSource of [null, undefined, {}, [], false, 1, 'x'.repeat(41), 'bad\nsource']) {
    assert.equal(incoming(input(badSource)).metric_sources.running_speed_mps.basis, 'UNKNOWN');
  }
  const spoof = incoming({ version: 2, source: 'VERIFIED_PROVIDER', running_speed_mps: [[0, 3]],
    metric_sources: { running_speed_mps: { basis: 'DECLARED', declared_source: 'garmin', verification_status: 'VERIFIED', server_attested: true } } });
  assert.equal(spoof.metric_sources.running_speed_mps.verification_status, 'UNVERIFIED');
  assert.equal('server_attested' in spoof.metric_sources.running_speed_mps, false);
  assert.match(label(parse(spoof), 'running_speed_mps'), /Declared source: garmin \(unverified\)/);
  for (const empty of [{ source: 'changed' }, input('changed', undefined, [[null, null]]), {}]) assert.deepEqual(merge(mixed, empty), mixed);
  const many = incoming(input('apple_health', undefined, Array.from({ length: 1000 }, (_, i) => [999 - i, 3])));
  assert.equal(many.running_speed_mps.length, 600); assert.equal(many.running_speed_mps[0].t, 0);
  assert.equal(many.running_speed_mps.at(-1).t, 999);
  assert.deepEqual(normalize(input('apple_health', undefined, [[1, 2], [1, 3]])).running_speed_mps, [{ t: 1, v: 3 }]);
  for (const value of [old, apple, mixed, unknown, spoof, many]) {
    const before = structuredClone(value);
    assert.deepEqual(normalize(JSON.stringify(value)), value);
    assert.deepEqual(parse(JSON.stringify(value)), value);
    assert.deepEqual(merge(value, value), value);
    assert.deepEqual(value, before);
  }
  assert.deepEqual(merge(mixed, manual), mixed, 'enrichment replay stable');
  console.log('PASS metric stream truth: malformed/zero, per-metric declared/legacy/unknown, spoof containment, merge/roundtrip/parser parity, deterministic bounds');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
