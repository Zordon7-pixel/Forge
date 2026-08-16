const assert = require('node:assert/strict');

const {
  buildCrossModalDoseLedger,
  deriveScopedRecoveryState,
  evaluateMaterialDose,
} = require('../src/lib/goalBackwardRecoveryMaterial');
const { buildGoalBackwardPlanningDecision } = require('../src/lib/goalBackwardDecisionEngine');
const { validateGoalBackwardCandidate } = require('../src/lib/goalBackwardValidators');
const { enumerateGoalBackwardCandidates } = require('../src/lib/racePlanCandidateEngine');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const plansRouter = require('../src/routes/plans');

const results = [];

function test(id, description, assertion) {
  assertion();
  results.push(id);
  console.log(`ok - ${id} - ${description}`);
}

const MI_TO_M = 1609.344;
const milesToMeters = (miles) => Math.round(miles * MI_TO_M * 1000) / 1000;

function runSession(id, miles, family = 'easy_run', role = 'SUPPORTING', date = '2026-08-17') {
  return {
    session_id: id,
    scheduled_local_date: date,
    workout_family: family,
    role,
    distance_m: milesToMeters(miles),
    duration_min: family === 'long_aerobic' ? 60 : family === 'threshold_run' ? 45 : 30,
    quality_work_duration_min: family === 'threshold_run' ? 12 : null,
  };
}

function materialInput({
  candidateMiles = 6.94,
  recentNormalMiles = 12.5,
  activePlanMiles = null,
  phase = 'EVENT_SPECIFIC_DEVELOPMENT',
  trainingAge = 'ESTABLISHED',
  consistency = 'CONSISTENT',
  reductionScope = null,
  crossModalLedger = null,
} = {}) {
  return {
    candidate: {
      sessions: [runSession('candidate-easy', candidateMiles)],
    },
    recent_normal_running: recentNormalMiles === null ? {
      status: 'INSUFFICIENT', median_distance_m: null, confidence: 'INSUFFICIENT',
    } : {
      status: 'ESTABLISHED',
      median_distance_m: milesToMeters(recentNormalMiles),
      confidence: 'HIGH',
      evidence_ids: ['sha256:recent-normal-evidence'],
    },
    active_applied_plan: activePlanMiles === null ? null : {
      plan_revision: 7,
      sessions: [runSession('active-easy', activePlanMiles)],
    },
    phase,
    training_age_class: trainingAge,
    consistency_state: consistency,
    planning_date_local: '2026-08-17',
    candidate_window_end_local: '2026-08-23',
    decisive_evidence_ids: ['sha256:planning-snapshot'],
    reduction_scope: reductionScope,
    cross_modal_ledger: crossModalLedger,
  };
}

function restrictionScope(overrides = {}) {
  return {
    scope_kind: 'BLOCK',
    reason_code: 'INJURY_SCOPE',
    effective_from_local: '2026-08-17',
    expires_at: '2026-08-24T04:00:00.000Z',
    reevaluate_at: '2026-08-23T12:00:00.000Z',
    affected_modalities: ['running_impact'],
    decisive_evidence_ids: ['sha256:injury-evidence'],
    authorizes_material_reduction: true,
    ...overrides,
  };
}

