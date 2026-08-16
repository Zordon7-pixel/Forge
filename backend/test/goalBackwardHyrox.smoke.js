#!/usr/bin/env node

const assert = require('node:assert/strict');
const fixtureData = require('./fixtures/goalBackwardV24.fixtures.json');
const canonicalWorkout = require('../src/lib/canonicalWorkout');
const hyroxPlan = require('../src/lib/hyroxPlan');
const standards = require('../src/lib/hyroxStandards');
const targets = require('../src/lib/goalBackwardTargets');
const policy = require('../src/lib/racePlanPolicy');
const {
  buildHyroxClusterCompletionLedger,
  buildGoalBackwardPlanningDecision,
} = require('../src/lib/goalBackwardDecisionEngine');
const {
  validatePartialRaceOrderClusterExposure,
} = require('../src/lib/goalBackwardValidators');

const RULESET = {
  ruleset_id: 'hyrox-global',
  ruleset_version: '2026-2027',
};

const BRYAN_FIXTURE = fixtureData.fixtures.find((fixture) => Array.isArray(fixture.acceptance_ids));

function bryanEventState() {
  return hyroxPlan.buildHyroxEventState(BRYAN_FIXTURE.input.hyrox_event);
}

function singlesInput(overrides = {}) {
  return {
    athlete_id: 'fixture-singles-athlete',
    format: 'singles',
    event_format: 'individual_open',
    registered_division: 'men',
    ...RULESET,
    transition_behavior: { evidence_ids: ['singles-transition'] },
    roxzone: { evidence_ids: ['singles-roxzone'] },
    compromised_running_evidence: [{ evidence_id: 'singles-compromised' }],
    station_performance_evidence: [{ evidence_id: 'singles-station' }],
    ...overrides,
  };
}

function doublesInput(overrides = {}) {
  return {
    athlete_id: 'fixture-doubles-athlete',
    format: 'doubles',
    registered_division: 'men',
    ...RULESET,
    partner_id: null,
    partner_placeholder: 'Partner TBD',
    team_station_time: {
      ski_erg: 240,
      row: 255,
    },
    planned_station_split: {
      ski_erg: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
      row: null,
    },
    actual_station_split: {
      ski_erg: { athlete: { distance_m: 620, time_s: 142 }, partner: { distance_m: 380, time_s: 98 } },
      row: null,
    },
    transition_behavior: { team_time_s: 310, athlete_time_s: null, evidence_ids: ['team-transition'] },
    roxzone: { team_time_s: 310, athlete_time_s: null, evidence_ids: ['team-roxzone'] },
    compromised_running_evidence: [{ evidence_id: 'doubles-compromised' }],
    team_performance_evidence: [{ evidence_id: 'doubles-team' }],
    athlete_specific_fatigue_evidence: [{ evidence_id: 'doubles-athlete-fatigue' }],
    ...overrides,
  };
}

function completeDoublesSplit() {
  return {
    ski_erg: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
    sled_push: { athlete: { distance_m: 30 }, partner: { distance_m: 20 } },
    sled_pull: { athlete: { distance_m: 30 }, partner: { distance_m: 20 } },
    burpee_broad_jump: { athlete: { distance_m: 48 }, partner: { distance_m: 32 } },
    row: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
    farmers_carry: { athlete: { distance_m: 120 }, partner: { distance_m: 80 } },
    sandbag_lunge: { athlete: { distance_m: 60 }, partner: { distance_m: 40 } },
    wall_ball: { athlete: { repetitions: 60 }, partner: { repetitions: 40 } },
  };
}

