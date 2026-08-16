#!/usr/bin/env node

const assert = require('node:assert/strict');
const { buildEvidenceSnapshot } = require('../src/lib/goalBackwardEvidence');
const { summarizeCanonicalActivityWindows } = require('../src/lib/activityIdentity');
const {
  classifyProviderCoverage,
  providerCoverageFromHealthRow,
  valueStateForEmptyCoverage,
} = require('../src/lib/healthCoverage');
const {
  normalizeTrainingMetrics,
  parseTrainingMetrics,
} = require('../src/lib/healthSyncMetrics');
const { _test: importTest } = require('../src/routes/import');
const concurrentPlan = require('../src/lib/concurrentPlan');

const ATHLETE_ID = 'athlete-c2-synthetic';

function appleRun(id, providerId, overrides = {}) {
  return {
    id,
    user_id: ATHLETE_ID,
    date: '2026-08-04',
    type: 'easy',
    distance_miles: 4.004,
    duration_seconds: 2335,
    health_source: 'apple_health',
    health_source_workout_id: providerId,
    health_start_at: '2026-08-04T12:36:59.000Z',
    health_end_at: '2026-08-04T13:15:54.000Z',
    workout_metrics_json: '{}',
    created_at: '2026-08-04T14:00:00.000Z',
    ...overrides,
  };
}

const historicalCollision = buildEvidenceSnapshot({
  athleteId: ATHLETE_ID,
  planningInstant: '2026-08-14T12:00:00.000Z',
  timezone: 'America/New_York',
  runs: [
    appleRun('raw-aug-4-a', 'healthkit-workout-a'),
    appleRun('raw-aug-4-b', 'healthkit-workout-b', {
      distance_miles: 4.003,
      duration_seconds: 2595,
      health_end_at: '2026-08-04T13:20:14.000Z',
      created_at: '2026-08-04T14:01:00.000Z',
    }),
  ],
});

assert.equal(
  historicalCollision.canonical_activities.length,
  1,
  'same-source changed-ID collision must count once during planning assembly',
);
assert.equal(
  historicalCollision.activity_identity_receipts[0].reason_code,
  'ACTIVITY_IDENTITY_FUZZY_COLLISION',
);
assert.equal(historicalCollision.source_row_counts.runs, 2, 'historical raw fixture rows remain present');
assert.match(historicalCollision.activity_identity_receipts[0].kept_activity_ref, /^sha256:[a-f0-9]{64}$/);
assert.deepEqual(
  Object.keys(historicalCollision.activity_identity_receipts[0]).sort(),
  [
    'kept_activity_ref',
    'reason_code',
    'receipt_schema_version',
    'references_truncated',
    'suppressed_activity_refs',
    'suppressed_count',
  ],
  'identity receipts use the bounded privacy-safe schema only',
);

const exactDuplicate = buildEvidenceSnapshot({
  athleteId: ATHLETE_ID,
  planningInstant: '2026-08-14T12:00:00.000Z',
  timezone: 'America/New_York',
  runs: [
    appleRun('raw-exact-a', 'same-provider-workout'),
    appleRun('raw-exact-b', 'same-provider-workout', {
      distance_miles: 4.5,
      duration_seconds: 3000,
      health_start_at: '2026-08-04T12:50:00.000Z',
    }),
  ],
});
assert.equal(exactDuplicate.canonical_activities.length, 1, 'exact provider identity counts once');
assert.equal(exactDuplicate.activity_identity_receipts[0].reason_code, 'ACTIVITY_IDENTITY_EXACT_DUPLICATE');

const nearbyDistinct = buildEvidenceSnapshot({
  athleteId: ATHLETE_ID,
  planningInstant: '2026-08-14T12:00:00.000Z',
  timezone: 'America/New_York',
  runs: [
    appleRun('raw-near-a', 'near-provider-a'),
    appleRun('raw-near-b', 'near-provider-b', {
      distance_miles: 4.5,
      duration_seconds: 2595,
      health_start_at: '2026-08-04T12:38:59.000Z',
    }),
  ],
});
assert.equal(nearbyDistinct.canonical_activities.length, 2, 'legitimate nearby workouts remain separate');
assert.equal(nearbyDistinct.activity_identity_receipts.length, 0);

