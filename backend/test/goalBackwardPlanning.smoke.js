const assert = require('node:assert/strict');

const {
  EVENT_POLICY_REGISTRY_V1,
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  STRESS_TAXONOMY_V1,
  TARGET_CONVERSION_REGISTRY_V1,
  canonicalHash,
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
const {
  buildDueExposureLedger,
  buildGoalBackwardPlanningDecision,
  buildRoleMultiset,
  selectGoalBackwardPhase,
} = require('../src/lib/goalBackwardDecisionEngine');
const {
  compareMaterialChange,
  HARD_VALIDATOR_NAMES,
  validateGoalBackwardCandidate,
  validateInterference,
} = require('../src/lib/goalBackwardValidators');
const {
  buildGoalBackwardCandidateSkeleton,
  compareGoalBackwardCandidateRankings,
  enumerateGoalBackwardCandidates,
} = require('../src/lib/racePlanCandidateEngine');
const { buildCanonicalSession } = require('../src/lib/canonicalWorkout');

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
    [dimension, Array(6).fill([11, 10, 7, 2, 2, 6, 7, 3][index])]
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
  assert.deepEqual(authorized.normal_ceiling_vector, [14, 12, 9, 4, 4, 8, 9, 5]);
  assert.deepEqual(authorized.authorized_ceiling_vector, [16, 14, 12, 6, 6, 10, 12, 10]);
  const budget = evaluateStressBudget([13, 12, 10, 5, 5, 9, 10, 7], authorized);
  assert.equal(budget.valid, true);
  assert.deepEqual(budget.overload_dimensions_used, [
    'lower_body_muscular',
    'upper_body_muscular',
    'grip',
    'neuromuscular',
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

test('MAT-01', 'a twelve-percent and three-mile weekly reduction is material against the active applied plan', () => {
  const result = compareMaterialChange({
    active_applied_plan: {
      plan_revision: 7,
      sessions: [{ session_id: 'easy-1', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING', distance_m: 40234 }],
    },
    candidate: {
      sessions: [{ session_id: 'easy-1', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING', distance_m: 35406 }],
    },
  });
  assert.equal(result.material_change, true);
  assert.equal(result.preview_required, true);
  assert.ok(result.changes.some((change) => change.code === 'WEEKLY_RUNNING_VOLUME'));
  assert.deepEqual(result.reason_codes, ['MATERIAL_CHANGE_REVIEW_REQUIRED']);
});

test('MAT-02', 'a primary-key family replacement is material below every volume threshold', () => {
  const result = compareMaterialChange({
    active_applied_plan: {
      plan_revision: 3,
      sessions: [{ session_id: 'key-1', scheduled_local_date: '2026-08-04', workout_family: 'threshold_run', role: 'PRIMARY_KEY', distance_m: 8000 }],
    },
    candidate: {
      sessions: [{ session_id: 'key-1', scheduled_local_date: '2026-08-04', workout_family: 'interval_run', role: 'PRIMARY_KEY', distance_m: 8000 }],
    },
  });
  assert.equal(result.material_change, true);
  assert.ok(result.changes.some((change) => change.code === 'KEY_SESSION_FAMILY_CHANGED'));
});

test('MAT-03', 'cosmetic copy does not change the canonical prescription hash', () => {
  const baselineSession = {
    session_id: 'easy-copy', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING',
    distance_m: 6000, duration_s: 2400, title: 'Easy aerobic run', description: 'Keep it conversational.',
  };
  const result = compareMaterialChange({
    active_applied_plan: { plan_revision: 4, sessions: [baselineSession] },
    candidate: { sessions: [{ ...baselineSession, title: 'Relaxed aerobic run', description: 'Comfortable throughout.' }] },
  });
  assert.equal(result.material_change, false);
  assert.equal(result.prescription_hash_changed, false);
  assert.deepEqual(result.changes, []);
});

test('MAT-04', 'rejected previews and recent-normal load never replace the active applied comparator', () => {
  const result = compareMaterialChange({
    active_applied_plan: {
      plan_revision: 9,
      sessions: [{ session_id: 'support-1', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING', distance_m: 32187 }],
    },
    rejected_preview: {
      plan_revision: 10,
      sessions: [{ session_id: 'support-1', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING', distance_m: 48280 }],
    },
    recent_normal_running_m: 50000,
    candidate: {
      sessions: [{ session_id: 'support-1', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING', distance_m: 30578 }],
    },
  });
  assert.equal(result.baseline_source, 'ACTIVE_APPLIED_PLAN');
  assert.equal(result.baseline_plan_revision, 9);
  assert.equal(result.material_change, false, 'the five-percent/one-mile active-plan delta is below threshold');
});

test('MAT-05', 'a first-ever plan uses initial activation review without fabricating an adaptation delta', () => {
  const result = compareMaterialChange({
    active_applied_plan: null,
    candidate: {
      sessions: [{ session_id: 'first-key', scheduled_local_date: '2026-08-04', workout_family: 'threshold_run', role: 'PRIMARY_KEY' }],
    },
  });
  assert.equal(result.material_change_baseline, null);
  assert.equal(result.material_change, false);
  assert.equal(result.initial_plan_review, true);
  assert.equal(result.review_required, true);
  assert.equal(result.change_label, null);
});

test('MAT-THRESHOLDS-01', 'every approved structural, dosage, movement, priority, and safety threshold creates an exact review item', () => {
  const base = {
    session_id: 'material-key', scheduled_local_date: '2026-08-03', workout_family: 'threshold_run',
    role: 'PRIMARY_KEY', distance_m: 10000, target_pace_s_per_km: 300, target_zone_number: 3,
    work_duration_s: 1200, repetitions: 4, station_distance_m: 100, station_repetitions: 20,
    load_kg: 40, strength_hard_sets: 10, stress_vector: [4, 4, 4, 2, 3, 3, 4, 4],
  };
  const cases = [
    ['TARGET_PACE_CHANGED', { target_pace_s_per_km: 309.01 }],
    ['TARGET_ZONE_CHANGED', { target_zone_number: 4 }],
    ['SESSION_DOSAGE_CHANGED', { work_duration_s: 1380 }],
    ['SESSION_DOSAGE_CHANGED', { station_distance_m: 115 }],
    ['SESSION_DOSAGE_CHANGED', { load_kg: 46 }],
    ['STRENGTH_HARD_SETS_CHANGED', { strength_hard_sets: 12 }],
    ['HYBRID_STRESS_DIMENSION_CHANGED', { stress_vector: [4, 4, 3, 2, 3, 3, 4, 4] }],
    ['HARD_SESSION_MOVED', { scheduled_local_date: '2026-08-05' }],
  ];
  for (const [expected, override] of cases) {
    const result = compareMaterialChange({
      active_applied_plan: { plan_revision: 11, sessions: [base] },
      candidate: { plan_revision: 12, sessions: [{ ...base, ...override }] },
      decisive_evidence_ids: ['evidence-material-thresholds'],
      material_reason_code: 'MATERIAL_CHANGE_REVIEW_REQUIRED',
    });
    const item = result.changes.find((change) => change.code === expected);
    assert.ok(item, `${expected} must be material`);
    assert.equal(item.review_required, true);
    assert.equal(item.reason_code, 'MATERIAL_CHANGE_REVIEW_REQUIRED');
    assert.deepEqual(item.decisive_evidence_ids, ['evidence-material-thresholds']);
    assert.equal(item.baseline_plan_revision, 11);
    assert.equal(item.candidate_plan_revision, 12);
    assert.equal(result.auto_apply_allowed, false);
  }

  const planLevel = compareMaterialChange({
    active_applied_plan: { plan_revision: 11, phase: 'DEVELOPMENT', goal_priority: 'A', safety_scope: { executable: true }, sessions: [base] },
    candidate: { plan_revision: 12, phase: 'SHARPENING', goal_priority: 'B', safety_scope: { executable: false }, sessions: [base] },
    decisive_evidence_ids: ['evidence-plan-level'],
  });
  for (const code of ['PHASE_CHANGED', 'GOAL_PRIORITY_CHANGED', 'SAFETY_SCOPE_CHANGED']) {
    assert.ok(planLevel.changes.some((change) => change.code === code));
  }
});

test('MAT-BOUNDARY-01', 'zero baselines use absolute or structural rules and minor changes never gain an auto-apply path', () => {
  const baseline = {
    session_id: 'support-zero', scheduled_local_date: '2026-08-03', workout_family: 'easy_run',
    role: 'SUPPORTING', distance_m: 0, work_duration_s: 0,
  };
  const minor = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [baseline] },
    candidate: { plan_revision: 3, sessions: [{ ...baseline, title: 'Cosmetic rename' }] },
  });
  assert.equal(minor.material_change, false);
  assert.equal(minor.auto_apply_allowed, false);
  const structural = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [baseline] },
    candidate: { plan_revision: 3, sessions: [{ ...baseline, work_duration_s: 60 }] },
  });
  assert.ok(structural.changes.some((change) => change.code === 'SESSION_DOSAGE_CHANGED'));
  const zeroVolume = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [baseline] },
    candidate: {
      plan_revision: 3,
      sessions: [{ ...baseline, scheduled_local_date: '2026-08-03', distance_m: 3219 }],
    },
  });
  assert.ok(zeroVolume.changes.some((change) => change.code === 'WEEKLY_RUNNING_VOLUME'));

  const unknown = {
    session_id: 'unknown-dosage', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING',
    target_pace_s_per_km: null, target_zone_number: null, work_duration_s: null, repetitions: null,
    station_distance_m: null, station_repetitions: null, load_kg: null, strength_hard_sets: null,
    derived_totals: { distance_m: null, work_duration_s: null, repetitions: null, station_distance_m: null },
    steps: [{ type: 'run', target: { pace_range_s_per_km: null, heart_rate_range_bpm: null } }],
  };
  const missing = {
    session_id: 'unknown-dosage', scheduled_local_date: '2026-08-03', workout_family: 'easy_run', role: 'SUPPORTING',
    derived_totals: {}, steps: [{ type: 'run', target: {} }],
  };
  const unknownToMissing = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknown] },
    candidate: { plan_revision: 3, sessions: [missing] },
  });
  assert.equal(unknownToMissing.material_change, false, 'unknown/null must not coerce to valid zero');
  const unknownToValidZero = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknown] },
    candidate: { plan_revision: 3, sessions: [{ ...missing, work_duration_s: 0 }] },
  });
  assert.ok(unknownToValidZero.changes.some((change) => (
    change.code === 'SESSION_DOSAGE_CHANGED' && change.field === 'work_duration_s'
  )), 'unknown-to-valid-zero is an explicit prescription value-state transition');

  const unknownDistance = { ...missing, distance_m: null, distance_miles: '' };
  const distanceMissing = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknownDistance] },
    candidate: { plan_revision: 3, sessions: [missing] },
  });
  assert.equal(distanceMissing.material_change, false);
  const distanceZero = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknownDistance] },
    candidate: { plan_revision: 3, sessions: [{ ...missing, distance_m: 0 }] },
  });
  assert.ok(distanceZero.changes.some((change) => change.code === 'WEEKLY_RUNNING_VOLUME_STATE_CHANGED'));
  const distancePositive = compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [{ ...missing, distance_m: 0 }] },
    candidate: { plan_revision: 3, sessions: [{ ...missing, distance_m: 3219 }] },
  });
  assert.ok(distancePositive.changes.some((change) => change.code === 'WEEKLY_RUNNING_VOLUME'));

  const unknownStrength = {
    session_id: 'unknown-strength', scheduled_local_date: '2026-08-04', workout_family: 'strength_lower',
    role: 'SUPPORTING', strength_hard_sets: null,
  };
  const missingStrength = {
    session_id: 'unknown-strength', scheduled_local_date: '2026-08-04', workout_family: 'strength_lower', role: 'SUPPORTING',
  };
  assert.equal(compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknownStrength] },
    candidate: { plan_revision: 3, sessions: [missingStrength] },
  }).material_change, false);
  assert.ok(compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [unknownStrength] },
    candidate: { plan_revision: 3, sessions: [{ ...missingStrength, strength_hard_sets: 0 }] },
  }).changes.some((change) => change.code === 'STRENGTH_HARD_SETS_CHANGED'));
  assert.ok(compareMaterialChange({
    active_applied_plan: { plan_revision: 2, sessions: [{ ...missingStrength, strength_hard_sets: 0 }] },
    candidate: { plan_revision: 3, sessions: [{ ...missingStrength, strength_hard_sets: 2 }] },
  }).changes.some((change) => change.code === 'STRENGTH_HARD_SETS_CHANGED'));
});

