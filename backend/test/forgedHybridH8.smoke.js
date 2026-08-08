// Forged Hybrid H8 backend smoke.
// Run: node backend/test/forgedHybridH8.smoke.js

const raceCourse = require('../src/lib/raceCourse');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route?.methods?.[method]);
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

function catalogSearchMatches(row, params) {
  const patterns = params.filter((value) => typeof value === 'string' && value.startsWith('%') && value.endsWith('%'));
  const tokens = patterns.filter((_, index) => index % 4 === 0).map((pattern) => pattern.slice(1, -1).toLowerCase());
  const fields = [row.name, row.city, row.state, row.country].map((value) => String(value || '').toLowerCase());
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

async function runRaceRouteSmoke() {
  console.log('\nCatalog search and import routes');
  const dbModulePath = require.resolve('../src/db');
  const racesRoutePath = require.resolve('../src/routes/races');
  const originalDbModule = require.cache[dbModulePath];
  const originalRacesRoute = require.cache[racesRoutePath];
  const catalogRace = {
    id: 'army-10-miler-2026-10-11',
    name: 'Army 10-Miler',
    race_date: '2026-10-11',
    city: 'Washington',
    state: 'DC',
    country: 'USA',
    distance_miles: 10,
    elevation_gain_ft: 190,
    max_altitude_ft: 100,
    terrain: 'road',
    source: 'Army Ten-Miler',
    url: 'https://www.armytenmiler.com/',
    created_at: '2026-07-13T12:00:00.000Z',
    course_profile_json: null,
  };
  const raceRows = [
    {
      id: 'owned-existing-h8',
      user_id: 'owner-h8',
      race_name: 'Army Ten-Miler',
      race_date: catalogRace.race_date,
      distance_miles: 10,
      location: 'Old location',
      goal_time_seconds: null,
      status: 'upcoming',
      elevation_gain_ft: 1,
      max_altitude_ft: 2,
      terrain: 'trail',
      course_profile_json: JSON.stringify({ legacy: true }),
      source: 'old source',
      url: 'https://old.invalid/',
      created_at: '2026-07-01T12:00:00.000Z',
    },
    {
      id: 'foreign-existing-h8',
      user_id: 'other-user-h8',
      race_name: 'Army Ten-Miler',
      race_date: catalogRace.race_date,
      distance_miles: 10,
      location: 'Foreign location',
      goal_time_seconds: 9999,
      status: 'upcoming',
      elevation_gain_ft: 7,
      max_altitude_ft: 8,
      terrain: 'trail',
      course_profile_json: JSON.stringify({ foreign: true }),
      source: 'foreign source',
      url: 'https://foreign.invalid/',
      created_at: '2026-07-01T12:00:00.000Z',
    },
  ];
  const calls = [];
  let insertCount = 0;

  const mockDb = {
    dbGet: async (sql, params = []) => {
      calls.push({ kind: 'get', sql, params: [...params] });
      if (sql.includes('FROM race_catalog')) {
        return params[0] === catalogRace.id ? { ...catalogRace } : null;
      }
      if (sql.includes('FROM race_events')) {
        const row = raceRows.find((item) => item.id === params[0] && item.user_id === params[1]);
        return row ? { ...row } : null;
      }
      return null;
    },
    dbAll: async (sql, params = []) => {
      calls.push({ kind: 'all', sql, params: [...params] });
      if (sql.includes('FROM race_catalog')) {
        return catalogSearchMatches(catalogRace, params) ? [{ ...catalogRace }] : [];
      }
      if (sql.includes('FROM race_events')) {
        return raceRows
          .filter((row) => row.user_id === params[0]
            && row.race_date === params[1]
            && Number(row.distance_miles) === Number(params[2]))
          .map((row) => ({ ...row }));
      }
      return [];
    },
    dbRun: async (sql, params = []) => {
      calls.push({ kind: 'run', sql, params: [...params] });
      if (sql.includes('UPDATE race_events')) {
        const [
          race_name,
          race_date,
          distance_miles,
          location,
          goal_time_seconds,
          elevation_gain_ft,
          max_altitude_ft,
          terrain,
          course_profile_json,
          source,
          url,
          id,
          user_id,
        ] = params;
        const row = raceRows.find((item) => item.id === id && item.user_id === user_id);
        if (!row) return { changes: 0 };
        Object.assign(row, {
          race_name,
          race_date,
          distance_miles,
          location,
          goal_time_seconds,
          elevation_gain_ft,
          max_altitude_ft,
          terrain,
          course_profile_json,
          source,
          url,
        });
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO race_events')) {
        insertCount += 1;
        const [
          id,
          user_id,
          race_name,
          race_date,
          distance_miles,
          location,
          goal_time_seconds,
          status,
          elevation_gain_ft,
          max_altitude_ft,
          terrain,
          course_profile_json,
          source,
          url,
        ] = params;
        raceRows.push({
          id,
          user_id,
          race_name,
          race_date,
          distance_miles,
          location,
          goal_time_seconds,
          status,
          elevation_gain_ft,
          max_altitude_ft,
          terrain,
          course_profile_json,
          source,
          url,
          created_at: '2026-07-13T12:00:00.000Z',
        });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };
  mockDb.withPlanningInputMutation = async (_userId, mutation) => mutation({
    get: mockDb.dbGet,
    all: mockDb.dbAll,
    run: mockDb.dbRun,
  });

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  delete require.cache[racesRoutePath];

  try {
    const racesRouter = require('../src/routes/races');
    const searchHandler = routeHandler(racesRouter, '/catalog', 'get');
    const importHandler = routeHandler(racesRouter, '/from-catalog/:catalogId', 'post');
    check(typeof searchHandler === 'function' && typeof importHandler === 'function', 'real catalog search and import handlers are registered');

    let response = await invoke(searchHandler, { query: { q: 'Army Ten-Miler' }, user: { id: 'owner-h8' } });
    check(response.statusCode === 200 && response.payload?.races?.[0]?.id === catalogRace.id, 'Army Ten-Miler alias finds the Army 10-Miler catalog row');
    let searchCall = calls.filter((call) => call.kind === 'all' && call.sql.includes('FROM race_catalog')).at(-1);
    check(same([...new Set(searchCall.params)], ['%army%', '%10%', '%miler%']), 'alias search binds canonical tokens as parameters');
    check(/city ILIKE \?/.test(searchCall.sql) && /state ILIKE \?/.test(searchCall.sql), 'catalog search spans canonical name and location columns');
    check(!searchCall.sql.includes('Army Ten-Miler'), 'catalog search never interpolates the user query into SQL');

    response = await invoke(searchHandler, { query: { q: 'Washington D.C.' }, user: { id: 'owner-h8' } });
    check(response.statusCode === 200 && response.payload?.races?.[0]?.id === catalogRace.id, 'Washington DC terms find the catalog city and state');
    searchCall = calls.filter((call) => call.kind === 'all' && call.sql.includes('FROM race_catalog')).at(-1);
    check(same([...new Set(searchCall.params)], ['%washington%', '%dc%']), 'location search normalizes punctuation and binds both tokens');

    response = await invoke(importHandler, {
      params: { catalogId: catalogRace.id },
      body: { goal_time_seconds: 5400 },
      user: { id: 'owner-h8' },
    });
    const owned = raceRows.find((row) => row.id === 'owned-existing-h8');
    const foreign = raceRows.find((row) => row.id === 'foreign-existing-h8');
    const ownedEnvelope = JSON.parse(owned.course_profile_json);
    check(response.statusCode === 200 && response.payload?.existing === true && response.payload?.race?.id === owned.id, 'reselecting an owned catalog edition reuses the existing race');
    check(insertCount === 0 && raceRows.length === 2, 'owned edition reuse is idempotent and does not insert');
    check(owned.goal_time_seconds === 5400 && owned.race_name === catalogRace.name && owned.location === 'Washington, DC', 'reuse applies goal time and canonical catalog identity fields');
    check(owned.elevation_gain_ft === 190 && owned.max_altitude_ft === 100 && owned.terrain === 'road', 'reuse refreshes canonical course fields');
    check(ownedEnvelope.editionId === catalogRace.id && ownedEnvelope.provenance === 'curated', 'reuse refreshes the canonical H7 course envelope');
    const updateCall = calls.filter((call) => call.kind === 'run' && call.sql.includes('UPDATE race_events')).at(-1);
    check(/WHERE id=\? AND user_id=\?/.test(updateCall.sql) && updateCall.params.at(-1) === 'owner-h8', 'reuse UPDATE is owner-scoped and binds the authenticated user');
    check(foreign.location === 'Foreign location' && foreign.goal_time_seconds === 9999 && foreign.elevation_gain_ft === 7, 'reuse cannot mutate another user\'s matching race');

    owned.elevation_gain_ft = 3;
    response = await invoke(importHandler, {
      params: { catalogId: catalogRace.id },
      body: {},
      user: { id: 'owner-h8' },
    });
    check(response.statusCode === 200 && response.payload?.existing === true && insertCount === 0, 'a repeated selection remains idempotent');
    check(owned.goal_time_seconds === 5400 && owned.elevation_gain_ft === 190, 'omitted goal time is preserved while canonical course data is refreshed');

    const writesBeforeInvalidGoal = calls.filter((call) => call.kind === 'run').length;
    response = await invoke(importHandler, {
      params: { catalogId: catalogRace.id },
      body: { goal_time_seconds: -1 },
      user: { id: 'owner-h8' },
    });
    check(response.statusCode === 400 && response.payload?.error === 'goal_time_seconds is invalid', 'catalog import uses existing goal-time validation');
    check(calls.filter((call) => call.kind === 'run').length === writesBeforeInvalidGoal, 'invalid goal time is rejected before any write');

    response = await invoke(importHandler, {
      params: { catalogId: catalogRace.id },
      body: { goal_time_seconds: 5100 },
      user: { id: 'new-owner-h8' },
    });
    const inserted = raceRows.find((row) => row.user_id === 'new-owner-h8');
    const insertedEnvelope = JSON.parse(inserted.course_profile_json);
    check(response.statusCode === 201 && response.payload?.existing === false && response.payload?.race?.id === inserted.id, 'a user without the edition receives a new 201 import');
    check(insertCount === 1 && inserted.goal_time_seconds === 5100 && inserted.status === 'upcoming', 'new import persists goal time and upcoming status once');
    check(insertedEnvelope.editionId === catalogRace.id && inserted.elevation_gain_ft === 190 && inserted.location === 'Washington, DC', 'new import persists canonical H7 envelope and course fields');
  } finally {
    delete require.cache[racesRoutePath];
    if (originalRacesRoute) require.cache[racesRoutePath] = originalRacesRoute;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }
}

async function runOpenAITimeoutSmoke() {
  console.log('\nOpenAI Responses timeout');
  const aiModulePath = require.resolve('../src/services/ai');
  const originalAiModule = require.cache[aiModulePath];
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalTimeoutEnv = process.env.OPENAI_RESPONSES_TIMEOUT_MS;
  const timerHandle = {};
  const logs = [];
  let timeoutMs = null;
  let clearedTimer = false;
  let sawAbortSignal = false;

  delete require.cache[aiModulePath];
  process.env.OPENAI_API_KEY = 'h8-test-key';
  process.env.OPENAI_RESPONSES_TIMEOUT_MS = '1';
  global.setTimeout = (callback, ms) => {
    timeoutMs = ms;
    queueMicrotask(callback);
    return timerHandle;
  };
  global.clearTimeout = (handle) => {
    if (handle === timerHandle) clearedTimer = true;
  };
  global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
    sawAbortSignal = Boolean(options.signal);
    const rejectAbort = () => {
      const err = new Error('simulated abort');
      err.name = 'AbortError';
      reject(err);
    };
    if (options.signal?.aborted) rejectAbort();
    else options.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  console.error = (...args) => logs.push(args.join(' '));

  try {
    const ai = require('../src/services/ai');
    const result = await ai.generateTrainingPlan(
      { name: 'H8 Test', weekly_miles_current: 12, run_days_per_week: 3, lift_days_per_week: 0 },
      { weeks: 4, planMode: 'run_only', liftingEnabled: false, startDate: '2026-07-13' }
    );
    check(result === null, 'generateTrainingPlan returns null after a Responses abort');
    check(timeoutMs === 75_000, 'Responses fetch uses the fixed 75-second source timeout despite an env override');
    check(sawAbortSignal && clearedTimer, 'Responses fetch receives an abort signal and always clears its timer');
    check(logs.some((line) => line.includes('timed out after 75 seconds')), 'Responses abort produces a useful timeout log');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalTimeoutEnv === undefined) delete process.env.OPENAI_RESPONSES_TIMEOUT_MS;
    else process.env.OPENAI_RESPONSES_TIMEOUT_MS = originalTimeoutEnv;
    delete require.cache[aiModulePath];
    if (originalAiModule) require.cache[aiModulePath] = originalAiModule;
  }
}

async function runPlanFallbackSmoke() {
  console.log('\nPlan generation fallback');
  const dbModulePath = require.resolve('../src/db');
  const aiModulePath = require.resolve('../src/services/ai');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDbModule = require.cache[dbModulePath];
  const originalAiModule = require.cache[aiModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const writes = [];
  let generateCalls = 0;
  const profile = {
    id: 'plan-owner-h8',
    name: 'H8 Athlete',
    weekly_miles_current: 15,
    run_days_per_week: 3,
    lift_days_per_week: 0,
    goal_type: 'fitness',
    comeback_mode: 0,
    injury_notes: '',
  };
  const raceDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const race = {
    id: 'race-plan-h8',
    user_id: profile.id,
    race_name: 'H8 Race',
    race_date: raceDate,
    distance_miles: 10,
    goal_time_seconds: 5400,
    elevation_gain_ft: null,
    max_altitude_ft: null,
    terrain: null,
    course_profile_json: null,
    source: null,
    url: null,
  };
  const mockDb = {
    dbGet: async (sql, params = []) => {
      if (sql.includes('FROM users WHERE id = ?')) return params[0] === profile.id ? { ...profile } : null;
      if (sql.includes('FROM race_events WHERE id = ? AND user_id = ?')) {
        return params[0] === race.id && params[1] === profile.id ? { ...race } : null;
      }
      return null;
    },
    dbAll: async () => [],
    dbRun: async () => ({ changes: 0 }),
    withTransaction: async (fn) => fn({
      run: async (sql, params = []) => {
        writes.push({ sql, params: [...params] });
        return { changes: 1 };
      },
    }),
  };
  const mockAi = {
    generateTrainingPlan: async (_profile, target) => {
      generateCalls += 1;
      return null;
    },
    generateRaceAdjustment: async () => null,
  };

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  require.cache[aiModulePath] = {
    id: aiModulePath,
    filename: aiModulePath,
    loaded: true,
    exports: mockAi,
    children: [],
    paths: [],
  };
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const handler = routeHandler(plansRouter, '/generate', 'post');
    const raceHandler = routeHandler(plansRouter, '/generate-for-race/:raceId', 'post');
    check(typeof handler === 'function' && typeof raceHandler === 'function', 'ordinary and race plan generation handlers are registered');
    let response = await invoke(handler, {
      body: { target: { trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    check(response.statusCode === 400 && /supplied together/.test(response.payload?.error || ''), 'selected weekdays without an authoritative count are rejected instead of falling back to three');
    check(writes.length === 0, 'a partial run schedule is rejected before persistence');

    response = await invoke(handler, {
      body: { target: { weeks: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    check(generateCalls === 0, 'plan route does not spend an LLM request');
    check(response.statusCode === 201 && response.payload?.generation_source === 'evidence_engine', 'POST /plans/generate succeeds with evidence_engine');
    check(response.payload?.plan?.plan_data?.generationSource === 'evidence_engine', 'persisted response carries evidence-engine provenance');
    check(writes.length === 3 && writes.every((write) => write.params.includes(profile.id)), 'evidence plan persistence remains scoped to the authenticated user');

    response = await invoke(raceHandler, {
      params: { raceId: race.id },
      body: { target: { trainingDays: ['Tue', 'Thu', 'Sat'], runDaysPerWeek: 3, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    check(generateCalls === 0, 'race plan route also avoids an LLM request');
    check(response.statusCode === 201 && response.payload?.generation_source === 'evidence_engine', 'POST /plans/generate-for-race succeeds with evidence_engine');
    check(response.payload?.plan?.plan_data?.generationSource === 'evidence_engine', 'race plan persistence carries evidence-engine provenance');
    check(response.payload?.race?.id === race.id && response.payload?.plan?.plan_data?.goal?.name === race.race_name && response.payload?.plan?.plan_data?.goal?.date === raceDate, 'race plan uses the owned race identity and date');
    const preferenceWrite = writes.find((write) => write.sql.includes('UPDATE users SET run_days_per_week'));
    check(writes.length === 7 && writes.every((write) => write.params.includes(profile.id)), 'race evidence and preference persistence remain scoped to the authenticated user');
    check(preferenceWrite?.params[0] === 3 && preferenceWrite?.params[1] === JSON.stringify(['Tue', 'Thu', 'Sat']), 'race generation persists the authoritative run count and selected weekdays');
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalAiModule) require.cache[aiModulePath] = originalAiModule;
    else delete require.cache[aiModulePath];
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }
}

async function run() {
  console.log('Catalog token normalization');
  check(same(raceCourse.normalizeCatalogSearchTokens('Army Ten-Miler'), ['army', '10', 'miler']), 'canonical race alias normalizes to catalog spelling');
  check(same(raceCourse.normalizeCatalogSearchTokens('Washington D.C.'), ['washington', 'dc']), 'location terms normalize city/state punctuation');
  const boundedTokens = raceCourse.normalizeCatalogSearchTokens(Array.from({ length: 20 }, (_, index) => `token${index}`).join(' '));
  check(boundedTokens.length === raceCourse.CATALOG_SEARCH_MAX_TOKENS, 'catalog search caps normalized token count');
  const oversizedTokens = raceCourse.normalizeCatalogSearchTokens(`${'a'.repeat(raceCourse.CATALOG_SEARCH_MAX_INPUT_LENGTH)} late-token`);
  check(!oversizedTokens.includes('late') && oversizedTokens.every((token) => token.length <= 40), 'catalog search caps input and token size');

  await runRaceRouteSmoke();
  await runOpenAITimeoutSmoke();
  await runPlanFallbackSmoke();

  console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
  if (failed) process.exitCode = 1;
  else console.log('H8 BACKEND SMOKE OK');
}

run().catch((err) => {
  console.error('  FAIL: H8 backend smoke crashed:', err);
  process.exit(1);
});
