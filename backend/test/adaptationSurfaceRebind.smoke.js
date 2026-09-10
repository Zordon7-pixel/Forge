#!/usr/bin/env node

const assert = require('node:assert/strict');
const { canonicalSessionSetHash, canonicalWorkoutHash } = require('../src/lib/canonicalWorkout');
const plansRouter = require('../src/routes/plans');

function hash(char) {
  return `sha256:${char.repeat(64)}`;
}

function canonicalSession(overrides = {}) {
  const session = {
    session_id: 'session-1',
    session_revision: 1,
    plan_id: 'plan-1',
    plan_revision: 1,
    decision_id: 'decision-1',
    goal_ids: ['goal-1'],
    phase: 'BUILD',
    role: 'SUPPORTING',
    workout_family: 'easy_run',
    title: 'Original easy run',
    purpose_reason_codes: ['GOAL_EXPOSURES_SUPPORTED'],
    scheduled_local_date: '2026-09-10',
    timezone: 'America/New_York',
    steps: [],
    success_criteria: ['Complete the canonical work as prescribed.'],
    adjustment_criteria: ['Use the recorded adjustment and safety criteria when needed.'],
    stop_criteria: ['Stop when a recorded safety ceiling is reached.'],
    safety_scope: [],
    executability: 'EXECUTABLE',
    ...overrides,
  };
  session.content_hash = canonicalWorkoutHash(session);
  return session;
}

