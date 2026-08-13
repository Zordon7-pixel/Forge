#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const planSchema = require('../src/lib/planSchema');

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function assertFilteringContract() {
  const source = {
    schemaVersion: 2,
    weeks: [{ days: [{
      date: localDate(1),
      day: 'Thu',
      sessions: [
        { id: 'run-kept', kind: 'run' },
        { id: 'lift-removed', kind: 'lift' },
      ],
    }] }],
  };
  const identified = planSchema.withRemovalSessionIdentities(source);
  const removalId = identified.weeks[0].days[0].sessions[1].removal_session_id;
  const filtered = planSchema.withoutRemovedSessions(identified, [removalId]);
  assert.deepEqual(filtered.weeks[0].days[0].sessions.map((session) => session.id), ['run-kept']);
  assert.equal(source.weeks[0].days[0].sessions.length, 2, 'immutable source plan is preserved');
  assert.strictEqual(planSchema.withoutRemovedSessions(source, []), source, 'empty removal set preserves identity');
}

function assertStoredCompletionContract() {
  assert.equal(planSchema.isStoredSessionCompleted({}, { kind: 'lift', completed: true }), true);
  assert.equal(planSchema.isStoredSessionCompleted({}, { kind: 'lift', status: 'completed' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ status: 'completed' }, { kind: 'lift' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ completed: true }, { kind: 'lift' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ status: 'planned' }, { kind: 'lift' }), false);
}

function assertRemovalIdentityContract() {
  const legacy = {
    startDate: '2026-07-13',
    weeks: [
      { sessions: [{ day: 'Mon', type: 'run', title: 'Week one' }] },
      { sessions: [{ day: 'Mon', type: 'run', title: 'Week two' }] },
    ],
  };
  const identified = planSchema.withRemovalSessionIdentities(legacy);
  const weekOneId = identified.weeks[0].sessions[0].removal_session_id;
  const weekTwoId = identified.weeks[1].sessions[0].removal_session_id;
  assert.match(weekOneId, /^remove:v1:2026-07-13:/);
  assert.match(weekTwoId, /^remove:v1:2026-07-20:/);
  assert.notEqual(weekOneId, weekTwoId, 'legacy no-ID sessions in different weeks never collide');
  const filtered = planSchema.withoutRemovedSessions(identified, [weekTwoId]);
  assert.equal(filtered.weeks[0].sessions[0].title, 'Week one');
  assert.equal(filtered.weeks[1].sessions[0].status, 'removed');

  const assignmentAnchored = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{ day: 'Wed', sessions: [{ kind: 'lift', title: 'Anchored lift' }] }] }],
  }, { assignmentStart: '2026-07-13' });
  assert.equal(assignmentAnchored.weeks[0].days[0].date, '2026-07-15');
  assert.match(assignmentAnchored.weeks[0].days[0].sessions[0].removal_session_id, /^remove:v1:2026-07-15:/);

  const duplicate = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{
      date: '2026-07-13',
      day: 'Mon',
      sessions: [
        { id: 'duplicate', kind: 'run' },
        { id: 'duplicate', kind: 'run' },
      ],
    }] }],
  });
  assert.equal(duplicate.weeks[0].days[0].sessions[0].removal_session_id, undefined);
  assert.equal(duplicate.weeks[0].days[0].sessions[1].removal_session_id, undefined);

  const unanchored = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{ day: 'Wed', sessions: [{ id: 'unanchored', kind: 'lift' }] }] }],
  });
  assert.equal(unanchored.weeks[0].days[0].sessions[0].removal_session_id, undefined);
}

