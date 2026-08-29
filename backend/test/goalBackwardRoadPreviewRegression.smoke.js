#!/usr/bin/env node

const assert = require('node:assert/strict');

const concurrentPlan = require('../src/lib/concurrentPlan');
const plansRouter = require('../src/routes/plans');
const { HARD_VALIDATOR_NAMES } = require('../src/lib/goalBackwardValidators');
const { canonicalHash } = require('../src/lib/racePlanPolicy');

const EVENT_DATE = '2026-10-11';
const TIMEZONE = 'America/New_York';
const TRAINING_DAYS = Object.freeze(['Tue', 'Thu', 'Sat', 'Sun']);
const FULL_GYM_EQUIPMENT = Object.freeze(['barbell', 'dumbbell', 'rack', 'bench']);
const BASELINE_MILES = 20;
const BASELINE_RUNNING_M = Math.round(BASELINE_MILES * 1609.344);
const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
  'interval_run', 'race_rhythm_run', 'assessment', 'race',
]);

function addDays(localDate, count) {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function weekday(localDate) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(`${localDate}T12:00:00.000Z`).getUTCDay()
  ];
}

function completeRunLoadInput() {
  const weeks = ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17'];
  return {
    load_input_state: 'COMPLETE',
    load_input_confidence: 'HIGH',
    recent_normal_confidence: 'MEDIUM',
    recent_normal_eligible_week_count: weeks.length,
    recent_normal_weeks: weeks.map((weekStart) => ({
      week_start_local: weekStart,
      eligible: true,
      distance_m: BASELINE_RUNNING_M,
    })),
    recent_normal: {
      status: 'ESTABLISHED',
      confidence: 'MEDIUM',
      eligible_week_count: weeks.length,
      median_distance_m: BASELINE_RUNNING_M,
      lower_bound_m: BASELINE_RUNNING_M,
      upper_bound_m: BASELINE_RUNNING_M,
    },
    windows: [],
    unresolved_conflicts: [],
    reason_codes: [],
    load_input_hash: `sha256:${'a'.repeat(64)}`,
  };
}

function insufficientRunLoadInput() {
  return {
    load_input_state: 'UNKNOWN',
    load_input_confidence: 'INSUFFICIENT',
    recent_normal_confidence: 'INSUFFICIENT',
    recent_normal_eligible_week_count: 0,
    recent_normal_weeks: [],
    recent_normal: {
      status: 'INSUFFICIENT',
      confidence: 'INSUFFICIENT',
      eligible_week_count: 0,
      median_distance_m: null,
      lower_bound_m: null,
      upper_bound_m: null,
    },
    windows: [],
    unresolved_conflicts: [],
    reason_codes: ['EVIDENCE_UNKNOWN'],
    load_input_hash: `sha256:${'b'.repeat(64)}`,
  };
}

