// Real public routes and schema-faithful disposable SQLite. No provider/AI calls.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDb } = require('./helpers/adaptiveShadowDb');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { projectSessionLog } = require('../src/lib/strengthLogObservation');
const source = require('../src/lib/adaptiveCoachingSources');
const fixture = createDb({ syntheticProfileFields: false }), { db, tx } = fixture;
fixture.exports.runWithUserContext = (_userId, next) => next();
db.exec('ALTER TABLE users ADD COLUMN weight_lbs REAL'); // actual startup schema field
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  generateWorkoutFeedback: () => { throw new Error('Unexpected AI call'); },
} };
const imagePath = require.resolve('../src/lib/exerciseImageRequests');
require.cache[imagePath] = { id: imagePath, filename: imagePath, loaded: true,
  exports: { requestExerciseImageIfMissing: async () => null } };
process.env.JWT_SECRET = 'synthetic-strength-log-only';
const jwt = require('jsonwebtoken'), express = require('express'), app = express();
app.use(express.json()); app.use('/workouts', require('../src/routes/workouts'));
const RealDate = Date; let now = '2026-09-27T12:00:00Z';
// Observe the actual engine default before installing a deterministic clock.
const nativeClock = db.prepare('SELECT CURRENT_TIMESTAMP value').get().value;
assert.match(nativeClock, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
const clockProjection = recorded => projectSessionLog({ id: 'clock', started_at: new RealDate(RealDate.parse(recorded.replace(' ', 'T') + 'Z') - 60000).toISOString(),
  ended_at: new RealDate(RealDate.parse(recorded.replace(' ', 'T') + 'Z') - 60000).toISOString(), created_at: recorded, total_seconds: 0 },
  [{ id: 'set', exercise_name: 'Squat', set_number: 1, reps: 8, weight_lbs: 0, logged_at: recorded }],
  { since: '2000-01-01', through: '2099-01-01', observationInstant: new RealDate().toISOString(), timezone: 'UTC' });
assert.equal(clockProjection(nativeClock).known_set_count, 1);
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return RealDate.parse(now); } };
// Match SQLite's real CURRENT_TIMESTAMP serialization, not a fictional ISO DB.
db.function('current_timestamp', () => new Date().toISOString().slice(0, 19).replace('T', ' '));
const owner = randomUUID(), foreign = randomUUID();
for (const id of [owner, foreign]) db.prepare("INSERT INTO users(id,name,email,password_hash,planning_input_revision) VALUES (?,'Synthetic',?,'',1)").run(id, id + '@example.invalid');
const args = { tx, userId: owner, planningDateISO: '2026-09-27', observationInstant: now, timezone: 'America/New_York' };
const sets = [{ exercise_name: 'Barbell back squat', set_number: 1, reps: 8, weight_lbs: 100 },
  { exercise_name: 'Barbell back squat', set_number: 2, reps: 8, weight_lbs: 100 }];
