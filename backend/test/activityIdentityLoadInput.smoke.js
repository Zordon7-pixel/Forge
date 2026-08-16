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
      assert.equal(uncertain.uncertainLoadSafetyHold, true, `${state}: excess observed load remains available only as a conservative safety hold`);
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

  console.log('ACTIVITY IDENTITY + LOAD INPUT SMOKE OK (16 groups)');
}

runSmoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
