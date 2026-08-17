const assert = require('node:assert/strict');

const {
  validateGoalBackwardCandidate,
  validateMaterialDose,
} = require('../src/lib/goalBackwardValidators');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { enumerateGoalBackwardCandidates } = require('../src/lib/racePlanCandidateEngine');
const {
  buildDueExposureLedger,
  buildGoalBackwardPlanningDecision,
  buildScopedRecoverySafetyState,
} = require('../src/lib/goalBackwardDecisionEngine');

const METERS_PER_MILE = 1609.344;

function runSession(sessionId, family, miles, date) {
  return {
    session_id: sessionId,
    scheduled_local_date: date,
    workout_family: family,
    role: family === 'long_aerobic' ? 'PRIMARY_KEY' : 'SUPPORTING',
    distance_miles: miles,
    duration_min: Math.round(miles * 11),
  };
}

const historicalCandidate = [
  runSession('incident-easy', 'easy_run', 2.2, '2026-08-17'),
  runSession('incident-compromised', 'hyrox_compromised', 1.24, '2026-08-20'),
  runSession('incident-long', 'long_aerobic', 3.5, '2026-08-23'),
];

const historical = validateMaterialDose(historicalCandidate, {
  phase: 'EVENT_SPECIFIC_DEVELOPMENT',
  recent_normal_running: {
    status: 'ESTABLISHED',
    median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE',
    value_state: 'KNOWN',
  },
});

assert.equal(historical.validator, 'material_dose');
assert.equal(historical.valid, false);
assert.ok(historical.reason_codes.includes('MATERIAL_UNDERTRAINING'));
assert.deepEqual(historical.receipt.comparators.recent_normal, {
  source: 'RECENT_NORMAL_RUNNING',
  baseline_m: 20116.8,
  candidate_m: 11168.847,
  absolute_change_m: -8947.953,
  percentage_change: -44.48,
  material_reduction: true,
});

console.log('ok - C3-DOSE-01 historical 12.5 to 6.94 unsupported material reduction rejects');

for (const baselineMiles of [10.2, 10.3]) {
  const deduped = validateMaterialDose(historicalCandidate, {
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    recent_normal_running: {
      status: 'ESTABLISHED',
      median_distance_m: baselineMiles * METERS_PER_MILE,
      sync_state: 'COMPLETE',
      value_state: 'KNOWN',
    },
  });
  assert.equal(deduped.valid, false, `${baselineMiles} miles remains a material comparator`);
  assert.ok(deduped.reason_codes.includes('MATERIAL_UNDERTRAINING'));
}
console.log('ok - C3-DOSE-02 C2-deduped 10.2 and 10.3 baselines still reject 6.94');

const activeComparator = enumerateGoalBackwardCandidates({
  decision: {
    decision_id: 'decision-active-comparator',
    decision_hash: canonicalHash({ fixture: 'active-comparator' }),
    plan_id: 'active-comparator-plan',
    plan_revision: 8,
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-active-comparator',
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_state: { action: 'NORMAL', scope: [] },
    evidence_used: ['evidence-active-comparator'],
    athlete_locks: [],
    manual_edits: [],
    role_multiset: [{ requirement_id: 'mobility', any_of: ['mobility'], role: 'RECOVERY' }],
    due_exposure_ledger: {
      due_roles: [{ requirement_id: 'mobility', any_of: ['mobility'], role: 'RECOVERY' }],
      unplaceable_requirement_ids: [],
    },
    recent_normal_running: {
      status: 'INSUFFICIENT', sync_state: 'PARTIAL', value_state: 'UNKNOWN', median_distance_m: null,
    },
  },
  available_local_dates: ['2026-08-17'],
  maximum_session_count: 1,
  active_applied_plan: {
    plan_revision: 8,
    sessions: [runSession('active-easy', 'easy_run', 5, '2026-08-17')],
  },
  validation_options: {
    available_local_dates: ['2026-08-17'],
    available_days_count: 5,
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_action: 'NORMAL',
  },
  materialize_canonical: false,
});
assert.equal(activeComparator.selected_candidate, null);
assert.ok(activeComparator.rejected_candidates[0].reason_codes.includes('MATERIAL_UNDERTRAINING'));
console.log('ok - C3-DOSE-03 active applied plan catches material removal with incomplete recent-normal evidence');