function buildScenario({
  ownerId = 'road-preview-regression-owner',
  planningDate = '2026-08-31',
  liftDaysPerWeek = 4,
  evidence = 'complete',
} = {}) {
  const raceWindow = concurrentPlan.racePlanWindow(EVENT_DATE, planningDate);
  assert.ok(raceWindow, 'the Army event must have a valid production planning window');
  const race = {
    id: 'army-ten-miler-2026',
    user_id: ownerId,
    race_name: 'Army 10-Miler',
    race_date: EVENT_DATE,
    event_local_date: EVENT_DATE,
    event_timezone: TIMEZONE,
    event_kind: 'run_race',
    event_revision: 2,
    goal_revision: 3,
    status: 'upcoming',
    distance_miles: 10,
    goal_time_seconds: 5340,
  };
  const target = {
    raceId: race.id,
    raceName: race.race_name,
    raceDate: race.race_date,
    distanceMiles: race.distance_miles,
    goalTimeSeconds: race.goal_time_seconds,
    goalType: 'pr',
    raceTargets: [{
      raceId: race.id,
      raceName: race.race_name,
      raceDate: race.race_date,
      distanceMiles: race.distance_miles,
      goalTimeSeconds: race.goal_time_seconds,
      goalType: 'pr',
    }],
    weeks: raceWindow.weeks,
    startDate: raceWindow.startDate,
    todayISO: planningDate,
    nowISO: `${planningDate}T12:00:00.000Z`,
    planMode: 'hybrid_maintain',
    trainingDays: [...TRAINING_DAYS],
    runDaysPerWeek: 4,
    liftDaysPerWeek,
    liftingEnabled: true,
    equipment: [...FULL_GYM_EQUIPMENT],
  };
  const evidenceComplete = evidence === 'complete';
  const runLoadInput = evidenceComplete ? completeRunLoadInput() : insufficientRunLoadInput();
  const context = {
    profile: {
      id: ownerId,
      timezone: TIMEZONE,
      training_age_class: 'ESTABLISHED',
      weekly_miles_current: BASELINE_MILES,
      run_days_per_week: 4,
      lift_days_per_week: liftDaysPerWeek,
    },
    target,
    history: {
      weeklyMileageBaseline: BASELINE_MILES,
      mileageBaseline: {
        observedLowerBoundWeeklyMiles: evidenceComplete ? BASELINE_MILES : null,
      },
      recentRunCount: evidenceComplete ? 16 : 2,
      runLoadInput,
      acuteRunLoad: {
        latestRun: evidenceComplete ? { paceSecondsPerMile: 600 } : null,
        currentWeek: {
          startDate: concurrentPlan.racePlanWindow(planningDate, planningDate).startDate,
          miles: 0,
          knownDistanceLowerBoundMiles: 0,
          runCount: 0,
          runDates: [],
          distanceState: 'KNOWN',
          unknownDistanceRunCount: 0,
          longRunCompleted: false,
        },
      },
      previousTwoWeeksPassed: true,
      modalityHistory: {},
    },
    recovery: { state: 'NORMAL' },
    safety: { activeInjury: false },
  };
  const built = plansRouter._test.buildDeterministicCandidate(context, {
    planningDateLocal: planningDate,
  });
  assert.equal(built.validation.valid, true,
    'the real deterministic road generator must produce a valid source plan');
  const planningConstraints = {
    locks: [],
    manual_edits: [],
    lock_revision: 0,
    edit_revision: 0,
    constraint_fingerprint: null,
  };
  const state = {
    target,
    context,
    races: [race],
    inputHash: `sha256:${canonicalHash({
      ownerId, planningDate, race, target, runLoadInput, planningConstraints,
    })}`,
    planningInputRevision: 1,
    planningConstraints,
    active: null,
    activePlan: null,
    request: {
      race_ids: [race.id],
      planning_date_local: planningDate,
      timezone_offset_minutes: 240,
    },
  };
  const result = plansRouter._test.computeGoalBackwardShadowDiagnostics({
    userId: ownerId,
    state,
    built,
    planningDateLocal: planningDate,
  });
  const applicable = plansRouter._test.applicableGoalBackwardPlan(built.plan, result);
  return { applicable, built, context, evidence, liftDaysPerWeek, ownerId, planningDate, result };
}

function materialDoseReceipt(candidate) {
  return candidate.validation.validator_results.find((entry) => (
    entry.validator === 'material_dose'
  ))?.receipt || null;
}

