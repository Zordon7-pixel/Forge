const assert = require('node:assert/strict');
const fixture = require('./fixtures/racePlanQuality.2026-08-07.json');
const {
  buildConcurrentPlan,
  validateConcurrentPlan,
} = require('../src/lib/concurrentPlan');
const { buildRacePlanCandidate } = require('../src/lib/racePlanCandidateEngine');
const planSchema = require('../src/lib/planSchema');
const trainingEvidence = require('../src/lib/trainingEvidence');
const {
  RACE_PLAN_POLICY_V1,
  acceptPlanningClock,
  canonicalHash,
  firstFullMonday,
  longRunIdentityFloor,
  peakLongRunDemand,
  requiredPeakWeeklyMiles,
  taperWeeksForDistance,
} = require('../src/lib/racePlanPolicy');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runSummary(plan) {
  return (plan.weeks?.[0]?.days || [])
    .flatMap((day) => (day.sessions || []).map((session) => ({
      date: day.date,
      type: session.type,
      workout_id: session.workout_id,
      miles: session.distance_miles,
      min: session.duration_min,
    })))
    .filter((session) => session.type !== 'strength');
}

function semanticLongRunErrors(plan) {
  const errors = [];
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    for (const [dayIndex, day] of (week.days || []).entries()) {
      for (const [sessionIndex, session] of (day.sessions || []).entries()) {
        if (session.type !== 'long' && session.workout_id !== 'long_aerobic') continue;
        if (Number(session.distance_miles || 0) < 2) {
          errors.push({
            code: 'LONG_SEMANTIC_MINIMUM',
            path: `weeks[${weekIndex}].days[${dayIndex}].sessions[${sessionIndex}]`,
          });
        }
      }
    }
  }
  return errors;
}

function semanticLongRunMiles(plan) {
  const miles = [];
  for (const week of plan.weeks || []) {
    for (const day of week.days || []) {
      for (const session of day.sessions || []) {
        if (session.type === 'long' || session.workout_id === 'long_aerobic') {
          miles.push(Number(session.distance_miles || 0));
        }
      }
    }
  }
  return miles;
}

const plan = buildConcurrentPlan(clone(fixture));
const validation = validateConcurrentPlan(plan, clone(fixture));
const summary = runSummary(plan);

