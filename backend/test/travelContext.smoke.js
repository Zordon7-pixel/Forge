// Phase B deterministic travel-context policy and authenticated route smoke.
// Run: node backend/test/travelContext.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  MAX_CURRENT_ACCURACY_METERS,
  MAX_HISTORY_ROWS,
  MAX_ROUTE_BYTES,
  classifyTravelContext,
  historicalStart,
  inferHomeAnchor,
  validateTravelContextInput,
} = require('../src/lib/travelContext');

const TODAY = '2026-08-04';
const DC = { latitude: 38.9072, longitude: -77.0369 };
const NYC = { latitude: 40.7128, longitude: -74.0060 };
const LA = { latitude: 34.0522, longitude: -118.2437 };

function routeRow(latitude, longitude, format = 'object') {
  const points = format === 'array'
    ? [[latitude, longitude], [latitude + 0.001, longitude + 0.001]]
    : [{ lat: latitude, lon: longitude }, { lat: latitude + 0.001, lng: longitude + 0.001 }];
  return { route_coords: JSON.stringify(points) };
}

const homeRows = [
  routeRow(38.9072, -77.0369),
  routeRow(38.9140, -77.0280, 'array'),
  routeRow(38.8980, -77.0440),
  routeRow(38.9030, -77.0500),
];

const away = classifyTravelContext({ ...NYC, accuracyMeters: 25 }, homeRows);
assert.deepEqual(away, {
  status: 'away', confidence: 'high', distanceBand: 'over_150_miles', reason: 'confirmed_away_from_home',
});
const home = classifyTravelContext({ ...DC, accuracyMeters: 25 }, homeRows);
assert.deepEqual(home, {
  status: 'home', confidence: 'high', distanceBand: 'within_15_miles', reason: 'within_home_training_area',
});
assert.equal(classifyTravelContext({ latitude: 39.2904, longitude: -76.6122, accuracyMeters: 25 }, homeRows).status, 'unknown',
  'a location between the home and away thresholds must remain unknown');
assert.deepEqual(classifyTravelContext({ ...NYC, accuracyMeters: MAX_CURRENT_ACCURACY_METERS + 1 }, homeRows), {
  status: 'unknown', confidence: 'none', distanceBand: 'unknown', reason: 'poor_current_accuracy',
});
assert.equal(classifyTravelContext({ ...NYC, accuracyMeters: 25 }, homeRows.slice(0, 2)).reason, 'insufficient_home_history');

const splitHistory = [
  ...homeRows.slice(0, 3),
  routeRow(LA.latitude, LA.longitude),
  routeRow(LA.latitude + 0.01, LA.longitude + 0.01),
  routeRow(LA.latitude - 0.01, LA.longitude - 0.01),
];
assert.equal(inferHomeAnchor(splitHistory).reason, 'no_dominant_home_cluster',
  'equal clusters must not guess which location is home');

const malformed = [
  { route_coords: '{not-json' },
  { route_coords: JSON.stringify([{ lat: 999, lon: 0 }, { lat: 0, lon: 0 }]) },
  { route_coords: JSON.stringify([{ lat: '38.9', lon: '-77.0' }, { lat: 38.901, lon: -77.001 }]) },
  { route_coords: JSON.stringify([{ lat: DC.latitude, lon: DC.longitude }]) },
  { route_coords: 'x'.repeat(256001) },
];
assert.equal(historicalStart(malformed[0]), null);
assert.equal(historicalStart(malformed[1]), null);
assert.equal(historicalStart(malformed[2]), null);
assert.equal(historicalStart(malformed[3]), null);
assert.equal(historicalStart(malformed[4]), null);
assert.equal(classifyTravelContext({ ...NYC, accuracyMeters: 25 }, [...malformed, ...homeRows]).status, 'away',
  'malformed routes must be ignored without poisoning valid history');

