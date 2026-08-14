const assert = require('node:assert/strict');
const { buildRacePlanCandidate, semanticCandidateErrors } = require('../src/lib/racePlanCandidateEngine');
const { validateConcurrentPlan } = require('../src/lib/concurrentPlan');
const { addDays, daysBetween } = require('../src/lib/racePlanPolicy');
const { evaluateGoalBackwardFeasibility, evaluatePlanFeasibility } = require('../src/lib/planFeasibility');
const runWorkoutTaxonomy = require('../src/lib/runWorkoutTaxonomy');

const PLANNING_DATE = '2026-08-03';
const RACES = [
  { name: '5K', distance: 3.107, weeks: 8, establishedMiles: 15, establishedLong: 5, goalPace: 480 },
  { name: '10K', distance: 6.214, weeks: 10, establishedMiles: 18, establishedLong: 6, goalPace: 510 },
  { name: '10 Mile', distance: 10, weeks: 12, establishedMiles: 24, establishedLong: 8, goalPace: 525 },
  { name: 'Half Marathon', distance: 13.109, weeks: 14, establishedMiles: 28, establishedLong: 10, goalPace: 540 },
  { name: 'Marathon', distance: 26.219, weeks: 20, establishedMiles: 42, establishedLong: 18, goalPace: 570 },
];

function historyRows(weeklyMiles, longMiles) {
  const rows = [];
  for (let week = 1; week <= 6; week += 1) {
    const start = addDays(PLANNING_DATE, -7 * week);
    const easyMiles = Math.max(1, (weeklyMiles - longMiles) / 3);
    [easyMiles, easyMiles, easyMiles, longMiles].forEach((miles, index) => {
      rows.push({
        date: addDays(start, [0, 2, 4, 6][index]),
        distanceMiles: Number(miles.toFixed(2)),
        durationMinutes: Math.round(miles * 11),
        type: index === 3 ? 'long_aerobic' : 'easy_aerobic',
        intensityTrusted: true,
      });
    });
  }
  return rows;
}

function contextFor(race, tier, planMode) {
  const established = tier === 'established';
  const weeklyMiles = established ? race.establishedMiles : Math.max(6, race.establishedMiles * 0.45);
  const longMiles = established ? race.establishedLong : Math.max(2, race.establishedLong * 0.45);
  const liftDays = planMode === 'run_only' ? 0 : 2;
  const recentRuns = historyRows(weeklyMiles, longMiles);
  const goalTimeSeconds = Math.round(race.distance * race.goalPace);
  return {
    todayISO: PLANNING_DATE,
    profile: {
      weekly_miles_current: weeklyMiles,
      run_days_per_week: 4,
      lift_days_per_week: liftDays,
    },
    target: {
      raceId: race.name.toLowerCase().replaceAll(' ', '-'),
      raceName: race.name,
      raceDate: addDays(PLANNING_DATE, race.weeks * 7 - 1),
      distanceMiles: race.distance,
      goalType: 'pr',
      goalTimeSeconds,
      weeks: race.weeks,
      startDate: PLANNING_DATE,
      planMode,
      trainingDays: ['Mon', 'Wed', 'Fri', 'Sun'],
      runDaysPerWeek: 4,
      liftDaysPerWeek: liftDays,
      equipment: ['dumbbell', 'bench'],
    },
    history: {
      weeklyMileageBaseline: weeklyMiles,
      recentRunCount: recentRuns.length,
      recentRuns,
      performanceProfile: {
        targetAnchor: {
          distanceMiles: race.distance,
          equivalentTimeSeconds: Math.round(goalTimeSeconds * 1.02),
          equivalentPaceSecondsPerMile: Math.round(race.goalPace * 1.02),
          date: '2026-07-20',
          kind: 'race',
        },
      },
      acuteRunLoad: {
        latestRun: {
          date: '2026-07-26',
          distanceMiles: longMiles,
          paceSecondsPerMile: Math.round(race.goalPace * 1.18),
          isLong: true,
        },
      },
    },
    recovery: { state: 'normal', available: true, metrics: {} },
  };
}

function demandingDates(plan) {
  return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).filter((session) => session.kind === 'run' && (
      session.type === 'race'
      || (session.type === 'long' && session.workout_id === 'long_aerobic')
      || runWorkoutTaxonomy.isQualityWorkout(session.workout_id)
    )).map(() => day.date)
  ))).sort();
}

function assertDemandingSpacing(plan, label) {
  const dates = demandingDates(plan);
  for (let index = 1; index < dates.length; index += 1) {
    assert.ok(daysBetween(dates[index - 1], dates[index]) > 2, `${label}: demanding dates need two intervening dates`);
  }
  for (let index = 0; index + 2 < dates.length; index += 1) {
    assert.ok(daysBetween(dates[index], dates[index + 2]) > 6, `${label}: no more than two demanding sessions in seven days`);
  }
}

