const assert = require('node:assert/strict');

const {
  EVENT_POLICY_REGISTRY_V1,
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  STRESS_TAXONOMY_V1,
  TARGET_CONVERSION_REGISTRY_V1,
  eventPolicyFor,
  minimumWeeklyDemandFor,
} = require('../src/lib/racePlanPolicy');
const {
  aggregateWeeklyStress,
  calculateFatigueCeilings,
  evaluateStressBudget,
  integerMedian,
  resolveStressVector,
  selectRunningVolumeIntersection,
  validateRollingHardDays,
} = require('../src/lib/goalBackwardLoad');

const results = [];

function test(id, description, assertion) {
  assertion();
  results.push(id);
  console.log(`ok - ${id} - ${description}`);
}

test('POLICY-01', 'v2.4 policy registries reuse the approved independent version anchors', () => {
  assert.equal(GOAL_BACKWARD_PLANNING_POLICY_V1.planning_policy_version, 'goal-backward-planning-policy-v1');
  assert.equal(EVENT_POLICY_REGISTRY_V1.registry_version, 1);
  assert.equal(STRESS_TAXONOMY_V1.stress_taxonomy_version, 1);
  assert.equal(TARGET_CONVERSION_REGISTRY_V1.target_conversion_registry_version, 1);
  assert.deepEqual(TARGET_CONVERSION_REGISTRY_V1.distance_ratio, { minimum: 0.5, maximum: 2 });
  assert.deepEqual(TARGET_CONVERSION_REGISTRY_V1.source_duration_seconds, { minimum: 1200, maximum: 10800 });
  assert.equal(TARGET_CONVERSION_REGISTRY_V1.exponent, 1.06);
  assert.deepEqual(eventPolicyFor('road_10mile_v1').phase_running_floor_factor, {
    FOUNDATION: 0.7,
    DEVELOPMENT: 0.85,
    EVENT_SPECIFIC_DEVELOPMENT: 0.9,
    SHARPENING: 0.7,
    TAPER_RACE_WEEK: 0.4,
    POST_RACE_TRANSITION: 0,
  });
  assert.deepEqual(eventPolicyFor('hyrox_singles_v1').overload_allowance_points, {
    aerobic: 2,
    running_impact: 2,
    lower_body_muscular: 3,
    upper_body_muscular: 2,
    grip: 2,
    neuromuscular: 2,
    metabolic: 3,
    event_specific_fatigue: 5,
  });
  assert.deepEqual(minimumWeeklyDemandFor('road_10mile_v1', {
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    recent_normal_status: 'ESTABLISHED',
    recent_normal_median_distance_m: 32001,
    training_age_class: 'DEVELOPING',
    available_days_count: 5,
    recovery_state: 'NORMAL',
  }), { running_m: 28800, required_exposure_count: 2 });
  assert.equal(minimumWeeklyDemandFor('road_10mile_v1', {
    phase: 'DEVELOPMENT',
    recent_normal_status: 'INSUFFICIENT',
    recent_normal_median_distance_m: 32000,
  }).running_m, null);
});

test('VECTOR-01', 'closed families resolve exact vectors and reject unknown families', () => {
  assert.deepEqual(resolveStressVector('interval_run'), [3, 4, 2, 0, 0, 4, 4, 1]);
  assert.deepEqual(resolveStressVector('race', { event_kind: 'ROAD_ENDURANCE' }), [4, 4, 3, 1, 1, 4, 4, 4]);
  assert.deepEqual(resolveStressVector('race', { event_kind: 'HYROX_DOUBLES' }), [4, 4, 4, 4, 4, 4, 4, 4]);
  assert.equal(resolveStressVector('invented_from_title'), null);
});

test('VECTOR-02', 'assessment takes the element-wise work-family maximum and event-specific floor', () => {
  assert.deepEqual(resolveStressVector('assessment', {
    contributing_work_families: ['easy_run', 'strength_lower'],
  }), [2, 2, 4, 1, 1, 3, 2, 2]);
  assert.equal(resolveStressVector('assessment', { contributing_work_families: [] }), null);
  assert.equal(resolveStressVector('assessment', {
    contributing_work_families: ['easy_run', 'unknown_family'],
  }), null);
  assert.deepEqual(resolveStressVector('assessment', {
    contributing_work_families: [
      { step_role: 'WARMUP', workout_family: 'interval_run' },
      { step_role: 'WORK', workout_family: 'easy_run' },
    ],
  }), [2, 2, 1, 0, 0, 1, 1, 2]);
});

