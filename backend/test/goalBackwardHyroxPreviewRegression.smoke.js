#!/usr/bin/env node

const assert = require('node:assert/strict');

process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';

const plansRouter = require('../src/routes/plans');
const {
  MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
  MAX_GOAL_BACKWARD_SEARCH_NODES,
} = require('../src/lib/racePlanCandidateEngine');
const { HARD_VALIDATOR_NAMES } = require('../src/lib/goalBackwardValidators');
const {
  acceptPlanningClock,
  canonicalHash,
  eventPolicyFor,
} = require('../src/lib/racePlanPolicy');

const PLANNING_DATE = '2026-08-21';
const TIMEZONE = 'America/New_York';
const TIMEZONE_OFFSET_MINUTES = 240;
const EVENT_DATE = '2026-09-06';
const BASELINE_RUNNING_M = Math.round(16 * 1609.344);
const DEVELOPMENT_FLOOR_FACTOR = 0.85;
const REQUIRED_RUNNING_M = 21887;
const TRAINING_DAYS = Object.freeze(['Tue', 'Thu', 'Sat', 'Sun']);
const HYROX_EQUIPMENT = Object.freeze([]);

function validatorResult(candidate, validator) {
  return candidate?.validation?.validator_results?.find((entry) => entry.validator === validator) || null;
}

function candidateRunningDose(candidate) {
  return validatorResult(candidate, 'material_dose')?.receipt?.candidate_running_m ?? null;
}

function selectedSchedule(result) {
  return result.selected_candidate?.canonical_sessions?.map((session) => ({
    session_id: session.session_id,
    scheduled_local_date: session.scheduled_local_date,
    workout_family: session.workout_family,
    content_hash: session.content_hash,
    derived_totals: session.derived_totals,
  })) || null;
}

function compactDiagnostic(result) {
  const runningDoses = [...new Set(result.candidates.map(candidateRunningDose))];
  const floorViolations = [...new Set(result.candidates.flatMap((candidate) => (
    candidate.validation.violations
      .filter((violation) => violation.reason === 'WEEKLY_RUNNING_FLOOR')
      .map((violation) => `${violation.proposed_running_m}/${violation.required_running_m}`)
  )))];
  return {
    selected: result.selected_candidate?.candidate_hash || null,
    retained: result.candidates.length,
    running_m: runningDoses,
    floor_m: result.decision.minimum_weekly_demand.running_m,
    weekly_floor: floorViolations,
    search: {
      expanded: result.search_diagnostics.expanded_node_count,
      leaves: result.search_diagnostics.generated_leaf_count,
      retained: result.search_diagnostics.retained_candidate_count,
    },
  };
}

