// Real routes + JWT ownership + in-memory SQLite transactions; no production DB,
// provider, weather or AI requests. Shoe edits never supply completion authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb();
const { db, hooks, calls } = fixture;
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
for (const name of ['shoe_catalog', 'gear_shoes', 'personal_records', 'ai_usage', 'user_hr_profile']) {
  const ddl = `${schema}\n${startup}`.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
  assert.ok(ddl, `${name} uses repository schema`);
  db.exec(ddl[0].replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP'));
}
// Existing startup-only run fields, not new production migrations.
for (const column of ['shoe_id TEXT', 'gps_available INTEGER DEFAULT 1', 'calories_burned INTEGER']) {
  if (!db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === column.split(' ')[0])) {
    db.exec(`ALTER TABLE runs ADD COLUMN ${column}`);
  }
}
for (const column of ['weight_lbs REAL', 'max_heart_rate INTEGER', 'resting_hr INTEGER']) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(row => row.name === column.split(' ')[0])) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
  }
}
fixture.exports.runWithUserContext = (_userId, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
// Feedback quota is exhausted locally; invoking an AI service is a test failure.
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  generateRunFeedback: () => { throw new Error('Unexpected AI call'); },
} };
process.env.JWT_SECRET = 'synthetic-shoe-route-test-only';
process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/runs', require('../src/routes/runs'));
app.use('/gear', require('../src/routes/gear'));
const owner = randomUUID(), foreign = randomUUID();
for (const id of [owner, foreign]) {
  db.prepare("INSERT INTO users(id,name,email,password_hash,planning_input_revision) VALUES (?,'Synthetic',?,'',7)")
    .run(id, `${id}@example.invalid`);
  for (let n = 0; n < 10; n++) db.prepare("INSERT INTO ai_usage(id,user_id,call_type) VALUES (?,?,'run_feedback')").run(randomUUID(), id);
}
const pairA = randomUUID(), pairB = randomUUID(), retired = randomUUID(), foreignPair = randomUUID();
for (const [id, user, isRetired] of [[pairA, owner, 0], [pairB, owner, 0], [retired, owner, 1], [foreignPair, foreign, 0]]) {
  db.prepare("INSERT INTO gear_shoes(id,user_id,brand,model,is_retired) VALUES (?,?,'Manual','Same model',?)").run(id, user, isRetired);
}
const row = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const revision = () => db.prepare('SELECT planning_input_revision FROM users WHERE id=?').get(owner).planning_input_revision;
const count = () => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
const body = (overrides = {}) => ({ id: randomUUID(), date: '2026-09-22', type: 'easy', distance_miles: 5,
  duration_seconds: 3000, target_zone: 'Zone 2', plan_session_id: null, ...overrides });
