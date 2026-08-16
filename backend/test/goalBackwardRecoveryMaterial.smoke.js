const assert = require('node:assert/strict');

const {
  buildDevelopmentRoleBinding,
  buildCrossModalDoseLedger,
  deriveMaterialReductionScope,
  deriveScopedRecoveryState,
  evaluateMaterialDose,
  normalizeCrossModalReductionEvidence,
  normalizeScope,
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
  crossModalReductionEvidence = null,
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
    cross_modal_reduction_evidence: crossModalReductionEvidence,
  };
}

const CROSS_MODAL_DIMENSIONS = [
  'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
  'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
];

function crossModalEvidenceEnvelope(overrides = {}) {
  const content = {
    schema_version: 1,
    athlete_id: 'synthetic-cross-modal-owner',
    athlete_state_revision: 4,
    evidence_snapshot_id: `sha256:${'2'.repeat(64)}`,
    evidence_revision: 3,
    weekly_dimension_sum: [9, 7, 12, 5, 6, 8, 10, 8],
    dimensions: Object.fromEntries(CROSS_MODAL_DIMENSIONS.map((dimension, index) => [dimension, {
      status: 'ESTABLISHED', confidence: 'HIGH',
      normal_ceiling: [10, 8, 12, 6, 7, 9, 10, 8][index],
      authorized_ceiling: [10, 8, 12, 6, 7, 9, 10, 8][index],
    }])),
    measured_running_ceiling_m: milesToMeters(7.2),
    decisive_evidence_ids: [`sha256:${'3'.repeat(64)}`, `sha256:${'4'.repeat(64)}`],
    ...overrides,
  };
  return { ...content, content_hash: `sha256:${canonicalHash(content)}` };
}

