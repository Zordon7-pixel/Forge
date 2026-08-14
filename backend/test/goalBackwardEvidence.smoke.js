#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildAthleteState,
  buildEvidenceSnapshot,
  buildEvidenceStateArtifacts,
  classifyCompletedWeek,
  deriveCrossModalRecentNormal,
  deriveRecentNormalRunning,
  localDateInTimezone,
  resolveHeartRateEvidence,
  resolvePerformanceEvidence,
} = require('../src/lib/goalBackwardEvidence');

const MILE_M = 1609.344;
const ATHLETE_ID = 'athlete-synthetic';
const PLANNING_INSTANT = '2026-08-14T12:00:00.000Z';
const TIMEZONE = 'America/New_York';

function route(offset = 0) {
  return [
    { lat: 40.7000 + offset, lon: -74.0000 },
    { lat: 40.7010 + offset, lon: -74.0010 },
    { lat: 40.7020 + offset, lon: -74.0020 },
    { lat: 40.7030 + offset, lon: -74.0030 },
    { lat: 40.7040 + offset, lon: -74.0040 },
  ];
}

function runRow(overrides = {}) {
  return {
    id: 'run-fit',
    user_id: ATHLETE_ID,
    date: '2026-08-10',
    type: 'easy',
    distance_miles: 5.02,
    duration_seconds: 2400,
    avg_heart_rate: 150,
    health_source: 'fit',
    health_source_workout_id: null,
    health_start_at: '2026-08-10T11:00:00.000Z',
    health_end_at: '2026-08-10T11:40:00.000Z',
    route_coords: JSON.stringify(route()),
    workout_metrics_json: JSON.stringify({
      distance_source: 'fit',
      hr_sample_coverage_pct: 100,
      route_status: 'complete',
      sample_count: 240,
    }),
    created_at: '2026-08-10T11:45:00.000Z',
    ...overrides,
  };
}

function coverage(qualityState = 'COMPLETE', overrides = {}) {
  return {
    source_system: 'garmin',
    modality: 'running',
    coverage_start_local: '2026-08-03',
    coverage_end_local: '2026-08-09',
    quality_state: qualityState,
    ...overrides,
  };
}

function normalWeek(weekId, distanceM, overrides = {}) {
  return {
    week_id: weekId,
    start_date_local: weekId,
    end_date_local: new Date(`${weekId}T12:00:00.000Z`).toISOString().slice(0, 10),
    distance_m: distanceM,
    duration_s: distanceM / 3,
    coverage: [coverage('COMPLETE')],
    context_tags: [],
    ...overrides,
  };
}

const passed = [];

function check(id, fn) {
  try {
    fn();
    passed.push(id);
    console.log(`ok - ${id}`);
  } catch (error) {
    console.error(`not ok - ${id}`);
    throw error;
  }
}