function correction(id, rawEvidenceRef, value) {
  return {
    id,
    user_id: ATHLETE_ID,
    raw_evidence_kind: 'run',
    raw_evidence_ref: rawEvidenceRef,
    revision: 1,
    corrected_canonical_value_json: { field: 'distance_m', value },
    canonical_unit: 'm',
    reason_code: 'MANUAL_CORRECTION_APPLIED',
    reason: 'Athlete verified the corrected distance.',
    attributed_by_user_id: ATHLETE_ID,
    supersedes_correction_id: null,
    created_at: '2026-08-05T12:00:00.000Z',
  };
}

const correctionConflict = buildEvidenceSnapshot({
  athleteId: ATHLETE_ID,
  planningInstant: '2026-08-14T12:00:00.000Z',
  timezone: 'America/New_York',
  runs: [
    appleRun('raw-correction-a', 'correction-duplicate'),
    appleRun('raw-correction-b', 'correction-duplicate'),
  ],
  corrections: [
    correction('correction-a', 'raw-correction-a', 6400),
    correction('correction-b', 'raw-correction-b', 6800),
  ],
});
assert.equal(correctionConflict.canonical_activities.length, 1);
assert.equal(
  correctionConflict.canonical_activities[0].distance_m,
  null,
  'conflicting athlete corrections surface an unresolved value instead of silently choosing one',
);
assert.deepEqual(
  correctionConflict.canonical_activities[0].correction_ids,
  ['correction-a', 'correction-b'],
  'all conflicting correction provenance remains attached',
);
assert.equal(correctionConflict.unresolved_conflicts.some((entry) => entry.field === 'manual_correction'), true);

function datedRun(id, date, miles, overrides = {}) {
  return appleRun(id, `provider-${id}`, {
    date,
    distance_miles: miles,
    duration_seconds: Math.round(miles * 600),
    health_start_at: `${date}T12:00:00.000Z`,
    health_end_at: `${date}T13:00:00.000Z`,
    ...overrides,
  });
}

const windowRows = [
  datedRun('window-aug-14', '2026-08-14', 1),
  datedRun('window-aug-08', '2026-08-08', 2),
  datedRun('window-aug-07', '2026-08-07', 3),
  datedRun('window-aug-04-a', '2026-08-04', 4.004, {
    health_source_workout_id: 'window-aug-04-provider-a',
    duration_seconds: 2400,
  }),
  datedRun('window-aug-04-b', '2026-08-04', 4.004, {
    health_source_workout_id: 'window-aug-04-provider-b',
    duration_seconds: 2660,
  }),
  datedRun('window-jul-25', '2026-07-25', 5),
  datedRun('window-jul-24', '2026-07-24', 6),
  datedRun('window-jul-04', '2026-07-04', 7),
  datedRun('window-jul-03', '2026-07-03', 8),
  datedRun('window-jun-20', '2026-06-20', 9),
  datedRun('window-jun-19', '2026-06-19', 10),
];
const canonicalWindows = summarizeCanonicalActivityWindows(windowRows, { planningDateISO: '2026-08-14' });
assert.deepEqual(canonicalWindows.windows, {
  7: { activity_count: 2, distance_miles: 3, duration_seconds: 1800 },
  14: { activity_count: 4, distance_miles: 10.004, duration_seconds: 6000 },
  21: { activity_count: 5, distance_miles: 15.004, duration_seconds: 9000 },
  28: { activity_count: 6, distance_miles: 21.004, duration_seconds: 12600 },
  42: { activity_count: 7, distance_miles: 28.004, duration_seconds: 16800 },
  56: { activity_count: 9, distance_miles: 45.004, duration_seconds: 27000 },
});
assert.deepEqual(
  summarizeCanonicalActivityWindows([...windowRows].reverse(), { planningDateISO: '2026-08-14' }).windows,
  canonicalWindows.windows,
  'canonical rolling windows are deterministic regardless of raw row order',
);
assert.equal(canonicalWindows.raw_row_count, 11);
assert.equal(canonicalWindows.canonical_row_count, 10);

