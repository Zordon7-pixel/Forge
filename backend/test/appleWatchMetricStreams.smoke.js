const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_STREAM_POINTS,
  mergeWorkoutMetricStreams,
  normalizeWorkoutMetricStreams,
} = require('../src/lib/workoutMetricStreams');

const root = path.join(__dirname, '..', '..');
const swift = fs.readFileSync(path.join(root, 'frontend/ios/App/App/ForgeHealthPlugin.swift'), 'utf8');
const importRoute = fs.readFileSync(path.join(root, 'backend/src/routes/import.js'), 'utf8');
const runsRoute = fs.readFileSync(path.join(root, 'backend/src/routes/runs.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend/src/db/schema.pg.sql'), 'utf8');
const recap = fs.readFileSync(path.join(root, 'frontend/src/components/RunDetailModal.jsx'), 'utf8');

const normalized = normalizeWorkoutMetricStreams({
  version: 1,
  source: 'apple_health',
  heart_rate_bpm: [{ t: 10, v: 171 }, { t: 0, v: 85 }, { t: 11, v: 999 }],
  running_power_watts: Array.from({ length: 900 }, (_, index) => ({ t: index, v: 152 + (index % 5) })),
});
assert.deepEqual(normalized.heart_rate_bpm, [{ t: 0, v: 85 }, { t: 10, v: 171 }]);
assert.equal(normalized.running_power_watts.length, MAX_STREAM_POINTS, 'streams are deterministically bounded');

const merged = mergeWorkoutMetricStreams({
  version: 1,
  source: 'apple_health',
  running_cadence_spm: [{ t: 0, v: 160 }, { t: 10, v: 161 }],
}, {
  version: 1,
  source: 'apple_health',
  heart_rate_bpm: [{ t: 0, v: 150 }, { t: 10, v: 171 }],
});
assert.equal(merged.running_cadence_spm.length, 2, 'late enrichment preserves previously imported streams');
assert.equal(merged.heart_rate_bpm.length, 2, 'late enrichment adds newly available streams');

assert.match(swift, /metricsSchemaVersion": 6/);
assert.match(swift, /running_power_watts/);
assert.match(swift, /running_cadence_spm/);
assert.match(swift, /post_workout_heart_rate_bpm/);
assert.match(swift, /maxMetricStreamPoints = 600/);
assert.match(importRoute, /workout_metric_streams_json/);
assert.match(importRoute, /min_heart_rate = COALESCE/);
assert.match(runsRoute, /withoutWorkoutMetricStreams/);
assert.match(runsRoute, /runs\.map\(\(run\)[\s\S]*withoutWorkoutMetricStreams\(run\)[\s\S]*activity_kind:\s*activityKind\(run\)/, 'history summaries omit large streams while adding canonical activity identity');
assert.match(runsRoute, /router\.get\('\/:id'[\s\S]*SELECT \* FROM runs WHERE id=\? AND user_id=\?/, 'owner-scoped detail still returns metric streams');
assert.match(schema, /workout_metric_streams_json TEXT DEFAULT '\{\}'/);
assert.match(recap, /Apple Watch timelines/);
assert.match(recap, /data-metric-trace/);

console.log('Apple Watch metric streams smoke passed');
