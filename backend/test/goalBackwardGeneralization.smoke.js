#!/usr/bin/env node

const assert = require('node:assert/strict');

const fixtureData = require('./fixtures/goalBackwardV24.fixtures.json');
const {
  buildAthleteState,
  buildEvidenceSnapshot,
  deriveRecentNormalRunning,
} = require('../src/lib/goalBackwardEvidence');
const {
  buildGoalBackwardPlanningDecision,
  selectGoalBackwardPhase,
} = require('../src/lib/goalBackwardDecisionEngine');
const { buildSafetyExecutability, validateGoalBackwardCandidate } = require('../src/lib/goalBackwardValidators');
const { resolveGoalBackwardTarget } = require('../src/lib/goalBackwardTargets');
const { eventPolicyFor } = require('../src/lib/racePlanPolicy');
const { buildCanonicalHyroxEventState } = require('../src/lib/canonicalWorkout');
const { buildBryanPeakWeekWitness } = require('../src/lib/hyroxPlan');
const { findArtifactRedactionViolations } = require('../src/lib/planCandidateLifecycle');

const OWNED_IDS = Object.freeze(['GEN-A', 'GEN-B', 'GEN-C', 'GEN-D', 'GEN-E', 'GEN-F', 'GEN-G', 'GEN-H', 'GEN-I']);

function decisionFor(fixture) {
  const input = fixture.input;
  return buildGoalBackwardPlanningDecision({
    athlete_id: input.athlete_id,
    planning_date_local: input.planning_date_local,
    timezone: input.timezone,
    athlete_state: input.athlete_state,
    goals: input.goals,
    races: input.races,
    development_gate_complete: input.development_gate_complete === true,
  });
}

function primaryFamilies(decision) {
  return [...new Set(decision.role_multiset
    .filter((role) => role.role === 'PRIMARY_KEY')
    .flatMap((role) => role.any_of || []))];
}

