// Goal-backward low-volume presentation-floor and bounded-search regression.
// Run: node backend/test/goalBackwardGoalFloorRecovery.smoke.js

const assert = require('node:assert/strict');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const {
  MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
  MAX_GOAL_BACKWARD_SEARCH_NODES,
  enumerateGoalBackwardCandidates,
} = require('../src/lib/racePlanCandidateEngine');

const PLANNING_DATE = '2026-08-19';
const HYBRID_EVENT_DATE = '2026-09-06';
const ROAD_EVENT_DATE = '2026-10-11';
const AVAILABLE_DATES = Object.freeze([
  '2026-08-19', '2026-08-21', '2026-08-23', '2026-08-25',
  '2026-08-27', '2026-08-29', '2026-08-31',
]);

function immutableDecision(content, id) {
  return Object.freeze({
    decision_id: id,
    ...content,
    decision_hash: canonicalHash(content),
  });
}

function athleteState(trainingAgeClass, evidenceStatus) {
  return {
    training_age_class: trainingAgeClass,
    consistency_state: evidenceStatus === 'PROVISIONAL' ? 'SPARSE_DATA' : 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_state: { action: 'NORMAL', scope: [] },
  };
}

function dualGoalInput(availableDayCount, {
  trainingAgeClass = 'ESTABLISHED',
  evidenceStatus = 'ESTABLISHED',
} = {}) {
  const availableDates = AVAILABLE_DATES.slice(0, availableDayCount);
  const roles = [
    {
      requirement_id: 'hybrid-limiter',
      any_of: ['hyrox_station_skill'],
      role: 'PRIMARY_KEY',
    },
    {
      requirement_id: 'road-development',
      any_of: ['easy_run', 'long_aerobic'],
      role: 'SUPPORTING',
      supports_requirement_id: 'hybrid-limiter',
    },
    {
      requirement_id: 'aerobic-support',
      any_of: ['easy_run'],
      role: 'SUPPORTING',
      supports_requirement_id: 'hybrid-limiter',
    },
  ];
  const content = {
    planning_date_local: PLANNING_DATE,
    timezone: 'America/New_York',
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-hybrid',
    ...athleteState(trainingAgeClass, evidenceStatus),
    evidence_used: [{ evidence_id: `synthetic-${evidenceStatus.toLowerCase()}-load` }],
    athlete_locks: [],
    manual_edits: [],
    active_goals: [
      {
        goal_id: 'goal-hybrid', race_id: 'race-hybrid', event_kind: 'HYROX_DOUBLES',
        event_local_date: HYBRID_EVENT_DATE, event_state: 'SCHEDULED', priority: 'A',
      },
      {
        goal_id: 'goal-road', race_id: 'race-road', event_kind: 'ROAD_ENDURANCE',
        event_local_date: ROAD_EVENT_DATE, event_state: 'SCHEDULED', priority: 'B',
      },
    ],
    minimum_weekly_demand: { running_m: 10000, required_exposure_count: 1 },
    role_multiset: roles,
    due_exposure_ledger: { due_roles: [roles[0]], unplaceable_requirement_ids: [] },
    development_role_requirements: [],
  };
  const decision = immutableDecision(
    content,
    `decision-dual-${trainingAgeClass.toLowerCase()}-${evidenceStatus.toLowerCase()}-${availableDayCount}`,
  );
  return {
    decision,
    available_local_dates: availableDates,
    maximum_session_count: roles.length,
    legacy_road_candidate_material: [
      {
        id: 'synthetic-station-skill', workout_family: 'hyrox_station_skill',
        kind: 'hyrox', duration_min: 35,
        stationSequence: [{ id: 'row', distance_m: 500 }],
      },
      {
        id: 'synthetic-road-development', workout_family: 'long_aerobic', kind: 'run',
        prescription_basis: 'distance', distance_m: 6500, distance_miles: 6500 / 1609.344,
        distance_is_estimate: false,
      },
      {
        id: 'synthetic-aerobic-support', workout_family: 'easy_run', kind: 'run',
        prescription_basis: 'distance', distance_m: 9000, distance_miles: 9000 / 1609.344,
        distance_is_estimate: false,
      },
    ],
    materialize_canonical: true,
    planning_instant: `${PLANNING_DATE}T00:00:00.000Z`,
    hybrid_running_projection_pace_s_per_mile: 600,
    validation_options: {
      available_local_dates: availableDates,
      available_days_count: availableDayCount,
      training_age_class: trainingAgeClass,
      consistency_state: content.consistency_state,
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
      minimum_weekly_demand: content.minimum_weekly_demand,
    },
  };
}

