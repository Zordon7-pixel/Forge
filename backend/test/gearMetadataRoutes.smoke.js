// Real authenticated HTTP + repository DDL in disposable in-memory SQLite.
// No production DB, weather/provider lookup, migrations or account access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixture = require('./helpers/adaptiveShadowDb').createDb();
const { db } = fixture;
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
for (const name of ['shoe_catalog', 'gear_shoes']) {
  const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
  assert.ok(ddl);
  db.exec(ddl[0]);
}
if (!db.prepare('PRAGMA table_info(runs)').all().some(r => r.name === 'shoe_id')) db.exec('ALTER TABLE runs ADD COLUMN shoe_id TEXT');
fixture.exports.runWithUserContext = (_id, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const weatherPath = require.resolve('../src/services/weather');
require.cache[weatherPath] = { id: weatherPath, filename: weatherPath, loaded: true,
  exports: { getWeather: () => { throw new Error('External weather call forbidden'); } } };
process.env.JWT_SECRET = 'synthetic-gear-metadata-test-only';
const jwt = require('jsonwebtoken');
const app = require('express')();
app.use(require('express').json());
app.use('/gear', require('../src/routes/gear'));
const owner = randomUUID(), foreign = randomUUID();
for (const id of [owner, foreign]) db.prepare("INSERT INTO users(id,name,email,password_hash,is_pro,planning_input_revision) VALUES (?,'Synthetic',?,'',1,9)").run(id, `${id}@example.invalid`);
db.prepare("INSERT INTO training_plans(id,user_id,plan_json) VALUES ('plan',?,'{\"physiology\":\"unchanged\"}')").run(owner);
const immutable = () => JSON.stringify({ users: db.prepare('SELECT * FROM users ORDER BY id').all(),
  plans: db.prepare('SELECT * FROM training_plans').all(), artifacts: db.prepare('SELECT * FROM planning_pipeline_artifacts').all(),
  receipts: db.prepare('SELECT * FROM activity_measured_receipts').all(), runs: db.prepare('SELECT * FROM runs').all() });
let baseline = immutable();
const saved = id => ({ ...db.prepare('SELECT * FROM gear_shoes WHERE id=?').get(id) });
let server;
async function main() {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, route, body, user = owner) {
    const response = await fetch(`${base}/gear${route}`, { method, headers: { 'Content-Type': 'application/json',
      ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const pick = async (surface = 'road', user = owner) => {
    const r = await request('GET', `/recommendation?surface=${surface}`, undefined, user);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.shoe;
  };
  assert.equal((await request('POST', '/shoes', { brand: 'Synthetic', model: 'Unknown' }, null)).status, 401);
  assert.ok((await pick()).reason_codes.includes('NO_ACTIVE_SHOES'));
  const added = await request('POST', '/shoes', { brand: 'Synthetic', model: 'Unknown' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const id = added.data.id;
  for (const key of ['category', 'surface', 'cushion', 'wet_ok', 'recommended_miles', 'pct_used', 'miles_remaining']) assert.equal(added.data[key], null, key);
  assert.equal(added.data.total_miles, 0);
  assert.deepEqual(added.data.intent_tags, []);
  assert.equal((await request('GET', '/shoes')).data.shoes[0].surface, null);
  assert.ok((await pick()).reason_codes.includes('UNKNOWN_SHOE_METADATA'));
  const edited = await request('PATCH', `/shoes/${id}`, { category: 'daily_trainer', surface: 'road', wet_ok: true, recommended_miles: 450 });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.profile_metadata_basis, 'UNVERIFIED_PROFILE');
  assert.equal((await pick()).shoe.id, id);
  assert.equal(immutable(), baseline);
  // Synthetic observed mileage is fixture input, never a gear route write.
  db.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,shoe_id) VALUES ('mileage-fixture',?,'2026-09-22','easy',500,3000,?)").run(owner, id);
  baseline = immutable();
  const highMileage = await pick();
  assert.equal(highMileage.shoe.id, id);
  assert.equal(highMileage.shoe.total_miles, 500);
  assert.ok(highMileage.reason_codes.includes('INSPECT_WEAR'));
  assert.equal(saved(id).is_retired, 0);
  assert.equal((await pick('trail')).shoe, null);
  assert.equal((await pick('both')).shoe, null);
  await request('PATCH', `/shoes/${id}`, { nickname: 'Named pair' });
  assert.equal(saved(id).surface, 'road', 'omitted edit preserves');
  assert.equal(saved(id).category, 'daily_trainer');
  for (const patch of [{ surface: null }, { surface: '' }]) {
    assert.equal((await request('PATCH', `/shoes/${id}`, patch)).status, 200);
    assert.equal(saved(id).surface, null);
    assert.equal((await pick()).shoe, null);
    await request('PATCH', `/shoes/${id}`, { surface: 'road' });
  }
  assert.equal((await request('PATCH', `/shoes/${id}`, { category: null, recommended_miles: '' })).status, 200);
  assert.equal(saved(id).category, null);
  assert.equal(saved(id).recommended_miles, null);
  const beforeInvalid = saved(id);
  for (const [field, values] of Object.entries({ category: ['bad', [], {}, true], surface: ['snow', [], {}, false], recommended_miles: [[], {}, true, -1, 900] })) {
    for (const value of values) {
      assert.equal((await request('PATCH', `/shoes/${id}`, { nickname: 'must not write', [field]: value })).status, 400);
      assert.deepEqual(saved(id), beforeInvalid);
      if (field !== 'recommended_miles') assert.equal((await request('POST', '/shoes', { brand: 'Bad', model: 'Bad', [field]: value })).status, 400);
    }
  }
  assert.equal((await request('GET', '/recommendation?surface=snow')).status, 400);
  assert.equal((await request('PATCH', `/shoes/${id}`, { surface: 'trail' }, foreign)).status, 404);
  assert.deepEqual(saved(id), beforeInvalid);
  assert.deepEqual((await request('GET', '/shoes', undefined, foreign)).data.shoes, []);
  assert.equal((await pick('road', foreign)).shoe, null);
  db.prepare(`INSERT INTO shoe_catalog(id,brand,model,category,surface,wet_ok,recommended_miles_min,recommended_miles_max,verification_status,confidence)
    VALUES ('catalog','Catalog','Known','daily_trainer','road',1,300,450,'manufacturer_verified','high')`).run();
  const catalog = await request('POST', '/shoes', { catalog_id: 'catalog' });
  assert.equal(catalog.status, 201);
  assert.equal(catalog.data.surface, 'road');
  assert.equal(catalog.data.catalog_verification_status, 'manufacturer_verified');
  const override = await request('PATCH', `/shoes/${catalog.data.id}`, { surface: 'trail', category: null, wet_ok: 1 });
  assert.equal(override.data.profile_metadata_basis, 'UNVERIFIED_PROFILE');
  const trailPick = await pick('trail');
  assert.equal(trailPick.shoe.id, catalog.data.id);
  assert.equal(trailPick.confidence, 'LOW', 'catalog verification does not certify override');
  assert.doesNotMatch(trailPick.reason, /built for|verified traction/);
  assert.equal((await request('POST', `/shoes/${catalog.data.id}/retire`)).status, 200);
  assert.equal((await pick('trail')).shoe, null);
  assert.equal(immutable(), baseline, 'gear writes/reads never mutate physiology, plan, evidence or account revision');
  console.log('PASS gear metadata routes: auth/ownership, nullable manual create/edit, preservation/clear, malformed rejection, strict surfaces, catalog override uncertainty and physiological non-mutation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { if (server) server.close(); db.close(); });