function partialCluster(overrides = {}) {
  const eventState = hyroxPlan.buildHyroxEventState(doublesInput({
    planned_station_split: completeDoublesSplit(),
    actual_station_split: {},
    athlete_station_contribution: {},
    partner_station_contribution: {},
  }));
  return hyroxPlan.buildPartialRaceOrderCluster({
    session_id: 'cluster-fixture',
    scheduled_local_date: '2026-08-18',
    event_local_date: '2026-09-06',
    timezone: 'America/New_York',
    plan_id: 'cluster-plan',
    decision_id: 'cluster-decision',
    goal_ids: ['hyrox-goal'],
    hyrox_event_state: eventState,
    station_start_index: 0,
    pair_count: 3,
    run_distance_m: 750,
    station_dose_fraction: 0.5,
    main_work_duration_s: 36 * 60,
    main_set_rpe_range: { minimum: 6, maximum: 8 },
    warmup_running_m: 2094,
    cooldown_running_m: 2093,
    training_age_class: 'ESTABLISHED',
    ...overrides,
  });
}

function assertRegistryPolicy() {
  assert.equal(standards.HYROX_RULESET_ID, 'hyrox-global');
  assert.equal(standards.HYROX_RULESET_VERSION, '2026-2027');
  assert.equal(standards.REGISTRY.rulesetId, standards.HYROX_RULESET_ID);
  assert.equal(standards.REGISTRY.rulesetVersion, standards.HYROX_RULESET_VERSION);
  assert.match(standards.REGISTRY.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(standards.REGISTRY.effectiveThrough, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.ruleset_id, standards.HYROX_RULESET_ID);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.ruleset_version, standards.HYROX_RULESET_VERSION);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.unknown_is_zero, false);
  assert.deepEqual(policy.HYROX_EVENT_MODEL_POLICY_V1.formats.singles.ownership, [
    'official_runs', 'official_stations', 'transitions_roxzone',
    'compromised_running', 'fatigue_recovery',
  ]);
}

function assertSinglesOwnership() {
  const state = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput());
  assert.equal(state.format, 'singles');
  assert.equal(state.event_format, 'individual_open');
  assert.equal(state.partner_id, null);
  assert.equal(state.partner_placeholder, null);
  assert.equal(state.ruleset_status, 'exact');
  assert.equal(state.exact_loads_available, true);
  assert.equal(state.official_run_requirements.length, 8);
  assert.equal(state.official_run_requirements.every((run) => run.ownership === 'athlete'), true);
  assert.equal(state.official_station_requirements.length, 8);
  assert.equal(state.official_station_requirements.every((station) => station.ownership === 'athlete'), true);
  assert.equal(state.individual_training_burden.run_distance_m, 8000);
  assert.equal(state.individual_training_burden.run_ownership, 'athlete');
  assert.equal(state.individual_training_burden.station_ownership, 'athlete_full');
  assert.equal(state.individual_training_burden.transition_ownership, 'athlete');
  assert.equal(state.team_performance_burden, null);
  assert.deepEqual(state.compromised_running_evidence, [{ evidence_id: 'singles-compromised' }]);
  assert.deepEqual(state.station_performance_evidence, [{ evidence_id: 'singles-station' }]);
  assert.deepEqual(state.transition_behavior, { evidence_ids: ['singles-transition'] });
}

function assertDoublesBurdenAndUnknownSplit() {
  const state = hyroxPlan.buildHyroxEventState(doublesInput());
  assert.equal(state.format, 'doubles');
  assert.equal(state.partner_id, null);
  assert.equal(state.partner_placeholder, 'Partner TBD');
  assert.equal(state.official_run_requirements.length, 8);
  assert.equal(
    state.official_run_requirements.every((run) => run.ownership === 'athlete_required_with_partner'),
    true,
  );
  assert.equal(state.official_station_requirements.every((station) => station.ownership === 'team_shared'), true);
  assert.deepEqual(state.planned_station_split.ski_erg, {
    athlete: { distance_m: 600 }, partner: { distance_m: 400 },
  });
  assert.deepEqual(state.actual_station_split.ski_erg, {
    athlete: { distance_m: 620, time_s: 142 }, partner: { distance_m: 380, time_s: 98 },
  });
  assert.equal(state.planned_station_split.row, null);
  assert.equal(state.actual_station_split.row, null);
  assert.deepEqual(state.athlete_station_contribution.ski_erg, { distance_m: 620, time_s: 142 });
  assert.equal(state.athlete_station_contribution.row, null);
  assert.deepEqual(state.partner_station_contribution.ski_erg, { distance_m: 380, time_s: 98 });
  assert.equal(state.partner_station_contribution.row, null);
  assert.equal(state.team_performance_burden.station_time_s.ski_erg, 240);
  assert.equal(state.team_performance_burden.station_time_s.row, 255);
  assert.equal(state.individual_training_burden.station_time_s.ski_erg, 142);
  assert.equal(state.individual_training_burden.station_time_s.row, null);
  assert.equal(state.individual_training_burden.transition_roxzone_time_s, null);
  assert.equal(state.individual_training_burden.contribution_coherent, false);
  assert.deepEqual(state.team_performance_evidence, [{ evidence_id: 'doubles-team' }]);
  assert.deepEqual(state.athlete_specific_fatigue_evidence, [{ evidence_id: 'doubles-athlete-fatigue' }]);
}