test('MAT-CANONICAL-01', 'nested canonical target and repeat changes are compared after materialization', () => {
  const materialized = enumerateGoalBackwardCandidates(roadMaterializationInput({
    target_context: {
      level_1_evidence: [{
        evidence_id: 'evidence-canonical-pace', quality_state: 'COMPLETE', freshness_class: 'FRESH',
        successful: true, target_type: 'threshold', workout_family: 'threshold_run',
        benchmark_protocol_id: 'threshold-protocol', benchmark_success_criteria_id: 'threshold-success',
        pace_s_per_km: 300, observed_at: '2026-08-10T12:00:00.000Z', confidence: 'HIGH',
      }],
      benchmark_protocol_id: 'threshold-protocol',
      benchmark_success_criteria_id: 'threshold-success',
    },
  }));
  const baseline = materialized.selected_candidate.canonical_sessions.find((session) => session.workout_family === 'threshold_run');
  const changedSteps = JSON.parse(JSON.stringify(baseline.steps));
  const finalWork = changedSteps.find((step) => step.step_id.endsWith('work-final'));
  finalWork.target.pace_range_s_per_km = { minimum: 270, maximum: 280 };
  const changed = buildCanonicalSession({
    ...baseline,
    plan_revision: baseline.plan_revision + 1,
    session_revision: baseline.session_revision + 1,
    steps: changedSteps,
  });
  const result = compareMaterialChange({
    active_applied_plan: { plan_revision: baseline.plan_revision, sessions: [baseline] },
    candidate: { plan_revision: changed.plan_revision, sessions: [changed] },
    decisive_evidence_ids: ['evidence-canonical-pace'],
  });
  assert.equal(result.material_change, true);
  assert.ok(result.changes.some((change) => change.code === 'TARGET_PACE_CHANGED'));
  assert.equal(result.preview_required, true);
  assert.equal(result.review_contract_complete, true);

  const repeatSteps = JSON.parse(JSON.stringify(baseline.steps));
  repeatSteps.find((step) => step.type === 'repeat').repeat_count -= 1;
  const repeatChanged = buildCanonicalSession({
    ...baseline,
    plan_revision: baseline.plan_revision + 1,
    session_revision: baseline.session_revision + 1,
    steps: repeatSteps,
  });
  const repeatResult = compareMaterialChange({
    active_applied_plan: { plan_revision: baseline.plan_revision, sessions: [baseline] },
    candidate: { plan_revision: repeatChanged.plan_revision, sessions: [repeatChanged] },
    decisive_evidence_ids: ['evidence-canonical-pace'],
  });
  assert.ok(repeatResult.changes.some((change) => (
    change.code === 'SESSION_DOSAGE_CHANGED' && ['work_duration_s', 'repetitions'].includes(change.field)
  )));
});