const scopedActiveComparator = validateMaterialDose([
  runSession('candidate-week', 'easy_run', 5, '2026-08-17'),
], {
  available_local_dates: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'],
  recent_normal_running: { status: 'INSUFFICIENT', sync_state: 'PARTIAL', value_state: 'UNKNOWN' },
  active_applied_plan: {
    sessions: [
      runSession('active-same-week', 'easy_run', 5, '2026-08-17'),
      runSession('active-later-week', 'long_aerobic', 40, '2026-08-30'),
    ],
  },
});
assert.equal(scopedActiveComparator.valid, true);
assert.equal(scopedActiveComparator.receipt.comparators.active_plan.baseline_m, 8046.72);
console.log('ok - C3-DOSE-04 active-plan comparison is scoped to the candidate week, not the full block');

function scopedRestriction(reasonCode, overrides = {}) {
  return {
    scope: 'BLOCK_MULTI_DAY',
    reason_code: reasonCode,
    starts_at: '2026-08-16T12:00:00.000Z',
    expires_at: '2026-08-23T12:00:00.000Z',
    reevaluate_at: '2026-08-17T12:00:00.000Z',
    decisive_evidence_ids: [`evidence-${reasonCode.toLowerCase()}`],
    affected_modalities: ['RUNNING'],
    ...overrides,
  };
}

const sleepOnly = validateMaterialDose(historicalCandidate, {
  phase: 'EVENT_SPECIFIC_DEVELOPMENT',
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('RECOVERY_VOLUME_REDUCTION', {
    scope: 'ACUTE_24_48H',
    expires_at: '2026-08-18T12:00:00.000Z',
    decisive_evidence_ids: ['evidence-low-sleep'],
  }),
});
assert.equal(sleepOnly.valid, false);
assert.equal(sleepOnly.receipt.qualifying_restriction.qualifies_weekly_reduction, false);
assert.ok(sleepOnly.receipt.qualifying_restriction.contract_errors.includes('ACUTE_SCOPE_CANNOT_JUSTIFY_WEEKLY_REDUCTION'));

const sleepOnlyLedger = buildDueExposureLedger({
  event_policy: require('../src/lib/racePlanPolicy').eventPolicyFor('hyrox_doubles_v1'),
  phase: 'EVENT_SPECIFIC_DEVELOPMENT',
  mandatory_hyrox_cluster: true,
  planning_date_local: '2026-08-16',
  event_local_date: '2026-09-20',
  training_age_class: 'ESTABLISHED',
  consistency_state: 'CONSISTENT',
  recovery_state: 'RECOVERY',
  safety_action: 'NORMAL',
  prospective_block_restriction: false,
  available_days_count: 6,
});
assert.deepEqual(sleepOnlyLedger.unplaceable_requirement_ids, []);
assert.ok(sleepOnlyLedger.due_roles.some((role) => role.requirement_id === 'long_aerobic'));
console.log('ok - C3-SCOPE-01 sleep-only recovery is acute and does not erase future-week roles');

for (const reasonCode of ['INJURY_SCOPE', 'ILLNESS_RECOVERY', 'RECOVERY_VOLUME_REDUCTION']) {
  const allowed = validateMaterialDose(historicalCandidate, {
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    recent_normal_running: {
      status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
      sync_state: 'COMPLETE', value_state: 'KNOWN',
    },
    dose_restriction: scopedRestriction(reasonCode),
  });
  assert.equal(allowed.valid, true, `${reasonCode} complete scoped receipt permits the bounded reduction`);
  assert.equal(allowed.receipt.qualifying_restriction.qualifies_weekly_reduction, true);
}
const incompleteSafety = validateMaterialDose(historicalCandidate, {
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('INJURY_SCOPE', { expires_at: null, reevaluate_at: null }),
});
assert.equal(incompleteSafety.valid, false);
assert.ok(incompleteSafety.reason_codes.includes('MATERIAL_UNDERTRAINING'));

