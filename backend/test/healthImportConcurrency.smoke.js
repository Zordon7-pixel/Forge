const assert = require('node:assert/strict');
const { _test } = require('../src/routes/import');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createImportHarness() {
  const claims = new Map();
  const runs = new Map();
  const lifts = new Map();
  let runInserts = 0;
  let liftInserts = 0;

  const claimKey = (userId, sourceKey) => `${userId}:${sourceKey}`;
  const transaction = async (callback) => callback({
    async run(sql, params) {
      if (sql.includes('INSERT INTO activity_import_claims')) {
        const [userId, sourceKey, claimToken] = params;
        const key = claimKey(userId, sourceKey);
        const existing = claims.get(key);
        if (existing) {
          if (!existing.activity_id) await existing.finalized.promise;
          return { changes: 0 };
        }
        claims.set(key, {
          user_id: userId,
          source_key: sourceKey,
          claim_token: claimToken,
          activity_kind: null,
          activity_id: null,
          finalized: deferred(),
        });
        return { changes: 1 };
      }
      if (sql.includes('SET activity_kind=?')) {
        const [activityKind, activityId, userId, sourceKey, claimToken] = params;
        const claim = claims.get(claimKey(userId, sourceKey));
        if (!claim || claim.claim_token !== claimToken) return { changes: 0 };
        claim.activity_kind = activityKind;
        claim.activity_id = activityId;
        claim.finalized.resolve();
        return { changes: 1 };
      }
      if (sql.includes('SET claim_token=?')) {
        const [claimToken, userId, sourceKey, priorToken] = params;
        const claim = claims.get(claimKey(userId, sourceKey));
        if (!claim || claim.claim_token !== priorToken) return { changes: 0 };
        claim.claim_token = claimToken;
        claim.activity_kind = null;
        claim.activity_id = null;
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO runs')) {
        runInserts += 1;
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
          route_coords: params[23],
          planned_session_json: params[32],
          workout_metrics_json: params[29],
          workout_metric_streams_json: params[30],
        });
        return { changes: 1 };
      }
      if (sql.includes('UPDATE runs SET')) {
        const run = runs.get(params.at(-2));
        if (run && run.user_id === params.at(-1)) {
          if (params[0] != null) run.distance_miles = params[0];
          if (params[1] != null) run.duration_seconds = params[1];
          if (params[8] != null) run.health_source = params[8];
          if (params[9] != null) run.health_source_workout_id = params[9];
          if (params[10] != null) run.health_start_at = params[10];
        }
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO lifts')) {
        liftInserts += 1;
        lifts.set(params[0], {
          id: params[0],
          user_id: params[1],
          date: params[2],
          workout_duration_seconds: params[7],
        });
        return { changes: 1 };
      }
      throw new Error(`Unexpected run query: ${sql}`);
    },
    async get(sql, params) {
      if (sql.includes('FROM activity_import_claims')) {
        return claims.get(claimKey(params[0], params[1])) || null;
      }
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
      if (sql.includes('FROM lifts') && sql.includes('WHERE id=? AND user_id=?')) {
        const lift = lifts.get(params[0]);
        return lift?.user_id === params[1] ? lift : null;
      }
      if (sql.includes('FROM lifts') && sql.includes('date=?')) {
        return [...lifts.values()].find((lift) => lift.user_id === params[0] && lift.date === params[1]) || null;
      }
      if (sql.includes('FROM user_plans') || sql.includes('FROM training_plans')) return null;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async all(sql, params = []) {
      if (sql.includes('FROM runs') && sql.includes("health_source='forged_hybrid'")) return [];
      if (sql.includes('FROM runs')) {
        return [...runs.values()].filter((run) => run.user_id === params[0] && run.date === params[1]);
      }
      throw new Error(`Unexpected all query: ${sql}`);
    },
  });

  return {
    counts: () => ({ runInserts, liftInserts, claims: claims.size }),
    runs: () => [...runs.values()].map((run) => ({ ...run })),
    transaction,
  };
}