test('MAT-REVIEW-01', 'an incomplete material-review contract is a hard validation failure', () => {
  const result = validateGoalBackwardCandidate({
    sessions: [{
      session_id: 'material-review-key', scheduled_local_date: '2026-08-17', workout_family: 'threshold_run',
      role: 'PRIMARY_KEY', duration_min: 40, quality_work_duration_min: 10,
    }],
    material_change: {
      material_change: true, preview_required: true, review_required: true,
      review_contract_complete: false, baseline_plan_revision: 3, candidate_plan_revision: 4,
      changes: [{
        code: 'TARGET_PACE_CHANGED', review_required: true,
        reason_code: 'MATERIAL_CHANGE_REVIEW_REQUIRED', decisive_evidence_ids: [],
        baseline_plan_revision: 3, candidate_plan_revision: 4,
      }],
    },
  }, {
    available_local_dates: ['2026-08-17'], available_days_count: 5,
    training_age_class: 'ESTABLISHED', recovery_state: 'NORMAL', safety_action: 'NORMAL',
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason_codes.includes('MATERIAL_CHANGE_REVIEW_REQUIRED'));
  assert.ok(result.violations.some((violation) => violation.reason === 'REVIEW_CONTRACT_INCOMPLETE'));
});

test('PHASE-01', 'a safe useful peak exposure is retained before taper', () => {
  const result = selectGoalBackwardPhase({
    planning_date_local: '2026-08-03',
    goal: { event_state: 'SCHEDULED', event_local_date: '2026-08-19' },
    event_policy: eventPolicyFor('road_10mile_v1'),
    athlete_state: {
      training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', consistent_weeks: 8,
      recovery_state: 'NORMAL', safety_action: 'NORMAL', recent_normal_running: { status: 'ESTABLISHED' },
    },
    due_exposure_count: 1,
    safe_useful_peak_fits: true,
    development_gate_complete: true,
  });
  assert.equal(result.phase, 'EVENT_SPECIFIC_DEVELOPMENT');
  assert.ok(result.reason_codes.includes('PREMATURE_TAPER_PREVENTED'));
});

test('PHASE-02', 'late overload is prevented when its recovery buffer cannot fit', () => {
  const result = selectGoalBackwardPhase({
    planning_date_local: '2026-08-03',
    goal: { event_state: 'SCHEDULED', event_local_date: '2026-08-14' },
    event_policy: eventPolicyFor('road_10mile_v1'),
    athlete_state: {
      training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', consistent_weeks: 8,
      recovery_state: 'NORMAL', safety_action: 'NORMAL', recent_normal_running: { status: 'ESTABLISHED' },
    },
    due_exposure_count: 2,
    peak_exposure_complete: false,
  });
  assert.equal(result.phase, 'SHARPENING');
  assert.ok(result.reason_codes.includes('LATE_BUILD_PREVENTED'));
  assert.ok(result.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));
});