function generateDiagnostics(goalTimeSeconds, options = {}) {
  const clock = acceptPlanningClock({
    planning_date_local: PLANNING_DATE,
    timezone_offset_minutes: TIMEZONE_OFFSET_MINUTES,
  }, PLANNING_DATE);
  assert.deepEqual(clock, {
    valid: true,
    planningDateLocal: PLANNING_DATE,
    timezoneOffsetMinutes: TIMEZONE_OFFSET_MINUTES,
  });

  const race = {
    id: 'hyrox-september-6',
    race_name: 'Hyrox DC',
    race_date: EVENT_DATE,
    event_local_date: EVENT_DATE,
    event_timezone: TIMEZONE,
    location: 'Washington DC',
    event_kind: 'hyrox',
    event_format: 'individual_open',
    event_category: 'men',
    goal_time_seconds: goalTimeSeconds,
    status: 'upcoming',
  };
  const target = {
    planMode: 'hyrox_build',
    runDaysPerWeek: 4,
    trainingDays: [...TRAINING_DAYS],
    liftingEnabled: true,
    hyroxEquipment: [...HYROX_EQUIPMENT],
    hyroxEvent: {
      raceId: race.id,
      name: race.race_name,
      eventLocalDate: race.event_local_date,
      eventTimezone: race.event_timezone,
      format: race.event_format,
      category: race.event_category,
      rulesVersion: '2026-2027',
      goalTimeSeconds,
      runningPriority: 'maintain',
    },
  };
  const currentWeek = {
    startDate: '2026-08-17',
    miles: 10,
    distanceState: 'KNOWN',
    knownDistanceLowerBoundMiles: 10,
    unknownDistanceRunCount: 0,
    runCount: 2,
    runDates: ['2026-08-18', '2026-08-20'],
    longRunCompleted: false,
    ...(options.currentWeek || {}),
  };
  const history = {
    weeklyMileageBaseline: 16,
    mileageBaseline: { observedLowerBoundWeeklyMiles: 16 },
    recentRunCount: 8,
    acuteRunLoad: {
      latestRun: { paceSecondsPerMile: 600 },
      currentWeek,
    },
    runLoadInput: {
      load_input_state: 'COMPLETE',
      load_input_confidence: 'HIGH',
      recent_normal_confidence: 'HIGH',
      recent_normal: {
        status: 'ESTABLISHED',
        median_distance_m: BASELINE_RUNNING_M,
      },
      windows: [],
      unresolved_conflicts: [],
      reason_codes: [],
    },
    previousTwoWeeksPassed: true,
    modalityHistory: {},
  };
  const context = {
    profile: {
      id: 'hyrox-preview-regression-athlete',
      timezone: TIMEZONE,
      training_age_class: 'ESTABLISHED',
    },
    target,
    history,
    recovery: { state: 'NORMAL' },
    safety: { activeInjury: false },
  };
  const built = plansRouter._test.buildDeterministicCandidate(context, {
    planningDateLocal: clock.planningDateLocal,
  });
  assert.equal(built.validation.valid, true, 'the production HYROX generator must produce a valid source plan');

  const active = options.activePlan === false ? null : {
    source: 'assigned',
    row: {
      id: 'active-hyrox-plan',
      user_plan_id: 'active-hyrox-assignment',
      plan_version: 1,
      plan_json: JSON.stringify(built.plan),
      plan_data: JSON.stringify(built.plan),
    },
  };
  const activePlan = active ? {
    planVersion: 1,
    trainingPlanId: active.row.id,
    userPlanId: active.row.user_plan_id,
  } : null;

  const state = {
    target,
    context,
    races: [race],
    inputHash: `sha256:${canonicalHash({ clock, race, target })}`,
    planningInputRevision: 1,
    planningConstraints: {
      locks: [],
      manual_edits: [],
      lock_revision: 0,
      edit_revision: 0,
      constraint_fingerprint: null,
    },
    active,
    activePlan,
    request: {
      race_ids: [race.id],
      planning_date_local: clock.planningDateLocal,
      timezone_offset_minutes: clock.timezoneOffsetMinutes,
    },
  };
  const result = plansRouter._test.computeGoalBackwardShadowDiagnostics({
    userId: context.profile.id,
    state,
    built,
    planningDateLocal: clock.planningDateLocal,
  });
  return { built, result };
}

function assertBoundedHardValidSelection(result, label) {
  const diagnostic = compactDiagnostic(result);
  assert.ok(result.candidates.length > 0, `${label} must retain bounded candidates`);
  assert.ok(
    result.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES,
    `${label} must respect the node bound`,
  );
  assert.ok(
    result.search_diagnostics.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
    `${label} must respect the frontier bound`,
  );
  assert.ok(
    result.selected_candidate,
    `${label} must select a hard-valid candidate; diagnostic=${JSON.stringify(diagnostic)}`,
  );

  const hardResults = result.selected_candidate.validation.validator_results;
  assert.deepEqual(hardResults.map((entry) => entry.validator), HARD_VALIDATOR_NAMES, label);
  assert.equal(hardResults.every((entry) => entry.valid), true, `${label} must pass every real hard validator`);
  assert.equal(result.selected_candidate.validation.valid, true, label);
  assert.ok(candidateRunningDose(result.selected_candidate) >= REQUIRED_RUNNING_M, label);
  assert.equal(result.selected_candidate.validation.violations.some((violation) => (
    violation.reason === 'WEEKLY_RUNNING_FLOOR'
  )), false, label);
}