const assertions = {
  'GEN-A': (fixture) => {
    const decision = decisionFor(fixture);
    const target = resolveGoalBackwardTarget(fixture.input.target_request);
    assert.equal(decision.event_policy_id, fixture.expected.event_policy_id);
    assert.equal(decision.phase, fixture.expected.phase);
    assert.equal(decision.key_stimuli.length, fixture.expected.primary_count);
    assert.deepEqual(primaryFamilies(decision), fixture.expected.primary_families);
    assert.equal(decision.minimum_weekly_demand.running_m, null, 'insufficient history never becomes Bryan-like volume');
    assert.equal(target.authority_level, fixture.expected.target_authority_level);
    assert.equal(target.target.pace_range_s_per_km, null);
    assert.deepEqual(target.target.rpe_range, fixture.expected.target_rpe_range);
  },

  'GEN-B': (fixture) => {
    const decision = decisionFor(fixture);
    const target = resolveGoalBackwardTarget(fixture.input.target_request);
    assert.equal(decision.event_policy_id, fixture.expected.event_policy_id);
    assert.equal(decision.phase, fixture.expected.phase);
    assert.equal(decision.key_stimuli.length, fixture.expected.primary_count);
    assert.deepEqual(primaryFamilies(decision), fixture.expected.primary_families);
    assert.equal(decision.minimum_weekly_demand.running_m, fixture.expected.minimum_weekly_running_m);
    assert.equal(target.authority_level, fixture.expected.target_authority_level);
    assert.deepEqual(target.target.pace_range_s_per_km, { minimum: 294, maximum: 306 });
  },

  'GEN-C': (fixture) => {
    const decision = decisionFor(fixture);
    const policy = eventPolicyFor(decision.event_policy_id);
    assert.equal(decision.event_policy_id, fixture.expected.event_policy_id);
    assert.equal(policy.taper_days, fixture.expected.taper_days);
    assert.equal(decision.phase, fixture.expected.phase_before_taper);
    assert.equal(decision.minimum_weekly_demand.running_m, fixture.expected.minimum_weekly_running_m);
    assert.deepEqual(primaryFamilies(decision), fixture.expected.primary_families);
    const taper = selectGoalBackwardPhase({
      planning_date_local: '2026-08-10',
      goal: fixture.input.goals[0],
      event_policy: policy,
      athlete_state: fixture.input.athlete_state,
      due_exposure_count: 2,
    });
    assert.equal(taper.phase, fixture.expected.phase_at_taper);
    assert.ok(taper.reason_codes.includes('TAPER_ENTRY'));
  },

  'GEN-D': (fixture) => {
    const decision = decisionFor(fixture);
    const event = buildCanonicalHyroxEventState(fixture.input.hyrox_event);
    assert.equal(decision.event_policy_id, fixture.expected.event_policy_id);
    assert.equal(event.format, fixture.expected.format);
    assert.equal(event.ruleset_status, 'exact');
    assert.equal(event.official_run_requirements.every((run) => run.ownership === fixture.expected.run_ownership), true);
    assert.equal(event.official_station_requirements.every((station) => station.ownership === fixture.expected.station_ownership), true);
    assert.equal(decision.role_multiset.some((role) => role.any_of.includes(fixture.expected.station_role_family)), true);
    assert.equal(event.team_performance_burden, null);
  },

  'GEN-E': (fixture) => {
    const decision = decisionFor(fixture);
    const event = buildCanonicalHyroxEventState(fixture.input.hyrox_event);
    assert.equal(decision.event_policy_id, fixture.expected.event_policy_id);
    assert.equal(event.format, fixture.expected.format);
    assert.equal(event.official_run_requirements.every((run) => run.ownership === fixture.expected.run_ownership), true);
    assert.equal(event.official_station_requirements.every((station) => station.ownership === fixture.expected.station_ownership), true);
    assert.deepEqual(event.planned_station_split[fixture.expected.known_station], {
      athlete: { distance_m: 600 }, partner: { distance_m: 400 },
    });
    assert.equal(event.planned_station_split[fixture.expected.unknown_station], null);
    assert.equal(event.individual_training_burden.station_time_s[fixture.expected.unknown_station], null);
    assert.equal(event.team_performance_burden.station_time_s[fixture.expected.unknown_station], 255);
  },

  'GEN-F': (fixture) => {
    const decision = decisionFor(fixture);
    assert.equal(fixture.input.athlete_state.available_days.length, fixture.expected.available_day_count);
    assert.equal(decision.key_stimuli.length, fixture.expected.primary_count);
    assert.equal(decision.role_multiset.length, fixture.expected.maximum_session_count, 'constrained week has no calendar filler');
    assert.equal(decision.athlete_locks[0].local_date, fixture.expected.locked_local_date);
    const validation = validateGoalBackwardCandidate({ sessions: fixture.input.candidate_sessions }, {
      available_local_dates: [fixture.expected.locked_local_date],
      locks: decision.athlete_locks,
      maximum_session_count: fixture.expected.maximum_session_count,
      training_age_class: fixture.input.athlete_state.training_age_class,
      safety_action: 'NORMAL',
    });
    assert.equal(validation.reason_codes.includes('ATHLETE_LOCK_CONFLICT'), false);
    const moved = validateGoalBackwardCandidate({
      sessions: [{ ...fixture.input.candidate_sessions[0], scheduled_local_date: '2026-08-08' }],
    }, {
      available_local_dates: ['2026-08-08', fixture.expected.locked_local_date],
      locks: decision.athlete_locks,
      maximum_session_count: fixture.expected.maximum_session_count,
      training_age_class: fixture.input.athlete_state.training_age_class,
      safety_action: 'NORMAL',
    });
    assert.ok(moved.reason_codes.includes('ATHLETE_LOCK_CONFLICT'));
  },

  'GEN-G': (fixture) => {
    const decision = decisionFor(fixture);
    const target = resolveGoalBackwardTarget(fixture.input.target_request);
    assert.equal(decision.recent_normal_running_range_m.median, null);
    assert.equal(fixture.input.athlete_state.recent_normal_running.status, fixture.expected.recent_normal_status);
    assert.equal(decision.phase, fixture.expected.phase);
    assert.equal(target.authority_level, fixture.expected.target_authority_level);
    assert.equal(target.target.pace_range_s_per_km, null);
    assert.deepEqual(target.target.rpe_range, fixture.expected.target_rpe_range);
    assert.ok(target.reason_codes.includes('ASSESSMENT_REQUIRED'));
  },

  'GEN-H': (fixture) => {
    const input = fixture.input;
    const recentNormal = deriveRecentNormalRunning({
      weeks: input.weeks,
      planningDateLocal: input.planning_date_local,
      completedRuns: input.completed_runs,
      completeDaysInSeedWindow: input.complete_days_in_seed_window,
    });
    assert.equal(recentNormal.status, fixture.expected.recent_normal_status);
    assert.equal(recentNormal.historical_median_distance_m, fixture.expected.historical_median_distance_m);
    assert.equal(recentNormal.forward_load_seed_m, fixture.expected.forward_load_seed_m);
    assert.notEqual(recentNormal.forward_load_seed_m, recentNormal.historical_median_distance_m);
    assert.ok(recentNormal.reason_codes.includes(fixture.expected.reason_code));
  },

  'GEN-I': (fixture) => {
    const input = fixture.input;
    const snapshot = buildEvidenceSnapshot({
      athleteId: input.athlete_id,
      planningInstant: input.planning_instant,
      timezone: input.timezone,
      painReports: input.pain_reports,
      providerCoverage: input.provider_coverage,
    });
    const state = buildAthleteState({ snapshot, weeks: [], trainingAgeClass: 'DEVELOPING' });
    const executability = buildSafetyExecutability(input.sessions, {
      safety_action: state.safety_action,
      safety_scope: state.safety_scope,
      safety_state_revision: state.athlete_state_revision,
    });
    assert.equal(state.safety_action, fixture.expected.safety_action);
    assert.deepEqual(state.safety_scope, fixture.expected.safety_scope);
    assert.equal(executability.sessions.find((session) => session.session_id.endsWith('-run')).executable, fixture.expected.run_executable);
    assert.equal(executability.sessions.find((session) => session.session_id.endsWith('-upper')).executable, fixture.expected.upper_executable);
    assert.equal(Object.hasOwn(state, 'diagnosis'), false, 'safety scope never invents a diagnosis');
  },
};

