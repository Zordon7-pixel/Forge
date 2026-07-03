#!/usr/bin/env node
const assert = require('assert');
const watchSync = require('../src/routes/watchSync');

const {
  findRunDuplicateFromRows,
  findLiftDuplicateFromRows,
  normalizeGarminActivityId,
  normalizeSyncUuid,
} = watchSync._test;

function simulateRunIngest(payload, runs, watchSyncRows) {
  const syncUuid = normalizeSyncUuid(payload);
  if (syncUuid && watchSyncRows.some((row) => row.sync_uuid === syncUuid)) {
    return { duplicate: true, reason: 'sync_uuid', runCount: runs.length };
  }

  const garminActivityId = normalizeGarminActivityId(payload);
  if (garminActivityId && watchSyncRows.some((row) => row.garmin_activity_id === garminActivityId)) {
    return { duplicate: true, reason: 'garmin_activity_id', runCount: runs.length };
  }

  const duplicate = findRunDuplicateFromRows(runs, payload);
  if (duplicate) return { duplicate: true, reason: 'heuristic', runCount: runs.length };

  const watchSyncId = `ws-${watchSyncRows.length + 1}`;
  watchSyncRows.push({
    id: watchSyncId,
    sync_uuid: syncUuid,
    garmin_activity_id: garminActivityId,
  });
  runs.push({
    id: `run-${runs.length + 1}`,
    watch_sync_id: watchSyncId,
    date: payload.date,
    distance_miles: payload.distance_miles,
    duration_seconds: payload.duration_seconds,
    health_start_at: payload.start_at || null,
  });
  return { duplicate: false, runCount: runs.length };
}

const runs = [];
const watchSyncRows = [];
const baseRun = {
  activity_type: 'run',
  date: '2026-05-18',
  start_at: '2026-05-18T10:00:00.000Z',
  duration_seconds: 1800,
  distance_miles: 3,
  sync_uuid: 'client-run-1',
};

assert.deepStrictEqual(simulateRunIngest(baseRun, runs, watchSyncRows), { duplicate: false, runCount: 1 });
assert.deepStrictEqual(simulateRunIngest(baseRun, runs, watchSyncRows), { duplicate: true, reason: 'sync_uuid', runCount: 1 });

assert.deepStrictEqual(
  simulateRunIngest({ ...baseRun, sync_uuid: null, garmin_activity_id: 'garmin-123', duration_seconds: 2400, distance_miles: 4 }, runs, watchSyncRows),
  { duplicate: false, runCount: 2 }
);
assert.deepStrictEqual(
  simulateRunIngest({ ...baseRun, sync_uuid: null, garmin_activity_id: 'garmin-123', duration_seconds: 2415, distance_miles: 4.05 }, runs, watchSyncRows),
  { duplicate: true, reason: 'garmin_activity_id', runCount: 2 }
);

assert.deepStrictEqual(
  simulateRunIngest({ ...baseRun, sync_uuid: null, garmin_activity_id: null, duration_seconds: 1200, distance_miles: 2, start_at: '2026-05-18T15:00:00.000Z' }, runs, watchSyncRows),
  { duplicate: false, runCount: 3 }
);
assert.deepStrictEqual(
  simulateRunIngest({ ...baseRun, sync_uuid: null, garmin_activity_id: null, duration_seconds: 1225, distance_miles: 2.02, start_at: '2026-05-18T15:20:00.000Z' }, runs, watchSyncRows),
  { duplicate: true, reason: 'heuristic', runCount: 3 }
);
assert.deepStrictEqual(
  simulateRunIngest({ ...baseRun, sync_uuid: null, garmin_activity_id: null, duration_seconds: 600, distance_miles: 1, start_at: '2026-05-18T18:00:00.000Z' }, runs, watchSyncRows),
  { duplicate: false, runCount: 4 }
);

const liftDuplicate = findLiftDuplicateFromRows(
  [{ id: 'lift-1', exercise_name: 'Strength Session', workout_duration_seconds: 3600 }],
  { activity_type: 'strength', exercise_name: 'Strength Session', workout_duration_seconds: 3580 }
);
assert.strictEqual(liftDuplicate.id, 'lift-1');

console.log('watchsync dedup smoke OK');
