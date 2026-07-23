#!/usr/bin/env node

const assert = require('node:assert/strict');

let adapter = {};

const dbModulePath = require.resolve('../src/db');
const originalDbModule = require.cache[dbModulePath];
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    dbGet: (...args) => adapter.dbGet(...args),
    dbAll: (...args) => adapter.dbAll(...args),
    dbRun: (...args) => adapter.dbRun(...args),
    withTransaction: (...args) => adapter.withTransaction(...args),
    withUserMutation: (userId, fn) => adapter.withTransaction(fn, { requireUserIds: [userId] }),
    runWithUserContext: (_userId, fn) => fn(),
  },
};

function routeHandler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function invoke(handler, request) {
  const response = responseHarness();
  let nextError = null;
  await handler(request, response, (error) => { nextError = error || new Error('Unexpected next() call'); });
  if (nextError) throw nextError;
  return response;
}

async function verifyRunRangeRoute(runsHandler) {
  const reads = [];
  adapter = {
    dbAll: async (sql, params) => {
      reads.push({ sql, params });
      return [{ id: 'run-1', user_id: 'user-a', date: '2026-07-22', type: 'Running', distance_miles: 3.1 }];
    },
    dbGet: async () => null,
    dbRun: async () => ({ changes: 0 }),
    withTransaction: async (fn) => fn({}),
  };

  const ranged = await invoke(runsHandler, {
    user: { id: 'user-a' },
    query: { start_date: '2026-03-01', end_date: '2026-07-22', limit: '900' },
  });
  assert.equal(ranged.statusCode, 200);
  assert.equal(ranged.payload.runs.length, 1);
  assert.match(reads[0].sql, /user_id = \? AND date >= \? AND date <= \?/);
  assert.deepEqual(reads[0].params, ['user-a', '2026-03-01', '2026-07-22', 500]);

  const invalidQueries = [
    { start_date: '2026-02-30', end_date: '2026-07-22' },
    { start_date: '2026-07-23', end_date: '2026-07-22' },
    { start_date: '2026-07-01' },
  ];
  for (const query of invalidQueries) {
    const response = await invoke(runsHandler, { user: { id: 'user-a' }, query });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(reads.length, 1, 'invalid ranges must not query the database');

  await invoke(runsHandler, { user: { id: 'user-a' }, query: { limit: '0' } });
  assert.deepEqual(reads.at(-1).params, ['user-a', 1], 'zero limits clamp to one');
  await invoke(runsHandler, { user: { id: 'user-a' }, query: { limit: 'garbage' } });
  assert.deepEqual(reads.at(-1).params, ['user-a', 50], 'malformed limits use the default');
}

function baseRace() {
  return {
    id: 'race-1',
    user_id: 'user-a',
    race_name: 'Army Ten-Miler',
    race_date: '2026-10-11',
    distance_miles: 10,
    location: 'Washington, DC',
    goal_time_seconds: 5400,
    status: 'upcoming',
    notes: 'A race note',
    elevation_gain_ft: 480,
    max_altitude_ft: 190,
    terrain: 'rolling',
    course_profile_json: JSON.stringify({ version: 1, provenance: { kind: 'user_gpx' } }),
    source: 'user_gpx',
    url: 'https://example.test/course',
  };
}

async function verifyRacePatchRoute(racePatchHandler) {
  let race = baseRace();
  let writes = 0;
  adapter = {
    dbGet: async (sql, params) => {
      assert.match(sql, /race_events WHERE id=\? AND user_id=\?/);
      return params[0] === race.id && params[1] === race.user_id ? { ...race } : null;
    },
    dbAll: async () => [],
    dbRun: async (sql, params) => {
      writes += 1;
      assert.match(sql, /WHERE id=\? AND user_id=\?/);
      assert.deepEqual(params.slice(-2), [race.id, race.user_id]);
      race = {
        ...race,
        race_name: params[0],
        race_date: params[1],
        distance_miles: params[2],
        location: params[3],
        goal_time_seconds: params[4],
        status: params[5],
        notes: params[6],
        elevation_gain_ft: params[7],
        max_altitude_ft: params[8],
        terrain: params[9],
        course_profile_json: params[10],
        source: params[11],
        url: params[12],
      };
      return { changes: 1 };
    },
    withTransaction: async (fn) => fn({}),
  };

  const goalOnly = await invoke(racePatchHandler, {
    user: { id: 'user-a' }, params: { id: 'race-1' }, body: { goal_time_seconds: 5100 },
  });
  assert.equal(goalOnly.statusCode, 200);
  assert.equal(race.goal_time_seconds, 5100);
  assert.equal(race.elevation_gain_ft, 480);
  assert.equal(race.course_profile_json, baseRace().course_profile_json);
  assert.equal(race.source, 'user_gpx');

  race = baseRace();
  const identityEdit = await invoke(racePatchHandler, {
    user: { id: 'user-a' }, params: { id: 'race-1' }, body: { location: 'Arlington, VA' },
  });
  assert.equal(identityEdit.statusCode, 200);
  for (const field of ['elevation_gain_ft', 'max_altitude_ft', 'terrain', 'course_profile_json', 'source', 'url']) {
    assert.equal(race[field], null, `${field} must clear after a course identity edit`);
  }

  const beforeForeignWrite = writes;
  const foreign = await invoke(racePatchHandler, {
    user: { id: 'user-b' }, params: { id: 'race-1' }, body: { goal_time_seconds: 5000 },
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(writes, beforeForeignWrite, 'a foreign race must never reach UPDATE');
}

async function verifyLegacyRaceLinkRoute(raceLinkHandler) {
  const sharedPlanData = {
    schemaVersion: 2,
    goal: { name: 'Army Ten-Miler', date: '2026-10-11', distanceMiles: 10 },
    weeks: [],
  };
  const plans = new Map([['template-1', {
    id: 'template-1',
    user_id: null,
    week_start: '2026-07-20',
    plan_json: null,
    plan_data: JSON.stringify(sharedPlanData),
    name: 'Army Ten-Miler plan',
    type: 'race',
    weeks: 12,
    description: 'Shared template',
  }]]);
  const assignment = {
    user_plan_id: 'up-a',
    id: 'up-a',
    user_id: 'user-a',
    plan_id: 'template-1',
    current_week: 1,
    started_at: '2026-07-20',
    status: 'active',
    progress_json: '{}',
  };
  const races = new Map([
    ['race-a', { id: 'race-a', user_id: 'user-a', race_name: 'Army Ten-Miler', race_date: '2026-10-11', distance_miles: 10 }],
    ['race-b', { id: 'race-b', user_id: 'user-b', race_name: 'Other Race', race_date: '2026-10-11', distance_miles: 10 }],
  ]);
  const writes = [];

  const tx = {
    get: async (sql, params) => {
      if (/FROM race_events/.test(sql)) {
        const race = races.get(params[0]);
        return race?.user_id === params[1] ? { ...race } : null;
      }
      if (/FROM user_plans up/.test(sql)) {
        if (params[0] !== assignment.user_id) return null;
        return {
          user_plan_id: assignment.user_plan_id,
          plan_id: assignment.plan_id,
          current_week: assignment.current_week,
          started_at: assignment.started_at,
          status: assignment.status,
          progress_json: assignment.progress_json,
        };
      }
      if (/FROM training_plans tp/.test(sql)) {
        const plan = plans.get(params[0]);
        return plan && params[1] === assignment.user_plan_id && params[2] === assignment.user_id ? { ...plan } : null;
      }
      if (/FROM training_plans\s+WHERE user_id=/.test(sql)) return null;
      throw new Error(`Unexpected transaction read: ${sql}`);
    },
    run: async (sql, params) => {
      writes.push({ sql, params });
      if (/INSERT INTO training_plans/.test(sql)) {
        const [cloneId, userId, sourceId] = params;
        const source = plans.get(sourceId);
        assert.ok(source);
        plans.set(cloneId, { ...source, id: cloneId, user_id: userId });
        return { changes: 1 };
      }
      if (/UPDATE user_plans SET plan_id=/.test(sql)) {
        const [cloneId, userPlanId, userId] = params;
        assert.equal(userPlanId, assignment.user_plan_id);
        assert.equal(userId, assignment.user_id);
        assignment.plan_id = cloneId;
        return { changes: 1 };
      }
      if (/UPDATE training_plans SET plan_data=/.test(sql)) {
        const [serialized, planId, userId] = params;
        const plan = plans.get(planId);
        assert.equal(plan?.user_id, userId);
        plan.plan_data = serialized;
        return { changes: 1 };
      }
      throw new Error(`Unexpected transaction write: ${sql}`);
    },
  };

  adapter = {
    dbGet: async () => null,
    dbAll: async () => [],
    dbRun: async () => ({ changes: 0 }),
    withTransaction: async (fn) => fn(tx),
  };

  const foreign = await invoke(raceLinkHandler, {
    user: { id: 'user-a' }, body: { race_id: 'race-b' }, params: {}, query: {},
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(writes.length, 0, 'foreign race linkage must not mutate a plan');

  const linked = await invoke(raceLinkHandler, {
    user: { id: 'user-a' }, body: { race_id: 'race-a' }, params: {}, query: {},
  });
  assert.equal(linked.statusCode, 200);
  assert.equal(linked.payload.plan_data.goal.raceId, 'race-a');
  assert.equal(assignment.plan_id === 'template-1', false, 'the user assignment must repoint to a private clone');
  assert.equal(JSON.parse(plans.get('template-1').plan_data).goal.raceId, undefined, 'the shared template must stay pristine');
  const clone = plans.get(assignment.plan_id);
  assert.equal(clone.user_id, 'user-a');
  assert.equal(JSON.parse(clone.plan_data).goal.raceId, 'race-a');
  assert.ok(writes.some(({ sql, params }) => /UPDATE user_plans/.test(sql) && params.at(-1) === 'user-a'));
  assert.ok(writes.some(({ sql, params }) => /UPDATE training_plans/.test(sql) && params.at(-1) === 'user-a'));
}

async function main() {
  try {
    const runsRouter = require('../src/routes/runs');
    const racesRouter = require('../src/routes/races');
    const plansRouter = require('../src/routes/plans');
    await verifyRunRangeRoute(routeHandler(runsRouter, '/', 'get'));
    await verifyRacePatchRoute(routeHandler(racesRouter, '/:id', 'patch'));
    await verifyLegacyRaceLinkRoute(routeHandler(plansRouter, '/my/race-link', 'put'));
    console.log('RACE CALENDAR ACTIVITY BEHAVIOR OK');
  } finally {
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