test('C3-REC-01', 'one low-sleep readiness state is acute and cannot authorize a future-week collapse', () => {
  const first = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: 'sha256:recovery-snapshot',
    context: {
      safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
      recovery: {
        state: 'recovery',
        readinessScore: 43,
        syncedAt: '2026-08-17T10:00:00.000Z',
        metrics: {
          sleepHoursLastNight: 4.8,
          sleepHours7dBaseline: 6.2,
          restingHeartRate: 58,
          restingHeartRateBaseline: 56,
          freshness: { sleep: true, restingHeartRate: true },
        },
      },
      checkin: null,
    },
  });
  const second = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: 'sha256:recovery-snapshot',
    context: {
      safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
      recovery: {
        state: 'recovery', readinessScore: 43, syncedAt: '2026-08-17T10:00:00.000Z',
        metrics: {
          sleepHoursLastNight: 4.8, sleepHours7dBaseline: 6.2,
          restingHeartRate: 58, restingHeartRateBaseline: 56,
          freshness: { sleep: true, restingHeartRate: true },
        },
      },
      checkin: null,
    },
  });
  assert.deepEqual(second, first, 'recovery receipt is deterministic');
  assert.equal(first.recovery_state, 'CAUTION');
  assert.equal(first.safety_action, 'MONITOR');
  assert.equal(first.scopes.length, 1);
  assert.equal(first.scopes[0].scope_kind, 'ACUTE');
  assert.equal(first.scopes[0].reason_code, 'RECOVERY_VOLUME_REDUCTION');
  assert.equal(first.scopes[0].authorizes_material_reduction, false);
  assert.equal(first.scopes[0].affected_modalities.includes('running_quality'), true);
  assert.match(first.receipt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(first.scopes[0], 'rest_days'), false, 'recovery evidence does not invent a rest-day count');

  const unknown = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: 'synthetic-missing-recovery-evidence',
    context: {},
  });
  assert.equal(unknown.recovery_state, 'UNKNOWN');
  assert.equal(unknown.safety_action, 'NORMAL');
  assert.deepEqual(unknown.scopes, [], 'missing evidence does not fabricate a restriction');

  const returning = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: 'synthetic-returning-evidence',
    context: {
      safety: { activeInjury: false, comebackMode: true, injuryNotesPresent: false },
      recovery: { state: 'LOW', readinessScore: null },
    },
  });
  assert.equal(returning.scopes[0].reason_code, 'RECOVERY_VOLUME_REDUCTION',
    'comeback mode alone is not diagnosed as an injury');
});