function assertUnknownRulesAndDivision() {
  const unknownRulesetId = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput({
    ruleset_id: null,
  }));
  assert.equal(unknownRulesetId.ruleset_status, 'incomplete');
  assert.equal(unknownRulesetId.exact_loads_available, false);
  assert.equal(
    unknownRulesetId.official_station_requirements.every((station) => station.exact_load === null),
    true,
  );

  const unsupportedRules = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput({
    ruleset_version: 'invented-season',
  }));
  assert.equal(unsupportedRules.ruleset_status, 'unsupported_rules_version');
  assert.equal(unsupportedRules.exact_loads_available, false);
  assert.equal(
    unsupportedRules.official_station_requirements.every((station) => (
      station.official_standard === null
      && station.exact_load === null
      && station.load_instruction === 'registered_load_or_relative_technique'
    )),
    true,
  );

  const unknownDivision = canonicalWorkout.buildCanonicalHyroxEventState(doublesInput({
    registered_division: 'unknown',
  }));
  assert.equal(unknownDivision.ruleset_status, 'unsupported_division_category');
  assert.equal(unknownDivision.exact_loads_available, false);
  assert.equal(
    unknownDivision.official_station_requirements.every((station) => station.exact_load === null),
    true,
  );
}

function assertNullPreservingBudget() {
  const state = hyroxPlan.buildHyroxEventState(doublesInput());
  const budget = targets.buildHyroxPerformanceBudget({
    target_total_time_s: 3600,
    projected_run_time_s: 1800,
    run_confidence: 'MEDIUM',
    stations: [
      { station_id: 'ski_erg', projected_time_s: 240, evidence_ids: ['ski'], confidence: 'MEDIUM' },
      { station_id: 'row', projected_time_s: null, evidence_ids: [], confidence: 'INSUFFICIENT' },
    ],
    transition_roxzone_time_s: null,
    transition_confidence: 'INSUFFICIENT',
    team_budget: state.team_performance_burden,
    individual_training_burden: state.individual_training_burden,
  });
  assert.equal(budget.projected_run_time_s, 1800);
  assert.equal(budget.stations.length, 8);
  assert.equal(budget.stations.find((station) => station.station_id === 'ski_erg').projected_time_s, 240);
  assert.equal(budget.stations.find((station) => station.station_id === 'row').projected_time_s, null);
  assert.equal(budget.transition_roxzone_time_s, null);
  assert.equal(budget.known_component_sum_s, 2040);
  assert.equal(budget.unknown_unallocated_time_s, 1560);
  assert.equal(budget.mandatory_components_known, false);
  assert.equal(budget.supported, false);
  assert.equal(budget.confidence, 'INSUFFICIENT');
  assert.equal(budget.team_budget.station_time_s.row, 255);
  assert.equal(budget.individual_training_burden.station_time_s.row, null);

  const emptyBudget = hyroxPlan.buildHyroxPerformanceBudget({ target_total_time_s: 3600 });
  assert.equal(emptyBudget.projected_run_time_s, null);
  assert.equal(emptyBudget.stations.every((station) => station.projected_time_s === null), true);
  assert.equal(emptyBudget.transition_roxzone_time_s, null);
  assert.equal(emptyBudget.known_component_sum_s, 0);
  assert.equal(emptyBudget.unknown_unallocated_time_s, null);

  const completeComponents = {
    target_total_time_s: 3600,
    projected_run_time_s: 1800,
    run_confidence: 'MEDIUM',
    stations: standards.STATION_ORDER.map((stationId) => ({
      station_id: stationId,
      projected_time_s: 150,
      evidence_ids: [`${stationId}-benchmark`],
      confidence: 'MEDIUM',
    })),
    transition_roxzone_time_s: 300,
    transition_confidence: 'MEDIUM',
  };
  const noBurden = targets.buildHyroxPerformanceBudget(completeComponents);
  assert.equal(noBurden.mandatory_components_known, true);
  assert.equal(noBurden.burden_coherent, false);
  assert.equal(noBurden.supported, false, 'complete times cannot support a target without coherent burden');

  const singlesState = hyroxPlan.buildHyroxEventState(singlesInput());
  const supportedSingles = targets.buildHyroxPerformanceBudget({
    ...completeComponents,
    individual_training_burden: singlesState.individual_training_burden,
  });
  assert.equal(supportedSingles.known_component_sum_s, 3300);
  assert.equal(supportedSingles.unknown_unallocated_time_s, 300);
  assert.equal(supportedSingles.mandatory_components_known, true);
  assert.equal(supportedSingles.burden_coherent, true);
  assert.equal(supportedSingles.confidence, 'MEDIUM');
  assert.equal(supportedSingles.supported, true);

  const unknownDoublesBurden = targets.buildHyroxPerformanceBudget({
    ...completeComponents,
    team_budget: state.team_performance_burden,
    individual_training_burden: state.individual_training_burden,
  });
  assert.equal(unknownDoublesBurden.mandatory_components_known, true);
  assert.equal(unknownDoublesBurden.burden_coherent, false);
  assert.equal(unknownDoublesBurden.supported, false);
}