function remainingRoadInput({ token = false } = {}) {
  const roles = [{
    requirement_id: 'remaining-road-long', any_of: ['long_aerobic'], role: 'PRIMARY_KEY',
  }];
  const content = {
    planning_date_local: PLANNING_DATE,
    timezone: 'America/New_York',
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-road',
    ...athleteState('ESTABLISHED', 'ESTABLISHED'),
    evidence_used: [{ evidence_id: 'synthetic-removal-load' }],
    athlete_locks: [],
    manual_edits: [],
    active_goals: [{
      goal_id: 'goal-road', race_id: 'race-road', event_kind: 'ROAD_ENDURANCE',
      event_local_date: ROAD_EVENT_DATE, event_state: 'SCHEDULED', priority: 'A',
    }],
    minimum_weekly_demand: { running_m: token ? 0 : 6000, required_exposure_count: 1 },
    role_multiset: roles,
    due_exposure_ledger: { due_roles: roles, unplaceable_requirement_ids: [] },
    development_role_requirements: [],
  };
  const decision = immutableDecision(content, token ? 'decision-token-road' : 'decision-remaining-road');
  const distanceM = token ? 500 : 6500;
  return {
    decision,
    available_local_dates: AVAILABLE_DATES.slice(0, 3),
    maximum_session_count: 1,
    legacy_road_candidate_material: [{
      id: token ? 'synthetic-token-long' : 'synthetic-remaining-long',
      workout_family: 'long_aerobic',
      kind: 'run',
      prescription_basis: token ? 'time' : 'distance',
      ...(token ? { duration_min: 10 } : {}),
      distance_m: distanceM,
      distance_miles: distanceM / 1609.344,
      distance_is_estimate: false,
    }],
    materialize_canonical: true,
    planning_instant: `${PLANNING_DATE}T00:00:00.000Z`,
    hybrid_running_projection_pace_s_per_mile: 600,
    validation_options: {
      available_local_dates: AVAILABLE_DATES.slice(0, 3),
      available_days_count: 3,
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
      minimum_weekly_demand: content.minimum_weekly_demand,
    },
  };
}

function failedValidators(candidate) {
  return candidate.validation.validator_results
    .filter((entry) => entry.valid === false)
    .map((entry) => entry.validator);
}

function assertSelectedAndDeterministic(input, label) {
  const first = enumerateGoalBackwardCandidates(input);
  const replay = enumerateGoalBackwardCandidates(input);
  assert.ok(first.selected_candidate, `${label} must select an applicable candidate`);
  assert.equal(first.selected_candidate.validation.valid, true, label);
  assert.deepEqual(replay, first, `${label} replay must be byte-equivalent`);
  assert.ok(first.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES, label);
  return first;
}

const establishedThreeDay = assertSelectedAndDeterministic(
  dualGoalInput(3),
  'three-day established hybrid plus road preview',
);
assert.equal(establishedThreeDay.selected_candidate.sessions.every((session) => (
  session.canonical_workout_schema_version === 1
)), true);
assert.deepEqual(failedValidators(establishedThreeDay.selected_candidate), []);
const distancePrescriptions = establishedThreeDay.selected_candidate.sessions.filter((session) => (
  ['easy_run', 'long_aerobic'].includes(session.workout_family)
));
assert.equal(distancePrescriptions.length, 2);
assert.equal(distancePrescriptions.every((session) => (
  session.steps.every((step) => !Object.hasOwn(step.target || {}, 'duration_s'))
    && !(session.purpose_reason_codes || []).includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
    && !session.beginner_or_rehab_protocol_id
)), true, 'floor proof preserves distance prescriptions without manufacturing an exception or duration');

const remainingRoad = assertSelectedAndDeterministic(
  remainingRoadInput(),
  'remaining-road removal rebuild',
);
assert.equal(remainingRoad.candidates.length, 3);

for (const availableDayCount of [5, 7]) {
  const result = assertSelectedAndDeterministic(
    dualGoalInput(availableDayCount),
    `${availableDayCount}-day bounded search`,
  );
  assert.ok(result.selected_candidate,
    `${availableDayCount}-day search must not lose every valid branch at the bounded frontier`);
}

assertSelectedAndDeterministic(
  dualGoalInput(3, { trainingAgeClass: 'DEVELOPING', evidenceStatus: 'PROVISIONAL' }),
  'three-day developing provisional preview',
);

const token = enumerateGoalBackwardCandidates(remainingRoadInput({ token: true }));
assert.equal(token.selected_candidate, null, 'a genuine ten-minute token long run remains rejected');
assert.equal(token.candidates.length, 3);
assert.equal(token.candidates.every((candidate) => (
  candidate.validation.reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
)), true);

for (const invalidPace of ['600', 179, 2401]) {
  const invalidWitnessInput = dualGoalInput(3);
  invalidWitnessInput.hybrid_running_projection_pace_s_per_mile = invalidPace;
  const invalidWitness = enumerateGoalBackwardCandidates(invalidWitnessInput);
  assert.equal(invalidWitness.selected_candidate, null,
    `invalid pace witness ${invalidPace} cannot prove a distance-only floor`);
  assert.equal(invalidWitness.candidates.every((candidate) => (
    candidate.validation.reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
  )), true);
}

console.log('GOAL BACKWARD GOAL-FLOOR RECOVERY SMOKE OK');