test('C3-SAFETY-01', 'acute sleep, injury, and illness actions are enforced only inside their bounded scope', () => {
  const baseContext = {
    safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
    recovery: { state: 'NORMAL', readinessScore: 80, syncedAt: '2026-08-17T10:00:00.000Z' },
    checkin: null,
  };
  const states = [
    {
      expectedAction: 'NO_HIGH_INTENSITY',
      context: { ...baseContext, recovery: { ...baseContext.recovery, state: 'RECOVERY', readinessScore: 43 } },
      affected: runSession('sleep-quality-today', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-17'),
      later: runSession('sleep-quality-later', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-20'),
    },
    {
      expectedAction: 'MODIFY_IMPACT',
      context: { ...baseContext, safety: { ...baseContext.safety, activeInjury: true } },
      affected: runSession('injury-run-today', 3, 'easy_run', 'SUPPORTING', '2026-08-17'),
      later: runSession('injury-run-later', 3, 'easy_run', 'SUPPORTING', '2026-08-20'),
    },
    {
      expectedAction: 'NO_HIGH_INTENSITY',
      context: { ...baseContext, checkin: { lifeFlags: ['sick'] } },
      affected: runSession('illness-quality-today', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-17'),
      later: runSession('illness-quality-later', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-20'),
    },
  ];
  for (const fixture of states) {
    const state = deriveScopedRecoveryState({
      planning_date_local: '2026-08-17',
      evidence_snapshot_id: 'synthetic-scoped-safety-evidence',
      context: fixture.context,
    });
    assert.equal(state.safety_action, 'MONITOR');
    assert.equal(state.scopes[0].action, fixture.expectedAction);
    const validation = validateGoalBackwardCandidate({ sessions: [fixture.affected, fixture.later] }, {
      safety_action: state.safety_action,
      safety_scope: state.scopes,
    });
    const safety = validation.validator_results.find((entry) => entry.validator === 'safety');
    assert.equal(safety.valid, false);
    assert.deepEqual(safety.violations.map((entry) => entry.session_id), [fixture.affected.session_id]);
    assert.equal(safety.violations[0].code, fixture.expectedAction);
    assert.equal(safety.executability.sessions.find((entry) => entry.session_id === fixture.later.session_id).executable, true);
  }

  const injury = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: 'synthetic-injury-evidence',
    context: { ...baseContext, safety: { ...baseContext.safety, activeInjury: true } },
  });
  const modified = runSession('modified-impact-today', 2, 'easy_run', 'SUPPORTING', '2026-08-17');
  modified.impact_modified = true;
  const allowed = validateGoalBackwardCandidate({ sessions: [modified] }, {
    safety_action: injury.safety_action,
    safety_scope: injury.scopes,
  });
  assert.equal(allowed.validator_results.find((entry) => entry.validator === 'safety').valid, true);
});

test('C3-SAFETY-02', 'a malformed requested restriction fails closed instead of disappearing', () => {
  const validation = validateGoalBackwardCandidate({
    sessions: [runSession('malformed-scope-run', 3)],
  }, {
    safety_action: 'MONITOR',
    safety_scope: [{
      scope_kind: 'BLOCK',
      reason_code: 'INJURY_SCOPE',
      action: 'NO_RUNNING',
      effective_from_local: '2026-08-17',
      expires_at: null,
      reevaluate_at: '2026-08-18T12:00:00.000Z',
      affected_modalities: ['running'],
      decisive_evidence_ids: ['synthetic-injury-evidence'],
    }],
  });
  const safety = validation.validator_results.find((entry) => entry.validator === 'safety');
  assert.equal(safety.valid, false);
  assert.equal(safety.violations[0].code, 'SAFETY_SCOPE_INVALID');
});

test('C3-SAFETY-03', 'unchanged scoped recovery evidence has the same preview and apply safety identity', () => {
  const context = {
    profile: { timezone: 'UTC' },
    safety: { activeInjury: true, comebackMode: false, injuryNotesPresent: false },
    recovery: { state: 'NORMAL', readinessScore: 80, syncedAt: '2026-08-17T10:00:00.000Z' },
  };
  const inputHash = canonicalHash({ fixture: 'c3-apply-safety' });
  const derived = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    evidence_snapshot_id: `snapshot-${inputHash.slice(-24)}`,
    context,
  });
  const expectedSafetyState = {
    action: derived.safety_action,
    scope: derived.scopes,
    reason_codes: derived.reason_codes,
    receipt_hash: derived.receipt_hash,
  };
  const envelope = plansRouter._test.currentGoalBackwardApplyEnvelope({
    planning_date_local: '2026-08-17',
    candidate_id: 'synthetic-c3-candidate',
  }, 'synthetic-c3-owner', {
    races: [],
    context,
    planningInputRevision: 4,
    inputHash,
    activePlan: null,
    planningConstraints: { locks: [], manual_edits: [], lock_revision: 0, edit_revision: 0 },
  });
  assert.equal(envelope.safety_state_hash, `sha256:${canonicalHash(expectedSafetyState)}`);
});

test('C3-MAT-01', 'the unsupported 6.94-versus-12.5 reduction rejects at exactly -44.48 percent', () => {
  const receipt = evaluateMaterialDose(materialInput());
  assert.equal(receipt.valid, false);
  assert.equal(receipt.candidate_running_m, milesToMeters(6.94));
  const recent = receipt.comparators.find((entry) => entry.source === 'CANONICAL_RECENT_NORMAL');
  assert.equal(recent.baseline_running_m, milesToMeters(12.5));
  assert.equal(recent.delta_percentage, -44.48);
  assert.equal(recent.material_reduction, true);
  assert.deepEqual(receipt.reason_codes, ['RECENT_LOAD_MAINTAIN']);
  assert.equal(receipt.violations[0].reason, 'UNSUPPORTED_MATERIAL_RUNNING_REDUCTION');
});

