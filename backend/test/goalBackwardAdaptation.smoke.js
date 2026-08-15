#!/usr/bin/env node

const assert = require('node:assert/strict');

const {
  COMPLETION_OUTCOMES,
  buildAdaptationProposal,
  buildGoalBackwardAdaptationProposal,
  classifyCompletionOutcome,
  suppressRejectedAdaptationCandidate,
  summarizeCompletionOutcomes,
  translateCompletionEvidence,
} = require('../src/lib/adaptationEngine');
const { buildGoalBackwardPlanningDecision } = require('../src/lib/goalBackwardDecisionEngine');
const {
  buildSafetyExecutability,
  compareMaterialChange,
  validateGoalBackwardAdaptationCandidate,
} = require('../src/lib/goalBackwardValidators');
const {
  buildCandidateRejectionRecord,
  buildGoalBackwardFingerprintBindings,
  candidateRejectionMatches,
  normalizePlanningConstraints,
} = require('../src/lib/planCandidateLifecycle');
const { buildCompletionOutcomeRevisions } = require('../src/lib/planningRevision');

const results = [];

function test(id, description, assertion) {
  assertion();
  results.push(id);
  console.log(`ok - ${id} - ${description}`);
}

function session(id, date, workoutFamily, overrides = {}) {
  return {
    id,
    session_id: id,
    scheduled_local_date: date,
    workout_family: workoutFamily,
    role: 'SUPPORTING',
    duration_min: 30,
    ...overrides,
  };
}

function plan(sessions) {
  return {
    schemaVersion: 2,
    planMode: 'run_only',
    weeks: [{
      week: 1,
      phase: 'build',
      days: sessions.map((entry) => ({
        day: entry.scheduled_local_date,
        date: entry.scheduled_local_date,
        sessions: [entry],
      })),
    }],
  };
}