function restrictionScope(overrides = {}) {
  return {
    scope_kind: 'BLOCK',
    reason_code: 'INJURY_SCOPE',
    effective_from_local: '2026-08-17',
    expires_on_local: '2026-08-24',
    expires_at: '2026-08-24T04:00:00.000Z',
    reevaluate_at: '2026-08-23T12:00:00.000Z',
    scope_timezone: 'UTC',
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

test('C3-SAFETY-01', 'acute sleep and illness stay bounded while active injury protects the full candidate window', () => {
  const baseContext = {
    safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
    recovery: { state: 'NORMAL', readinessScore: 80, syncedAt: '2026-08-17T10:00:00.000Z' },
    checkin: null,
  };
  const states = [
    {
      expectedAction: 'NO_HIGH_INTENSITY',
      laterBlocked: false,
      context: { ...baseContext, recovery: { ...baseContext.recovery, state: 'RECOVERY', readinessScore: 43 } },
      affected: runSession('sleep-quality-today', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-17'),
      later: runSession('sleep-quality-later', 3, 'threshold_run', 'PRIMARY_KEY', '2026-08-20'),
    },
    {
      expectedAction: 'MODIFY_IMPACT',
      laterBlocked: true,
      context: { ...baseContext, safety: { ...baseContext.safety, activeInjury: true } },
      affected: runSession('injury-run-today', 3, 'easy_run', 'SUPPORTING', '2026-08-17'),
      later: runSession('injury-run-later', 3, 'easy_run', 'SUPPORTING', '2026-08-20'),
    },
    {
      expectedAction: 'NO_HIGH_INTENSITY',
      laterBlocked: false,
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
    assert.deepEqual(safety.violations.map((entry) => entry.session_id), fixture.laterBlocked
      ? [fixture.affected.session_id, fixture.later.session_id]
      : [fixture.affected.session_id]);
    assert.equal(safety.violations[0].code, fixture.expectedAction);
    assert.equal(
      safety.executability.sessions.find((entry) => entry.session_id === fixture.later.session_id).executable,
      !fixture.laterBlocked,
    );
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
  assert.equal(injury.scopes[0].scope_kind, 'BLOCK');
  assert.equal(injury.scopes[0].authorizes_material_reduction, false,
    'one injury signal protects impact but cannot itself authorize a weekly volume reduction');
  assert.equal(injury.scopes[0].expires_on_local, '2026-08-24');

  const fullWeekSessions = Array.from({ length: 7 }, (_, index) => (
    runSession(`injury-week-${index + 1}`, 2, 'easy_run', 'SUPPORTING', `2026-08-${17 + index}`)
  ));
  const fullWeek = validateGoalBackwardCandidate({ sessions: fullWeekSessions }, {
    safety_action: injury.safety_action, safety_scope: injury.scopes,
  }).validator_results.find((entry) => entry.validator === 'safety');
  assert.equal(fullWeek.violations.length, 7, 'active injury protects every impact day in the candidate window');
  const nonImpact = validateGoalBackwardCandidate({ sessions: [{
    session_id: 'injury-upper-body', scheduled_local_date: '2026-08-22',
    workout_family: 'strength_upper', role: 'PRIMARY_KEY', duration_min: 35,
  }] }, { safety_action: injury.safety_action, safety_scope: injury.scopes });
  assert.equal(nonImpact.validator_results.find((entry) => entry.validator === 'safety').valid, true);
});

test('C3-SAFETY-04', 'injury notes and injured check-ins protect impact without fabricating injury from comeback', () => {
  for (const context of [
    { safety: { activeInjury: false, injuryNotesPresent: true }, recovery: { state: 'NORMAL' } },
    { safety: {}, recovery: { state: 'NORMAL' }, checkin: { lifeFlags: ['injured'] } },
  ]) {
    const state = deriveScopedRecoveryState({
      planning_date_local: '2026-08-17',
      candidate_window_end_local: '2026-08-23',
      evidence_snapshot_id: 'synthetic-injury-variant-snapshot',
      context,
    });
    assert.equal(state.scopes[0].scope_kind, 'BLOCK');
    assert.equal(state.scopes[0].action, 'MODIFY_IMPACT');
    assert.equal(state.scopes[0].expires_on_local, '2026-08-24');
    assert.ok(state.scopes[0].reevaluate_at <= state.scopes[0].expires_at);
  }
  const comeback = deriveScopedRecoveryState({
    planning_date_local: '2026-08-17',
    candidate_window_end_local: '2026-08-23',
    evidence_snapshot_id: 'synthetic-comeback-snapshot',
    context: { safety: { comebackMode: true }, recovery: { state: 'NORMAL' } },
  });
  assert.deepEqual(comeback.scopes, []);
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

test('C3-MAT-06', 'production-bound taper, training-gap, and corroborated safety evidence derive real BLOCK authorizations', () => {
  const common = {
    planning_date_local: '2026-08-17',
    candidate_window_end_local: '2026-08-23',
    evidence_snapshot_id: 'synthetic-revisioned-planning-snapshot',
    decision_evidence_ids: ['synthetic-goal-revision'],
    decision: {
      decision_id: 'synthetic-c3-scope-decision',
      decision_hash: canonicalHash({ fixture: 'synthetic-c3-scope-decision' }),
      phase: 'DEVELOPMENT',
      consistency_state: 'CONSISTENT',
      training_age_class: 'ESTABLISHED',
      evidence_used: [{ evidence_id: 'synthetic-goal-revision' }],
    },
    context: { safety: {}, recovery: { state: 'NORMAL' }, checkin: null },
  };
  const taper = deriveMaterialReductionScope({
    ...common,
    decision: { ...common.decision, phase: 'TAPER_RACE_WEEK' },
  });
  assert.equal(taper.reason_code, 'TAPER_VOLUME_REDUCTION');
  assert.equal(taper.scope_kind, 'BLOCK');
  assert.equal(taper.authorizes_material_reduction, true);
  assert.equal(evaluateMaterialDose(materialInput({
    candidateMiles: 12,
    recentNormalMiles: 30,
    phase: 'TAPER_RACE_WEEK',
    reductionScope: taper,
  })).valid, true);

  const returning = deriveMaterialReductionScope({
    ...common,
    decision: { ...common.decision, consistency_state: 'RETURNING' },
    recent_normal_running: {
      status: 'TRAINING_GAP',
      evidence_ids: ['synthetic-canonical-load-receipt'],
    },
  });
  assert.equal(returning.reason_code, 'TRAINING_GAP_REBUILD');
  assert.equal(evaluateMaterialDose(materialInput({
    consistency: 'RETURNING', reductionScope: returning,
  })).valid, true);

  const injuryState = deriveScopedRecoveryState({
    ...common,
    context: {
      safety: { activeInjury: true, injuryNotesPresent: true },
      recovery: { state: 'NORMAL' },
      checkin: null,
    },
  });
  const injury = deriveMaterialReductionScope({ ...common, scoped_recovery_state: injuryState });
  assert.equal(injury.reason_code, 'INJURY_SCOPE');
  assert.equal(injury.authorizes_material_reduction, true);

  const illnessState = deriveScopedRecoveryState({
    ...common,
    context: {
      safety: {},
      recovery: {
        state: 'RECOVERY', readinessScore: 35, available: true,
        syncedAt: '2026-08-17T10:00:00.000Z',
      },
      checkin: { lifeFlags: ['sick'] },
    },
  });
  const illness = deriveMaterialReductionScope({ ...common, scoped_recovery_state: illnessState });
  assert.equal(illness.reason_code, 'ILLNESS_RECOVERY');
  assert.equal(illness.scope_kind, 'BLOCK');
  assert.equal(illness.authorizes_material_reduction, true);

  const sleepOnly = deriveScopedRecoveryState({
    ...common,
    context: { safety: {}, recovery: { state: 'RECOVERY', readinessScore: 43 }, checkin: null },
  });
  assert.equal(deriveMaterialReductionScope({ ...common, scoped_recovery_state: sleepOnly }), null,
    'one low-readiness snapshot cannot synthesize a BLOCK authorization');
});

test('C3-MAT-07', 'missing or malformed scheduled dates make candidate and active-plan dose unknown', () => {
  for (const badDate of [
    null, '', 'not-a-date', '2026-02-30', '2026-08-17garbage', '2026-08-17 ',
    '2026-08-17\u0000', '2026-08-17T00:00:00Z', '2026-08-17T23:59:00-04:00',
    20260817, { date: '2026-08-17' },
  ]) {
    const candidate = materialInput();
    candidate.candidate.sessions.push(runSession('undated-padding', 8, 'easy_run', 'SUPPORTING', badDate));
    const receipt = evaluateMaterialDose(candidate);
    assert.equal(receipt.valid, false, `candidate date ${String(badDate)} must fail closed`);
    assert.equal(receipt.violations[0].reason, 'CANDIDATE_RUNNING_DATE_UNKNOWN');
    assert.equal(receipt.candidate_running_m, null);

    const active = materialInput({ activePlanMiles: 12.5 });
    active.active_applied_plan.sessions[0].scheduled_local_date = badDate;
    const activeReceipt = evaluateMaterialDose(active);
    assert.equal(activeReceipt.valid, false, `active comparator date ${String(badDate)} must fail closed`);
    assert.equal(activeReceipt.violations[0].reason, 'ACTIVE_PLAN_RUNNING_DATE_UNKNOWN');
  }

  const bounded = materialInput({ candidateMiles: 6.94, recentNormalMiles: 12.5 });
  bounded.candidate.sessions.push(runSession('before-window', 20, 'easy_run', 'SUPPORTING', '2026-08-16'));
  bounded.candidate.sessions.push(runSession('after-window', 20, 'easy_run', 'SUPPORTING', '2026-08-24'));
  assert.equal(evaluateMaterialDose(bounded).candidate_running_m, milesToMeters(6.94),
    'window boundaries exclude dated sessions outside the inclusive candidate week');

  for (const date of ['2026-08-17', '2026-08-23']) {
    const input = materialInput({ candidateMiles: 0 });
    input.candidate.sessions = [runSession('boundary', 6.94, 'easy_run', 'SUPPORTING', date)];
    assert.equal(evaluateMaterialDose(input).candidate_running_m, milesToMeters(6.94));
  }

  const padded = materialInput({ candidateMiles: 6.94, recentNormalMiles: 12.5 });
  padded.candidate.sessions.push(runSession(
    'prefix-garbage-padding', 8, 'easy_run', 'SUPPORTING', '2026-08-17garbage'
  ));
  const paddedReceipt = evaluateMaterialDose(padded);
  assert.equal(paddedReceipt.valid, false);
  assert.equal(paddedReceipt.violations[0].reason, 'CANDIDATE_RUNNING_DATE_UNKNOWN');

  const inflatedActive = materialInput({ recentNormalMiles: null, activePlanMiles: 12.5 });
  inflatedActive.active_applied_plan.sessions[0].scheduled_local_date = '2026-08-17garbage';
  const inflatedActiveReceipt = evaluateMaterialDose(inflatedActive);
  assert.equal(inflatedActiveReceipt.valid, false);
  assert.equal(inflatedActiveReceipt.violations[0].reason, 'ACTIVE_PLAN_RUNNING_DATE_UNKNOWN');
});

test('C3-SCOPE-01', 'expiry instant and local calendar identity must agree and cover the whole candidate window', () => {
  const contradictory = restrictionScope({
    expires_on_local: '2026-08-30',
    expires_at: '2026-08-17T12:00:00.000Z',
    reevaluate_at: '2026-08-17T10:00:00.000Z',
  });
  assert.equal(normalizeScope(contradictory), null);
  assert.equal(evaluateMaterialDose(materialInput({ reductionScope: contradictory })).valid, false);

  for (const invalid of [
    restrictionScope({ expires_on_local: '2026-08-23', expires_at: '2026-08-23T23:59:00.000Z' }),
    restrictionScope({ expires_on_local: '2026-08-18', expires_at: '2026-08-18T12:00:00.000Z' }),
  ]) {
    assert.equal(evaluateMaterialDose(materialInput({ reductionScope: invalid })).valid, false);
  }

  const legitimateOffsetCrossing = restrictionScope({
    scope_timezone: 'Pacific/Kiritimati',
    expires_on_local: '2026-08-24',
    expires_at: '2026-08-24T00:30:00+14:00',
    reevaluate_at: '2026-08-23T12:00:00+14:00',
    decisive_evidence_ids: ['offset-evidence-1', 'offset-evidence-2'],
  });
  assert.equal(evaluateMaterialDose(materialInput({ reductionScope: legitimateOffsetCrossing })).valid, true);

  const dstBound = restrictionScope({
    effective_from_local: '2026-10-26',
    scope_timezone: 'America/New_York',
    expires_on_local: '2026-11-02',
    expires_at: '2026-11-02T00:00:00-05:00',
    reevaluate_at: '2026-10-27T12:00:00-04:00',
    decisive_evidence_ids: ['dst-evidence-1', 'dst-evidence-2'],
  });
  const dstInput = materialInput({ reductionScope: dstBound });
  dstInput.planning_date_local = '2026-10-26';
  dstInput.candidate_window_end_local = '2026-11-01';
  dstInput.candidate.sessions[0].scheduled_local_date = '2026-10-26';
  assert.equal(evaluateMaterialDose(dstInput).valid, true);
});

test('C3-DATE-01', 'decision and validator calendar fields reject timestamps instead of truncating them', () => {
  assert.throws(() => buildGoalBackwardPlanningDecision({
    athlete_id: 'synthetic-date-owner',
    planning_date_local: '2026-08-17T00:00:00Z',
  }), /valid planning_date_local/);

  const validation = validateGoalBackwardCandidate({
    sessions: [runSession(
      'timestamp-calendar-field', 3, 'easy_run', 'SUPPORTING', '2026-08-17T00:00:00Z'
    )],
  }, {
    available_local_dates: ['2026-08-17'],
    safety_action: 'NORMAL',
  });
  const availability = validation.validator_results.find((entry) => entry.validator === 'availability');
  assert.equal(availability.valid, false);
  assert.equal(availability.violations[0].code, 'SESSION_DATE_INVALID');

  const invalidOffsetSession = runSession(
    'invalid-offset-instant', 3, 'easy_run', 'SUPPORTING', '2026-08-17'
  );
  delete invalidOffsetSession.scheduled_local_date;
  invalidOffsetSession.scheduled_start_at = '2026-08-17T00:00:00+14:30';
  const invalidOffsetValidation = validateGoalBackwardCandidate({
    sessions: [invalidOffsetSession],
  }, {
    available_local_dates: ['2026-08-17'],
    safety_action: 'NORMAL',
  });
  const invalidOffsetAvailability = invalidOffsetValidation.validator_results
    .find((entry) => entry.validator === 'availability');
  assert.equal(invalidOffsetAvailability.valid, false);
  assert.equal(invalidOffsetAvailability.violations[0].code, 'SESSION_DATE_INVALID');
});

test('C3-ROUTE-01', 'the route binds taper and training-gap BLOCK scopes into candidate validation', () => {
  function captureFor({ eventDate, recentNormal }) {
    let captured = null;
    const planningDateLocal = '2026-08-17';
    const state = {
      inputHash: `sha256:${'7'.repeat(64)}`,
      planningInputRevision: 3,
      active: null,
      activePlan: null,
      races: [{
        id: 'synthetic-route-race', user_id: 'synthetic-route-athlete', race_date: eventDate,
        event_local_date: eventDate, event_kind: 'road', distance_miles: 10, goal_revision: 4,
      }],
      target: { trainingDays: ['Mon', 'Wed', 'Sun'] },
      context: {
        profile: { training_age_class: 'ESTABLISHED', timezone: 'America/New_York' },
        history: {
          recentRunCount: 8,
          weeklyMileageBaseline: 20,
          runLoadInput: {
            load_input_state: 'COMPLETE', load_input_confidence: 'HIGH',
            recent_normal_confidence: 'HIGH', recent_normal: recentNormal,
            load_input_hash: `sha256:${'8'.repeat(64)}`,
            windows: [], reason_codes: [],
          },
        },
        recovery: { state: 'NORMAL' }, safety: {}, checkin: null,
      },
    };
    plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: 'synthetic-route-athlete', planningDateLocal, state,
      built: { plan: { weeks: [{ days: [{
        date: planningDateLocal,
        sessions: [{ id: 'route-easy', workout_id: 'easy_aerobic', kind: 'run', distance_miles: 6.94, duration_min: 70 }],
      }] }] } },
    }, {
      enumerateCandidates(input) {
        captured = input;
        return { decision: input.decision, candidates: [], selected_candidate: null };
      },
    });
    return captured;
  }

  const taper = captureFor({
    eventDate: '2026-08-20',
    recentNormal: { status: 'ESTABLISHED', median_distance_m: milesToMeters(30), confidence: 'HIGH' },
  });
  assert.equal(taper.decision.phase, 'TAPER_RACE_WEEK');
  assert.equal(taper.validation_options.material_reduction_scope.reason_code, 'TAPER_VOLUME_REDUCTION');

  const returning = captureFor({
    eventDate: '2026-10-18',
    recentNormal: {
      status: 'TRAINING_GAP', median_distance_m: milesToMeters(12.5), confidence: 'HIGH',
      evidence_ids: ['synthetic-training-gap-evidence'],
    },
  });
  assert.equal(returning.decision.consistency_state, 'RETURNING');
  assert.equal(returning.validation_options.material_reduction_scope.reason_code, 'TRAINING_GAP_REBUILD');
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

  const decision = {
    decision_id: 'synthetic-cross-modal-decision',
    decision_hash: canonicalHash({ fixture: 'synthetic-cross-modal-decision' }),
    phase: 'DEVELOPMENT', consistency_state: 'CONSISTENT', training_age_class: 'ESTABLISHED',
    evidence_used: [{ evidence_id: 'sha256:cross-modal-week-a' }],
  };
  const measuredScope = deriveMaterialReductionScope({
    planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-23',
    evidence_snapshot_id: 'synthetic-cross-modal-snapshot', decision,
    cross_modal_ledger: ledger, measured_running_ceiling_m: milesToMeters(7.2),
  });
  assert.equal(measuredScope, null, 'a candidate ledger is not an authoritative measured reduction receipt');
  const scoped = evaluateMaterialDose(materialInput({
    crossModalLedger: ledger,
    reductionScope: measuredScope,
  }));
  assert.equal(scoped.valid, false);
});

test('C3-XMOD-02', 'cross-modal reduction evidence is owner/revision/hash bound and complete before route use', () => {
  const envelope = crossModalEvidenceEnvelope();
  const expected = {
    athlete_id: envelope.athlete_id,
    athlete_state_revision: envelope.athlete_state_revision,
    evidence_snapshot_id: envelope.evidence_snapshot_id,
  };
  const normalized = normalizeCrossModalReductionEvidence(envelope, expected);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.measured_running_ceiling_m, milesToMeters(7.2));
  assert.equal(normalized.dimension_ledger.dimensions.length, 8);
  assert.doesNotMatch(JSON.stringify(normalized), /synthetic-cross-modal-owner/);

  const invalidFixtures = [
    { name: 'owner', value: { ...envelope, athlete_id: 'different-owner' }, reason: 'CROSS_MODAL_OWNER_MISMATCH' },
    { name: 'revision', value: { ...envelope, athlete_state_revision: 5 }, reason: 'CROSS_MODAL_REVISION_MISMATCH' },
    { name: 'snapshot', value: { ...envelope, evidence_snapshot_id: `sha256:${'5'.repeat(64)}` }, reason: 'CROSS_MODAL_SNAPSHOT_MISMATCH' },
    { name: 'hash', value: { ...envelope, content_hash: `sha256:${'6'.repeat(64)}` }, reason: 'CROSS_MODAL_EVIDENCE_HASH_MISMATCH' },
    {
      name: 'dimension',
      value: { ...envelope, dimensions: Object.fromEntries(Object.entries(envelope.dimensions).slice(0, 7)) },
      reason: 'CROSS_MODAL_DIMENSIONS_INCOMPLETE',
    },
    { name: 'ceiling', value: { ...envelope, measured_running_ceiling_m: null }, reason: 'CROSS_MODAL_RUNNING_CEILING_UNKNOWN' },
  ];
  for (const fixture of invalidFixtures) {
    const receipt = normalizeCrossModalReductionEvidence(fixture.value, expected);
    assert.equal(receipt.valid, false, fixture.name);
    assert.deepEqual(receipt.reason_codes, [fixture.reason], fixture.name);
  }

  const { content_hash: _contentHash, ...contentWithoutHash } = envelope;
  const inheritedDimensionContent = {
    ...contentWithoutHash,
    dimensions: {
      ...envelope.dimensions,
      aerobic: Object.create(envelope.dimensions.aerobic),
    },
  };
  const inheritedDimensionEnvelope = {
    ...inheritedDimensionContent,
    content_hash: `sha256:${canonicalHash(inheritedDimensionContent)}`,
  };
  const hostileFixtures = [
    Object.create(envelope),
    inheritedDimensionEnvelope,
    crossModalEvidenceEnvelope({
      dimensions: {
        ...envelope.dimensions,
        aerobic: { ...envelope.dimensions.aerobic, untrusted_override: true },
      },
    }),
  ];
  for (const hostile of hostileFixtures) {
    const receipt = normalizeCrossModalReductionEvidence(hostile, expected);
    assert.equal(receipt.valid, false, 'prototype or open-schema evidence must fail closed');
    assert.deepEqual(receipt.reason_codes, ['CROSS_MODAL_EVIDENCE_SHAPE_INVALID']);
  }

  const decision = {
    decision_id: 'synthetic-bound-cross-modal-decision',
    decision_hash: canonicalHash({ fixture: 'synthetic-bound-cross-modal-decision' }),
    athlete_id: envelope.athlete_id,
    athlete_state_revision: envelope.athlete_state_revision,
    evidence_snapshot_id: envelope.evidence_snapshot_id,
    phase: 'DEVELOPMENT', consistency_state: 'CONSISTENT', training_age_class: 'ESTABLISHED',
    evidence_used: [{ evidence_id: envelope.evidence_snapshot_id }],
  };
  const scope = deriveMaterialReductionScope({
    planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-23',
    decision, cross_modal_reduction_evidence: normalized,
    measured_running_ceiling_m: normalized.measured_running_ceiling_m,
  });
  assert.equal(scope.reason_code, 'CROSS_MODAL_FATIGUE_LIMIT');
  assert.equal(scope.cross_modal_ledger_hash, normalized.dimension_ledger.receipt_hash);
  assert.equal(deriveMaterialReductionScope({
    planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-23',
    decision, cross_modal_reduction_evidence: normalized,
    measured_running_ceiling_m: normalized.measured_running_ceiling_m + 1,
  }), null, 'a ceiling mismatch cannot authorize reduction');

  const candidateLedger = buildCrossModalDoseLedger({
    weekly_dimension_sum: [9, 7, 12, 5, 6, 8, 10, 8],
    dimensions: envelope.dimensions,
    decisive_evidence_ids: normalized.decisive_evidence_ids,
  });
  const accepted = evaluateMaterialDose(materialInput({
    reductionScope: scope,
    crossModalLedger: candidateLedger,
    crossModalReductionEvidence: normalized,
  }));
  assert.equal(accepted.valid, true);
});

test('C3-XMOD-03', 'production route rejects absent, stale, mismatched, and incomplete cross-modal evidence', () => {
  const planningDateLocal = '2026-08-17';
  const baseState = {
    inputHash: `sha256:${'a'.repeat(64)}`,
    planningInputRevision: 4,
    active: null,
    activePlan: null,
    races: [{
      id: 'synthetic-cross-modal-race', user_id: 'synthetic-cross-modal-owner',
      race_date: '2026-10-18', event_local_date: '2026-10-18', event_kind: 'road',
      distance_miles: 10, goal_revision: 4,
    }],
    target: { trainingDays: ['Mon', 'Wed', 'Sun'] },
    context: {
      profile: { training_age_class: 'ESTABLISHED', timezone: 'America/New_York' },
      history: {
        recentRunCount: 8, weeklyMileageBaseline: 12.5,
        runLoadInput: {
          load_input_state: 'COMPLETE', load_input_confidence: 'HIGH', recent_normal_confidence: 'HIGH',
          recent_normal: { status: 'ESTABLISHED', median_distance_m: milesToMeters(12.5), confidence: 'HIGH' },
          load_input_hash: `sha256:${'b'.repeat(64)}`, windows: [], reason_codes: [],
        },
      },
      recovery: { state: 'NORMAL' }, safety: {}, checkin: null,
    },
  };
  const snapshotId = `snapshot-${baseState.inputHash.slice(-24)}`;
  const validEnvelope = crossModalEvidenceEnvelope({ evidence_snapshot_id: snapshotId });
  const fixtures = [
    { label: 'absent', evidence: null, reason: 'CROSS_MODAL_EVIDENCE_RECEIPT_MISSING' },
    { label: 'owner', evidence: { ...validEnvelope, athlete_id: 'other-owner' }, reason: 'CROSS_MODAL_OWNER_MISMATCH' },
    { label: 'revision', evidence: { ...validEnvelope, athlete_state_revision: 3 }, reason: 'CROSS_MODAL_REVISION_MISMATCH' },
    { label: 'stale snapshot', evidence: { ...validEnvelope, evidence_snapshot_id: 'stale-snapshot' }, reason: 'CROSS_MODAL_SNAPSHOT_MISMATCH' },
    { label: 'hash', evidence: { ...validEnvelope, content_hash: `sha256:${'c'.repeat(64)}` }, reason: 'CROSS_MODAL_EVIDENCE_HASH_MISMATCH' },
    {
      label: 'dimension',
      evidence: { ...validEnvelope, dimensions: Object.fromEntries(Object.entries(validEnvelope.dimensions).slice(0, 7)) },
      reason: 'CROSS_MODAL_DIMENSIONS_INCOMPLETE',
    },
    { label: 'ceiling', evidence: { ...validEnvelope, measured_running_ceiling_m: null }, reason: 'CROSS_MODAL_RUNNING_CEILING_UNKNOWN' },
  ];
  for (const fixture of fixtures) {
    let captured = null;
    const state = JSON.parse(JSON.stringify(baseState));
    state.context.history.crossModalReductionEvidence = fixture.evidence;
    const result = plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: 'synthetic-cross-modal-owner', planningDateLocal, state,
      built: { plan: { weeks: [{ days: [{
        date: planningDateLocal,
        sessions: [{ id: 'route-easy', workout_id: 'easy_aerobic', kind: 'run', distance_miles: 6.94, duration_min: 70 }],
      }] }] } },
    }, {
      enumerateCandidates(input) {
        captured = input;
        return { decision: input.decision, candidates: [], selected_candidate: null, persisted: false };
      },
    });
    assert.equal(captured.validation_options.material_reduction_scope, null, fixture.label);
    assert.equal(captured.validation_options.cross_modal_reduction_evidence.valid, false, fixture.label);
    assert.deepEqual(captured.validation_options.cross_modal_reduction_evidence.reason_codes,
      [fixture.reason], fixture.label);
    assert.deepEqual(captured.validation_options.cross_modal_evidence_ids, [], fixture.label);
    assert.equal(result.selected_candidate, null, fixture.label);
    assert.equal(result.persisted, false, fixture.label);

    const productionResult = plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: 'synthetic-cross-modal-owner', planningDateLocal, state,
      built: { plan: { weeks: [{ days: [{
        date: planningDateLocal,
        sessions: [{
          id: 'route-easy', workout_id: 'easy_aerobic', kind: 'run',
          distance_miles: 6.94, duration_min: 70,
        }],
      }] }] } },
    });
    assert.equal(productionResult.selected_candidate, null, `${fixture.label} production selection`);
    assert.ok(productionResult.candidates.length > 0, `${fixture.label} production candidates`);
    assert.ok(productionResult.candidates.every((candidate) => (
      candidate.persisted === false
        && candidate.validation.valid === false
        && candidate.validation.reason_codes.includes('RECENT_LOAD_MAINTAIN')
    )), `${fixture.label} production candidates must remain rejected and non-persistable`);
  }
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
  const roles = validation.validator_results.find((entry) => entry.validator === 'development_roles');
  const longEvaluation = roles.role_evaluations.find((entry) => entry.requirement_id === 'long_aerobic');
  assert.equal(longEvaluation.presentation_floor_min, 45);
  assert.equal(longEvaluation.presentation_floor_source, 'OBSERVED_ORDINARY_EASY_MEDIAN');
});

