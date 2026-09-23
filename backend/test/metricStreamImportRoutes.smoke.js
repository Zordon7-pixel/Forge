// Actual authenticated import persistence against disposable repository SQLite
// DDL. No provider/API/account access, production schema or source repair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixture = require('./helpers/adaptiveShadowDb').createDb();
const { db } = fixture;
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
for (const name of ['activity_import_claims', 'run_import_tombstones', 'personal_records']) {
  db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`))[0]);
}
for (const column of ['discrepancy INTEGER DEFAULT 0', 'auto_value REAL']) {
  try { db.exec(`ALTER TABLE personal_records ADD COLUMN ${column}`); } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}
for (const column of ['calories_burned INTEGER', 'calories_watch INTEGER', 'shoe_id TEXT', 'gps_available INTEGER DEFAULT 1']) {
  if (!db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === column.split(' ')[0])) db.exec(`ALTER TABLE runs ADD COLUMN ${column}`);
}
fixture.exports.runWithUserContext = (_owner, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
process.env.JWT_SECRET = 'synthetic-metric-stream-import-only';
const jwt = require('jsonwebtoken');
const express = require('express'), app = express();
app.use(express.json());
app.use('/import', require('../src/routes/import'));
app.use('/runs', require('../src/routes/runs'));
const owner = randomUUID(), foreign = randomUUID();
for (const id of [owner, foreign]) db.prepare("INSERT INTO users(id,name,email,password_hash,timezone,planning_input_revision) VALUES (?,'Synthetic',?,'','UTC',9)").run(id, `${id}@example.invalid`);
const revision = () => db.prepare('SELECT planning_input_revision FROM users WHERE id=?').get(owner).planning_input_revision;
const rows = () => db.prepare('SELECT * FROM runs WHERE user_id=?').all(owner);
const stream = () => JSON.parse(rows()[0].workout_metric_streams_json);
const base = { source: 'apple_health', sourceWorkoutId: 'synthetic-stream-activity', type: 'running',
  startDate: '2026-09-21T10:00:00Z', endDate: '2026-09-21T10:30:00Z', distanceMiles: 3, durationSeconds: 1800 };
const nativeFetch = global.fetch;
global.fetch = (url, options) => { assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+\/(?:import|runs)\//, 'no external request'); return nativeFetch(url, options); };
let server;
async function main() {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  async function request(method, route, body, user = owner) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() };
  }
  const send = async (workoutMetricStreams, user = owner) => {
    const result = await request('POST', '/import/health', { workouts: [{ ...base, workoutMetricStreams }] }, user);
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data.errors, []); return result.data;
  };
  assert.equal((await request('POST', '/import/health', { workouts: [base] }, null)).status, 401);
  const first = { source: 'apple_health', heart_rate_bpm: [[0, 140], [10, 145]],
    running_speed_mps: [[null, null], ['', ''], [false, false], [0, 0]] };
  const inserted = await send(first);
  assert.equal(inserted.imported, 1); assert.equal(rows().length, 1); assert.equal(revision(), 10);
  const id = rows()[0].id;
  assert.deepEqual(stream().running_speed_mps, [{ t: 0, v: 0 }]);
  assert.equal(stream().metric_sources.heart_rate_bpm.declared_source, 'apple_health');
  const mixedInput = { source: 'manual', running_speed_mps: [[0, 0], [10, 3]] };
  await send(mixedInput);
  const mixed = stream();
  assert.equal(rows().length, 1); assert.equal(rows()[0].id, id); assert.equal(revision(), 11);
  assert.equal(mixed.source, 'mixed'); assert.equal(mixed.metric_sources.heart_rate_bpm.declared_source, 'apple_health');
  assert.equal(mixed.metric_sources.running_speed_mps.declared_source, 'manual');
  assert.equal(mixed.metric_sources.running_speed_mps.verification_status, 'UNVERIFIED');
  await send(mixedInput); assert.deepEqual(stream(), mixed, 'exact enrichment replay does not churn stream JSON');
  assert.equal(revision(), 12, 'existing import revision semantics are unchanged');
  for (const invalid of [{ source: 'garmin' }, { source: 'garmin', heart_rate_bpm: [[null, null]], running_speed_mps: [[false, false]] }]) {
    await send(invalid); assert.deepEqual(stream(), mixed, 'empty/invalid enrichment never erases or relabels existing metrics');
  }
  await send({ running_speed_mps: [[0, 1], [10, 2]] });
  assert.equal(stream().metric_sources.running_speed_mps.declared_source, null);
  assert.equal(stream().metric_sources.heart_rate_bpm.declared_source, 'apple_health');
  const beforeSpoof = rows()[0].distance_miles;
  await send({ version: 2, source: 'garmin', running_speed_mps: [[0, 2]], metric_sources: {
    running_speed_mps: { basis: 'DECLARED', declared_source: 'garmin', verification_status: 'VERIFIED', authenticated_provider: true } } });
  assert.equal(stream().metric_sources.running_speed_mps.verification_status, 'UNVERIFIED');
  assert.equal(rows()[0].distance_miles, beforeSpoof);
  const detail = await request('GET', `/runs/${id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.deepEqual(JSON.parse(detail.data.run.workout_metric_streams_json), stream());
  assert.equal((await request('GET', `/runs/${id}`, null, foreign)).status, 404);
  const ownerBefore = rows()[0].workout_metric_streams_json;
  await send({ source: 'foreign', running_speed_mps: [[0, 9]] }, foreign);
  assert.equal(rows()[0].workout_metric_streams_json, ownerBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 2, 'same provider key remains owner isolated');
  // A genuine old row remains old until a real enrichment writes it. Reading
  // or normalizing cannot certify its metric origins or backfill the database.
  const legacy = { version: 1, source: 'apple_health', heart_rate_bpm: [[0, 140], [10, 145]] };
  db.prepare('UPDATE runs SET workout_metric_streams_json=? WHERE id=?').run(JSON.stringify(legacy), id);
  await request('GET', `/runs/${id}`);
  assert.equal(rows()[0].workout_metric_streams_json, JSON.stringify(legacy));
  await send({ source: 'manual', running_speed_mps: [[0, 3]] });
  assert.equal(stream().metric_sources.heart_rate_bpm.basis, 'LEGACY_GLOBAL_ONLY');
  assert.equal(stream().metric_sources.heart_rate_bpm.declared_source, null);
  assert.equal(stream().metric_sources.heart_rate_bpm.legacy_global_source, 'apple_health');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_measured_receipts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_plans').get().n, 0);
  assert.equal(rows().length, 1);
  console.log('PASS metric stream import routes: real auth/DDL/transactions, persistence/detail roundtrip, owner isolation, physical replay, unchanged revision semantics, legacy/unverified provenance');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { server?.close(); db.close(); global.fetch = nativeFetch; });
