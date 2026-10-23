// Synthetic fixtures only. Real POST/import SQL, PR service, revision runner,
// totals and planner load projection against disposable in-memory SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb();
const { db } = fixture;
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
for (const name of ['shoe_catalog', 'gear_shoes', 'personal_records', 'ai_usage', 'user_hr_profile',
  'activity_import_claims', 'run_import_tombstones']) {
  const ddl = `${schema}\n${startup}`.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
  assert.ok(ddl, `fixture DDL ${name}`);
  db.exec(ddl[0].replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP'));
}
for (const [table, columns] of Object.entries({
  runs: ['shoe_id TEXT', 'gps_available INTEGER DEFAULT 1', 'calories_burned INTEGER', 'calories_watch INTEGER'],
  users: ['weight_lbs REAL', 'max_heart_rate INTEGER', 'resting_hr INTEGER'],
})) for (const column of columns) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column.split(' ')[0])) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}
function mockModule(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
fixture.exports.runWithUserContext = (_id, next) => next();
mockModule('../src/db', fixture.exports);
mockModule('../src/services/ai', { generateRunFeedback() { throw Error('Unexpected AI call'); } });
mockModule('../src/services/weather', { getWeather() { throw Error('Unexpected weather call'); } });
process.env.JWT_SECRET = 'synthetic-phase4-only';
const runsRouter = require('../src/routes/runs');
const { _test: imports } = require('../src/routes/import');
const { summarizeRecentRunLoad } = require('../src/lib/recentRunLoad');
const { resolveRunEffort } = require('../src/lib/runEffort');
const prAuto = require('../src/services/prAuto');
const { normalizeRouteCoords } = require('../src/lib/runPostRun');
const day = '2026-10-20';
const phoneRoute = { version: 2, segments: [
  { gap: null, points: [{ lat: 0, lon: 0, alt: 10 }, { lat: 0, lon: .001, alt: 12 }] },
  { gap: { kind: 'gps-gap', reason: 'timeout' }, points: [{ lat: 0, lon: .02, alt: 200 }, { lat: 0, lon: .021, alt: 203 }] },
] };
const watchRoute = [{ lat: 1, lon: 1, alt: 20 }, { lat: 1, lon: 1.001, alt: 25 }];
function owner() {
  const id = randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,planning_input_revision) VALUES (?,'Synthetic',?,'',7)").run(id, `${id}@example.invalid`);
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO ai_usage(id,user_id,call_type) VALUES (?,?,'run_feedback')").run(randomUUID(), id);
  return id;
}
function phone(overrides = {}) {
  return { id: randomUUID(), date: day, type: 'easy', distance_miles: 3.2, duration_seconds: 1800,
    activity_start_at: `${day}T10:00:00Z`, activity_end_at: `${day}T10:30:00Z`,
    route_coords: phoneRoute, gps_source: 'native_bg', backgroundRefreshStatus: 'denied',
    elevation_gain: 5, elevation_loss: 3, avg_heart_rate: 110, max_heart_rate: 120,
    heart_rate_zones: { z1: 1800 }, target_zone: 'Zone 2', plan_session_id: null, ...overrides };
}
function watch(overrides = {}) {
  return { source: 'apple_health', sourceWorkoutId: randomUUID(), type: 'running', date: day,
    startDate: `${day}T10:00:20Z`, endDate: `${day}T10:31:20Z`, distanceMiles: 3.1, durationSeconds: 1860,
    avgHeartRate: 155, maxHeartRate: 181, minHeartRate: 85, zoneSeconds: { z3: 1860 },
    elevationGain: 42, elevationLoss: 39, calories: 360, cadenceSpm: 170,
    trainingEffectAerobic: 3.2, runningPowerWatts: 255,
    workoutMetricStreams: { version: 1, source: 'apple_health', heart_rate_bpm: [{ t: 0, v: 150 }, { t: 10, v: 160 }] },
    ...overrides };
}
const rows = user => db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY id').all(user);
const revision = user => db.prepare('SELECT planning_input_revision n FROM users WHERE id=?').get(user).n;
async function call(user, method, routePath, body = {}, id) {
  const layer = runsRouter.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]);
  assert.ok(layer);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
  await layer.route.stack.at(-1).handle({ user: { id: user }, params: { id }, query: {}, body }, res);
  assert.ok(res.code < 400, `handler ${method} ${routePath} failed (${res.code})`);
  return res;
}
async function sync(user, item) {
  const result = await imports.importRows(user, [item]);
  assert.equal(result.errors.length, 0, 'import transaction must succeed');
  return result;
}
function canonical(user, p, w, withRoute) {
  const saved = rows(user);
  assert.equal(saved.length, 1, 'one canonical run');
  const run = saved[0], m = JSON.parse(run.workout_metrics_json);
  for (const [field, expected] of Object.entries({ distance_miles: w.distanceMiles, duration_seconds: w.durationSeconds,
    avg_heart_rate: w.avgHeartRate, max_heart_rate: w.maxHeartRate, min_heart_rate: w.minHeartRate,
    elevation_gain: w.elevationGain, elevation_loss: w.elevationLoss, cadence_spm: w.cadenceSpm,
    training_effect_aerobic: w.trainingEffectAerobic, calories: w.calories })) assert.equal(run[field], expected, field);
  assert.equal(run.health_source, 'apple_health');
  assert.equal(run.health_start_at, new Date(w.startDate).toISOString());
  assert.equal(run.health_end_at, new Date(w.endDate).toISOString());
  assert.equal(m.summary_source, 'apple_health'); assert.equal(m.distance_source, 'apple_health');
  assert.equal(m.forged_recording_id, p.id);
  assert.equal(m.gps_source, 'native_bg'); assert.equal(m.backgroundRefreshStatus, 'denied');
  assert.equal(m.running_power_watts, 255);
  assert.equal(m.metric_sources.running_power_watts, 'apple_health');
  for (const field of ['distance_miles', 'duration_seconds', 'avg_heart_rate', 'elevation_gain', 'elevation_loss']) {
    assert.equal(m.metric_sources[field], 'apple_health', `canonical ${field} provenance`);
  }
  assert.equal(m.route_source, withRoute ? 'apple_health' : 'forged_phone');
  assert.equal(m.route_status, withRoute && !w.routeCoverageIncomplete ? 'complete' : 'partial');
  assert.ok(JSON.stringify(JSON.parse(run.route_coords)) === JSON.stringify(withRoute ? imports.normalizeRow(w).routeCoords : normalizeRouteCoords(p.route_coords)), 'whole source only; no connectors or planned fill');
  assert.equal(JSON.parse(run.workout_metric_streams_json).heart_rate_bpm.length, 2);
  const totals = db.prepare('SELECT COUNT(*) n, SUM(distance_miles) miles, SUM(duration_seconds) seconds FROM runs WHERE user_id=?').get(user);
  assert.equal(totals.n, 1); assert.equal(totals.miles, w.distanceMiles); assert.equal(totals.seconds, w.durationSeconds);
  const load = summarizeRecentRunLoad(saved, { todayISO: day, coverageComplete: true });
  assert.equal(load.currentWeek.runCount, 1); assert.equal(load.currentWeek.miles, w.distanceMiles);
  assert.equal(load.latestRun.durationSeconds, w.durationSeconds);
  assert.equal(load.latestRun.avgHeartRate, w.avgHeartRate);
  assert.equal(resolveRunEffort(run).zoneLoad, 93, 'load recomputed from authoritative watch zones and duration');
  const prs = db.prepare("SELECT label, value, run_id FROM personal_records WHERE user_id=? AND source='auto'").all(user);
  const expected = [...prAuto.buildRunPrCandidates(run), prAuto.buildTimePrCandidate(run)].filter(Boolean);
  assert.equal(prs.length, expected.length);
  for (const pr of prs) { assert.equal(pr.run_id, run.id); assert.equal(pr.value, expected.find(c => c.label === pr.label).value); }
  return run;
}
async function main() {
  for (const watchFirst of [false, true]) for (const withRoute of [false, true]) {
    const user = owner(), p = phone(), w = watch(withRoute ? { routeCoords: watchRoute } : {});
    if (watchFirst) {
      await sync(user, w); assert.equal(revision(user), 8);
      await sync(user, w); assert.equal(revision(user), 8, 'identical unpaired watch retry does not advance revision');
      const originalId = rows(user)[0].id;
      const completion = await call(user, 'post', '/', p);
      assert.equal(completion.value.run.id, originalId, 'watch-first keeps persisted identity');
    } else {
      await call(user, 'post', '/', p); assert.equal(revision(user), 8);
      const provisional = db.prepare("SELECT value FROM personal_records WHERE user_id=? AND label='Best Avg Pace'").get(user).value;
      await sync(user, w);
      assert.ok(db.prepare("SELECT value FROM personal_records WHERE user_id=? AND label='Best Avg Pace'").get(user).value > provisional, 'slower canonical result retracts provisional PR');
    }
    assert.equal(revision(user), 9, 'one revision per changed transaction, no double advance');
    const before = canonical(user, p, w, withRoute);
    await sync(user, w); await sync(user, w);
    await call(user, 'post', '/', { ...p, distance_miles: 99, duration_seconds: 9999 });
    assert.equal(revision(user), 9, 'both retry kinds leave revision unchanged');
    assert.equal(canonical(user, p, w, withRoute).id, before.id);
    const alias = await call(user, 'get', '/:id', {}, p.id);
    assert.equal(alias.value.run.id, before.id, 'queued phone UUID resolves to canonical recap');
    if (!withRoute) {
      const later = { ...w, routeCoords: watchRoute };
      await sync(user, later); assert.equal(revision(user), 10);
      canonical(user, p, later, true);
      await sync(user, later); assert.equal(revision(user), 10);
    }
  }
  console.log('PASS both orders: watch metrics, route precedence, segmented fallback, retries, recap alias, totals/PR/load and exact revisions');
  for (const watchFirst of [false, true]) {
    const user = owner(), p = phone(), w = watch({ routeCoords: watchRoute, routeCoverageIncomplete: true,
      calories: 0, elevationGain: 0, elevationLoss: 0 });
    if (watchFirst) { await sync(user, w); await call(user, 'post', '/', p); }
    else { await call(user, 'post', '/', p); await sync(user, w); }
    canonical(user, p, w, true);
    await sync(user, w); assert.equal(revision(user), 9, 'explicit zero sensor metrics and partial watch geometry are idempotent');
  }

  const prOwner = owner();
  const prior = phone({ date: '2026-10-19', activity_start_at: '2026-10-19T10:00:00Z',
    activity_end_at: '2026-10-19T10:30:30Z', distance_miles: 3.1, duration_seconds: 1830 });
  await call(prOwner, 'post', '/', prior);
  const provisional = phone(); await call(prOwner, 'post', '/', provisional);
  db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,source,achieved_at) VALUES (?,?,'run','Manual milestone',123,'seconds','manual','2026-10-19')").run(randomUUID(), prOwner);
  await sync(prOwner, watch());
  const best = db.prepare("SELECT * FROM personal_records WHERE user_id=? AND label='Best Avg Pace'").get(prOwner);
  assert.equal(best.run_id, prior.id, 'recompute selects another surviving run when phone PR is revoked');
  assert.equal(best.value, prAuto.buildRunPrCandidates(rows(prOwner).find(r => r.id === prior.id)).find(c => c.label === 'Best Avg Pace').value);
  assert.equal(db.prepare("SELECT value FROM personal_records WHERE user_id=? AND source='manual'").get(prOwner).value, 123, 'manual history untouched');
  const beforeFailure = rows(prOwner).find(r => r.id === provisional.id);
  const beforeRevision = revision(prOwner);
  const failed = await imports.importRows(prOwner, [watch({ sourceWorkoutId: beforeFailure.health_source_workout_id, avgHeartRate: 160 })], {
    updateRunPrs: async () => { throw Error('synthetic PR gate failure'); },
  });
  assert.equal(failed.errors.length, 1, 'PR failure is returned, never reported as success');
  assert.equal(revision(prOwner), beforeRevision, 'failed PR refresh rolls back revision');
  assert.equal(rows(prOwner).find(r => r.id === provisional.id).avg_heart_rate, beforeFailure.avg_heart_rate, 'failed PR refresh rolls back canonical evidence');
  console.log('PASS PR replacement across prior runs, manual record preservation, atomic failure/revision rollback');

  const manualOwner = owner();
  db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,source,achieved_at) VALUES (?,?,'run','Best Avg Pace',9.8,'min/mi','manual','2026-10-19')").run(randomUUID(), manualOwner);
  await call(manualOwner, 'post', '/', phone());
  assert.equal(db.prepare("SELECT discrepancy FROM personal_records WHERE user_id=? AND source='manual'").get(manualOwner).discrepancy, 1);
  await sync(manualOwner, watch());
  const manual = db.prepare("SELECT * FROM personal_records WHERE user_id=? AND source='manual'").get(manualOwner);
  assert.equal(manual.value, 9.8); assert.equal(manual.discrepancy, 0); assert.equal(manual.auto_value, null, 'phone-derived discrepancy must not survive watch correction');
  const strictOwner = owner();
  fixture.hooks.before = async (method, sql) => {
    if (method === 'run' && sql.includes('INSERT INTO personal_records')) throw Error('synthetic PR write failure');
  };
  const strictFailure = await imports.importRows(strictOwner, [watch()]);
  delete fixture.hooks.before;
  assert.equal(strictFailure.errors.length, 1); assert.equal(rows(strictOwner).length, 0);
  assert.equal(revision(strictOwner), 7, 'actual PR service write failure rolls back entire import');
  console.log('PASS manual discrepancy correction and strict PR service failure rollback');

  for (const delta of [{ startDate: `${day}T10:06:00Z` }, { durationSeconds: 2200 }, { distanceMiles: 4 }, { type: 'cycling' }]) {
    for (const watchFirst of [false, true]) {
      const user = owner(), p = phone(), w = watch(delta);
      if (watchFirst) { await sync(user, w); await call(user, 'post', '/', p); }
      else { await call(user, 'post', '/', p); await sync(user, w); }
      assert.equal(rows(user).length, 2, 'nonmatching activities remain separate');
    }
  }
  const ambiguous = owner();
  await call(ambiguous, 'post', '/', phone()); await call(ambiguous, 'post', '/', phone());
  await sync(ambiguous, watch()); assert.equal(rows(ambiguous).length, 3, 'ambiguous phones fail closed');
  const reverseAmbiguous = owner();
  await sync(reverseAmbiguous, watch());
  // Independent provider IDs with different values outside import fallback tolerance,
  // but both within the established phone match window.
  await sync(reverseAmbiguous, watch({ distanceMiles: 3.3, durationSeconds: 1780 }));
  await call(reverseAmbiguous, 'post', '/', phone());
  assert.equal(rows(reverseAmbiguous).length, 3, 'ambiguous watches fail closed');
  const a = owner(), b = owner(), p = phone();
  await call(a, 'post', '/', p); await sync(b, watch());
  assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 1);
  const alien = { code: 200, status(code) { this.code = code; return this; }, json(v) { this.value = v; return this; } };
  await runsRouter.stack.find(l => l.route?.path === '/:id' && l.route.methods.get).route.stack.at(-1).handle({ user: { id: b }, params: { id: p.id }, query: {} }, alien);
  assert.equal(alien.code, 404, 'foreign phone alias is not exposed');
  console.log('PASS ambiguous/nonmatching time, duration, distance, kind and owner boundaries');
  db.close();
}
main().catch(error => { console.error(error.message); db.close(); process.exitCode = 1; });
