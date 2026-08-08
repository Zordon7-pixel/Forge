const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assignmentLifecycle = require('../src/lib/planAssignmentLifecycle');
const candidateLifecycle = require('../src/lib/planCandidateLifecycle');
const plansRouter = require('../src/routes/plans');

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
  assert.match(source, /SELECT \* FROM plan_generation_candidates WHERE id=\? AND user_id=\? FOR UPDATE/);
  assert.match(source, /WHERE id=\? AND user_id=\? AND status='preview'/);
  assert.match(source, /WHERE id=\? AND user_id=\? AND status='active'/);
  assert.equal(plansRouter._test.candidateEffectiveFrom({ source: 'assigned' }, '2026-08-08'), '2026-08-09');
  assert.equal(plansRouter._test.candidateEffectiveFrom({ source: 'legacy' }, '2026-08-08'), '2026-08-08');
  assert.match(source, /candidateEffectiveFrom\(active, row\.planning_date_local\)/);
  assert.match(source, /row\.status === 'applied'/);
  assert.match(source, /CANDIDATE_DETERMINISM_MISMATCH/);
  assert.match(source, /storedFeasibility === 'unsafe'[\s\S]*CANDIDATE_UNSAFE/);
  assert.match(source, /!candidateFeasibilityCanApply\(storedPlan\)[\s\S]*CANDIDATE_FEASIBILITY_MISSING/);
  assert.match(source, /includeFuture: true/);
  const writeBoundaryGuard = source.lastIndexOf('assertCandidatePlanningDateCurrent(row);');
  const firstPlanWrite = source.indexOf("'UPDATE users SET run_days_per_week=?", writeBoundaryGuard);
  assert.ok(writeBoundaryGuard > 0 && firstPlanWrite > writeBoundaryGuard, 'the local-date guard runs inside apply immediately before plan writes');

  console.log('PLAN CANDIDATE LIFECYCLE SMOKE OK (45)');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
