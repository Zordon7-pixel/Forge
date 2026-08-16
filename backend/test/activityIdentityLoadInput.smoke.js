#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildEvidenceSnapshot,
  canonicalizeRunLoadInput,
  classifyCanonicalActivityIdentity,
} = require('../src/lib/goalBackwardEvidence');
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
  }

  {
    const duplicateRows = [
      run({ id: 'planning-raw-a', health_source_workout_id: 'planning-provider-a', distance_miles: 5 }),
      run({ id: 'planning-raw-b', health_source_workout_id: 'planning-provider-b', distance_miles: 5 }),
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
    assert.equal(context.history.runLoadInput.windows[0].distance_m, 9000, 'plan assembly applies the owned revisioned correction after identity canonicalization');
    assert.equal(context.history.runLoadInput.reason_codes.includes('MANUAL_CORRECTION_APPLIED'), true);
  }

  console.log('ACTIVITY IDENTITY + LOAD INPUT SMOKE OK (10 groups)');
}

runSmoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
