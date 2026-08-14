const assert = require('node:assert/strict');

const {
  buildGoalBackwardPlanningDecision,
  deriveGoalConfidence,
  resolveOwnedGoals,
} = require('../src/lib/goalBackwardDecisionEngine');
const { evaluateGoalBackwardFeasibility } = require('../src/lib/planFeasibility');

const results = [];

function test(id, description, assertion) {
  assertion();
  results.push(id);
  console.log(`ok - ${id} - ${description}`);
}

function baseGoal(overrides = {}) {
  return {
    goal_id: 'goal-target',
    race_id: 'race-target',
    athlete_id: 'athlete-target',
    event_kind: 'ROAD_ENDURANCE',
    event_local_date: '2026-10-11',
    event_state: 'SCHEDULED',
    priority: 'A',
    goal_type: 'performance',
    target_time_s: 4200,
    ...overrides,
  };
}

test('GOAL-PRIORITY-01', 'owned explicit priority overrides chronology and foreign goals are rejected', () => {
  const goals = resolveOwnedGoals({
    athlete_id: 'athlete-target',
    goals: [
      baseGoal({ goal_id: 'goal-a', race_id: 'race-a', event_local_date: '2026-11-01', priority: 'A' }),
      baseGoal({ goal_id: 'goal-b', race_id: 'race-b', event_local_date: '2026-09-01', priority: 'B' }),
      baseGoal({ goal_id: 'foreign', race_id: 'race-foreign', athlete_id: 'other-athlete', priority: 'A' }),
    ],
    races: [
      { race_id: 'race-a', athlete_id: 'athlete-target' },
      { race_id: 'race-b', athlete_id: 'athlete-target' },
      { race_id: 'race-foreign', athlete_id: 'other-athlete' },
    ],
  });
  assert.deepEqual(goals.map((goal) => goal.goal_id), ['goal-a', 'goal-b']);
  assert.equal(goals[0].tie_break_reason, 'ATHLETE_EXPLICIT_PRIORITY');
});

test('GOAL-PRIORITY-02', 'unspecified ties resolve by registration, selected performance intent, date, then creation time', () => {
  const goals = resolveOwnedGoals({
    athlete_id: 'athlete-target',
    goals: [
      baseGoal({ goal_id: 'undated', race_id: null, event_local_date: null, priority: 'UNSPECIFIED', goal_type: 'completion', created_at: '2026-01-01T00:00:00Z' }),
      baseGoal({ goal_id: 'completion', race_id: 'race-completion', event_local_date: '2026-09-10', priority: 'UNSPECIFIED', goal_type: 'completion', created_at: '2026-01-02T00:00:00Z' }),
      baseGoal({ goal_id: 'selected-pr', race_id: 'race-pr', event_local_date: '2026-10-10', priority: 'UNSPECIFIED', goal_type: 'pr', athlete_selected_primary: true, created_at: '2026-01-03T00:00:00Z' }),
      baseGoal({ goal_id: 'older-same-date', race_id: 'race-old', event_local_date: '2026-11-01', priority: 'UNSPECIFIED', created_at: '2026-01-01T00:00:00Z' }),
      baseGoal({ goal_id: 'newer-same-date', race_id: 'race-new', event_local_date: '2026-11-01', priority: 'UNSPECIFIED', created_at: '2026-02-01T00:00:00Z' }),
    ],
    races: ['race-completion', 'race-pr', 'race-old', 'race-new'].map((race_id) => ({ race_id, athlete_id: 'athlete-target' })),
  });
  assert.deepEqual(goals.map((goal) => goal.goal_id), ['selected-pr', 'completion', 'older-same-date', 'newer-same-date', 'undated']);
  assert.deepEqual(goals.slice(0, 3).map((goal) => goal.effective_priority), ['A', 'B', 'C']);
});

test('GOAL-LIFECYCLE-01', 'unknown past events remain visible while cancelled events lose future specificity', () => {
  const goals = resolveOwnedGoals({
    athlete_id: 'athlete-target',
    goals: [
      baseGoal({ goal_id: 'unknown', race_id: 'race-unknown', event_local_date: '2026-08-01', event_state: 'UNKNOWN', priority: 'A' }),
      baseGoal({ goal_id: 'cancelled', race_id: 'race-cancelled', event_state: 'CANCELLED', priority: 'B' }),
    ],
    races: [{ race_id: 'race-unknown', athlete_id: 'athlete-target' }, { race_id: 'race-cancelled', athlete_id: 'athlete-target' }],
  });
  assert.equal(goals[0].goal_id, 'unknown');
  assert.equal(goals[0].planning_eligible, true);
  assert.equal(goals[1].specificity_active, false);
});

test('GOAL-01', 'an aggressive target without evidence remains visible and unvalidated', () => {
  const goal = baseGoal();
  const result = evaluateGoalBackwardFeasibility({
    goal,
    current_status: 'unvalidated',
    target_observations: [],
    workload_path_passes: true,
    safety_permits_goal_training: true,
    mandatory_exposures_complete: true,
    unresolved_material_conflict: false,
  });
  assert.equal(result.status, 'unvalidated');
  assert.deepEqual(result.target, { target_time_s: 4200, target_pace: null });
  assert.equal(result.confidence, 'INSUFFICIENT');
});

