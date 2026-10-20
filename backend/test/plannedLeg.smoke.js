// All provider calls are mocked; HTTP is dispatched in memory (no listener).
// --postgres starts an isolated Unix-socket PostgreSQL cluster in /tmp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Duplex } = require('node:stream');
const { IncomingMessage, ServerResponse } = require('node:http');
const { createPlanner, PlanningError, validateInput, cacheKey, retrySeconds, MAX_BYTES, TTL_MS } = require('../src/services/plannedLeg');
const { createPlanningStore, installPlanningStore, DDL } = require('../src/db/plannedLegStore');
const SENTINEL = 'synthetic-ors-test-credential-only';
process.env.ORS_API_KEY = SENTINEL;
process.env.JWT_SECRET = 'synthetic-planning-jwt-only';
// Do not inherit a real database or make a provider request by accident.
delete process.env.DATABASE_URL;
let unexpectedFetch = 0;
global.fetch = async () => { unexpectedFetch++; throw new Error('LIVE_NETWORK_FORBIDDEN'); };
const input = { profile: 'foot-walking', points: [[12.1234567, 45.7654321], [12.1245678, 45.7665432]] };
const valid = () => ({ type: 'FeatureCollection', features: [{ type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[12.12346, 45.76543], [12.12457, 45.76654]] },
  properties: { summary: { distance: 200.5, duration: 123.4 }, secret: SENTINEL }, secret: SENTINEL }], secret: SENTINEL });