test('C3-MAT-02', 'deduped 10.2 and 10.3 recent-normal anchors still reject the same 6.94 week', () => {
  for (const baseline of [10.2, 10.3]) {
    const receipt = evaluateMaterialDose(materialInput({ recentNormalMiles: baseline }));
    assert.equal(receipt.valid, false, `${baseline} mi/week must reject`);
    assert.equal(receipt.comparators[0].material_reduction, true);
    assert.ok(receipt.comparators[0].delta_percentage < -30);
  }
});

test('C3-MAT-03', 'active applied plan remains an independent material-dose comparator', () => {
  const receipt = evaluateMaterialDose(materialInput({ recentNormalMiles: null, activePlanMiles: 12.2 }));
  assert.equal(receipt.valid, false);
  assert.deepEqual(receipt.comparators.map((entry) => entry.source), ['ACTIVE_APPLIED_PLAN']);
  assert.equal(receipt.comparators[0].baseline_plan_revision, 7);
});

test('C3-MAT-04', 'taper and returning rebuilds qualify only with bounded deterministic receipts', () => {
  const taper = evaluateMaterialDose(materialInput({
    phase: 'TAPER_RACE_WEEK',
    reductionScope: restrictionScope({
      reason_code: 'TAPER_VOLUME_REDUCTION',
      affected_modalities: ['running'],
      decisive_evidence_ids: ['sha256:goal-and-event-revision'],
    }),
  }));
  assert.equal(taper.valid, true);
  assert.equal(taper.reduction_authorization.reason_code, 'TAPER_VOLUME_REDUCTION');

  const returning = evaluateMaterialDose(materialInput({
    trainingAge: 'RETURNING',
    consistency: 'RETURNING',
    reductionScope: restrictionScope({
      reason_code: 'TRAINING_GAP_REBUILD',
      affected_modalities: ['running'],
      decisive_evidence_ids: ['sha256:training-gap-evidence'],
    }),
  }));
  assert.equal(returning.valid, true);
  assert.equal(returning.reduction_authorization.reason_code, 'TRAINING_GAP_REBUILD');
});

test('C3-MAT-05', 'corroborated injury or illness may authorize a scoped reduction but missing bindings fail closed', () => {
  for (const reason of ['INJURY_SCOPE', 'ILLNESS_RECOVERY']) {
    const valid = evaluateMaterialDose(materialInput({
      reductionScope: restrictionScope({
        reason_code: reason,
        decisive_evidence_ids: [`sha256:${reason.toLowerCase()}-evidence-1`, `sha256:${reason.toLowerCase()}-evidence-2`],
      }),
    }));
    assert.equal(valid.valid, true, `${reason} is a qualifying closed reason`);
  }
  for (const invalidScope of [
    restrictionScope({ expires_at: null }),
    restrictionScope({ decisive_evidence_ids: [] }),
    restrictionScope({ affected_modalities: [] }),
    restrictionScope({ scope_kind: 'ACUTE' }),
    restrictionScope({
      reevaluate_at: '2026-08-16T12:00:00.000Z',
      decisive_evidence_ids: ['synthetic-scope-evidence-1', 'synthetic-scope-evidence-2'],
    }),
  ]) {
    const rejected = evaluateMaterialDose(materialInput({ reductionScope: invalidScope }));
    assert.equal(rejected.valid, false);
    assert.equal(rejected.reduction_authorization, null);
  }
});

