#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildEvidenceSnapshot,
  canonicalizeRunLoadInput,
  classifyCanonicalActivityIdentity,
} = require('../src/lib/goalBackwardEvidence');
const importTest = require('../src/routes/import')._test;
const { normalizeRow, selectExistingRunIdentityMatch } = importTest;
const { summarizeRecentRunLoad } = require('../src/lib/recentRunLoad');
const concurrentPlan = require('../src/lib/concurrentPlan');
const adaptation = require('../src/lib/adaptationEngine');
const ai = require('../src/services/ai');
const plansRouter = require('../src/routes/plans');

const MILE_M = 1609.344;
const ATHLETE_ID = 'synthetic-athlete-c2';
const PLANNING_INSTANT = '2026-08-17T12:00:00.000Z';
const PLANNING_DATE = '2026-08-17';
const TIMEZONE = 'UTC';

function run(overrides = {}) {
  return {
    id: 'raw-a',
    user_id: ATHLETE_ID,
    date: '2026-08-16',
    type: 'easy',
    distance_miles: 4,
    duration_seconds: 2400,
    health_source: 'apple_health',
    health_source_workout_id: 'provider-a',
    health_start_at: '2026-08-16T10:00:00.000Z',
    created_at: '2026-08-16T11:00:00.000Z',
    workout_metrics_json: '{}',
    ...overrides,
  };
}

function coverage(overrides = {}) {
  return {
    source_system: 'apple_health',
    modalities: ['running'],
    coverage_start_local: '2026-06-23',
    coverage_end_local: PLANNING_DATE,
    expected_start_local: '2026-06-23',
    expected_end_local: PLANNING_DATE,
    quality_state: 'COMPLETE',
    ...overrides,
  };
}

function snapshot(runs, options = {}) {
  return buildEvidenceSnapshot({
    athleteId: ATHLETE_ID,
    planningInstant: PLANNING_INSTANT,
    timezone: TIMEZONE,
    runs,
    providerCoverage: options.providerCoverage ?? [coverage()],
    corrections: options.corrections || [],
  });
}

function correction(id, rawEvidenceRef, revision, value) {
  return {
    id,
    user_id: ATHLETE_ID,
    raw_evidence_kind: 'run',
    raw_evidence_ref: rawEvidenceRef,
    revision,
    corrected_canonical_value_json: { field: 'distance_m', value },
    canonical_unit: 'm',
    reason_code: 'MANUAL_CORRECTION_APPLIED',
    reason: 'Synthetic correction fixture.',
    attributed_by_user_id: ATHLETE_ID,
    created_at: '2026-08-16T12:00:00.000Z',
  };
}

function assertBoundedPrivateReceipt(receipt, forbidden = []) {
  const encoded = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 16 * 1024, 'receipt is bounded to 16 KiB');
  for (const value of forbidden) assert.doesNotMatch(encoded, new RegExp(value), 'receipt excludes raw identity/PII');
  assert.match(receipt.receipt_hash, /^sha256:[a-f0-9]{64}$/);
}

