// Synthetic routes only; actual Strava handlers/SQL, in-memory SQLite, no network or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const activity = require('../src/lib/stravaActivity');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE runs (
  id TEXT PRIMARY KEY, user_id TEXT, date TEXT, type TEXT, distance_miles REAL,
  duration_seconds INTEGER, perceived_effort INTEGER, calories REAL, notes TEXT,
  watch_mode TEXT, watch_activity_type TEXT, watch_normalized_type TEXT,
  health_source TEXT, health_source_workout_id TEXT, health_start_at TEXT,
  health_end_at TEXT, avg_heart_rate REAL, elevation_gain REAL, route_coords TEXT,
  workout_metrics_json TEXT
); CREATE TABLE strava_tokens (user_id TEXT, connected_at TEXT);`);
const tx = {
  get: async (sql, params) => db.prepare(sql).get(...params),
  all: async (sql, params) => db.prepare(sql).all(...params),
  run: async (sql, params) => db.prepare(sql.replaceAll('NOW()', 'CURRENT_TIMESTAMP')).run(...params),
};
const router = { get() {}, post() {}, delete() {} };
let providerFetch = async () => { throw new Error('Unexpected provider call'); };
const filename = path.join(__dirname, '../src/routes/strava.js');
const requireRoute = createRequire(filename);
const sandbox = {
  module: { exports: {} }, console, URL, Buffer, process: { env: {} },
  fetch: (...args) => providerFetch(...args),
  require(id) {
    if (id === 'express') return { Router: () => router };
    if (id === 'express-rate-limit') return () => () => {};
    if (id === '../db') return {
      dbRun: async (sql) => { assert.match(sql, /^\s*CREATE TABLE IF NOT EXISTS strava_tokens/); },
      withPlanningInputMutation: async (_owner, work) => work(tx),
    };
    if (id === '../middleware/auth') return () => { throw new Error('HTTP auth is outside this fixture'); };
    if (id === '../services/prAuto') return async () => {};
    if (id === '../services/notifications') return {};
    if (id === '../lib/planningRevision') return { planningInputUnchanged: value => value };
    if (id === 'crypto' || id === '../lib/stravaActivity' || id === '../lib/stravaWebhook' || id === '../lib/runPostRun') return requireRoute(id);
    throw new Error(`Unexpected module: ${id}`);
  },
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { enrichRunFromStrava, syncStravaActivitiesForUser, hydrateMissingStravaRoutes };', sandbox, { filename });
const { enrichRunFromStrava, syncStravaActivitiesForUser, hydrateMissingStravaRoutes } = sandbox.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const polyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const upstream = { id: 12345, type: 'Run', start_date: '2026-10-23T10:00:00Z',
  distance: 5000, moving_time: 1800, elapsed_time: 1800, map: { summary_polyline: polyline } };
const incoming = activity.normalizeStravaRun(upstream);
const segment = (gap, lon) => ({ gap, points: [
  { lat: 40, lon, time: 1800000000000, accuracy: 4 },
  { lat: 40.001, lon, time: 1800000030000, accuracy: 4 },
] });
function seed(id, owner, route) {
  db.prepare(`INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds,
    health_source, health_start_at, route_coords, workout_metrics_json)
    VALUES (?, ?, ?, 'easy', ?, ?, 'forged_hybrid', ?, ?, ?)`)
    .run(id, owner, incoming.date, incoming.distanceMiles, incoming.movingSeconds,
      incoming.startDate, JSON.stringify(route), JSON.stringify({ gps_source: 'native_bg', route_source: 'forged_phone' }));
}
const row = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);

async function main() {
  // RED witness: the existing version-2 envelope must not be mistaken for an absent route.
  for (const reason of [null, 'manual-pause', 'timeout', 'background', 'foreground', 'restore']) {
    for (const decoded of [false, true]) {
      db.exec('DELETE FROM runs');
      const route = { version: 2, segments: [segment(null, -74)] };
      if (reason) route.segments.push(segment({ kind: 'gps-gap', reason }, -73.99));
      seed('canonical', 'owner', route);
      seed('foreign', 'other', route);
      const before = row('canonical');
      const foreignBefore = row('foreign');
      const query = decoded ? { ...tx, get: async (...args) => {
        const value = await tx.get(...args);
        return value ? { ...value, route_coords: JSON.parse(value.route_coords) } : value;
      } } : tx;
      const result = await enrichRunFromStrava('owner', 'canonical', incoming, query);
      assert.equal(Number(result.changes), 0, 'an existing segmented canonical route must not be overwritten by Strava');
      assert.deepEqual(row('canonical'), before, 'coordinates, gap markers, timestamps and phone provenance survive byte-for-byte');
      const metrics = { ...incoming, averageHeartRate: 145, elevationGainFeet: 50, perceivedEffort: 6, calories: 300 };
      await enrichRunFromStrava('owner', 'canonical', metrics, query);
      assert.equal(row('canonical').route_coords, before.route_coords, 'missing metrics can enrich without replacing the route');
      assert.equal(row('canonical').avg_heart_rate, 145);
      assert.equal(row('canonical').elevation_gain, 50);
      assert.equal(JSON.parse(row('canonical').workout_metrics_json).gps_source, 'native_bg');
      assert.equal(Number((await enrichRunFromStrava('owner', 'canonical', metrics, query)).changes), 0, 'identical enrichment is a no-op');
      assert.equal(Number((await enrichRunFromStrava('owner', 'foreign', metrics, query)).changes), 0);
      assert.deepEqual(row('foreign'), foreignBefore, 'foreign owner remains unchanged');
      const synced = await syncStravaActivitiesForUser('owner', [upstream]);
      assert.deepEqual(plain(synced.runIds), ['canonical']);
      assert.equal(synced.imported, 0);
      assert.equal(synced.enriched, 0);
      assert.equal(row('canonical').route_coords, before.route_coords, 'full sync preserves the segmented canonical route');
      assert.deepEqual(row('foreign'), foreignBefore);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 2, 'sync adds no duplicate');
    }
  }
  console.log('PASS segmented canonical routes: complete/gapped, JSON/decoded, metric-only enrichment, replay and owner isolation');

  for (const route of [null, [], { version: 2, segments: [] }, incoming.routeCoords]) {
    db.exec('DELETE FROM runs');
    seed('canonical', 'owner', route);
    const result = await syncStravaActivitiesForUser('owner', [upstream]);
    assert.equal(result.imported, 0);
    assert.deepEqual(plain(result.runIds), ['canonical'], 'canonical ID survives enrichment');
    assert.deepEqual(JSON.parse(row('canonical').route_coords), incoming.routeCoords);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
    assert.equal((await syncStravaActivitiesForUser('owner', [upstream])).enriched, 0);
  }
  db.exec('DELETE FROM runs');
  assert.equal((await syncStravaActivitiesForUser('owner', [upstream])).imported, 1);
  assert.equal((await syncStravaActivitiesForUser('owner', [upstream])).imported, 0);
  assert.deepEqual(JSON.parse(row('strava_owner_12345').route_coords), incoming.routeCoords);
  console.log('PASS existing sync: missing-route backfill, legacy preservation, canonical ID, polyline import and duplicate retry');

  let lookups = [];
  providerFetch = async url => {
    lookups.push(new URL(url));
    return { ok: true, json: async () => ({ latlng: { data: [[40, -74], [40.001, -74.001]] },
      altitude: { data: [10, 12] }, time: { data: [0, 30] } }) };
  };
  const missing = Array.from({ length: 5 }, (_, index) => ({ ...upstream, id: 200 + index, map: {} }));
  const hydrated = await hydrateMissingStravaRoutes([upstream, { ...missing[0], trainer: true }, ...missing], 'synthetic-only');
  assert.equal(lookups.length, 3, 'at most three missing-route stream lookups');
  assert.equal(hydrated.filter(item => item.routeCoords?.length === 2).length, 3);
  assert.ok(lookups.every(url => url.searchParams.get('keys') === 'latlng,altitude,time' && url.searchParams.get('key_by_type') === 'true'));
  assert.equal(hydrated[2].routeCoords[1].alt, 12);
  assert.equal(hydrated[2].routeCoords[1].time, '2026-10-23T10:00:30.000Z');
  lookups = [];
  providerFetch = async url => { lookups.push(url); return { ok: false, status: 429, json: async () => ({ message: 'synthetic rate limit' }) }; };
  await hydrateMissingStravaRoutes(missing, 'synthetic-only');
  assert.equal(lookups.length, 1, 'rate limit stops stream fallback');
  providerFetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'synthetic expired token' }) });
  await assert.rejects(hydrateMissingStravaRoutes(missing, 'synthetic-only'), error => error.status === 401);
  console.log('PASS bounded mocked streams: polyline/trainer skip, GPS/altitude/time, three-lookups cap, 429 stop and 401 propagation');
}
main().then(() => db.close()).catch(error => { db.close(); console.error(error); process.exitCode = 1; });