const stored = id => db.prepare('SELECT * FROM workout_sessions WHERE id=?').get(id);
const setRows = id => db.prepare('SELECT * FROM workout_sets WHERE session_id=? ORDER BY set_number').all(id);
const revision = () => db.prepare('SELECT planning_input_revision FROM users WHERE id=?').get(owner).planning_input_revision;
let server;
async function main() {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  async function request(method, url, body, user = owner) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  }
  const load = () => source.loadMeasuredSources(args);
  const get = async id => (await load()).receipt.sessions.find(s => s.session_id === id);
  const post = body => request('POST', '/workouts/strength', body);
  assert.equal((await request('POST', '/workouts/strength', { sets }, null)).status, 401);
  const historical = await post({ completed_at: '2026-09-20T09:00:00-04:00', sets });
  assert.equal(historical.status, 201);
  const id = historical.data.session.id, original = stored(id), originalSets = setRows(id);
  assert.equal(original.started_at, '2026-09-20T09:00:00-04:00');
  assert.equal(original.ended_at, original.started_at); assert.equal(original.total_seconds, 0);
  assert.equal(original.created_at, '2026-09-27 12:00:00'); assert(originalSets.every(s => s.logged_at === original.created_at));
  let observed = await get(id);
  assert.equal(observed.measured_set_count, 2); assert.equal(observed.measurement_state, 'KNOWN_LOWER_BOUND');
  assert.equal(observed.log_observation.occurrence.local_date, '2026-09-20');
  assert.deepEqual(observed.log_observation.duration_s, { state: 'UNKNOWN', value: null });
  assert.equal(observed.log_observation.origin, 'UNKNOWN');
  assert.equal(observed.log_observation.evidence_semantics, 'USER_RECORDED_LOG');
  assert.equal(observed.log_observation.progression_eligible, false);
  assert.equal(observed.log_observation.canonical_adherence_verified, false);
  assert.equal(observed.log_observation.coverage_state, 'UNKNOWN');
  assert.equal(observed.log_observation.prescription_link_state, 'UNSUPPORTED');
  assert.deepEqual(stored(id), original); assert.deepEqual(setRows(id), originalSets);
  const acquired = await load();
  assert.deepEqual(acquired.lifts, [], 'log observations never become COMPLETE measured lift envelopes');
  assert.equal(acquired.receipt.measured_receipts.rows.length, 0);
  assert.equal(acquired.receipt.provider_imports.rows.length, 0);
  assert.deepEqual(await load(), acquired, 'same rows produce deterministic acquisition');
  const support = source.sourceSupport({ athlete_state: { adaptive_foundation: { completion_pairs: [], capacities: { lift: 4 } }, planning_date_local: args.planningDateISO },
    decision: { goal_gap: [], weekly_objectives: { objectives: [{ candidate_families: ['strength_upper'] }] } },
    artifacts: [{ payload_json: { evidence: [], physical_sources: acquired.receipt } }] });
  assert.equal(support.source_limited, true);
  assert.equal(support.limits.find(l => l.required).reason_code, 'CANONICAL_STRENGTH_LINK_ABSENT');

  // Date precision is preserved, and numeric zero is not lost to || null.
  const dateLog = await post({ completed_at: '2026-09-21', sets: [{ ...sets[0], weight_lbs: 0 }] });
  assert.equal(dateLog.status, 201);
  observed = await get(dateLog.data.session.id);
  assert.equal(observed.log_observation.occurrence.precision, 'DATE');
  assert.equal(observed.log_observation.occurrence.local_date, '2026-09-21');
  assert.deepEqual(observed.log_observation.sets[0].external_load_lbs, { state: 'VALID_ZERO', value: 0 });
  const unknownLoad = await post({ sets: [{ ...sets[0], weight_lbs: null }] });
  assert.equal(unknownLoad.status, 201);
  assert.equal((await get(unknownLoad.data.session.id)).measured_set_count, 1);
  assert.deepEqual((await get(unknownLoad.data.session.id)).log_observation.sets[0].external_load_lbs, { state: 'UNKNOWN', value: null });
  now = '2026-09-27T12:00:00.500Z';
  const fractionalLog = await post({ sets });
  assert.equal(fractionalLog.status, 201);
  const fractionalProjection = projectSessionLog(stored(fractionalLog.data.session.id), setRows(fractionalLog.data.session.id),
    { since: '2026-08-03', through: args.planningDateISO, observationInstant: now, timezone: args.timezone });
  assert.equal(fractionalProjection.known_set_count, 2, 'DB second precision does not invent a pre-start set');
  assert.equal(fractionalProjection.sets[0].recorded_time_precision, 'SECOND');

  // Date-only has no UTC instant. At this boundary tomorrow UTC is already
  // today in +14; the same declaration remains future/unknown in New York.
  now = '2026-09-27T23:30:00Z';
  const boundary = await post({ completed_at: '2026-09-28', sets });
  assert.equal(boundary.status, 201);
  const boundaryRows = setRows(boundary.data.session.id), boundarySession = stored(boundary.data.session.id);
  const dateOptions = { since: '2026-08-03', through: '2026-09-28', observationInstant: now, timezone: 'Pacific/Kiritimati' };
  assert.equal(projectSessionLog(boundarySession, boundaryRows, dateOptions).known_set_count, 2);
  assert.equal(projectSessionLog(boundarySession, boundaryRows, { ...dateOptions, timezone: 'America/New_York' }).known_set_count, null);
  const pgSession = { ...boundarySession, created_at: '2026-09-27 23:30:00+00' };
  assert.equal(projectSessionLog(pgSession, boundaryRows.map(s => ({ ...s, logged_at: '2026-09-27 23:30:00.000+00' })), dateOptions).known_set_count, 2);
  now = '2026-09-28T00:30:00Z';
  assert.equal((await post({ completed_at: '2026-09-27', sets })).status, 201, 'previous UTC day remains valid current local date');
  now = args.observationInstant;

  // Actual start/sets/end recording, not a backdated fabricated timer.
  now = '2026-09-25T23:30:00-04:00';
  const started = await request('POST', '/workouts/start', { muscle_groups: ['legs'] });
  assert.equal(started.status, 201); const timed = started.data.session.id;
  now = '2026-09-25T23:40:00-04:00';
  for (const set of sets) assert.equal((await request('POST', `/workouts/${timed}/sets`, set)).status, 201);
  now = '2026-09-26T00:00:00-04:00';
  assert.equal((await request('PUT', `/workouts/${timed}/end`, {})).status, 200);
  now = args.observationInstant;
  observed = await get(timed);
  assert.equal(observed.measured_set_count, 2);
  assert.equal(observed.log_observation.occurrence.local_date, '2026-09-25');
  assert.deepEqual(observed.log_observation.duration_s, { state: 'KNOWN', value: 1800 });
  assert.equal(observed.log_observation.origin, 'UNKNOWN', 'elapsed agreement is not timer/provider provenance');

  // Malformed/future POSTs fail before writes or planning revision changes.
  for (const body of [[], { completed_at: 'tomorrow' }, { completed_at: '2026-02-30T12:00:00Z' },
    { completed_at: '2026-09-28T00:00:00Z' }, { completed_at: '2026-09-29' },
    { completed_at: {} }, { completed_at: '2026-09-20T12:00:00' }, { sets: {} }, { sets: [null] },
    ...['reps', 'weight_lbs', 'set_number'].flatMap(key => [[], {}, false, -1, 'bad'].map(value => ({ sets: [{ ...sets[0], [key]: value }] })))]) {
    const before = db.prepare('SELECT COUNT(*) n FROM workout_sessions').get().n, rev = revision();
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workout_sessions').get().n, before); assert.equal(revision(), rev);
  }
  const beforeForeign = await load();
  assert.equal((await request('PUT', `/workouts/${id}`, { exercise_name: 'Other', sets: 2, reps: 10 }, foreign)).status, 404);
  assert.equal((await request('DELETE', `/workouts/${id}`, undefined, foreign)).status, 404);
  assert.deepEqual(await load(), beforeForeign);
  const foreignLog = await request('POST', '/workouts/strength', { sets }, foreign);
  assert.equal(foreignLog.status, 201); assert.deepEqual(await load(), beforeForeign);

  // Ordinary edit/delete changes the source hash; recorded timestamps untouched.
  const beforeHash = canonicalHash((await load()).receipt);
  assert.equal((await request('PUT', `/workouts/${id}`, { exercise_name: 'Barbell back squat', sets: 2, reps: 10, weight_lbs: 105 })).status, 200);
  assert.notEqual(canonicalHash((await load()).receipt), beforeHash);
  assert.deepEqual(setRows(id).map(s => s.logged_at), originalSets.map(s => s.logged_at));
  assert.equal(stored(id).created_at, original.created_at);
  const editedHash = canonicalHash((await load()).receipt);
  assert.equal((await request('DELETE', `/workouts/${id}`)).status, 200);
  assert.notEqual(canonicalHash((await load()).receipt), editedHash); assert.equal(await get(id), undefined);

  // Stored corruption, future recording, duplicates, and non-run corrections
  // remain withheld; no origin inferred from apparently plausible timestamps.
  for (const mutation of [
    () => db.prepare('UPDATE workout_sets SET logged_at=? WHERE session_id=?').run('2026-09-28T12:00:00Z', timed),
    () => db.prepare('UPDATE workout_sets SET logged_at=? WHERE session_id=?').run('2026-09-01T12:00:00Z', timed),
    () => db.prepare('UPDATE workout_sets SET set_number=1 WHERE session_id=?').run(timed),
    () => db.prepare('UPDATE workout_sets SET reps=NULL WHERE session_id=?').run(timed),
    () => db.prepare('UPDATE workout_sessions SET ended_at=? WHERE id=?').run('2026-09-28T12:00:00Z', timed),
  ]) {
    db.exec('SAVEPOINT corrupt'); mutation(); assert.equal((await get(timed)).measured_set_count, null);
    db.exec('ROLLBACK TO corrupt'); db.exec('RELEASE corrupt');
  }
  const foreignSetHash = canonicalHash((await load()).receipt);
  db.exec('SAVEPOINT foreign_set');
  db.prepare('INSERT INTO workout_sets(id,session_id,user_id,exercise_name,set_number,reps,weight_lbs) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), timed, foreign, 'Other', 99, 8, 20);
  assert.equal(canonicalHash((await load()).receipt), foreignSetHash, 'foreign-owned child row never enters owner evidence');
  db.exec('ROLLBACK TO foreign_set'); db.exec('RELEASE foreign_set');
  const invalidDuration = projectSessionLog({ ...stored(timed), total_seconds: 999 }, setRows(timed),
    { since: '2026-08-03', through: args.planningDateISO, observationInstant: now, timezone: args.timezone });
  assert.equal(invalidDuration.known_set_count, 2); assert.equal(invalidDuration.duration_s.value, null);
  // Existing non-run correction path remains explicitly unsupported/fail-closed.
  const correctiveTx = { ...tx, all: async (sql, params) => sql.includes('FROM planning_evidence_corrections')
    ? [{ id: 'correction', user_id: owner, raw_evidence_kind: 'lift', raw_evidence_ref: timed, revision: 1, created_at: now }]
    : tx.all(sql, params) };
  assert.equal((await source.loadMeasuredSources({ ...args, tx: correctiveTx })).reason_code, 'SOURCE_CORRECTION_UNSUPPORTED');
  for (const table of ['training_plans', 'user_plans', 'activity_measured_receipts', 'provider_import_receipts'])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  console.log('STRENGTH LOG ACQUISITION OK: authenticated historical/contemporaneous/timed logs; chronology, null duration, owner, edits/deletion, correction, deterministic receipt; no completed-prescription authority');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); db.close(); global.Date = RealDate; });