function assertSyntheticDualGoalFixture(fixture) {
  const decision = decisionFor(fixture);
  const eventState = buildCanonicalHyroxEventState(fixture.input.hyrox_event);
  const witness = buildBryanPeakWeekWitness({ hyrox_event_state: eventState });
  const cluster = witness.sessions.find((session) => session.workout_family === 'hyrox_partial_simulation');
  assert.deepEqual(decision.ordered_goal_ids, fixture.expected.ordered_goal_ids);
  assert.deepEqual(decision.active_goals.map((goal) => goal.feasibility_status), fixture.expected.feasibility_statuses);
  assert.equal(Object.values(eventState.planned_station_split).every((split) => split !== null), true);
  assert.deepEqual(fixture.input.cross_modal_median_vector, fixture.expected.normal_ceiling_vector.map((value, index) => (
    value - [3, 2, 2, 2, 2, 2, 2, 2][index]
  )));
  assert.equal(witness.recent_normal_median_distance_m, fixture.expected.recent_normal_median_distance_m);
  assert.equal(witness.minimum_weekly_running_m, fixture.expected.minimum_weekly_running_m);
  assert.equal(witness.weekly_running_m, fixture.expected.weekly_running_m);
  assert.equal(witness.weekly_running_miles, fixture.expected.weekly_running_miles);
  assert.equal(cluster.main_work_duration_s, fixture.expected.cluster_main_work_duration_s);
  assert.equal(cluster.main_set_running_m, fixture.expected.cluster_main_set_running_m);
  assert.equal(cluster.warmup_cooldown_running_m, fixture.expected.cluster_warmup_cooldown_running_m);
  assert.equal(cluster.running_distance_m, fixture.expected.cluster_running_distance_m);
  assert.deepEqual(witness.weekly_stress_vector, fixture.expected.weekly_stress_vector);
  assert.deepEqual(witness.normal_ceiling_vector, fixture.expected.normal_ceiling_vector);
  assert.deepEqual(witness.authorized_ceiling_vector, fixture.expected.authorized_ceiling_vector);
  assert.equal(witness.hard_day_count, fixture.expected.hard_day_count);
  assert.equal(witness.validation.valid, true, JSON.stringify(witness.validation.violations));
}

function run() {
  assert.equal(fixtureData.schema_version, 'goal_backward_v24_generalization_fixtures_v1');
  assert.equal(fixtureData.fixtures.length, 10);
  assert.deepEqual(findArtifactRedactionViolations(fixtureData, 'goal_backward_v24_fixtures'), [],
    'serialized fixtures must not contain secret or PII-shaped keys');

  const generalizationFixtures = fixtureData.fixtures.filter((fixture) => fixture.acceptance_id);
  const dualGoalFixture = fixtureData.fixtures.find((fixture) => Array.isArray(fixture.acceptance_ids));
  assert.deepEqual(generalizationFixtures.map((fixture) => fixture.acceptance_id), OWNED_IDS);
  assert.deepEqual(dualGoalFixture.acceptance_ids, ['BRYAN-01', 'BRYAN-02', 'BRYAN-03', 'BRYAN-04']);
  assertSyntheticDualGoalFixture(dualGoalFixture);

  const emitted = [];
  for (const fixture of generalizationFixtures) {
    const assertion = assertions[fixture.acceptance_id];
    assert.equal(typeof assertion, 'function', `${fixture.acceptance_id} requires one parameterized assertion`);
    assertion(fixture);
    emitted.push(fixture.acceptance_id);
    console.log(`ok - ${fixture.acceptance_id} - ${fixture.fixture_id}`);
  }
  assert.deepEqual(emitted, OWNED_IDS);
  assert.equal(new Set(emitted).size, OWNED_IDS.length);
  console.log(`GOAL BACKWARD GENERALIZATION SMOKE OK (${emitted.length} checks; ${fixtureData.fixtures.length} fixtures)`);
}

if (require.main === module) run();

module.exports = { run };