function assertCompletionOutcomeContracts() {
  const legacyInput = {
    plan: plan([session('legacy-quality', '2026-08-14', 'threshold_run', {
      kind: 'run', type: 'quality', workout_type: 'run', duration_min: 40, distance_miles: 4,
    })]),
    planningDateISO: '2026-08-14',
    planVersion: 'legacy-byte-compatibility',
    completion: { missedWorkouts: 2 },
  };
  assert.deepEqual(
    buildAdaptationProposal(legacyInput),
    buildAdaptationProposal({ ...legacyInput, goalBackwardV24: false }),
    'missing and explicit flag-off adaptation responses remain byte-compatible'
  );
  assert.deepEqual(COMPLETION_OUTCOMES, [
    'UNDER_TARGET',
    'ON_TARGET',
    'ABOVE_TARGET',
    'EXCESSIVE_STRAIN',
    'INCOMPLETE',
    'PAIN_LIMITED',
    'UNSCORABLE_PARTIAL_SYNC',
  ]);
  const fixtures = [
    [{ observed_duration_s: 1800, prescribed_duration_s: 2400 }, 'UNDER_TARGET'],
    [{ observed_duration_s: 2340, prescribed_duration_s: 2400 }, 'ON_TARGET'],
    [{ observed_duration_s: 2760, prescribed_duration_s: 2400 }, 'ABOVE_TARGET'],
    [{ target_met: true, perceived_exertion: 10, excessive_strain: true }, 'EXCESSIVE_STRAIN'],
    [{ completion_state: 'missed' }, 'INCOMPLETE'],
    [{ pain_limited: true, pain_level: 6 }, 'PAIN_LIMITED'],
    [{ quality_state: 'PARTIAL', sync_state: 'PARTIAL_SYNC', observed_duration_s: 0 }, 'UNSCORABLE_PARTIAL_SYNC'],
  ];
  for (const [observation, expected] of fixtures) {
    const classified = classifyCompletionOutcome({
      observation: { evidence_id: `evidence-${expected.toLowerCase()}`, ...observation },
      prescribedSession: { session_id: 'session-outcome' },
    });
    assert.equal(classified.outcome, expected);
    assert.equal(COMPLETION_OUTCOMES.includes(classified.outcome), true);
  }
  const failedSync = classifyCompletionOutcome({
    observation: { evidence_id: 'failed-sync', sync_state: 'FAILED_SYNC', observed_distance_m: 0 },
    prescribedSession: { session_id: 'failed-session', distance_m: 5000 },
  });
  assert.equal(failedSync.outcome, 'UNSCORABLE_PARTIAL_SYNC');
  assert.deepEqual(failedSync.reason_codes, ['FAILED_SYNC'], 'failed and partial sync reasons stay distinct');

  const translated = translateCompletionEvidence({
    completionObservations: [{
      evidence_id: 'completion-current', linked_session_id: 'translated-session',
      value: { duration_s: 1200, target_met: true },
    }],
    checkin: {
      evidence_id: 'checkin-current', linked_session_id: 'translated-session', post_workout: true,
      life_flags: ['sore'],
    },
    recentRunLoad: {
      latestRun: {
        evidence_id: 'run-current', session_id: 'translated-session', target_met: true,
        postRunPain: 'none',
      },
    },
  }, [{ session_id: 'translated-session', duration_s: 1200 }]);
  assert.deepEqual(translated.map((entry) => entry.outcome), ['ON_TARGET', 'PAIN_LIMITED', 'ON_TARGET']);

  const partial = classifyCompletionOutcome({
    observation: {
      evidence_id: 'partial-observation',
      quality_state: 'PARTIAL',
      sync_state: 'PARTIAL_SYNC',
      observed_distance_m: 0,
    },
    prescribedSession: { session_id: 'partial-session', distance_m: 5000 },
  });
  assert.equal(partial.outcome, 'UNSCORABLE_PARTIAL_SYNC');
  assert.equal(partial.scorable, false);
  assert.equal(partial.observed_to_prescribed_ratio, null, 'partial coverage never manufactures a zero ratio');

  const ordinary = summarizeCompletionOutcomes([{ ...partial, outcome: 'ABOVE_TARGET', scorable: true }]);
  assert.equal(ordinary.material_adaptation_eligible, false);
  assert.equal(ordinary.single_ordinary_outlier_protected, true);
  const assessment = summarizeCompletionOutcomes([{
    ...partial,
    outcome: 'ABOVE_TARGET',
    scorable: true,
    designated_assessment: true,
  }]);
  assert.equal(assessment.material_adaptation_eligible, true, 'a designated assessment may update evidence');

  const rawObservation = {
    evidence_id: 'observed-run-1',
    evidence_type: 'completed_workout',
    truth_class: 'OBSERVED',
    value: { duration_s: 2340, distance_m: 5000 },
  };
  const evidenceSnapshot = {
    evidence_snapshot_id: 'evidence-snapshot-before',
    evidence_snapshot_revision: 2,
    athlete_id: 'athlete-synthetic',
    created_at: '2026-08-13T12:00:00.000Z',
    planning_date_local: '2026-08-13',
    timezone: 'America/New_York',
    evidence: [rawObservation],
    reason_codes: [],
  };
  const athleteState = {
    athlete_state_id: 'athlete-state-before',
    athlete_state_revision: 4,
    athlete_id: 'athlete-synthetic',
    evidence_snapshot_id: evidenceSnapshot.evidence_snapshot_id,
    safety_action: 'NORMAL',
    safety_scope: [],
    reason_codes: [],
  };
  const beforeSnapshotBytes = JSON.stringify(evidenceSnapshot);
  const beforeStateBytes = JSON.stringify(athleteState);
  const outcome = classifyCompletionOutcome({
    observation: { ...rawObservation, observed_duration_s: 2340 },
    prescribedSession: { session_id: 'session-1', duration_s: 2400 },
  });
  const revision = buildCompletionOutcomeRevisions({
    evidenceSnapshot,
    athleteState,
    outcomes: [outcome],
    createdAt: '2026-08-14T12:00:00.000Z',
  });
  assert.equal(JSON.stringify(evidenceSnapshot), beforeSnapshotBytes);
  assert.equal(JSON.stringify(athleteState), beforeStateBytes);
  assert.deepEqual(revision.evidence_snapshot.evidence[0], rawObservation, 'the observed envelope remains byte-equivalent');
  assert.equal(revision.evidence_snapshot.evidence_snapshot_revision, 3);
  assert.equal(revision.evidence_snapshot.supersedes_evidence_snapshot_id, 'evidence-snapshot-before');
  assert.equal(revision.outcome_evidence[0].truth_class, 'DERIVED');
  assert.deepEqual(revision.outcome_evidence[0].source_evidence_ids, ['observed-run-1']);
  assert.equal(revision.athlete_state.athlete_state_revision, 5);
  assert.equal(revision.athlete_state.evidence_snapshot_id, revision.evidence_snapshot.evidence_snapshot_id);
}