function run() {
  const blankScenario = generateDiagnostics(null);
  const supportedTimeScenario = generateDiagnostics(3600);
  const replayScenario = generateDiagnostics(null);
  const blank = blankScenario.result;
  const supportedTime = supportedTimeScenario.result;
  const replay = replayScenario.result;

  const hyroxPolicy = eventPolicyFor('hyrox_singles_v1');
  assert.equal(hyroxPolicy.phase_running_floor_factor.DEVELOPMENT, DEVELOPMENT_FLOOR_FACTOR);
  assert.equal(Math.floor(BASELINE_RUNNING_M * DEVELOPMENT_FLOOR_FACTOR), REQUIRED_RUNNING_M);
  for (const result of [blank, supportedTime, replay]) {
    assert.equal(result.decision.phase, 'DEVELOPMENT');
    assert.equal(result.decision.minimum_weekly_demand.running_m, REQUIRED_RUNNING_M);
  }

  assertBoundedHardValidSelection(blank, 'blank goal time');
  assertBoundedHardValidSelection(supportedTime, 'supported 60-minute goal time');
  assertBoundedHardValidSelection(replay, 'blank goal time replay');
  for (const [label, scenario] of [
    ['blank goal time', blankScenario],
    ['supported 60-minute goal time', supportedTimeScenario],
  ]) {
    const applicable = plansRouter._test.applicableGoalBackwardPlan(
      scenario.built.plan,
      scenario.result,
    );
    assert.ok(applicable, `${label} must remain applicable on the real preview replacement path`);
    assert.equal(applicable.goal_backward_engine_version, 'goal-backward-coaching-v2.4');
    const materialDose = validatorResult(scenario.result.selected_candidate, 'material_dose')?.receipt;
    assert.ok(materialDose?.completed_running_credit, JSON.stringify(materialDose));
    assert.equal(materialDose.completed_running_credit.completed_running_m, Math.floor(10 * 1609.344));
    assert.equal(materialDose.planned_candidate_running_m, 10000);
    assert.equal(materialDose.candidate_running_m,
      materialDose.planned_candidate_running_m + materialDose.completed_running_credit.completed_running_m);
    assert.ok(materialDose.planned_candidate_running_m < materialDose.candidate_running_m);
    assert.ok(scenario.result.selected_candidate.canonical_sessions.some((session) => (
      session.workout_family === 'long_aerobic' && session.scheduled_local_date > '2026-08-23'
    )), `${label} must not count the following partial week toward the credited current-week floor`);
  }
  assert.equal(replay.selected_candidate.candidate_hash, blank.selected_candidate.candidate_hash);
  assert.deepEqual(selectedSchedule(replay), selectedSchedule(blank));

  const malformedCredit = generateDiagnostics(null, {
    activePlan: false,
    currentWeek: { distanceState: 'UNKNOWN' },
  }).result;
  assert.equal(malformedCredit.selected_candidate, null,
    'unverified current-week distance cannot be credited to make a candidate pass');
  assert.ok(malformedCredit.candidates.every((candidate) => candidate.validation.violations.some((violation) => (
    violation.reason === 'WEEKLY_RUNNING_FLOOR'
      || violation.reason === 'UNSUPPORTED_MATERIAL_RUNNING_REDUCTION'
  ))), 'the malformed-credit negative control remains rejected by the existing hard validators');

  console.log('GOAL BACKWARD HYROX PREVIEW REGRESSION SMOKE OK');
}

if (require.main === module) run();

module.exports = { run };
