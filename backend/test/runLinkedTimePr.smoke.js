// Synthetic SQLite + real authenticated route chains and SQL. No sockets, live DB,
// providers, credentials, env files, or fabricated persistence/API responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb({ syntheticProfileFields: false });
const { db, tx, hooks } = fixture;
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
for (const name of ['activity_import_claims', 'personal_records', 'ai_usage', 'user_hr_profile', 'run_import_tombstones', 'activity_media', 'community_posts']) {
  const ddl = `${startup}\n${schema}`.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
  assert.ok(ddl, `repository DDL for ${name}`);
  db.exec(ddl[0].replace(/DEFAULT \(to_char\(NOW\(\), 'YYYY-MM-DD'\)\)/g, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP'));
}
for (const [table, columns] of Object.entries({ runs: ['shoe_id TEXT', 'gps_available INTEGER DEFAULT 1', 'calories_burned INTEGER', 'calories_watch INTEGER'],
  users: ['weight_lbs REAL', 'max_heart_rate INTEGER', 'resting_hr INTEGER'] })) {
  for (const column of columns) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}
fixture.exports.runWithUserContext = (_id, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  generateRunFeedback: () => { throw new Error('Unexpected AI request'); },
} };
const noNetwork = () => { throw new Error('Unexpected network request'); };
global.fetch = noNetwork;
require('node:http').request = noNetwork;
require('node:https').request = noNetwork;
require('node:net').connect = noNetwork;
process.env.JWT_SECRET = 'synthetic-time-pr-test-only';
process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
const jwt = require('jsonwebtoken');
const runs = require('../src/routes/runs');
const prs = require('../src/routes/prs');
const auto = require('../src/services/prAuto');
const imports = require('../src/routes/import');
const { normalizeRow } = imports._test;
const { STANDARD_TIME_PRS, nearestStandardTimePr, TIME_PR_DISTANCE_TOLERANCE } = auto;
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
function user() {
  const id = randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,planning_input_revision) VALUES (?,'Synthetic',?,'',1)").run(id, `${id}@example.invalid`);
  // Real feedback quota check, with no AI calls.
  for (let n = 0; n < 10; n++) db.prepare("INSERT INTO ai_usage(id,user_id,call_type) VALUES (?,?,'run_feedback')").run(randomUUID(), id);
  return id;
}
async function request(router, method, routePath, owner, { body = {}, id, query = {} } = {}) {
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method.toLowerCase()])?.route;
  assert.ok(route, `${method} ${routePath}`);
  assert.equal(route.stack[0].handle, require('../src/middleware/auth'));
  const result = { status: 200 };
  const req = { body, params: { id }, query, headers: owner ? { authorization: `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET)}` } : {} };
  const res = { status(code) { result.status = code; return this; }, json(data) { result.data = data; return this; } };
  let index = 0;
  const next = () => route.stack[index++]?.handle(req, res, next);
  await next();
  return result;
}
const record = (owner, label, source = 'auto') => db.prepare('SELECT * FROM personal_records WHERE user_id=? AND category=? AND label=? AND source=?').get(owner, 'time_pr', `Time PR: ${label}`, source);
const row = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const records = owner => db.prepare('SELECT * FROM personal_records WHERE user_id=? ORDER BY id').all(owner);
const payload = overrides => ({ id: randomUUID(), date: '2026-01-02', type: 'easy', distance_miles: 1,
  duration_seconds: 420, target_zone: 'Zone 2', plan_session_id: null, ...overrides });
