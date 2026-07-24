const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORGED_TRUSTED_SENSOR_ACTIVITY_WINDOW_MS,
  FORGED_TRUSTED_SENSOR_SYNC_WINDOW_MS,
  chooseForgedRunMatch,
  distanceTolerance,
  durationTolerance,
  isTrustedSensorSummarySource,
  sensorSummarySourcePriority,
} = require('../src/lib/canonicalRunMatch');
const { _test: importTest } = require('../src/routes/import');

const PRODUCTION_PAIR = Object.freeze({
  forgedCreatedAt: '2026-07-24T14:45:13.089Z',
  forgedDistanceMiles: 3.191156,
  forgedDurationSeconds: 1774,
  appleCreatedAt: '2026-07-24T14:55:17.613Z',
  appleDistanceMiles: 3.109,
  appleDurationSeconds: 1755,
  appleAvgHeartRate: 158,
});

function forgedCandidate(overrides = {}) {
  return {
    id: 'forged-run',
    health_source: 'forged_hybrid',
    health_start_at: null,
    created_at: PRODUCTION_PAIR.forgedCreatedAt,
    duration_seconds: PRODUCTION_PAIR.forgedDurationSeconds,
    distance_miles: PRODUCTION_PAIR.forgedDistanceMiles,
    ...overrides,
  };
}

function incomingRun(overrides = {}) {
  return {
    source: 'apple_health',
    startDate: null,
    createdAt: PRODUCTION_PAIR.appleCreatedAt,
    durationSeconds: PRODUCTION_PAIR.appleDurationSeconds,
    distanceMiles: PRODUCTION_PAIR.appleDistanceMiles,
    ...overrides,
  };
}