function assertEquipmentSubstitutionTruth() {
  const exact = standards.resolveHyroxStandard({
    rulesetId: RULESET.ruleset_id,
    rulesetVersion: RULESET.ruleset_version,
    format: 'individual_open',
    category: 'men',
  });
  const push = exact.stations.find((station) => station.id === 'sled_push');
  const substituted = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: [],
    dose_fraction: 0.5,
    ruleset_status: 'exact',
    exact_loads_available: true,
  });
  assert.equal(substituted.exactStation, false);
  assert.equal(substituted.readinessClaim, 'pattern_only');
  assert.equal(substituted.exactStationReadiness, false);
  assert.equal(substituted.prescribedLoadKg, null);
  assert.equal(substituted.officialStandard, undefined);
  assert.match(substituted.substitute, /pattern training only/i);

  const exactEquipment = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: ['sled_push'],
    dose_fraction: 0.5,
    ruleset_status: 'exact',
    exact_loads_available: true,
  });
  assert.equal(exactEquipment.exactStation, true);
  assert.equal(exactEquipment.readinessClaim, 'station_specific');
  assert.equal(exactEquipment.exactStationReadiness, true);
  assert.equal(exactEquipment.officialStandard.loadKgIncludingSled, 152);

  const unsupportedRules = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: ['sled_push'],
    dose_fraction: 0.5,
    ruleset_status: 'unsupported_rules_version',
    exact_loads_available: false,
  });
  assert.equal(unsupportedRules.exactStation, true, 'the actual station equipment remains available');
  assert.equal(unsupportedRules.exactStationReadiness, false);
  assert.equal(unsupportedRules.readinessClaim, 'relative_technique');
  assert.equal(unsupportedRules.prescribedLoadKg, null);
  assert.equal(unsupportedRules.officialStandard, undefined);
}