let server;
async function main() {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, url, payload, user = owner) {
    const response = await fetch(`${base}${url}`, { method, headers: {
      'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}),
    }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function mileage(id) {
    const result = await request('GET', '/gear/shoes?retired=true');
    assert.equal(result.status, 200);
    return result.data.shoes.find(shoe => shoe.id === id).total_miles;
  }
  assert.equal((await request('POST', '/runs', body(), null)).status, 401);
  const created = body({ shoe_id: pairA });
  const first = await request('POST', '/runs', created);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.run.shoe_id, pairA);
  assert.equal(row(created.id).shoe_id, pairA);
  assert.equal(revision(), 8, 'new actual activity advances evidence once');
  assert.equal((await request('GET', `/runs/${created.id}`)).data.run.shoe_id, pairA);
  assert.equal(await mileage(pairA), 5);
  assert.equal(await mileage(pairA), 5, 'read does not accrue mileage');
  const original = { ...row(created.id) };
  for (const replacement of [pairB, null, foreignPair]) {
    const replay = await request('POST', '/runs', { ...created, shoe_id: replacement, distance_miles: 99 });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.run.shoe_id, pairA, 'create replay is not an actual-shoe correction');
    assert.deepEqual({ ...row(created.id) }, original);
  }
  assert.equal(count(), 1);
  assert.equal(revision(), 8);
  const collision = await request('POST', '/runs', { ...created, shoe_id: foreignPair }, foreign);
  assert.equal(collision.status, 409, 'foreign run identity cannot be replayed or overwritten');
  assert.deepEqual({ ...row(created.id) }, original);
  for (const bad of [foreignPair, randomUUID(), '', 'not-a-shoe', 42, {}, []]) {
    const attempted = body({ shoe_id: bad });
    assert.equal((await request('POST', '/runs', attempted)).status, 400);
    assert.equal(row(attempted.id), undefined);
    assert.equal(revision(), 8, 'rejection is transactional');
  }
  const noShoe = body();
  assert.equal((await request('POST', '/runs', noShoe)).status, 201);
  assert.equal(row(noShoe.id).shoe_id, null, 'omitted create stays unknown, never picks a default');
  const explicitUnknown = body({ shoe_id: null });
  assert.equal((await request('POST', '/runs', explicitUnknown)).status, 201);
  assert.equal(row(explicitUnknown.id).shoe_id, null);
  const retiredRun = body({ shoe_id: retired, distance_miles: 2 });
  assert.equal((await request('POST', '/runs', retiredRun)).status, 201);
  assert.equal(await mileage(retired), 2, 'retired pairs retain historical truth');

  db.prepare("INSERT INTO training_plans(id,user_id,plan_json) VALUES ('synthetic-plan',?,'{\"unchanged\":true}')").run(owner);
  db.prepare(`INSERT INTO activity_measured_receipts(id,user_id,activity_kind,activity_id,plan_id,session_id,revision,payload_json,content_hash)
    VALUES ('synthetic-receipt',?,'run',?,'synthetic-plan','synthetic-session',1,'{}','preserved-hash')`).run(owner, created.id);
  const immutable = () => JSON.stringify({ plan: db.prepare('SELECT * FROM training_plans').all(),
    receipts: db.prepare('SELECT * FROM activity_measured_receipts').all(), revision: revision() });
  const before = immutable();
  const prior = { ...row(created.id) };
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: pairB })).status, 200);
  assert.deepEqual({ ...row(created.id), shoe_id: pairA }, prior, 'only physical pair changes');
  assert.equal(immutable(), before, 'shoe change does not revise physiology, plan or measurements');
  assert.equal(await mileage(pairA), 0);
  assert.equal(await mileage(pairB), 5, 'different physical pairs of same model track separately');
  const staleReplay = await request('POST', '/runs', created);
  assert.equal(staleReplay.status, 200);
  assert.equal(staleReplay.data.run.shoe_id, pairB, 'confirmed actual edit wins over stale pre-workout/create selection');
  assert.equal(immutable(), before);
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: pairB })).status, 200);
  assert.equal(await mileage(pairB), 5, 'edit replay is idempotent');
  assert.equal((await request('PUT', `/runs/${created.id}`, { shoe_id: null })).status, 200);
  assert.equal(row(created.id).shoe_id, null);
  assert.equal(await mileage(pairB), 0, 'explicit unknown clears actual use');
  for (const invalid of [foreignPair, randomUUID(), 'bad', false]) {
    assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: invalid })).status, 400);
    assert.equal(row(created.id).shoe_id, null);
    assert.equal(immutable(), before);
  }
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: foreignPair }, foreign)).status, 404);
  assert.equal((await request('PATCH', `/runs/${randomUUID()}`, { shoe_id: pairA })).status, 404);
  for (const changes of [{}, { notes: 'edit' }, { shoe_id: pairA, duration_seconds: 1 }, { shoe_id: pairA, unexpected: true }]) {
    const rejected = await request('PATCH', `/runs/${created.id}`, changes);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.code, 'EVIDENCE_IMMUTABLE');
  }
  assert.equal(immutable(), before);

  // Roll back after a real INSERT/UPDATE, not just a rejected input check.
  hooks.after = async (method, sql, result) => {
    if (method === 'run' && (/INSERT INTO runs/.test(sql) || /UPDATE runs SET shoe_id/.test(sql))) throw new Error('synthetic rollback');
    return result;
  };
  const rollbackCreate = body({ shoe_id: pairA });
  assert.equal((await request('POST', '/runs', rollbackCreate)).status, 500);
  assert.equal(row(rollbackCreate.id), undefined);
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: pairA })).status, 500);
  assert.equal(row(created.id).shoe_id, null);
  assert.equal(immutable(), before);
  delete hooks.after;

  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
  assert.equal((await request('PUT', `/runs/${created.id}`, { shoe_id: pairA, notes: 'explicit correction' })).status, 200);
  assert.equal((await request('PATCH', `/runs/${created.id}`, { notes: 'omitted gear' })).status, 200);
  assert.equal(row(created.id).shoe_id, pairA, 'ordinary edits preserve omitted gear');
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: null, notes: 'unknown gear' })).status, 200);
  assert.equal(row(created.id).shoe_id, null, 'mixed edit can explicitly clear when physiological edits are allowed');
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: retired })).status, 200);
  assert.equal(await mileage(retired), 7);
  assert.equal((await request('PATCH', `/runs/${created.id}`, { distance_miles: 3 })).status, 200);
  assert.equal(await mileage(retired), 5, 'distance correction recalculates without incrementing twice');
  const beforeBadEdit = { ...row(created.id) }, beforeBadRevision = revision();
  assert.equal((await request('PATCH', `/runs/${created.id}`, { shoe_id: foreignPair, notes: 'must roll back' })).status, 400);
  assert.deepEqual({ ...row(created.id) }, beforeBadEdit);
  assert.equal(revision(), beforeBadRevision);
  assert.ok(calls.some(call => /FROM gear_shoes WHERE id=\? AND user_id=\? FOR KEY SHARE/.test(call.sql)), 'owned pair locked through write');
  assert.ok(calls.filter(call => /UPDATE runs SET shoe_id/.test(call.sql)).every(call => /WHERE id=\? AND user_id=\?/.test(call.sql)));
  console.log('PASS run actual shoe: authenticated create/read, ownership, optional/clear/edit, retired pairs, replay, mileage, rollback, immutable physiological state');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); db.close(); });
