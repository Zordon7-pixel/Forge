const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diagnosticsRouter = require('../src/routes/diagnostics');
const {
  buildDecisionArtifactDiagnosticBundle,
  buildPlanDiagnosticBundle,
} = require('../src/lib/racePlanDiagnostics');
const {
  buildPipelineArtifact,
  persistPipelineArtifacts,
} = require('../src/lib/planCandidateLifecycle');
const { assertPipelineLinks } = require('../src/lib/goalBackwardContracts');

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
  for (const forbiddenKey of ['ssn', 'socialSecurityNumber', 'homeAddress', 'creditCardNumber']) {
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

  verifyAdminGate();

  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/diagnostics.js'), 'utf8');
  assert.match(routeSource, /router\.post\('\/plan-audit', auth, requireDiagnosticsAdmin/);
  assert.match(routeSource, /WHERE user_id=\? AND status='upcoming' AND race_date>=\?/);
  assert.match(routeSource, /previewPlanForUser\(targetUserId,[\s\S]*\{ store: false \}\)/);
  assert.match(routeSource, /INSERT INTO diagnostic_access_audit/);
  assert.match(routeSource, /userIds: \[req\.user\.id, targetUserId\]/);
  assert.doesNotMatch(routeSource, /INSERT INTO plan_generation_candidates[\s\S]*plan-audit/);
  assert.match(routeSource, /router\.get\('\/plan-audit\/:decisionId\/artifacts', auth, requireDiagnosticsAdmin/);
  assert.match(routeSource, /FROM planning_pipeline_artifacts[\s\S]*WHERE user_id=\? AND decision_id=\?/);
  assert.match(routeSource, /LIMIT 32/);

  console.log('RACE PLAN DIAGNOSTICS SMOKE OK (56)');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
