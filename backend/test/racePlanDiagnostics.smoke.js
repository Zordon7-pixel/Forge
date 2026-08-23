const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diagnosticsRouter = require('../src/routes/diagnostics');
const plansRouter = require('../src/routes/plans');
const {
  buildDecisionArtifactDiagnosticBundle,
  buildGoalBackwardReleaseDiagnosticBundle,
  buildPlanDiagnosticBundle,
} = require('../src/lib/racePlanDiagnostics');
const {
  buildGoalBackwardReleaseTelemetry,
} = require('../src/lib/betaPlanRollout');
const {
  buildPipelineArtifact,
  persistPipelineArtifacts,
} = require('../src/lib/planCandidateLifecycle');
const { assertPipelineLinks } = require('../src/lib/goalBackwardContracts');
const { canonicalHash } = require('../src/lib/racePlanPolicy');

function plan({ miles = 3, workoutId = 'easy_aerobic', title = 'Easy run' } = {}) {
  return {
    schemaVersion: 2,
    engineVersion: 'race-plan-candidate-v1',
    overall_feasibility: 'supported',
    reasons: ['BRIDGE_WEEK'],
    email: 'must-not-appear@example.com',
    weeks: [{
      week: 1,
      startDate: '2026-08-10',
      phase: 'base',
      purpose: 'Build durable aerobic work.',
      days: [{
        date: '2026-08-11',
        sessions: [{
          id: `run-${workoutId}`,
          kind: 'run',
          type: workoutId === 'long_aerobic' ? 'long' : 'easy',
          workout_id: workoutId,
          title,
          distance_miles: miles,
          duration_min: 40,
          target_zone: 'Zone 2',
          access_token: 'must-not-appear',
        }],
      }],
    }],
  };
}

function candidateFor(activePlan, nextPlan) {
  return {
    id: 'candidate-1',
    candidateHash: 'sha256:candidate',
    plan: nextPlan,
    diagnostics: {
      active_plan: { trainingPlanId: 'plan-old', userPlanId: 'assignment-old', planVersion: 4 },
      active_plan_data: activePlan,
      snapshot: {
        planning_date_local: '2026-08-08',
        context: {
          checkin: { date: '2026-08-08', email: 'hidden@example.com' },
          history: {
            acuteRunLoad: { latestRun: { date: '2026-08-06', route: [[1, 2]], averageHeartRate: 151 } },
            performanceProfile: { targetAnchor: { date: '2026-07-31' } },
            recentRunCount: 4,
            recentLiftCount: 2,
            mileageBaseline: { source: 'complete_weeks' },
          },
          recovery: { state: 'green', dataAvailable: true, syncedAt: '2026-08-08T12:00:00Z' },
          safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
        },
      },
      trace: {
        engine_version: 'race-plan-candidate-v1',
        validation: { valid: true, errors: [] },
      },
    },
  };
}

