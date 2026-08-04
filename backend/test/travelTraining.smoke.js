// Travel/no-gym deterministic helper + plan-route boundary smoke.
// Run: node backend/test/travelTraining.smoke.js

const assert = require('node:assert/strict');
const { buildBodyweightAlternative } = require('../src/lib/travelTraining');

function routeHandler(router, routePath, method) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route?.methods?.[method]);
  return layer?.route?.stack?.at(-1)?.handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handler(req, res);
  return { statusCode, payload };
}

const sourceLift = {
  id: 'lift-owner',
  kind: 'lift',
  title: 'Strength maintenance - Lower body',
  focus: 'Lower body',
  main: [
    { name: 'Barbell back squat', sets: 4, reps: '4-6', rest: '3 min', load: '135 lb', cue: 'Brace.', progression: 'Add load.', rpe: '7-8' },
    { name: 'Romanian deadlift', sets: 3, reps: '6-8', rest: '2 min', load: '95 lb', cue: 'Hinge.', progression: 'Add load.', rpe: '7-8' },
    { name: 'Box jump', sets: 3, reps: '5', rest: '90 sec', load: 'Bodyweight', cue: 'Jump.', progression: 'Jump higher.', rpe: '7' },
  ],
};

const sourceSnapshot = JSON.parse(JSON.stringify(sourceLift));
const pureAlternative = buildBodyweightAlternative({
  session: sourceLift,
  sessionId: sourceLift.id,
  date: '2026-08-03',
  week: 1,
  phase: 'base',
});
assert.deepEqual(sourceLift, sourceSnapshot, 'pure generation must not mutate the stored session');
assert.equal(pureAlternative.id, sourceLift.id, 'pure generation preserves the stable session ID');
assert.deepEqual(pureAlternative.equipment, ['bodyweight']);
assert.ok(pureAlternative.main.length >= 3 && pureAlternative.main.length <= 4);
assert.ok(pureAlternative.main.every((exercise) => exercise.equipment?.length === 1 && exercise.equipment[0] === 'bodyweight'));
assert.ok(pureAlternative.main.every((exercise) => ['name', 'sets', 'reps', 'rest', 'load', 'cue', 'progression'].every((field) => exercise[field] !== undefined && exercise[field] !== '')));
assert.ok(!pureAlternative.main.some((exercise) => /jump|hop|plyo|depth|bound/i.test(exercise.name)));

