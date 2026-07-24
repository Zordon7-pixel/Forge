const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chooseForgedRunMatch,
  distanceTolerance,
  durationTolerance,
  isTrustedSensorSummarySource,
  sensorSummarySourcePriority,
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
  assert.equal(isTrustedSensorSummarySource('apple_health'), true, 'Apple Health is a trusted sensor summary');
  assert.equal(isTrustedSensorSummarySource('imported'), false, 'generic imports cannot claim summary authority');
  assert.ok(
    sensorSummarySourcePriority('apple_health') > sensorSummarySourcePriority('strava'),
    'Apple Health remains the canonical summary when a lower-priority Strava copy arrives later'
  );

  assert.equal(
    chooseForgedRunMatch([forgedCandidate({ health_source: 'apple_health' })], incomingRun()),
    null,
    'an imported row can never masquerade as the Forged route owner'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({
        health_source: 'apple_health',
        workout_metrics_json: JSON.stringify({
          forged_recording_id: 'forged-run',
          route_source: 'forged_phone',
        }),
      }),
    ], incomingRun())?.id,
    'forged-run',
    'a previously merged row retains Forged recording provenance for later syncs'
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
  assert.match(importSource, /calories_burned = CASE WHEN \?=1 THEN \? ELSE calories_burned END/, 'watch calories replace the phone estimate');
  assert.match(importSource, /calories_watch = CASE WHEN \?=1 THEN \? ELSE calories_watch END/, 'watch calories are retained with sensor provenance');
  assert.match(importSource, /ai_feedback = CASE WHEN \?=1 THEN NULL ELSE ai_feedback END/, 'stale AI feedback is cleared when the summary changes');
  assert.match(importSource, /route_source: 'forged_phone'/, 'Forged route provenance is retained');
  assert.match(importSource, /FOR UPDATE/, 'matching runs are row-locked during import consolidation');
  assert.doesNotMatch(
    importSource,
    /DELETE FROM plan_adjustment_proposals/,
    'plan adjustment decisions are never deleted during consolidation'
  );
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
    avg_heart_rate: null,
    max_heart_rate: null,
    heart_rate_zones: null,
    cadence_spm: null,
    elevation_gain: 72,
    elevation_loss: 70,
    vo2_max: null,
    training_effect_aerobic: null,
    training_effect_anaerobic: null,
    recovery_time_hours: null,
    temperature_f: null,
    calories: 439,
    calories_burned: 439,
    calories_watch: null,
    shoe_id: null,
    plan_session_id: null,
    planned_session_json: '{}',
    workout_metrics_json: JSON.stringify({ route_status: 'complete' }),
    ai_feedback: 'Stale phone-summary feedback',
    ai_feedback_requested_at: '2026-07-24T13:00:00.000Z',
  });
  const importedRun = {
    id: 'apple-run',
    date: '2026-07-24',
    type: 'easy',
    duration_seconds: 1755,
    health_start_at: '2026-07-24T12:00:20.000Z',
    health_source: 'apple_health',
    distance_miles: 3.11,
    perceived_effort: null,
    pain_level: null,
    post_energy: null,
    notes: 'Imported workout',
    shoe_id: null,
    plan_session_id: null,
    planned_session_json: '{}',
    workout_metrics_json: '{}',
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
  for (const statement of statements) {
    assert.equal(
      (statement.sql.match(/\?/g) || []).length,
      statement.params.length,
      `SQL bind count matches for ${statement.sql.trim().split(/\s+/).slice(0, 4).join(' ')}`
    );
  }
  const summaryUpdate = statements.find((statement) => statement.sql.includes('distance_miles = COALESCE'));
  assert.equal(summaryUpdate.params[0], 3.11, 'Apple Health distance becomes canonical');
  assert.equal(summaryUpdate.params[1], 1755, 'Apple Health duration becomes canonical');
  assert.equal(summaryUpdate.params[3], null, 'the user-rated Forged effort is never overwritten');
  assert.equal(summaryUpdate.params[17], '[]', 'the Apple import cannot replace an existing Forged route');
  assert.equal(summaryUpdate.params[24], 362, 'Apple Health calories become canonical');
  assert.equal(summaryUpdate.params[28], 362, 'the stale phone calorie estimate is replaced');
  assert.equal(summaryUpdate.params[30], 362, 'watch calories are stored explicitly');
  assert.equal(summaryUpdate.params[34], 1, 'AI feedback invalidation is enabled');
  assert.equal(summaryUpdate.params[35], 1, 'an in-flight AI feedback request is also invalidated');
  const metrics = JSON.parse(summaryUpdate.params[31]);
  assert.equal(metrics.route_source, 'forged_phone', 'the retained route records Forged provenance');
  assert.equal(metrics.summary_source, 'apple_health', 'the watch summary records Apple Health provenance');
  assert.ok(
    statements.some((statement) => statement.sql === 'DELETE FROM runs WHERE id=? AND user_id=?'
      && statement.params[0] === 'apple-run'
      && statement.params[1] === 'athlete-1'),
    'the redundant Apple row is removed in the same transaction'
  );

  const transferable = importTest.analyzeRunConsolidation(
    forgedCandidate({
      perceived_effort: null,
      pain_level: null,
      post_energy: null,
      notes: null,
      shoe_id: null,
      plan_session_id: null,
      planned_session_json: '{}',
    }),
    {
      ...importedRun,
      perceived_effort: 7,
      pain_level: 'mild',
      post_energy: 'medium',
      notes: 'Windy finish',
      shoe_id: 'shoe-1',
      plan_session_id: 'session-1',
      planned_session_json: JSON.stringify({ sessionId: 'session-1', title: 'Recovery Run' }),
    },
    item
  );
  assert.deepEqual(transferable.conflicts, [], 'non-conflicting user data can move to the canonical row');
  assert.equal(transferable.patch.notes, 'Windy finish', 'a user note is preserved');
  assert.equal(transferable.patch.perceivedEffort, 7, 'a user effort is preserved');
  assert.equal(transferable.patch.shoeId, 'shoe-1', 'a shoe link is preserved');
  assert.equal(transferable.patch.planSessionId, 'session-1', 'a plan link is preserved');

  const conflicting = importTest.analyzeRunConsolidation(
    forgedCandidate({
      perceived_effort: 8,
      notes: 'Strong finish',
      plan_session_id: 'session-a',
      planned_session_json: JSON.stringify({ sessionId: 'session-a', title: 'Tempo' }),
    }),
    {
      ...importedRun,
      perceived_effort: 6,
      notes: 'Felt rough',
      plan_session_id: 'session-b',
      planned_session_json: JSON.stringify({ sessionId: 'session-b', title: 'Easy' }),
    },
    item
  );
  assert.ok(conflicting.conflicts.includes('effort'), 'conflicting effort prevents destructive consolidation');
  assert.ok(conflicting.conflicts.includes('notes'), 'conflicting notes prevent destructive consolidation');
  assert.ok(conflicting.conflicts.includes('plan link'), 'conflicting plan links prevent destructive consolidation');

  const lowerPriorityStatements = [];
  const appleCanonical = {
    ...canonicalRun,
    health_source: 'apple_health',
    distance_miles: 3.11,
    duration_seconds: 1755,
    workout_metrics_json: JSON.stringify({
      forged_recording_id: 'forged-run',
      route_source: 'forged_phone',
      summary_source: 'apple_health',
      route_status: 'complete',
    }),
  };
  const stravaItem = importTest.normalizeRow({
    source: 'strava',
    sourceWorkoutId: 'strava-activity-id',
    type: 'running',
    startDate: '2026-07-24T12:00:20.000Z',
    endDate: '2026-07-24T12:29:35.000Z',
    distanceMiles: 3.2,
    durationSeconds: 1700,
    avgHeartRate: 160,
    calories: 400,
  });
  await importTest.updateExistingRunHealth({
    async get() { return null; },
    async run(sql, params) {
      lowerPriorityStatements.push({ sql, params });
      return { changes: 1 };
    },
  }, 'athlete-1', appleCanonical, stravaItem);
  const lowerPriorityUpdate = lowerPriorityStatements[0];
  assert.equal(lowerPriorityUpdate.params[0], null, 'lower-priority Strava distance cannot replace Apple Health');
  assert.equal(lowerPriorityUpdate.params[1], null, 'lower-priority Strava duration cannot replace Apple Health');
  assert.equal(lowerPriorityUpdate.params[4], null, 'lower-priority Strava heart rate cannot replace Apple Health');
  assert.equal(JSON.parse(lowerPriorityUpdate.params[31]).summary_source, 'apple_health', 'summary provenance remains Apple Health');

  let proposalLookup = 0;
  const conflictStatements = [];
  const proposalConflictDb = {
    async all(sql) {
      if (sql.includes("health_source='forged_hybrid'")) return [canonicalRun];
      throw new Error(`Unexpected all query: ${sql}`);
    },
    async get(sql) {
      if (sql.includes('activity_likes')) return { interaction_count: 0 };
      if (sql.includes('plan_adjustment_proposals')) {
        proposalLookup += 1;
        return { id: proposalLookup === 1 ? 'canonical-proposal' : 'duplicate-proposal' };
      }
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async run(sql, params) {
      conflictStatements.push({ sql, params });
      return { changes: 1 };
    },
  };
  const proposalConflictResult = await importTest.consolidateImportedRunIntoForged(
    proposalConflictDb,
    'athlete-1',
    importedRun,
    item
  );
  assert.equal(proposalConflictResult, null, 'two plan adjustment decisions prevent consolidation');
  assert.equal(conflictStatements.length, 0, 'proposal conflicts leave both runs untouched');

  console.log('CANONICAL RUN MERGE SMOKE OK');
}

if (require.main === module) {
  runCanonicalRunMergeSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runCanonicalRunMergeSmoke };