const expiredSafety = validateMaterialDose(historicalCandidate, {
  planning_instant: '2026-08-24T00:00:00.000Z',
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('INJURY_SCOPE'),
});
assert.equal(expiredSafety.valid, false);
assert.ok(expiredSafety.receipt.qualifying_restriction.contract_errors.includes('RESTRICTION_EXPIRED'));
console.log('ok - C3-SCOPE-02 safety and illness reductions require evidence, scope, time, and modalities');

const taper = validateMaterialDose(historicalCandidate, {
  phase: 'TAPER_RACE_WEEK',
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('TAPER_VOLUME_REDUCTION', { scope: 'TAPER_WINDOW' }),
});
assert.equal(taper.valid, true);
assert.equal(taper.receipt.qualifying_restriction.reason_code, 'TAPER_VOLUME_REDUCTION');

const returning = validateMaterialDose(historicalCandidate, {
  phase: 'FOUNDATION',
  training_age_class: 'RETURNING',
  active_applied_plan: {
    sessions: [runSession('prior-normal', 'easy_run', 12.5, '2026-08-17')],
  },
  recent_normal_running: {
    status: 'TRAINING_GAP', sync_state: 'COMPLETE', value_state: 'UNKNOWN', median_distance_m: null,
  },
  dose_restriction: scopedRestriction('TRAINING_GAP_REBUILD', { scope: 'TRAINING_GAP_REBUILD' }),
});
assert.equal(returning.valid, true);
assert.equal(returning.receipt.qualifying_restriction.reason_code, 'TRAINING_GAP_REBUILD');
console.log('ok - C3-SCOPE-03 taper and returning rebuild preserve deterministic reduction receipts');

const unrelatedCrossModal = validateMaterialDose(historicalCandidate, {
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('CROSS_MODAL_FATIGUE_LIMIT', {
    scope: 'CROSS_MODAL_LIMIT',
    dimension_ledger: [{
      dimension: 'lower_body_muscular', affected_modality: 'STRENGTH',
      projected_without_reduction: 15, authorized_ceiling: 12,
    }],
  }),
});
assert.equal(unrelatedCrossModal.valid, false);

const linkedCrossModal = validateMaterialDose(historicalCandidate, {
  recent_normal_running: {
    status: 'ESTABLISHED', median_distance_m: 12.5 * METERS_PER_MILE,
    sync_state: 'COMPLETE', value_state: 'KNOWN',
  },
  dose_restriction: scopedRestriction('CROSS_MODAL_FATIGUE_LIMIT', {
    scope: 'CROSS_MODAL_LIMIT',
    dimension_ledger: [{
      dimension: 'running_impact', affected_modality: 'RUNNING',
      projected_without_reduction: 15, authorized_ceiling: 12,
    }],
  }),
});
assert.equal(linkedCrossModal.valid, true);
assert.equal(linkedCrossModal.receipt.qualifying_restriction.dimension_ledger[0].dimension, 'running_impact');
console.log('ok - C3-XLOAD-01 cross-modal reduction requires a measured run-dimension ledger');

const sleepSafety = buildScopedRecoverySafetyState({
  recovery: { state: 'recovery', readinessScore: 43 },
  safety: { activeInjury: false, comebackMode: false },
  checkin: null,
}, '2026-08-16');
assert.equal(sleepSafety.action, 'NORMAL');
assert.deepEqual(sleepSafety.scope, ['RUN']);
assert.equal(sleepSafety.restriction.scope, 'ACUTE_24_48H');
assert.equal(sleepSafety.restriction.reevaluate_at, '2026-08-17T12:00:00.000Z');
assert.equal(sleepSafety.restriction.expires_at, '2026-08-18T12:00:00.000Z');