test('C3-XMOD-01', 'cross-modal relief requires a complete dimension-specific ledger and never follows from a generic ceiling', () => {
  const ledger = buildCrossModalDoseLedger({
    weekly_dimension_sum: [9, 7, 12, 5, 6, 8, 10, 8],
    dimensions: {
      aerobic: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 10, authorized_ceiling: 10 },
      running_impact: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 8, authorized_ceiling: 8 },
      lower_body_muscular: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 12, authorized_ceiling: 12 },
      upper_body_muscular: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 6, authorized_ceiling: 6 },
      grip: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 7, authorized_ceiling: 7 },
      neuromuscular: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 9, authorized_ceiling: 9 },
      metabolic: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 10, authorized_ceiling: 10 },
      event_specific_fatigue: { status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 8, authorized_ceiling: 8 },
    },
    decisive_evidence_ids: ['sha256:cross-modal-week-a', 'sha256:cross-modal-week-b'],
  });
  assert.equal(ledger.valid, true);
  assert.equal(ledger.dimensions.length, 8);
  assert.match(ledger.receipt_hash, /^sha256:[a-f0-9]{64}$/);

  const noScope = evaluateMaterialDose(materialInput({ crossModalLedger: ledger }));
  assert.equal(noScope.valid, false, 'a ledger alone cannot silently delete running volume');

  const scoped = evaluateMaterialDose(materialInput({
    crossModalLedger: ledger,
    reductionScope: restrictionScope({
      reason_code: 'CROSS_MODAL_FATIGUE_LIMIT',
      affected_modalities: ['running_impact', 'lower_body_muscular'],
      decisive_evidence_ids: ['sha256:cross-modal-week-a', 'sha256:cross-modal-week-b'],
      cross_modal_ledger_hash: ledger.receipt_hash,
      measured_running_ceiling_m: milesToMeters(7.2),
    }),
  }));
  assert.equal(scoped.valid, true);
  assert.equal(scoped.reduction_authorization.cross_modal_ledger_hash, ledger.receipt_hash);
});