function run() {
  check('EVID-01', () => {
    const snapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      runs: [
        runRow(),
        runRow({
          id: 'run-garmin',
          distance_miles: 5,
          duration_seconds: 2402,
          health_source: 'garmin',
          health_start_at: '2026-08-10T11:02:30.000Z',
          health_end_at: '2026-08-10T11:42:32.000Z',
          workout_metrics_json: JSON.stringify({ distance_source: 'garmin', route_status: 'complete' }),
        }),
      ],
      lifts: [{
        id: 'lift-forge',
        user_id: ATHLETE_ID,
        date: '2026-08-09',
        category: 'strength',
        workout_duration_seconds: 2700,
        sets: 12,
        reps: 60,
        weight_lbs: 100,
        created_at: '2026-08-09T13:00:00.000Z',
      }],
      checkIns: [{
        id: 'checkin-forge',
        user_id: ATHLETE_ID,
        checkin_date: '2026-08-14',
        feeling: 4,
        legs: 3,
        drive: 4,
        sleep_hours: 7.5,
        life_flags: '[]',
        created_at: '2026-08-14T11:00:00.000Z',
      }],
      providerCoverage: [coverage('COMPLETE')],
    });
    assert.equal(snapshot.canonical_activities.length, 1);
    assert.equal(snapshot.canonical_activities[0].distance_m, Math.round(5.02 * MILE_M));
    assert.deepEqual([...snapshot.canonical_activities[0].evidence_ids].sort(), ['run-fit', 'run-garmin']);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(snapshot.evidence.some((item) => item.evidence_id === 'lift-forge' && item.value.activity_kind === 'lift'), true);
    assert.equal(snapshot.evidence.some((item) => item.evidence_id === 'checkin-forge' && item.evidence_type === 'subjective_readiness'), true);
    assert.equal(snapshot.evidence.some((item) => item.evidence_type === 'provider_coverage'), true);
    assert.match(snapshot.canonical_hash, /^sha256:[a-f0-9]{64}$/);
    const state = buildAthleteState({ snapshot, weeks: [] });
    const artifacts = buildEvidenceStateArtifacts({ snapshot, athleteState: state, decisionId: 'decision-evid-01' });
    assert.deepEqual(artifacts.map((artifact) => artifact.artifact_kind), ['evidence_snapshot', 'athlete_state']);
    assert.equal(artifacts[1].parent_artifact_id, artifacts[0].id);
  });

  check('EVID-02', () => {
    const snapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      runs: [runRow({ distance_miles: 5 })],
      corrections: [{
        id: 'correction-1',
        user_id: ATHLETE_ID,
        raw_evidence_kind: 'run',
        raw_evidence_ref: 'run-fit',
        revision: 1,
        corrected_canonical_value_json: { field: 'distance_m', value: 8200 },
        canonical_unit: 'm',
        reason_code: 'MANUAL_CORRECTION_APPLIED',
        reason: 'Measured course distance was verified.',
        attributed_by_user_id: ATHLETE_ID,
        supersedes_correction_id: null,
        created_at: '2026-08-11T12:00:00.000Z',
      }],
      providerCoverage: [coverage('COMPLETE')],
    });
    const raw = snapshot.evidence.find((item) => item.evidence_id === 'run-fit');
    assert.equal(raw.value.distance_m, Math.round(5 * MILE_M), 'raw observation remains unchanged');
    assert.equal(snapshot.canonical_activities[0].distance_m, 8200);
    assert.equal(snapshot.canonical_activities[0].correction_id, 'correction-1');
    assert.equal(snapshot.reason_codes.includes('MANUAL_CORRECTION_APPLIED'), true);
  });

  check('EVID-03', () => {
    const week = classifyCompletedWeek(normalWeek('2026-08-03', 0, {
      coverage: [coverage('PARTIAL')],
    }));
    assert.equal(week.classification, 'PARTIAL_WEEK');
    assert.equal(week.distance_m, null);
    assert.equal(week.reason_codes.includes('PARTIAL_SYNC'), true);
  });

  check('EVID-04', () => {
    const snapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      runs: [],
      providerCoverage: [coverage('FAILED_SYNC', { source_system: 'apple_health' })],
    });
    assert.deepEqual(snapshot.failed_sync_sources, ['apple_health']);
    assert.equal(snapshot.activity_summary.value_state, 'UNKNOWN');
    assert.equal(snapshot.activity_summary.value, null);
    const missingSnapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      runs: [runRow({
        id: 'run-missing',
        distance_miles: 5,
        duration_seconds: null,
        avg_heart_rate: null,
        perceived_effort: '',
      })],
      providerCoverage: [coverage('COMPLETE')],
    });
    const missing = missingSnapshot.evidence.find((item) => item.evidence_id === 'run-missing');
    assert.equal(missing.value.duration_s, null);
    assert.equal(missing.value.avg_heart_rate_bpm, null);
    assert.equal(missing.value.perceived_effort, null);
    assert.equal(missing.quality_state, 'PARTIAL');
  });

  check('EVID-05', () => {
    const snapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      runs: [],
      providerCoverage: [coverage('COMPLETE')],
    });
    assert.equal(snapshot.activity_summary.value_state, 'VALID_ZERO');
    assert.equal(snapshot.activity_summary.value, 0);
    assert.equal(snapshot.reason_codes.includes('VALID_ZERO_CONFIRMED'), true);
  });

  check('EVID-06', () => {
    const resolved = resolveHeartRateEvidence([
      { evidence_id: 'hr-fit', value: { median_bpm: 150, duration_coverage_pct: 96 }, quality_state: 'COMPLETE', source_system: 'fit' },
      { evidence_id: 'hr-garmin', value: { median_bpm: 158, duration_coverage_pct: 95 }, quality_state: 'COMPLETE', source_system: 'garmin' },
    ]);
    assert.equal(resolved.quality_state, 'CONFLICT');
    assert.equal(resolved.value, null);
    assert.equal(resolved.target_fallback, 'HR_RPE_FALLBACK');
    assert.equal(resolved.reason_codes.includes('EVIDENCE_CONFLICT_UNRESOLVED'), true);
    const missing = resolveHeartRateEvidence([
      { evidence_id: 'hr-missing', value: { median_bpm: null, duration_coverage_pct: '' }, quality_state: 'COMPLETE' },
    ]);
    assert.equal(missing.value_state, 'UNKNOWN');
    assert.equal(missing.value, null);
  });

  check('FRESH-01', () => {
    const result = resolvePerformanceEvidence([{
      evidence_id: 'threshold-old',
      evidence_type: 'threshold_evidence',
      observed_at: '2026-07-02T11:59:59.000Z',
      value: { pace_seconds_per_mile: 420 },
      quality_state: 'COMPLETE',
      value_state: 'KNOWN',
    }], PLANNING_INSTANT);
    assert.equal(result.threshold_pace_seconds_per_mile, null);
    assert.equal(result.reason_codes.includes('PACE_EVIDENCE_STALE'), true);
    assert.equal(result.fallback, 'HR_RPE_FALLBACK');
  });

  check('FRESH-02', () => {
    const snapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      painReports: [{
        id: 'pain-1',
        user_id: ATHLETE_ID,
        observed_at: '2026-08-01T12:00:00.000Z',
        pain_level: 'moderate',
        safety_action: 'MODIFY_IMPACT',
        safety_scope: ['running_impact'],
      }],
      providerCoverage: [coverage('COMPLETE')],
    });
    const state = buildAthleteState({ snapshot, weeks: [] });
    assert.equal(state.safety_action, 'MODIFY_IMPACT');
    assert.deepEqual(state.safety_scope, ['running_impact']);
    assert.equal(state.reconfirmation_requested, true);
    const readinessSnapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: PLANNING_INSTANT,
      timezone: TIMEZONE,
      checkIns: [{
        id: 'checkin-low',
        user_id: ATHLETE_ID,
        checkin_date: '2026-08-14',
        feeling: 1,
        legs: 1,
        drive: 1,
        created_at: '2026-08-14T11:00:00.000Z',
      }],
      providerCoverage: [coverage('COMPLETE')],
    });
    const readinessState = buildAthleteState({ snapshot: readinessSnapshot, weeks: [] });
    assert.equal(readinessState.recovery_state, 'RECOVERY');
    assert.deepEqual(readinessState.recovery_evidence_ids, ['checkin-low']);
  });

  check('LOAD-01', () => {
    const result = deriveRecentNormalRunning({
      weeks: [
        normalWeek('2026-07-06', 10000),
        normalWeek('2026-07-13', 20000),
        normalWeek('2026-07-20', 30000),
        normalWeek('2026-07-27', 40000),
      ],
      planningDateLocal: '2026-08-10',
      completedRuns: [
        { observed_at: '2026-08-09T12:00:00.000Z', distance_m: 15000 },
        { observed_at: '2026-08-02T12:00:00.000Z', distance_m: 15000 },
        { observed_at: '2026-07-26T12:00:00.000Z', distance_m: 15000 },
        { observed_at: '2026-07-20T12:00:00.000Z', distance_m: 15000 },
      ],
    });
    assert.equal(result.status, 'ESTABLISHED');
    assert.equal(result.median_distance_m, 25000);
    assert.equal(result.lower_bound_m, 17500);
    assert.equal(result.upper_bound_m, 32500);
    assert.equal(result.confidence, 'MEDIUM');
  });

  check('LOAD-02', () => {
    const result = classifyCompletedWeek(normalWeek('2026-08-10', 9000, { is_current: true }));
    assert.equal(result.classification, 'PARTIAL_WEEK');
    assert.equal(result.baseline_eligible, false);
    const missing = classifyCompletedWeek(normalWeek('2026-08-03', null, { duration_s: null }));
    assert.equal(missing.baseline_eligible, false);
    assert.equal(missing.distance_m, null);
    assert.equal(missing.duration_s, null);
    assert.equal(missing.reason_codes.includes('EVIDENCE_MISSING'), true);
  });

  check('LOAD-03', () => {
    const result = deriveRecentNormalRunning({
      weeks: [
        normalWeek('2026-06-15', 10000),
        normalWeek('2026-06-22', 12000),
        normalWeek('2026-06-29', 14000),
        normalWeek('2026-07-06', 16000, { context_tags: ['illness'] }),
        normalWeek('2026-07-13', 18000, { context_tags: ['taper'] }),
        normalWeek('2026-07-20', 20000, { context_tags: ['travel'] }),
      ],
      planningDateLocal: '2026-08-10',
      completedRuns: [
        { observed_at: '2026-08-09T12:00:00.000Z', distance_m: 10000 },
        { observed_at: '2026-08-02T12:00:00.000Z', distance_m: 10000 },
        { observed_at: '2026-07-26T12:00:00.000Z', distance_m: 10000 },
      ],
    });
    assert.equal(result.status, 'PROVISIONAL');
    assert.deepEqual(result.excluded_week_ids, ['2026-07-06', '2026-07-13', '2026-07-20']);
    assert.deepEqual(result.excluded_weeks.map((week) => week.reason_code), [
      'ILLNESS_CONTEXT', 'TAPER_CONTEXT', 'TRAVEL_CONTEXT',
    ]);
  });

  check('LOAD-04', () => {
    const historical = Math.round(25 * MILE_M);
    const result = deriveRecentNormalRunning({
      weeks: [0, 1, 2, 3, 4, 5].map((index) => normalWeek(`2026-0${index + 1}-05`, historical)),
      planningDateLocal: '2026-08-10',
      completedRuns: [
        { observed_at: '2026-07-19T12:00:00.000Z', distance_m: 4000 },
        { observed_at: '2026-07-18T12:00:00.000Z', distance_m: 4000 },
      ],
      completeDaysInSeedWindow: 28,
    });
    assert.equal(result.status, 'TRAINING_GAP');
    assert.equal(result.forward_load_seed_m, 2000);
    assert.notEqual(result.forward_load_seed_m, historical);
    assert.equal(result.reason_codes.includes('TRAINING_GAP_REBUILD'), true);
    const oldLowerBodyWeeks = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
    const recentAerobicWeeks = ['2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'];
    const crossModal = deriveCrossModalRecentNormal([
      ...oldLowerBodyWeeks.map((weekId) => ({
        week_id: weekId,
        end_date_local: weekId,
        classification: 'VALID_NORMAL_WEEK',
        modality_eligibility: { lower_body_muscular: { eligible: true }, aerobic: { eligible: true } },
        stress_dimensions: { lower_body_muscular: 5 },
      })),
      ...recentAerobicWeeks.map((weekId) => ({
        week_id: weekId,
        end_date_local: weekId,
        classification: 'VALID_NORMAL_WEEK',
        modality_eligibility: { lower_body_muscular: { eligible: true }, aerobic: { eligible: true } },
        stress_dimensions: { aerobic: 4 },
      })),
    ], { planningDateLocal: '2026-08-10' });
    assert.equal(crossModal.dimensions.lower_body_muscular.status, 'TRAINING_GAP');
    assert.equal(crossModal.dimensions.lower_body_muscular.median_sum, null);
    assert.equal(crossModal.dimensions.lower_body_muscular.historical_median_sum, 5);
    assert.equal(crossModal.dimensions.aerobic.status, 'ESTABLISHED');
  });

  check('TIME-01', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utcServer = localDateInTimezone('2026-08-14T01:30:00.000Z', 'America/Los_Angeles');
      process.env.TZ = 'Asia/Tokyo';
      const tokyoServer = localDateInTimezone('2026-08-14T01:30:00.000Z', 'America/Los_Angeles');
      assert.equal(utcServer, '2026-08-13');
      assert.equal(tokyoServer, utcServer);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  check('TIME-02', () => {
    const priorSnapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: '2026-08-14T05:30:00.000Z',
      timezone: 'America/Los_Angeles',
      providerCoverage: [coverage('COMPLETE')],
    });
    const prior = buildAthleteState({ snapshot: priorSnapshot, weeks: [] });
    const nextSnapshot = buildEvidenceSnapshot({
      athleteId: ATHLETE_ID,
      planningInstant: '2026-08-14T05:30:00.000Z',
      timezone: 'America/New_York',
      providerCoverage: [coverage('COMPLETE')],
    });
    const next = buildAthleteState({ snapshot: nextSnapshot, weeks: [], previousState: prior });
    assert.equal(prior.planning_date_local, '2026-08-13');
    assert.equal(next.planning_date_local, '2026-08-14');
    assert.equal(next.athlete_state_revision, 2);
    assert.equal(next.reason_codes.includes('TIMEZONE_REVISION'), true);
    assert.match(next.athlete_state_hash, /^sha256:[a-f0-9]{64}$/);
  });

  assert.deepEqual(passed, [
    'EVID-01', 'EVID-02', 'EVID-03', 'EVID-04', 'EVID-05', 'EVID-06',
    'FRESH-01', 'FRESH-02', 'LOAD-01', 'LOAD-02', 'LOAD-03', 'LOAD-04',
    'TIME-01', 'TIME-02',
  ]);
}

run();