const injurySafety = buildScopedRecoverySafetyState({
  recovery: { state: 'low', readinessScore: 40 },
  safety: { activeInjury: true, comebackMode: false },
  checkin: { lifeFlags: ['injured'] },
}, '2026-08-16');
assert.equal(injurySafety.action, 'MODIFY_IMPACT');
assert.equal(injurySafety.restriction.reason_code, 'INJURY_SCOPE');
assert.equal(injurySafety.restriction.scope, 'BLOCK_MULTI_DAY');

const illnessSafety = buildScopedRecoverySafetyState({
  recovery: { state: 'low', readinessScore: 40 },
  safety: { activeInjury: false, comebackMode: false },
  checkin: { lifeFlags: ['sick'] },
  evidence_snapshot_id: 'snapshot-illness-synthetic',
}, '2026-08-16');
assert.equal(illnessSafety.action, 'NO_HIGH_INTENSITY');
assert.equal(illnessSafety.restriction.reason_code, 'ILLNESS_RECOVERY');
assert.deepEqual(illnessSafety.restriction.decisive_evidence_ids, ['snapshot-illness-synthetic']);

const returningSafety = buildScopedRecoverySafetyState({
  recovery: { state: 'low', readinessScore: null },
  safety: { activeInjury: false, comebackMode: true },
  checkin: null,
}, '2026-08-16');
assert.equal(returningSafety.action, 'MONITOR');
assert.equal(returningSafety.restriction.reason_code, 'TRAINING_GAP_REBUILD');
console.log('ok - C3-SCOPE-04 route safety assembly emits deterministic acute and block receipts without diagnosis');

