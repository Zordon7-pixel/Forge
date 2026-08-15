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
          perceived_effort: params[6],
          notes: params[7],
          watch_mode: params[13],
          watch_activity_type: params[14],
          watch_normalized_type: params[15],
          health_source: params[16],
          health_source_workout_id: params[17],
          health_start_at: params[18],
          planned_session_json: params[32],
          workout_metrics_json: params[29],
          workout_metric_streams_json: params[30],
        });
        return { changes: 1 };
      }
      if (sql.includes('UPDATE runs SET')) return { changes: 1 };
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
    async all(sql) {
      if (sql.includes('FROM runs')) return [];
      throw new Error(`Unexpected all query: ${sql}`);
    },
  });

  return {
    counts: () => ({ runInserts, liftInserts, claims: claims.size }),
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

  const liftResults = await Promise.all([
    _test.importRows(userId, [lift], options),
    _test.importRows(userId, [lift], options),
  ]);
  assert.equal(liftResults.reduce((sum, result) => sum + result.imported, 0), 1);
  assert.equal(liftResults.reduce((sum, result) => sum + result.skipped, 0), 1);
  assert.equal(harness.counts().liftInserts, 1, 'overlapping lift retries create one lift');
  assert.equal(harness.counts().claims, 2, 'each source workout has one durable claim');

  const failed = await _test.importRows(userId, [run], {
    transaction: async () => {
      const error = new Error('database unavailable');
      error.code = 'ECONNRESET';
      throw error;
    },
    updateRunPrs: async () => {},
  });
  assert.equal(failed.errors[0].retryable, true, 'operational row failures are explicitly retryable');

  console.log('HEALTH IMPORT CONCURRENCY SMOKE OK (8)');
}

if (require.main === module) {
  runHealthImportConcurrencySmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runHealthImportConcurrencySmoke };