const validInput = validateTravelContextInput({
  latitude: NYC.latitude, longitude: NYC.longitude, accuracy_meters: 25, date: TODAY,
});
assert.deepEqual(validInput.value, { ...NYC, accuracyMeters: 25, date: TODAY });
for (const invalid of [
  { latitude: '40.7', longitude: NYC.longitude, accuracy_meters: 25, date: TODAY },
  { latitude: 91, longitude: NYC.longitude, accuracy_meters: 25, date: TODAY },
  { latitude: NYC.latitude, longitude: -181, accuracy_meters: 25, date: TODAY },
  { latitude: NYC.latitude, longitude: NYC.longitude, accuracy_meters: -1, date: TODAY },
  { latitude: NYC.latitude, longitude: NYC.longitude, accuracy_meters: 100001, date: TODAY },
  { latitude: NYC.latitude, longitude: NYC.longitude, accuracy_meters: 25, date: '2026-02-30' },
]) {
  assert.ok(validateTravelContextInput(invalid).error, `invalid input must be rejected: ${JSON.stringify(invalid)}`);
}

function routeLayer(router) {
  return router.stack.find((item) => item.route?.path === '/' && item.route?.methods?.post)?.route;
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

async function routeBoundarySmoke() {
  const dbModulePath = require.resolve('../src/db');
  const routeModulePath = require.resolve('../src/routes/travelContext');
  const authModulePath = require.resolve('../src/middleware/auth');
  const originalDb = require.cache[dbModulePath];
  const originalRoute = require.cache[routeModulePath];
  const queries = [];

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      dbAll: async (sql, params) => {
        queries.push({ sql, params });
        return params[0] === 'owner' ? homeRows : [];
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[routeModulePath];

  try {
    const auth = require(authModulePath);
    const router = require('../src/routes/travelContext');
    const route = routeLayer(router);
    assert.ok(route, 'POST / travel-context route must be registered');
    assert.equal(route.stack[0]?.handle, auth, 'travel-context route must require auth middleware');
    const handler = route.stack.at(-1).handle;
    const body = { latitude: NYC.latitude, longitude: NYC.longitude, accuracy_meters: 25, date: TODAY };

    let result = await invoke(handler, { user: { id: 'owner' }, body });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.status, 'away');
    assert.deepEqual(Object.keys(result.payload).sort(), ['confidence', 'distanceBand', 'reason', 'status'],
      'the endpoint must not return raw or inferred coordinates');
    assert.match(queries[0].sql, /WHERE user_id=\? AND date<\?/);
    assert.match(queries[0].sql, /duration_seconds>0 AND distance_miles>0/);
    assert.match(queries[0].sql, /LENGTH\(route_coords\)<=\?/);
    assert.deepEqual(queries[0].params, ['owner', TODAY, MAX_ROUTE_BYTES, MAX_HISTORY_ROWS]);

    result = await invoke(handler, { user: { id: 'different-owner' }, body });
    assert.equal(result.payload.reason, 'insufficient_home_history', 'history must be isolated by authenticated owner');
    assert.deepEqual(queries[1].params, ['different-owner', TODAY, MAX_ROUTE_BYTES, MAX_HISTORY_ROWS]);

    const queryCount = queries.length;
    result = await invoke(handler, { user: { id: 'owner' }, body: { ...body, latitude: '40.7' } });
    assert.equal(result.statusCode, 400);
    assert.equal(queries.length, queryCount, 'invalid coordinate types must be rejected before database access');
  } finally {
    delete require.cache[routeModulePath];
    if (originalRoute) require.cache[routeModulePath] = originalRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }

  const appSource = fs.readFileSync(require.resolve('../src/app'), 'utf8');
  assert.match(appSource, /app\.use\('\/api\/travel-context', require\('\.\/routes\/travelContext'\)\)/);
}

routeBoundarySmoke()
  .then(() => console.log('TRAVEL CONTEXT PHASE B SMOKE OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