function providerCoverage(status, overrides = {}) {
  return classifyProviderCoverage({
    source_system: 'apple_health',
    status,
    modalities: ['running'],
    coverage_start_local: '2026-06-20',
    coverage_end_local: '2026-08-14',
    expected_start_local: '2026-06-20',
    expected_end_local: '2026-08-14',
    ...overrides,
  });
}

const syncCases = [
  ['complete', 'COMPLETE', 'VALID_ZERO'],
  ['partial', 'PARTIAL', 'UNKNOWN'],
  ['failed', 'FAILED', 'UNKNOWN'],
  ['stale', 'STALE', 'STALE'],
  ['missing', 'MISSING', 'MISSING'],
  ['unknown', 'UNKNOWN', 'UNKNOWN'],
];
for (const [input, expectedSyncState, expectedValueState] of syncCases) {
  const classified = providerCoverage(input);
  assert.equal(classified.sync_state, expectedSyncState, `${input} sync remains distinct`);
  assert.equal(valueStateForEmptyCoverage([classified]), expectedValueState, `${input} sync cannot become complete zero`);
  const snapshot = buildEvidenceSnapshot({
    athleteId: ATHLETE_ID,
    planningInstant: '2026-08-14T12:00:00.000Z',
    timezone: 'America/New_York',
    runs: [],
    providerCoverage: [classified],
  });
  assert.equal(snapshot.activity_summary.sync_state, expectedValueState === 'VALID_ZERO' ? 'VALID_ZERO' : expectedSyncState);
  assert.equal(snapshot.activity_summary.value_state, expectedValueState);
  assert.equal(snapshot.activity_summary.value, expectedValueState === 'VALID_ZERO' ? 0 : null);
}
const deniedZero = providerCoverage('complete', { affirmative_complete: false });
assert.notEqual(deniedZero.sync_state, 'COMPLETE');
assert.notEqual(valueStateForEmptyCoverage([deniedZero]), 'VALID_ZERO');

const normalizedSyncMetrics = normalizeTrainingMetrics({
  workout_sync_state: 'complete',
  workout_sync_coverage_start_local: '2026-06-20',
  workout_sync_coverage_end_local: '2026-08-14',
  workout_sync_observed_at: '2026-08-14T11:59:00.000Z',
  workout_sync_affirmative_complete: true,
});
assert.equal(normalizedSyncMetrics.error, undefined);
assert.deepEqual(parseTrainingMetrics(normalizedSyncMetrics.metrics), normalizedSyncMetrics.metrics);
const storedCompleteCoverage = providerCoverageFromHealthRow({
  training_metrics_json: JSON.stringify(normalizedSyncMetrics.metrics),
  synced_at: '2026-08-14T11:59:00.000Z',
}, {
  planningInstant: '2026-08-14T12:00:00.000Z',
  expectedStartLocal: '2026-06-20',
  expectedEndLocal: '2026-08-14',
});
assert.equal(storedCompleteCoverage.sync_state, 'COMPLETE');
assert.equal(storedCompleteCoverage.complete, true);
const staleStoredCoverage = providerCoverageFromHealthRow({
  training_metrics_json: JSON.stringify({
    ...normalizedSyncMetrics.metrics,
    workout_sync_observed_at: '2026-08-11T11:59:00.000Z',
  }),
  synced_at: '2026-08-11T11:59:00.000Z',
}, {
  planningInstant: '2026-08-14T12:00:00.000Z',
  expectedStartLocal: '2026-06-20',
  expectedEndLocal: '2026-08-14',
});
assert.equal(staleStoredCoverage.sync_state, 'STALE');
assert.equal(valueStateForEmptyCoverage([staleStoredCoverage]), 'STALE');
assert.equal(providerCoverageFromHealthRow(null, {
  planningInstant: '2026-08-14T12:00:00.000Z',
  expectedStartLocal: '2026-06-20',
  expectedEndLocal: '2026-08-14',
}).sync_state, 'MISSING');
assert.equal(providerCoverageFromHealthRow({ synced_at: '2026-08-14T11:59:00.000Z' }, {
  planningInstant: '2026-08-14T12:00:00.000Z',
  expectedStartLocal: '2026-06-20',
  expectedEndLocal: '2026-08-14',
}).sync_state, 'UNKNOWN', 'legacy rows remain explicitly unknown');

