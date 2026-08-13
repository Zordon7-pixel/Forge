#!/usr/bin/env node

const assert = require('node:assert/strict');
const planSchema = require('../src/lib/planSchema');

async function run() {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sourcePlan = {
    schemaVersion: 2,
    weeks: [{ days: [{ date, day: 'Wed', sessions: [{ id: 'removed-today-run', kind: 'run', duration_min: 45 }] }] }],
  };
  const identified = planSchema.withRemovalSessionIdentities(sourcePlan, { assignmentStart: date });
  const removalId = identified.weeks[0].days[0].sessions[0].removal_session_id;
  const row = {
    user_plan_id: 'assignment-owner',
    plan_id: 'plan-owner',
    status: 'active',
    started_at: date,
    effective_from: date,
    progress_json: JSON.stringify({ removedSessionIds: [removalId] }),
    plan_data: sourcePlan,
  };
  const writes = [];
  const tx = {
    async get(sql) {
      if (/SELECT id FROM daily_checkins/.test(sql)) return null;
      if (/FROM user_plans up/.test(sql) && /JOIN training_plans tp/.test(sql)) return row;
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
      user: { id: 'owner' },
      body: { feeling: 3, time_available: 30, life_flags: [], date },
      query: {},
      headers: { 'x-forged-local-date': date },
    }, response);
    assert.equal(statusCode, 200);
    assert.match(payload.adjustment, /no active workout was found/i);
    assert.equal(writes.some(({ sql }) => /INSERT INTO checkin_overrides/.test(sql)), false,
      'removed workout never creates an override');
    assert.equal(writes.some(({ sql }) => /DELETE FROM checkin_overrides/.test(sql)), true,
      'stale same-day override is cleared when no visible workout remains');
    assert.equal(writes.some(({ sql }) => /INSERT INTO daily_checkins/.test(sql)), true,
      'the truthful check-in itself is still saved');
    console.log('CHECK-IN REMOVAL VISIBILITY SMOKE OK');
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