function assertHardValidArmySelection(scenario, label) {
  const { applicable, built, liftDaysPerWeek, result } = scenario;
  const selected = result.selected_candidate;
  assert.ok(selected, `${label} must select a deterministic candidate`);
  assert.equal(selected.validation.valid, true, label);
  assert.deepEqual(
    selected.validation.validator_results.map((entry) => entry.validator),
    HARD_VALIDATOR_NAMES,
    label,
  );
  assert.equal(selected.validation.validator_results.every((entry) => entry.valid), true,
    `${label} must pass every hard validator`);
  const running = selected.canonical_sessions.filter((session) => (
    RUNNING_FAMILIES.has(session.workout_family)
  ));
  assert.equal(running.length, 4, `${label} must retain four requested run exposures`);
  assert.equal(new Set(running.map((session) => session.scheduled_local_date)).size, 4,
    `${label} must place the runs on four distinct days`);
  assert.equal(running.every((session) => (
    TRAINING_DAYS.includes(weekday(session.scheduled_local_date))
  )), true, `${label} must use only Tue/Thu/Sat/Sun`);
  const requiredSpecific = running.find((session) => (
    session.requirement_id === 'road_endurance_specific'
  ));
  assert.ok(requiredSpecific, `${label} must include the required road-endurance exposure`);
  assert.ok(['race_rhythm_run', 'threshold_run'].includes(requiredSpecific.workout_family), label);
  assert.ok(requiredSpecific.derived_totals.distance_m > 0,
    `${label} must carry an authoritative running dose into canonical quality material`);
  assert.ok(requiredSpecific.derived_totals.work_duration_s >= 8 * 60,
    `${label} must remain above the quality presentation floor`);
  const dose = materialDoseReceipt(selected);
  assert.equal(dose?.valid, true, `${label} must satisfy the recent-load material contract`);
  assert.ok(dose.candidate_running_m >= result.required_running_dose_receipt.required_running_m,
    `${label} must satisfy the normalized preservation floor`);
  assert.ok(applicable, `${label} must apply through applicableGoalBackwardPlan`);
  assert.equal(applicable.selected_candidate_hash, selected.candidate_hash, label);
  assert.equal(applicable.strengthPolicy.sessionsPerWeek, liftDaysPerWeek,
    `${label} must retain the requested lifting policy`);
  assert.equal(built.plan.strengthPolicy.sessionsPerWeek, liftDaysPerWeek, label);
  assert.deepEqual(built.plan.strengthPolicy.equipment, FULL_GYM_EQUIPMENT, label);
  const sourceWindowEnd = addDays(scenario.planningDate, 6);
  const sourceDays = built.plan.weeks.flatMap((week) => week.days || []).filter((day) => (
    day.date >= scenario.planningDate && day.date <= sourceWindowEnd
  ));
  const sameDayRunLift = sourceDays.filter((day) => (
    day.sessions.some((session) => session.kind === 'run')
      && day.sessions.some((session) => session.kind === 'lift')
  ));
  assert.equal(sameDayRunLift.every((day) => (
    day.orderGuidance === 'Run first; lift at least 6 hours later.'
  )), true, `${label} must retain the source generator's run/lift interference guidance`);
}

function run() {
  const exact = buildScenario();
  assert.equal(exact.result.decision.phase, 'EVENT_SPECIFIC_DEVELOPMENT');
  assert.ok(exact.result.decision.reason_codes.includes('EVENT_SPECIFIC_ENTRY'));
  assert.ok(exact.result.decision.reason_codes.includes('ASSESSMENT_REQUIRED'));
  assertHardValidArmySelection(exact, 'exact Army 10-Miler four-run/four-lift preview');

  const secondOwner = buildScenario({ ownerId: 'road-preview-regression-owner-2' });
  assertHardValidArmySelection(secondOwner, 'same evidence for a second synthetic owner');
  assert.equal(secondOwner.result.decision.active_goals[0].athlete_id, secondOwner.ownerId);

  const saturday = buildScenario({ planningDate: '2026-08-29' });
  assertHardValidArmySelection(saturday, 'Saturday planning replay');
  assert.equal(saturday.result.search_diagnostics.available_day_count, 4);

  const twoLiftDays = buildScenario({ liftDaysPerWeek: 2 });
  assertHardValidArmySelection(twoLiftDays, 'two-lift-day preview');
  assert.equal(twoLiftDays.built.plan.weeks[0].days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'lift').length, 2);
  assert.equal(exact.built.plan.weeks[0].days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'lift').length, 4);

  const unsafe = buildScenario({ evidence: 'insufficient' });
  assert.equal(unsafe.result.selected_candidate, null,
    'insufficient canonical evidence must fail closed');
  assert.equal(unsafe.applicable, null, 'unsafe evidence cannot produce an applicable mutation');
  assert.ok(unsafe.result.candidates.length > 0);
  assert.equal(unsafe.result.candidates.every((candidate) => (
    candidate.validation.validator_results.some((entry) => (
      entry.validator === 'material_dose'
        && entry.valid === false
        && entry.violations.some((violation) => (
          violation.code === 'RECENT_NORMAL_INSUFFICIENT'
            && violation.reason === 'MATERIAL_DOSE_COMPARATOR_UNKNOWN'
        ))
    ))
  )), true, 'unsafe evidence must expose the specific fail-closed material reason');

  const replay = buildScenario();
  assert.equal(
    JSON.stringify({ result: replay.result, applicable: replay.applicable }),
    JSON.stringify({ result: exact.result, applicable: exact.applicable }),
    'deterministic replay must be byte-identical',
  );

  console.log('GOAL BACKWARD ROAD PREVIEW REGRESSION SMOKE OK (7 scenarios)');
}

if (require.main === module) run();

module.exports = { run };