test('PHASE-03', 'a postponed race date produces a new phase decision and hash', () => {
  const base = {
    athlete_id: 'athlete-phase', planning_date_local: '2026-08-03', timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 2, evidence_snapshot_id: 'snapshot-phase', training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT', consistent_weeks: 8, recovery_state: 'NORMAL', safety_action: 'NORMAL',
      recent_normal_running: { status: 'ESTABLISHED', median_distance_m: 32000 }, available_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    },
    goals: [{ goal_id: 'goal-phase', race_id: 'race-phase', athlete_id: 'athlete-phase', priority: 'A', goal_type: 'performance', event_kind: 'ROAD_ENDURANCE', event_state: 'POSTPONED' }],
    races: [{ race_id: 'race-phase', athlete_id: 'athlete-phase' }],
    development_gate_complete: true,
  };
  const near = buildGoalBackwardPlanningDecision({ ...base, goals: [{ ...base.goals[0], event_local_date: '2026-08-12' }] });
  const postponed = buildGoalBackwardPlanningDecision({ ...base, goals: [{ ...base.goals[0], event_local_date: '2026-10-11' }] });
  assert.notEqual(near.phase, postponed.phase);
  assert.notEqual(near.decision_hash, postponed.decision_hash);
  assert.equal(Object.isFrozen(postponed), true);
});

test('PHASE-04', 'a completed A goal retains post-race transition before B promotion', () => {
  const input = {
    athlete_id: 'athlete-transition', planning_date_local: '2026-08-03', timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 1, evidence_snapshot_id: 'snapshot-transition', training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT', consistent_weeks: 8, recovery_state: 'NORMAL', safety_action: 'NORMAL',
      recent_normal_running: { status: 'ESTABLISHED', median_distance_m: 30000 }, available_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    },
    goals: [
      { goal_id: 'goal-a', race_id: 'race-a', athlete_id: 'athlete-transition', priority: 'A', event_kind: 'ROAD_SHORT', event_local_date: '2026-08-02', event_state: 'COMPLETED' },
      { goal_id: 'goal-b', race_id: 'race-b', athlete_id: 'athlete-transition', priority: 'B', event_kind: 'ROAD_ENDURANCE', event_local_date: '2026-10-11', event_state: 'SCHEDULED' },
    ],
    races: [{ race_id: 'race-a', athlete_id: 'athlete-transition' }, { race_id: 'race-b', athlete_id: 'athlete-transition' }],
  };
  const transition = buildGoalBackwardPlanningDecision({ ...input, transition_exit_met: false });
  const promoted = buildGoalBackwardPlanningDecision({ ...input, transition_exit_met: true });
  assert.equal(transition.primary_goal_id, 'goal-a');
  assert.equal(transition.phase, 'POST_RACE_TRANSITION');
  assert.equal(promoted.primary_goal_id, 'goal-b');
});

test('ROLE-01', 'beginner four-day role construction selects one primary key before dates', () => {
  const ledger = buildDueExposureLedger({
    event_policy: eventPolicyFor('road_10mile_v1'), phase: 'DEVELOPMENT',
    training_age_class: 'BEGINNER', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL', available_days_count: 4,
  });
  const roles = buildRoleMultiset({ exposure_ledger: ledger, training_age_class: 'BEGINNER', available_days_count: 4, recovery_state: 'NORMAL' });
  assert.equal(roles.filter((role) => role.role === 'PRIMARY_KEY').length, 1);
  assert.ok(roles.every((role) => role.scheduled_local_date === null));
});

test('ROLE-02', 'an established six-day athlete may use a third key only when it is upper-body or technique dominant', () => {
  const ledger = buildDueExposureLedger({
    event_policy: eventPolicyFor('road_10mile_v1'), phase: 'DEVELOPMENT',
    training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL', available_days_count: 6,
  });
  const accepted = buildRoleMultiset({
    exposure_ledger: ledger, training_age_class: 'ESTABLISHED', available_days_count: 6, recovery_state: 'NORMAL',
    tolerated_three_hard_stimuli: true,
    additional_primary_stimuli: [{ requirement_id: 'upper-key', any_of: ['strength_upper'], adaptation_id: 'upper-strength', upper_or_technique_dominant: true }],
  });
  const rejected = buildRoleMultiset({
    exposure_ledger: ledger, training_age_class: 'ESTABLISHED', available_days_count: 6, recovery_state: 'NORMAL',
    tolerated_three_hard_stimuli: true,
    additional_primary_stimuli: [{ requirement_id: 'lower-key', any_of: ['strength_lower'], adaptation_id: 'lower-strength', upper_or_technique_dominant: false }],
  });
  assert.equal(accepted.filter((role) => role.role === 'PRIMARY_KEY').length, 3);
  assert.equal(rejected.filter((role) => role.role === 'PRIMARY_KEY').length, 2);
  const candidate = validateGoalBackwardCandidate({ sessions: [
    { session_id: 'road-threshold', scheduled_local_date: '2026-08-03', workout_family: 'threshold_run', role: 'PRIMARY_KEY', duration_min: 50, quality_work_duration_min: 12 },
    { session_id: 'road-long', scheduled_local_date: '2026-08-06', workout_family: 'long_aerobic', role: 'PRIMARY_KEY', duration_min: 60 },
    { session_id: 'upper-key', scheduled_local_date: '2026-08-08', workout_family: 'strength_upper', role: 'PRIMARY_KEY', duration_min: 45, exercises: [{ working_sets: 3 }, { working_sets: 3 }] },
  ] }, {
    training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL',
    available_local_dates: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
    available_days_count: 6, tolerated_three_hard_stimuli: true, safety_action: 'NORMAL',
    median_ordinary_easy_duration_min: 30, required_exposure_ledger: ledger,
  });
  assert.equal(candidate.valid, true);
});