assertCompletionOutcomeContracts();

test('SAFE-01', 'fresh restrictive safety evidence wins over a great readiness check-in', () => {
  const run = session('restricted-run', '2026-08-16', 'easy_run');
  const result = buildSafetyExecutability([run], {
    safety_action: 'NO_RUNNING',
    safety_state_revision: 7,
    subjective_readiness: 'READY',
  });
  assert.equal(result.sessions[0].executable, false);
  assert.equal(result.sessions[0].reason_code, 'NO_RUNNING');
  assert.equal(result.safety_state_revision, 7);
  assert.equal(Object.values(result.surface_executability).every((value) => value === false), true);
});

test('SAFE-02', 'NO_RUNNING blocks running while leaving safe upper-body work eligible', () => {
  const result = buildSafetyExecutability([
    session('blocked-run', '2026-08-16', 'easy_run'),
    session('safe-upper', '2026-08-16', 'strength_upper', {
      exercises: [{ working_sets: 2 }, { working_sets: 2 }],
    }),
  ], { safety_action: 'NO_RUNNING', safety_state_revision: 8 });
  assert.deepEqual(result.sessions.map((entry) => [entry.session_id, entry.executable]), [
    ['blocked-run', false],
    ['safe-upper', true],
  ]);
});

test('SAFE-03', 'FULL_REST closes every executable surface for the same safety revision', () => {
  const result = buildSafetyExecutability([
    session('rest-blocked', '2026-08-16', 'strength_upper', {
      exercises: [{ working_sets: 2 }, { working_sets: 2 }],
    }),
  ], { safety_action: 'FULL_REST', safety_state_revision: 9 });
  assert.equal(Object.values(result.surface_executability).every((value) => value === false), true);
  assert.equal(result.sessions[0].executable, false);
  assert.equal(result.sessions[0].safety_state_revision, 9);
});

test('SAFE-04', 'a superseding resolved state can return to NORMAL without permanent suppression', () => {
  const blocked = buildSafetyExecutability([
    session('resolved-run', '2026-08-16', 'easy_run'),
  ], { safety_action: 'NO_RUNNING', safety_state_revision: 10 });
  const resolved = buildSafetyExecutability([
    session('resolved-run', '2026-08-16', 'easy_run'),
  ], {
    safety_action: 'NORMAL',
    safety_state_revision: 11,
    supersedes_safety_state_revision: 10,
    resolution_evidence_ids: ['pain-resolution-observation'],
  });
  assert.equal(blocked.sessions[0].executable, false);
  assert.equal(resolved.sessions[0].executable, true);
  assert.equal(resolved.supersedes_safety_state_revision, 10);
});

