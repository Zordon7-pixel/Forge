#!/usr/bin/env node

const assert = require('node:assert/strict');

async function run() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const ownerId = 'low-sleep-route-owner';
  const planRow = {
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
  const writes = [];
  const tx = {
    async get(sql) {
      if (/SELECT id FROM daily_checkins/.test(sql)) return null;
      if (/FROM health_sync/.test(sql)) return {
        sleep_hours_last_night: 3.5,
        synced_at: new Date().toISOString(),
        training_metrics_json: '{}',
      };
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
    await handler({
      user: { id: ownerId },
      body: {
        legs: 3,
        drive: 3,
        time_available: 60,
        life_flags: [],
        date,
      },
      query: {},
      headers: { 'x-forged-local-date': date },
    }, response);

    assert.equal(statusCode, 200);
    assert.equal(payload.action, 'rest', 'actual mobile POST handler turns fresh synced 3.5-hour sleep into recovery');
    const savedCheckin = writes.find(({ sql }) => /INSERT INTO daily_checkins/.test(sql));
    assert(savedCheckin, 'actual POST handler persists the check-in');
    assert.equal(savedCheckin.params[7], 3.5, 'actual mobile POST handler persists the fresh synced sleep value');
    const savedOverride = writes.find(({ sql }) => /INSERT INTO checkin_overrides/.test(sql));
    assert(savedOverride, 'actual POST handler persists a bound safety override');
    const patch = JSON.parse(savedOverride.params[4]);
    assert.equal(patch.type, 'rest');
    assert.equal(patch.workout_type, 'rest');
    assert.equal(patch.distance_miles, 0);
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