const planningBaseline = concurrentPlan.estimateWeeklyMileageBaseline(windowRows, {
  planningDateISO: '2026-08-14',
  profileWeeklyMiles: 10,
  syncState: 'COMPLETE',
});
assert.equal(planningBaseline.rawRunCount, 11);
assert.equal(planningBaseline.meaningfulRunCount, 10);
assert.deepEqual(planningBaseline.windows, canonicalWindows.windows);
assert.equal(planningBaseline.identityReceipts[0].reason_code, 'ACTIVITY_IDENTITY_FUZZY_COLLISION');
assert.equal(planningBaseline.syncState, 'COMPLETE');
assert.equal(planningBaseline.confidence, 'HIGH');
const incompleteBaselineStates = ['PARTIAL', 'FAILED', 'STALE', 'MISSING', 'UNKNOWN'];
for (const syncState of incompleteBaselineStates) {
  const baseline = concurrentPlan.estimateWeeklyMileageBaseline([], {
    planningDateISO: '2026-08-14',
    profileWeeklyMiles: 10,
    syncState,
  });
  assert.equal(baseline.weeklyMiles, 10, `${syncState} retains the legacy profile fallback value`);
  assert.equal(baseline.status, 'UNKNOWN', `${syncState} profile fallback is not complete recent-normal evidence`);
  assert.equal(baseline.confidence, 'INSUFFICIENT');
  assert.equal(baseline.completeZero, false);
}
const validZeroBaseline = concurrentPlan.estimateWeeklyMileageBaseline([], {
  planningDateISO: '2026-08-14',
  profileWeeklyMiles: 10,
  syncState: 'VALID_ZERO',
});
assert.equal(validZeroBaseline.weeklyMiles, 0);
assert.equal(validZeroBaseline.status, 'VALID_ZERO');
assert.equal(validZeroBaseline.completeZero, true);

