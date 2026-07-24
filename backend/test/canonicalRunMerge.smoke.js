const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chooseForgedRunMatch,
  distanceTolerance,
  durationTolerance,
} = require('../src/lib/canonicalRunMatch');
const { _test: importTest } = require('../src/routes/import');

function forgedCandidate(overrides = {}) {
  return {
    id: 'forged-run',
    health_source: 'forged_hybrid',
    health_start_at: '2026-07-24T12:00:00.000Z',
    duration_seconds: 1774,
    distance_miles: 3.19,
    ...overrides,
  };
}

function incomingRun(overrides = {}) {
  return {
    startDate: '2026-07-24T12:00:20.000Z',
    durationSeconds: 1755,
    distanceMiles: 3.11,
    ...overrides,
  };
}

async function runCanonicalRunMergeSmoke() {
  const screenshotMatch = chooseForgedRunMatch([forgedCandidate()], incomingRun());
  assert.equal(screenshotMatch?.id, 'forged-run', 'the reported 3.19/3.11 mile duplicate resolves to the Forged recording');
  assert.equal(distanceTolerance(3.11), 0.1555, 'distance tolerance is 5% for a 3.11 mile run');
  assert.equal(durationTolerance(1755), 90, 'short-run duration tolerance stays bounded at 90 seconds');

  assert.equal(
    chooseForgedRunMatch([forgedCandidate({ health_source: 'apple_health' })], incomingRun()),
    null,
    'an imported row can never masquerade as the Forged route owner'
  );
  assert.equal(
    chooseForgedRunMatch([forgedCandidate({ health_start_at: '2026-07-24T12:06:00.000Z' })], incomingRun()),
    null,
    'start times outside five minutes do not merge'
  );
  assert.equal(
    chooseForgedRunMatch([forgedCandidate({ duration_seconds: 1950 })], incomingRun()),
    null,
    'materially different durations do not merge'
  );
  assert.equal(
    chooseForgedRunMatch([forgedCandidate({ distance_miles: 3.4 })], incomingRun()),
    null,
    'materially different distances do not merge'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({ id: 'candidate-a' }),
      forgedCandidate({ id: 'candidate-b', health_start_at: '2026-07-24T12:00:25.000Z' }),
    ], incomingRun()),
    null,
    'ambiguous candidates remain separate instead of guessing'
  );

  const importSource = fs.readFileSync(
    path.join(__dirname, '../src/routes/import.js'),
    'utf8'
  );
  assert.match(importSource, /distance_miles = COALESCE\(\?, distance_miles\)/, 'watch distance replaces the phone summary');
  assert.match(importSource, /duration_seconds = COALESCE\(\?, duration_seconds\)/, 'watch duration replaces the phone summary');
  assert.match(importSource, /route_source: 'forged_phone'/, 'Forged route provenance is retained');
  assert.match(
    importSource,
    /DELETE FROM runs WHERE id=\? AND user_id=\?/,
    'the redundant imported row is deleted with owner scope'
  );
  assert.match(
    importSource,
    /UPDATE activity_import_claims[\s\S]*activity_id=\? AND user_id=\?/,
    'durable import claims are repointed to the canonical run'
  );
  assert.match(
    importSource,
    /UPDATE personal_records SET run_id=\? WHERE run_id=\? AND user_id=\?/,
    'run-linked personal records follow the canonical run'
  );

  const statements = [];
  const canonicalRun = forgedCandidate({
    route_coords: JSON.stringify([
      { lat: 38.91, lon: -76.95 },
      { lat: 38.92, lon: -76.94 },
    ]),
    perceived_effort: 8,
    pain_level: null,
    post_energy: null,
    notes: null,
    watch_mode: null,
    planned_session_json: '{}',
    workout_metrics_json: JSON.stringify({ route_status: 'complete' }),
  });
  const importedRun = {
    id: 'apple-run',
    health_source: 'apple_health',
  };
  const item = importTest.normalizeRow({
    source: 'apple_health',
    sourceWorkoutId: 'apple-workout-id',
    type: 'running',
    startDate: '2026-07-24T12:00:20.000Z',
    endDate: '2026-07-24T12:29:35.000Z',
    distanceMiles: 3.11,
    durationSeconds: 1755,
    avgHeartRate: 153,
    maxHeartRate: 181,
    calories: 362,
    heart_rate_zones: { z1: 0, z2: 300, z3: 600, z4: 842, z5: 13 },
  });
  const db = {
    async all(sql) {
      if (sql.includes("health_source='forged_hybrid'")) return [canonicalRun];
      throw new Error(`Unexpected all query: ${sql}`);
    },
    async get(sql) {
      if (sql.includes('activity_likes')) return { interaction_count: 0 };
      if (sql.includes('plan_adjustment_proposals')) return null;
      if (sql.includes('FROM user_plans') || sql.includes('FROM training_plans')) return null;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async run(sql, params) {
      statements.push({ sql, params });
      return { changes: 1 };
    },
  };
  const canonicalRunId = await importTest.consolidateImportedRunIntoForged(
    db,
    'athlete-1',
    importedRun,
    item
  );
  assert.equal(canonicalRunId, 'forged-run', 'the Forged recording remains the canonical row');
  const summaryUpdate = statements.find((statement) => statement.sql.includes('UPDATE runs SET'));
  assert.equal(summaryUpdate.params[0], 3.11, 'Apple Health distance becomes canonical');
  assert.equal(summaryUpdate.params[1], 1755, 'Apple Health duration becomes canonical');
  assert.equal(summaryUpdate.params[3], null, 'the user-rated Forged effort is never overwritten');
  assert.equal(summaryUpdate.params[17], '[]', 'the Apple import cannot replace an existing Forged route');
  const metrics = JSON.parse(summaryUpdate.params[25]);
  assert.equal(metrics.route_source, 'forged_phone', 'the retained route records Forged provenance');
  assert.equal(metrics.summary_source, 'apple_health', 'the watch summary records Apple Health provenance');
  assert.ok(
    statements.some((statement) => statement.sql === 'DELETE FROM runs WHERE id=? AND user_id=?'
      && statement.params[0] === 'apple-run'
      && statement.params[1] === 'athlete-1'),
    'the redundant Apple row is removed in the same transaction'
  );

  console.log('CANONICAL RUN MERGE SMOKE OK (22)');
}

if (require.main === module) {
  runCanonicalRunMergeSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runCanonicalRunMergeSmoke };