test('C3-ROLE-01', 'healthy HYROX plus road development requires pure-running quality, HYROX-specific work, and long aerobic work', () => {
  const athleteId = 'synthetic-c3-multigoal';
  const decision = buildGoalBackwardPlanningDecision({
    athlete_id: athleteId,
    planning_date_local: '2026-08-17',
    created_at: '2026-08-17T00:00:00.000Z',
    timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 4,
      evidence_snapshot_id: 'sha256:c3-athlete-state',
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      consistent_weeks: 8,
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
      safety_scope: [],
      recent_normal_running: { status: 'ESTABLISHED', median_distance_m: milesToMeters(20), confidence: 'HIGH' },
      available_days: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
    },
    goals: [
      {
        goal_id: 'goal-hyrox', race_id: 'race-hyrox', athlete_id: athleteId, priority: 'A',
        goal_type: 'performance', event_kind: 'HYROX_DOUBLES', event_local_date: '2026-09-20',
        event_state: 'SCHEDULED', source_revision: 2, planning_eligible: true,
      },
      {
        goal_id: 'goal-road', race_id: 'race-road', athlete_id: athleteId, priority: 'B',
        goal_type: 'performance', event_kind: 'ROAD_ENDURANCE', distance_miles: 10,
        event_local_date: '2026-10-11', event_state: 'SCHEDULED', source_revision: 2, planning_eligible: true,
      },
    ],
    races: [
      { race_id: 'race-hyrox', athlete_id: athleteId },
      { race_id: 'race-road', athlete_id: athleteId },
    ],
    development_gate_complete: true,
    previous_two_weeks_passed: true,
  });
  const families = decision.role_multiset.flatMap((role) => role.any_of);
  assert.ok(families.includes('hyrox_partial_simulation'));
  assert.ok(families.includes('long_aerobic'));
  assert.ok(families.some((family) => ['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family)));
  assert.ok(decision.role_multiset.some((role) => role.requirement_id === 'secondary_road_quality'));
  assert.equal(decision.due_exposure_ledger.required_primary_count,
    decision.due_exposure_ledger.due_roles.filter((role) => role.role === 'PRIMARY_KEY').length);
  assert.equal(decision.due_exposure_ledger.complete, false);
});

test('C3-VALIDATOR-01', 'material dose and meaningful role validation are hard gates with bounded receipts', () => {
  const sessions = [
    runSession('hyrox-key', 2, 'hyrox_partial_simulation', 'PRIMARY_KEY', '2026-08-18'),
    runSession('road-quality', 2, 'threshold_run', 'PRIMARY_KEY', '2026-08-20'),
    runSession('token-long', 2.94, 'long_aerobic', 'PRIMARY_KEY', '2026-08-23'),
  ];
  sessions[0].run_station_pair_count = 3;
  sessions[0].main_work_duration_min = 35;
  sessions[2].duration_min = 20;
  const validation = validateGoalBackwardCandidate({ sessions }, {
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_action: 'NORMAL',
    available_local_dates: sessions.map((session) => session.scheduled_local_date),
    available_days_count: 5,
    recent_normal_running_minutes_per_week: 150,
    median_ordinary_easy_duration_min: 30,
    material_dose: materialInput({ candidateMiles: 6.94 }),
    development_role_requirements: [
      { requirement_id: 'hyrox_specific', any_of: ['hyrox_partial_simulation'], minimum_role: 'PRIMARY_KEY' },
      { requirement_id: 'pure_running_quality', any_of: ['threshold_run', 'interval_run', 'race_rhythm_run'], minimum_role: 'PRIMARY_KEY' },
      { requirement_id: 'long_aerobic', any_of: ['long_aerobic'], minimum_role: 'PRIMARY_KEY', presentation_floor_required: true },
    ],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.reason_codes.includes('RECENT_LOAD_MAINTAIN'));
  assert.ok(validation.reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION'));
  assert.ok(validation.validator_results.some((entry) => entry.validator === 'material_dose'));
  assert.ok(validation.validator_results.some((entry) => entry.validator === 'development_roles'));
  assert.ok(Buffer.byteLength(JSON.stringify(validation), 'utf8') < 16 * 1024);
  assert.equal(canonicalHash(validation).length, 64);
});

test('C3-ROLE-02', 'an explicit bounded availability conflict may mark a role unplaceable without inventing a token session', () => {
  const result = validateGoalBackwardCandidate({
    sessions: [runSession('quality-only', 4, 'threshold_run', 'PRIMARY_KEY')],
  }, {
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_action: 'NORMAL',
    available_local_dates: ['2026-08-17'],
    planning_date_local: '2026-08-17',
    candidate_window_end_local: '2026-08-23',
    development_role_requirements: [{
      requirement_id: 'long_aerobic', any_of: ['long_aerobic'], minimum_role: 'PRIMARY_KEY',
      presentation_floor_required: true,
    }],
    development_role_conflicts: [{
      requirement_id: 'long_aerobic',
      scope_kind: 'BLOCK',
      reason_code: 'SCHEDULE_CONSTRAINT',
      effective_from_local: '2026-08-17',
      expires_at: '2026-08-24T04:00:00.000Z',
      reevaluate_at: '2026-08-23T12:00:00.000Z',
      affected_modalities: ['running'],
      decisive_evidence_ids: ['synthetic-availability-revision'],
      authorizes_material_reduction: false,
    }],
  });
  assert.equal(result.validator_results.find((entry) => entry.validator === 'development_roles').valid, true);
  assert.equal(result.valid, true);
});

test('C3-ENGINE-01', 'enumeration rejects unsupported under-dose deterministically and retains no persistable least-bad selection', () => {
  const decision = {
    decision_id: 'decision-c3-underdose',
    decision_hash: canonicalHash({ fixture: 'c3-underdose' }),
    planning_date_local: '2026-08-17',
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    primary_goal_id: 'goal-c3-underdose',
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_state: { action: 'NORMAL', scope: [] },
    evidence_used: [{ evidence_id: 'synthetic-c3-load-evidence' }],
    athlete_locks: [],
    manual_edits: [],
    role_multiset: [{
      requirement_id: 'easy-volume', any_of: ['easy_run'], role: 'SUPPORTING', scheduled_local_date: null,
    }],
    due_exposure_ledger: {
      due_roles: [{ requirement_id: 'easy-volume', any_of: ['easy_run'], role: 'SUPPORTING' }],
      unplaceable_requirement_ids: [],
    },
    development_role_requirements: [],
  };
  const input = {
    decision,
    available_local_dates: ['2026-08-17'],
    maximum_session_count: 1,
    materialize_canonical: false,
    material_dose_enforced: true,
    legacy_road_candidate_material: [{
      id: 'synthetic-c3-easy', workout_id: 'easy_aerobic', workout_family: 'easy_run',
      kind: 'run', title: 'Easy run', distance_miles: 6.94, duration_min: 70,
    }],
    validation_options: {
      available_local_dates: ['2026-08-17'],
      available_days_count: 1,
      training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL',
      safety_action: 'NORMAL',
      recent_normal_running: {
        status: 'ESTABLISHED', median_distance_m: milesToMeters(12.5), confidence: 'HIGH',
        evidence_ids: ['synthetic-c3-load-evidence'],
      },
    },
  };
  const first = enumerateGoalBackwardCandidates(input);
  const second = enumerateGoalBackwardCandidates(input);
  assert.equal(first.selected_candidate, null);
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].persisted, false);
  assert.equal(first.candidates[0].validation.reason_codes.includes('RECENT_LOAD_MAINTAIN'), true);
  assert.equal(first.decision.selected_candidate_id, null);
  assert.deepEqual(second, first, 'retry/replay is byte-equivalent and non-mutating');
});

test('C3-PRIVACY-01', 'receipt ordering is stable and raw evidence identities never escape diagnostics', () => {
  const left = buildCrossModalDoseLedger({
    weekly_dimension_sum: [1, 1, 1, 1, 1, 1, 1, 1],
    dimensions: Object.fromEntries([
      'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
      'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
    ].map((dimension) => [dimension, {
      status: 'ESTABLISHED', confidence: 'HIGH', normal_ceiling: 2, authorized_ceiling: 2,
    }])),
    decisive_evidence_ids: ['person@example.com', 'raw-provider-workout-id'],
  });
  const right = buildCrossModalDoseLedger({
    weekly_dimension_sum: [1, 1, 1, 1, 1, 1, 1, 1],
    dimensions: Object.fromEntries([
      'event_specific_fatigue', 'metabolic', 'neuromuscular', 'grip',
      'upper_body_muscular', 'lower_body_muscular', 'running_impact', 'aerobic',
    ].map((dimension) => [dimension, {
      authorized_ceiling: 2, normal_ceiling: 2, confidence: 'HIGH', status: 'ESTABLISHED',
    }])),
    decisive_evidence_ids: ['raw-provider-workout-id', 'person@example.com'],
  });
  assert.deepEqual(right, left);
  assert.doesNotMatch(JSON.stringify(left), /person@example\.com|raw-provider-workout-id/);
  assert.ok(Buffer.byteLength(JSON.stringify(left), 'utf8') < 16 * 1024);
});

test('C3-UNKNOWN-01', 'unknown load cannot become zero or authorize either increase or reduction', () => {
  const receipt = evaluateMaterialDose(materialInput({ recentNormalMiles: null, activePlanMiles: null }));
  assert.equal(receipt.valid, false);
  assert.equal(receipt.candidate_running_m, milesToMeters(6.94));
  assert.deepEqual(receipt.comparators, []);
  assert.deepEqual(receipt.reason_codes, ['RECENT_NORMAL_INSUFFICIENT']);
  assert.equal(receipt.violations[0].reason, 'MATERIAL_DOSE_COMPARATOR_UNKNOWN');
});

assert.equal(new Set(results).size, results.length);
console.log(`goalBackwardRecoveryMaterial smoke: ${results.length}/${results.length} passed`);
