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
const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
  'assessment', 'race',
]);

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

function selectedRunningSessions(result) {
  return result.selected_candidate?.canonical_sessions?.filter((session) => (
    RUNNING_FAMILIES.has(session.workout_family)
  )) || [];
}

function completedRunningReceipt(result) {
  return validatorResult(result.selected_candidate, 'material_dose')
    ?.receipt?.completed_running_credit || null;
}

function assertApplicableIdentity(scenario, label) {
  const applicable = plansRouter._test.applicableGoalBackwardPlan(
    scenario.built.plan,
    scenario.result,
  );
  assert.ok(applicable, `${label} must remain applicable`);
  assert.equal(applicable.decision_id, scenario.result.decision.decision_id, label);
  assert.equal(applicable.decision_hash, scenario.result.decision.decision_hash, label);
  assert.equal(
    applicable.selected_candidate_hash,
    scenario.result.selected_candidate.candidate_hash,
    label,
  );
  assert.equal(
    applicable.canonical_session_set_hash,
    scenario.result.selected_candidate.canonical_session_set.content_hash,
    label,
  );
  return applicable;
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
  const planningDate = options.planningDate || PLANNING_DATE;
  const baselineRunningM = options.baselineRunningM || BASELINE_RUNNING_M;
  const observedLowerBoundRunningM = options.observedLowerBoundRunningM ?? baselineRunningM;
  const recentNormalStatus = options.recentNormalStatus || 'ESTABLISHED';
  const loadInputState = options.loadInputState || 'COMPLETE';
  const recentNormalConfidence = options.recentNormalConfidence
    || (recentNormalStatus === 'PROVISIONAL' ? 'LOW' : 'HIGH');
  const recentNormalEligibleWeekCount = recentNormalStatus === 'PROVISIONAL' ? 3
    : recentNormalStatus === 'INSUFFICIENT' ? 2 : 4;
  const clock = acceptPlanningClock({
    planning_date_local: planningDate,
    timezone_offset_minutes: TIMEZONE_OFFSET_MINUTES,
  }, planningDate);
  assert.deepEqual(clock, {
    valid: true,
    planningDateLocal: planningDate,
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
    event_format: options.eventFormat || 'individual_open',
    event_category: 'men',
    goal_time_seconds: goalTimeSeconds,
    status: 'upcoming',
  };
  const secondaryRace = options.secondaryRace ? {
    id: 'ten-miler-october-11',
    race_name: '10 Miler',
    race_date: '2026-10-11',
    event_local_date: '2026-10-11',
    event_timezone: TIMEZONE,
    location: 'Washington DC',
    event_kind: 'run_race',
    event_format: 'road',
    event_category: 'men',
    distance_miles: 10,
    goal_time_seconds: 5400,
    status: 'upcoming',
  } : null;
  const races = [race, secondaryRace].filter(Boolean);
  const target = {
    planMode: 'hyrox_build',
    runDaysPerWeek: 4,
    trainingDays: [...(options.trainingDays || TRAINING_DAYS)],
    liftingEnabled: true,
    hyroxEquipment: [...HYROX_EQUIPMENT],
    ...(secondaryRace ? {
      secondaryRace: {
        kind: 'run_race',
        raceId: secondaryRace.id,
        name: secondaryRace.race_name,
        eventLocalDate: secondaryRace.event_local_date,
        eventTimezone: secondaryRace.event_timezone,
        distanceMiles: secondaryRace.distance_miles,
        goalTimeSeconds: secondaryRace.goal_time_seconds,
        goalType: 'pr',
        goalPaceSecondsPerMile: 540,
        goalPaceLabel: '9:00/mi',
      },
    } : {}),
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
  const defaultCurrentWeek = planningDate === PLANNING_DATE ? {
    startDate: '2026-08-17', miles: 10, knownDistanceLowerBoundMiles: 10,
    runCount: 2, runDates: ['2026-08-18', '2026-08-20'],
  } : {
    startDate: '2026-08-24', miles: 0, knownDistanceLowerBoundMiles: 0,
    runCount: 0, runDates: [],
  };
  const currentWeek = options.currentWeek === null ? null : {
    ...defaultCurrentWeek,
    distanceState: 'KNOWN',
    unknownDistanceRunCount: 0,
    longRunCompleted: false,
    ...(options.currentWeek || {}),
  };
  const history = {
    weeklyMileageBaseline: baselineRunningM / 1609.344,
    mileageBaseline: { observedLowerBoundWeeklyMiles: observedLowerBoundRunningM / 1609.344 },
    recentRunCount: 8,
    acuteRunLoad: {
      latestRun: { paceSecondsPerMile: 600 },
      currentWeek,
    },
    runLoadInput: {
      load_input_state: loadInputState,
      load_input_confidence: loadInputState === 'COMPLETE' ? 'HIGH' : 'LOW',
      recent_normal_confidence: recentNormalConfidence,
      recent_normal_eligible_week_count: recentNormalEligibleWeekCount,
      recent_normal_weeks: Array.from({ length: recentNormalEligibleWeekCount }, (_, index) => ({
        week_start_local: ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10'][index],
        eligible: true,
        distance_m: baselineRunningM,
      })),
      recent_normal: {
        status: recentNormalStatus,
        eligible_week_count: recentNormalEligibleWeekCount,
        median_distance_m: baselineRunningM,
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
      training_age_class: options.trainingAgeClass || 'ESTABLISHED',
    },
    target,
    history,
    recovery: {
      state: options.recoveryState || 'NORMAL',
      ...(options.readinessScore !== undefined ? { readinessScore: options.readinessScore } : {}),
    },
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

  const planningConstraints = {
    locks: options.locks || [],
    manual_edits: options.manualEdits || [],
    lock_revision: options.locks?.length ? 1 : 0,
    edit_revision: options.manualEdits?.length ? 1 : 0,
    constraint_fingerprint: null,
  };
  const state = {
    target,
    context,
    races,
    inputHash: `sha256:${canonicalHash({ clock, races, target, currentWeek, planningConstraints })}`,
    planningInputRevision: 1,
    planningConstraints,
    active,
    activePlan,
    request: {
      race_ids: races.map((event) => event.id),
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

  const launchScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
  });
  assert.equal(launchScenario.result.decision.phase, 'DEVELOPMENT');
  assert.equal(launchScenario.result.decision.minimum_weekly_demand.running_m, REQUIRED_RUNNING_M);
  assertBoundedHardValidSelection(
    launchScenario.result,
    'Aug 24 doubles preview with four requested run days',
  );
  assert.equal(completedRunningReceipt(launchScenario.result), null);
  const launchRunningSessions = selectedRunningSessions(launchScenario.result);
  assert.equal(launchRunningSessions.length, 4,
    'the selected preview must preserve all four requested running exposures');
  assert.equal(new Set(launchRunningSessions.map((session) => session.scheduled_local_date)).size, 4,
    'the four runs must remain on four distinct selected training days');
  assert.equal(launchScenario.result.selected_candidate.canonical_sessions.length, 5,
    'the HYROX skill session must use one legal same-day stack instead of deleting a run');
  assert.equal(launchScenario.result.search_diagnostics.maximum_sessions_per_day, 2);
  assert.ok(candidateRunningDose(launchScenario.result.selected_candidate) >= REQUIRED_RUNNING_M);
  assertApplicableIdentity(launchScenario, 'Aug 24 preview/apply binding');
  const launchCompromised = launchScenario.result.selected_candidate.canonical_sessions.find((session) => (
    session.workout_family === 'hyrox_compromised'
  ));
  assert.ok(launchCompromised, 'the controlled compromised workout must remain canonical HYROX work');
  assert.deepEqual(launchCompromised.steps.map((step) => step.type), [
    'run', 'station', 'run', 'station',
  ]);
  assert.equal(launchCompromised.steps.filter((step) => step.type === 'run')
    .reduce((sum, step) => sum + Number(step.target.distance_m || 0), 0), 2000,
  'only the two 1 km run segments count toward running volume');
  assert.equal(launchScenario.result.selected_candidate.skeleton_sessions.some((session) => (
    session.projection_source_material_ids?.includes('hyrox-race-day')
  )), false, 'the current week cannot borrow race-day running from the following week');

  const launchMultiGoalScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
  });
  assert.equal(launchMultiGoalScenario.result.decision.active_goals.length, 2);
  assertBoundedHardValidSelection(
    launchMultiGoalScenario.result,
    'Aug 24 doubles preview with secondary 10-miler',
  );
  assertApplicableIdentity(launchMultiGoalScenario, 'Aug 24 multi-goal preview/apply binding');

  const launchLowReadinessScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'RECOVERY',
    readinessScore: 44,
  });
  assertBoundedHardValidSelection(
    launchLowReadinessScenario.result,
    'Aug 24 multi-goal preview at readiness 44',
  );
  assertApplicableIdentity(
    launchLowReadinessScenario,
    'Aug 24 readiness 44 preview/apply binding',
  );

  const launchDevelopingScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'RECOVERY',
    readinessScore: 44,
    trainingAgeClass: 'DEVELOPING',
  });
  assertBoundedHardValidSelection(
    launchDevelopingScenario.result,
    'Aug 24 developing multi-goal preview at readiness 44',
  );
  assertApplicableIdentity(
    launchDevelopingScenario,
    'Aug 24 developing readiness 44 preview/apply binding',
  );
  assert.equal(launchDevelopingScenario.result.decision.training_age_class, 'DEVELOPING');
  assert.equal(launchDevelopingScenario.result.decision.recovery_state, 'CAUTION');
  assert.equal(launchDevelopingScenario.result.search_diagnostics.maximum_sessions_per_day, 1);
  assert.equal(launchDevelopingScenario.result.selected_candidate.canonical_sessions.length, 4);
  assert.equal(selectedRunningSessions(launchDevelopingScenario.result).length, 3);
  assert.ok(candidateRunningDose(launchDevelopingScenario.result.selected_candidate) >= (
    launchDevelopingScenario.result.required_running_dose_receipt.required_running_m
  ));

  const provisionalBaselineRunningM = 26509;
  const provisionalRequiredRunningM = 22532;
  const launchDevelopingProvisionalScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'RECOVERY',
    readinessScore: 44,
    trainingAgeClass: 'DEVELOPING',
    recentNormalStatus: 'PROVISIONAL',
    recentNormalConfidence: 'LOW',
    baselineRunningM: provisionalBaselineRunningM,
  });
  assert.equal(
    launchDevelopingProvisionalScenario.result.decision.minimum_weekly_demand.running_m,
    provisionalRequiredRunningM,
    'three eligible running weeks establish the same deterministic policy floor used by validation',
  );
  assert.equal(
    launchDevelopingProvisionalScenario.result.decision.recent_normal_running.status,
    'PROVISIONAL',
  );
  assertBoundedHardValidSelection(
    launchDevelopingProvisionalScenario.result,
    'Aug 24 developing multi-goal preview with complete provisional recent-normal evidence',
  );
  assert.ok(candidateRunningDose(
    launchDevelopingProvisionalScenario.result.selected_candidate,
  ) >= provisionalRequiredRunningM);
  assertApplicableIdentity(
    launchDevelopingProvisionalScenario,
    'Aug 24 complete provisional preview/apply binding',
  );

  const launchIncompleteLoadScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'RECOVERY',
    readinessScore: 44,
    trainingAgeClass: 'DEVELOPING',
    recentNormalStatus: 'PROVISIONAL',
    recentNormalConfidence: 'LOW',
    loadInputState: 'PARTIAL',
    baselineRunningM: provisionalBaselineRunningM,
    activePlan: false,
  });
  assertBoundedHardValidSelection(
    launchIncompleteLoadScenario.result,
    'partial provider coverage with a sufficient completed-run lower bound',
  );
  assert.ok(candidateRunningDose(
    launchIncompleteLoadScenario.result.selected_candidate,
  ) >= provisionalRequiredRunningM);
  assertApplicableIdentity(
    launchIncompleteLoadScenario,
    'partial coverage with a sufficient observed lower-bound preview/apply binding',
  );

  const launchInsufficientObservedLoadScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'RECOVERY',
    readinessScore: 44,
    trainingAgeClass: 'DEVELOPING',
    recentNormalStatus: 'PROVISIONAL',
    recentNormalConfidence: 'LOW',
    loadInputState: 'PARTIAL',
    baselineRunningM: provisionalBaselineRunningM,
    observedLowerBoundRunningM: 16000,
    activePlan: false,
  });
  assert.equal(launchInsufficientObservedLoadScenario.result.selected_candidate, null,
    'partial provider coverage cannot top up from an insufficient completed-run lower bound');
  assert.equal(launchInsufficientObservedLoadScenario.result.candidates.every((candidate) => (
    candidate.validation.violations.some((violation) => (
      violation.reason === 'WEEKLY_RUNNING_FLOOR'
        || violation.reason === 'UNSUPPORTED_MATERIAL_RUNNING_REDUCTION'
    ))
  )), true, 'insufficient observations remain rejected by the existing hard dose validators');
  assert.equal(plansRouter._test.applicableGoalBackwardPlan(
    launchInsufficientObservedLoadScenario.built.plan,
    launchInsufficientObservedLoadScenario.result,
  ), null);

  const launchTrainingGapScenario = generateDiagnostics(3600, {
    planningDate: '2026-08-24',
    eventFormat: 'doubles',
    secondaryRace: true,
    recoveryState: 'NORMAL',
    trainingAgeClass: 'DEVELOPING',
    recentNormalStatus: 'TRAINING_GAP',
    recentNormalConfidence: 'LOW',
    baselineRunningM: provisionalBaselineRunningM,
  });
  assert.ok(launchTrainingGapScenario.result.candidates.length > 0);
  assert.ok(launchTrainingGapScenario.result.selected_candidate,
    'Aug 24 training-gap rebuild remains explicitly authorized');
  assert.equal(launchTrainingGapScenario.result.selected_candidate.validation.valid, true);
  assert.ok(candidateRunningDose(launchTrainingGapScenario.result.selected_candidate)
    < launchTrainingGapScenario.result.required_running_dose_receipt.required_running_m,
  'the scoped training-gap rebuild remains a material reduction instead of an implicit top-up');
  assert.equal(
    validatorResult(launchTrainingGapScenario.result.selected_candidate, 'material_dose')
      ?.receipt?.reduction_authorization?.reason_code,
    'TRAINING_GAP_REBUILD',
  );

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
    assert.ok(materialDose.planned_candidate_running_m >= (
      scenario.result.required_running_dose_receipt.required_running_m
        - materialDose.completed_running_credit.completed_running_m
    ));
    assert.equal(materialDose.candidate_running_m,
      materialDose.planned_candidate_running_m + materialDose.completed_running_credit.completed_running_m);
    assert.ok(materialDose.planned_candidate_running_m < materialDose.candidate_running_m);
    assert.ok(scenario.result.selected_candidate.canonical_sessions.some((session) => (
      session.workout_family === 'long_aerobic' && session.scheduled_local_date > '2026-08-23'
    )), `${label} must not count the following partial week toward the credited current-week floor`);
  }
  assert.equal(replay.selected_candidate.candidate_hash, blank.selected_candidate.candidate_hash);
  assert.deepEqual(selectedSchedule(replay), selectedSchedule(blank));

  const overlapOptions = {
    trainingDays: ['Fri', 'Sat', 'Sun', 'Tue', 'Thu'],
    currentWeek: {
      runCount: 3,
      runDates: ['2026-08-18', '2026-08-20', PLANNING_DATE],
    },
    locks: [{
      constraint_kind: 'day_lock',
      local_date: '2026-08-22',
      role: 'PRIMARY_KEY',
      workout_family: 'hyrox_station_skill',
    }],
  };
  const planningDateCompletion = generateDiagnostics(null, overlapOptions);
  const planningDateCompletionReplay = generateDiagnostics(null, overlapOptions);
  assertBoundedHardValidSelection(
    planningDateCompletion.result,
    'verified planning-date completion with legal later availability',
  );
  assert.equal(overlapOptions.trainingDays.includes('Fri'), true,
    'the planning date is an athlete-selected training day');
  assert.equal(planningDateCompletion.result.search_diagnostics.available_day_count, 5,
    'legal later placement dates remain available');
  const overlapReceipt = completedRunningReceipt(planningDateCompletion.result);
  assert.equal(overlapReceipt?.through_local_date, PLANNING_DATE);
  assert.equal(overlapReceipt.completed_running_m, Math.floor(10 * 1609.344));
  assert.equal(selectedRunningSessions(planningDateCompletion.result).every((session) => (
    session.scheduled_local_date > overlapReceipt.through_local_date
  )), true, 'planned running must be strictly later than the completed-running receipt boundary');
  assert.equal(planningDateCompletion.result.search_diagnostics.placement_failure_reason ?? null, null);

  const firstApplicable = assertApplicableIdentity(
    planningDateCompletion,
    'planning-date completion preview/apply binding',
  );
  const replayApplicable = assertApplicableIdentity(
    planningDateCompletionReplay,
    'planning-date completion replay binding',
  );
  assert.equal(
    planningDateCompletionReplay.result.selected_candidate.candidate_hash,
    planningDateCompletion.result.selected_candidate.candidate_hash,
  );
  assert.deepEqual(
    selectedSchedule(planningDateCompletionReplay.result),
    selectedSchedule(planningDateCompletion.result),
  );
  assert.deepEqual({
    decision_id: replayApplicable.decision_id,
    decision_hash: replayApplicable.decision_hash,
    selected_candidate_hash: replayApplicable.selected_candidate_hash,
    canonical_session_set_hash: replayApplicable.canonical_session_set_hash,
  }, {
    decision_id: firstApplicable.decision_id,
    decision_hash: firstApplicable.decision_hash,
    selected_candidate_hash: firstApplicable.selected_candidate_hash,
    canonical_session_set_hash: firstApplicable.canonical_session_set_hash,
  }, 'preview and apply bindings remain deterministic on replay');

  const previousDayCompletion = generateDiagnostics(null, {
    trainingDays: overlapOptions.trainingDays,
    locks: overlapOptions.locks,
  });
  assertBoundedHardValidSelection(
    previousDayCompletion.result,
    'completed run one day before planning',
  );
  const previousDayReceipt = completedRunningReceipt(previousDayCompletion.result);
  assert.equal(previousDayReceipt?.through_local_date, '2026-08-20');
  assert.equal(previousDayReceipt.completed_running_m, Math.floor(10 * 1609.344),
    'the earlier completed run retains full weekly credit');
  assert.ok(selectedRunningSessions(previousDayCompletion.result).some((session) => (
    session.scheduled_local_date === PLANNING_DATE
  )), 'a receipt ending yesterday must not remove a legal planning-date run');
  assert.equal(previousDayCompletion.result.search_diagnostics.placement_failure_reason ?? null, null);

  const noCompletedRun = generateDiagnostics(null, {
    trainingDays: overlapOptions.trainingDays,
    locks: overlapOptions.locks,
    currentWeek: {
      miles: 0,
      knownDistanceLowerBoundMiles: 0,
      runCount: 0,
      runDates: [],
    },
  });
  assertBoundedHardValidSelection(noCompletedRun.result, 'planning-date availability without a completed run');
  assert.equal(completedRunningReceipt(noCompletedRun.result), null);
  assert.ok(selectedRunningSessions(noCompletedRun.result).some((session) => (
    session.scheduled_local_date === PLANNING_DATE
  )), 'no receipt boundary may suppress a legal planning-date run');

  const planningDateHyrox = generateDiagnostics(null, {
    trainingDays: overlapOptions.trainingDays,
    currentWeek: overlapOptions.currentWeek,
  });
  assertBoundedHardValidSelection(planningDateHyrox.result, 'planning-date HYROX station work');
  assert.ok(planningDateHyrox.result.selected_candidate.canonical_sessions.some((session) => (
    session.scheduled_local_date === PLANNING_DATE
      && ['hyrox_station_skill', 'hyrox_station_strength'].includes(session.workout_family)
  )), 'non-running HYROX work remains legal on the completed-running boundary date');
  assert.equal(selectedRunningSessions(planningDateHyrox.result).every((session) => (
    session.scheduled_local_date > PLANNING_DATE
  )), true);

  const noLegalLaterRunningDay = generateDiagnostics(null, {
    ...overlapOptions,
    locks: [...overlapOptions.locks, {
      constraint_kind: 'day_lock',
      local_date: PLANNING_DATE,
      role: 'PRIMARY_KEY',
      workout_family: 'long_aerobic',
    }],
  });
  assert.equal(noLegalLaterRunningDay.result.selected_candidate, null);
  assert.equal(noLegalLaterRunningDay.result.candidates.length, 0,
    'the engine must not retain an unsafe same-day duplicate as a least-bad candidate');
  assert.equal(
    noLegalLaterRunningDay.result.search_diagnostics.placement_failure_reason,
    'SCHEDULE_CONSTRAINT',
  );
  assert.equal(
    noLegalLaterRunningDay.result.search_diagnostics.placement_failure_detail,
    'NO_RUNNING_PLACEMENT_AFTER_COMPLETED_RECEIPT',
  );
  assert.ok(noLegalLaterRunningDay.result.decision.reason_codes.includes(
    'SCHEDULE_CONSTRAINT',
  ));
  assert.equal(plansRouter._test.applicableGoalBackwardPlan(
    noLegalLaterRunningDay.built.plan,
    noLegalLaterRunningDay.result,
  ), null, 'a blocked running lock cannot produce an applicable duplicate plan');

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
