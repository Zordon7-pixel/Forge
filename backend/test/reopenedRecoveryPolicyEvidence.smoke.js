#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLANNING_DATE = '2026-08-30';
const OWNER_ID = 'reopened-recovery-policy-owner';

function routeHandler(router, routePath, method) {
  return router.stack.find((layer) => (
    layer.route?.path === routePath && layer.route?.methods?.[method]
  ))?.route?.stack?.at(-1)?.handle;
}

function sourcePlan() {
  return {
    schemaVersion: 2,
    planMode: 'run_only',
    weeks: [{
      week: 1,
      phase: 'build',
      days: [{
        day: 'Sun',
        date: PLANNING_DATE,
        sessions: [{
          id: 'token-quality-run',
          kind: 'run',
          type: 'quality',
          workout_type: 'run',
          title: 'Quality run',
          intensity: 'Hard',
          target_zone: 'Zone 4',
          duration_min: 16,
          distance_miles: 1.1,
        }],
      }],
    }],
  };
}

function liftOnlyPlan() {
  return {
    schemaVersion: 2,
    planMode: 'hybrid_maintain',
    weeks: [{
      week: 1,
      phase: 'build',
      days: [{
        day: 'Sun',
        date: PLANNING_DATE,
        sessions: [{
          id: 'source-bound-lift',
          kind: 'lift',
          type: 'strength',
          workout_type: 'strength',
          title: 'Strength maintenance',
          focus: 'full body',
        }],
      }],
    }],
  };
}

function hybridRunLiftPlan() {
  const plan = sourcePlan();
  plan.planMode = 'hybrid_maintain';
  plan.weeks[0].days[0].sessions.push({
    id: 'source-bound-lift',
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: 'Strength maintenance',
    focus: 'full body',
  });
  return plan;
}

function assignmentRow(plan, suffix) {
  return {
    id: `reopened-plan-${suffix}`,
    plan_id: `reopened-plan-${suffix}`,
    user_plan_id: `reopened-assignment-${suffix}`,
    status: 'active',
    current_week: 1,
    started_at: PLANNING_DATE,
    effective_from: PLANNING_DATE,
    progress_json: '{}',
    plan_data: JSON.stringify(plan),
  };
}