async function routeBoundarySmoke() {
  const dbModulePath = require.resolve('../src/db');
  const aiModulePath = require.resolve('../src/services/ai');
  const routeModulePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalAi = require.cache[aiModulePath];
  const originalRoute = require.cache[routeModulePath];
  const RealDate = global.Date;
  let writeQueries = 0;
  let aiCalls = 0;

  const plan = {
    schemaVersion: 2,
    planMode: 'hybrid_maintain',
    goal: { name: 'Army Ten-Miler', date: '2026-10-11', distanceMiles: 10 },
    weeks: [{
      week: 1,
      phase: 'base',
      startDate: '2026-08-03',
      days: [
        { date: '2026-08-02', day: 'Sun', sessions: [] },
        { date: '2026-08-03', day: 'Mon', sessions: [sourceLift, { id: 'run-owner', kind: 'run', type: 'easy', distance_miles: 3 }] },
        { date: '2026-08-04', day: 'Tue', sessions: [{ ...sourceLift, id: 'lift-tomorrow' }] },
        { date: '2026-08-05', day: 'Wed', sessions: [] },
      ],
    }],
  };
  const originalPlanBytes = JSON.stringify(plan);
  const activeRow = {
    id: 'plan-owner',
    user_id: 'owner',
    user_plan_id: 'assignment-owner',
    current_week: 1,
    progress_json: JSON.stringify({ completedSessionIds: [] }),
    plan_data: JSON.stringify(plan),
  };

  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-08-03T12:00:00.000Z'])); }
    static now() { return new RealDate('2026-08-03T12:00:00.000Z').getTime(); }
  }

  const mockDb = {
    dbGet: async (sql, params = []) => {
      if (sql.includes('FROM user_plans up') && sql.includes('JOIN training_plans tp')) {
        return params[0] === 'owner' ? activeRow : null;
      }
      if (sql.includes('FROM training_plans WHERE user_id')) return null;
      return null;
    },
    dbAll: async () => [],
    dbRun: async () => { writeQueries += 1; return { changes: 1 }; },
    withTransaction: async () => { throw new Error('bodyweight route must not open a write transaction'); },
  };

  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: mockDb, children: [], paths: [] };
  require.cache[aiModulePath] = {
    id: aiModulePath,
    filename: aiModulePath,
    loaded: true,
    exports: { generateRaceAdjustment: () => { aiCalls += 1; throw new Error('AI must not be called'); } },
    children: [],
    paths: [],
  };
  global.Date = FixedDate;
  delete require.cache[routeModulePath];

  try {
    const router = require('../src/routes/plans');
    const handler = routeHandler(router, '/today/bodyweight-alternative', 'post');
    assert.equal(typeof handler, 'function', 'bodyweight route must be registered');
    const request = (body, userId = 'owner') => ({ user: { id: userId }, query: {}, body });

    let response = await invoke(handler, request({
      date: '2026-08-03',
      session_id: 'lift-owner',
      workout: { title: 'Client workout', main: [{ name: 'Depth jump' }] },
    }));
    assert.equal(response.statusCode, 200, response.payload?.error);
    assert.equal(response.payload.alternative.id, 'lift-owner');
    assert.equal(response.payload.alternative.date, '2026-08-03');
    assert.equal(response.payload.alternative.adjustedForTravel, true);
    assert.equal(response.payload.alternative.title, 'Runner strength — no equipment');
    assert.deepEqual(response.payload.alternative.equipment, ['bodyweight']);
    assert.ok(!response.payload.alternative.main.some((exercise) => /jump|hop|plyo|depth|bound/i.test(exercise.name)));

    for (const sessionId of ['', 'x'.repeat(129)]) {
      response = await invoke(handler, request({ date: '2026-08-03', session_id: sessionId }));
      assert.equal(response.statusCode, 400, `invalid session ID length ${sessionId.length} must be rejected`);
    }
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'foreign-lift' }));
    assert.equal(response.statusCode, 404, 'foreign/missing session ID must be uniformly not found');
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'lift-owner' }, 'different-owner'));
    assert.equal(response.statusCode, 404, 'another owner cannot load the active plan');
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'run-owner' }));
    assert.equal(response.statusCode, 409, 'run session cannot become bodyweight strength');
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'lift-tomorrow' }));
    assert.equal(response.statusCode, 404, 'another date session cannot be selected');
    response = await invoke(handler, request({ date: '2026-08-02', session_id: 'rest-day' }));
    assert.equal(response.statusCode, 404, 'rest day cannot become bodyweight strength');
    response = await invoke(handler, request({ date: '2026-08-01', session_id: 'lift-owner' }));
    assert.equal(response.statusCode, 400, 'date outside the phone-local safety window must be rejected');

    activeRow.progress_json = JSON.stringify({ completedSessionIds: ['lift-owner'] });
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'lift-owner' }));
    assert.equal(response.statusCode, 409, 'completed lift cannot be translated as executable');

    activeRow.progress_json = JSON.stringify({ completedSessionIds: [] });
    plan.weeks[0].days[1].sessions[0].completed = true;
    activeRow.plan_data = JSON.stringify(plan);
    response = await invoke(handler, request({ date: '2026-08-03', session_id: 'lift-owner' }));
    assert.equal(response.statusCode, 409, 'session-level completion cannot be translated as executable');
    delete plan.weeks[0].days[1].sessions[0].completed;
    activeRow.plan_data = JSON.stringify(plan);

    assert.equal(JSON.stringify(plan), originalPlanBytes, 'stored plan remains byte-identical after every route request');
    assert.equal(writeQueries, 0, 'bodyweight route executes no write query');
    assert.equal(aiCalls, 0, 'bodyweight route executes no AI call');
  } finally {
    global.Date = RealDate;
    delete require.cache[routeModulePath];
    if (originalRoute) require.cache[routeModulePath] = originalRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
    if (originalAi) require.cache[aiModulePath] = originalAi;
    else delete require.cache[aiModulePath];
  }
}

routeBoundarySmoke()
  .then(() => console.log('TRAVEL TRAINING BACKEND SMOKE OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