function createImportHarness() {
  const claims = new Map();
  const runs = new Map();
  const claimKey = (userId, sourceKey) => `${userId}:${sourceKey}`;
  return {
    runs,
    transaction: async (callback) => callback({
      async run(sql, params) {
        if (sql.includes('INSERT INTO activity_import_claims')) {
          const [userId, sourceKey, claimToken] = params;
          const key = claimKey(userId, sourceKey);
          if (!claims.has(key)) claims.set(key, {
            user_id: userId,
            source_key: sourceKey,
            claim_token: claimToken,
            activity_kind: null,
            activity_id: null,
          });
          return { changes: 1 };
        }
        if (sql.includes('SET activity_kind=?')) {
          const [activityKindName, activityId, userId, sourceKey, claimToken] = params;
          const claim = claims.get(claimKey(userId, sourceKey));
          if (!claim || claim.claim_token !== claimToken) return { changes: 0 };
          claim.activity_kind = activityKindName;
          claim.activity_id = activityId;
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO runs')) {
          runs.set(params[0], {
            id: params[0],
            user_id: params[1],
            date: params[2],
            type: params[3],
            distance_miles: params[4],
            duration_seconds: params[5],
            perceived_effort: params[6],
            notes: params[7],
            watch_mode: params[13],
            watch_activity_type: params[14],
            watch_normalized_type: params[15],
            health_source: params[16],
            health_source_workout_id: params[17],
            health_start_at: params[18],
            health_end_at: params[19],
            workout_metrics_json: params[29],
            workout_metric_streams_json: params[30],
            plan_session_id: params[31],
            planned_session_json: params[32],
            created_at: '2026-08-04T14:00:00.000Z',
          });
          return { changes: 1 };
        }
        if (sql.includes('UPDATE runs SET')) return { changes: 1 };
        throw new Error(`Unexpected import write: ${sql}`);
      },
      async get(sql, params) {
        if (sql.includes('FROM activity_import_claims')) return claims.get(claimKey(params[0], params[1])) || null;
        if (sql.includes('FROM run_import_tombstones')) return null;
        if (sql.includes('FROM runs') && sql.includes('health_source=?')) {
          return [...runs.values()].find((run) => (
            run.user_id === params[0]
            && run.health_source === params[1]
            && run.health_source_workout_id === params[2]
          )) || null;
        }
        if (sql.includes('FROM runs') && sql.includes('WHERE id=? AND user_id=?')) {
          const run = runs.get(params[0]);
          return run?.user_id === params[1] ? run : null;
        }
        if (sql.includes('FROM user_plans') || sql.includes('FROM training_plans')) return null;
        throw new Error(`Unexpected import read: ${sql}`);
      },
      async all(sql, params) {
        if (sql.includes("health_source='forged_hybrid'")) return [];
        if (sql.includes('FROM runs')) {
          return [...runs.values()].filter((run) => (
            run.user_id === params[0]
            && run.date === params[1]
            && Math.abs(run.distance_miles - params[2]) < 0.05
          ));
        }
        throw new Error(`Unexpected import list: ${sql}`);
      },
    }),
  };
}

async function verifyIngestionIdentity() {
  const harness = createImportHarness();
  const options = { transaction: harness.transaction, updateRunPrs: async () => {} };
  const raw = {
    source: 'apple_health',
    sourceWorkoutId: 'ingest-provider-a',
    type: 'running',
    startDate: '2026-08-04T12:36:59.000Z',
    endDate: '2026-08-04T13:15:54.000Z',
    distanceMiles: 4.004,
    durationSeconds: 2335,
  };
  const first = await importTest.importRows(ATHLETE_ID, [raw], options);
  assert.equal(first.imported, 1);
  const exact = await importTest.importRows(ATHLETE_ID, [raw], options);
  assert.equal(exact.skipped, 1);
  assert.equal(exact.identity_receipts[0].reason_code, 'ACTIVITY_IDENTITY_EXACT_DUPLICATE');
  const fuzzyRaw = {
    ...raw,
    sourceWorkoutId: 'ingest-provider-b',
    distanceMiles: 4.003,
    durationSeconds: 2595,
  };
  const fuzzy = await importTest.importRows(ATHLETE_ID, [fuzzyRaw], options);
  assert.equal(fuzzy.skipped, 1);
  assert.equal(fuzzy.identity_receipts[0].reason_code, 'ACTIVITY_IDENTITY_FUZZY_COLLISION');
  assert.equal(harness.runs.size, 1, 'new fuzzy collision keeps one counted ingestion row');
  const fuzzyReplay = await importTest.importRows(ATHLETE_ID, [fuzzyRaw], options);
  assert.equal(fuzzyReplay.skipped, 1);
  assert.equal(
    fuzzyReplay.identity_receipts[0].reason_code,
    'ACTIVITY_IDENTITY_FUZZY_COLLISION',
    'a claimed changed-ID alias remains fuzzy on replay',
  );
  const distinct = await importTest.importRows(ATHLETE_ID, [{
    ...raw,
    sourceWorkoutId: 'ingest-provider-distinct',
    distanceMiles: 4.5,
    durationSeconds: 2595,
  }], options);
  assert.equal(distinct.imported, 1);
  assert.equal(harness.runs.size, 2, 'nearby legitimate ingestion remains distinct');
}

verifyIngestionIdentity().then(() => {
  console.log('ACTIVITY IDENTITY C2 SMOKE OK (69)');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
