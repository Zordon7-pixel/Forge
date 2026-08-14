const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assignmentLifecycle = require('../src/lib/planAssignmentLifecycle');
const candidateLifecycle = require('../src/lib/planCandidateLifecycle');
const plansRouter = require('../src/routes/plans');
const {
  getGoalBackwardV24Mode,
} = require('../src/lib/betaPlanRollout');

const ownerId = 'candidate-owner';
const oldAssignment = {
  user_plan_id: 'up-old',
  plan_id: 'tp-old',
  id: 'tp-old',
  started_at: '2026-08-01',
  effective_from: '2026-08-01',
  status: 'superseded',
  supersedes_user_plan_id: null,
  plan_version: 3,
  lineage_id: 'lineage-1',
  progress_json: '{}',
  current_week: 2,
  user_id: ownerId,
  plan_data: JSON.stringify({ weeks: [] }),
};
const newAssignment = {
  user_plan_id: 'up-new',
  plan_id: 'tp-new',
  id: 'tp-new',
  started_at: '2026-08-09',
  effective_from: '2026-08-09',
  status: 'active',
  supersedes_user_plan_id: 'up-old',
  plan_version: 4,
  lineage_id: 'lineage-1',
  progress_json: '{}',
  current_week: 1,
  user_id: ownerId,
  plan_data: JSON.stringify({ weeks: [] }),
};

function assignmentOnly(row) {
  return {
    user_plan_id: row.user_plan_id,
    plan_id: row.plan_id,
    current_week: row.current_week,
    started_at: row.started_at,
    status: row.status,
    progress_json: row.progress_json,
    plan_version: row.plan_version,
    lineage_id: row.lineage_id,
    supersedes_user_plan_id: row.supersedes_user_plan_id,
    effective_from: row.effective_from,
  };
}

function createTx() {
  const calls = [];
  return {
    calls,
    async get(sql, params = []) {
      calls.push({ sql, params });
      assert.equal(params.includes(ownerId), true, 'every assignment lookup is owner-scoped');
      if (sql.includes("up.status='active'") || sql.includes("up.status = 'active'")) {
        return sql.includes('JOIN training_plans') ? { ...newAssignment } : assignmentOnly(newAssignment);
      }
      if (sql.includes('up.id=?') && params[0] === 'up-old') {
        return sql.includes('JOIN training_plans') ? { ...oldAssignment } : assignmentOnly(oldAssignment);
      }
      if (sql.includes('owner_up.id=?') && params[0] === 'tp-old') {
        return { id: 'tp-old', user_id: ownerId, plan_data: oldAssignment.plan_data };
      }
      if (sql.includes('owner_up.id=?') && params[0] === 'tp-new') {
        return { id: 'tp-new', user_id: ownerId, plan_data: newAssignment.plan_data };
      }
      return null;
    },
  };
}