async function save(owner, overrides) {
  const body = payload(overrides);
  const result = await request(runs, 'POST', '/', owner, { body });
  assert.equal(result.status, 201, JSON.stringify(result));
  return result.data.run;
}
async function edit(owner, id, body) {
  const result = await request(runs, 'PUT', '/:id', owner, { id, body });
  assert.equal(result.status, 200, JSON.stringify(result));
}
async function remove(owner, id) {
  const result = await request(runs, 'DELETE', '/:id', owner, { id });
  assert.equal(result.status, 200, JSON.stringify(result));
}
async function times(owner) {
  const result = await request(prs, 'GET', '/time', owner);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.data.times;
}
function nextFloat(number, up) {
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, number);
  view.setBigUint64(0, view.getBigUint64(0) + (up ? 1n : -1n));
  return view.getFloat64(0);
}
async function persistedFixture(owner, distance, duration = 1234, type = 'easy') {
  const id = randomUUID();
  db.prepare('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,?,?,?,?)')
    .run(id, owner, '2026-01-01', type, distance, duration);
  await fixture.exports.withUserMutation(owner, inner => auto(owner, row(id), { tx: inner, strictErrors: true }));
  return row(id);
}
async function main() {
  assert.equal(TIME_PR_DISTANCE_TOLERANCE, 0.01);
  assert.deepEqual(STANDARD_TIME_PRS.map(d => d.label), ['1 Mile', '5K', '10K', '15K', '10 Mile', 'Half Marathon', 'Marathon']);
  for (const dist of STANDARD_TIME_PRS) {
    const owner = user();
    const run = await save(owner, { distance_miles: dist.target });
    const pr = record(owner, dist.label);
    assert.ok(pr, dist.label);
    assert.deepEqual([pr.user_id, pr.category, pr.label, pr.unit, pr.value, pr.run_id, pr.achieved_at, pr.source],
      [owner, 'time_pr', `Time PR: ${dist.label}`, 'seconds', 420, run.id, '2026-01-02', 'auto']);
    assert.equal((await times(owner)).find(t => t.distance === dist.label).run_id, run.id);
    const second = await save(owner, { distance_miles: dist.target, duration_seconds: 450 });
    await edit(owner, run.id, { duration_seconds: 500 });
    assert.equal(record(owner, dist.label).run_id, second.id);
    await remove(owner, second.id);
    assert.equal(record(owner, dist.label).run_id, run.id);
    for (const distance of [dist.min, dist.target, dist.max]) {
      const boundaryOwner = user();
      const boundaryRun = await persistedFixture(boundaryOwner, distance);
      assert.equal(nearestStandardTimePr(distance), dist);
      assert.equal(record(boundaryOwner, dist.label).run_id, boundaryRun.id);
      assert.equal((await times(boundaryOwner)).find(t => t.distance === dist.label).best_time_seconds, 1234);
    }
    for (const distance of [nextFloat(dist.min, false), nextFloat(dist.max, true)]) {
      const outsideOwner = user();
      await persistedFixture(outsideOwner, distance);
      assert.equal(nearestStandardTimePr(distance), null, `${dist.label}: outside ${distance}`);
      assert.equal(record(outsideOwner, dist.label), undefined);
      assert.ok((await times(outsideOwner)).every(t => t.best_time_seconds === null));
    }
  }
  pass('seven real run-save paths; exact targets, inclusive endpoints, adjacent outside floats through SQL persistence/read');

  // /runs accepts distance_miles only. Its existing six-decimal normalization
  // precedes matching; imported km/meters use the real import normalizer.
  for (const [field, value, expected] of [['distanceMiles', 3.107, 3.107], ['distanceKilometers', 5, 3.107], ['distanceMeters', 5000, 3.107]]) {
    const normalized = normalizeRow({ date: '2026-01-03', type: 'run', [field]: value, durationSeconds: 1500, source: 'synthetic' });
    assert.equal(normalized.distanceMiles, expected);
    const owner = user();
    await save(owner, { distance_miles: normalized.distanceMiles, duration_seconds: normalized.durationSeconds });
    assert.equal(record(owner, '5K').value, 1500);
  }
  assert.throws(() => normalizeRow({ type: 'run', distance: 5, distanceUnit: 'furlongs', source: 'synthetic' }), /Unsupported distance unit/);
  const normalizedOwner = user();
  const rounded = await save(normalizedOwner, { distance_miles: '3.1070004', distance_unit: 'km' });
  assert.equal(rounded.distance_miles, 3.107, 'distance_miles remains miles; no new public unit');
  assert.equal(record(normalizedOwner, '5K').run_id, rounded.id);
  pass('actual run API canonical miles and existing import km/meter normalization');

  const importOwner = user();
  const backup = await save(importOwner, { distance_miles: 3.107, duration_seconds: 430, date: '2026-01-01' });
  const provisional = await save(importOwner, { distance_miles: 3.107, duration_seconds: 400,
    activity_start_at: '2026-01-02T10:00:00Z', activity_end_at: '2026-01-02T10:06:40Z' });
  assert.equal(record(importOwner, '5K').run_id, provisional.id);
  const watch = { source: 'apple_health', sourceWorkoutId: randomUUID(), type: 'running', date: '2026-01-02',
    startDate: '2026-01-02T10:00:20Z', endDate: '2026-01-02T10:07:50Z', distanceKilometers: 5, durationSeconds: 450 };
  const synced = await request(imports, 'POST', '/workouts', importOwner, { body: { workouts: [watch] } });
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.data.errors, []);
  assert.equal(row(provisional.id).duration_seconds, 450);
  assert.equal(record(importOwner, '5K').run_id, backup.id);
  const afterImport = records(importOwner);
  const replayImport = await request(imports, 'POST', '/workouts', importOwner, { body: { workouts: [watch] } });
  assert.deepEqual(replayImport.data.errors, []);
  assert.deepEqual(records(importOwner), afterImport);
  pass('real authenticated watch import normalizes kilometers, retracts provisional time and preserves repeat-sync identity');


  for (const bad of [undefined, null, 0, -1, '', 'bad', Infinity, NaN]) {
    assert.equal(auto.buildTimePrCandidate({ type: 'easy', distance_miles: 1, duration_seconds: bad }), null);
    assert.equal(auto.buildTimePrCandidate({ type: 'easy', distance_miles: bad, duration_seconds: 400 }), null);
  }
  for (const overrides of [{ duration_seconds: undefined }, { duration_seconds: null }, { duration_seconds: 0 }, { duration_seconds: -1 },
    { distance_miles: undefined }, { distance_miles: null }, { distance_miles: 0 }]) {
    const owner = user();
    await save(owner, overrides);
    assert.equal(record(owner, '1 Mile'), undefined);
  }
  for (const bad of [-1, 'bad', Infinity]) {
    const result = await request(runs, 'POST', '/', user(), { body: payload({ distance_miles: bad }) });
    assert.equal(result.status, 400);
  }
  for (const type of ['walk', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'workout', 'other']) {
    const owner = user();
    await save(owner, { type });
    assert.equal(records(owner).length, 0);
    assert.ok((await times(owner)).every(t => t.best_time_seconds === null));
  }
  pass('invalid/missing/zero metrics and non-run activities cannot create time PRs');

  const owner = user(), foreign = user();
  const first = await save(owner, { duration_seconds: 500 });
  const original = record(owner, '1 Mile');
  for (const duration_seconds of [500, 501]) {
    await save(owner, { duration_seconds, date: '2026-01-03' });
    assert.deepEqual(record(owner, '1 Mile'), original);
  }
  const fast = await save(owner, { duration_seconds: 400, date: '2026-01-04' });
  assert.equal(record(owner, '1 Mile').id, original.id);
  assert.equal(record(owner, '1 Mile').run_id, fast.id);
  assert.equal(record(owner, '1 Mile').achieved_at, '2026-01-04');
  const beforeRepeat = records(owner);
  assert.equal((await request(runs, 'POST', '/', owner, { body: payload({ id: fast.id }) })).status, 200);
  await auto(owner, row(fast.id), { tx, strictErrors: true });
  assert.deepEqual(records(owner), beforeRepeat);
  const foreignRun = await save(foreign, { duration_seconds: 100 });
  // A foreign exact id with forged qualifying metrics must not link a time PR.
  const freshOwner = user();
  await auto(freshOwner, { ...row(foreignRun.id), duration_seconds: 1 }, { tx, strictErrors: true });
  assert.equal(record(freshOwner, '1 Mile'), undefined);
  assert.equal(record(owner, '1 Mile').value, 400);
  const equalEarlier = await save(owner, { duration_seconds: 400, date: '2025-12-31' });
  assert.ok(equalEarlier.id !== fast.id);
  await auto.recomputeRunPrCategories(owner, [], { tx });
  assert.equal(record(owner, '1 Mile').run_id, fast.id, 'recompute keeps an equal surviving winner');
  assert.equal(record(foreign, '1 Mile').value, 100);
  for (const label of ['Best Avg Pace', 'Fastest Mile', 'Longest Run', '1 Mile PR']) {
    assert.ok(db.prepare("SELECT * FROM personal_records WHERE user_id=? AND category='run' AND label=?").get(owner, label));
  }
  await remove(owner, equalEarlier.id);
  const longest = await save(owner, { distance_miles: 4, duration_seconds: 2400 });
  assert.equal(db.prepare("SELECT value FROM personal_records WHERE user_id=? AND label='Longest Run'").get(owner).value, 4);
  pass('faster updates in place; slower/equal/retry no-op; owner isolation; pace and Longest Run retained');

  const manualResult = await request(prs, 'POST', '/manual', owner, { body: { distance_miles: 1, time_seconds: 600, date: '2026-01-01' } });
  assert.equal(manualResult.status, 200);
  const manual = record(owner, '1 Mile', 'manual');
  assert.equal(manual.run_id, null);
  assert.equal(record(owner, '1 Mile').value, 400);
  assert.equal((await times(owner))[0].best_time_seconds, 600, 'manual precedence regardless of slower time');
  const faster = await save(owner, { duration_seconds: 350 });
  assert.deepEqual(record(owner, '1 Mile', 'manual'), manual);
  assert.equal(record(owner, '1 Mile').run_id, faster.id);
  const legacyOwner = user();
  db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,notes,achieved_at) VALUES ('legacy',?,'time_pr','Time PR (1mi)',700,'seconds','Manually entered','2026-01-01')").run(legacyOwner);
  const legacyBefore = records(legacyOwner)[0];
  await save(legacyOwner);
  assert.deepEqual(db.prepare("SELECT * FROM personal_records WHERE id='legacy'").get(), legacyBefore);
  assert.equal((await times(legacyOwner))[0].best_time_seconds, 700);
  const legacyEdit = await request(prs, 'POST', '/manual', legacyOwner, { body: { distance_miles: 1, time_seconds: 650, date: '2026-01-02' } });
  assert.equal(legacyEdit.data.id, 'legacy');
  assert.equal(legacyEdit.data.source, 'manual');
  assert.equal(legacyEdit.data.run_id, null);
  assert.equal(record(legacyOwner, '1 Mile').value, 420);
  pass('manual coexistence, manual-first reads, legacy manual preservation and explicit manual provenance');

  const detectOwner = user();
  const detectRun = await save(detectOwner, { duration_seconds: 400 });
  await tx.run("DELETE FROM personal_records WHERE user_id=? AND category='time_pr'", [detectOwner]);
  const detected = await request(prs, 'POST', '/auto-detect', detectOwner, { body: { run_id: detectRun.id } });
  assert.equal(detected.status, 200);
  assert.ok(detected.data.newPRs.some(pr => pr.label === 'Time PR: 1 Mile' && pr.value === 400));
  assert.equal(record(detectOwner, '1 Mile').run_id, detectRun.id);
  const beforeDetectRepeat = records(detectOwner);
  assert.equal((await request(prs, 'POST', '/auto-detect', detectOwner, { body: { run_id: detectRun.id } })).status, 200);
  assert.deepEqual(records(detectOwner), beforeDetectRepeat);
  assert.deepEqual((await request(prs, 'POST', '/auto-detect', foreign, { body: { run_id: detectRun.id } })).data.newPRs, []);
  assert.equal((await request(prs, 'POST', '/auto-detect', null, { body: { run_id: detectRun.id } })).status, 401);
  for (const label of ['Longest Run', 'Fastest Pace']) {
    await tx.run("DELETE FROM personal_records WHERE user_id=? AND category='run' AND label=?", [detectOwner, label]);
    const entered = await request(prs, 'POST', '/', detectOwner, { body: { category: 'run', label, value: label === 'Longest Run' ? 0.5 : 20, unit: label === 'Longest Run' ? 'mi' : 'min/mi' } });
    assert.equal(entered.data.source, 'manual');
    assert.equal(entered.data.run_id, null);
  }
  await request(prs, 'POST', '/auto-detect', detectOwner, { body: { run_id: detectRun.id } });
  const manualRunPrs = records(detectOwner).filter(pr => pr.source === 'manual');
  assert.deepEqual(manualRunPrs.map(pr => [pr.label, pr.value, pr.run_id]).sort(), [['Fastest Pace', 20, null], ['Longest Run', 0.5, null]]);
  pass('explicit auto-detect uses shared persistence transaction, stays idempotent/owned and preserves manual pace/longest values');


  const share = async (account, id) => request(runs, 'GET', '/:id/share-context', account, { id, query: { local_date: '2026-01-02' } });
  const linked = await share(owner, faster.id);
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.data.prs.filter(pr => pr.category === 'time_pr').map(pr => pr.id), [original.id]);
  assert.equal((await share(owner, first.id)).data.prs.filter(pr => pr.category === 'time_pr').length, 0);
  assert.equal((await share(foreign, faster.id)).status, 404);
  assert.equal((await share(null, faster.id)).status, 401);
  pass('real authenticated share-context selects only the exact linked owned run, excludes manual time');

  const mutateOwner = user();
  const slow = await save(mutateOwner, { duration_seconds: 550 });
  const winner = await save(mutateOwner, { duration_seconds: 400 });
  await edit(mutateOwner, winner.id, { date: '2026-01-05' });
  assert.equal(record(mutateOwner, '1 Mile').achieved_at, '2026-01-05');
  await edit(mutateOwner, winner.id, { duration_seconds: 600 });
  assert.equal(record(mutateOwner, '1 Mile').run_id, slow.id);
  await edit(mutateOwner, slow.id, { distance_miles: 3.107 });
  assert.equal(record(mutateOwner, '1 Mile').run_id, winner.id);
  assert.equal(record(mutateOwner, '5K').run_id, slow.id);
  await edit(mutateOwner, winner.id, { type: 'walk' });
  assert.equal(record(mutateOwner, '1 Mile'), undefined);
  await edit(mutateOwner, winner.id, { type: 'easy' });
  assert.equal(record(mutateOwner, '1 Mile').run_id, winner.id);
  const next = await save(mutateOwner, { distance_miles: 3.107, duration_seconds: 650 });
  await remove(mutateOwner, slow.id);
  assert.equal(record(mutateOwner, '5K').run_id, next.id);
  await remove(mutateOwner, next.id);
  assert.equal(record(mutateOwner, '5K'), undefined);
  const protectedBefore = records(foreign);
  assert.equal((await request(runs, 'PUT', '/:id', mutateOwner, { id: foreignRun.id, body: { duration_seconds: 1 } })).status, 404);
  assert.equal((await request(runs, 'DELETE', '/:id', mutateOwner, { id: foreignRun.id })).status, 404);
  assert.deepEqual(records(foreign), protectedBefore);
  await remove(owner, faster.id);
  assert.equal(record(owner, '1 Mile').run_id, fast.id);
  assert.deepEqual(record(owner, '1 Mile', 'manual'), manual);
  await remove(owner, longest.id);
  assert.equal(db.prepare("SELECT value FROM personal_records WHERE user_id=? AND label='Longest Run'").get(owner).value, 1);
  pass('date/duration/distance/type edits and deletes recompute next owned winner; preserve manual and foreign records');

  // Same shared recompute seam used by import corrections, even when the caller
  // supplies only legacy run labels (or no such labels remain).
  await tx.run('UPDATE runs SET duration_seconds=? WHERE id=? AND user_id=?', [700, fast.id, owner]);
  await auto.recomputeRunPrCategories(owner, [], { tx, includeManualDiscrepancies: true });
  assert.equal(record(owner, '1 Mile').value, 500);
  assert.deepEqual(record(owner, '1 Mile', 'manual'), manual);
  pass('canonical/import-style correction refreshes linked time categories without touching manual records');

  const legacyRunsOwner = user();
  const short = await persistedFixture(legacyRunsOwner, 0.99, 400);
  await persistedFixture(legacyRunsOwner, 1.01, 405); // faster pace, slower whole run
  await persistedFixture(legacyRunsOwner, 1.04, 200); // old 5% window must not qualify
  await tx.run("DELETE FROM personal_records WHERE user_id=? AND category='time_pr'", [legacyRunsOwner]);
  const legacyTime = (await times(legacyRunsOwner))[0];
  assert.equal(legacyTime.best_time_seconds, 400);
  assert.equal(legacyTime.run_id, short.id);
  assert.equal(legacyTime.observed_time_seconds, 400);
  assert.equal(legacyTime.observed_distance_miles, 0.99);
  assert.equal(legacyTime.pace, 400 / 0.99);
  await auto(legacyRunsOwner, row(short.id), { tx, strictErrors: true });
  const persistedTime = (await times(legacyRunsOwner))[0];
  assert.equal(persistedTime.best_time_seconds, 400);
  assert.equal(persistedTime.observed_distance_miles, 0.99);
  assert.equal(persistedTime.observed_time_seconds, 400);
  assert.equal(persistedTime.pace, 400 / 0.99);
  db.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,'2026-01-01','easy',1,300)").run(randomUUID(), legacyRunsOwner);
  assert.equal((await times(legacyRunsOwner))[0].best_time_seconds, 400, 'persisted auto record precedes legacy fallback');
  assert.ok((await times(legacyRunsOwner)).slice(1).every(t => t.best_time_seconds === null));
  const fractionOwner = user();
  await save(fractionOwner, { duration_seconds: 420.25 });
  assert.equal(record(fractionOwner, '1 Mile').value, 420.25, 'observed duration is not rounded or inferred');
  pass('legacy GET fallback uses observed whole-run duration, ranks duration rather than pace, no extrapolation');

  const rollbackOwner = user();
  const rollbackRun = await save(rollbackOwner, { duration_seconds: 500 });
  const rollbackBefore = records(rollbackOwner), rollbackRow = row(rollbackRun.id);
  const revision = () => db.prepare('SELECT planning_input_revision AS r FROM users WHERE id=?').get(rollbackOwner).r;
  const beforeRevision = revision();
  hooks.after = async (method, sql, result) => {
    if (method === 'run' && /UPDATE personal_records/.test(sql)) throw new Error('synthetic PR transaction failure');
    return result;
  };
  const failedEdit = await request(runs, 'PUT', '/:id', rollbackOwner, { id: rollbackRun.id, body: { duration_seconds: 550 } });
  hooks.after = null;
  assert.equal(failedEdit.status, 500);
  assert.deepEqual(records(rollbackOwner), rollbackBefore);
  assert.deepEqual(row(rollbackRun.id), rollbackRow);
  assert.equal(revision(), beforeRevision);
  hooks.after = async (method, sql, result) => {
    if (method === 'run' && /INSERT INTO personal_records/.test(sql)) throw new Error('synthetic PR insert failure');
    return result;
  };
  const failedBody = payload({ distance_miles: 3.107 });
  const failedSave = await request(runs, 'POST', '/', rollbackOwner, { body: failedBody });
  hooks.after = null;
  assert.equal(failedSave.status, 500);
  assert.equal(row(failedBody.id), undefined);
  assert.deepEqual(records(rollbackOwner), rollbackBefore);
  assert.equal(revision(), beforeRevision);
  hooks.after = async (method, sql, result) => {
    if (method === 'run' && /DELETE FROM personal_records/.test(sql)) throw new Error('synthetic PR delete failure');
    return result;
  };
  const failedDelete = await request(runs, 'DELETE', '/:id', rollbackOwner, { id: rollbackRun.id });
  hooks.after = null;
  assert.equal(failedDelete.status, 500);
  assert.deepEqual(row(rollbackRun.id), rollbackRow);
  assert.deepEqual(records(rollbackOwner), rollbackBefore);
  assert.equal(revision(), beforeRevision);
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
  assert.equal((await request(runs, 'PUT', '/:id', rollbackOwner, { id: rollbackRun.id, body: { duration_seconds: 1 } })).status, 409);
  pass('PR failures roll back run/PR/revision together; existing immutable-evidence edit guard remains');
  console.log(`RUN LINKED TIME PR OK (${groups} groups)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