function buildC4Fixture() {
  const targetUserId = 'synthetic-c4-owner';
  const decisionId = 'decision-c4-complete';
  const planGenerationCandidateId = 'candidate-row-c4';
  const selectedCandidateId = 'candidate-skeleton-c4';
  const selectedCandidateHash = 'b'.repeat(64);
  const decisionHash = 'c'.repeat(64);
  const canonicalSessionSetHash = 'd'.repeat(64);
  const sourceRevision = '7c1bfdc4240fdb7ade6efb4d12402cd30e500ea2';
  const safetyState = { action: 'NORMAL', scope: [], reason_codes: [] };
  const safetyStateHash = `sha256:${canonicalHash(safetyState)}`;
  const generatedAt = '2026-08-16T15:00:00.000Z';
  const releaseIdentity = {
    policy_version: 'goal-backward-planning-policy-v1',
    engine_version: 'goal-backward-coaching-v2.4',
    feature_mode: 'preview',
    generation_timestamp: generatedAt,
    source_revision: sourceRevision,
    deployment_revision: sourceRevision,
  };
  const sessions = [{
    session_id: 'session-c4-1',
    session_revision: 1,
    content_hash: 'e'.repeat(64),
    local_date: '2026-08-17',
    role: 'PRIMARY_KEY',
    workout_family: 'long_aerobic',
  }];
  const payloads = {
    evidence_snapshot: {
      evidence_snapshot_id: 'snapshot-c4',
      planning_date_local: '2026-08-16',
      source: 'REDACTED_SHADOW_INPUT',
      source_revision: sourceRevision,
      deployment_revision: sourceRevision,
      release_identity: releaseIdentity,
    },
    athlete_state: {
      athlete_state_revision: 4,
      recovery_state: 'NORMAL',
      recent_normal_running: {
        status: 'ESTABLISHED',
        median_distance_m: 32000,
        reason_codes: ['RECENT_LOAD_MAINTAIN'],
      },
      safety_state: safetyState,
      safety_state_hash: safetyStateHash,
    },
    planning_decision: {
      decision_id: decisionId,
      decision_hash: decisionHash,
      planning_date_local: '2026-08-16',
      plan_revision: 8,
      goal_set: {
        primary_goal_id: 'goal-c4',
        goals: [{
          goal_id: 'goal-c4',
          source_revision: 3,
          priority: 'A',
          goal_type: 'performance',
          event_state: 'SCHEDULED',
        }],
      },
      phase_decision: { phase: 'DEVELOPMENT', reason_codes: ['DEVELOPMENT_ENTRY'] },
      candidate_ids: [selectedCandidateId],
      selected_candidate_id: selectedCandidateId,
      selected_candidate_hash: selectedCandidateHash,
      candidate_enumeration: { retained_count: 1, total_unique_candidate_count: 1 },
    },
    candidate_week: {
      plan_generation_candidate_ref: `sha256:${canonicalHash(planGenerationCandidateId)}`,
      current_candidate_hash: `sha256:${selectedCandidateHash}`,
      authoritative_engine: 'goal-backward-coaching-v2.4',
      candidates: [{
        candidate_id: selectedCandidateId,
        candidate_hash: selectedCandidateHash,
        valid: true,
        reason_codes: [],
        ranking_tuple: { due_primary_exposures_satisfied: 1 },
      }],
    },
    validator_result: {
      plan_generation_candidate_ref: `sha256:${canonicalHash(planGenerationCandidateId)}`,
      results: [{
        candidate_id: selectedCandidateId,
        candidate_hash: selectedCandidateHash,
        valid: true,
        validators_executed: ['schedule', 'canonical_session_set'],
        reason_codes: [],
      }],
      material_review: { review_contract_complete: true },
    },
    canonical_session_set: {
      plan_generation_candidate_ref: `sha256:${canonicalHash(planGenerationCandidateId)}`,
      canonical_sessions_materialized: true,
      selected_candidate_id: selectedCandidateId,
      selected_candidate_hash: selectedCandidateHash,
      candidate_id: selectedCandidateId,
      candidate_hash: selectedCandidateHash,
      decision_id: decisionId,
      decision_hash: decisionHash,
      plan_id: 'plan-c4',
      plan_revision: 9,
      content_hash: canonicalSessionSetHash,
      sessions,
    },
    surface_manifest: {
      schema_version: 'goal_backward_surface_manifest_v1',
      surface_revision: 1,
      feature_mode: 'preview',
      v24_surface_enabled: true,
      status: 'accepted',
      identity: {
        decision_id: decisionId,
        decision_hash: decisionHash,
        candidate_id: selectedCandidateId,
        candidate_revision: 1,
        candidate_hash: selectedCandidateHash,
        plan_id: 'plan-c4',
        plan_revision: 9,
        canonical_session_set_hash: canonicalSessionSetHash,
        athlete_state_revision: 4,
        safety_state_hash: safetyStateHash,
        goal_revisions: { 'goal-c4': 3 },
      },
      sessions,
    },
  };
  const artifacts = [];
  let parentArtifactId = null;
  for (const [index, kind] of [
    'evidence_snapshot', 'athlete_state', 'planning_decision', 'candidate_week',
    'validator_result', 'canonical_session_set', 'surface_manifest',
  ].entries()) {
    const artifact = buildPipelineArtifact({
      id: `artifact-c4-${kind}`,
      userId: targetUserId,
      kind,
      decisionId,
      parentArtifactId,
      planGenerationCandidateId: index >= 3 ? planGenerationCandidateId : null,
      payload: payloads[kind],
      createdAt: generatedAt,
    });
    artifacts.push(artifact);
    parentArtifactId = artifact.id;
  }
  const decisionArtifact = artifacts.find((artifact) => artifact.artifact_kind === 'planning_decision');
  const candidateRow = {
    id: planGenerationCandidateId,
    user_id: targetUserId,
    status: 'preview',
    training_plan_id: 'plan-c4-old',
    user_plan_id: 'assignment-c4-old',
    active_plan_version: 8,
    planning_input_revision: 4,
    planning_date_local: '2026-08-16',
    timezone_offset_minutes: 0,
    candidate_hash: `sha256:${selectedCandidateHash}`,
    engine_version: 'goal-backward-coaching-v2.4',
    policy_version: 'goal-backward-planning-policy-v1',
    decision_id: decisionId,
    candidate_revision: 1,
    athlete_state_revision: 4,
    safety_state_hash: safetyStateHash,
    goal_revisions_json: { 'goal-c4': 3 },
    lock_revision: 0,
    edit_revision: 0,
    surface_revision: 1,
    export_revision: 1,
    feature_mode: 'preview',
    selected_candidate_hash: selectedCandidateHash,
    material_change_json: {
      review_contract_complete: true,
      reason_codes: [],
      changes: [],
      apply_bindings: {
        decision_hash: decisionHash,
        decision_artifact: {
          artifact_id: decisionArtifact.id,
          revision: decisionArtifact.revision,
          content_hash: decisionArtifact.content_hash,
        },
        planning_timezone: 'UTC',
        evidence_fingerprint: `sha256:${'f'.repeat(64)}`,
        constraint_fingerprint: `sha256:${'1'.repeat(64)}`,
        goal_fingerprint: `sha256:${'2'.repeat(64)}`,
        policy_fingerprint: `sha256:${'3'.repeat(64)}`,
      },
    },
    created_at: generatedAt,
  };
  return { artifacts, candidateRow, decisionId, targetUserId };
}

