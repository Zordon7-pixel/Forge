#!/usr/bin/env node

const assert = require('node:assert/strict');

async function run() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const ownerId = 'low-sleep-route-owner';
  let planRow = {
    user_plan_id: 'up-low-sleep',
    plan_id: 'tp-low-sleep',
    id: 'tp-low-sleep',
    status: 'active',
    started_at: date,
    effective_from: date,
    progress_json: '{}',
    plan_data: JSON.stringify({
      schemaVersion: 2,
      weeks: [{ week: 1, days: [{
        date,
        day: 'Thu',
        sessions: [{ id: 'low-sleep-run', kind: 'run', type: 'easy_run', duration_minutes: 40 }],
      }] }],
    }),
  };
  let healthRow = null;
  let reads = [];
  let writes = [];
  let mutationOwnerId = null;
  const tx = {
    async get(sql, params = []) {
      reads.push({ sql, params });
      if (/SELECT id FROM daily_checkins/.test(sql)) return null;
      if (/FROM health_sync/.test(sql)) return healthRow;
      if (/FROM user_plans up/.test(sql) && /JOIN training_plans tp/.test(sql)) return planRow;
      if (/FROM training_plans WHERE user_id/.test(sql)) return null;
      throw new Error(`unexpected get: ${sql}`);
    },
    async run(sql, params) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };

  const dbPath = require.resolve('../src/db');
  const routePath = require.resolve('../src/routes/checkin');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dbGet: tx.get,
      withUserMutation: async (userId, callback) => {
        mutationOwnerId = userId;
        return callback(tx);
      },
      withPlanningInputMutation: async () => {
        throw new Error('passive compatibility storage must not advance planning authority');
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/checkin');
    const layer = router.stack.find((item) => item.route?.path === '/' && item.route?.methods?.post);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function');
    let statusCode = 200;
    let payload;
    const response = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    };
    async function postCheckin(row, bodyOverrides = {}) {
      healthRow = row;
      reads = [];
      writes = [];
      mutationOwnerId = null;
      statusCode = 200;
      payload = undefined;
      await handler({
        user: { id: ownerId },
        body: {
          feeling: 5,
          legs: 3,
          drive: 3,
          time_available: 60,
          life_flags: [],
          date,
          ...bodyOverrides,
        },
        query: {},
        headers: { 'x-forged-local-date': date },
      }, response);
      assert.equal(statusCode, 200);
      return {
        payload,
        reads: [...reads],
        writes: [...writes],
        mutationOwnerId,
        savedCheckin: writes.find(({ sql }) => /INSERT INTO daily_checkins/.test(sql)),
      };
    }

    function assertPassiveCompatibilityWrite(result, label) {
      assert.equal(result.payload.action, 'keep', `${label} has no plan-mutation action`);
      assert.equal(result.payload.readiness_delta, 0, `${label} has no readiness authority`);
      assert.deepEqual(result.payload.drivers, [], `${label} supplies no plan-mutation drivers`);
      assert.equal(Object.hasOwn(result.payload, 'patch'), false, `${label} returns no executable patch`);
      assert.match(result.payload.adjustment, /unchanged/i, `${label} says the accepted training is unchanged`);
      assert.equal(result.mutationOwnerId, ownerId, `${label} uses the owner-scoped compatibility mutation`);

      const healthRead = result.reads.find(({ sql }) => /FROM health_sync/.test(sql));
      assert(healthRead, `${label} resolves compatibility sleep through the real route`);
      assert.match(healthRead.sql, /WHERE user_id=\?/, `${label} health lookup remains parameterized`);
      assert.deepEqual(healthRead.params, [ownerId], `${label} health lookup remains owner-scoped`);

      const checkinRead = result.reads.find(({ sql }) => /SELECT id FROM daily_checkins/.test(sql));
      assert(checkinRead, `${label} checks compatibility storage through the real route`);
      assert.match(
        checkinRead.sql,
        /WHERE user_id=\? AND checkin_date=\?/,
        `${label} compatibility lookup remains parameterized and owner-scoped`,
      );
      assert.deepEqual(checkinRead.params, [ownerId, date], `${label} binds owner and local date separately`);

      assert(result.savedCheckin, `${label} remains available for compatibility history/export`);
      assert.match(
        result.savedCheckin.sql,
        /INSERT INTO daily_checkins \(id, user_id, checkin_date,[\s\S]*VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?\)/,
        `${label} compatibility write remains parameterized`,
      );
      assert.equal(result.savedCheckin.params[1], ownerId, `${label} compatibility write remains owner-scoped`);
      assert.equal(result.savedCheckin.params[2], date, `${label} compatibility write binds the requested local date`);
      assert.equal(
        result.writes.some(({ sql }) => /checkin_overrides/i.test(sql)),
        false,
        `${label} never creates, updates, or deletes a legacy override`,
      );
      assert.equal(
        result.writes.some(({ sql }) => /(?:UPDATE|INSERT INTO)\s+(?:user_plans|training_plans)/i.test(sql)),
        false,
        `${label} never mutates the accepted plan`,
      );
    }

    const planSchema = require('../src/lib/planSchema');
    const dailyExecution = require('../src/lib/dailyExecution');
    function canonicalExecution() {
      const acceptedPlan = JSON.parse(planRow.plan_data);
      const resolved = dailyExecution.resolvePlanDayForDate({
        plan: acceptedPlan,
        dateISO: date,
      });
      return {
        resolved,
        execution: dailyExecution.buildDailyExecution({
          plan: acceptedPlan,
          dateISO: date,
          selectedEntry: resolved.selectedEntry,
          selectedWeek: resolved.selectedWeek,
          selectedDayIndex: resolved.selectedDayIndex,
          completedSessionIds: [],
        }),
      };
    }

    const lowSleep = await postCheckin({
      sleep_hours_last_night: 3.5,
      synced_at: new Date().toISOString(),
      training_metrics_json: '{}',
    });
    assertPassiveCompatibilityWrite(lowSleep, 'fresh synced 3.5-hour sleep');
    assert.equal(lowSleep.savedCheckin.params[7], 3.5, 'actual mobile POST handler persists the fresh synced sleep value');
    const lowSleepExecution = canonicalExecution();
    assert.equal(
      planSchema.daySessions(lowSleepExecution.resolved.selectedEntry)[0].type,
      'easy_run',
      'fresh synced low sleep leaves the accepted run prescription unchanged',
    );
    assert.equal(lowSleepExecution.execution.checkinOverride, null, 'fresh synced low sleep adds no execution override');
    assert.equal(lowSleepExecution.execution.run?.id, 'low-sleep-run', 'fresh synced low sleep preserves the canonical run identity');
    assert.equal(lowSleepExecution.execution.run?.type, 'easy_run', 'fresh synced low sleep preserves executable canonical training');

    const invalidSleepRows = [
      {
        label: 'missing health row',
        row: null,
      },
      {
        label: 'sleep-absent health row',
        row: { synced_at: new Date().toISOString(), training_metrics_json: '{}' },
      },
      {
        label: 'stale synced sleep',
        row: {
          sleep_hours_last_night: 7.5,
          synced_at: new Date(Date.now() - (40 * 60 * 60 * 1000)).toISOString(),
          training_metrics_json: '{}',
        },
      },
      {
        label: 'implausible synced sleep',
        row: {
          sleep_hours_last_night: 13,
          synced_at: new Date().toISOString(),
          training_metrics_json: '{}',
        },
      },
    ];

    for (const testCase of invalidSleepRows) {
      const result = await postCheckin(testCase.row);
      assertPassiveCompatibilityWrite(result, testCase.label);
      assert.equal(result.savedCheckin.params[7], null, `${testCase.label} persists unknown sleep as null, not zero`);
      const unchanged = canonicalExecution();
      assert.equal(unchanged.execution.checkinOverride, null, `${testCase.label} adds no execution override`);
      assert.equal(unchanged.execution.run?.type, 'easy_run', `${testCase.label} leaves the accepted run executable`);
    }

    const liftOnlyDay = {
      date,
      day: 'Thu',
      sessions: [{ id: 'low-sleep-lift', kind: 'lift', type: 'strength', title: 'Strength maintenance' }],
    };
    planRow = {
      ...planRow,
      plan_data: JSON.stringify({ schemaVersion: 2, weeks: [{ week: 1, days: [liftOnlyDay] }] }),
    };
    const liftSafetyCases = [
      { label: 'sick', row: null, body: { life_flags: ['sick'] } },
      { label: 'injured', row: null, body: { life_flags: ['injured'] } },
      {
        label: 'fresh 3.5-hour sleep',
        row: { sleep_hours_last_night: 3.5, synced_at: new Date().toISOString(), training_metrics_json: '{}' },
        body: {},
      },
    ];
    for (const testCase of liftSafetyCases) {
      const result = await postCheckin(testCase.row, testCase.body);
      assertPassiveCompatibilityWrite(result, `lift-only ${testCase.label}`);
      const unchanged = canonicalExecution();
      assert.equal(
        planSchema.daySessions(unchanged.resolved.selectedEntry)[0].type,
        'strength',
        `lift-only ${testCase.label} leaves the accepted lift prescription unchanged`,
      );
      assert.equal(unchanged.execution.checkinOverride, null, `lift-only ${testCase.label} adds no execution override`);
      assert.equal(unchanged.execution.lift?.id, 'low-sleep-lift', `lift-only ${testCase.label} preserves the canonical lift identity`);
      assert.equal(unchanged.execution.lift?.type, 'strength', `lift-only ${testCase.label} leaves the accepted lift executable`);
    }
    console.log('CHECK-IN LOW-SLEEP ROUTE SMOKE OK');
  } finally {
    delete require.cache[routePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { run };