if (process.argv.includes('--semantic-acceptance')) {
  const acceptanceContext = clone(fixture);
  acceptanceContext.history.recentRuns = [
    { date: '2026-07-13', distanceMiles: 4, durationMinutes: 42, type: 'easy' },
    { date: '2026-07-15', distanceMiles: 4, durationMinutes: 41, type: 'easy' },
    { date: '2026-07-18', distanceMiles: 8, durationMinutes: 86, type: 'long' },
    { date: '2026-07-20', distanceMiles: 4, durationMinutes: 40, type: 'easy' },
    { date: '2026-07-22', distanceMiles: 5, durationMinutes: 51, type: 'easy' },
    { date: '2026-07-25', distanceMiles: 9, durationMinutes: 95, type: 'long' },
  ];
  acceptanceContext.history.mileageBaseline = {
    method: 'bounded_recent_history',
    meaningfulRunCount: acceptanceContext.history.recentRuns.length,
  };
  const candidate = buildRacePlanCandidate(acceptanceContext, {
    planningDateLocal: fixture.todayISO,
    timezoneOffsetMinutes: 240,
  });
  const noRaceContext = clone(fixture);
  delete noRaceContext.target.raceId;
  delete noRaceContext.target.raceName;
  delete noRaceContext.target.raceDate;
  delete noRaceContext.target.raceTargets;
  delete noRaceContext.target.goalTimeSeconds;
  noRaceContext.target.goalType = 'completion';
  const noRaceCandidate = buildRacePlanCandidate(noRaceContext, {
    planningDateLocal: fixture.todayISO,
    timezoneOffsetMinutes: 240,
  });
  assert.equal(noRaceCandidate.validation.valid, true, 'non-race training blocks remain structurally valid');
  assert.equal(noRaceCandidate.plan.overall_feasibility, 'not_applicable', 'non-race blocks are explicit rather than misclassified as unsafe');
  const longRunMiles = semanticLongRunMiles(candidate.plan);
  assert.ok(longRunMiles.length >= 2, 'evidence-backed race plans retain multiple long-run sessions');
  assert.ok(Math.max(...longRunMiles) > longRunMiles[0], 'long-run demand progresses beyond its first scheduled long run');
  const errors = [...semanticLongRunErrors(candidate.plan), ...candidate.validation.errors];
  if (errors.length) {
    console.error(`RACE PLAN QUALITY ACCEPTANCE RED: ${errors[0].code} at ${errors[0].path || errors[0].message || 'candidate'}`);
    process.exitCode = 1;
  } else {
    const bridgeRuns = runSummary(candidate.plan);
    assert.deepEqual(bridgeRuns, [
      { date: '2026-08-07', type: 'quality', workout_id: 'strides', miles: 1.3, min: 35 },
      { date: '2026-08-09', type: 'easy', workout_id: 'easy_aerobic', miles: 0.9, min: 10 },
    ]);
    assert.equal(candidate.plan.weeks[0].bridgeWeek, true);
    assert.equal(candidate.plan.weeks[0].weekLabel, 'Bridge Week');
    assert.equal(candidate.plan.weeks[1].fullWeekFloorRestored, true);
    assert.equal(candidate.plan.weeks[1].days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run').length, 4);
    const lowData = clone(fixture);
    delete lowData.history.acuteRunLoad.currentWeek;
    const friday = buildRacePlanCandidate(lowData, { planningDateLocal: '2026-08-07', timezoneOffsetMinutes: 240 });
    const sunday = buildRacePlanCandidate(lowData, { planningDateLocal: '2026-08-09', timezoneOffsetMinutes: 240 });
    assert.equal(friday.plan.weeks[0].bridgeWeek, true);
    assert.equal(sunday.plan.weeks[0].bridgeWeek, true);
    assert.equal(friday.plan.bridgeWeek.firstFullWeekStart, '2026-08-10');
    assert.equal(sunday.plan.bridgeWeek.firstFullWeekStart, '2026-08-10');
    assert.equal(friday.plan.weeks[0].days.filter((day) => day.date < '2026-08-07').every((day) => day.sessions.length === 0), true);
    assert.equal(sunday.plan.weeks[0].days.filter((day) => day.date < '2026-08-09').every((day) => day.sessions.length === 0), true);
    console.log('RACE PLAN QUALITY ACCEPTANCE OK');
  }
} else {
  assert.deepEqual(summary, [
    { date: '2026-08-07', type: 'quality', workout_id: 'strides', miles: 1.3, min: 35 },
    { date: '2026-08-09', type: 'long', workout_id: 'long_aerobic', miles: 0.9, min: 30 },
  ]);
  assert.deepEqual(validation, { valid: true, errors: [] });

  const variants = [
    ['low-data', { history: { ...fixture.history, weeklyMileageBaseline: 4, recentRunCount: 2 } }],
    ['no-data', { history: {} }],
    ['established', { history: { ...fixture.history, weeklyMileageBaseline: 35, recentRunCount: 30 } }],
    ['comeback', { safety: { comebackMode: true, activeInjury: true } }],
    ['dual-race', {}],
  ];
  for (const [name, patch] of variants) {
    const context = clone(fixture);
    Object.assign(context, clone(patch));
    const generated = buildConcurrentPlan(context);
    assert.equal(Array.isArray(generated.weeks), true, `${name} fixture should generate weeks`);
  }

  const canonicalSession = {
    id: 'session-round-trip',
    kind: 'run',
    type: 'quality',
    workout_type: 'run',
    workout_id: 'race_pace_intervals',
    workout_family: 'race_pace',
    goal_pace_seconds_per_mile: 540,
    goal_pace_label: '9:00/mi',
    quality_prescription: {
      repetitions: 3,
      work: { duration_seconds: 480, pace_source: 'race' },
      recovery: { duration_seconds: 180, pace_source: 'easy' },
    },
    prescription: {
      warmup: [{ kind: 'run', duration_seconds: 720, pace_source: 'easy' }],
      segments: [{ kind: 'work', repeats: 3, duration_seconds: 480, pace_source: 'race' }],
      cooldown: [{ kind: 'run', duration_seconds: 600, pace_source: 'easy' }],
    },
    distance_miles: 6.2,
    duration_min: 64,
    distance_is_estimate: false,
    durationIsEstimated: false,
    anchorState: 'anchored',
    purpose: 'Practice goal pace under control.',
    evidence_refs: ['elite_periodization'],
    reason_codes: ['PACE_EQUIVALENCY_USED'],
    safety_annotations: [{ code: 'LOWER_BODY_SEPARATION', active: true }],
    completion_ref: 'completion-1',
    future_engine_field: { nested: ['preserved'] },
    access_token: 'must-not-survive',
  };
  const normalizedOnce = planSchema.normalizeSession(canonicalSession);
  const normalizedTwice = planSchema.normalizeSession(JSON.parse(JSON.stringify(normalizedOnce)));
  assert.deepEqual(normalizedTwice, normalizedOnce, 'canonical session normalization must be lossless and stable');
  assert.deepEqual(normalizedOnce.future_engine_field, { nested: ['preserved'] });
  assert.equal(Object.hasOwn(normalizedOnce, 'access_token'), false, 'explicit secret denylist must be enforced');

  assert.equal(Object.isFrozen(RACE_PLAN_POLICY_V1), true);
  assert.equal(taperWeeksForDistance(6.214), 1);
  assert.equal(taperWeeksForDistance(13.109), 2);
  assert.equal(taperWeeksForDistance(26.219), 3);
  assert.equal(longRunIdentityFloor(10), 5);
  assert.equal(peakLongRunDemand(13.109, 'pr'), 10);
  assert.equal(requiredPeakWeeklyMiles(13.109, 'pr'), 22.5);
  assert.equal(firstFullMonday('2026-08-07', []), '2026-08-10');
  assert.equal(firstFullMonday('2026-08-09', []), '2026-08-10');
  assert.equal(firstFullMonday('2026-08-10', []), '2026-08-10');
  assert.equal(firstFullMonday('2026-08-10', ['2026-08-10']), '2026-08-17');
  assert.deepEqual(
    acceptPlanningClock({ planningDateLocal: '2026-08-07', timezoneOffsetMinutes: 840 }, '2026-08-08'),
    { valid: true, planningDateLocal: '2026-08-07', timezoneOffsetMinutes: 840 }
  );
  assert.deepEqual(
    acceptPlanningClock({ planningDateLocal: '2026-08-09', timezoneOffsetMinutes: -840 }, '2026-08-08'),
    { valid: true, planningDateLocal: '2026-08-09', timezoneOffsetMinutes: -840 }
  );
  assert.deepEqual(
    acceptPlanningClock({ planningDateLocal: '2026-08-08' }, '2026-08-08'),
    { valid: false, reason: 'INVALID_TIMEZONE_OFFSET' },
    'missing phone timezone authority fails closed'
  );
  assert.deepEqual(
    acceptPlanningClock({ planningDateLocal: '2026-08-08', timezoneOffsetMinutes: '' }, '2026-08-08'),
    { valid: false, reason: 'INVALID_TIMEZONE_OFFSET' },
    'blank phone timezone authority fails closed'
  );
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
  assert.deepEqual(trainingEvidence.validateRegistry(), { valid: true, errors: [] });

  console.log('RACE PLAN QUALITY CHARACTERIZATION OK (5 variants + exact regression + P1 policy/schema)');
}

module.exports = { semanticLongRunErrors };