function run() {
  const originalSession = canonicalSession();
  const canonicalSet = {
    schema_version: 'canonical_session_set_v1',
    canonical_sessions_materialized: true,
    selected_candidate_id: 'skeleton-1',
    selected_candidate_hash: hash('a'),
    candidate_id: 'skeleton-1',
    candidate_hash: hash('a'),
    decision_id: 'decision-1',
    decision_hash: hash('b'),
    plan_id: 'plan-1',
    plan_revision: 1,
    sessions: [originalSession],
  };
  canonicalSet.content_hash = canonicalSessionSetHash(canonicalSet);
  const plan = {
    schemaVersion: 2,
    canonical_workout_schema_version: 1,
    selected_candidate_hash: hash('a'),
    decision_id: 'decision-1',
    decision_hash: hash('b'),
    canonical_session_set_hash: canonicalSet.content_hash,
    plan_id: 'plan-1',
    plan_revision: 1,
    purpose: 'Build safely toward the race.',
    overall_feasibility: 'supported',
    reasons: ['GOAL_EXPOSURES_SUPPORTED'],
    weeks: [{
      week: 1,
      startDate: '2026-09-07',
      phase: 'BUILD',
      purpose: 'Build safely toward the race.',
      days: [{ date: '2026-09-10', day: 'Thu', sessions: [originalSession] }],
    }],
  };
  const candidate = {
    id: 'candidate-row-1',
    status: 'applied',
    decision_id: 'decision-1',
    candidate_revision: 1,
    athlete_state_revision: 1,
    safety_state_hash: hash('c'),
    goal_revisions_json: { 'goal-1': 1 },
    surface_revision: 1,
    feature_mode: 'on',
    selected_candidate_hash: hash('a'),
    applied_training_plan_id: 'plan-1',
    applied_user_plan_id: 'assignment-1',
  };
  const manifest = plansRouter._test.buildCanonicalSurfaceManifest({
    planGenerationCandidateRef: `sha256:${require('../src/lib/racePlanPolicy').canonicalHash(candidate.id)}`,
    featureMode: 'on',
    surfaceRevision: 1,
    candidateRevision: 1,
    athleteStateRevision: 1,
    safetyStateHash: hash('c'),
    goalRevisions: { 'goal-1': 1 },
    decision: { decision_id: 'decision-1', decision_hash: hash('b'), safety_state: { action: 'NORMAL' } },
    selectedCandidate: { candidate_skeleton_id: 'skeleton-1', candidate_hash: hash('a') },
    canonicalSessionSet: canonicalSet,
    plan,
  });
  const activeRow = {
    user_plan_id: 'assignment-1',
    plan_id: 'plan-1',
    plan_version: 1,
    status: 'active',
    plan_data: plan,
  };
  assert.equal(plansRouter._test.surfaceManifestAppliedPlanDiagnostic(
    manifest, candidate, activeRow, canonicalSet,
  ).status_code, 'ACCEPTED');

  const proposedPlan = JSON.parse(JSON.stringify(plan));
  proposedPlan.weeks[0].days[0].sessions[0].title = 'Accepted recovery run';
  proposedPlan.weeks[0].days[0].sessions[0].adjusted = true;

  const bumpedWithoutRebind = {
    ...activeRow,
    plan_version: 2,
    plan_data: proposedPlan,
  };
  assert.equal(plansRouter._test.surfaceManifestAppliedPlanDiagnostic(
    manifest, candidate, bumpedWithoutRebind, canonicalSet,
  ).status_code, 'BLOCKED', 'control: a plan-version bump without a successor surface remains blocked');

  const successor = plansRouter._test.buildAdaptationSurfaceSuccessor({
    activeRow,
    candidate,
    canonicalArtifact: {
      id: 'canonical-artifact-1',
      user_id: 'owner',
      artifact_kind: 'canonical_session_set',
      decision_id: 'decision-1',
      parent_artifact_id: 'validator-artifact-1',
      plan_generation_candidate_id: 'candidate-row-1',
      schema_version: '1',
      policy_version: 'goal-backward-v2.4',
      revision: 1,
      payload_json: canonicalSet,
      created_at: '2026-09-09T12:00:00.000Z',
    },
    surfaceArtifact: {
      id: 'surface-artifact-1',
      user_id: 'owner',
      artifact_kind: 'surface_manifest',
      decision_id: 'decision-1',
      parent_artifact_id: 'canonical-artifact-1',
      plan_generation_candidate_id: 'candidate-row-1',
      schema_version: '1',
      policy_version: 'goal-backward-v2.4',
      revision: 1,
      payload_json: manifest,
      created_at: '2026-09-09T12:00:00.000Z',
    },
    proposedPlan,
    createdAt: '2026-09-09T13:00:00.000Z',
  });

  assert.equal(successor.plan.plan_revision, 2);
  assert.equal(successor.plan.weeks[0].days[0].sessions[0].title, 'Accepted recovery run');
  assert.equal(successor.plan.weeks[0].days[0].sessions[0].session_revision, 2);
  assert.notEqual(successor.plan.canonical_session_set_hash, plan.canonical_session_set_hash);
  assert.equal(successor.canonicalArtifact.revision, 2);
  assert.equal(successor.surfaceArtifact.revision, 2);
  assert.equal(successor.surfaceArtifact.parent_artifact_id, successor.canonicalArtifact.id);
  assert.equal(successor.surfaceArtifact.payload_json.sessions[0].title, 'Accepted recovery run');
  assert.equal(successor.surfaceArtifact.payload_json.plan_generation_candidate_ref, manifest.plan_generation_candidate_ref,
    'An adaptation successor retains its own preview-candidate binding');

  const reboundRow = {
    ...activeRow,
    plan_version: 2,
    plan_data: successor.plan,
  };
  assert.equal(plansRouter._test.surfaceManifestAppliedPlanDiagnostic(
    successor.surfaceArtifact.payload_json,
    candidate,
    reboundRow,
    successor.canonicalArtifact.payload_json,
  ).status_code, 'ACCEPTED', 'accepted adaptation appends a bound executable successor surface');

  assert.throws(() => plansRouter._test.buildAdaptationSurfaceSuccessor({
    activeRow,
    candidate,
    canonicalArtifact: { id: 'bad', payload_json: { plan_revision: 99 } },
    surfaceArtifact: { id: 'bad-surface', parent_artifact_id: 'different', payload_json: manifest },
    proposedPlan,
  }), /reviewed rebuild/i, 'corrupt artifact state still fails closed');

  console.log('adaptation surface rebind smoke: PASS');
}

run();