async function runSmoke() {
  {
    const identity = (overrides = {}) => ({
      athlete_id: ATHLETE_ID,
      activity_kind: 'run',
      observed_at: '2026-08-16T10:00:00.000Z',
      duration_s: 2400,
      distance_m: 4 * MILE_M,
      source_system: 'apple_health',
      source_activity_id: 'provider-boundary-a',
      ...overrides,
    });
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_activity_id: 'provider-boundary-b',
      observed_at: '2026-08-16T10:03:00.000Z',
      duration_s: 2402,
      distance_m: 4 * MILE_M + 0.02 * MILE_M,
    })).reason_code, 'FUZZY_SOURCE_ACTIVITY_MATCH', 'fuzzy boundary is inclusive');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_activity_id: 'provider-boundary-b',
      observed_at: '2026-08-16T10:03:00.001Z',
      duration_s: 2402,
    })), null, 'start beyond 180 seconds stays distinct');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_activity_id: 'provider-boundary-b',
      observed_at: '2026-08-16T10:02:00.000Z',
      duration_s: 2403,
    })), null, 'duration beyond two seconds stays distinct outside exact-start exception');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_activity_id: 'provider-boundary-b',
      observed_at: '2026-08-16T10:02:00.000Z',
      distance_m: 4 * MILE_M + 0.021 * MILE_M,
    })), null, 'distance outside the max(0.02 mi, 0.5%) bound stays distinct');
    assert.equal(classifyCanonicalActivityIdentity(identity({ duration_s: 2100 }), identity({
      source_activity_id: 'provider-boundary-b',
      duration_s: 2400,
    })).reason_code, 'EXACT_START_SOURCE_METRIC_COLLISION', 'exact-start exception permits the bounded 300-second provider correction');
    assert.equal(classifyCanonicalActivityIdentity(identity({ duration_s: 2099 }), identity({
      source_activity_id: 'provider-boundary-b',
      duration_s: 2400,
    })), null, 'exact-start exception rejects duration beyond 300 seconds');
  }

  {
    const localDateCases = [
      {
        name: 'west-of-UTC evening',
        date: '2026-08-16',
        health_start_at: '2026-08-17T02:30:00.000Z',
        timezone: 'America/New_York',
      },
      {
        name: 'east-of-UTC morning',
        date: '2026-08-17',
        health_start_at: '2026-08-16T20:30:00.000Z',
        timezone: 'Asia/Tokyo',
      },
      {
        name: 'UTC midnight is not local-date authority',
        date: '2026-08-17',
        health_start_at: '2026-08-17T00:00:00.000Z',
        timezone: 'America/Los_Angeles',
      },
      {
        name: 'spring DST boundary',
        date: '2026-03-08',
        health_start_at: '2026-03-09T03:30:00.000Z',
        timezone: 'America/New_York',
        planningDate: '2026-03-08',
      },
      {
        name: 'fall DST boundary',
        date: '2026-11-01',
        health_start_at: '2026-11-02T04:30:00.000Z',
        timezone: 'America/New_York',
        planningDate: '2026-11-01',
      },
    ];
    for (const fixture of localDateCases) {
      const planningDate = fixture.planningDate || fixture.date;
      const result = canonicalizeRunLoadInput({
        athleteId: ATHLETE_ID,
        planningInstant: `${planningDate}T23:59:59.999Z`,
        planningDateLocal: planningDate,
        timezone: fixture.timezone,
        runs: [run({
          id: `local-${fixture.name}`,
          date: fixture.date,
          health_start_at: fixture.health_start_at,
          health_source_workout_id: `local-provider-${fixture.name}`,
        })],
        providerCoverage: [coverage({
          coverage_end_local: planningDate,
          expected_end_local: planningDate,
        })],
      });
      assert.equal(result.canonical_run_rows[0].date, fixture.date, `${fixture.name}: persisted local run date remains authoritative`);
      assert.equal(result.windows[0].canonical_activity_count, 1, `${fixture.name}: today's run is not omitted from the acute window`);
      assert.ok(result.windows[0].distance_m > 0, `${fixture.name}: complete evidence cannot become VALID_ZERO`);
    }

    const threeDay = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: '2026-08-17T23:59:59.999Z',
      planningDateLocal: '2026-08-17',
      timezone: 'America/New_York',
      runs: [run({
        id: 'three-day-local',
        date: '2026-08-14',
        health_start_at: '2026-08-15T02:30:00.000Z',
        health_source_workout_id: 'three-day-provider',
        perceived_effort: 8,
      })],
      providerCoverage: [coverage()],
    });
    const acute = summarizeRecentRunLoad(threeDay.canonical_run_rows, {
      todayISO: '2026-08-17',
      weeklyBaseline: 20,
    });
    assert.equal(acute.latestRun.daysSince, 3, 'persisted local dates preserve the inclusive 72-hour safety boundary');
    assert.equal(acute.protection.active, true, 'a hard run at 72 hours remains safety-visible');
  }

  {
    const identity = (overrides = {}) => ({
      athlete_id: ATHLETE_ID,
      activity_kind: 'run',
      observed_at: '2026-08-16T10:00:00.000Z',
      duration_s: 2400,
      distance_m: 4 * MILE_M,
      source_system: 'apple_health',
      source_activity_id: 'cross-source-a',
      route_points: [],
      ...overrides,
    });
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'garmin',
      source_activity_id: 'cross-source-b',
      observed_at: '2026-08-16T10:00:30.000Z',
      duration_s: 2405,
      distance_m: 4.019 * MILE_M,
    })).reason_code, 'CROSS_SOURCE_METRIC_CORROBORATION', 'route-less cross-source summaries deduplicate at the inclusive conservative boundary');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'strava',
      observed_at: '2026-08-16T10:00:30.001Z',
    })), null, 'cross-source start outside the 30-second bound remains distinct');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'strava',
      duration_s: 2406,
    })), null, 'cross-source duration outside the five-second bound remains distinct');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'csv',
      distance_m: 4.021 * MILE_M,
    })), null, 'cross-source distance outside the existing conservative bound remains distinct');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'garmin',
      route_points: [[40.7, -74.0], [40.71, -74.01]],
    })).reason_code, 'CROSS_SOURCE_METRIC_CORROBORATION', 'one missing route falls back to tight metric corroboration');
    assert.equal(classifyCanonicalActivityIdentity(identity({
      route_points: [[40.7, -74.0], [40.71, -74.01]],
    }), identity({
      source_system: 'garmin',
      route_points: [[34.0, -118.2], [34.01, -118.21]],
    })), null, 'two contradictory routes cannot fall back to metric-only identity');
    assert.equal(classifyCanonicalActivityIdentity(identity(), identity({
      source_system: 'manual',
    })), null, 'manual entries are never suppressed by cross-source metric inference');

    const providerCopyOfManual = classifyCanonicalActivityIdentity(identity({
      source_system: 'manual',
      source_activity_id: null,
      observed_at: null,
      local_activity_date: '2026-08-16',
      distance_m: 5 * MILE_M,
    }), identity({
      source_system: 'strava',
      source_activity_id: 'provider-copy-of-manual',
      observed_at: '2026-08-16T17:30:00.000Z',
      local_activity_date: '2026-08-16',
      distance_m: 5.049 * MILE_M,
    }));
    assert.equal(providerCopyOfManual?.reason_code, 'MANUAL_PROVIDER_SUMMARY_CORROBORATION',
      'a provider-startless manual summary has one bounded same-date/distance identity rule');
    assert.equal(classifyCanonicalActivityIdentity(identity({
      source_system: 'manual', source_activity_id: null, observed_at: null,
      local_activity_date: '2026-08-16', distance_m: 5 * MILE_M,
    }), identity({
      source_system: 'strava', source_activity_id: 'provider-copy-of-manual',
      observed_at: '2026-08-16T17:30:00.000Z', local_activity_date: '2026-08-16',
      distance_m: 5.05 * MILE_M,
    })), null, 'the manual/provider distance ceiling is strict and matches the existing SQL bound');
    assert.equal(classifyCanonicalActivityIdentity(identity({
      source_system: 'manual', source_activity_id: null,
      observed_at: '2026-08-16T12:00:00.000Z', local_activity_date: '2026-08-16',
      distance_m: 5 * MILE_M,
    }), identity({
      source_system: 'strava', source_activity_id: 'provider-copy-of-manual',
      observed_at: '2026-08-16T17:30:00.000Z', local_activity_date: '2026-08-16',
      distance_m: 5 * MILE_M,
    })), null, 'a manual row with an actual provider start is not eligible for the startless fallback');
  }

  {
    const result = snapshot([
      run({ id: 'route-less-apple', health_source: 'apple_health', health_source_workout_id: 'apple-a' }),
      run({
        id: 'route-less-garmin',
        health_source: 'garmin',
        health_source_workout_id: 'garmin-a',
        health_start_at: '2026-08-16T10:00:20.000Z',
        duration_seconds: 2404,
        distance_miles: 4.01,
      }),
    ]);
    assert.equal(result.canonical_activities.length, 1, 'Apple and Garmin copies count once without routes');
    assert.equal(result.identity_decision_receipt.decisions[0].reason_code, 'CROSS_SOURCE_METRIC_CORROBORATION');
    const ingestionMatch = selectExistingRunIdentityMatch(ATHLETE_ID, [{
      id: 'ingestion-existing',
      type: 'easy',
      health_start_at: '2026-08-16T10:00:00.000Z',
      duration_seconds: 2400,
      distance_miles: 4,
      health_source: 'apple_health',
      health_source_workout_id: 'ingestion-apple',
      route_coords: null,
    }], normalizeRow({
      date: '2026-08-16',
      startDate: '2026-08-16T10:00:20.000Z',
      type: 'run',
      distanceMiles: 4.01,
      durationSeconds: 2404,
      source: 'garmin',
      sourceWorkoutId: 'ingestion-garmin',
    }));
    assert.equal(ingestionMatch.identityDecision.reason_code, 'CROSS_SOURCE_METRIC_CORROBORATION', 'new ingestion uses the same route-less cross-source identity contract');

    const distinct = snapshot([
      run({ id: 'unknown-a', health_source: 'Outside Provider A', health_source_workout_id: '12345' }),
      run({
        id: 'unknown-b',
        health_source: 'Outside Provider B',
        health_source_workout_id: '12345',
        health_start_at: '2026-08-16T13:00:00.000Z',
        duration_seconds: 900,
        distance_miles: 1.5,
      }),
      run({
        id: 'strava-import',
        health_source: 'strava',
        health_source_workout_id: 'shared-id',
        health_start_at: '2026-08-15T10:00:00.000Z',
      }),
      run({
        id: 'generic-import',
        health_source: 'import',
        health_source_workout_id: 'shared-id',
        health_start_at: '2026-08-14T10:00:00.000Z',
        distance_miles: 8,
      }),
    ]);
    assert.equal(distinct.canonical_activities.length, 4, 'distinct provider namespaces sharing provider IDs never collapse');
    assert.notEqual(distinct.canonical_activities[0].source_namespace, distinct.canonical_activities[1].source_namespace, 'unknown provider namespaces remain distinct and pseudonymous');
    assert.doesNotMatch(JSON.stringify(distinct.identity_decision_receipt), /Outside Provider|12345|shared-id/);
    assert.throws(() => normalizeRow({ date: PLANNING_DATE, type: 'run', source: 'provider\nheader' }), /source/i, 'client source namespaces reject control characters');
  }

  {
    const result = snapshot([
      run(),
      run({ id: 'raw-b', created_at: '2026-08-16T11:01:00.000Z' }),
    ]);
    assert.equal(result.evidence.filter((item) => item.evidence_type === 'completed_workout').length, 2, 'raw observations are retained');
    assert.equal(result.canonical_activities.length, 1, 'same provider workout counts once');
    assert.equal(result.identity_decision_receipt.decisions[0].reason_code, 'EXACT_SOURCE_ACTIVITY_ID');
    assertBoundedPrivateReceipt(result.identity_decision_receipt, [ATHLETE_ID, 'provider-a', 'raw-a', 'raw-b']);
    assert.throws(() => snapshot([run({ user_id: 'different-owner' })]), /owner mismatch/, 'cross-owner evidence fails closed');
    const bounded = snapshot(Array.from({ length: 90 }, (_, index) => run({
      id: `bounded-raw-${index}`,
      created_at: `2026-08-16T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })));
    assert.equal(bounded.identity_decision_receipt.decision_count, 89);
    assert.equal(bounded.identity_decision_receipt.decisions_truncated, true);
    assertBoundedPrivateReceipt(bounded.identity_decision_receipt, ['bounded-raw']);
  }

  {
    const result = snapshot([
      run(),
      run({
        id: 'raw-b',
        health_source_workout_id: 'provider-reissued',
        health_start_at: '2026-08-16T10:01:30.000Z',
        distance_miles: 4.01,
        duration_seconds: 2402,
      }),
    ]);
    assert.equal(result.canonical_activities.length, 1, 'changed provider ID with near metrics counts once');
    assert.equal(result.identity_decision_receipt.decisions[0].reason_code, 'FUZZY_SOURCE_ACTIVITY_MATCH');
  }

  {
    const result = snapshot([
      run(),
      run({
        id: 'raw-nearby',
        health_source_workout_id: 'provider-nearby',
        health_start_at: '2026-08-16T10:02:00.000Z',
        distance_miles: 1.5,
        duration_seconds: 900,
      }),
    ]);
    assert.equal(result.canonical_activities.length, 2, 'legitimate nearby workouts stay distinct');
    assert.equal(result.identity_decision_receipt.decision_count, 0);
    const dateOnly = snapshot([
      run({ id: 'manual-a', health_source: 'manual', health_source_workout_id: null, health_start_at: null }),
      run({ id: 'manual-b', health_source: 'manual', health_source_workout_id: null, health_start_at: null }),
    ]);
    assert.equal(dateOnly.canonical_activities.length, 2, 'date-only rows never gain a fabricated same-start identity');
  }

  {
    const historicalRows = [
      run({ duration_seconds: 2335 }),
      run({
        id: 'raw-historical-duplicate',
        health_source_workout_id: 'provider-reissued',
        duration_seconds: 2595,
      }),
    ];
    const result = snapshot(historicalRows);
    assert.equal(result.canonical_activities.length, 1, 'exact-start historical duplicate canonicalizes at planning read');
    assert.equal(result.identity_decision_receipt.decisions[0].reason_code, 'EXACT_START_SOURCE_METRIC_COLLISION');
    assert.equal(result.source_row_counts.runs, 2, 'historical source rows remain retained');
    const load = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: historicalRows,
      providerCoverage: [coverage()],
    });
    assert.equal(load.windows[0].distance_m, Math.round(4 * MILE_M), 'mileage counts once despite conflicting provider duration summaries');
    assert.equal(load.windows[0].duplicate_removal_delta_m, Math.round(4 * MILE_M));
    assert.equal(load.windows[0].duration_s, null, 'conflicting duration remains explicitly unknown');
  }

  {
    const historicalManualProviderRows = [
      run({
        id: 'manual-five-mile',
        date: '2026-08-16',
        type: 'easy',
        distance_miles: 5,
        duration_seconds: 3000,
        health_source: 'manual',
        health_source_workout_id: null,
        health_start_at: null,
      }),
      run({
        id: 'strava-five-mile',
        date: '2026-08-16',
        type: 'easy',
        distance_miles: 5.04,
        duration_seconds: 3000,
        health_source: 'strava',
        health_source_workout_id: 'strava-five-mile-provider-id',
        health_start_at: '2026-08-16T17:30:00.000Z',
      }),
    ];
    const load = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: historicalManualProviderRows,
      providerCoverage: [coverage()],
    });
    assert.equal(load.raw_row_count, 2, 'manual and provider raw observations remain immutable');
    assert.equal(load.canonical_activity_count, 1, 'historical manual/provider copies count once at planning read');
    assert.equal(load.duplicate_activity_count, 1);
    assert.equal(load.identity_decision_receipt.decisions[0].reason_code, 'MANUAL_PROVIDER_SUMMARY_CORROBORATION');
    assert.equal(load.windows.find((window) => window.days === 7).distance_m, Math.round(5.04 * MILE_M));
    assert.equal(load.windows.find((window) => window.days === 7).duplicate_removal_delta_m, Math.round(5 * MILE_M));
    assert.equal(load.canonical_run_rows[0].health_source, 'strava', 'provider evidence is retained as the canonical measurement source');
    assertBoundedPrivateReceipt(load.identity_decision_receipt, [ATHLETE_ID, 'strava-five-mile-provider-id', 'manual-five-mile']);

    const normalizedProvider = normalizeRow({
      date: '2026-08-16',
      startDate: '2026-08-16T17:30:00.000Z',
      type: 'running',
      distanceMiles: 5.04,
      durationSeconds: 3000,
      source: 'strava',
      sourceWorkoutId: 'ingestion-strava-five-mile',
    });
    const manualCandidate = {
      id: 'manual-ingestion-candidate',
      date: '2026-08-16',
      type: 'easy',
      distance_miles: 5,
      duration_seconds: 3000,
      health_source: null,
      health_source_workout_id: null,
      health_start_at: null,
    };
    const ingestionMatch = selectExistingRunIdentityMatch(ATHLETE_ID, [manualCandidate], normalizedProvider);
    assert.equal(ingestionMatch.identityDecision?.reason_code, 'MANUAL_PROVIDER_SUMMARY_CORROBORATION');
    assert.equal(ingestionMatch.run?.id, manualCandidate.id);
    const rejects = [
      [{ ...manualCandidate, type: 'walk' }, normalizedProvider, 'different kind'],
      [{ ...manualCandidate, distance_miles: 4.98 }, normalizedProvider, 'distance outside strict bound'],
      [{ ...manualCandidate, distance_miles: null }, normalizedProvider, 'unknown manual distance'],
      [{ ...manualCandidate, health_start_at: '2026-08-16T12:00:00.000Z' }, normalizedProvider, 'manual provider start present'],
      [manualCandidate, { ...normalizedProvider, sourceWorkoutId: null }, 'incoming provider identity absent'],
    ];
    for (const [candidate, item, label] of rejects) {
      assert.equal(selectExistingRunIdentityMatch(ATHLETE_ID, [candidate], item).run, null, `${label} remains distinct`);
    }
    assert.equal(selectExistingRunIdentityMatch(ATHLETE_ID, [
      manualCandidate,
      { ...manualCandidate, id: 'second-same-distance-manual' },
    ], normalizedProvider).run, null, 'ambiguous repeated same-distance manual laps fail closed');
  }

  {
    const baseRuns = [
      run({ id: 'day-1', date: '2026-08-16', health_source_workout_id: 'id-1', distance_miles: 3, health_start_at: '2026-08-16T10:00:00Z' }),
      run({ id: 'day-1-dup', date: '2026-08-16', health_source_workout_id: 'id-1-copy', distance_miles: 3, health_start_at: '2026-08-16T10:00:00Z' }),
      run({ id: 'day-8', date: '2026-08-09', health_source_workout_id: 'id-8', distance_miles: 4, health_start_at: '2026-08-09T10:00:00Z' }),
      run({ id: 'day-15', date: '2026-08-02', health_source_workout_id: 'id-15', distance_miles: 5, health_start_at: '2026-08-02T10:00:00Z' }),
      run({ id: 'day-22', date: '2026-07-26', health_source_workout_id: 'id-22', distance_miles: 6, health_start_at: '2026-07-26T10:00:00Z' }),
      run({ id: 'day-29', date: '2026-07-19', health_source_workout_id: 'id-29', distance_miles: 7, health_start_at: '2026-07-19T10:00:00Z' }),
      run({ id: 'day-43', date: '2026-07-05', health_source_workout_id: 'id-43', distance_miles: 8, health_start_at: '2026-07-05T10:00:00Z' }),
    ];
    const result = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: baseRuns,
      providerCoverage: [coverage()],
    });
    const totals = Object.fromEntries(result.windows.map((window) => [window.days, window.distance_m]));
    assert.deepEqual(totals, {
      7: Math.round(3 * MILE_M),
      14: Math.round(3 * MILE_M) + Math.round(4 * MILE_M),
      21: Math.round(3 * MILE_M) + Math.round(4 * MILE_M) + Math.round(5 * MILE_M),
      28: Math.round(3 * MILE_M) + Math.round(4 * MILE_M) + Math.round(5 * MILE_M) + Math.round(6 * MILE_M),
      42: Math.round(3 * MILE_M) + Math.round(4 * MILE_M) + Math.round(5 * MILE_M) + Math.round(6 * MILE_M) + Math.round(7 * MILE_M),
      56: Math.round(3 * MILE_M) + Math.round(4 * MILE_M) + Math.round(5 * MILE_M) + Math.round(6 * MILE_M) + Math.round(7 * MILE_M) + Math.round(8 * MILE_M),
    });
    assert.equal(result.windows.find((item) => item.days === 7).raw_distance_m - result.windows.find((item) => item.days === 7).distance_m, Math.round(3 * MILE_M));
    assert.equal(result.raw_row_count, 7);
    assert.equal(result.canonical_activity_count, 6);
    assert.equal(result.load_input_state, 'COMPLETE');
    assert.equal(result.recent_normal_confidence, 'HIGH');
    assert.equal(result.recent_normal_eligible_week_count, 7);
    assert.equal(result.recent_normal.median_distance_m, Math.round(5 * MILE_M));
    const replay = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: [...baseRuns].reverse(),
      providerCoverage: [coverage()],
    });
    assert.equal(replay.load_input_hash, result.load_input_hash, 'window calculations and identity are input-order deterministic');
  }

  {
    const cases = [
      { name: 'partial', providerCoverage: [coverage({ quality_state: 'PARTIAL' })], expected: 'PARTIAL' },
      { name: 'failed', providerCoverage: [coverage({ quality_state: 'FAILED_SYNC' })], expected: 'FAILED' },
      { name: 'stale', providerCoverage: [coverage({ synced_at: '2026-08-10T00:00:00Z' })], expected: 'STALE' },
      { name: 'missing', providerCoverage: [], expected: 'MISSING' },
      { name: 'unknown', providerCoverage: [{ source_system: 'apple_health', modalities: ['running'], status: 'unknown' }], expected: 'UNKNOWN' },
      { name: 'short-complete-interval', providerCoverage: [coverage({ coverage_start_local: '2026-08-11', expected_start_local: '2026-08-11' })], expected: 'PARTIAL' },
    ];
    for (const fixture of cases) {
      const result = canonicalizeRunLoadInput({
        athleteId: ATHLETE_ID,
        planningInstant: PLANNING_INSTANT,
        planningDateLocal: PLANNING_DATE,
        timezone: TIMEZONE,
        runs: [],
        providerCoverage: fixture.providerCoverage,
      });
      assert.equal(result.load_input_state, fixture.expected, fixture.name);
      assert.equal(result.windows[0].distance_m, null, `${fixture.name} is never presented as complete zero`);
      assert.equal(result.recent_normal_confidence, 'INSUFFICIENT');
    }
    const zero = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: [],
      providerCoverage: [coverage()],
    });
    assert.equal(zero.load_input_state, 'VALID_ZERO');
    assert.equal(zero.windows[0].distance_m, 0);

    const completeBaseline = plansRouter._test.confidenceAwareMileageBaseline([
      run({ date: '2026-08-16', distance_miles: 4 }),
      run({ id: 'complete-two', date: '2026-08-12', health_source_workout_id: 'complete-two', distance_miles: 4 }),
    ], { load_input_state: 'COMPLETE', load_input_confidence: 'HIGH' }, {
      planningDateISO: PLANNING_DATE,
      profileWeeklyMiles: 20,
    });
    assert.equal(completeBaseline.progressionEligible, true);
    assert.equal(completeBaseline.evidenceConfidence, 'HIGH');
    assert.ok(completeBaseline.weeklyMiles > 0);
    const validZeroBaseline = plansRouter._test.confidenceAwareMileageBaseline([], {
      load_input_state: 'VALID_ZERO', load_input_confidence: 'HIGH',
    }, { planningDateISO: PLANNING_DATE, profileWeeklyMiles: 20 });
    assert.equal(validZeroBaseline.weeklyMiles, 0, 'complete interval proof of zero is not replaced by stale profile mileage');
    assert.equal(validZeroBaseline.progressionEligible, true);
    for (const state of ['PARTIAL', 'FAILED', 'STALE', 'MISSING', 'UNKNOWN']) {
      const uncertain = plansRouter._test.confidenceAwareMileageBaseline([
        run({ date: '2026-08-16', distance_miles: 30 }),
      ], { load_input_state: state, load_input_confidence: state === 'PARTIAL' ? 'LOW' : 'INSUFFICIENT' }, {
        planningDateISO: PLANNING_DATE,
        profileWeeklyMiles: 20,
      });
      assert.equal(uncertain.progressionEligible, false, state);
      assert.ok(uncertain.weeklyMiles <= 20, `${state}: incomplete history cannot raise the profile baseline`);
      assert.equal(uncertain.observedAbovePrescriptionBound, true, `${state}: excess observed load remains an explicit diagnostic signal`);
      assert.equal(uncertain.uncertainLoadSafetyHold, undefined, `${state}: C2 does not invent a permanent recovery policy`);
    }
  }

  {
    const conflicting = snapshot([run(), run({ id: 'raw-b' })], {
      corrections: [correction('correction-a', 'raw-a', 1, 6500), correction('correction-b', 'raw-b', 1, 6700)],
    });
    assert.equal(conflicting.canonical_activities[0].distance_m, null, 'conflicting manual corrections fail closed');
    assert.equal(conflicting.canonical_activities[0].correction_id, null);
    assert.equal(conflicting.canonical_activities[0].reason_codes.includes('MANUAL_CORRECTION_CONFLICT'), true);
    assert.equal(conflicting.unresolved_conflicts.some((item) => item.field === 'manual_correction'), true);
    assert.equal(conflicting.evidence.filter((item) => item.evidence_type === 'manual_correction').length, 2, 'correction provenance is retained');
    assert.doesNotMatch(JSON.stringify(conflicting.unresolved_conflicts), /raw-a|raw-b|correction-a|correction-b/, 'artifact-facing conflict refs are pseudonymous');
  }

  {
    const result = snapshot([
      run({
        id: 'mixed-apple',
        health_source: 'apple_health',
        health_source_workout_id: 'mixed-a',
        avg_heart_rate: 160,
        workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 90 }),
      }),
      run({
        id: 'mixed-garmin',
        health_source: 'garmin',
        health_source_workout_id: 'mixed-b',
        health_start_at: '2026-08-16T10:00:20.000Z',
        duration_seconds: 2404,
        distance_miles: 4.01,
        avg_heart_rate: 120,
        workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 90 }),
      }),
    ]);
    assert.equal(result.canonical_activities.length, 1);
    assert.equal(result.canonical_activities[0].heart_rate_resolution.value, 120, 'cross-source dedup keeps HR from the retained metric provenance instead of blending incompatible streams');
    assert.equal(result.canonical_activities[0].heart_rate_resolution.quality_state, 'COMPLETE');
  }

  {
    const duplicateRows = [
      run({ id: 'planning-raw-a', health_source_workout_id: 'planning-provider-a', distance_miles: 5, perceived_effort: 8 }),
      run({ id: 'planning-raw-b', health_source_workout_id: 'planning-provider-b', distance_miles: 5, perceived_effort: 8 }),
    ];
    const context = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: 20,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, {
      todayISO: PLANNING_DATE,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      distanceMiles: 10,
    }, {
      async all(sql) {
        if (sql.includes('FROM runs')) return duplicateRows.map((row) => ({ ...row }));
        if (sql.includes('FROM planning_evidence_corrections')) return [correction('planning-correction', 'planning-raw-a', 1, 9000)];
        return [];
      },
      async get() { return null; },
    });
    assert.equal(context.history.runLoadInput.raw_row_count, 2);
    assert.equal(context.history.runLoadInput.canonical_activity_count, 1, 'plan assembly consumes canonical historical rows');
    assert.equal(context.history.runLoadInput.load_input_state, 'MISSING', 'stored activity rows do not fabricate a complete provider-coverage interval');
    assert.equal(context.history.recentRunCount, 1);
    assert.equal(context.history.mileageBaseline.meaningfulRunCount, 1);
    assert.equal(context.history.mileageBaseline.progressionEligible, false, 'incomplete history cannot authorize upward prescription');
    assert.equal(context.history.mileageBaseline.evidenceConfidence, 'INSUFFICIENT');
    assert.equal(context.history.mileageBaseline.method, 'profile_bounded_uncertain_evidence');
    assert.ok(context.history.weeklyMileageBaseline <= 20, 'uncertain observed rows cannot increase an athlete-authored profile baseline');
    assert.equal(context.history.adherenceRate, null, 'incomplete activity coverage cannot claim positive adherence');
    assert.equal(context.history.missedWorkouts, null, 'incomplete activity coverage cannot claim missed workouts');
    assert.equal(context.history.performanceProfile.sampleCount, 1, 'performance consumers receive canonical rows rather than duplicate raw rows');
    assert.equal(context.history.acuteRunLoad.latestRun.date, '2026-08-16', 'the local-date run remains visible to 24-72 hour safety protection');
    assert.equal(context.history.acuteRunLoad.protection.active, true, 'uncertain coverage may still reduce load through observed acute safety evidence');
    assert.equal(context.history.acuteRunLoad.evidenceUse, 'SAFETY_ONLY');
    assert.equal(context.history.runLoadInput.windows[0].distance_m, 9000, 'plan assembly applies the owned revisioned correction after identity canonicalization');
    assert.equal(context.history.runLoadInput.reason_codes.includes('MANUAL_CORRECTION_APPLIED'), true);
  }

  {
    const tooManyCorrections = Array.from({ length: 1001 }, (_, index) => (
      correction(`cap-correction-${index}`, `cap-run-${index}`, 1, 5000 + index)
    ));
    const context = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: 15,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, {
      todayISO: PLANNING_DATE,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      distanceMiles: 10,
    }, {
      async all(sql) {
        if (sql.includes('FROM planning_evidence_corrections')) return tooManyCorrections;
        if (sql.includes('FROM runs')) return [run({ id: 'cap-run-current' })];
        return [];
      },
      async get() { return null; },
    });
    assert.equal(context.history.runLoadInput.correction_input_state, 'TRUNCATED');
    assert.equal(context.history.runLoadInput.load_input_state, 'UNKNOWN', 'an incomplete manual-correction view fails closed');
    assert.match(context.history.runLoadInput.correction_receipt_hash, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(context.history.runLoadInput), /cap-correction|cap-run-/);
  }

  {
    const incompleteRuns = Array.from({ length: 28 }, (_, index) => run({
      id: `runtime-run-${index}`,
      health_source_workout_id: `runtime-provider-${index}`,
      date: new Date(Date.UTC(2026, 7, 17 - index, 12)).toISOString().slice(0, 10),
      distance_miles: 1,
      duration_seconds: 600,
      health_start_at: new Date(Date.UTC(2026, 7, 17 - index, 12)).toISOString(),
    }));
    const incompleteLoad = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: `${PLANNING_DATE}T23:59:59.999Z`,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: incompleteRuns,
      providerCoverage: [{ source_system: 'apple_health', modalities: ['running'], status: 'unknown' }],
    });
    const noProfileBaseline = plansRouter._test.confidenceAwareMileageBaseline(
      incompleteLoad.canonical_run_rows,
      incompleteLoad,
      { planningDateISO: PLANNING_DATE, profileWeeklyMiles: null },
    );
    assert.equal(noProfileBaseline.weeklyMiles, null, 'incomplete rows without an athlete profile never assert a zero baseline');
    assert.equal(noProfileBaseline.observedLowerBoundWeeklyMiles, 7, '28 observed miles expose a 7 mi/week lower bound');
    assert.equal(noProfileBaseline.observedWindowDays, 28);
    assert.equal(noProfileBaseline.observedWindowMiles, 28);
    assert.equal(noProfileBaseline.progressionEligible, false);
    assert.equal(noProfileBaseline.uncertainLoadSafetyHold, undefined, 'C2 does not invent a permanent recovery policy from incomplete coverage');

    const unknownDistanceLoad = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: `${PLANNING_DATE}T23:59:59.999Z`,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: [{
        id: 'unknown-distance-observation',
        user_id: ATHLETE_ID,
        date: PLANNING_DATE,
        duration_seconds: 1800,
        health_source: 'apple_health',
        health_source_workout_id: 'unknown-distance-provider-id',
        health_start_at: `${PLANNING_DATE}T12:00:00.000Z`,
      }],
      providerCoverage: [{ source_system: 'apple_health', modalities: ['running'], status: 'unknown' }],
    });
    const unknownDistanceBaseline = plansRouter._test.confidenceAwareMileageBaseline(
      unknownDistanceLoad.canonical_run_rows,
      unknownDistanceLoad,
      { planningDateISO: PLANNING_DATE, profileWeeklyMiles: null },
    );
    assert.equal(unknownDistanceBaseline.weeklyMiles, null);
    assert.equal(unknownDistanceBaseline.observedWindowMiles, null,
      'an observed workout with unknown distance is not restated as zero observed mileage');
    assert.equal(unknownDistanceBaseline.observedLowerBoundWeeklyMiles, null);

    const durationOnlyAcute = summarizeRecentRunLoad(unknownDistanceLoad.canonical_run_rows, {
      todayISO: PLANNING_DATE,
      weeklyBaseline: 20,
      coverageComplete: false,
    });
    assert.equal(durationOnlyAcute.latestRun.distanceMiles, null, 'duration-only recent run distance remains unknown');
    assert.equal(durationOnlyAcute.latestRun.distanceKnown, false);
    assert.equal(durationOnlyAcute.sevenDayMiles, null);
    assert.equal(durationOnlyAcute.sevenDayDistanceState, 'INCOMPLETE');
    assert.equal(durationOnlyAcute.sevenDayKnownDistanceLowerBoundMiles, 0);
    assert.equal(durationOnlyAcute.currentWeek.miles, null);
    assert.equal(durationOnlyAcute.currentWeek.distanceState, 'INCOMPLETE');
    assert.equal(durationOnlyAcute.loadRatio, null, 'unknown acute distance cannot become a zero load ratio');
    assert.equal(durationOnlyAcute.protection.active, true, 'duration-only run remains safety-visible');
    assert.doesNotMatch(durationOnlyAcute.protection.reason, /(?:^|,\s)0(?:\.0)? mi(?:,|$)/);
    assert.match(durationOnlyAcute.protection.reason, /distance unknown/i);

    const conflictingDistanceRows = [
      run({
        id: 'conflicting-distance-ten',
        date: PLANNING_DATE,
        distance_miles: 10,
        duration_seconds: 5400,
        health_source_workout_id: 'same-provider-conflict',
        health_start_at: `${PLANNING_DATE}T08:00:00.000Z`,
      }),
      run({
        id: 'conflicting-distance-twelve',
        date: PLANNING_DATE,
        distance_miles: 12,
        duration_seconds: 5400,
        health_source_workout_id: 'same-provider-conflict',
        health_start_at: `${PLANNING_DATE}T08:00:00.000Z`,
      }),
    ];
    const conflictingDistanceLoad = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: `${PLANNING_DATE}T23:59:59.999Z`,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: conflictingDistanceRows,
      providerCoverage: [{ source_system: 'apple_health', modalities: ['running'], status: 'unknown' }],
    });
    assert.equal(conflictingDistanceLoad.canonical_run_rows[0].distance_miles, null);
    assert.equal(conflictingDistanceLoad.unresolved_conflicts[0].field, 'distance_m');
    const conflictingDistanceReplay = canonicalizeRunLoadInput({
      athleteId: ATHLETE_ID,
      planningInstant: `${PLANNING_DATE}T23:59:59.999Z`,
      planningDateLocal: PLANNING_DATE,
      timezone: TIMEZONE,
      runs: conflictingDistanceRows,
      providerCoverage: [{ source_system: 'apple_health', modalities: ['running'], status: 'unknown' }],
    });
    assert.equal(conflictingDistanceReplay.canonical_hash, conflictingDistanceLoad.canonical_hash,
      'unresolved-distance evidence hash remains deterministic');
    assert.equal(conflictingDistanceReplay.identity_decision_receipt.receipt_hash,
      conflictingDistanceLoad.identity_decision_receipt.receipt_hash);
    const conflictingDistanceAcute = summarizeRecentRunLoad(conflictingDistanceLoad.canonical_run_rows, {
      todayISO: PLANNING_DATE,
      weeklyBaseline: 20,
      coverageComplete: false,
    });
    assert.equal(conflictingDistanceAcute.latestRun.distanceMiles, null);
    assert.equal(conflictingDistanceAcute.sevenDayMiles, null);
    assert.equal(conflictingDistanceAcute.currentWeek.miles, null);
    assert.equal(conflictingDistanceAcute.loadRatio, null);

    const mixedKnownUnknownAcute = summarizeRecentRunLoad([
      run({
        id: 'mixed-known-three',
        date: PLANNING_DATE,
        distance_miles: 3,
        duration_seconds: 1800,
        health_source_workout_id: 'mixed-known-provider',
        health_start_at: '2026-08-16T08:00:00.000Z',
      }),
      {
        ...run({
          id: 'mixed-unknown-distance',
          date: PLANNING_DATE,
          distance_miles: null,
          duration_seconds: 2400,
          health_source_workout_id: 'mixed-unknown-provider',
          health_start_at: `${PLANNING_DATE}T08:00:00.000Z`,
        }),
      },
    ], {
      todayISO: PLANNING_DATE,
      focusRunId: 'mixed-unknown-distance',
      weeklyBaseline: 20,
      coverageComplete: false,
    });
    assert.equal(mixedKnownUnknownAcute.sevenDayMiles, null, 'mixed known and unknown distances never produce a complete total');
    assert.equal(mixedKnownUnknownAcute.sevenDayKnownDistanceLowerBoundMiles, 3,
      'known recent mileage remains an explicitly labelled lower bound');
    assert.equal(mixedKnownUnknownAcute.currentWeek.miles, null);
    assert.equal(mixedKnownUnknownAcute.currentWeek.knownDistanceLowerBoundMiles, 3);
    assert.equal(mixedKnownUnknownAcute.currentWeek.unknownDistanceRunCount, 1);
    assert.equal(mixedKnownUnknownAcute.loadRatio, null);
    assert.equal(mixedKnownUnknownAcute.latestRun.distanceMiles, null);
    const hyroxArithmeticView = plansRouter._test.hyroxRecentRunLoadView(mixedKnownUnknownAcute);
    assert.equal(hyroxArithmeticView.currentWeek.miles, 3,
      'the legacy HYROX arithmetic receives only the explicit known-distance lower bound');
    assert.equal(mixedKnownUnknownAcute.currentWeek.miles, null,
      'the canonical evidence object is not mutated for legacy arithmetic');
    const hyroxTruthFixture = {
      inputSummary: { currentWeekRunLoad: { miles: 3 } },
      weeks: [{ currentWeekConstraint: { completedRunMiles: 3 } }],
    };
    plansRouter._test.restoreHyroxIncompleteDistanceTruth(hyroxTruthFixture, mixedKnownUnknownAcute);
    assert.deepEqual(hyroxTruthFixture.inputSummary.currentWeekRunLoad, {
      miles: null,
      distanceState: 'INCOMPLETE',
      knownDistanceLowerBoundMiles: 3,
      unknownDistanceRunCount: 1,
    });
    assert.equal(hyroxTruthFixture.weeks[0].currentWeekConstraint.completedRunMiles, null);
    assert.equal(hyroxTruthFixture.weeks[0].currentWeekConstraint.completedKnownDistanceLowerBoundMiles, 3);
    assert.equal(hyroxTruthFixture.weeks[0].currentWeekConstraint.completedRunDistanceState, 'INCOMPLETE');

    const unverifiedZeroRowAcute = summarizeRecentRunLoad([run({
      id: 'unverified-zero-row',
      date: PLANNING_DATE,
      distance_miles: 0,
      duration_seconds: 0,
    })], {
      todayISO: PLANNING_DATE,
      weeklyBaseline: 20,
      coverageComplete: false,
    });
    assert.equal(unverifiedZeroRowAcute.sevenDayMiles, null,
      'a zero-valued workout row cannot prove a complete zero-mile interval');
    assert.equal(unverifiedZeroRowAcute.sevenDayDistanceState, 'INCOMPLETE');

    const verifiedZeroAcute = summarizeRecentRunLoad([], {
      todayISO: PLANNING_DATE,
      weeklyBaseline: 20,
      coverageComplete: true,
    });
    assert.equal(verifiedZeroAcute.sevenDayMiles, 0, 'zero is valid only with complete interval evidence');
    assert.equal(verifiedZeroAcute.sevenDayDistanceState, 'VALID_ZERO');
    assert.equal(verifiedZeroAcute.currentWeek.miles, 0);
    assert.equal(verifiedZeroAcute.currentWeek.distanceState, 'VALID_ZERO');

    const recent = summarizeRecentRunLoad(incompleteLoad.canonical_run_rows, {
      todayISO: PLANNING_DATE,
      weeklyBaseline: null,
      coverageComplete: false,
    });
    assert.equal(recent.weeklyBaseline, null, 'acute-load metadata preserves an unknown weekly baseline');
    assert.equal(recent.sevenDayMiles, 7, 'known acute observations remain visible for safety');
    assert.equal(recent.loadRatio, null, 'unknown baseline is never divided as zero');
    const noObservedAcute = summarizeRecentRunLoad([], {
      todayISO: PLANNING_DATE,
      weeklyBaseline: null,
      coverageComplete: false,
    });
    assert.equal(noObservedAcute.sevenDayMiles, null, 'no observed rows under incomplete coverage is unknown, not a zero-mile week');
    assert.equal(noObservedAcute.currentWeek.miles, null);
    assert.equal(noObservedAcute.sevenDayDistanceState, 'UNKNOWN');
    assert.equal(noObservedAcute.currentWeek.distanceState, 'UNKNOWN');

    const contextWithoutProfileMileage = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: null,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, {
      todayISO: PLANNING_DATE,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      distanceMiles: 10,
    }, {
      async all(sql) {
        if (sql.includes('FROM runs')) return incompleteRuns.map((row) => ({ ...row }));
        return [];
      },
      async get(sql) {
        if (sql.includes('FROM health_sync')) {
          return { synced_at: '2026-08-17T11:00:00.000Z', total_miles_this_week: 7 };
        }
        return null;
      },
    });
    assert.equal(contextWithoutProfileMileage.history.runLoadInput.load_input_state, 'UNKNOWN');
    assert.equal(contextWithoutProfileMileage.history.weeklyMileageBaseline, null);
    assert.equal(contextWithoutProfileMileage.history.mileageBaseline.observedLowerBoundWeeklyMiles, 7);
    assert.equal(contextWithoutProfileMileage.history.acuteRunLoad.weeklyBaseline, null);
    assert.equal(contextWithoutProfileMileage.history.acuteRunLoad.evidenceUse, 'SAFETY_ONLY');
    assert.equal(contextWithoutProfileMileage.history.adherenceRate, null);
    assert.equal(contextWithoutProfileMileage.history.missedWorkouts, null);

    const missingContextWithoutProfileMileage = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: null,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, {
      todayISO: PLANNING_DATE,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      distanceMiles: 10,
    }, {
      async all(sql) {
        if (sql.includes('FROM runs')) return incompleteRuns.map((row) => ({ ...row }));
        return [];
      },
      async get() { return null; },
    });
    assert.equal(missingContextWithoutProfileMileage.history.runLoadInput.load_input_state, 'MISSING');
    assert.equal(missingContextWithoutProfileMileage.history.weeklyMileageBaseline, null);
    assert.equal(missingContextWithoutProfileMileage.history.mileageBaseline.observedLowerBoundWeeklyMiles, 7);

    const profileBoundContext = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: 20,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, {
      todayISO: PLANNING_DATE,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      distanceMiles: 10,
    }, {
      async all(sql) {
        if (sql.includes('FROM runs')) return incompleteRuns.map((row) => ({ ...row }));
        return [];
      },
      async get(sql) {
        return sql.includes('FROM health_sync')
          ? { synced_at: '2026-08-17T11:00:00.000Z', total_miles_this_week: 7 }
          : null;
      },
    });
    assert.equal(profileBoundContext.history.runLoadInput.load_input_state, 'UNKNOWN');
    assert.equal(profileBoundContext.history.weeklyMileageBaseline, 7, 'incomplete observations may bound a profile baseline downward, never upward');
    assert.equal(profileBoundContext.history.mileageBaseline.profileBoundWeeklyMiles, 20);
    assert.equal(profileBoundContext.history.mileageBaseline.observedLowerBoundWeeklyMiles, 7);

    const summaryPlan = concurrentPlan.buildConcurrentPlan({
      profile: {
        weekly_miles_current: null,
        run_days_per_week: 3,
        lift_days_per_week: 0,
      },
      target: {
        startDate: '2026-08-17',
        weeks: 4,
        planMode: 'run_only',
        runDaysPerWeek: 3,
        liftDaysPerWeek: 0,
        trainingDays: ['Mon', 'Wed', 'Sun'],
      },
      todayISO: PLANNING_DATE,
      history: contextWithoutProfileMileage.history,
      recovery: { state: 'unknown', available: false, dataAvailable: false },
    });
    assert.equal(summaryPlan.inputSummary.weeklyMileageBaseline, null, 'runtime input summary does not convert unknown mileage to zero');
    assert.equal(summaryPlan.inputSummary.observedLowerBoundWeeklyMiles, 7);
    assert.equal(summaryPlan.inputSummary.missedWorkouts, null, 'runtime input summary keeps unknown misses nullable');
    assert.equal(summaryPlan.inputSummary.adherenceBand, 'unknown');

    const incompleteAcutePlan = concurrentPlan.buildConcurrentPlan({
      profile: {
        weekly_miles_current: null,
        run_days_per_week: 3,
        lift_days_per_week: 0,
      },
      target: {
        startDate: PLANNING_DATE,
        weeks: 4,
        planMode: 'run_only',
        runDaysPerWeek: 3,
        liftDaysPerWeek: 0,
        trainingDays: ['Mon', 'Wed', 'Sun'],
      },
      todayISO: PLANNING_DATE,
      history: {
        ...contextWithoutProfileMileage.history,
        acuteRunLoad: mixedKnownUnknownAcute,
      },
      recovery: { state: 'unknown', available: false, dataAvailable: false },
    });
    assert.equal(incompleteAcutePlan.inputSummary.recentRun.distanceMiles, null,
      'structured planning input retains the unknown latest distance');
    assert.equal(incompleteAcutePlan.inputSummary.sevenDayRunMiles, null);
    assert.equal(incompleteAcutePlan.inputSummary.sevenDayRunDistanceState, 'INCOMPLETE');
    assert.equal(incompleteAcutePlan.inputSummary.sevenDayRunKnownDistanceLowerBoundMiles, 3);
    assert.equal(incompleteAcutePlan.inputSummary.recentRunLoadRatio, null);
    assert.equal(incompleteAcutePlan.weeks[0].completedMilesAtGeneration, null);
    assert.equal(incompleteAcutePlan.weeks[0].completedKnownDistanceLowerBoundMilesAtGeneration, 3);
    assert.doesNotMatch(JSON.stringify(incompleteAcutePlan), /0(?:\.0)? mi recent run|Your 0(?:\.0)? mi run/);

    const incompleteAcuteAdaptation = adaptation.buildAdaptationProposal({
      plan: {
        schemaVersion: 2,
        planMode: 'run_only',
        strengthPolicy: { minimumSessionsPerWeek: 0 },
        weeks: [{ week: 1, phase: 'base', startDate: PLANNING_DATE, days: [{
          day: 'Mon',
          date: PLANNING_DATE,
          sessions: [{
            id: 'incomplete-acute-lift', kind: 'lift', type: 'strength', workout_type: 'strength',
            title: 'Lower-body strength', focus: 'Lower body', duration_min: 45,
          }],
        }] }],
      },
      planningDateISO: PLANNING_DATE,
      recentRunLoad: mixedKnownUnknownAcute,
    });
    assert.doesNotMatch(JSON.stringify(incompleteAcuteAdaptation), /(?:the |after the )0(?:\.0)? mi(?: recent)? run/i,
      'adaptation copy never restates unknown distance as zero');
    assert.match(JSON.stringify(incompleteAcuteAdaptation), /distance unknown/i);

    const olderDurationOnlyRuns = [30, 33, 36, 39, 42, 48].map((daysAgo, index) => ({
      ...run({
        id: `older-duration-only-${index}`,
        date: new Date(Date.parse(`${PLANNING_DATE}T12:00:00.000Z`) - daysAgo * 86400000).toISOString().slice(0, 10),
        distance_miles: null,
        duration_seconds: 1800 + index * 60,
        health_source_workout_id: `older-duration-provider-${index}`,
        health_start_at: new Date(Date.parse(`${PLANNING_DATE}T12:00:00.000Z`) - daysAgo * 86400000).toISOString(),
      }),
    }));
    const unknownBaselineTarget = {
      todayISO: PLANNING_DATE,
      startDate: PLANNING_DATE,
      weeks: 4,
      planMode: 'run_only',
      runDaysPerWeek: 3,
      liftDaysPerWeek: 0,
      trainingDays: ['Mon', 'Wed', 'Sun'],
      distanceMiles: 10,
      raceDate: '2026-09-13',
      raceName: 'Synthetic 10 Miler',
    };
    const unknownBaselineContext = await plansRouter._test.buildConcurrentContext(ATHLETE_ID, {
      timezone: TIMEZONE,
      weekly_miles_current: null,
      run_days_per_week: 3,
      lift_days_per_week: 0,
      comeback_mode: false,
      injury_notes: null,
    }, unknownBaselineTarget, {
      async all(sql) {
        if (sql.includes('FROM runs')) return olderDurationOnlyRuns.map((row) => ({ ...row }));
        return [];
      },
      async get() { return null; },
    });
    assert.equal(unknownBaselineContext.history.weeklyMileageBaseline, null);
    assert.equal(unknownBaselineContext.history.mileageBaseline.meaningfulRunCount, 6);
    assert.equal(concurrentPlan.qualitySafetyForWeek(unknownBaselineContext, {
      weekNumber: 1,
      weekStart: PLANNING_DATE,
    }).lowExperience, true, 'unknown baseline stays fail-closed even with several duration-only runs');
    const unknownBaselinePlan = concurrentPlan.buildConcurrentPlan(unknownBaselineContext);
    assert.equal(unknownBaselinePlan.inputSummary.weeklyMileageBaseline, null, 'unknown baseline remains nullable in plan truth');
    assert.ok(unknownBaselinePlan.weeks[0].totalMiles <= 6.1,
      'unknown load uses a bounded conservative planning anchor, never the race distance');
    const unsafeUnknownBaselineSessions = unknownBaselinePlan.weeks.flatMap((week) => week.days)
      .flatMap((day) => day.sessions || [])
      .filter((session) => session.kind === 'run' && session.type !== 'race')
      .filter((session) => ['intervals', 'threshold', 'hills', 'benchmark', 'race_pace'].includes(session.workout_family));
    assert.deepEqual(unsafeUnknownBaselineSessions, [], 'unknown baseline cannot enable interval, tempo, hill, benchmark, or race-pace escalation');
    assert.equal(concurrentPlan.validateConcurrentPlan(unknownBaselinePlan, unknownBaselineContext).valid, true,
      'the bounded unknown-baseline plan passes the same production validator');
    assert.equal(concurrentPlan.qualitySafetyForWeek({
      ...unknownBaselineContext,
      history: {
        ...unknownBaselineContext.history,
        weeklyMileageBaseline: 12,
        mileageBaseline: { ...unknownBaselineContext.history.mileageBaseline, meaningfulRunCount: 6 },
      },
    }, { weekNumber: 1, weekStart: PLANNING_DATE }).lowExperience, false,
    'explicit finite mileage plus sufficient history can remove low-experience protection');

    const capturedRequests = [];
    ai._test.setClient({
      messages: {
        async create(request) {
          capturedRequests.push(request);
          return { content: [{ text: '{}' }] };
        },
      },
    });
    try {
      await ai.generateTrainingPlan({
        name: 'Synthetic athlete',
        weekly_miles_current: null,
        run_days_per_week: 3,
        lift_days_per_week: 0,
      }, {
        startDate: '2026-08-17',
        weeks: 4,
        planMode: 'run_only',
        runDaysPerWeek: 3,
        liftDaysPerWeek: 0,
        trainingDays: ['Mon', 'Wed', 'Sun'],
      }, contextWithoutProfileMileage);
      await ai.generateTrainingPlan({
        name: 'Synthetic athlete',
        weekly_miles_current: null,
        run_days_per_week: 3,
        lift_days_per_week: 0,
      }, {
        startDate: PLANNING_DATE,
        weeks: 4,
        planMode: 'run_only',
        runDaysPerWeek: 3,
        liftDaysPerWeek: 0,
        trainingDays: ['Mon', 'Wed', 'Sun'],
      }, {
        ...contextWithoutProfileMileage,
        history: {
          ...contextWithoutProfileMileage.history,
          acuteRunLoad: mixedKnownUnknownAcute,
        },
      });
    } finally {
      ai._test.resetClient();
    }
    const [capturedRequest, incompleteAcuteRequest] = capturedRequests;
    assert.equal(capturedRequest.model, 'complex', 'C2 keeps the training-plan model tier unchanged');
    const prompt = capturedRequest.messages[0].content;
    assert.match(prompt, /Observed weekly mileage from recent activity: unknown; observed lower bound: 7\.0 mi\/week over 28 days \(incomplete evidence\)/);
    assert.match(prompt, /Recent adherence: unknown \(insufficient evidence\); missed sessions estimate: unknown \(insufficient evidence\)/);
    assert.doesNotMatch(prompt, /Recent adherence: 0%|missed sessions estimate: 0(?:\D|$)/, 'nullable completion evidence never becomes a confident zero in the AI prompt');
    const incompleteAcutePrompt = incompleteAcuteRequest.messages[0].content;
    assert.match(incompleteAcutePrompt, /Latest meaningful run: distance unknown .*incomplete evidence/i);
    assert.match(incompleteAcutePrompt, /trailing 7-day miles: unknown \(incomplete evidence; known-distance lower bound 3\.0 mi\)/i);
    assert.doesNotMatch(incompleteAcutePrompt, /Latest meaningful run: 0\.0 miles|trailing 7-day miles: 0\.0/);

    const incompleteAge = plansRouter._test.goalBackwardTrainingAge({
      profile: {},
      history: { recentRunCount: 28, runLoadInput: { load_input_state: 'UNKNOWN' } },
    });
    assert.equal(incompleteAge, 'ESTABLISHED', 'missing interval proof alone does not permanently promote an experienced runner to beginner');
    assert.deepEqual(plansRouter._test.goalBackwardSafetyState({
      safety: { activeInjury: false },
      history: { mileageBaseline: { observedLowerBoundWeeklyMiles: 7, progressionEligible: false } },
    }), { action: 'NORMAL', scope: [] }, 'C2 exposes uncertainty without inventing a permanent no-intensity policy');

    let capturedAthleteState = null;
    assert.throws(() => plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: ATHLETE_ID,
      planningDateLocal: PLANNING_DATE,
      state: {
        inputHash: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        planningInputRevision: 1,
        target: { trainingDays: ['Mon', 'Wed', 'Sun'] },
        races: [],
        planningConstraints: { locks: [], manual_edits: [], lock_revision: 0, edit_revision: 0 },
        context: contextWithoutProfileMileage,
        active: null,
        activePlan: null,
      },
      built: { plan: { weeks: [] } },
    }, {
      buildDecision(input) {
        capturedAthleteState = input.athlete_state;
        throw new Error('C2_ATHLETE_STATE_CAPTURED');
      },
    }), /C2_ATHLETE_STATE_CAPTURED/);
    assert.equal(capturedAthleteState.training_age_class, 'ESTABLISHED');
    assert.equal(capturedAthleteState.consistency_state, 'UNKNOWN', 'incomplete interval coverage cannot claim completed consistent weeks');
    assert.equal(capturedAthleteState.safety_action, 'NORMAL');
    assert.equal(capturedAthleteState.recent_normal_running.status, 'PROVISIONAL');
    assert.equal(capturedAthleteState.recent_normal_running.load_input_state, 'UNKNOWN');
    assert.equal(capturedAthleteState.recent_normal_running.confidence, 'INSUFFICIENT');
    assert.equal(capturedAthleteState.recent_normal_running.load_input_confidence, 'LOW');
    assert.equal(capturedAthleteState.recent_normal_running.observed_lower_bound_distance_m, Math.round(7 * MILE_M));
    assert.equal(capturedAthleteState.recent_normal_running.median_distance_m, Math.round(7 * MILE_M));

    const unknownCompletion = adaptation.buildAdaptationProposal({
      plan: {
        schemaVersion: 2,
        planMode: 'run_only',
        weeks: [{ week: 1, phase: 'build', days: [{
          day: 'Mon',
          date: '2026-08-17',
          sessions: [{
            id: 'unknown-completion-run',
            kind: 'run',
            type: 'quality',
            workout_type: 'run',
            title: 'Quality run',
            intensity: 'Hard',
            target_zone: 'Zone 4',
            duration_min: 40,
            distance_miles: 4,
          }],
        }] }],
      },
      planningDateISO: PLANNING_DATE,
      planVersion: 'c2-null-completion',
      completion: {
        adherenceRate: null,
        missedWorkouts: null,
        missedRuns: null,
        missedLifts: null,
        weeklyMileageBaseline: null,
        freshness: 'unknown',
      },
    });
    assert.equal(unknownCompletion.status, 'keep', 'unknown completion evidence cannot trigger a low-adherence adaptation');
    assert.doesNotMatch(JSON.stringify(unknownCompletion), /"missedWorkouts":0/, 'adaptation artifacts never restate unknown misses as zero');
  }

  console.log('ACTIVITY IDENTITY + LOAD INPUT SMOKE OK (19 groups)');
}

runSmoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