const response = (body = valid(), status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const errorIs = code => err => err.code === code;
let groups = 0;
function ok(name) { groups++; console.log(`PASS ${name}`); }
function sqliteFixture(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY)');
  let time = Date.parse('2026-10-20T12:00:00Z');
  const query = async (method, sql, args = []) => {
    if (sql.includes(' AS now_ms')) return { now_ms: time };
    return db.prepare(sql)[method](...args);
  };
  const tx = Object.fromEntries(['get', 'all', 'run'].map(m => [m, (sql, args) => query(m, sql, args)]));
  // Queue only the SQLite connection; PG uses independent real transactions.
  let tail = Promise.resolve();
  const transaction = (owner, fn) => {
    const job = tail.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (owner && !db.prepare('SELECT id FROM users WHERE id=?').get(owner)) throw new Error('ACCOUNT_DELETED');
        const result = await fn(tx); db.exec('COMMIT'); return result;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    });
    tail = job.catch(() => undefined);
    return job;
  };
  const adapter = { dbGet: tx.get, withUserMutation: transaction, runWithUserContext: (_owner, next) => next() };
  const store = createPlanningStore({ ...adapter, dialect: 'sqlite' });
  return { db, tx, adapter, store, install: () => transaction(null, installPlanningStore),
    setTime: n => { time = n; }, get time() { return time; },
    user: id => db.prepare('INSERT INTO users(id) VALUES (?) ON CONFLICT DO NOTHING').run(id) };
}
function inMemoryRequest(app, { body = JSON.stringify(input), token, url = '/api/route-planning/leg', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('In-memory request did not finish')), 3000);
    const buffers = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { buffers.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket);
    Object.assign(req, { method: 'POST', url, httpVersionMajor: 1, httpVersionMinor: 1, httpVersion: '1.1' });
    req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(guard);
      const raw = Buffer.concat(buffers).toString();
      const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      resolve({ status: res.statusCode, body: JSON.parse(payload), headers: res.getHeaders() });
      socket.destroy();
    });
    app.handle(req, res);
    req.complete = true;
    req.push(body); req.push(null);
  });
}
async function sqliteSuite() {
  const f = sqliteFixture();
  await f.install(); f.user('alice'); f.user('bob');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
  for (const sql of DDL) assert.ok(schema.includes(sql), 'fresh and upgrade DDL identical');
  let calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(url, `https://api.heigit.org/openrouteservice/v2/directions/${currentProfile}/geojson`);
    assert.equal(opts.headers.Authorization, SENTINEL);
    assert.equal(opts.redirect, 'error'); assert.equal(opts.method, 'POST');
    assert.ok(opts.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(JSON.parse(opts.body)).sort(), ['coordinates', 'elevation', 'instructions']);
    return response();
  };
  let currentProfile = 'foot-walking';
  const planner = createPlanner({ store: f.store, fetchImpl });
  const dbPath = require.resolve('../src/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: f.adapter };
  const express = require('express'), jwt = require('jsonwebtoken');
  const { createRouter } = require('../src/routes/routePlanning');
  const app = express();
  app.use('/api/route-planning', createRouter(planner));
  app.use(express.json({ limit: '10mb' }));
  const token = jwt.sign({ id: 'alice' }, process.env.JWT_SECRET);
  const request = opts => inMemoryRequest(app, { token, ...opts });
  assert.equal((await request({ token: null })).status, 401);
  assert.equal((await request({ token: 'invalid' })).status, 401);
  assert.equal((await request({ token: jwt.sign({ id: 'deleted' }, process.env.JWT_SECRET) })).status, 401);
  for (const bad of [null, [], {}, { ...input, host: 'https://evil.invalid' }, { ...input, options: {} },
    { ...input, profile: 'driving-car' }, { ...input, profile: 'foot-hiking/../../x' },
    { ...input, points: [...input.points, [0, 0]] }, { ...input, points: [input.points[0]] },
    ...[NaN, Infinity, -Infinity, '12', null, true, {}, 180.00001, -180.00001].map(n => ({ ...input, points: [[n, 0], [0, 0]] })),
    ...[90.00001, -90.00001, '0'].map(n => ({ ...input, points: [[0, n], [0, 0]] })),
    { ...input, points: [[1, 2, 3], [4, 5]] }]) {
    assert.throws(() => validateInput(bad), errorIs('INVALID_LEG'));
    assert.equal((await request({ body: JSON.stringify(bad) })).status, 400);
  }
  assert.equal((await request({ body: '{"profile":' })).status, 400);
  assert.equal((await request({ body: ' '.repeat(1025) })).status, 413);
  assert.equal((await request({ body: JSON.stringify(input) + ' '.repeat(1024) })).status, 413);
  assert.equal((await request({ headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await request({ headers: { 'content-encoding': 'gzip' } })).status, 400);
  assert.equal((await request({ url: '/api/route-planning/leg?key=synthetic' })).status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(validateInput({ ...input, points: [[-180, -90], [180, 90]] }).points, [[-180, -90], [180, 90]]);
  assert.deepEqual(validateInput({ ...input, points: [[-0.0000001, 0.0000001], [-1.123456, -2.123456]] }).points, [[0, 0], [-1.12346, -2.12346]]);
  for (const failure of [new Error(SENTINEL + JSON.stringify(input.points)), new PlanningError('PROVIDER_RATE_LIMITED', 429, 60)]) {
    const failureApp = express();
    failureApp.use('/api/route-planning', createRouter(async () => { throw failure; }));
    const result = await inMemoryRequest(failureApp, { token });
    assert.equal(result.status, failure instanceof PlanningError ? 429 : 503);
    assert.deepEqual(result.body, { error: failure instanceof PlanningError ? 'PROVIDER_RATE_LIMITED' : 'PLANNING_UNAVAILABLE' });
    assert.equal(result.headers['retry-after'], failure instanceof PlanningError ? '60' : undefined);
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
    assert.ok(!JSON.stringify(result).includes('12.1234567'));
  }
  ok('auth, strict body/profile/coordinate validation, 1 KiB parser and fixed contract');

  // A real persisted recorded-run row is never read or mutated by this service.
  f.db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,user_id TEXT,route_coords TEXT,route_integrity TEXT); INSERT INTO runs VALUES ('recorded','alice','[[1,2,111],[3,4,222]]','sampled-truth')");
  const truth = f.db.prepare('SELECT * FROM runs').all();
  const first = await request();
  assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'private, no-store');
  assert.equal(first.headers.vary, 'Authorization');
  assert.equal(first.body.status.cache, 'miss');
  assert.deepEqual(JSON.parse(calls[0].opts.body).coordinates, [[12.12346, 45.76543], [12.12457, 45.76654]]);
  assert.equal((await request()).body.status.cache, 'hit');
  assert.equal(calls.length, 1);
  const normalizedTwin = { ...input, points: [[12.123459, 45.765434], [12.124569, 45.766544]] };
  assert.equal((await planner('alice', normalizedTwin)).status.cache, 'hit');
  await planner('bob', input); assert.equal(calls.length, 2);
  await planner('alice', { ...input, points: [...input.points].reverse() }); assert.equal(calls.length, 3);
  currentProfile = 'foot-hiking';
  await planner('alice', { ...input, profile: currentProfile }); assert.equal(calls.length, 4);
  currentProfile = 'foot-walking';
  assert.notEqual(cacheKey('alice', validateInput(input)), cacheKey('bob', validateInput(input)));
  const budgetBefore = f.db.prepare('SELECT * FROM ors_planning_global').get();
  await planner('alice', input);
  assert.deepEqual(f.db.prepare('SELECT * FROM ors_planning_global').get(), budgetBefore);
  f.setTime(f.time + TTL_MS - 1);
  assert.equal((await planner('alice', input)).status.cache, 'hit');
  f.setTime(f.time + 1);
  assert.equal((await planner('alice', input)).status.cache, 'miss');
  assert.deepEqual(f.db.prepare('SELECT * FROM runs').all(), truth);
  assert.deepEqual(Object.keys(first.body).sort(), ['leg', 'status']);
  assert.deepEqual(Object.keys(first.body.leg).sort(), ['distanceMeters', 'durationSeconds', 'geometry', 'profile']);
  assert.ok(!JSON.stringify(first).includes(SENTINEL));
  assert.ok(!JSON.stringify(first).includes('12.1234567'), 'raw request precision is not reflected');
  ok('private result, owner/profile/order isolation, zero-cost hits, normalized key, exact TTL, recorded truth');

  let release; let upstream = 0;
  const waiting = createPlanner({ store: f.store, fetchImpl: async () => { upstream++; await new Promise(r => { release = r; }); return response(); } });
  const other = { ...input, points: [[1, 2], [3, 4]] };
  const jobs = Array.from({ length: 12 }, () => waiting('alice', other));
  while (!release) await new Promise(r => setImmediate(r));
  release(); await Promise.all(jobs); assert.equal(upstream, 1);
  ok('in-process duplicate coalescing');

  // Deterministic capacity and tie eviction, under the same DB lock as writers.
  f.db.exec('DELETE FROM ors_planning_cache');
  const payload = JSON.stringify(first.body.leg);
  const insert = f.db.prepare('INSERT INTO ors_planning_cache VALUES (?,?,?,?,?)');
  f.db.exec('BEGIN');
  for (let n = 0; n < 10000; n++) insert.run('bob', String(n).padStart(5, '0'), payload, f.time - 1, f.time - 1 + TTL_MS);
  f.db.exec('COMMIT');
  await f.store.save('alice', 'new', payload);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ors_planning_cache').get().n, 10000);
  assert.equal(f.db.prepare("SELECT * FROM ors_planning_cache WHERE user_id='bob' AND cache_key='00000'").get(), undefined);
  assert.ok(f.db.prepare("SELECT * FROM ors_planning_cache WHERE user_id='bob' AND cache_key='00001'").get());
  ok('deterministic 10000-entry global eviction cap');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ors-restart-'));
  const file = path.join(dir, 'db.sqlite');
  let disk = sqliteFixture(file); await disk.install(); disk.user('alice');
  await disk.store.reserve('alice'); await disk.store.save('alice', 'persist', payload);
  disk.db.close(); disk = sqliteFixture(file); await disk.install();
  assert.equal(await disk.store.lookup('alice', 'persist'), payload);
  assert.equal(disk.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 1);
  assert.equal(disk.db.prepare('SELECT day_count FROM ors_planning_users').get().day_count, 1);
  disk.db.exec('DELETE FROM ors_planning_global'); disk.db.close();
  disk = sqliteFixture(file); await disk.install();
  await assert.rejects(() => disk.store.reserve('alice'), errorIs('PLANNING_UNAVAILABLE'));
  disk.db.close(); fs.rmSync(dir, { recursive: true });
  ok('disk restart persistence and missing global state never replenished by migration');

  // Account deletion removes only its planning data; the shared budget survives.
  const globalBeforeDelete = f.db.prepare('SELECT * FROM ors_planning_global').get();
  f.db.prepare('DELETE FROM users WHERE id=?').run('bob');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ors_planning_cache WHERE user_id='bob'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ors_planning_users WHERE user_id='bob'").get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM ors_planning_global').get(), globalBeforeDelete);
  assert.deepEqual(f.db.prepare('SELECT * FROM runs').all(), truth);
  await budgetSuite();
  await failureSuite();
  f.db.close();
  assert.equal(unexpectedFetch, 0);
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.ok(appSource.indexOf("app.use('/api/route-planning'") < appSource.indexOf("app.use(express.json("));
  for (const filename of ['../src/services/plannedLeg.js', '../src/routes/routePlanning.js', '../src/db/plannedLegStore.js']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.doesNotMatch(source, /console\.|route_coords|ActiveRun|UPDATE runs|INSERT INTO runs|VITE_|OPENROUTESERVICE_API_KEY/);
  }
  ok('no live provider requests, logs, public key variable, or recorded-run write path');
}
async function budgetSuite() {
  const f = sqliteFixture(); await f.install();
  for (let i = 0; i < 30; i++) f.user(`u${i}`);
  for (let i = 0; i < 10; i++) await f.store.reserve('u0');
  await assert.rejects(() => f.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  f.setTime(f.time + 59999);
  await assert.rejects(() => f.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  f.setTime(f.time + 1); await f.store.reserve('u0');
  for (let minute = 2; minute < 11; minute++) {
    f.setTime(Date.parse('2026-10-20T12:00:00Z') + minute * 60000);
    for (let i = 0; i < (minute === 10 ? 9 : 10); i++) await f.store.reserve('u0');
  }
  assert.equal(f.db.prepare("SELECT day_count FROM ors_planning_users WHERE user_id='u0'").get().day_count, 100);
  await assert.rejects(() => f.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  f.setTime(Date.parse('2026-10-20T23:59:59.999Z'));
  await assert.rejects(() => f.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  f.setTime(Date.parse('2026-10-21T00:00:00Z'));
  await f.store.reserve('u0');
  assert.equal(f.db.prepare("SELECT day_count FROM ors_planning_users WHERE user_id='u0'").get().day_count, 1);
  for (let i = 1; i < 35; i++) await f.store.reserve(`u${1 + Math.floor((i - 1) / 10)}`);
  await assert.rejects(() => f.store.reserve('u29'), errorIs('PLANNING_LIMIT'));
  f.setTime(f.time + 60000); await f.store.reserve('u29');
  ok('actual per-user 10/minute and 100/day, global 35/minute, exact UTC resets');

  // Exercise all 1900 reservations, distributed below the per-user thresholds.
  const g = sqliteFixture(); await g.install();
  for (let i = 0; i < 20; i++) g.user(`u${i}`);
  for (let i = 0; i < 1900; i++) {
    g.setTime(Date.parse('2026-10-20T00:00:00Z') + Math.floor(i / 20) * 60000);
    await g.store.reserve(`u${i % 20}`);
  }
  assert.equal(g.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 1900);
  const cachedLeg = { profile: input.profile, geometry: valid().features[0].geometry, distanceMeters: 1, durationSeconds: 1 };
  await g.store.save('u0', cacheKey('u0', validateInput(input)), JSON.stringify(cachedLeg));
  const hitAtCap = await createPlanner({ store: g.store })('u0', input);
  assert.equal(hitAtCap.status.cache, 'hit');
  assert.equal(g.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 1900);
  await assert.rejects(() => g.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  g.setTime(Date.parse('2026-10-20T23:59:59.999Z'));
  await assert.rejects(() => g.store.reserve('u0'), errorIs('PLANNING_LIMIT'));
  g.setTime(Date.parse('2026-10-21T00:00:00Z')); await g.store.reserve('u0');
  assert.equal(g.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 1);
  g.setTime(g.time - 60000);
  await assert.rejects(() => g.store.reserve('u0'), errorIs('PLANNING_UNAVAILABLE'));
  g.db.close(); f.db.close();
  ok('actual global 1900/day headroom and backwards clock fails closed');
}
async function failureSuite() {
  const logs = [];
  const saved = Object.fromEntries(['log', 'warn', 'error'].map(k => [k, console[k]]));
  for (const k of Object.keys(saved)) console[k] = (...args) => logs.push(args.join(' '));
  try {
    for (const [label, factory, expected] of [
      ['provider auth', () => response({ error: SENTINEL }, 401), 'PLANNING_UNAVAILABLE'],
      ['forbidden', () => response({ error: SENTINEL }, 403), 'PLANNING_UNAVAILABLE'],
      ['redirect', () => response({}, 302), 'PROVIDER_UNAVAILABLE'],
      ['500', () => response({ coordinates: input.points }, 500), 'PROVIDER_UNAVAILABLE'],
      ['throw', () => { throw new Error(SENTINEL + JSON.stringify(input.points)); }, 'PLANNING_UNAVAILABLE'],
      ['malformed JSON', () => new Response('{oops'), 'INVALID_PROVIDER_RESPONSE'],
      ['empty', () => response({}), 'INVALID_PROVIDER_RESPONSE'],
      ['extra route', () => { const x = valid(); x.features.push(x.features[0]); return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['bad coordinate', () => { const x = valid(); x.features[0].geometry.coordinates[0][0] = 181; return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['string coordinate', () => { const x = valid(); x.features[0].geometry.coordinates[0][0] = '12'; return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['elevation surprise', () => { const x = valid(); x.features[0].geometry.coordinates[0].push(1); return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['negative summary', () => { const x = valid(); x.features[0].properties.summary.distance = -1; return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['too many geometry points', () => { const x = valid(); x.features[0].geometry.coordinates = Array(10001).fill([1,2]); return response(x); }, 'INVALID_PROVIDER_RESPONSE'],
      ['oversize declared', () => response(valid(), 200, { 'content-length': String(MAX_BYTES + 1) }), 'INVALID_PROVIDER_RESPONSE'],
      ['oversize streamed', () => new Response(' '.repeat(MAX_BYTES + 1)), 'INVALID_PROVIDER_RESPONSE'],
    ]) {
      const f = sqliteFixture(); await f.install(); f.user('alice'); let attempts = 0;
      const plan = createPlanner({ store: f.store, fetchImpl: async () => { attempts++; return factory(); } });
      let caught;
      try { await plan('alice', input); } catch (err) { caught = err; }
      assert.equal(caught?.code, expected, label); assert.equal(attempts, 1, `${label}: no retry/fallback`);
      assert.equal(f.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 1);
      assert.equal(f.db.prepare('SELECT day_count FROM ors_planning_users').get().day_count, 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ors_planning_cache').get().n, 0);
      assert.ok(!JSON.stringify(caught).includes(SENTINEL));
      assert.ok(!JSON.stringify(caught).includes('12.1234567'));
      f.db.close();
    }
    const f = sqliteFixture(); await f.install(); f.user('alice'); f.user('bob');
    let attempts = 0;
    const fetchImpl = async () => { attempts++; return response(); };
    for (const key of [undefined, '', ' ', ' short ', 'has\nnewlines-and-long-enough', 'x'.repeat(513), 'é'.repeat(40)]) {
      await assert.rejects(() => createPlanner({ store: f.store, fetchImpl, getKey: () => key })('alice', input), errorIs('PLANNING_UNAVAILABLE'));
    }
    assert.equal(attempts, 0); assert.equal(f.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 0);
    for (const unavailable of ['lookup', 'reserve']) {
      const store = { ...f.store, [unavailable]: async () => { throw new Error(SENTINEL); } };
      await assert.rejects(() => createPlanner({ store, fetchImpl })('alice', input), errorIs('PLANNING_UNAVAILABLE'));
    }
    assert.equal(attempts, 0);
    // Commit failure is indistinguishable from unknown reservation state: no fetch.
    const uncertainStore = { ...f.store, reserve: async owner => { await f.store.reserve(owner); throw new Error('commit outcome unknown'); } };
    await assert.rejects(() => createPlanner({ store: uncertainStore, fetchImpl })('alice', input), errorIs('PLANNING_UNAVAILABLE'));
    assert.equal(attempts, 0);
    let fire, observedSignal;
    const timed = createPlanner({ store: f.store, fetchImpl: async (_url, opts) => {
      attempts++; observedSignal = opts.signal; return new Promise(() => {});
    }, setTimer: (fn, ms) => { assert.equal(ms, 8000); fire = fn; return 1; }, clearTimer: id => assert.equal(id, 1) });
    const pending = timed('alice', input);
    while (!fire || !observedSignal) await new Promise(r => setImmediate(r));
    fire(); await assert.rejects(() => pending, errorIs('PROVIDER_TIMEOUT'));
    assert.equal(observedSignal.aborted, true); assert.equal(attempts, 1);
    // Deadline also covers a hung response body, not just response headers.
    fire = null;
    const bodyTimeout = createPlanner({ store: f.store, fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
      setTimer: fn => { fire = fn; return 1; }, clearTimer: () => {} });
    const slowBody = bodyTimeout('alice', input);
    while (!fire) await new Promise(r => setImmediate(r));
    fire(); await assert.rejects(() => slowBody, errorIs('PROVIDER_TIMEOUT'));
    const throttled = createPlanner({ store: f.store, fetchImpl: async () => { attempts++; return response({}, 429, { 'retry-after': '120' }); } });
    await assert.rejects(() => throttled('alice', input), err => err.code === 'PROVIDER_RATE_LIMITED' && err.retryAfter === 120);
    const before = attempts;
    assert.equal(f.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, 4,
      'uncertain commit, header timeout, body timeout and 429 all count');
    const otherInstance = createPlanner({ store: createPlanningStore({ ...f.adapter, dialect: 'sqlite' }), fetchImpl });
    await assert.rejects(() => otherInstance('bob', input), err => err.code === 'PROVIDER_RATE_LIMITED' && err.retryAfter === 120);
    assert.equal(attempts, before);
    f.setTime(f.time + 119999);
    await assert.rejects(() => otherInstance('bob', input), errorIs('PROVIDER_RATE_LIMITED'));
    f.setTime(f.time + 1); await otherInstance('bob', input);
    assert.equal(attempts, before + 1);
    for (const [value, expected] of [[null,60], ['garbage',60], ['-1',60], ['0',60], ['9999999999',86400], ['120',120],
      [new Date(f.time + 180000).toUTCString(),180], [new Date(f.time - 100000).toUTCString(),60], [SENTINEL,60]]) {
      assert.equal(retrySeconds(value, f.time), expected);
    }
    // Saving an otherwise-valid plan can fail; its attempt still counts.
    const countBeforeSaveFailure = f.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count;
    await assert.rejects(() => createPlanner({ store: { ...f.store, save: async () => { throw new Error(SENTINEL); } }, fetchImpl })(
      'alice', { ...input, points: [[4,5],[6,7]] }), errorIs('PLANNING_UNAVAILABLE'));
    assert.equal(f.db.prepare('SELECT day_count FROM ors_planning_global').get().day_count, countBeforeSaveFailure + 1);
    // Persisted corruption never becomes a fresh upstream attempt.
    const key = cacheKey('bob', validateInput(input));
    f.db.prepare('UPDATE ors_planning_cache SET payload=? WHERE user_id=? AND cache_key=?').run('{bad', 'bob', key);
    const snapshot = attempts;
    await assert.rejects(() => otherInstance('bob', input), errorIs('PLANNING_UNAVAILABLE'));
    assert.equal(attempts, snapshot);
    f.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE ors_planning_global SET day_count=-1');
    await assert.rejects(() => otherInstance('alice', input), errorIs('PLANNING_UNAVAILABLE'));
    f.db.close();
  } finally { Object.assign(console, saved); }
  assert.deepEqual(logs, []);
  ok('failure reservations, malformed bounded responses, credentials, DB uncertainty, 8s deadlines, persisted 429/backoff, redaction and no retry');
}
async function postgresSuite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ors-pg-'));
  let started = false;
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), LC_ALL: 'C' } });
    if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr}`);
    return r;
  };
  try {
    run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'synthetic_ors', '--no-locale']);
    run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'), '-o', `-k ${dir} -h '' -p 55439`, '-w', 'start']);
    started = true;
    process.env.DATABASE_URL = `postgresql://synthetic_ors@localhost/postgres?host=${encodeURIComponent(dir)}&port=55439`;
    delete require.cache[require.resolve('../src/db')];
    const adapter = require('../src/db');
    await adapter.dbRun('CREATE TABLE users(id TEXT PRIMARY KEY)');
    await adapter.withTransaction(installPlanningStore);
    for (let i = 0; i < 12; i++) await adapter.dbRun('INSERT INTO users VALUES (?)', [`u${i}`]);
    const realTime = await createPlanningStore(adapter).now();
    assert.ok(Number.isSafeInteger(realTime) && realTime > 0, 'production clock SQL returns epoch milliseconds');
    // Freeze only the clock for deterministic boundary races; locks, commits,
    // rollback, row counts and all budget/cache SQL remain real PostgreSQL.
    const frozen = db => ({ ...db, withUserMutation: (owner, fn) => db.withUserMutation(owner, tx => fn({ ...tx,
      get: (sql, args) => sql.includes(' AS now_ms') ? Promise.resolve({ now_ms: 1792497600000 }) : tx.get(sql, args),
    })) });
    const stores = Array.from({ length: 6 }, () => createPlanningStore(frozen(adapter)));
    const results = await Promise.allSettled(Array.from({ length: 80 }, (_, i) => stores[i % 6].reserve(`u${i % 12}`)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 35);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'PLANNING_LIMIT'));
    assert.equal((await adapter.dbGet('SELECT day_count FROM ors_planning_global')).day_count, 35);
    await adapter.dbRun('UPDATE ors_planning_global SET minute_count=0');
    const personal = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => stores[i % 6].reserve('u11')));
    const u = await adapter.dbGet('SELECT * FROM ors_planning_users WHERE user_id=?', ['u11']);
    assert.equal(u.minute_count, 10);
    assert.ok(personal.some(r => r.status === 'rejected'));
    // Global day boundary with overlapping writers must admit exactly one.
    await adapter.dbRun('UPDATE ors_planning_global SET day_count=1899, minute_count=0');
    await adapter.dbRun('UPDATE ors_planning_users SET minute_count=0');
    const last = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => stores[i % 6].reserve(`u${i % 12}`)));
    assert.equal(last.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await adapter.dbGet('SELECT day_count FROM ors_planning_global')).day_count, 1900);
    await adapter.withTransaction(installPlanningStore);
    assert.equal((await adapter.dbGet('SELECT day_count FROM ors_planning_global')).day_count, 1900);
    const source = require('../src/services/plannedLeg');
    const leg = { profile: 'foot-walking', geometry: valid().features[0].geometry, distanceMeters: 1, durationSeconds: 1 };
    source.validateLeg(leg);
    await stores[0].save('u0', 'pg-cache', JSON.stringify(leg));
    assert.equal(await stores[1].lookup('u0', 'pg-cache'), JSON.stringify(leg));
    assert.equal(await stores[1].lookup('u1', 'pg-cache'), null);
    // Reconnect/recreate pools without reseeding counters or cache.
    await adapter.pool.end();
    run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']);
    started = false;
    run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'), '-o', `-k ${dir} -h '' -p 55439`, '-w', 'start']);
    started = true;
    delete require.cache[require.resolve('../src/db')];
    const restarted = require('../src/db');
    assert.equal((await restarted.dbGet('SELECT day_count FROM ors_planning_global')).day_count, 1900);
    assert.equal(await createPlanningStore(frozen(restarted)).lookup('u0', 'pg-cache'), JSON.stringify(leg));
    await restarted.pool.end();
    ok('real PostgreSQL parallel instances: minute/user/day atomic boundaries, upgrade/server-restart persistence and owner cache');
  } finally {
    if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(process.argv.includes('--postgres') ? postgresSuite() : sqliteSuite())
  .then(() => console.log(`Planned leg smoke OK (${groups} groups; zero live provider requests).`))
  .catch(err => { console.error(err); process.exitCode = 1; });