test('C3-ROLE-02', 'an explicit bounded availability conflict may mark a role unplaceable without inventing a token session', () => {
  const decisionBinding = buildDevelopmentRoleBinding({
    decision_id: 'decision-c3-role-conflict',
    decision_hash: canonicalHash({ decision: 'c3-role-conflict' }),
    lock_revision: 3,
    edit_revision: 2,
    constraint_fingerprint: `sha256:${canonicalHash({ constraints: 'c3-role-conflict' })}`,
    athlete_locks: [],
    manual_edits: [],
  });
  const conflictInput = {
    requirement_id: 'long_aerobic',
    governing_decision_id: decisionBinding.decision_id,
    governing_decision_hash: decisionBinding.decision_hash,
    governing_constraint_revision: decisionBinding.constraint_revision,
    governing_constraint_hash: decisionBinding.constraint_hash,
    scope_kind: 'BLOCK',
    reason_code: 'SCHEDULE_CONSTRAINT',
    effective_from_local: '2026-08-17',
    expires_on_local: '2026-08-24',
    expires_at: '2026-08-24T04:00:00.000Z',
    reevaluate_at: '2026-08-23T12:00:00.000Z',
    scope_timezone: 'UTC',
    affected_modalities: ['running'],
    decisive_evidence_ids: ['synthetic-availability-revision'],
    authorizes_material_reduction: false,
  };
  const boundConflict = normalizeScope(conflictInput);
  assert.ok(boundConflict?.scope_hash);
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
    development_role_conflicts: [boundConflict],
    development_role_binding: decisionBinding,
  });
  assert.equal(result.validator_results.find((entry) => entry.validator === 'development_roles').valid, true);
  assert.equal(result.valid, true);

  const qualityConflict = normalizeScope({ ...conflictInput, requirement_id: 'pure_running_quality' });
  assert.notEqual(qualityConflict.scope_hash, boundConflict.scope_hash,
    'the waived requirement identity must be part of the immutable scope hash');
  for (const conflicts of [
    [{ ...boundConflict, governing_decision_hash: `sha256:${'0'.repeat(64)}` }],
    [{ ...boundConflict, governing_constraint_revision: 'lock:2:edit:2' }],
    [{ ...boundConflict, governing_constraint_hash: `sha256:${'1'.repeat(64)}` }],
    [boundConflict, { ...boundConflict, decisive_evidence_ids: ['synthetic-duplicate-waiver'] }],
    [{ ...qualityConflict, requirement_id: 'long_aerobic' }],
  ]) {
    const rejected = validateGoalBackwardCandidate({
      sessions: [runSession('quality-only-negative', 4, 'threshold_run', 'PRIMARY_KEY')],
    }, {
      training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL',
      safety_action: 'NORMAL', available_local_dates: ['2026-08-17'],
      planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-23',
      development_role_requirements: [{
        requirement_id: 'long_aerobic', any_of: ['long_aerobic'], minimum_role: 'PRIMARY_KEY',
      }],
      development_role_conflicts: conflicts,
      development_role_binding: decisionBinding,
    });
    assert.equal(rejected.validator_results.find((entry) => entry.validator === 'development_roles').valid, false);
  }

  const selfAuthored = validateGoalBackwardCandidate({
    sessions: [runSession('quality-only-self-authored', 4, 'threshold_run', 'PRIMARY_KEY')],
    development_role_conflicts: [boundConflict],
  }, {
    training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT', recovery_state: 'NORMAL',
    safety_action: 'NORMAL', available_local_dates: ['2026-08-17'],
    planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-23',
    development_role_requirements: [{
      requirement_id: 'long_aerobic', any_of: ['long_aerobic'], minimum_role: 'PRIMARY_KEY',
    }],
    development_role_binding: decisionBinding,
  });
  assert.equal(selfAuthored.validator_results.find((entry) => entry.validator === 'development_roles').valid, false);
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

  for (const badDate of ['2026-08-17garbage', '2026-08-17T00:00:00Z']) {
    const hostileDate = enumerateGoalBackwardCandidates({
      ...input,
      available_local_dates: [badDate],
      validation_options: { ...input.validation_options, available_local_dates: [badDate] },
    });
    assert.equal(hostileDate.selected_candidate, null);
    assert.equal(hostileDate.candidates.length, 0,
      `candidate enumeration must reject non-calendar placement date ${badDate}`);
  }
});