test('XLOAD-03', 'daily classifications add one per-dimension surcharge and weekly sums remain uncapped', () => {
  const evidence = aggregateWeeklyStress([
    { session_id: 'easy-a', scheduled_local_date: '2026-08-03', workout_family: 'easy_run' },
    { session_id: 'easy-b', scheduled_local_date: '2026-08-03', workout_family: 'easy_run' },
    { session_id: 'upper', scheduled_local_date: '2026-08-03', workout_family: 'strength_upper' },
  ]);
  assert.equal(evidence.valid, true);
  assert.deepEqual(evidence.days[0].qualifying_count, [2, 2, 0, 1, 1, 1, 0, 0]);
  assert.deepEqual(evidence.days[0].stack_surcharge, [1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(evidence.days[0].daily_dimension_classification, [3, 3, 1, 3, 2, 2, 1, 0]);
  assert.deepEqual(evidence.weekly_dimension_sum, [6, 5, 2, 3, 2, 4, 3, 0]);
  assert.equal(evidence.weekly_dimension_sum[0] > 4, true, 'weekly sums must not be capped at VERY_HIGH');
});

test('CEILING-01', 'ordinal medians and normal ceilings use integer upward rounding', () => {
  assert.equal(integerMedian([7, 10, 11, 12]), 11);
  const ceilings = calculateFatigueCeilings({
    aerobic: [7, 10, 11, 12],
    running_impact: [1, 1, 1, 1],
  }, { training_age_class: 'ESTABLISHED' });
  assert.deepEqual(ceilings.dimensions.aerobic, {
    dimension: 'aerobic',
    eligible_week_count: 4,
    status: 'ESTABLISHED',
    confidence: 'MEDIUM',
    integer_median_sum: 11,
    normal_ceiling: 14,
    overload_allowance: 0,
    authorized_ceiling: 14,
    ceiling_source: 'RECENT_NORMAL',
  });
  assert.equal(ceilings.dimensions.running_impact.normal_ceiling, 3, 'minimum ceiling increment is two');
});

test('CEILING-02', 'three weeks are provisional and fewer than three use the exact class fallback', () => {
  const provisional = calculateFatigueCeilings({ aerobic: [7, 8, 11] }, {
    training_age_class: 'ESTABLISHED',
    event_policy: eventPolicyFor('hyrox_singles_v1'),
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    mandatory_hyrox_cluster: true,
    recovery_state: 'READY',
    safety_restriction: false,
    previous_two_weeks_passed: true,
  });
  assert.equal(provisional.dimensions.aerobic.status, 'PROVISIONAL');
  assert.equal(provisional.dimensions.aerobic.confidence, 'LOW');
  assert.equal(provisional.dimensions.aerobic.integer_median_sum, 8);
  assert.equal(provisional.dimensions.aerobic.normal_ceiling, 10);
  assert.equal(provisional.dimensions.aerobic.overload_allowance, 0, 'provisional history cannot authorize overload');

  const fallback = calculateFatigueCeilings({}, { training_age_class: 'DEVELOPING' });
  assert.deepEqual(fallback.normal_ceiling_vector, [10, 9, 8, 7, 6, 8, 9, 7]);
  assert.equal(fallback.dimensions.lower_body_muscular.status, 'INSUFFICIENT');
  assert.equal(fallback.dimensions.lower_body_muscular.integer_median_sum, null);
  assert.equal(fallback.dimensions.lower_body_muscular.ceiling_source, 'TRAINING_CLASS_FALLBACK');
});

test('XLOAD-04', 'eligibility is modality-specific when strength coverage failed', () => {
  const ceilings = calculateFatigueCeilings({
    aerobic: { eligible_sums: [8, 9, 8, 10], coverage_state: 'COMPLETE' },
    running_impact: { eligible_sums: [7, 8, 7, 9], coverage_state: 'COMPLETE' },
    lower_body_muscular: { eligible_sums: [9, 9, 10, 10], coverage_state: 'FAILED_SYNC' },
  }, { training_age_class: 'DEVELOPING' });
  assert.equal(ceilings.dimensions.running_impact.status, 'ESTABLISHED');
  assert.equal(ceilings.dimensions.running_impact.ceiling_source, 'RECENT_NORMAL');
  assert.equal(ceilings.dimensions.lower_body_muscular.status, 'INSUFFICIENT');
  assert.equal(ceilings.dimensions.lower_body_muscular.coverage_state, 'FAILED_SYNC');
  assert.equal(ceilings.dimensions.lower_body_muscular.ceiling_source, 'TRAINING_CLASS_FALLBACK');
});

test('XLOAD-05', 'HYROX cluster overload is phase-bound, gated, dimension-exact, and recorded only when used', () => {
  const history = Object.fromEntries(STRESS_TAXONOMY_V1.dimensions.map((dimension, index) => (
    [dimension, Array(6).fill([11, 10, 7, 3, 3, 7, 7, 2][index])]
  )));
  const eventPolicy = eventPolicyFor('hyrox_doubles_v1');
  const authorized = calculateFatigueCeilings(history, {
    training_age_class: 'ESTABLISHED',
    event_policy: eventPolicy,
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    mandatory_hyrox_cluster: true,
    recovery_state: 'NORMAL',
    safety_restriction: false,
    previous_two_weeks_passed: true,
  });
  assert.deepEqual(authorized.normal_ceiling_vector, [14, 12, 9, 5, 5, 9, 9, 4]);
  assert.deepEqual(authorized.authorized_ceiling_vector, [16, 14, 12, 7, 7, 11, 12, 9]);
  const budget = evaluateStressBudget([13, 12, 10, 5, 5, 9, 10, 7], authorized);
  assert.equal(budget.valid, true);
  assert.deepEqual(budget.overload_dimensions_used, [
    'lower_body_muscular',
    'metabolic',
    'event_specific_fatigue',
  ]);
  assert.deepEqual(budget.reason_codes, ['PHASE_SPECIFIC_OVERLOAD']);

  const wrongPhase = calculateFatigueCeilings(history, {
    training_age_class: 'ESTABLISHED',
    event_policy: eventPolicy,
    phase: 'DEVELOPMENT',
    mandatory_hyrox_cluster: true,
    recovery_state: 'NORMAL',
    previous_two_weeks_passed: true,
  });
  assert.deepEqual(wrongPhase.authorized_ceiling_vector, wrongPhase.normal_ceiling_vector);
  assert.equal(evaluateStressBudget([13, 12, 10, 5, 5, 9, 10, 7], wrongPhase).valid, false);
});

test('HARD-01', 'rolling seven-day lower-body/running hard-day and very-high caps fail closed', () => {
  const threeHardDays = validateRollingHardDays([
    { scheduled_local_date: '2026-08-03', workout_family: 'long_aerobic' },
    { scheduled_local_date: '2026-08-06', workout_family: 'hyrox_partial_simulation' },
    { scheduled_local_date: '2026-08-09', workout_family: 'threshold_run' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(threeHardDays.valid, false);
  assert.ok(threeHardDays.violations.some((violation) => violation.code === 'ROLLING_LOWER_BODY_HARD_DAY_CAP'));

  const twoVeryHigh = validateRollingHardDays([
    { scheduled_local_date: '2026-08-03', workout_family: 'hyrox_partial_simulation' },
    { scheduled_local_date: '2026-08-09', workout_family: 'hyrox_compromised' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(twoVeryHigh.valid, false);
  assert.ok(twoVeryHigh.violations.some((violation) => violation.code === 'ROLLING_VERY_HIGH_EVENT_CAP'));
});

test('XLOAD-02', 'an upper-body stack remains eligible when it does not make the day hard', () => {
  const result = validateRollingHardDays([
    { scheduled_local_date: '2026-08-03', workout_family: 'easy_run' },
    { scheduled_local_date: '2026-08-03', workout_family: 'strength_upper' },
  ], { training_age_class: 'DEVELOPING' });
  assert.equal(result.valid, true);
  assert.equal(result.days[0].hard_day, false);
});

test('RUNVOL-01', 'running volume selects the highest workload in the complete safe intersection', () => {
  const selected = selectRunningVolumeIntersection({
    recent_normal_range: { minimum_m: 30000, maximum_m: 36000 },
    safe_forward_range: { minimum_m: 31000, maximum_m: 34000 },
    goal_backward_range: { minimum_m: 33000, maximum_m: 35000 },
    phase_range: { minimum_m: 0, maximum_m: 33500 },
    cross_modal_range: { minimum_m: 0, maximum_m: 33200 },
  });
  assert.deepEqual(selected, {
    valid: true,
    selected_running_m: 33200,
    safe_intersection: { minimum_m: 33000, maximum_m: 33200 },
    limiting_factors: ['cross_modal_range'],
    reason_codes: [],
  });

  const impossible = selectRunningVolumeIntersection({
    recent_normal_range: { minimum_m: 30000, maximum_m: 36000 },
    safe_forward_range: { minimum_m: 30000, maximum_m: 34000 },
    goal_backward_range: { minimum_m: 35000, maximum_m: 37000 },
  });
  assert.equal(impossible.valid, false);
  assert.equal(impossible.selected_running_m, null);
  assert.deepEqual(impossible.reason_codes, ['CROSS_MODAL_FATIGUE_LIMIT']);
});

test('XLOAD-01', 'cross-modal budget rejects a mileage-safe week whose muscular load exceeds its ceiling', () => {
  const ceilings = calculateFatigueCeilings({
    aerobic: [10, 10, 10, 10],
    running_impact: [8, 8, 8, 8],
    lower_body_muscular: [5, 5, 5, 5],
    upper_body_muscular: [3, 3, 3, 3],
    grip: [3, 3, 3, 3],
    neuromuscular: [6, 6, 6, 6],
    metabolic: [6, 6, 6, 6],
    event_specific_fatigue: [2, 2, 2, 2],
  }, { training_age_class: 'ESTABLISHED' });
  const result = evaluateStressBudget([11, 9, 9, 4, 4, 7, 7, 3], ceilings);
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map((violation) => violation.dimension), ['lower_body_muscular']);
  assert.deepEqual(result.reason_codes, ['CROSS_MODAL_FATIGUE_LIMIT']);
});

assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
console.log(`GOAL-BACKWARD PLANNING SMOKE OK (${results.length} checks)`);