async function run() {
  const originalMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  try {
    delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    assert.equal(getGoalBackwardV24Mode(), 'off', 'missing v2.4 mode defaults off');
    for (const invalid of ['', 'true', 'PREVIEW ', 'enabled', 'garbage']) {
      process.env.FORGE_GOAL_BACKWARD_V24_MODE = invalid;
      assert.equal(getGoalBackwardV24Mode(), 'off', `invalid v2.4 mode ${JSON.stringify(invalid)} fails off`);
    }
    for (const mode of ['off', 'shadow', 'preview', 'on']) {
      process.env.FORGE_GOAL_BACKWARD_V24_MODE = mode;
      assert.equal(getGoalBackwardV24Mode(), mode);
    }
  } finally {
    if (originalMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = originalMode;
  }

  assert.equal(assignmentLifecycle.assignmentEffectiveFrom(newAssignment), '2026-08-09');
  assert.equal(assignmentLifecycle.isAssignmentEffective(newAssignment, '2026-08-08'), false);
  assert.equal(assignmentLifecycle.isAssignmentEffective(newAssignment, '2026-08-09'), true);
  assert.equal(
    assignmentLifecycle.shouldFollowSupersededAssignment(newAssignment, '2026-08-08'),
    true,
  );
  assert.equal(
    assignmentLifecycle.shouldFollowSupersededAssignment(newAssignment, '2026-08-08', { includeFuture: true }),
    false,
  );

  let tx = createTx();
  let selected = await plansRouter._test.getActivePlanForUser(ownerId, tx, {
    planningDateLocal: '2026-08-08',
  });
  assert.equal(selected.row.user_plan_id, 'up-old', 'today keeps the predecessor authoritative');

  tx = createTx();
  selected = await plansRouter._test.getActivePlanForUser(ownerId, tx, {
    planningDateLocal: '2026-08-09',
  });
  assert.equal(selected.row.user_plan_id, 'up-new', 'the replacement becomes authoritative on effective_from');

  tx = createTx();
  selected = await plansRouter._test.getActivePlanForUser(ownerId, tx, {
    includeFuture: true,
    planningDateLocal: '2026-08-08',
  });
  assert.equal(selected.row.user_plan_id, 'up-new', 'candidate conflict checks capture the latest applied version');

  tx = createTx();
  selected = await plansRouter._test.getActivePlanForMutation(ownerId, tx, {
    planningDateLocal: '2026-08-08',
  });
  assert.equal(selected.row.user_plan_id, 'up-old', 'today progress mutates the predecessor, not tomorrow\'s plan');
  assert.equal(tx.calls.some((call) => call.sql.includes('FOR UPDATE OF up')), true);
  assert.equal(tx.calls.some((call) => call.sql.includes('owner_up.user_id=?')), true);

  const snapshot = candidateLifecycle.buildPlanningSnapshot({
    activePlan: { planVersion: 3, trainingPlanId: 'tp-old', userPlanId: 'up-old' },
    context: {
      checkin: {
        date: '2026-08-08',
        feeling: 3,
        lifeFlags: ['stressed', 'private free text', 'STRESSED'],
        privateNote: 'must not persist',
      },
      profile: { email: 'hidden@example.com', phone: '555-0100', weekly_miles_current: Infinity },
      target: { distanceMiles: 10 },
    },
    planningDateLocal: '2026-08-08',
    planningInputRevision: 12,
    request: { email: 'hidden@example.com', race_ids: ['race-1'] },
    timezoneOffsetMinutes: 240,
  });
  assert.equal(snapshot.context.profile.email, undefined);
  assert.equal(snapshot.context.profile.phone, undefined);
  assert.equal(snapshot.context.profile.weekly_miles_current, 0);
  assert.deepEqual(snapshot.context.checkin.lifeFlags, ['stressed']);
  assert.equal(snapshot.context.checkin.privateNote, undefined);
  assert.equal(snapshot.request.email, undefined);

  const plan = {
    schemaVersion: 2,
    weeks: [{
      week: 1,
      days: [{
        date: '2026-08-09',
        sessions: [{ id: 'run-1', kind: 'run', distance_miles: 3, duration_min: 30 }],
      }],
    }],
  };
  assert.equal(candidateLifecycle.validatePlanStructure(plan).valid, true);
  assert.equal(candidateLifecycle.prefixedHash(plan), candidateLifecycle.prefixedHash(JSON.parse(JSON.stringify(plan))));
  const duplicate = JSON.parse(JSON.stringify(plan));
  duplicate.weeks[0].days.push({ date: '2026-08-10', sessions: [{ ...duplicate.weeks[0].days[0].sessions[0] }] });
  assert.equal(candidateLifecycle.validatePlanStructure(duplicate).valid, false);

  const bindings = candidateLifecycle.buildGoalBackwardCandidateBindings({
    decisionId: 'decision-synthetic',
    candidateRevision: 1,
    athleteStateRevision: 3,
    safetyStateHash: `sha256:${'a'.repeat(64)}`,
    goalRevisions: { 'goal-synthetic': 2 },
    lockRevision: 0,
    editRevision: 0,
    surfaceRevision: 1,
    exportRevision: 1,
    featureMode: 'shadow',
    selectedCandidateHash: `sha256:${'b'.repeat(64)}`,
    materialChange: { required: false, reason_codes: [] },
  });
  assert.deepEqual(bindings, {
    decision_id: 'decision-synthetic',
    candidate_revision: 1,
    athlete_state_revision: 3,
    safety_state_hash: `sha256:${'a'.repeat(64)}`,
    goal_revisions_json: { 'goal-synthetic': 2 },
    lock_revision: 0,
    edit_revision: 0,
    surface_revision: 1,
    export_revision: 1,
    feature_mode: 'shadow',
    selected_candidate_hash: `sha256:${'b'.repeat(64)}`,
    material_change_json: { required: false, reason_codes: [] },
  });
  assert.throws(
    () => candidateLifecycle.buildGoalBackwardCandidateBindings({
      ...bindings,
      feature_mode: 'invalid',
    }),
    (error) => error?.code === 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INVALID' && error?.status === 422,
  );
  const v24Bundle = candidateLifecycle.validateGoalBackwardCandidateBundle({
    plan,
    snapshot,
    trace: { reason_codes: ['RECENT_LOAD_MAINTAIN'] },
    bindings,
  });
  assert.deepEqual(v24Bundle.bindings, bindings);
  assert.deepEqual(v24Bundle.plan, plan);
  assert.deepEqual(candidateLifecycle.buildGoalBackwardCandidateBundle({
    plan,
    snapshot,
    trace: { reason_codes: ['RECENT_LOAD_MAINTAIN'] },
    bindings,
  }), v24Bundle);

  assert.deepEqual(candidateLifecycle.validateStoredGoalBackwardCandidateBindings({}), { present: false, bindings: null });
  assert.throws(
    () => candidateLifecycle.validateStoredGoalBackwardCandidateBindings({
      decision_id: 'decision-incomplete',
      feature_mode: 'shadow',
    }),
    (error) => error?.code === 'GOAL_BACKWARD_CANDIDATE_BINDINGS_INCOMPLETE' && error?.status === 409,
    'a row with any v2.4 lineage must contain every required binding before apply',
  );
  assert.deepEqual(
    candidateLifecycle.validateStoredGoalBackwardCandidateBindings({
      ...bindings,
      candidate_hash: bindings.selected_candidate_hash,
    }),
    { present: true, bindings },
  );
  assert.throws(
    () => candidateLifecycle.validateStoredGoalBackwardCandidateBindings({
      ...bindings,
      feature_mode: 'preview',
      candidate_hash: bindings.selected_candidate_hash,
    }),
    (error) => error?.code === 'GOAL_BACKWARD_MODE_UNAVAILABLE' && error?.status === 409,
    'preview/on v2.4 bindings stay operationally unavailable before later gates',
  );

  const decisionArtifacts = candidateLifecycle.buildGoalBackwardDecisionArtifacts({
    userId: ownerId,
    planGenerationCandidateId: 'candidate-current',
    currentCandidateHash: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-08-08T12:00:00.000Z',
    decision: {
      decision_id: 'decision-synthetic',
      decision_hash: 'c'.repeat(64),
      planning_date_local: '2026-08-08',
      athlete_state_revision: 3,
      evidence_snapshot_id: 'snapshot-synthetic',
      phase: 'DEVELOPMENT',
      recovery_state: 'NORMAL',
      candidate_ids: ['candidate-a', 'candidate-b'],
      selected_candidate_id: 'candidate-a',
      selected_candidate_ranking_tuple: { due_primary_exposures_satisfied: 1 },
      rejected_candidates: [{ candidate_id: 'candidate-b', reason_codes: ['FULL_REST'] }],
      validator_results: [{ candidate_id: 'candidate-b', valid: false, reason_codes: ['FULL_REST'] }],
      candidate_enumeration: { retained_count: 2, truncation_reason: null },
    },
    athleteState: { athlete_state_revision: 3, safety_action: 'NORMAL' },
    candidates: [
      { candidate_skeleton_id: 'candidate-a', candidate_hash: 'a'.repeat(64), validation: { valid: true, validator_results: [], reason_codes: [] }, ranking_tuple: { due_primary_exposures_satisfied: 1 } },
      { candidate_skeleton_id: 'candidate-b', candidate_hash: 'b'.repeat(64), validation: { valid: false, validator_results: [], reason_codes: ['FULL_REST'] }, ranking_tuple: { due_primary_exposures_satisfied: 0 } },
    ],
  });
  assert.equal(decisionArtifacts.length, 7);
  assert.equal(decisionArtifacts[0].parent_artifact_id, null);
  assert.equal(decisionArtifacts.slice(1).every((artifact, index) => artifact.parent_artifact_id === decisionArtifacts[index].id), true);
  assert.equal(decisionArtifacts.slice(3).every((artifact) => artifact.plan_generation_candidate_id === 'candidate-current'), true);
  const secondCandidateArtifacts = candidateLifecycle.buildGoalBackwardDecisionArtifacts({
    userId: ownerId,
    planGenerationCandidateId: 'candidate-second',
    currentCandidateHash: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-08-08T12:00:00.000Z',
    decision: {
      decision_id: 'decision-synthetic',
      decision_hash: 'c'.repeat(64),
      planning_date_local: '2026-08-08',
      athlete_state_revision: 3,
      evidence_snapshot_id: 'snapshot-synthetic',
      phase: 'DEVELOPMENT',
      recovery_state: 'NORMAL',
      candidate_ids: ['candidate-a', 'candidate-b'],
      selected_candidate_id: 'candidate-a',
      selected_candidate_ranking_tuple: { due_primary_exposures_satisfied: 1 },
      rejected_candidates: [{ candidate_id: 'candidate-b', reason_codes: ['FULL_REST'] }],
      validator_results: [{ candidate_id: 'candidate-b', valid: false, reason_codes: ['FULL_REST'] }],
      candidate_enumeration: { retained_count: 2, truncation_reason: null },
    },
    candidates: decisionArtifacts.length ? [{
      candidate_skeleton_id: 'candidate-a',
      candidate_hash: 'a'.repeat(64),
      validation: { valid: true, reason_codes: [] },
      ranking_tuple: { due_primary_exposures_satisfied: 1 },
    }] : [],
  });
  assert.deepEqual(
    secondCandidateArtifacts.slice(0, 3).map((artifact) => artifact.id),
    decisionArtifacts.slice(0, 3).map((artifact) => artifact.id),
    'decision-stage artifacts are safely reusable for the same immutable decision',
  );
  assert.equal(
    secondCandidateArtifacts.slice(3).every((artifact, index) => artifact.id !== decisionArtifacts[index + 3].id),
    true,
    'candidate-stage artifacts remain linked uniquely to each current preview row',
  );
  const linkedBundle = candidateLifecycle.validateGoalBackwardCandidateBundle({
    plan,
    snapshot,
    trace: { reason_codes: [] },
    bindings,
    artifacts: decisionArtifacts,
  });
  assert.deepEqual(linkedBundle.artifacts, decisionArtifacts);
  const artifactWrites = [];
  const persistedArtifacts = await candidateLifecycle.persistGoalBackwardDecisionArtifacts({
    tx: {
      run: async (sql, params) => {
        artifactWrites.push({ sql, params });
        return { changes: 1 };
      },
    },
    artifacts: decisionArtifacts,
  });
  assert.deepEqual(persistedArtifacts, {
    inserted: 7,
    artifact_ids: decisionArtifacts.map((artifact) => artifact.id),
  });
  assert.equal(artifactWrites.length, 7);
  assert.equal(artifactWrites.every((write) => write.sql.includes('INSERT INTO planning_pipeline_artifacts')), true);

  const assignedLineage = plansRouter._test.replacementLineageForActivePlan({
    source: 'assigned',
    row: { user_plan_id: 'up-current', lineage_id: 'lineage-current', plan_version: 4 },
  }, 'up-next');
  assert.deepEqual(assignedLineage, {
    lineageId: 'lineage-current',
    priorVersion: 4,
    supersedesUserPlanId: 'up-current',
  });
  const legacyLineage = plansRouter._test.replacementLineageForActivePlan({
    source: 'legacy',
    row: { id: 'legacy-training-plan' },
  }, 'up-next');
  assert.deepEqual(legacyLineage, {
    lineageId: 'up-next',
    priorVersion: 0,
    supersedesUserPlanId: null,
  }, 'legacy plans create a first assignment instead of superseding an undefined assignment');

  assert.equal(
    plansRouter._test.assertCandidatePlanningDateCurrent(
      { planning_date_local: '2026-08-08', timezone_offset_minutes: 0 },
      new Date('2026-08-08T23:59:59.000Z')
    ),
    '2026-08-08'
  );
  assert.throws(
    () => plansRouter._test.assertCandidatePlanningDateCurrent(
      { planning_date_local: '2026-08-08', timezone_offset_minutes: 0 },
      new Date('2026-08-09T00:00:01.000Z')
    ),
    (error) => error?.code === 'CANDIDATE_PLANNING_DATE_CHANGED' && error?.status === 409,
    'candidate application fails closed when the tester local date crosses midnight'
  );
  assert.equal(plansRouter._test.candidateFeasibilityCanApply({ overall_feasibility: 'supported' }), true);
  assert.equal(plansRouter._test.candidateFeasibilityCanApply({ overall_feasibility: 'stretch' }), true);
  assert.equal(plansRouter._test.candidateFeasibilityCanApply({ overall_feasibility: 'not_applicable', goals: [] }), true);
  assert.equal(
    plansRouter._test.candidateFeasibilityCanApply({ overall_feasibility: 'not_applicable', goals: [{ date: '2026-10-11' }] }),
    false,
    'dated race candidates cannot bypass feasibility through not_applicable'
  );
  assert.equal(plansRouter._test.candidateFeasibilityCanApply({ overall_feasibility: '' }), false);
  assert.equal(
    plansRouter._test.getTimezoneOffsetFromRequest({ body: {}, headers: {} }),
    undefined,
    'a missing timezone header is not silently converted to UTC'
  );
  await assert.rejects(
    plansRouter._test.previewPlanForUser(ownerId, {
      planning_date_local: new Date().toISOString().slice(0, 10),
      race_ids: [],
    }),
    (error) => error?.code === 'INVALID_TIMEZONE_OFFSET' && error?.status === 400,
    'candidate preview rejects clients without explicit phone timezone authority'
  );

  const pruneCalls = [];
  await plansRouter._test.pruneExpiredPlanCandidates({
    run: async (sql, params) => {
      pruneCalls.push({ sql, params });
      return { changes: 1 };
    },
  }, ownerId, { excludeCandidateId: 'candidate-current', now: new Date('2026-08-08T12:00:00.000Z') });
  assert.match(pruneCalls[0].sql, /DELETE FROM plan_generation_candidates WHERE user_id=\? AND expires_at<\? AND id<>\?/);
  assert.deepEqual(pruneCalls[0].params, [ownerId, '2026-08-07T12:00:00.000Z', 'candidate-current']);

  const source = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
  assert.match(source, /validateStoredGoalBackwardCandidateBindings\(row\)/);
  assert.match(source, /SELECT \* FROM plan_generation_candidates WHERE id=\? AND user_id=\? FOR UPDATE/);
  assert.match(source, /WHERE id=\? AND user_id=\? AND status='preview'/);
  assert.match(source, /WHERE id=\? AND user_id=\? AND status='active'/);
  assert.equal(
    plansRouter._test.candidateEffectiveFrom({ source: 'assigned' }, '2026-08-08'),
    '2026-08-09',
    'a generic assigned-plan cutover still protects the current calendar day',
  );
  assert.equal(
    plansRouter._test.candidateEffectiveFrom({ source: 'assigned' }, '2026-08-08', { immediate: true }),
    '2026-08-08',
    'an explicitly accepted candidate starts on its reviewed planning date',
  );
  assert.equal(plansRouter._test.candidateEffectiveFrom({ source: 'legacy' }, '2026-08-08'), '2026-08-08');
  assert.match(source, /candidateEffectiveFrom\(active, row\.planning_date_local, \{ immediate: true \}\)/);
  assert.match(source, /row\.status === 'applied'/);
  assert.match(source, /CANDIDATE_DETERMINISM_MISMATCH/);
  assert.match(source, /storedFeasibility === 'unsafe'[\s\S]*CANDIDATE_UNSAFE/);
  assert.match(source, /!candidateFeasibilityCanApply\(storedPlan\)[\s\S]*CANDIDATE_FEASIBILITY_MISSING/);
  assert.match(source, /includeFuture: true/);
  assert.doesNotMatch(source, /function persistConcurrentPlan\(/, 'obsolete direct plan persistence cannot bypass candidate lineage');
  const writeBoundaryGuard = source.lastIndexOf('assertCandidatePlanningDateCurrent(row);');
  const firstPlanWrite = source.indexOf("'UPDATE users SET run_days_per_week=?", writeBoundaryGuard);
  assert.ok(writeBoundaryGuard > 0 && firstPlanWrite > writeBoundaryGuard, 'the local-date guard runs inside apply immediately before plan writes');

  const currentResponse = { candidate_id: 'current-candidate', plan: { byte_compatible: true } };
  let shadowComputations = 0;
  const offResponse = await plansRouter._test.maybeComputeGoalBackwardShadowDiagnostics({
    mode: 'off',
    response: currentResponse,
    compute: async () => { shadowComputations += 1; },
  });
  const shadowResponse = await plansRouter._test.maybeComputeGoalBackwardShadowDiagnostics({
    mode: 'shadow',
    response: currentResponse,
    compute: async () => { shadowComputations += 1; },
  });
  assert.strictEqual(offResponse, currentResponse);
  assert.strictEqual(shadowResponse, currentResponse);
  assert.equal(JSON.stringify(shadowResponse), JSON.stringify(offResponse), 'shadow returns current candidate bytes unchanged');
  assert.equal(shadowComputations, 1, 'only shadow computes bounded v2.4 diagnostics');

  const computedShadow = plansRouter._test.computeGoalBackwardShadowDiagnostics({
    userId: ownerId,
    planningDateLocal: '2026-08-08',
    state: {
      active: null,
      activePlan: null,
      context: {
        profile: {},
        history: { recentRunCount: 0, weeklyMileageBaseline: 0 },
        recovery: { state: 'normal' },
        safety: {},
      },
      inputHash: `sha256:${'d'.repeat(64)}`,
      planningInputRevision: 1,
      races: [],
      target: { trainingDays: ['Fri', 'Sun'] },
    },
    built: {
      plan: {
        weeks: [{ days: [{
          date: '2026-08-08',
          sessions: [{ id: 'current-easy', kind: 'run', workout_id: 'easy_aerobic', duration_min: 30, distance_miles: 3 }],
        }] }],
      },
    },
  });
  assert.ok(computedShadow.candidates.length > 0 && computedShadow.candidates.length <= 64);
  assert.equal(computedShadow.decision.candidate_ids.length, computedShadow.candidates.length);
  assert.match(computedShadow.selected_candidate.candidate_hash, /^[a-f0-9]{64}$/);

  console.log('PLAN CANDIDATE LIFECYCLE SMOKE OK (63)');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