async function runCanonicalRunMergeSmoke() {
  const productionMatch = chooseForgedRunMatch([forgedCandidate()], incomingRun());
  assert.equal(productionMatch?.id, 'forged-run', 'the exact production 3.191156/3.109 mile pair resolves to the Forged recording');
  assert.equal(FORGED_TRUSTED_SENSOR_ACTIVITY_WINDOW_MS, 5 * 60 * 1000, 'reliable activity starts use the tight five-minute window');
  assert.equal(FORGED_TRUSTED_SENSOR_SYNC_WINDOW_MS, 15 * 60 * 1000, 'the cross-source sync-latency window is exactly 15 minutes');
  assert.equal(distanceTolerance(3.109), 0.15545, 'distance tolerance remains 5% for the production Apple distance');
  assert.equal(durationTolerance(1755), 90, 'short-run duration tolerance stays bounded at 90 seconds');
  assert.equal(isTrustedSensorSummarySource('apple_health'), true, 'Apple Health is a trusted sensor summary');
  assert.equal(isTrustedSensorSummarySource('imported'), false, 'generic imports cannot claim summary authority');
  assert.ok(
    sensorSummarySourcePriority('apple_health') > sensorSummarySourcePriority('strava'),
    'Apple Health remains the canonical summary when a lower-priority Strava copy arrives later'
  );

  assert.equal(
    chooseForgedRunMatch([forgedCandidate()], incomingRun({ source: 'manual_json' })),
    null,
    'the wider window is unavailable to untrusted or manual imports'
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
    chooseForgedRunMatch([forgedCandidate({ created_at: '2026-07-24T14:40:17.612Z' })], incomingRun()),
    null,
    'start times even one millisecond outside 15 minutes do not merge'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({
        created_at: '2026-07-24T14:50:00.000Z',
        duration_seconds: 2500,
        distance_miles: 4.25,
      }),
    ], incomingRun()),
    null,
    'two dissimilar legitimate runs inside 15 minutes remain separate'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({
        health_start_at: '2026-07-24T10:00:00.000Z',
        created_at: PRODUCTION_PAIR.forgedCreatedAt,
      }),
    ], incomingRun({
      startDate: '2026-07-24T10:00:10.000Z',
      createdAt: PRODUCTION_PAIR.appleCreatedAt,
    }))?.id,
    'forged-run',
    'actual activity starts remain authoritative over import-created timestamps'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({
        health_start_at: '2026-07-24T10:00:00.000Z',
        created_at: PRODUCTION_PAIR.forgedCreatedAt,
      }),
    ], incomingRun({
      startDate: '2026-07-24T10:06:00.000Z',
      createdAt: '2026-07-24T14:45:20.000Z',
    })),
    null,
    'reliable activity starts six minutes apart never use the wider delivery-time fallback'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({
        health_start_at: '2026-07-24T10:00:00.000Z',
        created_at: PRODUCTION_PAIR.forgedCreatedAt,
      }),
    ], incomingRun({
      startDate: null,
      createdAt: '2026-07-24T14:45:20.000Z',
    })),
    null,
    'mixed actual-start and delivery-time evidence is never compared'
  );
  assert.equal(
    chooseForgedRunMatch([
      forgedCandidate({ health_start_at: '2026-07-24T10:00:00.000Z' }),
    ], incomingRun({ startDate: '2026-07-24T10:20:00.000Z' })),
    null,
    'close created timestamps cannot override materially different actual starts'
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
      forgedCandidate({ id: 'candidate-b', created_at: '2026-07-24T14:45:18.089Z' }),
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
  assert.match(importSource, /calories_burned = CASE \? WHEN 1 THEN \? WHEN 2 THEN NULL ELSE calories_burned END/, 'watch calories replace or explicitly clear the phone estimate');
  assert.match(importSource, /calories_watch = CASE \? WHEN 1 THEN \? WHEN 2 THEN NULL ELSE calories_watch END/, 'watch calories are retained with sensor provenance');
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
  assert.match(
    importSource,
    /CASE WHEN EXISTS \(\s*SELECT 1\s*FROM runs\s*WHERE id=\? AND user_id=\?/,
    'the interaction safety gate first verifies the duplicate belongs to the importing user'
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
    duration_seconds: PRODUCTION_PAIR.appleDurationSeconds,
    health_start_at: null,
    created_at: PRODUCTION_PAIR.appleCreatedAt,
    health_source: 'apple_health',
    distance_miles: PRODUCTION_PAIR.appleDistanceMiles,
    route_coords: JSON.stringify([
      { lat: 38.91, lon: -76.95 },
      { lat: 38.921, lon: -76.939 },
    ]),
    avg_heart_rate: PRODUCTION_PAIR.appleAvgHeartRate,
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
    date: '2026-07-24',
    createdAt: PRODUCTION_PAIR.appleCreatedAt,
    endDate: '2026-07-24T15:24:32.613Z',
    distanceMiles: PRODUCTION_PAIR.appleDistanceMiles,
    durationSeconds: PRODUCTION_PAIR.appleDurationSeconds,
    avgHeartRate: PRODUCTION_PAIR.appleAvgHeartRate,
    maxHeartRate: 181,
    calories: 362,
    heart_rate_zones: { z1: 0, z2: 300, z3: 600, z4: 842, z5: 13 },
    routeCoords: [
      { lat: 38.91, lon: -76.95 },
      { lat: 38.921, lon: -76.939 },
    ],
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
  assert.equal(summaryUpdate.params[0], PRODUCTION_PAIR.appleDistanceMiles, 'Apple Health distance becomes canonical');
  assert.equal(summaryUpdate.params[1], PRODUCTION_PAIR.appleDurationSeconds, 'Apple Health duration becomes canonical');
  assert.equal(summaryUpdate.params[3], null, 'the user-rated Forged effort is never overwritten');
  assert.equal(summaryUpdate.params[4], PRODUCTION_PAIR.appleAvgHeartRate, 'Apple Health heart rate enriches the surviving row');
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

  const runHealthUpdate = async (existing, incoming) => {
    const updates = [];
    await importTest.updateExistingRunHealth({
      async get() { return null; },
      async run(sql, params) {
        updates.push({ sql, params });
        return { changes: 1 };
      },
    }, 'athlete-1', existing, incoming);
    assert.equal(updates.length, 1, 'the health enrichment issues exactly one run update');
    return updates[0];
  };
  const repeatedAppleCanonical = {
    ...canonicalRun,
    distance_miles: item.distanceMiles,
    duration_seconds: item.durationSeconds,
    avg_heart_rate: item.avgHeartRate,
    max_heart_rate: item.maxHeartRate,
    heart_rate_zones: JSON.stringify(item.zoneSeconds),
    health_source: item.source,
    health_source_workout_id: item.sourceWorkoutId,
    health_start_at: item.startDate,
    health_end_at: item.endDate,
    watch_activity_type: 'running',
    watch_normalized_type: item.runType,
    calories: 362,
    calories_burned: 362,
    calories_watch: 362,
    workout_metrics_json: JSON.stringify(metrics),
    ai_feedback: 'Current Apple-summary feedback',
    ai_feedback_requested_at: '2026-07-24T15:30:00.000Z',
  };
  const identicalRepeat = await runHealthUpdate(repeatedAppleCanonical, item);
  assert.equal(identicalRepeat.params[23], 1, 'a repeated Apple payload with calories keeps explicit sensor authority');
  assert.equal(identicalRepeat.params[24], 362, 'the repeated Apple calorie value remains available');
  assert.equal(identicalRepeat.params[34], 0, 'an identical Apple retry preserves existing AI feedback');
  assert.equal(identicalRepeat.params[35], 0, 'an identical Apple retry preserves the feedback request marker');

  const appleWithoutCalories = importTest.normalizeRow({
    ...item.raw,
    calories: undefined,
  });
  const omittedCaloriesRepeat = await runHealthUpdate(repeatedAppleCanonical, appleWithoutCalories);
  assert.equal(omittedCaloriesRepeat.params[23], 0, 'a same-source Apple retry that omits calories preserves stored sensor calories');
  assert.equal(omittedCaloriesRepeat.params[34], 0, 'omitted optional calories alone do not invalidate AI feedback');

  const changedAppleItem = importTest.normalizeRow({
    ...item.raw,
    avgHeartRate: PRODUCTION_PAIR.appleAvgHeartRate + 1,
  });
  const materiallyChangedRepeat = await runHealthUpdate(repeatedAppleCanonical, changedAppleItem);
  assert.equal(materiallyChangedRepeat.params[34], 1, 'a material sensor-summary change invalidates stale AI feedback');
  assert.equal(materiallyChangedRepeat.params[35], 1, 'a material sensor-summary change invalidates an in-flight feedback request');

  const firstAppleWithoutCalories = await runHealthUpdate(canonicalRun, appleWithoutCalories);
  assert.equal(firstAppleWithoutCalories.params[23], 2, 'first trusted authority without calories explicitly clears the phone estimate');
  assert.equal(firstAppleWithoutCalories.params[24], null, 'no sensor calories are invented during the authority change');

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

  const mixedPlanConflict = importTest.analyzeRunConsolidation(
    forgedCandidate({
      plan_session_id: 'session-a',
      planned_session_json: JSON.stringify({ sessionId: 'session-a', title: 'Tempo', distanceMiles: 4 }),
    }),
    {
      ...importedRun,
      plan_session_id: null,
      planned_session_json: JSON.stringify({ title: 'Easy', distanceMiles: 3 }),
    },
    item
  );
  assert.ok(
    mixedPlanConflict.conflicts.includes('plan link'),
    'one session ID and a materially different unidentified plan snapshot refuse consolidation'
  );
  const equivalentMixedPlan = importTest.analyzeRunConsolidation(
    forgedCandidate({
      plan_session_id: 'session-a',
      planned_session_json: JSON.stringify({ sessionId: 'session-a', title: 'Tempo', distanceMiles: 4 }),
    }),
    {
      ...importedRun,
      plan_session_id: null,
      planned_session_json: JSON.stringify({ distanceMiles: 4, title: 'Tempo' }),
    },
    item
  );
  assert.equal(
    equivalentMixedPlan.conflicts.includes('plan link'),
    false,
    'semantically equivalent snapshots remain mergeable when only one copy retained its session ID'
  );

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
      distance_source: 'apple_health',
      distance_unit: 'miles',
      route_status: 'complete',
      running_stride_length_m: 1.0,
      metric_sources: { running_stride_length_m: 'apple_health' },
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
    runningPowerWatts: 300,
    runningStrideLengthM: 1.2,
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
  assert.equal(lowerPriorityUpdate.params[4], 160, 'lower-priority Strava can fill heart rate Apple Health did not provide');
  const lowerPriorityMetrics = JSON.parse(lowerPriorityUpdate.params[31]);
  assert.equal(lowerPriorityMetrics.summary_source, 'apple_health', 'summary provenance remains Apple Health');
  assert.equal(lowerPriorityMetrics.running_power_watts, 300, 'lower-priority Strava fills missing JSON-only power');
  assert.equal(lowerPriorityMetrics.running_stride_length_m, 1, 'lower-priority Strava cannot overwrite Apple stride length');
  assert.equal(lowerPriorityMetrics.metric_sources.running_power_watts, 'strava', 'filled JSON metrics retain field-level provenance');
  assert.equal(lowerPriorityMetrics.metric_sources.running_stride_length_m, 'apple_health', 'existing metric provenance remains intact');

  const protectedHeartRateStatements = [];
  await importTest.updateExistingRunHealth({
    async get() { return null; },
    async run(sql, params) {
      protectedHeartRateStatements.push({ sql, params });
      return { changes: 1 };
    },
  }, 'athlete-1', { ...appleCanonical, avg_heart_rate: 149 }, stravaItem);
  assert.equal(
    protectedHeartRateStatements[0].params[4],
    null,
    'lower-priority Strava cannot replace heart rate Apple Health already provided'
  );

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