async function main() {
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'FORGE-RACE-TRAVEL-ADAPTATION-SPEC.md'), 'utf8');
  assert.match(spec, /fallback recovery run is conservative: 20 minutes, at most 2 miles, Zone 1[–-]2, fully conversational, walking allowed/i);
  assert.match(spec, /Do not offer an extra run just because a lift exists/i);

  const adaptation = require('../src/lib/adaptationEngine');
  const unchanged = adaptation.buildAdaptationProposal({
    plan: sourcePlan(),
    planningDateISO: PLANNING_DATE,
    planVersion: 'reopened-policy-v1',
  });
  assert.equal(unchanged.status, 'keep', 'no fresh objective driver means no proposal');
  assert.deepEqual(unchanged.changes, []);
  assert.deepEqual(unchanged.proposedPlan, sourcePlan(), 'absence of objective evidence preserves the accepted plan byte-for-byte');

  const objectiveRecovery = adaptation.buildAdaptationProposal({
    plan: sourcePlan(),
    planningDateISO: PLANNING_DATE,
    planVersion: 'reopened-policy-v1',
    completion: { missedWorkouts: 2, missedRuns: 1, freshness: 'recent' },
  });
  assert.equal(objectiveRecovery.status, 'proposal');
  const alternative = objectiveRecovery.changes[0]?.after;
  assert.equal(alternative?.title, 'Rest, easy walking, or mobility');
  assert.equal(alternative?.distance_miles, 0);
  assert.equal(alternative?.recovery_alternative?.reduced_run_minutes, 11);
  assert.equal(alternative?.recovery_alternative?.reduced_run_miles, 0.8);
  assert.equal(alternative?.recovery_alternative?.minimum_run_minutes, 20);
  assert.equal(alternative?.recovery_alternative?.minimum_run_miles, 1.5);
  assert.match(alternative?.description || '', /missed-session history/i);
  assert.deepEqual(
    alternative?.recovery_alternative?.options?.map((option) => option.type),
    ['rest', 'walking', 'mobility'],
  );

  const hybridObjectiveRecovery = adaptation.buildAdaptationProposal({
    plan: hybridRunLiftPlan(),
    planningDateISO: PLANNING_DATE,
    planVersion: 'reopened-policy-hybrid-v1',
    completion: { missedWorkouts: 2, missedRuns: 1, freshness: 'recent' },
  });
  assert.equal(hybridObjectiveRecovery.status, 'proposal');
  const hybridRecoveryDay = hybridObjectiveRecovery.proposedPlan.weeks[0].days[0];
  assert.deepEqual(
    hybridRecoveryDay.sessions.map((session) => session.kind),
    ['rest', 'lift'],
    'the run alternative does not remove its independently prescribed lift sibling',
  );
  const hybridExecutionUnit = require('../src/lib/dailyExecution').buildDailyExecution({
    plan: hybridObjectiveRecovery.proposedPlan,
    dateISO: PLANNING_DATE,
    selectedEntry: hybridRecoveryDay,
    selectedWeek: hybridObjectiveRecovery.proposedPlan.weeks[0],
    selectedDayIndex: 0,
    completedSessionIds: [],
    hrProfile: null,
    restSource: null,
  });
  assert.equal(hybridExecutionUnit.isRest, false);
  assert.deepEqual(hybridExecutionUnit.sessions.map((session) => session.id), ['source-bound-lift']);
  assert.equal(hybridExecutionUnit.lift?.id, 'source-bound-lift');
  assert.equal(hybridExecutionUnit.recoveryGuidance, undefined, 'non-executable run guidance cannot override a visible lift sibling');

  const dbPath = require.resolve('../src/db');
  const plansPath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbPath];
  const originalPlans = require.cache[plansPath];
  const RealDate = Date;
  const fixedNow = new RealDate('2026-08-30T16:00:00.000Z').getTime();
  let activeRow = assignmentRow(liftOnlyPlan(), 'lift-only');
  const reads = [];

  global.Date = class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() { return fixedNow; }
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      async dbGet(sql, params = []) {
        reads.push({ sql, params });
        assert.equal(params.includes(OWNER_ID), true, 'every exported route read remains owner-scoped');
        if (/FROM user_plans up[\s\S]*JOIN training_plans tp/.test(sql)) return { ...activeRow };
        if (/FROM user_hr_profile/.test(sql)) return null;
        throw new Error(`unexpected exported-route read: ${sql}`);
      },
      async dbAll() { return []; },
      async dbRun() { return { changes: 0 }; },
      async withPlanningInputMutation(_userId, callback) { return callback(this); },
      async withUserMutation(_userId, callback) { return callback(this); },
    },
    children: [],
    paths: [],
  };
  delete require.cache[plansPath];

  async function readToday(handler) {
    let statusCode = 200;
    let payload;
    await handler({
      user: { id: OWNER_ID },
      body: {},
      query: { date: PLANNING_DATE },
      headers: { 'x-forged-local-date': PLANNING_DATE },
    }, {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    });
    assert.equal(statusCode, 200);
    return payload;
  }

  try {
    const plansRouter = require('../src/routes/plans');
    const handler = routeHandler(plansRouter, '/today', 'get');
    assert.equal(typeof handler, 'function');

    const liftOnly = await readToday(handler);
    assert.equal(liftOnly.execution.hasDay, true);
    assert.equal(liftOnly.execution.isRest, false, 'a source-bound lift-only day is not relabeled as recovery');
    assert.equal(liftOnly.execution.run, null, 'a lift-only day never fabricates a run');
    assert.equal(liftOnly.execution.lift?.id, 'source-bound-lift');
    assert.equal(liftOnly.execution.recoveryGuidance, undefined, 'no objective recovery proposal means no generated recovery choice');

    activeRow = assignmentRow(hybridObjectiveRecovery.proposedPlan, 'hybrid-objective-recovery');
    const hybridRecovery = await readToday(handler);
    assert.equal(hybridRecovery.execution.hasDay, true);
    assert.equal(hybridRecovery.execution.isRest, false, 'a surviving lift keeps the hybrid day executable');
    assert.deepEqual(hybridRecovery.execution.sessions.map((session) => session.id), ['source-bound-lift']);
    assert.equal(hybridRecovery.execution.run, null);
    assert.equal(hybridRecovery.execution.lift?.id, 'source-bound-lift');
    assert.equal(hybridRecovery.execution.recoveryGuidance, undefined, 'the exported route does not emit terminal recovery guidance beside an executable lift');

    activeRow = assignmentRow(objectiveRecovery.proposedPlan, 'objective-recovery');
    const recovery = await readToday(handler);
    assert.equal(recovery.execution.hasDay, true);
    assert.equal(recovery.execution.isRest, true);
    assert.equal(recovery.execution.isPlannedRest, true);
    assert.deepEqual(recovery.execution.sessions, [], 'the explicit alternative is guidance, never an executable workout');
    assert.equal(recovery.execution.run, null);
    assert.equal(recovery.execution.lift, null);
    assert.equal(recovery.execution.recoveryGuidance?.title, 'Rest, easy walking, or mobility');
    assert.equal(recovery.execution.recoveryGuidance?.distance_miles, 0);
    assert.match(recovery.execution.recoveryGuidance?.description || '', /missed-session history/i);
    assert.deepEqual(
      recovery.execution.recoveryGuidance?.recovery_alternative?.options?.map((option) => option.type),
      ['rest', 'walking', 'mobility'],
    );
    assert.equal(reads.length, 6, 'each exact route read resolves one assignment and one optional HR profile');
  } finally {
    global.Date = RealDate;
    delete require.cache[plansPath];
    if (originalPlans) require.cache[plansPath] = originalPlans;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }

  console.log('REOPENED RECOVERY POLICY EVIDENCE SMOKE OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
