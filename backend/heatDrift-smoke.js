const assert = require('assert');
const { assessHeatDrift } = require('./src/lib/heatDrift');

const hot = assessHeatDrift({
  targetZone: 'Zone 2',
  actualZone: 'Z3',
  weather: { available: true, feelsLikeF: 88, tempF: 84 },
});
assert.strictEqual(hot.drifted, true);
assert.strictEqual(hot.label, 'heat-expected');

const mild = assessHeatDrift({
  targetZone: 'Z2',
  actualZone: 'Z3',
  weather: { available: true, feelsLikeF: 55, tempF: 55 },
});
assert.strictEqual(mild.drifted, true);
assert.strictEqual(mild.label, 'overreach');

const unknown = assessHeatDrift({
  targetZone: 'Zone 2',
  actualZone: 'Zone 3',
  weather: { available: false, reason: 'WEATHER_API_KEY is not configured' },
});
assert.strictEqual(unknown.drifted, true);
assert.strictEqual(unknown.label, 'drift-unknown');

const noDrift = assessHeatDrift({
  targetZone: 'Zone 2',
  actualZone: 'Z2',
  weather: { available: true, feelsLikeF: 88 },
});
assert.deepStrictEqual(noDrift, { drifted: false });

const garbage = assessHeatDrift({
  targetZone: 'easy',
  actualZone: 'tempo',
  weather: null,
});
assert.deepStrictEqual(garbage, { drifted: false });

console.log('heatDrift smoke passed');