let assertions = 0;
for (const tier of ['conservative', 'established']) {
  for (const planMode of ['run_only', 'hybrid_maintain']) {
    for (const race of RACES) {
      const label = `${tier} ${planMode} ${race.name}`;
      const context = contextFor(race, tier, planMode);
      const first = buildRacePlanCandidate(context, { planningDateLocal: PLANNING_DATE });
      const second = buildRacePlanCandidate(context, { planningDateLocal: PLANNING_DATE });
      assert.deepEqual(second, first, `${label}: generation must be deterministic`);
      assert.deepEqual(semanticCandidateErrors(first.plan, context, PLANNING_DATE), [], `${label}: semantic invariants`);
      assert.equal(first.validation.valid, true, `${label}: candidate validation`);
      assert.deepEqual(validateConcurrentPlan(first.plan, context), { valid: true, errors: [] }, `${label}: legacy contract validation`);
      assertDemandingSpacing(first.plan, label);
      for (const week of first.plan.weeks) {
        const longRuns = week.days.flatMap((day) => day.sessions)
          .filter((session) => session.kind === 'run' && session.type === 'long' && session.workout_id === 'long_aerobic');
        assert.ok(longRuns.length <= 1, `${label}: at most one semantic long run per week`);
      }
      const goal = first.plan.goal_feasibilities[0];
      if (first.plan.overall_feasibility === 'supported') {
        assert.equal(goal.pace.status, 'supported', `${label}: supported pace evidence`);
        assert.equal(goal.workload.status, 'supported', `${label}: supported workload evidence`);
        assert.equal(goal.quality.status, 'supported', `${label}: supported quality exposure`);
      }
      if (tier === 'established') assert.equal(first.plan.overall_feasibility, 'supported', `${label}: established fixture should be supportable`);
      assertions += 1;
    }
  }
}

const noAnchor = contextFor(RACES[3], 'established', 'run_only');
delete noAnchor.history.performanceProfile;
const noAnchorCandidate = buildRacePlanCandidate(noAnchor, { planningDateLocal: PLANNING_DATE });
assert.notEqual(noAnchorCandidate.plan.overall_feasibility, 'supported', 'a timed PR goal without a performance anchor cannot be presented as supported');
assert.ok(noAnchorCandidate.plan.reasons.includes('NO_PERFORMANCE_ANCHOR'));
assertions += 2;

const originalGoalBackwardMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
try {
  const flagOffContext = {
    ...contextFor(RACES[0], 'established', 'run_only'),
    goalBackwardWorkloadInput: {
      sessions: [{ scheduled_local_date: PLANNING_DATE, workout_family: 'easy_run' }],
    },
    goalBackwardDecisionInput: {
      goal: { goal_id: 'v24-only', feasibility_status: 'not_currently_supported' },
      phase: 'EVENT_SPECIFIC_DEVELOPMENT',
      role_multiset: [{ role: 'PRIMARY_KEY', workout_family: 'interval_run' }],
    },
  };
  const candidate = buildRacePlanCandidate(flagOffContext, { planningDateLocal: PLANNING_DATE });
  delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  const missingFlag = evaluatePlanFeasibility(candidate.plan, flagOffContext);
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
  const explicitOff = evaluatePlanFeasibility(candidate.plan, flagOffContext);
  assert.deepEqual(explicitOff, missingFlag, 'missing and explicit off modes must remain byte-compatible');
  assert.equal(Object.hasOwn(explicitOff, 'goalBackwardWorkload'), false, 'flag-off result must retain the legacy shape');
  assert.equal(JSON.stringify(explicitOff).includes('not_currently_supported'), false, 'v2.4 feasibility states must not leak flag-off');
  assert.equal(JSON.stringify(explicitOff).includes('EVENT_SPECIFIC_DEVELOPMENT'), false, 'v2.4 phase states must not leak flag-off');
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'shadow';
  const shadow = evaluatePlanFeasibility(candidate.plan, flagOffContext);
  assert.equal(Object.hasOwn(shadow, 'goalBackwardWorkload'), true, 'active v2.4 modes expose workload evidence');
  assert.deepEqual(shadow.goalBackwardWorkload.weekly_stress.weekly_dimension_sum, [2, 2, 1, 0, 0, 1, 1, 0]);
  assert.equal(shadow.goalBackwardWorkload.valid, true);
  assertions += 7;
} finally {
  if (originalGoalBackwardMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  else process.env.FORGE_GOAL_BACKWARD_V24_MODE = originalGoalBackwardMode;
}

const directV24 = evaluateGoalBackwardFeasibility({
  goal: { goal_id: 'direct-v24', target_time_s: 1500 },
  current_status: 'unvalidated',
  target_observations: [],
  safe_forward_reaches_minimum_demand: false,
});
assert.equal(directV24.status, 'not_currently_supported');
assert.equal(directV24.target.target_time_s, 1500);
assertions += 2;

console.log(`PLAN FEASIBILITY SMOKE OK (${assertions} matrices/checks)`);