test('LOCK-01', 'revisioned athlete day and session locks reject a silent move', () => {
  const constraints = normalizePlanningConstraints([
    {
      id: 'lock-sunday-v1', user_id: 'athlete-synthetic', constraint_kind: 'day_lock',
      plan_id: 'plan-1', date_local: '2026-08-16', revision: 1, active: true,
      attributed_by_user_id: 'athlete-synthetic',
      attributed_payload_json: { role: 'PRIMARY_KEY', workout_family: 'long_aerobic' },
    },
    {
      id: 'lock-sunday-v2', user_id: 'athlete-synthetic', constraint_kind: 'day_lock',
      plan_id: 'plan-1', date_local: '2026-08-16', revision: 2, active: true,
      supersedes_constraint_id: 'lock-sunday-v1', attributed_by_user_id: 'athlete-synthetic',
      attributed_payload_json: { role: 'PRIMARY_KEY', workout_family: 'long_aerobic' },
    },
    {
      id: 'lock-retired-v1', user_id: 'athlete-synthetic', constraint_kind: 'session_lock',
      plan_id: 'plan-1', session_id: 'retired-session', date_local: '2026-08-15', revision: 1, active: true,
      attributed_by_user_id: 'athlete-synthetic', attributed_payload_json: { workout_family: 'easy_run' },
    },
    {
      id: 'lock-retired-v2', user_id: 'athlete-synthetic', constraint_kind: 'session_lock',
      plan_id: 'plan-1', session_id: 'retired-session', date_local: '2026-08-15', revision: 2, active: false,
      supersedes_constraint_id: 'lock-retired-v1', attributed_by_user_id: 'athlete-synthetic',
      attributed_payload_json: { workout_family: 'easy_run' },
    },
  ], { athleteId: 'athlete-synthetic', planId: 'plan-1' });
  assert.equal(constraints.lock_revision, 2);
  assert.equal(constraints.locks.length, 1, 'only the latest active scope revision is authoritative');

  const moved = validateGoalBackwardAdaptationCandidate({ sessions: [
    session('sunday-long', '2026-08-15', 'long_aerobic', { role: 'PRIMARY_KEY', duration_min: 75 }),
  ] }, { training_age_class: 'ESTABLISHED', planning_constraints: constraints });
  assert.equal(moved.valid, false);
  assert.equal(moved.reason_codes.includes('ATHLETE_LOCK_CONFLICT'), true);
  const preserved = validateGoalBackwardAdaptationCandidate({ sessions: [
    session('sunday-long', '2026-08-16', 'long_aerobic', { role: 'PRIMARY_KEY', duration_min: 75 }),
  ] }, { training_age_class: 'ESTABLISHED', planning_constraints: constraints });
  assert.equal(preserved.valid, true);
});