function replaceC4Payload(fixture, kind, transform) {
  const index = fixture.artifacts.findIndex((artifact) => artifact.artifact_kind === kind);
  const prior = fixture.artifacts[index];
  const payload = JSON.parse(JSON.stringify(prior.payload_json));
  transform(payload);
  fixture.artifacts[index] = buildPipelineArtifact({
    id: prior.id,
    userId: prior.user_id,
    kind: prior.artifact_kind,
    decisionId: prior.decision_id,
    parentArtifactId: prior.parent_artifact_id,
    planGenerationCandidateId: prior.plan_generation_candidate_id,
    schemaVersion: prior.schema_version,
    policyVersion: prior.policy_version,
    revision: prior.revision,
    payload,
    createdAt: prior.created_at,
  });
}

function buildAppliedSurfaceFixture() {
  const fixture = buildC4Fixture();
  const purpose = 'Build durable event-specific work.';
  const weeks = [{
    week: 1,
    start_date: '2026-08-17',
    phase: 'DEVELOPMENT',
    purpose,
  }];
  replaceC4Payload(fixture, 'surface_manifest', (payload) => {
    payload.purpose = purpose;
    payload.feasibility = { status: 'supported', reason_codes: [] };
    payload.weeks = weeks;
  });
  fixture.candidateRow = {
    ...fixture.candidateRow,
    status: 'applied',
    applied_training_plan_id: 'stored-plan-c4',
    applied_user_plan_id: 'assignment-c4-applied',
  };
  const canonical = fixture.artifacts.find((artifact) => (
    artifact.artifact_kind === 'canonical_session_set'
  )).payload_json;
  const surface = fixture.artifacts.find((artifact) => (
    artifact.artifact_kind === 'surface_manifest'
  )).payload_json;
  const appliedRow = {
    user_plan_id: fixture.candidateRow.applied_user_plan_id,
    plan_id: fixture.candidateRow.applied_training_plan_id,
    plan_version: 8,
    status: 'active',
    plan_data: {
      canonical_workout_schema_version: 1,
      plan_id: canonical.plan_id,
      plan_revision: canonical.plan_revision,
      decision_id: canonical.decision_id,
      decision_hash: canonical.decision_hash,
      selected_candidate_hash: canonical.selected_candidate_hash,
      canonical_session_set_hash: canonical.content_hash,
      overall_feasibility: 'supported',
      reasons: [],
      purpose,
      weeks: weeks.map((week) => ({
        week: week.week,
        startDate: week.start_date,
        phase: week.phase,
        purpose: week.purpose,
      })),
    },
  };
  return { ...fixture, appliedRow, canonical, surface };
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function verifyAdminGate() {
  const oldAdmins = process.env.DIAGNOSTICS_ADMIN_EMAILS;
  const oldDemo = process.env.DIAGNOSTICS_ALLOW_DEMO_ADMIN;
  process.env.DIAGNOSTICS_ADMIN_EMAILS = 'ops@forge.app';
  delete process.env.DIAGNOSTICS_ALLOW_DEMO_ADMIN;
  try {
    let nextCalls = 0;
    let res = responseRecorder();
    diagnosticsRouter.requireDiagnosticsAdmin({ user: { email: 'athlete@example.com' } }, res, () => { nextCalls += 1; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalls, 0);

    res = responseRecorder();
    diagnosticsRouter.requireDiagnosticsAdmin({ user: { email: 'demo@forge.app' } }, res, () => { nextCalls += 1; });
    assert.equal(res.statusCode, 403, 'demo stays denied unless its explicit override is enabled');
    assert.equal(nextCalls, 0);

    res = responseRecorder();
    diagnosticsRouter.requireDiagnosticsAdmin({ user: { email: 'OPS@FORGE.APP' } }, res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
  } finally {
    if (oldAdmins === undefined) delete process.env.DIAGNOSTICS_ADMIN_EMAILS;
    else process.env.DIAGNOSTICS_ADMIN_EMAILS = oldAdmins;
    if (oldDemo === undefined) delete process.env.DIAGNOSTICS_ALLOW_DEMO_ADMIN;
    else process.env.DIAGNOSTICS_ALLOW_DEMO_ADMIN = oldDemo;
  }
}

async function run() {
  const targetUserId = 'private-user-id-123';
  const activePlan = plan({ miles: 3 });
  const nextPlan = plan({ miles: 5, workoutId: 'long_aerobic', title: 'Long aerobic run' });
  const bundle = buildPlanDiagnosticBundle({
    targetUserId,
    candidate: candidateFor(activePlan, nextPlan),
  });

  assert.match(bundle.target_ref, /^sha256:/);
  assert.notEqual(bundle.target_ref, targetUserId);
  assert.equal(bundle.active_plan.summary.weekly_curve[0].weekly_miles, 3);
  assert.equal(bundle.candidate.summary.weekly_curve[0].weekly_miles, 5);
  assert.equal(bundle.candidate.summary.weekly_curve[0].long_run_miles, 5);
  assert.equal(bundle.comparison.weekly_curve[0].delta_miles, 2);
  assert.deepEqual(bundle.candidate.summary.quality_distribution, {});
  assert.equal(bundle.input_sources.latest_run_date, '2026-08-06');
  assert.equal(bundle.active_safety_constraints.active_injury, false);
  const serialized = JSON.stringify(bundle);
  for (const forbidden of [targetUserId, 'must-not-appear@example.com', 'hidden@example.com', 'must-not-appear', 'averageHeartRate', 'route']) {
    assert.equal(serialized.includes(forbidden), false, `diagnostic must omit ${forbidden}`);
  }

  const oversized = plan();
  oversized.weeks[0].days = Array.from({ length: 3200 }, (_, index) => ({
    date: '2026-08-11',
    sessions: [{
      kind: 'run',
      workout_id: 'easy_aerobic',
      title: `Repeated bounded diagnostic session ${index}`,
      distance_miles: 3,
      duration_min: 30,
      target_zone: 'Zone 2',
    }],
  }));
  assert.throws(
    () => buildPlanDiagnosticBundle({ targetUserId, candidate: candidateFor(activePlan, oversized) }),
    (error) => error.code === 'PLAN_CANDIDATE_TOO_LARGE' && error.status === 422,
  );

  const evidenceArtifact = buildPipelineArtifact({
    id: 'artifact-evidence',
    userId: targetUserId,
    kind: 'evidence_snapshot',
    decisionId: 'decision-1',
    payload: { evidence_ids: ['evidence-1'], source_refs: ['provider-ref-1'] },
    createdAt: '2026-08-14T12:00:00.000Z',
  });
  const athleteStateArtifact = buildPipelineArtifact({
    id: 'artifact-state',
    userId: targetUserId,
    kind: 'athlete_state',
    decisionId: 'decision-1',
    parentArtifactId: evidenceArtifact.id,
    payload: { athlete_state_revision: 2, reason_codes: ['TRAINING_GAP_REBUILD'] },
    createdAt: '2026-08-14T12:00:01.000Z',
    revision: 2,
  });
  const pipeline = [evidenceArtifact, athleteStateArtifact];
  for (const kind of ['planning_decision', 'candidate_week', 'validator_result', 'canonical_session_set', 'surface_manifest']) {
    const prior = pipeline[pipeline.length - 1];
    pipeline.push(buildPipelineArtifact({
      id: `artifact-${kind}`,
      userId: targetUserId,
      kind,
      decisionId: 'decision-1',
      parentArtifactId: prior.id,
      planGenerationCandidateId: pipeline.length >= 3 ? 'candidate-1' : null,
      payload: { stage: kind, reason_codes: [] },
      createdAt: `2026-08-14T12:00:0${pipeline.length}.000Z`,
    }));
  }
  assert.equal(assertPipelineLinks(pipeline), pipeline);
  const artifactBundle = buildDecisionArtifactDiagnosticBundle({
    targetUserId,
    decisionId: 'decision-1',
    artifactRows: pipeline,
  });
  assert.equal(artifactBundle.decision_id, 'decision-1');
  assert.equal(artifactBundle.artifact_count, 7);
  assert.equal(artifactBundle.artifacts[0].artifact_kind, 'evidence_snapshot');
  assert.equal(artifactBundle.artifacts[1].parent_artifact_id, 'artifact-evidence');
  assert.equal(JSON.stringify(artifactBundle).includes(targetUserId), false);
  const artifactWrites = [];
  const persisted = await persistPipelineArtifacts({
    tx: {
      async run(sql, params) {
        artifactWrites.push({ sql, params });
        return { changes: 1 };
      },
    },
    artifacts: pipeline,
    requireCompleteLinks: true,
  });
  assert.equal(persisted.inserted, 7);
  assert.deepEqual(persisted.artifact_ids, pipeline.map((artifact) => artifact.id));
  assert.equal(artifactWrites.length, 7);
  assert.equal(artifactWrites.every((write) => write.sql.includes('INSERT INTO planning_pipeline_artifacts')), true);
  assert.equal(artifactWrites.every((write) => !write.sql.includes('UPDATE planning_pipeline_artifacts')), true);
  assert.throws(
    () => buildDecisionArtifactDiagnosticBundle({
      targetUserId,
      decisionId: 'decision-1',
      artifactRows: [{
        ...evidenceArtifact,
        payload_json: { nested: [{ privateProfile: { phoneNumber: '+1-555-0100' } }] },
      }],
    }),
    (error) => error.code === 'DIAGNOSTIC_ARTIFACT_REDACTION_REQUIRED' && error.status === 422,
  );
  for (const forbiddenKey of [
    'ssn', 'socialSecurityNumber', 'homeAddress', 'creditCardNumber',
    'accountId', 'credentials', 'rawHealthSamples',
  ]) {
    assert.throws(
      () => buildPipelineArtifact({
        id: `artifact-pii-${forbiddenKey}`,
        userId: targetUserId,
        kind: 'evidence_snapshot',
        decisionId: 'decision-1',
        payload: { nested: [{ [forbiddenKey]: 'must-not-persist' }] },
        createdAt: '2026-08-14T12:00:00.000Z',
      }),
      (error) => error.code === 'INVALID_PIPELINE_ARTIFACT'
        && error.details.some((detail) => detail.code === 'ARTIFACT_REDACTION_REQUIRED'),
    );
  }
  assert.throws(
    () => buildDecisionArtifactDiagnosticBundle({
      targetUserId,
      decisionId: 'decision-1',
      artifactRows: [{ ...evidenceArtifact, payload_json: { evidence_ids: ['tampered'] } }],
    }),
    (error) => error.code === 'DIAGNOSTIC_ARTIFACT_HASH_MISMATCH' && error.status === 422,
  );

  const completeC4 = buildC4Fixture();
  const completeDiagnostic = buildDecisionArtifactDiagnosticBundle({
    targetUserId: completeC4.targetUserId,
    decisionId: completeC4.decisionId,
    artifactRows: completeC4.artifacts,
    candidateRow: completeC4.candidateRow,
  });
  assert.equal(completeDiagnostic.production_complete, true);
  assert.deepEqual(completeDiagnostic.reason_codes, []);
  assert.equal(completeDiagnostic.stages.length, 11);
  assert.equal(completeDiagnostic.stages.every((stage) => stage.complete === true), true);
  assert.equal(completeDiagnostic.release_identity.revisions_match, true);
  assert.equal(completeDiagnostic.canonical_binding.verified, true);
  assert.ok(Buffer.byteLength(JSON.stringify(completeDiagnostic), 'utf8') < 256 * 1024);

  const missingStageCases = [
    ['evidence_snapshot', (payload) => { delete payload.evidence_snapshot_id; }, 'C4_EVIDENCE_IDENTITY_MISSING'],
    ['athlete_state', (payload) => { delete payload.athlete_state_revision; }, 'C4_ATHLETE_STATE_MISSING'],
    ['planning_decision', (payload) => { delete payload.goal_set; }, 'C4_GOAL_SET_MISSING'],
    ['athlete_state', (payload) => { delete payload.recent_normal_running; }, 'C4_RECENT_NORMAL_SAFETY_STATE_MISSING'],
    ['planning_decision', (payload) => { delete payload.phase_decision; }, 'C4_PHASE_DECISION_MISSING'],
    ['planning_decision', (payload) => { delete payload.decision_hash; }, 'C4_PLANNING_DECISION_MISSING'],
    ['candidate_week', (payload) => { payload.candidates = []; }, 'C4_CANDIDATE_SET_MISSING'],
    ['validator_result', (payload) => { payload.results = []; }, 'C4_VALIDATOR_RECEIPTS_MISSING'],
    ['canonical_session_set', (payload) => { payload.sessions = []; }, 'C4_CANONICAL_SESSIONS_MISSING'],
    ['canonical_session_set', (payload) => { delete payload.plan_revision; }, 'C4_PLAN_REVISION_MISSING'],
    ['surface_manifest', (payload) => { delete payload.identity; }, 'C4_SURFACE_IDENTITY_MISSING'],
  ];
  for (const [kind, mutate, reasonCode] of missingStageCases) {
    const fixture = buildC4Fixture();
    replaceC4Payload(fixture, kind, mutate);
    const diagnostic = buildDecisionArtifactDiagnosticBundle({
      targetUserId: fixture.targetUserId,
      decisionId: fixture.decisionId,
      artifactRows: fixture.artifacts,
      candidateRow: fixture.candidateRow,
    });
    assert.equal(diagnostic.production_complete, false, reasonCode);
    assert.equal(diagnostic.reason_codes.includes(reasonCode), true, reasonCode);
  }

  const membershipMismatch = buildC4Fixture();
  replaceC4Payload(membershipMismatch, 'candidate_week', (payload) => {
    payload.candidates[0].candidate_id = 'different-candidate';
  });
  assert.equal(buildDecisionArtifactDiagnosticBundle({
    targetUserId: membershipMismatch.targetUserId,
    decisionId: membershipMismatch.decisionId,
    artifactRows: membershipMismatch.artifacts,
    candidateRow: membershipMismatch.candidateRow,
  }).reason_codes.includes('C4_SELECTED_CANDIDATE_NOT_IN_SET'), true);

  const canonicalMismatch = buildC4Fixture();
  replaceC4Payload(canonicalMismatch, 'canonical_session_set', (payload) => {
    payload.selected_candidate_hash = '9'.repeat(64);
  });
  assert.equal(buildDecisionArtifactDiagnosticBundle({
    targetUserId: canonicalMismatch.targetUserId,
    decisionId: canonicalMismatch.decisionId,
    artifactRows: canonicalMismatch.artifacts,
    candidateRow: canonicalMismatch.candidateRow,
  }).reason_codes.includes('C4_CANONICAL_PLAN_BINDING_MISMATCH'), true);

  for (const [field, value, reasonCode] of [
    ['source_revision', null, 'C4_SOURCE_REVISION_MISSING'],
    ['deployment_revision', null, 'C4_DEPLOYMENT_REVISION_MISSING'],
    ['deployment_revision', '1111111111111111111111111111111111111111', 'C4_RELEASE_REVISION_MISMATCH'],
  ]) {
    const fixture = buildC4Fixture();
    replaceC4Payload(fixture, 'evidence_snapshot', (payload) => {
      if (value === null) delete payload.release_identity[field];
      else payload.release_identity[field] = value;
    });
    const diagnostic = buildDecisionArtifactDiagnosticBundle({
      targetUserId: fixture.targetUserId,
      decisionId: fixture.decisionId,
      artifactRows: fixture.artifacts,
      candidateRow: fixture.candidateRow,
    });
    assert.equal(diagnostic.production_complete, false, reasonCode);
    assert.equal(diagnostic.reason_codes.includes(reasonCode), true, reasonCode);
  }

  const staleSurface = buildC4Fixture();
  replaceC4Payload(staleSurface, 'surface_manifest', (payload) => {
    payload.identity.candidate_revision = 2;
  });
  assert.equal(buildDecisionArtifactDiagnosticBundle({
    targetUserId: staleSurface.targetUserId,
    decisionId: staleSurface.decisionId,
    artifactRows: staleSurface.artifacts,
    candidateRow: staleSurface.candidateRow,
  }).reason_codes.includes('C4_SURFACE_IDENTITY_STALE'), true);

  const appliedSurface = buildAppliedSurfaceFixture();
  assert.equal(typeof diagnosticsRouter._test?.buildPlanArtifactDiagnosticHandler, 'function',
    'the authenticated admin artifact route exposes a dependency-injected handler for semantic route coverage');
  const artifactRoute = diagnosticsRouter.stack.find((layer) => (
    layer.route?.path === '/plan-audit/:decisionId/artifacts' && layer.route?.methods?.get
  ));
  assert.ok(artifactRoute, 'the applied surface diagnostic remains on the existing admin route');
  const routeAdminGate = artifactRoute.route.stack[1].handle;
  let forbiddenNextCalls = 0;
  const forbiddenResponse = responseRecorder();
  const oldRouteAdmins = process.env.DIAGNOSTICS_ADMIN_EMAILS;
  process.env.DIAGNOSTICS_ADMIN_EMAILS = 'ops@forge.app';
  try {
    routeAdminGate(
      { user: { email: 'athlete@example.com' } },
      forbiddenResponse,
      () => { forbiddenNextCalls += 1; },
    );
  } finally {
    if (oldRouteAdmins === undefined) delete process.env.DIAGNOSTICS_ADMIN_EMAILS;
    else process.env.DIAGNOSTICS_ADMIN_EMAILS = oldRouteAdmins;
  }
  assert.equal(forbiddenResponse.statusCode, 403);
  assert.equal(forbiddenNextCalls, 0, 'a non-admin never reaches the applied surface diagnostic');

  const auditWrites = [];
  const routeHandler = diagnosticsRouter._test.buildPlanArtifactDiagnosticHandler({
    async dbAll(sql, params) {
      assert.match(sql, /FROM planning_pipeline_artifacts/);
      assert.deepEqual(params, [appliedSurface.targetUserId, appliedSurface.decisionId]);
      return appliedSurface.artifacts;
    },
    async dbGet(sql, params) {
      if (sql.includes('FROM plan_generation_candidates')) {
        assert.deepEqual(params, [
          appliedSurface.candidateRow.id,
          appliedSurface.targetUserId,
          appliedSurface.decisionId,
        ]);
        return appliedSurface.candidateRow;
      }
      assert.match(sql, /FROM user_plans up[\s\S]*JOIN training_plans tp/);
      assert.deepEqual(params, [
        appliedSurface.candidateRow.applied_user_plan_id,
        appliedSurface.targetUserId,
      ]);
      return appliedSurface.appliedRow;
    },
    async withTransaction(callback) {
      return callback({
        async run(sql, params) {
          auditWrites.push({ sql, params });
          return { changes: 1 };
        },
      });
    },
  });
  const appliedResponse = responseRecorder();
  await routeHandler({
    params: { decisionId: appliedSurface.decisionId },
    query: { user_id: appliedSurface.targetUserId },
    user: { id: 'admin-actor-id', email: 'ops@forge.app' },
  }, appliedResponse);
  assert.equal(appliedResponse.statusCode, 200, JSON.stringify(appliedResponse.payload));
  const surfaceDiagnostic = appliedResponse.payload.diagnostic.surface_validation;
  assert.equal(surfaceDiagnostic.applicable, true);
  assert.equal(surfaceDiagnostic.status_code, 'BLOCKED');
  assert.equal(surfaceDiagnostic.first_failed_predicate, 'ASSIGNMENT_REVISION_MATCH');
  assert.deepEqual(surfaceDiagnostic.reason_codes, ['SURFACE_REVISION_MISMATCH']);
  assert.equal(surfaceDiagnostic.predicates.ASSIGNMENT_REVISION_MATCH, false);
  assert.deepEqual(surfaceDiagnostic.revisions.plan, {
    manifest: 9,
    plan: 9,
    assignment: 8,
    canonical_session_set: 9,
    matches: false,
  });
  assert.deepEqual(Object.keys(surfaceDiagnostic.bindings).sort(), [
    'artifact', 'assignment', 'athlete_state', 'candidate', 'content_hash',
    'decision', 'goal', 'plan', 'safety', 'session_set', 'surface_revision',
  ]);
  for (const forbidden of [
    appliedSurface.targetUserId,
    appliedSurface.appliedRow.user_plan_id,
    appliedSurface.canonical.plan_id,
    appliedSurface.canonical.sessions[0].session_id,
    appliedSurface.appliedRow.plan_data.purpose,
    'athlete@example.com',
    'access_token',
  ]) {
    assert.equal(JSON.stringify(surfaceDiagnostic).includes(forbidden), false,
      `surface predicate diagnostic must omit ${forbidden}`);
  }
  const routeDiagnosticJson = JSON.stringify(appliedResponse.payload.diagnostic);
  for (const forbidden of [
    appliedSurface.targetUserId,
    appliedSurface.appliedRow.user_plan_id,
    appliedSurface.canonical.plan_id,
    appliedSurface.canonical.sessions[0].session_id,
    appliedSurface.appliedRow.plan_data.purpose,
  ]) {
    assert.equal(routeDiagnosticJson.includes(forbidden), false,
      `the admin route response must omit raw owner, assignment, plan, and session content: ${forbidden}`);
  }
  assert.equal(Object.hasOwn(appliedResponse.payload.diagnostic.artifacts[0], 'payload_json'), false,
    'route artifact rows expose only safe status/revision/hash metadata');
  assert.equal(auditWrites.length, 1);
  assert.match(auditWrites[0].sql, /INSERT INTO diagnostic_access_audit/);
  assert.doesNotMatch(auditWrites[0].sql, /UPDATE|DELETE|plan_generation_candidates|user_plans|training_plans/,
    'the GET diagnostic records access but never mutates plan state');

  const missingArtifactDiagnostic = plansRouter._test.surfaceManifestAppliedPlanDiagnostic(
    null,
    appliedSurface.candidateRow,
    appliedSurface.appliedRow,
    appliedSurface.canonical,
  );
  assert.equal(missingArtifactDiagnostic.first_failed_predicate, 'SURFACE_ARTIFACT_PRESENT');
  assert.equal(missingArtifactDiagnostic.bindings.artifact, false);

  const missingBinding = buildC4Fixture();
  const missingBindingDiagnostic = buildDecisionArtifactDiagnosticBundle({
    targetUserId: missingBinding.targetUserId,
    decisionId: missingBinding.decisionId,
    artifactRows: missingBinding.artifacts,
    candidateRow: null,
  });
  assert.equal(missingBindingDiagnostic.production_complete, false);
  assert.equal(missingBindingDiagnostic.reason_codes.includes('C4_CANONICAL_BINDING_MISSING'), true);

  const brokenParent = buildC4Fixture();
  brokenParent.artifacts[4] = { ...brokenParent.artifacts[4], parent_artifact_id: brokenParent.artifacts[1].id };
  const brokenParentDiagnostic = buildDecisionArtifactDiagnosticBundle({
    targetUserId: brokenParent.targetUserId,
    decisionId: brokenParent.decisionId,
    artifactRows: brokenParent.artifacts,
    candidateRow: brokenParent.candidateRow,
  });
  assert.equal(brokenParentDiagnostic.production_complete, false);
  assert.equal(brokenParentDiagnostic.reason_codes.includes('C4_PIPELINE_PARENT_MISMATCH'), true);

  const releaseDiagnostic = buildGoalBackwardReleaseDiagnosticBundle({
    telemetry: [
      buildGoalBackwardReleaseTelemetry({
        targetRef: bundle.target_ref,
        eventType: 'candidate_comparison',
        mode: 'shadow',
        outcome: 'control_selected',
        candidateSelected: true,
        passReasonCodes: ['DEVELOPMENT_ENTRY'],
        failReasonCodes: ['SCHEDULE_CONSTRAINT'],
        surfaceCapability: 'NOT_EXPOSED',
      }),
      buildGoalBackwardReleaseTelemetry({
        targetRef: bundle.target_ref,
        eventType: 'candidate_outcome',
        mode: 'on',
        outcome: 'applied',
        candidateSelected: true,
        passReasonCodes: ['CANDIDATE_APPLIED'],
        surfaceCapability: 'EXECUTABLE',
      }),
    ],
  });
  assert.equal(releaseDiagnostic.schema_version, 'goal_backward_release_diagnostic_v1');
  assert.deepEqual(releaseDiagnostic.mode_counts, { on: 1, shadow: 1 });
  assert.deepEqual(releaseDiagnostic.outcome_counts, { applied: 1, control_selected: 1 });
  assert.deepEqual(releaseDiagnostic.reason_counts.SCHEDULE_CONSTRAINT, { pass: 0, fail: 1 });
  assert.equal(releaseDiagnostic.alerts.rollback_required, false);
  const releaseSerialized = JSON.stringify(releaseDiagnostic);
  for (const forbidden of [targetUserId, 'private@example.com', 'route', 'healthSample', 'access_token']) {
    assert.equal(releaseSerialized.includes(forbidden), false, `release diagnostic must omit ${forbidden}`);
  }
  assert.throws(
    () => buildGoalBackwardReleaseDiagnosticBundle({ telemetry: [{
      schema_version: 'goal_backward_release_telemetry_v1',
      target_ref: bundle.target_ref,
      event_type: 'candidate_outcome',
      mode: 'on',
      outcome: 'applied',
      payload: { email: 'private@example.com' },
    }] }),
    /release telemetry record/i,
  );

  verifyAdminGate();

  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/diagnostics.js'), 'utf8');
  assert.match(routeSource, /router\.post\('\/plan-audit', auth, requireDiagnosticsAdmin/);
  assert.match(routeSource, /WHERE user_id=\? AND status='upcoming' AND race_date>=\?/);
  assert.match(routeSource, /previewPlanForUser\(targetUserId,[\s\S]*\{ store: false \}\)/);
  assert.match(routeSource, /INSERT INTO diagnostic_access_audit/);
  assert.match(routeSource, /userIds: \[req\.user\.id, targetUserId\]/);
  assert.doesNotMatch(routeSource, /INSERT INTO plan_generation_candidates[\s\S]*plan-audit/);
  assert.match(routeSource, /router\.get\(\s*'\/plan-audit\/:decisionId\/artifacts',\s*auth,\s*requireDiagnosticsAdmin/);
  assert.match(routeSource, /FROM planning_pipeline_artifacts[\s\S]*WHERE user_id=\? AND decision_id=\?/);
  assert.match(routeSource, /FROM plan_generation_candidates[\s\S]*WHERE id=\? AND user_id=\? AND decision_id=\?/);
  assert.match(routeSource, /applied_user_plan_id/);
  assert.match(routeSource, /FROM user_plans up[\s\S]*JOIN training_plans tp[\s\S]*WHERE up\.id=\? AND up\.user_id=\?/);
  assert.match(routeSource, /LIMIT 32/);
  assert.match(routeSource, /router\.get\('\/goal-backward-release', auth, requireDiagnosticsAdmin/);
  assert.match(routeSource, /goalBackwardReleaseTelemetrySnapshot\(\)/);

  console.log('RACE PLAN DIAGNOSTICS SMOKE OK (68)');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
