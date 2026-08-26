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
  buildGoalBackwardApplyEnvelope,
  buildGoalBackwardFingerprintBindings,
  candidateRejectionMatches,
  normalizePlanningConstraints,
  validateGoalBackwardApplyEnvelope,
} = require('../src/lib/planCandidateLifecycle');
const { buildCompletionOutcomeRevisions } = require('../src/lib/planningRevision');
const plansRoute = require('../src/routes/plans');

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
    [{
      target_met: true,
      pain_level: 10,
      painLevel: 10,
      pain: 10,
      perceived_exertion: 10,
      perceivedEffort: 10,
      rpe: 10,
      postRunPain: 'severe',
      postRunEnergy: 'low',
      energy: 'low',
      value: { pain_level: 10, perceived_effort: 10, rpe: 10, post_energy: 'low' },
    }, 'ON_TARGET'],
    [{ pain_limited: true, injury_record_id: 'injury-record-explicit' }, 'PAIN_LIMITED'],
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
      life_flags: ['sore', 'injured'], pain_level: 10, perceived_effort: 10, post_energy: 'low',
    },
    recentRunLoad: {
      latestRun: {
        evidence_id: 'run-current', session_id: 'translated-session', target_met: true,
        postRunPain: 'severe', postRunEnergy: 'low', perceivedEffort: 10,
      },
    },
  }, [{ session_id: 'translated-session', duration_s: 1200 }]);
  assert.deepEqual(
    translated.map((entry) => entry.outcome),
    ['ON_TARGET', 'ON_TARGET'],
    'subjective check-in answers are omitted and subjective run fields cannot create pain or strain outcomes',
  );

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