test('C3-ENGINE-02', 'enumeration selects bounded taper and training-gap reductions derived from decision evidence', () => {
  for (const fixture of [
    {
      label: 'taper', phase: 'TAPER_RACE_WEEK', consistency: 'CONSISTENT',
      status: 'ESTABLISHED', baselineMiles: 30, candidateMiles: 12,
      expectedReason: 'TAPER_VOLUME_REDUCTION', confidence: 'HIGH',
    },
    {
      label: 'returning', phase: 'FOUNDATION', consistency: 'RETURNING',
      status: 'TRAINING_GAP', baselineMiles: 12.5, candidateMiles: 6.94,
      expectedReason: 'TRAINING_GAP_REBUILD', confidence: 'LOW',
    },
  ]) {
    const decision = {
      decision_id: `decision-c3-${fixture.label}`,
      decision_hash: canonicalHash({ fixture: fixture.label }),
      planning_date_local: '2026-08-17',
      phase: fixture.phase,
      primary_goal_id: `goal-c3-${fixture.label}`,
      training_age_class: 'ESTABLISHED',
      consistency_state: fixture.consistency,
      recovery_state: 'NORMAL',
      safety_state: { action: 'NORMAL', scope: [] },
      evidence_used: [{ evidence_id: `synthetic-${fixture.label}-decision-evidence` }],
      athlete_locks: [], manual_edits: [],
      role_multiset: [{
        requirement_id: 'bounded-aerobic', any_of: ['easy_run'], role: 'PRIMARY_KEY', scheduled_local_date: null,
      }],
      due_exposure_ledger: {
        due_roles: [{ requirement_id: 'bounded-aerobic', any_of: ['easy_run'], role: 'PRIMARY_KEY' }],
        unplaceable_requirement_ids: [],
      },
      development_role_requirements: [],
    };
    const recentNormal = {
      status: fixture.status,
      median_distance_m: milesToMeters(fixture.baselineMiles),
      historical_median_distance_m: fixture.status === 'TRAINING_GAP'
        ? milesToMeters(fixture.baselineMiles) : null,
      confidence: fixture.confidence,
      evidence_ids: [`synthetic-${fixture.label}-load-evidence`],
    };
    const reductionScope = deriveMaterialReductionScope({
      planning_date_local: '2026-08-17', candidate_window_end_local: '2026-08-17',
      evidence_snapshot_id: `synthetic-${fixture.label}-snapshot`,
      decision, recent_normal_running: recentNormal,
      load_evidence_ids: [`synthetic-${fixture.label}-load-evidence`],
    });
    const result = enumerateGoalBackwardCandidates({
      decision,
      available_local_dates: ['2026-08-17'],
      maximum_session_count: 1,
      materialize_canonical: false,
      material_dose_enforced: true,
      legacy_road_candidate_material: [{
        id: `synthetic-${fixture.label}-easy`, workout_id: 'easy_aerobic', workout_family: 'easy_run',
        kind: 'run', title: 'Easy run', distance_miles: fixture.candidateMiles, duration_min: 70,
      }],
      validation_options: {
        available_local_dates: ['2026-08-17'], available_days_count: 1,
        training_age_class: 'ESTABLISHED', consistency_state: fixture.consistency,
        recovery_state: 'NORMAL', safety_action: 'NORMAL',
        recent_normal_running: recentNormal, material_reduction_scope: reductionScope,
      },
    });
    assert.ok(result.selected_candidate, `${fixture.label} must produce a selectable bounded candidate`);
    assert.equal(result.selected_candidate.validation.valid, true);
    assert.deepEqual(result.selected_candidate.validation.reason_codes, [fixture.expectedReason]);
  }
});