async function runHealthImportConcurrencySmoke() {
  const userId = 'health-import-user';
  const harness = createImportHarness();
  const options = { transaction: harness.transaction, updateRunPrs: async () => {} };
  const run = {
    source: 'apple_health',
    sourceWorkoutId: 'run-uuid-1',
    type: 'running',
    startDate: '2026-07-21T10:00:00.000Z',
    endDate: '2026-07-21T10:30:00.000Z',
    distanceMiles: 3.1,
    durationSeconds: 1800,
    avgHeartRate: 145,
  };
  const lift = {
    source: 'apple_health',
    sourceWorkoutId: 'lift-uuid-1',
    type: 'traditional strength training',
    startDate: '2026-07-21T12:00:00.000Z',
    endDate: '2026-07-21T12:45:00.000Z',
    durationSeconds: 2700,
  };

  const runResults = await Promise.all([
    _test.importRows(userId, [run], options),
    _test.importRows(userId, [run], options),
  ]);
  assert.equal(runResults.reduce((sum, result) => sum + result.imported, 0), 1);
  assert.equal(runResults.reduce((sum, result) => sum + result.skipped, 0), 1);
  assert.equal(harness.counts().runInserts, 1, 'overlapping run retries create one run');
  assert.equal(runResults.flatMap((result) => result.identity_decision_receipt.decisions)
    .some((decision) => decision.reason_code === 'EXACT_SOURCE_ACTIVITY_ID'), true, 'exact concurrent replay emits an identity receipt');

  const reissued = {
    ...run,
    sourceWorkoutId: 'run-uuid-reissued',
    startDate: '2026-07-21T10:01:30.000Z',
    endDate: '2026-07-21T10:31:32.000Z',
    distanceMiles: 3.11,
    durationSeconds: 1802,
  };
  const reissuedResult = await _test.importRows(userId, [reissued], options);
  assert.equal(reissuedResult.imported, 0);
  assert.equal(reissuedResult.skipped, 1);
  assert.equal(harness.counts().runInserts, 1, 'changed provider id with near source metrics reuses the canonical run');
  assert.equal(reissuedResult.identity_decision_receipt.decisions[0].reason_code, 'FUZZY_SOURCE_ACTIVITY_MATCH');
  assert.doesNotMatch(JSON.stringify(reissuedResult.identity_decision_receipt), /health-import-user|run-uuid/i, 'identity receipt contains no owner or provider identifier');
  const originalRun = [...harness.runs()].find((stored) => stored.user_id === userId);
  assert.equal(originalRun.health_source_workout_id, run.sourceWorkoutId, 'fuzzy replay preserves the first immutable provider identity');
  assert.equal(originalRun.health_start_at, run.startDate, 'fuzzy replay preserves the first observed start fact');
  assert.equal(originalRun.distance_miles, run.distanceMiles, 'fuzzy replay does not overwrite the first raw summary');

  const otherOwnerResult = await _test.importRows('health-import-other-user', [run], options);
  assert.equal(otherOwnerResult.imported, 1, 'identity claims and fuzzy matching remain owner scoped');
  assert.equal(harness.counts().runInserts, 2);

  const manualHarness = createImportHarness();
  const manualOptions = { transaction: manualHarness.transaction, updateRunPrs: async () => {} };
  const manualRun = {
    source: 'manual',
    type: 'running',
    date: '2026-07-22',
    distanceMiles: 5,
    durationSeconds: 3000,
  };
  const manualResult = await _test.importRows(userId, [manualRun], manualOptions);
  assert.equal(manualResult.imported, 1);
  const providerCopy = {
    source: 'strava',
    sourceWorkoutId: 'manual-provider-copy-private-id',
    type: 'running',
    startDate: '2026-07-22T17:30:00.000Z',
    endDate: '2026-07-22T18:20:00.000Z',
    distanceMiles: 5.04,
    durationSeconds: 3000,
  };
  const providerResults = await Promise.all([
    _test.importRows(userId, [providerCopy], manualOptions),
    _test.importRows(userId, [providerCopy], manualOptions),
  ]);
  assert.equal(providerResults.reduce((sum, result) => sum + result.skipped, 0), 2);
  assert.equal(manualHarness.counts().runInserts, 1, 'concurrent provider copies reuse the one manual canonical run');
  assert.equal(providerResults.flatMap((result) => result.identity_decision_receipt.decisions)
    .some((decision) => decision.reason_code === 'MANUAL_PROVIDER_SUMMARY_CORROBORATION'), true);
  assert.doesNotMatch(JSON.stringify(providerResults), /health-import-user|manual-provider-copy-private-id/i,
    'manual/provider identity receipts remain owner- and provider-private');
  const retainedManual = manualHarness.runs()[0];
  assert.equal(retainedManual.health_source, 'manual', 'provider reconciliation preserves raw manual source facts');
  assert.equal(retainedManual.health_source_workout_id, null);
  assert.equal(retainedManual.health_start_at, null);
  const otherOwnerManualResult = await _test.importRows('health-import-other-user', [providerCopy], manualOptions);
  assert.equal(otherOwnerManualResult.imported, 1, 'manual/provider fallback remains owner-scoped');
  assert.equal(manualHarness.counts().runInserts, 2);

  const liftResults = await Promise.all([
    _test.importRows(userId, [lift], options),
    _test.importRows(userId, [lift], options),
  ]);
  assert.equal(liftResults.reduce((sum, result) => sum + result.imported, 0), 1);
  assert.equal(liftResults.reduce((sum, result) => sum + result.skipped, 0), 1);
  assert.equal(harness.counts().liftInserts, 1, 'overlapping lift retries create one lift');
  assert.equal(harness.counts().claims, 4, 'each owner-scoped source workout identity has one durable claim');

  const failed = await _test.importRows(userId, [run], {
    transaction: async () => {
      const error = new Error('database unavailable');
      error.code = 'ECONNRESET';
      throw error;
    },
    updateRunPrs: async () => {},
  });
  assert.equal(failed.errors[0].retryable, true, 'operational row failures are explicitly retryable');

  console.log('HEALTH IMPORT CONCURRENCY SMOKE OK (22)');
}

if (require.main === module) {
  runHealthImportConcurrencySmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runHealthImportConcurrencySmoke };