test('GOAL-02', 'two fresh target observations on different dates promote only when every support gate passes', () => {
  const observations = [
    { evidence_id: 'obs-1', observed_local_date: '2026-07-01', target_relevant: true, specificity: 'NEARBY_STANDARD', freshness_state: 'FRESH', quality_state: 'COMPLETE' },
    { evidence_id: 'obs-2', observed_local_date: '2026-07-20', target_relevant: true, specificity: 'EVENT_SPECIFIC', freshness_state: 'FRESH', quality_state: 'COMPLETE' },
  ];
  const supported = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'unvalidated', target_observations: observations,
    workload_path_passes: true, mandatory_exposures_complete: true, safety_permits_goal_training: true,
    unresolved_material_conflict: false,
  });
  const oneOrdinary = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'unvalidated', target_observations: [
      { evidence_id: 'ordinary', observed_local_date: '2026-07-20', target_relevant: true, specificity: 'INDIRECT', freshness_state: 'FRESH', quality_state: 'COMPLETE' },
    ], workload_path_passes: true, mandatory_exposures_complete: true, safety_permits_goal_training: true,
  });
  assert.equal(supported.status, 'supported');
  assert.equal(supported.confidence, 'MEDIUM');
  assert.equal(oneOrdinary.status, 'unvalidated');
});

test('GOAL-03', 'two missed required key exposures downgrade supported to at risk', () => {
  const result = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'supported', confidence: 'HIGH', missed_required_key_exposures: 2,
  });
  assert.equal(result.status, 'at_risk');
  assert.deepEqual(result.reason_codes, ['REQUIRED_KEY_EXPOSURES_MISSED']);
});

test('GOAL-04', 'an unreachable safe demand becomes not currently supported without hiding the target', () => {
  const result = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'unvalidated', safe_forward_reaches_minimum_demand: false,
    mandatory_exposure_placeable: true, safety_compatible_through_runway: true,
  });
  assert.equal(result.status, 'not_currently_supported');
  assert.equal(result.target.target_time_s, 4200);
  assert.ok(result.reason_codes.includes('SAFE_WORKLOAD_DEMAND_UNREACHABLE'));
});

test('GOAL-05', 'two consecutive eligible sub-85-percent weeks use exact integer comparison', () => {
  const result = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'supported', confidence: 'HIGH',
    weekly_running_demand: [
      { dimension_eligible: true, completed_running_m: 25499, demand_running_m: 30000 },
      { dimension_eligible: true, completed_running_m: 25500, demand_running_m: 30000 },
      { dimension_eligible: true, completed_running_m: 25499, demand_running_m: 30000 },
    ],
  });
  assert.equal(result.status, 'supported', 'the exact 85-percent middle week breaks consecutiveness');
  const consecutive = evaluateGoalBackwardFeasibility({
    goal: baseGoal(), current_status: 'supported', confidence: 'HIGH',
    weekly_running_demand: [
      { dimension_eligible: true, completed_running_m: 25499, demand_running_m: 30000 },
      { dimension_eligible: true, completed_running_m: 25499, demand_running_m: 30000 },
    ],
  });
  assert.equal(consecutive.status, 'at_risk');
  assert.deepEqual(consecutive.reason_codes, ['MINIMUM_WEEKLY_RUNNING_DEMAND_MISSED']);
});

test('CONF-01', 'one indirect observation yields categorical LOW confidence', () => {
  const result = deriveGoalConfidence([
    { evidence_id: 'indirect-1', observed_local_date: '2026-07-20', target_relevant: true, specificity: 'INDIRECT', freshness_state: 'FRESH', quality_state: 'COMPLETE' },
  ]);
  assert.equal(result.confidence, 'LOW');
  assert.equal(typeof result.confidence, 'string');
  assert.equal(Object.hasOwn(result, 'score'), false);
});

test('DECISION-01', 'planning decisions retain aspiration and categorical feasibility per owned goal', () => {
  const decision = buildGoalBackwardPlanningDecision({
    athlete_id: 'athlete-target', planning_date_local: '2026-08-03', timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 3, evidence_snapshot_id: 'snapshot-target', training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT', consistent_weeks: 8, recovery_state: 'NORMAL', safety_action: 'NORMAL',
      recent_normal_running: { status: 'ESTABLISHED', median_distance_m: 32000 }, available_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    },
    goals: [baseGoal()], races: [{ race_id: 'race-target', athlete_id: 'athlete-target' }],
    feasibility_by_goal: { 'goal-target': { target_observations: [] } },
  });
  assert.equal(decision.goal_feasibilities[0].status, 'unvalidated');
  assert.equal(decision.active_goals[0].target_time_s, 4200);
  assert.equal(decision.goal_feasibilities[0].confidence, 'INSUFFICIENT');
});

assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
console.log(`GOAL-BACKWARD TARGETS SMOKE OK (${results.length} checks)`);