function assertPartialRaceOrderClusterContract() {
  const cluster = partialCluster();
  const schema = canonicalWorkout.validatePartialRaceOrderCluster(cluster, {
    training_age_class: 'ESTABLISHED',
  });
  assert.equal(schema.valid, true, JSON.stringify(schema.violations));
  assert.equal(cluster.workout_family, 'hyrox_partial_simulation');
  assert.equal(cluster.run_station_pair_count, 3);
  assert.deepEqual(cluster.partial_race_order_cluster.station_ids, [
    'ski_erg', 'sled_push', 'sled_pull',
  ]);
  assert.deepEqual(cluster.partial_race_order_cluster.run_distances_m, [750, 750, 750]);
  assert.equal(cluster.partial_race_order_cluster.main_work_duration_s, 2160);
  assert.deepEqual(cluster.partial_race_order_cluster.main_set_rpe_range, { minimum: 6, maximum: 8 });
  assert.equal(cluster.partial_race_order_cluster.station_contributions.every((entry) => (
    entry.dose_fraction === 0.5 && entry.contribution_basis === 'EXPLICIT_DOUBLES_PLANNED_CONTRIBUTION'
  )), true);
  assert.equal(cluster.running_distance_m, 6437);
  assert.equal(cluster.warmup_cooldown_running_m, 4187);
  assert.equal(cluster.distance_miles, 4);

  const exposure = validatePartialRaceOrderClusterExposure([cluster], {
    event_local_date: '2026-09-06',
    mandatory_hyrox_cluster: true,
    training_age_class: 'ESTABLISHED',
  });
  assert.equal(exposure.valid, true, JSON.stringify(exposure.violations));
  assert.deepEqual(exposure.qualifying_cluster_dates, ['2026-08-18']);
  assert.deepEqual(exposure.window, { earliest_local_date: '2026-08-09', latest_local_date: '2026-08-23' });

  const beginnerCluster = partialCluster({
    session_id: 'beginner-two-pair-cluster', pair_count: 2, main_work_duration_s: 20 * 60,
    training_age_class: 'BEGINNER', warmup_running_m: 1000, cooldown_running_m: 1000,
  });
  assert.equal(canonicalWorkout.validatePartialRaceOrderCluster(beginnerCluster, {
    training_age_class: 'BEGINNER',
  }).valid, true);
  const establishedFourPair = partialCluster({
    session_id: 'established-four-pair-cluster', pair_count: 4, main_work_duration_s: 40 * 60,
  });
  assert.equal(canonicalWorkout.validatePartialRaceOrderCluster(establishedFourPair, {
    training_age_class: 'ESTABLISHED',
  }).valid, true);

  const outsideWindow = validatePartialRaceOrderClusterExposure([
    partialCluster({ scheduled_local_date: '2026-08-24', session_id: 'late-cluster' }),
  ], {
    event_local_date: '2026-09-06', mandatory_hyrox_cluster: true, training_age_class: 'ESTABLISHED',
  });
  assert.equal(outsideWindow.valid, false);
  assert.ok(outsideWindow.violations.some((violation) => violation.reason === 'CLUSTER_OUTSIDE_REQUIRED_WINDOW'));

  const crowded = validatePartialRaceOrderClusterExposure([
    partialCluster({ scheduled_local_date: '2026-08-18', session_id: 'crowded-a' }),
    partialCluster({ scheduled_local_date: '2026-08-29', session_id: 'crowded-b' }),
  ], {
    event_local_date: '2026-09-15', mandatory_hyrox_cluster: true, training_age_class: 'ESTABLISHED',
  });
  assert.equal(crowded.valid, false);
  assert.ok(crowded.violations.some((violation) => violation.reason === 'CLUSTER_FREQUENCY_EXCEEDED'));

  const incomplete = buildHyroxClusterCompletionLedger({
    sessions: [cluster], event_local_date: '2026-09-06', training_age_class: 'ESTABLISHED',
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.status, 'INCOMPLETE');
  const completedCluster = partialCluster({
    completion: {
      status: 'COMPLETED',
      completed_station_ids: ['ski_erg', 'sled_push', 'sled_pull'],
      stop_criteria_breach: false,
    },
  });
  const stationOnly = buildHyroxClusterCompletionLedger({
    sessions: [completedCluster], event_local_date: '2026-09-06', training_age_class: 'ESTABLISHED',
  });
  assert.equal(stationOnly.complete, false, 'station-only evidence cannot complete run/station pairs');
  const completedStepIds = cluster.steps
    .filter((step) => step.step_role === 'WORK')
    .map((step) => step.step_id);
  const pairedCompletion = partialCluster({
    completion: {
      status: 'COMPLETED',
      completed_step_ids: completedStepIds,
      stop_criteria_breach: false,
    },
  });
  const complete = buildHyroxClusterCompletionLedger({
    sessions: [pairedCompletion], event_local_date: '2026-09-06', training_age_class: 'ESTABLISHED',
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.status, 'COMPLETE');
}

function assertNonClusterRejection() {
  const reordered = partialCluster({ station_ids: ['ski_erg', 'sled_pull', 'sled_push'] });
  const reorderedResult = canonicalWorkout.validatePartialRaceOrderCluster(reordered, {
    training_age_class: 'ESTABLISHED',
  });
  assert.equal(reorderedResult.valid, false);
  assert.ok(reorderedResult.violations.some((violation) => violation.reason === 'OFFICIAL_ORDER_NOT_CONTIGUOUS'));

  assert.throws(
    () => partialCluster({ pair_count: 2, main_work_duration_s: 19 * 60, training_age_class: 'BEGINNER' }),
    /invalid_partial_cluster_input:main_work_duration_s/,
  );

  const currentCompromised = {
    workout_family: 'hyrox_compromised',
    sessionType: 'hyrox_compromised',
    runSequenceMeters: Array(6).fill(1000),
    stationSequence: standards.STATION_ORDER.slice(0, 6).map((id) => ({ id })),
    main_work_duration_min: 40,
  };
  assert.equal(canonicalWorkout.validatePartialRaceOrderCluster(currentCompromised).valid, false);

  const unknownSplit = hyroxPlan.buildPartialRaceOrderCluster({
    session_id: 'unknown-split-cluster', scheduled_local_date: '2026-08-18',
    event_local_date: '2026-09-06', timezone: 'America/New_York', plan_id: 'cluster-plan',
    decision_id: 'cluster-decision', goal_ids: ['hyrox-goal'],
    hyrox_event_state: hyroxPlan.buildHyroxEventState(doublesInput({ planned_station_split: {} })),
    station_start_index: 0, pair_count: 3, run_distance_m: 750,
    main_work_duration_s: 36 * 60, training_age_class: 'ESTABLISHED',
  });
  const unknownResult = canonicalWorkout.validatePartialRaceOrderCluster(unknownSplit, {
    training_age_class: 'ESTABLISHED',
  });
  assert.equal(unknownResult.valid, false);
  assert.ok(unknownResult.violations.some((violation) => violation.reason === 'DOUBLES_CONTRIBUTION_UNKNOWN'));
  assert.equal(unknownSplit.partial_race_order_cluster.station_contributions[0].prescribed_amount, null);

  for (const [field, value] of [
    ['pair_count', 'not-a-count'],
    ['run_distance_m', 'unknown'],
    ['main_work_duration_s', null],
    ['main_set_rpe_range', { minimum: 5, maximum: 9 }],
    ['station_dose_fraction', 'unknown'],
  ]) {
    assert.throws(
      () => partialCluster({ session_id: `malformed-${field}`, [field]: value }),
      /invalid_partial_cluster_input/,
      `${field} must fail closed rather than becoming a valid default`,
    );
  }
}

function assertBryanWitnessRunningFloor() {
  const witness = hyroxPlan.buildBryanPeakWeekWitness({
    hyrox_event_state: bryanEventState(),
  });
  assert.equal(witness.recent_normal_median_distance_m, BRYAN_FIXTURE.expected.recent_normal_median_distance_m);
  assert.equal(witness.minimum_weekly_running_m, BRYAN_FIXTURE.expected.minimum_weekly_running_m);
  assert.equal(witness.weekly_running_m, BRYAN_FIXTURE.expected.weekly_running_m);
  assert.equal(witness.weekly_running_m >= witness.minimum_weekly_running_m, true);
  assert.equal(witness.weekly_running_miles, BRYAN_FIXTURE.expected.weekly_running_miles);
  assert.equal(witness.sessions.filter((session) => session.workout_family === 'rest').length, 0);
}

function assertBryanGoalsRemainUnvalidated() {
  const input = BRYAN_FIXTURE.input;
  const decision = buildGoalBackwardPlanningDecision({
    athlete_id: input.athlete_id, planning_date_local: input.planning_date_local, timezone: input.timezone,
    athlete_state: input.athlete_state, goals: input.goals, races: input.races,
    development_gate_complete: input.development_gate_complete,
  });
  assert.deepEqual(decision.ordered_goal_ids, BRYAN_FIXTURE.expected.ordered_goal_ids);
  assert.deepEqual(decision.active_goals.map((goal) => goal.feasibility_status), BRYAN_FIXTURE.expected.feasibility_statuses);
  assert.deepEqual(decision.active_goals.map((goal) => goal.target_time_s), input.goals.map((goal) => goal.target_time_s));
}

function assertBryanOrderedGoals() {
  const input = BRYAN_FIXTURE.input;
  const hyroxGoal = input.goals[0];
  const tenMileGoal = input.goals[1];
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
  try {
    const plan = hyroxPlan.generateHyroxPlan({
      athlete: { weeklyMilesCurrent: input.athlete_state.recent_normal_running.median_distance_m / 1609.344, runDaysPerWeek: 4, training_age_class: input.athlete_state.training_age_class },
      planningLocalDate: input.planning_date_local,
      event: {
        raceId: hyroxGoal.race_id, name: 'Synthetic HYROX', eventLocalDate: hyroxGoal.event_local_date,
        eventTimezone: input.timezone, format: input.hyrox_event.format,
        category: input.hyrox_event.registered_division, rulesVersion: input.hyrox_event.ruleset_version,
        goalTimeSeconds: hyroxGoal.target_time_s,
        hyroxEventState: { planned_station_split: input.hyrox_event.planned_station_split },
      },
      equipment: ['ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target', 'sandbag', 'farmers_carry', 'treadmill'],
      availableDays: input.athlete_state.available_days,
      secondaryRace: {
        raceId: tenMileGoal.race_id, name: 'Synthetic 10-mile', eventLocalDate: tenMileGoal.event_local_date,
        eventTimezone: input.timezone, distanceMiles: tenMileGoal.distance_miles, goalTimeSeconds: tenMileGoal.target_time_s,
      },
    });
    assert.deepEqual(plan.goals.map((goal) => goal.priority), ['A', 'B']);
    assert.deepEqual(plan.goals.map((goal) => goal.feasibility_status), ['unvalidated', 'unvalidated']);
    assert.equal(plan.goals[0].goalType, 'performance');
    assert.equal(plan.goals[0].goalTimeSeconds, hyroxGoal.target_time_s);
    assert.equal(plan.hyroxPerformanceBudget.target_total_time_s, hyroxGoal.target_time_s);
    const raceWeek = plan.weeks.findIndex((week) => week.days.some((day) => (
      day.sessions.some((session) => session.sessionType === 'hyrox_race')
    )));
    assert.equal(plan.weeks[raceWeek + 1].phase, 'post_hyrox_recovery');
    assert.ok(plan.weeks.slice(raceWeek + 2).some((week) => week.phase === 'running_specific'));
  } finally {
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
  }
}

function assertBryanExactWitness() {
  const witness = hyroxPlan.buildBryanPeakWeekWitness({
    hyrox_event_state: bryanEventState(),
  });
  const cluster = witness.sessions.find((session) => session.workout_family === 'hyrox_partial_simulation');
  assert.equal(cluster.run_station_pair_count, 3);
  assert.equal(cluster.main_work_duration_s, BRYAN_FIXTURE.expected.cluster_main_work_duration_s);
  assert.equal(cluster.main_set_running_m, BRYAN_FIXTURE.expected.cluster_main_set_running_m);
  assert.equal(cluster.warmup_cooldown_running_m, BRYAN_FIXTURE.expected.cluster_warmup_cooldown_running_m);
  assert.equal(cluster.running_distance_m, BRYAN_FIXTURE.expected.cluster_running_distance_m);
  assert.deepEqual(witness.weekly_stress_vector, BRYAN_FIXTURE.expected.weekly_stress_vector);
  assert.deepEqual(witness.normal_ceiling_vector, BRYAN_FIXTURE.expected.normal_ceiling_vector);
  assert.deepEqual(witness.authorized_ceiling_vector, BRYAN_FIXTURE.expected.authorized_ceiling_vector);
  assert.deepEqual(witness.roles, {
    hyrox_partial_simulation: 'PRIMARY_KEY', long_aerobic: 'PRIMARY_KEY', hyrox_station_skill: 'SUPPORTING',
  });
  assert.equal(witness.hard_day_count, BRYAN_FIXTURE.expected.hard_day_count);
  assert.equal(witness.validation.valid, true, JSON.stringify(witness.validation.violations));
  assert.deepEqual(witness.validation.reason_codes, ['PHASE_SPECIFIC_OVERLOAD']);
  assert.deepEqual(witness.overload.reason_codes, ['PHASE_SPECIFIC_OVERLOAD']);
}

function run() {
  const results = [];
  const test = (id, description, assertion) => {
    assertion();
    results.push(id);
    console.log(`ok - ${id} - ${description}`);
  };
  assert.ok(BRYAN_FIXTURE, 'the synthetic dual-goal parameterized fixture is required');
  assert.deepEqual(BRYAN_FIXTURE.acceptance_ids, ['BRYAN-01', 'BRYAN-02', 'BRYAN-03', 'BRYAN-04']);
  assertRegistryPolicy();
  test('HYROX-01', 'Singles owns the complete official run and station workload', assertSinglesOwnership);
  test('HYROX-02', 'Doubles preserves team truth and unknown individual contribution', assertDoublesBurdenAndUnknownSplit);
  test('HYROX-03', 'unknown rules/division never invent exact load', () => {
    assertUnknownRulesAndDivision();
    assertEquipmentSubstitutionTruth();
  });
  test('HYROX-04', 'missing station and transition components remain null', assertNullPreservingBudget);
  test('HYROX-05', 'partial race-order cluster schema, window, count, and success ledger are exact', assertPartialRaceOrderClusterContract);
  test('HYROX-06', 'noncontiguous, short, compromised, and unknown-split work cannot count as the peak cluster', assertNonClusterRejection);
  test('BRYAN-01', 'healthy final substantial week preserves the recent-normal running floor', assertBryanWitnessRunningFloor);
  test('BRYAN-02', 'both unsupported performance targets remain visible and unvalidated', assertBryanGoalsRemainUnvalidated);
  test('BRYAN-03', 'HYROX specificity, transition, and 10-mile specificity remain ordered', assertBryanOrderedGoals);
  test('BRYAN-04', 'the exact 19-mile cluster-week witness passes every gate', assertBryanExactWitness);
  assert.deepEqual(results, [
    'HYROX-01', 'HYROX-02', 'HYROX-03', 'HYROX-04', 'HYROX-05', 'HYROX-06',
    'BRYAN-01', 'BRYAN-02', 'BRYAN-03', 'BRYAN-04',
  ]);
  console.log(`GOAL BACKWARD HYROX SMOKE OK (${results.length} checks)`);
}

if (require.main === module) run();
module.exports = { run };
