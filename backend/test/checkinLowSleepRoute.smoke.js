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
  let writes = [];
  const tx = {
    async get(sql) {
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
      withPlanningInputMutation: async (_userId, callback) => callback(tx),
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
      writes = [];
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
        savedCheckin: writes.find(({ sql }) => /INSERT INTO daily_checkins/.test(sql)),
        savedOverride: writes.find(({ sql }) => /INSERT INTO checkin_overrides/.test(sql)),
      };
    }

    const lowSleep = await postCheckin({
      sleep_hours_last_night: 3.5,
      synced_at: new Date().toISOString(),
      training_metrics_json: '{}',
    });
    assert.equal(lowSleep.payload.action, 'rest', 'actual mobile POST handler turns fresh synced 3.5-hour sleep into recovery');
    assert(lowSleep.savedCheckin, 'actual POST handler persists the check-in');
    assert.equal(lowSleep.savedCheckin.params[7], 3.5, 'actual mobile POST handler persists the fresh synced sleep value');
    assert(lowSleep.savedOverride, 'actual POST handler persists a bound safety override');
    const lowSleepPatch = JSON.parse(lowSleep.savedOverride.params[4]);
    assert.equal(lowSleepPatch.type, 'rest');
    assert.equal(lowSleepPatch.workout_type, 'rest');
    assert.equal(lowSleepPatch.distance_miles, 0);

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
      assert.equal(result.payload.action, 'keep', `${testCase.label} cannot invent a rest decision`);
      assert(result.savedCheckin, `${testCase.label} still persists the user's check-in`);
      assert.equal(result.savedCheckin.params[7], null, `${testCase.label} persists unknown sleep as null, not zero`);
      assert(result.savedOverride, `${testCase.label} retains a bound keep decision for the scheduled workout`);
      assert.equal(result.savedOverride.params[3], 'keep', `${testCase.label} persists keep rather than rest`);
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
    const planSchema = require('../src/lib/planSchema');
    const dailyExecution = require('../src/lib/dailyExecution');
    for (const testCase of liftSafetyCases) {
      const result = await postCheckin(testCase.row, testCase.body);
      assert.equal(result.payload.action, 'rest', `actual POST /checkin turns lift-only ${testCase.label} safety evidence into rest`);
      const patch = JSON.parse(result.savedOverride.params[4]);
      const resolved = dailyExecution.resolvePlanDayForDate({
        plan: JSON.parse(planRow.plan_data),
        dateISO: date,
        patch,
      });
      assert.equal(planSchema.daySessions(resolved.selectedEntry)[0].type, 'rest', `lift-only ${testCase.label} persists a non-executable lift prescription`);
      const execution = dailyExecution.buildDailyExecution({
        plan: JSON.parse(planRow.plan_data),
        dateISO: date,
        selectedEntry: resolved.selectedEntry,
        selectedWeek: resolved.selectedWeek,
        selectedDayIndex: resolved.selectedDayIndex,
        completedSessionIds: [],
      });
      assert.equal(execution.checkinOverride?.action, 'rest', `lift-only ${testCase.label} carries the day-level fail-closed directive`);
      assert.equal(execution.lift?.type, 'rest', `lift-only ${testCase.label} cannot remain an executable strength session`);
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