function assertRaceOwnershipRouteContract() {
  const races = fs.readFileSync(path.join(__dirname, '../src/routes/races.js'), 'utf8');
  const plans = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
  assert.match(races, /router\.post\('\/:id\/removal-apply', auth, async/);
  assert.doesNotMatch(races, /router\.post\('\/:id\/removal-apply', auth, requirePremium/);
  assert.doesNotMatch(races, /withRequestPlanningClock\(req, req\.body \|\| \{\}\)/,
    'race removal endpoints never forward an open-ended client body');
  assert.match(races, /planning_date_local: req\.body\?\.planning_date_local,[\s\S]*timezone_offset_minutes: req\.body\?\.timezone_offset_minutes/);
  assert.match(races, /requiredOperation:\s*'remove_race', requiredRaceId:/);
  assert.match(plans, /constraints\.requiredOperation[\s\S]*CANDIDATE_OPERATION_MISMATCH/);
  assert.match(plans, /constraints\.requiredRaceId[\s\S]*CANDIDATE_RACE_MISMATCH/);
}

async function assertScheduledWorkoutRoute() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlans = require.cache[plansRoutePath];

  const plan = {
    schemaVersion: 2,
    planMode: 'hybrid_maintain',
    weeks: [{
      week: 1,
      startDate: localDate(-1),
      days: [
        { date: localDate(-1), day: 'Tue', sessions: [{ id: 'past-run', kind: 'run', title: 'Past run' }] },
        { date: localDate(0), day: 'Wed', sessions: [
          { id: 'today-run', kind: 'run', title: 'Today run' },
          { id: 'today-lift', kind: 'lift', title: 'Today lift' },
          { id: 'stored-flag-complete', kind: 'lift', title: 'Stored flag', completed: true },
          { id: 'stored-status-complete', kind: 'lift', title: 'Stored status', status: 'completed' },
        ] },
        { date: localDate(1), day: 'Thu', status: 'completed', sessions: [
          { id: 'completed-day-lift', kind: 'lift', title: 'Completed day lift' },
        ] },
      ],
    }],
  };
  let activePlan = plan;
  let assignment;
  let updateCount = 0;
  const reset = (progress = {}) => {
    assignment = {
      user_plan_id: 'assignment-owner',
      plan_id: 'plan-owner',
      current_week: 1,
      started_at: localDate(-1),
      status: 'active',
      progress_json: JSON.stringify(progress),
      plan_version: 1,
      lineage_id: 'lineage-owner',
      supersedes_user_plan_id: null,
      effective_from: localDate(-1),
    };
    updateCount = 0;
  };
  reset();

  const tx = {
    async get(sql) {
      if (/FROM user_plans up/.test(sql)) return assignment;
      if (/FROM training_plans tp/.test(sql)) {
        return {
          id: 'plan-owner',
          user_id: 'owner',
          name: 'Owner plan',
          type: 'hybrid_maintain',
          weeks: 1,
          plan_data: activePlan,
          plan_json: null,
        };
      }
      throw new Error(`unexpected get: ${sql}`);
    },
    async run(sql, params) {
      if (/UPDATE user_plans SET progress_json/.test(sql)) {
        assert.equal(params[1], 'assignment-owner');
        assert.equal(params[2], 'owner');
        assignment.progress_json = params[0];
        updateCount += 1;
        return { changes: 1 };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
  };
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      dbGet: async (sql) => {
        if (/FROM user_plans up/.test(sql) && /JOIN training_plans tp/.test(sql)) {
          return {
            ...assignment,
            id: 'plan-owner',
            user_id: 'owner',
            name: 'Owner plan',
            type: 'hybrid_maintain',
            weeks: activePlan.weeks.length,
            plan_data: activePlan,
            plan_json: null,
          };
        }
        if (/FROM training_plans WHERE user_id/.test(sql)) return null;
        return null;
      },
      dbAll: async () => [],
      dbRun: async () => ({ changes: 0 }),
      withUserMutation: async (_userId, fn) => fn(tx),
      withPlanningInputMutation: async (_userId, fn) => {
        const result = await fn(tx);
        return result && Object.prototype.hasOwnProperty.call(result, 'marker') ? result.value : result;
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const layer = plansRouter.stack.find((item) => item.route?.path === '/my/sessions/:sessionId' && item.route?.methods?.delete);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function');

    const invoke = async (sessionId) => {
      let statusCode = 200;
      let payload = null;
      const response = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await handler({ params: { sessionId }, user: { id: 'owner' }, body: {}, headers: { 'x-forged-local-date': localDate(0) } }, response);
      return { statusCode, payload };
    };

    const identified = planSchema.withRemovalSessionIdentities(plan, { assignmentStart: localDate(-1) });
    const sessionRemovalId = (sessionId) => identified.weeks
      .flatMap((week) => week.days)
      .flatMap((day) => day.sessions)
      .find((session) => session.id === sessionId)?.removal_session_id;
    const todayLiftRemovalId = sessionRemovalId('today-lift');
    const todayRunRemovalId = sessionRemovalId('today-run');
    const pastRunRemovalId = sessionRemovalId('past-run');
    const storedFlagRemovalId = sessionRemovalId('stored-flag-complete');
    const storedStatusRemovalId = sessionRemovalId('stored-status-complete');
    const completedDayRemovalId = sessionRemovalId('completed-day-lift');

    const raceRequest = plansRouter._test.raceRemovalCandidateRequest('server-race', ['server-remaining'], {
      planning_date_local: localDate(0),
      timezone_offset_minutes: 240,
      target: { raceDate: '2099-01-01', runDaysPerWeek: 7 },
      operation: 'plan_preview',
      remove_race_id: 'attacker-race',
      race_ids: ['attacker-race'],
    });
    assert.deepEqual(raceRequest, {
      planning_date_local: localDate(0),
      timezone_offset_minutes: 240,
      operation: 'remove_race',
      remove_race_id: 'server-race',
      race_ids: ['server-remaining'],
    }, 'race removal preview admits only planning clock and server-derived race inputs');

    let response = await invoke(todayLiftRemovalId);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.removedSessionIds, [todayLiftRemovalId]);
    assert.equal(updateCount, 1);
    assert.deepEqual(JSON.parse(assignment.progress_json).removedSessionIds, [todayLiftRemovalId]);

    response = await invoke(todayLiftRemovalId);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.idempotent, true);
    assert.equal(updateCount, 1, 'idempotent replay does not write again');

    reset({ completedSessionIds: ['today-run'] });
    response = await invoke(todayRunRemovalId);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED');
    assert.equal(updateCount, 0);

    for (const storedRemovalId of [storedFlagRemovalId, storedStatusRemovalId, completedDayRemovalId]) {
      reset();
      response = await invoke(storedRemovalId);
      assert.equal(response.statusCode, 409);
      assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED');
      assert.equal(updateCount, 0);
    }

    reset();
    response = await invoke(pastRunRemovalId);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_IN_PAST');
    assert.equal(updateCount, 0);

    response = await invoke('remove:v1:2099-01-01:id%3Aforeign-session');
    assert.equal(response.statusCode, 404);
    assert.equal(response.payload.code, 'PLAN_SESSION_NOT_FOUND');
    assert.equal(updateCount, 0);

    const hybridPlan = {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      weeks: [{
        week: 1,
        startDate: localDate(-1),
        days: [
          { date: localDate(-1), day: 'Tue', sessions: [
            { id: 'paired-run', kind: 'run', title: 'Paired run' },
            { id: 'paired-lift', kind: 'lift', title: 'Paired lift' },
          ] },
          { date: localDate(1), day: 'Thu', sessions: [{ id: 'future-rest', kind: 'rest' }] },
        ],
      }],
    };
    activePlan = hybridPlan;
    const identifiedHybrid = planSchema.withRemovalSessionIdentities(hybridPlan, { assignmentStart: localDate(-1) });
    const pairedDay = identifiedHybrid.weeks[0].days[0];
    const pairedRunId = planSchema.sessionIdentifier(pairedDay, pairedDay.sessions[0], 0, 0);
    const pairedLiftId = planSchema.sessionIdentifier(pairedDay, pairedDay.sessions[1], 1, 0);
    const pairedLiftRemovalId = pairedDay.sessions[1].removal_session_id;
    reset({ completedSessionIds: [pairedRunId], removedSessionIds: [pairedLiftRemovalId] });

    const currentLayer = plansRouter.stack.find((item) => item.route?.path === '/reconciliation/current' && item.route?.methods?.get);
    const currentHandler = currentLayer?.route?.stack?.at(-1)?.handle;
    const respondLayer = plansRouter.stack.find((item) => item.route?.path === '/reconciliation/respond' && item.route?.methods?.post);
    const respondHandler = respondLayer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof currentHandler, 'function');
    assert.equal(typeof respondHandler, 'function');

    const invokeHandler = async (routeHandler, request) => {
      let statusCode = 200;
      let payload = null;
      const routeResponse = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await routeHandler({ user: { id: 'owner' }, headers: {}, query: {}, body: {}, ...request }, routeResponse);
      return { statusCode, payload };
    };

    response = await invokeHandler(currentHandler, {
      query: { date: localDate(0), hour: 21, timezone: 'UTC' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.reconciliation, null, 'removed lift cannot create a hybrid prompt');

    response = await invokeHandler(respondHandler, {
      body: {
        current_date: localDate(0),
        session_date: localDate(-1),
        lift_session_id: pairedLiftId,
        response: 'life_event',
        timezone: 'UTC',
      },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /planned hybrid session changed/i);
    assert.equal(updateCount, 0, 'crafted response cannot move or update a removed lift');
    const servedAgain = planSchema.withoutRemovedSessions(identifiedHybrid, [pairedLiftRemovalId]);
    assert.deepEqual(servedAgain.weeks[0].days[0].sessions.map((session) => session.id), ['paired-run'],
      'refetch remains filtered after rejected reconciliation');
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlans) require.cache[plansRoutePath] = originalPlans;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

async function run() {
  assertFilteringContract();
  assertStoredCompletionContract();
  assertRemovalIdentityContract();
  assertRaceOwnershipRouteContract();
  await assertScheduledWorkoutRoute();
  console.log('SELF-SERVICE REMOVAL BACKEND SMOKE OK');
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { run };