test('EDIT-01', 'athlete-authored manual edits retain attribution and require review before overwrite', () => {
  const editHash = 'a'.repeat(64);
  const constraints = normalizePlanningConstraints([{
    id: 'edit-1', user_id: 'athlete-synthetic', constraint_kind: 'manual_edit',
    plan_id: 'plan-1', session_id: 'edited-session', date_local: '2026-08-17', revision: 3, active: true,
    attributed_by_user_id: 'athlete-synthetic',
    attributed_payload_json: {
      owner: 'athlete', workout_family: 'easy_run', scheduled_local_date: '2026-08-17',
      session_revision: 4, content_hash: editHash,
    },
  }], { athleteId: 'athlete-synthetic', planId: 'plan-1' });
  assert.equal(constraints.edit_revision, 3);
  assert.equal(constraints.manual_edits[0].owner, 'athlete');
  assert.equal(constraints.manual_edits[0].attributed_by_user_id, 'athlete-synthetic');

  const edited = session('edited-session', '2026-08-17', 'easy_run', {
    role: 'PRIMARY_KEY', duration_min: 30, session_revision: 4, content_hash: editHash,
  });
  const overwritten = { ...edited, workout_family: 'interval_run', quality_work_duration_min: 12 };
  const validation = validateGoalBackwardAdaptationCandidate({ sessions: [overwritten] }, {
    training_age_class: 'ESTABLISHED', planning_constraints: constraints,
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.reason_codes.includes('ATHLETE_EDIT_PRESERVED'), true);
  const material = compareMaterialChange({
    active_applied_plan: { plan_revision: 4, sessions: [edited] },
    candidate: { plan_revision: 5, sessions: [overwritten] },
    decisive_evidence_ids: ['edit-recommendation-evidence'],
  });
  assert.equal(material.preview_required, true);

  const decision = buildGoalBackwardPlanningDecision({
    athlete_id: 'athlete-synthetic', planning_date_local: '2026-08-14', plan_id: 'plan-1', plan_revision: 4,
    athlete_state: {
      athlete_state_revision: 2, available_days: ['2026-08-17'], training_age_class: 'ESTABLISHED',
      safety_action: 'NORMAL', recovery_state: 'NORMAL', recent_normal_running: { status: 'INSUFFICIENT' },
    },
    planning_constraints: constraints,
  });
  assert.equal(decision.manual_edits[0].owner, 'athlete');
  assert.equal(decision.edit_revision, 3);
});

test('REJECT-01', 'athlete rejection keeps the active plan and suppresses only the identical current fingerprint', () => {
  const activePlan = plan([session('retained-session', '2026-08-17', 'easy_run')]);
  const candidatePlan = plan([session('changed-session', '2026-08-17', 'threshold_run', {
    role: 'PRIMARY_KEY', quality_work_duration_min: 12,
  })]);
  const candidateHash = `sha256:${'b'.repeat(64)}`;
  const fingerprintDecision = {
    athlete_id: 'athlete-synthetic',
    plan_id: 'plan-active',
    athlete_state_revision: 2,
    evidence_snapshot_id: 'snapshot-current',
    evidence_used: [{ evidence_id: 'evidence-current', purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
    active_goals: [{
      goal_id: 'goal-a', race_id: 'race-a', source_revision: 1,
      event_local_date: '2026-10-11', event_state: 'SCHEDULED', priority: 'A',
    }],
    lock_revision: 0,
    edit_revision: 0,
    safety_state: { action: 'NORMAL', scope: [] },
    policy_versions: {
      planning_policy_version: 'goal-backward-planning-policy-v1',
      event_policy_registry_version: 1,
      stress_taxonomy_version: 1,
    },
    event_policy_id: 'road_10mile_v1',
  };
  const originalBindings = buildGoalBackwardFingerprintBindings(fingerprintDecision);
  const changedGoalBindings = buildGoalBackwardFingerprintBindings({
    ...fingerprintDecision,
    active_goals: [{ ...fingerprintDecision.active_goals[0], source_revision: 2 }],
  });
  assert.notEqual(changedGoalBindings.goal_fingerprint, originalBindings.goal_fingerprint);
  assert.notEqual(
    changedGoalBindings.policy_fingerprint,
    originalBindings.policy_fingerprint,
    'the persisted policy fingerprint intentionally includes the goal fingerprint, so a goal change releases suppression',
  );
  assert.equal(changedGoalBindings.evidence_fingerprint, originalBindings.evidence_fingerprint);
  assert.equal(changedGoalBindings.constraint_fingerprint, originalBindings.constraint_fingerprint);
  const rejection = buildCandidateRejectionRecord({
    userId: 'athlete-synthetic',
    candidateHash,
    decisionId: 'decision-rejected',
    decisionHash: 'c'.repeat(64),
    reasonCode: 'ADAPTATION_REJECTED',
    evidenceFingerprint: originalBindings.evidence_fingerprint,
    constraintFingerprint: originalBindings.constraint_fingerprint,
    policyFingerprint: originalBindings.policy_fingerprint,
    createdAt: '2026-08-14T12:00:00.000Z',
  });
  const fingerprint = {
    evidence_fingerprint: rejection.evidence_fingerprint,
    constraint_fingerprint: rejection.constraint_fingerprint,
    policy_fingerprint: rejection.policy_fingerprint,
  };
  assert.equal(candidateRejectionMatches(rejection, { candidate_hash: candidateHash, ...fingerprint }), true);
  assert.equal(candidateRejectionMatches(rejection, {
    candidate_hash: candidateHash,
    ...fingerprint,
    evidence_fingerprint: `sha256:${'0'.repeat(64)}`,
  }), false, 'new evidence releases suppression');

  const suppressed = suppressRejectedAdaptationCandidate({
    proposal: {
      status: 'proposal', changes: [{ sessionId: 'retained-session' }], proposedPlan: candidatePlan,
      reason_codes: [],
    },
    activePlan,
    candidateHash,
    rejectionRecords: [rejection],
    fingerprint,
  });
  assert.equal(suppressed.status, 'keep');
  assert.deepEqual(suppressed.changes, []);
  assert.deepEqual(suppressed.proposedPlan, activePlan, 'rejection never mutates or replaces the active plan');
  assert.equal(suppressed.reason_codes.includes('ADAPTATION_REJECTED'), true);
  assert.equal(suppressed.reason_codes.includes('IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED'), true);

  const released = suppressRejectedAdaptationCandidate({
    proposal: { status: 'proposal', changes: [{ sessionId: 'retained-session' }], proposedPlan: candidatePlan },
    activePlan,
    candidateHash,
    rejectionRecords: [rejection],
    fingerprint: { ...fingerprint, policy_fingerprint: changedGoalBindings.policy_fingerprint },
  });
  assert.equal(released.status, 'proposal', 'goal or policy changes permit a fresh proposal');
});

test('MISS-01', 'missed work follows an explicit skip/replace policy and never creates an excess hard day', () => {
  const sourcePlan = plan([
    session('next-key', '2026-08-17', 'threshold_run', {
      kind: 'run', type: 'quality', workout_type: 'run', role: 'PRIMARY_KEY', duration_min: 45,
      quality_work_duration_min: 16, distance_miles: 5,
    }),
    session('debt-a', '2026-08-18', 'interval_run', {
      kind: 'run', type: 'quality', workout_type: 'run', role: 'PRIMARY_KEY', duration_min: 45,
      quality_work_duration_min: 16, distance_miles: 5, workout_debt: true,
    }),
  ]);
  const result = buildGoalBackwardAdaptationProposal({
    plan: sourcePlan,
    planningDateISO: '2026-08-17',
    planVersion: 'adaptation-v24-1',
    completion: {
      missedWorkouts: 2,
      missedSessions: [
        { session_id: 'missed-key-a', role: 'PRIMARY_KEY', missed_local_date: '2026-08-12' },
        { session_id: 'missed-key-b', role: 'PRIMARY_KEY', missed_local_date: '2026-08-14' },
      ],
    },
    athleteState: { athlete_state_revision: 2, safety_action: 'NORMAL', recovery_state: 'NORMAL' },
    validationOptions: { training_age_class: 'ESTABLISHED' },
  });
  assert.equal(result.status, 'proposal');
  assert.equal(result.v24_validation.valid, true);
  assert.equal(result.missed_session_policy.actions.every((action) => (
    ['SKIP', 'RESCHEDULE', 'SHORTEN', 'REPLACE', 'OMIT_EXCESS'].includes(action.action)
  )), true);
  assert.equal(result.v24_validation.workload_evidence.rolling_hard_days.valid, true);
});

test('MISS-02', 'multiple missed key sessions omit excess debt with NO_WORKOUT_DEBT', () => {
  const sourcePlan = plan([
    session('debt-a', '2026-08-17', 'threshold_run', {
      kind: 'run', type: 'quality', workout_type: 'run', role: 'PRIMARY_KEY', duration_min: 45,
      quality_work_duration_min: 16, distance_miles: 5, workout_debt: true,
    }),
    session('debt-b', '2026-08-19', 'interval_run', {
      kind: 'run', type: 'quality', workout_type: 'run', role: 'PRIMARY_KEY', duration_min: 45,
      quality_work_duration_min: 16, distance_miles: 5, workout_debt: true,
    }),
  ]);
  const result = buildGoalBackwardAdaptationProposal({
    plan: sourcePlan,
    planningDateISO: '2026-08-17',
    planVersion: 'adaptation-v24-debt',
    completion: {
      missedWorkouts: 3,
      missedSessions: [
        { session_id: 'missed-key-a', role: 'PRIMARY_KEY', missed_local_date: '2026-08-11' },
        { session_id: 'missed-key-b', role: 'PRIMARY_KEY', missed_local_date: '2026-08-13' },
        { session_id: 'missed-key-c', role: 'PRIMARY_KEY', missed_local_date: '2026-08-15' },
      ],
    },
    athleteState: { athlete_state_revision: 3, safety_action: 'NORMAL', recovery_state: 'NORMAL' },
    validationOptions: { training_age_class: 'ESTABLISHED' },
  });
  assert.equal(result.reason_codes.includes('NO_WORKOUT_DEBT'), true);
  assert.equal(result.missed_session_policy.omitted_excess_count >= 1, true);
  const sessions = result.proposedPlan.weeks[0].days.flatMap((day) => day.sessions);
  assert.equal(sessions.some((entry) => entry.workout_debt === true), false, 'debt markers never survive as executable work');
  assert.equal(result.v24_validation.valid, true);
});

const expectedBatch10Ids = [
  'SAFE-01', 'SAFE-02', 'SAFE-03', 'SAFE-04',
  'LOCK-01', 'EDIT-01', 'REJECT-01', 'MISS-01', 'MISS-02',
];
assert.deepEqual(results, expectedBatch10Ids);
console.log(`GOAL BACKWARD ADAPTATION SMOKE OK (${results.length})`);