test('C3-ENGINE-03', 'enumeration enforces healthy event-specific role gates instead of selecting a partial token week', () => {
  const decision = {
    decision_id: 'decision-c3-development-gate',
    decision_hash: canonicalHash({ fixture: 'c3-development-gate' }),
    planning_date_local: '2026-08-17', phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    primary_goal_id: 'goal-c3-hyrox', training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT', recovery_state: 'NORMAL',
    safety_state: { action: 'NORMAL', scope: [] },
    evidence_used: [{ evidence_id: 'synthetic-development-evidence' }],
    athlete_locks: [], manual_edits: [],
    role_multiset: [{
      requirement_id: 'hyrox-specific', any_of: ['hyrox_compromised'], role: 'PRIMARY_KEY', scheduled_local_date: null,
    }],
    due_exposure_ledger: {
      due_roles: [{ requirement_id: 'hyrox-specific', any_of: ['hyrox_compromised'], role: 'PRIMARY_KEY' }],
      unplaceable_requirement_ids: [],
    },
    development_role_requirements: [
      { requirement_id: 'hyrox_specific', any_of: ['hyrox_compromised'], minimum_role: 'PRIMARY_KEY' },
      { requirement_id: 'pure_running_quality', any_of: ['threshold_run'], minimum_role: 'PRIMARY_KEY' },
      { requirement_id: 'long_aerobic', any_of: ['long_aerobic'], minimum_role: 'PRIMARY_KEY', presentation_floor_required: true },
    ],
  };
  const result = enumerateGoalBackwardCandidates({
    decision, available_local_dates: ['2026-08-17'], maximum_session_count: 1,
    materialize_canonical: false,
    legacy_road_candidate_material: [{
      id: 'hyrox-token', workout_id: 'hyrox_compromised', workout_family: 'hyrox_compromised',
      kind: 'hyrox', title: 'Compromised run', distance_miles: 4, duration_min: 35,
      run_station_pair_count: 3, main_work_duration_min: 30,
    }],
    validation_options: {
      available_local_dates: ['2026-08-17'], available_days_count: 5,
      training_age_class: 'ESTABLISHED', consistency_state: 'CONSISTENT',
      recovery_state: 'NORMAL', safety_action: 'NORMAL', median_ordinary_easy_duration_min: 40,
    },
  });
  assert.equal(result.selected_candidate, null);
  const development = result.candidates[0].validation.validator_results
    .find((entry) => entry.validator === 'development_roles');
  assert.equal(development.valid, false);
  assert.deepEqual(development.violations.map((entry) => entry.requirement_id).sort(), [
    'long_aerobic', 'pure_running_quality',
  ]);
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

  const tooMany = restrictionScope({
    decisive_evidence_ids: Array.from({ length: 17 }, (_, index) => `private-evidence-${index}`),
  });
  assert.equal(evaluateMaterialDose(materialInput({ reductionScope: tooMany })).valid, false,
    'approval-relevant evidence cannot be silently truncated');

  const localExpiry = restrictionScope({
    scope_timezone: 'Pacific/Kiritimati',
    expires_on_local: '2026-08-24',
    expires_at: '2026-08-24T00:30:00+14:00',
    reevaluate_at: '2026-08-22T12:00:00+14:00',
    decisive_evidence_ids: ['local-expiry-evidence-1', 'local-expiry-evidence-2'],
  });
  assert.equal(evaluateMaterialDose(materialInput({ reductionScope: localExpiry })).valid, true,
    'an explicit local expiry date does not shift when its instant crosses a UTC day');
});

test('C3-MAT-08', 'a within-bound candidate emits no false maintain reduction reason', () => {
  const receipt = evaluateMaterialDose(materialInput({ candidateMiles: 12, recentNormalMiles: 12.5 }));
  assert.equal(receipt.valid, true);
  assert.equal(receipt.dose_state, 'WITHIN_MATERIAL_BOUND');
  assert.deepEqual(receipt.reason_codes, []);
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
