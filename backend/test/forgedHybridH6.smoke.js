// Forged Hybrid H6 simplification/migration smoke.
// Run: node backend/test/forgedHybridH6.smoke.js
//
// Exercises the real GET /plans/my handler with a mocked DB. The migration
// contract is read-only: assigned plans win, legacy user-owned plans remain
// visible, and a normal read never creates or mutates plan data.

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}

async function run() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDbModule = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];

  let assignedRow = null;
  let legacyRow = null;
  let calls = [];
  let writeCount = 0;

  const mockDb = {
    dbGet: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM user_plans up')) return assignedRow ? { ...assignedRow } : null;
      if (sql.includes('FROM training_plans WHERE user_id = ?')) return legacyRow ? { ...legacyRow } : null;
      return null;
    },
    dbAll: async (sql, params) => {
      calls.push({ sql, params });
      if (assignedRow && sql.includes('up.lineage_id=?') && params[2] !== assignedRow.user_plan_id) {
        return [{
          id: assignedRow.user_plan_id,
          plan_id: assignedRow.plan_id,
          plan_data: assignedRow.plan_data,
          plan_version: assignedRow.plan_version,
          progress_json: assignedRow.progress_json,
          status: assignedRow.status,
        }];
      }
      return [];
    },
    dbRun: async () => { writeCount += 1; return { changes: 0 }; },
    withTransaction: async () => { writeCount += 1; throw new Error('GET /plans/my must not start a write transaction'); },
  };

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const layer = plansRouter.stack.find((item) => item.route?.path === '/my' && item.route?.methods?.get);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert(typeof handler === 'function', 'GET /plans/my handler is registered');

    const invoke = async (userId = 'user-h6') => {
      let statusCode = 200;
      let payload = null;
      const response = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await handler({ user: { id: userId } }, response);
      return { statusCode, payload };
    };

    assignedRow = {
      id: 'catalog-plan-h6',
      user_plan_id: 'assignment-h6',
      plan_id: 'catalog-plan-h6',
      lineage_id: 'lineage-h6',
      plan_version: 2,
      name: 'Assigned hybrid plan',
      type: 'hybrid',
      weeks: 2,
      description: 'Assigned plan wins',
      plan_data: { schemaVersion: 2, weeks: [] },
      progress_json: JSON.stringify({ completedSessionIds: ['run-1'] }),
      started_at: '2026-07-13',
      current_week: 2,
      status: 'active',
    };
    legacyRow = {
      id: 'legacy-should-not-win',
      name: 'Legacy plan',
      type: 'run',
      weeks: 1,
      plan_json: JSON.stringify({ weeks: [] }),
    };
    calls = [];
    let response = await invoke();
    assert(response.statusCode === 200 && response.payload?.plan?.id === 'catalog-plan-h6', 'assigned active plan remains authoritative');
    assert(response.payload?.user_plan?.id === 'assignment-h6' && response.payload?.user_plan?.current_week === 2, 'assigned progress contract is unchanged');
    assert(response.payload?.lineage_history?.length === 0, 'the served assignment is excluded from its own lineage history');
    assert(calls.length === 2 && calls.every((call) => call.params?.[0] === 'user-h6'), 'assigned and lineage lookups are scoped to the authenticated user');
    assert(calls[1].params?.[2] === 'assignment-h6', 'lineage exclusion binds the user-plan assignment ID');

    assignedRow = null;
    legacyRow = {
      id: 'legacy-plan-h6',
      name: 'Legacy Army Ten-Miler',
      type: 'run',
      weeks: 3,
      description: 'Existing user-owned plan',
      plan_data: null,
      plan_json: JSON.stringify({ weeks: [{ week: 1, days: [] }] }),
    };
    calls = [];
    response = await invoke();
    assert(response.statusCode === 200 && response.payload?.source === 'legacy', 'legacy user-owned plan is returned when no assignment exists');
    assert(response.payload?.plan?.id === 'legacy-plan-h6' && response.payload?.plan?.plan_data?.weeks?.length === 1, 'legacy plan JSON is parsed into the normal frontend contract');
    assert(response.payload?.user_plan === null, 'legacy read does not invent assignment progress');
    assert(calls.length === 2 && calls.every((call) => call.params?.[0] === 'user-h6'), 'assigned and legacy lookups both bind the authenticated user');

    legacyRow = null;
    calls = [];
    response = await invoke('different-user-h6');
    assert(response.statusCode === 200 && response.payload?.plan === null, 'user with no owned or assigned plan gets the no-plan state');
    assert(calls.every((call) => call.params?.[0] === 'different-user-h6'), 'no-plan lookup cannot cross user scope');
    assert(writeCount === 0, 'GET /plans/my performs no writes or migration transaction');
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }

  console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
  if (failed) process.exit(1);
  console.log('H6 BACKEND SMOKE OK');
}

run().catch((err) => {
  console.error('  FAIL: H6 backend smoke crashed:', err);
  process.exit(1);
});
