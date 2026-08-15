const assert = require('node:assert/strict');

const rollout = require('../src/lib/betaPlanRollout');
const rolloutScript = require('../scripts/upgrade-beta-race-plans');

async function run() {
  rollout.clearGoalBackwardReleaseTelemetry();
  const disposableUserId = '00000000-0000-4000-8000-000000000024';
  const otherUserId = '00000000-0000-4000-8000-000000000025';
  const disposableRef = rollout.targetRef(disposableUserId);
  const cohortRefs = rollout.parseGoalBackwardCohortRefs(disposableRef);

  assert.deepEqual(cohortRefs, [disposableRef]);
  assert.throws(
    () => rollout.parseGoalBackwardCohortRefs(disposableUserId),
    /pseudonymous sha256 refs/,
    'the runtime cohort never accepts raw account IDs',
  );
  assert.equal(rollout.resolveOperationalGoalBackwardV24Mode('off', { userId: disposableUserId, cohortRefs }), 'off');
  assert.equal(rollout.resolveOperationalGoalBackwardV24Mode('shadow', { userId: disposableUserId, cohortRefs }), 'shadow');
  assert.equal(rollout.resolveOperationalGoalBackwardV24Mode('preview', { userId: disposableUserId, cohortRefs }), 'preview');
  assert.equal(rollout.resolveOperationalGoalBackwardV24Mode('on', { userId: disposableUserId, cohortRefs }), 'on');
  assert.equal(
    rollout.resolveOperationalGoalBackwardV24Mode('on', { userId: otherUserId, cohortRefs }),
    'off',
    'a configured release mode cannot cross the pseudonymous cohort boundary',
  );
  assert.equal(rollout.resolveOperationalGoalBackwardV24Mode('garbage', { userId: disposableUserId, cohortRefs }), 'off');

  const comparison = rollout.buildGoalBackwardReleaseTelemetry({
    targetRef: disposableRef,
    eventType: 'candidate_comparison',
    mode: 'shadow',
    outcome: 'control_selected',
    candidateSelected: true,
    passReasonCodes: ['DEVELOPMENT_ENTRY', 'RECENT_LOAD_MAINTAIN'],
    failReasonCodes: ['SCHEDULE_CONSTRAINT'],
    surfaceCapability: 'NOT_EXPOSED',
  });
  assert.equal(comparison.schema_version, 'goal_backward_release_telemetry_v1');
  assert.equal(comparison.policy_versions.planning_policy_version, 'goal-backward-planning-policy-v1');
  assert.deepEqual(comparison.reason_counts, {
    DEVELOPMENT_ENTRY: { pass: 1, fail: 0 },
    RECENT_LOAD_MAINTAIN: { pass: 1, fail: 0 },
    SCHEDULE_CONSTRAINT: { pass: 0, fail: 1 },
  });
  assert.equal(comparison.candidate_selected, true);
  assert.equal(JSON.stringify(comparison).includes(disposableUserId), false);
  assert.throws(
    () => rollout.buildGoalBackwardReleaseTelemetry({
      targetRef: disposableRef,
      eventType: 'candidate_comparison',
      mode: 'shadow',
      outcome: 'control_selected',
      payload: { email: 'private@example.com', route: [[1, 2]], healthSample: 42 },
    }),
    /bounded telemetry fields/,
    'payloads, emails, routes, and health samples cannot enter telemetry',
  );
  assert.throws(
    () => rollout.buildGoalBackwardReleaseTelemetry({
      targetRef: disposableRef,
      eventType: 'candidate_outcome',
      mode: 'on',
      outcome: 'apply_rejected',
      failReasonCodes: ['private database error with free text'],
    }),
    /stable reason code/,
    'free-text failure details are rejected instead of becoming telemetry dimensions',
  );

  rollout.emitGoalBackwardReleaseTelemetry(comparison, { sink: () => {} });
  const safeAlerts = rollout.evaluateGoalBackwardReleaseAlerts(rollout.goalBackwardReleaseTelemetrySnapshot());
  assert.equal(safeAlerts.rollback_required, false);
  const revisionMismatch = rollout.emitGoalBackwardReleaseTelemetry({
    targetRef: disposableRef,
    eventType: 'surface_capability',
    mode: 'on',
    outcome: 'revision_mismatch',
    failReasonCodes: ['REVISION_MISMATCH'],
    surfaceCapability: 'BLOCKED',
    revisionMismatch: true,
  }, { sink: () => {} });
  assert.equal(revisionMismatch.revision_mismatch, true);
  const alerts = rollout.evaluateGoalBackwardReleaseAlerts(rollout.goalBackwardReleaseTelemetrySnapshot());
  assert.equal(alerts.rollback_required, true);
  assert.deepEqual(alerts.breached_thresholds, ['REVISION_MISMATCH']);
  assert.equal(
    rollout.resolveOperationalGoalBackwardV24Mode('on', { userId: disposableUserId, cohortRefs }),
    'off',
    'a zero-tolerance alert forces the applicable cohort back to control',
  );
  rollout.clearGoalBackwardReleaseTelemetry();
  for (const reasonCode of [
    'HARD_VALIDATOR_BYPASS',
    'MUTATION_AFTER_STALE_FAILURE',
    'UNKNOWN_TO_ZERO',
    'TELEMETRY_REDACTION_VIOLATION',
    'SURFACE_EXECUTABILITY_MISMATCH',
    'DUPLICATE_ASSIGNMENT',
  ]) {
    rollout.emitGoalBackwardReleaseTelemetry({
      targetRef: disposableRef,
      eventType: 'candidate_outcome',
      mode: 'on',
      outcome: 'apply_rejected',
      failReasonCodes: [reasonCode],
      surfaceCapability: 'BLOCKED',
    }, { sink: () => {} });
    assert.deepEqual(
      rollout.evaluateGoalBackwardReleaseAlerts(rollout.goalBackwardReleaseTelemetrySnapshot()).breached_thresholds,
      [reasonCode],
      `${reasonCode} has a zero alert threshold`,
    );
    rollout.clearGoalBackwardReleaseTelemetry();
  }

  assert.equal(rolloutScript.parseArgs([]).apply, false);
  assert.equal(rolloutScript.parseArgs([]).rollback, false);
  assert.throws(
    () => rolloutScript.parseArgs([
      '--apply',
      '--user-id=DISPOSABLE_ACCOUNT_ID',
      '--backup-dir=/private/tmp/forge-v24-release-test',
    ]),
    /placeholder/,
  );
  assert.throws(
    () => rolloutScript.assertDisposableUserIds([disposableUserId], [rollout.targetRef(otherUserId)]),
    /DISPOSABLE_TARGET_NOT_ALLOWLISTED/,
  );
  assert.doesNotThrow(() => rolloutScript.assertDisposableUserIds([disposableUserId], cohortRefs));
  assert.throws(
    () => rolloutScript.assertGoalBackwardApplyAuthorized({
      apply: true,
      confirmation: 'APPLY_FUTURE_BETA_PLANS',
      mode: 'on',
    }),
    /APPLY_GOAL_BACKWARD_V24/,
  );
  assert.doesNotThrow(() => rolloutScript.assertGoalBackwardApplyAuthorized({
    apply: true,
    confirmation: 'APPLY_GOAL_BACKWARD_V24',
    mode: 'on',
  }));

  const releaseIdentity = rolloutScript.assertDeployedArtifactIdentity({
    expectedRevision: '0123456789abcdef0123456789abcdef01234567',
    deployedRevision: '0123456789abcdef0123456789abcdef01234567',
    expectedArtifactHash: `sha256:${'a'.repeat(64)}`,
    deployedArtifactHash: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(releaseIdentity.verified, true);
  assert.throws(
    () => rolloutScript.assertDeployedArtifactIdentity({
      expectedRevision: '0123456789abcdef0123456789abcdef01234567',
      deployedRevision: '1123456789abcdef0123456789abcdef01234567',
      expectedArtifactHash: `sha256:${'a'.repeat(64)}`,
      deployedArtifactHash: `sha256:${'a'.repeat(64)}`,
    }),
    /DEPLOYED_REVISION_MISMATCH/,
  );
  assert.throws(
    () => rolloutScript.assertDeployedArtifactIdentity({
      expectedRevision: '0123456789abcdef0123456789abcdef01234567',
      deployedRevision: '0123456789abcdef0123456789abcdef01234567',
      expectedArtifactHash: `sha256:${'a'.repeat(64)}`,
      deployedArtifactHash: `sha256:${'b'.repeat(64)}`,
    }),
    /DEPLOYED_ARTIFACT_MISMATCH/,
  );

  const writes = [];
  const restored = await rolloutScript.restorePreviousAssignment({
    userId: disposableUserId,
    priorUserPlanId: 'assignment-prior',
    appliedUserPlanId: 'assignment-v24',
  }, {
    withUserMutation: async (userId, operation) => {
      assert.equal(userId, disposableUserId);
      const tx = {
        async get(sql, params) {
          writes.push({ kind: 'get', sql, params });
          if (sql.includes('COUNT(*)')) return { active_count: 1, active_id: 'assignment-prior' };
          return { prior_status: 'superseded', applied_status: 'active', supersedes_user_plan_id: 'assignment-prior' };
        },
        async run(sql, params) {
          writes.push({ kind: 'run', sql, params });
          return { changes: 1 };
        },
      };
      return operation(tx);
    },
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.target_ref, disposableRef);
  assert.equal(writes.filter((write) => write.kind === 'run').length, 3);
  assert.equal(writes.every((write) => /user_id=\?/.test(write.sql)), true, 'rollback stays owner scoped');
  assert.equal(JSON.stringify(restored).includes(disposableUserId), false);

  const cleanup = rolloutScript.buildCleanupEvidence({
    userId: disposableUserId,
    accountPresent: false,
    activeAssignmentCount: 0,
    openV24CandidateCount: 0,
    orphanAssignmentCount: 0,
  });
  assert.deepEqual(cleanup, {
    schema_version: 1,
    target_ref: disposableRef,
    account_removed: true,
    active_assignment_count: 0,
    open_v24_candidate_count: 0,
    orphan_assignment_count: 0,
    cleanup_complete: true,
  });
  assert.equal(JSON.stringify(cleanup).includes(disposableUserId), false);

  console.log('GOAL BACKWARD RELEASE SMOKE OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