test('ROLE-03', 'mandatory HYROX role counts keep station skill supporting and record constrained long work', () => {
  const eligible = buildDueExposureLedger({
    event_policy: eventPolicyFor('hyrox_doubles_v1'), phase: 'EVENT_SPECIFIC_DEVELOPMENT', mandatory_hyrox_cluster: true,
    training_age_class: 'DEVELOPING', consistency_state: 'CONSISTENT', recovery_state: 'READY', available_days_count: 5,
  });
  assert.deepEqual(eligible.due_roles.map((entry) => [entry.requirement_id, entry.role]), [
    ['hyrox_team_partial_simulation', 'PRIMARY_KEY'], ['long_aerobic', 'PRIMARY_KEY'], ['hyrox_station_skill', 'SUPPORTING'],
  ]);
  const constrained = buildDueExposureLedger({
    event_policy: eventPolicyFor('hyrox_doubles_v1'), phase: 'EVENT_SPECIFIC_DEVELOPMENT', mandatory_hyrox_cluster: true,
    training_age_class: 'DEVELOPING', consistency_state: 'CONSISTENT', recovery_state: 'CAUTION', available_days_count: 4,
  });
  assert.deepEqual(constrained.due_roles.map((entry) => [entry.requirement_id, entry.role]), [
    ['hyrox_team_partial_simulation', 'PRIMARY_KEY'], ['hyrox_station_skill', 'SUPPORTING'],
  ]);
  assert.ok(constrained.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));
  assert.ok(constrained.unplaceable_requirement_ids.includes('long_aerobic'));
  assert.deepEqual(buildRoleMultiset({
    exposure_ledger: eligible, training_age_class: 'DEVELOPING', available_days_count: 5, recovery_state: 'READY',
  }).map((entry) => [entry.requirement_id, entry.role]), [
    ['hyrox_team_partial_simulation', 'PRIMARY_KEY'], ['long_aerobic', 'PRIMARY_KEY'], ['hyrox_station_skill', 'SUPPORTING'],
  ]);
  assert.deepEqual(buildRoleMultiset({
    exposure_ledger: constrained, training_age_class: 'DEVELOPING', available_days_count: 4, recovery_state: 'CAUTION',
  }).map((entry) => [entry.requirement_id, entry.role]), [
    ['hyrox_team_partial_simulation', 'PRIMARY_KEY'], ['hyrox_station_skill', 'SUPPORTING'],
  ]);
});