function decisionFixture(athleteState, goalOverrides = {}, inputOverrides = {}) {
  return buildGoalBackwardPlanningDecision({
    athlete_id: 'athlete-c3-decision',
    planning_date_local: '2026-08-16',
    timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 3,
      evidence_snapshot_id: 'snapshot-c3-decision',
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      consistent_weeks: 8,
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
      recent_normal_running: {
        status: 'ESTABLISHED', median_distance_m: 10 * METERS_PER_MILE,
        sync_state: 'COMPLETE', value_state: 'KNOWN',
      },
      available_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      ...athleteState,
    },
    goals: [{
      goal_id: 'goal-c3-decision', race_id: 'race-c3-decision', athlete_id: 'athlete-c3-decision',
      priority: 'A', event_kind: 'ROAD_ENDURANCE', event_local_date: '2026-08-20',
      event_state: 'SCHEDULED', source_revision: 2, ...goalOverrides,
    }],
    races: [{ race_id: 'race-c3-decision', athlete_id: 'athlete-c3-decision' }],
    evidence_used: [{ evidence_id: 'evidence-c3-decision', purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
    ...inputOverrides,
  });
}

const taperDecision = decisionFixture({});
assert.equal(taperDecision.phase, 'TAPER_RACE_WEEK');
assert.equal(taperDecision.dose_restriction.reason_code, 'TAPER_VOLUME_REDUCTION');
assert.ok(taperDecision.reason_codes.includes('TAPER_VOLUME_REDUCTION'));

const acuteTaperDecision = decisionFixture({
  dose_restriction: scopedRestriction('RECOVERY_VOLUME_REDUCTION', { scope: 'ACUTE_24_48H' }),
});
assert.equal(acuteTaperDecision.dose_restriction.reason_code, 'TAPER_VOLUME_REDUCTION');

const gapDecision = decisionFixture({
  training_age_class: 'RETURNING', consistency_state: 'RETURNING', consistent_weeks: 0,
  recent_normal_running: { status: 'TRAINING_GAP', sync_state: 'COMPLETE', value_state: 'UNKNOWN' },
}, { event_local_date: '2026-10-20' });
assert.equal(gapDecision.phase, 'FOUNDATION');
assert.equal(gapDecision.dose_restriction.reason_code, 'TRAINING_GAP_REBUILD');
assert.ok(gapDecision.reason_codes.includes('TRAINING_GAP_REBUILD'));
console.log('ok - C3-SCOPE-05 planning decisions synthesize taper and training-gap receipts');

function healthyHyroxValidation(sessions, overrides = {}) {
  return validateGoalBackwardCandidate({ sessions }, {
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    event_kind: 'HYROX_DOUBLES',
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_action: 'NORMAL',
    available_days_count: 6,
    recent_normal_running: {
      status: 'ESTABLISHED', median_distance_m: 10 * METERS_PER_MILE,
      sync_state: 'COMPLETE', value_state: 'KNOWN',
    },
    median_ordinary_easy_duration_min: 30,
    ...overrides,
  });
}

const completeRoleSet = [
  {
    session_id: 'pure-quality', scheduled_local_date: '2026-08-18', workout_family: 'threshold_run',
    role: 'SUPPORTING', supports_requirement_id: 'hyrox-specific', duration_min: 45,
    quality_work_duration_min: 12, distance_miles: 4,
  },
  {
    session_id: 'hyrox-specific', scheduled_local_date: '2026-08-20', workout_family: 'hyrox_station_skill',
    role: 'SUPPORTING', supports_requirement_id: 'hyrox-specific', duration_min: 30,
  },
  {
    session_id: 'meaningful-long', scheduled_local_date: '2026-08-23', workout_family: 'long_aerobic',
    role: 'PRIMARY_KEY', duration_min: 70, distance_miles: 6,
  },
];
assert.equal(healthyHyroxValidation(completeRoleSet).valid, true);

const missingQuality = healthyHyroxValidation(completeRoleSet.filter((session) => session.session_id !== 'pure-quality'));
assert.equal(missingQuality.valid, false);
assert.ok(missingQuality.violations.some((violation) => violation.reason === 'PURE_RUNNING_QUALITY_ROLE_MISSING'));

const acuteMissingQuality = healthyHyroxValidation(
  completeRoleSet.filter((session) => session.session_id !== 'pure-quality'),
  { dose_restriction: scopedRestriction('RECOVERY_VOLUME_REDUCTION', { scope: 'ACUTE_24_48H' }) },
);
assert.equal(acuteMissingQuality.valid, false);
assert.ok(acuteMissingQuality.violations.some((violation) => violation.reason === 'PURE_RUNNING_QUALITY_ROLE_MISSING'));

const mislabeledTinyLong = healthyHyroxValidation(completeRoleSet.map((session) => (
  session.session_id === 'meaningful-long'
    ? { ...session, title: 'Long Run', duration_min: 30, distance_miles: 0.9 }
    : session
)));
assert.equal(mislabeledTinyLong.valid, false);
assert.ok(mislabeledTinyLong.violations.some((violation) => violation.reason === 'LONG_AEROBIC_ROLE_BELOW_FLOOR'));

const unknownLongDose = healthyHyroxValidation(completeRoleSet.map((session) => (
  session.session_id === 'meaningful-long'
    ? { ...session, distance_miles: null }
    : session
)));
assert.equal(unknownLongDose.valid, false);
assert.ok(unknownLongDose.violations.some((violation) => violation.reason === 'LONG_AEROBIC_ROLE_BELOW_FLOOR'));
console.log('ok - C3-ROLE-01 healthy event-specific weeks require meaningful pure-run, HYROX, and long roles');

const explicitConflict = healthyHyroxValidation(completeRoleSet.filter((session) => session.session_id !== 'meaningful-long'), {
  unplaceable_requirement_ids: ['long_aerobic'],
});
assert.equal(explicitConflict.valid, false);
assert.ok(explicitConflict.reason_codes.includes('REQUIRED_EXPOSURE_UNPLACEABLE'));

const returningRoleSet = healthyHyroxValidation([
  runSession('returning-easy', 'easy_run', 2, '2026-08-17'),
], {
  training_age_class: 'RETURNING',
  consistency_state: 'RETURNING',
  recovery_state: 'CAUTION',
  safety_action: 'MONITOR',
});
assert.equal(
  returningRoleSet.validator_results.find((entry) => entry.validator === 'event_role_coverage').valid,
  true,
);
console.log('ok - C3-ROLE-02 explicit unplaceable conflicts reject while returning protocols preserve reduced coverage');
