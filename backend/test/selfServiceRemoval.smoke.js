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
  const filtered = planSchema.withoutRemovedSessions(source, ['lift-removed']);
  assert.deepEqual(filtered.weeks[0].days[0].sessions.map((session) => session.id), ['run-kept']);
  assert.equal(source.weeks[0].days[0].sessions.length, 2, 'immutable source plan is preserved');
  assert.strictEqual(planSchema.withoutRemovedSessions(source, []), source, 'empty removal set preserves identity');
}

function assertRaceOwnershipRouteContract() {
  const races = fs.readFileSync(path.join(__dirname, '../src/routes/races.js'), 'utf8');
  const plans = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
  assert.match(races, /router\.post\('\/:id\/removal-apply', auth, async/);
  assert.doesNotMatch(races, /router\.post\('\/:id\/removal-apply', auth, requirePremium/);
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
        ] },
      ],
    }],
  };
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
          plan_data: plan,
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
      dbGet: async () => null,
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

    let response = await invoke('today-lift');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.removedSessionIds, ['today-lift']);
    assert.equal(updateCount, 1);
    assert.deepEqual(JSON.parse(assignment.progress_json).removedSessionIds, ['today-lift']);

    response = await invoke('today-lift');
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.idempotent, true);
    assert.equal(updateCount, 1, 'idempotent replay does not write again');

    reset({ completedSessionIds: ['today-run'] });
    response = await invoke('today-run');
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED');
    assert.equal(updateCount, 0);

    reset();
    response = await invoke('past-run');
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_IN_PAST');
    assert.equal(updateCount, 0);

    response = await invoke('foreign-session');
    assert.equal(response.statusCode, 404);
    assert.equal(response.payload.code, 'PLAN_SESSION_NOT_FOUND');
    assert.equal(updateCount, 0);
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlans) require.cache[plansRoutePath] = originalPlans;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

async function run() {
  assertFilteringContract();
  assertRaceOwnershipRouteContract();
  await assertScheduledWorkoutRoute();
  console.log('SELF-SERVICE REMOVAL BACKEND SMOKE OK');
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { run };