test('SAFE-01', 'subjective answers stay inert while explicit injury and safety records remain authoritative', () => {
  const currentPlan = plan([session('subjective-quality', '2026-08-14', 'threshold_run', {
    kind: 'run', type: 'quality', workout_type: 'run', role: 'PRIMARY_KEY',
    duration_min: 40, distance_miles: 4,
  })]);
  const proposalInput = {
    plan: currentPlan,
    planningDateISO: '2026-08-14',
    planVersion: 'subjective-fields-inert',
  };
  const baseline = buildAdaptationProposal(proposalInput);
  const subjective = buildAdaptationProposal({
    ...proposalInput,
    checkin: {
      evidence_id: 'subjective-checkin', linked_session_id: 'subjective-quality', post_run: true,
      feeling: 1, legs: 1, drive: 1, sleep_hours: 2, time_available: 5,
      life_flags: ['sick', 'injured', 'sore'], pain_level: 10, perceived_effort: 10, post_energy: 'low',
    },
    recentRunLoad: {
      latestRun: {
        evidence_id: 'subjective-run-answers', session_id: 'subjective-quality', target_met: true,
        postRunPain: 'severe', postRunEnergy: 'low', perceivedEffort: 10,
      },
      protection: { active: false },
    },
  });
  assert.deepEqual(subjective, baseline, 'questionnaire answers cannot change the adaptation proposal');

  const injury = buildAdaptationProposal({
    ...proposalInput,
    injuryState: {
      activeInjuries: [{
        id: 'injury-record-objective', bodyPart: 'knee', severity: 'severe', date: '2026-08-14',
      }],
    },
  });
  assert.equal(injury.safetyException, true, 'a structured open injury record remains authoritative');
  assert.equal(injury.changes.length, 1);
  assert.equal(injury.changes[0].after.kind, 'rest');

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

test('SAFE-03', 'FULL_REST and malformed safety overlays fail closed on every executable surface', () => {
  const result = buildSafetyExecutability([
    session('rest-blocked', '2026-08-16', 'strength_upper', {
      exercises: [{ working_sets: 2 }, { working_sets: 2 }],
    }),
  ], { safety_action: 'FULL_REST', safety_state_revision: 9 });
  assert.equal(Object.values(result.surface_executability).every((value) => value === false), true);
  assert.equal(result.sessions[0].executable, false);
  assert.equal(result.sessions[0].safety_state_revision, 9);

  const invalidOverlay = buildSafetyExecutability([
    session('invalid-scope-blocked', '2026-08-16', 'strength_upper', {
      exercises: [{ working_sets: 2 }, { working_sets: 2 }],
    }),
  ], {
    safety_action: 'NORMAL',
    safety_state_revision: 10,
    safety_scope: [{ action: 'NO_RUNNING' }],
  });
  assert.equal(invalidOverlay.safety_scope_state, 'INVALID_FAIL_CLOSED');
  assert.equal(invalidOverlay.sessions[0].reason_code, 'SAFETY_SCOPE_INVALID');
  assert.equal(Object.values(invalidOverlay.surface_executability).every((value) => value === false), true);
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

test('SAFE-05', 'workout starts require one current manifest binding and preserve scoped eligibility', () => {
  const hash = (character) => character.repeat(64);
  const identity = {
    plan_id: 'plan-start-safe', plan_revision: 3, athlete_state_revision: 11,
    safety_state_hash: `sha256:${hash('a')}`,
  };
  const makeSession = (sessionId, workoutFamily, overrides = {}) => ({
    session_id: sessionId, session_revision: 2, plan_id: identity.plan_id,
    plan_revision: identity.plan_revision, workout_family: workoutFamily,
    executability: 'EXECUTABLE', content_hash: hash('b'), safety_scope: [], steps: [],
    ...overrides,
  });
  const upper = makeSession('safe-upper-start', 'strength_upper');
  const run = makeSession('blocked-run-start', 'easy_run', { safety_scope: ['RUN', 'IMPACT'], content_hash: hash('c') });
  const manifest = {
    schema_version: 'goal_backward_surface_manifest_v1', surface_revision: 6,
    status: 'accepted', identity,
    safety: { action: 'NO_RUNNING', scope: ['RUN', 'IMPACT'], reason_codes: ['NO_RUNNING'] },
    sessions: [run, upper],
  };
  const access = plansRoute._test.canonicalWorkoutStartAccess(manifest, upper);
  assert.equal(plansRoute._test.canonicalWorkoutStartDecision({ manifest, access, sessionId: upper.session_id, activity: { kind: 'lift' } }).allowed, true);
  assert.equal(plansRoute._test.canonicalWorkoutStartDecision({ manifest, access: plansRoute._test.canonicalWorkoutStartAccess(manifest, run), sessionId: run.session_id, activity: { kind: 'run' } }).reasonCode, 'NO_RUNNING');
  const stale = JSON.parse(JSON.stringify(access));
  stale.manifest.safety_state_hash = `sha256:${hash('d')}`;
  assert.equal(plansRoute._test.canonicalWorkoutStartDecision({ manifest, access: stale, sessionId: upper.session_id, activity: { kind: 'lift' } }).reasonCode, 'WORKOUT_START_ACCESS_STALE');
  assert.equal(plansRoute._test.canonicalWorkoutStartDecision({ manifest, access: null, sessionId: upper.session_id, activity: { kind: 'lift' } }).reasonCode, 'WORKOUT_START_ACCESS_MISSING');
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

function applyEnvelopeFixture() {
  return buildGoalBackwardApplyEnvelope({
    id: 'candidate-mutation-fixture',
    user_id: 'athlete-mutation-fixture',
    candidate_hash: `sha256:${'a'.repeat(64)}`,
    training_plan_id: 'plan-mutation-active',
    user_plan_id: 'assignment-mutation-active',
    active_plan_version: 7,
    planning_input_revision: 12,
    planning_date_local: '2026-08-14',
    timezone_offset_minutes: 240,
    decision_id: 'decision-mutation-fixture',
    candidate_revision: 2,
    athlete_state_revision: 5,
    lock_revision: 3,
    edit_revision: 4,
    safety_state_hash: `sha256:${'b'.repeat(64)}`,
    goal_revisions_json: { 'goal-mutation-fixture': 3 },
    surface_revision: 4,
    export_revision: 2,
    feature_mode: 'on',
    selected_candidate_hash: `sha256:${'a'.repeat(64)}`,
    material_change_json: {
      apply_bindings: {
        decision_hash: 'c'.repeat(64),
        decision_artifact: {
          artifact_id: 'artifact-mutation-fixture',
          revision: 1,
          content_hash: `sha256:${'d'.repeat(64)}`,
        },
        planning_timezone: 'America/New_York',
        goal_fingerprint: `sha256:${'e'.repeat(64)}`,
        evidence_fingerprint: `sha256:${'f'.repeat(64)}`,
        constraint_fingerprint: `sha256:${'1'.repeat(64)}`,
        policy_fingerprint: `sha256:${'2'.repeat(64)}`,
        lock_revision: 3,
        edit_revision: 4,
      },
    },
  });
}

test('MUT-01', 'a stale active-plan revision fails visibly before any apply write', () => {
  const expected = applyEnvelopeFixture();
  const result = validateGoalBackwardApplyEnvelope(expected, {
    ...expected,
    active_plan: { ...expected.active_plan, plan_revision: expected.active_plan.plan_revision + 1 },
  });
  assert.deepEqual(result, { valid: false, code: 'ACTIVE_PLAN_REVISION_CHANGED' });
  const applySource = plansRoute._test.applyPlanCandidate.toString();
  assert.ok(applySource.indexOf('validateGoalBackwardApplyEnvelope(expectedApplyEnvelope, requestEnvelope)')
    < applySource.indexOf("row.status !== 'preview'"));
});

test('MUT-02', 'a race revision change invalidates the bound preview', () => {
  const expected = applyEnvelopeFixture();
  assert.deepEqual(validateGoalBackwardApplyEnvelope(expected, {
    ...expected,
    goal_revisions: { 'goal-mutation-fixture': 4 },
  }), { valid: false, code: 'RACE_REVISION_CHANGED' });
});

test('MUT-03', 'an exact duplicate apply returns the recorded replay before successor writes', () => {
  const expected = applyEnvelopeFixture();
  assert.deepEqual(validateGoalBackwardApplyEnvelope(expected, expected), { valid: true, code: null });
  const applySource = plansRoute._test.applyPlanCandidate.toString();
  const replayBranch = applySource.indexOf("row.status === 'applied'");
  const replayReturn = applySource.indexOf('status: 200, replay: true', replayBranch);
  const previewBranch = applySource.indexOf("row.status !== 'preview'", replayBranch);
  const firstSuccessorWrite = applySource.indexOf('await tx.run(', previewBranch);
  assert.ok(replayBranch >= 0 && replayReturn > replayBranch && previewBranch > replayReturn);
  assert.ok(firstSuccessorWrite === -1 || firstSuccessorWrite > previewBranch,
    'duplicate replay must return before a successor assignment write');
});

test('MUT-04', 'a fresh restrictive safety revision stale-fails the preview and remains enforced', () => {
  const expected = applyEnvelopeFixture();
  const current = {
    ...expected,
    athlete_state_revision: expected.athlete_state_revision + 1,
    safety_state_hash: `sha256:${'3'.repeat(64)}`,
  };
  assert.deepEqual(validateGoalBackwardApplyEnvelope(expected, current), {
    valid: false,
    code: 'ATHLETE_STATE_REVISION_CHANGED',
  });
  const safety = buildSafetyExecutability([
    session('mutation-safety-run', '2026-08-14', 'easy_run'),
  ], { safety_action: 'NO_RUNNING', safety_state_revision: current.athlete_state_revision });
  assert.equal(safety.sessions[0].executable, false);
  assert.equal(safety.sessions[0].safety_state_revision, current.athlete_state_revision);
});

const ownedAcceptanceIds = [
  'SAFE-01', 'SAFE-02', 'SAFE-03', 'SAFE-04',
  'LOCK-01', 'EDIT-01', 'REJECT-01', 'MISS-01', 'MISS-02',
  'MUT-01', 'MUT-02', 'MUT-03', 'MUT-04',
];
assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
assert.deepEqual(results.filter((id) => ownedAcceptanceIds.includes(id)).sort(), [...ownedAcceptanceIds].sort(),
  'all 13 adaptation-owned acceptance rows must report exactly once');
console.log(`GOAL BACKWARD ADAPTATION SMOKE OK (${results.length})`);
