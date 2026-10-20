// Synthetic fixtures only. No TCP listener, dotenv, application DB or provider.
// --postgres uses an isolated disposable Unix-socket cluster under /tmp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Duplex } = require('node:stream');
const http = require('node:http');
const https = require('node:https');
const { parseStringPromise } = require('xml2js');
const { DDL, installUserRoutes, createUserRoutesStore } = require('../src/db/userRoutesStore');
const { MAX_BYTES, MAX_POINTS, validateRoute, toGpx } = require('../src/lib/userRoutes');
const { ACCOUNT_EXPORT_TABLES, ACCOUNT_DELETE_QUERIES, buildExportSql } = require('../src/lib/accountDataCoverage');

delete process.env.DATABASE_URL;
process.env.JWT_SECRET = 'synthetic-user-routes-test-only';
let networkAttempts = 0;
const forbidNetwork = () => { networkAttempts++; throw new Error('NETWORK_FORBIDDEN'); };
global.fetch = forbidNetwork;
http.request = http.get = https.request = https.get = forbidNetwork;
let groups = 0;
const ok = name => { groups++; console.log(`PASS ${name}`); };
const clone = value => structuredClone(value);
const example = () => ({
  name: 'River <Loop> & "Bridge" 🏃',
  waypoints: [[12, 45], [12.002, 45.003], [12.003, 45.004]],
  geometry: { type: 'LineString', coordinates: [[12, 45, 0], [12.001, 45.002, null], [12.002, 45.003, -12], [12.003, 45.004]] },
  legs: [
    { mode: 'routed', provenance: 'ors', profile: 'foot-walking', startIndex: 0, endIndex: 2 },
    { mode: 'straight', provenance: 'manual', profile: null, startIndex: 2, endIndex: 3 },
  ],
  distanceMeters: 543.21, targetDistanceMeters: 600,
  elevation: { source: 'imported', gainMeters: null, lossMeters: null },
  display: { description: 'Synthetic planning fixture', surface: 'mixed', elevationPreference: null },
});
function request(app, { method = 'GET', url = '/api/user-routes', token, body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const content = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const timer = setTimeout(() => reject(new Error('In-memory request timed out')), 5000);
    const buffers = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { buffers.push(Buffer.from(chunk)); done(); } });
    const req = new http.IncomingMessage(socket);
    Object.assign(req, { method, url, httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1 });
    req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(content)),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', err => { clearTimeout(timer); reject(err); });
    res.on('finish', () => {
      clearTimeout(timer);
      const rawResponse = Buffer.concat(buffers).toString();
      const text = rawResponse.slice(rawResponse.indexOf('\r\n\r\n') + 4);
      const responseHeaders = res.getHeaders();
      resolve({ status: res.statusCode, headers: responseHeaders, text,
        body: responseHeaders['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      socket.destroy();
    });
    app.handle(req, res);
    req.complete = true; req.push(content); req.push(null);
  });
}
function sqliteFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const tx = Object.fromEntries(['get', 'all', 'run'].map(method => [
    method, async (sql, params = []) => sqlite.prepare(sql)[method](...params),
  ]));
  let tail = Promise.resolve();
  const withUserMutation = (owner, fn) => {
    const job = tail.then(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        if (!await tx.get('SELECT id FROM users WHERE id=?', [owner])) throw new Error('AUTH_ACCOUNT_DELETED');
        const result = await fn(tx);
        sqlite.exec('COMMIT'); return result;
      } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
    });
    tail = job.catch(() => undefined);
    return job;
  };
  return { adapter: { dbGet: tx.get, dbAll: tx.all, dbRun: tx.run, withUserMutation,
    runWithUserContext: (_owner, fn) => fn() }, close: () => sqlite.close() };
}
async function suite(adapter, dialect) {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(appSource.indexOf("app.use('/api/user-routes'") < appSource.indexOf("express.json({ limit: '10mb' })"));
  assert.match(migration, /await require\('\.\/userRoutesStore'\)\.installUserRoutes\(tx\)/);
  await adapter.dbRun('CREATE TABLE users(id TEXT PRIMARY KEY)');
  for (const owner of ['alice', 'bob']) await adapter.dbRun('INSERT INTO users(id) VALUES (?)', [owner]);
  // Model preexisting app state, including public routes and recorded truth.
  for (const table of ['shared_routes', 'runs', 'user_plans', 'personal_records', 'activity_measured_receipts']) {
    await adapter.dbRun(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,user_id TEXT,payload TEXT)`);
    await adapter.dbRun(`INSERT INTO ${table} VALUES (?,?,?)`, ['preexisting', 'alice', 'unchanged-sampled-or-training-truth']);
  }
  for (const sql of DDL) {
    assert.ok(schema.includes(sql), 'fresh and additive schemas are identical');
    assert.doesNotMatch(sql, /\b(?:ALTER|DROP|INSERT|UPDATE|DELETE FROM)\b/i);
    await adapter.dbRun(sql); // fresh schema path
  }
  const protectedRows = {};
  for (const table of ['shared_routes', 'runs', 'user_plans', 'personal_records', 'activity_measured_receipts']) {
    protectedRows[table] = await adapter.dbAll(`SELECT * FROM ${table}`);
  }
  ok(`${dialect}: fresh DDL, additive startup registration and existing-data preservation`);

  const sqlAudit = [];
  let failAfterWrite = false;
  const record = async (method, sql, params = []) => {
    sqlAudit.push({ sql, params: clone(params) });
    return adapter[method](sql, params);
  };
  const db = { ...adapter,
    dbGet: (sql, params) => record('dbGet', sql, params),
    dbAll: (sql, params) => record('dbAll', sql, params),
    withUserMutation: (owner, fn) => adapter.withUserMutation(owner, tx => fn(Object.fromEntries(
      ['get', 'all', 'run'].map(method => [method, async (sql, params = []) => {
        sqlAudit.push({ sql, params: clone(params) });
        const result = await tx[method](sql, params);
        if (method === 'run' && failAfterWrite) throw new Error('Failure after writing private [12,45]');
        return result;
      }]),
    ))),
  };
  const dbPath = require.resolve('../src/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  const express = require('express'), jwt = require('jsonwebtoken');
  const { createRouter } = require('../src/routes/userRoutes');
  const app = express();
  app.use('/api/user-routes', createRouter(createUserRoutesStore(db)));
  app.use(express.json({ limit: '10mb' }));
  const alice = jwt.sign({ id: 'alice' }, process.env.JWT_SECRET);
  const bob = jwt.sign({ id: 'bob' }, process.env.JWT_SECRET);
  const call = options => request(app, { token: alice, ...options });
  for (const options of [{}, { url: '/api/user-routes/00000000-0000-0000-0000-000000000000' },
    { method: 'POST', body: example() }, { method: 'PUT', url: '/api/user-routes/00000000-0000-0000-0000-000000000000', body: example() },
    { method: 'DELETE', url: '/api/user-routes/00000000-0000-0000-0000-000000000000' },
    { url: '/api/user-routes/00000000-0000-0000-0000-000000000000/gpx' }]) {
    for (const token of [null, 'invalid', jwt.sign({ id: 'deleted' }, process.env.JWT_SECRET)]) {
      assert.equal((await call({ ...options, token })).status, 401);
    }
  }
  const created = await call({ method: 'POST', body: example() });
  assert.equal(created.status, 201);
  const route = created.body.route, id = route.id, url = `/api/user-routes/${id}`;
  assert.equal(created.headers.location, url);
  assert.equal(created.headers['cache-control'], 'private, no-store');
  assert.equal(created.headers.vary, 'Authorization');
  assert.equal(route.kind, 'planned');
  assert.equal(route.provenanceTrust, 'client_declared');
  assert.equal(route.elevation.coverage, 'partial');
  assert.equal(route.elevation.gainMeters, null);
  assert.equal(route.elevation.lossMeters, null);
  assert.deepEqual(route.geometry, example().geometry);
  assert.deepEqual(route.legs, example().legs);
  assert.deepEqual(route.waypoints, example().waypoints);
  assert.equal(route.user_id, undefined);
  assert.ok(Number.isFinite(Date.parse(route.createdAt)));
  assert.equal((await call({ url })).body.route.id, id);
  const mine = await call({});
  assert.deepEqual(mine.body.routes.map(r => r.id), [id]);
  assert.equal(mine.body.routes[0].geometry, undefined);
  assert.equal((await call({ token: bob })).body.routes.length, 0);
  const bobCreated = await call({ method: 'POST', body: example(), token: bob });
  assert.equal(bobCreated.status, 201);
  for (const options of [{ url }, { url: `${url}/gpx` }, { url, method: 'PUT', body: example() }, { url, method: 'DELETE' }]) {
    const crossUser = await call({ ...options, token: bob });
    const absent = await call({ ...options, token: bob, url: options.url.replace(id, '00000000-0000-0000-0000-000000000000') });
    assert.equal(crossUser.status, 404);
    assert.deepEqual(crossUser.body, absent.body);
    assert.ok(!crossUser.text.includes(route.name));
  }
  const beforeUpgrade = await adapter.dbAll('SELECT * FROM user_routes ORDER BY id');
  await installUserRoutes({ run: adapter.dbRun });
  await installUserRoutes({ run: adapter.dbRun });
  assert.deepEqual(await adapter.dbAll('SELECT * FROM user_routes ORDER BY id'), beforeUpgrade);
  ok(`${dialect}: authenticated CRUD ownership, uniform cross-user 404, idempotent upgrade retains routes`);

  const invalid = [];
  for (const number of [null, '12', true, {}, [], NaN, Infinity, -Infinity, 180.00001, -180.00001]) {
    const bad = example(); bad.geometry.coordinates[0][0] = number; invalid.push(bad);
    const waypoint = example(); waypoint.waypoints[0][0] = number; invalid.push(waypoint);
  }
  for (const latitude of [90.0001, -90.0001, null, '45']) {
    const bad = example(); bad.geometry.coordinates[0][1] = latitude; invalid.push(bad);
  }
  for (const altitude of ['0', false, {}, 100001, -2001, NaN, Infinity]) {
    const bad = example(); bad.geometry.coordinates[0][2] = altitude;
    assert.throws(() => validateRoute(bad));
    // JSON's NaN/Infinity become null (honest missing) on the wire.
    if (Number.isFinite(altitude) || typeof altitude !== 'number') invalid.push(bad);
  }
  for (const field of ['distanceMeters', 'targetDistanceMeters']) {
    for (const number of [-1, 1000001, '1', false, {}]) invalid.push({ ...example(), [field]: number });
  }
  for (const name of ['', ' '.repeat(5), 'a'.repeat(121), 'header\r\ninjection', '\u0000', '\uD800']) invalid.push({ ...example(), name });
  for (const extra of [{ user_id: 'bob' }, { id }, { run_id: 'recorded' }, { route_integrity: 'complete' },
    { completed: true }, { createdAt: '2000-01-01' }]) invalid.push({ ...example(), ...extra });
  invalid.push(null, [], {}, { ...example(), geometry: { type: 'Point', coordinates: [12, 45] } },
    { ...example(), waypoints: Array(101).fill([12, 45]) },
    { ...example(), geometry: { type: 'LineString', coordinates: Array(MAX_POINTS + 1).fill([12, 45]) } },
    { ...example(), elevation: { source: 'imported', coverage: 'complete' } },
    { ...example(), elevation: { source: null } },
    { ...example(), elevation: { source: 'imported', gainMeters: -1 } },
    { ...example(), display: { surface: 'invented' } },
    { ...example(), display: { description: 'x'.repeat(501) } },
    { ...example(), legs: [] });
  for (const patch of [{ mode: 'straight' }, { provenance: 'manual' }, { profile: 'driving-car' },
    { startIndex: -1 }, { startIndex: 1 }, { endIndex: 99999 }, { endIndex: 1.5 }, { endIndex: 0 }, { hidden: true }]) {
    const bad = example(); bad.legs[0] = { ...bad.legs[0], ...patch }; invalid.push(bad);
  }
  const notCovered = example(); notCovered.legs[1].startIndex = 1; invalid.push(notCovered);
  const beforeInvalid = await adapter.dbAll('SELECT * FROM user_routes ORDER BY id');
  for (const body of invalid) {
    assert.throws(() => validateRoute(body));
    assert.equal((await call({ method: 'POST', body })).status, 400);
    assert.equal((await call({ method: 'PUT', url, body })).status, 400);
  }
  for (const badId of ['1', 'abc', '%27%20OR%201=1--', '%00', '%E0%A4%A']) {
    assert.equal((await call({ url: `/api/user-routes/${badId}` })).status, 400);
  }
  for (const query of ['?owner=bob', '?limit=101', '?offset=-1', '?limit=1&limit=2', '?offset=1000001', '?limit=1e1']) {
    assert.equal((await call({ url: `/api/user-routes${query}` })).status, 400);
  }
  assert.equal((await call({ url: `${url}?user_id=bob` })).status, 400);
  assert.equal((await call({ method: 'POST', body: example(), headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await call({ method: 'POST', body: example(), headers: { 'content-encoding': 'gzip' } })).status, 400);
  assert.equal((await call({ method: 'POST', raw: '{"name":' })).status, 400);
  assert.equal((await call({ method: 'POST', raw: ' '.repeat(MAX_BYTES + 1) })).status, 413);
  assert.equal((await call({ method: 'POST', raw: '{"distanceMeters":1e999}' })).status, 400);
  assert.deepEqual(await adapter.dbAll('SELECT * FROM user_routes ORDER BY id'), beforeInvalid);
  assert.equal((await call({ url: '/api/user-routes?limit=1&offset=1' })).body.routes.length, 0);
  ok(`${dialect}: ${invalid.length} invalid contracts, IDs, numeric bounds, body sizes, parser and immutable failures`);

  const exportResult = await call({ url: `${url}/gpx` });
  assert.equal(exportResult.status, 200);
  assert.match(exportResult.headers['content-type'], /^application\/gpx\+xml/);
  assert.equal(exportResult.headers['content-disposition'], `attachment; filename="planned-route-${id}.gpx"`);
  assert.equal(exportResult.headers['cache-control'], 'private, no-store');
  assert.equal(exportResult.headers['x-content-type-options'], 'nosniff');
  const gpx = (await parseStringPromise(exportResult.text)).gpx;
  assert.equal(gpx.$.version, '1.1');
  assert.equal(gpx.$.xmlns, 'http://www.topografix.com/GPX/1/1');
  assert.equal(gpx.rte, undefined); assert.equal(gpx.wpt, undefined);
  assert.equal(gpx.trk.length, 1); assert.equal(gpx.trk[0].trkseg.length, 1);
  assert.equal(gpx.trk[0].name[0], example().name);
  assert.match(gpx.trk[0].desc[0], /Planned route/);
  assert.match(gpx.trk[0].desc[0], /straight-line segments/);
  const trkpts = gpx.trk[0].trkseg[0].trkpt;
  assert.deepEqual(trkpts.map(p => [Number(p.$.lon), Number(p.$.lat)]), example().geometry.coordinates.map(p => p.slice(0, 2)));
  assert.deepEqual(trkpts.map(p => p.ele ? Number(p.ele[0]) : null), [0, null, -12, null]);
  assert.ok(trkpts.every(p => p.time === undefined), 'No recorded sample timestamps invented');
  for (const elevation of [null, undefined, NaN, Infinity, -Infinity, '12', false, 100001, -2001]) {
    assert.ok(!toGpx({ name: 'test', geometry: { coordinates: [[12, 45, elevation]] } }).includes('<ele>'));
  }
  for (const elevation of [-2000, 0, 100000]) {
    assert.ok(toGpx({ name: 'test', geometry: { coordinates: [[12, 45, elevation]] } }).includes(`<ele>${elevation}</ele>`));
  }
  ok(`${dialect}: parsed GPX trk preserves every ordered vertex, escapes names, emits only valid known elevations`);

  const replacement = example();
  replacement.name = '../../unsafe "filename"; 😀';
  replacement.geometry.coordinates = replacement.geometry.coordinates.map(p => p.slice(0, 2));
  delete replacement.elevation; delete replacement.display; delete replacement.targetDistanceMeters;
  const replaced = await call({ method: 'PUT', url, body: replacement });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.route.createdAt, route.createdAt);
  assert.ok(replaced.body.route.updatedAt >= route.updatedAt);
  assert.equal(replaced.body.route.targetDistanceMeters, null);
  assert.deepEqual(replaced.body.route.elevation, { source: null, coverage: 'missing', gainMeters: null, lossMeters: null });
  const noElevation = await call({ url: `${url}/gpx` });
  assert.ok(!noElevation.text.includes('<ele>'));
  assert.equal(noElevation.headers['content-disposition'], exportResult.headers['content-disposition']);
  const fullElevation = example();
  fullElevation.geometry.coordinates = fullElevation.geometry.coordinates.map((p, i) => [...p.slice(0, 2), i * 10]);
  fullElevation.elevation = { source: 'manual', gainMeters: 30, lossMeters: 0 };
  assert.equal((await call({ method: 'PUT', url, body: fullElevation })).body.route.elevation.coverage, 'complete');
  assert.equal(((await call({ url: `${url}/gpx` })).text.match(/<ele>/g) || []).length, 4);
  const large = {
    name: 'Lossless synthetic path', waypoints: [[0, 0], [0.09999, 0]],
    geometry: { type: 'LineString', coordinates: Array.from({ length: MAX_POINTS }, (_, i) => [i / 100000, 0]) },
    legs: [{ mode: 'routed', provenance: 'ors', profile: 'foot-hiking', startIndex: 0, endIndex: MAX_POINTS - 1 }],
    distanceMeters: 11119,
  };
  const largeResult = await call({ method: 'POST', body: large });
  assert.equal(largeResult.status, 201);
  assert.deepEqual(largeResult.body.route.geometry, large.geometry);
  const largeGpx = await call({ url: `/api/user-routes/${largeResult.body.route.id}/gpx` });
  assert.equal((largeGpx.text.match(/<trkpt /g) || []).length, MAX_POINTS);
  assert.deepEqual((await call({ url: `/api/user-routes/${largeResult.body.route.id}` })).body.route.geometry, large.geometry);
  const boundary = clone(large);
  boundary.waypoints = [[-180, -90], [180, 90]];
  boundary.geometry.coordinates = [[-180, -90], [180, 90]];
  boundary.legs = [{ mode: 'straight', provenance: 'manual', profile: null, startIndex: 0, endIndex: 1 }];
  assert.deepEqual(validateRoute(boundary).geometry, boundary.geometry);
  ok(`${dialect}: replace clears absent optional data, complete/missing heights and lossless 10000-point save/read/GPX`);

  const beforeFailure = await adapter.dbAll('SELECT * FROM user_routes ORDER BY id');
  const errorLogs = [];
  const originalError = console.error;
  console.error = (...args) => errorLogs.push(args);
  failAfterWrite = true;
  try {
    for (const options of [{ method: 'POST', body: example() }, { method: 'PUT', url, body: replacement }, { method: 'DELETE', url }]) {
      const failed = await call(options);
      assert.equal(failed.status, 503);
      assert.deepEqual(failed.body, { error: 'USER_ROUTES_UNAVAILABLE' });
    }
  } finally {
    failAfterWrite = false;
    console.error = originalError;
  }
  assert.deepEqual(errorLogs, [], 'Private SQL failures must never enter logs');
  assert.deepEqual(await adapter.dbAll('SELECT * FROM user_routes ORDER BY id'), beforeFailure);
  // Read failures after auth are checked using a failing store, so the existing
  // authentication logger cannot print our synthetic private SQL error.
  const failingApp = express();
  failingApp.use('/api/user-routes', createRouter({
    get: async () => { throw new Error('private [12,45]'); },
    list: async () => { throw new Error('private [12,45]'); },
  }));
  for (const target of ['/api/user-routes', url, `${url}/gpx`]) {
    const result = await request(failingApp, { token: alice, url: target });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'USER_ROUTES_UNAVAILABLE' });
  }
  await adapter.dbRun('UPDATE user_routes SET geometry_json=? WHERE id=? AND user_id=?', ['{"type":"LineString","coordinates":[[999,45],[12,45]]}', id, 'alice']);
  assert.equal((await call({ url })).status, 503);
  assert.equal((await call({ url: `${url}/gpx` })).status, 503);
  assert.equal((await call({ method: 'PUT', url, body: example() })).status, 200);
  ok(`${dialect}: transactional rollback, private stable errors and fail-closed corrupt geometry`);

  const exportDefinition = ACCOUNT_EXPORT_TABLES.filter(e => e.table === 'user_routes');
  const deleteDefinition = ACCOUNT_DELETE_QUERIES.filter(([sql]) => /DELETE FROM user_routes\b/.test(sql));
  assert.equal(exportDefinition.length, 1); assert.equal(deleteDefinition.length, 1);
  const exported = await adapter.dbAll(buildExportSql(exportDefinition[0]), ['alice']);
  assert.equal(exported.length, 2);
  assert.ok(exported.every(r => r.user_id === 'alice'));
  assert.deepEqual(JSON.parse(exported.find(r => r.id === id).geometry_json), example().geometry);
  const bobBefore = await adapter.dbAll('SELECT * FROM user_routes WHERE user_id=?', ['bob']);
  await assert.rejects(adapter.withUserMutation('alice', async tx => {
    await tx.run(deleteDefinition[0][0], ['alice']);
    throw new Error('test rollback');
  }), /test rollback/);
  assert.equal((await adapter.dbAll(buildExportSql(exportDefinition[0]), ['alice'])).length, 2);
  assert.equal((await call({ method: 'DELETE', url })).status, 204);
  assert.equal((await call({ url })).status, 404);
  assert.equal((await call({ url: `${url}/gpx` })).status, 404);
  assert.equal((await call({ method: 'DELETE', url })).status, 404);
  await adapter.withUserMutation('alice', tx => tx.run(deleteDefinition[0][0], ['alice']));
  assert.deepEqual(await adapter.dbAll(buildExportSql(exportDefinition[0]), ['alice']), []);
  assert.deepEqual(await adapter.dbAll('SELECT * FROM user_routes WHERE user_id=?', ['bob']), bobBefore);
  await adapter.dbRun('DELETE FROM users WHERE id=?', ['bob']);
  assert.deepEqual(await adapter.dbAll('SELECT * FROM user_routes WHERE user_id=?', ['bob']), []);
  assert.equal((await call({ token: bob, method: 'POST', body: example() })).status, 401);
  ok(`${dialect}: account export/deletion owner isolation, deletion rollback, cascade and revoked account`);

  for (const table of Object.keys(protectedRows)) assert.deepEqual(await adapter.dbAll(`SELECT * FROM ${table}`), protectedRows[table]);
  for (const { sql, params } of sqlAudit) {
    assert.doesNotMatch(sql, /\b(shared_routes|runs|user_plans|personal_records|activity_measured_receipts|ors_planning_\w*)\b/);
    if (/user_routes/.test(sql)) {
      assert.ok(params.includes('alice') || params.includes('bob'));
      if (/^\s*INSERT/i.test(sql)) assert.match(sql, /user_id/);
      else assert.match(sql, /WHERE[\s\S]*user_id=\?/i);
      assert.doesNotMatch(sql, /alice|bob|River/);
    }
  }
  assert.equal(networkAttempts, 0);
  ok(`${dialect}: audited parameterized ownership on every route query, shared/recorded/training tables untouched, zero network`);
}
async function main() {
  if (!process.argv.includes('--postgres')) {
    const f = sqliteFixture();
    try { await suite(f.adapter, 'SQLite'); } finally { f.close(); }
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-routes-pg-'));
    let started = false, adapter;
    const run = (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000,
        env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), LC_ALL: 'C' } });
      if (result.status !== 0) throw new Error(`${command} exit ${result.status}: ${result.stderr || result.error}`);
    };
    try {
      run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'synthetic_routes', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'),
        '-o', `-k ${dir} -h '' -p 55441`, '-w', 'start']);
      started = true;
      process.env.DATABASE_URL = `postgresql://synthetic_routes@localhost/postgres?host=${encodeURIComponent(dir)}&port=55441`;
      adapter = require('../src/db');
      await suite(adapter, 'PostgreSQL');
    } finally {
      if (adapter) await adapter.pool.end();
      if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop']);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`User routes smoke OK (${groups} groups; zero network/provider requests).`);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