test('INT-01', 'threshold and heavy lower-body work inside the separation window fail', () => {
  const result = validateInterference([
    { session_id: 'threshold', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'threshold_run' },
    { session_id: 'lower', scheduled_start_at: '2026-08-04T07:00:00Z', workout_family: 'strength_lower' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].minimum_separation_hours, 24);
});

test('INT-02', 'compromised HYROX work requires forty-eight hours before intervals', () => {
  const result = validateInterference([
    { session_id: 'compromised', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'hyrox_compromised' },
    { session_id: 'intervals', scheduled_start_at: '2026-08-05T07:00:00Z', workout_family: 'interval_run' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].minimum_separation_hours, 48);
});

test('INT-03', 'an intentional hard-day stack without a following recovery day is rejected', () => {
  const result = validateInterference([
    { session_id: 'threshold-stack', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'threshold_run', intentional_stack: true },
    { session_id: 'lower-stack', scheduled_start_at: '2026-08-03T17:00:00Z', workout_family: 'strength_lower', intentional_stack: true },
    { session_id: 'next-hard', scheduled_start_at: '2026-08-04T08:00:00Z', workout_family: 'long_aerobic' },
  ], {
    training_age_class: 'ESTABLISHED', recovery_state: 'NORMAL', safety_action: 'NORMAL',
    tolerated_stack_patterns: [['threshold_run', 'strength_lower']], combined_stress_passes: true,
    stacking_protects_recovery_day: true, reason_codes: ['HARD_DAY_STACK_TO_PROTECT_RECOVERY'],
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === 'INTENTIONAL_STACK_RECOVERY_REQUIRED'));
});

test('INT-STACK-01', 'an intentional stack is eligible only when every tolerance and recovery gate passes', () => {
  const result = validateInterference([
    { session_id: 'threshold-stack-ok', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'threshold_run', intentional_stack: true },
    { session_id: 'lower-stack-ok', scheduled_start_at: '2026-08-03T17:00:00Z', workout_family: 'strength_lower', intentional_stack: true },
    { session_id: 'next-easy', scheduled_start_at: '2026-08-04T08:00:00Z', workout_family: 'easy_run' },
  ], {
    training_age_class: 'ESTABLISHED', recovery_state: 'NORMAL', safety_action: 'NORMAL',
    tolerated_stack_patterns: [['threshold_run', 'strength_lower']], combined_stress_passes: true,
    stacking_protects_recovery_day: true, reason_codes: ['HARD_DAY_STACK_TO_PROTECT_RECOVERY'],
  });
  assert.equal(result.valid, true);
});

test('INT-MATRIX-01', 'sled, peak-simulation, and full-simulation predicates enforce their longest separations', () => {
  const sled = validateInterference([
    {
      session_id: 'sled', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'hyrox_station_strength',
      steps: [{ station_id: 'sled_push', distance_m: 60, official_distance_m: 100 }],
    },
    { session_id: 'quality', scheduled_start_at: '2026-08-05T07:00:00Z', workout_family: 'race_rhythm_run' },
  ], { training_age_class: 'ESTABLISHED' });
  const peak = validateInterference([
    { session_id: 'peak', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'hyrox_partial_simulation' },
    { session_id: 'hard-lower', scheduled_start_at: '2026-08-05T07:00:00Z', workout_family: 'strength_full_body' },
  ], { training_age_class: 'ESTABLISHED' });
  const race = validateInterference([
    { session_id: 'full-sim', scheduled_local_date: '2026-08-03', workout_family: 'hyrox_full_simulation' },
    { session_id: 'race', scheduled_local_date: '2026-08-16', workout_family: 'race', event_kind: 'HYROX_SINGLES' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(sled.violations[0].minimum_separation_hours, 48);
  assert.equal(peak.violations[0].minimum_separation_hours, 48);
  assert.equal(race.violations[0].minimum_separation_hours, 336);
});

test('INT-04', 'canonical lower-strength family and vector defeat a misleading title', () => {
  const result = validateInterference([
    { session_id: 'misleading', title: 'Gentle mobility', scheduled_start_at: '2026-08-03T08:00:00Z', workout_family: 'strength_lower' },
    { session_id: 'long', scheduled_start_at: '2026-08-04T18:00:00Z', workout_family: 'long_aerobic' },
  ], { training_age_class: 'ESTABLISHED' });
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].minimum_separation_hours, 36);
});

test('VALIDATOR-01', 'availability, lock-shaped input, roles, exposure, presentation, and safety are hard failures', () => {
  const result = validateGoalBackwardCandidate({
    sessions: [
      { session_id: 'locked-long', scheduled_local_date: '2026-08-08', workout_family: 'long_aerobic', role: 'PRIMARY_KEY', duration_min: 25 },
      { session_id: 'filler', scheduled_local_date: '2026-08-06', workout_family: 'easy_run', role: 'SUPPORTING', duration_min: 30 },
    ],
  }, {
    available_local_dates: ['2026-08-03', '2026-08-04', '2026-08-08'],
    locks: [{ constraint_kind: 'day_lock', local_date: '2026-08-09', role: 'PRIMARY_KEY', workout_family: 'long_aerobic' }],
    manual_edits: [{ session_id: 'filler', workout_family: 'interval_run', owner: 'athlete' }],
    required_exposure_ledger: [
      { requirement_id: 'long_aerobic', any_of: ['long_aerobic'], role: 'PRIMARY_KEY' },
      { requirement_id: 'threshold', any_of: ['threshold_run'], role: 'PRIMARY_KEY' },
    ],
    training_age_class: 'ESTABLISHED', median_ordinary_easy_duration_min: 30, safety_action: 'NO_RUNNING',
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason_codes.includes('SCHEDULE_CONSTRAINT'));
  assert.ok(result.reason_codes.includes('ATHLETE_LOCK_CONFLICT'));
  assert.ok(result.reason_codes.includes('ATHLETE_EDIT_PRESERVED'));
  assert.ok(result.reason_codes.includes('SESSION_ROLE_UNJUSTIFIED'));
  assert.ok(result.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));
  assert.ok(result.reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION'));
  assert.ok(result.reason_codes.includes('NO_RUNNING'));
});

test('RUNWAY-01', 'too-short runway records due work as unplaceable instead of cramming it', () => {
  const ledger = buildDueExposureLedger({
    event_policy: eventPolicyFor('road_10mile_v1'), phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL', available_days_count: 5,
    planning_date_local: '2026-08-03', event_local_date: '2026-08-14',
  });
  assert.equal(ledger.runway_conflict, true);
  assert.ok(ledger.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));
  assert.ok(ledger.reason_codes.includes('LATE_BUILD_PREVENTED'));
});

test('CANDIDATE-SKELETON-01', 'candidate construction preserves role-first ordering and never trusts legacy dates', () => {
  const decision = buildGoalBackwardPlanningDecision({
    athlete_id: 'athlete-skeleton', planning_date_local: '2026-08-03', timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 1, evidence_snapshot_id: 'snapshot-skeleton', training_age_class: 'BEGINNER',
      consistency_state: 'CONSISTENT', consistent_weeks: 5, recovery_state: 'NORMAL', safety_action: 'NORMAL',
      recent_normal_running: { status: 'PROVISIONAL', median_distance_m: 16000 }, available_days: ['Mon', 'Wed', 'Fri', 'Sun'],
    },
    goals: [{ goal_id: 'goal-skeleton', race_id: 'race-skeleton', athlete_id: 'athlete-skeleton', priority: 'A', event_kind: 'ROAD_ENDURANCE', event_local_date: '2026-10-11', event_state: 'SCHEDULED' }],
    races: [{ race_id: 'race-skeleton', athlete_id: 'athlete-skeleton' }],
  });
  const skeleton = buildGoalBackwardCandidateSkeleton({
    decision,
    legacy_road_candidate_material: [{ id: 'legacy-key', date: '2026-08-09', workout_id: 'tempo_threshold', title: 'Threshold intervals' }],
  });
  assert.equal(Object.isFrozen(skeleton), true);
  assert.ok(skeleton.role_multiset.length > 0);
  assert.ok(skeleton.sessions.every((session) => session.scheduled_local_date === null));
  assert.equal(skeleton.candidate_material[0].legacy_scheduled_local_date, '2026-08-09');
});

function boundedEnumerationInput(overrides = {}) {
  const availableLocalDates = Array.from({ length: 9 }, (_, index) => `2026-08-${String(index + 3).padStart(2, '0')}`);
  return {
    decision: {
      decision_id: 'decision-enumeration',
      decision_hash: canonicalHash({ fixture: 'bounded-enumeration' }),
      phase: 'DEVELOPMENT',
      primary_goal_id: 'goal-enumeration',
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      athlete_locks: [],
      manual_edits: [],
      role_multiset: [
        { requirement_id: 'primary-aerobic', any_of: ['mobility'], role: 'PRIMARY_KEY', scheduled_local_date: null },
        { requirement_id: 'primary-recovery', any_of: ['manual_recovery'], role: 'PRIMARY_KEY', scheduled_local_date: null },
      ],
      due_exposure_ledger: {
        due_roles: [
          { requirement_id: 'primary-aerobic', any_of: ['mobility'], role: 'PRIMARY_KEY' },
          { requirement_id: 'primary-recovery', any_of: ['manual_recovery'], role: 'PRIMARY_KEY' },
        ],
        unplaceable_requirement_ids: [],
      },
    },
    available_local_dates: availableLocalDates,
    maximum_session_count: 2,
    validation_options: {
      available_local_dates: availableLocalDates,
      available_days_count: availableLocalDates.length,
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
    },
    selected_weekly_stress_targets: [4, 4, 2, 0, 0, 2, 2, 1],
    selected_running_volume_m: 0,
    ...overrides,
  };
}

test('CAND-BOUND-01', 'candidate enumeration retains at most 64 unique canonical hashes and records truncation', () => {
  const result = enumerateGoalBackwardCandidates(boundedEnumerationInput());
  assert.equal(result.candidates.length, 64);
  assert.equal(new Set(result.candidates.map((candidate) => candidate.candidate_hash)).size, 64);
  assert.equal(result.total_unique_candidate_count, 81);
  assert.equal(result.truncation_reason, 'CANDIDATE_ENUMERATION_TRUNCATED_64');
  assert.equal(result.decision.candidate_ids.length, 64);
});

test('CAND-VALIDATORS-01', 'every hard validator executes and rejected candidates retain all reason codes', () => {
  const invalid = validateGoalBackwardCandidate({
    sessions: [{
      session_id: 'not-due',
      scheduled_local_date: '2026-08-04',
      workout_family: 'easy_run',
      role: 'PRIMARY_KEY',
    }],
  }, {
    allowed_requirement_ids: ['due-only'],
    maximum_session_count: 1,
    required_exposure_ledger: [{ requirement_id: 'due-only', any_of: ['threshold_run'], role: 'PRIMARY_KEY' }],
    available_local_dates: ['2026-08-03'],
    workload_evidence: { valid: false, violations: [{ code: 'WEEKLY_DIMENSION_CEILING' }] },
    safety_action: 'FULL_REST',
  });
  assert.deepEqual(invalid.validator_results.map((result) => result.validator), HARD_VALIDATOR_NAMES);
  assert.equal(invalid.validator_results.every((result) => typeof result.valid === 'boolean'), true);
  assert.ok(invalid.reason_codes.includes('SESSION_ROLE_UNJUSTIFIED'));
  assert.ok(invalid.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));
  assert.ok(invalid.reason_codes.includes('SCHEDULE_CONSTRAINT'));
  assert.ok(invalid.reason_codes.includes('CROSS_MODAL_FATIGUE_LIMIT'));
  assert.ok(invalid.reason_codes.includes('FULL_REST'));

  const rejected = enumerateGoalBackwardCandidates(boundedEnumerationInput({
    validation_options: {
      ...boundedEnumerationInput().validation_options,
      safety_action: 'FULL_REST',
    },
  }));
  assert.equal(rejected.selected_candidate, null);
  assert.equal(rejected.decision.rejected_candidates.length, 64);
  assert.equal(rejected.decision.rejected_candidates.every((candidate) => candidate.reason_codes.includes('FULL_REST')), true);
});

test('CAND-RANK-01', 'zero-failure candidates rank by the approved lexicographic tuple', () => {
  const strongestExposure = {
    candidate_hash: 'b'.repeat(64),
    ranking_tuple: {
      due_primary_exposures_satisfied: 2,
      material_change_count: 5,
      stress_target_absolute_deviation: 8,
      running_volume_absolute_deviation_m: 5000,
      preferred_day_matches: 0,
      ordered_session_tuple: [['2026-08-08', 0, 'easy_run', 'b']],
    },
  };
  const fewerChanges = {
    candidate_hash: 'a'.repeat(64),
    ranking_tuple: {
      ...strongestExposure.ranking_tuple,
      due_primary_exposures_satisfied: 1,
      material_change_count: 0,
      ordered_session_tuple: [['2026-08-03', 0, 'easy_run', 'a']],
    },
  };
  assert.ok(compareGoalBackwardCandidateRankings(strongestExposure, fewerChanges) < 0);

  const tiedExposure = {
    ...fewerChanges,
    ranking_tuple: { ...fewerChanges.ranking_tuple, due_primary_exposures_satisfied: 2 },
  };
  assert.ok(compareGoalBackwardCandidateRankings(tiedExposure, strongestExposure) < 0);
});

test('CAND-01', 'one hundred repeated bounded generations select the identical canonical hash', () => {
  const selectedHashes = Array.from({ length: 100 }, () => (
    enumerateGoalBackwardCandidates(boundedEnumerationInput()).selected_candidate?.candidate_hash
  ));
  assert.equal(selectedHashes.every((hash) => hash === selectedHashes[0]), true);
  assert.match(selectedHashes[0], /^[a-f0-9]{64}$/);
});

function roadMaterializationInput(overrides = {}) {
  const dates = ['2026-08-17', '2026-08-19', '2026-08-22'];
  return {
    decision: {
      decision_id: 'decision-road-materialized',
      decision_hash: canonicalHash({ fixture: 'road-materialized' }),
      plan_id: 'active-plan-road',
      plan_revision: 3,
      phase: 'DEVELOPMENT',
      timezone: 'America/New_York',
      primary_goal_id: 'goal-road-materialized',
      active_goals: [{ goal_id: 'goal-road-materialized', source_revision: 2 }],
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      safety_state: { action: 'NORMAL', scope: [] },
      evidence_used: ['evidence-road-materialized'],
      athlete_locks: [],
      manual_edits: [],
      role_multiset: [
        { requirement_id: 'quality', any_of: ['threshold_run'], role: 'PRIMARY_KEY', scheduled_local_date: null },
        { requirement_id: 'easy', any_of: ['easy_run'], role: 'SUPPORTING', supports_requirement_id: 'quality', scheduled_local_date: null },
      ],
      due_exposure_ledger: {
        due_roles: [
          { requirement_id: 'quality', any_of: ['threshold_run'], role: 'PRIMARY_KEY' },
          { requirement_id: 'easy', any_of: ['easy_run'], role: 'SUPPORTING' },
        ],
        unplaceable_requirement_ids: [],
      },
    },
    available_local_dates: dates,
    maximum_session_count: 2,
    legacy_road_candidate_material: [
      {
        id: 'road-quality', workout_id: 'tempo_threshold', kind: 'run', title: 'Threshold intervals',
        prescription_basis: 'time', duration_min: 50, distance_miles: 6, distance_is_estimate: true,
        quality_prescription: { repetitions: 4, work: '5 min threshold', recovery: { duration: '2 min', type: 'easy jog' } },
        warmup: ['15 min easy running'], cooldown: ['10 min easy running'],
      },
      {
        id: 'road-easy', workout_id: 'easy_aerobic', kind: 'run', title: 'Easy aerobic run',
        prescription_basis: 'time', duration_min: 30, distance_miles: 3, distance_is_estimate: true,
      },
    ],
    validation_options: {
      available_local_dates: dates,
      available_days_count: dates.length,
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
    },
    materialize_canonical: true,
    planning_instant: '2026-08-14T12:00:00.000Z',
    ...overrides,
  };
}

test('CAND-MATERIALIZE-01', 'accepted road candidates validate executable canonical sessions before selection', () => {
  const result = enumerateGoalBackwardCandidates(roadMaterializationInput());
  assert.ok(result.selected_candidate);
  assert.equal(result.selected_candidate.canonical_sessions_materialized, true);
  assert.equal(result.selected_candidate.canonical_sessions.length, 2);
  assert.equal(result.selected_candidate.canonical_session_set.plan_revision, 4);
  assert.equal(result.selected_candidate.canonical_plan.schemaVersion, 2);
  assert.equal(result.selected_candidate.validation.valid, true);
  assert.ok(result.selected_candidate.validation.validator_results.some((entry) => entry.validator === 'canonical_session_set'));
  assert.equal(result.selected_candidate.canonical_sessions.every((session) => session.decision_id === result.decision.decision_id), true);
  assert.equal(result.selected_candidate.canonical_sessions.every((session) => session.content_hash.length === 64), true);
});

test('CAND-WEEK-01', 'a below-floor canonical session is rejected before any internal preview can be selected', () => {
  const input = roadMaterializationInput();
  const result = enumerateGoalBackwardCandidates({
    ...input,
    decision: {
      ...input.decision,
      role_multiset: [{ requirement_id: 'recovery', any_of: ['recovery_run'], role: 'RECOVERY', scheduled_local_date: null }],
      due_exposure_ledger: {
        due_roles: [{ requirement_id: 'recovery', any_of: ['recovery_run'], role: 'RECOVERY' }],
        unplaceable_requirement_ids: [],
      },
    },
    maximum_session_count: 1,
    legacy_road_candidate_material: [{
      id: 'token-recovery', workout_id: 'recovery_run', kind: 'run', title: 'Recovery run',
      prescription_basis: 'time', duration_min: 11, distance_miles: 1, distance_is_estimate: true,
    }],
  });
  assert.equal(result.selected_candidate, null);
  assert.equal(result.candidates.every((candidate) => candidate.canonical_sessions_materialized), true);
  assert.equal(result.candidates.every((candidate) => candidate.validation.reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')), true);
});

test('MAT-SESSION-BINDING-01', 'material review items must identify the actual canonical session revision and hash', () => {
  const input = roadMaterializationInput({
    active_applied_plan: {
      plan_revision: 3,
      sessions: [{
        session_id: 'road-quality', scheduled_local_date: '2026-08-17', workout_family: 'interval_run',
        role: 'PRIMARY_KEY', duration_min: 50, distance_miles: 6,
      }],
    },
  });
  const result = enumerateGoalBackwardCandidates(input);
  assert.ok(result.selected_candidate?.material_change?.material_change);
  const tampered = JSON.parse(JSON.stringify(result.selected_candidate));
  const sessionItem = tampered.material_change.changes.find((item) => item.session_id && item.candidate_binding_state === 'CANONICAL');
  assert.ok(sessionItem);
  sessionItem.candidate_session_revision = null;
  sessionItem.candidate_session_content_hash = null;
  const validation = validateGoalBackwardCandidate(tampered, {
    ...input.validation_options,
    required_exposure_ledger: input.decision.due_exposure_ledger,
    available_local_dates: input.available_local_dates,
  });
  const materialReview = validation.validator_results.find((entry) => entry.validator === 'material_review');
  assert.equal(materialReview.valid, false);
  assert.ok(materialReview.violations.some((violation) => violation.reason === 'MATERIAL_ITEM_BINDING_INCOMPLETE'));

  const fabricated = JSON.parse(JSON.stringify(result.selected_candidate));
  const fabricatedItem = fabricated.material_change.changes.find((item) => item.session_id);
  fabricatedItem.session_id = 'never-existed';
  fabricatedItem.baseline_binding_state = 'NOT_APPLICABLE';
  fabricatedItem.baseline_session_revision = null;
  fabricatedItem.baseline_session_content_hash = null;
  fabricatedItem.candidate_binding_state = 'REMOVED';
  fabricatedItem.candidate_session_revision = null;
  fabricatedItem.candidate_session_content_hash = null;
  const fabricatedValidation = validateGoalBackwardCandidate(fabricated, {
    ...input.validation_options,
    required_exposure_ledger: input.decision.due_exposure_ledger,
    available_local_dates: input.available_local_dates,
  });
  const fabricatedReview = fabricatedValidation.validator_results.find((entry) => entry.validator === 'material_review');
  assert.equal(fabricatedReview.valid, false);
});

assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
console.log(`GOAL-BACKWARD PLANNING SMOKE OK (${results.length} checks)`);
